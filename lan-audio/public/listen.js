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
const AudioContextClass = window.AudioContext || window.webkitAudioContext

let eventSource = null
let peer = null
let broadcasterId = null
let participants = []
let remoteStream = null
let playbackProcessor = null
let unlockedPlaybackContext = null
let wakeLock = null
let usingDirectPlaybackFallback = false
let mediaReady = false
let processedPlaybackPath = 'media-element-source'
let preferredPlaybackMode = 'processed'
let lastPlaybackFailure = null
let lastPlayerEvent = 'none'
let lastPlayerErrorCode = 'n/a'
let playbackSessionId = 0
let activePlaybackJob = null
let activePlaybackStreamKey = ''
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

function normalizeErrorMessage(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  return String(error)
}

function summarizeErrorStack(error) {
  if (!error || !error.stack) return 'n/a'
  return String(error.stack).replace(/\s+/g, ' ').slice(0, 240)
}

function wait(ms) {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

async function postSignalWithRetry(from, to, signal) {
  const attempts = signal && signal.type === 'answer' ? 12 : 6
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

function describePlaybackFailure(error) {
  const name = error && error.name ? String(error.name) : 'Error'
  const message = normalizeErrorMessage(error)
  return `${name}: ${message}`.slice(0, 180)
}

function clearPlaybackFailure() {
  lastPlaybackFailure = null
}

function recordPlaybackFailure(stage, sourceLabel, error) {
  lastPlaybackFailure = {
    at: new Date().toISOString(),
    stage: stage || 'unknown',
    source: sourceLabel || 'unknown',
    name: error && error.name ? String(error.name) : 'Error',
    message: normalizeErrorMessage(error),
    stack: summarizeErrorStack(error)
  }
}

function getStreamKey(stream) {
  if (!stream) return 'none'

  const trackKeys = stream.getTracks()
    .map(track => `${track.kind}:${track.id}:${track.readyState}`)
    .sort()

  return `${stream.id}|${trackKeys.join('|')}`
}

function createStalePlaybackError() {
  const error = new Error('Stale playback request')
  error.name = 'StalePlaybackError'
  return error
}

function assertCurrentPlaybackSession(sessionId) {
  if (sessionId !== playbackSessionId) {
    throw createStalePlaybackError()
  }
}

function shouldPreferDirectPlayback() {
  const userAgent = navigator.userAgent || ''
  const looksMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
  const hasTouch = typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1
  return looksMobile || hasTouch
}

function getSelfParticipant() {
  return findParticipant(participants, listenerId)
}

async function ensureUnlockedPlaybackContext() {
  if (!AudioContextClass) return null

  if (!unlockedPlaybackContext || unlockedPlaybackContext.state === 'closed') {
    unlockedPlaybackContext = new AudioContextClass()
  }

  if (unlockedPlaybackContext.state === 'suspended') {
    await unlockedPlaybackContext.resume()
  }

  return unlockedPlaybackContext
}

async function primeAudioContexts() {
  await Promise.allSettled([
    ensureUnlockedPlaybackContext(),
    incomingVisualizer.prime(),
    playbackVisualizer.prime()
  ])
}

async function closeUnlockedPlaybackContext() {
  if (!unlockedPlaybackContext) return

  const contextToClose = unlockedPlaybackContext
  unlockedPlaybackContext = null

  if (contextToClose.state !== 'closed') {
    await contextToClose.close()
  }
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
      remoteStream
    )

    if (!processingActive) {
      silentPlaybackStreak = 0
      return
    }

    const incomingLevel = incomingVisualizer.getLevel()
    const playbackLevel = playbackProcessor && typeof playbackProcessor.getLevel === 'function'
      ? playbackProcessor.getLevel()
      : playbackVisualizer.getLevel()
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
        'Processed playback stayed silent on this device, so direct fallback was enabled.',
        playbackSessionId
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
    `player.errorCode=${player.error && typeof player.error.code === 'number' ? player.error.code : lastPlayerErrorCode}`,
    `lastPlayerEvent=${lastPlayerEvent}`,
    `processedPlaybackPath=${processedPlaybackPath}`,
    `preferredPlaybackMode=${preferredPlaybackMode}`,
    `playbackProcessor=${playbackProcessor ? 'active' : 'none'}`,
    `listenerContext.state=${unlockedPlaybackContext ? unlockedPlaybackContext.state : 'n/a'}`,
    `processor.context.state=${processorContext ? processorContext.state : 'n/a'}`,
    `processor.context.sampleRate=${processorContext ? processorContext.sampleRate : 'n/a'}`,
    `processor.level=${playbackProcessor && typeof playbackProcessor.getLevel === 'function'
      ? playbackProcessor.getLevel().toFixed(4)
      : 'n/a'}`,
    `browser.userAgent=${navigator.userAgent || 'n/a'}`,
    `browser.platform=${navigator.platform || 'n/a'}`,
    `browser.vendor=${navigator.vendor || 'n/a'}`,
    `browser.maxTouchPoints=${typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints : 'n/a'}`,
    `capabilities.audioContext=${AudioContextClass ? 'yes' : 'no'}`,
    `capabilities.mediaSession=${'mediaSession' in navigator ? 'yes' : 'no'}`,
    `capabilities.wakeLock=${'wakeLock' in navigator ? 'yes' : 'no'}`,
    `capabilities.createMediaElementSource=${AudioContextClass && typeof AudioContextClass.prototype.createMediaElementSource === 'function' ? 'yes' : 'no'}`,
    `capabilities.createMediaStreamSource=${AudioContextClass && typeof AudioContextClass.prototype.createMediaStreamSource === 'function' ? 'yes' : 'no'}`,
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
    `lastPlaybackFailure.at=${lastPlaybackFailure ? lastPlaybackFailure.at : 'n/a'}`,
    `lastPlaybackFailure.stage=${lastPlaybackFailure ? lastPlaybackFailure.stage : 'n/a'}`,
    `lastPlaybackFailure.source=${lastPlaybackFailure ? lastPlaybackFailure.source : 'n/a'}`,
    `lastPlaybackFailure.name=${lastPlaybackFailure ? lastPlaybackFailure.name : 'n/a'}`,
    `lastPlaybackFailure.message=${lastPlaybackFailure ? lastPlaybackFailure.message : 'n/a'}`,
    `lastPlaybackFailure.stack=${lastPlaybackFailure ? lastPlaybackFailure.stack : 'n/a'}`,
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
        if (playbackProcessor && !usingDirectPlaybackFallback) {
          await playbackProcessor.context.resume()
          return
        }
        await player.play()
      } catch (error) {}
    })

    navigator.mediaSession.setActionHandler('pause', () => {
      if (playbackProcessor && !usingDirectPlaybackFallback) {
        playbackProcessor.context.suspend().catch(() => {})
        return
      }
      player.pause()
    })
  } catch (error) {
    console.debug('Media Session unavailable:', error)
  }
}

