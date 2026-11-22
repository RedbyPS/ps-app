// The Clients workspace (PS 1.73) at work: the person's day from their settings, the next call from the calendar, the due today
// feed for the nag (p1-alarms-173), and a tick at each day end so the list lands the next day's tasks with no click.
// The rules are core/clientwork.ts.
import { useEffect, useState } from "react";
import { vaultStore, type Snapshot } from "../core/vault";
import type { CalEvent, ClientRec, Doc, Todo } from "../core/model";
import { allTodos, calendarSnap, settingsData } from "../core/select";
import { cdEffective } from "../core/daycount";
import { resetAtOf } from "../core/resetday";
import { DAY_ENDS_DEFAULT } from "../core/daylog";
import { buildMatcher } from "../core/mail";
import { dayOn, dayPrefs, dayZone } from "../daycount";
import { clientDueToday, dayEndAt, landDayAt, type DayRule } from "../core/clientwork";
import { setLandDay } from "../core/actions";
import { scheduledOn, setSchedWall } from "../core/scheduled";
import { overdueZone } from "../core/overdue";
import { wall } from "../core/tz";

/** The person's day rule: the countdown's Day ends (the developer's 12:00 GST), else Settings 'Your work day ends at'. */
export function dayRuleOf(s: Snapshot): DayRule {
  const st = settingsData(s);
  const p = dayPrefs(s);
  return { on: dayOn(s), prefs: cdEffective(p, resetAtOf(st)), tz: dayZone(s, p), dayEndsHour: typeof st.dayEndsHour === "number" ? st.dayEndsHour : DAY_ENDS_DEFAULT };
}
/** Which day it is for the person now (the day client tasks land on). */
export const landDayNow = (s: Snapshot, now = Date.now()) => landDayAt(now, dayRuleOf(s));
setLandDay((s) => landDayNow(s));
// Break-it 1.75 (core/scheduled.ts schedCut): the calendar date in the Tab list's zone (the zone Overdue and typed dates use),
// so a scheduled task is never kept out on its own date. Worked out once a minute per vault state.
let wallMemo: { s: Snapshot | null; min: number; day: string } = { s: null, min: -1, day: "" };
setSchedWall(() => {
  const s = vaultStore.get(), now = Date.now(), min = Math.floor(now / 60_000);
  if (wallMemo.s !== s || wallMemo.min !== min) {
    const w = wall(now, overdueZone(settingsData(s).tmHomeTz));
    wallMemo = { s, min, day: `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}` };
  }
  return wallMemo.day;
});

/** "12:00": the day end as a clock time in its zone. */
export function endHmOf(s: Snapshot, now = Date.now()): string {
  const r = dayRuleOf(s), end = dayEndAt(now, r);
  try { return new Intl.DateTimeFormat("en-GB", { timeZone: r.on ? r.tz : undefined, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(end); }
  catch { return new Date(end).toTimeString().slice(0, 5); }
}

let tick = 0;
const subs = new Set<() => void>();
let timer: number | null = null;
/** Re-renders at the person's day end (and every 10 minutes as a safety net), so tasks land with no click. */
export function useLandTick(s: Snapshot): number {
  const [n, setN] = useState(tick);
  useEffect(() => {
    const f = () => setN(tick);
    subs.add(f);
    const arm = () => {
      if (timer !== null) return;
      const now = Date.now();
      // Break-it 1.75: with scheduled tasks on, tasks also come in when their calendar date starts (core/scheduled.ts schedCut).
      const mid = new Date(now); mid.setHours(24, 0, 0, 500);
      const wait = Math.max(1000, Math.min(dayEndAt(now, dayRuleOf(s)) - now + 500, 10 * 60_000, scheduledOn() ? mid.getTime() - now : Infinity));
      timer = window.setTimeout(() => { timer = null; tick++; subs.forEach((g) => g()); arm(); }, wait);
    };
    arm();
    return () => { subs.delete(f); if (!subs.size && timer !== null) { window.clearTimeout(timer); timer = null; } };
  }, [s]);
  return n;
}

// ---------- the next call (Google Calendar; nothing without it) ----------

const startMs = (e: CalEvent) => (e.start ? Date.parse(e.allDay ? `${e.start}T00:00:00` : e.start) : NaN);
const endMs = (e: CalEvent) => (e.end ? Date.parse(e.allDay ? `${e.end}T00:00:00` : e.end) : startMs(e));
/** The client's next call: an event an attendee of which is the client (email and matchAddrs), else whose title has the
 *  client's name. null when the calendar is not linked or nothing is coming. `linked`: a calendar is linked at all. */
export function nextCallOf(s: Snapshot, client: Doc<ClientRec>, now = Date.now()): { linked: boolean; ev: CalEvent | null; who: string | null } {
  const snap = calendarSnap(s);
  if (!snap) return { linked: false, ev: null, who: null };
  const match = buildMatcher([client]);
  const name = client.data.name.trim().toLowerCase();
  let best: { ev: CalEvent; who: string | null } | null = null;
  for (const e of snap.data.events || []) {
    if (e.allDay || !(endMs(e) > now)) continue;
    const att = (e.attendees || []).find((a) => !a.self && match(a.email));
    const hit = att || (name.length >= 3 && (e.title || "").toLowerCase().includes(name));
    if (!hit) continue;
    if (!best || startMs(e) < startMs(best.ev)) best = { ev: e, who: att ? att.name || att.email : null };
  }
  return { linked: true, ev: best?.ev ?? null, who: best?.who ?? null };
}
/** Every calendar event by id (a deadline that is a call follows it), and the time the copy covers. */
export function calEvents(s: Snapshot): { byId: Map<string, CalEvent>; from: number; to: number } | null {
  const snap = calendarSnap(s);
  if (!snap) return null;
  return { byId: new Map((snap.data.events || []).map((e) => [e.id, e])), from: Date.parse(snap.data.from), to: Date.parse(snap.data.to) };
}

// ---------- the due today feed (p1-alarms-173) ----------

/** The client tasks due today in the shape the nag takes (core/duealerts.ts DueTask: id, title, kind, dueAt): every open client
 *  task in the list on the person's day, due at that day's end. P1 ones are left to the nag's own Priority 1 rules. Wire it with
 *  `addDueSource("clients", (ctx) => clientDueTasks(vaultStore.get(), ctx.now))` (src/duewatch.ts). */
export function clientDueTasks(s: Snapshot, now = Date.now()): { id: string; title: string; kind: "client"; dueAt: number }[] {
  const r = dayRuleOf(s), day = landDayAt(now, r), end = dayEndAt(now, r);
  const mine = allTodos(s).filter((d) => d.ws === null) as Doc<Todo>[];
  return clientDueToday(mine, day).filter((x) => x.doc.data.p1 !== true)
    .map((x) => ({ id: x.doc.id, title: x.doc.data.title, kind: "client" as const, dueAt: end }));
}
