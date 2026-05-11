'use strict'

const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { URL } = require('url')

const PORT = Number(process.env.PORT || 43117)
const HOST = process.env.HOST || '0.0.0.0'
const PUBLIC_DIR = path.join(__dirname, 'public')
const NODE_MODULES_DIR = path.join(__dirname, '..', 'node_modules')
const LOCAL_WEQ8_DIST_DIR = path.join(__dirname, 'weq8-main', 'dist')
const SIMPLE_PEER_PATH = path.join(__dirname, '..', 'simplepeer.min.js')
const DEBUG_LOG_PATH = path.resolve(
  process.env.HOME_AUDIO_DEBUG_LOG || path.join(os.tmpdir(), 'home-audio', 'debug.ndjson')
)
const MAX_DEBUG_EVENTS = Math.max(
  50,
  Math.min(5000, Number(process.env.HOME_AUDIO_DEBUG_MAX_EVENTS || 400) || 400)
)
const SSE_HEARTBEAT_MS = Math.max(
  5000,
  Number(process.env.HOME_AUDIO_SSE_HEARTBEAT_MS || 15000) || 15000
)
const SSE_DISCONNECT_GRACE_MS = Math.max(
  0,
  Number(process.env.HOME_AUDIO_SSE_DISCONNECT_GRACE_MS || 900000) || 900000
)
const SSE_BROADCASTER_DISCONNECT_GRACE_MS = Math.max(
  0,
  Number(process.env.HOME_AUDIO_SSE_BROADCASTER_DISCONNECT_GRACE_MS || 3000) || 3000
)
const STOP_WITHOUT_HOST_MS = Math.max(
  0,
  Number(process.env.HOME_AUDIO_STOP_WITHOUT_HOST_MS || 30000) || 30000
)
const DELAY_MIN_MS = 0
const DELAY_MAX_MS = 300
const DELAY_STEP_MS = 5

if (typeof process.send === 'function') {
  process.on('disconnect', () => {
    process.exit(0)
  })
}

function ensureDebugLogDirectory() {
  fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true })
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html') return 'text/html; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.js') return 'application/javascript; charset=utf-8'
  if (ext === '.json') return 'application/json; charset=utf-8'
  if (ext === '.svg') return 'image/svg+xml'
  if (ext === '.png') return 'image/png'
  return 'application/octet-stream'
}

function getLanAddresses(port) {
  const interfaces = os.networkInterfaces()
  const urls = []

  Object.values(interfaces).forEach(entries => {
    ;(entries || []).forEach(entry => {
      if (!entry || entry.internal) return
      if (entry.family !== 'IPv4') return
      urls.push(`http://${entry.address}:${port}`)
    })
  })

  return Array.from(new Set(urls)).sort()
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''

    req.setEncoding('utf8')

    req.on('data', chunk => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('Body too large'))
        req.destroy()
      }
    })

    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }

      try {
        resolve(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })

    req.on('error', reject)
  })
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function sendEvent(client, event, payload) {
  if (!client || !client.res) return
  client.res.write(`event: ${event}\n`)
  client.res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: 'Not found' })
      return
    }

    res.writeHead(200, {
      'Content-Type': getMimeType(filePath),
      'Content-Length': data.length,
      'Cache-Control': 'no-store'
    })
    res.end(data)
  })
}

function createState() {
  return {
    serverRunning: true,
    shuttingDown: false,
    broadcasterId: null,
    broadcasterSessionId: '',
    broadcasterSessionStartedAt: null,
    noHostStopTimer: null,
    noHostStopAt: null,
    clients: new Map(),
    startedAt: new Date().toISOString(),
    nextDebugEventId: 1,
    debugEvents: [],
    debugSubscribers: new Set(),
    counters: {
      registerRequests: 0,
      unregisterRequests: 0,
      signalMessages: 0,
      participantSettingsUpdates: 0,
      diagnosticsUpdates: 0
    }
  }
}

function shutdownProcess(server, state, reason) {
  if (state.shuttingDown) return
  state.shuttingDown = true
  recordDebugEvent(state, 'server-control', {
    action: 'shutdown',
    changed: true,
    running: state.serverRunning,
    reason: reason || 'api-shutdown'
  })

  stopService(state, 'api-shutdown')

  setTimeout(() => {
    server.close(() => {
      process.exit(0)
    })

    setTimeout(() => {
      process.exit(0)
    }, 2000)
  }, 120)
}

function getDefaultSettings(role) {
  return {
    delayMs: 0,
    channelMode: 'stereo'
  }
}

function clampDelay(value) {
  const delay = Number(value)
  if (!Number.isFinite(delay)) return DELAY_MIN_MS
  const snapped = Math.round(delay / DELAY_STEP_MS) * DELAY_STEP_MS
  return Math.max(DELAY_MIN_MS, Math.min(DELAY_MAX_MS, snapped))
}

