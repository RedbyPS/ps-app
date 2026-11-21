// The island inside PS on the phone (PS 1.66, the developer, 17 Nov 2026: "the phone has no system island following you, so draw PS's
// island inside the app at the top, just below the status bar, centred, showing the same moments the Mac island shows").
// This file only decides WHAT it shows, from the same island state the Mac gets (src/island.ts), the G Squad message cards
// (squad/chatengine.ts) and the reminders that are showing now (core/remind.ts). gos/PhoneIsland.tsx draws it.
//
// One moment at a time, the most urgent first: a new squad message, a new email or AI message, a reminder, a Fitness moment,
// the rest timer, a meeting (soon or on now), a stand-up, a Pomodoro; with none of those, the task being worked on (small).
//
// Run: node --experimental-strip-types tests/phoneisland.test.ts

export type MomentKind = "squad" | "mail" | "lead" | "chat" | "rem" | "fit" | "rest" | "meet" | "stand" | "pomo" | "task";
export type MomentTone = "squad" | "mail" | "rem" | "fit" | "meet" | "calm" | "plain";
/** Where a tap goes: a page or screen of PS on the phone. */
export type MomentOpen = "gsquad" | "inbox" | "plan" | "list" | "gym" | `task:${string}`;

export interface PhoneMoment {
  id: string;
  kind: MomentKind;
  title: string;
  sub: string;
  /** A countdown to this time (epoch ms), shown on the right. */
  to?: number;
  tone: MomentTone;
  open: MomentOpen;
  /** Big: two lines, wider. Small: a one line pill. */
  big: boolean;
}

/** The parts of the island state (core/island.ts IslandState plus what src/island.ts adds) this needs. All optional:
 *  the page may not have sent anything yet. */
export interface IslandIn {
  private?: boolean;
  task?: { id: string; title: string; dim?: boolean } | null;
  event?: { id: string; kind: "mail" | "lead" | "chat"; title: string; sub: string; privTitle?: string } | null;
  pomo?: { id: string; phase: "work" | "short" | "long"; endsAt: number; wait: boolean } | null;
  stand?: { at: number; len: number } | null;
  meet?: { id: string; title: string; start: number; end: number } | null;
  fit?: { moment: { id: string; title: string; sub: string; until: number } | null; rest: { endsAt: number; exercise: string; set: number; of: number; over: boolean; overAt: number } | null } | null;
}
export interface NoteIn { id: string; title: string; body: string; at: string }
/** A reminder showing now. `snooze`: its own length in minutes (it comes out of the island again at that rhythm). */
export interface RemIn { id: string; text: string; task: string; snooze?: number }

/** How long a new squad message stays on the island (the Mac's event time). */
export const NOTE_MS = 12_000;
/** A stand-up shows from this long before it starts. */
export const STAND_EARLY_MS = 60_000;
/** "Rest over" stays this long (core/fitisland.ts REST_OVER_MS). */
export const REST_OVER_MS = 3_000;

const clip = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");

/** The words of every moment, in one place (the handover lists them; no dashes). */
export const ISL_WORDS = {
  squad: "G Squad",
  squadPrivate: "New message",
  mail: "New client email",
  lead: "New lead reply",
  chat: "An AI chat finished",
  aiPrivate: "A message from an AI",
  reminder: "Reminder",
  rest: "Rest",
  restOver: "Rest over",
  setOf: (set: number, of: number) => `Set ${set} of ${of}`,
  meeting: "Meeting",
  startsIn: "Starts in",
  endsIn: "On now, ends in",
  stand: "Stand up",
  standSub: "Stretch for a minute",
  focus: "Focus",
  breakShort: "Short break",
  breakLong: "Long break",
  breakWait: "Break is ready",
  pomodoro: "Pomodoro",
  working: "Working on",
  privateTask: "Private mode",
} as const;

