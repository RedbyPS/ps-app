// The Annoying 15 min reminders at work (core/remind.ts has the rules). Runs in the page that holds the vault: PS's
// main page on a Mac, the page in the phone app.
//  - Hands the shell the plan (every reminder with its words worked out and its state), only when it changed:
//    the Mac shows the cards itself (ps-mac Sources/Reminders.swift: only while you are at the Mac, never in a
//    meeting, under Do Not Disturb or over 1Password and Signal), the phone posts notifications by itself while PS
//    sleeps (ps-gos Remind.kt).
//  - Saves each answer from a shell ({type:"remAct"}: confirmed, or Remind me in) in the vault record, so the other
//    device's card or notification goes too. An answer that comes while the vault is still locked waits here.
//  - Reminders ON tasks (V1.55): the pop-up says the task's name, a ticked task ends today's nagging, Done on a card or
//    a notification ticks the task, and a reminder whose task was deleted or (a one-off) finished goes after a short
//    wait (so Undo brings both back). A once reminder goes a day after its day.
//  - Alarms (V1.57): the Mac gets them in this plan (their card); the phone does not (it rings them, gymwatch.ts). Their
//    Acknowledge comes back as an ordinary remAct "done", from either device.
//  - 1.60: the built in daily reminder ("fu") is gone for everyone: never in the plan, rewritten out of a saved record.
//  - PS 1.73 (duewatch.ts, core/duealerts.ts): every task due today gets the Annoying reminder from 3 hours before the day ends,
//    and a Priority 1 task rings an alarm an hour before its 24 hours run out. Both join this plan as ordinary items (the phone
//    rings the P1 alarms with the gym ring instead, gymwatch.ts; the iPhone web app keeps them as its card and push). Their
//    answers are saved in the record's `auto`; Done on a nag ticks its task.
import { vaultStore } from "./core/vault";
import { allTodos, remindDoc, remindRec } from "./core/select";
import { saveRemind, setTodoDone } from "./core/actions";
import { applyAct, okTaskId, remPlan, removeReminders, staleTaskReminders, taskInfos, type Reminder, type RemAct } from "./core/remind";
import { DEVICE_TZ } from "./core/tz";
import { sb } from "./core/vault";
import { feature } from "./core/features";
import { gymReady } from "./core/gym";
import { pushClearArgs } from "./core/webpush";
import { lpInterval } from "./core/lowpower.ts";
import { MWEB } from "./gos/bridge";
import { dueItemOf, duePlan, dueTaskOf, stampP1Own } from "./duewatch";

type Post = (m: object) => void;
const PHONE = import.meta.env.MODE === "gos";
let post: Post = () => {};
let lastPlan = "";
let waiting: RemAct[] = [];
let retiring = false;                          // the rewrite without the retired reminder is under way
let staleSince: Record<string, number> = {};   // reminders on tasks: when their task was first seen gone or finished
let sweeping = false;
const unlocked = () => { const s = vaultStore.get(); return s.status === "unlocked" && s.role === "owner"; };