function normalizeChannelMode(mode) {
  if (mode === 'mono') return mode
  if (mode === 'left' || mode === 'right') return mode
  return 'stereo'
}

function decodeQuotedValue(value) {
  if (typeof value !== 'string') return ''
  if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
    return value.slice(1, -1)
  }
  return value
}

function summarizeUserAgent(value) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 220)
}

function parseDiagnosticsSummary(text) {
  if (typeof text !== 'string' || !text) {
    return {}
  }

  const lines = text.split(/\r?\n/)
  const keys = [
    'status',
    'mediaReady',
    'directFallback',
    'processedPlaybackPath',
    'listenerContext.state',
    'mediaSession.configured',
    'mediaSession.playbackState',
    'mediaSession.action.play',
    'mediaSession.action.pause',
    'mediaSession.action.stop',
    'processor.context.state',
    'processor.context.sampleRate',
    'processor.level',
    'incomingMeterLevel',
    'playbackMeterLevel',
    'sourceMeterLevel',
    'monitorMeterLevel',
    'monitorProcessorLevel',
    'receiver.deltaBytes',
    'receiver.deltaPackets',
    'receiver.codec',
    'silentFallbackStreak',
    'lastPlayerEvent',
    'player.errorCode',
    'lastPlaybackFailure.at',
    'lastPlaybackFailure.stage',
    'lastPlaybackFailure.source',
    'lastPlaybackFailure.name',
    'lastPlaybackFailure.message',
    'pc.connectionState',
    'pc.iceConnectionState',
    'pc.signalingState'
  ]

  const summary = {}

  keys.forEach(key => {
    const prefix = `${key}=`
    const line = lines.find(entry => entry.startsWith(prefix))
    if (!line) return
    summary[key] = decodeQuotedValue(line.slice(prefix.length))
  })

  return summary
}

function appendDebugEvent(event) {
  try {
    ensureDebugLogDirectory()
  } catch (error) {
    console.error(`Failed preparing debug log directory: ${error.message}`)
    return
  }

  fs.appendFile(DEBUG_LOG_PATH, `${JSON.stringify(event)}\n`, error => {
    if (error) {
      console.error(`Failed writing debug event log: ${error.message}`)
    }
  })
}

function recordDebugEvent(state, type, details) {
  const event = {
    id: state.nextDebugEventId,
    at: new Date().toISOString(),
    type,
    ...(details || {})
  }

  state.nextDebugEventId += 1
  state.debugEvents.push(event)

  if (state.debugEvents.length > MAX_DEBUG_EVENTS) {
    state.debugEvents.shift()
  }

  appendDebugEvent(event)

  state.debugSubscribers.forEach(res => {
    try {
      sendEvent({ res }, 'debug', { event })
    } catch (error) {}
  })

  return event
}

function getOrCreateClient(state, clientId) {
  let client = state.clients.get(clientId)
  if (!client) {
    client = {
      id: clientId,
      role: null,
      res: null,
      disconnectTimer: null,
      disconnectedAt: null,
      settings: null,
      diagnostics: '',
      diagnosticsAt: null,
      lastDirectFallbackAt: null,
      lastDirectFallbackStatus: ''
    }
    state.clients.set(clientId, client)
  }
  return client
}

function clearDisconnectTimer(client) {
  if (!client || !client.disconnectTimer) {
    if (client) {
      client.disconnectedAt = null
    }
    return
  }

  clearTimeout(client.disconnectTimer)
  client.disconnectTimer = null
  client.disconnectedAt = null
}

function clearNoHostStopTimer(state) {
  if (!state || !state.noHostStopTimer) {
    if (state) {
      state.noHostStopAt = null
    }
    return
  }

  clearTimeout(state.noHostStopTimer)
  state.noHostStopTimer = null
  state.noHostStopAt = null
}

function scheduleStopWithoutHost(state) {
  if (!state || !state.serverRunning) return
  if (STOP_WITHOUT_HOST_MS <= 0) return
  if (state.broadcasterId) return

  clearNoHostStopTimer(state)
  state.noHostStopAt = new Date(Date.now() + STOP_WITHOUT_HOST_MS).toISOString()

  state.noHostStopTimer = setTimeout(() => {
    state.noHostStopTimer = null
    state.noHostStopAt = null

    if (!state.serverRunning || state.broadcasterId) {
      return
    }

    const changed = stopService(state, 'no-host-timeout')
    if (changed) {
      recordDebugEvent(state, 'server-control', {
        action: 'auto-stop-no-host',
        serverRunning: state.serverRunning
      })
    }
  }, STOP_WITHOUT_HOST_MS)
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed || ''
}

