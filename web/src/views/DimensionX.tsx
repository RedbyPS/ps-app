// Dimension X: a big planning screen inside the Tab list, opened from the small purple X just
// under the meetings panel (bottom left). Hover the X: it grows into "Dimension X" and, after a
// short rest (so a passing mouse never opens it), the screen opens out of it; a click opens it at
// once. Three bands: Actionables (top: things he will do very soon that are not on his list yet),
// The Upside Down (ideas he might do soon, not sure when) and Dimension X (random ideas, just
// spacing out), plus a live copy of his real task list (Priorities) on the right. Drag anything
// anywhere: between bands, into the task list at the drop point, back out again, and up and down
// inside each. Every band and the list take new items by typing. Urgent left Dimension X in V1.40
// (the Tab list's Overdue card replaced it on 4 Nov 2026); old Urgent items (settings.aware) move
// into Actionables the first time the board opens, so nothing is lost (see Board).
// Esc or the minimize button (top left) shrinks it back into the X; the Tab list stays open (a
// second Esc closes that as usual).
//
// Task API (V1.56): the AI Inbox sits at the top of the right rail. Tasks an AI added (core/aiinbox.ts) wait there,
// on no list, with an AI badge; drag one onto Your task list or a band, or use its menu to send it to any list, tick
// it or delete it. A switch at the top (Ideas, Lists) swaps the bands for the Lists view (views/DimxLists.tsx): every
// list page side by side with its tasks, to open, rename, reorder and delete (the developer's friend: "rn the new pages.. i can
// add tasks there but i dont have a way in dimension x to manage that").
// Data: settings.dimx (array order = order on screen). Into the task list = a real task is added
// and the card leaves dimx; out of the list = the task is deleted and a card is added (text only).
// Each move stays on screen as done for a moment (the hold) while PS's floating window round trips
// through its main window, so a two step move never flickers.
import { morphFade, morphFrames } from "../ui/morphframes";
import { wheelMorph } from "../gos/launch";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DIMX_COLORS, type AwareItem, type DimxItem, type DimxStyle, type DimxZone, type Doc, type Todo } from "../core/model";
import { fmtDate, useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { PS, psPost } from "../ps";
import { orderForPriority, taskMapActions } from "./TaskMap";
import { p1AfterMove, prioNumbers } from "../core/prio";
import { PrioInput, typedPrioOn, useTypedPrio } from "./TypedPrio";
import { useNlDates } from "./NlDates";
import type { ParsedTask } from "../core/nldates";
import type { TimeRemind } from "../core/nlremind";
import { settingsData } from "../core/select";
import { renamedPrio, typedEdit, typedOrder, type PrioNum } from "../core/typedprio";
import { DimxLists, MoveMenu, listsEscape } from "./DimxLists";
import { INBOX_NAME } from "../core/aiinbox";
import { insertDimx } from "../core/dimxmove";
import "./dimx.css";

type Zone = DimxZone | "prio" | "ai";
type Card = { key: string; id: string; text: string; zone: Zone; due?: string | null; pending?: boolean; style?: DimxStyle; ai?: boolean };
type PrioView = { id: string; title: string; due?: string | null; pending?: boolean; p1?: boolean; unranked?: boolean; ai?: boolean };
type View = { dimx: DimxItem[]; prio: PrioView[]; ai: PrioView[] };
type Hold = Partial<View> & { until: number };

// Each band's one line meaning sits on its own line under the title (the developer's meanings, V1.40).
const BANDS: { zone: DimxZone; title: string; sub: string; add: string }[] = [
  { zone: "act", title: "Actionables", sub: "Things you will do very soon that are not on your to-do list yet.", add: "Add an actionable" },
  { zone: "soon", title: "The Upside Down", sub: "Ideas you might do soon, but you do not know when.", add: "Add something for soon" },
  { zone: "x", title: "Dimension X", sub: "Random ideas. Just spacing out.", add: "Add a random idea" },
];
const isBand = (z: Zone): z is DimxZone => z === "act" || z === "soon" || z === "x";

// Open in this page right now (the Tab list keeps typing in its boxes while it is).
let dxOpen = false;
export const dimxIsOpen = () => dxOpen;

export const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const EASE_CSS = "cubic-bezier(.22,1,.36,1)";
const HOLD_MS = 1500;
const DWELL_MS = 480;
export const DWELL = DWELL_MS;
const WIN_RADIUS = 26;
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

const insertAt = <T,>(arr: T[], item: T, i: number) => [...arr.slice(0, i), item, ...arr.slice(i)];

/**
 * The window grows out of the X ("in") or shrinks back into it ("out"): one transform, sampled
 * along the easing curve so the corners stay truly round at every step (radii of r/sx by r/sy).
 */
export function morph(win: HTMLElement | null, x: HTMLElement | null, dim: HTMLElement | null, dir: "in" | "out", parts: { body: string; tint: string; flat?: boolean } = { body: ".dx-content", tint: ".dx-morph" }): Promise<void> {
  if (!win) return Promise.resolve();
  win.getAnimations().forEach((a) => a.cancel());
  // PS 1.67 the phone's wheel menu: a window it launched zooms out of the item's spot and back into it (gos/launch.ts).
  const wheel = wheelMorph(win, dir);
  if (wheel) {
    dim?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: dir === "out" ? 300 : 420, easing: "ease", fill: dir === "out" ? "forwards" : "none", direction: dir === "out" ? "reverse" : "normal" });
    return wheel;
  }
  const p = win.getBoundingClientRect();
  const b = x?.getBoundingClientRect();
  const quick = reduced() || !b || b.width < 4 || p.width < 4;
  const fill = dir === "out" ? "forwards" as const : "none" as const;
  const back = dir === "out" ? "reverse" as const : "normal" as const;
  dim?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: quick ? 160 : 480, easing: "ease", fill, direction: back });
  // A stylesheet can ask for a sheet that slides up from the bottom instead (PS GOS sets --morph: sheet on the phone).
  if (!reduced() && getComputedStyle(win).getPropertyValue("--morph").trim() === "sheet") {
    const down = { transform: "translate3d(0, 100%, 0)" }, up = { transform: "translate3d(0, 0, 0)" };
    return win.animate(dir === "in" ? [down, up] : [up, down], dir === "in"
      ? { duration: 520, easing: "cubic-bezier(.22, 1, .36, 1)", fill }
      : { duration: 340, easing: "cubic-bezier(.4, 0, .9, .6)", fill }).finished.then(() => {}, () => {});
  }
  if (quick) {
    return win.animate([{ opacity: 0, transform: reduced() ? "none" : "scale(.97)" }, { opacity: 1, transform: "none" }],
      { duration: 200, easing: "ease", fill, direction: back }).finished.then(() => {}, () => {});
  }
  // V1.47 (the developer: Fitness open, minimise and close "very laggy"): border-radius cannot run on the GPU, and one such
  // property in the keyframes keeps the WHOLE animation (the transform too) on the main thread, so every render or
  // sync during it dropped frames. On the phone the window moves by transform only and fades at its small end
  // instead, so the squashed corners never show; the Mac keeps the truly round corners.
  const flat = parts.flat ?? (import.meta.env.MODE === "gos" || document.documentElement.classList.contains("gos"));   // the phone app and G Squad on the web
  const frames = morphFrames(p, b!, dir, flat, WIN_RADIUS);   // ui/morphframes.ts
  win.style.transformOrigin = "0 0";
  const ms = dir === "in" ? 600 : 500;
  const a = win.animate(frames, { duration: ms, easing: "linear", fill });
  if (flat) win.animate(morphFade(dir), { duration: ms, easing: "linear", fill });
  const body = win.querySelector<HTMLElement>(parts.body), tint = win.querySelector<HTMLElement>(parts.tint);
  if (dir === "out") {
    body?.animate([{ opacity: 1 }, { opacity: 0, offset: 0.32 }, { opacity: 0 }], { duration: ms, fill });
    tint?.animate([{ opacity: 0 }, { opacity: 1, offset: 0.6 }, { opacity: 1 }], { duration: ms, fill });
  } else {
    body?.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration: ms, fill });
    tint?.animate([{ opacity: 1 }, { opacity: 1, offset: 0.2 }, { opacity: 0, offset: 0.62 }, { opacity: 0 }], { duration: ms, fill });
  }
  return a.finished.then(() => {}, () => {});
}

