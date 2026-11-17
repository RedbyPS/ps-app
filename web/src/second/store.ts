// Second Computer, the moving part (PS main window only, where the vault is open). It never decides trust:
// device keys, pairing, signing and the job allowlist live in PS itself (ps-mac Second*.swift), which this
// file talks to over the usual bridge (protocol.md section 10). Here we only carry sealed records and blobs:
//   - announce this Mac (sdev), hand pairing to PS's own alerts (spair);
//   - send notes (smsg), files in 4 MB encrypted chunks (sfile + blobs), and jobs with their code bundles (sjob);
//   - on the secondary: hand jobs and bundles to PS, store its signed statuses (sjobst) and heartbeat (sstat);
//   - on either Mac: land files meant for it (PS writes ~/Downloads/From PS), ack them (sack), delete the chunks;
//   - on the primary: the CLI bridge for Claude sessions (scripts/second.ts) and housekeeping.
//   - drag and drop (protocol v1.2, 2 Nov 2026): PS stages whatever is dropped (ps-mac SecondDrop.swift, the outbox);
//     this page streams it up 4 MB at a time while at most WAITING_MAX sits in the vault, and the other Mac lands each
//     chunk as it comes (resuming after sleep or a restart), deletes it and says how far it got (sgot).
//   - outsourcing (protocol v1.3, 2 Nov 2026): PS seals and signs research jobs and their results itself (ps-mac
//     SecondSeal.swift); this page only carries the sealed records (sojob, sores) and hands each Mac's signed hello
//     to PS so it learns the other Mac's keys. It never sees a task or a report except what PS shows in the window.
// Egress: chunks are fetched once, only by the Mac they are for, then deleted; everything else is a small
// record on the normal change-only pull. A private Realtime poke (migration 026) makes it quick.
import { deleteBlob, docs, getBlob, onSecondPoke, pokeSecond, put, putBlob, remove, setSecondChannel, vaultStore } from "../core/vault";
import type { Doc } from "../core/model";
import {
  CHUNK, checkJob, chunkCount, fileRefusal, isDone, JOB_MAX_AGE, MSG_MAX, prune, secretPath,
  type AckBody, type BundleRef, type CmdAction, type DevBody, type Env, type FileBody, type GetBody, type IdxBody, type JobBody, type JobStatusBody, type JobType, type PairBody, type Peer, type Role, type StatBody,
  cmdAction, CMD_MAX_AGE, checkGet, looksSecret, monthKey, rebootSet, sendRefusal, sharePathOk, WAITING_MAX,
} from "../core/second";
import type { SecondOp } from "../views/Second";
import { settingsData } from "../core/select";
import { saveSettings } from "../core/actions";
import { codeBody, codeJobsOn, type CodeJobIn } from "../core/secondcode";
import { putPreview, takeDrop } from "./drops";
import { EMPTY_LOCAL, mySeeks, parseEnv, SEEK_LIFE, secondView, type NativeInfo, type OffInfo, type OJobInfo, type OutItem, type SeekBody, type Progress, type SecondLocal, type SecondView } from "./view";

/** What this page can do with files (v1.2), told to PS (second:hello) and, in the hello, to the other Mac. */
const WCAPS = ["stream", "pack"];

type Post = (m: object) => void;
let post: Post = () => {};
let local: SecondLocal = { ...EMPTY_LOCAL };
const listeners = new Set<() => void>();
function set(p: Partial<SecondLocal>) { local = { ...local, ...p }; listeners.forEach((l) => l()); }
export const secondStore = { subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }, get: () => local };
export function secondLocal() { return local; }
/** The floating Tab list gets the main window's copy with the rest of the state (ps.ts). */
export function setSecondMirror(x: unknown) {
  if (!x || typeof x !== "object") return;
  local = { ...EMPTY_LOCAL, ...(x as SecondLocal) };
  listeners.forEach((l) => l());
}
export function currentView(): SecondView {
  const s = vaultStore.get();
  return secondView([...s.docs.values()], local, Date.now());
}
const note = (text: string | null) => set({ note: text });

// ---------- talking to PS ----------
type Waiter = { resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; t: number };
const waiters = new Map<string, Waiter>();
function ask(msg: Record<string, unknown>, key: string, ms = 120_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const old = waiters.get(key);
    if (old) { clearTimeout(old.t); old.reject(new Error("Replaced")); }
    const t = window.setTimeout(() => { waiters.delete(key); reject(new Error("PS app did not answer")); }, ms);
    waiters.set(key, { resolve, reject, t });
    post(msg);
  });
}
function answer(key: string, m: Record<string, unknown>) {
  const w = waiters.get(key);
  if (!w) return false;
  clearTimeout(w.t); waiters.delete(key); w.resolve(m); return true;
}
let reqN = 0;
const req = (p: string) => `${p}-${Date.now().toString(36)}-${(reqN++).toString(36)}`;

async function sign(body: Record<string, unknown>): Promise<Env> {
  const r = `sign-${String(body.t)}-${String(body.id)}`;
  // The body goes as an object: PS reads msg["body"] as a dictionary and drops anything else without a word. Until
  // 1 Nov 2026 it went as text, so no hello, note, file, job or command signed here ever reached the other Mac.
  const m = await ask({ type: "second:sign", req: r, body }, r, 20_000);
  const env = m.env as Env | undefined;
  if (!env || typeof env.body !== "string") throw new Error("PS would not sign that");
  return env;
}
const base = (t: string, to: string, id: string = crypto.randomUUID()) => ({ v: 1 as const, t, id, from: local.me!.device, to, at: Date.now() });

/** Messages from PS. True when it was one of ours. */
export function secondMessage(m: { type?: string; [k: string]: unknown }): boolean {
  const t = m.type ?? "";
  if (!t.startsWith("second")) return false;
  if (t === "second") {
    const me = m.me as NativeInfo | null, trusted = Array.isArray(m.trusted) ? (m.trusted as SecondLocal["trusted"]) : [];
    const off = m.off && typeof m.off === "object" ? m.off as OffInfo : null;
    const caps = Array.isArray(m.caps) ? (m.caps as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 20) : [];
    set({ native: true, me, trusted, seeks: Array.isArray(m.seeks) ? (m.seeks as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 20) : [], off, caps });
    // Every Mac with Second Computer listens for a nudge, whatever its role: a Mac with no role yet must hear Pair too.
    setSecondChannel(!!me, me?.role === "secondary");
    if (m.wake === true) fresh = true;   // back from sleep: say hello again
    if (off) void announceOff(off); else void announce();
    if (roleAsked && me && me.role === roleAsked.role) { clearTimeout(roleAsked.t); roleAsked = null; note(null); }
    schedule();
  } else if (t === "second:signed") { if (!answer(String(m.req), m) && String(m.req).startsWith("ack:")) void storeAck(m.env as Env); }
  else if (t === "second:idx") void storeIdx(m.env as Env);
  else if (t === "second:cancelled") { const w = waiters.get(String(m.req)); if (w) { clearTimeout(w.t); waiters.delete(String(m.req)); w.reject(new Error("cancelled")); } set({ pairing: null }); }
  else if (t === "second:bundled") answer(String(m.req), m);
  else if (t === "second:projects") set({ projects: Array.isArray(m.list) ? (m.list as SecondLocal["projects"]).slice(0, 80) : [] });
  else if (t === "second:jobst") void storeStatus(m.env as Env);
  else if (t === "second:stat") void storeStat(m.env as Env);
  else if (t === "second:cli") void cliRequest(m.req as CliReq, (m.bundles as CliBundle[]) || []);
  else if (t === "second:upload") void uploadResult(m);
  else if (t === "second:outbox") { set({ outbox: cleanOutbox(m.list) }); schedule(); }
  else if (t === "second:readOk" || t === "second:landAt" || t === "second:chunkOk") answer(String(m.req), m);
  else if (t === "second:fetchTo") void fetchTo(m);
  else if (t === "second:ojobOut") void storeOJob(m);
  else if (t === "second:oresOut") void storeORes(m);
  else if (t === "second:oack") void ackOJob(m);
  else if (t === "second:ojobs") set({ ojobs: Array.isArray(m.list) ? (m.list as OJobInfo[]).slice(0, 100) : [] });
  else if (t === "second:off") {   // V1.31: a click while Second Computer is off here is answered, never dropped
    if (roleAsked) { clearTimeout(roleAsked.t); roleAsked = null; }
    note(typeof m.why === "string" && m.why ? m.why.slice(0, 300) : "Second Computer is off on this Mac.");
  }
  else if (t === "second:dropProblems") note(Array.isArray(m.list) ? (m.list as unknown[]).map(String).slice(0, 3).join(" ") : null);
  return true;
}

