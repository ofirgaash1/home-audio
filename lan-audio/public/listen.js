'use strict'

const joinButton = document.querySelector('#join')
const leaveButton = document.querySelector('#leave')
const statusBox = document.querySelector('#status')
const player = document.querySelector('#player')
const participantsBody = document.querySelector('#participants-body')
const diagnosticsBox = document.querySelector('#diagnostics')
const incomingMeterCanvas = document.querySelector('#incoming-meter')
const incomingMeterValue = document.querySelector('#incoming-meter-value')
const playbackMeterCanvas = document.querySelector('#playback-meter')
const playbackMeterValue = document.querySelector('#playback-meter-value')

const listenerId = randomId('listener')

let eventSource = null
let peer = null
let broadcasterId = null
let participants = []
let remoteStream = null
let playbackProcessor = null
let wakeLock = null
let usingDirectPlaybackFallback = false
let mediaReady = false
let diagnosticsInterval = null
let joined = false
let lastDiagnosticsText = ''
let receiverStats = {
  bytesReceived: 'n/a',
  packetsReceived: 'n/a',
  deltaBytes: 'n/a',
  deltaPackets: 'n/a',
  packetsLost: 'n/a',
  jitter: 'n/a',
  jitterBufferDelay: 'n/a',
  jitterBufferEmittedCount: 'n/a',
  concealedSamples: 'n/a',
  totalSamplesReceived: 'n/a',
  totalAudioEnergy: 'n/a',
  audioLevel: 'n/a',
  codec: 'n/a'
}
let lastInboundBytes = null
let lastInboundPackets = null
let silentPlaybackStreak = 0
let receiverStatsBusy = false
const incomingVisualizer = createStreamVisualizer(incomingMeterCanvas, incomingMeterValue)
const playbackVisualizer = createStreamVisualizer(playbackMeterCanvas, playbackMeterValue)

function getSelfParticipant() {
  return findParticipant(participants, listenerId)
}

function summarizeTrack(track) {
  if (!track) return 'none'
  return `${track.kind}:${track.readyState}${track.enabled ? ':enabled' : ':disabled'}`
}

function summarizeStream(stream) {
  if (!stream) return 'none'
  return `id=${stream.id} tracks=[${stream.getTracks().map(summarizeTrack).join(', ')}]`
}

function summarizeReceivers(nextPeer) {
  if (!nextPeer || !nextPeer._pc || typeof nextPeer._pc.getReceivers !== 'function') {
    return 'none'
  }

  const receivers = nextPeer._pc.getReceivers().map(receiver => summarizeTrack(receiver.track))
  return receivers.length ? receivers.join(', ') : 'none'
}

function summarizeTrackSettings(track) {
  if (!track || typeof track.getSettings !== 'function') {
    return 'n/a'
  }

  const settings = track.getSettings()
  const keys = [
    'deviceId',
    'channelCount',
    'sampleRate',
    'latency',
    'echoCancellation',
    'noiseSuppression',
    'autoGainControl'
  ]

  const parts = keys
    .filter(key => settings[key] !== undefined)
    .map(key => `${key}=${settings[key]}`)

  return parts.length ? parts.join(', ') : 'none'
}

function summarizeTrackConstraints(track) {
  if (!track || typeof track.getConstraints !== 'function') {
    return 'n/a'
  }

  const constraints = track.getConstraints()
  const keys = Object.keys(constraints)
  if (!keys.length) return 'none'
  return keys.map(key => `${key}=${JSON.stringify(constraints[key])}`).join(', ')
}

function resetReceiverStats() {
  receiverStats = {
    bytesReceived: 'n/a',
    packetsReceived: 'n/a',
    deltaBytes: 'n/a',
    deltaPackets: 'n/a',
    packetsLost: 'n/a',
    jitter: 'n/a',
    jitterBufferDelay: 'n/a',
    jitterBufferEmittedCount: 'n/a',
    concealedSamples: 'n/a',
    totalSamplesReceived: 'n/a',
    totalAudioEnergy: 'n/a',
    audioLevel: 'n/a',
    codec: 'n/a'
  }
  lastInboundBytes = null
  lastInboundPackets = null
  silentPlaybackStreak = 0
}

