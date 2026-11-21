// Settings > Annoying 15 min reminder (the developer, 10 Nov 2026; rules in core/remind.ts). Every reminder in one list: add as
// many as you like, and for each: on or off, its words, when it starts and stops popping up and on which days, how long
// "Remind me in" puts it away and that button's words, the confirm button's words and what has to be typed (or one
// click), the pop-up's colours (presets and the colour wheel) with a live preview, a sound (none, the built in ones or
// your own file, which stays on this device), and Test, which shows it right now.
// One small vault record (kind "remind"), saved only when something changed: the Mac's cards and the phone's
// notifications follow it on every device. Text boxes save on Enter or when you leave them.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { isRedAccount } from "../core/account";
import { MWEB } from "../gos/bridge";
import { disablePush, enablePush, pushStatus } from "../remweb";
import { PUSH_WORDS, type PushState } from "../core/webpush";
import { remindRec } from "../core/select";
import { saveRemind } from "../core/actions";
import { HOME_COMMON, DEVICE_TZ, tzLabel } from "../core/tz";
import {
  REM_COLOURS, REM_LABEL_MAX, REM_MAX, REM_SNOOZE_MAX, REM_SNOOZE_MIN, REM_SOUNDS, REM_TEXT_MAX, ALL_DAYS, REPEAT_KINDS, TASK_PILL,
  addReminder, addAlarm, alarmsOf, alarmText, ALARM_LATER, ALARM_RING_MIN, ALARM_TITLE, ALARM_YES, alarmLook, freshId, laterOf, remLook, moveReminder, okSnooze, oneLine, patchReminder, pillOf, plainOf, onTasksOf, remPlan, remindOrDefault,
  removeReminder, remStatus, repeatOf, repeatPatch, taskQuestion, windowWords, wordOf, yesOf, type Reminder, type RemindRec, type PlanItem,
} from "../core/remind";
import type { Doc, Todo } from "../core/model";
import { todayISO } from "../ui/kit";
import { OWN_ACCEPT } from "../core/alarmsound";
import { ColorWheel } from "./ColorWheel";
import { clearNote, importOwn, pickOnMac, picksNatively, removeOwn, remSoundWhere, stopTest, testReminder, useRemSound } from "../remsound";
import { DUE_NAG_PILL, DUE_P1_TEXT, DUE_P1_TITLE, DUE_P1_WORD, DUE_P1_YES } from "../core/remind";
import { dueCfgOf, fillWords, patchDue } from "../core/duealerts";
import { dayView } from "../daycount";
import "./remind.css";

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SNOOZE_QUICK = [5, 10, 15, 30, 60];
const plusDay = (n: number) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toLocaleDateString("en-CA"); };
const WHERE_LINE = remSoundWhere === "mac" ? "Cards pop up on this Mac and notifications on your phone, from the same list."
  : remSoundWhere === "phone" ? "Notifications on this phone and cards on your Mac, from the same list."
  : "They pop up as cards in PS app on your Mac and as notifications in PS app on your phone.";

const ALARM_LINE = `Your phone rings like an alarm at the time you pick, full screen, even in Do Not Disturb, for up to ${ALARM_RING_MIN} minutes. ${ALARM_LATER} rings again in 5. Your Mac shows a card too. ${ALARM_YES} on either one stops both.`;

function useRemind() {
  const s = useVault();
  const red = isRedAccount(s);
  const saved = s.status === "unlocked" ? remindRec(s) : null;
  const rec = remindOrDefault(saved, red);
  const change = (fn: (r: RemindRec) => RemindRec) => { void saveRemind((cur) => fn(remindOrDefault(cur, red))).catch(() => {}); };
  return { rec, red, ready: s.status === "unlocked", saved: !!saved, change };
}

/** 1.60: "Allow reminders on this iPhone" (Web Push while the web app is closed). Only on the iPhone web app. */
function IphoneReminders() {
  const [st, setSt] = useState<PushState>("feature-off");
  const [note, setNote] = useState("");
  useEffect(() => { void pushStatus().then(setSt); }, []);
  if (st === "feature-off" || st === "unsupported") return null;
  const msg = st === "old-ios" ? PUSH_WORDS.old : st === "needs-home-screen" ? PUSH_WORDS.needHome : st === "blocked" ? PUSH_WORDS.blocked : note;
  return (
    <div className="rm-iphone">
      {st === "on" ? <>
        <p className="rm-help">{PUSH_WORDS.on}</p>
        <button type="button" className="rm-btn" onClick={() => { void disablePush().then(setSt); }}>{PUSH_WORDS.turnOff}</button>
      </> : st === "ask" ? <>
        <button type="button" className="rm-btn" onClick={() => { void enablePush().then((r) => { setSt(r.state); setNote(r.note ?? ""); }); }}>{PUSH_WORDS.button}</button>
        <p className="rm-help">{PUSH_WORDS.help}</p>
      </> : null}
      {msg && <p className="rm-help" role="status">{msg}</p>}
    </div>
  );
}

