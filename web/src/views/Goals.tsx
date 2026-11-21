// Goals timeline: the developer's goals on three lanes that share one time line.
//   Macro: the big ones, across months (the year).   Meso: month by month.   Micro: week by week.
// Click an empty spot in a lane and a light ghost shows where a goal would go, with a "+ New goal" button: only that
// button, or Enter, adds it (Jan, PS 1.72: "right now when you just click once it already creates a task"). Drag the
// ghost's ends to change its days first; Esc or a click anywhere else puts it away. A goal closed with no name and no
// notes is not kept. Drag a goal to move it, drag its ends to stretch it; click it to rename, recolour or delete.
// Swipe (or drag the background) to move through time, pinch or use the slider to zoom from a few weeks to whole years.
// Opens from the map button in the Tab list's Timelines panel, and in the To-do page's Map. An AI can manage the goals
// too, through the AI task API (core/taskapi.ts, /v1/goals). The rules both share: core/goals.ts.
// "How it works" opens a pop-up with the video the idea came from (GoalsVideo below).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Goal } from "../core/model";
import { GOAL_COLORS, GOAL_LEVELS, GOAL_NOTE_MAX, GOAL_TITLE_MAX, blankGoal, nextGoalColor, spanAt } from "../core/goals";
import { GOALS_VIDEO, canEmbedVideo } from "../core/goalsvideo";
import { sfx } from "../ui/sfx";
import "./goals.css";

