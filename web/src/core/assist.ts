// The Settings assistant (PS 1.65, request of the developer's AI, 17 Nov 2026): a small bot that finds a setting, shows where it
// lives, walks you to it and, when you say "Do it", changes it. This file is the pure part (no React, no DOM, no clock):
//  - the tool layer over core/settingsindex.ts: find, show, change, each with the values that are allowed,
//  - the digest the Mac's AI is given (the settings list and nothing else, nothing from the vault),
//  - the re-check of every answer (an AI may only pick from the list it was given, the page drops anything else),
//  - the confirm step's words, the simple fallback (no AI: match words like Settings search),
//  - the outside step guides (WhatsApp), which never ask for a password or a key.
// views/Assistant.tsx draws it, src/assist.ts keeps the state and talks to the Mac, core/assistwalk.ts is the guided walk.
// Tests: tests/assist.test.ts and tests/assistwalk.test.ts.
import { groupById, landingOf, norm, searchSettings, settingById, stem, visibleTo, SETTINGS, type Ctx, type SetEntry } from "./settingsindex.ts";
import type { Settings } from "./model.ts";
import { META_APPS, META_BUSINESS } from "./wasetup.ts";

export const ASSIST_FEATURE = "settings-assistant";
/** Words that mean the person is giving a password, key, token or code: a guide never asks for one, an answer that does is dropped. */
const SECRET_ASK = /\b(password|passcode|passphrase|secret|api key|access token|token|private key|pin)\b/i;
const DASHES = /[–—]/g;
/** Any text from outside (an AI, a person) that will be shown: no dashes, one line, short, no markup. */
export function cleanSay(v: unknown, max = 240): string {
  if (typeof v !== "string") return "";
  return v.replace(DASHES, ", ").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

// ---------- the switches this assistant has itself (saved with the person's other settings, settings.assistant) ----------
export interface AssistPrefs { on: boolean; pop: boolean }
export function assistPrefs(v: unknown): AssistPrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  return { on: o.on !== false, pop: o.pop !== false };
}
export type AiPick = "apple" | "claude" | "chatgpt";
export const PICKS: AiPick[] = ["apple", "claude", "chatgpt"];
export const PICK_NAME: Record<AiPick, string> = { apple: "Apple (on this Mac)", claude: "Claude", chatgpt: "ChatGPT" };

// ---------- what may be changed ----------
/** One setting the assistant may change. Everything else it can only find, show and walk to. */
export interface ChangeSpec {
  kind: "toggle" | "choice" | "number";
  /** choice: the allowed values. */
  values?: readonly number[];
  /** number: the allowed range (whole numbers). */
  min?: number; max?: number; unit?: string;
  read: (s: Settings) => boolean | number;
  patch: (s: Settings, v: boolean | number) => Partial<Settings>;
}
const flag = (v: unknown, d = true) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const post = (k: "on", d = true): Pick2 => ({ read: (s) => flag(s.posture?.[k], d), patch: (s, v) => ({ posture: { ...s.posture, [k]: v as boolean } }) });
type Pick2 = Omit<ChangeSpec, "kind">;
const pomoT = (k: "on" | "auto" | "sound"): Pick2 => ({ read: (s) => flag(s.pomodoro?.[k]), patch: (s, v) => ({ pomodoro: { ...s.pomodoro, [k]: v as boolean } }) });
const pomoN = (k: "work" | "short" | "long" | "rounds", d: number): Pick2 => ({ read: (s) => num(s.pomodoro?.[k], d), patch: (s, v) => ({ pomodoro: { ...s.pomodoro, [k]: v as number } }) });
const standT = (k: "on" | "sound"): Pick2 => ({ read: (s) => flag(s.standup?.[k]), patch: (s, v) => ({ standup: { ...s.standup, [k]: v as boolean } }) });
/** A switch that is on unless it was switched off (core/offswitches.ts onUnlessOff). */
const plain = (k: "psPresence" | "taskHistory" | "squadAutoJoin" | "tipsShow" | "tmTypedPrio"): Pick2 => ({ read: (s) => s[k] !== false, patch: (_s, v) => ({ [k]: v as boolean }) });
const chk = (k: "on" | "sound"): Pick2 => ({ read: (s) => flag(s.chkRemind?.[k]), patch: (s, v) => ({ chkRemind: { on: true, every: 120, sound: true, ...s.chkRemind, [k]: v as boolean } }) });

