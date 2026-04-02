'use strict'

const startButton = document.querySelector('#start')
const stopButton = document.querySelector('#stop')
const serverToggleButton = document.querySelector('#server-toggle')
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
const eqDrawerShell = document.querySelector('#eq-drawer-shell')
const eqDrawerBackdrop = document.querySelector('#eq-drawer-backdrop')
const eqDrawerCloseButton = document.querySelector('#eq-drawer-close')
const eqSavePresetButton = document.querySelector('#eq-save-preset')
const eqBypassButton = document.querySelector('#eq-bypass')
const eqResetButton = document.querySelector('#eq-reset')
const eqPresetSelect = document.querySelector('#eq-preset-select')
const eqDrawerTitle = document.querySelector('#eq-drawer-title')
const eqDrawerSubtitle = document.querySelector('#eq-drawer-subtitle')
const eqDrawerStatus = document.querySelector('#eq-drawer-status')
const eqUi = document.querySelector('#participant-eq-ui')

const HOST_ID_STORAGE_KEY = 'home-audio.host-id.v1'
const hostId = getPersistentHostId()
const peers = new Map()
const listenerProcessors = new Map()
const EQ_STORAGE_KEY = 'home-audio.host-eq.v2'
const EQ_PRESETS_STORAGE_KEY = 'home-audio.host-eq.presets.v1'
const HOST_EQ_STORAGE_SLOT = 'host-monitor'
const DEFAULT_PRESET_NAME = 'default'
const FLAT_PRESET_NAME = 'flat'
const CUSTOM_PRESET_NAME = 'custom'
const EQ_NUMERIC_TOLERANCE = 0.000001
const DEFAULT_EQ_STATE = [
  { type: 'lowshelf12', frequency: 63, gain: 0, Q: 0.7, bypass: false },
  { type: 'peaking12', frequency: 136, gain: 0, Q: 0.7, bypass: false },
  { type: 'peaking12', frequency: 294, gain: 0, Q: 0.7, bypass: false },
  { type: 'peaking12', frequency: 632, gain: 0, Q: 0.7, bypass: false },
  { type: 'peaking12', frequency: 1363, gain: 0, Q: 0.7, bypass: false },
  { type: 'peaking12', frequency: 2936, gain: 0, Q: 0.7, bypass: false },
  { type: 'highshelf12', frequency: 6324, gain: 0, Q: 0.7, bypass: false },
  { type: 'noop', frequency: 350, gain: 0, Q: 1, bypass: false }
]
const FLAT_EQ_STATE = DEFAULT_EQ_STATE.map(filter => ({
  ...filter,
  bypass: true
}))
const BUILTIN_EQ_PRESETS = {
  [DEFAULT_PRESET_NAME]: DEFAULT_EQ_STATE,
  [FLAT_PRESET_NAME]: FLAT_EQ_STATE,
  '31.3.26': [
    { type: 'lowshelf12', frequency: 128.95592361951634, gain: -3.2555309734513287, Q: 0.7, bypass: false },
    { type: 'peaking12', frequency: 58.96004371289738, gain: -4.370575221238937, Q: 0.695010881248892, bypass: false },
    { type: 'peaking12', frequency: 294, gain: 0, Q: 0.7, bypass: false },
    { type: 'peaking12', frequency: 508.6293358792846, gain: -3.7334070796460193, Q: 0.7, bypass: false },
    { type: 'peaking12', frequency: 1363, gain: 0, Q: 0.7, bypass: false },
    { type: 'peaking12', frequency: 2936, gain: 0, Q: 0.7, bypass: false },
    { type: 'highshelf12', frequency: 1251.699925647288, gain: 3.5940265486725664, Q: 0.7, bypass: false },
    { type: 'noop', frequency: 350, gain: 0, Q: 1, bypass: false }
  ]
}

let eventSource = null
let captureStream = null
let audioOnlyStream = null
let stopping = false
let serverRunning = true
let serverControlBusy = false
let unloadUnregisterSent = false
let monitorProcessor = null
let participants = []
let diagnosticsInterval = null
let remoteDiagnostics = {}
let peerTransportStats = {}
let lastPeerTraffic = {}
let diagnosticsBusy = false
let lastDiagnosticsText = ''
let selectedEqClientId = hostId
let eqModules = null
let eqModulesPromise = null
let eqModuleError = ''
let activeEqRuntime = null
let eqStateStore = loadEqStateStore()
let eqPresetStore = loadEqPresetStore()
const sourceVisualizer = createStreamVisualizer(sourceMeterCanvas, sourceMeterValue)
const monitorVisualizer = createStreamVisualizer(monitorMeterCanvas, monitorMeterValue)

