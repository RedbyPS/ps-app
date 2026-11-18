// Switches for this phone only (PS 1.66): the island drawn inside PS and the round Add task button. PS 1.67: the wheel menu
// (gos/PhoneWheel.tsx; off brings back the hamburger at the top left). All on by default.
// Kept on this device (each phone and each iPhone web app chooses for itself), so no shell change and nothing synced.
import { useSyncExternalStore } from "react";
import { phoneIslandOnce } from "../core/islandon";

export type PhonePrefKey = "island" | "addButton" | "wheel";
const KEY: Record<PhonePrefKey, string> = { island: "ps.phone.inAppIsland", addButton: "ps.phone.addButton", wheel: "ps.phone.wheel" };
const subs = new Set<() => void>();
const cache: Partial<Record<PhonePrefKey, boolean>> = {};

/** On unless this phone switched it off. Storage that throws (private mode) counts as on. */
export function phonePref(k: PhonePrefKey): boolean {
  if (k in cache) return cache[k]!;
  let on = true;
  // PS 1.67, once per phone: an Island inside PS switched off here goes back on (core/islandon.ts); a later Off stays off.
  if (k === "island") { try { phoneIslandOnce(localStorage); } catch { /* storage off: nothing to turn back on */ } }
  try { on = localStorage.getItem(KEY[k]) !== "off"; } catch { /* storage off: the default */ }
  cache[k] = on;
  return on;
}
export function setPhonePref(k: PhonePrefKey, on: boolean) {
  cache[k] = on;
  try { if (on) localStorage.removeItem(KEY[k]); else localStorage.setItem(KEY[k], "off"); } catch { /* storage off: this run only */ }
  subs.forEach((f) => f());
}
export function usePhonePref(k: PhonePrefKey): boolean {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => phonePref(k), () => true);
}
