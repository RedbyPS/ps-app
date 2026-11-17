// Feature intros (PS 1.60, the developer 14 Nov 2026: "every future release introduces its big new features from the island").
// A small LIST of intros (INTROS below) and the rules for when one may show. Pure rules only (no React, no DOM, no clock of its
// own), so tests/featureintro.test.ts checks every rule. The one piece that draws them is views/FeatureIntro.tsx; the Mac's
// island part (the squeeze and the chime) is Sources/IslandIntroCore.swift and SetupIsland.intro.
//
// ADD THE NEXT INTRO = add one entry to INTROS. Nothing else (docs/feature-intros.md says how).
//
import { cleanAnchor, cleanVersion, cmpVersion, type IslandAnchor } from "./whatsnew.ts";
import { SR_INTRO } from "./screenrecmeet.ts";
import { PROTON_WORDS } from "./protonmail.ts";
import { ASSIST_WORDS } from "./assist.ts";
import { TOUR_FOLDS, TOUR_ID, TOUR_WORDS } from "./tour.ts";
import { APPROVE_INTRO, APPROVE_PICKS } from "./autoapprove.ts";
import { AM_WORDS } from "./activitymon.ts";
import { JOIN_ASK_ID, JOIN_ASK_WORDS } from "./gsquadjoin.ts";

// The rules (all in nextIntro):
//  - Not right after an update: only after about 1 minute of ACTIVE use of the to do list on this version (idle time does not
//    count, see addActive).
//  - Only when nothing else is on the island, and never in Sleep mode, Sentry mode, Do Not Disturb, while sharing the screen or
//    over a full screen app. When it cannot show it waits for the next free moment (the answer says why).
//  - Only to people the intro still applies to (for WhatsApp: not linked yet). Once they did it, never again.
//  - "Later" (or Esc) asks once more 3 days later, then never. "Show me" is the end of it: the guide stays in Settings.
//  - One intro at a time, at least one day after the last one.

/** One feature intro: its words, its mark, and what "Show me" opens. */
export interface IntroDef {
  /** Never reused or renamed (the saved record is keyed by it). */
  id: string;
  /** The first line the island says. */
  headline: string;
  /** The question, with the two buttons. Left out for an `ack` intro. */
  ask?: string;
  show: string;
  later?: string;
  /** Which picture swoops in (views/FeatureIntro.tsx MARKS). */
  mark: "whatsapp" | "spark" | "record" | "logo" | "shield";
  /** V1.62: a one button notice ("Ok"): no question, no Later, no guide. Ok (or Esc, or Back) ends it for good, and it is saved
   *  with the person's settings (introsDone), so it shows once per person, not once per device. */
  ack?: true;
  /** V1.62: only for people who ran PS before this build (an update, never a first install). views/FeatureIntro.tsx asks
   *  updaterAnswer below; any doubt means it does not show. */
  updatersOnly?: true;
  /** PS 1.63: a question with two answers (`show` is Yes, `later` is No). Both answers end it for good, nothing opens, and what the
   *  answer does is in views/FeatureIntro.tsx CHOICES. Esc, Back and a page that goes away are no answer: it asks once more later. */
  choice?: true;
  /** PS 1.65: the "where things live" tour (core/tour.ts). It starts like any intro (a minute of use, the island free, no meeting) but is
   *  not held back by the one day gap, comes back until it is finished (Done, or Esc, which ends it for good) and is saved with the
   *  person's settings (introsDone), so it shows once per person. Its steps are drawn by views/FeatureIntro.tsx. */
  tour?: true;
  /** PS 1.65: small switches on a `choice` card the person can untick before answering (id and label each). "Keep it on" keeps the
   *  ticked ones and "Turn off" turns every one off (views/FeatureIntro.tsx CHOICES gets the kept ids). Never take focus. */
  picks?: { id: string; label: string }[];
  /** What "Show me" opens (views/FeatureIntro.tsx GUIDES). Without one, `steps` are shown in a small generic guide. */
  guide?: "wa-link";
  /** A few plain steps for the generic guide (one short sentence each). */
  steps?: string[];
  /** A link to a demo or a page about it (opened from the generic guide). */
  demo?: string;
  /** Where the guide stays reachable for good (not for an `ack` intro). */
  settings?: string;
}