// ---------- this Mac in the vault ----------
// This Mac says hello whenever PS runs and the vault is open, whatever window is up: at every start of the page
// (launch, sign in), after sleep, and when anything in it changes. `fresh`: the next pass re-signs it when the
// record is over 5 minutes old, so the other Mac sees when this one was last on (V1.26; it used to say hello only
// when something changed). Otherwise at most every 6 hours. One small record, updated in place.
// A hello that could not be saved is tried again, 30 s later and then less often: right after a wake the VPN is still
// reconnecting (1 Nov 2026: the M4's hello failed at each of four wakes and was never tried again, and the 6 hour
// refresh never ran because a hello already said returned before looking at its age).
let announced = "", announcedAt = 0, fresh = true, helloFails = 0, helloRetry: number | undefined;
async function announce() {
  const me = local.me;
  if (!me || vaultStore.get().status !== "unlocked") return;
  const nstream = local.caps?.includes("stream") ?? false;
  const key = `${me.device}|${me.name}|${me.role}|${me.pub}|${me.chip ?? ""}|${me.app ?? ""}|${nstream}|${me.okid ?? ""}`;
  if (key === announced && !fresh && Date.now() - announcedAt < 6 * 3_600_000) return;
  const mine = docs<{ device?: string; env?: Env }>("sdev").find((d) => d.data.device === me.device);
  const b = parseEnv<DevBody>(mine?.data.env);
  const age = b ? Date.now() - b.at : Infinity;
  if (b && b.name === me.name && b.role === me.role && b.pub === me.pub && (b.chip ?? "") === (me.chip ?? "") && (b.app ?? "") === (me.app ?? "")
      && (b.wcaps ?? []).join() === WCAPS.join() && (b.ncaps ?? []).includes("stream") === nstream
      && ((b as DevBody & { okeys?: { kid?: string } }).okeys?.kid ?? "") === (me.okid ?? "")
      && age < (fresh ? 5 * 60_000 : 6 * 3_600_000)) { announced = key; announcedAt = b.at; fresh = false; return; }
  fresh = false;
  try {
    const env = await sign({ ...base("dev", "all"), name: me.name, model: me.model, ...(me.chip ? { chip: me.chip } : {}), role: me.role, pub: me.pub, wcaps: WCAPS });
    await put("sdev", { device: me.device, env }, mine ? { id: mine.id } : {});
    announced = key; announcedAt = Date.now(); helloFails = 0;
    void pokeSecond("stat");
  } catch {
    fresh = true;
    if (helloRetry === undefined) {
      const wait = Math.min(30_000 * 2 ** helloFails++, 10 * 60_000);
      helloRetry = window.setTimeout(() => { helloRetry = undefined; schedule(); }, wait);
    }
  }
}

/** Second Computer could not start here (no device key): say so, unsigned and for display only, so the main Mac
 *  can tell the developer why this Mac never connects instead of seeing nothing at all. */
let offSaid = "";
async function announceOff(full: OffInfo) {
  if (vaultStore.get().status !== "unlocked") return;
  // Only what the other Mac shows (V1.31: this Mac's own wording and the Allow state stay on this Mac).
  const o: OffInfo = { why: full.why, name: full.name, model: full.model, chip: full.chip, app: full.app };
  const key = JSON.stringify(o);
  if (key === offSaid) return;
  const mine = docs<{ off?: boolean; name?: string; at?: number }>("sdev").find((d) => d.data.off && d.data.name === o.name);
  if (mine && Date.now() - (mine.data.at ?? 0) < 6 * 3_600_000 && JSON.stringify({ ...mine.data, at: 0 }) === JSON.stringify({ off: true, ...o, at: 0 })) { offSaid = key; return; }
  try { await put("sdev", { off: true, ...o, at: Date.now() }, mine ? { id: mine.id } : {}); offSaid = key; void pokeSecond("stat"); } catch { /* next pass */ }
}

// 4 Nov 2026 (the M4): "This is my main Mac" did nothing at all, PS dropped it while its key was blocked. A role
// click now always ends in something the developer can see: the new role, PS's reason, or "PS did not answer" after 8 s.
let roleAsked: { role: Role; t: number } | null = null;
export function setRole(role: Role) {
  if (roleAsked) clearTimeout(roleAsked.t);
  roleAsked = { role, t: window.setTimeout(() => {
    roleAsked = null;
    if (local.me?.role === role) return;
    note(local.off ? (local.off.here || `Second Computer is off on this Mac: ${local.off.why}.`)
      : role === "secondary" ? "PS app has not set this Mac up yet. Answer its question if one is open, or click again."
      : "PS app did not answer. Click again; if nothing changes, quit PS app and open it again.");
  }, 8_000) };
  note(null);
  post({ type: "second:role", role });
  if (role === "secondary") set({ waitingSince: Date.now() });
}
/** The developer clicked Allow: PS reads its Second Computer key again, and macOS may ask once (his Mac login password, Always Allow). */
export function allowKey() {
  note("If macOS asks, type your Mac login password and click Always Allow.");
  post({ type: "second:allow" });
}
/** "Show the Trust question again": a request the developer closed without answering is asked once more. */
export function waitForPrimary() { answered.clear(); schedule(); }
export function askProjects() { post({ type: "second:projects" }); }

// ---------- one click pairing (V1.26; PS signs and checks every step, nothing here can add trust) ----------
// The developer clicks Pair on the main Mac: PS signs a "looking for my other Mac" record (seek), kept 24 hours. Any other
// Mac of the developer's with PS running and signed in answers it by itself (its PS becomes the second Mac, trusts that key
// and signs a pairok naming the seek); the main Mac's PS checks the answer against its own seek and trusts it back.
export async function pair() {
  const me = local.me;
  if (!me || local.pairing) return;
  set({ pairing: "seek" });
  try {
    const r = req("seek");
    const m = await ask({ type: "second:seek", req: r }, r, 20_000);
    await put("spair", { env: m.env });
    void pokeSecond("stat");
  } catch { note("Could not start looking. Try again."); }
  finally { set({ pairing: null }); }
}
export function unpair(device: string) { post({ type: "second:unpair", device }); }

/** The second Mac's half: answer a fresh seek from another Mac (asked once per record per page). */
const answered = new Set<string>();
async function answerSeek() {
  const me = local.me;
  if (!me || local.pairing || (local.seeks?.length ?? 0) > 0) return;
  const now = Date.now();
  for (const d of docs<{ env?: Env }>("spair")) {
    const b = parseEnv<SeekBody>(d.data.env);
    if (!b || b.t !== "seek" || b.from === me.device || now - b.at > SEEK_LIFE || b.at > now + 5 * 60_000 || answered.has(d.id)) continue;
    if (local.trusted.some((t) => t.device === b.from && t.role === "primary")) { answered.add(d.id); continue; }
    answered.add(d.id);
    set({ pairing: b.from });
    try {
      const m = await ask({ type: "second:autotrust", env: d.data.env }, "pairok:auto", 60_000);
      await put("spair", { env: m.env });
      fresh = true;   // its new role, at once
      void pokeSecond("stat");
    } catch { /* PS said why in its log */ }
    finally { set({ pairing: null }); }
    return;
  }
}