function getActiveBroadcasterSummary(state) {
  if (!state.broadcasterId) return null
  const active = state.clients.get(state.broadcasterId)
  return {
    clientId: state.broadcasterId,
    sessionId: state.broadcasterSessionId || '',
    connected: Boolean(active && active.res),
    startedAt: state.broadcasterSessionStartedAt || null
  }
}

function isActiveBroadcasterSession(state, clientId, sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId)
  if (!clientId || !normalizedSessionId) return false
  if (state.broadcasterId !== clientId) return false
  if (!state.broadcasterSessionId) return false
  return state.broadcasterSessionId === normalizedSessionId
}

function applyClientSettings(client, role, nextSettings) {
  const base = client.settings || getDefaultSettings(role)
  const merged = {
    delayMs: clampDelay(
      nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, 'delayMs')
        ? nextSettings.delayMs
        : base.delayMs
    ),
    channelMode: normalizeChannelMode(
      nextSettings && Object.prototype.hasOwnProperty.call(nextSettings, 'channelMode')
        ? nextSettings.channelMode
        : base.channelMode
    )
  }

  client.settings = merged
  return merged
}

function getParticipantsSnapshot(state) {
  const activeClients = Array.from(state.clients.values())
    .filter(client => client.role)
    .sort((left, right) => {
      if (left.role === 'broadcaster' && right.role !== 'broadcaster') return -1
      if (right.role === 'broadcaster' && left.role !== 'broadcaster') return 1
      return left.id.localeCompare(right.id)
    })

  let listenerIndex = 0

  return activeClients
    .map(client => {
      const label = client.role === 'broadcaster'
        ? 'Host'
        : `Listener ${++listenerIndex}`

      return {
        clientId: client.id,
        role: client.role,
        label,
        delayMs: client.settings ? client.settings.delayMs : getDefaultSettings(client.role).delayMs,
        channelMode: client.settings ? client.settings.channelMode : 'stereo'
      }
    })
}

function getParticipantLabelMap(state) {
  return new Map(
    getParticipantsSnapshot(state).map(participant => [participant.clientId, participant.label])
  )
}

function broadcastParticipants(state) {
  const participants = getParticipantsSnapshot(state)

  state.clients.forEach(client => {
    if (client.role && client.res) {
      sendEvent(client, 'participants', { participants })
    }
  })

  return participants
}

function getClientDebugSnapshot(client, labelMap) {
  const diagnosticsSummary = parseDiagnosticsSummary(client.diagnostics)

  return {
    clientId: client.id,
    role: client.role,
    label: client.role ? (labelMap.get(client.id) || null) : null,
    connected: Boolean(client.res),
    disconnectedAt: client.disconnectedAt,
    settings: client.settings || null,
    diagnosticsAt: client.diagnosticsAt,
    diagnosticsSummary,
    diagnostics: client.diagnostics || '',
    lastDirectFallbackAt: client.lastDirectFallbackAt,
    lastDirectFallbackStatus: client.lastDirectFallbackStatus || ''
  }
}

function getDebugStateSnapshot(state, activePort) {
  const labelMap = getParticipantLabelMap(state)

  return {
    server: {
      running: Boolean(state.serverRunning),
      host: HOST,
      port: activePort,
      startedAt: state.startedAt,
      debugLogPath: DEBUG_LOG_PATH,
      stopWithoutHostMs: STOP_WITHOUT_HOST_MS,
      noHostStopAt: state.noHostStopAt
    },
    broadcasterId: state.broadcasterId,
    broadcasterSessionId: state.broadcasterSessionId || '',
    broadcasterSessionStartedAt: state.broadcasterSessionStartedAt,
    participants: getParticipantsSnapshot(state),
    clients: Array.from(state.clients.values())
      .map(client => getClientDebugSnapshot(client, labelMap))
      .filter(client => client.role || client.connected || client.diagnostics || client.lastDirectFallbackAt),
    counters: {
      ...state.counters,
      activeClientConnections: Array.from(state.clients.values()).filter(client => client.role).length,
      debugSubscribers: state.debugSubscribers.size
    },
    recentEvents: state.debugEvents.slice(-100)
  }
}

function getStatusSnapshot(state, activePort) {
  return {
    serverRunning: Boolean(state.serverRunning),
    hostPage: `http://localhost:${activePort}/host`,
    listenPages: getLanAddresses(activePort).map(url => `${url}/listen`),
    port: activePort
  }
}

function getDiagnosticsSnapshot(state) {
  const labelMap = getParticipantLabelMap(state)
  const diagnostics = {}

  state.clients.forEach(client => {
    if (!client.role) return
    diagnostics[client.id] = {
      clientId: client.id,
      role: client.role,
      label: labelMap.get(client.id) || null,
      text: client.diagnostics || '',
      updatedAt: client.diagnosticsAt
    }
  })

  return diagnostics
}