export const CHANGEABLE: Record<string, ChangeSpec> = {
  "posture-on": { kind: "toggle", ...post("on") },
  "posture-every": { kind: "choice", values: [30, 45, 60, 90], unit: "minutes", read: (s) => num(s.posture?.every, 45), patch: (s, v) => ({ posture: { ...s.posture, every: v as number } }) },
  "chk-on": { kind: "toggle", ...chk("on") },
  "chk-every": { kind: "choice", values: [30, 45, 60, 90, 120, 180, 240, 360, 480, 720], unit: "minutes", read: (s) => num(s.chkRemind?.every, 120), patch: (s, v) => ({ chkRemind: { on: true, sound: true, ...s.chkRemind, every: v as number } }) },
  "chk-sound": { kind: "toggle", ...chk("sound") },
  "pomo-on": { kind: "toggle", ...pomoT("on") },
  "pomo-auto": { kind: "toggle", ...pomoT("auto") },
  "pomo-sound": { kind: "toggle", ...pomoT("sound") },
  "pomo-work": { kind: "number", min: 1, max: 180, unit: "minutes", ...pomoN("work", 25) },
  "pomo-short": { kind: "number", min: 1, max: 60, unit: "minutes", ...pomoN("short", 5) },
  "pomo-long": { kind: "number", min: 1, max: 120, unit: "minutes", ...pomoN("long", 15) },
  "pomo-rounds": { kind: "number", min: 1, max: 12, unit: "sessions", ...pomoN("rounds", 4) },
  "stand-on": { kind: "toggle", ...standT("on") },
  "stand-sound": { kind: "toggle", ...standT("sound") },
  "reply-in-panel": { kind: "toggle", read: (s) => s.replyInPanel !== false, patch: (_s, v) => ({ replyInPanel: v as boolean }) },
  // Plain switches saved with the other settings (each reads and saves exactly like its row in views/SettingsGroups.tsx).
  "ps-presence": { kind: "toggle", ...plain("psPresence") },
  "fuller-history": { kind: "toggle", ...plain("taskHistory") },
  "tips-show": { kind: "toggle", ...plain("tipsShow") },
  "typed-prio": { kind: "toggle", ...plain("tmTypedPrio") },
  "invert-swipe": { kind: "toggle", read: (s) => s.swipeInvert === true, patch: (_s, v) => ({ swipeInvert: v as boolean }) },
  "assist-pop": { kind: "toggle", read: (s) => assistPrefs(s.assistant).pop, patch: (s, v) => ({ assistant: { ...s.assistant, pop: v as boolean } }) },
};

/** The value, cleaned for that setting, or null when it is not allowed (never guessed, never rounded to something else). */
export function cleanValue(id: string, v: unknown): boolean | number | null {
  const sp = CHANGEABLE[id];
  if (!sp) return null;
  if (sp.kind === "toggle") return typeof v === "boolean" ? v : v === "on" || v === "true" ? true : v === "off" || v === "false" ? false : null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,4}$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n)) return null;
  if (sp.kind === "choice") return sp.values!.includes(n) ? n : null;
  return n >= sp.min! && n <= sp.max! ? n : null;
}
/** What the Settings list says is allowed, in words, for the AI and for the person. */
export function allowedWords(id: string): string | undefined {
  const sp = CHANGEABLE[id];
  if (!sp) return undefined;
  if (sp.kind === "toggle") return "on or off";
  if (sp.kind === "choice") return `one of ${sp.values!.join(", ")} ${sp.unit ?? ""}`.trim();
  return `a whole number from ${sp.min} to ${sp.max} ${sp.unit ?? ""}`.trim();
}
/** True when this setting can be changed by the assistant here (it is in the list for this person and has a rule). */
export function canChange(id: string, ctx: Ctx): boolean {
  const e = settingById(id);
  return !!e && !!CHANGEABLE[id] && visibleTo(e, ctx);
}

