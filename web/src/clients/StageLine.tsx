// The big editable stage line (Clients, PS 1.73). Drag the white handle along it to mark stages done (it snaps to the nearest
// stage edge with a little bounce); click a stage's bar to jump there; click its name to rename it, set its dates, move it or
// remove it; + at the end adds one; drag a name to reorder (mouse). On the phone it stands upright. Maths: core/clientwork.ts.
import { useLayoutEffect, useRef, useState, type PointerEvent as RPE } from "react";
import type { Project, Stage } from "../core/model";
import { dayWords, percentDone, snapEdge, stageWidths } from "../core/clientwork";
import { stageAdd, stageDone, stageEdit, stageMove, stageRemove } from "../core/clientsact";
import { Pop } from "./bits";

const shortDay = (iso?: string | null) => (iso ? dayWords(iso).split(" ").slice(1).join(" ") : "");
function datesOf(s: Stage) {
  if (!s.start && !s.due) return "No dates";
  if (s.start && s.due && s.start !== s.due) return `${shortDay(s.start)} to ${shortDay(s.due)}`;
  return dayWords((s.due || s.start)!);
}

export function StageLine({ id, p, today, upright, say, popOpen }: {
  id: string; p: Project; today: string; upright: boolean; say: (t: string) => void; popOpen: (open: boolean) => void;
}) {
  const stages = p.stages;
  const n = stages.length;
  const done = Math.max(0, Math.min(p.current, n));
  const line = useRef<HTMLDivElement>(null);
  const segs = useRef<(HTMLDivElement | null)[]>([]);
  const [drag, setDrag] = useState<number | null>(null);   // the handle's place in px along the line while dragged
  const [pop, setPop] = useState(false);
  const [edit, setEditRaw] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [moving, setMoving] = useState<number | null>(null);
  const [rest, setRest] = useState<number | null>(null);   // the handle's place at rest (px), measured; null until then
  const [settled, setSettled] = useState(false);   // the handle slides only after it first stood in place
  const setEdit = (i: number | null) => { setEditRaw(i); popOpen(i !== null); };
  const widths = stageWidths(stages);

  /** Each stage edge along the line, in px from its start (edges[k]: the start of stage k; edges[n]: the end of the last).
   *  Layout offsets, not screen boxes: the window grows in with a transform while it opens, and that must not move them. */
  const edges = (): number[] => {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const sg = segs.current[k], bar = sg?.querySelector<HTMLElement>(".clw-bar");
      if (!sg || !bar) return [];
      const at = upright ? sg.offsetTop + bar.offsetTop : sg.offsetLeft + bar.offsetLeft;
      out.push(k === 0 ? at : at - 3);
      if (k === n - 1) out.push(at + (upright ? bar.offsetHeight : bar.offsetWidth));
    }
    return out;
  };
  useLayoutEffect(() => {
    const f = () => { const e = edges(); if (e.length) { setRest(e[done] ?? 0); window.requestAnimationFrame(() => setSettled(true)); } };
    f();
    const ro = new ResizeObserver(f);
    if (line.current) ro.observe(line.current);
    return () => ro.disconnect();
  }, [done, n, upright, JSON.stringify(stages.map((s) => [s.start, s.due, s.name]))]);   // eslint-disable-line react-hooks/exhaustive-deps

  const posOf = (e: { clientX: number; clientY: number }) => {
    // In layout px, like edges(): a scaled screen (PS fits the list to small screens) divides back out.
    const el = line.current!, box = el.getBoundingClientRect();
    if (upright) return (e.clientY - box.top) / ((box.height / (el.offsetHeight || 1)) || 1);
    return (e.clientX - box.left) / ((box.width / (el.offsetWidth || 1)) || 1);
  };
  const commit = async (k: number) => {
    if (k === done) return;
    const before = done;
    await stageDone(id, k, today);
    setPop(true); window.setTimeout(() => setPop(false), 450);
    const pct = percentDone(stages, k);
    if (k > before) say(k - before === 1 ? `${stages[k - 1].name} is done. ${pct}% of ${p.title}.` : `${k} stages are done. ${pct}% of ${p.title}.`);
    else say(`${stages[k]?.name ?? "That stage"} is open again.`);
  };
  const down = (e: RPE<HTMLButtonElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(posOf(e));
  };
  const move = (e: RPE<HTMLButtonElement>) => {
    if (drag === null) return;
    const ed = edges();
    setDrag(Math.max(ed[0] ?? 0, Math.min(posOf(e), ed[ed.length - 1] ?? 0)));
  };
  const up = (e: RPE<HTMLButtonElement>) => {
    if (drag === null) return;
    const ed = edges(), len = (ed[ed.length - 1] ?? 1) || 1;
    const k = snapEdge(ed.map((x) => x / len), posOf(e) / len);
    setDrag(null);
    void commit(k);
  };
  const key = (e: React.KeyboardEvent) => {
    const fwd = upright ? "ArrowDown" : "ArrowRight", back = upright ? "ArrowUp" : "ArrowLeft";
    if (e.key === fwd && done < n) { e.preventDefault(); void commit(done + 1); }
    if (e.key === back && done > 0) { e.preventDefault(); void commit(done - 1); }
  };
  // How full each bar is: by the dragged handle, else done or not.
  const fill = (k: number): number => {
    if (drag === null) return k < done ? 1 : 0;
    const ed = edges();
    const a = ed[k] ?? 0, b = ed[k + 1] ?? a;
    return b > a ? Math.max(0, Math.min(1, (drag - a) / (b - a))) : 0;
  };
  const pct = percentDone(stages, done);
  const now = p.nowLine || (done >= n ? (n ? "All done" : "") : stages[done]?.name || "");

  const add = async () => {
    await stageAdd(id, "New stage", today);
    setEdit(n);
  };

  return (
    <div className={`clw-stl-wrap${upright ? " up" : ""}`}>
      <div className="clw-stl-top">
        <span className="clw-pct">{pct}% done</span>
        {now && <span className="clw-now">Right now: <b>{now}</b></span>}
      </div>
      <div className={`clw-stl${drag === null && settled ? " snap" : ""}`} ref={line}>
        {stages.map((s, k) => {
          const f = fill(k);
          const st = upright ? { flex: `${Math.max(widths[k], 0.0001)} 1 0`, minHeight: 58 } : { flex: `${Math.max(widths[k], 0.0001)} 1 0` };
          return (
            <div key={s.key || k} ref={(el) => { segs.current[k] = el; }} style={st}
              className={`clw-sg${k < done ? " done" : ""}${k === done ? " cur" : ""}${over === k ? " over" : ""}${moving === k ? " drag" : ""}`}
              onDragOver={(e) => { if (moving !== null) { e.preventDefault(); setOver(k); } }}
              onDragLeave={() => setOver((o) => (o === k ? null : o))}
              onDrop={(e) => { e.preventDefault(); const from = moving; setOver(null); setMoving(null); if (from !== null && from !== k) void stageMove(id, from, k).then(() => say(`${s.name === stages[from].name ? s.name : stages[from].name} moved. The dates follow the new order.`)); }}>
              <div className="clw-bar" onClick={() => void commit(k < done ? k : k + 1)} title={k < done ? `Open ${s.name} again` : `Mark ${s.name} done`}>
                <i style={upright ? { height: `${f * 100}%`, width: "100%" } : { width: `${f * 100}%` }} />
              </div>
              <button type="button" className="clw-lb" draggable={!upright} onDragStart={(e) => { setMoving(k); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", s.name); }}
                onDragEnd={() => { setMoving(null); setOver(null); }} onClick={() => setEdit(edit === k ? null : k)}>
                <span className="n">{s.name}</span>
                <span className="d">{datesOf(s)}</span>
              </button>
              {edit === k && <StageBox id={id} p={p} i={k} upright={upright} onClose={() => setEdit(null)} say={say} right={!upright && k > n / 2} />}
            </div>
          );
        })}
        {n > 0 && (drag !== null || rest !== null) && (
          <button type="button" className={`clw-knob${drag !== null ? " grab" : ""}${pop ? " pop" : ""}`} aria-label="Drag to mark stages done" title="Drag to mark stages done"
            style={upright ? { top: (drag ?? rest ?? 0) } : { left: (drag ?? rest ?? 0) }}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} onKeyDown={key} />
        )}
        <button type="button" className="clw-addst" onClick={() => void add()} aria-label="Add a stage" title="Add a stage">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <div className="clw-hint">{upright ? "Drag the handle to mark stages done. Tap a stage to rename it or change its dates." : "Drag the handle to mark stages done. Click a stage to rename it or change its dates."}</div>
    </div>
  );
}