function destroyPeer() {
  if (!peer) return
  playbackSessionId += 1
  activePlaybackJob = null
  activePlaybackStreamKey = ''
  peer.destroy()
  peer = null
  resetReceiverStats()
}

async function stopPlayback(options) {
  const preserveRemoteStream = Boolean(options && options.preserveRemoteStream)
  player.pause()
  player.muted = false
  player.srcObject = null
  if (!preserveRemoteStream) {
    remoteStream = null
    incomingVisualizer.clear('Waiting for audio')
  }
  usingDirectPlaybackFallback = false
  mediaReady = false
  lastPlayerErrorCode = 'n/a'
  resetReceiverStats()

  if (playbackProcessor) {
    await playbackProcessor.close().catch(() => {})
  }

  playbackProcessor = null
  playbackVisualizer.clear('Waiting for audio')
  renderDiagnostics()
}

async function startPlayback(stream, sessionId) {
  await stopPlayback({ preserveRemoteStream: true })
  assertCurrentPlaybackSession(sessionId)
  clearPlaybackFailure()
  processedPlaybackPath = 'media-element-source'
  preferredPlaybackMode = 'processed'

  const selfParticipant = getSelfParticipant() || {
    delayMs: 0,
    channelMode: 'stereo'
  }

  const playbackContext = await ensureUnlockedPlaybackContext()
  assertCurrentPlaybackSession(sessionId)
  player.srcObject = stream
  player.muted = true
  await player.play()
  assertCurrentPlaybackSession(sessionId)

  const nextPlaybackProcessor = await createProcessedElementAudioEngine(player, {
    delayMs: selfParticipant.delayMs,
    channelMode: selfParticipant.channelMode,
    context: playbackContext,
    audibleDestination: true
  })
  if (sessionId !== playbackSessionId) {
    await nextPlaybackProcessor.close().catch(() => {})
    throw createStalePlaybackError()
  }
  playbackProcessor = nextPlaybackProcessor

  await playbackVisualizer.attachStream(playbackProcessor.outputStream)
  assertCurrentPlaybackSession(sessionId)
  configureMediaSession()
  await requestWakeLock()
  assertCurrentPlaybackSession(sessionId)

  try {
    await playbackProcessor.context.resume()
    assertCurrentPlaybackSession(sessionId)
    mediaReady = true
    setStatus(statusBox, 'Playing')
    renderDiagnostics()
  } catch (error) {
    setStatus(statusBox, 'Tap play.', 'warn')
    renderDiagnostics()
  }
}

