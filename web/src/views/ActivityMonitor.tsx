// Activity monitor (PS 1.65, the developer's request of 17 Nov 2026): what this Mac is doing right now. A chart button next to
// Network in the Tab list opens it with a CLICK (never on hover). It bursts out of the island: the island squeezes, the window
// unfolds from the island's black shape with a glowing frame while the graphs draw themselves in, and it folds back into the
// island when it closes (Esc, the minimize button, or a click outside). While it is open the island shows a tiny CPU and memory
// readout (mac/Sources/ActivityIsland.swift).
//
// The numbers come from PS on the Mac (mac/Sources/ActivityMonitor.swift) through the bridge, only while this window is open.
// Nothing here touches the vault (except the two view choices, saved with the settings), Supabase or any server. 1Password and
// Signal never appear: PS drops them at its first read, and core/activitymon.ts drops them again.
//
// Cost (the developer: "the animations must never make the Mac busy"): graphs slide by a transform on their own layer (no drawing
// between samples), rows glide by a transform, numbers ease for under half a second after each sample and then stop, heat
// shading only changes when a cell crosses a step. Nothing runs between samples. Reduce Motion turns the burst, the glides and
// the slides off. The rules live in core/activitymon.ts (tests/activitymon.test.ts); this file only draws.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { psPost, useAppIcons } from "../ps";
import { toneSfx } from "../ui/sfx";
import { morph, reduced } from "./DimensionX";
import { useVault } from "../ui/kit";
import { screenTimeDays } from "../core/select";
import {
  AM_SOUNDS, AM_WORDS, COLUMNS, burstFrames, DEFAULT_SORT, GRAPH_POINTS, PRESSURE_WORD, SPEEDS, applySnap, bytes, canEnd, cleanCols, cleanSpeed, duration, easeAt, END_WAIT_MS, endStep, endWords,
  graphPaths, heat, historyRows, holdOrder, islandBox, mem, nextSort, niceMax, pct, perfItems, pushPoint, rate, startupRows, tableLines, watts,
  type Col, type EndEvent, type EndState, type HistoryMsg, type Line, type MetaMap, type PerfId, type Proc, type Snap, type Sort, type Speed, type StartupItem,
} from "../core/activitymon";
import "./cstats.css";
import "./activitymonitor.css";
import { TopIcon } from "./topicons";

// ---------- what PS sends, kept outside React so the graphs keep their history across tabs ----------
type Series = { cpu: number[]; mem: number[]; dr: number[]; dw: number[]; gpu: number[]; bat: number[]; cores: number[][]; net: Record<string, { rx: number[]; tx: number[] }> };
type AmState = { snap: Snap | null; procs: Proc[]; known: MetaMap; series: Series; history: HistoryMsg | null; startup: { items: StartupItem[]; hidden: boolean } | null;
  ended: { pid: number; ok: boolean; alive: boolean; n: number } | null; place: unknown; placeN: number; hiddenN: number };
const emptySeries = (): Series => ({ cpu: [], mem: [], dr: [], dw: [], gpu: [], bat: [], cores: [], net: {} });
let am: AmState = { snap: null, procs: [], known: new Map(), series: emptySeries(), history: null, startup: null, ended: null, place: null, placeN: 0, hiddenN: 0 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
function reset() { am = { ...am, snap: null, procs: [], known: new Map(), series: emptySeries(), ended: null }; emit(); }
function apply(m: { kind?: string } & Record<string, unknown>) {
  if (m.kind === "snap") {
    const s = m as unknown as Snap;
    const { known, procs } = applySnap(am.known, s);
    const se = am.series, total = s.mem.total || 1;
    const net: Series["net"] = {};
    for (const i of s.net.ifs) net[i.n] = { rx: pushPoint(se.net[i.n]?.rx || [], i.rx), tx: pushPoint(se.net[i.n]?.tx || [], i.tx) };
    am = { ...am, snap: s, known, procs, series: {
      cpu: pushPoint(se.cpu, s.cpu.t), mem: pushPoint(se.mem, (s.mem.used / total) * 100), dr: pushPoint(se.dr, s.disk.r), dw: pushPoint(se.dw, s.disk.w),
      gpu: pushPoint(se.gpu, s.gpu.u ?? 0), bat: pushPoint(se.bat, s.bat?.watts ?? 0), cores: s.cpu.cores.map((c, i) => pushPoint(se.cores[i] || [], c)), net } };
  } else if (m.kind === "history") am = { ...am, history: m as unknown as HistoryMsg };
  else if (m.kind === "startup") am = { ...am, startup: { items: startupRows(m.items), hidden: m.hidden !== false } };
  else if (m.kind === "ended") am = { ...am, ended: { pid: Number(m.pid), ok: !!m.ok, alive: !!m.alive, n: (am.ended?.n || 0) + 1 } };
  else if (m.kind === "place") am = { ...am, place: m.place, placeN: am.placeN + 1 };
  else if (m.kind === "hidden") am = { ...am, hiddenN: am.hiddenN + 1 };   // the Tab list went away: PS stopped reading, the window closes
  else return;
  emit();
}
if (typeof window !== "undefined") (window as { __psActivity?: typeof apply }).__psActivity = apply;
function useAm() { return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => am); }
const ask = (op: string, extra: object = {}) => psPost({ type: "activity", op, ...extra });
const play = (k: keyof typeof AM_SOUNDS) => toneSfx(k, AM_SOUNDS[k]);

/** The dev page and the screenshots: hand the window made up numbers instead of PS (src/dev/activity-fake.ts). */
export const __amDev = { apply, reset };

