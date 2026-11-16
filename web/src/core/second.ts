// PS Second Computer (the developer, 31 Oct 2026: "like a second computer feature ... I can drop files to it, I can
// message myself stuff through the PS app. I can outsource stuff as well. Make it like a full outsource
// machine"). His M1 at home runs PS as a SECONDARY; his travelling M4 is the PRIMARY and sends it jobs,
// files and notes. Both Macs only talk outbound through his existing encrypted vault (the VPN app, no LAN, no
// open ports). The protocol is written down in the shared notes: second-computer/protocol.md.
//
// Trust: the vault is the transport, not the authority. A job runs on the M1 only when it carries an
// ECDSA P-256 signature from a primary that the M1's NATIVE trust store holds (Keychain keys, added only by
// a native alert the developer clicks after comparing the six digit code on both screens). The native side
// (ps-mac Second*.swift) is the gate that counts; this file holds the same rules in TypeScript so the
// panel can show what will happen, the CLI can check before sending, and the tests pin them down.
//
// Pure: no React, no vault, runs under `node --experimental-strip-types` (tests/second.test.ts).

const te = new TextEncoder();
const subtle = globalThis.crypto.subtle;
type Bytes = Uint8Array<ArrayBuffer>;

export type Role = "primary" | "secondary" | "none";
export type BodyType = "dev" | "pair" | "pairok" | "job" | "jobst" | "msg" | "file" | "ack" | "stat" | "cmd" | "idx" | "get";

/** A signed message. `body` is JSON text, parsed only after the signature checks out. */
export interface Env { body: string; sig: string; by: string }

export interface BodyBase { v: 1; t: BodyType; id: string; from: string; to: string; at: number }

export type JobType = "selftest" | "build" | "tests" | "claude" | "research" | "cancel";
export type TestPreset = "auto" | "node-tests" | "npm-test" | "swift-test" | "pytest" | "make-test";
export const TEST_PRESETS: TestPreset[] = ["auto", "node-tests", "npm-test", "swift-test", "pytest", "make-test"];

export interface BundleRef { project: string; file: string; head: string; base?: string }
export interface JobBody extends BodyBase { t: "job"; exp: number; type: JobType; args: Record<string, unknown>; bundles?: BundleRef[] }

export type JobState = "accepted" | "refused" | "queued" | "running" | "done" | "failed" | "cancelled" | "timeout";
export interface JobStatusBody extends BodyBase {
  t: "jobst"; job: string; state: JobState; reason?: string; startedAt?: number; endedAt?: number; exit?: number;
  step?: string; tail: string; summary?: string; files?: string[]; result?: string;
}
export interface StatBody extends BodyBase {
  t: "stat"; cpu: number; mem?: number; battery: number | null; charging: boolean; power: "ac" | "battery";
  busy: string | null; queue: number; have: Record<string, string>; disk?: number; app?: string; sleepSoon?: boolean;
  machine?: Machine;
}
/** What the Mac reports about itself (read only; PS never changes these). protocol.md section 13. */
export interface Machine {
  awake?: boolean; locked?: boolean; fileVault?: "on" | "off" | "unknown"; passwordImmediately?: boolean | null;
  /** The reboot helper's clock is in epoch SECONDS (deadline, lastWould, bootedAt, lastRestart.at); see machineMs. */
  timer?: { on?: boolean; hours: number; deadline: number | null; mode?: "off" | "watch" | "active"; asked?: string; live?: boolean; safeMode?: boolean; lastWould?: number;
    /** V1.28: the length in minutes (10 to 4320), seconds postponed so far, whether Postpone reaches its helper, whether it
     *  takes its settings from the main Mac (set), when the lock now running began, whether its helper has seen a sign in this
     *  boot (false: Before First Unlock, no timer), and its last three lock periods, newest first. */
    minutes?: number; postponed?: number; postpone?: boolean; set?: boolean; lockedAt?: number; signedIn?: boolean; periods?: LockPeriod[] };
  helper?: "approved" | "needs approval" | "not set up" | "missing";
  bootedAt?: number; lastRestart?: { at: number; kind: "restart" | "remote" | "shutdown" };
}
/** One lock period, as the restart helper writes it down (epoch seconds; ran in seconds). end: unlock, timer (it restarted
 *  the Mac), restart or shutdown (the developer's own), boot (the Mac started again some other way), changed (settings), off. */
