// The Tasks column of the Clients screen (PS 1.73): the project's tasks, which are ordinary to-do tasks with the client on them,
// so ticking one here ticks it in the list too. Each lands in the normal list by itself on its day at the day end (the developer's rules,
// core/clientwork.ts): weekday chips for repeating ones, a date for one day ones, a deadline with its own do date, P1.
import { useMemo, useState, type CSSProperties } from "react";
import type { CalEvent, Doc, Todo } from "../core/model";
import { addClientTodo, editClientTodo, removeClientTodo, tickClientTodo, type TaskInput } from "../core/clientsact";
import {
  CHIPS, SECTION_WORDS, clampDoOn, comesInWords, dayWords, daysOf, daysWords, deadlineWords, doOnFor, gapOf, landWords, repeatPatch,
  sectionOf, toggleDay, type Deadline,
} from "../core/clientwork";
import { clientRanked } from "./clientsday";
import { levelPick, prioNumbers } from "../core/prio";
import type { Reminder } from "../core/remind";
import { plusDays } from "../core/repeat";
import { useVault } from "../ui/kit";
import { PriorityPicker } from "../views/PriorityPicker";
import { AddTime } from "../views/TimeEstimate";
import { DraftRemindPop, reminderWords, useTaskReminder, TaskReminderEditor } from "../views/TaskRemind";
import { I, Pop } from "./bits";