// ---------- the digest the AI gets (the Settings list only) ----------
/** One setting as the AI sees it. `can` is there only when the assistant may change it: "toggle" (true or false), "choice" (one of
 *  `values`) or "number" (a whole number inside `range`). `allowed` is the same in words. Nothing else: no value, nothing from the vault. */
export interface SettingDigest { id: string; group: string; name: string; line: string; words: string[]; can?: ChangeSpec["kind"]; values?: number[]; range?: [number, number]; allowed?: string }
export function digest(ctx: Ctx, list: SetEntry[] = SETTINGS): SettingDigest[] {
  return list.filter((e) => visibleTo(e, ctx) && !isProtectedWord(e)).map((e) => {
    const d: SettingDigest = { id: e.id, group: groupById(e.group).label, name: e.name, line: e.line, words: (e.words ?? []).slice(0, 12) };
    const sp = CHANGEABLE[e.id];
    if (sp) {
      d.can = sp.kind;
      if (sp.kind === "choice") d.values = [...sp.values!];
      if (sp.kind === "number") d.range = [sp.min!, sp.max!];
      d.allowed = allowedWords(e.id);
    }
    return d;
  });
}
/** Never hand an AI anything about 1Password or Signal (the PS rule): a setting that names them stays on the page. */
const PROTECTED = /1password|agilebits|signal/i;
function isProtectedWord(e: SetEntry): boolean { return PROTECTED.test(`${e.name} ${e.line} ${(e.words ?? []).join(" ")}`); }
export interface ToolSpec { name: string; line: string; args: Record<string, string> }
export const TOOLS: ToolSpec[] = [
  { name: "find_setting", line: "Find settings by words the person used. Returns up to 5 setting ids.", args: { query: "words" } },
  { name: "show_setting", line: "Show where one setting lives in Settings. Changes nothing.", args: { id: "a setting id from the list" } },
  { name: "change_setting", line: "Change one setting, only after the person says Do it. Only settings with allowed values.", args: { id: "a setting id from the list", value: "an allowed value" } },
];

// ---------- an answer, and its re-check ----------
export type PlanKind = "change" | "show" | "guide" | "none";
export interface Plan { kind: PlanKind; settingId?: string; value?: boolean | number; steps?: string[]; say: string; closest?: { settingId: string; say: string } }
export type Via = "apple" | "claude" | "chatgpt" | "simple";

/** The line shown for a change, built by the page from the list and the value, never taken from the AI. */
export function changeLine(id: string, value: boolean | number): string {
  const e = settingById(id), sp = CHANGEABLE[id];
  if (!e || !sp) return "";
  const g = groupById(e.group).label, where = norm(g) === norm(e.name) ? "" : ` (${g})`;   // never "Stand-up reminders (Stand-up reminders)"
  if (sp.kind === "toggle") return `Turn ${value ? "on" : "off"} "${e.name}"${where}.`;
  return `Set "${e.name}"${where} to ${value}${sp.unit ? ` ${sp.unit}` : ""}.`;
}
export const showLine = (id: string): string => { const e = settingById(id); return e ? `"${e.name}" is in ${pathOf(id)}.` : ""; };
/** "Settings, Posture Reminder, How often". A setting drawn inside another names its parent too. */
export function pathOf(id: string): string {
  const e = settingById(id);
  if (!e) return "Settings";
  const parts = ["Settings", groupById(e.group).label];
  const land = landingOf(e);
  if (land.id !== e.id) parts.push(land.name);
  parts.push(e.name);
  return parts.join(", ");
}

/** Check an answer from anywhere (the Mac's AI, a bridge message) against this person's list. Anything not on it is dropped. Returns
 *  a plan the page may show, and whether anything was dropped. The words of a change or a show are rebuilt from the list. */
