// Second Computer: what the panel draws, worked out from the vault records (core/second.ts has the rules,
// store.ts moves the data). Pure: the main window and the floating Tab list both call it, the Tab list
// with the copy the main window hands it. Bodies are read here for DISPLAY only; whether anything runs or
// lands is decided by the native side after it checks the signature (protocol.md section 3).
import type { Doc } from "../core/model";
import { CHUNK, isDone, isOnline, monthKey, WAITING_MAX, type IdxBody, type IdxEntry, type Machine, type DevBody, type Env, type FileBody, type JobBody, type JobState, type JobStatusBody, type MsgBody, type Peer, type Role, type StatBody, type AckBody, type PairBody } from "../core/second.ts";

/** chip: eg "Apple M4"; chosen: the developer picked the role (false while it is the chip's starting role). Both from PS V1.25.
 *  okid: the id of this Mac's outsourcing keys (v1.3), so a new key is announced at once. */
export interface NativeInfo { device: string; name: string; model?: string; pub: string; role: Role; chip?: string; chosen?: boolean; app?: string; okid?: string }
/** An outsourced job as PS knows it after opening its sealed records (v1.3). Titles and reports live only in memory. */
export interface OJobInfo { job: string; title: string; state: JobState | "sent"; step?: string; reason?: string; summary?: string; suite: string; at: number;
  startedAt?: number; endedAt?: number; mine: boolean; report?: string; folder?: string }
/** PS could not start Second Computer on this Mac (no device key): what the other Mac is told. */
/** here: what this Mac's own panel says (V1.31), retried: the developer's Allow was already tried, allowing: the read is running. */
export interface OffInfo { why: string; name: string; model?: string; chip?: string; app?: string; here?: string; retried?: boolean; allowing?: boolean }
export interface Progress { id: string; name: string; size: number; done: number; total: number; dir: "up" | "down"; error?: string }
/** A file PS staged to send (drag and drop, protocol v1.2): ps-mac SecondOutbox's manifest. `target.kind`
 *  "files": to the other Mac (into its shared folder when root is set); "msg": attached to the note being written
 *  (held until it is sent); "get": a shared file the other Mac asked for. */
export interface OutItem {
  id: string; name: string; size: number; sha256: string; mime?: string; pack?: "zip"; m?: number; at: number; hold?: boolean; retried?: boolean;
  target: { kind: "files" | "msg" | "get"; root?: string; dir?: string; get?: string; to?: string };
}
/** What the main window knows beyond the records: this Mac (from PS), who it trusts, transfers in flight. */
export interface SecondLocal {
  native: boolean;
  me: NativeInfo | null;
  trusted: (Peer & { name?: string; at?: number })[];
  verified: string[];        // record ids whose signature checked out here
  progress: Progress[];
  projects: { name: string; path: string }[];
  pairing: string | null;    // device id while PS's pairing alert is up
  waitingSince: number | null;   // secondary: when "Waiting for your primary" began (pair alerts only then)
  note: string | null;       // the last plain message for the developer ("Sent", "Too big: ...")
  previewGets?: string[];    // requests asked as previews (their files stay out of the Files list)
  seeks?: string[];          // this Mac's own "looking for my other Mac" records still open (from PS, V1.26)
  off?: OffInfo | null;      // Second Computer is off on this Mac, and why
  outbox?: OutItem[];        // staged files waiting to go (v1.2)
  ojobs?: OJobInfo[];        // outsourced jobs (v1.3), from PS
  caps?: string[];           // what this Mac's PS can do with files (v1.2: outbox, stream, pack, drop)
}
export const EMPTY_LOCAL: SecondLocal = { native: false, me: null, trusted: [], verified: [], progress: [], projects: [], pairing: null, waitingSince: null, note: null };

export function parseEnv<T>(env: unknown): T | null {
  const e = env as Env | undefined;
  if (!e || typeof e.body !== "string") return null;
  try { return JSON.parse(e.body) as T; } catch { return null; }
}

