// Sleep mode's engine (V1.40, rules in core/sleepmode.ts). It decides where the sleep screen is drawn and keeps it fed:
// - In PS on a Mac: the shell's own full screen window (ps-mac Sources/SleepScreen.swift). This page sends the plan
//   ({type:"sleep:start"|"sleep:plan"|"sleep:stop"}) and hears back through window.__psSleep(state).
// - In PS on the GrapheneOS phone: the shell's screen over the lock screen (ps-gos Sleep.kt), the same plan through
//   gosPost, the state back as {type:"sleep:state"} and Wake up as {type:"sleep:woke", at}.
// - Anywhere else (the iPhone web app, the website): this page draws the screen itself (views/SleepMode.tsx) and
//   holds a screen wake lock while it is up. Alarms there ring only while the page stays open and on screen.
// "Went to sleep" and "woke up" go into the Fitness settings record (fitness/sleep-store.ts sleepOpen, synced), so
// whichever device you pick up first can show the sleep to confirm. Nothing here sends anything to anyone else.
import { useSyncExternalStore } from "react";
import { vaultStore } from "../core/vault";
import { settingsData, todos } from "../core/select";
import { homeTz } from "../core/tz";
import { todayISO } from "../ui/kit";
import { PS, onPsSettings, psInOverlay, psPost, psSettingsNow } from "../ps";
import { sentryOf } from "../core/sentry";
import { GOS, gosPost, onShell } from "../gos/bridge";
import { fitnessNow, savePrefs } from "../fitness/store";
import { saveSleep, sleepNow } from "../fitness/sleep-store";
import { usual, type SleepLog } from "../core/sleep";
import { breakOpen, breakStage, buildPlan, moreOpen, pauseOpen, propose, resumeOpen, sleepModeOf, timeoutOpen, timerOpen, todayTasks, upOpen, wakeCard, wokeElsewhere,
  type SleepPlan, unsavedLog } from "../core/sleepmode";
import { okWakeIn, wakeInAt, type SleepTimer } from "../core/sleepwake";
import type { OpenSleep } from "../core/fitness";
import { onSleepSquad, sleepSquadNow } from "./squad";
import { clearSpentOnce, onceAuthAnswer, onceFromShell, onceOn } from "./once";
import { lpInterval } from "../core/lowpower.ts";

export type Where = "mac" | "phone" | "web";
// The build mode itself, not ps.ts's PS: this module can load before ps.ts finishes (they import each other), and then
// PS is not ready yet (the dev server's ?fake page went blank, 17 Nov 2026).
export const WHERE: Where = import.meta.env.MODE === "ps" ? "mac" : import.meta.env.MODE === "gos" ? "phone" : "web";

export interface SleepState {
  here: boolean;                       // the sleep screen is up on this device
  woke: { at: string; tz: string; woke: string; breaks?: { start: string; end: string }[] | null } | null;   // the Sleep log card, shown at once, saved or not
  choose: { at: number; since: number | null } | null;   // V1.43: Wake up pressed here: "Up for the day, or just checking something?"
  breakAsk: number;                    // V1.43: "Go back to sleep?" is showing: which ask (1 to BREAK_ASKS), 0 none
  breakHidden: number;                 // the ask Esc put away (the next one shows again)
  since: number | null;                // went to sleep (ms)
  asking: boolean;                     // pressed, waiting for the Mac or phone to say it is up
  onBattery: boolean; pct: number | null;   // Mac only
  note: string | null;                 // a plain sentence to show once (refused, stopped on battery, an old PS)
  wakeLock: "on" | "off" | "none";     // web only: the screen wake lock
  customising: boolean;                // V1.42: Customise is open (from the settings, the web screen, or the Mac or phone screen)
}
let st: SleepState = { here: false, woke: null, choose: null, breakAsk: 0, breakHidden: 0, since: null, asking: false, onBattery: false, pct: null, note: null, wakeLock: "none", customising: false };
const subs = new Set<() => void>();
function set(p: Partial<SleepState>) { st = { ...st, ...p }; subs.forEach((f) => f()); }
export function useSleepMode(): SleepState {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => st);
}
export const sleepState = () => st;

/** A short status line in this device's own log (ps.log on a Mac, the phone's log, the console): the step, never data.
 *  V1.41: Wake up "did nothing" on 7 Nov 2026 and no device had a line to say why. */