export function recheck(raw: unknown, ctx: Ctx, list: SetEntry[] = SETTINGS): { plan: Plan; dropped: string[] } {
  const dropped: string[] = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const real = (id: unknown): SetEntry | undefined => (typeof id === "string" ? list.find((e) => e.id === id && visibleTo(e, ctx)) : undefined);
  let closest: Plan["closest"];
  if (o.closest && typeof o.closest === "object") {
    const c = o.closest as Record<string, unknown>, ce = real(c.settingId);
    if (ce) closest = { settingId: ce.id, say: cleanSay(c.say, 160) || ce.line };
    else dropped.push(`closest:${String(c.settingId)}`);
  }
  const say = cleanSay(o.say);
  const kind = o.kind === "change" || o.kind === "show" || o.kind === "guide" ? o.kind : "none";
  const e = real(o.settingId);
  if (kind !== "none" && !e) { dropped.push(`setting:${String(o.settingId)}`); return { plan: noneFrom(say, closest), dropped }; }
  if (kind === "change" && e) {
    const v = cleanValue(e.id, o.value);
    if (!CHANGEABLE[e.id]) { dropped.push(`change:${e.id}`); return { plan: { kind: "show", settingId: e.id, say: showLine(e.id), ...(closest ? { closest } : {}) }, dropped }; }
    if (v === null) { dropped.push(`value:${String(o.value)}`); return { plan: { kind: "show", settingId: e.id, say: showLine(e.id), ...(closest ? { closest } : {}) }, dropped }; }
    return { plan: { kind: "change", settingId: e.id, value: v, say: changeLine(e.id, v), ...(closest ? { closest } : {}) }, dropped };
  }
  if (kind === "show" && e) return { plan: { kind: "show", settingId: e.id, say: showLine(e.id), ...(closest ? { closest } : {}) }, dropped };
  if (kind === "guide" && e) {
    const g = OUTSIDE_GUIDES.find((x) => x.settingId === e.id);
    if (!g) { dropped.push(`guide:${e.id}`); return { plan: { kind: "show", settingId: e.id, say: showLine(e.id), ...(closest ? { closest } : {}) }, dropped }; }
    return { plan: { kind: "guide", settingId: e.id, steps: g.steps.map((s) => s.line), say: g.intro, ...(closest ? { closest } : {}) }, dropped };
  }
  if (!say) dropped.push("empty");
  return { plan: noneFrom(say, closest), dropped };
}
function noneFrom(say: string, closest?: Plan["closest"]): Plan {
  return { kind: "none", say: say && !SECRET_ASK.test(say) ? say : ASSIST_WORDS.nothing, ...(closest ? { closest } : {}) };
}

// ---------- the confirm step ----------
export type Button = "doit" | "show" | "cancel";
/** The buttons under a plan. Only a change has Do it. A guide has its own Next. Nothing at all changes until Do it is clicked. */
export function confirmButtons(plan: Plan): Button[] {
  if (plan.kind === "change") return ["doit", "show", "cancel"];
  if (plan.kind === "show") return ["show", "cancel"];
  return [];
}
/** What a click does: Do it on a change is a walk that changes (mode "do"); anything else is a walk that only shows. */
export function walkModeFor(plan: Plan, click: "do" | "show"): "do" | "show" {
  return click === "do" && plan.kind === "change" && plan.value !== undefined ? "do" : "show";
}

// ---------- the simple version (no AI, the website, the phone) ----------
export interface Match { id: string; name: string; group: string; line: string }
const ON_WORDS = /\b(turn on|switch on|enable|start|activate|on)\b/, OFF_WORDS = /\b(turn off|switch off|disable|stop|deactivate|kill|off)\b/;
/** A toggle word in the text: true for on, false for off, null for none or both. */
export function toggleWord(text: string): boolean | null {
  const t = norm(text);
  const on = ON_WORDS.test(t), off = OFF_WORDS.test(t);
  return on === off ? null : on;
}
/** The first whole number in the text (minutes: "1 hour" is 60), or null. */
export function numberWord(text: string): number | null {
  const t = norm(text);
  const m = /\b(\d{1,4})\s*(hours?|hrs?|h|minutes?|mins?|m)?\b/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] && /^h/.test(m[2]) ? n * 60 : n;
}
/** What the simple version does with a typed request: the best match as a plan (a change when the words say on, off or a number the
 *  setting allows, otherwise a show), plus the top matches as buttons. It never makes a change on its own either. */