export const INTROS: IntroDef[] = [
  {
    // V1.62 (the developer, 15 Nov 2026): "about a minute later when you download 1.62, the dynamic island expands out with the new app logo
    // and shows 'New app logo' ... only to people that are updating from a previous version. Then you can click 'Ok' on it."
    // First in the list, so an updater sees it after the first minute of use even when an older intro is still waiting.
    id: "new-logo-162",
    headline: "New app logo",
    show: "Ok",
    mark: "logo",
    ack: true,
    updatersOnly: true,
  },
  {
    // PS 1.65 (the developer's friend, 17 Nov 2026): one short tour of where the new things live, after about a minute of use. It replaces
    // the separate intros in TOUR_FOLDS (receipts, posture-165, checklist-165, notif-stack-165). Updaters only.
    id: TOUR_ID,
    headline: TOUR_WORDS.head,
    show: TOUR_WORDS.next,
    mark: "spark",
    tour: true,
    choice: true,   // a one button card that takes no focus and opens no guide (views/FeatureIntro.tsx)
    updatersOnly: true,
  },
  {
    // PS 1.66 (the developer, 17 Nov 2026): once after updating, people not in The G Squad and not waiting to be let in are asked to join
    // (core/gsquadjoin.ts). Join sends the normal Ask to join; Not now ends it for good on every device. Never the developer's account.
    id: JOIN_ASK_ID,
    headline: JOIN_ASK_WORDS.headline,
    ask: JOIN_ASK_WORDS.ask,
    show: JOIN_ASK_WORDS.join,
    later: JOIN_ASK_WORDS.notNow,
    mark: "spark",
    choice: true,
    updatersOnly: true,
  },
  {
    id: "whatsapp",
    headline: "WhatsApp messages now supported",
    ask: "Did you know you can link WhatsApp?",
    show: "Show me",
    later: "Later",
    mark: "whatsapp",
    guide: "wa-link",
    settings: "Settings, WhatsApp settings, Link WhatsApp",
  },
  {
    // PS 1.63 (the developer's friend, 15 Nov 2026): P1 sharing is on by default (opt out). Everyone gets this same notice once they are
    // in a squad (views/FeatureIntro.tsx DONE_PROBES, core/squadp1.ts p1Default). Turn off saves it off for good. No button takes focus.
    id: "squad-p1",
    headline: "Priority 1 with your squad",
    ask: "Your Priority 1 tasks now show to your squad. Hide any task from it, or turn this off.",
    show: "Keep it on",
    later: "Turn off",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.64 (the developer approved these exact words, 16 Nov 2026): G Squad replies and the members list. One Ok ends it for good
    // (a `choice` with one button: nothing opens). Only for people in a squad (views/FeatureIntro.tsx DONE_PROBES).
    id: "gsquad-reply-164",
    headline: "New in G Squad: reply to any message and see who is online.",
    ask: "Hover over a message and click Reply, or click the people at the top.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 Activity monitor (core/activitymon.ts AM_WORDS.intro; words for the owner to approve). Mac only, folded into the 1.65 tour
    // (core/tour.ts TOUR_FOLDS): one Ok ends it for good (a `choice` with one button: nothing opens).
    id: "activity-monitor-165",
    headline: AM_WORDS.intro.headline,
    ask: AM_WORDS.intro.ask,
    show: AM_WORDS.intro.show,
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 G Squad v3 (words for the owner to approve): one Ok ends it for good (a `choice` with one button: nothing opens). Only for
    // people in a squad (views/FeatureIntro.tsx DONE_PROBES).
    id: "gsquad-v3-165",
    headline: "G Squad has a new look, a bigger window and profile pictures.",
    ask: "Pull a corner to resize it. Add your picture in Squad settings.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 G Squad pieces (words for the owner to approve): one Ok ends it for good (a `choice` with one button: nothing opens). Only for
    // people in a squad (views/FeatureIntro.tsx DONE_PROBES).
    id: "gsquad-pieces-165",
    headline: "G Squad now comes in pieces.",
    ask: "In Edit mode, add the chat, the leaderboard or who is working to any page.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 Receipts (words for the owner to approve): one Ok ends it for good (a `choice` with one button: nothing opens). Only while
    // Receipts is on and the person owns the vault (views/FeatureIntro.tsx DONE_PROBES).
    id: "receipts",
    headline: "New: scan receipts and see what you spend.",
    ask: "Scan a receipt with your phone. Then open Purchases in the Tab list.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 Posture reminder (words to be approved by the owner). One Ok ends it for good (a `choice` with one button).
    id: "posture-165",
    headline: "New: a posture reminder.",
    ask: "A stick figure pops up now and then to remind you to sit up straight. Change it in Settings, Posture Reminder.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 Checklist reminder (words wait for the developer's approval): one Ok ends it for good (a `choice` with one button).
    // Only while the feature is on (views/FeatureIntro.tsx DONE_PROBES).
    id: "checklist-165",
    headline: "New: Checklist Reminder",
    ask: "A pop-up nudges you when you have not ticked a task for a while. Change it in Settings, Checklist Reminder.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 stacked notifications (Mac only: the island's cards). One Ok ends it for good (a `choice` with one button: nothing opens).
    id: "notif-stack-165",
    headline: "New: notifications stack.",
    ask: "With more than one waiting you see the newest and a +number. Point at it to open the rest.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 G Squad v3 (words for the owner to approve): one Ok ends it for good. Only once the hub answers for DMs and the person is in a squad
    // (views/FeatureIntro.tsx DONE_PROBES).
    id: "gsquad-dm",
    headline: "New in G Squad: private messages, group chats and pictures.",
    ask: "Click a name at the top to send a private message.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 Auto approve on by default (the developer's friend, 17 Nov 2026; words wait for the owner's approval). About a minute in, one
    // calm notice on each Mac says what Auto approve now does, with a switch for AI mode and Sleep mode. Keep it on keeps the ticked
    // switches, Turn off turns them off on every one of the person's Macs (synced approveOff). The defaults count on a Mac only once
    // it was shown there. Only while a switch still has no choice on that Mac (views/FeatureIntro.tsx DONE_PROBES, PICKS_NOW).
    id: APPROVE_INTRO.id,
    headline: APPROVE_INTRO.headline,
    ask: APPROVE_INTRO.ask,
    show: APPROVE_INTRO.show,
    later: APPROVE_INTRO.later,
    mark: "shield",
    choice: true,
    picks: [...APPROVE_PICKS],
  },
  {
    // PS 1.65 Proton Mail through Bridge (core/protonmail.ts PROTON_WORDS.intro). Mac only: the probe in views/FeatureIntro.tsx never lets it
    // show anywhere else, and retires it once Bridge is linked. "Show me" opens the plain steps; they stay in Settings.
    id: "proton-bridge-165",
    headline: PROTON_WORDS.intro.headline,
    ask: PROTON_WORDS.intro.ask,
    show: PROTON_WORDS.intro.show,
    later: PROTON_WORDS.intro.later,
    mark: "spark",
    steps: [...PROTON_WORDS.introSteps],
    settings: PROTON_WORDS.intro.settings,
  },
  {
    // PS 1.60 (pull request 12b). Only for people who said No or have not answered (views/FeatureIntro.tsx DONE_PROBES, core/screenrecmeet.ts introAudience).
    id: "screenrec",
    headline: SR_INTRO.headline,
    ask: SR_INTRO.ask,
    show: "Show me",
    later: "Later",
    mark: "record",
    steps: [...SR_INTRO.steps],
    settings: SR_INTRO.settings,
  },
  {
    // PS 1.65 Settings assistant (words for the owner to approve): one Ok ends it for good (a `choice` with one button: nothing opens).
    // Shown only while the assistant is on (views/FeatureIntro.tsx DONE_PROBES).
    id: "settings-assistant-165",
    headline: ASSIST_WORDS.introHead,
    ask: ASSIST_WORDS.introAsk,
    show: "Ok",
    mark: "spark",
    choice: true,
  },
  {
    // PS 1.65 Low power mode (core/lowpower.ts, views/LowPowerButton.tsx): one Ok ends it for good. Words for the owner to approve.
    id: "low-power-165",
    headline: "Low power mode",
    ask: "The leaf next to Network puts G Squad, email feeds and every background timer to sleep. Your list keeps going.",
    show: "Ok",
    mark: "spark",
    choice: true,
  },
];

