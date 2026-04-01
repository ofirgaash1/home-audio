import { D as p, F as u, g as c, a as o } from "./functions.fad2c372.js";
let g = () => ({
  events: {},
  emit(l, ...e) {
    let t = this.events[l] || [];
    for (let i = 0, n = t.length; i < n; i++)
      t[i](...e);
  },
  on(l, e) {
    var t;
    return (t = this.events[l]) != null && t.push(e) || (this.events[l] = [e]), () => {
      var i;
      this.events[l] = (i = this.events[l]) == null ? void 0 : i.filter((n) => e !== n);
    };
  }
});
class y {
  constructor(e, t = p, i = u) {
    this.audioCtx = e, this.spec = t, this.supportedFilterTypes = i, this.filterbank = [], this.input = e.createGain(), this.output = e.createGain(), this.buildFilterChain(t), this.emitter = g();
  }
  connect(e) {
    this.output.connect(e);
  }
  disconnect(e) {
    this.output.disconnect(e);
  }
  on(e, t) {
    return this.emitter.on(e, t);
  }
  setFilterType(e, t) {
    var i;
    if (t === "noop" && this.spec[e].type !== "noop" && !this.spec[e].bypass ? this.disconnectFilter(e) : t !== "noop" && this.spec[e].type === "noop" && !this.spec[e].bypass && this.connectFilter(e, t), this.spec[e].type = t, t !== "noop" && !this.spec[e].bypass) {
      let n = (i = this.filterbank.find((s) => s.idx === e)) == null ? void 0 : i.filters;
      if (!n)
        throw new Error("Assertion failed: No filters in filterbank");
      for (let s of n)
        s.type = c(t);
      let r = o(t);
      for (; n.length > r; ) {
        let s = n.length - 1, h = n[s], f = n[s - 1], a = this.getNextInChain(e);
        h.disconnect(), f.disconnect(h), f.connect(a), n.splice(s, 1);
      }
      for (; n.length < r; ) {
        let s = this.audioCtx.createBiquadFilter();
        s.type = c(t), s.frequency.value = this.spec[e].frequency, s.Q.value = this.spec[e].Q, s.gain.value = this.spec[e].gain;
        let h = n[n.length - 1], f = this.getNextInChain(e);
        h.disconnect(f), h.connect(s), s.connect(f), n.push(s);
      }
    }
    this.emitter.emit("filtersChanged", this.spec);
  }
  toggleBypass(e, t) {
    t && !this.spec[e].bypass && this.spec[e].type !== "noop" ? this.disconnectFilter(e) : !t && this.spec[e].bypass && this.spec[e].type !== "noop" && this.connectFilter(e, this.spec[e].type), this.spec[e].bypass = t, this.emitter.emit("filtersChanged", this.spec);
  }
  disconnectFilter(e) {
    var r;
    let t = (r = this.filterbank.find((s) => s.idx === e)) == null ? void 0 : r.filters;
    if (!t)
      throw new Error("Assertion failed: No filters in filterbank when disconnecting filter. Was it connected?");
    let i = this.getPreviousInChain(e), n = this.getNextInChain(e);
    i.disconnect(t[0]), t[t.length - 1].disconnect(n), i.connect(n), this.filterbank = this.filterbank.filter((s) => s.idx !== e);
  }
  connectFilter(e, t) {
    let i = Array.from({ length: o(t) }, () => {
      let s = this.audioCtx.createBiquadFilter();
      return s.type = c(t), s.frequency.value = this.spec[e].frequency, s.Q.value = this.spec[e].Q, s.gain.value = this.spec[e].gain, s;
    }), n = this.getPreviousInChain(e), r = this.getNextInChain(e);
    n.disconnect(r), n.connect(i[0]);
    for (let s = 0; s < i.length - 1; s++)
      i[s].connect(i[s + 1]);
    i[i.length - 1].connect(r), this.filterbank.push({ idx: e, filters: i });
  }
  setFilterFrequency(e, t) {
    this.spec[e].frequency = t;
    let i = this.filterbank.find((n) => n.idx === e);
    if (i)
      for (let n of i.filters)
        n.frequency.value = t;
    this.emitter.emit("filtersChanged", this.spec);
  }
  setFilterQ(e, t) {
    this.spec[e].Q = t;
    let i = this.filterbank.find((n) => n.idx === e);
    if (i)
      for (let n of i.filters)
        n.Q.value = t;
    this.emitter.emit("filtersChanged", this.spec);
  }
  setFilterGain(e, t) {
    this.spec[e].gain = t;
    let i = this.filterbank.find((n) => n.idx === e);
    if (i)
      for (let n of i.filters)
        n.gain.value = t;
    this.emitter.emit("filtersChanged", this.spec);
  }
  getFrequencyResponse(e, t, i, n, r) {
    let s = this.filterbank.find((h) => h.idx === e);
    return s ? (s.filters[t].getFrequencyResponse(i, n, r), !0) : !1;
  }
  buildFilterChain(e) {
    this.filterbank = [];
    for (let t = 0; t < e.length; t++) {
      let i = e[t];
      if (i.type === "noop" || i.bypass)
        continue;
      let n = Array.from({ length: o(i.type) }, () => {
        let r = this.audioCtx.createBiquadFilter();
        return r.type = c(i.type), r.frequency.value = i.frequency, r.Q.value = i.Q, r.gain.value = i.gain, r;
      });
      this.filterbank.push({ idx: t, filters: n });
    }
    if (this.filterbank.length === 0)
      this.input.connect(this.output);
    else
      for (let t = 0; t < this.filterbank.length; t++) {
        let { filters: i } = this.filterbank[t];
        t === 0 ? this.input.connect(i[0]) : this.filterbank[t - 1].filters[this.filterbank[t - 1].filters.length - 1].connect(i[0]);
        for (let n = 0; n < i.length - 1; n++)
          i[n].connect(i[n + 1]);
        t === this.filterbank.length - 1 && i[i.length - 1].connect(this.output);
      }
  }
  getPreviousInChain(e) {
    let t = this.input, i = -1;
    for (let n of this.filterbank)
      n.idx < e && n.idx > i && (t = n.filters[n.filters.length - 1], i = n.idx);
    return t;
  }
  getNextInChain(e) {
    let t = this.output, i = this.spec.length;
    for (let n of this.filterbank)
      n.idx > e && n.idx < i && (t = n.filters[0], i = n.idx);
    return t;
  }
}
export {
  y as WEQ8Runtime
};
