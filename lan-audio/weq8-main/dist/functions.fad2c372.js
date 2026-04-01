const c = [
  "lowpass12",
  "lowpass24",
  "highpass12",
  "highpass24",
  "bandpass12",
  "bandpass24",
  "lowshelf12",
  "lowshelf24",
  "highshelf12",
  "highshelf24",
  "peaking12",
  "peaking24",
  "notch12",
  "notch24"
], t = [
  { type: "lowshelf12", frequency: 63, gain: 0, Q: 0.7, bypass: !1 },
  { type: "peaking12", frequency: 136, gain: 0, Q: 0.7, bypass: !1 },
  { type: "peaking12", frequency: 294, gain: 0, Q: 0.7, bypass: !1 },
  { type: "peaking12", frequency: 632, gain: 0, Q: 0.7, bypass: !1 },
  { type: "peaking12", frequency: 1363, gain: 0, Q: 0.7, bypass: !1 },
  { type: "peaking12", frequency: 2936, gain: 0, Q: 0.7, bypass: !1 },
  { type: "highshelf12", frequency: 6324, gain: 0, Q: 0.7, bypass: !1 },
  { type: "noop", frequency: 350, gain: 0, Q: 1, bypass: !1 }
];
function l(s) {
  return s === "lowshelf12" || s === "lowshelf24" || s === "highshelf12" || s === "highshelf24" || s === "peaking12" || s === "peaking24";
}
function o(s) {
  return s !== "noop";
}
function r(s) {
  return s === "lowpass12" || s === "lowpass24" || s === "highpass12" || s === "highpass24" || s === "bandpass12" || s === "bandpass24" || s === "peaking12" || s === "peaking24" || s === "notch12" || s === "notch24";
}
function g(s) {
  switch (s) {
    case "lowpass12":
    case "lowpass24":
      return "lowpass";
    case "highpass12":
    case "highpass24":
      return "highpass";
    case "bandpass12":
    case "bandpass24":
      return "bandpass";
    case "lowshelf12":
    case "lowshelf24":
      return "lowshelf";
    case "highshelf12":
    case "highshelf24":
      return "highshelf";
    case "peaking12":
    case "peaking24":
      return "peaking";
    case "notch12":
    case "notch24":
      return "notch";
  }
}
function f(s) {
  switch (s) {
    case "noop":
      return 0;
    case "lowpass12":
    case "highpass12":
    case "bandpass12":
    case "lowshelf12":
    case "highshelf12":
    case "peaking12":
    case "notch12":
      return 1;
    case "lowpass24":
    case "highpass24":
    case "bandpass24":
    case "lowshelf24":
    case "highshelf24":
    case "peaking24":
    case "notch24":
      return 2;
  }
}
function p(s, a, e) {
  let n = Math.log10(a), h = Math.log10(e);
  return (Math.log10(i(s, a, e)) - n) / (h - n);
}
function u(s, a, e) {
  let n = Math.log10(a), h = Math.log10(e);
  return i(Math.pow(10, s * (h - n) + n), a, e);
}
function i(s, a, e) {
  return Math.min(Math.max(s, a), e);
}
function w(s, a = !1) {
  return s >= 1e3 && !a ? (s / 1e3).toFixed(2) : s.toFixed(0);
}
function b(s, a = !1) {
  return s >= 1e3 && !a ? "kHz" : "Hz";
}
export {
  t as D,
  c as F,
  f as a,
  w as b,
  i as c,
  b as d,
  l as e,
  o as f,
  g,
  r as h,
  u as i,
  p as t
};
