'use strict'

const startButton = document.querySelector('#start')
const stopButton = document.querySelector('#stop')
const statusBox = document.querySelector('#status')
const listenLinks = document.querySelector('#listen-links')
const listenerCount = document.querySelector('#listener-count')
const sourceDeviceSelect = document.querySelector('#source-device')
const monitorDeviceSelect = document.querySelector('#monitor-device')
const refreshDevicesButton = document.querySelector('#refresh-devices')
const monitorDelayInput = document.querySelector('#monitor-delay')
const monitorDelayValue = document.querySelector('#monitor-delay-value')
const monitorPlayer = document.querySelector('#monitor-player')
const presetButtons = Array.from(document.querySelectorAll('.preset-button'))
const participantsBody = document.querySelector('#participants-body')
const diagnosticsBox = document.querySelector('#diagnostics')
const listenerDiagnosticsBox = document.querySelector('#listener-diagnostics')
const sourceMeterCanvas = document.querySelector('#source-meter')
const sourceMeterValue = document.querySelector('#source-meter-value')
const monitorMeterCanvas = document.querySelector('#monitor-meter')
const monitorMeterValue = document.querySelector('#monitor-meter-value')

const hostId = randomId('host')
const peers = new Map()
const listenerProcessors = new Map()

let eventSource = null
let captureStream = null
let audioOnlyStream = null
let stopping = false
let monitorProcessor = null
let participants = []
let diagnosticsInterval = null
let remoteDiagnostics = {}
let peerTransportStats = {}
let lastPeerTraffic = {}
let diagnosticsBusy = false
let lastDiagnosticsText = ''
const sourceVisualizer = createStreamVisualizer(sourceMeterCanvas, sourceMeterValue)
const monitorVisualizer = createStreamVisualizer(monitorMeterCanvas, monitorMeterValue)

function normalizeErrorMessage(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  return String(error)
}

function wait(ms) {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

async function postSignalWithRetry(from, to, signal) {
  const attempts = signal && signal.type === 'offer' ? 12 : 6
  let lastError = null

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await postJson('/api/signal', { from, to, signal })
      return
    } catch (error) {
      lastError = error
      const message = normalizeErrorMessage(error)
      const shouldRetry = /Target client is not connected/i.test(message)

      if (!shouldRetry || attempt === attempts) {
        throw error
      }

      await wait(150 * attempt)
    }
  }

  throw lastError || new Error('Signal send failed')
}

function isCableDeviceLabel(label) {
  return /vb-audio|virtual cable|cable input|cable output/i.test(label || '')
}

function describeDevice(device, fallbackPrefix, index) {
  if (device.label) return device.label
  return `${fallbackPrefix} ${index + 1}`
}

function getSelfParticipant() {
  return findParticipant(participants, hostId)
}

function updateListenerCount() {
  listenerCount.textContent = String(
    participants.filter(participant => participant.role === 'listener').length
  )
}

function updateMonitorDelayLabel() {
  monitorDelayValue.textContent = `${monitorDelayInput.value} ms`
}

function summarizeTrack(track) {
  if (!track) return 'none'
  return `${track.kind}:${track.readyState}${track.enabled ? ':enabled' : ':disabled'}`
}

function summarizeStream(stream) {
  if (!stream) return 'none'
  return `id=${stream.id} tracks=[${stream.getTracks().map(summarizeTrack).join(', ')}]`
}

