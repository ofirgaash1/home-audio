'use strict'

const CHANNEL_OPTIONS = [
  { value: 'stereo', label: 'Stereo' },
  { value: 'mono', label: 'Mono Mix' },
  { value: 'left', label: 'L' },
  { value: 'right', label: 'R' }
]

function randomId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function setStatus(element, message, tone) {
  element.textContent = message
  if (tone) {
    element.dataset.tone = tone
  } else {
    delete element.dataset.tone
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

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  const json = await response.json()

  if (!response.ok) {
    throw new Error(json.error || 'Request failed')
  }

  return json
}

async function fetchStatus() {
  const response = await fetch('/api/status', { cache: 'no-store' })
  return response.json()
}

function tuneOpusSdp(sdp) {
  if (!sdp) return sdp

  const opusMatch = sdp.match(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?$/m)
  if (!opusMatch) return sdp

  const payloadType = opusMatch[1]
  const fmtpPattern = new RegExp(`^a=fmtp:${payloadType}\\s+(.+)$`, 'm')
  const fmtpMatch = sdp.match(fmtpPattern)
  const desiredParams = {
    stereo: '1',
    'sprop-stereo': '1',
    maxaveragebitrate: '256000',
    maxplaybackrate: '48000'
  }

  if (!fmtpMatch) {
    return sdp.replace(
      opusMatch[0],
      `${opusMatch[0]}\r\na=fmtp:${payloadType} ${Object.entries(desiredParams)
        .map(([key, value]) => `${key}=${value}`)
        .join(';')}`
    )
  }

  const params = new Map()
  fmtpMatch[1]
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .forEach(part => {
      const [key, value] = part.split('=')
      params.set(key, value || '')
    })

  Object.entries(desiredParams).forEach(([key, value]) => {
    params.set(key, value)
  })

  const tunedLine = `a=fmtp:${payloadType} ${Array.from(params.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join(';')}`

  return sdp.replace(fmtpPattern, tunedLine)
}

async function optimizeAudioStream(stream) {
  if (!stream) return

  const audioTracks = stream.getAudioTracks()
  if (!audioTracks.length) return

  await Promise.allSettled(
    audioTracks.map(async track => {
      if ('contentHint' in track) {
        track.contentHint = 'music'
      }

      if (typeof track.applyConstraints === 'function') {
        try {
          await track.applyConstraints({
            channelCount: 2,
            sampleRate: 48000,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          })
        } catch (error) {
          console.debug('Audio constraints were not fully applied:', error)
        }
      }
    })
  )
}

function connectChannelMode(splitter, merger, channelMode) {
  try {
    splitter.disconnect()
  } catch (error) {}

  const mode = normalizeChannelMode(channelMode)

  if (mode === 'left') {
    splitter.connect(merger, 0, 0)
    splitter.connect(merger, 0, 1)
    return
  }

  if (mode === 'right') {
    splitter.connect(merger, 1, 0)
    splitter.connect(merger, 1, 1)
    return
  }

  splitter.connect(merger, 0, 0)
  splitter.connect(merger, 1, 1)
}

function createStreamVisualizer(canvas, valueElement) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  const drawingContext = canvas && typeof canvas.getContext === 'function'
    ? canvas.getContext('2d')
    : null

  let audioContext = null
  let analyser = null
  let sourceNode = null
  let animationFrameId = null
  let waveformBuffer = null
  let levelBuffer = null
  let lastLevel = 0

  function updateLabel(message) {
    if (valueElement) {
      valueElement.textContent = message
    }
  }

  function fitCanvas() {
    if (!canvas || !drawingContext) return

    const ratio = window.devicePixelRatio || 1
    const displayWidth = Math.max(240, Math.round(canvas.clientWidth || 320))
    const displayHeight = Math.max(72, Math.round(canvas.clientHeight || 120))

    if (canvas.width === Math.round(displayWidth * ratio) && canvas.height === Math.round(displayHeight * ratio)) {
      return
    }

    canvas.width = Math.round(displayWidth * ratio)
    canvas.height = Math.round(displayHeight * ratio)
    drawingContext.setTransform(ratio, 0, 0, ratio, 0, 0)
  }

  function drawPlaceholder(message) {
    if (!drawingContext || !canvas) return

    fitCanvas()

    const width = canvas.width / (window.devicePixelRatio || 1)
    const height = canvas.height / (window.devicePixelRatio || 1)

    drawingContext.clearRect(0, 0, width, height)
    drawingContext.fillStyle = '#171511'
    drawingContext.fillRect(0, 0, width, height)
    drawingContext.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    drawingContext.strokeRect(0.5, 0.5, width - 1, height - 1)
    drawingContext.fillStyle = 'rgba(247, 243, 234, 0.7)'
    drawingContext.font = '14px Georgia, serif'
    drawingContext.textAlign = 'center'
    drawingContext.textBaseline = 'middle'
    drawingContext.fillText(message, width / 2, height / 2)
  }

  function disconnectSource() {
    if (!sourceNode) return

    try {
      sourceNode.disconnect()
    } catch (error) {}

    sourceNode = null
  }

  function stopLoop() {
    if (!animationFrameId) return
    window.cancelAnimationFrame(animationFrameId)
    animationFrameId = null
  }

  function drawFrame() {
    animationFrameId = window.requestAnimationFrame(drawFrame)

    if (!drawingContext || !canvas || !analyser || !waveformBuffer || !levelBuffer) {
      return
    }

    fitCanvas()

    const width = canvas.width / (window.devicePixelRatio || 1)
    const height = canvas.height / (window.devicePixelRatio || 1)
    const meterWidth = Math.max(48, Math.round(width * 0.14))
    const plotWidth = width - meterWidth - 18

    analyser.getFloatTimeDomainData(levelBuffer)
    analyser.getByteTimeDomainData(waveformBuffer)

    let sumSquares = 0
    for (let index = 0; index < levelBuffer.length; index += 1) {
      const sample = levelBuffer[index]
      sumSquares += sample * sample
    }

    const rms = Math.sqrt(sumSquares / levelBuffer.length)
    const normalizedLevel = Math.max(0, Math.min(1, rms * 5))
    lastLevel = normalizedLevel

    drawingContext.clearRect(0, 0, width, height)
    drawingContext.fillStyle = '#171511'
    drawingContext.fillRect(0, 0, width, height)

    drawingContext.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    drawingContext.strokeRect(0.5, 0.5, width - 1, height - 1)

    drawingContext.strokeStyle = 'rgba(247, 243, 234, 0.18)'
    drawingContext.beginPath()
    drawingContext.moveTo(12, height / 2)
    drawingContext.lineTo(plotWidth, height / 2)
    drawingContext.stroke()

    drawingContext.lineWidth = 2
    drawingContext.strokeStyle = '#8dd5b5'
    drawingContext.beginPath()

    for (let index = 0; index < waveformBuffer.length; index += 1) {
      const x = 12 + (index / (waveformBuffer.length - 1)) * Math.max(1, plotWidth - 24)
      const y = 10 + (waveformBuffer[index] / 255) * (height - 20)

      if (index === 0) {
        drawingContext.moveTo(x, y)
      } else {
        drawingContext.lineTo(x, y)
      }
    }

    drawingContext.stroke()

    const meterX = width - meterWidth
    const meterHeight = height - 20
    const levelHeight = meterHeight * normalizedLevel

    drawingContext.fillStyle = 'rgba(255, 255, 255, 0.08)'
    drawingContext.fillRect(meterX, 10, meterWidth - 12, meterHeight)

    drawingContext.fillStyle = normalizedLevel > 0.8 ? '#d98c3b' : '#0e6b50'
    drawingContext.fillRect(
      meterX,
      10 + meterHeight - levelHeight,
      meterWidth - 12,
      levelHeight
    )

    updateLabel(`Level ${Math.round(normalizedLevel * 100)}%`)
  }

  async function ensureContext() {
    if (!AudioContextClass) {
      throw new Error('This browser does not support audio analysis.')
    }

    if (!audioContext) {
      audioContext = new AudioContextClass()
    }

    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }

    if (!analyser) {
      analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      waveformBuffer = new Uint8Array(analyser.fftSize)
      levelBuffer = new Float32Array(analyser.fftSize)
    }
  }

  async function attachStream(stream) {
    disconnectSource()
    stopLoop()

    if (!stream || !stream.getAudioTracks().length) {
      updateLabel('No stream')
      drawPlaceholder('No signal')
      return
    }

    await ensureContext()
    sourceNode = audioContext.createMediaStreamSource(stream)
    sourceNode.connect(analyser)
    updateLabel('Level 0%')
    drawFrame()
  }

  function clear(message) {
    disconnectSource()
    stopLoop()
    lastLevel = 0
    updateLabel(message || 'No stream')
    drawPlaceholder(message || 'No signal')
  }

  async function resume() {
    if (!audioContext) return
    if (audioContext.state === 'suspended') {
      await audioContext.resume()
    }
  }

  async function close() {
    disconnectSource()
    stopLoop()

    if (audioContext) {
      await audioContext.close()
    }

    audioContext = null
    analyser = null
    waveformBuffer = null
    levelBuffer = null
    lastLevel = 0
    drawPlaceholder('Visualizer offline')
  }

  clear('Waiting for audio')

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', fitCanvas)
  }

  return {
    attachStream,
    clear,
    resume,
    getLevel() {
      return lastLevel
    },
    close
  }
}