function broadcastDiagnostics(state) {
  const diagnostics = getDiagnosticsSnapshot(state)

  state.clients.forEach(client => {
    if (client.role && client.res) {
      sendEvent(client, 'diagnostics', { diagnostics })
    }
  })

  return diagnostics
}

function listListenerIds(state) {
  return Array.from(state.clients.values())
    .filter(client => client.role === 'listener')
    .map(client => client.id)
}

function stopService(state, reason) {
  if (!state.serverRunning) return false
  state.serverRunning = false
  clearNoHostStopTimer(state)

  const activeClientIds = Array.from(state.clients.values())
    .filter(client => client.role)
    .map(client => client.id)

  activeClientIds.forEach(clientId => {
    unregisterClient(state, clientId, reason || 'service-stop')
  })

  state.clients.forEach(client => {
    clearDisconnectTimer(client)
    const clientRes = client.res
    client.res = null
    if (clientRes) {
      try {
        clientRes.end()
      } catch (error) {}
    }
  })

  return true
}

function startService(state) {
  if (state.serverRunning) return false
  state.serverRunning = true
  clearNoHostStopTimer(state)
  return true
}

function unregisterClient(state, clientId, reason) {
  const client = state.clients.get(clientId)
  if (!client) return
  clearDisconnectTimer(client)

  if (!client.role) {
    client.res = null
    client.settings = null
    client.diagnostics = ''
    client.diagnosticsAt = null
    return
  }

  const previousRole = client.role
  const previousSettings = client.settings

  if (client.role === 'listener' && state.broadcasterId) {
    const broadcaster = state.clients.get(state.broadcasterId)
    sendEvent(broadcaster, 'client-left', { clientId })
  }

  if (client.role === 'broadcaster' && state.broadcasterId === clientId) {
    state.broadcasterId = null
    state.broadcasterSessionId = ''
    state.broadcasterSessionStartedAt = null
    state.clients.forEach(otherClient => {
      if (otherClient.id !== clientId && otherClient.role === 'listener') {
        sendEvent(otherClient, 'host-left', { broadcasterId: clientId })
      }
    })
  }

  recordDebugEvent(state, 'unregister', {
    clientId,
    role: previousRole,
    reason: reason || 'unknown',
    settings: previousSettings || null
  })

  client.role = null
  client.res = null
  client.settings = null
  client.diagnostics = ''
  client.diagnosticsAt = null
  if (previousRole === 'broadcaster') {
    scheduleStopWithoutHost(state)
  }
  broadcastParticipants(state)
  broadcastDiagnostics(state)
}

function attachSse(state, req, res, parsedUrl) {
  const clientId = parsedUrl.searchParams.get('clientId')
  const sessionId = normalizeSessionId(parsedUrl.searchParams.get('sessionId'))
  if (!clientId) {
    sendJson(res, 400, { error: 'Missing clientId' })
    return
  }

  if (clientId === state.broadcasterId) {
    if (!sessionId) {
      sendJson(res, 403, { error: 'Missing host sessionId' })
      return
    }

    if (!isActiveBroadcasterSession(state, clientId, sessionId)) {
      sendJson(res, 403, {
        error: 'Host session is not active',
        errorCode: 'HOST_SESSION_INACTIVE',
        activeHost: getActiveBroadcasterSummary(state)
      })
      return
    }
  }

  const client = getOrCreateClient(state, clientId)
  const hadDisconnectGap = Boolean(client.disconnectTimer || client.disconnectedAt)
  const previousDisconnectedAt = client.disconnectedAt
  clearDisconnectTimer(client)

  if (client.res && client.res !== res) {
    try {
      client.res.end()
    } catch (error) {}
  }

  client.res = res

  recordDebugEvent(state, 'sse-connected', {
    clientId,
    role: client.role || null,
    hadDisconnectGap,
    previousDisconnectedAt: previousDisconnectedAt || null,
    sessionId: clientId === state.broadcasterId ? sessionId : '',
    remoteAddress: (req.socket && req.socket.remoteAddress) || '',
    userAgent: summarizeUserAgent(req.headers['user-agent'])
  })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  })

  res.write(': connected\n\n')
  sendEvent(client, 'ready', { clientId })
  sendEvent(client, 'diagnostics', { diagnostics: getDiagnosticsSnapshot(state) })
  const heartbeatTimer = setInterval(() => {
    if (client.res !== res) {
      clearInterval(heartbeatTimer)
      return
    }

    try {
      res.write(': keepalive\n\n')
    } catch (error) {
      clearInterval(heartbeatTimer)
    }
  }, SSE_HEARTBEAT_MS)

  // Do not emit listener-joined on SSE reconnect for an already-registered listener.
  // Re-announcing a joined listener causes unnecessary renegotiation churn while audio is healthy.

  req.on('close', () => {
    clearInterval(heartbeatTimer)
    const currentClient = state.clients.get(clientId)
    if (!currentClient) return
    if (currentClient.res !== res) return

    currentClient.res = null
    currentClient.disconnectedAt = new Date().toISOString()
    const disconnectGraceMs = currentClient.role === 'broadcaster'
      ? SSE_BROADCASTER_DISCONNECT_GRACE_MS
      : SSE_DISCONNECT_GRACE_MS

    recordDebugEvent(state, 'sse-disconnected', {
      clientId,
      role: currentClient.role || null,
      disconnectedAt: currentClient.disconnectedAt,
      disconnectGraceMs
    })

    if (disconnectGraceMs <= 0) {
      unregisterClient(state, clientId, 'sse-close')
      return
    }

    currentClient.disconnectTimer = setTimeout(() => {
      const latestClient = state.clients.get(clientId)
      if (!latestClient || latestClient.res) return
      latestClient.disconnectTimer = null
      recordDebugEvent(state, 'sse-timeout', {
        clientId,
        role: latestClient.role || null,
        disconnectedAt: latestClient.disconnectedAt
      })
      unregisterClient(state, clientId, 'sse-timeout')
    }, disconnectGraceMs)
  })
}