function summarizePeer(listenerId, peer) {
  if (!peer || !peer._pc) {
    return `${listenerId}: no peer connection`
  }

  const outboundProcessor = listenerProcessors.get(listenerId)
  const senders = typeof peer._pc.getSenders === 'function'
    ? peer._pc.getSenders().map(sender => summarizeTrack(sender.track))
    : []
  const stats = peerTransportStats[listenerId]
  const listenerParticipant = findParticipant(participants, listenerId)
  const outboundMode = listenerParticipant ? listenerParticipant.channelMode : 'n/a'
  const outboundDelay = listenerParticipant ? listenerParticipant.delayMs : 'n/a'

  const lines = [
    `${listenerId}:`,
    `  outboundDelayMs=${outboundDelay}`,
    `  outboundChannelMode=${outboundMode}`,
    `  outboundProcessorLevel=${outboundProcessor && typeof outboundProcessor.getLevel === 'function'
      ? outboundProcessor.getLevel().toFixed(4)
      : 'n/a'}`,
    `  pc.connectionState=${peer._pc.connectionState || 'n/a'}`,
    `  pc.iceConnectionState=${peer._pc.iceConnectionState || 'n/a'}`,
    `  pc.signalingState=${peer._pc.signalingState || 'n/a'}`,
    `  dataChannelConnected=${peer.connected ? 'yes' : 'no'}`,
    `  senders=${senders.length ? senders.join(', ') : 'none'}`
  ]

  if (stats) {
    lines.push(`  sender.bytesSent=${stats.bytesSent}`)
    lines.push(`  sender.deltaBytes=${stats.deltaBytes}`)
    lines.push(`  sender.packetsSent=${stats.packetsSent}`)
    lines.push(`  sender.deltaPackets=${stats.deltaPackets}`)
    lines.push(`  sender.codec=${stats.codec}`)
    lines.push(`  sender.audioLevelStat=${stats.audioLevel}`)
    lines.push(`  sender.totalAudioEnergy=${stats.totalAudioEnergy}`)
    lines.push(`  sender.trackMuted=${stats.trackMuted}`)
    lines.push(`  sender.trackEnabled=${stats.trackEnabled}`)
    lines.push(`  sender.rtt=${stats.currentRoundTripTime}`)
  }

  return lines.join('\n')
}

async function collectPeerTransportStats(listenerId, peer) {
  if (!peer || !peer._pc || typeof peer._pc.getStats !== 'function') {
    peerTransportStats[listenerId] = {
      bytesSent: 'n/a',
      deltaBytes: 'n/a',
      packetsSent: 'n/a',
      deltaPackets: 'n/a',
      codec: 'n/a',
      audioLevel: 'n/a',
      totalAudioEnergy: 'n/a',
      trackMuted: 'n/a',
      trackEnabled: 'n/a',
      currentRoundTripTime: 'n/a'
    }
    return
  }

  const stats = await peer._pc.getStats()
  let bytesSent = 0
  let packetsSent = 0
  let codecId = null
  let audioLevel = null
  let totalAudioEnergy = null
  let trackMuted = 'n/a'
  let trackEnabled = 'n/a'
  let currentRoundTripTime = null

  stats.forEach(report => {
    const isOutboundAudio = report.type === 'outbound-rtp' &&
      (report.kind === 'audio' || report.mediaType === 'audio') &&
      !report.isRemote

    if (isOutboundAudio) {
      bytesSent += Number(report.bytesSent || 0)
      packetsSent += Number(report.packetsSent || 0)

      if (!codecId && report.codecId) {
        codecId = report.codecId
      }
    }

    const isTrackStat = report.type === 'track' &&
      report.kind === 'audio' &&
      report.remoteSource === false

    if (isTrackStat) {
      if (typeof report.audioLevel === 'number') {
        audioLevel = report.audioLevel
      }

      if (typeof report.totalAudioEnergy === 'number') {
        totalAudioEnergy = report.totalAudioEnergy
      }

      if (typeof report.muted === 'boolean') {
        trackMuted = report.muted ? 'yes' : 'no'
      }

      if (typeof report.ended === 'boolean') {
        trackEnabled = report.ended ? 'no' : 'yes'
      }
    }

    const isSelectedPair = report.type === 'candidate-pair' &&
      report.selected &&
      typeof report.currentRoundTripTime === 'number'

    if (isSelectedPair) {
      currentRoundTripTime = report.currentRoundTripTime
    }
  })

  const previousTraffic = lastPeerTraffic[listenerId] || {}
  const deltaBytes = previousTraffic.bytesSent === undefined
    ? 0
    : Math.max(0, bytesSent - previousTraffic.bytesSent)
  const deltaPackets = previousTraffic.packetsSent === undefined
    ? 0
    : Math.max(0, packetsSent - previousTraffic.packetsSent)

  lastPeerTraffic[listenerId] = {
    bytesSent,
    packetsSent
  }

  const codecReport = codecId && typeof stats.get === 'function' ? stats.get(codecId) : null
  const codec = codecReport && codecReport.mimeType
    ? codecReport.mimeType
    : 'n/a'

  peerTransportStats[listenerId] = {
    bytesSent: String(bytesSent),
    deltaBytes: String(deltaBytes),
    packetsSent: String(packetsSent),
    deltaPackets: String(deltaPackets),
    codec,
    audioLevel: typeof audioLevel === 'number' ? audioLevel.toFixed(5) : 'n/a',
    totalAudioEnergy: typeof totalAudioEnergy === 'number' ? totalAudioEnergy.toFixed(5) : 'n/a',
    trackMuted,
    trackEnabled,
    currentRoundTripTime: typeof currentRoundTripTime === 'number'
      ? `${Math.round(currentRoundTripTime * 1000)}ms`
      : 'n/a'
  }
}