export interface LockPeriod { lockedAt: number; endedAt: number; ran: number; end: string; postponed?: number; would?: number }
/** A helper time as epoch ms (it reports seconds; anything already in ms passes through). */
export const machineMs = (t: number | null | undefined): number | null => !t ? null : t < 1e11 ? t * 1000 : t;
/** Whether the auto reboot timer counts down: mode "active" (or the older on flag). */
export const timerOn = (m: Machine | null | undefined) => !!m?.timer && (m.timer.mode ? m.timer.mode === "active" : !!m.timer.on);
export interface FileBody extends BodyBase {
  t: "file"; name: string; size: number; sha256: string; mime: string; purpose: "user" | "bundle" | "result" | "share"; job?: string; get?: string; root?: string; dir?: string; chunk: number; n: number;
  /** v1.2: "zip" = a folder or package packed by PS (ditto), unpacked on landing with its names and dates. */
  pack?: "zip";
  /** v1.2: the file's modified date on the sending Mac (epoch ms), kept on landing. */
  m?: number;
}
export interface MsgBody extends BodyBase { t: "msg"; text: string; files?: string[] }
/** postpone (V1.28): the other Mac's auto reboot comes an hour later (at most 12 hours for one countdown).
 *  set:<mode>:<minutes> (V1.28, main Mac only): the other Mac's auto reboot settings, eg "set:active:1080" (10 to 4320). */
export type RebootSetMode = "off" | "watch" | "active";
export type CmdAction = "restart" | "shutdown" | "lock" | "cancel" | "postpone" | `set:${RebootSetMode}:${number}`;
export interface CmdBody extends BodyBase { t: "cmd"; exp: number; action: CmdAction }
export interface IdxEntry { p: string; d?: boolean; s: number; m: number; k?: "image" | "pdf" | "text" | "other" }
export interface IdxBody extends BodyBase { t: "idx"; root: string; name: string; entries: IdxEntry[] }
export interface GetBody extends BodyBase { t: "get"; root: string; path: string; as: "download" | "preview" }
export interface DevBody extends BodyBase { t: "dev"; name: string; model?: string; chip?: string; role: Role; pub: string; app?: string;
  /** v1.2: what this Mac takes in files. ncaps from its PS (native), wcaps from its page; a Mac streams only with both. */
  ncaps?: string[]; wcaps?: string[] }
export interface PairBody extends BodyBase { t: "pair" | "pairok"; primary: string; primaryPub: string; secondary: string; secondaryPub: string; names?: { p?: string; s?: string } }
export interface AckBody extends BodyBase { t: "ack"; ref: string; ok: boolean; reason?: string; path?: string }