/** The widths of the intro card and the guide grown out of the island (points). */
export const CARD_W = 340, GUIDE_W = 640;
export const ACTIVE_NEEDED_MS = 60_000;
/** Input older than this is idle: the clock stops. */
export const IDLE_MS = 30_000;
/** One clock tick never adds more than this (a Mac that slept or a stalled page must not count as use). */
export const TICK_CAP_MS = 10_000;
export const LATER_AFTER_MS = 3 * 86_400_000;
export const GAP_MS = 86_400_000;

export interface IntroRec { n: number; at: number; later?: boolean; closed?: boolean }
export interface IntroState { ver: string; activeMs: number; lastAt: number; recs: Record<string, IntroRec> }
export const emptyState = (): IntroState => ({ ver: "", activeMs: 0, lastAt: 0, recs: {} });

const num = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : 0);
/** What was saved, cleaned (anything odd is forgotten, never trusted). */
export function cleanState(v: unknown): IntroState {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const recs: Record<string, IntroRec> = {};
  const r = (o.recs && typeof o.recs === "object" ? o.recs : {}) as Record<string, unknown>;
  for (const id of Object.keys(r).slice(0, 50)) {
    const x = (r[id] && typeof r[id] === "object" ? r[id] : {}) as Record<string, unknown>;
    const n = Math.min(5, Math.floor(num(x.n, 1000)));
    if (n < 1) continue;
    recs[id] = { n, at: num(x.at, 1e14), ...(x.later === true ? { later: true } : {}), ...(x.closed === true ? { closed: true } : {}) };
  }
  return { ver: typeof o.ver === "string" ? o.ver.slice(0, 20) : "", activeMs: num(o.activeMs, 1e9), lastAt: num(o.lastAt, 1e14), recs };
}

