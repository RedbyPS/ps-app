// The Soundboard (V1.47). The developer, 10 Nov 2026: "on the bottom right of the GOS app add a Soundboard button next to the
// Fitness and Dimension X buttons. It pops up full screen with all your audio and video files. A preview at the top
// right, with the option to move the preview to the top middle in a larger landscape view, and a full screen option, so
// you can watch a video in PS. When an audio or video is open, an option to set it to play at a time of day, say 7:07am.
// Very easily add new files: right click anywhere, Add new audio file, and Add folder to add a whole folder in batch.
// Stored locally, and you can change the storage location. If possible, a Share button to share it in the G Squad. A
// soundboard with files on screen, play them, skip tracks, and a queue of songs or videos or both."
//
// Pure rules here (tests/soundboard.test.ts): what a file is, a folder import, the queue (mixed audio and video,
// shuffle, repeat, reorder), the timed plays ("play at 7:07 am on these days") and sharing limits. No DOM, no clock,
// no storage. The page (src/soundboard/) draws and plays; each device keeps its own files: the Mac (ps-mac
// Sources/Soundboard.swift) and the phone (ps-gos Soundboard.kt) in a folder you can change, the website in the
// browser's own storage or a folder you pick. Files never go into the vault, so the Supabase egress does not move.
// The shells do the same timed play maths (ps-mac Soundboard.swift, ps-gos SbClock.kt).
import { wall, zonedToTs } from "./tz.ts";

// ---------- files ----------
export type MediaKind = "audio" | "video";
export const AUDIO_EXT = ["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "oga", "opus", "caf"] as const;
export const VIDEO_EXT = ["mp4", "m4v", "mov", "webm", "mkv", "3gp"] as const;
const AUDIO = new Set<string>(AUDIO_EXT), VIDEO = new Set<string>(VIDEO_EXT);
export const ACCEPT = [...AUDIO_EXT, ...VIDEO_EXT].map((e) => `.${e}`).join(",") + ",audio/*,video/*";
export const FILE_MAX = 4 * 1024 ** 3;         // one file: 4 GB
export const LIB_MAX = 5000;                   // files in the Soundboard
export const DEPTH_MAX = 4;                    // a folder import goes this deep
export const NAME_MAX = 120;
export const ID_RE = /^[0-9a-f]{16}$/;

/** "Song.MP3" -> "mp3"; no extension -> "". */
export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() || "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toLowerCase() : "";
}
export function kindOf(name: string): MediaKind | null {
  const e = extOf(name);
  return AUDIO.has(e) ? "audio" : VIDEO.has(e) ? "video" : null;
}
/** The display name: the file name without its extension, one line, at most NAME_MAX. */
export function baseName(name: string): string {
  const base = (name.split(/[\\/]/).pop() || "").replace(/[\u0000-\u001f\u007f]/g, "");
  const i = base.lastIndexOf(".");
  return oneLine(i > 0 ? base.slice(0, i) : base, NAME_MAX) || "Untitled";
}
export function oneLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f\u2013\u2014]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
const MIME: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", aif: "audio/aiff", aiff: "audio/aiff", flac: "audio/flac",
  ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/opus", caf: "audio/x-caf",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", "3gp": "video/3gpp",
};
export const mimeOf = (ext: string) => MIME[ext.toLowerCase()] || "application/octet-stream";

export interface MediaItem {
  id: string;        // 16 hex, stable for the file's life on this device
  name: string;      // display name
  ext: string;
  kind: MediaKind;
  size: number;      // bytes
  folder: string;    // "" or "Gym mix" or "Gym mix/Old" (the folder it was imported with)
  added: number;     // ms
}
export interface Lib { items: MediaItem[]; loc: { label: string; custom: boolean } }

