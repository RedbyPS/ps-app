// The day countdown at work (PS 1.70; the rules are core/daycount.ts). Two halves:
//  - dayView(): what any page draws (the Tab list countdown, the Priority 1 timers, the island part, the in-page card). Worked
//    out from the vault and the clock, never saved.
//  - startDayCount(): runs once in the page that holds the vault, and only there:
//      Mac PS: the card that comes out of the island ({type:"dayCard"}, ps-mac DayCountdown.swift): "End day now?" or
//              "You have 4h 12m left". Its answers come back as islandAction dayEnd and dayRem (src/island.ts).
//      Phone:  the plan ({type:"dayPlan"}: times and keys only) for the shell, which notifies by itself while PS is closed
//              (ps-gos DayEnd.kt). Its answers come back as {type:"dayAct"} (gos/bridge.ts).
//      Website and the phone's page: the card is drawn inside the page (views/DayCountdown.tsx DayCardHost).
//    Every answer is saved in the vault (settings.cdAns), so the card goes on every device.
// Nothing here reads or sends anything about 1Password or Signal.
import { vaultStore, type Snapshot } from "./core/vault";
import { settingsData } from "./core/select";
import { saveSettings } from "./core/actions";
import { feature } from "./core/features";
import { isRedAccount } from "./core/account";
import { DEVICE_TZ } from "./core/tz";
import { dndMutes } from "./core/dnd";
import { sleepState } from "./sleepmode/engine";
import type { Doc, Todo } from "./core/model";
import {
  CD_FEATURE, WORDS, answer, cdNow, cdZone, cleanAns, cleanCd, nextRemind, p1Deadline, remAck, remindDue,
  type CdAns, type CdNow, type CdPrefs,
} from "./core/daycount";

type Post = (m: object) => void;
type Where = "mac" | "phone" | "web";
const SINCE_STORE = "ps-cd-since";

let memSince = 0;
/** When this device first ran the countdown (ms). An end of day before that never asks. */
function since(now: number): number {
  try {
    const v = Number(localStorage.getItem(SINCE_STORE));
    if (Number.isFinite(v) && v > 0) return v;
    localStorage.setItem(SINCE_STORE, String(now));
  } catch { /* storage blocked: this run's memory */ }
  if (!memSince) memSince = now;
  return memSince;
}

export interface DayView {
  /** The feature and the switch are on, and the vault is open for its owner. */
  on: boolean;
  prefs: CdPrefs;
  tz: string;
  st: CdNow;
  ans: CdAns;
  /** The reminder due now (its time, ms), or null. Held under Do Not Disturb and Sleep mode. */
  rem: number | null;
  /** "12:00": the end of day the countdown runs to, in its zone. */
  endHm: string;
}

/** Is the countdown on for this vault? */
export function dayOn(s: Snapshot): boolean {
  return s.status === "unlocked" && s.role === "owner" && feature(CD_FEATURE) && cleanCd(settingsData(s).countdown).on;
}
export function dayPrefs(s: Snapshot): CdPrefs { return cleanCd(settingsData(s).countdown); }

const hmFmt = new Map<string, Intl.DateTimeFormat>();
function hmIn(ts: number, tz: string): string {
  let f = hmFmt.get(tz);
  if (!f) { try { f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } catch { f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } hmFmt.set(tz, f); }
  return f.format(ts);
}

export function dayView(s: Snapshot, now: number, where: Where = "web"): DayView {
  const prefs = dayPrefs(s);
  const st0 = settingsData(s);
  const tz = cdZone(prefs, isRedAccount(s), DEVICE_TZ);
  const ans = cleanAns(st0.cdAns);
  const on = dayOn(s);
  const sn = since(now);
  const st = on ? cdNow(prefs, ans, tz, now, sn) : { target: null, asking: false, endKey: null, snoozed: false };
  const held = dndMutes(st0.dnd, "island", now, where) || sleepState().here;
  const rem = on && !held ? remindDue(prefs, st, ans, tz, now, sn) : null;
  return { on, prefs, tz, st, ans, rem, endHm: st.target ? hmIn(st.endKey ? Date.parse(st.endKey) : st.target, tz) : prefs.at };
}