/** Counts a little active use. `idleMs`: how long since the last key, click or scroll. Only counts when the to do list is on
 *  screen (`listShown`) and the person is not idle. A new version starts the count again: "after an update". */
export function addActive(s: IntroState, a: { version: string; deltaMs: number; idleMs: number; listShown: boolean }): IntroState {
  const fresh = a.version !== s.ver;
  const base = fresh ? { ...s, ver: a.version, activeMs: 0 } : s;
  if (!a.listShown || a.idleMs > IDLE_MS || !(a.deltaMs > 0)) return base;
  return { ...base, activeMs: Math.min(base.activeMs + Math.min(a.deltaMs, TICK_CAP_MS), ACTIVE_NEEDED_MS * 100) };
}

export interface IntroFacts {
  now: number;
  /** Intros the person already did (WhatsApp linked) or that cannot apply to them (no own project to link). */
  notForThem: ReadonlySet<string> | readonly string[];
  /** Another island card (meeting, reminder, stand up, What's new, Welcome back, update, any other) is on it or waiting. */
  islandBusy: boolean;
  sleep: boolean;
  sentry: boolean;
  dnd: boolean;
  sharing: boolean;
  fullScreen: boolean;
  /** The feature switch (features.json "feature-intros") is off. */
  off: boolean;
  /** PS 1.65: the person is in a meeting right now (left out: not in one). */
  meeting?: boolean;
}