export function cleanFolder(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.split(/[\\/]/).map((p) => oneLine(p, 60)).filter((p) => p && p !== "." && p !== ".." && !p.startsWith(".")).slice(0, DEPTH_MAX).join("/");
}
export function cleanItem(v: unknown): MediaItem | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id.toLowerCase() : "";
  const ext = typeof o.ext === "string" ? o.ext.toLowerCase().replace(/^\./, "") : "";
  const kind = AUDIO.has(ext) ? "audio" : VIDEO.has(ext) ? "video" : null;
  if (!ID_RE.test(id) || !kind) return null;
  const size = Number(o.size), added = Number(o.added);
  return {
    id, ext, kind,
    name: oneLine(o.name, NAME_MAX) || "Untitled",
    size: Number.isFinite(size) && size >= 0 ? Math.round(size) : 0,
    folder: cleanFolder(o.folder),
    added: Number.isFinite(added) && added > 0 ? Math.round(added) : 0,
  };
}
/** The shell's (or the browser store's) list, checked: known kinds, no id twice, at most LIB_MAX, newest first. */
export function cleanLib(v: unknown): Lib {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  for (const x of Array.isArray(o.items) ? o.items : []) {
    const it = cleanItem(x);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id); items.push(it);
    if (items.length >= LIB_MAX) break;
  }
  items.sort((a, b) => b.added - a.added || a.name.localeCompare(b.name));
  const l = (o.loc && typeof o.loc === "object" ? o.loc : {}) as Record<string, unknown>;
  return { items, loc: { label: oneLine(l.label, 120) || "This device", custom: l.custom === true } };
}

/** A name that is free in `taken` (lower case compare): "Song.mp3", then "Song 2.mp3", "Song 3.mp3". */
export function freeName(file: string, taken: Set<string>): string {
  const has = (n: string) => taken.has(n.toLowerCase());
  if (!has(file)) return file;
  const i = file.lastIndexOf(".");
  const stem = i > 0 ? file.slice(0, i) : file, ext = i > 0 ? file.slice(i) : "";
  for (let n = 2; n < 10000; n++) { const c = `${stem} ${n}${ext}`; if (!has(c)) return c; }
  return `${stem} ${Date.now()}${ext}`;
}

export interface Picked { path: string; size: number }   // a path relative to what was picked, "Mix/Old/a.mp3"
export interface ImportPlan { take: { path: string; folder: string; name: string; ext: string; kind: MediaKind; size: number }[]; skipped: number }
/** What a folder (or a set of files) brings in: audio and video only, no hidden files or folders, at most DEPTH_MAX
 *  folders deep, nothing over FILE_MAX, nothing empty, and never past LIB_MAX with what is there already. `root` is the
 *  picked folder's own name: its files land in that folder ("Gym mix", "Gym mix/Old"). Sorted by path. */
export function planImport(files: Picked[], root: string, have = 0): ImportPlan {
  const take: ImportPlan["take"] = [];
  let skipped = 0;
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  for (const f of sorted) {
    const parts = f.path.split(/[\\/]/).filter(Boolean);
    const file = parts.pop() || "";
    const kind = kindOf(file);
    if (!kind || file.startsWith(".") || parts.some((p) => p.startsWith(".")) || parts.length > DEPTH_MAX - (root ? 1 : 0)
      || !(f.size > 0) || f.size > FILE_MAX || have + take.length >= LIB_MAX) { skipped++; continue; }
    take.push({ path: f.path, folder: cleanFolder([root, ...parts].filter(Boolean).join("/")), name: baseName(file), ext: extOf(file), kind, size: f.size });
  }
  return { take, skipped };
}

/** 16 random hex characters. */
export function newId(rnd: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < 16; i++) s += Math.floor(rnd() * 16).toString(16);
  return s;
}

/** The folders, each with its parents, sorted ("Gym", "Gym/Old", "Sleep"). */
export function foldersOf(items: MediaItem[]): string[] {
  const out = new Set<string>();
  for (const it of items) {
    const parts = it.folder ? it.folder.split("/") : [];
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join("/"));
  }
  return [...out].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}
export type KindFilter = "all" | MediaKind;
/** What the grid shows: in `folder` (and its subfolders; "" is everything), of `kind`, matching every word of `q`. */
export function filterItems(items: MediaItem[], q: string, folder: string, kind: KindFilter): MediaItem[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((it) => (kind === "all" || it.kind === kind)
    && (!folder || it.folder === folder || it.folder.startsWith(folder + "/"))
    && words.every((w) => it.name.toLowerCase().includes(w) || it.folder.toLowerCase().includes(w) || it.ext === w));
}