type Tab = "procs" | "perf" | "history" | "startup";
const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: "procs", label: AM_WORDS.tabs.procs, icon: <path d="M4 6h16M4 12h16M4 18h10" /> },
  { id: "perf", label: AM_WORDS.tabs.perf, icon: <path d="M3 17l5-6 4 3 5-7 4 4" /> },
  { id: "history", label: AM_WORDS.tabs.history, icon: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></> },
  { id: "startup", label: AM_WORDS.tabs.startup, icon: <><path d="M12 3v8" /><path d="M7.5 6.2a7.5 7.5 0 1 0 9 0" /></> },
];
const MORPH = { body: ".cs-content", tint: ".am-morph" };
type Box = { left: number; top: number; width: number; height: number };
/** Out of the island and back in (core/activitymon.ts burstFrames): the black island shape stretches, a glowing frame lights up, the
 *  window unfolds and its content fades in as the graphs draw themselves. All by transform and opacity on the window's own layer. */
function burst(win: HTMLElement | null, isl: Box, dim: HTMLElement | null, dir: "in" | "out"): Promise<void> {
  if (!win) return Promise.resolve();
  win.getAnimations().forEach((a) => a.cancel());
  const p = win.getBoundingClientRect();
  const ms = dir === "in" ? 820 : 520, fill = dir === "out" ? "forwards" as const : "none" as const;
  win.style.transformOrigin = "0 0";
  dim?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dir === "in" ? 520 : 420, easing: "ease", fill, direction: dir === "out" ? "reverse" : "normal" });
  const a = win.animate(burstFrames(p, isl, dir), { duration: ms, easing: "linear", fill });
  const body = win.querySelector<HTMLElement>(".cs-content"), tint = win.querySelector<HTMLElement>(".am-morph"), frame = win.querySelector<HTMLElement>(".am-frame");
  if (dir === "in") {
    tint?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.34 }, { opacity: 0, offset: 0.7 }, { opacity: 0 }], { duration: ms });
    body?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.46 }, { opacity: 1 }], { duration: ms });
    frame?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0.95, offset: 0.62 }, { opacity: 0 }], { duration: ms + 380 });
  } else {
    body?.animate([{ opacity: 1 }, { opacity: 0, offset: 0.3 }, { opacity: 0 }], { duration: ms, fill });
    tint?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.55 }, { opacity: 1 }], { duration: ms, fill });
    frame?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0.4 }], { duration: ms, fill });
  }
  return a.finished.then(() => {}, () => {});
}

