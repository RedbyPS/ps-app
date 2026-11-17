// Voice capture (PS 1.65, part 2 of the developer's request for 1.65: "A microphone button in Quick add and the Add task window on
// the Mac. Speak a ramble ('call Alex tomorrow at 10, send Sam the invoice, gym every day at 8') and it becomes tidy tasks.
// Private: Apple's on-device speech recognition ... then Apple's on-device model ... splits it into tasks, with dates through the
// parser from part 1. A review list before anything is added: each task editable, removable, then 'Add all'. Nothing is added
// without that click.")
//
// The pure half, tested by tests/voicecapture.test.ts with a fake shell and a fake model. No DOM, no clock of its own, no network.
//   - splitRamble: the split without the model (sentences, commas, "and then" style joins, lead ins like "I need to" dropped).
//   - checkModelTasks: what the on-device model said, accepted only when it stays faithful to the words (nothing made up,
//     nothing lost, every date phrase kept); otherwise the plain split is used.
//   - the review list (reviewStart, reviewStep): editable rows, each through parseTaskText (core/nldates.ts); the ONLY way
//     anything is added is the "addAll" action with by: "click".
//   - the capture flow (voiceStep): the microphone and speech permission states, the hold or click to record rule, the
//     protected app stop, thinking, the review. It returns the messages for the Mac shell (VoiceCapture.swift), so the view
//     (views/VoiceCapture.tsx) only draws and posts.
import { parseTaskText, type NlOpts, type ParsedTask } from "./nldates.ts";

// ---------------------------------------------------------------------------------------------------------------------
// Words (every one waits for the developer's yes; the report lists them)
// ---------------------------------------------------------------------------------------------------------------------
export const VOICE_WORDS = {
  mic: "Speak your tasks",
  micTitle: "Speak your tasks (hold to talk, or click and click Stop)",
  why: "PS uses the microphone and speech recognition only while you talk, and turns it into text on this Mac.",
  asking: "Waiting for your answer in the macOS window.",
  ready: "All set. Hold the microphone and talk, or click it and click Stop.",
  denied: "PS cannot use the microphone or speech recognition. Turn both on for PS in System Settings, Privacy and Security.",
  openSettings: "Open System Settings",
  restricted: "This Mac does not allow the microphone or speech recognition for PS.",
  noOnDevice: (lang: string) => `Speech on this Mac is not available for ${lang} without sending it to Apple, so PS will not listen.`,
  protectedFront: "PS does not listen while 1Password or Signal is in front.",
  protectedStop: "Stopped: 1Password or Signal came to the front.",
  listening: "Listening",
  stop: "Stop",
  holding: "Release to stop",
  limit: "Stopped after 2 minutes.",
  nothing: "Nothing heard. Try again a little closer to the microphone.",
  thinking: "Making tasks",
  failed: "Speech recognition stopped. Try again.",
  reviewHead: (n: number) => (n === 1 ? "1 task from what you said" : `${n} tasks from what you said`),
  reviewEmpty: "Nothing left to add.",
  addAll: (n: number) => (n === 1 ? "Add it" : `Add all ${n}`),
  discard: "Discard",
  remove: "Remove",
  keepWords: "Click to keep the words as text",
  needsName: "Needs a few words",
  added: (n: number) => (n === 1 ? "Added 1 task" : `Added ${n} tasks`),
} as const;

// ---------------------------------------------------------------------------------------------------------------------
// Cleaning one spoken task
// ---------------------------------------------------------------------------------------------------------------------
export const MAX_TASKS = 20;
export const MAX_TASK_CHARS = 200;
export const MAX_TRANSCRIPT = 4000;

/** Sounds people make between words. Removed anywhere. */
const FILLERS = /\b(?:um+|uh+|erm+|er|hmm+|ah+|you know|i mean)\b[,.]?/gi;
/** How people start a task out loud. Removed from the front of each task, again and again ("so I need to also call"). */
const LEAD_INS = [
  "okay so", "ok so", "so", "okay", "ok", "and also", "and then", "and", "also", "then", "oh and", "oh", "plus", "next up",
  "after that", "first of all", "firstly", "secondly", "finally", "lastly",
  "i need to", "i have to", "i've got to", "i have got to", "i got to", "i gotta", "i must", "i should", "i want to", "i'd like to",
  "i'll need to", "i will need to", "i'll", "i will", "we need to", "we have to", "we should", "need to", "have to", "got to", "gotta", "must",
  "remember to", "remind me to", "don't forget to", "do not forget to", "make sure to", "make sure i", "make sure we", "try to",
  "please", "can you", "could you", "add a task to", "a task to", "task to", "to",
];
const LEAD_RE = new RegExp(`^(?:${LEAD_INS.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")).join("|")})\\b[,:]?\\s*`, "i");

