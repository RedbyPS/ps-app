// PS GOS bridge between this page and the GrapheneOS shell (~/Projects/ps/phone).
//   page  -> shell: window.gosNative.postMessage(json)   (WebViewCompat.addWebMessageListener, only
//                   for https://appassets.androidplatform.net, so no other page can reach the shell)
//   shell -> page:  the same object's onmessage
// Nothing here sends anything to another person (Rule Zero): cards become notifications on this
// phone only. Signal and 1Password never get this far (the shell drops them at the first read),
// and isProtectedApp drops them again here.
import { useSyncExternalStore } from "react";
import { phoneScreenTimeOn } from "../core/offswitches";
import { localKeyMessage } from "../core/localholders";
import { fileSavedMessage } from "../localfirst";
import { gosPhoneCheck, lock, setOnPhoneRemoved, setPsKeepOpen, setPsRememberHook, sb, sync, unlockOnDevice, vaultStore } from "../core/vault";
import { saveScreenLine, saveScreenTime } from "../core/actions";
import { cleanTimeline } from "../core/stline";
import { setPhoneAsk, setPhoneLine } from "../stlive";
import { isProtectedApp } from "../core/protected";
import { isMeeting } from "../core/notescard";
import { shortHash } from "../core/meetalerts";
import { workingIdsOf, type CalendarSnap } from "../core/model";
import { settingsData, todos } from "../core/select";
import { mailCardMessage, refreshMailCards, startMailCards } from "../mailcards";
import { chatCardMessage, setNotePost } from "../squad/chatengine";
import { startMeetAlerts } from "../meetwatch";
import { startDnd } from "../dnd";
import { startSquad } from "../squad/engine";
import { setP1Post } from "../squad/p1engine";
import { startGymSquad } from "../squad/gym";
import { gymShellMessage, gymWake, startGymWatch } from "../gymwatch";
import { dayShellMessage, startDayCount } from "../daycount";
import { remShellMessage, remWake, startRemWatch } from "../remwatch";
import { landDayNow } from "../clients/clientsday";
import { waitsToLand } from "../core/clientwork";
import { scheduledOn } from "../core/scheduled";
import { calRefreshIfStale, startCalRefresh } from "../calrefresh";
import { visibleEvents } from "../core/meethide";
import { meetingEvents } from "../core/calpick";
import { startTgBot } from "../tgbot";
import { startIsland } from "../island";
import { isRedAccount } from "../core/account";

export const GOS = import.meta.env.MODE === "gos";
/** The mobile web app (cincee.com/todolist-mobile, src/mobile/): the same phone home as PS GOS in a phone's browser
 *  or installed to its Home Screen, with no shell. src/mobile/boot.ts sets the flag before any of this runs. */
export const MWEB = !GOS && (globalThis as { __psMobile?: unknown }).__psMobile === true;

type NativePort = { postMessage(m: string): void; onmessage: ((e: MessageEvent) => void) | null };
const port = () => (window as Window & { gosNative?: NativePort }).gosNative;

export function gosPost(msg: object) {
  // 1.60: the iPhone web app has no shell, so the reminders' plan goes to its own cards and push schedule (src/remweb.ts).
  if (MWEB) { const m = msg as { type?: string; plan?: unknown }; if (m.type === "remPlan" && m.plan) void import("../remweb").then((r) => r.webRemPlan(m.plan as { items?: never[] })); return; }
  try { port()?.postMessage(JSON.stringify(msg)); } catch { /* the dev page has no shell */ }
}

/** Short taps of the phone's own haptics (no vibrate permission, not a sensor). */
export type Haptic = "tick" | "press" | "drag" | "drop" | "reject";
export function haptic(kind: Haptic) {
  if (!MWEB) { gosPost({ type: "haptic", kind }); return; }
  // In a browser: a short buzz where the phone allows it (Android; iPhone browsers have no vibration), if switched on.
  if (state.prefs?.haptics === false) return;
  try { navigator.vibrate?.(kind === "reject" ? [12, 40, 12] : kind === "drag" ? 14 : kind === "tick" ? 6 : 9); } catch { /* not allowed */ }
}
/** Can this browser buzz at all (the Vibration switch only shows where it can). */
export const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";