export function sleepLog(text: string) {
  const t = `sleep: ${text}`.slice(0, 180);
  try {
    if (WHERE === "mac") psPost({ type: "log", text: t });
    else if (WHERE === "phone") gosPost({ type: "log", text: t });
    else console.info(`PS ${t}`);
  } catch { /* no log here */ }
}

/** This device's zone: alarms ring on the clock in front of you (the Sleep log keeps its own zone). */
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || homeTz(); } catch { return homeTz(); } };

/** The open sleep (any device), if it is still a real one: no wake yet and under 20 hours old. */
export function openSleep(): OpenSleep | null {
  const o = fitnessNow().prefs.sleepOpen;
  if (!o || typeof o.at !== "string") return null;
  return o;
}
const live = (o: ReturnType<typeof openSleep>, now = Date.now()) => !!o && !o.woke && now - Date.parse(o.at) < 20 * 3600_000;

/** The plan for the shells (and the web screen): counts only unless "Show full details" is on. */
export function currentPlan(since: number): SleepPlan {
  const s = vaultStore.get();
  const prefs = sleepModeOf(settingsData(s));
  const list = s.status === "unlocked" ? todos(s).map((d) => d.data) : [];
  let usualWake: string | null = null;
  try { const u = usual(sleepNow().days); usualWake = u.known ? u.wake : null; } catch { /* no Sleep log yet */ }
  const o = openSleep();
  const timer = live(o) ? o!.timer ?? null : pendingTimer;
  // V1.52: on a Mac the plan carries the AI Sentry mode button's settings and the same restart check as the AI button.
  const sentry = WHERE === "mac" ? { prefs: sentryOf(settingsData(s)), reboot: psSettingsNow()?.reboot } : null;
  return buildPlan({ since, tz: localTz(), prefs, usualWake, tasks: todayTasks(list, todayISO()), squad: sleepSquadNow(), psBase: sleepPsBase(), timer, now: Date.now(), sentry, onceOn: onceOn() });
}

// ---------- "Wake me up in" (V1.43) ----------
/** Set before the sleep is saved (Sleep pressed with a timer, the Mac or phone not up yet): it goes in with it. */
let pendingTimer: SleepTimer | null = null;
/** "Wake me up in `mins`" (null: no timer). On the open sleep, so every device rings it; the shells get a new plan. */
export async function setWakeIn(mins: number | null, now = Date.now()) {
  const m = mins == null ? null : okWakeIn(mins);
  const style = sleepModeOf(settingsData(vaultStore.get())).wake.timer;
  const o = openSleep();
  sleepLog(m == null ? "Wake me up in: no timer" : `Wake me up in ${m} min`);
  if (live(o, now)) {
    await savePrefs({ sleepOpen: timerOpen(o!, m, now, style) }).catch((e) => sleepLog(`timer not saved (${errText(e)})`));
  } else pendingTimer = m == null ? null : { at: new Date(wakeInAt(now, m)).toISOString(), mins: m, style };
  if (WHERE === "web") bumpWeb(); else { lastPlan = ""; refreshPlan(); }
}
/** The timer for this sleep, if any (the open sleep's, else one waiting to go in with it). */
export function wakeInNow(): SleepTimer | null { const o = openSleep(); return live(o) ? o!.timer ?? null : pendingTimer; }
let webBumps = 0;
const webSubs = new Set<() => void>();
function bumpWeb() { webBumps++; webSubs.forEach((f) => f()); }
/** For the web screen: redraws when the timer changes (the plan is rebuilt from it). */
export function useWakeInBump(): number { return useSyncExternalStore((f) => { webSubs.add(f); return () => { webSubs.delete(f); }; }, () => webBumps); }

/** The PS look's background colour (the "PS background" choice), as #rrggbb, or null when there is none. */
export function sleepPsBase(): string | null {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--k-base").trim();
    if (/^#[0-9a-f]{6}$/i.test(v)) return v;
    const m = v.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i);
    return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : null;
  } catch { return null; }
}

