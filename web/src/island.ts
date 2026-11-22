// PS Dynamic Island, the main window half (core/island.ts says what it shows; ps-mac Island.swift draws
// it). Posts {type:"island", state} whenever what it shows changes, and again every minute so a restarted
// native side catches up. A tick on the island comes back as {type:"islandAction", action:"tick"|"untick",
// id} and ticks the task exactly as the Tab list does (toggleTodo: streaks, mini tasks, the day log).
// Signed out or locked: the island is told "off", so it never shows a title the vault is not open for.
// Private mode: the island shows a mask and "Private mode" with Show instead of the hidden title; a click there comes
// back as {type:"islandAction", action:"privateOff"} and turns private mode off, and the real task is sent at once.
import { vaultStore, type Snapshot } from "./core/vault";
import { calendarSnap, openReplies, settingsData, tabLayoutDoc, todos } from "./core/select";
import { mailOnSnap } from "./core/mailsnap";
import { islandMailOk } from "./core/mailopen";
import { cleanLayout } from "./core/tablayout";
import { islandMeetings } from "./core/islandaway";
import { visibleEvents } from "./core/meethide";
import { meetingEvents } from "./core/calpick";
import { saveSettings, toggleTodo } from "./core/actions";
import { clockStart } from "./core/timesave";
import { workingIdsOf, type Doc, type Reply, type Todo } from "./core/model";
import { mailCards } from "./core/mailcards";
import { leadCards } from "./core/leadcards";
import { AI_MSG_PRIVATE, aiCardsNow } from "./core/aimessage";
import { irepFeed } from "./mailcards";
import { ISLAND_EVENT_MS, ISLAND_FRESH_MS, TASK_ONLY_FEATURE, canPrivateOff, canTick, canUndo, islandState, pickEvent, type IslandCard, type IslandEvent, type IslandState, type IslandTick } from "./core/island";
import { todayISO } from "./ui/kit";
import { breakWindows, cleanRun, pomoIsland, pomoPrefs } from "./core/pomodoro";
import { afkAskIsland, afkAskPatch } from "./core/afkask";
import { STAND_LEAD_MS, standAskDue, standAskPatch, standIsland, standPrefs } from "./core/standup";
import { meetBubblePrefs, meetIsland } from "./core/meetbubble";
import { dndMutes } from "./core/dnd";
import { runPomoOp } from "./pomodoro";
import { fitIslandPart } from "./fitness/fitisland";
import { welcomeDoneIds, welcomeIsland, type WelcomeIn } from "./core/welcomeback";
import { pendingSummary, summaryPrefs } from "./core/workoutsummary";
import { feature } from "./core/features";
import { privatePatch } from "./core/privateends";
import type { FitWorkout } from "./core/fitness";
import { workoutPatch } from "./fitness/store";
import { asleepNames, lowPower } from "./core/lowpower.ts";
import { dayIsland, dayIslandAction } from "./daycount";
import { landDayNow } from "./clients/clientsday";

type Post = (m: object) => void;
let post: Post = () => {};
let last = "";
let event: IslandEvent | null = null;
let eventTimer = 0;
/** Cards this page run has already seen: each pops the island once, and a restart pops none that are old. */
const seen = new Set<string>();
/** The last tick from the island, so its Undo also puts the task back in progress. */
let lastTick: IslandTick | null = null;
/** What the island was last told it shows: a tick may only reach one of these tasks (V1.44 #10). */
let shown: IslandState | null = null;
/** What Welcome back was last told (the only tasks its Done may tick). */
let welcomeTold: WelcomeIn | null = null;