// ---------- answers (from any device, any page) ----------
let saving: Promise<void> = Promise.resolve();
/** "Yes" or "15 more mins" (Esc too) for the end of day `key` (ISO). Only the end being asked about now is answered. */
export function dayAnswer(act: "yes" | "snooze", key?: string | null) {
  const s = vaultStore.get();
  if (!dayOn(s)) return;
  const now = Date.now();
  const v = dayView(s, now);
  const end = v.st.endKey;
  if (!end || (key && key !== end)) return;
  if (act === "snooze" && !v.st.asking) return;   // a snooze only from the card that is up
  saving = saving.then(() => saveSettings({ cdAns: answer(v.ans, end, act, now) })).catch(() => {});
  wake();
}
/** "Acknowledged" on a reminder: `slot` (ISO) or the one due now. */
export function dayRemAck(slot?: string | null) {
  const s = vaultStore.get();
  if (!dayOn(s)) return;
  const v = dayView(s, Date.now());
  const at = slot ? Date.parse(slot) : v.rem ?? NaN;
  if (!Number.isFinite(at)) return;
  if (v.ans.rem && Date.parse(v.ans.rem) >= at) return;
  saving = saving.then(() => saveSettings({ cdAns: remAck(v.ans, at) })).catch(() => {});
  wake();
}
/** From the Mac's island: {type:"islandAction", action:"dayEnd"|"dayRem", id}. id: "yes|<iso>", "snooze|<iso>" or the reminder's ISO. */
export function dayIslandAction(action: string, id: unknown) {
  const v = typeof id === "string" ? id.slice(0, 80) : "";
  if (action === "dayEnd") {
    const [act, key] = v.split("|");
    if (act === "yes" || act === "snooze") dayAnswer(act, key || null);
  } else if (action === "dayRem") dayRemAck(v || null);
}
/** Answers from the phone's notifications that came while the vault was still locked: saved once it opens (like the gym's Yes). */
let waitingActs: { act?: unknown; key?: unknown }[] = [];
/** From the phone's shell: {type:"dayAct", act:"yes"|"snooze"|"ack", key}. */
export function dayShellMessage(m: { act?: unknown; key?: unknown }) {
  const s = vaultStore.get();
  if (s.status !== "unlocked") { if (waitingActs.length < 10) waitingActs.push({ act: m.act, key: m.key }); return; }
  const key = typeof m.key === "string" ? m.key.slice(0, 40) : null;
  if (m.act === "yes" || m.act === "snooze") dayAnswer(m.act, key);
  else if (m.act === "ack") dayRemAck(key);
}

// ---------- the island's part (src/island.ts adds it to the island state) ----------
/** The countdown inside the island's task area: its end (ms), at zero, and the shown task's own Priority 1 timer. */
export function dayIsland(s: Snapshot, taskId: string | null | undefined, now: number): { end: number | null; zero: boolean; p1: number | null; lively: boolean; color: string } | null {
  if (s.status !== "unlocked" || s.role !== "owner" || !feature(CD_FEATURE)) return null;
  const v = dayView(s, now, "mac");
  if (!(v.on && v.prefs.island) && !v.prefs.p1) return null;
  let p1: number | null = null;
  if (v.prefs.p1 && taskId) {
    const d = s.docs.get(taskId) as Doc<Todo> | undefined;
    if (d?.kind === "todo" && d.data) p1 = p1Deadline(d.data, now);
  }
  const end = v.on && v.prefs.island ? v.st.target : null;
  if (end === null && p1 === null) return null;
  return { end, zero: end !== null && v.st.asking, p1, lively: v.prefs.lively, color: /^#[0-9a-f]{6}$/.test(v.prefs.color) ? v.prefs.color : "" };
}

// ---------- the engine ----------
type Card = { kind: "end"; key: string; title: string; yes: string; snooze: string } | { kind: "rem"; key: string; end: number; title: string; ack: string } | null;
const listeners = new Set<() => void>();
let cardNow: Card = null;
/** The card to draw inside the page (website, phone): null when none, or on the Mac (the island draws it). */
export const dayCardStore = {
  subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; },
  get: () => cardNow,
};
let wakeFn: () => void = () => {};
function wake() { window.setTimeout(() => wakeFn(), 0); }

