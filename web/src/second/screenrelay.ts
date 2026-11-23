// Remote screen, From anywhere (PS 1.77): the relay key's state on this Mac, as the Mac tells it
// (ps-mac RemoteScreen.relayState: window.__psScreenRelay({ready, saved?})). The key typed in Settings goes straight to the
// Mac ({type: "screenRelayKey", key}), which keeps it with Second Computer's keys; the page never keeps it or shows it again.
import { PS, psPost } from "../ps";

export type RelayState = { ready: boolean; key: boolean; last: "saved" | "bad" | "removed" | null };
let st: RelayState = { ready: false, key: false, last: null };
const subs = new Set<() => void>();

export const relayStore = {
  get: (): RelayState => st,
  subscribe(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; },
};

/** The Mac's message, checked: booleans only. */
export function setRelayState(o: unknown): void {
  if (!o || typeof o !== "object") return;
  const x = o as Record<string, unknown>;
  const last = x.saved === true ? "saved" : x.saved === false ? "bad" : x.removed === true ? "removed" : st.last;
  st = { ready: x.ready === true, key: x.key === true, last };
  subs.forEach((f) => f());
}
export function askRelay(): void { if (PS) psPost({ type: "screenRelay:get" }); }
/** Hands the key to the Mac at once ("" removes it). */
export function sendRelayKey(key: string): void { if (PS) psPost({ type: "screenRelayKey", key }); }

declare global { interface Window { __psScreenRelay?: (o: unknown) => void } }
if (typeof window !== "undefined") window.__psScreenRelay = setRelayState;