/** The moment to show now, or null for none (the island hides). */
export function pickMoment(st: IslandIn | null | undefined, notes: NoteIn[], rems: RemIn[], now: number): PhoneMoment | null {
  const priv = !!st?.private;
  // 1. A G Squad message that just came.
  const note = [...notes].filter((n) => { const at = Date.parse(n.at); return Number.isFinite(at) && now - at < NOTE_MS && now - at > -60_000; })
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  if (note) return { id: `n:${note.id}`, kind: "squad", title: priv ? ISL_WORDS.squad : clip(note.title, 60) || ISL_WORDS.squad, sub: priv ? ISL_WORDS.squadPrivate : clip(note.body, 140), tone: "squad", open: "gsquad", big: true };
  // 2. A new client email, lead reply or AI message (the island state already times it out).
  const ev = st?.event;
  if (ev) {
    const words = ev.kind === "mail" ? ISL_WORDS.mail : ev.kind === "lead" ? ISL_WORDS.lead : ev.privTitle ? ISL_WORDS.aiPrivate : ISL_WORDS.chat;
    return { id: `e:${ev.id}`, kind: ev.kind, title: priv ? words : clip(ev.title, 80) || words, sub: priv ? (ev.privTitle ? clip(ev.privTitle, 80) : "") : clip(ev.sub, 120) || words, tone: "mail", open: ev.kind === "chat" ? "list" : "inbox", big: true };
  }
  // 3. A reminder that is showing now (until it is answered).
  const rem = rems[0];
  if (rem) return { id: `r:${rem.id}`, kind: "rem", title: priv ? ISL_WORDS.reminder : clip(rem.text, 80) || ISL_WORDS.reminder, sub: ISL_WORDS.reminder, tone: "rem", open: rem.task ? `task:${rem.task}` : "list", big: true };
  // 4. Fitness: a moment (scanning, found, added...), then the rest timer.
  const fm = st?.fit?.moment;
  if (fm && fm.until > now) return { id: `f:${fm.id}`, kind: "fit", title: clip(fm.title, 60), sub: clip(fm.sub, 100), tone: "fit", open: "gym", big: true };
  const rest = st?.fit?.rest;
  if (rest && (!rest.over || now - rest.overAt < REST_OVER_MS)) {
    const over = rest.over || rest.endsAt <= now;
    return { id: "rest", kind: "rest", title: over ? ISL_WORDS.restOver : ISL_WORDS.rest, sub: [clip(rest.exercise, 40), rest.of > 0 ? ISL_WORDS.setOf(rest.set, rest.of) : ""].filter(Boolean).join(", "),
      ...(over ? {} : { to: rest.endsAt }), tone: "fit", open: "gym", big: false };
  }
  // 5. A meeting: soon (counting down to its start) or on now (counting down to its end).
  const m = st?.meet;
  if (m && now < m.end) {
    const on = now >= m.start;
    return { id: `m:${m.id}`, kind: "meet", title: priv ? ISL_WORDS.meeting : clip(m.title, 80) || ISL_WORDS.meeting, sub: on ? ISL_WORDS.endsIn : ISL_WORDS.startsIn, to: on ? m.end : m.start, tone: "meet", open: "plan", big: true };
  }
  // 6. A stand-up, from a minute before it until it is over.
  const sd = st?.stand;
  if (sd && now >= sd.at - STAND_EARLY_MS && now < sd.at + sd.len) {
    return { id: `s:${sd.at}`, kind: "stand", title: ISL_WORDS.stand, sub: ISL_WORDS.standSub, to: now < sd.at ? sd.at : sd.at + sd.len, tone: "calm", open: "list", big: false };
  }
  // 7. A Pomodoro running (or a break waiting for its Start).
  const p = st?.pomo;
  if (p && (p.wait || p.endsAt > now)) {
    const title = p.wait ? ISL_WORDS.breakWait : p.phase === "work" ? ISL_WORDS.focus : p.phase === "long" ? ISL_WORDS.breakLong : ISL_WORDS.breakShort;
    return { id: `p:${p.id}:${p.phase}`, kind: "pomo", title, sub: ISL_WORDS.pomodoro, ...(p.wait ? {} : { to: p.endsAt }), tone: "calm", open: "list", big: false };
  }
  // 8. Nothing live: the task being worked on, small.
  const t = st?.task;
  if (t && clip(t.title, 1)) return { id: `t:${t.id}`, kind: "task", title: priv ? ISL_WORDS.privateTask : clip(t.title, 80), sub: ISL_WORDS.working, tone: "plain", open: priv ? "list" : `task:${t.id}`, big: false };
  return null;
}

/** A countdown's words: "45" seconds, "4:05", "1:02:03". Never negative. */
export function countdown(to: number, now: number): string {
  const s = Math.max(0, Math.ceil((to - now) / 1000));
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  if (h) return `${h}:${two(mi)}:${two(se)}`;
  if (mi) return `${mi}:${two(se)}`;
  return `${se}`;
}

/** When the island must look again (ms from now): each second while a countdown shows, else at the next time a moment can
 *  start or end that it knows of, at most 30 s (a meeting's lead time, a reminder window). */
export function nextLook(m: PhoneMoment | null, st: IslandIn | null | undefined, notes: NoteIn[], now: number): number {
  if (m?.to) return 1000 - (now % 1000) + 5;
  const t: number[] = [];
  for (const n of notes) { const at = Date.parse(n.at); if (Number.isFinite(at) && at + NOTE_MS > now) t.push(at + NOTE_MS); }
  if (st?.fit?.moment && st.fit.moment.until > now) t.push(st.fit.moment.until);
  if (st?.fit?.rest?.over) t.push(st.fit.rest.overAt + REST_OVER_MS);
  if (st?.stand) t.push(st.stand.at - STAND_EARLY_MS);
  const next = t.filter((x) => x > now).map((x) => x - now + 20);
  return Math.max(250, Math.min(30_000, ...next));
}

