// Just tomorrow (PS 1.65), the part with a clock and the shells. Rules: core/alarmonce.ts.
// - Settings and the web sleep screen ask this device's owner first: a Mac asks Touch ID or its password (ps-mac SleepScreen.swift,
//   {type:"sleep:auth"}), the phone its own unlock (ps-gos Sleep.kt, the same message), a browser cannot ask, so it changes nothing.
// - The Mac's and the phone's sleep screens ask on their own and send the choice already passed ({once} / {type:"sleep:once"}).
// The override is saved with the Sleep mode settings, so the person's own sync carries it to every device and each one builds its
// rings from it (sleepmode/engine.ts). Nothing is sent to anyone else.
import { useSyncExternalStore } from "react";
import { vaultStore } from "../core/vault";
import { settingsData } from "../core/select";
import { saveSettings } from "../core/actions";
import { feature } from "../core/features";
import { psPost } from "../ps";
import { gosPost } from "../gos/bridge";
import { prefsOf, sleepModeOf } from "../core/sleepmode";
import { ONCE_FEATURE, ONCE_NOTES, onceChoose, onceSpent, onceView, onceWords, withOwner, type Authenticator, type OnceChoice, type OwnerAnswer } from "../core/alarmonce";
import type { Settings } from "../core/model";

export const onceOn = (): boolean => feature("alarm-once");
const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
export const onceTz = localTz;

// ---------- asking the owner (Touch ID, the Mac password, the phone's unlock) ----------
const waiting = new Map<string, { done: (a: OwnerAnswer) => void; timer: number }>();
let seq = 0;
/** The shell's answer to {type:"sleep:auth"} (sleepmode/engine.ts fromMac and fromPhone hand it here). */
export function onceAuthAnswer(id: unknown, ok: unknown, none?: unknown) {
  if (typeof id !== "string") return;
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  window.clearTimeout(w.timer);
  w.done(ok === true ? "ok" : none === true ? "none" : "no");
}
/** This device's authenticator: `where` is sleepmode/engine.ts WHERE. A shell that never answers (an older PS) is "old" after 90 s. */
export function shellAuth(where: "mac" | "phone" | "web"): Authenticator {
  return (reason) => new Promise<OwnerAnswer>((done) => {
    if (where === "web") { done("none"); return; }
    const id = `o${Date.now().toString(36)}${(seq++).toString(36)}`;
    const timer = window.setTimeout(() => { if (waiting.delete(id)) done("old"); }, 90_000);
    waiting.set(id, { done, timer });
    (where === "mac" ? psPost : gosPost)({ type: "sleep:auth", id, reason: reason.slice(0, 80) });
  });
}

// ---------- saving ----------
function current() {
  const s = vaultStore.get();
  return s.status === "unlocked" ? sleepModeOf(settingsData(s)) : null;
}
/** Applies a choice that has already passed the owner check. Returns a note for the screen, or null when saved. */
export async function applyOnce(choice: OnceChoice, now = Date.now()): Promise<string | null> {
  const p = current();
  if (!p) return ONCE_NOTES.no;
  const next = onceChoose(p.alarms, p.once, now, localTz(), choice);
  if (next === "none") return ONCE_NOTES.noAlarm;
  if (next === "past") return ONCE_NOTES.past;
  if (next === "far") return ONCE_NOTES.far;
  await saveSettings({ sleepMode: prefsOf({ ...p, once: next }) } as Partial<Settings>);
  bump();
  return null;
}
/** A choice from Settings or the web screen: the owner check first, then the save. Null when saved, else the note to show. */
export async function changeOnce(choice: OnceChoice, auth: Authenticator, now = Date.now()): Promise<string | null> {
  const p = current();
  const v = p ? onceView(p.alarms, p.once, now, localTz()) : null;
  if (!v) return ONCE_NOTES.noAlarm;
  const w = onceWords(v.day);
  const r = await withOwner(auth, choice.kind === "undo" ? w.undoReason : w.reason, () => applyOnce(choice));
  return r.ok ? r.value : ONCE_NOTES[r.why];
}
/** A choice the Mac or phone screen already checked with its own Touch ID or unlock. Anything malformed is dropped. */
export function onceFromShell(m: unknown) {
  if (!onceOn() || !m || typeof m !== "object") return;
  const o = m as Record<string, unknown>;
  const c: OnceChoice | null = o.act === "skip" ? { kind: "skip" } : o.act === "undo" ? { kind: "undo" }
    : o.act === "later" && Number.isFinite(Number(o.mins)) ? { kind: "later", mins: Number(o.mins) }
    : o.act === "pick" && typeof o.at === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.at) ? { kind: "pick", at: o.at } : null;
  if (c) void applyOnce(c).catch(() => {});
}
/** Clears a spent override (its morning is over), once, from the device that notices first. */
let clearing = false;
export function clearSpentOnce(now = Date.now()) {
  const p = current();
  if (!p || !p.once || clearing || !onceSpent(p.alarms, p.once, now, localTz())) return;
  clearing = true;
  void saveSettings({ sleepMode: prefsOf({ ...p, once: null }) } as Partial<Settings>).catch(() => {}).finally(() => { clearing = false; bump(); });
}

/** The Later row is open somewhere: Settings, Sleep mode lets it take Esc first (one Esc, one layer). */
let rows = 0;
export const onceRowOpen = () => rows > 0;
export function holdOnceRow(): () => void { rows++; let done = false; return () => { if (!done) { done = true; rows--; } }; }

// a small tick for the screens (the line changes on its own at the morning's end)
let n = 0;
const subs = new Set<() => void>();
function bump() { n++; subs.forEach((f) => f()); }
export function useOnceBump(): number { return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => n); }