// ---------- Customise (V1.42) ----------
/** Opens Customise (the settings button, the web screen's own button). */
export function openCustomise() { if (!st.customising) { sleepLog("Customise opened"); set({ customising: true }); } }
let custClosedAt = 0;
export function closeCustomise() { if (st.customising) { custClosedAt = Date.now(); set({ customising: false }); } }
/** True for a moment after Customise closed, so the same Esc never also leaves the screen under it. */
export const customiseJustClosed = () => Date.now() - custClosedAt < 300;
/** Esc on the web screen: the screen goes, nothing is logged (the "Asleep since" row then offers Wake up). Never a trap. */
export function leaveScreen() {
  if (!st.here || WHERE !== "web") return;
  sleepLog("Esc, the screen goes (no wake time)");
  set({ here: false, since: null, customising: false });
  releaseWakeLock();
}

// ---------- going to sleep ----------
/** The Sleep button. Keeps a sleep another device already started (both then say the same "Asleep for"). */
export async function goToSleep(opt?: { wakeIn?: number | null }) {
  if (st.here || st.asking) return;
  const now = Date.now();
  if (opt && opt.wakeIn !== undefined) {   // V1.43: Sleep with "Wake me up in" (Sleep mode's settings, the row)
    const m = opt.wakeIn == null ? null : okWakeIn(opt.wakeIn);
    const o0 = openSleep();
    const style = sleepModeOf(settingsData(vaultStore.get())).wake.timer;
    if (live(o0, now)) await savePrefs({ sleepOpen: timerOpen(o0!, m, now, style) }).catch(() => {});
    else pendingTimer = m == null ? null : { at: new Date(wakeInAt(now, m)).toISOString(), mins: m, style };
  }
  const o = openSleep();
  const since = live(o, now) ? Date.parse(o!.at) : now;
  // V1.43: Sleep again while a Wake up waits for its answer, or during a break: the time up is kept as a break.
  if (live(o, now) && (o!.paused || o!.brk)) { void savePrefs({ sleepOpen: resumeOpen(o!, now) }).catch(() => {}); set({ choose: null, breakAsk: 0 }); }
  const plan = currentPlan(since);
  sleepLog(`Sleep pressed (${WHERE}${live(o, now) ? ", keeps a sleep from another device" : ""})`);
  if (WHERE === "web") { set({ here: true, woke: null, since, note: null, customising: false }); void holdWakeLock(); }
  else {
    set({ asking: true, woke: null, note: null, customising: false });
    if (WHERE === "mac") psPost({ type: "sleep:start", plan }); else gosPost({ type: "sleep:start", plan });
    // An older PS without Sleep mode never answers.
    window.setTimeout(() => { if (st.asking) { sleepLog("no answer from the shell"); set({ asking: false, note: "Update PS app to use Sleep mode on this device." }); } }, 2500);
  }
  lastPlan = JSON.stringify(plan);
  // The website records "went to sleep" now; the Mac and the phone only once their screen is really up (a refusal
  // on battery or over 1Password or Signal must not leave a sleep open).
  if (WHERE === "web") await recordAsleep(since);
}
async function recordAsleep(since: number) {
  if (live(openSleep())) return;
  await logUnsaved(true);   // PS 1.68: last night, still waiting for its Save, goes into the Sleep log before this one starts
  const timer = pendingTimer && Date.parse(pendingTimer.at) > since ? pendingTimer : null;
  pendingTimer = null;
  await savePrefs({ sleepOpen: { at: new Date(since).toISOString(), tz: homeTz(), ...(timer ? { timer } : {}) } }).catch((e) => sleepLog(`went to sleep not saved (${errText(e)})`));
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 80);

// ---------- waking up ----------
/** Wake up (on any device): the screen goes and, V1.43, the sleep waits for "Up for the day, or just checking
 *  something?" (the chooser shows at once from this device's own copy, and any device can answer it).
 *  V1.41 (the developer, 7 Nov 2026: "The wake up button doesn't work"): the press always does something on screen at once,
 *  whether or not the vault write lands, and every step goes into the log. */