async function createProcessedAudioEngine(stream, options) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext
  if (!AudioContextClass) {
    throw new Error('This browser does not support Web Audio processing.')
  }

  const context = new AudioContextClass()
  const sourceNode = context.createMediaStreamSource(stream)
  const delayNode = context.createDelay(5)
  const splitter = context.createChannelSplitter(2)
  const leftToLeftGain = context.createGain()
  const leftToRightGain = context.createGain()
  const rightToLeftGain = context.createGain()
  const rightToRightGain = context.createGain()
  const merger = context.createChannelMerger(2)
  const destination = context.createMediaStreamDestination()

  sourceNode.connect(delayNode)
  delayNode.connect(splitter)
  splitter.connect(leftToLeftGain, 0)
  splitter.connect(leftToRightGain, 0)
  splitter.connect(rightToLeftGain, 1)
  splitter.connect(rightToRightGain, 1)
  leftToLeftGain.connect(merger, 0, 0)
  leftToRightGain.connect(merger, 0, 1)
  rightToLeftGain.connect(merger, 0, 0)
  rightToRightGain.connect(merger, 0, 1)
  merger.connect(destination)

  function applyChannelMode(channelMode) {
    const mode = normalizeChannelMode(channelMode)

    let leftToLeft = 0
    let leftToRight = 0
    let rightToLeft = 0
    let rightToRight = 0

    if (mode === 'left') {
      leftToLeft = 1
      leftToRight = 1
    } else if (mode === 'right') {
      rightToLeft = 1
      rightToRight = 1
    } else if (mode === 'mono') {
      leftToLeft = 0.5
      leftToRight = 0.5
      rightToLeft = 0.5
      rightToRight = 0.5
    } else {
      leftToLeft = 1
      rightToRight = 1
    }

    leftToLeftGain.gain.setValueAtTime(leftToLeft, context.currentTime)
    leftToRightGain.gain.setValueAtTime(leftToRight, context.currentTime)
    rightToLeftGain.gain.setValueAtTime(rightToLeft, context.currentTime)
    rightToRightGain.gain.setValueAtTime(rightToRight, context.currentTime)
  }

  applyChannelMode(options && options.channelMode)
  delayNode.delayTime.value = clampDelay(options && options.delayMs) / 1000
  await context.resume()

  return {
    context,
    outputStream: destination.stream,
    setDelay(delayMs) {
      delayNode.delayTime.setValueAtTime(
        clampDelay(delayMs) / 1000,
        context.currentTime
      )
    },
    setChannelMode(channelMode) {
      applyChannelMode(channelMode)
    },
    async close() {
      try {
        sourceNode.disconnect()
      } catch (error) {}

      try {
        delayNode.disconnect()
      } catch (error) {}

      try {
        splitter.disconnect()
      } catch (error) {}

      try {
        leftToLeftGain.disconnect()
      } catch (error) {}

      try {
        leftToRightGain.disconnect()
      } catch (error) {}

      try {
        rightToLeftGain.disconnect()
      } catch (error) {}

      try {
        rightToRightGain.disconnect()
      } catch (error) {}

      try {
        merger.disconnect()
      } catch (error) {}

      await context.close()
    }
  }
}