async function updateReceiverStats() {
  if (receiverStatsBusy) return
  receiverStatsBusy = true

  try {
    if (!peer || !peer._pc || typeof peer._pc.getStats !== 'function') {
      resetReceiverStats()
      return
    }

    const stats = await peer._pc.getStats()
    let bytesReceived = 0
    let packetsReceived = 0
    let packetsLost = 0
    let jitter = null
    let jitterBufferDelay = null
    let jitterBufferEmittedCount = null
    let concealedSamples = null
    let totalSamplesReceived = null
    let totalAudioEnergy = null
    let audioLevel = null
    let codecId = null

    stats.forEach(report => {
      const isInboundAudio = report.type === 'inbound-rtp' &&
        (report.kind === 'audio' || report.mediaType === 'audio') &&
        !report.isRemote

      if (!isInboundAudio) return

      bytesReceived += Number(report.bytesReceived || 0)
      packetsReceived += Number(report.packetsReceived || 0)
      packetsLost += Number(report.packetsLost || 0)

      if (typeof report.jitter === 'number') {
        jitter = report.jitter
      }

      if (typeof report.jitterBufferDelay === 'number') {
        jitterBufferDelay = report.jitterBufferDelay
      }

      if (typeof report.jitterBufferEmittedCount === 'number') {
        jitterBufferEmittedCount = report.jitterBufferEmittedCount
      }

      if (typeof report.concealedSamples === 'number') {
        concealedSamples = report.concealedSamples
      }

      if (typeof report.totalSamplesReceived === 'number') {
        totalSamplesReceived = report.totalSamplesReceived
      }

      if (typeof report.totalAudioEnergy === 'number') {
        totalAudioEnergy = report.totalAudioEnergy
      }

      if (!codecId && report.codecId) {
        codecId = report.codecId
      }
    })

    stats.forEach(report => {
      const isReceiverTrack = report.type === 'track' &&
        report.kind === 'audio' &&
        report.remoteSource === true

      if (!isReceiverTrack) return

      if (typeof report.audioLevel === 'number') {
        audioLevel = report.audioLevel
      }
    })

    const deltaBytes = lastInboundBytes === null
      ? 0
      : Math.max(0, bytesReceived - lastInboundBytes)
    const deltaPackets = lastInboundPackets === null
      ? 0
      : Math.max(0, packetsReceived - lastInboundPackets)

    lastInboundBytes = bytesReceived
    lastInboundPackets = packetsReceived
    const codecReport = codecId && typeof stats.get === 'function' ? stats.get(codecId) : null

    receiverStats = {
      bytesReceived: String(bytesReceived),
      packetsReceived: String(packetsReceived),
      deltaBytes: String(deltaBytes),
      deltaPackets: String(deltaPackets),
      packetsLost: String(packetsLost),
      jitter: typeof jitter === 'number' ? jitter.toFixed(6) : 'n/a',
      jitterBufferDelay: typeof jitterBufferDelay === 'number' ? jitterBufferDelay.toFixed(6) : 'n/a',
      jitterBufferEmittedCount: typeof jitterBufferEmittedCount === 'number' ? String(jitterBufferEmittedCount) : 'n/a',
      concealedSamples: typeof concealedSamples === 'number' ? String(concealedSamples) : 'n/a',
      totalSamplesReceived: typeof totalSamplesReceived === 'number' ? String(totalSamplesReceived) : 'n/a',
      totalAudioEnergy: typeof totalAudioEnergy === 'number' ? totalAudioEnergy.toFixed(6) : 'n/a',
      audioLevel: typeof audioLevel === 'number' ? audioLevel.toFixed(6) : 'n/a',
      codec: codecReport && codecReport.mimeType ? codecReport.mimeType : 'n/a'
    }

    const processingActive = Boolean(
      mediaReady &&
      !usingDirectPlaybackFallback &&
      playbackProcessor &&
      remoteStream &&
      player.srcObject &&
      playbackProcessor.outputStream &&
      player.srcObject.id === playbackProcessor.outputStream.id
    )

    if (!processingActive) {
      silentPlaybackStreak = 0
      return
    }

    const incomingLevel = incomingVisualizer.getLevel()
    const playbackLevel = playbackVisualizer.getLevel()
    const hasInboundTraffic = deltaBytes > 1200 || deltaPackets > 15
    const playbackLooksSilent = playbackLevel < 0.01
    const incomingLooksSilent = incomingLevel < 0.01

    if (hasInboundTraffic && playbackLooksSilent && incomingLooksSilent) {
      silentPlaybackStreak += 1
    } else if (hasInboundTraffic && playbackLooksSilent) {
      silentPlaybackStreak += 1
    } else {
      silentPlaybackStreak = 0
    }

    if (silentPlaybackStreak >= 4 && remoteStream) {
      silentPlaybackStreak = 0
      await startDirectPlaybackFallback(
        remoteStream,
        'Processed playback stayed silent on this device, so direct fallback was enabled.'
      )
    }
  } finally {
    receiverStatsBusy = false
  }
}

