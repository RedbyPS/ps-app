// Reminders ON tasks (V1.55, the developer 12 Nov 2026): "if I right click on the task or click edit on the task I can add an
// annoying 15 minute reminder and when I click on the settings for it it will pop up with the 15 minute reminder display
// where I can then customize the reminder for the task and I can have a task recurring every day etc."
// - Add annoying reminder (the right click menu, the task's edit, the bell) opens this pop-up: the same reminder display
//   as Settings > Annoying 15 min reminder, filled in for the task (its name on the pop-up, once today from the next
//   whole hour, Done in one click). Nothing is saved until Add reminder; Cancel or Esc leaves no trace.
// - Once it has one, the same pop-up changes it as you go (like Settings), and Remove reminder takes it away.
// - Repeat: once on a day, every day, weekdays or chosen days. On a one-off task a repeating reminder offers
//   "Make it an Every day task too".
// - The bell on the task row: the next time on hover, a click opens this pop-up.
// The rules are in core/remind.ts; the pop-ups and notifications come from the shells like every other reminder.
// Esc closes it (one layer: a Test showing ends first). Motion: transform and opacity only, none with Reduce motion.
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Doc, Todo } from "../core/model";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { isRedAccount } from "../core/account";
import { remindRec } from "../core/select";
import { saveRemind } from "../core/actions";
import { DEVICE_TZ } from "../core/tz";
import {
  REM_TASK_MAX, addTaskReminder, cleanReminder, freshId, newTaskReminder, nextWords, onTasksOf, patchReminder, pillOf, remindOrDefault,
  reminderOfTask, removeReminder, repeatOf, type Reminder,
} from "../core/remind";
import { RemEditor, RemTestCard } from "./RemindSettings";
import { stopTest, useRemSound } from "../remsound";
import { taskMapActions } from "./TaskMap";
import "./remind.css";

type Open = { task: string; root: Element | null; key: number };
let open: Open | null = null;
const subs = new Set<() => void>();
const setOpen = (o: Open | null) => { open = o; subs.forEach((f) => f()); };
const useOpen = () => useSyncExternalStore((l) => { subs.add(l); return () => { subs.delete(l); }; }, () => open);

/** Opens the reminder pop-up for a task. `from`: the element clicked (so only that list's host shows it). */
export function openTaskRemind(task: string, from?: Element | null) {
  sfx.click();
  // A click inside a list: that list. One floating on the page (the Overdue card's edit): the only list there is.
  const lists = document.querySelectorAll(".tm-overlay");
  const root = from ? (from.closest(".tm-overlay") ?? (from.closest(".tm-ctx-ed") && lists.length === 1 ? lists[0] : null)) : null;
  setOpen({ task, root, key: Date.now() });
}
export const closeTaskRemind = () => { if (open) setOpen(null); };

/** The menu's words: "Add annoying reminder", or "Reminder settings" once the task has one. */
export function useTaskReminder(task: string): Reminder | null {
  const s = useVault();
  return s.status === "unlocked" ? reminderOfTask(remindRec(s), task) : null;
}
export function reminderWords(has: boolean) { return has ? "Reminder settings" : "Add annoying reminder"; }

/** One per list, next to the task menu (views/TaskMenu.tsx TaskMenuHost); only the one the click came from shows. */
export function TaskRemindHost() {
  const o = useOpen();
  const probe = useRef<HTMLSpanElement>(null);
  const mine = !!o && !!probe.current && probe.current.closest(".tm-overlay") === o.root;
  return <><span ref={probe} hidden />{mine && o && <Pop key={o.key} task={o.task} />}</>;
}

/** Esc for a pop-up: a Test showing ends first (its own listener is newer), then the pop-up closes. Nothing behind it sees the key. */
function useEscClose(close: () => void) {
  const snd = useRemSound();
  const testing = useRef(false);
  testing.current = !!snd.testing;
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (testing.current) { stopTest(); return; }
      closeRef.current();
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
}

