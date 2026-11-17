// The Checklist reminder's clock (PS 1.65, rules in core/chkremind.ts). Runs on the page that holds the vault (the Mac's engine page, the
// website). Every 5 seconds it looks at the facts (no task ticked for the whole interval, not in a meeting, not in Sleep mode, not under
// Do Not Disturb, not away from the keyboard, something left to do) and, when it is time, shows the pop-up:
//  - on the Mac it hands the card to the shell ("rem:chk", Sources/Reminders.swift), which draws it over any app with the same look as the
//    Annoying 15 minute reminder and tells the page the answer (window.__psChkAnswered);
//  - on the website the same card is drawn by views/ChecklistReminder.tsx (it reads chkCard below).
// A tick that comes while the pop-up is up takes it away: the person is doing their checklist. Nothing is saved or sent anywhere; the clock
// lives in memory, so a restart starts counting again.
import { useSyncExternalStore } from "react";
import { vaultStore } from "./core/vault";
import { feature } from "./core/features";
import { settingsData, todos, calendarSnap } from "./core/select";
import { cleanGroups, tabLists } from "./core/groups";
import { overdueZone } from "./core/overdue";
import { dndActive } from "./core/dnd";
import { afkMeetWindows } from "./core/afkmeet";
import { meetingEvents } from "./core/calpick";
import { sleepState } from "./sleepmode/engine";
import { todayISO } from "./ui/kit";
import { CHK_FEATURE, checklistTasks, chkBlock, chkCardItem, chkStart, chkStep, cleanChk, lastTickOf, type ChkSettings } from "./core/chkremind";
import { openChkScreen } from "./chkscreen";
import type { CalendarSnap, Doc, Todo } from "./core/model";
import { lpInterval } from "./core/lowpower.ts";

type Post = (m: object) => void;
/** Away from the keyboard on the website: no key or mouse in this page for this long, or the page is hidden. (The Mac's shell knows for itself.) */
export const AWAY_MS = 5 * 60_000;

let post: Post | null = null;          // set on the Mac: the pop-up is the shell's
let clock = chkStart(Date.now());
let up = false, upSince = 0, testing = false;
let lastInput = Date.now();
let started = false;
/** The Sentry cover and the website's Posture pop-up. Loaded after start (plain imports would make a loop with ps.ts). */
let sentryNow: () => boolean = () => false;
let postureUp: () => boolean = () => false;
/** The checklist and its newest tick, worked out again only when the tasks change or a minute passed (not every 5 seconds). */
let memo: { s: unknown; day: string; min: number; v: { tasks: Doc<Todo>[]; lastTickAt: number } } | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** The website's pop-up is up (views/ChecklistReminder.tsx draws it). */
export const chkCard = (): { open: boolean; test: boolean } => ({ open: up && !post, test: testing });
const snapKey = () => (up && !post ? (testing ? 2 : 1) : 0);
export function useChkCard(): { open: boolean; test: boolean } {
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, snapKey, snapKey);
  return chkCard();
}

/** The tasks on the checklist now, and the newest tick. */
export function checklistNow(): { tasks: Doc<Todo>[]; lastTickAt: number } {
  const s = vaultStore.get(), now = Date.now(), day = todayISO(), min = Math.floor(now / 60_000);
  if (memo && memo.s === s && memo.day === day && memo.min === min) return memo.v;
  const st = settingsData(s), all = todos(s);
  const lists = tabLists(all, cleanGroups(st.tmGroups), day, { now, tz: overdueZone(st.tmHomeTz) });
  const v = { tasks: checklistTasks(lists), lastTickAt: lastTickOf(all) };
  memo = { s, day, min, v };
  return v;
}

function show(cfg: ChkSettings, now: number) {
  up = true; upSince = now; testing = false;
  if (post) post({ type: "rem:chk", item: chkCardItem(cfg) });
  emit();
}
function away(now: number) { return document.visibilityState === "hidden" || now - lastInput > AWAY_MS; }

function tick() {
  const now = Date.now(), s = vaultStore.get();
  const unlocked = s.status === "unlocked";
  const st = unlocked ? settingsData(s) : null;
  const cfg = cleanChk(st?.chkRemind);
  const enabled = unlocked && feature(CHK_FEATURE) && cfg.on;
  if (testing) return;
  // Off (the feature or the switch): nothing is worked out, the count stays fresh (the tabLists over every task is not run for nothing).
  if (!enabled) {
    if (up) dismiss();
    clock = chkStart(now);
    return;
  }
  const { tasks, lastTickAt } = checklistNow();
  // The pop-up is up and the person ticked something, or the switch went off: it goes.
  if (up && lastTickAt > upSince) { dismiss(); return; }
  const cal = unlocked ? calendarSnap(s) : null;
  const block = chkBlock({
    locked: !unlocked,
    protectedFront: false,      // the Mac's shell checks 1Password and Signal itself; this page never looks
    inMeeting: !!st && afkMeetWindows(meetingEvents(cal ? (cal.data as CalendarSnap).events : [], st.calChoices), st.meetHidden, now).some(([a, b]) => now >= a && now < b),
    sleepMode: sleepState().here,
    sentry: sentryNow(),        // the page's own Sentry cover (the Mac's shell also checks Sentry.swift)
    dnd: !!st && dndActive(st.dnd, now),
    away: !post && away(now),
    setup: false,
  });
  const r = chkStep(clock, {
    now, enabled, ready: unlocked && (!!s.lastSync || !!s.local || s.role === "owner"), everyMin: cfg.every, lastTickAt, openTasks: tasks.length, cardOpen: up, block,
    held: !post && postureUp(),
  });
  clock = r.clock;
  if (r.fire) show(cfg, now);
}

/** The pop-up goes away without an answer (a tick, the switch). */
function dismiss() {
  if (!up) return;
  up = false; clock = chkStart(Date.now());
  if (post) post({ type: "rem:chkStop" });
  emit();
}

/** On the website the two screens live in the Tab list, which is on the To-do page: go there first, so the choice always opens something. */
function goToTodo() {
  if (location.hash.replace(/^#\/?/, "").split("/")[0] !== "todo") location.hash = "#/todo";
}

/** A choice was made (the Mac's card says "rethink", "forgot", "sure" or "esc"; the website's card says the same). The count starts again. */
export function chkAnswered(outcome: unknown) {
  if (testing) { testing = false; up = false; emit(); return; }
  up = false; clock = chkStart(Date.now());
  if (outcome === "rethink" || outcome === "forgot") { if (!post) { goToTodo(); openChkScreen(outcome); } }
  emit();
}

/** Settings, "Show it now" on the website: the card at once, for a look. Nothing is saved and no screen opens. (On the Mac, Settings sends
 *  the card to the shell with "rem:test" itself, Sources/Reminders.swift test(): its buttons and Esc only close it.) */
export function chkTest() {
  testing = true; up = true; emit();
}

export function startChkWatch(p: Post | null) {
  if (started) return;
  started = true;
  post = p;
  const input = () => { lastInput = Date.now(); };
  for (const e of ["keydown", "pointerdown", "pointermove", "wheel", "touchstart"]) document.addEventListener(e, input, { passive: true, capture: true });
  (window as Window & { __psChkAnswered?: (o: unknown) => void }).__psChkAnswered = chkAnswered;
  void Promise.all([import("./views/Sentry"), import("./posturewatch")]).then(([a, b]) => { sentryNow = a.sentryUp; postureUp = () => b.postureView().open; }).catch(() => {});
  lpInterval("alarms", tick, 5000);   // PS 1.65: rings in Low power mode while Keep reminders ringing is on (core/lowpower.ts)
}