async function updatePeerStats() {
  if (diagnosticsBusy) return
  diagnosticsBusy = true

  try {
    const peerEntries = Array.from(peers.entries())
    if (!peerEntries.length) {
      peerTransportStats = {}
      lastPeerTraffic = {}
      return
    }

    const activeIds = new Set(peerEntries.map(([listenerId]) => listenerId))

    await Promise.all(peerEntries.map(async ([listenerId, peer]) => {
      try {
        await collectPeerTransportStats(listenerId, peer)
      } catch (error) {
        peerTransportStats[listenerId] = {
          bytesSent: 'n/a',
          deltaBytes: 'n/a',
          packetsSent: 'n/a',
          deltaPackets: 'n/a',
          codec: 'n/a',
          audioLevel: 'n/a',
          totalAudioEnergy: 'n/a',
          trackMuted: 'n/a',
          trackEnabled: 'n/a',
          currentRoundTripTime: `error: ${error.message || 'failed'}`
        }
      }
    }))

    Object.keys(peerTransportStats).forEach(listenerId => {
      if (!activeIds.has(listenerId)) {
        delete peerTransportStats[listenerId]
      }
    })

    Object.keys(lastPeerTraffic).forEach(listenerId => {
      if (!activeIds.has(listenerId)) {
        delete lastPeerTraffic[listenerId]
      }
    })
  } finally {
    diagnosticsBusy = false
  }
}

function getDiagnosticsText() {
  const peerLines = peers.size
    ? Array.from(peers.entries()).map(([listenerId, peer]) => summarizePeer(listenerId, peer))
    : ['no active listener peers']

  return [
    `hostId=${hostId}`,
    `participants=${participants.length}`,
    `sourceDevice=${sourceDeviceSelect.value || 'none'}`,
    `monitorDevice=${monitorDeviceSelect.value || 'default'}`,
    `captureStream=${summarizeStream(captureStream)}`,
    `audioOnlyStream=${summarizeStream(audioOnlyStream)}`,
    `broadcastStream=${summarizeStream(audioOnlyStream)}`,
    `monitorStream=${monitorProcessor ? summarizeStream(monitorProcessor.outputStream) : 'none'}`,
    `sourceMeterLevel=${Math.round(sourceVisualizer.getLevel() * 100)}%`,
    `monitorMeterLevel=${Math.round(monitorVisualizer.getLevel() * 100)}%`,
    `monitorProcessorLevel=${monitorProcessor && typeof monitorProcessor.getLevel === 'function'
      ? monitorProcessor.getLevel().toFixed(4)
      : 'n/a'}`,
    `status="${statusBox.textContent}"`,
    '',
    ...peerLines
  ].join('\n')
}

function renderDiagnostics() {
  diagnosticsBox.textContent = getDiagnosticsText()
}

async function pushDiagnostics() {
  if (!getSelfParticipant()) return

  const text = getDiagnosticsText()
  if (text === lastDiagnosticsText) return
  lastDiagnosticsText = text

  try {
    await postJson('/api/client-diagnostics', {
      clientId: hostId,
      text
    })
  } catch (error) {
    console.debug('Host diagnostics push failed:', error)
  }
}

function renderRemoteDiagnostics() {
  const activeListeners = participants.filter(participant => participant.role === 'listener')
  if (!activeListeners.length) {
    listenerDiagnosticsBox.textContent = 'No connected listeners.'
    return
  }

  const blocks = activeListeners.map(participant => {
    const snapshot = remoteDiagnostics[participant.clientId]
    const text = snapshot && snapshot.text
      ? snapshot.text
      : 'No diagnostics received yet from this listener.'
    return `${participant.label} (${participant.clientId})\n${text}`
  })

  listenerDiagnosticsBox.textContent = blocks.join('\n\n----------------\n\n')
}

function startDiagnostics() {
  if (diagnosticsInterval) return
  renderDiagnostics()
  diagnosticsInterval = window.setInterval(() => {
    updatePeerStats()
      .catch(error => {
        console.debug('Host peer stats update failed:', error)
      })
      .finally(() => {
        renderDiagnostics()
        pushDiagnostics().catch(() => {})
      })
  }, 1000)
}