// ---------- what the shell tells the page ----------
export type GosPrefs = {
  open: "tile" | "widget" | "notification" | "bubble";   // the default place the list opens from (all can be on)
  tile: boolean; widget: boolean; notification: boolean; bubble: boolean;
  background: boolean;                                   // background checks for meetings and client emails
  ays: boolean; aysApps: string[];                      // "Are you sure" for YouTube and Netflix
  haptics: boolean;
  stay: boolean;                                         // Stay signed in: no fingerprint each open, no lock by itself
  island?: boolean;                                      // V1.59 the Dynamic island over other apps (missing = on; an older shell has none)
  live?: boolean;                                        // V1.59 Instant notifications: the shell's live link (missing = on)
  screenTime?: boolean;                                  // Track my screen time (open source build): false = the shell reads no usage and nothing is saved (missing = on)
};
export type GosPerms = { notifications: boolean; usage: boolean; overlay: boolean; battery: boolean; exactAlarm: boolean; install: boolean; fullScreen?: boolean;
  /** V1.59: this build keeps the island off 1Password and Signal, so it needs Usage access. live: the live link is up. */
  islandUsage?: boolean; live?: boolean };
export type GosUpdate = { state: "idle" | "checking" | "none" | "available" | "downloading" | "verifying" | "ready" | "installing" | "error";
  version?: string; keyword?: string; current?: string; currentKeyword?: string; notes?: string; history?: unknown; size?: number; progress?: number; error?: string;
  by?: string };   // V1.58: who made the update ("jan", "gsquad"); shown only when it is a profile name (core/releaseby.ts)
export type GosState = {
  ready: boolean; visible: boolean; remembered: boolean; version: string; keyword: string; build: number;
  prefs: GosPrefs | null; perms: GosPerms | null; update: GosUpdate; online: boolean;
  insets: { top: number; bottom: number; left: number; right: number };
  /** V1.56: the phone's maker and model from the shell (Build.MANUFACTURER, Build.MODEL), for "Pixel 8, GrapheneOS" in
   *  the Mac's phone editor. "" from an older shell or the mobile web app. */
  device: string;
};
let state: GosState = {
  ready: false, visible: true, remembered: false, version: "", keyword: "", build: 0, prefs: null, perms: null,
  update: { state: "idle" }, online: true, insets: { top: 0, bottom: 0, left: 0, right: 0 }, device: "",
};
const subs = new Set<() => void>();
function set(p: Partial<GosState>) {
  state = { ...state, ...p };
  if (p.prefs) setPsKeepOpen(p.prefs.stay !== false);   // Stay signed in: the vault never locks itself after idle time
  subs.forEach((f) => f());
}
export function useGos() {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
}
export function gosState() { return state; }

/** Page side handlers for the shell's messages (the home screen listens for "open" and "back"). */
const listeners = new Set<(m: Record<string, unknown>) => void>();
export function onShell(f: (m: Record<string, unknown>) => void) { listeners.add(f); return () => { listeners.delete(f); }; }

// ---------- background checks (WorkManager in the shell) ----------
// The shell runs vault_probe itself (a few hundred bytes) and only wakes this page when a
// fingerprint moved. Then: open the vault with the background key if it was locked, one
// change-only sync, let the card logic run, hand over the upcoming meetings, lock again.
let pulsing = false;
async function pulse(m: Record<string, unknown>) {
  if (pulsing) return;
  pulsing = true;
  const was = vaultStore.get().status === "unlocked";
  let ok = false;
  try {
    if (!was) {
      if (typeof m.username !== "string" || typeof m.auth !== "string" || typeof m.kek !== "string") throw new Error("no keys");
      await unlockOnDevice(m.username, m.auth, m.kek);
    }
    await sync();
    refreshMailCards();                              // a reminded email card may be due with nothing changed in the vault
    gymWake();                                       // the gym plan for the shell (and an Acknowledge waiting to be saved)
    remWake();                                       // the reminders' plan (a Yes on the Mac clears the notification here)
    await new Promise((r) => setTimeout(r, 3500));   // mail cards wait 400 ms, meeting alerts 1.5 s after a change
    sendSchedule();
    ok = true;
  } catch (e) {
    gosPost({ type: "log", text: `pulse failed: ${(e instanceof Error ? e.message : "").slice(0, 100)}` });
  } finally {
    // Opened only for this check: closed again, so the next person to pick up the phone still meets the fingerprint.
    // With Stay signed in on (and no Lock pressed) it stays open: the next open needs nothing either.
    if (!was && !state.visible && m.keep !== true) lock();
    pulsing = false;
    gosPost({ type: "pulse:done", ok });
  }
}

