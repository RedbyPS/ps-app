// The Scheduled row at the very bottom of the list (PS 1.75, rules in core/scheduled.ts). Tasks with a later day wait here, out
// of the list, Priority 1 and the island, until their day starts. One quiet row with a count, closed every time the list
// opens; a click opens it and shows them greyed, soonest first, each with its day. A task can be opened (the same inline
// editor as the list: rename, a new day, delete), moved to today ("Do today") or ticked. Esc closes the row.
// Switch: Settings, Your list, "Hide tasks until their day" (feature "scheduled-tasks").
import { memo, useEffect, useState } from "react";
import type { Doc, Todo } from "../core/model";
import { doTodayPatch, schedLabel, SCHED_TITLE } from "../core/scheduled";
import { sfx } from "../ui/sfx";
import { Editor, clickTick, pressTick, taskMapActions, tickTask } from "./TaskMap";
import { openTaskMenu, openTaskMenuAt } from "./TaskMenu";

type ClientOpt = { id: string; name: string };

export function Scheduled({ list, day, editing, onEdit, clients }: { list: Doc<Todo>[]; day: string; editing: string | null; onEdit: (id: string | null) => void; clients: ClientOpt[] }) {
  const [open, setOpen] = useState(false);
  const editingHere = !!editing && list.some((d) => d.id === editing);
  // Esc closes the row (an editor open inside it closes first, by its own Esc).
  useEffect(() => {
    if (!open) return;
    // Break-it 1.75: it uses the key (ui/escape.ts asks the newest layer first and stops at the first that uses it), so one Esc
    // closes only the row, never the row and the list under it.
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !editingHere) { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, editingHere]);
  if (!list.length) return null;
  const toggle = () => { sfx.click(); setOpen((o) => !o); };
  return (
    <section className={`tm-sec tm-sched${open ? " open" : ""}`} aria-label={SCHED_TITLE}
      onKeyDown={(e) => { if (e.key === "Escape" && open && !editingHere) { e.stopPropagation(); e.preventDefault(); setOpen(false); } }}>
      <button type="button" className="tm-sched-bar" aria-expanded={open} onClick={toggle}
        title={open ? "Hide the tasks waiting for their day" : "Tasks waiting for their day. They come into your list by themselves on that day"}>
        <svg className="tm-sched-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="5" width="16" height="15" rx="3" /><path d="M4 10h16M9 3v4M15 3v4" />
        </svg>
        <span>{SCHED_TITLE}</span><b className="num">{list.length}</b>
        <svg className="tm-sched-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <ul className="tm-list tm-sched-list">
          {list.map((d) => (editing === d.id
            ? <Editor key={d.id} d={d} clients={clients} onDone={() => onEdit(null)} />
            : <SchedRow key={d.id} d={d} day={day} onOpen={() => onEdit(d.id)} />))}
        </ul>
      )}
    </section>
  );
}

const SchedRow = memo(function SchedRow({ d, day, onOpen }: { d: Doc<Todo>; day: string; onOpen: () => void }) {
  const t = d.data;
  const tick = () => tickTask(d.id);
  const today = () => { sfx.drop(); void taskMapActions.update(d.id, doTodayPatch(day)); };
  return (
    <li className="tm-row tm-sched-row" data-id={d.id} data-type={t.type} onMouseEnter={() => sfx.hover()}
      onContextMenu={(e) => openTaskMenu(e, d.id, "list")}
      onKeyDown={(e) => { if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) { e.preventDefault(); openTaskMenuAt(e.currentTarget, d.id, "list"); } }}>
      <button type="button" className="tm-tick no-drag" aria-pressed="false" aria-label={`Tick: ${t.title}`} title="Tick it off now"
        onPointerDown={(e) => pressTick(e, d.id, tick)} onClick={() => clickTick(d.id, tick)} />
      <button type="button" className="tm-text tm-sched-open" onClick={() => { sfx.click(); onOpen(); }} title="Open: rename it, pick another day or delete it">
        <span className="tm-t">{t.title}</span>
        <span className="tm-due num">{schedLabel(t.due!, day)}</span>
      </button>
      <button type="button" className="tm-sched-today" onClick={today} title="Bring it into today's list now">Do today</button>
    </li>
  );
});
