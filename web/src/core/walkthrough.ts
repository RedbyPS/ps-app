// "What is new" walkthrough (V1.58, the developer 13 Nov 2026): "when you actually update to 1.58 I want it to come up like the
// little tutorials like we did last time ... Just make sure people actually know what's going on."
//
// One short walkthrough per version (Next, Next, Done), in the same small card as the first use tips and the V1.56
// pop-ups, at the bottom of the Tab list, pointing at the real thing on screen where it can (the Pomodoro button).
// Always skippable: Skip or Esc ends it, and every step it had counts as seen.
//
// Rules (all pure, no DOM, no vault, no clock: tests/walkthrough.test.ts runs them; views/Walkthrough.tsx draws them):
//  - each step shows at most once per person (settings.walkSeen, synced, merged across devices). A step counts as seen
//    when Next, Show me, Skip, Done or Esc is used, or once it has been up WALK.seenAfterMs (time to read it). Taken
//    away sooner (the list hides, a meeting starts, a menu opens) it comes back, at that same step, another calm time;
//  - Mac app only (the island, Tab over 1Password and Signal and the Pomodoro button all live there). The website and
//    the phone never show it and never mark it seen, so a person who opens the website first still gets it on the Mac;
//  - the friends only step (Tab and the island over 1Password and Signal) never shows where the Mac says the list does
//    not open over them (PS 1.71: per BUILD, so never in the developer's own build and on every account in the G Squad build);
//    an older Mac that does not say falls back to the account (never on the developer's);
//  - it starts after What's new (or the "Updated to" card) has been up and closed on this device. A brand new install has
//    no What's new, so it waits until the first use tips have finished (same gate as the V1.56 pop-ups);
//  - never two at once: it waits while a first use tip or a V1.56 pop-up shows, and those wait for it. It uses the same
//    quiet rules as the tips (core/tips.ts blocker: meeting, Sleep mode, Sentry mode, Do Not Disturb, any screen or
//    menu, What's new, typing, 1Password or Signal in front, the list not calm for a few seconds);
//  - Settings, About and updates, "Show first use tips" Off silences it too.
// The words are in core/walkwords.ts.
import type { Blocker } from "./tips.ts";

/** Steps are named by version, so a later version's walkthrough never collides with this one. */
export type WalkStepId = "158-menu" | "158-settings" | "158-topbar" | "158-pomodoro" | "158-standup" | "158-meeting" | "158-ai" | "158-protected";

export interface WalkStep {
  id: WalkStepId;
  /** CSS selector of the thing in the Tab list it points at (a ring and an arrow). None: the card rests at the bottom middle. */
  target?: string;
  /** "Show me" opens Settings on this group (core/settingsindex.ts GroupId). Only shown when that group exists in this build. */
  settings?: string;
  /** With `settings`: the row to land on in that group (a core/settingsindex.ts setting id). */
  jump?: string;
  /** The little picture in the card. */
  picture: "menu" | "settings" | "topbar" | "pomodoro" | "standup" | "meeting" | "ai" | "protected";
  /** Only where the list opens over 1Password and Signal: never in the developer's own build (PS 1.71: per build). */
  notRed?: boolean;
}

/** The V1.58 walkthrough, in order. Targets and Settings groups follow the build chats' names (v158-tips.md). */
export const WALK_158: readonly WalkStep[] = [
  { id: "158-menu", picture: "menu" },
  { id: "158-settings", picture: "settings", settings: "island" },
  { id: "158-topbar", picture: "topbar" },
  { id: "158-pomodoro", picture: "pomodoro", target: ".pm-tab-btn", settings: "pomodoro" },
  { id: "158-standup", picture: "standup", settings: "standup" },
  { id: "158-meeting", picture: "meeting", settings: "notify", jump: "meet-bubble" },
  { id: "158-ai", picture: "ai", settings: "api", jump: "api-connect" },
  { id: "158-protected", picture: "protected", notRed: true },
];
/** The walkthrough this build shows (the newest version's). */
export const WALK: readonly WalkStep[] = WALK_158;
export const WALK_IDS: readonly WalkStepId[] = WALK.map((s) => s.id);

export const WALK_TIMES = {
  /** A step counts as seen once it has been up this long (time to read it), even with no button pressed. */
  seenAfterMs: 12_000,
} as const;

export const isWalkStepId = (v: unknown): v is WalkStepId => typeof v === "string" && (WALK_IDS as readonly string[]).includes(v);

// ---------- what is saved (synced) ----------
/** settings.walkSeen: when each step was seen (ISO). */
export interface WalkSeen { at: Partial<Record<WalkStepId, string>> }
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;
const okIso = (v: unknown): v is string => typeof v === "string" && v.length <= 32 && ISO.test(v) && Number.isFinite(Date.parse(v));