/** The next two days of real meetings, so the shell can raise "starts in 10 minutes" on time and keep
 *  "Are you sure" quiet during calls, even while this page sleeps. Titles stay on the phone. */
let lastSchedule = "";
function sendSchedule() {
  const s = vaultStore.get();
  if (s.status !== "unlocked" || s.role !== "owner") return;
  const cal = [...s.docs.values()].filter((d) => d.kind === "calendar")
    .sort((a, b) => ((b.data as CalendarSnap).at || "").localeCompare((a.data as CalendarSnap).at || ""))[0];
  const now = Date.now();
  // Meetings the developer took off the panel ring no alarm either (core/meethide.ts).
  const list = visibleEvents(meetingEvents(cal ? (cal.data as CalendarSnap).events : [], settingsData(s).calChoices), settingsData(s).meetHidden)
    .filter((e) => isMeeting(e) && Date.parse(e.end!) > now && Date.parse(e.start!) < now + 2 * 864e5)
    .slice(0, 40)
    .map((e) => ({ id: `ms:${shortHash(e.id)}`, title: String(e.title || "Call").slice(0, 120), start: Date.parse(e.start!), end: Date.parse(e.end!) }));
  const json = JSON.stringify(list);
  if (json === lastSchedule) return;
  lastSchedule = json;
  gosPost({ type: "schedule", meetings: list });
}

/** The quiet notification, the tile and the widget: how many open tasks, the next three and the one in progress. */
let lastTasks = "";
function sendTasks() {
  const s = vaultStore.get();
  // PS 1.75: while "scheduled-tasks" is on, a task waiting for a later day (or a client task before its do date) is not counted
  // until its day (core/scheduled.ts). Off: as in 1.74.
  const day = scheduledOn() ? landDayNow(s) : null;
  const open = todos(s).filter((d) => !d.data.done && !d.data.clearedAt && d.data.type === "once" && d.data.aiInbox !== true && !(day && waitsToLand(d.data, day)))   // the AI Inbox is on no list
    .sort((a, b) => (a.data.order ?? 0) - (b.data.order ?? 0));
  const working = new Set(workingIdsOf(settingsData(s)));
  const w = open.find((d) => working.has(d.id));
  const msg = { type: "tasks", count: open.length, list: open.slice(0, 3).map((d) => d.data.title.slice(0, 120)), top: open[0]?.data.title.slice(0, 80) ?? "", working: w?.data.title.slice(0, 80) ?? "" };
  const json = JSON.stringify(msg);
  if (json !== lastTasks) { lastTasks = json; gosPost(msg); }
}

/** Screen time from the shell (ps-gos Watch.kt ScreenTime): today's seconds per app from midnight
 *  (package names, labels) and, since V1.31, the last day as a timeline. Saved as the phone's own day
 *  record and line hours; the line also shows straight away in this phone's screen time pop-up. */
function screenTime(m: Record<string, unknown>) {
  if (!phoneScreenTimeOn(state.prefs?.screenTime)) return;   // Settings, "Track my screen time" Off on this phone: nothing shown or saved
  // The phone's own line is this phone's, vault open or not (it never leaves the page unless saved below).
  const tl = cleanTimeline(m.tl, "gos:");
  if (tl) setPhoneLine(tl);
  const v = vaultStore.get();
  if (v.status !== "unlocked" || v.role !== "owner" || typeof m.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.day) || !Array.isArray(m.apps)) return;
  const apps = (m.apps as { id?: unknown; name?: unknown; secs?: unknown }[])
    .filter((a) => a && typeof a.id === "string" && a.id && !isProtectedApp(a.id) && !isProtectedApp(String(a.name || "")) && Number.isFinite(a.secs) && (a.secs as number) > 0)
    .slice(0, 300)
    .map((a) => ({ id: `gos:${String(a.id).slice(0, 190)}`, name: String(a.name || a.id).slice(0, 100), secs: Math.min(86400, Math.round(a.secs as number)) }));
  if (apps.length) void saveScreenTime(m.day, apps, "gos", m.exact === true);
  if (tl) void saveScreenLine("gos", tl);
}