export async function wokeUp(at = Date.now()) {
  const was = st.here;
  const o = openSleep();
  const live = !!o && !o.woke;
  sleepLog(`Wake up (${WHERE}, screen ${was ? "up here" : "elsewhere"}, ${o ? (o.woke ? "already woke" : "open sleep") : "no open sleep"})`);
  set({ here: false, asking: false, since: null, choose: live || st.since != null ? { at, since: st.since } : null, breakAsk: 0,
    woke: !live && st.since == null ? wakeCard(o, at, null, homeTz()) : null });
  releaseWakeLock();
  if (was && WHERE !== "web") (WHERE === "mac" ? psPost : gosPost)({ type: "sleep:stop" });
  if (!live) return;
  try { await savePrefs({ sleepOpen: pauseOpen(o!, at) }); sleepLog("wake time kept, asking: up or a break"); }
  catch (e) { sleepLog(`wake time not saved (${errText(e)})`); }   // the chooser still shows (st.choose)
}
/** "I'm up": the sleep ends when you got up, then the Sleep log card (or straight into the log with "Log straight
 *  away"). A hand typed sleep for that date is never replaced silently. */
export async function chooseUp() {
  const c = st.choose, o = openSleep();
  set({ choose: null, breakAsk: 0 });
  sleepLog("I'm up");
  if (o && !o.woke) { await finishSleep(upOpen(o, c?.at ?? Date.now())); return; }
  set({ woke: wakeCard(null, c?.at ?? Date.now(), c?.since ?? null, homeTz()) });
}
/** "Back to sleep in N minutes": the sleep stays open as a break; the screen comes back when you say so. */
export async function chooseBreak(mins: number) {
  const c = st.choose, now = Date.now();
  let o = openSleep();
  if (!o || o.woke) {
    if (c?.since == null) { await chooseUp(); return; }
    o = { at: new Date(c.since).toISOString(), tz: homeTz() };
  }
  const o2 = breakOpen(o.paused ? o : pauseOpen(o, c?.at ?? now), mins, now, WHERE);
  set({ choose: null, breakAsk: 0, breakHidden: 0 });
  sleepLog(`a break of ${mins} min`);
  if (WHERE === "phone") gosPost({ type: "sleep:break", until: Date.parse(o2.brk!.until), plan: currentPlan(Date.parse(o2.at)) });
  await savePrefs({ sleepOpen: o2 }).catch((e) => sleepLog(`break not saved (${errText(e)})`));
}
/** "Back to sleep" (the break is over and kept): the sleep screen comes back, the same sleep goes on. */
export async function breakBack() {
  const o = openSleep();
  set({ breakAsk: 0, breakHidden: 0, choose: null });
  if (!o || o.woke) return;
  sleepLog("back to sleep");
  await savePrefs({ sleepOpen: resumeOpen(o, Date.now()) }).catch((e) => sleepLog(`back to sleep not saved (${errText(e)})`));
  await goToSleep();
}
/** "5 more minutes". */
export async function breakMore() {
  const o = openSleep();
  set({ breakAsk: 0, breakHidden: 0 });
  if (!o?.brk) return;
  const o2 = moreOpen(o, Date.now());
  sleepLog("5 more minutes");
  if (WHERE === "phone") gosPost({ type: "sleep:break", until: Date.parse(o2.brk!.until), plan: currentPlan(Date.parse(o2.at)) });
  await savePrefs({ sleepOpen: o2 }).catch((e) => sleepLog(`5 more minutes not saved (${errText(e)})`));
}
/** "I'm up now" on a break: the sleep ended when the break began. */
export async function breakUp() {
  const o = openSleep();
  set({ breakAsk: 0, breakHidden: 0 });
  if (!o || o.woke) return;
  sleepLog("I'm up now");
  if (WHERE === "phone") gosPost({ type: "sleep:breakEnd" });
  await finishSleep(upOpen(o, Date.now()));
}
/** Esc on "Go back to sleep?": put away until the next ask. Never a trap. */
export function hideBreakAsk() { set({ breakHidden: st.breakAsk }); }
async function finishSleep(o2: OpenSleep) {
  const woke = Date.parse(o2.woke ?? "");
  set({ woke: { at: o2.at, tz: o2.tz, woke: o2.woke!, ...(o2.breaks?.length ? { breaks: o2.breaks } : {}) } });
  try {
    if (!sleepModeOf(settingsData(vaultStore.get())).ask) {
      const p = propose(o2, woke);
      const had = p?.log ? sleepNow().days.get(p.log.day) : undefined;
      if (p?.log && (!had || had.src === "sleepmode")) {
        await saveSleep(p.log); await savePrefs({ sleepOpen: null });
        set({ woke: null }); sleepLog("logged straight away"); return;
      }
    }
    await savePrefs({ sleepOpen: o2 });
    sleepLog("wake time saved");
  } catch (e) {
    sleepLog(`wake time not saved (${errText(e)})`);   // the card still shows (st.woke); its Save writes the sleep
  }
}
/** No answer after the asks: the sleep ends at the last moment of activity (Mac: its idle time; a browser: the last
 *  touch or key in this page; the phone does this itself). */