/** The main Mac's half: hand PS each answer to one of its own open seeks. */
const finished = new Set<string>();
function finishPair() {
  const me = local.me;
  if (!me || me.role !== "primary") return;
  const mine = new Set(mySeeks(docs("spair"), local, Date.now()).map((x) => x.body.id));
  if (!mine.size) return;
  for (const d of docs<{ env?: Env }>("spair")) {
    const b = parseEnv<PairBody & { seek?: string }>(d.data.env);
    if (!b || b.t !== "pairok" || b.primary !== me.device || !b.seek || !mine.has(b.seek) || finished.has(d.id)) continue;
    if (local.trusted.some((t) => t.device === b.secondary)) continue;
    finished.add(d.id);
    post({ type: "second:autopair", env: d.data.env });
  }
}

// ---------- notes ----------
/** `held`: files PS staged for this note (v1.2, dropped on Messages); they go once the note is out. */
export async function sendMsg(text: string, attach: (Blob & { name?: string })[] = [], held: string[] = []) {
  const t = text.trim().slice(0, MSG_MAX);
  if (!t && !attach.length && !held.length) return;
  if (import.meta.env.MODE === "gos" || !local.me) {   // the phone has no device key: an unsigned note, shown as "Phone"
    await put("smsg", { phone: true, text: t, at: Date.now() });
  } else {
    const files: string[] = [];
    for (const f of attach.slice(0, 10)) { const id = await sendFile(f); if (id) files.push(id); }
    const keep = held.filter((id) => (local.outbox ?? []).some((o) => o.id === id)).slice(0, 10 - files.length);
    files.push(...keep);
    const env = await sign({ ...base("msg", "all"), text: t, ...(files.length ? { files } : {}) });
    await put("smsg", { env });
    if (keep.length) post({ type: "second:outboxRelease", ids: keep });
  }
  void pokeSecond("msg");
}

// ---------- files ----------
function progress(p: Progress | null, id?: string) {
  const rest = local.progress.filter((x) => x.id !== (p?.id ?? id));
  set({ progress: p ? [...rest, p] : rest });
}
async function sha256hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Upload bytes as a signed file for `to`. Returns the file id. */
async function upload(bytes: Uint8Array, meta: { name: string; mime: string; purpose: FileBody["purpose"]; to: string; job?: string; id?: string; get?: string; root?: string; dir?: string }, show: boolean): Promise<string> {
  const id = meta.id ?? crypto.randomUUID();
  const n = chunkCount(bytes.length);
  if (show) progress({ id, name: meta.name, size: bytes.length, done: 0, total: n, dir: "up" });
  const chunks: string[] = [];
  try {
    const sum = await sha256hex(bytes);
    for (let i = 0; i < n; i++) {
      chunks.push(await putBlob(null, bytes.subarray(i * CHUNK, Math.min(bytes.length, (i + 1) * CHUNK)), { cache: false }));
      if (show) progress({ id, name: meta.name, size: bytes.length, done: i + 1, total: n, dir: "up" });
    }
    const env = await sign({ ...base("file", meta.to, id), name: meta.name, size: bytes.length, sha256: sum, mime: meta.mime || "application/octet-stream",
      purpose: meta.purpose, ...(meta.job ? { job: meta.job } : {}), ...(meta.get ? { get: meta.get } : {}),
      ...(meta.root ? { root: meta.root, dir: meta.dir ?? "" } : {}), chunk: CHUNK, n });
    await put("sfile", { env, chunks }, { id });
    if (show) progress(null, id);
    void pokeSecond("file");
    return id;
  } catch (e) {
    for (const c of chunks) void deleteBlob(c).catch(() => {});
    if (show) progress({ id, name: meta.name, size: bytes.length, done: 0, total: n, dir: "up", error: "Could not send. Check the connection and try again." });
    throw e;
  }
}

/** Drag and drop: send a file to the other Mac (25 MB a file). */
export async function sendFile(file: Blob & { name?: string }, into?: { root: string; dir: string }): Promise<string | null> {
  const v = currentView();
  if (!v.peer) { note("Pair a second Mac first."); return null; }
  const why = fileRefusal(file.size, v.waitingBytes);
  if (why) { note(why); return null; }
  if (into && (!/^[a-z0-9-]{1,40}$/.test(into.root) || (into.dir && !sharePathOk(into.dir)))) { note("That folder cannot take files."); return null; }
  note(null);
  const bytes = new Uint8Array(await file.arrayBuffer());
  return upload(bytes, { name: file.name || "file", mime: file.type, purpose: into ? "share" : "user", to: v.peer.device, ...(into ? { root: into.root, dir: into.dir } : {}) }, true).catch(() => null);
}

// Landing: only the Mac a file is for fetches its chunks, once, and hands them to PS in order.
const landing = new Set<string>();
async function landFile(d: Doc<{ env?: Env; chunks?: string[] }>) {
  const b = parseEnv<FileBody>(d.data.env);
  const chunks = d.data.chunks;
  if (!b || !Array.isArray(chunks) || chunks.length !== b.n || landing.has(b.id)) return;
  landing.add(b.id);
  const show = b.purpose !== "bundle";
  try {
    for (let i = 0; i < chunks.length; i++) {
      if (show) progress({ id: b.id, name: b.name, size: b.size, done: i, total: chunks.length, dir: "down" });
      const bytes = await getBlob(chunks[i], null, { cache: false });
      const key = `ack:${b.id}`;
      const msg = { type: "second:chunk", env: d.data.env, i, n: chunks.length, b64: b64(bytes) };
      if (i < chunks.length - 1) post(msg);   // in order over the bridge; PS answers once, for the whole file
      else {
        const m = await ask(msg, key, 120_000);
        await put("sack", { ref: b.id, env: m.env });
      }
    }
    for (const c of chunks) await deleteBlob(c).catch(() => {});
    void pokeSecond("file");
  } catch { landing.delete(b.id); }   // try again on the next pass (PS keeps the half file aside)
  finally { if (show) progress(null, b.id); }
}
// v1.2: a Mac whose PS streams lands each chunk as soon as it is up, from where its disk left off (after sleep or a
// restart), deletes it from the vault and says how far it got (sgot), so the sender may put up the next ones.
async function landStream(d: Doc<{ env?: Env; chunks?: string[] }>) {
  const b = parseEnv<FileBody>(d.data.env);
  if (!b || !d.data.env || landing.has(b.id)) return;
  landing.add(b.id);
  const show = b.purpose !== "bundle";
  let finished = false;
  try {
    const r0 = req("landat");
    const at = await ask({ type: "second:landAt", req: r0, env: d.data.env }, r0, 30_000);
    let i = Math.max(0, Number(at.have) || 0);
    const first = d.data.chunks ?? [];
    for (let k = 0; k < Math.min(i, first.length); k++) void deleteBlob(first[k]).catch(() => {});   // on disk already
    if (i > 0 && (gotOf(b.id) ?? 0) < i) await setGot(b.id, i);
    while (i < b.n) {
      const cur = docs<{ chunks?: string[] }>("sfile").find((x) => x.id === d.id)?.data.chunks ?? [];
      if (i >= cur.length) break;   // the rest is not up yet: the next pass (a poke from the sender) carries on
      if (show) progress({ id: b.id, name: b.name, size: b.size, done: i, total: b.n, dir: "down" });
      const bytes = await getBlob(cur[i], null, { cache: false });
      const last = i === b.n - 1, key = last ? `ack:${b.id}` : `chunk:${b.id}:${i}`;
      const m = await ask({ type: "second:chunk", req: key, env: d.data.env, i, n: b.n, b64: b64(bytes) }, key, 120_000);
      if (m.error) { finished = true; break; }   // PS refused it and signed why (the ack reaches the vault on its own)
      if (last) { await put("sack", { ref: b.id, env: m.env }); finished = true; }
      await deleteBlob(cur[i]).catch(() => {});
      i++;
      if (!last) await setGot(b.id, i);
      void pokeSecond("file");
    }
  } catch { /* the next pass picks it up where the disk left off */ }
  finally { landing.delete(b.id); if (show && finished) progress(null, b.id); }
}
const gotOf = (ref: string) => docs<{ ref?: string; got?: number }>("sgot").find((g) => g.data.ref === ref)?.data.got;
async function setGot(ref: string, got: number) {
  const mine = docs<{ ref?: string }>("sgot").find((g) => g.data.ref === ref);
  await put("sgot", { ref, got, at: Date.now() }, mine ? { id: mine.id } : {}).catch(() => {});
}