function StageBox({ id, p, i, upright, onClose, say, right }: { id: string; p: Project; i: number; upright: boolean; onClose: () => void; say: (t: string) => void; right: boolean }) {
  const s = p.stages[i];
  const [name, setName] = useState(s.name);
  const save = () => { const t = name.trim(); if (t && t !== s.name) void stageEdit(id, i, { name: t.slice(0, 80) }); };
  const close = () => { save(); onClose(); };
  return (
    <Pop className={`clw-spop${right ? " r" : ""}`} onClose={close}>
      <div className="h">Stage {i + 1} of {p.stages.length}</div>
      <label>Name<input className="clw-inp" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") close(); }} onFocus={(e) => s.name === "New stage" && e.target.select()} /></label>
      <div className="two">
        <label>Starts<input type="date" className="clw-date" value={s.start || ""} onChange={(e) => void stageEdit(id, i, { start: e.target.value || null })} /></label>
        <label>Ends<input type="date" className="clw-date" value={s.due || ""} min={s.start || undefined} onChange={(e) => void stageEdit(id, i, { due: e.target.value || null })} /></label>
      </div>
      <div className="row">
        <button type="button" className="clw-btn sm" disabled={i === 0} onClick={() => { save(); void stageMove(id, i, i - 1).then(() => say(`${s.name} moved. The dates follow the new order.`)); onClose(); }}>{upright ? "Up" : "Earlier"}</button>
        <button type="button" className="clw-btn sm" disabled={i === p.stages.length - 1} onClick={() => { save(); void stageMove(id, i, i + 1).then(() => say(`${s.name} moved. The dates follow the new order.`)); onClose(); }}>{upright ? "Down" : "Later"}</button>
        <span className="clw-sp" />
        <button type="button" className="clw-btn sm danger" onClick={() => { void stageRemove(id, i).then(() => say(`${s.name} removed.`)); onClose(); }}>Remove</button>
        <button type="button" className="clw-btn sm pri" onClick={close}>Done</button>
      </div>
    </Pop>
  );
}