function attachDebugEvents(state, req, res, activePort) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  })

  res.write(': debug connected\n\n')
  state.debugSubscribers.add(res)
  sendEvent({ res }, 'ready', {
    startedAt: state.startedAt,
    debugLogPath: DEBUG_LOG_PATH
  })
  sendEvent({ res }, 'snapshot', {
    state: getDebugStateSnapshot(state, activePort)
  })

  req.on('close', () => {
    state.debugSubscribers.delete(res)
  })
}

async function handleRegister(state, req, res) {
  const body = await readBody(req)
  const clientId = body.clientId
  const role = body.role

  state.counters.registerRequests += 1

  if (!clientId || !role) {
    sendJson(res, 400, { error: 'Missing clientId or role' })
    return
  }

  if (role !== 'broadcaster' && role !== 'listener') {
    sendJson(res, 400, { error: 'Invalid role' })
    return
  }

  const client = getOrCreateClient(state, clientId)
  clearDisconnectTimer(client)
  client.lastDirectFallbackAt = null
  client.lastDirectFallbackStatus = ''

  if (role === 'broadcaster') {
    const sessionId = normalizeSessionId(body.sessionId)
    const takeover = Boolean(body.takeover)

    if (!sessionId) {
      sendJson(res, 400, { error: 'Missing sessionId for broadcaster registration' })
      return
    }

    const hasActiveBroadcaster = Boolean(state.broadcasterId)
    const sameActiveSession = isActiveBroadcasterSession(state, clientId, sessionId)

    if (hasActiveBroadcaster && !sameActiveSession) {
      if (!takeover) {
        sendJson(res, 409, {
          error: 'Another host session is already active',
          errorCode: 'HOST_ACTIVE',
          canTakeover: true,
          activeHost: getActiveBroadcasterSummary(state)
        })
        return
      }

      const previousBroadcasterId = state.broadcasterId
      const previousBroadcaster = previousBroadcasterId
        ? state.clients.get(previousBroadcasterId)
        : null
      const previousResponse = previousBroadcaster && previousBroadcaster.res
        ? previousBroadcaster.res
        : null

      if (previousBroadcaster && previousResponse) {
        sendEvent(previousBroadcaster, 'host-revoked', {
          reason: 'takeover',
          replacedByClientId: clientId,
          replacedBySessionId: sessionId,
          previousClientId: previousBroadcasterId,
          previousSessionId: state.broadcasterSessionId || '',
          at: new Date().toISOString()
        })
      }

      if (previousBroadcasterId) {
        unregisterClient(state, previousBroadcasterId, 'host-takeover')
      }

      if (previousResponse) {
        try {
          previousResponse.end()
        } catch (error) {}
      }
    }

    state.broadcasterId = clientId
    state.broadcasterSessionId = sessionId
    state.broadcasterSessionStartedAt = new Date().toISOString()
    clearNoHostStopTimer(state)
    client.role = 'broadcaster'
    applyClientSettings(client, role, body.settings)
    recordDebugEvent(state, 'register', {
      clientId,
      role,
      sessionId,
      takeover,
      settings: client.settings
    })

    const participants = broadcastParticipants(state)
    broadcastDiagnostics(state)
    sendJson(res, 200, {
      ok: true,
      role,
      clientId,
      sessionId,
      listeners: listListenerIds(state),
      participants
    })
    return
  }

  client.role = 'listener'
  applyClientSettings(client, role, body.settings)
  recordDebugEvent(state, 'register', {
    clientId,
    role,
    settings: client.settings,
    broadcasterId: state.broadcasterId
  })

  const broadcaster = state.broadcasterId
    ? state.clients.get(state.broadcasterId)
    : null

  if (broadcaster) {
    sendEvent(broadcaster, 'listener-joined', { clientId })
  }

  const participants = broadcastParticipants(state)
  broadcastDiagnostics(state)
  sendJson(res, 200, {
    ok: true,
    role,
    clientId,
    broadcasterId: state.broadcasterId,
    participants
  })
}