/** The chart button next to Network (a Slot, so Edit mode can move it). Click opens the monitor; it never opens on hover. */
export function ActivityButton({ speed, cols, save }: { speed?: number; cols?: string[]; save: (p: { activitySpeed?: Speed; activityCols?: string[] }) => void }) {
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const btn = useRef<HTMLButtonElement>(null), win = useRef<HTMLElement>(null), dim = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const from = useRef<Box | null>(null);
  const [drawing, setDrawing] = useState(false);
  const startTab = useRef<Tab>("procs");
  useLayoutEffect(() => { setHost(btn.current?.closest<HTMLElement>(".tm-overlay") ?? document.body); }, []);
  const sp = cleanSpeed(speed);

  const open = () => { if (phaseRef.current === "open") return; play("am-open"); reset(); setPhase("open"); };
  const click = () => { startTab.current = "procs"; open(); };
  const close = () => { if (phaseRef.current !== "open") return; play("am-close"); setPhase("closing"); };

  useLayoutEffect(() => {
    if (phase === "open") {
      psPost({ type: "dimx", open: true });          // PS pins the list and gives it the keyboard (Esc comes back here)
      const n0 = am.placeN;
      ask("open", { speed: sp });
      setDrawing(true);
      const t0 = performance.now();
      let raf = 0;
      // Wait a moment for the island's place (PS answers at once); none, or too slow: grow out of the button as Network does.
      const go = () => {
        const placed = am.placeN !== n0;
        if (!placed && performance.now() - t0 < 160) { raf = requestAnimationFrame(go); return; }
        const box = placed ? islandBox(am.place) : null;
        from.current = box;
        if (box && !reduced()) burst(win.current, box, dim.current, "in");
        else void morph(win.current, btn.current, dim.current, "in", MORPH);
      };
      if (win.current) win.current.style.opacity = "0";
      raf = requestAnimationFrame(() => { if (win.current) win.current.style.opacity = ""; go(); });
      const t = window.setTimeout(() => setDrawing(false), 1600);
      return () => { cancelAnimationFrame(raf); clearTimeout(t); };
    }
    if (phase === "closing") {
      psPost({ type: "dimx", open: false });
      ask("close");
      const box = from.current;
      void (box && !reduced() ? burst(win.current, box, dim.current, "out") : morph(win.current, btn.current, dim.current, "out", MORPH)).then(() => {
        if (box) ask("folded");          // the island gulps it back
        setPhase((p) => (p === "closing" ? "closed" : p));
      });
    }
    return undefined;
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc: a small pop up inside closes first (Columns, the End task question), then the window.
  const inner = useRef<() => boolean>(() => false);
  useEffect(() => {
    if (phase !== "open") return;
    const escape = () => { if (inner.current()) return true; close(); return true; };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); escape(); } };
    const w = window as Window & { __psDimxClose?: () => boolean };
    window.addEventListener("keydown", key, true);
    w.__psDimxClose = escape;
    return () => { window.removeEventListener("keydown", key, true); if (w.__psDimxClose === escape) delete w.__psDimxClose; };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // The Tab list was put away with the monitor open: PS stopped reading; the window closes quietly (no stale numbers later).
  const { hiddenN } = useAm();
  const seenHidden = useRef(hiddenN);
  useEffect(() => {
    if (hiddenN === seenHidden.current) return;
    seenHidden.current = hiddenN;
    if (phaseRef.current === "open") { psPost({ type: "dimx", open: false }); setPhase("closed"); }
  }, [hiddenN]);
  // The list went away with the monitor open: PS stops reading by itself; this keeps the page in step.
  useEffect(() => () => { if (phaseRef.current === "open") { ask("close"); psPost({ type: "dimx", open: false }); } }, []);
  // The dev page and a self test open it and pick a view without clicks.
  useEffect(() => {
    const on = (e: Event) => { const t = (e as CustomEvent).detail; startTab.current = TABS.some((x) => x.id === t) ? t as Tab : "procs"; open(); };
    window.addEventListener("ps-activity-open", on);
    return () => window.removeEventListener("ps-activity-open", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button ref={btn} type="button" className={`tm-pill-btn icon am-btn${phase !== "closed" ? " on" : ""}`} onClick={(e) => { if (e.button === 0) click(); }}
        aria-expanded={phase === "open"} aria-label={AM_WORDS.button} title={AM_WORDS.buttonTitle}>
        {/* A pulse line in a window (PS 1.70), the menu's own (views/topicons.tsx) */}
        <TopIcon id="activity" size={16} stroke={2} />
      </button>
      {phase !== "closed" && host && createPortal(
        <div className="dx-layer cs-layer am-layer" onMouseDown={(e) => e.stopPropagation()}>
          <div ref={dim} className="cs-dim" onMouseDown={close} aria-hidden="true" />
          <section ref={win} className={`cs-win am-win${drawing ? " am-drawin" : ""}`} role="dialog" aria-modal="true" aria-label="Activity monitor">
            <div className="am-morph" aria-hidden="true" />
            <div className="am-frame" aria-hidden="true" />
            <div className="cs-glow am-glow" aria-hidden="true" />
            <div className="cs-content am-content"><Monitor start={startTab.current} onClose={close} speed={sp} cols={cleanCols(cols)} save={save} inner={inner} /></div>
          </section>
        </div>, host)}
    </>
  );
}

function Monitor({ start, onClose, speed, cols, save, inner }: { start: Tab; onClose: () => void; speed: Speed; cols: Col[]; save: (p: { activitySpeed?: Speed; activityCols?: string[] }) => void; inner: { current: () => boolean } }) {
  const { snap } = useAm();
  const [tab, setTab] = useState<Tab>(start);
  useEffect(() => {
    const on = (e: Event) => { const t = (e as CustomEvent).detail as Tab; if (TABS.some((x) => x.id === t)) setTab(t); };
    window.addEventListener("am-tab", on);
    return () => window.removeEventListener("am-tab", on);
  }, []);
  useEffect(() => { if (tab === "history") ask("history"); if (tab === "startup") ask("startup"); }, [tab]);
  const pick = (t: Tab) => { if (t !== tab) { play("am-tab"); setTab(t); } };
  const setSpeed = (s: Speed) => { if (s === speed) return; play("am-tab"); save({ activitySpeed: s }); ask("speed", { speed: s }); };
  const memPct = snap && snap.mem.total ? (snap.mem.used / snap.mem.total) * 100 : 0;
  return (
    <>
      <header className="am-head">
        <button type="button" className="cs-min am-min" onClick={onClose} aria-label="Close the activity monitor" title={AM_WORDS.close}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
        </button>
        <div className="am-title"><span className="am-eyebrow">{AM_WORDS.eyebrow}</span><h2>{AM_WORDS.title}</h2></div>
        <div className="am-pills" aria-live="off">
          {snap && <>
            <span className="am-pill cpu"><i />CPU <b><Eased v={snap.cpu.t} f={pct} /></b></span>
            <span className={`am-pill mem ${snap.mem.press}`}><i />Memory <b><Eased v={memPct} f={pct} /></b></span>
            {snap.bat && <span className="am-pill bat"><i />Battery <b>{snap.bat.pct}%</b></span>}
          </>}
        </div>
        <div className="am-speed" role="radiogroup" aria-label={AM_WORDS.speed}>
          <span>{AM_WORDS.speed}</span>
          {SPEEDS.map((s) => <button key={s} type="button" role="radio" aria-checked={s === speed} className={s === speed ? "on" : ""} onClick={() => setSpeed(s)}>{AM_WORDS.speedNames[s]}</button>)}
        </div>
      </header>
      <div className="am-body">
        <nav className="am-rail" role="tablist" aria-label="Views" aria-orientation="vertical">
          <span className="am-ink" style={{ transform: `translateY(${TABS.findIndex((t) => t.id === tab) * 100}%)` }} aria-hidden="true" />
          {/* Click only (the developer, 18 Oct 2026): a tab never switches just because the mouse rests on it. */}
          {TABS.map((t) => <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : undefined} onClick={() => pick(t.id)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{t.icon}</svg>
            <span>{t.label}</span></button>)}
          <div className="am-rail-foot">
            {snap && <span className="am-cost" title={AM_WORDS.selfCost(snap.self.ms, snap.self.cpu)}>{AM_WORDS.selfCost(snap.self.ms, snap.self.cpu)}</span>}
            <span className="am-thru">{AM_WORDS.thru}</span>
          </div>
        </nav>
        <main className="am-main">
          {!snap && tab !== "history" && tab !== "startup" ? <p className="am-wait"><span className="am-spin" aria-hidden="true" />{AM_WORDS.reading}</p> : (
            <div className="am-view" key={tab}>
              {tab === "procs" && snap && <Processes snap={snap} cols={cols} save={save} inner={inner} />}
              {tab === "perf" && snap && <Performance speed={speed} />}
              {tab === "history" && <History />}
              {tab === "startup" && <Startup />}
            </div>
          )}
        </main>
      </div>
    </>
  );
}

// ---------- an easing number (under half a second after each change, then nothing runs) ----------
function Eased({ v, f }: { v: number; f: (n: number) => string }) {
  // The text is written straight into its own node while it eases: no React render per frame.
  const el = useRef<HTMLSpanElement>(null);
  const at = useRef(v);
  useEffect(() => {
    const from = at.current, to = v, node = el.current;
    if (!node) return;
    if (reduced() || Math.abs(to - from) < 0.05) { at.current = to; node.textContent = f(to); return; }
    const t0 = performance.now();
    let raf = 0, last = "";
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 420);
      at.current = easeAt(from, to, k);
      const txt = f(at.current);
      if (txt !== last) { node.textContent = txt; last = txt; }
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { if (el.current && !el.current.textContent) el.current.textContent = f(at.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <span ref={el} />;
}

// ---------- Processes ----------
const ROW = 32;
const COL_W: Record<Col, string> = { name: "minmax(220px, 1fr)", cpu: "88px", mem: "104px", disk: "108px", net: "112px", energy: "88px", threads: "84px", pid: "92px" };
const sumNet = (s: Snap) => s.net.ifs.reduce((n, i) => n + i.rx + i.tx, 0);

function Processes({ snap, cols, save, inner }: { snap: Snap; cols: Col[]; save: (p: { activityCols?: string[] }) => void; inner: { current: () => boolean } }) {
  const { procs, ended } = useAm();
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [sel, setSel] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [end, setEnd] = useState<EndState>({ s: "idle" });
  const endRef = useRef(end);
  endRef.current = end;
  const icons = useAppIcons(useMemo(() => [...new Set(procs.map((p) => p.id).filter(Boolean))], [procs]));
  // The order on screen a moment ago: rows whose numbers are close keep their places (core/activitymon.ts bucket).
  const prev = useRef<Map<string, number>>(new Map());
  const lines = useMemo(() => tableLines(procs, { sort, search, open, prev: prev.current }), [procs, sort, search, open]);
  // Held order while the pointer is over the table.
  const over = useRef(false);
  const order = useRef<string[]>([]);
  const keys = lines.map((l) => l.key);
  order.current = over.current ? holdOrder(order.current, keys) : keys;
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const shown = order.current.map((k) => byKey.get(k)).filter((l): l is Line => !!l);
  prev.current = new Map(shown.map((l, i) => [l.key, i]));

  const fire = (e: EndEvent) => {
    const r = endStep(endRef.current, e);
    endRef.current = r.next;
    setEnd(r.next);
    if (r.send) { play("am-end"); ask("end", r.send); }
  };
  useEffect(() => { if (ended) fire({ t: "ended", pid: ended.pid, ok: ended.ok, alive: ended.alive }); }, [ended?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  // A quit or force quit the Mac never answered (dropped, or the monitor closed under it) ends as "could not be ended".
  useEffect(() => {
    if (end.s !== "quitting" && end.s !== "forcing") return;
    const t = window.setTimeout(() => fire({ t: "timeout" }), END_WAIT_MS);
    return () => clearTimeout(t);
  }, [end.s]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (end.s !== "done" && end.s !== "failed") return;
    const t = window.setTimeout(() => fire({ t: "cancel" }), 3200);
    return () => clearTimeout(t);
  }, [end.s]); // eslint-disable-line react-hooks/exhaustive-deps
  // Esc closes the Columns menu or the End task question before the window.
  inner.current = () => {
    if (menu) { setMenu(false); return true; }
    if (endRef.current.s === "ask" || endRef.current.s === "stuck") { fire({ t: "cancel" }); return true; }
    return false;
  };
  const selected = sel != null ? procs.find((p) => p.pid === sel) : undefined;
  const endable = !!selected && canEnd(selected);
  const toggle = (pid: number) => setOpen((o) => { const n = new Set(o); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });
  const header: Record<Col, ReactNode> = {
    name: <>{AM_WORDS.tabs.procs}<em>{procs.length}</em></>,
    cpu: <>CPU<em><Eased v={snap.cpu.t} f={pct} /></em></>,
    mem: <>Memory<em>{snap.mem.total ? pct((snap.mem.used / snap.mem.total) * 100) : "-"}</em></>,
    disk: <>Disk<em>{rate(snap.disk.r + snap.disk.w)}</em></>,
    net: <>Network<em>{rate(sumNet(snap))}</em></>,
    energy: <>Energy<em>{watts(procs.reduce((n, p) => n + p.w, 0))}</em></>,
    threads: <>Threads<em>{snap.cpu.thr}</em></>,
    pid: <>Process ID<em>&nbsp;</em></>,
  };
  const grid = cols.map((c) => COL_W[c]).join(" ");
  const words = endWords(end);
  return (
    <div className="am-procs">
      <div className="am-tools">
        <label className="am-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></svg>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={AM_WORDS.search} aria-label={AM_WORDS.search} spellCheck={false} />
        </label>
        <div className="am-colwrap">
          <button type="button" className={`am-tool${menu ? " on" : ""}`} aria-expanded={menu} onClick={() => setMenu((m) => !m)}>{AM_WORDS.columns}</button>
          {menu && <div className="am-menu" role="menu">
            {COLUMNS.filter((c) => c.id !== "name").map((c) => <label key={c.id} className="am-check"><input type="checkbox" checked={cols.includes(c.id)}
              onChange={(e) => save({ activityCols: cleanCols(e.target.checked ? [...cols, c.id] : cols.filter((x) => x !== c.id)) })} />{c.label}</label>)}
          </div>}
        </div>
        {!snap.net.on && cols.includes("net") && <span className="am-note">{AM_WORDS.netOff}</span>}
        <button type="button" className="am-end" disabled={!endable || (end.s !== "idle" && end.s !== "done" && end.s !== "failed")} title={selected && !endable ? AM_WORDS.cannotEnd : undefined}
          onClick={() => selected && fire({ t: "start", p: selected })}>{AM_WORDS.endTask}</button>
      </div>
      <div className={`am-confirm${words ? ` show ${words.tone}` : ""}`} role={words ? "alertdialog" : undefined} aria-live="polite">
        {words && <>
          <span className="am-confirm-dot" aria-hidden="true" />
          <span className="am-confirm-line">{words.line}</span>
          {words.button && <><button type="button" className="am-confirm-go" onClick={() => fire({ t: "confirm" })}>{words.button}</button>
            <button type="button" className="am-confirm-no" onClick={() => fire({ t: "cancel" })}>{AM_WORDS.cancel}</button></>}
        </>}
      </div>
      <div className="am-table" style={{ ["--am-grid" as string]: grid }}>
        <div className="am-thead" role="row">
          {cols.map((c) => <button key={c} type="button" role="columnheader" className={`am-th ${c}${sort.col === c ? ` on ${sort.dir === 1 ? "up" : "down"}` : ""}`}
            aria-sort={sort.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"} onClick={() => setSort((s) => nextSort(s, c))}>{header[c]}</button>)}
        </div>
        <Rows lines={shown} cols={cols} icons={icons} sel={sel} onSel={setSel} onToggle={toggle} over={over} />
        {!lines.length && <p className="am-none">{AM_WORDS.noMatch}</p>}
      </div>
    </div>
  );
}

/** Only the rows in view are drawn; each sits at its place by a transform, so a new order glides (and holds under the pointer). */
function Rows({ lines, cols, icons, sel, onSel, onToggle, over }: { lines: Line[]; cols: Col[]; icons: Record<string, string>; sel: number | null; onSel: (p: number) => void;
  onToggle: (p: number) => void; over: { current: boolean } }) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0), [h, setH] = useState(600);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight));
    ro.observe(el);
    setH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  const first = Math.max(0, Math.floor(top / ROW) - 6), last = Math.min(lines.length, Math.ceil((top + h) / ROW) + 6);
  const fmt = (c: Col, l: Extract<Line, { kind: "row" }>): [ReactNode, number] => {
    const s = l.sums;
    switch (c) {
      case "cpu": return [pct(s.cpu), heat("cpu", s.cpu)];
      case "mem": return [mem(s.mem), heat("mem", s.mem)];
      case "disk": return [rate(s.disk), heat("disk", s.disk)];
      case "net": return [s.net == null ? "-" : rate(s.net), heat("net", s.net)];
      case "energy": return [watts(s.w), heat("energy", s.w)];
      case "threads": return [s.thr, 0];
      case "pid": return [l.p.pid, 0];
      case "name": return [null, 0];
    }
  };
  return (
    <div ref={box} className="am-tbody" onScroll={(e) => { const t = (e.target as HTMLDivElement).scrollTop; requestAnimationFrame(() => setTop(t)); }}
      onPointerEnter={() => { over.current = true; }} onPointerLeave={() => { over.current = false; }}>
      <div className="am-tspace" style={{ height: lines.length * ROW }}>
        {lines.slice(first, last).map((l, k) => {
          const y = (first + k) * ROW;
          if (l.kind === "head") return <div key={l.key} className="am-sec" style={{ transform: `translateY(${y}px)` }}><span>{l.label}</span><em>{l.count}</em></div>;
          const p = l.p;
          return (
            <div key={l.key} role="row" aria-selected={sel === p.pid} className={`am-tr${sel === p.pid ? " sel" : ""}${l.depth ? " kid" : ""}`} style={{ transform: `translateY(${y}px)` }}
              onMouseDown={(e) => { if (e.button === 0) onSel(p.pid); }}>
              {cols.map((c) => {
                if (c === "name") return (
                  <span key={c} className="am-td name">
                    {l.kids > 0 ? <button type="button" className={`am-chev${l.open ? " open" : ""}`} aria-label={l.open ? "Fold the helpers" : AM_WORDS.helpers(l.kids)} aria-expanded={l.open}
                      onMouseDown={(e) => e.stopPropagation()} onClick={() => onToggle(p.pid)}><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                      : <span className="am-chev-pad" />}
                    {p.id && icons[p.id] ? <img src={icons[p.id]} alt="" /> : <span className="am-letter">{p.n.slice(0, 1).toUpperCase()}</span>}
                    <span className="am-pname">{p.n}</span>
                    {l.kids > 0 && !l.open && <em className="am-kids">{l.kids}</em>}
                    {p.ps ? (p.n !== AM_WORDS.you && <span className="am-chip">{AM_WORDS.you}</span>) : p.sys ? <span className="am-chip">{AM_WORDS.sys}</span> : null}
                  </span>);
                const [v, hv] = fmt(c, l);
                return <span key={c} className={`am-td num am-h${hv}`}>{v}</span>;
              })}
            </div>);
        })}
      </div>
    </div>
  );
}

// ---------- graphs: the drawing slides one step left per sample by a transform (no drawing in between) ----------
function Graph({ lines, max, h = 160, speed, tones, mini, label }: { lines: number[][]; max: number; h?: number; speed: number; tones: string[]; mini?: boolean; label?: string }) {
  const wrap = useRef<HTMLDivElement>(null), slide = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const id = useId().replace(/:/g, "");
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const calm = reduced();
  const step = w / (GRAPH_POINTS - 1);
  const drawW = calm ? w : w + step;
  const paths = lines.map((s) => graphPaths(s, drawW, h, max));
  const n = lines[0]?.length ?? 0;
  useLayoutEffect(() => {
    const el = slide.current;
    if (!el || calm || !w || n < 2) return;
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([{ transform: "translate3d(0, 0, 0)" }, { transform: `translate3d(${-step}px, 0, 0)` }], { duration: speed * 1000, easing: "linear", fill: "forwards" });
  }, [n, lines[0]?.[n - 1], w]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={wrap} className={`am-graph${mini ? " mini" : ""}`} style={{ height: h }} role={label ? "img" : undefined} aria-label={label}>
      {!mini && <div className="am-grid" aria-hidden="true"><i /><i /><i /></div>}
      <div ref={slide} className="am-slide" style={{ width: drawW }}>
        {w > 0 && <svg width={drawW} height={h} viewBox={`0 0 ${drawW} ${h}`} aria-hidden="true">
          <defs>{tones.map((t, i) => <linearGradient key={t} id={`${id}${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" className={`am-stop ${t}`} stopOpacity=".42" /><stop offset="1" className={`am-stop ${t}`} stopOpacity="0" /></linearGradient>)}</defs>
          {paths.map((p, i) => p.line && <g key={i} className={`am-g ${tones[i]}`}>
            {i === 0 && <path d={p.area} fill={`url(#${id}${i})`} className="am-area" />}
            <path d={p.line} className="am-line" pathLength={1} />
          </g>)}
        </svg>}
      </div>
    </div>
  );
}

// ---------- Performance ----------
function Performance({ speed }: { speed: number }) {
  const { snap, series } = useAm();
  const [pick, setPick] = useState<PerfId>("cpu");
  if (!snap) return null;
  const items = perfItems(snap);
  const cur = items.some((i) => i.id === pick) ? pick : "cpu";
  const mini = (id: PerfId): { lines: number[][]; max: number; tones: string[] } => {
    if (id === "cpu") return { lines: [series.cpu], max: 100, tones: ["cpu"] };
    if (id === "mem") return { lines: [series.mem], max: 100, tones: ["mem"] };
    if (id === "disk") return { lines: [series.dr, series.dw], max: niceMax([...series.dr, ...series.dw], 1e5), tones: ["disk", "disk2"] };
    if (id === "gpu") return { lines: [series.gpu], max: 100, tones: ["gpu"] };
    if (id === "bat") return { lines: [series.bat], max: niceMax(series.bat, 5), tones: ["bat"] };
    const n = series.net[id.slice(4)] || { rx: [], tx: [] };
    return { lines: [n.rx, n.tx], max: niceMax([...n.rx, ...n.tx], 1e4), tones: ["net", "net2"] };
  };
  return (
    <div className="am-perf">
      <ul className="am-plist" role="listbox" aria-label={AM_WORDS.tabs.perf}>
        {items.map((it) => { const g = mini(it.id); return (
          <li key={it.id}><button type="button" role="option" aria-selected={cur === it.id} className={cur === it.id ? "on" : ""} onClick={() => { if (cur !== it.id) { play("am-tab"); setPick(it.id); } }}>
            <Graph lines={g.lines} max={g.max} h={34} speed={speed} tones={g.tones} mini />
            <span className="am-pl-t">{it.title}</span><span className="am-pl-s">{it.sub}</span>
          </button></li>); })}
      </ul>
      <div className="am-pdetail" key={cur}>
        {cur === "cpu" && <CpuDetail s={snap} series={series} speed={speed} />}
        {cur === "mem" && <MemDetail s={snap} series={series} speed={speed} />}
        {cur === "disk" && <DiskDetail s={snap} series={series} speed={speed} />}
        {cur.startsWith("net:") && <NetDetail s={snap} n={cur.slice(4)} series={series} speed={speed} />}
        {cur === "gpu" && <GpuDetail s={snap} series={series} speed={speed} />}
        {cur === "bat" && snap.bat && <BatDetail s={snap} series={series} speed={speed} />}
      </div>
    </div>
  );
}
type DP = { s: Snap; series: Series; speed: number };
function Head({ title, sub, big }: { title: string; sub?: string; big: ReactNode }) {
  return <header className="am-dh"><div><h3>{title}</h3>{sub && <span>{sub}</span>}</div><b className="am-big">{big}</b></header>;
}
function Stats({ list }: { list: [string, ReactNode][] }) {
  return <dl className="am-stats">{list.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}
function CpuDetail({ s, series, speed }: DP) {
  const W = AM_WORDS.cpu;
  let e = 0, p = 0;
  return (
    <>
      <Head title="CPU" sub={s.cpu.name} big={<Eased v={s.cpu.t} f={pct} />} />
      <Graph lines={[series.cpu]} max={100} speed={speed} tones={["cpu"]} label={`CPU ${pct(s.cpu.t)}`} />
      <Stats list={[[W.util, <Eased key="u" v={s.cpu.t} f={pct} />], [W.user, pct(s.cpu.u)], [W.system, pct(s.cpu.s)], [W.up, duration(s.cpu.up)], [W.procs, s.cpu.procs], [W.threads, s.cpu.thr], [W.cores, s.cpu.cores.length]]} />
      <h4 className="am-sub">{W.perCore}</h4>
      <div className="am-cores">
        {s.cpu.cores.map((c, i) => {
          const k = s.cpu.kinds[i];
          const name = k === "e" ? `${W.e} ${++e}` : k === "p" ? `${W.p} ${++p}` : `${W.cores} ${i + 1}`;
          return <div key={i} className={`am-core ${k || ""}`}><span><b>{name}</b><em>{pct(c)}</em></span><Graph lines={[series.cores[i] || []]} max={100} h={46} speed={speed} tones={[k === "e" ? "core-e" : "cpu"]} mini /></div>;
        })}
      </div>
    </>
  );
}
function MemDetail({ s, series, speed }: DP) {
  const W = AM_WORDS.mem, m = s.mem, t = m.total || 1;
  const parts: [string, number, string][] = [[W.app, m.app, "app"], [W.wired, m.wired, "wired"], [W.comp, m.comp, "comp"], [W.cached, m.cached, "cached"], [W.free, m.free, "free"]];
  return (
    <>
      <Head title="Memory" sub={`${mem(m.used)} ${W.of} ${mem(m.total)}`} big={<Eased v={(m.used / t) * 100} f={pct} />} />
      <Graph lines={[series.mem]} max={100} speed={speed} tones={["mem"]} label={`Memory ${pct((m.used / t) * 100)}`} />
      <div className="am-bar" role="img" aria-label={parts.map(([k, v]) => `${k} ${mem(v)}`).join(", ")}>
        {parts.map(([k, v, c]) => <i key={k} className={c} style={{ flexGrow: Math.max(0.2, (v / t) * 100) }} title={`${k} ${mem(v)}`} />)}
      </div>
      <ul className="am-legend">{parts.map(([k, v, c]) => <li key={k}><i className={c} />{k}<b>{mem(v)}</b></li>)}</ul>
      <Stats list={[[W.pressure, <span key="p" className={`am-press ${m.press}`}><i />{PRESSURE_WORD[m.press]}</span>], [W.used, mem(m.used)], [W.swap, `${mem(m.swap)} ${W.of} ${mem(m.swapT)}`]]} />
    </>
  );
}
function DiskDetail({ s, series, speed }: DP) {
  const W = AM_WORDS.disk, d = s.disk;
  const max = niceMax([...series.dr, ...series.dw], 1e5);
  return (
    <>
      <Head title="Disk" sub={`${W.read} ${rate(d.r)} · ${W.write} ${rate(d.w)}`} big={d.act == null ? rate(d.r + d.w) : <Eased v={d.act} f={pct} />} />
      <Graph lines={[series.dr, series.dw]} max={max} speed={speed} tones={["disk", "disk2"]} label={`${W.read} ${rate(d.r)}, ${W.write} ${rate(d.w)}`} />
      <ul className="am-legend"><li><i className="disk" />{W.read}<b>{rate(d.r)}</b></li><li><i className="disk2" />{W.write}<b>{rate(d.w)}</b></li><li className="am-top">{rate(max)}</li></ul>
      <Stats list={[[W.active, d.act == null ? W.noActive : pct(d.act)]]} />
      {d.vols.length > 0 && <><h4 className="am-sub">{W.vols}</h4>
        <ul className="am-vols">{d.vols.map((v) => { const used = v.total ? 1 - v.free / v.total : 0; return (
          <li key={v.n}><span><b>{v.n}</b><em>{W.free(bytes(v.free))} · {bytes(v.total)}</em></span><span className={`am-vbar${used > 0.9 ? " full" : ""}`}><i style={{ transform: `scaleX(${used})` }} /></span></li>); })}</ul></>}
    </>
  );
}
function NetDetail({ s, n, series, speed }: DP & { n: string }) {
  const W = AM_WORDS.net, i = s.net.ifs.find((x) => x.n === n);
  const ser = series.net[n] || { rx: [], tx: [] };
  if (!i) return null;
  const max = niceMax([...ser.rx, ...ser.tx], 1e4);
  return (
    <>
      <Head title={i.k === "vpn" ? W.vpn : i.l || i.n} sub={i.n} big={rate(i.rx + i.tx)} />
      <Graph lines={[ser.rx, ser.tx]} max={max} speed={speed} tones={["net", "net2"]} label={`${W.rx} ${rate(i.rx)}, ${W.tx} ${rate(i.tx)}`} />
      <ul className="am-legend"><li><i className="net" />{W.rx}<b>{rate(i.rx)}</b></li><li><i className="net2" />{W.tx}<b>{rate(i.tx)}</b></li><li className="am-top">{rate(max)}</li></ul>
    </>
  );
}
function GpuDetail({ s, series, speed }: DP) {
  const W = AM_WORDS.gpu;
  return (
    <>
      <Head title="GPU" sub={s.gpu.name} big={s.gpu.u == null ? "" : <Eased v={s.gpu.u} f={pct} />} />
      {s.gpu.u == null ? <p className="am-plain">{W.none}</p> : <>
        <Graph lines={[series.gpu]} max={100} speed={speed} tones={["gpu"]} label={`GPU ${pct(s.gpu.u)}`} />
        <Stats list={[[W.util, pct(s.gpu.u)]]} /></>}
    </>
  );
}
function BatDetail({ s, series, speed }: DP) {
  const W = AM_WORDS.bat, b = s.bat!;
  return (
    <>
      <Head title="Battery" sub={b.charging ? W.charging : b.ac ? W.plugged : W.onBattery} big={`${b.pct}%`} />
      <div className={`am-charge${b.charging ? " charging" : ""}${b.pct <= 15 ? " low" : ""}`}><i style={{ transform: `scaleX(${b.pct / 100})` }} /></div>
      <Graph lines={[series.bat]} max={niceMax(series.bat, 5)} h={110} speed={speed} tones={["bat"]} label={`${W.draw} ${b.watts == null ? "" : watts(b.watts)}`} />
      <Stats list={[[W.charge, `${b.pct}%`], [b.charging ? W.toFull : W.left, b.mins == null ? W.unknown : duration(b.mins * 60)], [W.health, b.health == null ? "-" : `${b.health}%`],
        [W.cycles, b.cycles ?? "-"], [W.draw, b.watts == null ? "-" : watts(b.watts)]]} />
    </>
  );
}

// ---------- App history ----------
function History() {
  const { history } = useAm();
  const v = useVault();
  const [range, setRange] = useState<"today" | "week">("today");
  const screen = useMemo(() => new Map([...screenTimeDays(v, "mac")].map(([k, d]) => [k, d.data])), [v]);
  const days = history?.days?.length ? (range === "today" ? history.days.slice(0, 1) : history.days) : [];
  const rows = useMemo(() => historyRows(days, screen, history), [days.join(), screen, history]); // eslint-disable-line react-hooks/exhaustive-deps
  const icons = useAppIcons(useMemo(() => rows.map((r) => r.id).filter(Boolean), [rows]));
  const W = AM_WORDS.history;
  const maxCpu = Math.max(1, ...rows.map((r) => r.cpu)), maxFront = Math.max(1, ...rows.map((r) => r.front));
  return (
    <div className="am-hist">
      <div className="am-tools">
        <div className="am-seg" role="radiogroup" aria-label={W.week}>
          {(["today", "week"] as const).map((r) => <button key={r} type="button" role="radio" aria-checked={range === r} className={range === r ? "on" : ""} onClick={() => { if (range !== r) { play("am-tab"); setRange(r); } }}>{r === "today" ? W.today : W.week}</button>)}
        </div>
        <span className="am-note">{W.note}</span>
      </div>
      {!history ? <p className="am-wait"><span className="am-spin" aria-hidden="true" />{AM_WORDS.reading}</p> : !rows.length ? <p className="am-none">{W.none}</p> : (
        <div className="am-htable" role="table">
          <div className="am-hrow head" role="row"><span>{W.app}</span><span>{W.front}</span><span>{W.cpu}</span><span>{W.net}</span></div>
          {rows.slice(0, 80).map((r) => (
            <div key={r.key} className="am-hrow" role="row">
              <span className="am-td name">{r.id && icons[r.id] ? <img src={icons[r.id]} alt="" /> : <span className="am-letter">{r.name.slice(0, 1).toUpperCase()}</span>}<span className="am-pname">{r.name}</span></span>
              <span className="am-hcell"><b>{r.front ? duration(r.front) : "-"}</b><i className="front" style={{ transform: `scaleX(${r.front / maxFront})` }} /></span>
              <span className="am-hcell"><b>{r.cpu ? duration(r.cpu) : "-"}</b><i className="cpu" style={{ transform: `scaleX(${r.cpu / maxCpu})` }} /></span>
              <span className="am-hcell"><b>{r.rx + r.tx ? `↓ ${bytes(r.rx)} ↑ ${bytes(r.tx)}` : "-"}</b></span>
            </div>))}
        </div>)}
    </div>
  );
}

// ---------- Startup apps (read only) ----------
function Startup() {
  const { startup } = useAm();
  const icons = useAppIcons(useMemo(() => (startup?.items || []).map((i) => i.id).filter(Boolean), [startup]));
  const W = AM_WORDS.startup;
  return (
    <div className="am-start">
      <div className="am-hidden">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
        <span>{W.hidden}</span>
        <button type="button" className="am-tool" onClick={() => { play("am-tab"); ask("loginItems"); }}>{W.open}</button>
      </div>
      {!startup ? <p className="am-wait"><span className="am-spin" aria-hidden="true" />{AM_WORDS.reading}</p> : !startup.items.length ? <p className="am-none">{W.none}</p> : (
        <div className="am-htable st" role="table">
          <div className="am-hrow head" role="row"><span>{W.name}</span><span>{W.runs}</span><span>{W.folder}</span></div>
          {startup.items.map((i) => (
            <div key={`${i.folder}:${i.label}`} className={`am-hrow${i.off ? " off" : ""}`} role="row">
              <span className="am-td name">{i.id && icons[i.id] ? <img src={icons[i.id]} alt="" /> : <span className="am-letter">{i.name.slice(0, 1).toUpperCase()}</span>}
                <span className="am-pname">{i.name}{i.name !== i.label && <em>{i.label}</em>}</span></span>
              <span>{i.off ? <span className="am-chip">{W.off}</span> : <>{i.run && <span className="am-chip go">{W.atLogin}</span>}{i.keep && <span className="am-chip">{W.kept}</span>}</>}</span>
              <span className="am-dim">{i.folder === "user" ? W.user : W.mac}</span>
            </div>))}
        </div>)}
    </div>
  );
}

// ---------- Settings, Mac, Activity monitor ----------
export function ActivitySetting({ on, speed, set }: { on: boolean; speed?: number; set: (p: { activityMonitor?: boolean; activitySpeed?: Speed }) => void }) {
  const W = AM_WORDS.setting, sp = cleanSpeed(speed);
  return (
    <div className="am-setting">
      <div className="tm-ed-seg" role="radiogroup" aria-label={W.name}>
        <button type="button" role="radio" aria-checked={on} className={`dwell${on ? " on" : ""}`} onClick={() => set({ activityMonitor: true })}>{W.on}</button>
        <button type="button" role="radio" aria-checked={!on} className={`dwell${!on ? " on" : ""}`} onClick={() => set({ activityMonitor: false })}>{W.off}</button>
      </div>
      {on && <div className="tm-ed-seg" role="radiogroup" aria-label={W.speed}>
        <span className="am-set-l">{W.speed}</span>
        {SPEEDS.map((s) => <button key={s} type="button" role="radio" aria-checked={s === sp} className={`dwell${s === sp ? " on" : ""}`} onClick={() => set({ activitySpeed: s })}>{AM_WORDS.speedNames[s]}</button>)}
      </div>}
    </div>
  );
}
export const activityNote = (on: boolean) => (on ? AM_WORDS.setting.noteOn : AM_WORDS.setting.noteOff);