// ---------- the outbox (v1.2): staged files streamed up ----------
function cleanOutbox(x: unknown): OutItem[] {
  if (!Array.isArray(x)) return [];
  return x.filter((o): o is OutItem => !!o && typeof o === "object" && KEY.test(String((o as OutItem).id)) && typeof (o as OutItem).name === "string"
    && Number.isFinite((o as OutItem).size) && typeof (o as OutItem).sha256 === "string" && !!(o as OutItem).target && typeof (o as OutItem).target === "object").slice(0, 200);
}
const acksOf = () => {
  const m = new Map<string, AckBody>();
  for (const d of docs<{ env?: Env }>("sack")) { const b = parseEnv<AckBody>(d.data.env); if (b?.t === "ack") m.set(b.ref, b); }
  return m;
};
const pumping = new Set<string>(), outDone = new Set<string>();
async function pump() {
  if (!local.me || !local.caps?.includes("outbox")) return;
  const acks = acksOf();
  for (const o of local.outbox ?? []) {
    if (o.hold || pumping.has(o.id) || outDone.has(o.id)) continue;
    const a = acks.get(o.id);
    if (a) {
      // Landed: PS drops its copy. Damaged on the way: the same bytes once more under a new id.
      outDone.add(o.id);
      post(!a.ok && /did not arrive whole/i.test(a.reason ?? "") && !o.retried ? { type: "second:outboxRetry", id: o.id } : { type: "second:outboxDone", id: o.id });
      continue;
    }
    pumping.add(o.id);
    let full = false;
    try { full = await pumpOne(o); } catch { /* the next pass */ } finally { pumping.delete(o.id); }
    if (full) return;   // the vault holds all it may: one file at a time until the other Mac takes some
  }
}
/** Puts up what fits of one staged file. True when the vault is full (stop for now). */
async function pumpOne(o: OutItem): Promise<boolean> {
  const v = currentView();
  const to = o.target.kind === "get" ? o.target.to : v.peer?.device;
  if (!to) return false;   // not paired (yet): it waits in PS
  const peer = v.devices.find((x) => x.device === to);
  const n = chunkCount(o.size);
  let d = docs<{ env?: Env; chunks?: string[] }>("sfile").find((x) => x.id === o.id);
  if (!d) {
    if (v.waitingBytes + CHUNK > WAITING_MAX) return true;
    const stream = !!peer?.stream, pack = !!peer?.pack;
    const why = sendRefusal(o.size, { stream, pack, folder: o.pack === "zip", month: v.month, peer: peer?.name ?? "the other Mac" });
    if (why) { note(`${o.name}: ${why}`); outDone.add(o.id); post({ type: "second:outboxDrop", id: o.id, why }); return false; }
    const purpose: FileBody["purpose"] = o.target.kind === "get" || o.target.root ? "share" : "user";
    const env = await sign({ ...base("file", to, o.id), name: o.pack === "zip" && !pack ? `${o.name}.zip` : o.name, size: o.size, sha256: o.sha256,
      mime: o.mime || "application/octet-stream", purpose, ...(o.target.kind === "get" && o.target.get ? { get: o.target.get } : {}),
      ...(o.target.root ? { root: o.target.root, dir: o.target.dir ?? "" } : {}), ...(o.pack === "zip" && pack ? { pack: "zip" } : {}),
      ...(o.m ? { m: o.m } : {}), chunk: CHUNK, n });
    await put("sfile", { env, chunks: [] }, { id: o.id });
    await addMonth(o.size);
    d = docs<{ env?: Env; chunks?: string[] }>("sfile").find((x) => x.id === o.id);
  }
  const env = d?.data.env ?? null, chunks = [...(d?.data.chunks ?? [])];
  if (!env) return false;
  while (chunks.length < n) {
    if (currentView().waitingBytes + CHUNK > WAITING_MAX) return true;
    const r = req("read");
    const m = await ask({ type: "second:read", req: r, id: o.id, i: chunks.length }, r, 60_000);
    if (typeof m.b64 !== "string") throw new Error(String(m.error ?? "Gone"));
    chunks.push(await putBlob(null, Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0)), { cache: false }));
    await put("sfile", { env, chunks }, { id: o.id });
    void pokeSecond("file");
  }
  return false;
}
/** This Mac's count for the month's budget (one small record per Mac per month). */
async function addMonth(bytes: number) {
  const me = local.me?.device, month = monthKey();
  if (!me) return;
  const mine = docs<{ device?: string; month?: string; bytes?: number }>("sbudget").find((d) => d.data.device === me && d.data.month === month);
  await put("sbudget", { device: me, month, bytes: (Number(mine?.data.bytes) || 0) + bytes }, mine ? { id: mine.id } : {}).catch(() => {});
}

// ---------- outsourcing (v1.3): sealed jobs and results, carried only ----------
/** PS (the main Mac) sealed and signed a job: into the vault as it is. */
async function storeOJob(m: Record<string, unknown>) {
  const env = m.env as Env | undefined, job = String(m.job ?? "");
  if (!env || typeof env.body !== "string" || !KEY.test(job)) return;
  await put("sojob", { env }, { id: job }).catch(() => {});
  void pokeSecond("job");
}
/** PS (the second Mac) sealed a status or the result of a job: one record per job, replaced as it goes. */
async function storeORes(m: Record<string, unknown>) {
  const env = m.env as Env | undefined, job = String(m.job ?? "");
  if (!env || typeof env.body !== "string" || !KEY.test(job)) return;
  const mine = docs<{ job?: string }>("sores").find((d) => d.data.job === job);
  await put("sores", { job, env }, mine ? { id: mine.id } : {}).catch(() => {});
  void pokeSecond("job");
}
/** The main Mac's PS has the result safely: a signed ack, so the second Mac deletes the job's folder. */
async function ackOJob(m: Record<string, unknown>) {
  const job = String(m.job ?? ""), to = String(m.to ?? "");
  if (!KEY.test(job) || !local.me || docs<{ ref?: string }>("sack").some((a) => a.data.ref === job)) return;
  try {
    const env = await sign({ ...base("ack", to), ref: job, ok: true });
    await put("sack", { ref: job, env });
    void pokeSecond("job");
  } catch { /* the next result asks again */ }
}
/** Each paired Mac's signed hello to PS (it checks it with the paired key and learns the outsourcing keys in it);
 *  sealed jobs for this Mac and sealed results for this Mac to PS; acks of jobs this Mac ran. Each once per change. */