function getDiagnosticsText() {
  const pc = peer && peer._pc
  const remoteTrack = remoteStream && remoteStream.getAudioTracks()[0]
  const outputTrack = player.srcObject && player.srcObject.getAudioTracks
    ? player.srcObject.getAudioTracks()[0]
    : null
  const processorContext = playbackProcessor ? playbackProcessor.context : null
  return [
    `listenerId=${listenerId}`,
    `participants=${participants.length}`,
    `broadcasterId=${broadcasterId || 'none'}`,
    `status="${statusBox.textContent}"`,
    `mediaReady=${mediaReady ? 'yes' : 'no'}`,
    `directFallback=${usingDirectPlaybackFallback ? 'yes' : 'no'}`,
    `remoteStream=${summarizeStream(remoteStream)}`,
    `player.paused=${player.paused}`,
    `player.readyState=${player.readyState}`,
    `player.networkState=${player.networkState}`,
    `player.currentTime=${player.currentTime.toFixed(2)}`,
    `player.volume=${player.volume}`,
    `player.muted=${player.muted}`,
    `player.defaultMuted=${player.defaultMuted}`,
    `player.playbackRate=${player.playbackRate}`,
    `player.ended=${player.ended}`,
    `player.srcObject=${player.srcObject ? summarizeStream(player.srcObject) : 'none'}`,
    `playbackProcessor=${playbackProcessor ? 'active' : 'none'}`,
    `processor.context.state=${processorContext ? processorContext.state : 'n/a'}`,
    `processor.context.sampleRate=${processorContext ? processorContext.sampleRate : 'n/a'}`,
    `remoteTrack=${summarizeTrack(remoteTrack)}`,
    `remoteTrack.muted=${remoteTrack ? remoteTrack.muted : 'n/a'}`,
    `remoteTrack.settings=${summarizeTrackSettings(remoteTrack)}`,
    `remoteTrack.constraints=${summarizeTrackConstraints(remoteTrack)}`,
    `outputTrack=${summarizeTrack(outputTrack)}`,
    `outputTrack.muted=${outputTrack ? outputTrack.muted : 'n/a'}`,
    `outputTrack.settings=${summarizeTrackSettings(outputTrack)}`,
    `incomingMeterLevel=${Math.round(incomingVisualizer.getLevel() * 100)}%`,
    `playbackMeterLevel=${Math.round(playbackVisualizer.getLevel() * 100)}%`,
    `receiver.bytesReceived=${receiverStats.bytesReceived}`,
    `receiver.deltaBytes=${receiverStats.deltaBytes}`,
    `receiver.deltaPackets=${receiverStats.deltaPackets}`,
    `receiver.packetsReceived=${receiverStats.packetsReceived}`,
    `receiver.packetsLost=${receiverStats.packetsLost}`,
    `receiver.jitter=${receiverStats.jitter}`,
    `receiver.jitterBufferDelay=${receiverStats.jitterBufferDelay}`,
    `receiver.jitterBufferEmittedCount=${receiverStats.jitterBufferEmittedCount}`,
    `receiver.concealedSamples=${receiverStats.concealedSamples}`,
    `receiver.totalSamplesReceived=${receiverStats.totalSamplesReceived}`,
    `receiver.totalAudioEnergy=${receiverStats.totalAudioEnergy}`,
    `receiver.audioLevel=${receiverStats.audioLevel}`,
    `receiver.codec=${receiverStats.codec}`,
    `silentFallbackStreak=${silentPlaybackStreak}`,
    `receivers=${summarizeReceivers(peer)}`,
    `pc.connectionState=${pc ? (pc.connectionState || 'n/a') : 'n/a'}`,
    `pc.iceConnectionState=${pc ? (pc.iceConnectionState || 'n/a') : 'n/a'}`,
    `pc.signalingState=${pc ? (pc.signalingState || 'n/a') : 'n/a'}`
  ].join('\n')
}

