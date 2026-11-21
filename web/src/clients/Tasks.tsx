// The Tasks column of the Clients screen (PS 1.73): the project's tasks, which are ordinary to-do tasks with the client on them,
// so ticking one here ticks it in the list too. Each lands in the normal list by itself on its day at the day end (the developer's rules,
// core/clientwork.ts): weekday chips for repeating ones, a date for one day ones, a deadline with its own do date, P1.
import { useState } from "react";
import type { CalEvent, Doc, Todo } from "../core/model";
import { toggleTodo } from "../core/actions";
import { addClientTodo, editClientTodo, removeClientTodo } from "../core/clientsact";
import {
  CHIPS, SECTION_WORDS, clampDoOn, comesInWords, dayWords, daysOf, daysWords, deadlineWords, doOnFor, gapOf, landWords, repeatPatch,
  sectionOf, toggleDay, type Deadline,
} from "../core/clientwork";
import { plusDays } from "../core/repeat";
import { I, Pop, Switch } from "./bits";

type Kind = "repeat" | "date" | "deadline";
export interface Call { ev: CalEvent; who: string | null }
const kindOf = (t: Todo): Kind => (t.type === "daily" ? "repeat" : t.deadline ? "deadline" : "date");
const callDeadline = (c: Call): Deadline => {
  const d = new Date(c.ev.start!);
  const p = (n: number) => String(n).padStart(2, "0");
  return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}`, eventId: c.ev.id, title: c.ev.title };
};

/** One task's schedule as the box edits it. */
interface Draft { title: string; kind: Kind; days: number[]; date: string; dl: Deadline; doOn: string; p1: boolean }
const draftOf = (t: Todo, day: string): Draft => ({
  title: t.title, kind: kindOf(t), days: daysOf(t).length ? daysOf(t) : [1, 2, 3, 4, 5], p1: t.p1 === true,
  date: t.doOn || day, dl: t.deadline ?? { date: t.doOn || day }, doOn: t.doOn || t.deadline?.date || day,
});
function patchOf(d: Draft, day: string): Partial<Todo> {
  const title = d.title.trim().slice(0, 500);
  if (d.kind === "repeat") return { title, p1: d.p1, ...repeatPatch(d.days, day), doOn: null, deadline: null };
  if (d.kind === "date") return { title, p1: d.p1, type: "once", repeat: null, due: null, doOn: d.date, deadline: null };
  return { title, p1: d.p1, type: "once", repeat: null, due: null, deadline: d.dl, doOn: clampDoOn(d.doOn, d.dl.date) };
}
function addedWords(t: Partial<Todo>): string {
  const sec = SECTION_WORDS[sectionOf(t as Todo)];
  if (t.type === "daily") return `Added. It comes into ${sec} on ${daysWords(daysOf(t as Todo))}.`;
  if (t.deadline) return `Added. It comes into ${sec} on ${dayWords(t.doOn!)}, deadline ${dayWords(t.deadline.date)}.`;
  return `Added. It comes into ${sec} on ${dayWords(t.doOn!)}.`;
}

export function Tasks({ clientId, projectId, list, day, endHm, dayLine, call, say, prep, onPrepDone }: {
  clientId: string; projectId: string; list: Doc<Todo>[]; day: string; endHm: string; dayLine: string; call: Call | null; say: (t: string) => void;
  prep: string | null; onPrepDone: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [add, setAdd] = useState<Draft>({ title: "", kind: "repeat", days: [1, 2, 3, 4, 5], date: day, dl: { date: plusDays(day, 3) }, doOn: plusDays(day, 3), p1: false });
  const openId = prep ?? open;
  const doAdd = async () => {
    const t = title.trim();
    if (!t) return;
    const patch = patchOf({ ...add, title: t }, day);
    await addClientTodo(clientId, projectId, patch as Todo);
    setTitle("");
    say(addedWords(patch));
  };
  return (
    <div className="clw-col clw-tasks">
      <div className="clw-col-h"><b>Tasks</b><span>{list.filter((d) => !d.data.done).length || ""}</span></div>
      <div className="clw-dayline">{dayLine}</div>
      <div className="clw-rows">
        {!list.length && <div className="clw-empty">No tasks for this project yet.</div>}
        {list.map((d) => <Row key={d.id} d={d} day={day} endHm={endHm} call={call} open={openId === d.id} setOpen={(v) => { setOpen(v ? d.id : null); if (!v && prep) onPrepDone(); }} say={say} />)}
      </div>
      <div className="clw-addrow">
        <div className="clw-addline">
          <input className="clw-inp" placeholder="Add a task" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void doAdd(); }} />
          <button type="button" className={`clw-p1t${add.p1 ? " on" : ""}`} title="Land it in Priority 1" onClick={() => setAdd({ ...add, p1: !add.p1 })}>P1</button>
          <button type="button" className="clw-btn pri" disabled={!title.trim()} onClick={() => void doAdd()}>Add</button>
        </div>
        <Schedule d={add} set={setAdd} call={call} compact />
      </div>
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
          <button key={k} type="button" className={d.kind === k ? "on" : ""} onClick={() => set({ ...d, kind: k })}>{k === "repeat" ? "Repeats" : k === "date" ? "On a date" : "By a deadline"}</button>
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

function Row({ d, day, endHm, call, open, setOpen, say }: { d: Doc<Todo>; day: string; endHm: string; call: Call | null; open: boolean; setOpen: (v: boolean) => void; say: (t: string) => void }) {
  const t = d.data;
  const p1 = async () => {
    await editClientTodo(d.id, { p1: !t.p1 });
    say(!t.p1 ? `${t.title} lands in Priority 1.` : `${t.title} lands in ${SECTION_WORDS[sectionOf({ ...t, p1: false })]}.`);
  };
  return (
    <div className={`clw-trow${t.done ? " done" : ""}`}>
      <button type="button" className={`clw-ck${t.done ? " on" : ""}`} aria-label={t.done ? "Not done" : "Done"} onClick={() => void toggleTodo(d.id)} />
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
      <button type="button" className={`clw-p1t${t.p1 ? " on" : ""}`} title={t.p1 ? "Lands in Priority 1. Click to land it normally." : "Click to land it in Priority 1"} onClick={() => void p1()}>P1</button>
      {open && <TaskBox d={d} day={day} endHm={endHm} call={call} onClose={() => setOpen(false)} say={say} />}
    </div>
  );
}

function TaskBox({ d, day, endHm, call, onClose, say }: { d: Doc<Todo>; day: string; endHm: string; call: Call | null; onClose: () => void; say: (t: string) => void }) {
  const [dr, setDr] = useState<Draft>(() => draftOf(d.data, day));
  const preview = { ...d.data, ...patchOf(dr, day) } as Todo;
  const close = () => {
    const patch = patchOf(dr, day);
    if (patch.title && JSON.stringify({ ...d.data, ...patch }) !== JSON.stringify(d.data)) void editClientTodo(d.id, patch);
    onClose();
  };
  const sec = SECTION_WORDS[sectionOf({ ...preview, p1: false })];
  return (
    <Pop className="clw-tpop" onClose={close}>
      <div className="h">Task</div>
      <label>Name<input className="clw-inp" autoFocus value={dr.title} onChange={(e) => setDr({ ...dr, title: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") close(); }}
        onFocus={(e) => d.data.title.startsWith("Prep for the ") && e.target.select()} /></label>
      <Schedule d={dr} set={setDr} call={call} />
      <div className="clw-p1row">
        <Switch on={dr.p1} onChange={(v) => setDr({ ...dr, p1: v })} label="Priority 1" />
        <div><b>Priority 1</b><span>{dr.p1 ? "Lands at the top of your list" : `Lands in ${sec}`}</span></div>
      </div>
      <div className="clw-land">{comesInWords(preview, day, endHm)}</div>
      <div className="row">
        <button type="button" className="clw-btn sm danger" onClick={() => { void removeClientTodo(d.id).then(() => say(`${d.data.title} removed.`)); onClose(); }}>{I.trash}Remove</button>
        <span className="clw-sp" />
        <button type="button" className="clw-btn sm pri" onClick={close}>Done</button>
      </div>
    </Pop>
  );
}