const handedO = new Map<string, string>();
function handOutsource() {
  const me = local.me?.device;
  if (!me || !local.caps?.includes("outsource")) return;
  const once = (k: string, v: string) => { if (handedO.get(k) === v) return false; handedO.set(k, v); return true; };
  for (const d of docs<{ device?: string; env?: Env }>("sdev")) {
    const env = d.data.env;
    if (!env || env.by === me || !local.trusted.some((t) => t.device === env.by)) continue;
    if (once("hello:" + env.by, env.sig)) post({ type: "second:peerHello", env });
  }
  const now = Date.now();
  for (const d of docs<{ env?: Env }>("sojob")) {
    const b = parseEnv<{ to?: string; at?: number }>(d.data.env);
    if (!b || b.to !== me || now - (b.at ?? 0) > 11 * 60_000) continue;
    if (once("ojob:" + d.id, d.data.env!.sig)) post({ type: "second:ojob", env: d.data.env });
  }
  for (const d of docs<{ job?: string; env?: Env }>("sores")) {
    const b = parseEnv<{ to?: string }>(d.data.env);
    if (!b || b.to !== me) continue;
    if (once("ores:" + d.id, d.data.env!.sig)) post({ type: "second:ores", env: d.data.env });
  }
  const ran = new Set(docs<{ job?: string; env?: Env }>("sores").filter((d) => parseEnv<{ from?: string }>(d.data.env)?.from === me).map((d) => d.data.job));
  for (const a of docs<{ ref?: string; env?: Env }>("sack")) {
    if (!a.data.ref || !ran.has(a.data.ref) || !a.data.env) continue;
    if (once("oack:" + a.data.ref, a.data.env.sig)) post({ type: "second:oacked", env: a.data.env });
  }
}
/** The window's Research form: PS seals and sends it (the same way as a chat's `second.ts outsource`). */
export function outsource(o: { title: string; prompt: string; model?: "opus" | "sonnet"; minutes?: number }) {
  const v = currentView();
  if (!v.peer?.outsource) { note(`${v.peer?.name ?? "The second Mac"} needs PS app updated before it can take sealed research.`); return; }
  post({ type: "second:outsource", title: o.title, prompt: o.prompt, ...(o.model ? { model: o.model } : {}), ...(o.minutes ? { minutes: o.minutes } : {}) });
  note(v.online ? "Sealed and sent. It starts in a few seconds." : `${v.peer.name} is offline: a sealed task waits only 10 minutes.`);
}

/** The Outsource tab's Code job form (PS 1.65): PS seals and sends it as kind "code" (the same way as `second.ts code`). */
export function outsourceCode(j: CodeJobIn) {
  const v = currentView();
  if (!codeJobsOn(settingsData(vaultStore.get()))) { note("Code jobs are off. Switch them on at the top of Outsource."); return; }
  if (!v.peer?.outsource) { note(`${v.peer?.name ?? "The second Mac"} needs PS app updated before it can take sealed work.`); return; }
  const { body, why } = codeBody(j, looksSecret);
  if (!body) { note(`Not sent: ${why}`); return; }
  post({ type: "second:ocode", ...body });
  note(v.online ? "Sealed and sent. It starts in a few seconds." : `${v.peer.name} is offline: a sealed job waits only 10 minutes.`);
}

/** Finder asked for a file the developer dragged out of the window: the signed request, and its id back to PS. */
async function fetchTo(m: Record<string, unknown>) {
  const r = String(m.req ?? "");
  if (!/^fetch-[0-9a-f-]{36}$/.test(r)) return;
  const id = await fetchShared(String(m.device ?? ""), String(m.root ?? ""), String(m.path ?? ""), "download", true).catch(() => null);
  post(id ? { type: "second:fetching", req: r, get: id } : { type: "second:fetching", req: r, error: "Could not ask the other Mac" });
}

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------- jobs ----------
const PROJECTS_FOR: Partial<Record<JobType, string[]>> = { selftest: ["ps-mac", "web"], build: ["ps-mac", "web"] };
type Bundled = { project: string; head: string; base?: string; b64: string; files?: string[]; dirty?: boolean };

async function bundleOf(project: string, have: string | undefined): Promise<Bundled> {
  const r = req("bundle");
  const m = await ask({ type: "second:bundle", req: r, project, ...(have ? { base: have } : {}) }, r, 120_000);
  if (m.error) throw new Error(String(m.error));
  return m as unknown as Bundled;
}

/** Send bundles and the signed job. `extra` holds the job's own arguments (prompt, preset, only, send). */
async function submit(type: JobType, extra: Record<string, unknown>, bundled: Bundled[], to: string): Promise<string> {
  for (const b of bundled) {
    const bad = (b.files || []).find(secretPath);
    if (bad) throw new Error(`Not sent: ${b.project} has a secret looking file (${bad}).`);
    if (!/^[0-9a-f]{40}$/.test(b.head)) throw new Error(`Not sent: ${b.project} has no commit yet.`);
  }
  const jobId = crypto.randomUUID();
  const refs: BundleRef[] = [];
  for (const b of bundled) {
    const bytes = Uint8Array.from(atob(b.b64), (c) => c.charCodeAt(0));
    const why = fileRefusal(bytes.length, 0);
    if (why) throw new Error(`${b.project}: ${why}`);
    const file = await upload(bytes, { name: `${b.project}.bundle`, mime: "application/x-git-bundle", purpose: "bundle", to, job: jobId }, false);
    refs.push({ project: b.project, file, head: b.head, ...(b.base ? { base: b.base } : {}) });
  }
  const head = (p: string) => bundled.find((b) => b.project === p)?.head;
  const args: Record<string, unknown> =
    type === "selftest" || type === "build" ? { mac: head("ps-mac"), web: head("web"), ...extra }
    : type === "cancel" ? extra
    : { project: bundled[0]?.project, head: bundled[0]?.head, ...extra };
  for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
  const now = Date.now();
  const body: JobBody = { ...base("job", to, jobId), t: "job", exp: now + JOB_MAX_AGE, type, args, ...(refs.length ? { bundles: refs } : {}) };
  const bad = checkJob(body, now);
  if (bad) throw new Error(`Not sent: ${bad}.`);
  const env = await sign(body as unknown as Record<string, unknown>);
  await put("sjob", { env }, { id: jobId });
  void pokeSecond("job");
  return jobId;
}

/** From the panel: start a job on the secondary. */
export async function startJob(type: Exclude<JobType, "cancel">, opts: { project?: string; prompt?: string; preset?: string; only?: string; send?: boolean; model?: "opus" | "sonnet"; minutes?: number; title?: string }) {
  const v = currentView();
  if (!v.peer) { note("Pair a second Mac first."); return null; }
  note(type === "research" ? "Sending the research task..." : type === "claude" ? "Packing the code and sending the task..." : "Packing the code and sending the job...");
  try {
    const projects = type === "research" ? [] : PROJECTS_FOR[type] ?? [opts.project ?? ""];
    const bundled: Bundled[] = [];
    for (const p of projects) bundled.push(await bundleOf(p, v.stat?.have?.[p]));
    const extra: Record<string, unknown> =
      type === "selftest" ? { only: opts.only || undefined }
      : type === "build" ? { send: opts.send || undefined }
      : type === "tests" ? { preset: opts.preset || "auto" }
      : type === "research" ? { prompt: opts.prompt, title: opts.title, model: opts.model, minutes: opts.minutes }
      : { prompt: opts.prompt, model: opts.model, minutes: opts.minutes };
    const id = await submit(type, extra, bundled, v.peer.device);
    note(v.online ? "Sent. It starts in a few seconds." : "Sent. It starts when the second Mac is back online.");
    return id;
  } catch (e) { note((e as Error).message || "Could not send the job."); return null; }
}
export async function cancelJob(job: string) {
  const v = currentView();
  if (!v.peer) return;
  try { await submit("cancel", { job }, [], v.peer.device); note("Asked it to stop."); } catch (e) { note((e as Error).message); }
}
/** A result file (a patch, a zipped app) is landed by PS like any file; this asks for one again. */
export function openDownloads() { post({ type: "second:reveal" }); }