function renderDiagnostics() {
  const text = getDiagnosticsText()
  diagnosticsBox.textContent = text
  return text
}

async function pushDiagnostics() {
  if (!joined) return

  const text = getDiagnosticsText()
  if (text === lastDiagnosticsText) return
  lastDiagnosticsText = text

  try {
    await postJson('/api/client-diagnostics', {
      clientId: listenerId,
      text
    })
  } catch (error) {
    console.debug('Diagnostics push failed:', error)
  }
}

function startDiagnostics() {
  if (diagnosticsInterval) return
  renderDiagnostics()
  diagnosticsInterval = window.setInterval(() => {
    updateReceiverStats()
      .catch(error => {
        console.debug('Receiver stats update failed:', error)
      })
      .finally(() => {
        renderDiagnostics()
        pushDiagnostics().catch(() => {})
      })
  }, 1000)
}

function renderParticipants() {
  renderParticipantsTable(participantsBody, participants, listenerId, {
    onAdjustDelay(targetClientId, delta) {
      const participant = findParticipant(participants, targetClientId)
      if (!participant) return

      updateParticipantSettings(targetClientId, {
        delayMs: clampDelay(participant.delayMs + delta)
      }).catch(error => {
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
}

function applySelfAudioSettings() {
  const selfParticipant = getSelfParticipant()
  if (!selfParticipant || !playbackProcessor) return
  playbackProcessor.setDelay(selfParticipant.delayMs)
  playbackProcessor.setChannelMode(selfParticipant.channelMode)
}

function updateParticipants(nextParticipants) {
  participants = nextParticipants || []
  renderParticipants()
  if (!usingDirectPlaybackFallback) {
    applySelfAudioSettings()
  }
  renderDiagnostics()
}

async function updateParticipantSettings(targetClientId, settings) {
  const response = await postJson('/api/participant-settings', {
    clientId: listenerId,
    targetClientId,
    settings
  })

  updateParticipants(response.participants)
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return
  if (document.hidden) return
  if (wakeLock) return

  try {
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => {
      wakeLock = null
    })
  } catch (error) {
    console.debug('Wake lock unavailable:', error)
  }
}

function releaseWakeLock() {
  if (!wakeLock) return
  wakeLock.release().catch(() => {})
  wakeLock = null
}

function configureMediaSession() {
  if (!('mediaSession' in navigator)) return

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'LAN Audio Relay',
      artist: 'Home Audio'
    })

    navigator.mediaSession.setActionHandler('play', async () => {
      try {
        if (playbackProcessor) {
          await playbackProcessor.context.resume()
        }
        await player.play()
      } catch (error) {}
    })

    navigator.mediaSession.setActionHandler('pause', () => {
      player.pause()
    })
  } catch (error) {
    console.debug('Media Session unavailable:', error)
  }
}

function destroyPeer() {
  if (!peer) return
  peer.destroy()
  peer = null
  resetReceiverStats()
}

async function stopPlayback(options) {
  const preserveRemoteStream = Boolean(options && options.preserveRemoteStream)
  player.pause()
  player.srcObject = null
  if (!preserveRemoteStream) {
    remoteStream = null
    incomingVisualizer.clear('Waiting for audio')
  }
  usingDirectPlaybackFallback = false
  mediaReady = false
  resetReceiverStats()

  if (playbackProcessor) {
    await playbackProcessor.close().catch(() => {})
  }

  playbackProcessor = null
  playbackVisualizer.clear('Waiting for audio')
  renderDiagnostics()
}

async function startPlayback(stream) {
  await stopPlayback({ preserveRemoteStream: true })

  const selfParticipant = getSelfParticipant() || {
    delayMs: 100,
    channelMode: 'stereo'
  }

  playbackProcessor = await createProcessedAudioEngine(stream, {
    delayMs: selfParticipant.delayMs,
    channelMode: selfParticipant.channelMode
  })

  player.srcObject = playbackProcessor.outputStream
  await playbackVisualizer.attachStream(playbackProcessor.outputStream)
  configureMediaSession()
  await requestWakeLock()

  try {
    await player.play()
    mediaReady = true
    setStatus(statusBox, 'Audio is playing.')
    renderDiagnostics()
  } catch (error) {
    setStatus(statusBox, 'Tap the audio control if playback stays paused.', 'warn')
    renderDiagnostics()
  }
}

async function startDirectPlaybackFallback(stream, reason) {
  await stopPlayback({ preserveRemoteStream: true })
  usingDirectPlaybackFallback = true
  player.srcObject = stream
  await playbackVisualizer.attachStream(stream)
  configureMediaSession()
  await requestWakeLock()

  try {
    await player.play()
    mediaReady = true
    setStatus(
      statusBox,
      `Audio is playing with direct fallback. Delay/channel controls may not apply on this device. ${reason || ''}`.trim(),
      'warn'
    )
    renderDiagnostics()
  } catch (error) {
    setStatus(
      statusBox,
      'Tap the audio control to start playback. This phone rejected the processed audio path, so direct playback fallback is loaded.',
      'warn'
    )
    renderDiagnostics()
  }
}

async function handleIncomingMediaStream(stream, sourceLabel) {
  if (!stream) return
  if (mediaReady && remoteStream && remoteStream.id === stream.id) return

  remoteStream = stream
  await incomingVisualizer.attachStream(stream)
  renderDiagnostics()

  try {
    await startPlayback(stream)
  } catch (error) {
    console.error(error)
    await startDirectPlaybackFallback(
      stream,
      `${sourceLabel || 'Processed playback'} failed on this device/browser.`
    )
  }
}

function buildReceiverStream(nextPeer) {
  if (!nextPeer || !nextPeer._pc || typeof nextPeer._pc.getReceivers !== 'function') {
    return null
  }

  const audioTracks = nextPeer._pc
    .getReceivers()
    .map(receiver => receiver.track)
    .filter(track => track && track.kind === 'audio')

  if (!audioTracks.length) return null
  return new MediaStream(audioTracks)
}

function attachPeerMediaFallback(nextPeer) {
  if (!nextPeer || !nextPeer._pc || typeof nextPeer._pc.addEventListener !== 'function') {
    return
  }

  nextPeer._pc.addEventListener('track', event => {
    if (event.track && event.track.kind !== 'audio') return

    if (event.streams && event.streams[0]) {
      handleIncomingMediaStream(event.streams[0], 'Track event').catch(error => {
        console.error(error)
        renderDiagnostics()
      })
      return
    }

    const receiverStream = buildReceiverStream(nextPeer) || new MediaStream([event.track])
    handleIncomingMediaStream(receiverStream, 'Track fallback').catch(error => {
      console.error(error)
      renderDiagnostics()
    })
  })
}

function ensureEventSource() {
  if (eventSource) return

  eventSource = new EventSource(`/events?clientId=${encodeURIComponent(listenerId)}`)

  eventSource.addEventListener('host-left', () => {
    destroyPeer()
    stopPlayback().catch(() => {})
    broadcasterId = null
    joined = false
    lastDiagnosticsText = ''
    updateParticipants([])
    setStatus(statusBox, 'The PC host stopped broadcasting. Leave this page open or tap Join Audio again after the host restarts.', 'warn')
    renderDiagnostics()
  })

  eventSource.addEventListener('participants', event => {
    const payload = JSON.parse(event.data)
    updateParticipants(payload.participants)
  })

  eventSource.addEventListener('signal', async event => {
    const payload = JSON.parse(event.data)
    broadcasterId = payload.from

    if (!peer) {
      peer = createPeer(payload.from)
    }

    peer.signal(payload.signal)
  })
}

function createPeer(hostClientId) {
  const nextPeer = new SimplePeer({
    initiator: false,
    trickle: true,
    config: { iceServers: [] }
  })

  attachPeerMediaFallback(nextPeer)
  renderDiagnostics()

  nextPeer.on('signal', async signal => {
    try {
      await postJson('/api/signal', {
        from: listenerId,
        to: hostClientId,
        signal
      })
    } catch (error) {
      setStatus(statusBox, error.message, 'warn')
    }
  })

  nextPeer.on('stream', async stream => {
    await handleIncomingMediaStream(stream, 'Stream event')
  })

  nextPeer.on('connect', () => {
    if (!mediaReady) {
      setStatus(statusBox, 'Connected. Waiting for audio packets...')
    }
    renderDiagnostics()

    setTimeout(() => {
      if (mediaReady) return

      const receiverStream = buildReceiverStream(nextPeer)
      if (!receiverStream) return

      handleIncomingMediaStream(receiverStream, 'Receiver fallback').catch(error => {
        console.error(error)
        renderDiagnostics()
      })
    }, 2500)
  })

  nextPeer.on('close', () => {
    if (peer === nextPeer) {
      peer = null
    }
    renderDiagnostics()
  })

  nextPeer.on('error', error => {
    console.error(error)
    if (peer === nextPeer) {
      peer = null
    }
    setStatus(statusBox, 'The audio link failed. Tap Leave and Join Audio to reconnect.', 'warn')
    renderDiagnostics()
  })

  return nextPeer
}

async function joinAudio() {
  ensureEventSource()

  const registration = await postJson('/api/register', {
    clientId: listenerId,
    role: 'listener',
    settings: {
      delayMs: 100,
      channelMode: 'stereo'
    }
  })

  updateParticipants(registration.participants)
  joinButton.disabled = true
  leaveButton.disabled = false
  joined = true
  setStatus(statusBox, 'Joined. Waiting for the PC host offer...')
  await requestWakeLock()
  renderDiagnostics()
  await pushDiagnostics()
}

async function leaveAudio() {
  destroyPeer()
  await stopPlayback()
  broadcasterId = null
  joined = false
  lastDiagnosticsText = ''
  releaseWakeLock()

  try {
    await postJson('/api/unregister', { clientId: listenerId })
  } catch (error) {
    console.error(error)
  }

  updateParticipants([])
  joinButton.disabled = false
  leaveButton.disabled = true
  setStatus(statusBox, 'Disconnected.')
  renderDiagnostics()
}

joinButton.addEventListener('click', async () => {
  joinButton.disabled = true
  setStatus(statusBox, 'Joining...')

  try {
    await joinAudio()
  } catch (error) {
    console.error(error)
    joinButton.disabled = false
    leaveButton.disabled = true
    setStatus(statusBox, error.message, 'warn')
    renderDiagnostics()
  }
})

leaveButton.addEventListener('click', () => {
  leaveAudio().catch(error => {
    console.error(error)
  })
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    requestWakeLock().catch(() => {})
    incomingVisualizer.resume().catch(() => {})
    playbackVisualizer.resume().catch(() => {})
    if (playbackProcessor) {
      playbackProcessor.context.resume().catch(() => {})
      player.play().catch(() => {})
    }
    renderDiagnostics()
  }
})

window.addEventListener('beforeunload', () => {
  if (eventSource) eventSource.close()
  releaseWakeLock()
  incomingVisualizer.close().catch(() => {})
  playbackVisualizer.close().catch(() => {})
  if (diagnosticsInterval) {
    window.clearInterval(diagnosticsInterval)
  }
})

renderParticipants()
startDiagnostics()