const FILLER = new Set("them they their there this that these those with from get got have has need let lets just also all any some more much very really when while if its it's hide unhide turn switch set make change please can could you i me my want to would like the a an it on off enable disable stop start activate deactivate kill where is are how do does find show tell what for of in at every each every minutes minute mins min hours hour hrs hr h by and or so then now".split(" "));
/** The words of a request that name a setting: filler (turn, off, please, numbers, units) taken out. */
export function keywords(text: string): string[] {
  return norm(text).split(" ").filter((w) => w && !FILLER.has(w) && !/^\d+$/.test(w));
}
/** Settings found for a typed request: all its keywords together first, else each keyword on its own, best first. */
function findFor(text: string, ctx: Ctx, list: SetEntry[]) {
  const kw = keywords(text);
  if (!kw.length) return [];
  const all = searchSettings(kw.join(" "), ctx, list);
  if (all.length) return all;
  const seen = new Map<string, ReturnType<typeof searchSettings>[number]>();
  for (const k of kw) for (const h of searchSettings(k, ctx, list)) { const o = seen.get(h.e.id); if (!o || h.score > o.score) seen.set(h.e.id, h); }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}
export function simplePlan(text: string, ctx: Ctx, list: SetEntry[] = SETTINGS, pickId?: string): { plan: Plan; matches: Match[] } {
  const clean = cleanSay(text, 200);
  const kw = keywords(clean);
  // Search order first, then re-ranked by how many of the person's words each one carries, and whether it takes the number or the
  // on or off the person said ("posture reminder every 60 minutes" is How often, not the on switch).
  const num = numberWord(clean), tog = toggleWord(clean);
  const fit = (e: SetEntry): number => { const sp = CHANGEABLE[e.id]; if (!sp) return 0; if (num !== null && sp.kind !== "toggle") return cleanValue(e.id, num) !== null ? 0.6 : 0; return num === null && tog !== null && sp.kind === "toggle" ? 0.2 : 0; };
  const found = clean ? findFor(clean, ctx, list).slice(0, 8) : [];
  const hits = found.map((h, i) => ({ h, r: coverage(kw, h.e) + fit(h.e) - i * 0.01 })).sort((a, b) => b.r - a.r).map((x) => x.h).slice(0, 4);
  const matches = hits.map((h) => ({ id: h.e.id, name: h.e.name, group: groupById(h.e.group).label, line: h.e.line }));
  // A match the person clicked: that setting, never anything outside the list.
  const forced = pickId ? list.find((e) => e.id === pickId && visibleTo(e, ctx)) : undefined;
  if (pickId && !forced) return { plan: { kind: "none", say: ASSIST_WORDS.nothing }, matches };
  if (!hits.length && !forced) return { plan: { kind: "none", say: ASSIST_WORDS.nothing }, matches };
  // The simple version only answers when the best match carries at least half of the person's own words; a weaker match is no
  // setting at all (a feature request goes out) with that match offered as the closest thing.
  if (!forced && coverage(kw, hits[0].e) < 0.5) return { plan: { kind: "none", say: ASSIST_WORDS.nothing, closest: { settingId: hits[0].e.id, say: hits[0].e.line } }, matches };
  const top = forced ?? hits[0].e;
  const sp = CHANGEABLE[top.id];
  if (sp) {
    const v = sp.kind === "toggle" ? toggleWord(clean) : numberWord(clean);
    const cv = v === null ? null : cleanValue(top.id, v);
    if (cv !== null) return { plan: { kind: "change", settingId: top.id, value: cv, say: changeLine(top.id, cv) }, matches };
  }
  if (outsideGuideFor(top.id) && GUIDE_WORDS.test(norm(clean))) { const g = outsideGuideFor(top.id)!; return { plan: { kind: "guide", settingId: top.id, steps: g.steps.map((x) => x.line), say: g.intro }, matches }; }
  return { plan: { kind: "show", settingId: top.id, say: showLine(top.id) }, matches };
}
/** How many of the request's words a setting carries (in its name, line, group or search words), from 0 to 1. */
export function coverage(kw: string[], e: SetEntry): number {
  if (!kw.length) return 0;
  const toks = norm([e.name, e.line, groupById(e.group).label, ...(e.words ?? [])].join(" ")).split(" ");
  // A word counts when a word of the setting starts with it ("remind" in "reminder"), never inside another word ("sing" in "using").
  return kw.filter((k) => { const st = stem(k); return toks.some((t) => t.startsWith(st) || stem(t) === st); }).length / kw.length;
}
/** Words that ask for a setup, not a place ("set up WhatsApp", "connect", "link"). */
const GUIDE_WORDS = /\b(set ?up|setup|connect|link|install|add)\b/;
/** The closest thing to offer when nothing fits: the AI's own pick (already re-checked), else the best simple match, else nothing. */
export function closestFor(plan: Plan, matches: Match[], ctx: Ctx): Plan["closest"] {
  if (plan.closest && settingById(plan.closest.settingId) && visibleTo(settingById(plan.closest.settingId)!, ctx)) return plan.closest;
  const m = matches.find((x) => { const e = settingById(x.id); return !!e && visibleTo(e, ctx); });
  return m ? { settingId: m.id, say: m.line } : undefined;
}