let ending = false;
async function breakTimeout() {
  const o = openSleep();
  if (ending || !o?.brk) return;
  ending = true;
  try {
    const now = Date.now();
    let last = now;
    if (WHERE === "mac") { const idle = await macIdle(); if (idle != null) last = now - idle; }
    else if (WHERE === "web") last = pageActive;
    sleepLog(`no answer to "Go back to sleep?", ending at the last activity (${Math.round((now - last) / 60000)} min ago)`);
    set({ breakAsk: 0, breakHidden: 0 });
    await finishSleep(timeoutOpen(o, last, now));
  } finally { ending = false; }
}
let pageActive = Date.now();
let idleWait: ((ms: number | null) => void) | null = null;
function macIdle(): Promise<number | null> {
  return new Promise((res) => {
    idleWait = res;
    psPost({ type: "sleep:idle" });
    window.setTimeout(() => { if (idleWait === res) { idleWait = null; res(null); } }, 2500);
  });
}
/** Every few seconds while a break runs on this device: ask when it is up (raising the Tab list on a Mac), again
 *  every 5 minutes, then end it. A break taken on another device is only shown, never asked here. */
function breakTick() {
  const o = openSleep();
  if (!o?.brk || o.woke) { if (st.breakAsk) set({ breakAsk: 0 }); return; }
  if (o.brk.dev !== WHERE) return;
  const b = breakStage(o.brk, Date.now());
  if (b.stage === "running") { if (st.breakAsk) set({ breakAsk: 0 }); return; }
  if (b.stage === "ask" && b.ask !== st.breakAsk) {
    sleepLog(`break over, asking (${b.ask})`);
    set({ breakAsk: b.ask });
    if (WHERE === "mac") psPost({ type: "sleep:show" });
  }
  if (b.stage === "end" && WHERE !== "phone") void breakTimeout();
}
/** The card's Save: the sleep (as shown or as changed) goes into the Sleep log, and the open sleep is closed. */
export async function confirmSleep(log: SleepLog) {
  await saveSleep(log);
  await savePrefs({ sleepOpen: null });
  set({ woke: null });
  sleepLog("sleep saved to the Sleep log");
}
/** The card's "Don't log": closes the open sleep without saving anything. */
export async function discardSleep() {
  set({ woke: null, choose: null });
  sleepLog("sleep not logged");
  await savePrefs({ sleepOpen: null });
}