export { GOAL_COLORS };
const DAY = 86400000;
const LANES = GOAL_LEVELS;
const ROW = 38, LANE_PAD = 10, HEAD = 58;
const iso = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const at = (s: string) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const days = (a: number, b: number) => Math.round((b - a) / DAY);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (s: string) => { const d = new Date(at(s)); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const GHOST = "ghost";   // the drag id of the ghost

/** Stack goals that overlap into rows, in start order. */
function stack(list: Goal[]) {
  const rows: number[] = [];
  const out = new Map<string, number>();
  for (const g of [...list].sort((a, b) => a.start.localeCompare(b.start))) {
    const s = at(g.start);
    let r = rows.findIndex((end) => end < s);
    if (r < 0) { r = rows.length; rows.push(0); }
    rows[r] = at(g.end);
    out.set(g.id, r);
  }
  return { rowOf: out, rows: Math.max(1, rows.length) };
}

/** A goal not added yet: where it would go. */
type Ghost = { level: Goal["level"]; start: string; end: string };

/** Esc steps back one thing inside the Timeline: the ghost, then the open goal. The window (or the map) around it asks
 *  first, and closes itself only when this answers false. */
let escStep: (() => boolean) | null = null;
export const goalsEsc = (): boolean => escStep?.() ?? false;

export function GoalsTimeline({ goals, onSave }: { goals: Goal[]; onSave: (list: Goal[]) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const now = Date.now();
  const thisYear = new Date().getFullYear();
  // The goals as last saved from here, so two quick changes never start from the same old copy.
  const [prevGoals, setPrevGoals] = useState(goals);
  const [mine, setMine] = useState(goals);
  if (prevGoals !== goals) { setPrevGoals(goals); setMine(goals); }
  const mineRef = useRef(mine);
  mineRef.current = mine;
  const save = (next: Goal[]) => { mineRef.current = next; setMine(next); onSave(next); };
  const saveRef = useRef(save);
  saveRef.current = save;
  // The canvas: from January last year to December the year after next (more if goals reach further).
  const range = useMemo(() => {
    let a = new Date(thisYear - 1, 0, 1).getTime(), b = new Date(thisYear + 2, 11, 31).getTime();
    for (const g of mine) { a = Math.min(a, at(g.start) - 31 * DAY); b = Math.max(b, at(g.end) + 31 * DAY); }
    return { a, b };
  }, [mine, thisYear]);
  const [ppd, setPpd] = useState(12);            // pixels per day: the zoom
  const [sel, setSelState] = useState<string | null>(null);
  const selRef = useRef<string | null>(null);
  const [ghost, setGhostState] = useState<Ghost | null>(null);
  const ghostRef = useRef<Ghost | null>(null);
  const setGhost = (g: Ghost | null) => { ghostRef.current = g; setGhostState(g); };
  const [live, setLive] = useState<Goal[] | null>(null);   // goals while dragging (saved on release)
  const [video, setVideo] = useState(false);
  const newBtn = useRef<HTMLButtonElement>(null);
  const draft = useRef<{ id: string; title: string; note: string } | null>(null);   // what the editor holds right now
  const list = live ?? mine;
  const xOf = (t: number) => ((t - range.a) / DAY) * ppd;
  const width = days(range.a, range.b) * ppd;

  /** The goals as they should be once the open goal closes: without it when nothing was typed in it, else with what is
   *  typed in its name and notes right now (Esc or Close can come before the field saves on its own). */
  const settle = (all: Goal[]): Goal[] => {
    const id = selRef.current;
    const g = id ? all.find((x) => x.id === id) : undefined;
    if (!g) return all;
    const d = draft.current?.id === id ? draft.current : { title: g.title, note: g.note ?? "" };
    if (blankGoal(d.title, d.note)) return all.filter((x) => x.id !== id);
    const title = d.title.trim().slice(0, GOAL_TITLE_MAX), note = d.note.trim().slice(0, GOAL_NOTE_MAX) || null;
    return title === g.title && note === (g.note ?? null) ? all : all.map((x) => (x.id === id ? { ...x, title, note } : x));
  };
  /** Open another goal (or none). A goal closed with nothing in it is not kept. */
  const setSel = (next: string | null) => {
    if (selRef.current && selRef.current !== next) {
      const kept = settle(mineRef.current);
      if (kept !== mineRef.current) save(kept);
      draft.current = null;
    }
    selRef.current = next;
    setSelState(next);
  };
  const setSelRef = useRef(setSel);
  setSelRef.current = setSel;
  const settleRef = useRef(settle);
  settleRef.current = settle;
  // Closing the whole Timeline closes the open goal too.
  useEffect(() => () => { const all = mineRef.current, kept = settleRef.current(all); if (kept !== all) saveRef.current(kept); }, []);
  useEffect(() => {
    const step = () => {
      if (ghostRef.current) { setGhost(null); return true; }
      if (selRef.current) { setSelRef.current(null); return true; }
      return false;
    };
    escStep = step;
    return () => { if (escStep === step) escStep = null; };
  });

  // Open on October this year (or the current month) to the end of the year, filling the width.
  const first = useRef(true);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !first.current) return;
    first.current = false;
    const start = new Date(thisYear, Math.min(new Date().getMonth(), 9), 1).getTime();
    const end = new Date(thisYear, 11, 31).getTime();
    const fit = Math.max(2, Math.min(60, (el.clientWidth - 40) / days(start, end)));
    setPpd(fit);
    requestAnimationFrame(() => { el.scrollLeft = ((start - range.a) / DAY) * fit - 20; });
  }, [range.a, thisYear]);

  // Zoom keeping a date under a point (the middle, or the mouse when pinching).
  const zoomTo = (next: number, anchorPx?: number) => {
    const el = scroller.current;
    if (!el) return;
    const p = anchorPx ?? el.clientWidth / 2;
    const t = range.a + ((el.scrollLeft + p) / ppd) * DAY;
    const z = Math.max(1.2, Math.min(80, next));
    setPpd(z);
    requestAnimationFrame(() => { el.scrollLeft = ((t - range.a) / DAY) * z - p; });
  };
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) { e.preventDefault(); const r = el.getBoundingClientRect(); zoomTo(ppd * Math.exp(-e.deltaY * 0.01), e.clientX - r.left); return; }
      // An ordinary mouse wheel scrolls through time; trackpad swipes already go sideways.
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); el.scrollLeft += e.deltaY; }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  });
  const jump = (start: number, end: number) => {
    const el = scroller.current;
    if (!el) return;
    const z = Math.max(1.2, Math.min(80, (el.clientWidth - 40) / Math.max(7, days(start, end))));
    setPpd(z);
    requestAnimationFrame(() => el.scrollTo({ left: ((start - range.a) / DAY) * z - 20, behavior: "smooth" }));
  };

  // Header: years and months on top, weeks (or days when zoomed in) below.
  const months: { t: number; label: string; x: number; w: number }[] = [];
  for (let d = new Date(range.a); d.getTime() < range.b; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const t = d.getTime(), next = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    months.push({ t, label: ppd * 30 > 70 ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : MONTHS[d.getMonth()][0], x: xOf(t), w: xOf(next) - xOf(t) });
  }
  const weeks: { t: number; x: number }[] = [];
  if (ppd * 7 >= 26) {
    const mon = new Date(range.a); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
    for (let t = mon.getTime(); t < range.b; t += 7 * DAY) weeks.push({ t, x: xOf(t) });
  }

  // Drag: move a goal (or the ghost), or stretch it from either end. Snaps to whole days.
  const drag = useRef<{ id: string; mode: "move" | "start" | "end"; x: number; g: { start: string; end: string }; moved: boolean } | null>(null);
  const pan = useRef<{ x: number; left: number } | null>(null);
  const panned = useRef(false);   // the background was dragged: that release is not a click to add
  const onGoalDown = (e: React.PointerEvent, g: { id: string; start: string; end: string }, mode: "move" | "start" | "end") => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { id: g.id, mode, x: e.clientX, g: { start: g.start, end: g.end }, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      const dd = Math.round((e.clientX - d.x) / ppd);
      if (dd === 0 && !d.moved) return;
      d.moved = true;
      let s = at(d.g.start), en = at(d.g.end);
      if (d.mode === "move") { s += dd * DAY; en += dd * DAY; }
      else if (d.mode === "start") s = Math.min(en, s + dd * DAY);
      else en = Math.max(s, en + dd * DAY);
      if (d.id === GHOST) { const gh = ghostRef.current; if (gh) setGhost({ ...gh, start: iso(s), end: iso(en) }); return; }
      setLive(mineRef.current.map((g) => g.id === d.id ? { ...g, start: iso(s), end: iso(en) } : g));
      return;
    }
    if (pan.current && scroller.current) {
      if (Math.abs(e.clientX - pan.current.x) > 4) panned.current = true;
      scroller.current.scrollLeft = pan.current.left - (e.clientX - pan.current.x);
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    pan.current = null;
    if (d?.id === GHOST) return;
    if (d && d.moved && live) { save(live); sfx.drop(); }
    else if (d) { setGhost(null); setSel(d.id); sfx.click(); }
    setLive(null);
  };
  // A click on an empty spot only shows the ghost there; nothing is added yet.
  const placeAt = (e: React.MouseEvent, level: Goal["level"]) => {
    if (panned.current) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setSel(null);
    setGhost({ level, ...spanAt(level, range.a + ((e.clientX - r.left) / ppd) * DAY) });
    sfx.click();
  };
  /** "+ New goal" or Enter: the ghost becomes a goal, and its editor opens to name it. */
  const create = () => {
    const gh = ghostRef.current;
    if (!gh) return;
    const base = settle(mineRef.current);
    const g: Goal = { id: crypto.randomUUID(), title: "", level: gh.level, start: gh.start, end: gh.end, color: nextGoalColor(base), createdAt: new Date().toISOString() };
    save([...base, g]);
    setGhost(null);
    draft.current = null;
    selRef.current = g.id;
    setSelState(g.id);
    sfx.drop();
  };
  const createRef = useRef(create);
  createRef.current = create;
  // While the ghost shows: the button takes the focus (so Enter adds it), Enter adds it from anywhere but a field, and a
  // click anywhere but the ghost puts it away (a click on another empty spot moves it there instead).
  useEffect(() => {
    if (!ghost) return;
    newBtn.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, button, [contenteditable='true']"))) return;
      e.preventDefault();
      createRef.current();
    };
    const click = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || t.closest(".gt-ghost, .gt-new") || t.classList.contains("gt-lane")) return;
      if (panned.current && t.closest(".gt-scroll")) return;   // the end of a drag through time
      setGhost(null);
    };
    window.addEventListener("keydown", key);
    document.addEventListener("click", click, true);
    return () => { window.removeEventListener("keydown", key); document.removeEventListener("click", click, true); };
  }, [ghost !== null]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** Each lane's rows, with the first row the ghost fits in (a new one below when none is free). */
  const lanes = LANES.map((l) => {
    const goalsHere = list.filter((g) => g.level === l.level);
    const { rowOf, rows } = stack(goalsHere);
    let ghostRow = -1;
    if (ghost && ghost.level === l.level) {
      ghostRow = 0;
      while (goalsHere.some((g) => rowOf.get(g.id) === ghostRow && g.start <= ghost.end && g.end >= ghost.start)) ghostRow++;
    }
    return { ...l, goalsHere, rowOf, ghostRow, rows: Math.max(rows, ghostRow + 1) };
  });

  const selected = list.find((g) => g.id === sel) || null;
  const zoomPct = Math.round((Math.log(ppd / 1.2) / Math.log(80 / 1.2)) * 100);

  return (
    <div className="gt">
      <div className="gt-bar">
        <div className="gt-jumps">
          <button type="button" onClick={() => jump(new Date(thisYear, 9, 1).getTime(), new Date(thisYear, 11, 31).getTime())}>Oct to Dec</button>
          <button type="button" onClick={() => jump(new Date(thisYear, new Date().getMonth(), 1).getTime(), new Date(thisYear, new Date().getMonth() + 1, 0).getTime())}>This month</button>
          <button type="button" onClick={() => jump(new Date(thisYear, 0, 1).getTime(), new Date(thisYear, 11, 31).getTime())}>{thisYear}</button>
          <button type="button" onClick={() => jump(new Date(thisYear + 1, 0, 1).getTime(), new Date(thisYear + 1, 11, 31).getTime())}>{thisYear + 1}</button>
          <button type="button" onClick={() => jump(range.a, range.b)}>Everything</button>
        </div>
        <button type="button" className="gt-how" onClick={() => { sfx.click(); setVideo(true); }} aria-haspopup="dialog">
          <span className="gt-how-play" aria-hidden="true" />How it works
        </button>
        <label className="gt-zoom">
          <span>Zoom</span>
          <input type="range" min={0} max={100} value={zoomPct} onChange={(e) => zoomTo(1.2 * Math.pow(80 / 1.2, Number(e.target.value) / 100))} aria-label="Zoom the timeline" />
        </label>
      </div>
      <div className="gt-body">
        <div className="gt-lanes-h" style={{ paddingTop: HEAD }}>
          {lanes.map((l) => <div key={l.level} className={`gt-lh ${l.level}`} style={{ height: l.rows * ROW + LANE_PAD * 2 + 8 }}><b>{l.title}</b><span>{l.sub}</span></div>)}
        </div>
        <div className="gt-scroll" ref={scroller}
          onPointerDown={(e) => { panned.current = false; if (!drag.current) pan.current = { x: e.clientX, left: scroller.current!.scrollLeft }; }}
          onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}>
          <div className="gt-canvas" style={{ width, ["--wk" as string]: `${ppd * 7}px` }}>
            <div className="gt-head" style={{ height: HEAD }}>
              {months.map((m) => <div key={m.t} className={`gt-month${new Date(m.t).getMonth() === 0 ? " jan" : ""}`} style={{ left: m.x, width: m.w }}><span>{m.label}</span></div>)}
              {weeks.map((w) => <span key={w.t} className="gt-week" style={{ left: w.x }}>{new Date(w.t).getDate()}</span>)}
            </div>
            {months.map((m) => <div key={"g" + m.t} className="gt-mline" style={{ left: m.x }} />)}
            <div className="gt-today" style={{ left: xOf(now) }}><span>Today</span></div>
            {lanes.map((l) => (
              <div key={l.level} className={`gt-lane ${l.level}`} style={{ height: l.rows * ROW + LANE_PAD * 2 + 8 }}
                onClick={(e) => { if (e.target === e.currentTarget) placeAt(e, l.level); }} title="Click to place a new goal here">
                {l.goalsHere.map((g) => {
                  const x0 = xOf(at(g.start)), x1 = xOf(at(g.end) + DAY), w = Math.max(10, x1 - x0);
                  return (
                    <div key={g.id} className={`gt-goal${sel === g.id ? " sel" : ""}${g.done ? " done" : ""}${live ? " dragging" : ""}`}
                      style={{ left: x0, width: w, top: LANE_PAD + (l.rowOf.get(g.id) || 0) * ROW, ["--c" as string]: g.color }}
                      onPointerDown={(e) => onGoalDown(e, g, "move")} title={`${g.title || "Untitled"}: ${g.start} to ${g.end}`}>
                      <span className="gt-h gt-h-l" onPointerDown={(e) => onGoalDown(e, g, "start")} />
                      <span className="gt-t">{g.done ? "✓ " : ""}{g.title || "Untitled goal"}</span>
                      <span className="gt-h gt-h-r" onPointerDown={(e) => onGoalDown(e, g, "end")} />
                    </div>
                  );
                })}
                {ghost && ghost.level === l.level ? (() => {
                  const x0 = xOf(at(ghost.start)), x1 = xOf(at(ghost.end) + DAY), w = Math.max(10, x1 - x0);
                  const top = LANE_PAD + Math.max(0, l.ghostRow) * ROW;
                  const inside = w >= 150;
                  const btn = (
                    <button ref={newBtn} type="button" className={`gt-new${inside ? "" : " out"}`} style={inside ? undefined : { left: x1 + 6, top: top + 2, ["--c" as string]: nextGoalColor(mine) }}
                      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); create(); }}>+ New goal</button>
                  );
                  return <>
                    <div className="gt-ghost" style={{ left: x0, width: w, top, ["--c" as string]: nextGoalColor(mine) }} aria-label={`New goal here: ${ghost.start} to ${ghost.end}`}
                      onPointerDown={(e) => onGoalDown(e, { id: GHOST, ...ghost }, "move")}>
                      <span className="gt-h gt-h-l" onPointerDown={(e) => onGoalDown(e, { id: GHOST, ...ghost }, "start")} />
                      {inside ? btn : null}
                      <span className="gt-ghost-t">{dayLabel(ghost.start)} to {dayLabel(ghost.end)}</span>
                      <span className="gt-h gt-h-r" onPointerDown={(e) => onGoalDown(e, { id: GHOST, ...ghost }, "end")} />
                    </div>
                    {inside ? null : btn}
                  </>;
                })() : null}
              </div>
            ))}
          </div>
        </div>
      </div>
      {selected ? (
        <GoalEditor key={selected.id} g={selected} onDraft={(title, note) => { draft.current = { id: selected.id, title, note }; }}
          onChange={(p) => save(mineRef.current.map((g) => g.id === selected.id ? { ...g, ...p } : g))}
          onDelete={() => { save(mineRef.current.filter((g) => g.id !== selected.id)); selRef.current = null; draft.current = null; setSelState(null); }}
          onClose={() => setSel(null)} />
      ) : ghost ? (
        <p className="gt-hint">Drag its ends to change the days. <b>+ New goal</b> or Enter adds it; Esc or a click anywhere else puts it away.</p>
      ) : (
        <p className="gt-hint">Click an empty spot in a lane, then <b>+ New goal</b> to add a goal there. Drag a goal to move it, drag its ends to stretch it, click it to edit. Swipe or drag the background to move through time, pinch or use the slider to zoom.</p>
      )}
      {video && <GoalsVideo onClose={() => setVideo(false)} />}
    </div>
  );
}