export function sizeWords(bytes: number): string {
  if (!(bytes > 0)) return "0 KB";
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
/** 75 -> "1:15", 3725 -> "1:02:05". */
export function clock(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const s = Math.floor(secs), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

// ---------- the queue ----------
// Songs and videos mixed. `items` is the order you see (and reorder); `at` is the one playing (-1: none). Shuffle
// keeps `items` as it is and walks `order`, a shuffled copy made when shuffle is turned on (the one playing first).
export type Repeat = "off" | "all" | "one";
export interface QEntry { key: string; media: string }   // key: this place in the queue (the same file can be there twice)
export interface Queue { items: QEntry[]; at: number; shuffle: boolean; repeat: Repeat; order: number[] }
export const QUEUE_MAX = 500;
export const emptyQueue = (): Queue => ({ items: [], at: -1, shuffle: false, repeat: "off", order: [] });

export function cleanQueue(v: unknown): Queue {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const items: QEntry[] = [];
  const keys = new Set<string>();
  for (const x of Array.isArray(o.items) ? o.items : []) {
    const e = x as Record<string, unknown>;
    if (!e || typeof e.key !== "string" || typeof e.media !== "string" || !ID_RE.test(e.media) || !/^[0-9a-z]{1,24}$/.test(e.key) || keys.has(e.key)) continue;
    keys.add(e.key); items.push({ key: e.key, media: e.media });
    if (items.length >= QUEUE_MAX) break;
  }
  const at = Number.isInteger(o.at) && (o.at as number) >= 0 && (o.at as number) < items.length ? (o.at as number) : -1;
  const repeat: Repeat = o.repeat === "all" || o.repeat === "one" ? o.repeat : "off";
  const shuffle = o.shuffle === true;
  const ord = Array.isArray(o.order) ? o.order.filter((n): n is number => Number.isInteger(n)) : [];
  const valid = ord.length === items.length && new Set(ord).size === items.length && ord.every((n) => n >= 0 && n < items.length);
  return { items, at, shuffle, repeat, order: shuffle ? (valid ? ord : items.map((_, i) => i)) : [] };
}

let keySeq = 0;
export const qKey = (rnd: () => number = Math.random) => `${(++keySeq % 1296).toString(36)}${Math.floor(rnd() * 36 ** 6).toString(36)}`.slice(0, 12);

/** A shuffled order of 0..n-1 with `first` (if given) at the front. Fisher-Yates. */
export function shuffled(n: number, first: number, rnd: () => number = Math.random): number[] {
  const rest = [...Array(n).keys()].filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  return first >= 0 && first < n ? [first, ...rest] : rest;
}
/** Index changes in `items` carried into `order` (the shuffle walk): `map[old] = new` or -1 for removed. */
function remapOrder(q: Queue, map: number[], added: number[] = [], rnd: () => number = Math.random): number[] {
  if (!q.shuffle) return [];
  const out = q.order.map((i) => map[i]).filter((i) => i >= 0);
  // New entries join the part still to come, at random places.
  const pos = q.at >= 0 ? out.indexOf(map[q.at] ?? -1) : -1;
  for (const a of added) { const from = pos + 1, at = from + Math.floor(rnd() * (out.length - from + 1)); out.splice(at, 0, a); }
  return out;
}

/** Add to the end ("Add to queue"). Nothing playing: the first one added becomes the current one (not playing yet). */
export function enqueue(q: Queue, media: string[], rnd: () => number = Math.random): Queue {
  const room = Math.max(0, QUEUE_MAX - q.items.length);
  const add = media.filter((m) => ID_RE.test(m)).slice(0, room).map((m) => ({ key: qKey(rnd), media: m }));
  if (!add.length) return q;
  const items = [...q.items, ...add];
  const map = q.items.map((_, i) => i);
  const added = add.map((_, i) => q.items.length + i);
  return { ...q, items, at: q.at >= 0 ? q.at : q.items.length, order: q.shuffle ? remapOrder(q, map, added, rnd) : [] };
}
/** "Play next": right after the current one (or first). */
export function playNext(q: Queue, media: string, rnd: () => number = Math.random): Queue {
  if (!ID_RE.test(media)) return q;
  const e = { key: qKey(rnd), media };
  const pos = q.at >= 0 ? q.at + 1 : 0;
  const items = [...q.items.slice(0, pos), e, ...q.items.slice(pos)].slice(0, QUEUE_MAX);
  const map = q.items.map((_, i) => (i >= pos ? i + 1 : i));
  let order: number[] = [];
  if (q.shuffle) {
    order = q.order.map((i) => map[i]);
    const cur = q.at >= 0 ? order.indexOf(map[q.at]) : -1;
    order.splice(cur + 1, 0, pos);
  }
  return { ...q, items, at: q.at >= 0 ? q.at : 0, order };
}
/** A tap on a tile: plays now. Put right after the current one and jump to it (the rest of the queue stays). */
export function playNow(q: Queue, media: string, rnd: () => number = Math.random): Queue {
  const n = playNext(q, media, rnd);
  if (n === q) return q;
  const at = q.at >= 0 ? q.at + 1 : 0;
  return { ...n, at };
}
/** Play a whole list now (a folder's Play all): the queue becomes it, from `start`. */
export function playList(q: Queue, media: string[], start = 0, rnd: () => number = Math.random): Queue {
  const items = media.filter((m) => ID_RE.test(m)).slice(0, QUEUE_MAX).map((m) => ({ key: qKey(rnd), media: m }));
  if (!items.length) return { ...q, items: [], at: -1, order: [] };
  const at = Math.max(0, Math.min(items.length - 1, start));
  return { ...q, items, at, order: q.shuffle ? shuffled(items.length, at, rnd) : [] };
}
export function removeAt(q: Queue, key: string): Queue {
  const i = q.items.findIndex((e) => e.key === key);
  if (i < 0) return q;
  const items = q.items.filter((_, j) => j !== i);
  const map = q.items.map((_, j) => (j < i ? j : j === i ? -1 : j - 1));
  let at = q.at;
  if (q.at === i) at = items.length ? Math.min(i, items.length - 1) : -1;
  else if (q.at > i) at = q.at - 1;
  return { ...q, items, at, order: remapOrder(q, map) };
}
/** Drag in the queue: the entry `key` to place `to` (0 based, in the new order). The one playing stays the one playing. */
export function moveTo(q: Queue, key: string, to: number): Queue {
  const from = q.items.findIndex((e) => e.key === key);
  if (from < 0) return q;
  const dest = Math.max(0, Math.min(q.items.length - 1, to));
  if (dest === from) return q;
  const items = [...q.items];
  const [e] = items.splice(from, 1);
  items.splice(dest, 0, e);
  const map = q.items.map((x) => items.indexOf(x));
  return { ...q, items, at: q.at >= 0 ? map[q.at] : -1, order: q.shuffle ? q.order.map((i) => map[i]) : [] };
}
/** Clear everything but the one playing. */
export function clearQueue(q: Queue): Queue {
  if (q.at < 0) return { ...q, items: [], at: -1, order: [] };
  return { ...q, items: [q.items[q.at]], at: 0, order: q.shuffle ? [0] : [] };
}
/** Files that were removed from the Soundboard leave the queue too. */
export function dropGone(q: Queue, have: Set<string>): Queue {
  let n = q;
  for (const e of q.items) if (!have.has(e.media)) n = removeAt(n, e.key);
  return n;
}
export function setShuffle(q: Queue, on: boolean, rnd: () => number = Math.random): Queue {
  if (on === q.shuffle) return q;
  return { ...q, shuffle: on, order: on ? shuffled(q.items.length, q.at, rnd) : [] };
}
export const nextRepeat = (r: Repeat): Repeat => (r === "off" ? "all" : r === "all" ? "one" : "off");

/** The place after (step 1) or before (step -1) the current one, in play order. `ended`: the file finished by
 *  itself, so repeat one plays it again; a press of Next always moves on. -1: the end (repeat off). */
export function stepIndex(q: Queue, step: 1 | -1, ended = false): number {
  const n = q.items.length;
  if (!n) return -1;
  if (q.at < 0) return step === 1 ? (q.shuffle ? q.order[0] ?? 0 : 0) : -1;
  if (ended && q.repeat === "one") return q.at;
  const walk = q.shuffle ? q.order : q.items.map((_, i) => i);
  const pos = walk.indexOf(q.at);
  const p = pos + step;
  if (p >= 0 && p < walk.length) return walk[p];
  if (q.repeat === "off") return -1;
  return walk[(p + walk.length) % walk.length];
}
/** Moves to the next (or previous). At the end with repeat off it stays on the last one (and the page stops). */
export function step(q: Queue, dir: 1 | -1, ended = false, rnd: () => number = Math.random): { q: Queue; play: boolean } {
  const i = stepIndex(q, dir, ended);
  if (i < 0) return { q, play: false };
  // Repeat all with shuffle: a fresh shuffle each time round (never the same one twice in a row across it).
  if (q.shuffle && q.repeat === "all" && dir === 1 && q.order.indexOf(q.at) === q.order.length - 1) {
    let order = shuffled(q.items.length, -1, rnd);
    if (order.length > 1 && order[0] === q.at) order = [...order.slice(1), order[0]];
    return { q: { ...q, order, at: order[0] }, play: true };
  }
  return { q: { ...q, at: i }, play: true };
}
export const current = (q: Queue): QEntry | null => (q.at >= 0 ? q.items[q.at] ?? null : null);
/** What comes after the current one, in play order (the queue panel's "Up next"). */
export function upNext(q: Queue): QEntry[] {
  const walk = q.shuffle ? q.order : q.items.map((_, i) => i);
  const pos = walk.indexOf(q.at);
  return walk.slice(pos + 1).map((i) => q.items[i]);
}

// ---------- timed plays ----------
// "When an audio or video is open, an option to set it to play at a time of day, say 7:07am." On this device only,
// because the file is on this device. Each one: the file, a time, the days, how loud (the alarm level), once or loop.
export interface TimedPlay { id: string; media: string; name: string; at: string; days: number[]; vol: number; loop: boolean; on: boolean }
export const PLAYS_MAX = 50;
export const VOL_DEF = 0.8, VOL_MIN = 0.1;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];   // 0 Sunday to 6 Saturday
export const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const okTime = (v: unknown): v is string => typeof v === "string" && HM.test(v);
export const okDays = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b) : [];
export const okVol = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? Math.round(Math.max(VOL_MIN, Math.min(1, n)) * 100) / 100 : VOL_DEF; };

