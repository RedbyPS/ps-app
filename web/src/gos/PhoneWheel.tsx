// The wheel menu on the phone (PS 1.67), bottom left on every page and screen. It replaces the hamburger at the top left
// (Settings, This phone, Wheel menu brings the hamburger back). How it goes:
// - A quick tap shows "Please hold" by the button with a small wobble, nothing else.
// - Hold: a glowing path draws from the button to the middle of the screen and a light runs along it under the finger.
// - At the middle every item fans out round the finger in two rings (the most used inside, the rest outside), on a staggered
//   spring. Nudge towards one: it grows and glows, the phone ticks, and its name and one line show by the finger (above, to
//   the left or below, never to the right, never under the finger, never off screen).
// - Let go on an item: it launches full screen out of its spot (gos/launch.ts). Let go on nothing: the wheel folds away.
// Smooth: React draws the wheel once when it opens; the finger only moves transforms and toggles classes, once per frame.
// Pure parts (items, rings, picking, the label's place, the path) are in gos/wheel.ts.
import { useEffect, useRef, useState } from "react";
import { haptic } from "./bridge";
import { WHEEL_WORDS, HOLD_MS, START_MOVE, arrived, along, labelSpot, middleOf, pathD, pathPts, pickSlot, wheelGeo, type Pt, type Vp, type WheelGeo, type WheelId, type WheelItem } from "./wheel";
import "./wheel.css";

type Phase = "idle" | "path" | "open" | "closing";
const SETTLE_MS = 160;

/** The bars the shell keeps clear (status bar, home indicator), read once per hold from the page's own variables. */
function viewport(): Vp {
  const probe = document.createElement("div");
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:var(--sat, 0px);padding-bottom:var(--gos-bottom, 0px)";
  document.body.appendChild(probe);
  const top = probe.offsetHeight - (parseFloat(getComputedStyle(probe).paddingBottom) || 0);
  const bottom = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
  probe.remove();
  return { w: window.innerWidth || 390, h: window.innerHeight || 800, top: Math.max(0, top), bottom: Math.max(0, bottom) };
}