/** The pop-up itself, shared by a task's reminder (Pop) and the one set up while adding a task (DraftRemindPop, PS 1.68). */
function PopFrame({ title, small, accent, closing, onClose, sw, intro, children, foot }: {
  title: string; small: string; accent: string; closing: boolean; onClose: () => void; sw?: ReactNode; intro: ReactNode; children: ReactNode; foot: ReactNode;
}) {
  return createPortal(
    <div className={`trm-layer${closing ? " out" : ""}`} onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <div className="trm-pop" role="dialog" aria-modal="true" aria-label={`Reminder on ${title}`} style={{ "--rm-acc": accent } as CSSProperties}>
        <header className="trm-head">
          <span className="trm-bell" aria-hidden="true"><BellIcon /></span>
          <span className="trm-t">
            <small>{small}</small>
            <b>{title}</b>
          </span>
          {sw}
          <button type="button" className="trm-x" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </header>
        <p className="trm-intro">{intro}</p>
        <div className="trm-body">{children}</div>
        <footer className="trm-foot">{foot}</footer>
      </div>
      <RemTestCard />
    </div>,
    document.body,
  );
}
const INTRO = "A pop-up on your Mac and a notification on your phone that keeps coming back until you answer, with this task's name on it.";
const EVERY_DAY_NOTE = "This is an Every day task: Done ticks it for today, and the reminder comes back next time.";
function MakeDaily({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="rm-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => { sfx.hover(); onChange(e.target.checked); }} />
      <span><b>Make it an Every day task too</b>Done ticks the task. A one-off task leaves with its reminder once ticked, so a repeating reminder keeps coming back only on an Every day task.</span>
    </label>
  );
}