function run() {
  if (!unlocked()) return;
  const s = vaultStore.get();
  if (waiting.length) { const w = waiting; waiting = []; w.forEach(remAnswer); }
  const rec = remindRec(s);
  // 1.60: the built in daily reminder ("fu") is gone. A saved record that still carries it is rewritten without it, once.
  if (remindDoc(s).stale && !retiring) {
    retiring = true;
    void saveRemind((cur) => cur).catch(() => { retiring = false; });
  }
  const all = allTodos(s);
  const tasks = taskInfos(all);
  // Reminders on tasks that were deleted or finished: away (only once the list has really come, never on an empty one).
  if (rec && rec.list.some((r) => r.task) && all.length && !s.syncing && (s.lastSync || s.local) && !sweeping) {
    const now = Date.now();
    const { remove, since } = staleTaskReminders(rec, tasks, staleSince, now, DEVICE_TZ);
    staleSince = since;
    if (remove.length) {
      sweeping = true;
      void saveRemind((cur) => (cur ? removeReminders(cur, remove, now) : null))
        .then(() => post({ type: "log", text: `reminders: ${remove.length} on finished or deleted tasks taken away` }))
        .catch(() => {}).finally(() => { sweeping = false; });
    }
  }
  // 1.60: never hand the shells a plan before the saved reminders have loaded: an empty one would cancel every alarm and
  // ring on the phone and make a reminder that was just answered ring again from scratch. They keep the plan they have.
  if (!gymReady({ hasSettings: !!rec, syncing: s.syncing, lastSync: s.lastSync })) return;
  stampP1Own(s);   // PS 1.73: your own Priority 1 clock, shared with a squad or not
  const now = Date.now();
  const base = remPlan(rec, !!s.red, { tasks, now, deviceTz: DEVICE_TZ });
  // PS 1.73: the nags for tasks due today and the Priority 1 alarms, after your own reminders. The phone app rings the P1
  // alarms (gymwatch.ts), so only the Mac and the iPhone web app get them here.
  const due = duePlan(s, now);
  const full = { ...base, items: [...base.items, ...due.nags, ...(PHONE && !MWEB ? [] : due.p1)] };
  // Alarms (V1.57): the Mac shows their card from this plan; the phone RINGS them with the gym ring instead (gymwatch.ts
  // hands them over with the gym plan), so they are left out of the phone's reminder notifications.
  const alarms = new Set((rec?.list ?? []).filter((r) => r.alarm).map((r) => r.id));
  const plan = PHONE && alarms.size ? { ...full, items: full.items.filter((i) => !alarms.has(i.id)) } : full;
  const json = JSON.stringify(plan);
  if (json !== lastPlan) { lastPlan = json; post(PHONE ? { type: "remPlan", plan } : { type: "rem:plan", plan }); }
}

/** An answer from a card, a notification or Settings: saved in the record (only if newer than the one kept). */
export function remAnswer(a: RemAct) {
  if (!unlocked()) { waiting.push(a); if (waiting.length > 40) waiting = waiting.slice(-40); return; }
  // Done on a reminder on a task ticks the task, only when the answer is new (a Mac sending an old one again, after
  // The developer unticked the task, never ticks it back).
  let task: string | undefined;
  let clearRem: Reminder | null = null;
  void saveRemind((cur) => {
    const next = cur ? applyAct(cur, a) : null;
    if (next && a.act === "done") { const r0 = cur!.list.find((r) => r.id === a.id); task = r0?.task ?? dueTaskOf(a.id) ?? undefined; clearRem = r0 ?? (dueItemOf(a.id) as unknown as Reminder | null); }
    return next;
  }).then(() => {
    if (a.act === "done" && feature("remind-push")) void sb.rpc("push_clear", pushClearArgs(clearRem, a.at || Date.now(), DEVICE_TZ)).then(() => {}, () => {});   // pushes still waiting for it (iPhone) go too, from any device
    if (okTaskId(task)) return setTodoDone(task, true).catch(() => post({ type: "log", text: "reminders: the task could not be ticked yet" }));
  }).catch(() => { waiting.push(a); });
}
/** A shell's message: {type:"remAct", id, act, day | until, at, by}. True when it was one. */
export function remShellMessage(m: { type?: unknown }): boolean {
  if (m.type !== "remAct") return false;
  const o = m as Record<string, unknown>;
  if (typeof o.id !== "string" || (o.act !== "done" && o.act !== "snooze") || typeof o.at !== "number") return true;
  remAnswer({ id: o.id, act: o.act, at: o.at, by: o.by === "mac" || o.by === "phone" ? o.by : undefined,
    ...(typeof o.day === "string" ? { day: o.day } : {}), ...(typeof o.until === "number" ? { until: o.until } : {}) });
  return true;
}

let started = false, timer = 0;
export function startRemWatch(p: Post) {
  if (started) return;
  started = true;
  post = p;
  vaultStore.subscribe(() => { clearTimeout(timer); timer = window.setTimeout(run, 300); });
  // Once a minute too: a ticked task's "done for now" follows the clock into the next window, and the sweep's wait ends.
  // Only the plan is worked out; it goes to the shell only when it changed.
  lpInterval("alarms", run, 60_000);   // PS 1.65: rings in Low power mode while Keep reminders ringing is on (core/lowpower.ts)
  run();
}
/** Woken (a Mac's wake, the phone's background check, new Mac settings): look now. The plan is resent as it is, so
 *  a shell that restarted gets it back. */
export function remWake(resend = false) { if (!started) return; if (resend) lastPlan = ""; run(); }