export type Wait = "off" | "notActive" | "gap" | "busy" | "sleep" | "sentry" | "dnd" | "sharing" | "fullScreen" | "meeting";
export type Choice = { show: IntroDef } | { wait: Wait } | null;

const has = (s: IntroFacts["notForThem"], id: string) => Array.isArray(s) ? s.includes(id) : (s as ReadonlySet<string>).has(id);

/** Could this intro still be shown to this person (ignoring the clock and the island)? Never after done, closed, or a second Later. */
export function eligible(d: IntroDef, s: IntroState, f: Pick<IntroFacts, "notForThem">, now: number): boolean {
  if (has(f.notForThem, d.id)) return false;
  const r = s.recs[d.id];
  if (!r) return true;
  if (d.tour) return !r.closed;   // the tour comes back (after a meeting, a closed page) until it is finished
  if (r.closed || r.n >= 2) return false;
  // shown once and answered Later (or closed by Esc, or the page went away): asks once more after 3 days
  return now - r.at >= LATER_AFTER_MS;
}

/** The one intro to show now, or why not yet, or null when nothing is left to show (ever). */
export function nextIntro(s: IntroState, f: IntroFacts, defs: IntroDef[] = INTROS): Choice {
  const d = defs.find((x) => eligible(x, s, f, f.now));
  if (!d) return null;
  if (f.off) return { wait: "off" };
  if (s.activeMs < ACTIVE_NEEDED_MS) return { wait: "notActive" };
  if (!d.tour && s.lastAt && f.now - s.lastAt < GAP_MS) return { wait: "gap" };
  // the places an intro must never come: the person is asleep, away, in a call or watching something
  if (f.sleep) return { wait: "sleep" };
  if (f.sentry) return { wait: "sentry" };
  if (f.dnd) return { wait: "dnd" };
  if (f.sharing) return { wait: "sharing" };
  if (f.fullScreen) return { wait: "fullScreen" };
  if (f.meeting) return { wait: "meeting" };
  if (f.islandBusy) return { wait: "busy" };
  return { show: d };
}

/** It was drawn. Counts at once and starts as "Later", so a page that goes away mid intro still asks only once more. */
export function markShown(s: IntroState, id: string, now: number): IntroState {
  const r = s.recs[id];
  return { ...s, lastAt: now, recs: { ...s.recs, [id]: { n: Math.min(5, (r?.n ?? 0) + 1), at: now, later: true } } };
}
/** The answer. "show": the end of it for good. "later": the second time it is the end too (never a third). */
export function answer(s: IntroState, id: string, a: "show" | "later"): IntroState {
  const r = s.recs[id];
  if (!r) return s;
  const closed = a === "show" || r.n >= 2;
  return { ...s, recs: { ...s.recs, [id]: { n: r.n, at: r.at, ...(closed ? { closed: true } : { later: true }) } } };
}

/** How long to wait before looking again, by reason (ms). A blocked moment is checked again soon, a clock reason later. */
export function recheckMs(w: Wait): number {
  switch (w) {
    case "notActive": return 15_000;
    case "gap": return 30 * 60_000;
    case "off": return 10 * 60_000;
    default: return 60_000;
  }
}

/** Reasons the Mac's island may answer with instead of "go" (Sources/IslandIntroCore.swift). */
export function macBlocked(v: unknown): Wait | null {
  return v === "sleep" || v === "sentry" || v === "sharing" || v === "fullScreen" || v === "off" || v === "busy" ? v : null;
}