/** Client emails, Instantly replies and finished chats, each with whether it just arrived. */
function cardsNow(s: Snapshot, now: number): { mail: number; leads: number; cards: IslandCard[] } {
  const st = settingsData(s);
  // PS 1.61: client emails and lead replies only with Client emails switched on (core/mailswitch.ts, fails closed), the same
  // as the pop up cards. The developer saw a "1" on the island with no email panel to open (1.60 counted them regardless).
  const mailOn = mailOnSnap(s);
  const mail = mailOn ? mailCards(s.docs.values(), st.mailCardsSince, 20, now) : [];
  const leads = mailOn ? leadCards(irepFeed(s), st.leadCards, now) : [];
  const ai = aiCardsNow(st, now);   // V1.58: a chat that sent a message has no plain card; Settings may show neither
  const chats = ai.chats;
  const cards: IslandCard[] = [];
  for (const c of mail) {
    // Fresh: the email just came, or its "Remind me in" just ran out.
    const r = s.docs.get(c.replyId)?.data as Reply | undefined;
    const back = r?.remindAt && r.remindFor === r.date ? Date.parse(r.remindAt) : 0;
    const at = Math.max(Date.parse(c.at) || 0, back || 0);
    cards.push({ id: c.id, kind: "mail", title: c.title, sub: c.sub, url: c.url, at, fresh: now - at < ISLAND_FRESH_MS });
  }
  for (const c of leads) cards.push({ id: c.id, kind: "lead", title: c.title, sub: c.sub, url: c.url, at: Date.parse(c.at) || 0, fresh: c.fresh });
  for (const c of chats) cards.push({ id: c.id, kind: "chat", title: c.chat, sub: c.sub, url: "", at: Date.parse(c.at) || 0, fresh: c.fresh });
  for (const c of ai.msgs) cards.push({ id: c.id, kind: "chat", title: c.text, sub: c.from, url: "", privTitle: AI_MSG_PRIVATE, at: Date.parse(c.at) || 0, fresh: c.fresh });
  // The counts open the Tab list's email panel (core/mailopen.ts): none while it is taken off the Tab list in Edit mode.
  const counts = islandMailOk(mailOn, tabLayout(s));
  // PS 1.68: the envelope counts what the email panel lists (core/mailopen.ts isOpenReply), every one, not the pop-up cards (which
  // also held emails already dealt with and stopped at 20). The cards above still decide what pops the island open.
  return { mail: counts && mailOn ? openReplies(s).length : 0, leads: counts ? leads.length : 0, cards };
}
function tabLayout(s: Snapshot) { const d = tabLayoutDoc(s); return d ? cleanLayout(d.data) : null; }