function renderLinks(status) {
  if (!status.listenPages.length) {
    listenLinks.innerHTML = '<p class="small">No LAN IP detected yet.</p>'
    return
  }

  listenLinks.innerHTML = status.listenPages
    .map(url => `<div class="codebox">${url}</div>`)
    .join('')
}

function populateDeviceSelect(select, devices, options) {
  const previousValue = select.value
  const { fallbackPrefix, placeholder, preferredDevice } = options

  select.innerHTML = ''

  if (!devices.length) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = placeholder
    select.appendChild(option)
    select.disabled = true
    return
  }

  select.disabled = false

  devices.forEach((device, index) => {
    const option = document.createElement('option')
    option.value = device.deviceId
    option.textContent = describeDevice(device, fallbackPrefix, index)
    select.appendChild(option)
  })

  if (devices.some(device => device.deviceId === previousValue)) {
    select.value = previousValue
    return
  }

  const preferred = devices.find(preferredDevice)
  select.value = preferred ? preferred.deviceId : devices[0].deviceId
}

async function refreshMediaDevices(options) {
  const { primeLabels } = options || {}

  if (primeLabels) {
    try {
      const permissionProbe = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false
      })
      permissionProbe.getTracks().forEach(track => track.stop())
    } catch (error) {
      setStatus(statusBox, `Audio device permission failed: ${error.message}`, 'warn')
    }
  }

  const devices = await navigator.mediaDevices.enumerateDevices()
  const inputDevices = devices.filter(device => device.kind === 'audioinput')
  const outputDevices = devices.filter(device => device.kind === 'audiooutput')

  populateDeviceSelect(sourceDeviceSelect, inputDevices, {
    fallbackPrefix: 'Audio input',
    placeholder: 'No audio inputs found',
    preferredDevice: device => /cable output/i.test(device.label || '')
  })

  populateDeviceSelect(monitorDeviceSelect, outputDevices, {
    fallbackPrefix: 'Audio output',
    placeholder: 'No audio outputs found',
    preferredDevice: device => !isCableDeviceLabel(device.label)
  })
}

function renderParticipants() {
  renderParticipantsTable(participantsBody, participants, hostId, {
    onAdjustDelay(targetClientId, delta) {
      adjustParticipantDelay(participants, targetClientId, delta, updateParticipantSettings).catch(error => {
        setStatus(statusBox, error.message, 'warn')
      })
    },
    onChangeChannel(targetClientId, channelMode) {
      updateParticipantSettings(targetClientId, {
        channelMode
      }).catch(error => {
        setStatus(statusBox, error.message, 'warn')
      })
    }
  })

  updateListenerCount()
}

function syncSelfDelayControl() {
  const selfParticipant = getSelfParticipant()
  if (!selfParticipant) {
    updateMonitorDelayLabel()
    return
  }

  monitorDelayInput.value = String(selfParticipant.delayMs)
  updateMonitorDelayLabel()
}

function applySelfAudioSettings() {
  const selfParticipant = getSelfParticipant()
  if (!selfParticipant || !monitorProcessor) return
  monitorProcessor.setDelay(selfParticipant.delayMs)
  monitorProcessor.setChannelMode(selfParticipant.channelMode)
}

function syncListenerOutboundSettings() {
  listenerProcessors.forEach((processor, listenerId) => {
    const participant = findParticipant(participants, listenerId)
    if (!participant || !processor) return
    processor.setDelay(participant.delayMs)
    processor.setChannelMode(participant.channelMode)
  })
}

function updateParticipants(nextParticipants) {
  participants = nextParticipants || []
  renderParticipants()
  syncSelfDelayControl()
  applySelfAudioSettings()
  syncListenerOutboundSettings()
  renderDiagnostics()
  renderRemoteDiagnostics()
}

function ensureEventSource() {
  if (eventSource) return

  eventSource = new EventSource(`/events?clientId=${encodeURIComponent(hostId)}`)

  eventSource.addEventListener('listener-joined', async event => {
    const payload = JSON.parse(event.data)
    if (!audioOnlyStream) return
    await createPeer(payload.clientId)
  })

  eventSource.addEventListener('client-left', event => {
    const payload = JSON.parse(event.data)
    destroyPeer(payload.clientId)
  })

  eventSource.addEventListener('participants', event => {
    const payload = JSON.parse(event.data)
    updateParticipants(payload.participants)
  })

  eventSource.addEventListener('diagnostics', event => {
    const payload = JSON.parse(event.data)
    remoteDiagnostics = payload.diagnostics || {}
    renderRemoteDiagnostics()
  })

  eventSource.addEventListener('signal', async event => {
    const payload = JSON.parse(event.data)
    let peer = peers.get(payload.from)

    if (!peer && audioOnlyStream) {
      peer = await createPeer(payload.from)
    }

    if (peer) {
      peer.signal(payload.signal)
    }
  })
}