export function RemindSettings() {
  const { rec, red, ready, saved, change } = useRemind();
  const plain = plainOf(rec), onTasks = onTasksOf(rec), alarms = alarmsOf(rec);
  const own = plain.length + alarms.length;
  const [open, setOpen] = useState<string | null>(() => (plain.length === 1 ? plain[0].id : null));
  const fresh = useRef<string | null>(null);
  const add = (alarm = false) => {
    sfx.click();
    const id = freshId(rec);
    fresh.current = id;
    change((r) => (alarm ? addAlarm(r, id, Date.now()) : addReminder(r, id, Date.now())));
    setOpen(id);
  };
  return (
    <div className="rm-wrap">
      {MWEB && <IphoneReminders />}
      <p className="rm-intro">
        Pop-ups that keep coming back until you answer. {WHERE_LINE} Remind me in puts one away for its snooze, then it comes back.
      </p>
      <ul className="rm-list">
        {plain.map((r, i) => (
          <ReminderItem key={r.id} r={r} red={red} rec={rec} first={i === 0} last={i === plain.length - 1} isNew={fresh.current === r.id}
            open={open === r.id} setOpen={(v) => setOpen(v ? r.id : null)} change={change} ready={ready} saved={saved} />
        ))}
      </ul>
      {!plain.length && <p className="rm-empty">No reminders. Add one below.</p>}
      <div className="rm-foot">
        <button type="button" className="rm-add" onClick={() => add()} disabled={!ready || own >= REM_MAX}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Add reminder
        </button>
        {own >= REM_MAX && <span className="rm-soft">{REM_MAX} reminders and alarms is the most.</span>}
        {!ready && <span className="rm-soft">Sign in to change your reminders.</span>}
      </div>
      {/* V1.57: alarms. The phone rings like the gym ring, the Mac shows the matching card. */}
      <h4 className="rm-h">Alarms</h4>
      <p className="rm-intro">{ALARM_LINE}</p>
      {alarms.length
        ? <ul className="rm-list">
            {alarms.map((r, i) => (
              <ReminderItem key={r.id} r={r} red={red} rec={rec} first={i === 0} last={i === alarms.length - 1} isNew={fresh.current === r.id}
                open={open === r.id} setOpen={(v) => setOpen(v ? r.id : null)} change={change} ready={ready} saved={saved} />
            ))}
          </ul>
        : <p className="rm-empty">No alarms yet.</p>}
      <div className="rm-foot">
        <button type="button" className="rm-add" onClick={() => add(true)} disabled={!ready || own >= REM_MAX}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          Add alarm
        </button>
      </div>
      {/* PS 1.73: the nag for every task due today and the Priority 1 alarm (core/duealerts.ts). */}
      <DueSection rec={rec} red={red} ready={ready} open={open} setOpen={setOpen} change={change} />
      {/* V1.55: reminders on tasks (added from a task's right click menu or its edit), changed here too. */}
      <h4 className="rm-h">On your tasks</h4>
      {onTasks.length
        ? <ul className="rm-list">
            {onTasks.map((r, i) => (
              <ReminderItem key={r.id} r={r} red={red} rec={rec} first={i === 0} last={i === onTasks.length - 1} isNew={false}
                open={open === r.id} setOpen={(v) => setOpen(v ? r.id : null)} change={change} ready={ready} saved={saved} />
            ))}
          </ul>
        : <p className="rm-empty">None yet. Right click a task (or open its edit) and pick Add annoying reminder.</p>}
    </div>
  );
}