// ---------- limits ----------
export const MB = 1024 * 1024;
export const FILE_MAX = 50 * MB;            // one file sent whole (31 Oct 2026: 25 MB at first, 50 MB with the shared folders)
export const WAITING_MAX = 100 * MB;        // in the vault at once, sent and not yet landed (the free plan database is 500 MB)
// v1.2, drag and drop (2 Nov 2026): a file streams through the vault 4 MB at a time, each chunk deleted as soon as
// the other Mac has it, so one file may be far bigger than what waits in the vault. Downloads count against the
// free plan's 5.5 GB of egress a month for ALL of PS, so Second Computer keeps to 2 GB a month for both Macs.
export const STREAM_MAX = 1024 * MB;        // one file or packed folder (ps-mac SecondOutbox.maxFile)
export const MONTH_MAX = 2048 * MB;         // all files sent by both Macs in one calendar month (UTC)
export const CHUNK = 4 * MB;                // one blobs row (about 5.6 MB of base64 text)
export const MSG_MAX = 4000;
export const PROMPT_MAX = 8000;
export const ONLINE_MS = 7 * 60_000;        // a stat every 5 minutes; two missed = offline
export const JOB_MAX_AGE = 24 * 3600_000;
export const FILE_MAX_AGE = 48 * 3600_000;
export const FUTURE_SKEW = 5 * 60_000;
export const TAIL_RUNNING = 4 * 1024;
export const TAIL_FINAL = 48 * 1024;
export const JOB_MINUTES: Record<Exclude<JobType, "cancel">, number> = { selftest: 40, build: 25, tests: 30, claude: 60, research: 60 };
export const CMD_MAX_AGE = 2 * 60_000;      // a restart or shut down command is good for 2 minutes
export const IDX_MAX = 5000;

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const AREA = /^[a-z0-9]{1,20}$/;
// A research title becomes a folder name on the M1: letters, digits, spaces and a little punctuation, no dots first.
const TITLE = /^[A-Za-z0-9][A-Za-z0-9 ,'()&+_-]{0,79}$/;

// ---------- pairing code ----------
/** The six digit code both Macs show while pairing ("123 456"). Same on both sides only if neither key was swapped. */
export async function pairCode(primaryPub: string, secondaryPub: string): Promise<string> {
  const h = new Uint8Array(await subtle.digest("SHA-256", te.encode(`ps-second-pair-v1\n${primaryPub}\n${secondaryPub}`)));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const s = String(n % 1_000_000).padStart(6, "0");
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

// ---------- keys and signatures (WebCrypto; the Macs use CryptoKit with the same bytes) ----------
function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Bytes {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const ALG = { name: "ECDSA", namedCurve: "P-256" } as const;
const SIG = { name: "ECDSA", hash: "SHA-256" } as const;

/** Tests, the dev page and fake data only: real device keys live in each Mac's Keychain. */
export async function makeKeys(): Promise<{ priv: CryptoKey; pub: string }> {
  const k = await subtle.generateKey(ALG, true, ["sign", "verify"]) as CryptoKeyPair;
  return { priv: k.privateKey, pub: b64(new Uint8Array(await subtle.exportKey("raw", k.publicKey))) };
}
export async function signBody(priv: CryptoKey, by: string, body: object): Promise<Env> {
  const text = JSON.stringify(body);
  const sig = new Uint8Array(await subtle.sign(SIG, priv, te.encode(text)));
  return { body: text, sig: b64(sig), by };
}
async function sigOk(pub: string, env: Env): Promise<boolean> {
  try {
    const key = await subtle.importKey("raw", unb64(pub), ALG, false, ["verify"]);
    const sig = unb64(env.sig);
    return sig.length === 64 && await subtle.verify(SIG, key, sig, te.encode(env.body));
  } catch { return false; }
}

export interface Peer { device: string; name?: string; pub: string; role: Role }
export type Check<T> = { ok: true; body: T } | { ok: false; reason: string };

/** The checks every Mac runs on a signed message before it acts on it (protocol.md section 3). */
export async function openEnv<T extends BodyBase>(env: unknown, o: {
  trusted: Peer[]; me: string; now: number; seen?: Set<string>; want?: BodyType[]; fromRole?: Role; maxAge?: number;
}): Promise<Check<T>> {
  const e = env as Env;
  if (!e || typeof e.body !== "string" || typeof e.sig !== "string" || typeof e.by !== "string" || e.body.length > 200_000) return { ok: false, reason: "Not signed" };
  const peer = o.trusted.find((p) => p.device === e.by);
  if (!peer) return { ok: false, reason: "Not signed by a paired Mac" };
  if (o.fromRole && peer.role !== o.fromRole) return { ok: false, reason: o.fromRole === "primary" ? "Not signed by your primary" : "Not signed by your secondary" };
  if (!(await sigOk(peer.pub, e))) return { ok: false, reason: "Signature does not match" };
  let b: T;
  try { b = JSON.parse(e.body) as T; } catch { return { ok: false, reason: "Unreadable" }; }
  if (!b || typeof b !== "object" || b.v !== 1) return { ok: false, reason: "Unknown version" };
  if (b.from !== e.by) return { ok: false, reason: "Sender does not match the signature" };
  if (o.want && !o.want.includes(b.t)) return { ok: false, reason: "Unexpected message" };
  if (b.to !== o.me && !(b.to === "all" && (b.t === "msg" || b.t === "stat"))) return { ok: false, reason: "Meant for another Mac" };
  if (typeof b.id !== "string" || !b.id || b.id.length > 64) return { ok: false, reason: "Bad id" };
  if (!Number.isFinite(b.at) || b.at > o.now + FUTURE_SKEW) return { ok: false, reason: "Clock is off" };
  // 30 days at most for everything else: the seen set only remembers 30 days, so an older envelope could be replayed.
  const maxAge = o.maxAge ?? (b.t === "job" ? JOB_MAX_AGE : b.t === "file" ? FILE_MAX_AGE : 30 * 86_400_000);
  if (o.now - b.at > maxAge) return { ok: false, reason: "Too old" };
  if (o.seen?.has(`${b.t}:${b.id}`)) return { ok: false, reason: "Seen before" };
  return { ok: true, body: b };
}

// ---------- jobs ----------
const has = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

/** The allowlist (protocol.md section 5). Anything not listed, or any extra argument, is refused. */
export function checkJob(b: JobBody, now = Date.now()): string | null {
  if (b.t !== "job") return "Not a job";
  if (!UUID.test(b.id)) return "Bad id";
  if (!Number.isFinite(b.exp) || b.exp < now) return "Too old";
  if (b.exp - b.at > JOB_MAX_AGE + 60_000) return "Bad arguments";
  const a = b.args;
  if (!a || typeof a !== "object" || Array.isArray(a)) return "Bad arguments";
  const bundles = b.bundles ?? [];
  if (!Array.isArray(bundles) || bundles.length > 3) return "Bad arguments";
  for (const x of bundles) {
    if (!x || !PROJECT.test(x.project) || !UUID.test(x.file) || !SHA.test(x.head) || (x.base !== undefined && !SHA.test(x.base))) return "Bad arguments";
  }
  const needs = (project: string, head: unknown) => typeof head === "string" && bundles.some((x) => x.project === project && x.head === head);
  switch (b.type) {
    case "selftest":
    case "build": {
      if (!has(a, b.type === "selftest" ? ["mac", "web", "only"] : ["mac", "web", "send"])) return "Bad arguments";
      if (!SHA.test(String(a.mac)) || !SHA.test(String(a.web))) return "Bad arguments";
      if (b.type === "selftest" && a.only !== undefined && !AREA.test(String(a.only))) return "Bad arguments";
      if (b.type === "build" && a.send !== undefined && typeof a.send !== "boolean") return "Bad arguments";
      if (!needs("ps-mac", a.mac) || !needs("web", a.web)) return "Code bundle missing";
      return null;
    }
    case "tests": {
      if (!has(a, ["project", "head", "preset"])) return "Bad arguments";
      if (!PROJECT.test(String(a.project)) || !SHA.test(String(a.head)) || !TEST_PRESETS.includes(a.preset as TestPreset)) return "Bad arguments";
      if (!needs(String(a.project), a.head)) return "Code bundle missing";
      return null;
    }
    case "claude": {
      if (!has(a, ["project", "head", "prompt", "model", "minutes"])) return "Bad arguments";
      if (!PROJECT.test(String(a.project)) || !SHA.test(String(a.head))) return "Bad arguments";
      if (typeof a.prompt !== "string" || !a.prompt.trim() || a.prompt.length > PROMPT_MAX) return "Bad arguments";
      if (a.model !== undefined && a.model !== "opus" && a.model !== "sonnet") return "Bad arguments";
      if (a.minutes !== undefined && !(Number.isInteger(a.minutes) && (a.minutes as number) >= 5 && (a.minutes as number) <= 60)) return "Bad arguments";
      if (!needs(String(a.project), a.head)) return "Code bundle missing";
      return null;
    }
    case "research": {
      if (!has(a, ["prompt", "title", "model", "minutes"]) || bundles.length) return "Bad arguments";
      if (typeof a.prompt !== "string" || !a.prompt.trim() || a.prompt.length > PROMPT_MAX) return "Bad arguments";
      if (typeof a.title !== "string" || !TITLE.test(a.title)) return "Bad arguments";
      if (a.model !== undefined && a.model !== "opus" && a.model !== "sonnet") return "Bad arguments";
      if (a.minutes !== undefined && !(Number.isInteger(a.minutes) && (a.minutes as number) >= 5 && (a.minutes as number) <= 60)) return "Bad arguments";
      return null;
    }
    case "cancel":
      if (!has(a, ["job"]) || !UUID.test(String(a.job)) || bundles.length) return "Bad arguments";
      return null;
    default:
      return "Unknown job type";
  }
}

/** Open and check a job on the secondary: signed by a paired PRIMARY, meant for this Mac, on the allowlist. */
export async function acceptJob(env: unknown, o: { trusted: Peer[]; me: string; now: number; seen?: Set<string>; myRole: Role }): Promise<Check<JobBody>> {
  if (o.myRole !== "secondary") return { ok: false, reason: "Not set as a secondary" };
  const r = await openEnv<JobBody>(env, { ...o, want: ["job"], fromRole: "primary" });
  if (!r.ok) return r;
  const bad = checkJob(r.body, o.now);
  return bad ? { ok: false, reason: bad } : r;
}

// ---------- remote machine commands (protocol.md section 13; the reboot session runs them) ----------
export const CMD_ACTIONS: CmdAction[] = ["restart", "shutdown", "lock", "cancel", "postpone"];
/** "set:active:1080" as its mode and minutes (10 to 4320, no leading zero), or null (the same rule as ps-mac
 *  SecondIdentity.autoRebootSet). */
export function rebootSet(a: string): { mode: RebootSetMode; minutes: number } | null {
  const m = /^set:(off|watch|active):([1-9]\d{1,3})$/.exec(a);
  const n = m ? Number(m[2]) : 0;
  return m && n >= 10 && n <= 4320 ? { mode: m[1] as RebootSetMode, minutes: n } : null;
}
export const cmdAction = (a: string): a is CmdAction => (CMD_ACTIONS as string[]).includes(a) || !!rebootSet(a);
/** Open a restart / shut down / lock command: signed by a paired primary (or an enrolled phone), for this Mac, 2 minutes. */
export async function acceptCmd(env: unknown, o: { trusted: Peer[]; me: string; now: number; seen?: Set<string> }): Promise<Check<CmdBody>> {
  const r = await openEnv<CmdBody>(env, { ...o, want: ["cmd"], maxAge: CMD_MAX_AGE });
  if (!r.ok) return r;
  const signer = o.trusted.find((p) => p.device === (env as Env).by);
  if (!signer || (signer.role !== "primary" && signer.role !== ("phone" as Role))) return { ok: false, reason: "Not signed by your primary" };
  const b = r.body;
  if (!cmdAction(b.action)) return { ok: false, reason: "Unknown command" };
  if (rebootSet(b.action) && signer.role !== "primary") return { ok: false, reason: "Not signed by your primary" };   // only the main Mac chooses its settings
  if (!Number.isFinite(b.exp) || b.exp < o.now || b.exp - b.at > CMD_MAX_AGE + 1000) return { ok: false, reason: "Too old" };
  if (Object.keys(b).some((k) => !["v", "t", "id", "from", "to", "at", "exp", "action"].includes(k))) return { ok: false, reason: "Bad arguments" };
  return r;
}

// ---------- shared folders (protocol.md section 15) ----------
/** A path inside a shared folder as the other Mac may ask for it: relative, no "..", no hidden parts, no oddities. */
export function sharePathOk(p: string): boolean {
  if (typeof p !== "string" || !p || p.length > 1024 || p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f]/.test(p)) return false;
  return p.split("/").every((x) => x.length > 0 && x !== "." && x !== ".." && !x.startsWith("."));
}
export function checkGet(b: GetBody): string | null {
  if (b.t !== "get") return "Not a request";
  if (typeof b.root !== "string" || !/^[a-z0-9-]{1,40}$/.test(b.root)) return "Bad arguments";
  if (!sharePathOk(b.path)) return "Bad arguments";
  if (b.as !== "download" && b.as !== "preview") return "Bad arguments";
  if (Object.keys(b).some((k) => !["v", "t", "id", "from", "to", "at", "root", "path", "as"].includes(k))) return "Bad arguments";
  return null;
}
/** ps://second/<device>/<root>/<path> links (they name a file; they grant nothing by themselves). */
export function shareLink(device: string, root: string, path: string): string {
  return `ps://second/${encodeURIComponent(device)}/${encodeURIComponent(root)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
export function parseShareLink(link: string): { device: string; root: string; path: string } | null {
  const m = /^ps:\/\/second\/([^/\s]+)\/([^/\s]+)\/(\S+)$/.exec(link.trim());
  if (!m) return null;
  try {
    const path = m[3].split("/").map(decodeURIComponent).join("/");
    const out = { device: decodeURIComponent(m[1]), root: decodeURIComponent(m[2]), path };
    return sharePathOk(path) && /^[a-z0-9-]{1,40}$/.test(out.root) ? out : null;
  } catch { return null; }
}
/** The folder tree of one shared root at `dir` ("" = the top): folders first, then files, A to Z. */
export function listDir(entries: IdxEntry[], dir: string): IdxEntry[] {
  const pre = dir ? dir + "/" : "";
  const seen = new Map<string, IdxEntry>();
  for (const e of entries) {
    if (!e.p.startsWith(pre) || e.p === dir) continue;
    const rest = e.p.slice(pre.length), slash = rest.indexOf("/");
    if (slash < 0) seen.set(rest, e);
    else { const name = rest.slice(0, slash); if (!seen.has(name)) seen.set(name, { p: pre + name, d: true, s: 0, m: e.m }); }
  }
  return [...seen.values()].sort((a, b) => (a.d === b.d ? a.p.localeCompare(b.p, undefined, { numeric: true, sensitivity: "base" }) : a.d ? -1 : 1));
}

export const JOB_LABEL: Record<JobType, string> = {
  selftest: "PS app self test", build: "Build PS app", tests: "Run tests", claude: "Claude task", research: "Research", cancel: "Stop a job",
};
export const DONE_STATES: JobState[] = ["refused", "done", "failed", "cancelled", "timeout"];
export const isDone = (s: JobState | undefined) => !!s && DONE_STATES.includes(s);

/** Cut a log to its last `max` bytes on a line break, so the vault never carries a huge record. */
export function tail(text: string, max: number): string {
  const b = te.encode(text);
  if (b.length <= max) return text;
  let s = new TextDecoder().decode(b.subarray(b.length - max));
  const nl = s.indexOf("\n");
  if (nl >= 0 && nl < 400) s = s.slice(nl + 1);
  return s.replace(/^�+/, "");
}

// ---------- files ----------
/** The month a send counts in ("2026-11", UTC). */
export const monthKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
/** Why a staged file cannot go to the other Mac (null when it can), in plain words for the developer.
 *  `stream`: the other Mac lands chunks as they come (v1.2); without it a file goes whole, 50 MB at most.
 *  `pack`: it unpacks folders; `month`: bytes both Macs sent this month. */
export function sendRefusal(size: number, o: { stream: boolean; pack: boolean; folder: boolean; month: number; peer: string }): string | null {
  if (!Number.isFinite(size) || size < 0) return "Cannot read that file.";
  if (size === 0) return "That file is empty.";
  const max = o.stream ? STREAM_MAX : FILE_MAX;
  if (size > max) return o.stream ? `Too big: ${fmtSize(size)}. The limit is ${fmtSize(STREAM_MAX)} a file or folder.`
    : `Too big for ${o.peer} as it is: ${fmtSize(size)}. It takes ${fmtSize(FILE_MAX)} a file until PS app is updated there (then up to ${fmtSize(STREAM_MAX)}).`;
  if (o.month + size > MONTH_MAX) return `That would pass this month's ${fmtSize(MONTH_MAX)} of Second Computer transfers (${fmtSize(o.month)} used). The free vault plan has about 5 GB of downloads a month for all of PS app.`;
  return null;
}
export type DropTarget = { kind: "files"; root?: string; dir?: string } | { kind: "msg" } | { kind: "alarm" };   // V1.47 alarm: audio files dropped on the alarm playlist (sleepmode/list.ts)
/** A drop place the page names to PS (ps-mac SecondDropZone.targetOk has the same rules). */
export function dropTargetOk(t: unknown): t is DropTarget {
  if (!t || typeof t !== "object") return false;
  const o = t as Record<string, unknown>, keys = Object.keys(o);
  if (o.kind === "msg" || o.kind === "alarm") return keys.length === 1;
  if (o.kind !== "files" || keys.some((k) => !["kind", "root", "dir"].includes(k))) return false;
  if (o.root !== undefined && (typeof o.root !== "string" || !/^[a-z0-9-]{1,40}$/.test(o.root))) return false;
  if (o.dir !== undefined && (typeof o.dir !== "string" || (o.dir !== "" && !sharePathOk(o.dir)))) return false;
  return true;
}
/** Why a file cannot be sent whole (null when it can). `waiting` = bytes already sent and not yet landed. */
export function fileRefusal(size: number, waiting: number): string | null {
  if (!Number.isFinite(size) || size < 0) return "Cannot read that file.";
  if (size === 0) return "That file is empty.";
  if (size > FILE_MAX) return `Too big: ${fmtSize(size)}. The limit is ${fmtSize(FILE_MAX)} a file.`;
  if (waiting + size > WAITING_MAX) return `Wait for the files on their way to land first (${fmtSize(waiting)} waiting, limit ${fmtSize(WAITING_MAX)}).`;
  return null;
}
export const chunkCount = (size: number) => Math.max(1, Math.ceil(size / CHUNK));

/** A safe name for ~/Downloads/From PS: no folders, no hidden files, no control characters, 120 characters at most. */
export function cleanName(name: string): string {
  let s = String(name ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f/\\:]/g, "-").replace(/^[.\s]+/, "").trim();
  if (s.length > 120) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : "";
    s = s.slice(0, 120 - ext.length) + ext;
  }
  return s || "file";
}
/** "report.pdf" taken: "report 2.pdf", then "report 3.pdf". */
export function freeName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 10_000; i++) { const n = `${stem} ${i}${ext}`; if (!taken(n)) return n; }
  return `${stem} ${Date.now()}${ext}`;
}
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  if (n >= 1024 * MB) return `${(n / (1024 * MB)).toFixed(n % (1024 * MB) ? 1 : 0)} GB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

// ---------- outsourcing from any chat (v1.3, 2 Nov 2026: the developer, "outsource these to the M1") ----------
// Research tasks go sealed to the second Mac (HPKE X-Wing, post-quantum, where both Macs run macOS 26; else P-256)
// and signed by the main Mac's Secure Enclave key; PS does all of it (ps-mac SecondSeal.swift, SecondOutsource.swift).
export const OJOB_MINUTES = 20, OJOB_MAX_MINUTES = 30, OJOB_MAX_RUNNING = 3;
/** Something that looks like a password, key or token (ps-mac SecondOJob.secret has the same patterns): never sent. */
export function looksSecret(s: string): string | null {
  const pats: [RegExp, string][] = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"], [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, "an API key"], [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
    [/\bgh[pousr]_[A-Za-z0-9]{30,}/, "a GitHub token"], [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"], [/\bAIza[0-9A-Za-z_-]{35}\b/, "a Google key"],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a login token"], [/\bsb_secret_[A-Za-z0-9_-]{10,}/, "a Supabase secret"],
    [/\b(password|passphrase|passwd)\s*[:=]\s*\S{4,}/i, "a password"],
  ];
  for (const [re, what] of pats) if (re.test(s)) return what;
  return null;
}
/** A research title from the first words of a task (ps-mac SecondOJob.title does the same). */
export function outsourceTitle(prompt: string): string {
  let t = prompt.replace(/[^A-Za-z0-9 ,'()&+_-]/g, " ").split(" ").filter(Boolean).slice(0, 9).join(" ").slice(0, 60).trim();
  t = t.replace(/^[^A-Za-z0-9]+/, "").replace(/[ ,'(&+_-]+$/, "");
  return t || "Research";
}
/** The suite in plain words for the developer. */
export const suiteWords = (s?: string) => s === "xwing" ? "X-Wing (ML-KEM-768 + X25519, post-quantum)" : s === "p256" ? "P-256 ECDH + AES-256-GCM (not post-quantum)" : "unknown";

// ---------- code bundles (the CLI and the panel) ----------
/** Paths that must never travel to the M1 inside a code bundle. */
export function secretPath(p: string): boolean {
  const s = p.replace(/\\/g, "/").toLowerCase();
  const base = s.split("/").pop() ?? "";
  return /^\.env(\..*)?$/.test(base) || /\.(key|pem|p12|keychain|mobileprovision)$/.test(base) || /^\.[a-z0-9-]*secret$/.test(base)   // dot files ending in "secret" (the public build never names the developer's own)
    || /(^|\/)(signing|private|\.cincee-gmail)\//.test(s) || /^(client_secret.*\.json|secrets?\.(json|ya?ml|env|txt)|.*\.secret)$/.test(base);
}

// ---------- status ----------
export function isOnline(stat: { at: number } | null | undefined, now = Date.now()): boolean {
  return !!stat && now - stat.at < ONLINE_MS && stat.at - now < FUTURE_SKEW;
}
/** "just now", "4 min ago", "14:32", "yesterday 09:10", "28 Oct". */
export function seenText(at: number | null | undefined, now = Date.now(), tz?: string): string {
  if (!at) return "never";
  const d = now - at;
  if (d < 90_000) return "just now";
  if (d < 60 * 60_000) return `${Math.round(d / 60_000)} min ago`;
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, ...o }).format(at);
  const day = (t: number) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const time = f({ hour: "2-digit", minute: "2-digit", hour12: false });
  if (day(at) === day(now)) return time;
  if (day(at) === day(now - 86_400_000)) return `yesterday ${time}`;
  return f({ day: "numeric", month: "short" });
}

// ---------- housekeeping ----------
export const KEEP_MSGS = 300;
export const JOB_KEEP_MS = 7 * 86_400_000;
export const FILE_KEEP_MS = 2 * 86_400_000;
/** Record ids to remove: jobs and statuses over 7 days, files 2 days after landing, all but the newest 300 notes. */
export function prune(o: {
  now: number;
  jobs: { id: string; at: number }[]; statuses: { id: string; job: string }[];
  msgs: { id: string; at: number }[]; files: { id: string; at: number; acked: boolean }[]; acks: { id: string; ref: string; at: number }[];
}): string[] {
  const out: string[] = [];
  const oldJobs = new Set(o.jobs.filter((j) => o.now - j.at > JOB_KEEP_MS).map((j) => j.id));
  for (const j of oldJobs) out.push(j);
  for (const s of o.statuses) if (oldJobs.has(s.job)) out.push(s.id);
  const live = new Set(o.jobs.map((j) => j.id));
  for (const s of o.statuses) if (!live.has(s.job) && !oldJobs.has(s.job)) out.push(s.id);   // a status whose job is gone
  const sorted = [...o.msgs].sort((a, b) => b.at - a.at);
  for (const m of sorted.slice(KEEP_MSGS)) out.push(m.id);
  const goneFiles = new Set<string>();
  for (const f of o.files) if ((f.acked && o.now - f.at > FILE_KEEP_MS) || o.now - f.at > FILE_MAX_AGE + FILE_KEEP_MS) { out.push(f.id); goneFiles.add(f.id); }
  for (const a of o.acks) if (goneFiles.has(a.ref) || o.now - a.at > FILE_MAX_AGE + FILE_KEEP_MS) out.push(a.id);
  return [...new Set(out)];
}
