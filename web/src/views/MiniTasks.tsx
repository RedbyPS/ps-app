// Mini tasks under a task (the developer, 24 Oct 2026: a task "Follow-ups" with an expand button that shows
// all its mini tasks). Used by the Tab list rows (PS and the To-do page) and the Today page. A click on the chevron opens or closes the list under the task; which tasks are
// open is saved in settings (tmSubOpen) so PS and the website match.
// Inside: a tick per mini task, double click edits, Backspace deletes the selected (or hovered)
// one when not typing, with Undo (Cmd+Z), drag to reorder, and an "Add mini task" box where
// Enter adds one and stays ready for the next. Every change shows straight away and is saved as a
// small op on the newest copy of the task (core/subtasks.ts).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Doc, Todo } from "../core/model";
import { settingsData } from "../core/select";
import { applySubOp, newSubId, subCount, type SubOp, type Subtask } from "../core/subtasks";
import { useDragOrder } from "../ui/dragOrder";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { Chevron, Collapse } from "./Accordion";
import { StreakBadge } from "../ui/RepeatPicker";
import { dimxIsOpen } from "./DimensionX";
import { pushUndoAction, taskMapActions } from "./TaskMap";
import "./minitasks.css";

// ---------- what shows: the saved list, or the one just changed until the save comes back ----------
const pending = new Map<string, { list: Subtask[]; until: number }>();
const openLocal = new Map<string, { open: boolean; until: number }>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; listeners.forEach((l) => l()); };
function useMiniStore() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => version);
}
const same = (a: Subtask[] | undefined, b: Subtask[] | undefined) => JSON.stringify(a || []) === JSON.stringify(b || []);

export function miniList(d: Doc<Todo>): Subtask[] {
  const p = pending.get(d.id);
  if (p) {
    if (Date.now() < p.until && !same(p.list, d.data.subtasks)) return p.list;
    pending.delete(d.id);
  }
  return d.data.subtasks || [];
}

/** One change: shown at once, then saved (PS: through its main window, as an op on the newest copy). */
export function miniAct(d: Doc<Todo>, op: SubOp) {
  const next = applySubOp(miniList(d), op, new Date().toISOString(), d.data.type === "daily");
  pending.set(d.id, { list: next, until: Date.now() + 5000 });
  emit();
  void taskMapActions.sub(d.id, op, next);
  // the saved copy normally comes back well within this; then the pending one steps aside
  window.setTimeout(emit, 5100);
}

/** Is this task's list open, and the click that opens or closes it (saved for PS and the website). */
export function useMiniOpen(d: Doc<Todo>, saved: string[] | undefined) {
  useMiniStore();
  const l = openLocal.get(d.id);
  const savedOpen = !!saved?.includes(d.id);
  if (l && (Date.now() > l.until || l.open === savedOpen)) openLocal.delete(d.id);
  const open = openLocal.get(d.id)?.open ?? savedOpen;
  const toggle = () => {
    const next = !open;
    openLocal.set(d.id, { open: next, until: Date.now() + 5000 });
    focusNext = next ? d.id : null;
    emit();
    sfx.click();
    const ids = (saved || []).filter((x) => x !== d.id);
    void taskMapActions.looks({ tmSubOpen: next ? [...ids, d.id] : ids });
  };
  return { open, toggle };
}

// ---------- Backspace and Cmd+Z: one listener for every open list ----------
type UndoFn = (id: string, title: string, run: () => void) => void;
type Pick = { d: Doc<Todo>; s: Subtask; index: number; undo: UndoFn };
const keys: { sel: Pick | null; hover: Pick | null; users: number } = { sel: null, hover: null, users: 0 };
function onKey(e: KeyboardEvent) {
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) return;
  if (dimxIsOpen()) return;
  const p = keys.sel ?? keys.hover;
  if (!p || !document.querySelector(`[data-mini="${p.d.id}/${p.s.id}"]`)) return;
  e.preventDefault(); e.stopPropagation();
  removeMini(p);
}
function onDown(e: PointerEvent) {
  if (!(e.target as Element | null)?.closest?.(".mt-item")) { if (keys.sel) { keys.sel = null; emit(); } }
}
function useKeys() {
  useEffect(() => {
    if (keys.users++ === 0) { window.addEventListener("keydown", onKey, true); window.addEventListener("pointerdown", onDown, true); }
    return () => { if (--keys.users === 0) { window.removeEventListener("keydown", onKey, true); window.removeEventListener("pointerdown", onDown, true); } };
  }, []);
}

let focusNext: string | null = null;   // the task just opened with the chevron: its add box takes the keys
function removeMini({ d, s, index, undo }: Pick) {
  sfx.drop();
  if (keys.sel?.s.id === s.id) keys.sel = null;
  if (keys.hover?.s.id === s.id) keys.hover = null;
  miniAct(d, { op: "remove", id: s.id });
  undo(`mini-rm:${d.id}/${s.id}`, s.title, () => miniAct(d, { op: "restore", item: s, index }));
}