const sv = { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export function PhoneWheel({ items, live, onLaunch }: {
  /** The items for this person right now (read as the hold starts). */
  items: () => WheelItem[];
  /** Live lines (today's screen time, Do Not Disturb on or off...), read as the wheel opens. */
  live: () => Partial<Record<WheelId, string>>;
  /** Launch an item from the spot it sat on. */
  onLaunch: (id: WheelId, at: Pt, size: number) => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [hint, setHint] = useState(0);
  const [list, setList] = useState<WheelItem[]>([]);
  const [geo, setGeo] = useState<WheelGeo | null>(null);
  const [lines, setLines] = useState<Partial<Record<WheelId, string>>>({});
  const [route, setRoute] = useState<{ d: string; to: Pt; from: Pt } | null>(null);
  const [picked, setPicked] = useState<WheelId | null>(null);   // the item launched, for its flash as the wheel leaves
  const btn = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const prog = useRef<SVGPathElement>(null);
  const orb = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const g = useRef({
    id: -1, phase: "idle" as Phase, timer: 0, raf: 0, start: { x: 0, y: 0 }, at: { x: 0, y: 0 }, vp: null as Vp | null,
    pts: [] as Pt[], geo: null as WheelGeo | null, sel: null as WheelId | null, labelFor: null as WheelId | null, lsize: { w: 220, h: 54 },
    list: [] as WheelItem[], lines: {} as Partial<Record<WheelId, string>>, openedAt: 0,
  });
  const go = (p: Phase) => { g.current.phase = p; setPhase(p); };

  // The quick tap's hint leaves by itself.
  useEffect(() => {
    if (!hint) return;
    const t = window.setTimeout(() => setHint(0), 1400);
    return () => window.clearTimeout(t);
  }, [hint]);
  // Closing: folds away, then nothing is drawn.
  useEffect(() => {
    if (phase !== "closing") return;
    const t = window.setTimeout(() => { if (g.current.phase === "closing") { go("idle"); setGeo(null); setRoute(null); setPicked(null); } }, 320);
    return () => window.clearTimeout(t);
  }, [phase]);
  useEffect(() => () => { window.clearTimeout(g.current.timer); cancelAnimationFrame(g.current.raf); }, []);
  // Back or Esc while the wheel is up folds it away (the finger is usually still down, so this is rare).
  useEffect(() => {
    if (phase === "idle" || phase === "closing") return;
    const back = (e: Event) => { e.preventDefault(); fold(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fold(); } };
    window.addEventListener("gos-back", back);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("gos-back", back); window.removeEventListener("keydown", key, true); };
  }, [phase]);

  const fold = () => { window.clearTimeout(g.current.timer); g.current.sel = null; if (g.current.phase !== "idle") go("closing"); };

  // Hold reached: the path from the button to the middle.
  const startPath = () => {
    const c = g.current;
    if (c.phase !== "idle") return;
    const r = btn.current?.getBoundingClientRect();
    const vp = viewport();
    const from = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : c.start;
    const to = middleOf(vp);
    c.vp = vp; c.pts = pathPts(from, to);
    c.list = items();
    setList(c.list);
    setRoute({ d: pathD(from, to), to, from });
    setHint(0);
    haptic("press");
    go("path");
  };
  // The finger reached the middle: the wheel fans out round it.
  const open = (p: Pt) => {
    const c = g.current;
    if (!c.vp || !c.list.length) return;
    c.geo = wheelGeo(c.list, p, c.vp);
    c.lines = live();
    c.sel = null; c.labelFor = null; c.openedAt = performance.now();
    setGeo(c.geo); setLines(c.lines);
    haptic("drop");
    go("open");
  };

  // Once per frame: move what follows the finger.
  const frame = () => {
    const c = g.current;
    c.raf = 0;
    const p = c.at;
    if (c.phase === "path") {
      const a = along(c.pts, p);
      const i = Math.round(a.t * (c.pts.length - 1)), q = c.pts[i];
      if (prog.current) prog.current.style.strokeDashoffset = String(1 - a.t);
      if (orb.current) orb.current.style.transform = `translate3d(${q.x}px, ${q.y}px, 0)`;
      if (arrived(c.pts, p)) open(p);
      return;
    }
    if (c.phase !== "open" || !c.geo) return;
    // The finger is still travelling as the wheel opens: nothing is picked in the first moment, so it never grabs an item by itself.
    const id = performance.now() - c.openedAt < SETTLE_MS ? null : pickSlot(c.geo, p);
    const el = root.current;
    if (id !== c.sel) {
      el?.querySelector(`.gos-wh-it[data-id="${c.sel}"]`)?.classList.remove("on");
      if (id) { el?.querySelector(`.gos-wh-it[data-id="${id}"]`)?.classList.add("on"); haptic("tick"); }
      el?.classList.toggle("has-pick", !!id);
      c.sel = id;
    }
    const lb = label.current;
    if (!lb) return;
    if (!id) { lb.classList.remove("show"); return; }
    if (c.labelFor !== id) {
      const it = c.list.find((x) => x.id === id);
      const t = lb.querySelector(".gos-wh-lt"), l = lb.querySelector(".gos-wh-ll"), s = lb.querySelector(".gos-wh-ls");
      if (t) t.textContent = it?.label ?? "";
      if (l) l.textContent = c.lines[id] || it?.line || "";
      if (s) s.textContent = it?.section ?? "";
      c.lsize = { w: lb.offsetWidth || 220, h: lb.offsetHeight || 54 };   // one layout read per new item, not per frame
      c.labelFor = id;
    }
    const slot = c.geo.slots.find((x) => x.id === id);
    const avoid = slot ? { x: slot.x - slot.size * 0.7, y: slot.y - slot.size * 0.7, w: slot.size * 1.4, h: slot.size * 1.4 } : null;
    const spot = labelSpot(p, c.lsize, c.vp!, avoid);
    lb.style.transform = `translate3d(${spot.x}px, ${spot.y}px, 0)`;
    lb.dataset.side = spot.side;
    lb.classList.add("show");
  };
  const ask = () => { if (!g.current.raf) g.current.raf = requestAnimationFrame(frame); };

  const down = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    const c = g.current;
    if (c.phase === "closing") { go("idle"); setGeo(null); setRoute(null); setPicked(null); }
    if (c.phase !== "idle" && c.phase !== "closing") return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* an old WebView */ }
    c.id = e.pointerId; c.start = { x: e.clientX, y: e.clientY }; c.at = c.start;
    window.clearTimeout(c.timer);
    c.timer = window.setTimeout(startPath, HOLD_MS);
  };
  const move = (e: React.PointerEvent<HTMLButtonElement>) => {
    const c = g.current;
    if (e.pointerId !== c.id) return;
    c.at = { x: e.clientX, y: e.clientY };
    if (c.phase === "idle" && c.timer && Math.hypot(c.at.x - c.start.x, c.at.y - c.start.y) > START_MOVE) { window.clearTimeout(c.timer); c.timer = 0; startPath(); }
    if (c.phase === "path" || c.phase === "open") ask();
  };
  const up = (e: React.PointerEvent<HTMLButtonElement>) => {
    const c = g.current;
    if (e.pointerId !== c.id) return;
    c.id = -1;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (c.phase === "idle") {
      if (c.timer) { window.clearTimeout(c.timer); c.timer = 0; setHint(Date.now()); haptic("reject"); }   // a quick tap
      return;
    }
    if (c.phase === "open" && c.geo) {
      frame();   // the last move counts
      const id = c.sel, slot = c.geo.slots.find((x) => x.id === id);
      if (id && slot) {
        setPicked(id);
        go("closing");
        haptic("press");
        onLaunch(id, { x: slot.x, y: slot.y }, slot.size);
        return;
      }
    }
    fold();
  };
  const cancel = (e: React.PointerEvent<HTMLButtonElement>) => { if (e.pointerId === g.current.id) { g.current.id = -1; fold(); } };

  const drawn = phase !== "idle";
  return (
    <>
      <button ref={btn} type="button" className={`gos-wheel-btn${drawn ? " held" : ""}${hint ? " nudge" : ""}`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} onLostPointerCapture={cancel}
        onContextMenu={(e) => e.preventDefault()} aria-label={WHEEL_WORDS.button} title={WHEEL_WORDS.hold}>
        <span className="gos-wheel-ic" key={hint}>
          <svg {...sv} width={26} height={26} strokeWidth={2.1}>
            <circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2.6" />
            <path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" />
          </svg>
        </span>
      </button>
      {hint > 0 && <div className="gos-wheel-hint" role="status" key={hint}>{WHEEL_WORDS.hint}</div>}
      {drawn && (
        <div ref={root} className={`gos-wheel p-${phase}${picked ? " launched" : ""}`} aria-hidden="true">
          <div className="gos-wh-dim" />
          {route && (
            <svg className="gos-wh-path" width="100%" height="100%">
              <defs>
                <linearGradient id="gos-wh-grad" gradientUnits="userSpaceOnUse" x1={route.from.x} y1={route.from.y} x2={route.to.x} y2={route.to.y}>
                  <stop offset="0" stopColor="var(--k-acc2, #8B5CF6)" /><stop offset="1" stopColor="var(--k-acc, #EC4E86)" />
                </linearGradient>
              </defs>
              <path className="gos-wh-glow" d={route.d} pathLength={1} />
              <path className="gos-wh-guide" d={route.d} pathLength={1} />
              <path ref={prog} className="gos-wh-prog" d={route.d} pathLength={1} />
            </svg>
          )}
          {route && phase === "path" && <div className="gos-wh-goal" style={{ transform: `translate3d(${route.to.x}px, ${route.to.y}px, 0)` }}><i /></div>}
          {phase === "path" && route && <div ref={orb} className="gos-wh-orb" style={{ transform: `translate3d(${route.from.x}px, ${route.from.y}px, 0)` }} />}
          {geo && (
            <div className="gos-wh-ring" style={{ ["--cx" as string]: `${geo.cx}px`, ["--cy" as string]: `${geo.cy}px`, ["--ri" as string]: `${geo.rIn}px`, ["--ro" as string]: `${geo.rOut}px` }}>
              <div className="gos-wh-halo" />
              {geo.rOut > 0 && <div className="gos-wh-track o" />}
              <div className="gos-wh-track i" />
              <div className="gos-wh-hub" />
              {geo.slots.map((s, i) => {
                const it = list.find((x) => x.id === s.id);
                if (!it) return null;
                const k = s.ring === 0 ? i : i + 2;   // the outer ring starts a beat later
                return (
                  <div key={s.id} className={`gos-wh-it r${s.ring}${picked === s.id ? " go" : ""}`} data-id={s.id} data-sec={it.section}
                    style={{ ["--x" as string]: `${s.x - geo.cx}px`, ["--y" as string]: `${s.y - geo.cy}px`, ["--a" as string]: `${s.ang}deg`, ["--s" as string]: `${s.size}px`, ["--k" as string]: k }}>
                    <span className="gos-wh-b">
                      {it.id === "rules" ? <span className="gos-dock-rb">PS</span> : <svg {...sv} width={Math.round(s.size * 0.44)} height={Math.round(s.size * 0.44)}><path d={it.icon} /></svg>}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          <div ref={label} className="gos-wh-label">
            <span className="gos-wh-ls" /><b className="gos-wh-lt" /><span className="gos-wh-ll" />
          </div>
        </div>
      )}
    </>
  );
}