/** The purple X under the meetings panel, and the Dimension X window it opens. */
export function DimensionX({ prio, aware, dimx, docked, inbox = [] }: { prio: Doc<Todo>[]; aware: AwareItem[]; dimx: DimxItem[]; docked?: boolean; inbox?: Doc<Todo>[] }) {
  const [view, setView] = useState<"ideas" | "lists">("ideas");
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const [hot, setHot] = useState(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const dock = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null);
  const win = useRef<HTMLElement>(null), dim = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  // A child's layout effect runs before the parent's refs are set, so find the list's root from here.
  useLayoutEffect(() => { setHost(docked ? document.body : dock.current?.closest<HTMLElement>(".tm-overlay") ?? null); }, [docked]);
  const dwell = useRef(0);
  const [ready, setReady] = useState(false);
  const boardEsc = useRef<() => boolean>(() => false);

  const open = () => {
    clearTimeout(dwell.current);
    if (phaseRef.current === "open") return;
    sfx.click();
    setReady(false);
    setPhase("open");
  };
  const close = () => {
    if (phaseRef.current !== "open") return;
    sfx.drop();
    setReady(false);
    setHot(false);
    setPhase("closing");
  };

  useLayoutEffect(() => {
    if (phase === "open") {
      dxOpen = true;
      // PS: pin the list and give it the keyboard (never over 1Password or Signal; PS decides).
      if (PS) psPost({ type: "dimx", open: true }); else taskMapActions.editing(true);
      void morph(win.current, btn.current, dim.current, "in").then(() => setReady(true));
    } else if (phase === "closing") {
      dxOpen = false;
      if (PS) psPost({ type: "dimx", open: false }); else taskMapActions.editing(false);
      const a = document.activeElement as HTMLElement | null;
      if (a && win.current?.contains(a)) a.blur();
      void morph(win.current, btn.current, dim.current, "out").then(() => {
        setPhase((p) => (p === "closing" ? "closed" : p));
        // The X takes it back in with a small pulse.
        if (!reduced()) btn.current?.animate([{ transform: "scale(1)" }, { transform: "scale(1.22)" }, { transform: "scale(1)" }], { duration: 380, easing: EASE_CSS });
      });
    }
  }, [phase]);

  // Esc: a drag or an edit first, then Dimension X itself; the Tab list stays (website: this runs
  // before the list's own Esc). In PS the Mac's Esc arrives as window.__psDimxClose instead.
  useEffect(() => {
    if (phase !== "open") return;
    // PS clears its "open" flag before asking; when Esc only stopped a drag, the menu or an edit,
    // say again that Dimension X is still open so the next Esc comes here too.
    const escape = () => { if (!boardEsc.current()) close(); else if (PS) psPost({ type: "dimx", open: true }); return true; };
    const key = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); escape(); };
    const w = window as Window & { __psDimxClose?: () => boolean };
    window.addEventListener("keydown", key, true);
    w.__psDimxClose = escape;
    return () => { window.removeEventListener("keydown", key, true); if (w.__psDimxClose === escape) delete w.__psDimxClose; };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    clearTimeout(dwell.current);
    if (dxOpen) { dxOpen = false; if (!PS) taskMapActions.editing(false); }
  }, []);

  const windowEl = phase !== "closed" && (
    <div className={`dx-layer${docked ? " docked" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
      <div ref={dim} className="dx-dim" onMouseDown={close} aria-hidden="true" />
      <section ref={win} className="dx-win" role="dialog" aria-modal="true" aria-label="Dimension X">
        <div className="dx-morph" aria-hidden="true" />
        <Storm />
        <div className="dx-content">
          <header className="dx-head">
            <button type="button" className="dx-min" onClick={close} aria-label="Minimize back to the Tab list" title="Back to the Tab list (Esc)">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
            </button>
            <div className="dx-title">
              <Logo />
              <p className="dx-tag">{view === "ideas" ? "Your ideas, sorted by how soon you will do them." : "Your lists, side by side: open, rename, reorder, delete."}</p>
              <div className="dx-views" role="tablist" aria-label="What Dimension X shows">
                {(["ideas", "lists"] as const).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} className={`dx-view${view === v ? " on" : ""}`} onClick={() => { if (view !== v) { sfx.click(); setView(v); } }}>
                    {v === "ideas" ? "Ideas" : "Lists"}
                  </button>
                ))}
              </div>
            </div>
            <p className="dx-hint">{view === "ideas" ? "Drag a card anywhere, even onto your to-do list" : "Every list, side by side"}<span>{view === "ideas" ? "Double click to edit. Right click for colours and effects" : "Double click a name to rename it. Arrows reorder"}</span><span>Esc to go back</span></p>
          </header>
          <Board prio={prio} aware={aware} dimx={dimx} inbox={inbox} ready={ready} escRef={boardEsc} view={view} onClose={close} />
        </div>
      </section>
    </div>
  );

  return (
    <>
      <div ref={dock} className="dx-dock" onMouseDown={(e) => e.stopPropagation()}>
        <button ref={btn} type="button" className={`dx-x${hot ? " hot" : ""}${phase !== "closed" ? " on" : ""}`} style={{ ["--dwell" as string]: `${DWELL_MS}ms` }}
          // Opens only on a click (the developer, 23 Oct 2026); hovering just grows the X into its label.
          onMouseEnter={() => { setHot(true); sfx.hover(); }}
          onMouseLeave={() => setHot(false)}
          onClick={open} aria-expanded={phase === "open"} aria-label="Open Dimension X" title="Dimension X">
          <span className="dx-x-mark" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </span>
          <span className="dx-x-l">Dimension X</span>
          {inbox.length > 0 && phase === "closed" ? <span className="dx-x-ai num" aria-label={`${inbox.length} in the ${INBOX_NAME}`} title={`${inbox.length} in the ${INBOX_NAME}`}>{inbox.length > 99 ? "99+" : inbox.length}</span> : null}
        </button>
      </div>
      {windowEl && host && createPortal(windowEl, host)}
    </>
  );
}

// The title, in the Stranger Things logo style: big first and last letters, red outline and glow,
// thin bars above and below, the X sitting in the gap of the lower bar.
function Logo() {
  return (
    <h2 className="dx-logo" aria-label="Dimension X">
      <span className="dx-l1" aria-hidden="true"><b>D</b><span className="dx-mid">IMENSIO</span><b>N</b></span>
      <span className="dx-l2" aria-hidden="true"><i /><span>X</span><i /></span>
    </h2>
  );
}

// ---------- the storm behind everything: slow red clouds, random lightning ----------
function Storm() {
  const svg = useRef<SVGSVGElement>(null), flash = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reduced()) return;
    let t = 0;
    const strike = () => {
      const s = svg.current, f = flash.current;
      if (!s || !f) return;
      const W = s.clientWidth, H = s.clientHeight;
      if (W > 50 && H > 50) {
        const x0 = W * (0.04 + Math.random() * 0.92);
        const end = H * (0.3 + Math.random() * 0.55);
        const pts: [number, number][] = [[x0, -8]];
        let x = x0, y = -8;
        while (y < end) { y += 12 + Math.random() * 30; x += (Math.random() - 0.5) * 50; pts.push([x, y]); }
        const d = (p: [number, number][]) => p.map(([a, b], i) => `${i ? "L" : "M"}${a.toFixed(1)} ${b.toFixed(1)}`).join("");
        // A side branch from somewhere along the bolt.
        const from = pts[Math.floor(pts.length * (0.3 + Math.random() * 0.4))];
        const br: [number, number][] = [from];
        let bx = from[0], by = from[1];
        const side = Math.random() < 0.5 ? -1 : 1;
        for (let i = 0; i < 4 + Math.floor(Math.random() * 4); i++) { by += 10 + Math.random() * 22; bx += side * (8 + Math.random() * 26); br.push([bx, by]); }
        s.querySelectorAll<SVGPathElement>("path.m").forEach((p) => p.setAttribute("d", d(pts)));
        s.querySelectorAll<SVGPathElement>("path.b").forEach((p) => p.setAttribute("d", d(br)));
        s.animate([{ opacity: 0 }, { opacity: 0.9, offset: 0.05 }, { opacity: 0.15, offset: 0.13 }, { opacity: 0.75, offset: 0.2 }, { opacity: 0 }],
          { duration: 700, easing: "ease-out" });
        f.style.setProperty("--fx", `${((x0 / W) * 100).toFixed(1)}%`);
        f.animate([{ opacity: 0 }, { opacity: 0.6, offset: 0.05 }, { opacity: 0.12, offset: 0.14 }, { opacity: 0.45, offset: 0.22 }, { opacity: 0 }],
          { duration: 1000, easing: "ease-out" });
      }
      t = window.setTimeout(strike, 2400 + Math.random() * 5600);
    };
    t = window.setTimeout(strike, 1100);
    // The PS self test holds one strike still to take its picture.
    const test = (e: Event) => {
      const s = svg.current, f = flash.current;
      if (!s || !f) return;
      if ((e as CustomEvent).detail === "hold") { clearTimeout(t); strike(); clearTimeout(t); s.getAnimations().forEach((a) => a.cancel()); f.getAnimations().forEach((a) => a.cancel()); s.style.opacity = ".9"; f.style.opacity = ".55"; }
      else { s.style.opacity = ""; f.style.opacity = ""; }
    };
    window.addEventListener("dx-strike", test);
    return () => { clearTimeout(t); window.removeEventListener("dx-strike", test); };
  }, []);
  return (
    <div className="dx-sky" aria-hidden="true">
      <i className="dx-cloud c1" /><i className="dx-cloud c2" /><i className="dx-cloud c3" /><i className="dx-cloud c4" />
      <div ref={flash} className="dx-flash" />
      <svg ref={svg} className="dx-bolt" width="100%" height="100%">
        <path className="m glow" /><path className="b glow" /><path className="m core" /><path className="b core thin" />
      </svg>
    </div>
  );
}

// Drifting spores in The Upside Down (fixed positions, so every render is the same).
const SPORES = Array.from({ length: 26 }, (_, i) => {
  const r = (n: number) => { const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
  return { left: `${(r(1) * 100).toFixed(1)}%`, top: `${(r(2) * 100).toFixed(1)}%`, size: 2 + r(3) * 3.5, dur: 9 + r(4) * 12, delay: -r(5) * 20, drift: (r(6) - 0.5) * 60 };
});

// The Upside Down's vines creeping in from the corners (faint, behind the cards).
function Vines() {
  return (
    <svg className="dx-vines" viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true">
      <path d="M600 30 C540 40 520 90 470 95 S400 70 360 120 S300 190 250 200" />
      <path d="M600 110 C560 105 545 140 505 150 S455 185 430 200" />
      <path d="M470 95 C470 70 440 55 420 40" />
      <path d="M0 200 C30 170 70 175 95 150 S130 120 160 135" />
      <path d="M360 120 C380 140 375 165 395 180" />
      <path d="M95 150 C90 125 60 115 45 95" />
    </svg>
  );
}

// ---------- the bands and lists: every card can be dragged anywhere ----------
type Drag = { card: Card; to: Zone | null; index: number; w: number; h: number };

function Board({ prio, aware, dimx, inbox, ready, escRef, view, onClose }: {
  prio: Doc<Todo>[]; aware: AwareItem[]; dimx: DimxItem[]; inbox: Doc<Todo>[]; ready: boolean; escRef: React.MutableRefObject<() => boolean>;
  view: "ideas" | "lists"; onClose: () => void;
}) {
  const typedOn = typedPrioOn(settingsData(useVault()));
  const [hold, setHold] = useState<Hold | null>(null);
  useEffect(() => {
    if (!hold) return;
    const t = window.setTimeout(() => setHold(null), Math.max(0, hold.until - Date.now()));
    return () => clearTimeout(t);
  }, [hold]);
  const realPrio = useMemo<PrioView[]>(() => prio.map((d) => ({ id: d.id, title: d.data.title, due: d.data.due, p1: !!d.data.p1, unranked: !!d.data.unranked, ai: d.data.ai === true })), [prio]);
  const realAi = useMemo<PrioView[]>(() => inbox.map((d) => ({ id: d.id, title: d.data.title, due: d.data.due, ai: true })), [inbox]);
  const live = hold && hold.until > Date.now() ? hold : null;
  const v: View = { dimx: live?.dimx ?? dimx, prio: live?.prio ?? realPrio, ai: live?.ai ?? realAi };
  const vRef = useRef(v);
  vRef.current = v;
  const prioDocs = useRef(new Map<string, Doc<Todo>>());
  prioDocs.current = new Map(prio.map((d) => [d.id, d]));
  const aiDocs = useRef(new Map<string, Doc<Todo>>());
  aiDocs.current = new Map(inbox.map((d) => [d.id, d]));
  const [moveFor, setMoveFor] = useState<{ id: string; at: DOMRect } | null>(null);
  // The latest lists change at once too, so quick changes in a row (several style picks, a delete
  // right after a move) each build on the one before instead of on the last render.
  const keep = (p: Partial<View>) => {
    vRef.current = { ...vRef.current, ...p };
    setHold((h) => ({ ...(h && h.until > Date.now() ? h : {}), ...p, until: Date.now() + HOLD_MS }));
  };

  const cards = useMemo(() => {
    const m: Record<Zone, Card[]> = { act: [], soon: [], x: [], prio: [], ai: [] };
    for (const d of v.dimx) if (isBand(d.zone)) m[d.zone].push({ key: `d:${d.id}`, id: d.id, text: d.text, zone: d.zone, style: d.style });
    for (const p of v.prio) m.prio.push({ key: `p:${p.id}`, id: p.id, text: p.title, zone: "prio", due: p.due, pending: p.pending, ai: p.ai });
    for (const p of v.ai) m.ai.push({ key: `a:${p.id}`, id: p.id, text: p.title, zone: "ai", due: p.due, pending: p.pending, ai: true });
    return m;
  }, [v.dimx, v.prio, v.ai]);

  // Urgent is gone (V1.40). Anything still on the old Urgent list (settings.aware, eg from an older
  // PS on another device) moves to the top of Actionables when the board opens: first added there
  // (same id and text), then taken off the old list. Saves run one at a time in that order, and an
  // id already in Dimension X is never added twice, so a half done move only leaves a copy behind.
  useEffect(() => {
    if (!ready || !aware.length) return;
    const cur = vRef.current;
    const have = new Set(cur.dimx.map((x) => x.id));
    const moved: DimxItem[] = aware.filter((a) => !have.has(a.id))
      .map((a) => ({ id: a.id, text: a.text.slice(0, 500), zone: "act", createdAt: a.createdAt || nowIso() }));
    if (moved.length) {
      const next = [...moved, ...cur.dimx];
      keep({ dimx: next });
      void taskMapActions.dimx(next);
    }
    void taskMapActions.aware([]);
  }, [ready, aware]); // eslint-disable-line react-hooks/exhaustive-deps

  // PS 1.68: each time the board opens, a move that was cut in half (the same id as a card and as a task) is finished.
  useEffect(() => { if (ready) void taskMapActions.dimxTidy(); }, [ready]);

  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [editKey, setEditKey] = useState<string | null>(null);
  const cancelDrag = useRef<(() => void) | null>(null);
  const cancelEdit = useRef<(() => void) | null>(null);
  // Selection (a click), the style menu, and the last card deleted (Undo).
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ key: string; at: DOMRect } | null>(null);
  const [undo, setUndo] = useState<{ text: string; verb: string; restore: () => void } | null>(null);
  const hovered = useRef<string | null>(null);
  escRef.current = () => {
    if (cancelDrag.current) { cancelDrag.current(); return true; }
    if (listsEscape()) return true;
    if (moveFor) { setMoveFor(null); return true; }
    if (menu) { setMenu(null); return true; }
    if (editKey) { cancelEdit.current?.(); setEditKey(null); return true; }
    return false;
  };

  /** The task order value for a drop at `index` (counted on screen, cards still on their way included). */
  const orderAt = (index: number) => {
    const shown = vRef.current.prio;
    const ranked = shown.filter((p) => !p.pending).map((p) => prioDocs.current.get(p.id)).filter((d): d is Doc<Todo> => !!d);
    return orderForPriority(ranked, shown.slice(0, index).filter((p) => !p.pending).length + 1);
  };

  /** Moves a card and saves it. Returns the key the card has where it lands. */
  const moveCard = (card: Card, to: Zone, index: number): string => {
    const cur = vRef.current, from = card.zone;
    if (from === "ai") return moveFromInbox(card, to, index);
    if (isBand(from) && isBand(to)) {
      const item = cur.dimx.find((x) => x.id === card.id);
      if (!item) return card.key;
      const next = insertDimx(cur.dimx, { ...item, zone: to }, index);
      keep({ dimx: next });
      void taskMapActions.dimx(next);
      return card.key;
    }
    if (from === to && to === "prio") {
      const moved = cur.prio.find((p) => p.id === card.id);
      if (!moved) return card.key;
      // Priority 1 follows the Tab list's rule: among (or above) the P1 cards it is P1, below them not.
      const p1 = new Set(cur.prio.filter((p) => p.p1).map((p) => p.id));
      const ids = insertAt(cur.prio.filter((p) => p.id !== card.id), moved, index).map((p) => p.id);
      const on = p1AfterMove(ids, card.id, p1);
      const next = insertAt(cur.prio.filter((p) => p.id !== card.id), { ...moved, p1: on }, index);
      keep({ prio: next });
      void taskMapActions.reorder(next.filter((p) => !p.pending).map((p) => p.id), on !== p1.has(card.id) ? { id: card.id, on } : undefined);
      return card.key;
    }
    // Across (PS 1.68, core/dimxmove.ts): ONE move that keeps the item's id. The page holding the vault writes the new
    // place first and then takes the old one away; a move sent twice, or cut in half, never leaves two copies.
    const text = card.text.trim();
    if (isBand(to) && from === "prio") {
      if (!prioDocs.current.has(card.id)) return card.key;
      keep({ dimx: insertDimx(cur.dimx, { id: card.id, text: text.slice(0, 500), zone: to, createdAt: nowIso() }, index), prio: cur.prio.filter((p) => p.id !== card.id) });
      void taskMapActions.toIdea(card.id, to, index);
      return `d:${card.id}`;
    }
    if (to === "prio" && isBand(from)) {
      const order = orderAt(index);
      // Dropped among the Priority 1 cards: it joins that group.
      const p1 = index < cur.prio.filter((p) => p.p1).length;
      keep({ prio: insertAt(cur.prio.filter((p) => p.id !== card.id), { id: card.id, title: text, pending: true, p1 }, index), dimx: cur.dimx.filter((x) => x.id !== card.id) });
      void taskMapActions.toTask(card.id, { order, p1 });
      return `p:${card.id}`;
    }
    return card.key;
  };

  /** A task out of the AI Inbox (core/aiinbox.ts): onto Your task list it keeps its id and its AI badge and only
   *  leaves the inbox; onto a band it becomes an idea card and the task goes. Within the inbox: a new order. */
  const moveFromInbox = (card: Card, to: Zone, index: number): string => {
    const cur = vRef.current;
    const moved = cur.ai.find((p) => p.id === card.id);
    if (!moved) return card.key;
    const rest = cur.ai.filter((p) => p.id !== card.id);
    if (to === "ai") {
      const next = insertAt(rest, moved, index);
      const orders = cur.ai.map((p) => aiDocs.current.get(p.id)?.data.order ?? 0).sort((a, b) => a - b);
      keep({ ai: next });
      next.forEach((p, i) => { const d = aiDocs.current.get(p.id); if (d && d.data.order !== orders[i]) void taskMapActions.update(p.id, { order: orders[i] }); });
      return card.key;
    }
    if (to === "prio") {
      const p1 = index < cur.prio.filter((p) => p.p1).length;
      keep({ ai: rest, prio: insertAt(cur.prio, { ...moved, pending: true, p1 }, index) });
      void taskMapActions.update(card.id, { aiInbox: false, group: null, order: orderAt(index), p1, unranked: false });
      return `p:${card.id}`;
    }
    if (!isBand(to)) return card.key;
    // A move, not a delete: the card keeps the task's id (core/dimxmove.ts), one op for the page holding the vault.
    keep({ dimx: insertDimx(cur.dimx, { id: card.id, text: card.text.trim().slice(0, 500), zone: to, createdAt: nowIso() }, index), ai: rest });
    void taskMapActions.toIdea(card.id, to, index);
    return `d:${card.id}`;
  };
  /** An inbox task deleted, with Undo (it comes back with everything it had). */
  const removeInbox = (card: Card) => {
    const d = aiDocs.current.get(card.id);
    if (!d) return;
    sfx.click();
    keep({ ai: vRef.current.ai.filter((p) => p.id !== card.id) });
    void taskMapActions.remove(card.id);
    setUndo({ text: card.text, verb: "Deleted", restore: () => { void taskMapActions.restore(d.id, d.data); keep({ ai: [...vRef.current.ai, { id: d.id, title: d.data.title, due: d.data.due, ai: true }] }); } });
  };

  // ---------- smooth moves: every card slides from where it was to where it is (FLIP) ----------
  const board = useRef<HTMLDivElement>(null);
  const rects = useRef(new Map<string, DOMRect>());
  const landing = useRef<{ key: string; rect: DOMRect; tilt: number } | null>(null);
  const settled = useRef(false);
  const measure = () => {
    const next = new Map<string, DOMRect>();
    board.current?.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => next.set(el.dataset.k!, el.getBoundingClientRect()));
    rects.current = next;
  };
  useLayoutEffect(() => {
    const root = board.current;
    if (!root) return;
    // While the window is still growing out of the X, positions are scaled: just note them.
    if (!ready) { settled.current = false; return; }
    if (!settled.current) { settled.current = true; measure(); return; }
    const calm = reduced();
    const land = landing.current;
    landing.current = null;
    const next = new Map<string, DOMRect>();
    root.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => {
      const k = el.dataset.k!;
      const vis = el.getBoundingClientRect();
      const running = el.getAnimations().filter((a) => a.id === "dx-flip");
      running.forEach((a) => a.cancel());
      const r = running.length ? el.getBoundingClientRect() : vis;
      next.set(k, r);
      if (calm) return;
      if (land && land.key === k) {
        el.animate([{ transform: `translate(${land.rect.left - r.left}px, ${land.rect.top - r.top}px) rotate(${land.tilt}deg) scale(1.04)` }, { transform: "none" }],
          { duration: 420, easing: EASE_CSS, id: "dx-flip" });
        return;
      }
      const prev = rects.current.get(k);
      if (!prev) { el.animate([{ opacity: 0, transform: "scale(.86)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE_CSS, id: "dx-flip" }); return; }
      // From where it showed a moment ago (mid slide included) to its new place.
      const dx = prev.left + (vis.left - r.left) - r.left, dy = prev.top + (vis.top - r.top) - r.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 360, easing: EASE_CSS, id: "dx-flip" });
    });
    rects.current = next;
  });
  // Scrolling a band or the window resizing moves cards without a render: note where they are now.
  useEffect(() => {
    let raf = 0;
    const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (settled.current) measure(); }); };
    const root = board.current;
    root?.addEventListener("scroll", later, true);
    window.addEventListener("resize", later);
    return () => { root?.removeEventListener("scroll", later, true); window.removeEventListener("resize", later); cancelAnimationFrame(raf); };
  }, []);

  // ---------- dragging ----------
  /** Which list is under the pointer and where in it a drop would go. */
  const hit = (x: number, y: number): { zone: Zone; index: number } | null => {
    const root = board.current;
    if (!root) return null;
    for (const z of root.querySelectorAll<HTMLElement>("[data-zone]")) {
      if (z.dataset.zone === "ai" && dragRef.current?.card.zone !== "ai") continue;   // nothing goes INTO the AI Inbox by hand
      const r = z.getBoundingClientRect();
      if (x < r.left - 6 || x > r.right + 6 || y < r.top - 6 || y > r.bottom + 6) continue;
      const wrap = z.dataset.layout === "wrap";
      let index = 0;
      z.querySelectorAll<HTMLElement>("[data-k]").forEach((el) => {
        const c = rects.current.get(el.dataset.k!) ?? el.getBoundingClientRect();
        const before = wrap ? y > c.bottom || (y >= c.top && x > c.left + c.width / 2) : y > c.top + c.height / 2;
        if (before) index++;
      });
      return { zone: z.dataset.zone as Zone, index };
    }
    return null;
  };

  const startDrag = (e: React.PointerEvent<HTMLElement>, card: Card) => {
    if (e.button !== 0 || card.pending || editKey === card.key || (e.target as Element).closest("button, input, textarea, a")) return;
    const src = e.currentTarget.getBoundingClientRect();
    // Touch (PS GOS): the card leaves the page while it is dragged, but a touch keeps sending its moves to it, so hold them here or the page scrolls and cancels the drag.
    const held = e.currentTarget, still = (t: TouchEvent) => { if (t.cancelable) t.preventDefault(); };
    held.addEventListener("touchmove", still, { passive: false });
    const sx = e.clientX, sy = e.clientY;
    let x = sx, y = sy, lastX = sx, tilt = 0, raf = 0;
    let ghost: HTMLDivElement | null = null;
    const offX = sx - src.left, offY = sy - src.top;
    const scrollerAt = () => {
      const z = hit(x, y);
      if (!z) return null;
      const el = board.current?.querySelector<HTMLElement>(`[data-zone="${z.zone}"] [data-scroll]`);
      if (!el || el.scrollHeight <= el.clientHeight + 2) return null;
      const r = el.getBoundingClientRect();
      const edge = 42;
      const sp = y < r.top + edge ? -Math.pow((r.top + edge - y) / edge, 2) * 14 : y > r.bottom - edge ? Math.pow((y - (r.bottom - edge)) / edge, 2) * 14 : 0;
      return sp ? { el, sp: Math.max(-14, Math.min(14, sp)) } : null;
    };
    const frame = () => {
      raf = 0;
      if (!ghost) return;
      tilt += (Math.max(-7, Math.min(7, (x - lastX) * 0.5)) - tilt) * 0.22;
      lastX = x;
      ghost.style.transform = `translate3d(${x - offX}px, ${y - offY}px, 0) rotate(${tilt.toFixed(2)}deg) scale(1.04)`;
      const sc = scrollerAt();
      if (sc) { sc.el.scrollTop += sc.sp; measure(); }
      const t = hit(x, y);
      const d = dragRef.current;
      if (d && ((t?.zone ?? null) !== d.to || (t && t.index !== d.index))) {
        const nd = { ...d, to: t?.zone ?? null, index: t?.index ?? 0 };
        dragRef.current = nd;
        setDrag(nd);
        if (t) sfx.hover();
        ghost.classList.toggle("lost", !t);
      }
      if (Math.abs(tilt) > 0.05 || sc) raf = requestAnimationFrame(frame);
    };
    const onMove = (ev: PointerEvent) => {
      x = ev.clientX; y = ev.clientY;
      if (!ghost) {
        if (Math.hypot(x - sx, y - sy) < 5) return;
        ghost = document.createElement("div");
        ghost.className = `dx-ghost z-${card.zone} ${sizeCls(card.style)}`;
        ghost.style.width = `${src.width}px`;
        const tx = document.createElement("span");
        tx.className = `dx-tx ${textCls(card.style)}`;
        tx.textContent = card.text;
        ghost.appendChild(tx);
        document.body.appendChild(ghost);
        document.documentElement.classList.add("dx-dragging");
        sfx.click();
        const index = cards[card.zone].findIndex((c) => c.key === card.key);
        const nd: Drag = { card, to: card.zone, index: Math.max(0, index), w: src.width, h: src.height };
        dragRef.current = nd;
        setDrag(nd);
        cancelDrag.current = () => end(null);
      }
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const end = (ev: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      held.removeEventListener("touchmove", still);
      cancelAnimationFrame(raf);
      cancelDrag.current = null;
      document.documentElement.classList.remove("dx-dragging");
      const g = ghost;
      ghost = null;
      // No drag: it was a click, which selects a band card (Backspace then deletes it).
      if (!g) { if (ev?.type === "pointerup" && isBand(card.zone)) setSel(card.key); return; }
      const d = dragRef.current;
      const rect = new DOMRect(x - offX, y - offY, src.width, src.height);
      // Let go over a list: it lands there. Anywhere else (or Esc): it flies back home.
      const dropped = !!(ev && ev.type === "pointerup" && d?.to);
      const key = dropped ? moveCard(d!.card, d!.to!, d!.index) : card.key;
      if (dropped) window.setTimeout(() => sfx.plop(), 120);
      landing.current = { key, rect, tilt };
      dragRef.current = null;
      setDrag(null);
      g.remove();
    };
    const cancel = () => end(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  };

  // ---------- typing new things in, editing, removing ----------
  const addTo = (zone: Zone, text: string, prio?: PrioNum, when?: ParsedTask | null, remind?: TimeRemind | null) => {
    const due = when?.kind === "once" ? when.due : null;   // PS 1.65: a date typed in plain words (core/nldates.ts)
    const r = remind ? { remind } : {};
    const t = text.trim();
    if (!t) return;
    const cur = vRef.current;
    sfx.drop();
    if (isBand(zone)) {
      const next = [...cur.dimx, { id: uid(), text: t.slice(0, 500), zone, createdAt: nowIso() }];
      keep({ dimx: next });
      void taskMapActions.dimx(next);
    } else {
      if (prio) {
        // Typed P1, P2 or P3 (core/typedprio.ts): in at that priority, shown there straight away.
        const real = cur.prio.filter((p) => !p.pending).map((p) => prioDocs.current.get(p.id)?.data).filter((d): d is Todo => !!d);
        const at = typedOrder(real, prio);
        const group = cur.prio.filter((p) => p.p1).length;
        const numbered = cur.prio.filter((p) => !p.p1 && !p.unranked).length;
        const index = at.p1 ? group : group + Math.min(prio - 2, numbered);
        keep({ prio: insertAt(cur.prio, { id: `pending-${uid()}`, title: t, pending: true, p1: at.p1 }, index) });
        void taskMapActions.add({ title: t.slice(0, 500), due, type: "once", order: at.order, p1: at.p1, ...r });
        return;
      }
      const order = orderAt(cur.prio.length);
      keep({ prio: [...cur.prio, { id: `pending-${uid()}`, title: t, pending: true }] });
      void taskMapActions.add({ title: t.slice(0, 500), due, type: "once", order, ...r });
    }
  };
  const rename = (card: Card, text: string) => {
    const t = text.trim();
    setEditKey(null);
    if (!t || t === card.text) return;
    const cur = vRef.current;
    if (isBand(card.zone)) { const next = cur.dimx.map((x) => (x.id === card.id ? { ...x, text: t.slice(0, 500) } : x)); keep({ dimx: next }); void taskMapActions.dimx(next); }
    else if (card.zone === "ai") { keep({ ai: cur.ai.map((p) => (p.id === card.id ? { ...p, title: t } : p)) }); void taskMapActions.update(card.id, { title: t.slice(0, 500) }); }
    else {
      // V1.57: P1, P2 or P3 typed into the name while editing sets the priority, as in Add task (core/typedprio.ts).
      const typed = typedOn ? renamedPrio(card.text, t) : null;
      if (typed && typed.title) {
        const ranked = cur.prio.filter((p) => !p.pending).map((p) => ({ id: p.id, ...(prioDocs.current.get(p.id)?.data ?? {}) })) as { id: string; order?: number; p1?: boolean; unranked?: boolean }[];
        const at = typedEdit(ranked, card.id, typed.prio);
        const title = typed.title.slice(0, 500);
        if (!at) { keep({ prio: cur.prio.map((p) => (p.id === card.id ? { ...p, title } : p)) }); void taskMapActions.update(card.id, { title }); return; }
        const me = cur.prio.find((p) => p.id === card.id);
        const rest = cur.prio.filter((p) => p.id !== card.id);
        const group = rest.filter((p) => p.p1).length, numbered = rest.filter((p) => !p.p1 && !p.unranked).length;
        const index = at.p1 ? group : group + Math.min(typed.prio - 2, numbered);
        keep({ prio: insertAt(rest, { ...(me ?? { id: card.id }), title, p1: at.p1, unranked: false }, index) });
        void taskMapActions.update(card.id, { title, p1: at.p1, order: at.order, unranked: false });
        return;
      }
      keep({ prio: cur.prio.map((p) => (p.id === card.id ? { ...p, title: t } : p)) }); void taskMapActions.update(card.id, { title: t.slice(0, 500) });
    }
  };
  /** A band card goes: it shrinks away, the others close the gap, and Undo can bring it back. */
  const removeCard = (card: Card) => {
    const cur = vRef.current;
    const index = cur.dimx.findIndex((x) => x.id === card.id);
    if (index < 0) return;
    const item = cur.dimx[index];
    sfx.click();
    setMenu((m) => (m?.key === card.key ? null : m));
    setSel((s) => (s === card.key ? null : s));
    if (hovered.current === card.key) hovered.current = null;
    const commit = () => {
      const next = vRef.current.dimx.filter((x) => x.id !== card.id);
      keep({ dimx: next });
      void taskMapActions.dimx(next);
      setUndo({ text: item.text, verb: "Deleted", restore: () => {
        const now = vRef.current.dimx;
        if (now.some((x) => x.id === item.id)) return;
        const back = [...now.slice(0, index), item, ...now.slice(index)];
        keep({ dimx: back });
        void taskMapActions.dimx(back);
      } });
    };
    const el = board.current?.querySelector<HTMLElement>(`[data-k="${CSS.escape(card.key)}"]`);
    if (!el || reduced()) { commit(); return; }
    el.style.pointerEvents = "none";
    el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.8) translateY(6px)" }],
      { duration: 210, easing: "cubic-bezier(.5,0,.75,0)", fill: "forwards" }).finished.then(commit, commit);
  };
  const restore = () => {
    const u = undo;
    if (!u) return;
    setUndo(null);
    u.restore();
    sfx.drop();
  };
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), 6000);
    return () => clearTimeout(t);
  }, [undo]);
  /** The style menu: each change shows on the card straight away and is saved. */
  const restyle = (card: Card, patch: Partial<DimxStyle> | null) => {
    const cur = vRef.current;
    const next = cur.dimx.map((x) => {
      if (x.id !== card.id) return x;
      const style = tidyStyle(patch ? { ...(x.style || {}), ...patch } : {});
      const { style: _old, ...rest } = x;
      return style ? { ...rest, style } : rest;
    });
    keep({ dimx: next });
    void taskMapActions.dimx(next);
  };

  // Keys while Dimension X is open and the developer is not typing: Backspace or Delete removes the selected
  // card (or the one under the mouse), Enter edits it, Cmd+Z brings back the last one removed.
  const keyFns = useRef({ removeCard, restore, undo, sel, cards });
  keyFns.current = { removeCard, restore, undo, sel, cards };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const a = document.activeElement as HTMLElement | null;
      const typing = !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
      if (typing || dragRef.current) return;
      const f = keyFns.current;
      const find = (k: string | null) => (k ? [...f.cards.act, ...f.cards.soon, ...f.cards.x].find((c) => c.key === k) : undefined);
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z" && f.undo) {
        e.preventDefault(); e.stopImmediatePropagation(); f.restore();
      } else if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.ctrlKey) {
        const c = find(f.sel) ?? find(hovered.current);
        if (c) { e.preventDefault(); e.stopImmediatePropagation(); f.removeCard(c); }
      } else if (e.key === "Enter" && f.sel && find(f.sel)) {
        e.preventDefault(); setEditKey(f.sel);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

  const drop = (card: Card) => {
    const cur = vRef.current;
    if (isBand(card.zone)) { sfx.click(); const next = cur.dimx.filter((x) => x.id !== card.id); keep({ dimx: next }); void taskMapActions.dimx(next); }
    else if (card.zone === "ai") { sfx.done(); keep({ ai: cur.ai.filter((p) => p.id !== card.id) }); void taskMapActions.tick(card.id, true); }
    else { sfx.done(); keep({ prio: cur.prio.filter((p) => p.id !== card.id) }); void taskMapActions.tick(card.id); }
  };

  /** One list's cards, with the gap where a dragged card would land. */
  const listOf = (zone: Zone, render: (c: Card, i: number) => React.ReactNode) => {
    const list = cards[zone].filter((c) => c.key !== drag?.card.key);
    const out: React.ReactNode[] = list.map((c, i) => render(c, i));
    if (drag && drag.to === zone) {
      const band = isBand(zone);
      out.splice(Math.min(drag.index, out.length), 0,
        <div key="__gap" className={`dx-gap${band ? "" : " row"}`} style={band ? { width: drag.w, height: drag.h } : { height: drag.h }} aria-hidden="true" />);
    }
    return out;
  };
  const cardProps = (c: Card) => ({
    "data-k": c.key,
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => startDrag(e, c),
    onDoubleClick: (e: React.MouseEvent) => { if (!c.pending && !(e.target as Element).closest("button")) { setMenu(null); setEditKey(c.key); } },
    onMouseEnter: () => { hovered.current = c.key; if (!drag) sfx.hover(); },
    onMouseLeave: () => { if (hovered.current === c.key) hovered.current = null; },
    // PS GOS: the touch layer keeps a finger's press from the board until it is a hold, so a tap selects through its click.
    onClick: (e: React.MouseEvent) => { if (isBand(c.zone) && document.documentElement.classList.contains("gos") && !(e.target as Element).closest("button, input")) setSel(c.key); },
  });
  const textOf = (c: Card) => editKey === c.key
    ? <EditBox text={c.text} onDone={(t) => rename(c, t)} cancelRef={cancelEdit} />
    : <span className={`dx-t${c.style?.highlight ? ` hl hl-${c.style.highlight}` : ""}`}><span className={`dx-tx ${textCls(c.style)}`}>{c.text}</span></span>;
  const openMenu = (c: Card, at: DOMRect) => {
    const b = board.current?.getBoundingClientRect();
    if (!b) return;
    sfx.click();
    setEditKey(null);
    setSel(c.key);
    setMenu({ key: c.key, at: new DOMRect(at.left - b.left, at.top - b.top, at.width, at.height) });
  };
  const menuCard = menu ? [...cards.act, ...cards.soon, ...cards.x].find((c) => c.key === menu.key) : undefined;

  // P numbers as in the Tab list: the Priority 1 group shows P1, the rest count on from P2.
  const p1Of = new Map(v.prio.map((p) => [p.id, !!p.p1]));
  const unrankedOf = new Map(v.prio.map((p) => [p.id, !!p.unranked]));
  const prioN = new Map([...prioNumbers(cards.prio.map((c) => ({ id: c.key, p1: !!p1Of.get(c.id), unranked: !!unrankedOf.get(c.id) })))]);
  return (
    <div ref={board} className={`dx-grid${drag ? " is-dragging" : ""}${view === "lists" ? " lists" : ""}`}
      onPointerDown={(e) => { if (!(e.target as Element).closest("[data-k], .dx-menu, .dx-toast, .dl-menu")) { setSel(null); setMenu(null); } }}>
      {view === "lists" ? <DimxLists onOpen={onClose} onUndo={(text, restore) => setUndo({ text, verb: "Deleted", restore })} /> : (
      <div className="dx-bands">
        {BANDS.map((b) => (
          <section key={b.zone} className={`dx-band z-${b.zone}${drag?.to === b.zone ? " target" : ""}`} data-zone={b.zone} data-layout="wrap" aria-label={b.title}>
            {b.zone === "soon" && <Vines />}
            {b.zone === "x" && <span className="dx-wm" aria-hidden="true">X</span>}
            {b.zone === "soon" && <div className="dx-spores" aria-hidden="true">{SPORES.map((s, i) => (
              <i key={i} style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDuration: `${s.dur}s`, animationDelay: `${s.delay}s`, ["--drift" as string]: `${s.drift}px` }} />
            ))}</div>}
            <header className="dx-band-h">
              <h3 className="dx-band-t" data-t={b.title}>{b.title}</h3>
              <span className="dx-band-n num">{cards[b.zone].length}</span>
              <span className="dx-band-s">{b.sub}</span>
            </header>
            <div className="dx-cards" data-scroll>
              {listOf(b.zone, (c) => (
                <div key={c.key} className={`dx-card ${sizeCls(c.style)}${editKey === c.key ? " editing" : ""}${sel === c.key ? " sel" : ""}${menu?.key === c.key ? " menu-on" : ""}`} {...cardProps(c)}
                  onContextMenu={(e) => { e.preventDefault(); openMenu(c, e.currentTarget.getBoundingClientRect()); }}>
                  {textOf(c)}
                  {editKey !== c.key && (
                    <span className="dx-tools">
                      <button type="button" className="dx-tool" onClick={(e) => openMenu(c, (e.currentTarget.closest("[data-k]") as HTMLElement).getBoundingClientRect())}
                        aria-label={`Style: ${c.text}`} title="Style and effects">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 6.2l-1.4-1.4M3 21l9-9" /></svg>
                      </button>
                      <button type="button" className="dx-tool" onClick={() => { setMenu(null); setEditKey(c.key); }} aria-label={`Edit: ${c.text}`} title="Edit (double click, or Enter)">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
                      </button>
                      <button type="button" className="dx-tool del" onClick={() => removeCard(c)} aria-label={`Delete: ${c.text}`} title="Delete (Backspace)">×</button>
                    </span>
                  )}
                </div>
              ))}
              <AddBox placeholder={b.add} onAdd={(t) => addTo(b.zone, t)} />
            </div>
          </section>
        ))}
      </div>
      )}
      <aside className={`dx-rail${cards.ai.length || drag?.card.zone === "ai" ? " with-ai" : ""}`}>
        <section className={`dx-mini z-ai${drag?.to === "ai" ? " target" : ""}${cards.ai.length ? "" : " empty"}`} data-zone="ai" aria-label={INBOX_NAME}>
          <header className="dx-mini-h"><h3>{INBOX_NAME}</h3><span className="dx-band-n num">{cards.ai.length}</span>
            <span className="dx-mini-s">{cards.ai.length ? "Tasks an AI added. Drag them onto your list or a band, or send them anywhere." : "Tasks an AI adds through Settings, AI task API land here."}</span></header>
          {cards.ai.length > 0 || drag?.card.zone === "ai" ? (
            <div className="dx-rows" data-scroll>
              {listOf("ai", (c) => (
                <div key={c.key} className={`dx-row ai${c.pending ? " pending" : ""}${editKey === c.key ? " editing" : ""}`} {...cardProps(c)}>
                  <button type="button" className="dx-tick" onClick={() => drop(c)} disabled={c.pending} aria-label={`Tick off: ${c.text}`} title="Tick off">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
                  </button>
                  {textOf(c)}
                  <span className="dl-meta"><span className="dx-ai" title="Added by an AI">AI</span>{c.due && <span className="dx-due num">{fmtDate(c.due)}</span>}</span>
                  <span className={`dl-acts${moveFor?.id === c.id ? " on" : ""}`}>
                    <button type="button" className="dx-mv" onClick={(e) => { sfx.click(); const b = board.current?.getBoundingClientRect(), r = e.currentTarget.getBoundingClientRect(); if (b) setMoveFor((m) => (m?.id === c.id ? null : { id: c.id, at: new DOMRect(r.left - b.left, r.top - b.top, r.width, r.height) })); }}
                      aria-label={`Move: ${c.text}`} title="Move to a list" aria-expanded={moveFor?.id === c.id}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                    </button>
                    <button type="button" className="dx-del" onClick={() => removeInbox(c)} aria-label={`Delete: ${c.text}`} title="Delete">×</button>
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
        <section className={`dx-mini z-prio${drag?.to === "prio" ? " target" : ""}`} data-zone="prio" aria-label="Your task list">
          <header className="dx-mini-h"><h3>Your task list</h3><span className="dx-band-n num">{cards.prio.length}</span><span className="dx-mini-s">The same list as your Tab list.</span></header>
          <div className="dx-rows" data-scroll>
            {listOf("prio", (c) => (
              <div key={c.key} className={`dx-row${c.pending ? " pending" : ""}${editKey === c.key ? " editing" : ""}`} {...cardProps(c)}>
                <button type="button" className="dx-tick" onClick={() => drop(c)} disabled={c.pending} aria-label={`Tick off: ${c.text}`} title="Tick off">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
                </button>
                {textOf(c)}
                {c.ai && <span className="dx-ai" title="Added by an AI">AI</span>}
                {c.due && <span className="dx-due num">{fmtDate(c.due)}</span>}
                <span className="dx-p num">P{prioN.get(c.key)}</span>
              </div>
            ))}
            {!cards.prio.length && !(drag?.to === "prio") && <p className="dx-empty">Nothing on your list. Drag a card here.</p>}
          </div>
          <PrioAddBox placeholder="Add a task" onAdd={(t, p, w, r) => addTo("prio", t, p, w, r)} />
        </section>
      </aside>
      {menu && menuCard && (
        <StyleMenu key={menu.key} card={menuCard} at={menu.at} bounds={board.current} onStyle={(p) => restyle(menuCard, p)}
          onEdit={() => { setMenu(null); setEditKey(menuCard.key); }} onDelete={() => removeCard(menuCard)} onClose={() => setMenu(null)} />
      )}
      {moveFor && aiDocs.current.get(moveFor.id) && (
        <MoveMenu task={aiDocs.current.get(moveFor.id)!} at={moveFor.at} bounds={board.current} onClose={() => setMoveFor(null)}
          onBand={(zone) => { const c = cards.ai.find((x) => x.id === moveFor.id); setMoveFor(null); if (c) { landing.current = null; moveFromInbox(c, zone, cards[zone].length); sfx.drop(); } }}
          onMoved={() => { const id = moveFor.id; setMoveFor(null); keep({ ai: vRef.current.ai.filter((p) => p.id !== id) }); }} />
      )}
      {undo && (
        <div className="dx-toast" role="status">
          <span>{undo.verb} <b>{undo.text.length > 42 ? `${undo.text.slice(0, 40)}...` : undo.text}</b></span>
          <button type="button" onClick={restore}>Undo</button>
        </div>
      )}
    </div>
  );
}

// ---------- text style: classes for a card's style ----------
const textCls = (s?: DimxStyle) => !s ? "" : [s.fx && s.fx !== "none" ? `fx-${s.fx}` : "", s.color && s.color !== "white" ? `c-${s.color}` : "",
  s.bold ? "st-b" : "", s.italic ? "st-i" : "", s.underline ? "st-u" : "", s.strike ? "st-s" : "", s.caps ? "st-caps" : ""].filter(Boolean).join(" ");
const sizeCls = (s?: DimxStyle) => (s?.size && s.size !== "m" ? `sz-${s.size}` : "");
/** Only what differs from plain text is kept. */
function tidyStyle(s: DimxStyle): DimxStyle | undefined {
  const o: DimxStyle = {};
  if (s.fx && s.fx !== "none") o.fx = s.fx;
  if (s.color && s.color !== "white") o.color = s.color;
  if (s.size && s.size !== "m") o.size = s.size;
  if (s.highlight) o.highlight = s.highlight;
  for (const k of ["bold", "italic", "underline", "strike", "caps"] as const) if (s[k]) o[k] = true;
  return Object.keys(o).length ? o : undefined;
}
const FX: { v: NonNullable<DimxStyle["fx"]>; label: string }[] = [
  { v: "none", label: "None" }, { v: "glisten", label: "Glisten" }, { v: "glow", label: "Glow" },
  { v: "flicker", label: "Flicker" }, { v: "pulse", label: "Pulse" }, { v: "flip", label: "Flip" },
];
const COLOR_NAME: Record<(typeof DIMX_COLORS)[number], string> = { white: "White", red: "Red", purple: "Purple", pink: "Pink", gold: "Gold", ice: "Ice blue" };

/** The style menu under a card (its hover button or a right click). Every pick shows on the card at once. */
function StyleMenu({ card, at, bounds, onStyle, onEdit, onDelete, onClose }: {
  card: Card; at: DOMRect; bounds: HTMLElement | null; onStyle: (p: Partial<DimxStyle> | null) => void;
  onEdit: () => void; onDelete: () => void; onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !bounds) return;
    const W = bounds.clientWidth, H = bounds.clientHeight, w = el.offsetWidth, h = el.offsetHeight;
    const below = at.bottom + 8, above = at.top - 8 - h;
    const up = below + h > H && above >= 0;
    setPos({ left: Math.max(4, Math.min(W - w - 4, at.left)), top: up ? above : Math.max(4, Math.min(H - h - 4, below)), up });
  }, [at, bounds]);
  useEffect(() => {
    const out = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(`[data-k="${CSS.escape(card.key)}"]`)) onClose(); };
    window.addEventListener("pointerdown", out, true);
    return () => window.removeEventListener("pointerdown", out, true);
  }, [card.key, onClose]);
  const s = card.style || {};
  const set = (p: Partial<DimxStyle>) => { sfx.hover(); onStyle(p); };
  const flag = (k: "bold" | "italic" | "underline" | "strike" | "caps", label: React.ReactNode, title: string) => (
    <button type="button" className={`dx-opt sq${s[k] ? " on" : ""}`} aria-pressed={!!s[k]} title={title} onClick={() => set({ [k]: !s[k] })}>{label}</button>
  );
  return (
    <div ref={ref} className={`dx-menu${pos?.up ? " up" : ""}`} role="dialog" aria-label="Style this card"
      style={pos ? { left: pos.left, top: pos.top } : { left: at.left, top: at.bottom + 8, visibility: "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}>
      <div className="dx-menu-row top">
        <button type="button" className="dx-opt wide" onClick={onEdit}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>Edit text
        </button>
        <button type="button" className="dx-opt wide danger" onClick={onDelete}>Delete</button>
        <button type="button" className="dx-opt wide ghost" onClick={() => { sfx.click(); onStyle(null); }} title="Back to plain text">Reset</button>
      </div>
      <span className="dx-menu-h">Effect</span>
      <div className="dx-menu-row">
        {FX.map((f) => (
          <button key={f.v} type="button" className={`dx-opt${(s.fx || "none") === f.v ? " on" : ""}`} aria-pressed={(s.fx || "none") === f.v} onClick={() => set({ fx: f.v })}>
            <span className={`dx-tx ${f.v === "none" ? "" : `fx-${f.v}`} ${s.color && s.color !== "white" ? `c-${s.color}` : ""}`}>{f.label}</span>
          </button>
        ))}
      </div>
      <span className="dx-menu-h">Colour</span>
      <div className="dx-menu-row">
        {DIMX_COLORS.map((c) => (
          <button key={c} type="button" className={`dx-sw sw-${c}${(s.color || "white") === c ? " on" : ""}`} aria-pressed={(s.color || "white") === c}
            onClick={() => set({ color: c })} aria-label={COLOR_NAME[c]} title={COLOR_NAME[c]} />
        ))}
      </div>
      <span className="dx-menu-h">Text</span>
      <div className="dx-menu-row">
        {flag("bold", <b>B</b>, "Bold")}{flag("italic", <i>I</i>, "Italic")}{flag("underline", <u>U</u>, "Underline")}
        {flag("strike", <s>S</s>, "Strikethrough")}{flag("caps", "AA", "UPPERCASE")}
      </div>
      <span className="dx-menu-h">Size</span>
      <div className="dx-menu-row">
        {(["s", "m", "l", "xl"] as const).map((z) => (
          <button key={z} type="button" className={`dx-opt sq${(s.size || "m") === z ? " on" : ""}`} aria-pressed={(s.size || "m") === z} title={`Size ${z.toUpperCase()}`}
            onClick={() => set({ size: z })}>{z.toUpperCase()}</button>
        ))}
      </div>
      <span className="dx-menu-h">Highlight</span>
      <div className="dx-menu-row">
        <button type="button" className={`dx-sw sw-none${!s.highlight ? " on" : ""}`} aria-pressed={!s.highlight} onClick={() => set({ highlight: null })} aria-label="No highlight" title="No highlight" />
        {DIMX_COLORS.map((c) => (
          <button key={c} type="button" className={`dx-sw hl-sw sw-${c}${s.highlight === c ? " on" : ""}`} aria-pressed={s.highlight === c}
            onClick={() => set({ highlight: c })} aria-label={`${COLOR_NAME[c]} highlight`} title={`${COLOR_NAME[c]} highlight`} />
        ))}
      </div>
    </div>
  );
}

function AddBox({ placeholder, onAdd }: { placeholder: string; onAdd: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <input className="dx-add" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder}
      onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) { e.preventDefault(); onAdd(text); setText(""); } }} />
  );
}

/** The Add a task box under the list: P1, P2 or P3 typed in it sets the priority (core/typedprio.ts, V1.40). */
function PrioAddBox({ placeholder, onAdd }: { placeholder: string; onAdd: (t: string, prio?: PrioNum, when?: ParsedTask | null, remind?: TimeRemind | null) => void }) {
  const [text, setText] = useState("");
  const tp = useTypedPrio(text);
  // PS 1.65: a one-off date typed in plain words sets the due (this list holds no repeats).
  const nl = useNlDates(text, { once: true });
  return (
    <PrioInput prio={tp} nl={nl} compact wrapClass="dx-addw" className="dx-add" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} aria-label={placeholder}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        const when = nl.take(text);
        const base = when ? when.title : text;
        const typed = tp.take(base);
        const t = typed ? typed.title : base;
        if (!t.trim()) return;
        e.preventDefault();
        onAdd(t, typed?.prio, when, when?.time ? nl.reminderFor(when) : null);
        setText(""); tp.reset(); nl.reset();
      }} />
  );
}

function EditBox({ text, onDone, cancelRef }: { text: string; onDone: (t: string) => void; cancelRef: React.MutableRefObject<(() => void) | null> }) {
  const [v, setV] = useState(text);
  const done = useRef(false);
  cancelRef.current = () => { done.current = true; };
  const finish = (t: string) => { if (done.current) return; done.current = true; onDone(t); };
  return (
    <input className="dx-edit" autoFocus value={v} onChange={(e) => setV(e.target.value)} aria-label="Edit"
      onFocus={(e) => e.currentTarget.select()} onBlur={() => finish(v)}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); finish(v); } }} />
  );
}