/** One task's words, tidied: fillers and lead ins out, no end punctuation, a capital first letter. "" when nothing is left. */
export function cleanSpoken(s: string): string {
  let t = String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(FILLERS, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/^[\s,;:.!?-]+/, "");
  for (let i = 0; i < 6; i++) {
    const before = t;
    t = t.replace(LEAD_RE, "").replace(/^[\s,;:.!?-]+/, "");
    if (t === before) break;
  }
  // "add" alone, "to" alone: nothing was said.
  t = t.replace(/[\s,;:.!?]+$/, "").trim();
  if (!t) return "";
  t = t.slice(0, MAX_TASK_CHARS).trim();
  return /^[a-z][A-Z]/.test(t) ? t : t.charAt(0).toUpperCase() + t.slice(1);   // "iPhone" stays
}

// ---------------------------------------------------------------------------------------------------------------------
// The split without the model
// ---------------------------------------------------------------------------------------------------------------------
/** Words that start a new task after a plain "and" ("call Alex and send the invoice"). A plain "and" before anything
 *  else stays inside the task ("buy milk and eggs"). */
const TASK_VERBS = new Set([
  "add", "answer", "apply", "arrange", "ask", "book", "bring", "buy", "call", "cancel", "change", "check", "clean", "clear", "collect",
  "confirm", "cook", "do", "draft", "drop", "email", "e-mail", "feed", "file", "finish", "fix", "follow", "get", "give", "go", "grab",
  "hang", "invite", "iron", "learn", "leave", "look", "mail", "make", "meet", "message", "move", "order", "organise", "organize",
  "pack", "pay", "phone", "pick", "plan", "post", "prepare", "print", "put", "read", "remind", "renew", "reply", "return", "review",
  "ring", "run", "schedule", "see", "sell", "send", "set", "share", "ship", "shop", "sign", "sort", "start", "submit", "take", "talk",
  "tell", "text", "tidy", "update", "upload", "visit", "walk", "wash", "watch", "water", "write", "gym", "workout", "study", "practice", "practise",
]);
/** Joins that always mean "next task" (after a comma, a full stop, or in the middle of a sentence). */
const JOINS = /\s*(?:,\s*)?\b(?:and then|and after that|after that|and also|oh and|then)\b\s*/gi;