// ---------- the island card (the Mac draws it; the page decides what it says) ----------
export type IslandState = "ask" | "thinking" | "answer" | "confirm" | "walk" | "done" | "error";
/** How long the page waits for the Mac at most. The Mac's own timeouts and fallbacks (AssistCore.swift) end well before this. */
export const PAGE_WAIT_MS = 75_000;
/** The assist:island message. Only fixed words, a re-checked line and the buttons the confirm step allows. vol 0 means silent. */
export function islandMsg(o: { show: boolean; state: IslandState; line?: string; buttons?: Button[]; vol: number; reduce: boolean }) {
  return {
    type: "assist:island" as const, show: o.show, state: o.state,
    ...(o.line ? { line: cleanSay(o.line, 200) } : {}),
    ...(o.state === "confirm" && o.buttons?.length ? { buttons: o.buttons.filter((b) => b === "doit" || b === "show" || b === "cancel") } : {}),
    vol: Math.max(0, Math.min(1, Number.isFinite(o.vol) ? o.vol : 0)), reduce: !!o.reduce,
  };
}

// ---------- outside steps (set up something outside PS) ----------
/** One outside step: its line, a page to open (`url`), or a place in PS to open (`open`, a setting id). */
export interface OutsideStep { line: string; url?: string; open?: string }
export interface OutsideGuide { settingId: string; intro: string; steps: OutsideStep[] }
/** Bigger setups where the steps happen outside PS: the assistant opens the right page and walks through the steps one at a time. It
 *  never does an outside step itself and never asks for a password or a key (those go into PS's own settings fields). */
export const OUTSIDE_GUIDES: OutsideGuide[] = [
  {
    // The same steps as PS's own Link WhatsApp guide (core/wasetup.ts waSteps), told in short. The parts with a code or a key stay in
    // that guide, which sends them to the person's own project and never into PS or this chat.
    settingId: "whatsapp",
    intro: "WhatsApp needs a few steps outside PS. I will walk you through them one at a time.",
    steps: [
      { line: "Pick a second phone number for PS. It must not be in a WhatsApp app yet." },
      { line: "Make a Meta app for WhatsApp, in a business portfolio of yours.", url: META_APPS },
      { line: "In the app, open WhatsApp, API setup, and add that second number. Meta sends it a code by text or call." },
      { line: "In Meta Business settings, add a system user and give it your app and your number.", url: META_BUSINESS },
      { line: "Now open Link WhatsApp in PS. It does the rest with live checks, and what Meta gives you goes to your own project, never into this chat.", open: "whatsapp" },
    ],
  },
];
export function outsideGuideFor(id: string): OutsideGuide | undefined { return OUTSIDE_GUIDES.find((g) => g.settingId === id); }
/** True when a line would ask for a password, key, token or code. */
export const asksForSecret = (line: string): boolean => SECRET_ASK.test(line);
/** True when typed text CARRIES a secret: a long key shaped string, a known key prefix, or "password is ...". Only words about
 *  a key ("where do I put the bot token") carry none: those are answered on this device by the simple version (assistRoute). */
