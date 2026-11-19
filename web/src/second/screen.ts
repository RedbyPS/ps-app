// The remote screen's state as the Mac tells it (ps-mac RemoteScreen.sendState): window.__psScreen({on, live, open, state}).
// Used by the Tab list's Remote screen switch (views/ScreenSwitch.tsx). PS on a Mac only; elsewhere it stays off.
import { PS, psPost } from "../ps";

export type ScreenState = { on: boolean; live: boolean; open: boolean; state: string };
let st: ScreenState = { on: false, live: false, open: false, state: "off" };
const subs = new Set<() => void>();
let asked = false;

export const screenStore = {
  get: (): ScreenState => st,
  subscribe(f: () => void): () => void {
    subs.add(f);
    if (PS && !asked) { asked = true; psPost({ type: "screen:get" }); }   // the first reader asks the Mac once
    return () => { subs.delete(f); };
  },
};

/** The Mac's message, checked: only these four fields, of these types. */
export function setScreenState(o: unknown): void {
  if (!o || typeof o !== "object") return;
  const x = o as Record<string, unknown>;
  const next: ScreenState = { on: x.on === true, live: x.live === true, open: x.open === true, state: typeof x.state === "string" ? x.state.slice(0, 120) : "" };
  if (JSON.stringify(next) === JSON.stringify(st)) return;
  st = next;
  subs.forEach((f) => f());
}

declare global { interface Window { __psScreen?: (o: unknown) => void } }
if (typeof window !== "undefined") window.__psScreen = setScreenState;