function sync(force = false) {
  const s = vaultStore.get();
  if (s.status !== "unlocked" || s.role !== "owner") { shown = null; lastTick = null; return send({ mode: "off", private: false, task: null, more: 0, tasks: [], mail: 0, leads: 0, event: null }, force); }
  const now = Date.now();
  const { mail, leads, cards } = cardsNow(s, now);
  const fresh = pickEvent(cards, seen);
  if (fresh) {
    event = fresh;
    clearTimeout(eventTimer);
    eventTimer = window.setTimeout(() => { event = null; sync(); }, ISLAND_EVENT_MS);
  }
  const st = settingsData(s);
  shown = islandState({ todos: todos(s) as Doc<Todo>[], settings: st, today: todayISO(), land: landDayNow(s, now), mail, leads, event, now, taskOnly: feature(TASK_ONLY_FEATURE) });
  // V1.58: the meetings for "Disappear for this meeting" (core/islandaway.ts): the Meetings panel's own calendar copy,
  // the meetings taken off the panel left out. Only ids and times.
  const cal = calendarSnap(s);
  const meetEv = meetingEvents(cal ? cal.data.events : [], st.calChoices);   // only calendars set to Meetings (core/calpick.ts)
  const meets = islandMeetings(visibleEvents(meetEv, st.meetHidden), now);
  // Pomodoro (V1.58, core/pomodoro.ts): the run with wall clock end times, so the island counts down by itself (ps-mac
  // IslandPomo.swift). Sent with the island off too: the Mac then says it with a pop-up. Sound: the setting, then Do Not Disturb.
  const soundOk = !dndMutes(st.dnd, "sounds", now);
  const run = cleanRun(st.pomoRun), pp = pomoPrefs(st.pomodoro);
  const pomo = pomoIsland(run, pp, now, soundOk);
  // Stand-up reminders (core/standup.ts): the one on now or next; one that falls in a Pomodoro break is skipped.
  const breaks = breakWindows(run, pp, now);
  const stand = standIsland(standPrefs(st.standup), now, soundOk, (at) => breaks.some(([a, b]) => at >= a && at < b), standTest, standAskDue(st));
  // The next meeting bubble (core/meetbubble.ts): the meetings the Meetings panel already has.
  const meet = meetIsland(meetEv, st.meetHidden, meetBubblePrefs(st.meetBubble), now, !!st.privateMode);
  // PS 1.60: Welcome back (the tasks being worked on) and the workout summary waiting for this Mac, each only with its
  // feature and switch on. The workout's mark is saved on the workout when the Mac says it showed it (islandMessage).
  const welcome = feature("welcome-back") ? welcomeIsland(todos(s) as Doc<Todo>[], st, !!st.privateMode) : null;
  welcomeTold = welcome;
  const workout = feature("workout-summary") && !st.privateMode ? pendingSummary(fitWorkouts(s), now, summaryPrefs(st.workoutMac)) : null;
  // V1.60 Fitness on the phone's island (src/fitness/fitisland.ts): Scanning, Found, Workout added, rest, progress hints. Null off the phone.
  // PS 1.65 Low power mode (core/lowpower.ts): the leaf, and what is asleep for its card. The island itself stays fully active.
  const lps = lowPower.state();
  const lp = lps.on ? { names: asleepNames(lps, lowPower.feeds()), why: lps.why } : null;
  // PS 1.66: the AFK timer's one question (core/afkask.ts): its words while it is still due, for the Mac's AFK card (Afk.swift).
  const afkAsk = afkAskIsland(st);
  // PS 1.70 the day countdown in the task area (src/daycount.ts): its end, at zero, and the shown task's own Priority 1 timer.
  const day = shown.task && !st.privateMode ? dayIsland(s, shown.task.id, now) : dayIsland(s, null, now);
  send({ ...shown, meets, pomo, stand, meet, welcome, workout, fit: fitIslandPart(now), lp, afkAsk, day }, force);
}
function fitWorkouts(s: Snapshot): { id: string; data: FitWorkout }[] {
  const out: { id: string; data: FitWorkout }[] = [];
  for (const d of s.docs.values()) if ((d.kind as string) === "fwork") out.push({ id: d.id, data: d.data as unknown as FitWorkout });
  return out;
}
function send(state: object, force: boolean) {
  const json = JSON.stringify(state);
  if (json !== last || !localState) { localState = state; localSubs.forEach((f) => f()); }   // PS 1.66: the phone's in-app island (gos/PhoneIsland.tsx)
  if (!force && json === last) return;
  last = json;
  post({ type: "island", state });
}
/** PS 1.66: the island state for the island drawn inside PS on the phone (gos/PhoneIsland.tsx), the same one the shell gets. */
let localState: object | null = null;
const localSubs = new Set<() => void>();
export const islandLocal = {
  subscribe(f: () => void) { localSubs.add(f); return () => { localSubs.delete(f); }; },
  get: () => localState,
};