/** The person did the thing (WhatsApp is linked): this intro never shows again, whatever the clock says. */
export function retire(s: IntroState, id: string, now: number): IntroState {
  const r = s.recs[id];
  if (r?.closed) return s;
  return { ...s, recs: { ...s.recs, [id]: { n: r?.n ?? 1, at: r?.at ?? now, closed: true } } };
}

/** PS 1.65: the tour runs, so the intros it replaces are done for good (they never show as separate cards). */
export function retireFolded(s: IntroState, now: number): IntroState {
  return TOUR_FOLDS.reduce((acc, id) => retire(acc, id, now), s);
}

/** The Mac's answer to "island:intro": queued behind another card, go (with where the island is, or none when the island
 *  cannot do it and the card is drawn plainly), or blocked with the reason (it asks again at the next free moment). */
export type IntroReply = { phase: "queued" } | { phase: "go"; anchor: IslandAnchor | null } | { phase: "blocked"; why: Wait } | null;
export function introReply(m: unknown): IntroReply {
  const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
  if (o.state === "queued") return { phase: "queued" };
  if (o.state === "go") return { phase: "go", anchor: cleanAnchor(o.rect) };
  if (o.state === "blocked") { const why = macBlocked(o.why); return why ? { phase: "blocked", why } : null; }
  return null;
}

// ---------- V1.62: once per person, and only for people who are updating ----------
/** The ids of the one button notices this person already closed, from their synced settings (introsDone). */
export function cleanDone(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && /^[a-z0-9-]{1,48}$/.test(x)))].slice(0, 50) : [];
}
/** Is this an update for this person (they ran PS before this build), a first install, or not known yet?
 *  done: closed on another device already, or a first install (it is retired for good, never shown);
 *  open: an update and not closed yet; unknown: wait, never show on a guess.
 *  The signal is the one What's new uses (core/whatsnew.ts accountOlderThan): the account holds a record last changed before
 *  this build was made, or this device had handled an earlier version before this page started (`seenAtStart`, read before
 *  What's new records the new one). */
export function updaterAnswer(i: {
  id: string; unlocked: boolean; docs: number; done: readonly string[]; accountOlder: boolean; seenAtStart: string | null; version: string;
}): "done" | "open" | "unknown" {
  if (!i.unlocked || i.docs === 0) return "unknown";
  if (i.done.includes(i.id)) return "done";
  const seen = cleanVersion(i.seenAtStart);
  const ranBefore = i.accountOlder || (!!seen && cmpVersion(seen, i.version) < 0);
  return ranBefore ? "open" : "done";
}

// ---------- V1.62: the new app logo's moment (the developer: "a very fancy animation with the dynamic island ... the logo coming out of the
// dynamic island, with nice chime sounds") ----------
// The Mac's island does its squeeze and spring bounce and its own chime as the card starts (SetupIsland.featureIntro, the Island
// sounds switch). The card hangs from the island in the same black and grows out of its width; the logo starts small inside the
// island and springs out to full size with a soft overshoot, a shine runs across it, then the words and Ok fade in. A second soft
// chime plays as the logo lands, a light click on Ok, and on Ok the logo goes back up into the island before the card folds away.
// Times in ms from the moment the card is drawn; views/featureintro.css uses the same numbers.
export const LOGO_MOMENT = {
  /** The logo's spring out of the island (it peaks a little past full size and settles). */
  outDelay: 80, outDur: 900,
  /** It has landed (the spring's overshoot top): the landing chime. */
  land: 520,
  /** The shine across the logo, then the words, then Ok. */
  shine: 640, words: 600, ok: 820,
  /** After Ok: the logo goes back into the island, then the card folds back up; the island then shrinks back. */
  backLogo: 300, backCard: 560,
} as const;
/** May the landing chime play? The island's sounds switch (Settings, Island) on, and not muted by Do Not Disturb. */
export function logoChime(o: { islandSounds: boolean; dnd: boolean }): boolean {
  return o.islandSounds && !o.dnd;
}