// ---------- PS 1.72: like the Mac's island (the developer, 21 Nov 2026) ----------
// "By default the island shows my current task. Reminders and other moments come OUT of the island with a fancy animation.
// Tapping it does something." Before this a reminder sat on the island until it was answered and a tap only went to the
// list, so nothing happened. Now a reminder comes out for POP_MS, goes back in to the task with a small bell while it
// waits, and comes out again at its own snooze rhythm (the ring's) and each time PS comes to the front. A tap opens the
// card (gos/PhoneIsland.tsx) with the reminder's real buttons, the same rules as the ring card and the Mac card.

/** How long a reminder stays out of the island before it goes back in to the task. */
export const POP_MS = 8_000;

/** When each reminder showing now was first seen while the island was up. Answered ones drop out; new ones start now. */
export function remSeen(prev: Readonly<Record<string, number>>, rems: RemIn[], now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rems) out[r.id] = prev[r.id] ?? now;
  return out;
}
const everyOf = (snooze: number | undefined) => Math.max(1, Math.min(240, Number.isFinite(snooze) ? Number(snooze) : 15)) * 60_000;
/** Out of the island now: for POP_MS from when it came, then again every snooze length until it is answered. */
export function remOut(since: number | undefined, snooze: number | undefined, now: number): boolean {
  if (since === undefined || !Number.isFinite(since) || now < since) return false;
  return (now - since) % everyOf(snooze) < POP_MS;
}
/** The next moment a reminder comes out or goes back in (epoch ms), or null when none waits. */
export function remTurn(rems: RemIn[], seen: Readonly<Record<string, number>>, now: number): number | null {
  let best: number | null = null;
  for (const r of rems) {
    const since = seen[r.id];
    if (since === undefined) continue;
    const every = everyOf(r.snooze), into = Math.max(0, now - since) % every;
    const at = now - into + (into < POP_MS ? POP_MS : every);
    if (best === null || at < best) best = at;
  }
  return best;
}

/** What the island shows. `face`: the pill (as before, but a reminder only while it is out), `waiting`: the reminders not
 *  answered yet and not on the face (the small bell), `out`: a reminder is out right now (the pop). */
export interface IslandLook { face: PhoneMoment | null; waiting: RemIn[]; out: boolean }
export function islandLook(st: IslandIn | null | undefined, notes: NoteIn[], rems: RemIn[], seen: Readonly<Record<string, number>>, now: number): IslandLook {
  const outs = rems.filter((r) => remOut(seen[r.id], r.snooze, now));
  let face = pickMoment(st, notes, outs, now);
  // Nothing else to show (no task): the waiting reminder stays as a small pill, so a tap can still reach its buttons.
  if (!face && rems.length) { const m = pickMoment({ private: st?.private }, [], [rems[0]], now); if (m) face = { ...m, big: false }; }
  const onFace = face?.kind === "rem" ? face.id.slice(2) : "";
  return { face, waiting: rems.filter((r) => r.id !== onFace), out: face?.kind === "rem" && face.big };
}

/** What a tap does. New messages, emails, AI chats and Fitness moments open their own screen, as they always did (their
 *  own action). The task, a reminder and the timers open the card. Nothing to put in a card: the old direct open. */
export type IslandTap = "open" | "card";
const DIRECT: MomentKind[] = ["squad", "mail", "lead", "chat", "fit"];
export function tapDoes(look: IslandLook, st: IslandIn | null | undefined): IslandTap {
  const f = look.face;
  if (!f) return "open";
  if (DIRECT.includes(f.kind)) return "open";
  const c = cardOf(look, st, null, look.waiting);
  return c.rem || f.kind === "rem" || c.task || c.moment ? "card" : "open";
}

/** The card a tap opens: the reminder with its buttons (the one asked for, else the one on the face, else the first one
 *  waiting), the timer or meeting that shows (a tap on it opens its screen), and the task being worked on with its tick.
 *  Private mode: no task row (its name stays hidden, as on the Mac). */
export interface IslandCard { rem: RemIn | null; moment: PhoneMoment | null; task: { id: string; title: string; dim: boolean } | null }
export function cardOf(look: IslandLook, st: IslandIn | null | undefined, pick: string | null, rems: RemIn[]): IslandCard {
  const f = look.face;
  const rem = (pick ? rems.find((r) => r.id === pick) : undefined)
    ?? (f?.kind === "rem" ? rems.find((r) => `r:${r.id}` === f.id) : undefined)
    ?? look.waiting[0] ?? null;
  const moment = f && f.kind !== "task" && f.kind !== "rem" && !DIRECT.includes(f.kind) ? f : null;
  const t = st?.task;
  // dim: nothing is marked as working, so this is the next Priority 1 task (the Mac's dimmed row): no "Working on" over it.
  const task = t && !st?.private && clip(t.title, 1) ? { id: t.id, title: clip(t.title, 120), dim: !!t.dim } : null;
  return { rem, moment, task };
}