/** A tick or an Undo on the island. Only for a task that exists and is in the right state. */
export function islandMessage(m: { type?: string; action?: string; id?: string }): boolean {
  if (m.type !== "islandAction") return false;
  const s = vaultStore.get();
  if (s.status !== "unlocked" || s.role !== "owner") return true;
  // Pomodoro: the island's Start on a break that waits (Start the next one by itself is off).
  if (m.action === "pomoBegin") { void runPomoOp("begin"); return true; }
  // V1.59 the first stand-up's question (ps-mac IslandBubble.swift): seen as it shows, then the answer. Saved once.
  if (m.action === "standAsk") {
    const st = settingsData(s);
    const patch = standAskPatch(m.id, st.standup);
    if (patch && (st.standAsk !== true || patch.standup)) void saveSettings(patch).then(() => sync(true));
    return true;
  }
  // PS 1.66 the AFK timer's question (ps-mac Afk.swift): Turn off or Keep it on. Saved once; the Mac switches its timer off itself.
  if (m.action === "afkAsk") {
    const patch = afkAskPatch(m.id);
    if (patch && settingsData(s).afkAsk !== true) void saveSettings(patch).then(() => sync(true));
    return true;
  }
  // PS 1.60 Welcome back: Done with the ticked ids (a JSON list in `id`). Each is ticked like a tick on the island.
  if (m.action === "welcomeDone") {
    const ids = welcomeDoneIds(m.id, welcomeTold?.tasks ?? [], new Map(todos(s).map((d) => [d.id, d])));
    for (const id of ids) void toggleTodo(id);
    return true;
  }
  // PS 1.60 workout summary: this Mac showed it. The mark goes on the workout (once, synced), so no other Mac shows it.
  if (m.action === "workoutShown") {
    const d = typeof m.id === "string" ? s.docs.get(m.id) : undefined;
    if (d && (d.kind as string) === "fwork" && !(d.data as unknown as FitWorkout).macShown) void workoutPatch(d.id, { macShown: new Date().toISOString() }).then(() => sync(true));
    return true;
  }
  // PS 1.70 the day countdown's card out of the island (ps-mac DayCountdown.swift): End day now? and the reminders.
  if (m.action === "dayEnd" || m.action === "dayRem") { dayIslandAction(m.action, m.id); return true; }
  // PS 1.65 Low power mode: the leaf card's Wake everything.
  if (m.action === "lowPowerWake") { lowPower.wakeAll(); return true; }
  if (m.action === "privateOff") {
    if (canPrivateOff(shown, settingsData(s).privateMode)) void saveSettings(privatePatch(false, Date.now())).then(() => sync(true));
    return true;
  }
  if (typeof m.id !== "string") return true;
  const d = s.docs.get(m.id) as Doc<Todo> | undefined;
  if (!d || d.kind !== "todo") return true;
  // Only a task the island shows, open and still in the list; Undo only for the island's own last tick (V1.44 #10).
  if (m.action === "tick" && canTick(shown, d.id, d.data)) {
    lastTick = { id: d.id, at: Date.now(), working: workingIdsOf(settingsData(s)) };
    void toggleTodo(d.id);
  } else if (m.action === "untick" && canUndo(lastTick, d.id, d.data, Date.now())) {
    const back = lastTick?.working ?? null;
    lastTick = null;
    void toggleTodo(d.id).then(() => { if (back?.includes(d.id)) { void saveSettings({ workingIds: back, workingOn: back[0] ?? null }); void clockStart(d.id); } });   // its clock goes on again (core/timesave.ts)
  }
  return true;
}

/** Send the island's state now (a Pomodoro phase just changed). */
export function islandNow() { sync(true); }
/** Settings, Stand-up reminders, Try it now: one stand-up 15 seconds from now, on this Mac only (never saved). */
let standTest: number | null = null;
export function islandStandTest() { standTest = Date.now() + STAND_LEAD_MS + 400; sync(true); }

/** PS main window only. */
export function startIsland(p: Post) {
  post = p;
  let t = 0;
  vaultStore.subscribe(() => { clearTimeout(t); t = window.setTimeout(() => sync(), 300); });
  window.setInterval(() => sync(true), 60_000);   // a restarted island catches up within a minute (stays on in Low power mode: the island is fully active)
  lowPower.subscribe(() => sync());   // PS 1.65: the leaf comes and goes at once
  // Back from sleep, a lock or the network: send at once rather than up to a minute later (V1.44 #10).
  const now = () => sync(true);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") now(); });
  window.addEventListener("online", now);
  window.addEventListener("focus", now);
  sync();
}