async function updateParticipantSettings(targetClientId, settings) {
  const response = await postJson('/api/participant-settings', {
    clientId: hostId,
    targetClientId,
    settings
  })

  updateParticipants(response.participants)
}

async function setMonitorOutputDevice() {
  if (!monitorPlayer.srcObject) return
  if (!monitorDeviceSelect.value) return

  if (typeof monitorPlayer.setSinkId !== 'function') {
    throw new Error('This browser cannot pick a separate speaker device. Use Chrome or Edge on the PC.')
  }

  await monitorPlayer.setSinkId(monitorDeviceSelect.value)
}

async function startLocalMonitor() {
  stopLocalMonitor()

  const selfParticipant = getSelfParticipant() || {
    delayMs: 0,
    channelMode: 'stereo'
  }

  monitorProcessor = await createProcessedAudioEngine(audioOnlyStream, {
    delayMs: selfParticipant.delayMs,
    channelMode: selfParticipant.channelMode
  })

  monitorPlayer.srcObject = monitorProcessor.outputStream
  await monitorVisualizer.attachStream(monitorProcessor.outputStream)
  await setMonitorOutputDevice()
  await monitorPlayer.play()
}

function stopLocalMonitor() {
  monitorPlayer.pause()
  monitorPlayer.srcObject = null

  if (monitorProcessor) {
    monitorProcessor.close().catch(() => {})
  }

  monitorProcessor = null
  monitorVisualizer.clear('Waiting for audio')
}

function destroyPeer(clientId) {
  const peer = peers.get(clientId)
  if (!peer) return
  peers.delete(clientId)
  peer.destroy()
  const processor = listenerProcessors.get(clientId)
  if (processor) {
    processor.close().catch(() => {})
    listenerProcessors.delete(clientId)
  }
  delete peerTransportStats[clientId]
  delete lastPeerTraffic[clientId]
}

async function createPeer(listenerId) {
  const existingPeer = peers.get(listenerId)
  if (existingPeer) return existingPeer

  const listenerParticipant = findParticipant(participants, listenerId) || {
    delayMs: 0,
    channelMode: 'stereo'
  }
  const outboundProcessor = await createProcessedAudioEngine(audioOnlyStream, {
    delayMs: listenerParticipant.delayMs,
    channelMode: listenerParticipant.channelMode,
    keepAliveDestination: true
  })
  const outboundStream = outboundProcessor.outputStream

  const peer = new SimplePeer({
    initiator: true,
    trickle: true,
    config: { iceServers: [] }
  })

  peer.on('signal', async signal => {
    try {
      await postSignalWithRetry(hostId, listenerId, signal)
    } catch (error) {
      setStatus(statusBox, normalizeErrorMessage(error), 'warn')
    }
  })

  peer.on('connect', () => {
    setStatus(statusBox, `Broadcast live. Active participants: ${participants.length}`)
    renderDiagnostics()
  })

  peer.on('close', () => {
    peers.delete(listenerId)
    const processor = listenerProcessors.get(listenerId)
    if (processor) {
      processor.close().catch(() => {})
      listenerProcessors.delete(listenerId)
    }
    renderDiagnostics()
  })

  peer.on('error', error => {
    console.error(error)
    destroyPeer(listenerId)
    renderDiagnostics()
  })

  if (outboundStream) {
    outboundStream.getAudioTracks().forEach(track => {
      try {
        peer.addTrack(track, outboundStream)
      } catch (error) {
        console.error('Failed adding audio track to peer:', error)
      }
    })
  }

  peers.set(listenerId, peer)
  listenerProcessors.set(listenerId, outboundProcessor)
  renderDiagnostics()

  return peer
}