// ---------- the shells' answers ----------
type MacState = { authId?: unknown; authOk?: unknown; authNone?: unknown; once?: unknown; idleMs?: unknown; wakeIn?: unknown; wakeFrom?: unknown; alarmOnly?: unknown; running?: unknown; since?: unknown; onBattery?: unknown; pct?: unknown; stopped?: unknown; woke?: unknown; refused?: unknown };
function fromMac(m: MacState) {
  // PS 1.65 Just tomorrow: the Mac's answer to a Touch ID ask from Settings, or a choice made on its clock (Touch ID already passed).
  if (typeof m.authId === "string") { onceAuthAnswer(m.authId, m.authOk, m.authNone); return; }
  if (m.once && typeof m.once === "object") { sleepLog("Just tomorrow set on the clock"); onceFromShell(m.once); return; }
  if (typeof m.idleMs === "number") { const f = idleWait; idleWait = null; f?.(m.idleMs); return; }   // V1.43: the Mac's idle time
  // V1.43: "Wake me up in" set on the Mac's clock (from the Mac's own moment, so both ring at the same minute).
  // V1.47: the Mac rang an alarm with Sleep mode off (its own screen, Stop closes it): no sleep to record or end.
  if (m.alarmOnly === true) { sleepLog(`alarm with Sleep mode off: ${m.running === true ? "ringing" : "over"}`); return; }
  if (typeof m.wakeIn === "number") { const f = Number(m.wakeFrom); void setWakeIn(m.wakeIn > 0 ? m.wakeIn : null, Number.isFinite(f) && Math.abs(f - Date.now()) < 60_000 ? f : Date.now()); return; }
  const running = m.running === true;
  const since = Number(m.since);
  const pct = Number.isFinite(Number(m.pct)) && m.pct !== null ? Math.round(Number(m.pct)) : null;
  sleepLog(`shell says ${running ? "up" : "down"}${m.refused ? `, refused ${String(m.refused).slice(0, 20)}` : ""}${m.stopped ? `, stopped ${String(m.stopped).slice(0, 20)}` : ""}`);
  const patch: Partial<SleepState> = { here: running, asking: false, since: running && Number.isFinite(since) ? since : null, onBattery: m.onBattery === true, pct };
  if (m.refused === "battery") patch.note = "Plug in your Mac first. Sleep mode needs mains power below 20% battery.";
  else if (m.refused === "protected") patch.note = "Sleep mode did not open: a protected app is in front.";
  else if (m.stopped === "battery") patch.note = "Sleep mode stopped at 20% battery so your Mac could sleep.";
  // V1.52: Sentry mode under Sleep mode reached its own battery stop: both ended and the Mac locked.
  else if (m.stopped === "sentryBattery") patch.note = "Sleep mode and Sentry mode stopped at your battery level, and your Mac locked.";
  // V1.52: "Set up the helper" on the sleep screen's restart warning: the sleep stays open, Security opens (views/Sentry.tsx).
  if (m.stopped === "security") window.setTimeout(() => window.dispatchEvent(new Event("ps-sentry-security")), 250);
  // Customise pressed on the Mac's clock (after Touch ID): the sleep stays open, Customise opens in the Tab list.
  if (m.stopped === "customise") patch.customising = true;
  // V1.47: the gear on the Mac's clock (after Touch ID): the sleep stays open, Sleep settings open in the Tab list.
  if (m.stopped === "settings") window.setTimeout(() => window.dispatchEvent(new Event("ps-sleep-settings")), 250);
  const started = running && !st.here && patch.since != null;
  set(patch);
  if (started) void recordAsleep(patch.since!);
  // Wake up passed Touch ID (or the Mac password): the wake time comes with it.
  if (m.stopped === "wake" && Number.isFinite(Number(m.woke))) void wokeUp(Number(m.woke));
}
function fromPhone(m: Record<string, unknown>) {
  if (m.type === "sleep:auth") { onceAuthAnswer(m.id, m.ok, m.none); return; }   // PS 1.65 Just tomorrow: the phone's unlock answer
  if (m.type === "sleep:once") { sleepLog("Just tomorrow set on the clock"); onceFromShell(m); return; }   // chosen on the phone's clock, unlock passed
  if (m.type === "sleep:state" && m.alarmOnly === true) {
    sleepLog(`alarm with Sleep mode off: ${m.running === true ? "ringing" : "over"}`);   // V1.47: nothing to record or end
  } else if (m.type === "sleep:settings") {
    // V1.47: the gear on the phone's clock (after its unlock): the sleep stays open, Sleep settings open here.
    sleepLog("shell Sleep settings");
    gosPost({ type: "sleep:settingsSeen" });
    set({ here: false, asking: false, since: null });
    window.setTimeout(() => window.dispatchEvent(new Event("ps-sleep-settings")), 250);
  } else if (m.type === "sleep:state") {
    const running = m.running === true, since = Number(m.since);
    if (running !== st.here || m.refused) sleepLog(`shell says ${running ? "up" : "down"}${m.refused ? `, refused ${String(m.refused).slice(0, 20)}` : ""}`);
    const started = running && !st.here && Number.isFinite(since);
    set({ here: running, asking: false, since: running && Number.isFinite(since) ? since : null });
    if (started) void recordAsleep(since);
    if (m.refused === "exactAlarm") set({ note: "Allow Alarms and reminders for PS app so alarms ring on time." });
  } else if (m.type === "sleep:breakAnswer" && typeof m.answer === "string" && Number.isFinite(Number(m.at))) {
    // The break's notification on the phone (it may come before the vault is open): kept until it is.
    sleepLog(`shell break answer: ${String(m.answer).slice(0, 10)}`);
    pendingBreak = { answer: String(m.answer), at: Number(m.at) };
    flushBreak();
  } else if (m.type === "sleep:wakeIn" && Number.isFinite(Number(m.mins))) {
    // V1.43: "Wake me up in" set on the phone's clock (the phone already armed it): kept until the vault is open.
    sleepLog("shell Wake me up in");
    pendingWakeIn = { mins: Number(m.mins), at: Number.isFinite(Number(m.at)) ? Number(m.at) : Date.now() };
    flushWakeIn();
  } else if (m.type === "sleep:customise") {
    // Customise pressed on the phone's clock (after its unlock): the sleep stays open, Customise opens here.
    sleepLog("shell Customise");
    gosPost({ type: "sleep:customiseSeen" });
    set({ here: false, asking: false, since: null, customising: true });
  } else if (m.type === "sleep:woke" && Number.isFinite(Number(m.at))) {
    sleepLog(`shell Wake up${vaultStore.get().status === "unlocked" ? "" : ", waits for the vault"}`);
    pendingWoke = Number(m.at);
    flushWoke();
  }
}
let pendingBreak: { answer: string; at: number } | null = null;
function flushBreak() {
  if (pendingBreak == null || vaultStore.get().status !== "unlocked") return;
  const { answer, at } = pendingBreak;
  pendingBreak = null;
  gosPost({ type: "sleep:breakSeen" });
  const o = openSleep();
  if (!o?.brk || o.woke) return;
  set({ breakAsk: 0, breakHidden: 0 });
  // "back": the phone already put the clock up again; the break is over and kept.
  if (answer === "back") void savePrefs({ sleepOpen: resumeOpen(o, at) }).catch(() => {});
  else if (answer === "more") void savePrefs({ sleepOpen: moreOpen(o, at) }).catch(() => {});
  else if (answer === "up") void finishSleep(upOpen(o, at));
  else if (answer === "timeout") void finishSleep(timeoutOpen(o, at, Date.now()));
}
let pendingWakeIn: { mins: number; at: number } | null = null;
function flushWakeIn() {
  if (pendingWakeIn == null || vaultStore.get().status !== "unlocked") return;
  const { mins, at } = pendingWakeIn;
  pendingWakeIn = null;
  gosPost({ type: "sleep:wakeInSeen" });
  void setWakeIn(mins > 0 ? mins : null, at);
}
// The phone's Wake up may arrive before the vault is open (the fingerprint comes first): kept until it is.
let pendingWoke: number | null = null;
function flushWoke() {
  if (pendingWoke == null || vaultStore.get().status !== "unlocked") return;
  const at = pendingWoke;
  pendingWoke = null;
  gosPost({ type: "sleep:wokeSaved" });
  void wokeUp(at);
}