function onMessage(m: Record<string, unknown>) {
  if (localKeyMessage(m) || fileSavedMessage(m)) return;   // local first: the Keystore's answer for the local vault key (src/core/localholders.ts), a saved backup
  switch (m.type) {
    case "hello":
      set({ ready: true, version: String(m.version || ""), keyword: String(m.keyword || "").slice(0, 40), build: Number(m.build) || 0, remembered: m.remembered === true,
        prefs: (m.prefs as GosPrefs) || null, perms: (m.perms as GosPerms) || null, visible: m.visible !== false,
        device: typeof m.device === "string" ? m.device.slice(0, 60) : "" });
      break;
    case "prefs": set({ prefs: m.prefs as GosPrefs }); break;
    case "perms": set({ perms: m.perms as GosPerms }); break;
    case "update": set({ update: m.update as GosUpdate }); break;
    case "net": set({ online: m.online !== false }); break;
    case "lowpowerOs": {   // PS 1.65: Battery Saver (src/lowpower.ts); kept for a page that starts Low power mode later
      const w = window as Window & { __psLowPowerOs?: (on: unknown) => void; __psLowPowerOsNow?: boolean };
      w.__psLowPowerOsNow = m.on === true;
      w.__psLowPowerOs?.(m.on === true);
      break;
    }
    case "visible": set({ visible: m.on === true }); if (m.on === true) { void sync(); calRefreshIfStale(); } break;
    case "insets": {
      const i = { top: Number(m.top) || 0, bottom: Number(m.bottom) || 0, left: Number(m.left) || 0, right: Number(m.right) || 0 };
      // V1.47: only when they changed. Each change on the page root restyles the whole page.
      const o = state.insets;
      if (i.top === o.top && i.bottom === o.bottom && i.left === o.left && i.right === o.right && document.documentElement.style.getPropertyValue("--gos-inset-top")) break;
      const r = document.documentElement.style;
      // V1.56: the shell's inset is --gos-inset-top; gos/gos.css makes --gos-top from it (plus the navbar's height when
      // the phone layout puts the navbar at the top, gos/phonepages.css).
      r.setProperty("--gos-inset-top", `${i.top}px`); r.setProperty("--gos-bottom", `${i.bottom}px`);
      r.setProperty("--gos-left", `${i.left}px`); r.setProperty("--gos-right", `${i.right}px`);
      set({ insets: i });
      break;
    }
    case "rememberStatus": set({ remembered: m.exists === true }); break;
    case "remember":
      // Derived keys from the Keystore after the fingerprint, in memory only.
      if (typeof m.username === "string" && typeof m.auth === "string" && typeof m.kek === "string") {
        void unlockOnDevice(m.username, m.auth, m.kek).then(() => { gosPost({ type: "log", text: "fingerprint sign in: ok" }); gosPhoneCheck(String(m.username)); }).catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : "";
          gosPost({ type: "log", text: `fingerprint sign in failed: ${msg.slice(0, 120)}` });
          if (/wrong username or passphrase|no vault keys/i.test(msg)) gosPost({ type: "remember:forget" });
        });
      }
      break;
    case "pulse": void pulse(m); break;
    case "cardAction": if (!mailCardMessage(m as { type?: string; id?: string; action?: string })) chatCardMessage(m as { type?: string; id?: string; action?: string }); break;   // a G Squad message card (g:) goes to the chat
    case "screentime": screenTime(m); break;
    case "gymAck": gymShellMessage(m); break;   // Acknowledge on the ring or a gym notification (ps-gos Gym.kt)
    case "dayAct": dayShellMessage(m as { act?: unknown; key?: unknown }); break;   // PS 1.70 End day now? or a time left reminder answered in a notification (ps-gos DayEnd.kt)
    case "remAct": remShellMessage(m); break;   // a reminder notification answered: Yes or Remind me in (ps-gos Remind.kt)
    case "rem:ready": remWake(true); break;     // the shell started again: send it the plan as it is
  }
  listeners.forEach((f) => f(m));
}