async function startBroadcast() {
  ensureEventSource()
  await refreshMediaDevices({ primeLabels: true })

  if (!sourceDeviceSelect.value) {
    throw new Error('Select the VB-CABLE source device first.')
  }

  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: sourceDeviceSelect.value },
      channelCount: 2,
      sampleRate: 48000,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    },
    video: false
  })

  const audioTracks = captureStream.getAudioTracks()
  if (!audioTracks.length) {
    captureStream.getTracks().forEach(track => track.stop())
    captureStream = null
    throw new Error('No audio came from the selected device.')
  }

  audioOnlyStream = new MediaStream(audioTracks)
  await optimizeAudioStream(audioOnlyStream)
  await sourceVisualizer.attachStream(audioOnlyStream)

  const registration = await postJson('/api/register', {
    clientId: hostId,
    role: 'broadcaster',
    settings: {
      delayMs: clampDelay(monitorDelayInput.value),
      channelMode: 'stereo'
    }
  })

  updateParticipants(registration.participants)
  await startLocalMonitor()
  renderDiagnostics()

  audioTracks.forEach(track => {
    track.addEventListener('ended', () => {
      stopBroadcast()
    }, { once: true })
  })

  startButton.disabled = true
  stopButton.disabled = false
  setStatus(statusBox, 'Broadcast started. Everyone can now tune delay and channel mode from the participant table.')

  for (const listenerId of registration.listeners) {
    await createPeer(listenerId)
  }
}

async function stopBroadcast() {
  if (stopping) return
  stopping = true

  peers.forEach((_, clientId) => {
    destroyPeer(clientId)
  })

  if (captureStream) {
    captureStream.getTracks().forEach(track => track.stop())
    captureStream = null
  }

  audioOnlyStream = null
  sourceVisualizer.clear('Waiting for audio')
  stopLocalMonitor()

  try {
    await postJson('/api/unregister', { clientId: hostId })
  } catch (error) {
    console.error(error)
  }

  lastDiagnosticsText = ''
  updateParticipants([])
  startButton.disabled = false
  stopButton.disabled = true
  setStatus(statusBox, 'Broadcast stopped.')
  stopping = false
  renderDiagnostics()
}

function requestSelfDelayChange(delayMs) {
  monitorDelayInput.value = String(clampDelay(delayMs))
  updateMonitorDelayLabel()

  if (!getSelfParticipant()) return

  updateParticipantSettings(hostId, {
    delayMs: clampDelay(delayMs)
  }).catch(error => {
    setStatus(statusBox, error.message, 'warn')
  })
}

startButton.addEventListener('click', async () => {
  startButton.disabled = true
  setStatus(statusBox, 'Opening the selected audio device...')

  try {
    await startBroadcast()
  } catch (error) {
    console.error(error)
    if (captureStream) {
      captureStream.getTracks().forEach(track => track.stop())
      captureStream = null
    }
    audioOnlyStream = null
    sourceVisualizer.clear('Waiting for audio')
    stopLocalMonitor()
    startButton.disabled = false
    stopButton.disabled = true
    setStatus(statusBox, error.message, 'warn')
  }
})

stopButton.addEventListener('click', () => {
  stopBroadcast()
})

refreshDevicesButton.addEventListener('click', () => {
  refreshMediaDevices({ primeLabels: true }).catch(error => {
    setStatus(statusBox, error.message, 'warn')
  })
})

monitorDelayInput.addEventListener('input', () => {
  requestSelfDelayChange(monitorDelayInput.value)
})

monitorDeviceSelect.addEventListener('change', () => {
  setMonitorOutputDevice().catch(error => {
    setStatus(statusBox, error.message, 'warn')
  })
})

presetButtons.forEach(button => {
  button.addEventListener('click', () => {
    requestSelfDelayChange(button.dataset.delay)
  })
})

window.addEventListener('beforeunload', () => {
  if (eventSource) eventSource.close()
  stopLocalMonitor()
  sourceVisualizer.close().catch(() => {})
  monitorVisualizer.close().catch(() => {})
  if (diagnosticsInterval) {
    window.clearInterval(diagnosticsInterval)
  }
})

updateMonitorDelayLabel()
renderParticipants()
startDiagnostics()
renderRemoteDiagnostics()

fetchStatus()
  .then(renderLinks)
  .catch(error => {
    setStatus(statusBox, error.message, 'warn')
    renderDiagnostics()
  })

refreshMediaDevices()
  .catch(error => {
    setStatus(statusBox, error.message, 'warn')
    renderDiagnostics()
  })

if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === 'function') {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    refreshMediaDevices().catch(() => {})
  })
}