function ReminderItem({ r, red, rec, first, last, isNew, open, setOpen, change, ready, saved }: {
  r: Reminder; red: boolean; rec: RemindRec; first: boolean; last: boolean; isNew: boolean; open: boolean; setOpen: (v: boolean) => void;
  change: (fn: (r: RemindRec) => RemindRec) => void; ready: boolean; saved: boolean;
}) {
  const set = (patch: Partial<Reminder>) => change((x) => patchReminder(x, r.id, patch, Date.now()));
  // Done, Snoozed or Showing only once the list is saved (before that nothing pops up anywhere).
  const status = ready && saved ? remStatus(r, rec.state[r.id], Date.now(), DEVICE_TZ) : "closed";
  const title = useTaskTitle(r.task);
  const question = r.alarm ? alarmText(r) : r.task ? taskQuestion(r, title) : r.text;
  const [sure, setSure] = useState(false);
  useEffect(() => { if (!sure) return; const t = window.setTimeout(() => setSure(false), 4000); return () => clearTimeout(t); }, [sure]);
  return (
    <li className={`rm-item${open ? " open" : ""}${isNew ? " rm-new" : ""}${r.on ? "" : " off"}`} style={{ "--rm-acc": r.accent } as CSSProperties}>
      <div className="rm-head">
        <button type="button" className={`rm-switch${r.on ? " on" : ""}`} role="switch" aria-checked={r.on} aria-label={`${pillOf(r)} on or off`} disabled={!ready}
          onClick={() => { sfx.hover(); set({ on: !r.on }); }}><i /></button>
        <button type="button" className="rm-sum" onClick={() => { sfx.hover(); setOpen(!open); }} aria-expanded={open}>
          <span className="rm-dot" aria-hidden="true" />
          <span className="rm-sum-t">
            <b>{question || "Your question"}</b>
            <span>{pillOf(r)} · {windowWords(r)}{r.tz ? ` · ${tzLabel(r.tz)}` : ""}</span>
          </span>
          {status === "done" && r.on && <em className="rm-pill good">Done</em>}
          {status === "snoozed" && r.on && <em className="rm-pill amber">Snoozed</em>}
          {status === "show" && r.on && <em className="rm-pill live">Showing</em>}
          <svg className="rm-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>
      <div className="rm-body" aria-hidden={!open}>
        <div className="rm-body-in">
          {open && (r.alarm ? <AlarmEditor r={r} red={red} set={set} ready={ready} /> : <RemEditor r={r} red={red} set={set} ready={ready} taskTitle={r.task ? title ?? "" : undefined} />)}
          {open && (
            <div className="rm-tools">
              <button type="button" className="rm-small" disabled={first || !ready} onClick={() => { sfx.hover(); change((x) => moveReminder(x, r.id, -1, Date.now())); }}>Move up</button>
              <button type="button" className="rm-small" disabled={last || !ready} onClick={() => { sfx.hover(); change((x) => moveReminder(x, r.id, 1, Date.now())); }}>Move down</button>
              <span className="rm-grow" />
              {!sure
                ? <button type="button" className="rm-small danger" disabled={!ready} onClick={() => { sfx.hover(); setSure(true); }}>Remove</button>
                : <button type="button" className="rm-small danger sure" onClick={() => { sfx.click(); stopTest(); change((x) => removeReminder(x, r.id, Date.now())); }}>Sure? Remove it</button>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/** A text box that saves on Enter or when you leave it; Esc puts the saved words back. */
function TextBox({ value, placeholder, max, save, label, wide }: { value: string; placeholder: string; max: number; save: (v: string) => void; label: string; wide?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const commit = () => { const t = oneLine(draft, max); if (t !== value) save(t); else setDraft(t); };
  return (
    <label className={`rm-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <input className="rm-input" type="text" value={draft} maxLength={max} placeholder={placeholder} spellCheck={false}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape" && draft !== value) { e.preventDefault(); e.stopPropagation(); setDraft(value); } }} />
    </label>
  );
}

function Sec({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="rm-sec">
      <h4>{title}</h4>
      {children}
      {note && <p className="rm-note">{note}</p>}
    </section>
  );
}

function Seg<T extends string | boolean>({ value, options, pick, label }: { value: T; options: { id: T; label: string }[]; pick: (v: T) => void; label: string }) {
  return (
    <div className="rm-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.id)} type="button" role="radio" aria-checked={o.id === value} className={o.id === value ? "on" : ""}
          onClick={() => { if (o.id !== value) { sfx.hover(); pick(o.id); } }}>{o.label}</button>
      ))}
    </div>
  );
}

/** A task's name, live from the vault (undefined: no task, or not found). */
export function useTaskTitle(task: string | undefined): string | undefined {
  const s = useVault();
  if (!task) return undefined;
  const d = s.docs.get(task) as Doc<Todo> | undefined;
  return d?.kind === "todo" ? d.data.title : undefined;
}

/** The editor of one reminder (Settings, and the pop-up on a task: `taskTitle` set). `whenExtra`: more under When. */
/** PS 1.73: the nag for tasks due today and the Priority 1 alarm use these editors with their own When (`due.when`), their words
 *  filled in from an example task (`due.fill`), and their own placeholder and note under the words. */
export interface DueEd { when: ReactNode; fill: (r: Reminder) => string; placeholder: string; note: string }
export function RemEditor({ r, red, set, ready, taskTitle, whenExtra, due }: { r: Reminder; red: boolean; set: (p: Partial<Reminder>) => void; ready: boolean; taskTitle?: string; whenExtra?: ReactNode; due?: DueEd }) {
  const onTask = taskTitle !== undefined;
  // Colours being tried right now (the wheel while it is dragged): shown at once, saved a moment after you stop.
  const [look, setLook] = useState({ bg: r.bg, accent: r.accent });
  const lookT = useRef(0);
  useEffect(() => { if (!lookT.current) setLook({ bg: r.bg, accent: r.accent }); }, [r.bg, r.accent]);
  const tryLook = (p: Partial<{ bg: string; accent: string }>, wait = 0) => {
    const next = { ...look, ...p };
    setLook(next);
    window.clearTimeout(lookT.current);
    const go = () => { lookT.current = 0; if (next.bg !== r.bg || next.accent !== r.accent) set(next); };
    if (wait) lookT.current = window.setTimeout(go, wait); else go();
  };
  const [wheel, setWheel] = useState<"bg" | "accent" | null>(null);
  const shown: Reminder = { ...r, ...look };
  const item: PlanItem = remPlan({ v: 1, list: [shown], state: {}, gone: {}, at: 0 }, red).items[0];
  if (onTask) item.text = taskQuestion(shown, taskTitle);
  if (due) item.text = due.fill(shown);
  const repeat = repeatOf(r);
  const zones = useMemo(() => [...new Set([...HOME_COMMON, ...(r.tz ? [r.tz] : [])])], [r.tz]);
  const snd = useRemSound();
  const testing = snd.testing?.id === r.id;
  const fileRef = useRef<HTMLInputElement>(null);
  const own = snd.own[r.id];
  const note = snd.note?.id === r.id ? snd.note.text : null;
  const [vol, setVol] = useState(r.vol);
  useEffect(() => { setVol(r.vol); }, [r.vol]);
  const fallbackQ = onTask ? taskQuestion({ text: "" }, taskTitle) : "HAVE YOU DONE IT YET?";

  return (
    <div className={`rm-ed${ready ? "" : " rm-notyet"}`}>
      <div className="rm-cols">
        <div className="rm-col">
          <Sec title="Words">
            <TextBox label={onTask || due ? "Words on the pop-up" : "Question"} value={r.text} placeholder={due ? due.placeholder : fallbackQ} max={REM_TEXT_MAX} save={(text) => set({ text })} wide />
            <TextBox label="Small label on top" value={r.label} placeholder={due ? DUE_NAG_PILL : onTask ? TASK_PILL : "Daily reminder"} max={REM_LABEL_MAX} save={(label) => set({ label })} />
            {onTask && <p className="rm-note">Empty: the task's name. The pop-up has three buttons: {laterOf(r)}, {yesOf(r)} (ticks the task) and Open task.</p>}
            {due && <p className="rm-note">{due.note}</p>}
          </Sec>

          {due ? <Sec title="When it pops up">{due.when}</Sec> : <Sec title="When it pops up" note={`It starts at the first time and keeps coming back until you answer. After the second time it no longer starts, but one already up stays until you answer.${r.until <= r.at ? " This one runs past midnight." : ""}`}>
            <div className="rm-row">
              <label className="rm-field"><span>Starts</span>
                <input className="rm-input rm-time" type="time" value={r.at} onChange={(e) => { const v = e.target.value; if (/^\d\d:\d\d$/.test(v) && v !== r.until) set({ at: v }); }} />
              </label>
              <label className="rm-field"><span>Stops</span>
                <input className="rm-input rm-time" type="time" value={r.until} onChange={(e) => { const v = e.target.value; if (/^\d\d:\d\d$/.test(v) && v !== r.at) set({ until: v }); }} />
              </label>
              <label className="rm-field"><span>Time zone</span>
                <select className="rm-input" value={r.tz} onChange={(e) => set({ tz: e.target.value })}>
                  <option value="">This device's time</option>
                  {zones.map((z) => <option key={z} value={z}>{tzLabel(z)}</option>)}
                </select>
              </label>
            </div>
            {onTask && (
              <div className="rm-repeat">
                <Seg label="Repeat" value={repeat} pick={(k) => set(repeatPatch(r, k, todayISO()))} options={REPEAT_KINDS} />
                {repeat === "once" && (
                  <div className="rm-row">
                    <label className="rm-field"><span>On</span>
                      <input className="rm-input rm-date" type="date" value={r.date ?? ""} onChange={(e) => { const v = e.target.value; if (/^\d{4}-\d{2}-\d{2}$/.test(v)) set({ date: v }); }} />
                    </label>
                    <button type="button" className={`rm-small${r.date === todayISO() ? " on" : ""}`} onClick={() => { sfx.hover(); set({ date: todayISO() }); }}>Today</button>
                    <button type="button" className={`rm-small${r.date === plusDay(1) ? " on" : ""}`} onClick={() => { sfx.hover(); set({ date: plusDay(1) }); }}>Tomorrow</button>
                  </div>
                )}
              </div>
            )}
            {(!onTask || repeat === "days") && <div className="rm-days" role="group" aria-label="Days">
              {ALL_DAYS.map((d) => {
                const on = r.days.includes(d);
                return <button key={d} type="button" aria-pressed={on} aria-label={DAY_NAMES[d]} className={on ? "on" : ""} data-tip={DAY_NAMES[d]}
                  onClick={() => { sfx.hover(); set({ days: on ? r.days.filter((x) => x !== d) : [...r.days, d] }); }}>{DAY_LETTERS[d]}</button>;
              })}
              {!onTask && <>
                <button type="button" className="rm-small" onClick={() => { sfx.hover(); set({ days: [...ALL_DAYS] }); }}>Every day</button>
                <button type="button" className="rm-small" onClick={() => { sfx.hover(); set({ days: [1, 2, 3, 4, 5] }); }}>Weekdays</button>
              </>}
            </div>}
            {whenExtra}
          </Sec>}

          <Sec title="Remind me in">
            <div className="rm-row">
              <label className="rm-field"><span>Snooze for (minutes)</span>
                <SnoozeBox value={r.snooze} save={(snooze) => set({ snooze })} />
              </label>
              <div className="rm-quick">
                {SNOOZE_QUICK.map((m) => <button key={m} type="button" className={`rm-small${r.snooze === m ? " on" : ""}`} onClick={() => { sfx.hover(); set({ snooze: m }); }}>{m}</button>)}
              </div>
            </div>
            <TextBox label="Button words" value={r.later} placeholder={laterOf({ later: "", snooze: r.snooze })} max={REM_LABEL_MAX} save={(later) => set({ later })} wide />
            <p className="rm-note">Empty: "{laterOf({ later: "", snooze: r.snooze })}", and the number follows the snooze. Type {"{n}"} in your own words for the minutes.</p>
          </Sec>

          <Sec title="Confirm button">
            <TextBox label="Button words" value={r.yes} placeholder="Yes" max={REM_LABEL_MAX} save={(yes) => set({ yes })} />
            <Seg label="How it clears" value={r.click} pick={(click) => set({ click })} options={[{ id: false, label: `Type ${wordOf(r)}` }, { id: true, label: "One click" }]} />
            {!r.click && <TextBox label="What has to be typed" value={r.word} placeholder={yesOf(r)} max={REM_LABEL_MAX} save={(word) => set({ word })} />}
            <p className="rm-note">{r.click ? `One click on ${yesOf(r)} clears it.` : `${yesOf(r)} opens a box, and only typing ${wordOf(r)} (any case) clears it.`}</p>
          </Sec>
        </div>

        <div className="rm-col">
          <Sec title="Preview">
            <RemCard item={item} />
            <div className="rm-row">
              {!testing
                ? <button type="button" className="rm-test" disabled={!ready} onClick={() => { sfx.click(); testReminder(item); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>Test it now</button>
                : <button type="button" className="rm-test stop" onClick={() => { sfx.hover(); stopTest(); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h12v12H6z" /></svg>Stop</button>}
              <span className="rm-soft">{testing ? "Showing now. Esc or Stop ends it." : remSoundWhere === "phone" ? "Shows the notification now, with its sound." : "Shows it now, with its sound."}</span>
            </div>
            {testing && <TestEsc />}
          </Sec>

          <Sec title="Colour">
            <div className="rm-swatches" role="radiogroup" aria-label="Colours">
              {REM_COLOURS.map((c) => {
                const on = look.bg === c.bg && look.accent === c.accent;
                return <button key={c.id} type="button" role="radio" aria-checked={on} className={`rm-sw${on ? " on" : ""}`} data-tip={c.label} aria-label={c.label}
                  style={{ "--sw-bg": c.bg, "--sw-acc": c.accent } as CSSProperties} onClick={() => { sfx.hover(); tryLook({ bg: c.bg, accent: c.accent }); }}><i /></button>;
              })}
            </div>
            <div className="rm-row">
              <button type="button" className={`rm-pick${wheel === "bg" ? " on" : ""}`} onClick={() => { sfx.hover(); setWheel(wheel === "bg" ? null : "bg"); }}>
                <i style={{ background: look.bg }} />Background
              </button>
              <button type="button" className={`rm-pick${wheel === "accent" ? " on" : ""}`} onClick={() => { sfx.hover(); setWheel(wheel === "accent" ? null : "accent"); }}>
                <i style={{ background: look.accent }} />Accent
              </button>
            </div>
            {wheel && <div className="rm-wheel"><ColorWheel label={wheel === "bg" ? "Background" : "Accent"} value={wheel === "bg" ? look.bg : look.accent}
              onChange={(hex) => tryLook(wheel === "bg" ? { bg: hex } : { accent: hex }, 450)} /></div>}
          </Sec>

          <Sec title="Sound when it pops up">
            <Seg label="Sound" value={due && r.sound === "own" ? "soft" : r.sound} pick={(sound) => set({ sound })} options={REM_SOUNDS.filter((s) => !due || s.id !== "own").map((s) => ({ id: s.id, label: s.label }))} />
            {r.sound === "own" && (
              <div className="rm-own">
                {own
                  ? <span className="rm-own-n"><b>{own.name}</b> {own.secs ? `${own.secs.toFixed(1)} s` : ""}</span>
                  : <span className="rm-soft">{snd.busy === r.id ? "Reading the file..." : "No file on this device yet: it plays the soft chime."}</span>}
                {picksNatively()
                  ? <button type="button" className="rm-small" disabled={snd.busy === r.id} onClick={() => { sfx.hover(); clearNote(); pickOnMac(r.id); }}>{own ? "Change" : "Pick a sound file"}</button>
                  : <>
                      <button type="button" className="rm-small" disabled={snd.busy === r.id} onClick={() => { sfx.hover(); clearNote(); fileRef.current?.click(); }}>{own ? "Change" : "Pick a sound file"}</button>
                      <input ref={fileRef} type="file" accept={OWN_ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void importOwn(r.id, f); }} />
                    </>}
                {own && <button type="button" className="rm-small" onClick={() => { sfx.hover(); removeOwn(r.id); }}>Remove</button>}
              </div>
            )}
            {note && <p className="rm-note warn">{note}</p>}
            {r.sound !== "none" && (
              <label className="rm-field wide"><span>Loudness: {Math.round(vol * 100)}% of this device's volume</span>
                <input className="rm-range" type="range" min={10} max={100} step={5} value={Math.round(vol * 100)} aria-label="Loudness"
                  onChange={(e) => setVol(Number(e.target.value) / 100)}
                  onPointerUp={() => { if (vol !== r.vol) set({ vol }); }} onKeyUp={() => { if (vol !== r.vol) set({ vol }); }} onBlur={() => { if (vol !== r.vol) set({ vol }); }} />
              </label>
            )}
            {r.sound === "own" && <p className="rm-note">mp3, m4a, wav or aiff, up to 20 MB (the first minute). Your sound stays on this device only: never uploaded, never synced. Pick it again on your other devices.</p>}
          </Sec>
        </div>
      </div>
    </div>
  );
}

/** The editor of one alarm (V1.57): when it rings, its title, words and stop button, its colours (the phone's ring screen
 *  and the Mac's card) and the Mac card's sound. Later is always 5 minutes and one click stops it. */
function AlarmEditor({ r, red, set, ready, due }: { r: Reminder; red: boolean; set: (p: Partial<Reminder>) => void; ready: boolean; due?: DueEd }) {
  const [look, setLook] = useState({ bg: r.bg, accent: r.accent });
  const lookT = useRef(0);
  useEffect(() => { if (!lookT.current) setLook({ bg: r.bg, accent: r.accent }); }, [r.bg, r.accent]);
  const tryLook = (p: Partial<{ bg: string; accent: string }>, wait = 0) => {
    const next = { ...look, ...p };
    setLook(next);
    window.clearTimeout(lookT.current);
    const go = () => { lookT.current = 0; if (next.bg !== r.bg || next.accent !== r.accent) set(next); };
    if (wait) lookT.current = window.setTimeout(go, wait); else go();
  };
  const [wheel, setWheel] = useState<"bg" | "accent" | null>(null);
  const shown: Reminder = { ...r, ...look };
  const item: PlanItem = remPlan({ v: 1, list: [shown], state: {}, gone: {}, at: 0 }, red).items[0];
  if (due) Object.assign(item, { text: due.fill(shown), pill: shown.label || DUE_P1_TITLE, yes: shown.yes || DUE_P1_YES, one: true, at: "19:30",   // an example ring time
    click: false, word: shown.word || DUE_P1_WORD });
  const zones = useMemo(() => [...new Set([...HOME_COMMON, ...(r.tz ? [r.tz] : [])])], [r.tz]);
  const snd = useRemSound();
  const testing = snd.testing?.id === r.id;
  return (
    <div className={`rm-ed${ready ? "" : " rm-notyet"}`}>
      <div className="rm-cols">
        <div className="rm-col">
          {due ? <Sec title="When it rings">{due.when}</Sec> : <Sec title="When it rings" note={`It rings on the days you pick, for up to ${ALARM_RING_MIN} minutes, until you stop it.`}>
            <div className="rm-row">
              <label className="rm-field"><span>Rings at</span>
                <input className="rm-input rm-time" type="time" value={r.at} onChange={(e) => { const v = e.target.value; if (/^\d\d:\d\d$/.test(v) && v !== r.at) set({ at: v }); }} />
              </label>
              <label className="rm-field"><span>Time zone</span>
                <select className="rm-input" value={r.tz} onChange={(e) => set({ tz: e.target.value })}>
                  <option value="">This device's time</option>
                  {zones.map((z) => <option key={z} value={z}>{tzLabel(z)}</option>)}
                </select>
              </label>
            </div>
            <div className="rm-days" role="group" aria-label="Days">
              {ALL_DAYS.map((d) => {
                const on = r.days.includes(d);
                return <button key={d} type="button" aria-pressed={on} aria-label={DAY_NAMES[d]} className={on ? "on" : ""} data-tip={DAY_NAMES[d]}
                  onClick={() => { sfx.hover(); set({ days: on ? r.days.filter((x) => x !== d) : [...r.days, d] }); }}>{DAY_LETTERS[d]}</button>;
              })}
              <button type="button" className="rm-small" onClick={() => { sfx.hover(); set({ days: [...ALL_DAYS] }); }}>Every day</button>
              <button type="button" className="rm-small" onClick={() => { sfx.hover(); set({ days: [1, 2, 3, 4, 5] }); }}>Weekdays</button>
            </div>
          </Sec>}
          <Sec title="Ring screen">
            <TextBox label="Title" value={r.label} placeholder={due ? DUE_P1_TITLE : ALARM_TITLE} max={REM_LABEL_MAX} save={(label) => set({ label })} />
            <TextBox label="Words" value={r.text} placeholder={due ? due.placeholder : alarmText({ text: "", at: r.at })} max={REM_TEXT_MAX} save={(text) => set({ text })} wide />
            <TextBox label="Stop button" value={r.yes} placeholder={due ? DUE_P1_YES : ALARM_YES} max={REM_LABEL_MAX} save={(yes) => set({ yes })} />
            {due && <TextBox label="What has to be typed" value={r.word} placeholder={DUE_P1_WORD} max={REM_LABEL_MAX} save={(word) => set({ word })} />}
            <p className="rm-note">{due ? due.note : `The other button is ${ALARM_LATER}: it rings again in 5 minutes.`}</p>
          </Sec>
        </div>
        <div className="rm-col">
          <Sec title="Preview">
            <AlarmScreen item={item} />
            <RemCard item={item} />
            <div className="rm-row">
              {!testing
                ? <button type="button" className="rm-test" disabled={!ready} onClick={() => { sfx.click(); testReminder(item); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>Test the card</button>
                : <button type="button" className="rm-test stop" onClick={() => { sfx.hover(); stopTest(); }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 6h12v12H6z" /></svg>Stop</button>}
              <span className="rm-soft">{testing ? "Showing now. Esc or Stop ends it." : "The phone's ring screen on top, the Mac's card below."}</span>
            </div>
            {testing && <TestEsc />}
          </Sec>
          <Sec title="Colour">
            <div className="rm-swatches" role="radiogroup" aria-label="Colours">
              {REM_COLOURS.map((c) => {
                const on = look.bg === c.bg && look.accent === c.accent;
                return <button key={c.id} type="button" role="radio" aria-checked={on} className={`rm-sw${on ? " on" : ""}`} data-tip={c.label} aria-label={c.label}
                  style={{ "--sw-bg": c.bg, "--sw-acc": c.accent } as CSSProperties} onClick={() => { sfx.hover(); tryLook({ bg: c.bg, accent: c.accent }); }}><i /></button>;
              })}
            </div>
            <div className="rm-row">
              <button type="button" className={`rm-pick${wheel === "bg" ? " on" : ""}`} onClick={() => { sfx.hover(); setWheel(wheel === "bg" ? null : "bg"); }}>
                <i style={{ background: look.bg }} />Background
              </button>
              <button type="button" className={`rm-pick${wheel === "accent" ? " on" : ""}`} onClick={() => { sfx.hover(); setWheel(wheel === "accent" ? null : "accent"); }}>
                <i style={{ background: look.accent }} />Accent
              </button>
            </div>
            {wheel && <div className="rm-wheel"><ColorWheel label={wheel === "bg" ? "Background" : "Accent"} value={wheel === "bg" ? look.bg : look.accent}
              onChange={(hex) => tryLook(wheel === "bg" ? { bg: hex } : { accent: hex }, 450)} /></div>}
          </Sec>
          <Sec title="Sound of the Mac card" note="The phone always rings with its own alarm sound, on the alarm volume.">
            <Seg label="Sound" value={r.sound === "own" ? "alarm" : r.sound} pick={(sound) => set({ sound })} options={REM_SOUNDS.filter((x) => x.id !== "own").map((x) => ({ id: x.id, label: x.label }))} />
          </Sec>
        </div>
      </div>
    </div>
  );
}

/** The phone's ring screen as it will look (ps-gos GymRingActivity with the alarm's colours and words). */
function AlarmScreen({ item }: { item: PlanItem }) {
  // V1.58: every colour from the background and accent (core/remind.ts alarmLook), so a light one reads too.
  const l = alarmLook(item.bg, item.accent);
  const style = { "--al-bg": item.bg, "--al-acc": item.accent, "--al-ink": l.ink, "--al-sub": l.sub, "--al-on": l.on } as CSSProperties;
  return (
    <div className="rm-alarm" style={style} aria-label="The ring screen on your phone">
      <span className="rm-alarm-orb">{item.pill}</span>
      <b className="rm-alarm-time">{item.at}</b>
      <span className="rm-alarm-words">{item.text}</span>
      <span className="rm-alarm-yes">{item.yes}</span>
      {!item.one && <span className="rm-alarm-later">{ALARM_LATER}</span>}
    </div>
  );
}

function SnoozeBox({ value, save }: { value: number; save: (v: number) => void }) {
  const [d, setD] = useState(String(value));
  useEffect(() => { setD(String(value)); }, [value]);
  const commit = () => { const n = okSnooze(Number(d)); setD(String(n)); if (n !== value) save(n); };
  return <input className="rm-input rm-num" type="number" min={REM_SNOOZE_MIN} max={REM_SNOOZE_MAX} value={d} onChange={(e) => setD(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }} />;
}

/** The pop-up as it will look (the Mac's card; the phone shows the same words as a notification). */
export function RemCard({ item, live }: { item: PlanItem; live?: boolean }) {
  const [box, setBox] = useState(false);
  // V1.58: every colour from the background and accent (core/remind.ts remLook, the same as the Mac's card), so Paper,
  // white and any light colour read as well as the dark ones.
  const l = remLook(item.bg, item.accent);
  const style = { "--rc-bg": item.bg, "--rc-acc": item.accent, "--rc-ink": l.ink, "--rc-sub": l.sub, "--rc-lift": l.lift, "--rc-glow": `${l.glow}%`,
    "--rc-pill": l.pill, "--rc-btn": `${l.btn}%`, "--rc-on": l.on, "--rc-field": l.field, "--rc-ph": l.ph } as CSSProperties;
  return (
    <div className={`rm-card${live ? " live" : ""}${box ? " box" : ""}`} style={style} key={`${item.bg}${item.accent}`}>
      <span className="rm-card-pill"><i />{item.pill}</span>
      <h3>{item.text}</h3>
      <div className="rm-card-row">
        {!item.one && <span className="rm-card-b">{item.later}</span>}
        {item.open && <span className="rm-card-b">{item.open}</span>}
        {!box && <span className="rm-card-b main" onClick={() => { if (!item.click) setBox(true); }}>{item.yes}</span>}
      </div>
      {box && (
        <div className="rm-card-box" onClick={() => setBox(false)}>
          <small>Type <b>{item.word}</b> and press Enter to confirm</small>
          <div className="rm-card-in"><span>Type {item.word}</span><span className="rm-card-b main">Done</span></div>
        </div>
      )}
    </div>
  );
}

/** While Test shows a reminder: Esc ends it (one layer; the Settings screen under it keeps its own Esc). */
function TestEsc() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); stopTest(); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);
  return null;
}

/** The website (and any page without a shell): Test shows the card here, over everything, until Esc, a button or Stop. */
export function RemTestCard() {
  const snd = useRemSound();
  if (remSoundWhere !== "web" || !snd.testing) return null;
  return (
    <div className="rm-testcard" onClick={() => stopTest()} role="dialog" aria-label="Reminder test">
      <RemCard item={snd.testing} live />
    </div>
  );
}

// ---------- PS 1.73: tasks due today and the Priority 1 alarm ----------
// The developer, 21 Nov 2026. Every word here waits for the developer's yes (ps-handover-notes/p1-alarms-173.md lists them).
const HOURS_QUICK = [1, 2, 3, 4, 6];
const LEAD_QUICK = [15, 30, 60, 120, 180];
const EXAMPLE_TASK = "Send the invoice";
export const DUE_WORDS = {
  head: "Due today",
  intro: "Nobody loses track of a task: these come by themselves, from your list.",
  nagTitle: "Tasks due today",
  nagSum: (h: number, snooze: number) => `Starts ${h} ${h === 1 ? "hour" : "hours"} before your day ends, then every ${snooze} mins until it is done`,
  nagWhen: (endHm: string) => `For every task due today that is not done: a task with today's date, a client task on its day, and each Priority 1 task by its own 24 hours. It comes back every snooze length until you tick the task or the time is up. An overdue task comes at once and all day, until it is done or has a new date. Done ticks the task. Your day ends at ${endHm} (Settings, Countdown text, Day ends).`,
  hours: "Starts this many hours before",
  nagNote: "{task} is the task's name, {left} the time left. Empty: the task's name.",
  p1Title: "Priority 1 alarm",
  p1Sum: (lead: string) => `Rings ${lead} before a Priority 1 task is due: its 24 hours or your day end, whichever comes first`,
  p1When: (endHm: string) => `Every Priority 1 task that is not done rings: ${"before its 24 hours run out (from when it became Priority 1, shared with the squad or not) or before your day ends at "}${endHm}, whichever comes first. Your phone rings full screen like an alarm, your Mac shows a card that rings, and the iPhone web app sends a notification. Only typing the word stops it, then it stops on every device.`,
  lead: "Rings this long before",
  p1Note: (word: string, yes: string) => `{task} is the task's name, {left} the time left. One button, no Later: ${yes} only works once ${word} is typed.`,
};
const leadWords = (m: number) => (m % 60 ? `${m} mins` : `${m / 60} ${m === 60 ? "hour" : "hours"}`);

function DueSection({ rec, red, ready, open, setOpen, change }: {
  rec: RemindRec; red: boolean; ready: boolean; open: string | null; setOpen: (v: string | null) => void; change: (fn: (r: RemindRec) => RemindRec) => void;
}) {
  const s = useVault();
  const cfg = dueCfgOf(rec, red);
  const endHm = s.status === "unlocked" ? dayView(s, Date.now()).endHm : "12:00";
  const set = (c: Parameters<typeof patchDue>[2]) => change((x) => patchDue(x, red, c, Date.now()));
  const nag: DueEd = {
    fill: (r) => fillWords(r.text, EXAMPLE_TASK, cfg.hours * 3_600_000),
    placeholder: EXAMPLE_TASK, note: DUE_WORDS.nagNote,
    when: <>
      <div className="rm-row"><span className="rm-soft">{DUE_WORDS.hours}</span>
        <div className="rm-quick">{HOURS_QUICK.map((h) => <button key={h} type="button" className={`rm-small${cfg.hours === h ? " on" : ""}`} disabled={!ready} onClick={() => { sfx.hover(); set({ hours: h }); }}>{h}</button>)}</div>
      </div>
      <p className="rm-note">{DUE_WORDS.nagWhen(endHm)}</p>
    </>,
  };
  const p1: DueEd = {
    fill: (r) => fillWords(r.text || DUE_P1_TEXT, EXAMPLE_TASK, cfg.lead * 60_000),
    placeholder: DUE_P1_TEXT, note: DUE_WORDS.p1Note(cfg.p1.word || DUE_P1_WORD, cfg.p1.yes || DUE_P1_YES),
    when: <>
      <div className="rm-row"><span className="rm-soft">{DUE_WORDS.lead}</span>
        <div className="rm-quick">{LEAD_QUICK.map((m) => <button key={m} type="button" className={`rm-small${cfg.lead === m ? " on" : ""}`} disabled={!ready} onClick={() => { sfx.hover(); set({ lead: m }); }}>{leadWords(m)}</button>)}</div>
      </div>
      <p className="rm-note">{DUE_WORDS.p1When(endHm)}</p>
    </>,
  };
  const row = (id: string, r: Reminder, title: string, sum: string, ed: ReactNode, onOff: (on: boolean) => void) => (
    <li className={`rm-item${open === id ? " open" : ""}${r.on ? "" : " off"}`} style={{ "--rm-acc": r.accent } as CSSProperties}>
      <div className="rm-head">
        <button type="button" className={`rm-switch${r.on ? " on" : ""}`} role="switch" aria-checked={r.on} aria-label={`${title} on or off`} disabled={!ready}
          onClick={() => { sfx.hover(); onOff(!r.on); }}><i /></button>
        <button type="button" className="rm-sum" onClick={() => { sfx.hover(); setOpen(open === id ? null : id); }} aria-expanded={open === id}>
          <span className="rm-dot" aria-hidden="true" />
          <span className="rm-sum-t"><b>{title}</b><span>{sum}</span></span>
          <svg className="rm-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </button>
      </div>
      <div className="rm-body" aria-hidden={open !== id}><div className="rm-body-in">{open === id && ed}</div></div>
    </li>
  );
  return (
    <>
      <h4 className="rm-h">{DUE_WORDS.head}</h4>
      <p className="rm-intro">{DUE_WORDS.intro}</p>
      <ul className="rm-list">
        {row("due:nag", cfg.nag, DUE_WORDS.nagTitle, DUE_WORDS.nagSum(cfg.hours, cfg.nag.snooze),
          <RemEditor r={cfg.nag} red={red} set={(p) => set({ nag: p })} ready={ready} due={nag} />, (on) => set({ nag: { on } }))}
        {row("due:p1", cfg.p1, DUE_WORDS.p1Title, DUE_WORDS.p1Sum(leadWords(cfg.lead)),
          <AlarmEditor r={cfg.p1} red={red} set={(p) => set({ p1: p })} ready={ready} due={p1} />, (on) => set({ p1: { on } }))}
      </ul>
    </>
  );
}