function endIfWokeElsewhere() {
  if (!wokeElsewhere(openSleep(), st.here, st.since)) return;
  sleepLog("woke on another device, closing here");
  set({ here: false, asking: false, since: null });
  releaseWakeLock();
  if (WHERE !== "web") (WHERE === "mac" ? psPost : gosPost)({ type: "sleep:stop" });
}

// ---------- keeping the shell's plan fresh (tasks, squad, settings) while it is up ----------
let lastPlan = "";
let planTimer = 0;
function refreshPlan() {
  if (!st.here || st.since == null || WHERE === "web") return;
  window.clearTimeout(planTimer);
  planTimer = window.setTimeout(() => {
    if (!st.here || st.since == null) return;
    const plan = currentPlan(st.since);
    const json = JSON.stringify(plan);
    if (json === lastPlan) return;
    lastPlan = json;
    (WHERE === "mac" ? psPost : gosPost)({ type: "sleep:plan", plan });
  }, 1500);
}

// ---------- web: the screen wake lock ----------
type Sentinel = { released: boolean; release(): Promise<void>; addEventListener(t: "release", f: () => void): void };
let lock: Sentinel | null = null;
async function holdWakeLock() {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<Sentinel> } }).wakeLock;
  if (!wl) { set({ wakeLock: "none" }); return; }
  try {
    lock = await wl.request("screen");
    set({ wakeLock: "on" });
    lock.addEventListener("release", () => { if (st.here) set({ wakeLock: "off" }); });
  } catch { set({ wakeLock: "off" }); }
}
function releaseWakeLock() { const l = lock; lock = null; if (l && !l.released) void l.release().catch(() => {}); if (st.wakeLock !== "none") set({ wakeLock: "off" }); }