export function cleanWalkSeen(v: unknown): WalkSeen {
  const o = (v && typeof v === "object" ? v : {}) as { at?: unknown };
  const at: WalkSeen["at"] = {};
  if (o.at && typeof o.at === "object") for (const id of WALK_IDS) { const t = (o.at as Record<string, unknown>)[id]; if (okIso(t)) at[id] = t; }
  return { at };
}
export const stepSeen = (s: WalkSeen | null | undefined, id: WalkStepId): boolean => !!s?.at?.[id];
/** Mark steps seen (an earlier time stays). */
export function markWalkSeen(cur: WalkSeen | null | undefined, ids: readonly WalkStepId[], now: number): WalkSeen {
  const c = cleanWalkSeen(cur);
  const at = { ...c.at };
  for (const id of ids) at[id] = at[id] ?? new Date(now).toISOString();
  return { at };
}
/** Two devices' copies: a step seen on either counts, so a second device never repeats it. */
export function mergeWalkSeen(a: unknown, b: unknown): WalkSeen {
  const x = cleanWalkSeen(a), y = cleanWalkSeen(b);
  const at: WalkSeen["at"] = {};
  for (const id of WALK_IDS) { const c = [x.at[id], y.at[id]].filter((t): t is string => !!t).sort()[0]; if (c) at[id] = c; }
  return { at };
}

// ---------- which steps, which one now ----------
export interface WalkFacts {
  seen: WalkSeen | null | undefined;
  /** The synced settings have arrived (never decide from the copy before the first download). */
  synced: boolean;
  /** An owner's own account (a shared helper view never gets it). */
  owner: boolean;
  /** This is the Mac app (PS). */
  mac: boolean;
  /** The developer's own account (core/account.ts isRedAccount). */
  red: boolean;
  /** The Mac says the list opens over 1Password and Signal in this build (PS 1.71: per build, before it per account;
   *  null: an older Mac that does not say). */
  overProtected: boolean | null;
  /** Steps whose feature the person switched off themselves (the Pomodoro button off): nothing to point at. */
  off: Partial<Record<WalkStepId, boolean>>;
  /** Settings, About and updates, "Show first use tips" is not Off. */
  enabled: boolean;
  /** What's new closed on this device, or (a brand new install) the first use tips finished. */
  gateOpen: boolean;
  /** A first use tip or a V1.56 pop-up is showing. */
  otherShowing: boolean;
  /** The first thing in the way (core/tips.ts blocker), or null. */
  block: Blocker | null;
}

/** Does this step belong in this person's walkthrough on this device? */
export function stepApplies(f: Pick<WalkFacts, "mac" | "red" | "overProtected" | "off">, s: WalkStep): boolean {
  if (!f.mac) return false;
  if (f.off[s.id]) return false;
  // PS 1.71: the Mac's answer is the BUILD's (G Squad on, the developer's own build off, whoever is signed in); only an older Mac
  // that does not say falls back to the account.
  if (s.notRed && (f.overProtected === false || (f.overProtected === null && f.red))) return false;
  return true;
}
/** Every step of this person's walkthrough, seen or not, in order (the "2 of 6" counts these). */
export const stepsFor = (f: Pick<WalkFacts, "mac" | "red" | "overProtected" | "off">): WalkStep[] => WALK.filter((s) => stepApplies(f, s));
/** The steps still to see, in order. */
export const stepsLeft = (f: Pick<WalkFacts, "mac" | "red" | "overProtected" | "off" | "seen">): WalkStep[] => stepsFor(f).filter((s) => !stepSeen(f.seen, s.id));

/** May the walkthrough show now? Ready means every rule but the moment: synced, owner, on, past the gate, steps left. */
export function walkReady(f: WalkFacts): boolean {
  return f.synced && f.owner && f.enabled && f.gateOpen && stepsLeft(f).length > 0;
}
/** The step to put up now, or null. */
export function nextStep(f: WalkFacts): WalkStep | null {
  if (!walkReady(f) || f.block || f.otherShowing) return null;
  return stepsLeft(f)[0] ?? null;
}
/** "n of total" for a step: its place among every step this person has. */
export function stepCount(f: Pick<WalkFacts, "mac" | "red" | "overProtected" | "off">, id: WalkStepId): { n: number; total: number } {
  const all = stepsFor(f);
  return { n: all.findIndex((s) => s.id === id) + 1, total: all.length };
}
/** Is this step the last one still to see? Only the steps after it count (its main button then says Done). */
export function isLast(f: Pick<WalkFacts, "mac" | "red" | "overProtected" | "off" | "seen">, id: WalkStepId): boolean {
  const all = stepsFor(f);
  const at = all.findIndex((s) => s.id === id);
  return !all.slice(at + 1).some((s) => !stepSeen(f.seen, s.id));
}
/** The next step after this one still to see, or null (Next shows it at once). */
export function stepAfter(f: Pick<WalkFacts, "mac" | "red" | "overProtected" | "off" | "seen">, id: WalkStepId): WalkStep | null {
  const all = stepsFor(f);
  const at = all.findIndex((s) => s.id === id);
  return all.slice(at + 1).find((s) => !stepSeen(f.seen, s.id)) ?? null;
}
/** Skip or Esc: every step this person has counts as seen. */
export const skipAll = (f: Pick<WalkFacts, "mac" | "red" | "overProtected" | "off">): WalkStepId[] => stepsFor(f).map((s) => s.id);

/** The words with the app's name and the count filled in. */
export const fillWalk = (s: string, o: { app?: string; n?: number; total?: number }): string =>
  s.replace(/\{app\}/g, o.app ?? "PS app").replace(/\{n\}/g, String(o.n ?? "")).replace(/\{total\}/g, String(o.total ?? ""));