export function cleanPlay(v: unknown): TimedPlay | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[0-9a-z]{1,16}$/.test(o.id) || typeof o.media !== "string" || !ID_RE.test(o.media) || !okTime(o.at)) return null;
  const days = okDays(o.days);
  return { id: o.id, media: o.media, name: oneLine(o.name, NAME_MAX) || "Untitled", at: o.at, days: days.length ? days : ALL_DAYS, vol: okVol(o.vol), loop: o.loop === true, on: o.on !== false };
}
export function cleanPlays(v: unknown): TimedPlay[] {
  const out: TimedPlay[] = [];
  const ids = new Set<string>();
  for (const x of Array.isArray(v) ? v : []) { const p = cleanPlay(x); if (p && !ids.has(p.id)) { ids.add(p.id); out.push(p); } if (out.length >= PLAYS_MAX) break; }
  return out;
}

/** "7:07am", "7.07 pm", "19:07", "7am", "0707" -> "HH:MM" (24 hour), or null. Break-it 1.75 (the same gap as the Time zones box):
 *  a comma, a closing dot and "p.m." count too ("22,15", "22.15.", "9,30 p.m."). */
export function parseTime(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, "").replace(/([ap])\.m\.?$/, "$1m").replace(/^(\d{1,2}[.,:]\d{2})[.,]$/, "$1").replace(/[.,]/g, ":");
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (min > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; if (ap === "a") h = h === 12 ? 0 : h; else h = h === 12 ? 12 : h + 12; }
  else if (h > 23) return null;
  if (!m[2] && !ap && m[1].length > 2) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}
