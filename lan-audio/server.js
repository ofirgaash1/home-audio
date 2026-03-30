'use strict'

const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const { URL } = require('url')

const PORT = Number(process.env.PORT || 43117)
const HOST = process.env.HOST || '0.0.0.0'
const PUBLIC_DIR = path.join(__dirname, 'public')
const SIMPLE_PEER_PATH = path.join(__dirname, '..', 'simplepeer.min.js')

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
    broadcasterId: null,
    clients: new Map()
  }
}

function getDefaultSettings(role) {
  return {
    delayMs: role === 'broadcaster' ? 250 : 100,
    channelMode: 'stereo'
  }
}

function clampDelay(value) {
  const delay = Number(value)
  if (!Number.isFinite(delay)) return 0
  return Math.max(0, Math.min(5000, Math.round(delay)))
}

function normalizeChannelMode(mode) {
  if (mode === 'mono') return mode
  if (mode === 'left' || mode === 'right') return mode
  return 'stereo'
}

function getOrCreateClient(state, clientId) {
  let client = state.clients.get(clientId)
  if (!client) {
    client = {
      id: clientId,
      role: null,
      res: null,
      settings: null,
      diagnostics: ''
    }
    state.clients.set(clientId, client)
  }
  return client
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

function getClientLabel(client) {
  if (client.role === 'broadcaster') return 'Host'
  return `Listener ${client.id.slice(-4)}`
}

function getParticipantsSnapshot(state) {
  return Array.from(state.clients.values())
    .filter(client => client.role)
    .map(client => ({
      clientId: client.id,
      role: client.role,
      label: getClientLabel(client),
      delayMs: client.settings ? client.settings.delayMs : getDefaultSettings(client.role).delayMs,
      channelMode: client.settings ? client.settings.channelMode : 'stereo'
    }))
    .sort((left, right) => {
      if (left.role === 'broadcaster' && right.role !== 'broadcaster') return -1
      if (right.role === 'broadcaster' && left.role !== 'broadcaster') return 1
      return left.label.localeCompare(right.label)
    })
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

function getDiagnosticsSnapshot(state) {
  const diagnostics = {}

  state.clients.forEach(client => {
    if (!client.role) return
    diagnostics[client.id] = {
      clientId: client.id,
      role: client.role,
      label: getClientLabel(client),
      text: client.diagnostics || ''
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

function unregisterClient(state, clientId) {
  const client = state.clients.get(clientId)
  if (!client) return

  if (client.role === 'listener' && state.broadcasterId) {
    const broadcaster = state.clients.get(state.broadcasterId)
    sendEvent(broadcaster, 'client-left', { clientId })
  }

  if (client.role === 'broadcaster' && state.broadcasterId === clientId) {
    state.broadcasterId = null
    state.clients.forEach(otherClient => {
      if (otherClient.id !== clientId && otherClient.role === 'listener') {
        sendEvent(otherClient, 'host-left', { broadcasterId: clientId })
      }
    })
  }

  client.role = null
  client.settings = null
  client.diagnostics = ''
  broadcastParticipants(state)
  broadcastDiagnostics(state)
}

function attachSse(state, req, res, parsedUrl) {
  const clientId = parsedUrl.searchParams.get('clientId')
  if (!clientId) {
    sendJson(res, 400, { error: 'Missing clientId' })
    return
  }

  const client = getOrCreateClient(state, clientId)
  client.res = res

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  })

  res.write(': connected\n\n')
  sendEvent(client, 'ready', { clientId })
  sendEvent(client, 'diagnostics', { diagnostics: getDiagnosticsSnapshot(state) })

  req.on('close', () => {
    const currentClient = state.clients.get(clientId)
    if (!currentClient) return
    currentClient.res = null
    unregisterClient(state, clientId)
  })
}

async function handleRegister(state, req, res) {
  const body = await readBody(req)
  const clientId = body.clientId
  const role = body.role

  if (!clientId || !role) {
    sendJson(res, 400, { error: 'Missing clientId or role' })
    return
  }

  if (role !== 'broadcaster' && role !== 'listener') {
    sendJson(res, 400, { error: 'Invalid role' })
    return
  }

  const client = getOrCreateClient(state, clientId)

  if (role === 'broadcaster') {
    if (state.broadcasterId && state.broadcasterId !== clientId) {
      sendJson(res, 409, { error: 'Another broadcaster is already active' })
      return
    }

    state.broadcasterId = clientId
    client.role = 'broadcaster'
    applyClientSettings(client, role, body.settings)

    const participants = broadcastParticipants(state)
    broadcastDiagnostics(state)
    sendJson(res, 200, {
      ok: true,
      role,
      clientId,
      listeners: listListenerIds(state),
      participants
    })
    return
  }

  client.role = 'listener'
  applyClientSettings(client, role, body.settings)

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
  if (!body.clientId) {
    sendJson(res, 400, { error: 'Missing clientId' })
    return
  }

  unregisterClient(state, body.clientId)
  sendJson(res, 200, { ok: true })
}

async function handleSignal(state, req, res) {
  const body = await readBody(req)
  const from = body.from
  const to = body.to
  const signal = body.signal

  if (!from || !to || !signal) {
    sendJson(res, 400, { error: 'Missing from, to, or signal' })
    return
  }

  const target = state.clients.get(to)
  if (!target || !target.res) {
    sendJson(res, 404, { error: 'Target client is not connected' })
    return
  }

  sendEvent(target, 'signal', { from, signal })
  sendJson(res, 200, { ok: true })
}

async function handleParticipantSettings(state, req, res) {
  const body = await readBody(req)
  const targetClientId = body.targetClientId

  if (!targetClientId || !body.settings) {
    sendJson(res, 400, { error: 'Missing targetClientId or settings' })
    return
  }

  const target = state.clients.get(targetClientId)
  if (!target || !target.role) {
    sendJson(res, 404, { error: 'Target participant is not active' })
    return
  }

  applyClientSettings(target, target.role, body.settings)
  const participants = broadcastParticipants(state)
  sendJson(res, 200, { ok: true, participants })
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

  client.diagnostics = text
  const diagnostics = broadcastDiagnostics(state)
  sendJson(res, 200, { ok: true, diagnostics })
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
        attachSse(state, req, res, parsedUrl)
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/api/status') {
        sendJson(res, 200, {
          hostPage: `http://localhost:${activePort}/host`,
          listenPages: getLanAddresses(activePort).map(url => `${url}/listen`),
          port: activePort
        })
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

      if (req.method === 'POST' && parsedUrl.pathname === '/api/client-diagnostics') {
        await handleClientDiagnostics(state, req, res)
        return
      }

      if (req.method === 'GET' && parsedUrl.pathname === '/simplepeer.min.js') {
        serveFile(res, SIMPLE_PEER_PATH)
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

  return server
}

function startServer() {
  const server = createServer()

  server.listen(PORT, HOST, () => {
    const address = server.address()
    const activePort = address && typeof address === 'object' ? address.port : PORT
    const lanUrls = getLanAddresses(activePort)
    console.log(`LAN audio server running on port ${activePort}`)
    console.log(`Host page: http://localhost:${activePort}/host`)
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