export function holdsSecret(text: string): boolean {
  if (/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}|\b(?:ghp|gho|ghs|github_pat|xox[abprs])[-_A-Za-z0-9]{8,}|\bA[K]IA[A-Z0-9]{8,}|\bey[J][A-Za-z0-9_-]{10,}/.test(text)) return true;
  if (/[A-Za-z0-9_+/=-]{24,}/.test(text) && /\d/.test(text.match(/[A-Za-z0-9_+/=-]{24,}/)![0])) return true;
  return /\b(?:password|passcode|passphrase|pin|token|key|secret)\s*(?:is|=|:)\s*\S{3,}/i.test(text);
}
/** Where a typed request goes. "block": it holds a secret, nothing is sent anywhere, not even a feature request. "local": it is
 *  about a password, key or token (no value in it), so the simple version answers on this device and no feature request is made.
 *  "ai": the chosen AI (or the simple version when none is ready). */
export function assistRoute(text: string): "block" | "local" | "ai" {
  if (holdsSecret(text)) return "block";
  return asksForSecret(text) ? "local" : "ai";
}

// ---------- what the card says (every fixed word, for the owner to approve) ----------
export const ASSIST_WORDS = {
  title: "Settings assistant",
  ask: "What do you want to do?",
  send: "Ask",
  thinking: "Thinking",
  doIt: "Do it",
  showHow: "Show me how",
  cancel: "Cancel",
  next: "Next",
  done: "Done",
  nothing: "I could not find a setting for that.",
  botButton: "Settings assistant",
  matches: "Is it one of these?",
  orThese: "Or one of these?",
  waitClick: "Click the glowing control to finish.",
  guideOpen: "Open the page",
  guideInPs: "Open it in PS",
  guideNote: "I only show the steps. You do them, and I never need a password or a key.",
  done1: "Done.",
  shown: "That is where it is.",
  guideDone: "That is all the steps. Your setup is in your hands now.",
  wasAlready: "It was already like that.",
  notSaved: "I could not save that. Unlock PS and try again.",
  // feature request
  frSent: "Feature request submitted.",
  frCant: "I can't do this right now, but I can do this:",
  frNoClosest: "I can't do this right now.",
  frUndo: "Undo",
  frUndone: "Request taken back.",
  frKept: "Saved on this device. It goes out once your squad is updated.",
  frNoSquad: "Saved on this device. It goes out when you join a squad.",
  frSquad: "See the squad's requests",
  frRefresh: "Check for new ones",
  frCopy: "Copy all",
  frCopied: "Copied. Paste it to your AI.",
  frCopyFail: "Could not copy. Select the text and copy it.",
  frYours: "yours",
  frSquadEmpty: "No requests from the squad yet.",
  frSquadMissing: "The squad's list comes with the next squad update.",
  frSquadError: "Could not reach the squad. Try again in a moment.",
  // switches
  ready: "Ready",
  notReady: "Not ready",
  test: "Test",
  remove: "Remove key",
  usesKey: "Uses your saved key.",
  usesClaudeCli: "Uses your own Claude Code on this Mac.",
  usesCodexCli: "Uses your own Codex on this Mac.",
  setKey: "Save key",
  keyHint: "Paste a key. It goes straight to this Mac's Keychain and is never shown again.",
  sendsTo: { claude: "Requests go to Anthropic. Only your request and the settings list are sent.", chatgpt: "Requests go to OpenAI. Only your request and the settings list are sent." },
  appleOff: "Apple's model is not on yet. Turn on Apple Intelligence in System Settings. Until then I use the simple version.",
  frRowLine: "What you asked the assistant for that PS cannot do yet. Only your words and the part of Settings you were in.",
  setupAsk: "Not sure? Ask the Settings assistant",
  slow: "The AI took too long, so this is the simple version.",
  aiFailed: "The AI could not answer, so this is the simple version.",
  introHead: "New: the Settings assistant.",
  introAsk: "Tell it what you want and it finds the setting and takes you there.",
} as const;