type Kind = "repeat" | "date" | "deadline";
export interface Call { ev: CalEvent; who: string | null }
const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const kindOf = (t: Todo): Kind => (t.type === "daily" ? "repeat" : t.deadline ? "deadline" : "date");
const callDeadline = (c: Call): Deadline => {
  const d = new Date(c.ev.start!);
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}`, eventId: c.ev.id, title: c.ev.title };
};

/** One task's schedule as the box edits it. */
interface Draft { title: string; kind: Kind; days: number[]; date: string; dl: Deadline; doOn: string; priority: number | null }
const draftOf = (t: Todo, day: string, priority: number | null): Draft => ({
  title: t.title, kind: kindOf(t), days: daysOf(t).length ? daysOf(t) : [1, 2, 3, 4, 5], priority,
  date: t.doOn || day, dl: t.deadline ?? { date: t.doOn || day }, doOn: t.doOn || t.deadline?.date || day,
});
function patchOf(d: Draft, day: string): TaskInput {
  const title = d.title.trim().slice(0, 500);
  const priority = d.kind === "repeat" && d.priority !== 1 ? null : d.priority;
  if (d.kind === "repeat") return { title, priority, ...repeatPatch(d.days, day), doOn: null, deadline: null };
  if (d.kind === "date") return { title, priority, type: "once", repeat: null, due: null, doOn: d.date, deadline: null };
  return { title, priority, type: "once", repeat: null, due: null, deadline: d.dl, doOn: clampDoOn(d.doOn, d.dl.date) };
}
function addedWords(t: TaskInput): string {
  const sec = t.priority ? `Priority ${t.priority}` : SECTION_WORDS[sectionOf(t as Todo)];
  if (t.type === "daily") return `Added. It comes into ${sec} on ${daysWords(daysOf(t as Todo))}.`;
  if (t.deadline) return `Added. It comes into ${sec} on ${dayWords(t.doOn!)}, deadline ${dayWords(t.deadline.date)}.`;
  return `Added. It comes into ${sec} on ${dayWords(t.doOn!)}.`;
}

export function Tasks({ clientId, projectId, list, day, endHm, dayLine, call, say, prep, onPrepDone, colour }: {
  clientId: string; projectId: string; list: Doc<Todo>[]; day: string; endHm: string; dayLine: string; call: Call | null; say: (t: string) => void;
  prep: string | null; onPrepDone: () => void; colour?: string;
}) {
  const s = useVault();
  const ranked = useMemo(() => clientRanked(s).map((d) => ({ ...d.data, id: d.id, p1: d.data.p1 === true })), [s, day]);
  const priorities = useMemo(() => prioNumbers(ranked), [ranked]);
  const max = useMemo(() => levelPick(ranked).max, [ranked]);
  const [open, setOpen] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [add, setAdd] = useState<Draft>({ title: "", kind: "repeat", days: [1, 2, 3, 4, 5], date: day, dl: { date: plusDays(day, 3) }, doOn: plusDays(day, 3), priority: null });
  const [advanced, setAdvanced] = useState(false);
  const [notes, setNotes] = useState("");
  const [rem, setRem] = useState<Reminder | null>(null);
  const [remOpen, setRemOpen] = useState(false);
  const [remTask, setRemTask] = useState<string | null>(null);
  const [est, setEst] = useState<number | null>(null);
  const [every, setEvery] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const openId = prep ?? open;
  const patch = patchOf({ ...add, title }, day);
  const doAdd = async () => {
    if (!patch.title || busy) return;
    setBusy(true);
    try {
      await addClientTodo(clientId, projectId, {
        ...patch, ...(notes.trim() ? { notes: notes.trim() } : {}), ...(est === null ? {} : { est }),
        ...(every === null ? {} : { checkEvery: every }), ...(rem ? { reminder: rem } : {}),
      });
      setTitle(""); setNotes(""); setEst(null); setEvery(null); setRem(null); setAdvanced(false);
      setAdd((d) => ({ ...d, priority: null }));
      say(addedWords(patch));
    } catch (e) {
      say(e instanceof Error ? e.message : "Could not add the task.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="clw-col clw-tasks" style={colour ? { "--clw-task-colour": colour } as CSSProperties : undefined}>
      <div className="clw-col-h"><b>TASKS FOR YOUR LIST</b><span>{list.filter((d) => !d.data.done).length || ""}</span></div>
      <div className="clw-col-hint">These go into your to-do list on their day.</div>
      <div className="clw-dayline">{dayLine}</div>
      <div className="clw-rows">
        {!list.length && <div className="clw-empty">No tasks for this project yet.</div>}
        {list.map((d) => <Row key={d.id} d={d} priority={d.data.p1 ? 1 : priorities.get(d.id) ?? null} max={openId === d.id ? levelPick(ranked, d.id).max : max}
          onReminder={() => setRemTask(d.id)} day={day} endHm={endHm} call={call} open={openId === d.id} setOpen={(v) => { setOpen(v ? d.id : null); if (!v && prep) onPrepDone(); }} say={say} />)}
      </div>
      <div className="clw-addrow">
        <div className="clw-addline">
          <input className="clw-inp" placeholder="Add a task" maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void doAdd(); }} />
          <button type="button" className={`clw-btn sm${advanced ? " on" : ""}`} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>Advanced</button>
          <button type="button" className="clw-btn pri" disabled={!title.trim() || busy} onClick={() => void doAdd()}>Add</button>
        </div>
        <Schedule d={add} set={setAdd} call={call} compact />
        {advanced && (
          <div className="clw-advanced">
            <Priority d={add} set={setAdd} max={max} />
            <label>Notes<textarea className="clw-inp" rows={2} value={notes} maxLength={20_000} onChange={(e) => setNotes(e.target.value)} /></label>
            <AddTime title={title} est={est} setEst={setEst} every={every} setEvery={setEvery} label="clw-adv-label" rowCls="clw-adv-row" />
            <button type="button" className={`clw-btn sm${rem ? " on" : ""}`} onClick={() => setRemOpen(true)}>{reminderWords(!!rem)}</button>
          </div>
        )}
        {remTask && <TaskReminderEditor task={remTask} onClose={() => setRemTask(null)}
          onMakeDaily={() => void editClientTodo(remTask, { ...repeatPatch(ALL_WEEKDAYS, day), priority: null, doOn: null, deadline: null })} />}
        {remOpen && <DraftRemindPop title={title} once={add.kind !== "repeat"} startDate={patch.doOn} value={rem} onClose={() => setRemOpen(false)}
          onSave={(r, daily) => { setRem(r); if (daily) setAdd((d) => ({ ...d, kind: "repeat", days: ALL_WEEKDAYS })); }} />}
      </div>
    </div>
  );
}

function Priority({ d, set, max }: { d: Draft; set: (d: Draft) => void; max: number }) {
  const on = d.priority === 1;
  const setPriority = (priority: number | null) => set({ ...d, priority });
  return (
    <div className="clw-adv-row">
      <button type="button" className={`clw-chipb${on ? " on" : ""}`} aria-pressed={on} onClick={() => setPriority(on ? null : 1)}>Priority 1</button>
      {d.kind === "repeat" && !on && <span className="clw-small">Choose a date or deadline for P2 and higher.</span>}
      {d.kind !== "repeat" && !on && (d.priority === null
        ? <button type="button" className="clw-chipb" onClick={() => setPriority(max)}>Give it a priority</button>
        : <><PriorityPicker value={Math.min(d.priority, max)} max={max} onChange={setPriority} />
          <button type="button" className="clw-chipb" onClick={() => setPriority(null)}>No priority</button></>)}
    </div>
  );
}

/** The kind and its chips or dates (the add row and the task box). */
function Schedule({ d, set, call, compact }: { d: Draft; set: (d: Draft) => void; call: Call | null; compact?: boolean }) {
  const gap = gapOf({ doOn: d.doOn, deadline: d.dl });
  const setDl = (dl: Deadline) => set({ ...d, dl, doOn: doOnFor(dl.date, gap) });
  const isCall = !!call && d.dl.eventId === call.ev.id;
  return (
    <div className="clw-sched">
      <div className="clw-seg">
        {(["repeat", "date", "deadline"] as Kind[]).map((k) => (
          <button key={k} type="button" className={d.kind === k ? "on" : ""} onClick={() => set({ ...d, kind: k, priority: k === "repeat" && d.priority !== 1 ? null : d.priority })}>{k === "repeat" ? "Repeats" : k === "date" ? "On a date" : "By a deadline"}</button>
        ))}
      </div>
      {d.kind === "repeat" && (
        <div className="clw-wk clw-wkl">{CHIPS.map((c) => <button key={c.d} type="button" className={d.days.includes(c.d) ? "on" : ""} title={c.name} onClick={() => set({ ...d, days: toggleDay(d.days, c.d) })}>{c.label}</button>)}</div>
      )}
      {d.kind === "date" && <input type="date" className="clw-date" value={d.date} onChange={(e) => e.target.value && set({ ...d, date: e.target.value })} />}
      {d.kind === "deadline" && (
        <>
          {!compact && <div className="k">Deadline</div>}
          <div className="row">
            <input type="date" className="clw-date" value={d.dl.date} onChange={(e) => e.target.value && setDl({ date: e.target.value })} aria-label="Deadline" />
            {call && <button type="button" className={`clw-chipb${isCall ? " on" : ""}`} title="Use the next call as the deadline" onClick={() => setDl(callDeadline(call))}>{I.video}{compact ? "Next call" : `${call.ev.title}, ${dayWords(callDeadline(call).date).split(" ").slice(1).join(" ")}`}</button>}
          </div>
          {!compact && isCall && <div className="clw-small">From Google Calendar: {call!.ev.title}{call!.who ? ` with ${call!.who}` : ""}, {dayWords(d.dl.date)}{d.dl.time ? `, ${d.dl.time}` : ""}.</div>}
          {!compact && <div className="k">Do it on</div>}
          <div className="row">
            {(compact ? [[0, "Do on the day"], [1, "Day before"]] : [[0, "Deadline day"], [1, "Day before"], [2, "2 days before"]] as [number, string][]).map(([g, w]) => (
              <button key={g} type="button" className={`clw-chipb${gap === g ? " on" : ""}`} onClick={() => set({ ...d, doOn: doOnFor(d.dl.date, g as number) })}>{w}</button>
            ))}
            {!compact && <input type="date" className="clw-date" value={d.doOn} max={d.dl.date} onChange={(e) => e.target.value && set({ ...d, doOn: clampDoOn(e.target.value, d.dl.date) })} aria-label="Do it on" />}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ d, priority, max, day, endHm, call, open, setOpen, say, onReminder }: { d: Doc<Todo>; priority: number | null; max: number; day: string; endHm: string; call: Call | null; open: boolean; setOpen: (v: boolean) => void; say: (t: string) => void; onReminder: () => void }) {
  const t = d.data;
  return (
    <div className={`clw-trow${t.done ? " done" : ""}`}>
      <button type="button" className={`clw-ck${t.done ? " on" : ""}`} aria-label={t.done ? "Not done" : "Done"} onClick={() => void tickClientTodo(d.id, !t.done)} />
      <div className="tt">
        <button type="button" className="clw-tname" title="Click to change" onClick={() => setOpen(!open)}>{t.title}</button>
        <div className="clw-tmeta">
          {t.type === "daily" && (
            <span className="clw-wk">{CHIPS.map((c) => {
              const on = daysOf(t).includes(c.d);
              return <button key={c.d} type="button" className={on ? "on" : ""} title={c.name} onClick={() => void editClientTodo(d.id, repeatPatch(toggleDay(daysOf(t), c.d), day))}>{c.label}</button>;
            })}</span>
          )}
          {t.type !== "daily" && t.doOn && <span className="clw-dpill">{I.cal}{t.deadline ? `Do on ${dayWords(t.doOn)}` : dayWords(t.doOn)}</span>}
          {t.deadline && <span className="clw-dl">{t.deadline.eventId ? I.video : I.flag}{t.deadline.gone ? "Call cancelled" : deadlineWords(t.deadline)}</span>}
          <span className="sub">{landWords(t)}</span>
        </div>
      </div>
      {priority !== null && <button type="button" className="clw-p1t on" aria-label={`Priority ${priority}, edit task`} onClick={() => setOpen(!open)}>P{priority}</button>}
      {open && <TaskBox d={d} priority={priority} max={max} day={day} endHm={endHm} call={call} onClose={() => setOpen(false)} say={say} onReminder={onReminder} />}
    </div>
  );
}

function TaskBox({ d, priority, max, day, endHm, call, onClose, say, onReminder }: { d: Doc<Todo>; priority: number | null; max: number; day: string; endHm: string; call: Call | null; onClose: () => void; say: (t: string) => void; onReminder: () => void }) {
  const [dr, setDr] = useState<Draft>(() => draftOf(d.data, day, priority));
  const [notes, setNotes] = useState(d.data.notes ?? "");
  const [est, setEst] = useState<number | null>(d.data.est ?? null);
  const [every, setEvery] = useState<number | null>(d.data.checkEvery ?? null);
  const reminder = useTaskReminder(d.id);
  const { priority: picked, ...task } = patchOf(dr, day);
  const preview = { ...d.data, ...task, p1: picked === 1 } as Todo;
  const close = () => {
    const patch = {
      ...task, ...(picked !== priority ? { priority: picked } : {}),
      ...(notes !== (d.data.notes ?? "") ? { notes: notes.trim() || null } : {}),
      ...(est !== (d.data.est ?? null) ? { est } : {}), ...(every !== (d.data.checkEvery ?? null) ? { checkEvery: every } : {}),
    };
    if (patch.title && JSON.stringify({ ...d.data, ...patch }) !== JSON.stringify(d.data)) void editClientTodo(d.id, patch);
    onClose();
  };
  return (
    <Pop className="clw-tpop" onClose={close}>
      <div className="h">Task</div>
      <label>Name<input className="clw-inp" autoFocus value={dr.title} onChange={(e) => setDr({ ...dr, title: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") close(); }}
        onFocus={(e) => d.data.title.startsWith("Prep for the ") && e.target.select()} /></label>
      <Schedule d={dr} set={setDr} call={call} />
      <Priority d={dr} set={setDr} max={max} />
      <label>Notes<textarea className="clw-inp" rows={2} value={notes} maxLength={20_000} onChange={(e) => setNotes(e.target.value)} /></label>
      <AddTime title={dr.title} est={est} setEst={setEst} every={every} setEvery={setEvery} label="clw-adv-label" rowCls="clw-adv-row" />
      <button type="button" className="clw-btn sm" onClick={() => { close(); onReminder(); }}>{reminderWords(!!reminder)}</button>
      <div className="clw-land">{comesInWords(preview, day, endHm)}</div>
      <div className="row">
        <button type="button" className="clw-btn sm danger" onClick={() => { void removeClientTodo(d.id).then(() => say(`${d.data.title} removed.`)); onClose(); }}>{I.trash}Remove</button>
        <span className="clw-sp" />
        <button type="button" className="clw-btn sm pri" onClick={close}>Done</button>
      </div>
    </Pop>
  );
}