function Pop({ task }: { task: string }) {
  const s = useVault();
  const red = isRedAccount(s);
  const ready = s.status === "unlocked";
  const d = s.docs.get(task) as Doc<Todo> | undefined;
  const t = d?.kind === "todo" ? d.data : undefined;
  const saved = ready ? reminderOfTask(remindRec(s), task) : null;
  // A new one is a draft here until Add reminder (its own id, so a sound picked for it stays with it).
  const [draft, setDraft] = useState<Reminder | null>(() => (saved ? null : newTaskReminder(freshId(remindOrDefault(remindRec(s), red)), task, Date.now(), DEVICE_TZ)));
  const [everyDay, setEveryDay] = useState(false);
  const [closing, setClosing] = useState(false);
  const [sure, setSure] = useState(false);
  const full = ready && onTasksOf(remindOrDefault(remindRec(s), red)).length >= REM_TASK_MAX;
  const r = saved ?? draft;
  const close = () => { if (closing) return; setClosing(true); stopTest(); window.setTimeout(closeTaskRemind, 170); };
  useEscClose(close);
  useEffect(() => { if (sure) { const x = window.setTimeout(() => setSure(false), 4000); return () => clearTimeout(x); } }, [sure]);
  // The task went (deleted on another device): nothing left to set.
  useEffect(() => { if (ready && !t) close(); }, [ready, t]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!t || !r) return null;

  const change = (fn: (rec: ReturnType<typeof remindOrDefault>) => ReturnType<typeof remindOrDefault>) => {
    void saveRemind((cur) => fn(remindOrDefault(cur, red))).catch(() => {});
  };
  const set = (patch: Partial<Reminder>) => {
    if (saved) change((x) => patchReminder(x, saved.id, patch, Date.now()));
    else setDraft((x) => (x ? cleanReminder({ ...x, ...patch }, Date.now()) ?? x : x));
  };
  const once = t.type === "once";
  const repeats = repeatOf(r) !== "once";
  const makeDaily = () => void taskMapActions.update(task, { type: "daily", repeat: null, due: null, p1: false });
  const add = () => {
    if (!draft || full) return;
    sfx.done();
    const now = Date.now();
    change((x) => addTaskReminder(x, { ...draft, edited: now }, now));
    if (everyDay && once && repeats) makeDaily();
    close();
  };
  const remove = () => {
    if (!saved) return;
    sfx.click(); stopTest();
    change((x) => removeReminder(x, saved.id, Date.now()));
    close();
  };
  const whenExtra = once && repeats
    ? <MakeDaily checked={saved ? false : everyDay} disabled={!ready} onChange={(on) => { if (saved) { if (on) makeDaily(); } else setEveryDay(on); }} />
    : !once ? <p className="rm-note">{EVERY_DAY_NOTE}</p> : null;

  return (
    <PopFrame title={t.title} small={saved ? "Reminder on this task" : "Add an annoying reminder"} accent={r.accent} closing={closing} onClose={close}
      sw={saved && (
        <button type="button" className={`rm-switch${saved.on ? " on" : ""}`} role="switch" aria-checked={saved.on} aria-label={`${pillOf(saved)} on or off`}
          onClick={() => { sfx.hover(); set({ on: !saved.on }); }}><i /></button>
      )}
      intro={<>{INTRO}{saved ? ` ${nextWords(saved, remindRec(s)?.state[saved.id], Date.now(), DEVICE_TZ, t.done)}.` : ""}</>}
      foot={saved
        ? <>
            {!sure
              ? <button type="button" className="rm-small danger" onClick={() => { sfx.hover(); setSure(true); }}>Remove reminder</button>
              : <button type="button" className="rm-small danger sure" onClick={remove}>Sure? Remove it</button>}
            <span className="rm-grow" />
            <span className="rm-soft">Changes save as you go.</span>
            <button type="button" className="trm-go" onClick={() => { sfx.click(); close(); }}>Done</button>
          </>
        : <>
            <span className="rm-soft">{full ? `${REM_TASK_MAX} reminders on tasks is the most.` : !ready ? "Sign in to add a reminder." : "Esc or Cancel leaves the task as it is."}</span>
            <span className="rm-grow" />
            <button type="button" className="rm-small" onClick={() => { sfx.hover(); close(); }}>Cancel</button>
            <button type="button" className="trm-go" disabled={!ready || full} onClick={add}>Add reminder</button>
          </>}>
      <RemEditor r={r} red={red} set={set} ready={ready} taskTitle={t.title} whenExtra={whenExtra} />
    </PopFrame>
  );
}

// ---------- PS 1.68: the reminder set up in the Add a task window, before the task exists ----------
// The same pop-up and the same reminder display as a task's Edit (Jan, 18 Nov 2026: "I don't see the option to add the annoying
// reminder" when adding). Nothing is saved here: Add reminder hands the reminder back to the Add a task window, which keeps it
// with the task being typed, and the reminder joins the synced list once the task is added and has its id (core/remind.ts
// addDraftTaskReminder). Picked again before Add task, it changes that kept reminder as you go, and Remove reminder drops it.
/** The task id a reminder carries while its task is still being typed (replaced by the real id when the task is added). */
export const DRAFT_TASK = "new-task";
let draftClose: (() => void) | null = null;
/** Is a reminder pop-up open (a task's, or the Add a task window's)? The Add a task window leaves Esc to it then. */
export const remindPopOpen = () => !!open || !!draftClose;
/** Close whichever reminder pop-up is open (the Mac's own Esc path); true when one was open. */
export function closeRemindPop(): boolean {
  if (draftClose) { draftClose(); return true; }
  if (open) { closeTaskRemind(); return true; }
  return false;
}