function GoalEditor({ g, onChange, onDraft, onDelete, onClose }: { g: Goal; onChange: (p: Partial<Goal>) => void; onDraft: (title: string, note: string) => void; onDelete: () => void; onClose: () => void }) {
  const [title, setTitle] = useState(g.title);
  const [note, setNote] = useState(g.note || "");
  const [sure, setSure] = useState(false);
  useEffect(() => { onDraft(title, note); });
  return (
    <div className="gt-edit" style={{ ["--c" as string]: g.color }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
      <input className="gt-in gt-title" value={title} autoFocus={!g.title} placeholder="Name this goal" onChange={(e) => setTitle(e.target.value)}
        onBlur={() => { if (title.trim() !== g.title) onChange({ title: title.trim().slice(0, GOAL_TITLE_MAX) }); }}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      <div className="gt-row">
        <div className="gt-levels" role="radiogroup" aria-label="Lane">
          {LANES.map((l) => <button key={l.level} type="button" className={g.level === l.level ? "on" : ""} onClick={() => onChange({ level: l.level })}>{l.title}</button>)}
        </div>
        <div className="gt-colors" role="radiogroup" aria-label="Colour">
          {GOAL_COLORS.map((c) => <button key={c} type="button" className={g.color === c ? "on" : ""} style={{ background: c }} onClick={() => onChange({ color: c })} aria-label={`Colour ${c}`} />)}
        </div>
        <label className="gt-date">From <input type="date" value={g.start} onChange={(e) => { if (e.target.value) onChange({ start: e.target.value, end: e.target.value > g.end ? e.target.value : g.end }); }} /></label>
        <label className="gt-date">To <input type="date" value={g.end} onChange={(e) => { if (e.target.value) onChange({ end: e.target.value < g.start ? g.start : e.target.value }); }} /></label>
      </div>
      <textarea className="gt-in" rows={2} value={note} placeholder="Notes: what done looks like" onChange={(e) => setNote(e.target.value)}
        onBlur={() => { if (note.trim() !== (g.note || "")) onChange({ note: note.trim().slice(0, GOAL_NOTE_MAX) || null }); }} />
      <div className="gt-row">
        <button type="button" className={`gt-btn${g.done ? " on" : ""}`} onClick={() => { sfx.done(); onChange({ done: !g.done }); }}>{g.done ? "Done ✓" : "Mark done"}</button>
        <span style={{ flex: 1 }} />
        <button type="button" className={`gt-btn danger${sure ? " sure" : ""}`} onClick={() => { if (!sure) { setSure(true); return; } onDelete(); }}>{sure ? "Click again to delete" : "Delete"}</button>
        <button type="button" className="gt-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

let videoOpen = false;   // Esc then closes only the video pop-up (GoalsWindow checks it)

/** The video the goal levels come from. The frame only exists while the pop-up is open, so
 *  nothing loads from YouTube before that, and closing it stops the video. */
function GoalsVideo({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  const shut = useRef(onClose);
  shut.current = onClose;
  useEffect(() => {
    videoOpen = true;
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); shut.current(); } };
    window.addEventListener("keydown", key, true);
    return () => { videoOpen = false; window.removeEventListener("keydown", key, true); };
  }, []);
  return (
    <div className="gv-scrim" role="dialog" aria-modal="true" aria-labelledby="gv-title"
      onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      onPointerDown={(e) => e.stopPropagation()}>
      <div className="gv-card">
        <header className="gv-h">
          <h3 id="gv-title">This is how it works, explained by the idea it came from</h3>
          <button ref={close} type="button" className="gt-x" onClick={onClose} aria-label="Close">×</button>
        </header>
        {canEmbedVideo(location.protocol) ? (
          <div className="gv-frame">
            <iframe src={GOALS_VIDEO.embed} title="This is how it works, explained by the idea it came from"
              allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox" />
          </div>
        ) : (
          <a className="gv-frame gv-out" href={GOALS_VIDEO.watch} target="_blank" rel="noopener noreferrer">
            <span className="gv-out-play" aria-hidden="true" />
            <span>Plays on YouTube in your browser</span>
          </a>
        )}
        <a className="gv-link" href={GOALS_VIDEO.watch} target="_blank" rel="noopener noreferrer">Open on YouTube<span aria-hidden="true"> ↗</span></a>
      </div>
    </div>
  );
}

/** The big window it opens in (Tab list). */
export function GoalsWindow({ goals, onSave, onClose }: { goals: Goal[]; onSave: (list: Goal[]) => void; onClose: () => void }) {
  useEffect(() => {
    // While the video pop-up is open, Esc closes only the pop-up (its own key handler).
    // Inside the Timeline Esc steps back one at a time (the ghost, then the open goal); then it closes the window.
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !videoOpen) { e.stopPropagation(); if (!goalsEsc()) onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  return (
    <div className="gt-scrim" role="dialog" aria-modal="true" aria-label="Goals timeline" onMouseDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}>
      <div className="gt-win">
        <header className="gt-win-h">
          <div><span className="gt-eyebrow">Your goals</span><h2>Timeline</h2></div>
          <button type="button" className="gt-x" onClick={onClose} aria-label="Close">×</button>
        </header>
        <GoalsTimeline goals={goals} onSave={onSave} />
      </div>
    </div>
  );
}
