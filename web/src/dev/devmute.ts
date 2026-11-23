// Dev only (PS 1.77 build chat, 23 Nov 2026): the dev server with ?mute in the address, or started with VITE_PS_MUTE=1, makes no
// sound at all, so a browser check on the developer's Mac never plays the Tab list's ticks or anything else (his rule: no audio
// while he works). Imported first by main.tsx, so it runs before any other code. In a real build import.meta.env.DEV is false
// and this is dropped.
if (import.meta.env.DEV && (import.meta.env.VITE_PS_MUTE === "1" || /[?&]mute(=|&|$)/.test(location.search))) {
  // One silent stand-in for every Web Audio object: any property is a number 0 or a function that returns the stand-in again,
  // so chains like o.connect(g).connect(a.destination) and g.gain.setValueAtTime(...) all work and nothing ever sounds.
  const silent: unknown = new Proxy(function () {}, {
    get: (_t, k) => (k === "state" ? "suspended" : k === "then" ? undefined : k === Symbol.toPrimitive ? () => 0
      : k === "currentTime" || k === "value" || k === "sampleRate" || k === "length" || k === "duration" ? 0
      : k === "resume" || k === "suspend" || k === "close" || k === "decodeAudioData" ? () => Promise.resolve(silent)
      : k === "getChannelData" ? () => new Float32Array(1) : silent),
    set: () => true,
    apply: () => silent,
    construct: () => silent as object,
  });
  const w = window as unknown as Record<string, unknown>;
  w.AudioContext = silent; w.webkitAudioContext = silent; w.OfflineAudioContext = silent; w.__psMuted = true;
  HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) { this.muted = true; this.volume = 0; return Promise.resolve(); };
  try { Object.defineProperty(window, "speechSynthesis", { value: silent, configurable: true }); } catch { /* left as it is */ }
}
export {};