export function cardOf(v: DayView, now: number): Card {
  if (!v.on) return null;
  if (v.st.asking && v.st.endKey) return { kind: "end", key: v.st.endKey, title: WORDS.endAsk, yes: WORDS.yes, snooze: WORDS.snooze };
  if (v.rem !== null && v.st.target !== null) return { kind: "rem", key: new Date(v.rem).toISOString(), end: v.st.target, title: WORDS.remind(v.st.target - now), ack: WORDS.ack };
  return null;
}
/** The phone shell's plan: times and keys only, never a task. */
export function planOf(v: DayView, now: number) {
  if (!v.on) return { on: false };
  const st = v.st;
  const ask = st.asking && st.endKey ? { at: Date.parse(st.endKey), key: st.endKey }
    : st.snoozed && st.endKey && st.target ? { at: st.target, key: st.endKey }
    : st.target ? { at: st.target, key: new Date(st.target).toISOString() } : null;
  const remAt = v.rem ?? nextRemind(v.prefs, st, now);
  const rem = remAt !== null && st.target !== null && !st.asking && !st.snoozed ? { at: remAt, end: st.target, key: new Date(remAt).toISOString() } : null;
  return { on: true, ask, rem, yes: v.ans.yes ? v.ans.end ?? null : null, remDone: v.ans.rem ?? null, words: { ask: WORDS.endAsk, yes: WORDS.yes, snooze: WORDS.snooze, ack: WORDS.ack } };
}

/** The page that holds the vault, once. where: "mac" posts cards to the Mac, "phone" posts the plan to the shell, "web" draws them. */
let engineOn = false;
/** The website (not PS, not the phone app): the card is drawn inside the page; started by the Tab list the first time it shows. */
export function ensureDayEngine() {
  if (import.meta.env.MODE === "ps" || import.meta.env.MODE === "gos") return;
  startDayCount(null, "web");
}
export function startDayCount(post: Post | null, where: Where) {
  if (engineOn) return;
  engineOn = true;
  let timer = 0, last = "", lastPlan = "";
  const run = () => {
    window.clearTimeout(timer);
    const s = vaultStore.get();
    if (s.status === "unlocked" && waitingActs.length) { const w = waitingActs; waitingActs = []; w.forEach(dayShellMessage); }
    const now = Date.now();
    const v = dayView(s, now, where);
    const card = cardOf(v, now);
    const json = JSON.stringify(card && card.kind === "rem" ? { ...card, title: "" } : card);   // the reminder's words move each minute; only a new one counts
    if (json !== last) {
      last = json;
      if (where === "mac" && post) post({ type: "dayCard", card });
      if (where !== "mac") { cardNow = card; listeners.forEach((f) => f()); }
    }
    if (where === "phone" && post) {
      const plan = planOf(v, now);
      const pj = JSON.stringify(plan);
      if (pj !== lastPlan) { lastPlan = pj; post({ type: "dayPlan", plan }); }
    }
    // Next look: the next moment anything can change (zero, a snooze ending, the next reminder), and at least each minute.
    const nexts = [v.st.target, nextRemind(v.prefs, v.st, now)].filter((x): x is number => typeof x === "number" && x > now).map((x) => x - now + 50);
    timer = window.setTimeout(run, Math.max(500, Math.min(60_000, ...nexts)));
  };
  wakeFn = run;
  let t = 0;
  vaultStore.subscribe(() => { window.clearTimeout(t); t = window.setTimeout(run, 250); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") run(); });
  window.addEventListener("focus", run);
  // The Mac's native side restarted: it hears the card again within a minute.
  if (where === "mac" && post) window.setInterval(() => { const s = vaultStore.get(); const v = dayView(s, Date.now(), where); post({ type: "dayCard", card: cardOf(v, Date.now()) }); }, 60_000);
  run();
}