let started = false;
export function startGos() {
  if (!GOS || started) return;
  started = true;
  document.documentElement.classList.add("gos");
  setPhoneAsk(() => gosPost({ type: "screentime:get" }));   // the screen time pop-up asks for a fresh count when it opens
  startTgBot();   // Add Telegram Bot (V1.47): reads this person's own bot while PS runs, key in the Keystore (src/tgbot.ts)
  const p = port();
  if (p) p.onmessage = (e) => { try { const m = JSON.parse(String(e.data)); if (m && typeof m === "object") onMessage(m); } catch { /* not ours */ } };
  // Sign in once: the derived keys (never the passphrase) go to the phone's Keystore behind the fingerprint.
  setPsRememberHook((username, auth, kek) => gosPost({ type: "remember:save", username, auth, kek }));
  // V1.55: a phone signed in from the Mac and then removed there forgets its Keystore keys (core/vault.ts phoneStillLinked).
  setOnPhoneRemoved(() => gosPost({ type: "remember:forget" }));
  // The shell's own tiny vault_probe call needs the current access token (never the refresh token).
  sb.auth.onAuthStateChange((_e, session) => gosPost({ type: "session", access: session?.access_token ?? null, exp: session?.expires_at ?? 0 }));
  // Cards: client emails and meeting alerts become notifications. A lock hides PS's Mac cards; here a
  // lock (after a background check) must not take the notifications away again.
  const card = (m: object) => {
    const t = (m as { type?: string }).type;
    if (t === "cardHide" && vaultStore.get().status !== "unlocked") return;
    if (t === "meetCard" || t === "cardHide" || t === "aysMeeting") gosPost(m);
  };
  let cardsOn = false, lastStatus = "", wasOpen = false;
  let lastRed: boolean | null = null;
  vaultStore.subscribe(() => {
    const s = vaultStore.get();
    // Locked on screen (the Lock button, or the website's own Lock): the next open asks for the fingerprint
    // once, even with Stay signed in. A background check closing what it opened is not that.
    const open = s.status === "unlocked";
    if (wasOpen && s.status === "locked" && state.visible && !pulsing) gosPost({ type: "lock", byHand: true });
    if (open || s.status === "locked") wasOpen = open;
    const st = `${s.status}|${s.role}`;
    if (st !== lastStatus) {
      lastStatus = st;
      gosPost({ type: "status", unlocked: s.status === "unlocked", busy: s.status === "busy", owner: s.role === "owner" });
      // Screen time (V1.31): the count the shell sent while the vault was still opening was not saved, so ask again now.
      if (s.status === "unlocked" && s.role === "owner" && phoneScreenTimeOn(state.prefs?.screenTime)) gosPost({ type: "screentime:get" });
    }
    if (s.status === "unlocked" && s.role === "owner") {
      if (!cardsOn) {
        cardsOn = true;
        // When the next reminded email card is due (ms, 0 = none): the shell wakes this page then, even in the background.
        startMailCards(card, (at) => gosPost({ type: "remindNext", at }));
        setP1Post(card);   // G Squad Priority 1 cards: a missed task, your own reminder (core/squadp1.ts)
        setNotePost(card);   // G Squad message notifications (core/squadnotify.ts): the shell shows them, Open and Dismiss come back as cardAction
        startMeetAlerts(card);
        startDnd(gosPost, "phone");   // Do Not Disturb: the shell's own call alarms follow it too (Notifier.kt)
        startGymWatch(gosPost);   // the gym plan: the shell notifies and rings by itself (src/gymwatch.ts, ps-gos Gym.kt)
        startRemWatch(gosPost);   // the Annoying 15 min reminders: the shell notifies by itself (src/remwatch.ts, ps-gos Remind.kt)
        startDayCount(gosPost, "phone");   // PS 1.70 the day countdown: the shell notifies by itself while PS is closed (src/daycount.ts, ps-gos DayEnd.kt)
        startSquad();   // G Squad (V1.40): the phone counts as working while PS runs on it, and shares tasks (src/squad/engine.ts)
        startGymSquad();   // G Squad Fitness (V1.40): your Fitness and Sleep cards and the boards (src/squad/gym.ts)
        startCalRefresh(() => state.visible);   // the calendar every 2 minutes, only while PS is on screen; the server reads Google every minute (src/calrefresh.ts)
        // V1.59 the phone's Dynamic island (ps-gos Island.kt): the same island state the Mac gets (src/island.ts), drawn by
        // the shell around the camera over every app. Locked or signed out, it is told "off" and shows nothing of the vault.
        startIsland(gosPost);
      }
      // Whose account: the island's 1Password and Signal rule starts from it (the developer's own: never over them, core/profile.ts).
      const red = isRedAccount(s);
      if (red !== lastRed) { lastRed = red; gosPost({ type: "islandRule", red }); }
      sendSchedule();
      sendTasks();
    } else { lastSchedule = ""; lastTasks = ""; }
  });
  addEventListener("online", () => set({ online: true }));
  addEventListener("offline", () => set({ online: false }));
  gosPost({ type: "ready" });
}