// On the secondary: jobs for this Mac go to PS (with their bundles first). PS checks everything again.
const handed = new Set<string>();
async function runIncoming() {
  const me = local.me;
  if (!me || me.role !== "secondary") return;
  const stDone = new Set(docs<{ job?: string }>("sjobst").map((d) => d.data.job));
  const jobs = docs<{ env?: Env }>("sjob")
    .map((d) => ({ d, b: parseEnv<JobBody>(d.data.env) }))
    .filter((x) => x.b && x.b.to === me.device && !stDone.has(x.b.id) && !handed.has(x.d.id) && Date.now() - x.b.at < JOB_MAX_AGE)
    .sort((a, b) => a.b!.at - b.b!.at);
  for (const { d, b } of jobs) {
    handed.add(d.id);
    for (const ref of b!.bundles ?? []) {
      const f = docs<{ env?: Env; chunks?: string[] }>("sfile").find((x) => x.id === ref.file);
      if (f && !acked(ref.file)) await landFile(f);
    }
    post({ type: "second:run", env: d.data.env, bundles: (b!.bundles ?? []).map((r) => ({ file: r.file, ready: acked(r.file) })) });
  }
}
const acked = (file: string) => docs<{ ref?: string }>("sack").some((a) => a.data.ref === file);

async function storeStatus(env: Env) {
  const b = parseEnv<JobStatusBody>(env);
  if (!b || b.t !== "jobst") return;
  const mine = docs<{ job?: string }>("sjobst").find((d) => d.data.job === b.job);
  const old = parseEnv<JobStatusBody>((mine?.data as { env?: Env } | undefined)?.env);
  await put("sjobst", { job: b.job, env }, mine ? { id: mine.id } : {});
  if (!old || old.state !== b.state || Date.now() - (lastPoke.get(b.job) ?? 0) > 14_000) { lastPoke.set(b.job, Date.now()); void pokeSecond("job"); }
}
const lastPoke = new Map<string, number>();
async function storeStat(env: Env) {
  const b = parseEnv<StatBody>(env);
  if (!b || b.t !== "stat" || b.from !== local.me?.device) return;
  const mine = docs<{ device?: string; env?: Env }>("sstat").find((d) => d.data.device === b.from);
  const old = parseEnv<StatBody>(mine?.data.env);
  await put("sstat", { device: b.from, env }, mine ? { id: mine.id } : {});
  if (!old || old.busy !== b.busy || old.power !== b.power) void pokeSecond("stat");
}

/** The secondary's PS hands over a job's result (Claude's patch, a zipped app) with the file id it already put in the status. */
async function uploadResult(m: Record<string, unknown>) {
  const id = String(m.file ?? ""), to = String(m.to ?? ""), b64s = typeof m.b64 === "string" ? m.b64 : "";
  const purpose = m.purpose === "share" ? "share" : "result";
  if (!/^[0-9a-f-]{36}$/.test(id) || !to || !b64s || !local.me || (purpose === "result" && local.me.role !== "secondary")) return;
  const bytes = Uint8Array.from(atob(b64s), (c) => c.charCodeAt(0));
  if (fileRefusal(bytes.length, 0)) return;
  await upload(bytes, { id, name: String(m.name || "file"), mime: String(m.mime || "application/octet-stream"), purpose, to,
    job: typeof m.job === "string" ? m.job : undefined, get: typeof m.get === "string" ? m.get : undefined }, false).catch(() => {});
}

// The primary tells its PS about the secondary's newest status, for the CLI's state.json (PS checks the signature).
let seenStat = "";
function tellSeen() {
  if (local.me?.role !== "primary") return;
  const v = currentView();
  if (!v.peer) return;
  const d = docs<{ device?: string; env?: Env }>("sstat").find((x) => x.data.device === v.peer!.device);
  const env = d?.data.env;
  if (!env || env.sig === seenStat) return;
  seenStat = env.sig;
  post({ type: "second:seen", env });
}

// ---------- shared folders (protocol.md section 15) ----------
/** PS hands over this Mac's signed index of one shared folder; stored only when it changed. */
async function storeIdx(env: Env) {
  const b = parseEnv<IdxBody>(env);
  if (!b || b.t !== "idx" || b.from !== local.me?.device || !/^[a-z0-9-]{1,40}$/.test(b.root)) return;
  const mine = docs<{ device?: string; root?: string; env?: Env }>("sidx").find((d) => d.data.device === b.from && d.data.root === b.root);
  const old = parseEnv<IdxBody>(mine?.data.env);
  if (old && JSON.stringify(old.entries) === JSON.stringify(b.entries) && old.name === b.name) return;
  await put("sidx", { device: b.from, root: b.root, env }, mine ? { id: mine.id } : {});
  void pokeSecond("idx");
}
/** Ask the other Mac for one of its shared files. `preview` keeps it in PS (pictures, PDFs, text) instead of Downloads. */
export async function fetchShared(device: string, root: string, path: string, as: "download" | "preview" = "download", dragged = false) {
  if (!local.me || !local.trusted.some((t) => t.device === device)) { note("That Mac is not paired."); return null; }
  const body = { ...base("get", device), root, path, as } as GetBody;
  if (checkGet(body)) { note("That file cannot be fetched."); return null; }
  const env = await sign(body as unknown as Record<string, unknown>);
  await put("sget", { env });
  void pokeSecond("get");
  if (as === "download") note(dragged ? `Fetching ${path.split("/").pop()}. It lands where you dropped it.` : `Asked for ${path.split("/").pop()}. It lands in Downloads, From PS.`);
  return body.id;
}
async function storeAck(env: Env) {
  const b = parseEnv<{ t: string; ref: string }>(env);
  if (!b || b.t !== "ack" || typeof b.ref !== "string") return;
  if (docs<{ ref?: string }>("sack").some((a) => a.data.ref === b.ref)) return;
  await put("sack", { ref: b.ref, env });
  void pokeSecond("file");
}

// ---------- remote restart, shut down and lock (protocol.md section 13; the reboot helper runs them) ----------
export async function machineCmd(action: CmdAction) {
  const v = currentView();
  if (!v.peer || local.me?.role !== "primary") { note("Only your primary Mac can do that."); return; }
  const at = Date.now();
  const env = await sign({ v: 1, t: "cmd", id: crypto.randomUUID(), from: local.me.device, to: v.peer.device, at, exp: at + CMD_MAX_AGE, action });
  await put("scmd", { env });
  void pokeSecond("cmd");
  note(action === "lock" ? "Asked it to lock." : action === "cancel" ? "Asked it to cancel." : action === "postpone" ? "Asked it to wait an hour longer before its auto reboot."
    : rebootSet(action) ? "Sent it its auto reboot settings." : v.online
    ? `Asked it to ${action === "restart" ? "restart" : "shut down"}. It stays offline until someone logs in at it.`
    : "Sent. It acts only if it comes online within 2 minutes.");
}
/** Commands and file requests meant for this Mac go to PS once; PS checks the signature, the age and the path. */
const handedOther = new Set<string>();
function handOther() {
  const me = local.me?.device;
  if (!me) return;
  for (const d of docs<{ env?: Env }>("scmd")) {
    const b = parseEnv<{ to: string; at: number; id: string }>(d.data.env);
    if (!b || b.to !== me || handedOther.has(d.id) || Date.now() - b.at > CMD_MAX_AGE || acked(b.id)) continue;
    handedOther.add(d.id);
    post({ type: "second:cmd", env: d.data.env });
  }
  for (const d of docs<{ env?: Env }>("sget")) {
    const b = parseEnv<GetBody>(d.data.env);
    if (!b || b.to !== me || handedOther.has(d.id) || Date.now() - b.at > 48 * 3_600_000 || acked(b.id)) continue;
    if (docs<{ env?: Env }>("sfile").some((f) => parseEnv<FileBody>(f.data.env)?.get === b.id)) continue;
    handedOther.add(d.id);
    post({ type: "second:get", env: d.data.env });
  }
}
/** A preview (asked for with as:"preview") is checked here and kept in PS's own storage for the window, never landed. */
async function keepPreview(d: Doc<{ env?: Env; chunks?: string[] }>, b: FileBody) {
  if (landing.has(b.id) || (d.data.chunks?.length ?? 0) !== b.n) return;   // a streamed preview: once it is all up
  landing.add(b.id);
  try {
    const peer = local.trusted.find((t) => t.device === b.from);
    if (!peer || !d.data.env || !(await verify(peer, d.data.env))) throw new Error("not verified");
    const parts: Uint8Array[] = [];
    for (const c of d.data.chunks ?? []) parts.push(await getBlob(c, null, { cache: false }));
    const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let o = 0;
    for (const x of parts) { all.set(x, o); o += x.length; }
    if (all.length !== b.size || (await sha256hex(all)) !== b.sha256) throw new Error("damaged");
    const g = docs<{ env?: Env }>("sget").map((x) => parseEnv<GetBody>(x.data.env)).find((x) => x?.id === b.get);
    if (!g) throw new Error("no request");
    await putPreview(previewKey(g.to, g.root, g.path), { name: b.name, mime: b.mime, bytes: all });
    const env = await sign({ ...base("ack", b.from), ref: b.id, ok: true });
    await put("sack", { ref: b.id, env });
    for (const c of d.data.chunks ?? []) await deleteBlob(c).catch(() => {});
  } catch { landing.delete(b.id); }
}
export const previewKey = (device: string, root: string, path: string) => `${device}/${root}/${path}`;
const previewGets = () => new Set(docs<{ env?: Env }>("sget").map((d) => parseEnv<GetBody>(d.data.env)).filter((g) => g?.as === "preview").map((g) => g!.id));