async function handleUnregister(state, req, res) {
  const body = await readBody(req)
  state.counters.unregisterRequests += 1
  if (!body.clientId) {
    sendJson(res, 400, { error: 'Missing clientId' })
    return
  }

  const sessionId = normalizeSessionId(body.sessionId)
  if (body.clientId === state.broadcasterId && state.broadcasterSessionId) {
    if (!sessionId || sessionId !== state.broadcasterSessionId) {
      sendJson(res, 200, {
        ok: true,
        ignored: true,
        reason: 'stale-host-session',
        activeHost: getActiveBroadcasterSummary(state)
      })
      return
    }
  }

  unregisterClient(state, body.clientId, 'api-unregister')
  sendJson(res, 200, { ok: true })
}

async function handleSignal(state, req, res) {
  const body = await readBody(req)
  const from = body.from
  const to = body.to
  const signal = body.signal
  const sessionId = normalizeSessionId(body.sessionId)

  if (!from || !to || !signal) {
    sendJson(res, 400, { error: 'Missing from, to, or signal' })
    return
  }

  const sender = state.clients.get(from)
  const isBroadcasterSignal = from === state.broadcasterId ||
    Boolean(sender && sender.role === 'broadcaster')
  if (isBroadcasterSignal) {
    if (!isActiveBroadcasterSession(state, from, sessionId)) {
      sendJson(res, 403, {
        error: 'Only active host session may send broadcaster signals',
        errorCode: 'HOST_SESSION_INACTIVE'
      })
      return
    }
  }

  const target = state.clients.get(to)
  if (!target || !target.res) {
    sendJson(res, 404, { error: 'Target client is not connected' })
    return
  }

  state.counters.signalMessages += 1
  recordDebugEvent(state, 'signal', {
    from,
    to,
    sessionId: isBroadcasterSignal ? sessionId : '',
    signalType: signal.type || (signal.candidate ? 'candidate' : 'unknown')
  })
  sendEvent(target, 'signal', { from, signal })
  sendJson(res, 200, { ok: true })
}

async function handleParticipantSettings(state, req, res) {
  const body = await readBody(req)
  const targetClientId = body.targetClientId
  const actorClientId = body.clientId || null
  const actorSessionId = normalizeSessionId(body.sessionId)

  if (!targetClientId || !body.settings) {
    sendJson(res, 400, { error: 'Missing targetClientId or settings' })
    return
  }

  const actor = actorClientId ? state.clients.get(actorClientId) : null
  if (actor && actor.role === 'broadcaster' && !isActiveBroadcasterSession(state, actorClientId, actorSessionId)) {
    sendJson(res, 403, {
      error: 'Only active host session may update settings',
      errorCode: 'HOST_SESSION_INACTIVE'
    })
    return
  }

  const target = state.clients.get(targetClientId)
  if (!target || !target.role) {
    sendJson(res, 404, { error: 'Target participant is not active' })
    return
  }

  applyClientSettings(target, target.role, body.settings)
  state.counters.participantSettingsUpdates += 1
  recordDebugEvent(state, 'participant-settings', {
    actorClientId,
    actorSessionId: actor && actor.role === 'broadcaster' ? actorSessionId : '',
    targetClientId,
    role: target.role,
    settings: target.settings
  })
  const participants = broadcastParticipants(state)
  sendJson(res, 200, { ok: true, participants })
}