async function startDirectPlaybackFallback(stream, reason, sessionId) {
  await stopPlayback({ preserveRemoteStream: true })
  assertCurrentPlaybackSession(sessionId)
  usingDirectPlaybackFallback = true
  processedPlaybackPath = 'direct-fallback'
  const preferredDirectMode = shouldPreferDirectPlayback()
  preferredPlaybackMode = preferredDirectMode ? 'direct-preferred' : 'processed-fallback'
  player.srcObject = stream
  player.muted = false
  await playbackVisualizer.attachStream(stream)
  assertCurrentPlaybackSession(sessionId)
  configureMediaSession()
  await requestWakeLock()
  assertCurrentPlaybackSession(sessionId)

  try {
    await player.play()
    assertCurrentPlaybackSession(sessionId)
    mediaReady = true
    setStatus(statusBox, preferredDirectMode ? 'Direct' : 'Fallback', preferredDirectMode ? null : 'warn')
    renderDiagnostics()
  } catch (error) {
    setStatus(statusBox, 'Tap play.', 'warn')
    renderDiagnostics()
  }
}

async function handleIncomingMediaStream(stream, sourceLabel) {
  if (!stream) return

  const streamKey = getStreamKey(stream)
  if (streamKey === activePlaybackStreamKey && (mediaReady || activePlaybackJob)) {
    return activePlaybackJob || undefined
  }

  remoteStream = stream
  activePlaybackStreamKey = streamKey
  await incomingVisualizer.attachStream(stream)
  renderDiagnostics()

  const sessionId = ++playbackSessionId
  const job = (async () => {
    try {
      if (shouldPreferDirectPlayback()) {
        await startDirectPlaybackFallback(
          stream,
          'Direct mode.',
          sessionId
        )
        return
      }

      await startPlayback(stream, sessionId)
    } catch (error) {
      if ((error && error.name === 'StalePlaybackError') || sessionId !== playbackSessionId) {
        return
      }

      recordPlaybackFailure('startPlayback', sourceLabel, error)
      console.error(error)
      await startDirectPlaybackFallback(
        stream,
        describePlaybackFailure(error),
        sessionId
      )
    }
  })()

  activePlaybackJob = job

  try {
    await job
  } finally {
    if (activePlaybackJob === job) {
      activePlaybackJob = null
    }
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
    setStatus(statusBox, 'Host left', 'warn')
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
      await postSignalWithRetry(listenerId, hostClientId, signal)
    } catch (error) {
      setStatus(statusBox, error.message, 'warn')
    }
  })

  nextPeer.on('stream', async stream => {
    await handleIncomingMediaStream(stream, 'Stream event')
  })

  nextPeer.on('connect', () => {
    if (!mediaReady) {
      setStatus(statusBox, 'Connected')
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
    setStatus(statusBox, 'Link failed', 'warn')
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
      delayMs: 0,
      channelMode: 'stereo'
    }
  })

  updateParticipants(registration.participants)
  joinButton.disabled = true
  leaveButton.disabled = false
  joined = true
  setStatus(statusBox, 'Joined')
  await requestWakeLock()
  renderDiagnostics()
  await pushDiagnostics()
}

async function leaveAudio() {
  destroyPeer()
  await stopPlayback()
  await closeUnlockedPlaybackContext().catch(() => {})
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
  setStatus(statusBox, 'Idle')
  renderDiagnostics()
}

joinButton.addEventListener('click', async () => {
  joinButton.disabled = true
  setStatus(statusBox, 'Joining')

  try {
    await primeAudioContexts()
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

;['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'waiting', 'stalled', 'suspend', 'error'].forEach(type => {
  player.addEventListener(type, () => {
    lastPlayerEvent = `${type}@${new Date().toISOString()}`
    lastPlayerErrorCode = player.error && typeof player.error.code === 'number'
      ? String(player.error.code)
      : 'n/a'
    renderDiagnostics()
  })
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    requestWakeLock().catch(() => {})
    ensureUnlockedPlaybackContext().catch(() => {})
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
  closeUnlockedPlaybackContext().catch(() => {})
  if (diagnosticsInterval) {
    window.clearInterval(diagnosticsInterval)
  }
})

renderParticipants()
startDiagnostics()