// ---------- the mobile web app: the browser stands in for the shell ----------
const WEB_PREFS_KEY = "psm.prefs";
const WEB_PREFS: GosPrefs = { open: "tile", tile: false, widget: false, notification: false, bubble: false, background: false, ays: false, aysApps: [], haptics: true, stay: false };
function webPrefs(): GosPrefs {
  try {
    const o = JSON.parse(localStorage.getItem(WEB_PREFS_KEY) || "{}") as Record<string, unknown>;
    return { ...WEB_PREFS, haptics: o.haptics !== false };
  } catch { return WEB_PREFS; }
}
/** The mobile web app's own switches (kept in this browser only, never in the vault). */
export function setWebPrefs(p: Pick<Partial<GosPrefs>, "haptics">) {
  if (!MWEB) return;
  const next = { ...(state.prefs || WEB_PREFS), ...(typeof p.haptics === "boolean" ? { haptics: p.haptics } : {}) };
  try { localStorage.setItem(WEB_PREFS_KEY, JSON.stringify({ haptics: next.haptics })); } catch { /* storage off */ }
  state = { ...state, prefs: next };   // not set(): no shell, and Stay signed in is not a thing in a browser
  subs.forEach((f) => f());
}
/** The mobile web app plays a shell message to the page's own listeners (the keyboard height, src/mobile/keyboard.ts). */
export function shellSays(m: Record<string, unknown>) { if (MWEB) listeners.forEach((f) => f(m)); }
/** Start the mobile web app's stand in for the shell: on screen or not, online or not. No cards go anywhere. */
export function startMobileWeb() {
  if (!MWEB || started) return;
  started = true;
  document.documentElement.classList.add("gos", "mweb");
  state = { ...state, ready: true, prefs: webPrefs(), version: __PS_VERSION__.name, keyword: __PS_VERSION__.keyword,
    visible: document.visibilityState !== "hidden", online: navigator.onLine !== false };
  subs.forEach((f) => f());
  const seen = () => {
    const on = document.visibilityState !== "hidden";
    if (on === state.visible) return;
    state = { ...state, visible: on };
    subs.forEach((f) => f());
    // Back on screen: one change only sync (the same small ask the website makes), nothing while hidden.
    if (on && vaultStore.get().status === "unlocked") void sync();
  };
  document.addEventListener("visibilitychange", seen);
  addEventListener("pageshow", seen);
  addEventListener("online", () => { state = { ...state, online: true }; subs.forEach((f) => f()); });
  addEventListener("offline", () => { state = { ...state, online: false }; subs.forEach((f) => f()); });
  // PS 1.66: the island drawn inside the app (gos/PhoneIsland.tsx) reads the same island state; there is no shell to post it to.
  startIsland(() => {});
  startDayCount(null, "web");   // PS 1.70 the day countdown's card, drawn inside the page (views/DayCountdown.tsx)
}

// ---------- asks from the page ----------
export const gos = {
  setPrefs: (p: Partial<GosPrefs>) => gosPost({ type: "prefs:set", prefs: p }),
  openPermission: (which: keyof GosPerms) => gosPost({ type: "perm", which }),
  /** PS 1.60: PS app's own settings page (the camera switch, and the three dots with Allow restricted settings). */
  openAppSettings: () => gosPost({ type: "perm", which: "app" }),
  checkUpdate: () => gosPost({ type: "update:check" }),
  installUpdate: () => gosPost({ type: "update:install" }),
  forget: () => gosPost({ type: "remember:forget" }),
  lock: () => { gosPost({ type: "lock", byHand: true }); lock(); },
  backNone: () => gosPost({ type: "back:none" }),
};