// ---------- the CLI on this Mac (scripts/second.ts through PS, protocol.md section 11) ----------
type CliReq = { id: string; type: JobType; args: Record<string, unknown>; bundles?: { project: string; head: string; base?: string }[] };
type CliBundle = Bundled;
const cliJobs = new Map<string, string>();   // job id -> CLI request id
async function cliRequest(r: CliReq, bundles: CliBundle[]) {
  const upd = (state: string, extra: Record<string, unknown> = {}) => post({ type: "second:cli:update", id: r?.id, state, ...extra });
  if (!r || typeof r.id !== "string" || !/^[A-Za-z0-9_-]{6,64}$/.test(r.id)) return;
  const v = currentView();
  if (!v.peer || local.me?.role !== "primary") return upd("refused", { reason: "No paired second Mac" });
  if (!["selftest", "build", "tests", "claude", "cancel"].includes(r.type)) return upd("refused", { reason: "Unknown job type" });
  try {
    const { mac: _m, web: _w, project: _p, head: _h, ...extra } = r.args || {};
    const job = await submit(r.type, extra, bundles, v.peer.device);
    cliJobs.set(job, r.id);
    upd("sent", { job, online: v.online });
  } catch (e) { upd("refused", { reason: (e as Error).message }); }
}
let cliSeen = new Map<string, string>();
function cliProgress() {
  if (!cliJobs.size) return;
  const next = new Map<string, string>();
  for (const d of docs<{ job?: string; env?: Env }>("sjobst")) {
    const id = d.data.job ? cliJobs.get(d.data.job) : undefined;
    if (!id) continue;
    const b = parseEnv<JobStatusBody>(d.data.env);
    if (!b) continue;
    const sig = `${b.state}|${b.at}`;
    next.set(d.data.job!, sig);
    if (cliSeen.get(d.data.job!) === sig) continue;
    post({ type: "second:cli:update", id, state: b.state, job: b.job, status: b });
    if (isDone(b.state)) cliJobs.delete(b.job);
  }
  cliSeen = next;
}

// ---------- signatures shown in the panel (display only) ----------
const checked = new Map<string, boolean>();
async function verifyShown() {
  const ids: string[] = [];
  const peers = new Map(local.trusted.map((t) => [t.device, t]));
  if (local.me) peers.set(local.me.device, { device: local.me.device, pub: local.me.pub, role: local.me.role });
  for (const d of docs<{ env?: Env }>("smsg")) {
    const env = d.data.env;
    if (!env) continue;
    const k = `${d.id}|${env.sig}`;
    if (!checked.has(k)) {
      const p = peers.get(env.by);
      checked.set(k, p ? await verify(p, env) : false);
    }
    if (checked.get(k)) ids.push(d.id);
  }
  if (ids.join() !== local.verified.join()) set({ verified: ids });
}
async function verify(p: Peer, env: Env): Promise<boolean> {
  try {
    const raw = Uint8Array.from(atob(p.pub), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = Uint8Array.from(atob(env.sig), (c) => c.charCodeAt(0));
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, new TextEncoder().encode(env.body));
  } catch { return false; }
}

// ---------- housekeeping (primary, once an hour) ----------
let lastPrune = 0;
async function housekeeping() {
  if (local.me?.role !== "primary" || Date.now() - lastPrune < 3_600_000) return;
  lastPrune = Date.now();
  const all = (k: string) => docs<{ env?: Env; job?: string; ref?: string; at?: number; chunks?: string[] }>(k as never);
  const acks = all("sack");
  const ackRefs = new Set(acks.map((a) => a.data.ref));
  const at = (d: Doc<{ env?: Env; at?: number }>) => parseEnv<{ at: number }>(d.data.env)?.at ?? (Number(d.data.at) || 0);
  const ids = prune({
    now: Date.now(),
    jobs: all("sjob").map((d) => ({ id: d.id, at: at(d) })),
    statuses: all("sjobst").map((d) => ({ id: d.id, job: String(d.data.job) })),
    msgs: all("smsg").map((d) => ({ id: d.id, at: at(d) })),
    files: all("sfile").map((d) => ({ id: d.id, at: at(d), acked: ackRefs.has(d.id) })),
    acks: acks.map((d) => ({ id: d.id, ref: String(d.data.ref), at: at(d) })),
  });
  // v1.2: a file's progress record goes with the file; a month's budget record after two months.
  const live = new Set(all("sfile").map((d) => d.id).filter((id) => !ids.includes(id)));
  for (const g of docs<{ ref?: string }>("sgot")) if (!live.has(String(g.data.ref))) ids.push(g.id);
  const keepMonths = new Set([monthKey(), monthKey(Date.now() - 32 * 86_400_000)]);
  // v1.3: sealed jobs and results after a week.
  for (const k of ["sojob", "sores"] as const) for (const d of docs<{ env?: Env }>(k)) if (Date.now() - (parseEnv<{ at?: number }>(d.data.env)?.at ?? 0) > 7 * 86_400_000) ids.push(d.id);
  for (const b of docs<{ month?: string }>("sbudget")) if (!keepMonths.has(String(b.data.month))) ids.push(b.id);
  for (const id of ids) {
    const f = all("sfile").find((d) => d.id === id);
    for (const c of f?.data.chunks ?? []) await deleteBlob(c).catch(() => {});
    await remove(id).catch(() => {});
  }
}

// ---------- the loop ----------
let timer: number | undefined, running = false, again = false;
function schedule() {
  if (timer !== undefined) return;
  timer = window.setTimeout(() => { timer = undefined; void pass(); }, 300);
}
async function pass() {
  if (!active) return;   // switched off (PS 1.65, stopSecond): nothing runs, nothing is answered
  if (running) { again = true; return; }
  running = true;
  try {
    if (vaultStore.get().status !== "unlocked") return;
    if (!local.me) { if (local.off) await announceOff(local.off); return; }
    tellCode();
    if (local.off) await announceOff(local.off); else await announce();
    void answerSeek();   // not awaited: jobs and files carry on meanwhile
    finishPair();
    await runIncoming();
    const me = local.me.device;
    handOther();
    const previews = previewGets();
    if ([...previews].join() !== (local.previewGets ?? []).join()) set({ previewGets: [...previews] });
    for (const d of docs<{ env?: Env; chunks?: string[] }>("sfile")) {
      const b = parseEnv<FileBody>(d.data.env);
      if (!b || b.to !== me || b.purpose === "bundle" || acked(b.id) || Date.now() - b.at >= 48 * 3_600_000) continue;
      if (b.purpose === "share" && b.get && previews.has(b.get)) await keepPreview(d, b);
      else if (local.caps?.includes("stream")) { if (d.data.chunks?.length) await landStream(d); }
      else await landFile(d);
    }
    await pump();
    handOutsource();
    cliProgress();
    tellSeen();
    await verifyShown();
    await housekeeping();
  } finally {
    running = false;
    if (again) { again = false; schedule(); }
  }
}