async function handleListenerCommand(state, req, res) {
  const body = await readBody(req)
  const actorClientId = body.clientId
  const actorSessionId = normalizeSessionId(body.sessionId)
  const targetClientId = body.targetClientId
  const command = typeof body.command === 'string'
    ? body.command.trim().toLowerCase()
    : ''
  const validCommands = new Set(['refresh', 'join', 'leave'])

  if (!actorClientId || !targetClientId || !validCommands.has(command)) {
    sendJson(res, 400, { error: 'Missing or invalid clientId, targetClientId, or command' })
    return
  }

  const actor = state.clients.get(actorClientId)
  if (!actor || actor.role !== 'broadcaster' || state.broadcasterId !== actorClientId) {
    sendJson(res, 403, { error: 'Only active host may issue listener commands' })
    return
  }

  if (!isActiveBroadcasterSession(state, actorClientId, actorSessionId)) {
    sendJson(res, 403, {
      error: 'Only active host session may issue listener commands',
      errorCode: 'HOST_SESSION_INACTIVE'
    })
    return
  }

  const targets = targetClientId === '*'
    ? Array.from(state.clients.values())
      .filter(client => client.role === 'listener' && client.res)
    : [state.clients.get(targetClientId)].filter(Boolean)

  const activeTargets = targets.filter(client => client.role === 'listener' && client.res)

  if (!activeTargets.length) {
    sendJson(res, 404, { error: 'Target listener is not connected' })
    return
  }

  const emittedAt = new Date().toISOString()

  activeTargets.forEach(target => {
    sendEvent(target, 'host-command', {
      command,
      requestedBy: actorClientId,
      targetClientId: target.id,
      at: emittedAt
    })
  })

  recordDebugEvent(state, 'listener-command', {
    actorClientId,
    actorSessionId,
    targetClientId,
    deliveredCount: activeTargets.length,
    command
  })

  sendJson(res, 200, {
    ok: true,
    deliveredCount: activeTargets.length,
    command
  })
}

async function handleClientDiagnostics(state, req, res) {
  const body = await readBody(req)
  const clientId = body.clientId
  const text = typeof body.text === 'string' ? body.text : ''

  if (!clientId) {
    sendJson(res, 400, { error: 'Missing clientId' })
    return
  }

  const client = state.clients.get(clientId)
  if (!client || !client.role) {
    sendJson(res, 404, { error: 'Client is not active' })
    return
  }

  const previousText = client.diagnostics
  const diagnosticsAt = new Date().toISOString()
  const diagnosticsSummary = parseDiagnosticsSummary(text)
  client.diagnostics = text
  client.diagnosticsAt = diagnosticsAt

  if (diagnosticsSummary.directFallback === 'yes') {
    client.lastDirectFallbackAt = diagnosticsAt
    client.lastDirectFallbackStatus = diagnosticsSummary.status || client.lastDirectFallbackStatus || ''
  }

  state.counters.diagnosticsUpdates += 1
  recordDebugEvent(state, 'diagnostics', {
    clientId,
    role: client.role,
    changed: previousText !== text,
    diagnosticsAt,
    summary: diagnosticsSummary
  })
  const diagnostics = broadcastDiagnostics(state)
  sendJson(res, 200, { ok: true, diagnostics })
}

async function handleServerControl(server, state, req, res, activePort) {
  const body = await readBody(req)
  const action = typeof body.action === 'string'
    ? body.action.trim().toLowerCase()
    : ''

  if (action !== 'start' && action !== 'stop' && action !== 'shutdown') {
    sendJson(res, 400, { error: 'Invalid action. Use start, stop, or shutdown.' })
    return
  }

  if (action === 'shutdown') {
    sendJson(res, 200, {
      ok: true,
      shuttingDown: true,
      ...getStatusSnapshot(state, activePort)
    })
    shutdownProcess(server, state, 'api-shutdown')
    return
  }

  if (state.shuttingDown) {
    sendJson(res, 503, { error: 'Server is shutting down' })
    return
  }

  if (action === 'stop') {
    const changed = stopService(state, 'api-server-stop')
    recordDebugEvent(state, 'server-control', {
      action: 'stop',
      changed,
      running: state.serverRunning
    })
  } else {
    const changed = startService(state)
    recordDebugEvent(state, 'server-control', {
      action: 'start',
      changed,
      running: state.serverRunning
    })
  }

  sendJson(res, 200, {
    ok: true,
    ...getStatusSnapshot(state, activePort)
  })
}

