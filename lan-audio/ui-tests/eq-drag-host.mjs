import { spawn } from 'node:child_process'
import { setTimeout as wait } from 'node:timers/promises'
import { chromium } from 'playwright'

const PORT = 43133
const SERVER_URL = `http://127.0.0.1:${PORT}`
const HOST_URL = `${SERVER_URL}/host`
const SERVER_CWD = process.cwd()

async function waitForServer(url, timeoutMs = 20000) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' })
      if (response.ok) return
    } catch (error) {}

    await wait(250)
  }

  throw new Error(`Server did not start within ${timeoutMs}ms`)
}

function parseTranslateY(transformText) {
  if (!transformText) return NaN
  const match = transformText.match(/translate\(\s*[-\d.]+px\s*,\s*([-\d.]+)px\s*\)/i)
  return match ? Number(match[1]) : NaN
}

const server = spawn('node', ['lan-audio/server.js'], {
  cwd: SERVER_CWD,
  env: {
    ...process.env,
    PORT: String(PORT)
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

server.stdout.on('data', chunk => {
  process.stdout.write(`[server] ${chunk}`)
})
server.stderr.on('data', chunk => {
  process.stderr.write(`[server:err] ${chunk}`)
})

let browser

try {
  await waitForServer(HOST_URL)

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  page.on('console', message => {
    if (message.type() === 'error') {
      console.error(`[browser:console] ${message.text()}`)
    }
  })
  page.on('pageerror', error => {
    console.error(`[browser:pageerror] ${error.message}`)
  })

  await page.goto(HOST_URL, { waitUntil: 'load' })
  await page.waitForLoadState('networkidle')

  let injected = false
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await page.evaluate(async () => {
        const { WEQ8Runtime } = await import('weq8')
        await import('weq8/ui')

        const AudioContextClass = window.AudioContext || window.webkitAudioContext
        if (!AudioContextClass) {
          throw new Error('Missing AudioContext in browser')
        }

        const audioContext = new AudioContextClass()
        const runtime = new WEQ8Runtime(audioContext)
        const oscillator = audioContext.createOscillator()
        oscillator.type = 'sine'
        oscillator.frequency.value = 440
        oscillator.connect(runtime.input)
        oscillator.start()
        await audioContext.resume()

        const drawer = document.querySelector('#eq-drawer-shell')
        const eqUi = document.querySelector('#participant-eq-ui')
        const subtitle = document.querySelector('#eq-drawer-subtitle')
        const status = document.querySelector('#eq-drawer-status')
        const title = document.querySelector('#eq-drawer-title')

        if (!drawer || !eqUi || !subtitle || !status || !title) {
          throw new Error('Missing EQ drawer elements on host page')
        }

        eqUi.runtime = runtime
        drawer.hidden = false
        document.body.classList.add('drawer-open')
        title.textContent = 'EQ: Test Runtime'
        subtitle.textContent = 'UI test runtime'
        status.textContent = 'Injected runtime'

        window.__eqUiTestRuntime = runtime
        window.__eqUiTestOscillator = oscillator
        window.__eqUiTestAudioContext = audioContext
      })
      injected = true
      break
    } catch (error) {
      if (attempt === 3 || !String(error.message || error).includes('Execution context was destroyed')) {
        throw error
      }
      await page.waitForLoadState('load')
    }
  }

  if (!injected) {
    throw new Error('Failed to inject EQ runtime for UI test')
  }

  await page.waitForSelector('weq8-ui .filter-handle-positioner')

  const defaultSpec = await page.evaluate(() => {
    return window.__eqUiTestRuntime.spec.map(filter => ({
      type: filter.type,
      frequency: Math.round(filter.frequency)
    }))
  })

  const expectedDefaults = [
    { type: 'lowshelf12', frequency: 63 },
    { type: 'peaking12', frequency: 136 },
    { type: 'peaking12', frequency: 294 },
    { type: 'peaking12', frequency: 632 },
    { type: 'peaking12', frequency: 1363 },
    { type: 'peaking12', frequency: 2936 },
    { type: 'highshelf12', frequency: 6324 }
  ]

  expectedDefaults.forEach((expected, index) => {
    const actual = defaultSpec[index]

    if (!actual || actual.type !== expected.type || actual.frequency !== expected.frequency) {
      throw new Error(
        `Default spec mismatch at band ${index + 1}: expected ${expected.type}@${expected.frequency}, got ${actual ? `${actual.type}@${actual.frequency}` : 'missing'}`
      )
    }
  })

  const secondPositioner = page.locator('weq8-ui .filter-handle-positioner').nth(1)
  const secondHandle = page.locator('weq8-ui .filter-handle').nth(1)
  const secondGainInput = page.locator('weq8-ui .gainInput').nth(1)
  await secondPositioner.scrollIntoViewIfNeeded()

  const beforeTransform = await secondPositioner.evaluate(element => element.getAttribute('style') || '')
  const beforeY = parseTranslateY(beforeTransform)
  const beforeGain = Number(await secondGainInput.inputValue())
  const box = await secondPositioner.boundingBox()

  if (!box) {
    throw new Error('Could not get handle bounding box')
  }

  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2

  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY - 120, { steps: 16 })
  await page.mouse.up()

  await wait(250)

  const afterTransform = await secondPositioner.evaluate(element => element.getAttribute('style') || '')
  const afterY = parseTranslateY(afterTransform)
  const afterGain = Number(await secondGainInput.inputValue())

  console.log(`before: y=${beforeY.toFixed(2)} gain=${beforeGain.toFixed(2)} style=${beforeTransform}`)
  console.log(`after:  y=${afterY.toFixed(2)} gain=${afterGain.toFixed(2)} style=${afterTransform}`)

  if (!Number.isFinite(beforeY) || !Number.isFinite(afterY)) {
    throw new Error('Could not parse handle Y position from transform style')
  }

  const yDelta = Math.abs(afterY - beforeY)
  const gainDelta = Math.abs(afterGain - beforeGain)

  if (gainDelta < 1) {
    throw new Error(`Expected gain to change after drag, delta=${gainDelta}`)
  }

  if (yDelta < 8) {
    throw new Error(`Expected handle Y to move after drag, delta=${yDelta}`)
  }

  const qBefore = await page.evaluate(() => window.__eqUiTestRuntime.spec[1].Q)

  const middleStart = await secondPositioner.boundingBox()
  if (!middleStart) {
    throw new Error('Could not get second handle bounding box for Q drag')
  }

  const middleX = middleStart.x + middleStart.width / 2
  const middleY = middleStart.y + middleStart.height / 2

  await page.mouse.move(middleX, middleY)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(middleX + 140, middleY, { steps: 12 })
  await page.mouse.up({ button: 'middle' })
  await wait(200)

  const qAfter = await page.evaluate(() => window.__eqUiTestRuntime.spec[1].Q)
  const gainAfterQDrag = Number(await secondGainInput.inputValue())
  const qDelta = Math.abs(qAfter - qBefore)
  const gainShiftFromQDrag = Math.abs(gainAfterQDrag - afterGain)

  if (qDelta < 0.05) {
    throw new Error(`Expected Q to change on middle-button horizontal drag, delta=${qDelta}`)
  }

  if (gainShiftFromQDrag > 0.2) {
    throw new Error(`Expected gain to stay stable during Q drag, gain delta=${gainShiftFromQDrag}`)
  }

  console.log(
    `PASS: defaults verified, vertical gain drag moved ${yDelta.toFixed(2)}px, middle-button Q drag changed Q by ${qDelta.toFixed(3)}`
  )
} finally {
  if (browser) {
    await browser.close().catch(() => {})
  }

  if (!server.killed) {
    server.kill()
    await wait(500)
  }
}