export interface DeviceRow { device: string; name: string; model?: string; chip?: string; app?: string; off?: string; role: Role; pub: string; at: number; trusted: boolean; me: boolean; paired: boolean;
  /** Trusted by PS but no signed hello from it in the vault (a Mac still on a page older than V1.27 says none). */
  silent?: boolean;
  /** v1.2: it lands files as they stream (up to 1 GB) and unpacks folders; both its PS and its page must say so. */
  stream?: boolean; pack?: boolean;
  /** v1.3: it published outsourcing keys (sealed jobs) and which suite it can open best. */
  outsource?: boolean; xwing?: boolean }
export interface MsgRow { id: string; text: string; at: number; from: string; mine: boolean; phone: boolean; verified: boolean; files: string[] }
export interface ShareRoot { device: string; root: string; name: string; entries: IdxEntry[]; at: number; mine: boolean }
export interface FileRow { id: string; name: string; size: number; at: number; from: string; to: string; mine: boolean; purpose: FileBody["purpose"]; state: "sending" | "waiting" | "landed" | "failed"; reason?: string; path?: string; job?: string; pct?: number;
  /** v1.2: a folder (packed on the way); the vault is full of this file's chunks until the other Mac takes some. */
  folder?: boolean; stalled?: boolean }
export interface JobRow { id: string; type: JobBody["type"]; args: Record<string, unknown>; at: number; to: string; state: JobState | "sent"; status: JobStatusBody | null; updated: number;
  /** v1.3: sealed (outsourced from a chat): its suite, the report and where its copy is. */
  sealed?: { suite: string; report?: string; folder?: string } }
/** The starting role PS picks from the chip (ps-mac Second.startRole): an M1 is the second Mac, an M4 the main one. */
export function chipRole(chip?: string): Role | null {
  const c = (chip ?? "").trim();
  const fam = (f: string) => c === f || c.startsWith(f + " ");
  return fam("Apple M1") ? "secondary" : fam("Apple M4") ? "primary" : null;
}

/** One click pairing needs PS V1.26 on both Macs. */
export const ONE_CLICK_APP = 126;
export const appNum = (v?: string) => { const m = /^(\d+)\.(\d+)/.exec(v ?? ""); return m ? Number(m[1]) * 100 + Number(m[2]) : 0; };
/** A "looking for my other Mac" record lasts this long (ps-mac Second.swift freshSeeks). */
export const SEEK_LIFE = 24 * 3_600_000;
/** After this long without an answer the window says why. */
export const SEEK_WAIT = 30_000;

/** Where pairing stands (1 Nov 2026, the developer: "I just click pair, it scans to see if my M1 is online and connects
 *  for me"). idle: not paired, one Pair button. looking: Pair was clicked here and no other Mac has answered yet.
 *  waiting: this is the second Mac, waiting for Pair on the main Mac. paired. `other`: the newest other Mac. */
export type LinkStep = "idle" | "looking" | "waiting" | "paired";
export interface Link { step: LinkStep; other: DeviceRow | null; since: number | null }

/** Why the other Mac has not connected, in plain words; null when nothing stands in the way. */
export function blocker(o: DeviceRow | null, now: number): string | null {
  if (!o) return "Is PS app V1.26 or newer open and signed in on it? It pairs by itself once it is.";
  if (o.off) return `${o.name} runs PS app, but Second Computer is off there: ${o.off}.`;
  if (appNum(o.app) < ONE_CLICK_APP) return `${o.name} is on ${o.app ? `V${o.app}` : "an older PS app"}. Update PS app there first: it pairs by itself after.`;
  if (now - o.at > 10 * 60_000) return `${o.name} has not been on since ${new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(o.at)}. Open PS app on it and sign in: it pairs by itself.`;
  return null;
}