// ---------- the pieces ----------
/** The chevron and the quiet count ("2/5"). With no mini tasks it shows only on hover of the row. */
export function MiniToggle({ d, open, onToggle }: { d: Doc<Todo>; open: boolean; onToggle: () => void }) {
  useMiniStore();
  const { done, total } = subCount(miniList(d));
  return (
    <button type="button" className={`mt-toggle no-drag${total ? "" : " empty"}${open ? " open" : ""}${total && done === total ? " all" : ""}`}
      onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} mini tasks${total ? `, ${done} of ${total} done` : ""}`}
      title={total ? `${done} of ${total} mini tasks done` : "Add mini tasks"}>
      {total > 0 && <span className="mt-count num">{done}/{total}</span>}
      <Chevron open={open} size={16} />
    </button>
  );
}

/** Every mini task done but the task itself not ticked: a quiet glow (never ticks it for him). */
export function miniAllDone(d: Doc<Todo>) {
  const { done, total } = subCount(miniList(d));
  return total > 0 && done === total && !d.data.done;
}

export function MiniList({ d, open, onUndo }: { d: Doc<Todo>; open: boolean; onUndo?: UndoFn }) {
  useMiniStore();
  useKeys();
  const undo = onUndo ?? pushUndoAction;
  const list = miniList(d);
  const ids = list.map((s) => s.id);
  const { order, row } = useDragOrder(ids, (next) => miniAct(d, { op: "order", ids: next }), { onDrop: () => sfx.drop() });
  const byId = new Map(list.map((s) => [s.id, s]));
  return (
    <Collapse open={open} lazy className="mt-panel">
      <div className="mt-box" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
        {order.length > 0 && (
          <ul className="mt-list">
            {order.map((id, i) => {
              const s = byId.get(id);
              return s ? <MiniItem key={id} d={d} s={s} index={i} drag={row(id)} undo={undo} /> : null;
            })}
          </ul>
        )}
        <MiniAdd d={d} open={open} />
      </div>
    </Collapse>
  );
}

function MiniItem({ d, s, index, drag, undo }: { d: Doc<Todo>; s: Subtask; index: number; drag: ReturnType<ReturnType<typeof useDragOrder>["row"]>; undo: UndoFn }) {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(s.title);
  useEffect(() => { if (!edit) setTitle(s.title); }, [s.title, edit]);
  const claude = !!s.claudeDoneAt && !s.done;
  const sel = keys.sel?.s.id === s.id && keys.sel.d.id === d.id;
  const tick = () => {
    if (!s.done) { sfx.done(); undo(`mini:${d.id}/${s.id}`, s.title, () => miniAct(d, { op: "tick", id: s.id })); }
    miniAct(d, { op: "tick", id: s.id });
  };
  const save = () => {
    setEdit(false);
    const v = title.trim();
    if (v && v !== s.title) miniAct(d, { op: "rename", id: s.id, title: v });
    else setTitle(s.title);
  };
  return (
    <li className={`mt-item${s.done ? " done" : ""}${claude ? " claude" : ""}${sel ? " sel" : ""}`} data-mini={`${d.id}/${s.id}`}
      ref={drag.ref} style={drag.style} data-dragging={drag["data-dragging"]}
      onPointerDown={(e) => { if (!edit) drag.onPointerDown(e); }}
      onClick={() => { keys.sel = { d, s, index, undo }; emit(); }}
      onMouseEnter={() => { keys.hover = { d, s, index, undo }; }} onMouseLeave={() => { if (keys.hover?.s.id === s.id) keys.hover = null; }}>
      <button type="button" className="mt-tick no-drag" onClick={(e) => { e.stopPropagation(); tick(); }} aria-pressed={s.done}
        aria-label={`${s.done ? "Untick" : "Tick off"}: ${s.title}`} title={claude ? `Claude did this: ${s.claudeNote || "done"}. Click to confirm` : undefined}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
      </button>
      {edit ? (
        <input className="mt-edit" autoFocus value={title} maxLength={300} aria-label="Mini task name"
          onChange={(e) => setTitle(e.target.value)} onBlur={save} onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); save(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setTitle(s.title); setEdit(false); } }} />
      ) : (
        <span className="mt-t" onDoubleClick={() => setEdit(true)} title="Double click to edit">{s.title}</span>
      )}
      {claude && <span className="mt-claude">Claude</span>}
      {/* PS 1.68: each mini task of a repeating task has its own streak (core/subtasks.ts), a tiny flame from 2 in a row. */}
      {d.data.type === "daily" && !edit && <StreakBadge n={s.streak} className="mt-streak" rule={d.data.repeat} best={s.bestStreak} mini />}
    </li>
  );
}

function MiniAdd({ d, open }: { d: Doc<Todo>; open: boolean }) {
  const [on, setOn] = useState(false);
  const [v, setV] = useState("");
  const box = useRef<HTMLInputElement>(null);
  // Opening a task with no mini tasks (a click on its chevron) goes straight to the box.
  useEffect(() => {
    if (open && focusNext === d.id) { focusNext = null; if (!(d.data.subtasks || []).length) setOn(true); }
    if (!open) setOn(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const add = () => {
    const t = v.trim();
    if (!t) return;
    miniAct(d, { op: "add", id: newSubId(), title: t.slice(0, 300) });
    sfx.plop();
    setV("");
    box.current?.focus();
  };
  if (!on) return (
    <button type="button" className="mt-add" onClick={() => setOn(true)}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      Add mini task
    </button>
  );
  return (
    <div className="mt-addrow">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
      <input ref={box} className="mt-input" autoFocus value={v} maxLength={300} placeholder="Mini task, Enter to add"
        aria-label="New mini task" onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setV(""); setOn(false); } }}
        onBlur={() => { if (!v.trim()) setOn(false); }} />
    </div>
  );
}

/** For views that only need the saved open list (one read of the settings). */
export function useSubOpenList(): string[] | undefined {
  const s = useVault();
  return s.status === "unlocked" ? settingsData(s).tmSubOpen : undefined;
}