function createServer() {
  const state = createState()
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      const address = server.address()
      const activePort = address && typeof address === 'object' ? address.port : PORT

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
        })
        res.end()
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/events') {
        if (!state.serverRunning) {
          sendJson(res, 503, { error: 'Server is stopped' })
          return
        }
        attachSse(state, req, res, parsedUrl)
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/api/debug/events') {
        attachDebugEvents(state, req, res, activePort)
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/api/debug/state') {
        sendJson(res, 200, getDebugStateSnapshot(state, activePort))
        return
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/server-control') {
        await handleServerControl(server, state, req, res, activePort)
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/api/status') {
        sendJson(res, 200, getStatusSnapshot(state, activePort))
        return
      }

      const requiresRunningServer =
        (req.method === 'GET' && parsedUrl.pathname === '/events') ||
        (req.method === 'POST' && (
          parsedUrl.pathname === '/api/register' ||
          parsedUrl.pathname === '/api/unregister' ||
          parsedUrl.pathname === '/api/signal' ||
          parsedUrl.pathname === '/api/participant-settings' ||
          parsedUrl.pathname === '/api/listener-command' ||
          parsedUrl.pathname === '/api/client-diagnostics'
        ))

      if (!state.serverRunning && requiresRunningServer) {
        sendJson(res, 503, { error: 'Server is stopped' })
        return
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/register') {
        await handleRegister(state, req, res)
        return
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/unregister') {
        await handleUnregister(state, req, res)
        return
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/signal') {
        await handleSignal(state, req, res)
        return
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/participant-settings') {
        await handleParticipantSettings(state, req, res)
        return
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/listener-command') {
        await handleListenerCommand(state, req, res)
        return
      }

      if (req.method === 'POST' && parsedUrl.pathname === '/api/client-diagnostics') {
        await handleClientDiagnostics(state, req, res)
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/simplepeer.min.js') {
        serveFile(res, SIMPLE_PEER_PATH)
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname.startsWith('/vendor/weq8-local/')) {
        const filePath = parsedUrl.pathname.slice('/vendor/weq8-local/'.length)
        const resolvedPath = path.join(LOCAL_WEQ8_DIST_DIR, filePath)
        const normalizedLocalWeq8Dir = path.resolve(LOCAL_WEQ8_DIST_DIR)
        const normalizedResolvedPath = path.resolve(resolvedPath)

        if (!normalizedResolvedPath.startsWith(normalizedLocalWeq8Dir)) {
          sendJson(res, 403, { error: 'Forbidden' })
          return
        }

        serveFile(res, normalizedResolvedPath)
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname.startsWith('/vendor/npm/')) {
        const filePath = parsedUrl.pathname.slice('/vendor/npm/'.length)
        const resolvedPath = path.join(NODE_MODULES_DIR, filePath)
        const normalizedNodeModulesDir = path.resolve(NODE_MODULES_DIR)
        const normalizedResolvedPath = path.resolve(resolvedPath)

        if (!normalizedResolvedPath.startsWith(normalizedNodeModulesDir)) {
          sendJson(res, 403, { error: 'Forbidden' })
          return
        }

        serveFile(res, normalizedResolvedPath)
        return
      }

      if (req.method === 'GET') {
        let filePath = parsedUrl.pathname

        if (filePath === '/') filePath = '/index.html'
        if (filePath === '/host') filePath = '/host.html'
        if (filePath === '/listen') filePath = '/listen.html'

        const resolvedPath = path.join(PUBLIC_DIR, filePath)
        const normalizedPublicDir = path.resolve(PUBLIC_DIR)
        const normalizedResolvedPath = path.resolve(resolvedPath)

        if (!normalizedResolvedPath.startsWith(normalizedPublicDir)) {
          sendJson(res, 403, { error: 'Forbidden' })
          return
        }

        serveFile(res, normalizedResolvedPath)
        return
      }

      sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      sendJson(res, 500, { error: error.message })
    }
  })

  server.homeAudioState = state
  return server
}

function startServer() {
  ensureDebugLogDirectory()
  const server = createServer()

  server.on('error', error => {
    if (error && error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`)
      console.error('Another Home Audio process is already running.')
      console.error(`If http://localhost:${PORT}/host shows "resume relay", resume it there (do not launch another node instance).`)
      console.error(`To fully stop that process, use the host page button "shutdown app".`)
      console.error(`Otherwise stop the existing process using port ${PORT}, or run with PORT=<new-port>.`)
      process.exit(1)
      return
    }

    console.error(error)
    process.exit(1)
  })

  server.listen(PORT, HOST, () => {
    const address = server.address()
    const activePort = address && typeof address === 'object' ? address.port : PORT
    const lanUrls = getLanAddresses(activePort)
    recordDebugEvent(server.homeAudioState, 'server-start', {
      host: HOST,
      port: activePort,
      debugLogPath: DEBUG_LOG_PATH
    })
    console.log(`LAN audio server running on port ${activePort}`)
    console.log(`Host page: http://localhost:${activePort}/host`)
    console.log(`Debug state: http://localhost:${activePort}/api/debug/state`)
    console.log(`Debug events: http://localhost:${activePort}/api/debug/events`)
    console.log(`Debug log: ${DEBUG_LOG_PATH}`)
    if (lanUrls.length) {
      console.log('Phone listener pages:')
      lanUrls.forEach(url => {
        console.log(`  ${url}/listen`)
      })
    } else {
      console.log('No LAN IPv4 addresses detected. Your phone may not be able to reach this PC yet.')
    }
  })

  return server
}

if (require.main === module) {
  startServer()
}

module.exports = {
  createServer,
  getLanAddresses
}