export interface SecondView {
  me: NativeInfo | null;
  role: Role;
  devices: DeviceRow[];
  /** The other Mac this panel is about: the paired secondary (on the primary) or the paired primary (on the secondary). */
  peer: DeviceRow | null;
  /** Secondaries that announced themselves and are not paired yet (primary side, for the Pair button). */
  unpaired: DeviceRow[];
  /** Phones that announced a restart key; trusted ones may send Restart, Shut down and Lock to this Mac (never jobs). */
  phones: DeviceRow[];
  stat: StatBody | null;
  /** This Mac's own newest status (its machine block shows on the Machine pane next to the other Mac's). */
  myStat: StatBody | null;
  machine: Machine | null;
  online: boolean;
  shares: ShareRoot[];
  msgs: MsgRow[];
  files: FileRow[];
  jobs: JobRow[];
  waitingBytes: number;
  /** Bytes both Macs sent this month (v1.2, the egress budget). */
  month: number;
  /** Files staged for the note being written (v1.2). */
  held: OutItem[];
  /** Every other Mac that announced itself (any role, or with Second Computer off), newest first. */
  others: DeviceRow[];
  link: Link;
}

export function secondView(docs: Doc[], local: SecondLocal, now = Date.now()): SecondView {
  const me = local.me;
  const verified = new Set(local.verified);
  const trusted = new Map(local.trusted.map((t) => [t.device, t]));
  const of = (k: string) => docs.filter((d) => d.kind === k);

  // Devices: the newest announcement per device.
  const devMap = new Map<string, DeviceRow>();
  const phones: DeviceRow[] = [];
  for (const d of of("sdev")) {
    // A phone announces itself UNSIGNED (its key signs only after a fingerprint): it is trusted only by a native alert on each Mac.
    const ph = d.data as { phone?: boolean; device?: string; pub?: string; name?: string; at?: number };
    if (ph.phone) {
      if (typeof ph.device === "string" && typeof ph.pub === "string" && ph.device.length <= 64 && ph.pub.length <= 200)
        phones.push({ device: ph.device, name: String(ph.name || "Phone").slice(0, 60), role: "phone" as Role, pub: ph.pub, at: Number(ph.at) || 0, trusted: trusted.has(ph.device), me: false, paired: trusted.has(ph.device) });
      continue;
    }
    // A Mac whose Second Computer could not start (no device key) says so UNSIGNED, for display only: never trusted.
    const off = d.data as { off?: boolean; why?: string; name?: string; chip?: string; app?: string; model?: string; at?: number; device?: string };
    if (off.off) {
      const k = `off:${String(off.name || "Mac").slice(0, 60)}`;
      if (!devMap.has(k) || devMap.get(k)!.at < (Number(off.at) || 0))
        devMap.set(k, { device: k, name: String(off.name || "Mac").slice(0, 60), model: off.model, chip: off.chip?.slice(0, 40), app: off.app?.slice(0, 12), off: String(off.why || "it could not start").slice(0, 120),
          role: "none", pub: "", at: Number(off.at) || 0, trusted: false, me: !!me && off.name === me.name, paired: false });
      continue;
    }
    const b = parseEnv<DevBody>((d.data as { env?: unknown }).env);
    if (!b || b.t !== "dev" || typeof b.from !== "string") continue;
    const old = devMap.get(b.from);
    if (old && old.at >= b.at) continue;
    const caps = (k: "ncaps" | "wcaps") => Array.isArray(b[k]) ? (b[k] as unknown[]).filter((x) => typeof x === "string") : [];
    devMap.set(b.from, {
      device: b.from, name: String(b.name || "Mac").slice(0, 60), model: b.model, chip: typeof b.chip === "string" ? b.chip.slice(0, 40) : undefined, app: typeof b.app === "string" ? b.app.slice(0, 12) : undefined, role: b.role, pub: b.pub, at: b.at,
      trusted: trusted.has(b.from), me: b.from === me?.device, paired: false,
      stream: caps("ncaps").includes("stream") && caps("wcaps").includes("stream"), pack: caps("ncaps").includes("pack") && caps("wcaps").includes("pack"),
      outsource: !!(b as DevBody & { okeys?: { sign?: string } }).okeys?.sign, xwing: !!(b as DevBody & { okeys?: { xwing?: string } }).okeys?.xwing,
    });
  }
  // A Mac PS already trusts shows even before its hello arrives (1 Nov 2026: the M4 logged "paired with the other
  // Mac" while the window still said "Nothing yet", because no hello had ever been signed). Display only: the
  // trust itself lives in PS.
  for (const t of local.trusted) {
    if (devMap.has(t.device) || (t.role !== "primary" && t.role !== "secondary") || t.device === me?.device) continue;
    devMap.set(t.device, { device: t.device, name: String(t.name || (t.role === "primary" ? "Your main Mac" : "Your second Mac")).slice(0, 60), role: t.role, pub: t.pub, at: Number(t.at) || 0, trusted: true, me: false, paired: false, silent: true });
  }
  const pairOk = new Set<string>();   // "primary|secondary" pairs the secondary confirmed
  for (const d of of("spair")) {
    const b = parseEnv<PairBody>((d.data as { env?: unknown }).env);
    if (b?.t === "pairok") pairOk.add(`${b.primary}|${b.secondary}`);
  }
  for (const r of devMap.values()) {
    if (!me || r.me) continue;
    r.paired = r.trusted && (me.role === "primary" ? pairOk.has(`${me.device}|${r.device}`) : pairOk.has(`${r.device}|${me.device}`));
  }
  const devices = [...devMap.values()].sort((a, b) => b.at - a.at);
  const role: Role = me?.role ?? "none";
  const others = devices.filter((d) => !d.me);
  const peer = role === "primary" ? others.find((d) => d.trusted && d.role === "secondary") ?? null
    : role === "secondary" ? others.find((d) => d.trusted && d.role === "primary") ?? null : null;
  const unpaired = role === "primary" ? others.filter((d) => d.role === "secondary" && !d.trusted) : [];

  // Status: the newest stat from the peer (on the secondary: its own).
  const statOf = peer && role === "primary" ? peer.device : me?.device;
  let stat: StatBody | null = null, myStat: StatBody | null = null;
  for (const d of of("sstat")) {
    const b = parseEnv<StatBody>((d.data as { env?: unknown }).env);
    if (!b || b.t !== "stat") continue;
    if (b.from === statOf && (!stat || b.at > stat.at)) stat = b;
    if (b.from === me?.device && (!myStat || b.at > myStat.at)) myStat = b;
  }
  // The newest heartbeat per Mac: it is also when that Mac was last on, and which PS it runs.
  for (const d of of("sstat")) {
    const b = parseEnv<StatBody>((d.data as { env?: unknown }).env);
    const r = b?.t === "stat" ? devMap.get(b.from) : undefined;
    if (!r || !b) continue;
    if (b.at > r.at) r.at = b.at;
    if (b.app && appNum(b.app) > appNum(r.app)) r.app = b.app.replace(/^V/i, "");
  }
  others.sort((a, b) => b.at - a.at);
  const link = linkOf(of("spair"), local, role, others, peer, now);
  const shares: ShareRoot[] = [];
  for (const d of of("sidx")) {
    const b = parseEnv<IdxBody>((d.data as { env?: unknown }).env);
    if (!b || b.t !== "idx" || !Array.isArray(b.entries)) continue;
    if (b.from !== me?.device && !trusted.has(b.from)) continue;   // only paired Macs' folders
    shares.push({ device: b.from, root: b.root, name: String(b.name || "Shared").slice(0, 60), entries: b.entries.slice(0, 5000), at: b.at, mine: b.from === me?.device });
  }

  // Notes to yourself.
  const msgs: MsgRow[] = [];
  for (const d of of("smsg")) {
    const x = d.data as { env?: unknown; phone?: boolean; text?: string; at?: number };
    if (x.phone) {
      if (typeof x.text === "string") msgs.push({ id: d.id, text: x.text.slice(0, 4000), at: Number(x.at) || 0, from: "phone", mine: false, phone: true, verified: false, files: [] });
      continue;
    }
    const b = parseEnv<MsgBody>(x.env);
    if (!b || b.t !== "msg" || typeof b.text !== "string") continue;
    msgs.push({ id: d.id, text: b.text.slice(0, 4000), at: b.at, from: b.from, mine: b.from === me?.device, phone: false, verified: verified.has(d.id),
      files: Array.isArray(b.files) ? b.files.filter((f) => typeof f === "string").slice(0, 10) : [] });
  }
  msgs.sort((a, b) => a.at - b.at);

  // Files (user and result files; code bundles stay out of sight).
  const acks = new Map<string, AckBody>();
  for (const d of of("sack")) {
    const b = parseEnv<AckBody>((d.data as { env?: unknown }).env);
    if (b?.t === "ack") acks.set(b.ref, b);
  }
  const files: FileRow[] = [];
  // What sits in the vault now: a file's chunks sent and not yet taken by the other Mac (v1.2 streams: the other Mac
  // says how many it took in an sgot record and deletes them); an older Mac takes a file only once it is whole.
  const gotOf = new Map<string, number>();
  for (const d of of("sgot")) {
    const g = d.data as { ref?: string; got?: number };
    if (typeof g.ref === "string" && Number.isFinite(g.got)) gotOf.set(g.ref, Math.max(gotOf.get(g.ref) ?? 0, Number(g.got)));
  }
  let waitingBytes = 0;
  for (const d of of("sfile")) {
    const b = parseEnv<FileBody>((d.data as { env?: unknown }).env);
    if (!b || b.t !== "file") continue;
    const a = acks.get(b.id);
    const sent = Array.isArray((d.data as { chunks?: unknown }).chunks) ? ((d.data as { chunks: unknown[] }).chunks.length) : 0, got = gotOf.get(b.id) ?? 0;
    if (!a) waitingBytes += Math.min(b.size, Math.max(0, sent - got) * (b.chunk || CHUNK));
    if (b.purpose === "bundle" || (b.purpose === "share" && b.get && local.previewGets?.includes(b.get))) continue;
    const p = local.progress.find((x) => x.id === b.id);
    const n = Math.max(1, b.n || 1), mine = b.from === me?.device;
    // Mine: how much the other Mac has (or, before it takes any, how much went up). Theirs: this Mac's own download.
    const pct = p ? Math.round((p.done / Math.max(1, p.total)) * 100) : mine && !a && (sent < n || got > 0) ? Math.round(((got || sent) / n) * 100) : undefined;
    files.push({
      id: b.id, name: b.name, size: b.size, at: b.at, from: b.from, to: b.to, mine, purpose: b.purpose, job: b.job, folder: b.pack === "zip",
      state: a ? (a.ok ? "landed" : "failed") : mine && sent < n ? "sending" : "waiting", reason: a?.reason, path: a?.path, pct,
    });
  }
  for (const p of local.progress) {
    if (p.dir === "up" && !files.some((f) => f.id === p.id)) {
      files.push({ id: p.id, name: p.name, size: p.size, at: now, from: me?.device ?? "", to: peer?.device ?? "", mine: true, purpose: "user",
        state: p.error ? "failed" : "sending", reason: p.error, pct: Math.round((p.done / Math.max(1, p.total)) * 100) });
      if (!p.error) waitingBytes += p.size;
    }
  }
  // Staged by PS and not in the vault yet: queued (a note's attachments wait for the note).
  const held: OutItem[] = [];
  for (const o of local.outbox ?? []) {
    if (o.hold) { held.push(o); continue; }
    if (o.target.kind === "get" || files.some((f) => f.id === o.id)) continue;
    files.push({ id: o.id, name: o.name, size: o.size, at: o.at, from: me?.device ?? "", to: peer?.device ?? "", mine: true, purpose: o.target.root ? "share" : "user", state: "sending", pct: 0, folder: o.pack === "zip" });
  }
  const full = waitingBytes + CHUNK > WAITING_MAX;
  for (const f of files) if (f.mine && f.state === "sending" && full) f.stalled = true;
  const month = monthKey(now);
  let monthUsed = 0;
  for (const d of of("sbudget")) {
    const x = d.data as { month?: string; bytes?: number };
    if (x.month === month && Number.isFinite(x.bytes)) monthUsed += Number(x.bytes);
  }
  files.sort((a, b) => b.at - a.at);

  // Jobs and their newest status.
  const stMap = new Map<string, JobStatusBody>();
  for (const d of of("sjobst")) {
    const b = parseEnv<JobStatusBody>((d.data as { env?: unknown }).env);
    if (!b || b.t !== "jobst") continue;
    const old = stMap.get(b.job);
    if (!old || b.at >= old.at) stMap.set(b.job, b);
  }
  const jobs: JobRow[] = [];
  for (const d of of("sjob")) {
    const b = parseEnv<JobBody>((d.data as { env?: unknown }).env);
    if (!b || b.t !== "job" || b.type === "cancel") continue;
    const st = stMap.get(b.id) ?? null;
    jobs.push({ id: b.id, type: b.type, args: b.args || {}, at: b.at, to: b.to, state: st?.state ?? "sent", status: st, updated: st?.at ?? b.at });
  }
  // Sealed jobs: only PS can open them; it hands their title, state and report over (local.ojobs).
  for (const o of local.ojobs ?? []) {
    if (jobs.some((j) => j.id === o.job)) continue;
    const status = { t: "jobst", job: o.job, state: o.state === "sent" ? "accepted" : o.state, reason: o.reason, step: o.step, summary: o.summary, startedAt: o.startedAt, endedAt: o.endedAt,
      tail: o.report ? o.report.slice(0, 48 * 1024) : "" } as unknown as JobStatusBody;
    jobs.push({ id: o.job, type: "research", args: { title: o.title }, at: o.at, to: peer?.device ?? "", state: o.state, status: o.state === "sent" ? null : status, updated: o.endedAt ?? o.startedAt ?? o.at,
      sealed: { suite: o.suite, report: o.report, folder: o.folder } });
  }
  jobs.sort((a, b) => b.at - a.at);

  return { me, role, devices, peer, unpaired, phones, stat, myStat, machine: stat?.machine ?? null, online: isOnline(stat, now), shares, msgs, files, jobs, waitingBytes, month: monthUsed, held, others, link };
}