function normalizeErrorMessage(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  return String(error)
}

function getPersistentHostId() {
  try {
    const stored = window.localStorage.getItem(HOST_ID_STORAGE_KEY)
    if (stored) return stored

    const generated = randomId('host')
    window.localStorage.setItem(HOST_ID_STORAGE_KEY, generated)
    return generated
  } catch (error) {
    return randomId('host')
  }
}

function wait(ms) {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

function loadEqStateStore() {
  try {
    const raw = window.localStorage.getItem(EQ_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.debug('Failed reading saved EQ state:', error)
    return {}
  }
}

function saveEqStateStore() {
  try {
    window.localStorage.setItem(EQ_STORAGE_KEY, JSON.stringify(eqStateStore))
  } catch (error) {
    console.debug('Failed saving EQ state:', error)
  }
}

function loadEqPresetStore() {
  try {
    const raw = window.localStorage.getItem(EQ_PRESETS_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    console.debug('Failed reading saved EQ presets:', error)
    return {}
  }
}

function saveEqPresetStore() {
  try {
    window.localStorage.setItem(EQ_PRESETS_STORAGE_KEY, JSON.stringify(eqPresetStore))
  } catch (error) {
    console.debug('Failed saving EQ presets:', error)
  }
}

function normalizePresetName(name) {
  return String(name || '').trim()
}

function isCustomEqPresetName(name) {
  return normalizePresetName(name).toLowerCase() === CUSTOM_PRESET_NAME
}

function getBuiltInEqPresetKey(name) {
  const trimmed = normalizePresetName(name)
  if (!trimmed) return ''

  const direct = Object.prototype.hasOwnProperty.call(BUILTIN_EQ_PRESETS, trimmed)
    ? trimmed
    : ''
  if (direct) return direct

  const lowered = trimmed.toLowerCase()
  return Object.keys(BUILTIN_EQ_PRESETS).find(key => key.toLowerCase() === lowered) || ''
}

function isReservedEqPresetName(name) {
  return Boolean(getBuiltInEqPresetKey(name)) || isCustomEqPresetName(name)
}

function listEqPresetNames() {
  const names = new Set([
    ...Object.keys(BUILTIN_EQ_PRESETS),
    ...Object.keys(eqPresetStore)
  ])
  return Array.from(names).sort((a, b) => a.localeCompare(b))
}

function saveEqPreset(name, state) {
  const trimmed = normalizePresetName(name)
  const nextState = cloneEqState(state)
  if (!trimmed || !nextState || isReservedEqPresetName(trimmed)) {
    return false
  }
  eqPresetStore[trimmed] = nextState
  saveEqPresetStore()
  return true
}

function getEqPreset(name) {
  const trimmed = normalizePresetName(name)
  if (!trimmed) return null

  const builtInKey = getBuiltInEqPresetKey(trimmed)
  if (builtInKey) {
    return cloneEqState(BUILTIN_EQ_PRESETS[builtInKey])
  }
  return cloneEqState(eqPresetStore[trimmed])
}

function isBuiltInEqPresetName(name) {
  return Boolean(getBuiltInEqPresetKey(name))
}

function refreshEqPresetSelect(preferredName) {
  if (!eqPresetSelect) return
  const names = listEqPresetNames()
  const previousValue = normalizePresetName(preferredName || eqPresetSelect.value)
  const includeCustom = isCustomEqPresetName(previousValue)
  if (includeCustom && !names.includes(CUSTOM_PRESET_NAME)) {
    names.push(CUSTOM_PRESET_NAME)
  }
  eqPresetSelect.textContent = ''

  names.forEach(name => {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    eqPresetSelect.appendChild(option)
  })

  if (!names.length) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = 'No presets'
    eqPresetSelect.appendChild(option)
  }

  if (names.includes(previousValue)) {
    eqPresetSelect.value = previousValue
  } else if (names.includes(DEFAULT_PRESET_NAME)) {
    eqPresetSelect.value = DEFAULT_PRESET_NAME
  } else if (names.length) {
    eqPresetSelect.value = names[0]
  } else {
    eqPresetSelect.value = ''
  }
}

function areNumbersClose(left, right) {
  return Math.abs(Number(left) - Number(right)) <= EQ_NUMERIC_TOLERANCE
}

function areEqStatesEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false
  if (left.length !== right.length) return false

  return left.every((leftFilter, index) => {
    const rightFilter = right[index]
    if (!leftFilter || !rightFilter) return false
    return String(leftFilter.type || '') === String(rightFilter.type || '') &&
      areNumbersClose(leftFilter.frequency, rightFilter.frequency) &&
      areNumbersClose(leftFilter.gain, rightFilter.gain) &&
      areNumbersClose(leftFilter.Q, rightFilter.Q) &&
      Boolean(leftFilter.bypass) === Boolean(rightFilter.bypass)
  })
}

function findMatchingEqPresetName(state) {
  if (!Array.isArray(state)) return DEFAULT_PRESET_NAME

  const presetNames = listEqPresetNames()
  for (const name of presetNames) {
    const presetState = getEqPreset(name)
    if (!presetState) continue
    if (areEqStatesEqual(state, presetState)) {
      return name
    }
  }

  return CUSTOM_PRESET_NAME
}

function getEqStorageSlot(clientId) {
  return clientId === hostId ? HOST_EQ_STORAGE_SLOT : `listener:${clientId}`
}

function getSavedEqState(clientId) {
  return cloneEqState(eqStateStore[getEqStorageSlot(clientId)]) || cloneEqState(DEFAULT_EQ_STATE)
}

function persistEqState(clientId, state) {
  const nextState = cloneEqState(state)
  if (!nextState) return
  eqStateStore[getEqStorageSlot(clientId)] = nextState
  saveEqStateStore()
}

function clearSavedEqState(clientId) {
  delete eqStateStore[getEqStorageSlot(clientId)]
  saveEqStateStore()
}

function applyEqStateToRuntime(runtime, state) {
  if (!runtime || !Array.isArray(state)) return

  state.forEach((filterState, index) => {
    const nextFilter = filterState || {}
    runtime.setFilterType(index, nextFilter.type || 'noop')
    runtime.setFilterFrequency(index, Number(nextFilter.frequency) || 350)
    runtime.setFilterQ(index, Number(nextFilter.Q) || 1)
    runtime.setFilterGain(index, Number(nextFilter.gain) || 0)
    runtime.toggleBypass(index, Boolean(nextFilter.bypass))
  })
}

function areAllActiveEqFiltersBypassed(runtime) {
  if (!runtime || !Array.isArray(runtime.spec)) return false
  const active = runtime.spec.filter(filter => filter && filter.type !== 'noop')
  if (!active.length) return false
  return active.every(filter => Boolean(filter.bypass))
}

async function ensureEqModules() {
  if (eqModulesPromise) {
    return eqModulesPromise
  }

  eqModulesPromise = Promise.all([
    import('weq8'),
    import('weq8/ui')
  ])
    .then(([runtimeModule]) => {
      eqModuleError = ''
      eqModules = {
        WEQ8Runtime: runtimeModule.WEQ8Runtime
      }
      renderEqDrawer()
      return eqModules
    })
    .catch(error => {
      eqModuleError = normalizeErrorMessage(error)
      console.error('Failed loading EQ modules:', error)
      renderEqDrawer()
      return null
    })

  return eqModulesPromise
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

function getParticipantProcessor(clientId) {
  if (clientId === hostId) {
    return monitorProcessor
  }

  return listenerProcessors.get(clientId) || null
}

function getEqSubtitle(participant) {
  if (!participant) {
    return 'Saved locally.'
  }

  if (participant.clientId === hostId) {
    return 'Monitor path.'
  }

  return 'Host outbound path.'
}

function setEqUiRuntime(runtime) {
  if (!eqUi) return

  if (!window.customElements || !window.customElements.get('weq8-ui')) {
    if (Object.prototype.hasOwnProperty.call(eqUi, 'runtime')) {
      delete eqUi.runtime
    }
    return
  }

  eqUi.runtime = runtime
}

function detachEqRuntime() {
  activeEqRuntime = null
  setEqUiRuntime(null)
}

function renderEqDrawer() {
  if (!eqDrawerShell) return
  refreshEqPresetSelect()

  const participant = findParticipant(participants, selectedEqClientId)

  if (!participant) {
    detachEqRuntime()
    eqResetButton.disabled = true
    if (eqPresetSelect) {
      eqPresetSelect.disabled = listEqPresetNames().length === 0
    }
    if (eqSavePresetButton) {
      eqSavePresetButton.disabled = true
    }
    if (eqBypassButton) {
      eqBypassButton.disabled = true
      eqBypassButton.textContent = 'Bypass'
    }
    eqDrawerTitle.textContent = 'EQ'
    eqDrawerSubtitle.textContent = 'Monitor path.'
    eqDrawerStatus.textContent = audioOnlyStream
      ? 'Waiting for participant state.'
      : 'Start first.'
    return
  }

  eqDrawerTitle.textContent = `EQ: ${formatParticipantLabel(participant, hostId)}`
  eqDrawerSubtitle.textContent = getEqSubtitle(participant)

  if (eqModuleError) {
    detachEqRuntime()
    eqResetButton.disabled = true
    if (eqPresetSelect) {
      eqPresetSelect.disabled = true
    }
    if (eqSavePresetButton) {
      eqSavePresetButton.disabled = true
    }
    if (eqBypassButton) {
      eqBypassButton.disabled = true
      eqBypassButton.textContent = 'Bypass'
    }
    eqDrawerStatus.textContent = `Load failed: ${eqModuleError}`
    return
  }

  const processor = getParticipantProcessor(participant.clientId)
  const runtime = processor && processor.eqRuntime

  if (!runtime) {
    detachEqRuntime()
    eqResetButton.disabled = true
    if (eqPresetSelect) {
      eqPresetSelect.disabled = listEqPresetNames().length === 0
    }
    if (eqSavePresetButton) {
      eqSavePresetButton.disabled = true
    }
    if (eqBypassButton) {
      eqBypassButton.disabled = true
      eqBypassButton.textContent = 'Bypass'
    }
    eqDrawerStatus.textContent = audioOnlyStream
      ? 'Waiting for audio.'
      : 'Start first.'
    return
  }

  activeEqRuntime = runtime
  setEqUiRuntime(runtime)
  refreshEqPresetSelect(findMatchingEqPresetName(runtime.spec))
  eqResetButton.disabled = false
  if (eqPresetSelect) {
    eqPresetSelect.disabled = listEqPresetNames().length === 0
  }
  if (eqSavePresetButton) {
    eqSavePresetButton.disabled = false
  }
  if (eqBypassButton) {
    eqBypassButton.disabled = false
    eqBypassButton.textContent = areAllActiveEqFiltersBypassed(runtime) ? 'Unbypass' : 'Bypass'
  }
  eqDrawerStatus.textContent = 'Live. Saved locally.'
}

function openEqDrawer(clientId) {
  selectedEqClientId = clientId
  renderEqDrawer()
  ensureEqModules().catch(() => {})
}

function closeEqDrawer() {
  selectedEqClientId = hostId
  renderEqDrawer()
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
    `  outboundEqRuntime=${outboundProcessor && outboundProcessor.eqRuntime ? 'ready' : 'off'}`,
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

function setServerToggleButtonState() {
  if (!serverToggleButton) return
  serverToggleButton.textContent = serverRunning ? 'stop server' : 'start server'
  serverToggleButton.disabled = serverControlBusy
}

function applyServerRunningState(nextState) {
  serverRunning = Boolean(nextState)
  setServerToggleButtonState()

  if (!serverRunning) {
    startButton.disabled = true
    stopButton.disabled = true
    return
  }

  if (audioOnlyStream) {
    startButton.disabled = true
    stopButton.disabled = false
    return
  }

  startButton.disabled = false
  stopButton.disabled = true
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(text)
    return
  }

  const textArea = document.createElement('textarea')
  textArea.value = text
  textArea.setAttribute('readonly', '')
  textArea.style.position = 'fixed'
  textArea.style.left = '-9999px'
  document.body.appendChild(textArea)
  textArea.select()

  const copied = document.execCommand('copy')
  document.body.removeChild(textArea)

  if (!copied) {
    throw new Error('Copy failed')
  }
}

function createListenLinkRow(url) {
  const row = document.createElement('div')
  row.className = 'link-row'

  const urlBox = document.createElement('div')
  urlBox.className = 'codebox'
  urlBox.textContent = url

  const copyButton = document.createElement('button')
  copyButton.type = 'button'
  copyButton.className = 'secondary link-copy-button'
  copyButton.textContent = 'copy'

  copyButton.addEventListener('click', async () => {
    if (copyButton.disabled) return

    copyButton.disabled = true

    try {
      await copyTextToClipboard(url)
      copyButton.textContent = 'copied!'
    } catch (error) {
      copyButton.textContent = 'copy failed'
      setStatus(statusBox, normalizeErrorMessage(error), 'warn')
    }

    if (copyButton.__resetTimer) {
      window.clearTimeout(copyButton.__resetTimer)
    }

    copyButton.__resetTimer = window.setTimeout(() => {
      copyButton.textContent = 'copy'
      copyButton.disabled = false
      copyButton.__resetTimer = null
    }, 1200)
  })

  row.appendChild(urlBox)
  row.appendChild(copyButton)
  return row
}

function renderLinks(status) {
  const running = status && Object.prototype.hasOwnProperty.call(status, 'serverRunning')
    ? Boolean(status.serverRunning)
    : true
  applyServerRunningState(running)

  listenLinks.textContent = ''

  if (!running) {
    const message = document.createElement('p')
    message.className = 'small'
    message.textContent = 'Server stopped.'
    listenLinks.appendChild(message)
    return
  }

  const listenPages = Array.isArray(status && status.listenPages) ? status.listenPages : []

  if (!listenPages.length) {
    const message = document.createElement('p')
    message.className = 'small'
    message.textContent = 'No LAN IP detected yet.'
    listenLinks.appendChild(message)
    return
  }

  listenPages.forEach(url => {
    listenLinks.appendChild(createListenLinkRow(url))
  })
}

async function refreshStatusAndLinks() {
  const status = await fetchStatus()
  renderLinks(status)
  return status
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
    },
    onOpenEq(targetClientId) {
      openEqDrawer(targetClientId)
    },
    onSendListenerCommand(targetClientId, command) {
      sendListenerCommand(targetClientId, command)
        .then(() => {
          setStatus(statusBox, `Sent ${command} to ${targetClientId.slice(-6)}`)
        })
        .catch(error => {
          setStatus(statusBox, normalizeErrorMessage(error), 'warn')
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
  renderEqDrawer()
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

async function sendListenerCommand(targetClientId, command) {
  await postJson('/api/listener-command', {
    clientId: hostId,
    targetClientId,
    command
  })
}

function attachEqPersistence(clientId, processor) {
  if (!processor || !processor.eqRuntime || typeof processor.eqRuntime.on !== 'function') {
    return
  }

  processor.eqUnsubscribe = processor.eqRuntime.on('filtersChanged', state => {
    persistEqState(clientId, state)
    if (clientId === selectedEqClientId && activeEqRuntime === processor.eqRuntime) {
      refreshEqPresetSelect(findMatchingEqPresetName(state))
      if (eqBypassButton) {
        eqBypassButton.textContent = areAllActiveEqFiltersBypassed(processor.eqRuntime) ? 'Unbypass' : 'Bypass'
      }
    }
  })
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
  await ensureEqModules()

  const selfParticipant = getSelfParticipant() || {
    delayMs: 0,
    channelMode: 'stereo'
  }

  monitorProcessor = await createProcessedAudioEngine(audioOnlyStream, {
    delayMs: selfParticipant.delayMs,
    channelMode: selfParticipant.channelMode,
    eqRuntimeClass: eqModules && eqModules.WEQ8Runtime,
    eqState: getSavedEqState(hostId)
  })

  attachEqPersistence(hostId, monitorProcessor)
  monitorPlayer.srcObject = monitorProcessor.outputStream
  await monitorVisualizer.attachStream(monitorProcessor.outputStream)
  await setMonitorOutputDevice()
  await monitorPlayer.play()
  renderEqDrawer()
}

function stopLocalMonitor() {
  monitorPlayer.pause()
  monitorPlayer.srcObject = null

  if (monitorProcessor) {
    if (typeof monitorProcessor.eqUnsubscribe === 'function') {
      monitorProcessor.eqUnsubscribe()
    }
    monitorProcessor.close().catch(() => {})
  }

  monitorProcessor = null
  monitorVisualizer.clear('Waiting for audio')
  renderEqDrawer()
}

function destroyPeer(clientId) {
  const peer = peers.get(clientId)
  if (!peer) return
  peers.delete(clientId)
  peer.destroy()
  const processor = listenerProcessors.get(clientId)
  if (processor) {
    if (typeof processor.eqUnsubscribe === 'function') {
      processor.eqUnsubscribe()
    }
    processor.close().catch(() => {})
    listenerProcessors.delete(clientId)
  }
  delete peerTransportStats[clientId]
  delete lastPeerTraffic[clientId]
  renderEqDrawer()
}

async function createPeer(listenerId) {
  const existingPeer = peers.get(listenerId)
  if (existingPeer) {
    const pc = existingPeer._pc
    const connectionState = pc && pc.connectionState ? pc.connectionState : ''
    const needsReplacement = existingPeer.destroyed ||
      connectionState === 'failed' ||
      connectionState === 'closed' ||
      connectionState === 'disconnected'

    if (!needsReplacement) {
      return existingPeer
    }

    destroyPeer(listenerId)
  }
  await ensureEqModules()

  const listenerParticipant = findParticipant(participants, listenerId) || {
    delayMs: 0,
    channelMode: 'stereo'
  }
  const outboundProcessor = await createProcessedAudioEngine(audioOnlyStream, {
    delayMs: listenerParticipant.delayMs,
    channelMode: listenerParticipant.channelMode,
    keepAliveDestination: true,
    eqRuntimeClass: eqModules && eqModules.WEQ8Runtime,
    eqState: getSavedEqState(listenerId)
  })
  const outboundStream = outboundProcessor.outputStream
  attachEqPersistence(listenerId, outboundProcessor)

  const peer = new SimplePeer({
    initiator: true,
    trickle: true,
    sdpTransform: tuneOpusSdp,
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
    setStatus(statusBox, `Live: ${participants.length}`)
    renderDiagnostics()
  })

  peer.on('close', () => {
    peers.delete(listenerId)
    const processor = listenerProcessors.get(listenerId)
    if (processor) {
      if (typeof processor.eqUnsubscribe === 'function') {
        processor.eqUnsubscribe()
      }
      processor.close().catch(() => {})
      listenerProcessors.delete(listenerId)
    }
    renderEqDrawer()
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
  renderEqDrawer()
  renderDiagnostics()

  return peer
}

async function startBroadcast() {
  ensureEventSource()
  await refreshMediaDevices({ primeLabels: true })

  if (!sourceDeviceSelect.value) {
    throw new Error('Select source.')
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
  setStatus(statusBox, 'Live')

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
  applyServerRunningState(serverRunning)
  setStatus(statusBox, 'Idle')
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

function unregisterHostOnUnload() {
  if (unloadUnregisterSent) return
  unloadUnregisterSent = true

  const body = JSON.stringify({ clientId: hostId })

  if (navigator.sendBeacon && typeof navigator.sendBeacon === 'function') {
    try {
      const payload = new Blob([body], { type: 'application/json' })
      navigator.sendBeacon('/api/unregister', payload)
      return
    } catch (error) {}
  }

  fetch('/api/unregister', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body,
    keepalive: true
  }).catch(() => {})
}

startButton.addEventListener('click', async () => {
  if (!serverRunning) {
    setStatus(statusBox, 'Server is stopped. Click Start Server first.', 'warn')
    applyServerRunningState(serverRunning)
    return
  }

  startButton.disabled = true
  setStatus(statusBox, 'Opening...')

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
    applyServerRunningState(serverRunning)
    setStatus(statusBox, error.message, 'warn')
  }
})

stopButton.addEventListener('click', () => {
  stopBroadcast()
})

if (serverToggleButton) {
  serverToggleButton.addEventListener('click', async () => {
    if (serverControlBusy) return

    serverControlBusy = true
    setServerToggleButtonState()

    try {
      if (serverRunning) {
        await stopBroadcast()
      }

      const action = serverRunning ? 'stop' : 'start'
      const status = await postJson('/api/server-control', { action })
      renderLinks(status)
      setStatus(statusBox, status.serverRunning ? 'Server running.' : 'Server stopped.')
    } catch (error) {
      setStatus(statusBox, normalizeErrorMessage(error), 'warn')
      try {
        await refreshStatusAndLinks()
      } catch (refreshError) {}
    } finally {
      serverControlBusy = false
      setServerToggleButtonState()
    }
  })
}

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

if (eqDrawerBackdrop) {
  eqDrawerBackdrop.addEventListener('click', () => {
    closeEqDrawer()
  })
}

if (eqDrawerCloseButton) {
  eqDrawerCloseButton.addEventListener('click', () => {
    closeEqDrawer()
  })
}

eqResetButton.addEventListener('click', () => {
  if (!selectedEqClientId || !activeEqRuntime) return
  const flatState = getEqPreset(FLAT_PRESET_NAME) || cloneEqState(DEFAULT_EQ_STATE)
  applyEqStateToRuntime(activeEqRuntime, flatState)
  persistEqState(selectedEqClientId, flatState)
  refreshEqPresetSelect(FLAT_PRESET_NAME)
  if (eqBypassButton) {
    eqBypassButton.textContent = areAllActiveEqFiltersBypassed(activeEqRuntime) ? 'Unbypass' : 'Bypass'
  }
  eqDrawerStatus.textContent = `Preset loaded: ${FLAT_PRESET_NAME}.`
})

if (eqSavePresetButton) {
  eqSavePresetButton.addEventListener('click', () => {
    if (!activeEqRuntime) return

    const selectedName = String(eqPresetSelect && eqPresetSelect.value ? eqPresetSelect.value : '').trim()
    const nameToSave = selectedName && !isBuiltInEqPresetName(selectedName) && !isCustomEqPresetName(selectedName)
      ? selectedName
      : `Preset ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`

    if (!saveEqPreset(nameToSave, activeEqRuntime.spec)) {
      eqDrawerStatus.textContent = 'Save failed.'
      return
    }

    refreshEqPresetSelect(nameToSave)
    eqDrawerStatus.textContent = `Preset saved: ${nameToSave}.`
  })
}

if (eqPresetSelect) {
  eqPresetSelect.addEventListener('change', () => {
    if (!selectedEqClientId || !activeEqRuntime) return

    const selectedName = String(eqPresetSelect.value || '').trim()
    if (isCustomEqPresetName(selectedName)) {
      eqDrawerStatus.textContent = 'Preset: custom.'
      return
    }

    if (!selectedName) {
      eqDrawerStatus.textContent = 'No presets saved.'
      return
    }

    const presetState = getEqPreset(selectedName)
    if (!presetState) {
      eqDrawerStatus.textContent = 'Preset not found.'
      return
    }

    applyEqStateToRuntime(activeEqRuntime, presetState)
    persistEqState(selectedEqClientId, presetState)
    if (eqBypassButton) {
      eqBypassButton.textContent = areAllActiveEqFiltersBypassed(activeEqRuntime) ? 'Unbypass' : 'Bypass'
    }
    eqDrawerStatus.textContent = `Preset loaded: ${selectedName}.`
  })
}

if (eqBypassButton) {
  eqBypassButton.addEventListener('click', () => {
    if (!selectedEqClientId || !activeEqRuntime) return

    const nextBypass = !areAllActiveEqFiltersBypassed(activeEqRuntime)
    activeEqRuntime.spec.forEach((filter, index) => {
      if (!filter || filter.type === 'noop') return
      activeEqRuntime.toggleBypass(index, nextBypass)
    })
    persistEqState(selectedEqClientId, activeEqRuntime.spec)
    eqBypassButton.textContent = nextBypass ? 'Unbypass' : 'Bypass'
    eqDrawerStatus.textContent = nextBypass ? 'Bypassed.' : 'Active.'
  })
}

presetButtons.forEach(button => {
  button.addEventListener('click', () => {
    requestSelfDelayChange(button.dataset.delay)
  })
})

window.addEventListener('beforeunload', () => {
  unregisterHostOnUnload()
  if (eventSource) eventSource.close()
  closeEqDrawer()
  stopLocalMonitor()
  sourceVisualizer.close().catch(() => {})
  monitorVisualizer.close().catch(() => {})
  if (diagnosticsInterval) {
    window.clearInterval(diagnosticsInterval)
  }
})

window.addEventListener('pagehide', () => {
  unregisterHostOnUnload()
})

updateMonitorDelayLabel()
renderParticipants()
startDiagnostics()
renderRemoteDiagnostics()
renderEqDrawer()
applyServerRunningState(serverRunning)

refreshStatusAndLinks()
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

ensureEqModules().catch(() => {})