/** "07:07" -> "7:07am", "19:30" -> "7:30pm", "00:00" -> "12:00am" (the developer writes times as 7:07am). */
export function timeWords(hm: string): string {
  if (!okTime(hm)) return hm;
  const [h, m] = hm.split(":").map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
}
export function daysWords(days: number[]): string {
  const d = okDays(days);
  if (!d.length || d.length === 7) return "Every day";
  if (d.join() === "1,2,3,4,5") return "Weekdays";
  if (d.join() === "0,6") return "Weekends";
  return d.map((x) => DAY_NAMES[x]).join(", ");
}

const dayOf = (ts: number, tz: string) => { const w = wall(ts, tz); return `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`; };
const addDays = (day: string, n: number) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekday = (day: string) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
/** The next time it plays, strictly after `now`, in the device's time zone `tz`. -1 when it is off or has no days.
 *  A time that does not exist that day (the clocks went forward over it) plays as far after the jump as it was into the gap. */
export function nextFire(p: Pick<TimedPlay, "at" | "days" | "on">, now: number, tz: string): number {
  const days = okDays(p.days);
  if (!p.on || !okTime(p.at) || !days.length) return -1;
  const [h, m] = p.at.split(":").map(Number);
  const today = dayOf(now, tz);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(today, i);
    if (!days.includes(weekday(day))) continue;
    const [y, mo, d] = day.split("-").map(Number);
    const ts = zonedToTs(y, mo, d, h, m, tz);
    if (ts > now) return ts;
  }
  return -1;
}
/** The plays due in (from, to]: each at most once, earliest first (the page's own timer on the website, and after a
 *  sleeping laptop wakes: only what fell in the last LATE_MS still plays, nothing from hours ago). */