let started = false;
/** PS 1.68 (core/sleepmode.ts unsavedLog): a woken sleep nobody saved or discarded is logged by itself. */
let logging = false;
async function logUnsaved(force = false) {
  if (logging) return;
  const o = openSleep();
  if (!o?.woke) return;
  const day = propose(o, Date.parse(o.woke))?.log?.day;
  const log = unsavedLog(o, Date.now(), day ? sleepNow().days.get(day) : null, force);
  if (!log && !(force && o.woke)) return;
  logging = true;
  try {
    if (log) await saveSleep(log);
    await savePrefs({ sleepOpen: null });
    if (st.woke) set({ woke: null });
    sleepLog(log ? "an unanswered sleep was logged by itself" : "an unanswered sleep could not be logged (a hand typed one stays)");
  } catch (e) { sleepLog(`unanswered sleep not logged (${errText(e)})`); }
  finally { logging = false; }
}
export function startSleepEngine() {
  if (started) return;
  if (WHERE === "mac" && !psInOverlay()) return;   // PS: only the Tab list page runs it (the main page never draws the button)
  started = true;
  if (WHERE === "mac") {
    (window as Window & { __psSleep?: (m: MacState) => void }).__psSleep = (m) => { if (m && typeof m === "object") fromMac(m); };
    psPost({ type: "sleep:get" });
  }
  if (WHERE === "phone") { onShell(fromPhone); gosPost({ type: "sleep:get" }); }
  if (WHERE === "web") {
    // The browser drops the wake lock when the page is hidden; it is asked for again when it comes back.
    document.addEventListener("visibilitychange", () => { if (st.here && document.visibilityState === "visible" && (!lock || lock.released)) void holdWakeLock(); });
  }
  vaultStore.subscribe(() => { refreshPlan(); flushWoke(); flushBreak(); flushWakeIn(); endIfWokeElsewhere(); sendAlarms(); void logUnsaved(); });
  lpInterval("alarms", sendAlarms, 30_000);   // PS 1.65: Sleep mode alarms ring in Low power mode while Keep reminders ringing is on
  sendAlarms();
  // V1.43 breaks: checked every 10 seconds; a browser also notes the last touch or key (the last moment of activity).
  lpInterval("alarms", breakTick, 10_000);
  if (WHERE === "web") for (const t of ["pointerdown", "keydown", "mousemove", "touchstart"]) window.addEventListener(t, () => { pageActive = Date.now(); }, { passive: true, capture: true });
  onSleepSquad(refreshPlan);
  if (WHERE === "mac") onPsSettings(refreshPlan);   // V1.52: the restart helper's state feeds the AI Sentry mode button's check
}
// ---------- V1.47 alarms ring even when Sleep mode is off (the developer's friend: "Have the alarm play even if I don't turn on
// Sleep mode ... ringing no matter what should be the default") ----------
// The Mac and the phone get the next alarms (a plan made from now, alarmOnly) and ring them with their own screen and
// sound whenever Sleep mode is not up; a new plan goes whenever the alarms, their sounds or the day's file change.
// Off ("Alarms ring even when Sleep mode is off" switched off, the Sleep button hidden, or no alarm on): plan null.
let lastAlarms = "";
function sendAlarms() {
  if (WHERE === "web" || !started) return;
  const s = vaultStore.get();
  if (s.status !== "unlocked") return;
  const prefs = sleepModeOf(settingsData(s));
  const now = Date.now();
  const on = prefs.show && prefs.ringAlways && prefs.alarms.some((a) => a.on);
  const plan = on ? buildPlan({ since: now, tz: localTz(), prefs, tasks: [], squad: null, psBase: sleepPsBase(), now, alarmOnly: true, onceOn: onceOn() }) : null;
  if (prefs.once) clearSpentOnce(now);   // PS 1.65: a Just tomorrow whose morning is over clears itself
  const key = plan ? JSON.stringify({ rings: plan.rings, list: plan.list, styles: plan.styles, look: plan.look, lock: plan.lock }) : "off";
  if (key === lastAlarms) return;
  lastAlarms = key;
  (WHERE === "mac" ? psPost : gosPost)({ type: "sleep:alarms", plan });
  sleepLog(plan ? `alarms ring with Sleep mode off (${plan.rings.length})` : "alarms ring only in Sleep mode");
}
/** For the screens: clear the one time note. */
export function clearSleepNote() { if (st.note) set({ note: null }); }