function words(s: string): string[] { return s.toLowerCase().match(/[a-z0-9']+/g) ?? []; }

/** True when the text holds nothing but date, time or repeat words ("tomorrow at 10", "every Friday"). */
function onlyWhen(s: string, now: number, tz: string, opts: NlOpts): boolean {
  const t = s.replace(/[\s,;:.!?]+$/, "").trim();
  if (!t) return false;
  const p = parseTaskText(t, now, tz, opts);
  return !!p && !cleanSpoken(p.title);
}

/** Splits a ramble into task texts without the model. `now`, `tz` and `opts` only help to keep a date said after a comma
 *  ("call Alex, tomorrow at 10") with its task. */
export function splitRamble(text: string, now: number | Date = 0, tz = "UTC", opts: NlOpts = {}): string[] {
  const at = typeof now === "number" ? now : now.getTime();
  let s = String(text ?? "").slice(0, MAX_TRANSCRIPT).replace(/[\r\n]+/g, ". ").replace(FILLERS, " ").replace(/\s+/g, " ").trim();
  if (!s) return [];
  // Hard breaks: the end of a sentence, a semicolon, the joins.
  s = s.replace(/([.!?;])\s+/g, "$1\u0001").replace(JOINS, "\u0001");
  // A comma (not one inside a number like 1,000) is a soft break: kept apart only when both sides say something.
  const hard = s.split("\u0001");
  const pieces: { text: string; soft: boolean }[] = [];   // soft: came after a comma in the same sentence
  for (const h of hard) {
    const soft = h.split(/(?<!\d),|,(?!\d)/);
    soft.forEach((raw, si) => {
      // A plain "and" before a task word starts a new task ("call mum and send the photos"), unless what follows only
      // points back ("review the contract and sign it").
      const parts = raw.split(/\s+and\s+(?=([a-z'-]+))/i);
      // String.split with a capture group puts the captured word in between: rebuild.
      let cur = parts[0];
      let first = true;
      for (let i = 1; i < parts.length; i += 2) {
        const next = parts[i + 1] ?? "";
        const verb = (parts[i] ?? "").toLowerCase();
        const back = words(next).length <= 3 && /\b(?:it|them|that|this|those|these|him|her)\b/i.test(next);
        if (TASK_VERBS.has(verb) && !back) { pieces.push({ text: cur, soft: first ? si > 0 : false }); first = false; cur = next; } else cur = `${cur} and ${next}`;
      }
      pieces.push({ text: cur, soft: first ? si > 0 : false });
    });
  }
  // Glue back what cannot stand alone: a piece that is only a date joins the task before it (or after it, at the start);
  // after a comma, a short piece that is not a task of its own ("eggs and bread" after "buy milk") is part of a list.
  const out: string[] = [];
  const verbLed = (t: string) => TASK_VERBS.has(words(t)[0] ?? "");
  let carry = "";
  for (const p of pieces) {
    const t = p.text.trim();
    if (!t) continue;
    if (onlyWhen(t, at, tz, opts)) {
      if (out.length) out[out.length - 1] = `${out[out.length - 1].replace(/[\s,;:.!?]+$/, "")} ${t}`;
      else carry = carry ? `${carry} ${t}` : t;
      continue;
    }
    const c = cleanSpoken(t);
    if (!c) continue;
    const prev = out[out.length - 1];
    if (p.soft && prev && verbLed(prev) && !verbLed(c) && words(c).length <= 3 && !parseTaskText(c, at, tz, opts)) {
      out[out.length - 1] = `${prev}, ${c.charAt(0).toLowerCase()}${c.slice(1)}`;
      continue;
    }
    out.push(carry ? `${c} ${carry}` : c);
    carry = "";
  }
  if (carry && !out.length) return [];   // only a date was said: nothing to call a task
  return out.map(cleanSpoken).filter(Boolean).slice(0, MAX_TASKS);
}

// ---------------------------------------------------------------------------------------------------------------------
// The model's split, checked
// ---------------------------------------------------------------------------------------------------------------------
/** The instructions the Mac gives Apple's on-device model (VoiceCaptureCore.swift keeps the same words, the test checks). */
export const SPLIT_RULES = [
  "Split what the person said into separate to do tasks.",
  "Use the person's own words. Do not add anything they did not say.",
  "Keep every word about dates, times and repeats exactly as said, in the task it belongs to.",
  "Drop filler like um, okay, I need to, remind me to.",
  "Answer only with JSON: {\"tasks\": [\"first task\", \"second task\"]}",
] as const;

/** Reads the model's text: {"tasks": [...]} or a bare [...], also inside other text or a code fence. Null when it is not there. */
export function parseModelText(text: unknown): string[] | null {
  if (Array.isArray(text)) return text.every((x) => typeof x === "string") ? (text as string[]) : null;
  if (typeof text !== "string") return null;
  const s = text.slice(0, 20000);
  const tryJson = (j: string): string[] | null => {
    try {
      const v = JSON.parse(j) as unknown;
      const list = Array.isArray(v) ? v : v && typeof v === "object" ? (v as { tasks?: unknown }).tasks : null;
      return Array.isArray(list) && list.every((x) => typeof x === "string") ? (list as string[]) : null;
    } catch { return null; }
  };
  const o = s.indexOf("{"), oe = s.lastIndexOf("}");
  if (o >= 0 && oe > o) { const r = tryJson(s.slice(o, oe + 1)); if (r) return r; }
  const a = s.indexOf("["), ae = s.lastIndexOf("]");
  if (a >= 0 && ae > a) { const r = tryJson(s.slice(a, ae + 1)); if (r) return r; }
  return null;
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "then", "also", "need", "have", "got", "gotta", "must", "should",
  "want", "remember", "remind", "forget", "don't", "make", "sure", "okay", "please", "you", "our", "your", "her", "his", "their", "them",
  "will", "i'll", "i've", "i'd", "about", "from", "into", "onto", "some", "just", "really", "maybe", "like", "um", "uh", "erm"]);
const stem = (w: string) => w.replace(/'s$/, "").replace(/(?:ing|ed|es|s)$/, "").slice(0, 6);
const content = (s: string) => words(s).filter((w) => w.length >= 3 && !STOP.has(w)).map(stem);

/** The model's tasks, accepted only when they stay with the person's words: at most MAX_TASKS, each made of words that were
 *  said (a few new small words are fine: "go to the gym"), together covering what was said, and every date, time or
 *  repeat phrase the parser finds in the words kept in some task. Null: use splitRamble instead. */
export function checkModelTasks(raw: unknown, transcript: string, now: number | Date = 0, tz = "UTC", opts: NlOpts = {}): string[] | null {
  const list = parseModelText(raw);
  if (!list) return null;
  const tasks = list.map(cleanSpoken).filter(Boolean);
  if (!tasks.length || list.length > MAX_TASKS) return null;
  const said = new Set(content(transcript));
  if (!said.size) return null;
  const used = new Set<string>();
  for (const t of tasks) {
    const c = content(t);
    if (!c.length) continue;
    const known = c.filter((w) => said.has(w));
    if (known.length / c.length < 0.6) return null;   // made up
    known.forEach((w) => used.add(w));
  }
  if (used.size / said.size < 0.7) return null;        // lost part of what was said
  // Every date phrase of the plain split must still be in some task, word for word.
  const at = typeof now === "number" ? now : now.getTime();
  const lowTasks = tasks.map((t) => t.toLowerCase().replace(/\s+/g, " "));
  for (const piece of splitRamble(transcript, at, tz, opts)) {
    const p = parseTaskText(piece, at, tz, opts);
    for (const h of p?.hits ?? []) {
      const raw = h.raw.toLowerCase().replace(/\s+/g, " ").trim();
      if (raw && !lowTasks.some((t) => t.includes(raw))) return null;
    }
  }
  return tasks.slice(0, MAX_TASKS);
}

/** The tasks for the review list: the model's when they pass checkModelTasks, else the plain split. */
export function tasksFrom(transcript: string, model: unknown, now: number | Date, tz: string, opts: NlOpts = {}): { tasks: string[]; via: "model" | "split" } {
  const m = model == null ? null : checkModelTasks(model, transcript, now, tz, opts);
  return m ? { tasks: m, via: "model" } : { tasks: splitRamble(transcript, now, tz, opts), via: "split" };
}

// ---------------------------------------------------------------------------------------------------------------------
// The review list
// ---------------------------------------------------------------------------------------------------------------------
export interface ReviewItem { id: string; text: string; keep: string[] }
export interface ReviewState { items: ReviewItem[]; done: boolean; seq: number }
/** One row as it will be added: the title, the date words read by parseTaskText (null: no date), whether it can be added. */
export interface ReviewRow { id: string; text: string; parsed: ParsedTask | null; title: string; ok: boolean }

export const reviewStart = (tasks: string[]): ReviewState => ({
  items: tasks.slice(0, MAX_TASKS).map((t, i) => ({ id: `v${i + 1}`, text: t.slice(0, MAX_TASK_CHARS), keep: [] })),
  done: false, seq: tasks.length,
});

/** A row's meaning now: its words through the dates parser (the chip), the title that will be saved. */
export function reviewRow(it: ReviewItem, now: number | Date, tz: string, opts: NlOpts = {}, dates = true): ReviewRow {
  const text = it.text.replace(/[\s,;:.!?]+$/, "").trim();
  const p = text && dates ? parseTaskText(text, now, tz, { ...opts, keep: [...(opts.keep ?? []), ...it.keep] }) : null;
  const parsed = p && cleanSpoken(p.title) ? p : null;   // only a date: the words stay as the title, no chip
  const title = cleanSpoken(parsed ? parsed.title : text);
  return { id: it.id, text: it.text, parsed, title, ok: !!title };
}

export type ReviewAction =
  | { type: "edit"; id: string; text: string }
  | { type: "remove"; id: string }
  | { type: "keepWords"; id: string }        // the chip was clicked: this row's date words stay as text
  | { type: "addAll"; by: "click" | "enter" | "key" | "auto" };

/** What a review action does. `add` is non-empty ONLY for addAll by "click", once: a second click, an Enter, a key or
 *  anything automatic adds nothing. Rows that would have no title are left out. */
export function reviewStep(st: ReviewState, a: ReviewAction, now: number | Date, tz: string, opts: NlOpts = {}, dates = true): { st: ReviewState; add: ReviewRow[] } {
  if (st.done) return { st, add: [] };
  switch (a.type) {
    case "edit":
      return { st: { ...st, items: st.items.map((it) => (it.id === a.id ? { ...it, text: String(a.text ?? "").slice(0, MAX_TASK_CHARS), keep: [] } : it)) }, add: [] };
    case "remove":
      return { st: { ...st, items: st.items.filter((it) => it.id !== a.id) }, add: [] };
    case "keepWords": {
      return { st: { ...st, items: st.items.map((it) => {
        if (it.id !== a.id) return it;
        const r = reviewRow(it, now, tz, opts, dates);
        return r.parsed ? { ...it, keep: [...it.keep, ...r.parsed.hits.map((h) => h.raw.toLowerCase())] } : it;
      }) }, add: [] };
    }
    case "addAll": {
      if (a.by !== "click") return { st, add: [] };
      const rows = st.items.map((it) => reviewRow(it, now, tz, opts, dates)).filter((r) => r.ok);
      if (!rows.length) return { st, add: [] };
      return { st: { ...st, done: true }, add: rows };
    }
  }
}

export const reviewCount = (st: ReviewState, now: number | Date, tz: string, opts: NlOpts = {}, dates = true) =>
  st.items.reduce((n, it) => n + (reviewRow(it, now, tz, opts, dates).ok ? 1 : 0), 0);

// ---------------------------------------------------------------------------------------------------------------------
// The capture flow
// ---------------------------------------------------------------------------------------------------------------------
/** The microphone and speech permission, as the Mac reports it: "ready" both allowed, "ask" one not asked yet, "denied"
 *  one said no, "restricted" this Mac does not allow it. */
export type VoicePerm = "ready" | "ask" | "denied" | "restricted";
export interface VoiceStatus { supported: boolean; perm: VoicePerm; onDevice: boolean; lang: string }

export type VoicePhase =
  | "off"          // the shell has not said it can (website, phone, an older Mac build) or the switch is off
  | "idle"
  | "asking"       // the plain line is up and macOS is asking
  | "starting"
  | "recording"
  | "thinking"
  | "review";

export interface VoiceState {
  phase: VoicePhase;
  status: VoiceStatus | null;
  /** A plain line under the button: why it cannot listen, or what just happened. */
  note: string;
  /** When the button went down (for hold to talk), and whether this press is a hold. */
  downAt: number;
  held: boolean;
  level: number;
  partial: string;
  since: number;
  /** The split asked of the Mac, so a late answer to an older one is ignored. */
  ask: string;
  transcript: string;
  review: ReviewState | null;
  via: "model" | "split" | null;
}

export const voiceStart = (): VoiceState => ({ phase: "off", status: null, note: "", downAt: 0, held: false, level: 0, partial: "", since: 0, ask: "", transcript: "", review: null, via: null });

/** A press longer than this is "hold to talk": letting go stops. A shorter click keeps listening until Stop. */
export const HOLD_MS = 450;
/** How long the page waits for the model's split before it uses the plain split. */
export const SPLIT_WAIT_MS = 15000;

/** To the Mac shell (VoiceCapture.swift). */
export type VoiceOut =
  | { type: "voice:status" } | { type: "voice:ask" } | { type: "voice:start" } | { type: "voice:stop" } | { type: "voice:cancel" }
  | { type: "voice:split"; id: string; text: string } | { type: "voice:settings" };

/** From the Mac shell, the person and the clock. */
export type VoiceEvent =
  | { type: "status"; status: VoiceStatus; featureOn: boolean }
  | { type: "down"; at: number }                     // the microphone button pressed (mouse, key)
  | { type: "up"; at: number }                       // let go
  | { type: "stopClick" }                            // the Stop button
  | { type: "esc" }
  | { type: "perm"; perm: VoicePerm; onDevice: boolean }
  | { type: "started"; at: number }
  | { type: "level"; v: number }
  | { type: "partial"; text: string }
  | { type: "stopped"; reason: "user" | "limit" | "protected" | "error" | "cancel"; text: string; at: number }
  | { type: "blocked"; why: "protected" | "onDevice" | "perm" | "off" }
  | { type: "tasks"; id: string; tasks: unknown }    // the model's answer (null: no model)
  | { type: "splitTimeout"; id: string }
  | { type: "review"; a: ReviewAction }
  | { type: "settingsClick" };

/** `dates`: Dates in plain words is on (feature nl-dates); off, every task keeps its words and has no date. */
export interface VoiceCtx { now: number; tz: string; opts?: NlOpts; protectedFront?: boolean; dates?: boolean }

function noteFor(s: VoiceStatus): string {
  if (s.perm === "denied") return VOICE_WORDS.denied;
  if (s.perm === "restricted") return VOICE_WORDS.restricted;
  if (!s.onDevice) return VOICE_WORDS.noOnDevice(s.lang || "this language");
  return "";
}

/** One step of the capture flow. `out` are the messages for the Mac; `add` the rows to add now (only from Add all's click). */
export function voiceStep(st: VoiceState, e: VoiceEvent, c: VoiceCtx): { st: VoiceState; out: VoiceOut[]; add: ReviewRow[] } {
  const none = { out: [] as VoiceOut[], add: [] as ReviewRow[] };
  const idle = (note = ""): VoiceState => ({ ...st, phase: "idle", note, held: false, level: 0, partial: "", since: 0, review: null, via: null });
  switch (e.type) {
    case "status": {
      if (!e.featureOn || !e.status.supported) return { st: { ...voiceStart(), status: e.status }, ...none };
      const busy = st.phase === "recording" || st.phase === "starting" || st.phase === "thinking" || st.phase === "review";
      if (busy) return { st: { ...st, status: e.status }, ...none };
      return { st: { ...st, phase: "idle", status: e.status, note: st.phase === "asking" ? st.note : "" }, ...none };
    }
    case "down": {
      if (st.phase === "recording") return { st: { ...st, held: false }, out: [{ type: "voice:stop" }], add: [] };   // a click while listening stops
      if (st.phase !== "idle" || !st.status) return { st, ...none };
      const s = st.status;
      if (c.protectedFront) return { st: idle(VOICE_WORDS.protectedFront), ...none };
      if (s.perm === "ask") return { st: { ...st, phase: "asking", note: VOICE_WORDS.why }, out: [{ type: "voice:ask" }], add: [] };
      const why = noteFor(s);
      if (why) return { st: idle(why), ...none };
      return { st: { ...st, phase: "starting", note: "", downAt: e.at, held: true, level: 0, partial: "" }, out: [{ type: "voice:start" }], add: [] };
    }
    case "up": {
      // Let go after a hold: stop. A short click: keep listening until Stop.
      if ((st.phase === "recording" || st.phase === "starting") && st.held) {
        if (e.at - st.downAt >= HOLD_MS) return { st: { ...st, held: false }, out: [{ type: "voice:stop" }], add: [] };
        return { st: { ...st, held: false }, ...none };
      }
      return { st, ...none };
    }
    case "stopClick":
      if (st.phase === "recording" || st.phase === "starting") return { st, out: [{ type: "voice:stop" }], add: [] };
      return { st, ...none };
    case "perm": {
      const status: VoiceStatus = { ...(st.status ?? { supported: true, lang: "" }), perm: e.perm, onDevice: e.onDevice } as VoiceStatus;
      if (e.perm === "ready" && e.onDevice) return { st: { ...idle(VOICE_WORDS.ready), status }, ...none };
      return { st: { ...idle(noteFor(status) || VOICE_WORDS.denied), status }, ...none };
    }
    case "started":
      if (st.phase !== "starting") return { st, out: [{ type: "voice:cancel" }], add: [] };   // closed or Esc'd before it began
      return { st: { ...st, phase: "recording", since: e.at }, ...none };
    case "level":
      if (st.phase !== "recording") return { st, ...none };
      return { st: { ...st, level: Math.max(0, Math.min(1, Number(e.v) || 0)) }, ...none };
    case "partial":
      if (st.phase !== "recording") return { st, ...none };
      return { st: { ...st, partial: String(e.text ?? "").slice(0, MAX_TRANSCRIPT) }, ...none };
    case "stopped": {
      if (st.phase !== "recording" && st.phase !== "starting") return { st, ...none };
      const text = String(e.text ?? "").slice(0, MAX_TRANSCRIPT).trim();
      const say = e.reason === "protected" ? VOICE_WORDS.protectedStop : e.reason === "limit" ? VOICE_WORDS.limit : e.reason === "error" ? VOICE_WORDS.failed : "";
      if (e.reason === "cancel") return { st: idle(), ...none };
      if (!text) return { st: idle(say || VOICE_WORDS.nothing), ...none };
      const id = `s${e.at}`;
      return { st: { ...st, phase: "thinking", note: say, held: false, level: 0, partial: "", ask: id, transcript: text }, out: [{ type: "voice:split", id, text }], add: [] };
    }
    case "blocked": {
      const note = e.why === "protected" ? VOICE_WORDS.protectedFront : e.why === "onDevice" ? VOICE_WORDS.noOnDevice(st.status?.lang || "this language")
        : e.why === "perm" ? VOICE_WORDS.denied : "";
      if (e.why === "off") return { st: { ...voiceStart(), status: st.status }, ...none };
      return { st: idle(note), ...none };
    }
    case "tasks":
    case "splitTimeout": {
      if (st.phase !== "thinking" || e.id !== st.ask) return { st, ...none };   // a late answer to an older recording
      const r = tasksFrom(st.transcript, e.type === "tasks" ? e.tasks : null, c.now, c.tz, c.opts);
      if (!r.tasks.length) return { st: idle(VOICE_WORDS.nothing), ...none };
      return { st: { ...st, phase: "review", review: reviewStart(r.tasks), via: r.via }, ...none };
    }
    case "review": {
      if (st.phase !== "review" || !st.review) return { st, ...none };
      const r = reviewStep(st.review, e.a, c.now, c.tz, c.opts, c.dates ?? true);
      if (r.add.length) return { st: idle(VOICE_WORDS.added(r.add.length)), out: [], add: r.add };
      return { st: { ...st, review: r.st }, ...none };
    }
    case "esc": {
      if (st.phase === "recording" || st.phase === "starting") return { st: idle(), out: [{ type: "voice:cancel" }], add: [] };
      if (st.phase === "thinking" || st.phase === "review" || st.phase === "asking" || st.note) return { st: idle(), ...none };
      return { st, ...none };
    }
    case "settingsClick":
      return { st, out: [{ type: "voice:settings" }], add: [] };
  }
}

/** True while the voice part has something open that Esc should close first (before the Add task window itself). */
export const voiceHoldsEsc = (st: VoiceState) => st.phase === "recording" || st.phase === "starting" || st.phase === "thinking" || st.phase === "review" || st.phase === "asking" || !!st.note;

/** The calm level meter: five bars, the middle tallest, each 0.15 to 1 of its height. Reduced motion: one still bar set. */
export function meterBars(level: number, reduced = false): number[] {
  const v = Math.max(0, Math.min(1, Number(level) || 0));
  const shape = [0.55, 0.8, 1, 0.8, 0.55];
  if (reduced) return shape.map(() => (v > 0.05 ? 0.5 : 0.15));
  return shape.map((k) => Math.round((0.15 + 0.85 * v * k) * 100) / 100);
}

/** The two soft sounds (made in code, like every PS sound; the Mac plays its own copy, Sfx.swift "voice-start" and
 *  "voice-stop", the same numbers): a small rising pair as it starts listening, the same falling as it stops. wave 0 sine. */
export const VOICE_TONES: Record<"start" | "stop", { f: number; to?: number; dur: number; peak: number; wave: 0 | 1; at: number }[]> = {
  start: [{ f: 660, dur: 0.12, peak: 0.06, wave: 0, at: 0 }, { f: 990, dur: 0.18, peak: 0.055, wave: 0, at: 0.07 }],
  stop: [{ f: 990, dur: 0.12, peak: 0.05, wave: 0, at: 0 }, { f: 660, dur: 0.2, peak: 0.05, wave: 0, at: 0.07 }],
};

/** "0:07", "1:42": how long it has been listening. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
