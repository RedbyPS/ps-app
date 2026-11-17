// Two switches for this phone only (PS 1.66): the island drawn inside PS and the round Add task button. Both on by default.
// Kept on this device (each phone and each iPhone web app chooses for itself), so no shell change and nothing synced.
import { useSyncExternalStore } from "react";

export type PhonePrefKey = "island" | "addButton";
const KEY: Record<PhonePrefKey, string> = { island: "ps.phone.inAppIsland", addButton: "ps.phone.addButton" };
const subs = new Set<() => void>();
const cache: Partial<Record<PhonePrefKey, boolean>> = {};

/** On unless this phone switched it off. Storage that throws (private mode) counts as on. */
export function phonePref(k: PhonePrefKey): boolean {
  if (k in cache) return cache[k]!;
  let on = true;
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