export function DraftRemindPop({ title, once, value, onSave, onClose }: {
  title: string; once: boolean; value: Reminder | null;
  /** The reminder kept with the new task (null: removed). `daily`: make the new task an Every day task too. */
  onSave: (r: Reminder | null, daily?: boolean) => void;
  onClose: () => void;
}) {
  const s = useVault();
  const red = isRedAccount(s);
  const ready = s.status === "unlocked";
  const [r, setR] = useState<Reminder>(() => value ?? newTaskReminder(freshId(remindOrDefault(remindRec(s), red)), DRAFT_TASK, Date.now(), DEVICE_TZ));
  const [everyDay, setEveryDay] = useState(false);
  const [closing, setClosing] = useState(false);
  const full = !value && ready && onTasksOf(remindOrDefault(remindRec(s), red)).length >= REM_TASK_MAX;
  const close = () => { if (closing) return; setClosing(true); stopTest(); window.setTimeout(onClose, 170); };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => { const f = () => closeRef.current(); draftClose = f; return () => { if (draftClose === f) draftClose = null; }; }, []);
  useEscClose(close);
  const set = (patch: Partial<Reminder>) => {
    const next = cleanReminder({ ...r, ...patch }, Date.now()) ?? r;
    setR(next);
    if (value) onSave(next);   // already kept with the task: changes save as you go, like a task's own reminder
  };
  const name = title.trim() || "New task";
  const repeats = repeatOf(r) !== "once";
  const whenExtra = once && repeats ? <MakeDaily checked={everyDay} disabled={!ready} onChange={setEveryDay} />
    : !once ? <p className="rm-note">{EVERY_DAY_NOTE}</p> : null;
  const add = () => { if (full) return; sfx.done(); onSave({ ...r, edited: Date.now() }, everyDay && once && repeats); close(); };
  return (
    <PopFrame title={name} small={value ? "Reminder on this task" : "Add an annoying reminder"} accent={r.accent} closing={closing} onClose={close}
      intro={<>{INTRO} {DRAFT_WORDS.starts}</>}
      foot={value
        ? <>
            <button type="button" className="rm-small danger" onClick={() => { sfx.click(); stopTest(); onSave(null); close(); }}>Remove reminder</button>
            <span className="rm-grow" />
            <span className="rm-soft">Changes save as you go.</span>
            <button type="button" className="trm-go" onClick={() => { sfx.click(); close(); }}>Done</button>
          </>
        : <>
            <span className="rm-soft">{full ? `${REM_TASK_MAX} reminders on tasks is the most.` : !ready ? "Sign in to add a reminder." : DRAFT_WORDS.cancel}</span>
            <span className="rm-grow" />
            <button type="button" className="rm-small" onClick={() => { sfx.hover(); close(); }}>Cancel</button>
            <button type="button" className="trm-go" disabled={!ready || full} onClick={add}>Add reminder</button>
          </>}>
      <RemEditor r={r} red={red} set={set} ready={ready} taskTitle={name} whenExtra={whenExtra} />
    </PopFrame>
  );
}
/** The new words of the Add a task window's reminder (PS 1.68, waiting for the owner's approval). */
export const DRAFT_WORDS = {
  starts: "It starts once you add the task.",
  cancel: "Esc or Cancel adds no reminder.",
};

function BellIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

/** The bell on a task that has a reminder: the next time on hover, a click opens the pop-up. Nothing when it has none. */
export function TaskBell({ task, done }: { task: string; done?: boolean }) {
  const s = useVault();
  const r = s.status === "unlocked" ? reminderOfTask(remindRec(s), task) : null;
  // The words follow the clock (a minute is plenty for "Next: Today, 14:00").
  const [, tick] = useState(0);
  useEffect(() => { if (!r) return; const x = window.setInterval(() => tick((n) => n + 1), 60_000); return () => clearInterval(x); }, [r]);
  if (!r) return null;
  const words = nextWords(r, remindRec(s)?.state[r.id], Date.now(), DEVICE_TZ, done);
  const live = words === "Reminding you now";
  return (
    <button type="button" className={`tm-bell no-drag${r.on ? "" : " off"}${live ? " live" : ""}`} style={{ "--rm-acc": r.accent } as CSSProperties}
      data-tip={words} aria-label={`Reminder: ${words}. Open its settings`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); openTaskRemind(task, e.currentTarget); }}>
      <BellIcon size={14} />
    </button>
  );
}