/** PS main window: start once the bridge is up (and again after it was switched off, PS 1.65). */
let active = false, hooked = false, retry: number | undefined;
/** The person's Code jobs switch as this page last told PS (PS keeps it, so a restarted PS waits for the page's word). */
let toldCode: boolean | undefined;
function tellCode() {
  const on = codeJobsOn(settingsData(vaultStore.get()));
  if (on !== toldCode) { toldCode = on; post({ type: "second:codeJobs", on }); }
}
export function startSecond(p: Post) {
  post = p;
  toldCode = undefined;
  if (active) return;
  active = true;
  if (!hooked) { hooked = true; vaultStore.subscribe(schedule); onSecondPoke(schedule); }
  post({ type: "second:hello", caps: ["outbox", ...WCAPS] });
  // A lost hello (PS starting up) or a vault that opened later: ask again now and then until PS answers.
  retry = window.setInterval(() => { if (!active || local.native) { clearInterval(retry); retry = undefined; return; } post({ type: "second:hello", caps: ["outbox", ...WCAPS] }); }, 15_000);
  schedule();
}
/** Second Computer switched off (PS 1.65, Settings, Second Computer): the loop stops and the panels empty. PS on the Mac
 *  stops its own half from the same answer (ps-mac Second.setOn). Pairing and keys stay, so On again picks up there. */
export function stopSecond() {
  if (!active) return;
  active = false;
  if (retry !== undefined) { clearInterval(retry); retry = undefined; }
  if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  local = { ...EMPTY_LOCAL };
  listeners.forEach((l) => l());
}

// ---------- the panel's buttons (main window; the Tab list sends the same ops as `secondOp`) ----------
const KEY = /^[0-9a-f-]{36}$/;
export function cleanSecondOp(x: unknown): SecondOp | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" ? v.slice(0, max) : undefined;
  switch (o.op) {
    case "msg": {
      const ids = (v: unknown) => Array.isArray(v) ? v.filter((k): k is string => typeof k === "string" && KEY.test(k)).slice(0, 10) : [];
      const keys = ids(o.keys), files = ids(o.files);
      return typeof o.text === "string" ? { op: "msg", text: o.text.slice(0, MSG_MAX), ...(keys.length ? { keys } : {}), ...(files.length ? { files } : {}) } : null;
    }
    case "outboxDrop": return typeof o.id === "string" && KEY.test(o.id) ? { op: "outboxDrop", id: o.id } : null;
    case "outsource": return typeof o.title === "string" && typeof o.prompt === "string" && o.prompt.trim()
      ? { op: "outsource", title: o.title.slice(0, 80), prompt: o.prompt.slice(0, 8000), model: o.model === "sonnet" ? "sonnet" : o.model === "opus" ? "opus" : undefined,
          minutes: Number.isInteger(o.minutes) ? o.minutes as number : undefined } : null;
    case "codeJobs": return typeof o.on === "boolean" ? { op: "codeJobs", on: o.on } : null;   // the Code jobs switch (PS 1.65)
    case "ocode": {   // a code job (PS 1.65): checked again here and by PS on both Macs
      const j = (o.job && typeof o.job === "object" ? o.job : {}) as Record<string, unknown>;
      if (typeof j.prompt !== "string" || typeof j.repo !== "string" || typeof j.base !== "string") return null;
      return { op: "ocode", job: { prompt: j.prompt.slice(0, 20_000), repo: j.repo.slice(0, 300), base: j.base.slice(0, 100), title: str(j.title, 80), tool: j.tool === "codex" ? "codex" : "claude",
        model: j.model === "sonnet" ? "sonnet" : j.model === "opus" ? "opus" : undefined, minutes: Number.isInteger(j.minutes) ? j.minutes as number : undefined, shots: j.shots === true } };
    }
    case "sendDrop": {
      if (typeof o.key !== "string" || !KEY.test(o.key)) return null;
      const into = typeof o.root === "string" && /^[a-z0-9-]{1,40}$/.test(o.root) && (o.dir === undefined || o.dir === "" || sharePathOk(String(o.dir)));
      return { op: "sendDrop", key: o.key, ...(into ? { root: o.root as string, dir: String(o.dir ?? "") } : {}) };
    }
    case "fetch":
      return typeof o.device === "string" && o.device.length <= 64 && typeof o.root === "string" && typeof o.path === "string" && (o.as === "download" || o.as === "preview")
        ? { op: "fetch", device: o.device, root: o.root.slice(0, 40), path: o.path.slice(0, 1024), as: o.as } : null;
    case "cmd": return cmdAction(String(o.action)) ? { op: "cmd", action: o.action as CmdAction } : null;
    case "window": return { op: "window", tab: typeof o.tab === "string" ? o.tab.slice(0, 20) : undefined };
    case "trustPhone": return typeof o.device === "string" && o.device.length <= 64 ? { op: "trustPhone", device: o.device } : null;
    case "job": return ["selftest", "build", "tests", "claude", "research"].includes(String(o.type))
      ? { op: "job", type: o.type as "selftest", project: str(o.project, 41), prompt: str(o.prompt, 8000), preset: str(o.preset, 20), only: str(o.only, 20), send: o.send === true,
          model: o.model === "sonnet" ? "sonnet" : o.model === "opus" ? "opus" : undefined, title: str(o.title, 80), minutes: Number.isInteger(o.minutes) ? o.minutes as number : undefined }
      : null;
    case "pair": return { op: "pair" };   // one click: PS looks for the other Mac (V1.26)
    case "cancel": case "unpair": {
      const id = o.op === "cancel" ? o.job : o.device;
      if (typeof id !== "string" || id.length > 64) return null;
      return o.op === "cancel" ? { op: "cancel", job: id } : { op: "unpair", device: id };
    }
    case "role": return o.role === "primary" || o.role === "secondary" || o.role === "none" ? { op: "role", role: o.role } : null;
    case "wait": case "projects": case "reveal": case "allow": return { op: o.op };
    default: return null;
  }
}
export function runSecondOp(o: SecondOp) {
  switch (o.op) {
    case "msg": void Promise.all((o.keys ?? []).map(takeDrop)).then((fs) => sendMsg(o.text, fs.filter((f): f is NonNullable<typeof f> => !!f), o.files ?? [])).catch(() => note("Could not send the note.")); break;
    case "outboxDrop": post({ type: "second:outboxDrop", id: o.id }); break;
    case "outsource": outsource(o); break;
    case "ocode": outsourceCode(o.job); break;
    case "codeJobs": void saveSettings({ secondCodeJobs: o.on }).catch(() => note("Could not save the switch.")); break;
    case "sendDrop": void takeDrop(o.key).then((f) => { if (f) void sendFile(f, o.root ? { root: o.root, dir: o.dir ?? "" } : undefined); else note("That file was not found. Drop it again."); }); break;
    case "fetch": void fetchShared(o.device, o.root, o.path, o.as); break;
    case "cmd": void machineCmd(o.action); break;
    case "window": post({ type: "second:window", ...(o.tab ? { tab: o.tab } : {}) }); break;
    case "trustPhone": {   // PS shows the six digit code (pairCode(this Mac, phone)) and asks; the phone shows the same code
      const p = currentView().phones.find((x) => x.device === o.device);
      if (p) post({ type: "second:trustPhone", device: p.device, pub: p.pub, name: p.name });
      break;
    }
    case "job": void startJob(o.type, o); break;
    case "cancel": void cancelJob(o.job); break;
    case "pair": void pair(); break;
    case "unpair": unpair(o.device); break;
    case "role": setRole(o.role); break;
    case "wait": waitForPrimary(); break;
    case "projects": askProjects(); break;
    case "reveal": openDownloads(); break;
    case "allow": allowKey(); break;
  }
}