export const LATE_MS = 2 * 60_000;
export function dueBetween(plays: TimedPlay[], from: number, to: number, tz: string): { play: TimedPlay; at: number }[] {
  const out: { play: TimedPlay; at: number }[] = [];
  const start = Math.max(from, to - LATE_MS);
  for (const p of plays) { const t = nextFire(p, start, tz); if (t > 0 && t <= to) out.push({ play: p, at: t }); }
  return out.sort((a, b) => a.at - b.at);
}
/** The soonest of all plays after `now` (when the page's timer wakes next), or -1. */
export function soonest(plays: TimedPlay[], now: number, tz: string): number {
  let best = -1;
  for (const p of plays) { const t = nextFire(p, now, tz); if (t > 0 && (best < 0 || t < best)) best = t; }
  return best;
}
/** What the shell is handed (sb:plan): only plays that are on and whose file is still here. */
export function planFor(plays: TimedPlay[], have: Set<string>): { id: string; media: string; name: string; at: string; days: number[]; vol: number; loop: boolean }[] {
  return plays.filter((p) => p.on && have.has(p.media)).map(({ id, media, name, at, days, vol, loop }) => ({ id, media, name, at, days, vol, loop }));
}
/** A loop rings at most this long (like the alarms). */
export const LOOP_MAX_MS = 10 * 60_000;

// ---------- sharing in the G Squad ----------
// The hub is a free plan Supabase project: 500 MB of database for everything, 5 GB of egress a month. So only small
// audio files are shared, sealed with the squad key, and they leave the hub after SHARE_DAYS.
export const SHARE_MAX = 10 * 1024 ** 2;        // 10 MB
export const SHARE_DAYS = 14;
export const SHARE_PART = 512 * 1024;           // one sealed piece
export const SHARE_NOTE_MAX = 200;
export function canShare(it: Pick<MediaItem, "kind" | "size">): { ok: boolean; why: string } {
  if (it.kind !== "audio") return { ok: false, why: "Only audio files can be shared in the squad (videos are too big for the free hub). You can still share the name with a note." };
  if (it.size > SHARE_MAX) return { ok: false, why: `This file is ${sizeWords(it.size)}. Up to ${sizeWords(SHARE_MAX)} can be shared. You can still share the name with a note.` };
  return { ok: true, why: "" };
}
/** How many pieces a file of `size` bytes is split into. */
export const partsFor = (size: number) => Math.max(1, Math.ceil(size / SHARE_PART));

// ---------- this device's Soundboard prefs (local, never synced) ----------
export type View = "corner" | "wide" | "full";
export interface SbPrefs { plays: TimedPlay[]; queue: Queue; vol: number; muted: boolean; view: View; keep: boolean; kind: KindFilter; folder: string; at: number }
export const emptyPrefs = (): SbPrefs => ({ plays: [], queue: emptyQueue(), vol: 0.8, muted: false, view: "corner", keep: false, kind: "all", folder: "", at: 0 });
export function cleanPrefs(v: unknown): SbPrefs {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const vol = Number(o.vol);
  return {
    plays: cleanPlays(o.plays),
    queue: cleanQueue(o.queue),
    vol: Number.isFinite(vol) ? Math.max(0, Math.min(1, Math.round(vol * 100) / 100)) : 0.8,
    muted: o.muted === true,
    view: o.view === "wide" || o.view === "full" ? "wide" : "corner",   // full screen never comes back by itself
    keep: o.keep === true,
    kind: o.kind === "audio" || o.kind === "video" ? o.kind : "all",
    folder: cleanFolder(o.folder),
    at: Number.isFinite(Number(o.at)) ? Number(o.at) : 0,
  };
}
