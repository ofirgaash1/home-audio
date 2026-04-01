import { css as A, LitElement as Q, html as f, svg as V } from "lit";
import { property as x, state as m, customElement as T, query as G } from "lit/decorators.js";
import { classMap as d } from "lit/directives/class-map.js";
import { a as z, f as q, b as P, c as v, d as M, e as $, h as k, t as w, i as F, D as H } from "./functions.fad2c372.js";
function u(S, e, t, i) {
  var r = arguments.length, n = r < 3 ? e : i === null ? i = Object.getOwnPropertyDescriptor(e, t) : i, l;
  if (typeof Reflect == "object" && typeof Reflect.decorate == "function")
    n = Reflect.decorate(S, e, t, i);
  else
    for (var a = S.length - 1; a >= 0; a--)
      (l = S[a]) && (n = (r < 3 ? l(n) : r > 3 ? l(e, t, n) : l(e, t)) || n);
  return r > 3 && n && Object.defineProperty(e, t, n), n;
}
class X {
  constructor(e, t) {
    this.runtime = e, this.canvas = t, this.disposed = !1, this.analyser = e.audioCtx.createAnalyser(), this.analyser.fftSize = 8192, this.analyser.smoothingTimeConstant = 0.5, e.connect(this.analyser), this.analysisData = new Uint8Array(this.analyser.frequencyBinCount);
    let i = Math.log10(e.audioCtx.sampleRate / 2) - 1;
    this.canvas.width = this.canvas.offsetWidth * window.devicePixelRatio, this.canvas.height = this.canvas.offsetHeight * window.devicePixelRatio, this.analysisXs = this.calculateAnalysisXs(i), this.resizeObserver = new ResizeObserver(() => {
      this.canvas.width = this.canvas.offsetWidth * window.devicePixelRatio, this.canvas.height = this.canvas.offsetHeight * window.devicePixelRatio, this.analysisXs = this.calculateAnalysisXs(i);
    }), this.resizeObserver.observe(this.canvas);
  }
  calculateAnalysisXs(e) {
    return Array.from(this.analysisData).map((t, i) => {
      let r = i / this.analysisData.length * (this.runtime.audioCtx.sampleRate / 2);
      return Math.floor((Math.log10(r) - 1) / e * this.canvas.width);
    });
  }
  analyse() {
    let e = () => {
      this.disposed || (this.analyser.getByteFrequencyData(this.analysisData), this.draw(), requestAnimationFrame(e));
    };
    requestAnimationFrame(e);
  }
  draw() {
    let e = this.canvas.width, t = this.canvas.height, i = this.canvas.height / 255, r = this.canvas.getContext("2d");
    if (!r)
      throw new Error("Could not get a canvas context!");
    r.clearRect(0, 0, e, t);
    let n = new Path2D();
    n.moveTo(0, t);
    for (let l = 0; l < this.analysisData.length; l++) {
      let a = Math.floor(t - this.analysisData[l] * i);
      n.lineTo(this.analysisXs[l], a);
    }
    n.lineTo(e, t), r.fillStyle = "rgba(30, 30, 60, 0.7)", r.fill(n), r.strokeStyle = "rgb(155, 155, 255)", r.stroke(n);
  }
  dispose() {
    this.disposed = !0, this.analyser.disconnect(), this.resizeObserver.disconnect();
  }
}
class L {
  constructor(e, t) {
    this.runtime = e, this.canvas = t, this.canvas.width = this.canvas.offsetWidth * window.devicePixelRatio, this.canvas.height = this.canvas.offsetHeight * window.devicePixelRatio, this.frequencies = this.calculateFrequencies(), this.filterMagResponse = new Float32Array(this.frequencies.length), this.filterPhaseResponse = new Float32Array(this.frequencies.length), this.frequencyResponse = new Float32Array(this.frequencies.length), this.resizeObserver = new ResizeObserver(() => {
      this.canvas.width = this.canvas.offsetWidth * window.devicePixelRatio, this.canvas.height = this.canvas.offsetHeight * window.devicePixelRatio, this.frequencies = this.calculateFrequencies(), this.filterMagResponse = new Float32Array(this.frequencies.length), this.filterPhaseResponse = new Float32Array(this.frequencies.length), this.frequencyResponse = new Float32Array(this.frequencies.length), this.render();
    }), this.resizeObserver.observe(this.canvas);
  }
  dispose() {
    this.resizeObserver.disconnect();
  }
  render() {
    this.frequencyResponse.fill(1);
    for (let e = 0; e < this.runtime.spec.length; e++)
      for (let t = 0; t < z(this.runtime.spec[e].type); t++)
        if (this.runtime.getFrequencyResponse(e, t, this.frequencies, this.filterMagResponse, this.filterPhaseResponse))
          for (let r = 0; r < this.frequencyResponse.length; r++)
            this.frequencyResponse[r] *= this.filterMagResponse[r];
    this.draw();
  }
  draw() {
    let e = this.canvas.getContext("2d"), t = this.canvas.width, i = this.canvas.height;
    if (!e)
      throw new Error("Could not get a canvas context!");
    e.clearRect(0, 0, t, i), e.strokeStyle = "#ffffff", e.lineWidth = 2, e.beginPath();
    let r = 13, n = -r;
    for (let l = 0; l < this.frequencyResponse.length; l++) {
      let a = this.frequencyResponse[l], o = 20 * Math.log10(a), s = i - (o - n) / (r - n) * i;
      l === 0 ? e.moveTo(l, s) : e.lineTo(l, s);
    }
    e.stroke();
  }
  calculateFrequencies() {
    let e = new Float32Array(this.canvas.width), t = this.runtime.audioCtx.sampleRate / 2, i = 1, r = Math.log10(t);
    for (let n = 0; n < this.canvas.width; n++) {
      let l = i + n / this.canvas.width * (r - i), a = Math.pow(10, l);
      e[n] = a;
    }
    return e;
  }
}
const C = A`
  @import url("https://fonts.googleapis.com/css2?family=Inter:wght@500&display=swap");

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  :host {
    background-color: #111;
    color: white;
    --font-stack: "Inter", sans-serif;
    --font-size: 11px;
    --font-weight: 500;
    font-family: var(--font-stack);
    font-size: var(--font-size);
    font-weight: var(--font-weight);
  }
`, E = [
  ["noop", "Add +"],
  ["lowpass12", "LP12"],
  ["lowpass24", "LP24"],
  ["highpass12", "HP12"],
  ["highpass24", "HP24"],
  ["lowshelf12", "LS12"],
  ["lowshelf24", "LS24"],
  ["highshelf12", "HS12"],
  ["highshelf24", "HS24"],
  ["peaking12", "PK12"],
  ["peaking24", "PK24"],
  ["notch12", "NT12"],
  ["notch24", "NT24"]
];
var D;
let I = (D = class extends Q {
  constructor() {
    super(), this.frequencyInputFocused = !1, this.dragStates = { frequency: null, gain: null, Q: null }, this.addEventListener("click", () => this.dispatchEvent(new CustomEvent("select", { composed: !0, bubbles: !0 })));
  }
  render() {
    if (!this.runtime || this.index === void 0)
      return;
    let e = E.filter((i) => this.runtime.supportedFilterTypes.includes(i[0])), t = this.runtime.spec[this.index];
    return f`
      <th>
        <div
          class=${d({
      chip: !0,
      disabled: !q(t.type),
      bypassed: t.bypass
    })}
        >
          <div
            class=${d({
      filterNumber: !0,
      bypassed: t.bypass
    })}
            @click=${() => this.toggleBypass()}
          >
            ${this.index + 1}
          </div>
          <select
            class=${d({ filterTypeSelect: !0, bypassed: t.bypass })}
            @change=${(i) => this.setFilterType(i.target.value)}
          >
            ${e.map(([i, r]) => f`<option value=${i} ?selected=${t.type === i}>
                  ${r}
                </option>`)}
          </select>
        </div>
      </th>
      <td>
        <input
          class=${d({
      frequencyInput: !0,
      numberInput: !0,
      bypassed: t.bypass
    })}
          type="number"
          step="0.1"
          lang="en_EN"
          .value=${P(t.frequency, this.frequencyInputFocused)}
          ?disabled=${!q(t.type)}
          @focus=${() => this.frequencyInputFocused = !0}
          @blur=${() => {
      this.frequencyInputFocused = !1, this.setFilterFrequency(v(t.frequency, 10, this.nyquist));
    }}
          @input=${(i) => this.setFilterFrequency(i.target.valueAsNumber)}
          @pointerdown=${(i) => this.startDraggingValue(i, "frequency")}
          @pointerup=${(i) => this.stopDraggingValue(i, "frequency")}
          @pointermove=${(i) => this.dragValue(i, "frequency")}
        />
        <span
          class=${d({
      frequencyUnit: !0,
      disabled: !q(t.type),
      bypassed: t.bypass
    })}
          >${M(t.frequency, this.frequencyInputFocused)}</span
        >
      </td>
      <td>
        <input
          class=${d({
      gainInput: !0,
      numberInput: !0,
      bypassed: t.bypass
    })}
          type="number"
          min="-18"
          max="18"
          step="0.1"
          lang="en_EN"
          .value=${t.gain.toFixed(1)}
          ?disabled=${!$(t.type)}
          @input=${(i) => this.setFilterGain(i.target.valueAsNumber)}
          @pointerdown=${(i) => this.startDraggingValue(i, "gain")}
          @pointerup=${(i) => this.stopDraggingValue(i, "gain")}
          @pointermove=${(i) => this.dragValue(i, "gain")}
        />
        <span
          class=${d({
      gainUnit: !0,
      disabled: !$(t.type),
      bypassed: t.bypass
    })}
          >dB</span
        >
      </td>
      <td>
        <input
          class=${d({
      qInput: !0,
      numberInput: !0,
      bypassed: t.bypass
    })}
          type="number"
          min="0.1"
          max="18"
          step="0.1"
          .value=${t.Q.toFixed(2)}
          ?disabled=${!k(t.type)}
          @input=${(i) => this.setFilterQ(i.target.valueAsNumber)}
          @pointerdown=${(i) => this.startDraggingValue(i, "Q")}
          @pointerup=${(i) => this.stopDraggingValue(i, "Q")}
          @pointermove=${(i) => this.dragValue(i, "Q")}
        />
      </td>
    `;
  }
  get nyquist() {
    var e, t;
    return ((t = (e = this.runtime) == null ? void 0 : e.audioCtx.sampleRate) != null ? t : 48e3) / 2;
  }
  toggleBypass() {
    !this.runtime || this.index === void 0 || this.runtime.toggleBypass(this.index, !this.runtime.spec[this.index].bypass);
  }
  setFilterType(e) {
    !this.runtime || this.index === void 0 || this.runtime.setFilterType(this.index, e);
  }
  setFilterFrequency(e) {
    !this.runtime || this.index === void 0 || isNaN(e) || this.runtime.setFilterFrequency(this.index, e);
  }
  setFilterGain(e) {
    !this.runtime || this.index === void 0 || isNaN(e) || this.runtime.setFilterGain(this.index, e);
  }
  setFilterQ(e) {
    !this.runtime || this.index === void 0 || isNaN(e) || this.runtime.setFilterQ(this.index, e);
  }
  startDraggingValue(e, t) {
    !this.runtime || this.index === void 0 || (e.target.setPointerCapture(e.pointerId), this.dragStates = {
      ...this.dragStates,
      [t]: {
        pointer: e.pointerId,
        startY: e.clientY,
        startValue: this.runtime.spec[this.index][t]
      }
    });
  }
  stopDraggingValue(e, t) {
    var i;
    !this.runtime || this.index === void 0 || ((i = this.dragStates[t]) == null ? void 0 : i.pointer) === e.pointerId && (e.target.releasePointerCapture(e.pointerId), this.dragStates = { ...this.dragStates, [t]: null });
  }
  dragValue(e, t) {
    if (!this.runtime || this.index === void 0)
      return;
    let i = this.dragStates[t];
    if (i && i.pointer === e.pointerId) {
      let r = i.startY, l = -(e.clientY - r), a = v(l / 150, -1, 1);
      if (t === "frequency") {
        let o = 10, s = this.runtime.audioCtx.sampleRate / 2, h = w(i.startValue, o, s), g = F(h + a, o, s);
        this.runtime.setFilterFrequency(this.index, g);
      } else if (t === "gain") {
        let o = a * 18;
        this.runtime.setFilterGain(this.index, v(i.startValue + o, -18, 18));
      } else if (t === "Q") {
        let o = 0.1, s = 18, h = w(i.startValue, o, s), g = F(h + a, o, s);
        this.runtime.setFilterQ(this.index, g);
      }
      e.target.blur();
    }
  }
}, (() => {
  D.styles = [
    C,
    A`
      :host {
        display: grid;
        grid-auto-flow: column;
        grid-template-columns: 60px 60px 50px 40px;
        align-items: center;
        gap: 4px;
        background-color: transparent;
        border-radius: 22px;
        transition: background-color 0.15s ease;
      }
      :host(.selected) {
        background-color: #373737;
      }
      input,
      select {
        padding: 0;
        border: 0;
      }
      input {
        border-bottom: 1px solid transparent;
        transition: border-color 0.15s ease;
      }
      input:focus,
      input:active {
        border-color: white;
      }
      .chip {
        display: inline-grid;
        grid-auto-flow: column;
        gap: 3px;
        height: 20px;
        padding-right: 6px;
        border-radius: 10px;
        background: #373737;
        transition: background-color 0.15s ease;
      }
      :host(.selected) .chip .filterNumber {
        background: #ffcc00;
      }
      .chip.disabled:hover {
        background: #444444;
      }
      .filterNumber {
        cursor: pointer;
        width: 20px;
        height: 20px;
        border-radius: 10px;
        display: grid;
        place-content: center;
        background: white;
        font-weight: var(--font-weight);
        color: black;
        transition: background-color 0.15s ease;
      }
      .chip.disabled .filterNumber {
        background: transparent;
        color: white;
      }
      .chip.bypassed .filterNumber {
        background: #7d7d7d;
        color: black;
      }
      .filterTypeSelect {
        width: 30px;
        appearance: none;
        outline: none;
        background-color: transparent;
        color: white;
        cursor: pointer;
        text-align: center;
        font-family: var(--font-stack);
        font-size: var(--font-size);
        font-weight: var(--font-weight);
      }
      .filterTypeSelect.bypassed {
        color: #7d7d7d;
      }
      .chip.disabled .filterTypeSelect {
        pointer-events: all;
      }
      .frequencyInput {
        width: 28px;
      }
      .gainInput {
        width: 26px;
      }
      .qInput {
        width: 30px;
      }
      .numberInput {
        appearance: none;
        outline: none;
        background-color: transparent;
        color: white;
        text-align: right;
        -moz-appearance: textfield;
        font-family: var(--font-stack);
        font-size: var(--font-size);
        font-weight: var(--font-weight);
        touch-action: none;
      }
      .numberInput:disabled,
      .disabled {
        color: #7d7d7d;
        pointer-events: none;
      }
      .bypassed {
        color: #7d7d7d;
      }
      .numberInput::-webkit-inner-spin-button,
      .numberInput::-webkit-outer-spin-button {
        -webkit-appearance: none !important;
        margin: 0 !important;
      }
    `
  ];
})(), D);
u([
  x({ attribute: !1 })
], I.prototype, "runtime", void 0);
u([
  x()
], I.prototype, "index", void 0);
u([
  m()
], I.prototype, "frequencyInputFocused", void 0);
u([
  m()
], I.prototype, "dragStates", void 0);
I = u([
  T("weq8-ui-filter-row")
], I);
var N;
let b = (N = class extends Q {
  constructor() {
    super(...arguments), this.x = 0, this.y = 0, this.frequencyInputFocused = !1, this.dragStates = { frequency: null, gain: null, Q: null }, this.posOnDragStart = null;
  }
  render() {
    var n, l, a, o;
    if (!this.runtime || this.index === void 0)
      return;
    let e = E.filter((s) => this.runtime.supportedFilterTypes.includes(s[0])), t = this.runtime.spec[this.index], i = ((l = (n = this.posOnDragStart) == null ? void 0 : n.x) != null ? l : this.x) - 100, r = ((o = (a = this.posOnDragStart) == null ? void 0 : a.y) != null ? o : this.y) + 20;
    return console.log("hi", i, r), f`
      <div class="root" style="transform: translate(${i}px, ${r}px);">
        <div>
          <div
            class=${d({
      chip: !0,
      disabled: !q(t.type),
      bypassed: t.bypass
    })}
          >
            <select
              class=${d({
      filterTypeSelect: !0,
      bypassed: t.bypass
    })}
              @change=${(s) => this.setFilterType(s.target.value)}
            >
              ${e.map(([s, h]) => f`<option value=${s} ?selected=${t.type === s}>
                    ${h}
                  </option>`)}
            </select>
          </div>
        </div>
        <div>
          <input
            class=${d({
      frequencyInput: !0,
      numberInput: !0,
      bypassed: t.bypass
    })}
            type="number"
            step="0.1"
            lang="en_EN"
            .value=${P(t.frequency, this.frequencyInputFocused)}
            ?disabled=${!q(t.type)}
            @focus=${() => this.frequencyInputFocused = !0}
            @blur=${() => {
      this.frequencyInputFocused = !1, this.setFilterFrequency(v(t.frequency, 10, this.nyquist));
    }}
            @input=${(s) => this.setFilterFrequency(s.target.valueAsNumber)}
            @pointerdown=${(s) => this.startDraggingValue(s, "frequency")}
            @pointerup=${(s) => this.stopDraggingValue(s, "frequency")}
            @pointermove=${(s) => this.dragValue(s, "frequency")}
          />
          <span
            class=${d({
      frequencyUnit: !0,
      disabled: !q(t.type),
      bypassed: t.bypass
    })}
            >${M(t.frequency, this.frequencyInputFocused)}</span
          >
        </div>
        <div>
          <input
            class=${d({
      gainInput: !0,
      numberInput: !0,
      bypassed: t.bypass
    })}
            type="number"
            min="-18"
            max="18"
            step="0.1"
            lang="en_EN"
            .value=${t.gain.toFixed(1)}
            ?disabled=${!$(t.type)}
            @input=${(s) => this.setFilterGain(s.target.valueAsNumber)}
            @pointerdown=${(s) => this.startDraggingValue(s, "gain")}
            @pointerup=${(s) => this.stopDraggingValue(s, "gain")}
            @pointermove=${(s) => this.dragValue(s, "gain")}
          />
          <span
            class=${d({
      gainUnit: !0,
      disabled: !$(t.type),
      bypassed: t.bypass
    })}
            >dB</span
          >
        </div>
        <div>
          <input
            class=${d({
      qInput: !0,
      numberInput: !0,
      bypassed: t.bypass
    })}
            type="number"
            min="0.1"
            max="18"
            step="0.1"
            .value=${t.Q.toFixed(2)}
            ?disabled=${!k(t.type)}
            @input=${(s) => this.setFilterQ(s.target.valueAsNumber)}
            @pointerdown=${(s) => this.startDraggingValue(s, "Q")}
            @pointerup=${(s) => this.stopDraggingValue(s, "Q")}
            @pointermove=${(s) => this.dragValue(s, "Q")}
          />
        </div>
      </div>
    `;
  }
  get nyquist() {
    var e, t;
    return ((t = (e = this.runtime) == null ? void 0 : e.audioCtx.sampleRate) != null ? t : 48e3) / 2;
  }
  setFilterType(e) {
    !this.runtime || this.index === void 0 || this.runtime.setFilterType(this.index, e);
  }
  setFilterFrequency(e) {
    !this.runtime || this.index === void 0 || isNaN(e) || this.runtime.setFilterFrequency(this.index, e);
  }
  setFilterGain(e) {
    !this.runtime || this.index === void 0 || isNaN(e) || this.runtime.setFilterGain(this.index, e);
  }
  setFilterQ(e) {
    !this.runtime || this.index === void 0 || isNaN(e) || this.runtime.setFilterQ(this.index, e);
  }
  startDraggingValue(e, t) {
    !this.runtime || this.index === void 0 || (e.target.setPointerCapture(e.pointerId), this.dragStates = {
      ...this.dragStates,
      [t]: {
        pointer: e.pointerId,
        startY: e.clientY,
        startValue: this.runtime.spec[this.index][t]
      }
    }, this.posOnDragStart = { x: this.x, y: this.y });
  }
  stopDraggingValue(e, t) {
    var i;
    !this.runtime || this.index === void 0 || (((i = this.dragStates[t]) == null ? void 0 : i.pointer) === e.pointerId && (e.target.releasePointerCapture(e.pointerId), this.dragStates = { ...this.dragStates, [t]: null }), this.dragStates.frequency === null && this.dragStates.gain === null && this.dragStates.Q === null && (this.posOnDragStart = null));
  }
  dragValue(e, t) {
    if (!this.runtime || this.index === void 0)
      return;
    let i = this.dragStates[t];
    if (i && i.pointer === e.pointerId) {
      let r = i.startY, l = -(e.clientY - r), a = v(l / 150, -1, 1);
      if (t === "frequency") {
        let o = 10, s = this.runtime.audioCtx.sampleRate / 2, h = w(i.startValue, o, s), g = F(h + a, o, s);
        this.runtime.setFilterFrequency(this.index, g);
      } else if (t === "gain") {
        let o = a * 18;
        this.runtime.setFilterGain(this.index, v(i.startValue + o, -18, 18));
      } else if (t === "Q") {
        let o = 0.1, s = 18, h = w(i.startValue, o, s), g = F(h + a, o, s);
        this.runtime.setFilterQ(this.index, g);
      }
      e.target.blur();
    }
  }
}, (() => {
  N.styles = [
    C,
    A`
      .root {
        position: absolute;
        display: grid;
        grid-auto-flow: column;
        width: 210px;
        grid-template-columns: 60px 60px 50px 40px;
        align-items: center;
        gap: 4px;
        background-color: black;
        border-radius: 22px;
      }
      input,
      select {
        padding: 0;
        border: 0;
      }
      input {
        border-bottom: 1px solid transparent;
        transition: border-color 0.15s ease;
      }
      input:focus,
      input:active {
        border-color: white;
      }
      .chip {
        display: inline-grid;
        grid-auto-flow: column;
        gap: 3px;
        height: 20px;
        padding-right: 6px;
        border-radius: 10px;
        background: #373737;
        transition: background-color 0.15s ease;
      }
      .chip.disabled:hover {
        background: #444444;
      }
      .filterTypeSelect {
        width: 30px;
        appearance: none;
        outline: none;
        background-color: transparent;
        color: white;
        cursor: pointer;
        text-align: center;
        font-family: var(--font-stack);
        font-size: var(--font-size);
        font-weight: var(--font-weight);
      }
      .filterTypeSelect.bypassed {
        color: #7d7d7d;
      }
      .chip.disabled .filterTypeSelect {
        pointer-events: all;
      }
      .frequencyInput {
        width: 28px;
      }
      .gainInput {
        width: 26px;
      }
      .qInput {
        width: 30px;
      }
      .numberInput {
        appearance: none;
        outline: none;
        background-color: transparent;
        color: white;
        text-align: right;
        -moz-appearance: textfield;
        font-family: var(--font-stack);
        font-size: var(--font-size);
        font-weight: var(--font-weight);
        touch-action: none;
      }
      .numberInput:disabled,
      .disabled {
        color: #7d7d7d;
        pointer-events: none;
      }
      .bypassed {
        color: #7d7d7d;
      }
      .numberInput::-webkit-inner-spin-button,
      .numberInput::-webkit-outer-spin-button {
        -webkit-appearance: none !important;
        margin: 0 !important;
      }
    `
  ];
})(), N);
u([
  x({ attribute: !1 })
], b.prototype, "runtime", void 0);
u([
  x()
], b.prototype, "index", void 0);
u([
  x()
], b.prototype, "x", void 0);
u([
  x()
], b.prototype, "y", void 0);
u([
  m()
], b.prototype, "frequencyInputFocused", void 0);
u([
  m()
], b.prototype, "dragStates", void 0);
u([
  m()
], b.prototype, "posOnDragStart", void 0);
b = u([
  T("weq8-ui-filter-hud")
], b);
var p, y;
let c = p = (y = class extends Q {
  constructor() {
    super(), this.view = "allBands", this.gridXs = [], this.dragStates = {}, this.selectedFilterIdx = -1, this.addEventListener("click", (e) => {
      e.composedPath()[0] === this && (this.selectedFilterIdx = -1);
    });
  }
  updated(e) {
    var t, i;
    if (e.has("runtime") && ((t = this.analyser) == null || t.dispose(), (i = this.frequencyResponse) == null || i.dispose(), this.runtime && this.analyserCanvas && this.frequencyResponseCanvas)) {
      this.analyser = new X(this.runtime, this.analyserCanvas), this.analyser.analyse(), this.frequencyResponse = new L(this.runtime, this.frequencyResponseCanvas), this.frequencyResponse.render();
      let r = [], n = this.runtime.audioCtx.sampleRate / 2, l = Math.floor(Math.log10(n));
      for (let a = 0; a < l; a++) {
        let o = Math.pow(10, a + 1);
        for (let s = 1; s < 10; s++) {
          let h = o * s;
          if (h > n)
            break;
          r.push((Math.log10(h) - 1) / (Math.log10(n) - 1) * 100);
        }
      }
      this.gridXs = r, this.runtime.on("filtersChanged", () => {
        var a, o, s;
        (a = this.frequencyResponse) == null || a.render(), this.requestUpdate();
        for (let h of Array.from((s = (o = this.shadowRoot) == null ? void 0 : o.querySelectorAll("weq8-ui-filter-row")) != null ? s : []))
          h.requestUpdate();
      });
    }
    e.has("view") && this.requestUpdate();
  }
  render() {
    var e;
    return f`
      ${this.view === "allBands" ? this.renderTable() : null}
      <div class="visualisation">
        <svg
          viewBox="0 0 100 10"
          preserveAspectRatio="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          ${this.gridXs.map(this.renderGridX)}
          ${[18, 9, 0, -9, -18].map(this.renderGridY)}
        </svg>
        <canvas class="analyser"></canvas>
        <canvas
          class="frequencyResponse"
          @click=${() => this.selectedFilterIdx = -1}
        ></canvas>
        ${(e = this.runtime) == null ? void 0 : e.spec.map((t, i) => t.type === "noop" ? void 0 : this.renderFilterHandle(t, i))}
        ${this.view === "hud" && this.selectedFilterIdx !== -1 ? this.renderFilterHUD() : null}
      </div>
    `;
  }
  renderTable() {
    return f` <table class="filters">
      <thead>
        <tr>
          <th class="headerFilter">Filter</th>
          <th>Freq</th>
          <th>Gain</th>
          <th>Q</th>
        </tr>
      </thead>
      <tbody>
        ${Array.from({ length: 8 }).map((e, t) => f`<weq8-ui-filter-row
              class="${d({ selected: this.selectedFilterIdx === t })}"
              .runtime=${this.runtime}
              .index=${t}
              @select=${(i) => {
      var r;
      this.selectedFilterIdx = ((r = this.runtime) == null ? void 0 : r.spec[t].type) === "noop" ? -1 : t, i.stopPropagation();
    }}
            />`)}
      </tbody>
    </table>`;
  }
  renderFilterHUD() {
    var r;
    if (!this.runtime)
      return f``;
    let e = (r = this.runtime) == null ? void 0 : r.spec[this.selectedFilterIdx], [t, i] = this.getFilterPositionInVisualisation(e);
    return f`<weq8-ui-filter-hud
      .runtime=${this.runtime}
      .index=${this.selectedFilterIdx}
      .x=${t}
      .y=${i}
    />`;
  }
  renderGridX(e) {
    return V`<line
      class="grid-x"
      x1=${e}
      y1="0"
      x2=${e}
      y2="10"
    />`;
  }
  renderGridY(e) {
    let i = (e - p.GAIN_MIN) / p.GAIN_RANGE * 10;
    return V`<line
      class="grid-y"
      x1="0"
      y1=${i}
      x2="100"
      y2=${i}
    />`;
  }
  renderFilterHandle(e, t) {
    if (!this.runtime)
      return;
    let [i, r] = this.getFilterPositionInVisualisation(e);
    return f`<div
      class="filter-handle-positioner"
      style="transform: translate(${i}px,${r}px)"
      @pointerdown=${(n) => this.startDraggingFilterHandle(n, t)}
      @pointerup=${(n) => this.stopDraggingFilterHandle(n, t)}
      @pointermove=${(n) => this.dragFilterHandle(n, t)}
      @contextmenu=${(n) => n.preventDefault()}
    >
      <div
        class="${d({
      "filter-handle": !0,
      bypassed: e.bypass,
      selected: t === this.selectedFilterIdx
    })}"
      >
        ${t + 1}
      </div>
    </div>`;
  }
  getFilterPositionInVisualisation(e) {
    var l, a, o, s;
    if (!this.runtime)
      return [0, 0];
    let t = (a = (l = this.analyserCanvas) == null ? void 0 : l.offsetWidth) != null ? a : 0, i = (s = (o = this.analyserCanvas) == null ? void 0 : o.offsetHeight) != null ? s : 0, r = w(e.frequency, 10, this.runtime.audioCtx.sampleRate / 2) * t, n = i - (e.gain - p.GAIN_MIN) / p.GAIN_RANGE * i;
    return $(e.type) || (n = i - w(e.Q, 0.1, 18) * i), [r, n];
  }
  startDraggingFilterHandle(e, t) {
    if (!this.runtime)
      return;
    if (e.button === 2) {
      e.preventDefault();
      const a = p.RESET_DEFAULTS[t];
      a && (this.runtime.setFilterFrequency(t, a.frequency), this.runtime.setFilterGain(t, a.gain), this.runtime.setFilterQ(t, a.Q)), this.selectedFilterIdx = t;
      return;
    }
    const i = this.runtime.spec[t].type, n = e.button === p.MIDDLE_MOUSE_BUTTON && k(i) ? "qHorizontal" : "frequencyGain";
    (e.currentTarget || e.target).setPointerCapture(e.pointerId), this.dragStates = {
      ...this.dragStates,
      [t]: {
        pointerId: e.pointerId,
        pointerButton: e.button,
        mode: n,
        startX: e.clientX,
        startY: e.clientY,
        startQ: this.runtime.spec[t].Q,
        moved: !1
      }
    }, this.selectedFilterIdx = t, e.preventDefault();
  }
  stopDraggingFilterHandle(e, t) {
    const i = this.dragStates[t];
    (i == null ? void 0 : i.pointerId) === e.pointerId && ((e.currentTarget || e.target).releasePointerCapture(e.pointerId), this.dragStates = { ...this.dragStates, [t]: null });
  }
  dragFilterHandle(e, t) {
    var r, n;
    const i = this.dragStates[t];
    if (this.runtime && (i == null ? void 0 : i.pointerId) === e.pointerId) {
      (Math.abs(e.clientX - i.startX) > 3 || Math.abs(e.clientY - i.startY) > 3) && (this.dragStates = {
        ...this.dragStates,
        [t]: { ...i, moved: !0 }
      });
      let l = this.runtime.spec[t].type, a = (n = (r = this.frequencyResponseCanvas) == null ? void 0 : r.getBoundingClientRect()) != null ? n : {
        left: 0,
        top: 0,
        width: 0,
        height: 0
      };
      if (i.mode === "qHorizontal") {
        if (!k(l))
          return;
        let R = w(i.startQ, 0.1, 18), Y = e.clientX - i.startX, O = F(v(R + Y / Math.max(1, a.width), 0, 1), 0.1, 18);
        this.runtime.setFilterQ(t, O);
        return;
      }
      let o = e.clientX - a.left, s = e.clientY - a.top, h = F(o / a.width, 10, this.runtime.audioCtx.sampleRate / 2);
      this.runtime.setFilterFrequency(t, h);
      let g = 1 - s / a.height;
      if ($(l)) {
        let R = v(g * p.GAIN_RANGE + p.GAIN_MIN, p.GAIN_MIN, p.GAIN_MAX);
        this.runtime.setFilterGain(t, R);
      } else {
        let R = F(g, 0.1, 18);
        this.runtime.setFilterQ(t, R);
      }
    }
  }
}, (() => {
  y.MIDDLE_MOUSE_BUTTON = 1;
})(), (() => {
  y.GAIN_MIN = -18;
})(), (() => {
  y.GAIN_MAX = 18;
})(), (() => {
  y.GAIN_RANGE = 36;
})(), (() => {
  y.RESET_DEFAULTS = H.map((e) => ({
    frequency: e.frequency,
    gain: e.gain,
    Q: e.Q
  }));
})(), (() => {
  y.styles = [
    C,
    A`
      :host {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        gap: 10px;
        min-width: 600px;
        min-height: 200px;
        padding: 20px;
        border-radius: 8px;
        overflow: visible;
        background: #202020;
        border: 1px solid #373737;
      }
      .filters {
        display: inline-grid;
        grid-auto-flow: row;
        gap: 4px;
      }
      .filters tbody,
      .filters tr {
        display: contents;
      }
      .filters thead {
        display: grid;
        grid-auto-flow: column;
        grid-template-columns: 60px 60px 50px 40px;
        align-items: center;
        gap: 4px;
      }
      .filters thead th {
        display: grid;
        place-content: center;
        height: 20px;
        border-radius: 10px;
        font-weight: var(--font-weight);
        border: 1px solid #373737;
      }
      .filters thead th.headerFilter {
        text-align: left;
        padding-left: 18px;
        border: none;
      }
      .visualisation {
        flex: 1;
        position: relative;
        border: 1px solid #373737;
      }
      canvas,
      svg {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }
      svg {
        overflow: visible;
      }
      .grid-x,
      .grid-y {
        stroke: #333;
        stroke-width: 1;
        vector-effect: non-scaling-stroke;
      }
      .filter-handle-positioner {
        position: absolute;
        top: 0;
        left: 0;
        width: 30px;
        height: 30px;
        touch-action: none;
      }
      .filter-handle {
        position: absolute;
        top: 0;
        left: 0;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background-color: #fff;
        color: black;
        transform: translate(-50%, -50%);
        display: flex;
        justify-content: center;
        align-items: center;
        user-select: none;
        cursor: grab;
        transition: background-color 0.15s ease;
      }
      .filter-handle.selected {
        background: #ffcc00;
      }
      .filter-handle.bypassed {
        background: #7d7d7d;
      }
    `
  ];
})(), y);
u([
  x({ attribute: !1 })
], c.prototype, "runtime", void 0);
u([
  x()
], c.prototype, "view", void 0);
u([
  m()
], c.prototype, "analyser", void 0);
u([
  m()
], c.prototype, "frequencyResponse", void 0);
u([
  m()
], c.prototype, "gridXs", void 0);
u([
  m()
], c.prototype, "dragStates", void 0);
u([
  m()
], c.prototype, "selectedFilterIdx", void 0);
u([
  G(".analyser")
], c.prototype, "analyserCanvas", void 0);
u([
  G(".frequencyResponse")
], c.prototype, "frequencyResponseCanvas", void 0);
c = p = u([
  T("weq8-ui")
], c);
export {
  c as WEQ8UIElement
};