/** This Mac's own open "looking" records (signed by it, under a day old, still open in PS). */
export function mySeeks(spair: Doc[], local: SecondLocal, now: number): PairSeek[] {
  const me = local.me;
  if (!me) return [];
  const out: PairSeek[] = [];
  for (const d of spair) {
    const b = parseEnv<SeekBody>((d.data as { env?: unknown }).env);
    if (b?.t === "seek" && b.from === me.device && now - b.at < SEEK_LIFE && (!local.seeks || local.seeks.includes(b.id))) out.push({ doc: d, body: b });
  }
  return out.sort((a, b) => b.body.at - a.body.at);
}
export interface SeekBody { v: 1; t: "seek"; id: string; from: string; to: string; at: number; primary: string; primaryPub: string; names?: { p?: string } }
export interface PairSeek { doc: Doc; body: SeekBody }

function linkOf(spair: Doc[], local: SecondLocal, role: Role, others: DeviceRow[], peer: DeviceRow | null, now: number): Link {
  const other = peer ?? others.find((d) => !d.trusted) ?? others[0] ?? null;
  if (peer && (role === "secondary" || peer.paired)) return { step: "paired", other: peer, since: null };
  const mine = mySeeks(spair, local, now)[0];
  if (mine) return { step: "looking", other, since: mine.body.at };
  if (role === "secondary") return { step: "waiting", other, since: null };
  return { step: "idle", other, since: null };
}
export const jobRunning = (j: JobRow) => !isDone(j.state as JobState) && j.state !== "sent";
export const STATE_WORD: Record<JobRow["state"], string> = {
  sent: "Sent", accepted: "Accepted", queued: "Queued", running: "Running", done: "Done", failed: "Failed",
  refused: "Refused", cancelled: "Stopped", timeout: "Timed out",
};