function findParticipant(participants, clientId) {
  return (participants || []).find(participant => participant.clientId === clientId) || null
}

function formatParticipantLabel(participant, currentClientId) {
  const suffix = participant.clientId === currentClientId ? ' (you)' : ''
  return `${participant.label}${suffix}`
}

function renderParticipantsTable(tbody, participants, currentClientId, handlers) {
  tbody.textContent = ''

  if (!participants.length) {
    const row = document.createElement('tr')
    const cell = document.createElement('td')
    cell.colSpan = 4
    cell.className = 'participant-empty'
    cell.textContent = 'No active participants yet.'
    row.appendChild(cell)
    tbody.appendChild(row)
    return
  }

  participants.forEach(participant => {
    const row = document.createElement('tr')

    const nameCell = document.createElement('td')
    nameCell.textContent = formatParticipantLabel(participant, currentClientId)
    row.appendChild(nameCell)

    const roleCell = document.createElement('td')
    roleCell.textContent = participant.role === 'broadcaster' ? 'Host' : 'Listener'
    row.appendChild(roleCell)

    const delayCell = document.createElement('td')
    const delayControls = document.createElement('div')
    delayControls.className = 'delay-controls'

    const minusButton = document.createElement('button')
    minusButton.type = 'button'
    minusButton.className = 'secondary delay-button'
    minusButton.textContent = '-10 ms'
    minusButton.addEventListener('click', () => {
      handlers.onAdjustDelay(participant.clientId, -10)
    })

    const delayValue = document.createElement('span')
    delayValue.className = 'delay-value'
    delayValue.textContent = `${participant.delayMs} ms`

    const plusButton = document.createElement('button')
    plusButton.type = 'button'
    plusButton.className = 'secondary delay-button'
    plusButton.textContent = '+10 ms'
    plusButton.addEventListener('click', () => {
      handlers.onAdjustDelay(participant.clientId, 10)
    })

    delayControls.append(minusButton, delayValue, plusButton)
    delayCell.appendChild(delayControls)
    row.appendChild(delayCell)

    const channelCell = document.createElement('td')
    const channelSelect = document.createElement('select')
    channelSelect.className = 'channel-select'

    CHANNEL_OPTIONS.forEach(optionConfig => {
      const option = document.createElement('option')
      option.value = optionConfig.value
      option.textContent = optionConfig.label
      channelSelect.appendChild(option)
    })

    channelSelect.value = normalizeChannelMode(participant.channelMode)
    channelSelect.addEventListener('change', event => {
      handlers.onChangeChannel(participant.clientId, event.target.value)
    })

    channelCell.appendChild(channelSelect)
    row.appendChild(channelCell)

    tbody.appendChild(row)
  })
}
