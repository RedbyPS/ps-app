// The vault engine: sign in, unlock, encrypted sync with an offline copy, invites.
// Keys live only in memory while unlocked (non-extractable where possible) and are
// dropped on lock. The local copy in IndexedDB is ciphertext only.
import { createClient } from "@supabase/supabase-js";
import * as C from "./crypto";
import type { CalendarSnap, ClientRec, Doc, IEmail, IThread, Kind, Reply, Settings } from "./model";
import { replyIdFor } from "./maildedupe";
import { mailOnSnap } from "./mailsnap";
import { setMailAllowed, setSecondAllowed } from "./mailflag";
import { secondOnSnap } from "./secondsnap";
import { waOnSnap } from "./wasnap";
import { applyInbound as applyWaInbound, applyStatus, chatKey, groupChats, matchClient, prefsOf, waChatIdFor, type WaChat, type WaEvent, type WaStatusEvent } from "./whatsapp";
import { applyInbound, applySent, buildMatcher, clientForInbound, parseAddress, type GmailInbound, type GmailSent } from "./mail";
import { logInbound, mailVerdict, ownAccounts, staleSenders, type MailSender } from "./mailrules";
import { DEFAULT_SETTINGS, uid } from "./model";
import { notify } from "./notify";
import { ownerInviteLink, publicBase, type OwnerInviteRow } from "./ownerInvite";
import { parseRole } from "./account";
import { accountDerive, accountLogin, projectAccountId, projectHandle } from "./accountid";
import { authStorageKey, chooseProject, isMobilePath, localDbName, onRedProject, setActiveProject } from "./project";
import { localCommit, localLogin, localUserId, outKey, rowsKey, type LocalHead } from "./localstore";
import { localKv } from "./localidb";
import type { MoveTarget } from "./move";
import { noteDevice } from "./whatsnew";
import { sealForPhone, type LinkPayload, type MacSide } from "./phonepair";
import { forgetPhoneKeys, readPhoneKeys, savePhoneKeys } from "./phonekeys";
import { feedOfAccount, isFeedSource, okFeedId } from "./calfeeds";

// The Supabase project: the build's own (the developer's vault), or in the PS Mac app the one this Mac was linked to
// in PS's "Connect your own Supabase" setup (core/project.ts; the shell sets window.__psProject first).
export const PROJECT = chooseProject(import.meta.env.MODE, (globalThis as { __psProject?: unknown }).__psProject,
  import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_KEY,
  // The mobile web app (src/mobile/boot.ts sets the flag before this runs), and only on its own address.
  (globalThis as { __psMobile?: unknown }).__psMobile === true && typeof location !== "undefined" && isMobilePath(location.pathname));
setActiveProject(PROJECT);
const SB_URL = PROJECT.url;
const SB_KEY = PROJECT.key;
/** V1.49: on a Supabase project of the person's own, the hidden handle that stands in for a username (core/accountid.ts).
 *  Null on the developer's project and the build's own project, where usernames stay. */
export const PROJECT_HANDLE = projectHandle(PROJECT);
const acctLogin = (username: string) => accountLogin(username, PROJECT);
const acctDerive = (passphrase: string, username: string, iters?: number, extractableKek = false) => accountDerive(passphrase, username, PROJECT, iters, extractableKek);
export const BASE = import.meta.env.BASE_URL; // "/client/"
// The two native apps (PS on the Mac, PS GOS on the developer's GrapheneOS phone) keep the derived keys in the
// device's own key store (Keychain, Keystore) instead of a saved session in web storage.
const NATIVE = import.meta.env.MODE === "ps" || import.meta.env.MODE === "gos";

// Every request gives up in the end (the developer, 28 Oct 2026: the phone's rules never arrived). A phone that
// sleeps, or a VPN that reconnects, can leave a request with no answer forever; without a limit the
// sync that sent it never finished, and every later sync saw "one is already running" and did nothing
// until PS was restarted. Uploads of files get longer.
const LIMIT_MS = 30_000, UPLOAD_LIMIT_MS = 180_000;
function limitedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const ms = /\/storage\/v1\/|\/functions\/v1\//.test(url) ? UPLOAD_LIMIT_MS : LIMIT_MS;
  if (typeof AbortSignal.timeout !== "function") return fetch(input, init);   // an old browser: as before
  const limit = AbortSignal.timeout(ms);
  if (!init?.signal) return fetch(input, { ...init, signal: limit });
  return typeof AbortSignal.any === "function" ? fetch(input, { ...init, signal: AbortSignal.any([init.signal, limit]) }) : fetch(input, init);
}

export const sb = createClient(SB_URL, SB_KEY, {
  // PS (Mac app) keeps nothing in web storage: it signs in again from the macOS Keychain on launch.
  auth: { persistSession: import.meta.env.MODE !== "ps", autoRefreshToken: true, detectSessionInUrl: false, storageKey: authStorageKey(PROJECT) },
  global: { fetch: limitedFetch },
  // A project shared with someone's own app keeps PS in the schema ps (core/project.ts), never in public.
  db: { schema: PROJECT.schema as "public" },
});

const OWNER_KINDS = new Set<Kind>(["client", "pprivate", "todo", "meeting", "draft", "settings", "reply", "brief", "calendar", "iemail", "ithread", "agenda", "journal", "quote", "note", "daylog", "screentime", "stline", "cstats", "cpage", "fup", "irep", "msender", "fprog", "fwork", "fit", "psnote", "tzperson", "tzzones", "tablayout", "remind", "fsleep", "squad", "squadask", "squadjoin", "fact", "phonelayout", "phonedev", "rout", "wachat", "srec", "srkey", "rwd", "sqpast", "bgdev", "rcpt", "mhist",
  "sdev", "spair", "sjob", "sjobst", "smsg", "sfile", "sack", "sstat", "scmd", "sidx", "sget", "sgot", "sbudget", "sojob", "sores"]);   // f*: Fitness (core/fitness.ts); s*: Second Computer (core/second.ts)
// Offline merge (Fitness, 31 Oct 2026): records two devices may change at the same time (a workout logged
// on the phone with no signal while the Mac fixes a weight in it) merge instead of the last write winning.
// A kind with a merger: a remote copy that arrives while this device still has an unsent change of the
// same record is merged into the unsent one (pullRecords), and an unsent change looks at the server first.
type Merger = (local: unknown, remote: unknown) => unknown;
const mergers = new Map<Kind, Merger>();
export function setMerger(kind: Kind, fn: Merger) { mergers.set(kind, fn); }
const mergeable = () => [...outbox.keys()].some((id) => { const k = snap.docs.get(id)?.kind; return !!k && mergers.has(k); });

interface Row {
  id: string;
  workspace_id: string | null;
  author_id: string | null;
  ct: string;
  deleted: boolean;
  updated_at: string | null;
}
interface KeysRow {
  user_id: string;
  kdf: unknown;
  wrapped_vk: string;
  wrapped_vk_recovery: string | null;
  wrapped_vk_prev?: string | null;
  recovery_check: string | null;
  public_key: string | null;
  wrapped_private_key: string | null;
}
interface Meta {
  login: string;
  userId: string;
  role: "owner" | "client";
  red?: boolean;                // the primary owner (the developer): the only account the sealed feeds are sealed to
  primary?: boolean;            // the primary owner of whatever project this is (not clamped to the developer's): client emails may switch on (core/mailswitch.ts)
  keys: KeysRow;
  wsKeys: { workspace_id: string; wrapped_key: string }[];
  cursor: string | null;
  lastSync: string | null;
  /** Local first (V1.44, core/localstore.ts): this vault lives on this device only, its "server" is the device. */
  local?: { since: string } | null;
}

/** What a feature that needs the person's own server says in local mode. */
export const NEEDS_SYNC = "This needs sync: right now your list lives only on this device. Turn on sync in Settings, under Sync and account.";
const localOnly = () => !!meta?.local;

// ---------- tiny IndexedDB key/value store ----------
let dbp: Promise<IDBDatabase> | null = null;
function idb(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(localDbName(PROJECT), 1);   // each linked project keeps its own offline copy
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
async function kvGet<T>(key: string): Promise<T | undefined> {
  if (meta?.local) return localKv.get<T>(key);
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction("kv").objectStore("kv").get(key);
    q.onsuccess = () => res(q.result as T | undefined);
    q.onerror = () => rej(q.error);
  });
}
async function kvSet(key: string, val: unknown): Promise<void> {
  if (meta?.local) return localKv.set(key, val);
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite");
    t.objectStore("kv").put(val, key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
// Never routed to the local vault's database: the engine has no way to delete anything there (core/localstore.ts
// discardLocalBackup is the only delete, after a verified move and the person's confirm).
async function kvDel(key: string): Promise<void> {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("kv", "readwrite");
    t.objectStore("kv").delete(key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

// ---------- state ----------
export type Status = "locked" | "busy" | "unlocked";
export interface Snapshot {
  status: Status;
  role: "owner" | "client" | null;
  red: boolean;                 // The developer's own account (core/account.ts). False for every other owner and client.
  primary: boolean;             // The primary owner of the project this vault is on, any project (core/mailswitch.ts). False until the database says so.
  userId: string | null;
  username: string | null;
  online: boolean;
  syncing: boolean;
  pendingCount: number;
  lastSync: string | null;
  syncError: string | null;
  live?: boolean;               // realtime channel connected
  /** Local first (V1.44): the data lives only on this device until sync is on. null for every synced account. */
  local: { since: string } | null;
  docs: Map<string, Doc>;
  version: number;
}

let snap: Snapshot = {
  status: "locked", role: null, red: false, primary: false, userId: null, username: null,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  syncing: false, pendingCount: 0, lastSync: null, syncError: null, local: null,
  docs: new Map(), version: 0,
};
const listeners = new Set<() => void>();
function emit(patch: Partial<Snapshot> = {}) {
  if (patch.red && !onRedProject()) patch = { ...patch, red: false };   // The developer's features: the developer's project only (fails closed)
  snap = { ...snap, ...patch, version: snap.version + 1 };
  setMailAllowed(snap.primary && (mailOnSnap(snap) || waOnSnap(snap)));   // WhatsApp shares the email panel's place (PS 1.60)
    // the layout, Do Not Disturb and island choices follow the Client emails switch (core/mailflag.ts)
  setSecondAllowed(secondOnSnap(snap));   // PS 1.65: the Second Computer panel in Edit mode follows its switch
  listeners.forEach((l) => l());
}
export const vaultStore = {
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); },
  get: () => snap,
};

// Secrets held only while unlocked.
let VK: CryptoKey | null = null;
let inboxPriv: CryptoKey | null = null;
const WKS = new Map<string, CryptoKey>();
let meta: Meta | null = null;
let rows = new Map<string, Row>();
let outbox = new Map<string, Row>();
let undecryptable = new Set<string>();
let timers: number[] = [];
let lastActivity = Date.now();

const kMeta = (login: string) => `${login}:meta`;
const kRows = (login: string) => `${login}:rows`;
const kOut = (login: string) => `${login}:outbox`;
const kLastUser = "last-username";

async function persist() {
  if (!meta) return;
  // The local vault: meta, records and unsaved changes in ONE transaction (on this device it is the only copy).
  if (meta.local) { await localKv.setMany([[kMeta(meta.login), meta], [kRows(meta.login), Object.fromEntries(rows)], [kOut(meta.login), Object.fromEntries(outbox)]]); return; }
  await kvSet(kMeta(meta.login), meta);
  await kvSet(kRows(meta.login), Object.fromEntries(rows));
  await kvSet(kOut(meta.login), Object.fromEntries(outbox));
}

export async function lastUsername(): Promise<string> {
  return (await kvGet<string>(kLastUser)) || "";
}

// ---------- helpers ----------
async function callAuthFn(body: Record<string, unknown>) {
  const r = await fetch(`${SB_URL}/functions/v1/vault-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SB_KEY },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

function isNetworkError(e: unknown) {
  const m = String((e as Error)?.message || e);
  return /fetch|network|Failed to fetch|NetworkError|Load failed|timed? ?out|abort/i.test(m);   // a request past its limit counts as offline
}

async function signIn(login: string, password: string) {
  const { data, error } = await sb.auth.signInWithPassword({ email: login, password });
  if (error) {
    if (/invalid login credentials/i.test(error.message)) throw new Error("Wrong username or passphrase.");
    throw error;
  }
  return data.user!.id;
}

async function fetchKeys(userId: string): Promise<KeysRow | null> {
  const { data, error } = await sb.from("user_keys").select("*").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data as KeysRow | null;
}
// Which account this is. vault_role() (migration 025) answers "red", "owner" or "client". Until 025 is
// applied it does not exist, and is_owner() (true only for the developer then) answers instead.
async function fetchRole(): Promise<{ role: "owner" | "client"; red: boolean }> {   // red here is the database's answer: the primary owner of THIS project (clamped later)
  const { data, error } = await sb.rpc("vault_role");
  if (!error) return parseRole(data);
  if (error.code !== "PGRST202" && error.code !== "42883") throw error;
  const { data: own, error: e2 } = await sb.rpc("is_owner");
  if (e2) throw e2;
  return own ? { role: "owner", red: true } : { role: "client", red: false };
}
async function fetchWsKeys(userId: string) {
  const { data, error } = await sb.from("workspace_keys").select("workspace_id, wrapped_key").eq("user_id", userId);
  if (error) throw error;
  return (data || []) as { workspace_id: string; wrapped_key: string }[];
}

async function decryptRow(r: Row): Promise<Doc | null> {
  const key = r.workspace_id ? WKS.get(r.workspace_id) : VK;
  if (!key) { undecryptable.add(r.id); return null; }
  try {
    const p = await C.decryptJson<{ kind: Kind; data: unknown }>(key, r.ct, C.aad.record(r.id, r.workspace_id));
    undecryptable.delete(r.id);
    if (r.deleted || (p.kind as string) === "_deleted") return null;
    if (!scopeOk(p.kind, r)) return null;
    return { id: r.id, ws: r.workspace_id, kind: p.kind, data: p.data, author: r.author_id, updatedAt: r.updated_at };
  } catch {
    undecryptable.add(r.id);
    return null;
  }
}

// A record's kind must match its scope, and in a client workspace only the owner may
// author the documents that describe the project. Stops a client planting fake to-dos,
// settings or projects that would show up in the developer's lists.
const OWNER_AUTHORED_SHARED = new Set<Kind>(["project", "ctask", "update", "wsmeta", "doc"]);
// Claude, the trusted assistant the developer allowed into client workspaces (Settings > Claude access):
// its records count as the developer's. The list comes from the developer's own encrypted settings, never the server.
let trustedAgents = new Set<string>();
export function setTrustedAgents(ids: string[]) {
  const next = new Set(ids.filter(Boolean));
  if (next.size === trustedAgents.size && [...next].every((x) => trustedAgents.has(x))) return;
  trustedAgents = next;
  void rebuildDocs();
}
function scopeOk(kind: Kind, r: Row): boolean {
  if (r.workspace_id === null) return OWNER_KINDS.has(kind) || kind === "project" || kind === "doc";
  if (OWNER_KINDS.has(kind)) return false;
  if (meta?.role === "owner" && OWNER_AUTHORED_SHARED.has(kind) && r.author_id && r.author_id !== meta.userId && !trustedAgents.has(r.author_id)) return false;
  // A client takes a project, its tasks, updates, files and the workspace name only from the workspace's owner,
  // never from another member (who could otherwise plant a fake one, or a fake owner name).
  if (meta?.role === "client" && OWNER_AUTHORED_SHARED.has(kind) && trustedAuthors) {
    const t = trustedAuthors.get(r.workspace_id);
    if (!t || !r.author_id || !t.has(r.author_id)) return false;
  }
  return true;
}

async function loadWsKeys(list: { workspace_id: string; wrapped_key: string }[]) {
  for (const w of list) {
    if (WKS.has(w.workspace_id)) continue;
    try { WKS.set(w.workspace_id, await C.unwrapKey(VK!, w.wrapped_key, C.aad.wk(w.workspace_id))); } catch { /* not ours */ }
  }
}

async function rebuildDocs() {
  const docs = new Map<string, Doc>();
  for (const r of rows.values()) {
    const pending = outbox.get(r.id);
    const d = await decryptRow(pending ?? r);
    if (d) docs.set(d.id, { ...d, pending: !!pending });
  }
  for (const [id, r] of outbox) {
    if (rows.has(id)) continue;
    const d = await decryptRow(r);
    if (d) docs.set(d.id, { ...d, pending: true });
  }
  emit({ docs, pendingCount: outbox.size });
}

// ---------- unlock / lock ----------
/** V1.53 (What's new): did this device already hold an offline copy when this build first opened it? Told once, on the
 *  first unlock, so a device updated from an old version (that kept no What's new record) lists the last few
 *  versions, and a brand new device lists nothing old (core/whatsnew.ts). */
function markDevice(hadCopy: boolean) {
  try { if (typeof localStorage !== "undefined") noteDevice(hadCopy, localStorage); } catch { /* storage not there */ }
}
async function finishUnlock(login: string, username: string, userId: string, role: "owner" | "client", keys: KeysRow, vk: CryptoKey, red = false, fresh = false): Promise<boolean> {
  // Turn on sync (local first, V1.44): a local vault waiting to move goes into this account BEFORE the account opens,
  // so nothing else writes into it meanwhile. The gate (src/localfirst.ts) answers the verified rows, or null when there
  // is nothing to move; it throws when the person went back to their data on this device instead.
  let moved: Row[] | null = null;
  if (moveGate && role === "owner" && !red) moved = await moveGate({ target: serverTarget(vk), userId, fresh });
  VK = vk;
  seen = {}; lastResync = 0; inboxRetry = false;
  const cached = await kvGet<Meta>(kMeta(login));
  markDevice(!!cached && cached.userId === userId && !!cached.lastSync);
  meta = {
    login, userId, role, red: role === "owner" && red && onRedProject(), primary: role === "owner" && (red || (!!cached && cached.userId === userId && !!cached.primary)), keys,
    wsKeys: cached?.wsKeys ?? [],
    cursor: cached && cached.userId === userId ? cached.cursor : null,
    lastSync: cached?.lastSync ?? null,
  };
  if (cached && cached.userId === userId) {
    rows = new Map(Object.entries((await kvGet<Record<string, Row>>(kRows(login))) || {}));
    outbox = new Map(Object.entries((await kvGet<Record<string, Row>>(kOut(login))) || {}));
  } else {
    rows = new Map(); outbox = new Map();
  }
  if (moved) for (const r of moved) rows.set(r.id, r);   // already read back and checked: nothing is downloaded twice
  if (role === "owner" && keys.wrapped_private_key) {
    try { inboxPriv = await C.importInboxPrivate(await C.decryptBytes(vk, keys.wrapped_private_key, C.aad.priv)); } catch { inboxPriv = null; }
  }
  await loadWsKeys(meta.wsKeys);
  await kvSet(kLastUser, username);
  await rebuildDocs();
  lastActivity = Date.now();
  emit({ status: "unlocked", role, red: !!meta.red, primary: !!meta.primary, userId, username, lastSync: meta.lastSync, syncError: null });
  startLoops();
  void saveSession();
  void sync();
  void confirmRole();
  return !!moved;
}

// ---------- Turn on sync: the move's way into this account (core/move.ts MoveTarget) ----------
export type MoveGate = (a: { target: MoveTarget; userId: string; fresh: boolean }) => Promise<Row[] | null>;
let moveGate: MoveGate | null = null;
/** src/localfirst.ts: set while a local vault on this device waits to move into the account that opens next. */
export function setMoveGate(g: MoveGate | null) { moveGate = g; }
function serverTarget(vk: CryptoKey): MoveTarget {
  return {
    stamps: async () => (await listStamps(null)).map((s) => ({ id: s.id, deleted: s.deleted })),
    fetch: async (ids) => {
      if (!ids.length) return [];
      const { data, error } = await sb.from("records").select("id, workspace_id, author_id, ct, deleted, updated_at").in("id", ids);
      if (error) throw error;
      return (data || []) as Row[];
    },
    upsert: async (list) => {
      const { data, error } = await sb.from("records").upsert(list, { onConflict: "id" }).select("id, workspace_id, author_id, deleted, updated_at");
      if (error) throw error;
      const ct = new Map(list.map((r) => [r.id, r.ct]));
      return ((data || []) as Omit<Row, "ct">[]).map((r) => ({ ...r, ct: ct.get(r.id)! })) as Row[];
    },
    encrypt: (id, p) => C.encryptJson(vk, p, C.aad.record(id, null)),
    decrypt: (r) => C.decryptJson(vk, r.ct, C.aad.record(r.id, r.workspace_id)),
    isNetworkError,
  };
}

// ---------- local first: the local vault (core/localstore.ts opens it; this runs it) ----------
/** Opens the local vault with its key (from core/localstore.ts openLocalVault). Same records, same put and remove,
 *  same docs; saving commits on this device instead of sending to a server. No network at all. */
export async function unlockLocal(head: LocalHead, vk: CryptoKey) {
  if (meta) lock();
  emit({ status: "busy" });
  try {
    VK = vk;
    seen = {}; lastResync = 0; inboxRetry = false;
    const login = localLogin(head), userId = localUserId(head);
    markDevice(Date.parse(head.createdAt) < Date.now() - 10 * 60_000);   // a local vault made just now is a brand new device
    const keys: KeysRow = { user_id: userId, kdf: { local: 1 }, wrapped_vk: "", wrapped_vk_recovery: null, recovery_check: null, public_key: null, wrapped_private_key: null };
    meta = { login, userId, role: "owner", red: false, keys, wsKeys: [], cursor: null, lastSync: null, local: { since: head.createdAt } };
    rows = new Map(Object.entries((await localKv.get<Record<string, Row>>(rowsKey(head))) || {}));
    outbox = new Map(Object.entries((await localKv.get<Record<string, Row>>(outKey(head))) || {}));
    if (outbox.size) await flush();   // changes saved but not committed when the app last closed
    meta.lastSync = new Date().toISOString();
    await rebuildDocs();
    lastActivity = Date.now();
    emit({ status: "unlocked", role: "owner", red: false, userId, username: head.name || null, lastSync: meta.lastSync, syncError: null, local: { since: head.createdAt } });
    startLoops();
  } catch (e) {
    lock();
    throw e;
  }
}
export const isLocal = () => !!meta?.local;

// The role as the server sees it, once per unlock while online (cached copies and saved sessions can be old).
// Until it is confirmed, nothing writes the owner's name into a client's workspace (actions.ts).
let roleConfirmedFor: string | null = null;
export function roleConfirmed() { return !!meta && roleConfirmedFor === meta.userId; }
async function confirmRole() {
  if (!meta || !navigator.onLine) return;
  const m = meta;
  try {
    const r = await fetchRole();
    const primary = r.role === "owner" && r.red;   // the database says primary owner of THIS project (any project)
    r.red = r.red && onRedProject();   // the first owner of any other project is "red" there; never the developer here
    if (meta !== m) return;
    roleConfirmedFor = m.userId;
    if (primary !== !!m.primary) { m.primary = primary; await persist(); emit({ primary }); }
    if (r.role !== m.role) { lock(); return; }   // an owner became a client or the reverse: sign in again
    if (r.red !== !!m.red) {
      m.red = r.red;
      await persist();
      emit({ red: r.red });
      startRealtime();
    }
    if (m.role === "client") await loadTrustedAuthors();
  } catch { /* offline or old database: try again next unlock */ }
}

// Clients only: who may write a workspace's project documents (its owner, the developer's assistant in the developer's
// workspaces). From workspace_trusted_authors() (migration 025); before 025 it does not exist and nothing changes.
let trustedAuthors: Map<string, Set<string>> | null = null;
async function loadTrustedAuthors() {
  const { data, error } = await sb.rpc("workspace_trusted_authors");
  if (error || !Array.isArray(data)) return;
  const m = new Map<string, Set<string>>();
  for (const r of data as { workspace_id: string; user_id: string }[]) {
    if (!m.has(r.workspace_id)) m.set(r.workspace_id, new Set());
    m.get(r.workspace_id)!.add(r.user_id);
  }
  trustedAuthors = m;
  await rebuildDocs();
}

// ---------- stay unlocked across a page refresh (until auto-lock) ----------
// The unlocked keys are CryptoKey objects that cannot be exported; IndexedDB can hold them
// as they are, so a refresh on this device reopens the vault without the passphrase until
// the auto-lock window passes. Lock (or auto-lock) deletes them immediately.
const kSession = "session";
const SESSION_MAX_MIN = 12 * 60;
interface SavedSession {
  login: string; username: string; userId: string; role: "owner" | "client"; red?: boolean;
  vk: CryptoKey; wks: [string, CryptoKey][]; inboxPriv: CryptoKey | null; expires: number;
}
function sessionWindowMs() {
  const m = autoLockMinutes();
  return (m > 0 ? Math.min(m, SESSION_MAX_MIN) : SESSION_MAX_MIN) * 60_000;
}
let sessionSavedFor = 0;
async function saveSession() {
  if (NATIVE) return; // PS keeps its keys in the macOS Keychain instead (src/ps.ts), PS GOS in the Keystore (src/gos)
  if (!meta || !VK || !snap.username || meta.local) return;   // the local vault opens with its device key anyway
  sessionSavedFor = lastActivity;
  const s: SavedSession = {
    login: meta.login, username: snap.username, userId: meta.userId, role: meta.role, red: !!meta.red,
    vk: VK, wks: [...WKS.entries()], inboxPriv, expires: lastActivity + sessionWindowMs(),
  };
  try { await kvSet(kSession, s); } catch { /* storage blocked: refresh will ask for the passphrase */ }
}

/** Reopen the vault after a refresh if this device still holds an unexpired session. */
export async function restoreSession(): Promise<boolean> {
  if (NATIVE) {
    // PS: clear anything an earlier PS build kept in web storage; the Keychain replaces it.
    await kvDel(kSession).catch(() => {});
    // (PS GOS keeps its Supabase login there: its background checks share it, see unlockOnDevice.)
    if (import.meta.env.MODE === "ps") try { localStorage.removeItem("cincee-vault-auth"); } catch { /* ignore */ }
    return false;
  }
  let s: SavedSession | undefined;
  try { s = await kvGet<SavedSession>(kSession); } catch { return restorePhone(); }
  if (!s || !s.vk) return restorePhone();
  if (Date.now() > s.expires) { await kvDel(kSession).catch(() => {}); return restorePhone(); }
  const cached = await kvGet<Meta>(kMeta(s.login));
  if (!cached || cached.userId !== s.userId) { await kvDel(kSession).catch(() => {}); return restorePhone(); }
  markDevice(!!cached.lastSync);
  emit({ status: "busy" });
  try {
    VK = s.vk;
    inboxPriv = s.inboxPriv ?? null;
    WKS.clear();
    for (const [ws, k] of s.wks) WKS.set(ws, k);
    meta = { ...cached, role: s.role, red: s.role === "owner" && (s.red ?? true) && onRedProject() };   // saved before multi-owner: the only owner was the developer
    rows = new Map(Object.entries((await kvGet<Record<string, Row>>(kRows(s.login))) || {}));
    outbox = new Map(Object.entries((await kvGet<Record<string, Row>>(kOut(s.login))) || {}));
    await loadWsKeys(meta.wsKeys);
    await rebuildDocs();
    lastActivity = Date.now();
    emit({ status: "unlocked", role: s.role, red: !!meta.red, primary: !!meta.primary, userId: s.userId, username: s.username, lastSync: meta.lastSync, syncError: null });
    startLoops();
    void saveSession();
    void sync();
    if (MOBILE_PAGE) void readPhoneKeys(PROJECT.url).then((k) => { if (k && k.u === s!.username) { phoneDevice = k.d; void phoneStillLinked(); } });
    return true;
  } catch {
    lock();
    return false;
  }
}

// PS Mac app only: after a sign-in with the passphrase, hand the DERIVED keys (never the
// passphrase) to the app, which keeps them in the macOS Keychain to sign in again next launch.
let psRememberHook: ((username: string, authPassword: string, kekRaw: string) => void) | null = null;
export function setPsRememberHook(fn: typeof psRememberHook) { if (NATIVE) psRememberHook = fn; }

/** PS Mac app only: sign in with the derived keys from the Keychain. */
export async function unlockRemembered(username: string, authPassword: string, kekRaw: string) {
  if (!NATIVE) throw new Error("PS only.");
  const kek = await C.importAesRaw(C.unb64url(kekRaw));
  await unlock(username, "", { authPassword, kek });
  holdLinkCreds(username, authPassword, kekRaw);
}

/** PS GOS only: open with the derived keys from the phone's Keystore and the Supabase login this
 *  phone already holds, so reopening (and each background check) is not a new sign in. Falls back
 *  to a normal sign in when that login is gone or belongs to someone else. */
export async function unlockOnDevice(username: string, authPassword: string, kekRaw: string) {
  if (import.meta.env.MODE !== "gos") throw new Error("PS GOS only.");
  const kek = await C.importAesRaw(C.unb64url(kekRaw));
  const login = await acctLogin(username);
  const cached = await kvGet<Meta>(kMeta(login));
  const session = navigator.onLine ? (await sb.auth.getSession().catch(() => null))?.data.session ?? null : null;
  if (!cached || !session || session.user.id !== cached.userId) return unlock(username, "", { authPassword, kek });
  emit({ status: "busy" });
  let vk: CryptoKey;
  try { vk = await C.unwrapKey(kek, cached.keys.wrapped_vk, C.aad.vk); }
  catch { return unlock(username, "", { authPassword, kek }); }   // passphrase changed elsewhere: sign in properly
  try { await finishUnlock(login, username.trim(), cached.userId, cached.role, cached.keys, vk, cached.red ?? cached.role === "owner"); }
  catch (e) { emit({ status: "locked" }); throw e; }
}

export async function unlock(username: string, passphrase: string, derived?: { authPassword: string; kek: CryptoKey }, opts: { remember?: boolean } = {}) {
  if (!username.trim() || (!passphrase && !derived)) throw new Error("Enter your username and passphrase.");
  if (meta) lock();   // never carry one account's keys or caches into the next
  emit({ status: "busy" });
  try {
    const login = await acctLogin(username);
    const ps = NATIVE;
    const d = derived ?? await acctDerive(passphrase, username, undefined, ps);
    let userId: string | null = null;
    let keys: KeysRow | null = null;
    let role: "owner" | "client" | null = null;
    let red = false;
    let offline = !navigator.onLine;
    if (!offline) {
      try {
        userId = await signIn(login, d.authPassword);
        keys = await fetchKeys(userId);
        ({ role, red } = await fetchRole());
      } catch (e) {
        if (!isNetworkError(e)) throw e;
        offline = true;
      }
    }
    const cached = await kvGet<Meta>(kMeta(login));
    if (offline) {
      if (!cached) throw new Error("You are offline and this device has no saved copy yet. Connect once to sign in.");
      userId = cached.userId; keys = cached.keys; role = cached.role; red = cached.red ?? cached.role === "owner";
    }
    if (!keys) throw new Error("This account has no vault keys yet. Finish setup from your invite link.");
    let vk: CryptoKey;
    try { vk = await C.unwrapKey(d.kek, keys.wrapped_vk, C.aad.vk); }
    catch {
      // An interrupted passphrase change leaves the previous wrap: the old passphrase still works.
      if (!keys.wrapped_vk_prev) throw new Error("Wrong username or passphrase.");
      try { vk = await C.unwrapKey(d.kek, keys.wrapped_vk_prev, C.aad.vk); } catch { throw new Error("Wrong username or passphrase."); }
      if (!offline) {
        await sb.from("user_keys").update({ wrapped_vk: keys.wrapped_vk_prev, wrapped_vk_prev: null }).eq("user_id", userId!);
        keys = { ...keys, wrapped_vk: keys.wrapped_vk_prev, wrapped_vk_prev: null };
      }
    }
    if (keys.wrapped_vk_prev && !offline) {
      await sb.from("user_keys").update({ wrapped_vk_prev: null }).eq("user_id", userId!);
      keys = { ...keys, wrapped_vk_prev: null };
    }
    await finishUnlock(login, username.trim(), userId!, role!, keys, vk, red);
    let kekRaw = "";
    if (ps && d.kek.extractable) { try { kekRaw = C.b64url(new Uint8Array(await crypto.subtle.exportKey("raw", d.kek))); } catch { /* not exportable */ } }
    if (kekRaw) holdLinkCreds(username.trim(), d.authPassword, kekRaw);
    if (ps && (opts.remember ?? !derived) && psRememberHook && kekRaw) {
      try { psRememberHook(username.trim(), d.authPassword, kekRaw); }
      catch { /* not remembered: PS asks for the password next launch */ }
    }
    // An account made with a username, signed in with its passphrase on a project of the person's own: keep the sealed
    // account hint up to date, so any new device opens it with the passphrase alone (V1.55, writeAccountHint).
    if (passphrase && !offline) void writeAccountHint(passphrase, username.trim());
  } catch (e) {
    emit({ status: "locked" });
    throw e;
  }
}

// ---------- V1.55: passphrase only sign in for every account, and phones signed in from the Mac ----------
// The Mac's own sign in, held in memory while unlocked, for "Link your iPhone" (src/core/phonepair.ts). These are the
// same derived keys Remember me keeps in the Keychain (never the passphrase). PS on the Mac only; cleared by lock().
let linkCreds: { username: string; auth: string; kek: string } | null = null;
function holdLinkCreds(username: string, auth: string, kek: string) {
  if (import.meta.env.MODE === "ps") linkCreds = { username, auth, kek };
}
/** Whether this Mac can sign a phone in right now (unlocked, with its keys in memory). */
export function canLinkPhone(): boolean { return !!linkCreds && !!meta && !meta.local; }

/** Where passphrase only sign in applies: a project of the person's own, never the developer's (many accounts there). */
function hintProject(): string | null {
  return PROJECT_HANDLE && PROJECT.custom && !onRedProject() ? projectAccountId(PROJECT) : null;
}
/** After a passphrase sign in of an account made with a username: seal its username for new devices (ps_hint_set).
 *  Best effort and quiet: without migration 029 or offline, nothing changes and the username field stays the way. */
async function writeAccountHint(passphrase: string, username: string) {
  const id = hintProject();
  if (!id || !username || username === PROJECT_HANDLE || !meta || meta.local) return;
  try {
    const d = await C.deriveForProjectWithHint(passphrase, id);
    const h = await C.sealHint(d, username);
    await sb.rpc("ps_hint_set", { p_check: h.check, p_sealed: h.sealed });
  } catch { /* old project or offline: next sign in tries again */ }
}

/** Sign in with the passphrase alone on a project of the person's own (views/Lock.tsx). First as the passphrase only
 *  account (V1.49), with the exact keys it always had; if this project's account was made with a username instead,
 *  its sealed hint gives the username and it signs in with the same keys and login id it always had. */
export async function unlockPassphraseOnly(passphrase: string) {
  const id = hintProject();
  if (!id || !PROJECT_HANDLE) throw new Error("Enter your username and passphrase.");
  if (!passphrase) throw new Error("Enter your passphrase.");
  emit({ status: "busy" });
  let d: C.ProjectDerived;
  try { d = await C.deriveForProjectWithHint(passphrase, id, undefined, NATIVE); }
  catch (e) { emit({ status: "locked" }); throw e; }
  try {
    await unlock(PROJECT_HANDLE, passphrase, { authPassword: d.authPassword, kek: d.kek }, { remember: true });
    return;
  } catch (e) {
    if (!/wrong username or passphrase/i.test((e as Error).message || "") || !navigator.onLine) throw e;
    let name: string | null = null;
    try {
      const { data } = await sb.rpc("ps_hint_get", { p_token: d.hintToken });
      if (typeof data === "string") name = await C.openHint(d, data);
    } catch { /* no hint table yet, or too many tries: the username field is the way */ }
    if (!name || name === PROJECT_HANDLE) throw e;
    await unlock(name, passphrase);
  }
}

// The Mac, after Allow: the sign in for the phone that claimed this offer, sealed so only it can open it, plus a row in
// this account's phone list (Remove device). Never the passphrase; never logged.
export async function sealLinkFor(m: MacSide, phonePub: string): Promise<{ sealed: string; device: string }> {
  if (!linkCreds || !meta || meta.local) throw new Error("Lock PS and sign in again on this Mac, then show a new code.");
  const { data, error } = await sb.from("ps_devices").insert({ kind: "phone" }).select("id").single();
  if (error || !data) throw new Error("PS could not add the phone to your account. Update PS on this Mac, then try again.");
  const device = String((data as { id: string }).id);
  try {
    return { sealed: await sealForPhone(m, phonePub, { v: 1, u: linkCreds.username, a: linkCreds.auth, k: linkCreds.kek, d: device }), device };
  } catch (e) {
    await sb.from("ps_devices").delete().eq("id", device);
    throw e;
  }
}
export interface LinkedPhone { id: string; kind: string; created_at: string }
export async function listPhones(): Promise<LinkedPhone[]> {
  if (!meta || meta.local) return [];
  const { data, error } = await sb.from("ps_devices").select("id, kind, created_at").order("created_at", { ascending: true });
  if (error) return [];
  return (data || []) as LinkedPhone[];
}
/** Remove device: the phone forgets its keys the next time it opens (phoneStillLinked). */
export async function removePhone(id: string): Promise<boolean> {
  const { error } = await sb.from("ps_devices").delete().eq("id", id);
  return !error;
}

// The phone (mobile web app): open with the keys the Mac sent (src/core/phonekeys.ts), the way Remember me opens a Mac.
const MOBILE_PAGE = (globalThis as { __psMobile?: unknown }).__psMobile === true && !NATIVE;
let phoneDevice: string | null = null;
async function restorePhone(): Promise<boolean> {
  if (!MOBILE_PAGE) return false;
  const k = await readPhoneKeys(PROJECT.url);
  if (!k) return false;
  try {
    await unlock(k.u, "", { authPassword: k.a, kek: await C.importAesRaw(C.unb64url(k.k)) });
  } catch (e) {
    // Passphrase changed on another device: these keys are done. Offline or a hiccup: keep them for next time.
    if (/wrong username or passphrase|no vault keys/i.test((e as Error).message || "")) await forgetPhoneKeys(PROJECT.url);
    return false;
  }
  phoneDevice = k.d;
  void phoneStillLinked();
  return true;
}
/** Removed on the Mac: forget the keys here and lock. Only a clear "not in the list" counts (offline keeps it). */
async function phoneStillLinked() {
  const d = phoneDevice;
  if (!d || !navigator.onLine) return;
  const { data, error } = await sb.from("ps_devices").select("id").eq("id", d);
  if (error || !Array.isArray(data) || data.length || phoneDevice !== d) return;
  phoneDevice = null;
  if (import.meta.env.MODE === "gos") { try { localStorage.removeItem(GOS_DEVICE); } catch { /* ignore */ } onPhoneRemoved?.(); }
  else await forgetPhoneKeys(PROJECT.url);
  lock();
}
/** The phone's own Lock: forget the Mac's keys here and take this phone off the list; the passphrase opens it again. */
export async function lockPhone() {
  const d = phoneDevice;
  phoneDevice = null;
  await forgetPhoneKeys(PROJECT.url);
  if (d && meta && navigator.onLine) await sb.from("ps_devices").delete().eq("id", d).then(() => {}, () => {});
  lock();
}
/** The phone, after the Mac's Allow (src/mobile/Pair.tsx): sign in with what the Mac sealed for it. The iPhone web app
 *  keeps it under a non extractable WebCrypto key (core/phonekeys.ts); PS GOS hands it to its Keystore the same way a
 *  passphrase sign in does (remember:save, behind the fingerprint). */
export async function unlockFromMac(p: LinkPayload) {
  if (import.meta.env.MODE === "gos") {
    await unlock(p.u, "", { authPassword: p.a, kek: await C.importAesRaw(C.unb64url(p.k), true) }, { remember: true });
    try { localStorage.setItem(GOS_DEVICE, JSON.stringify({ u: p.u, d: p.d })); } catch { /* the Remove check is skipped */ }
    phoneDevice = p.d;
    return;
  }
  if (!MOBILE_PAGE) throw new Error("Only a phone signs in this way.");
  await unlock(p.u, "", { authPassword: p.a, kek: await C.importAesRaw(C.unb64url(p.k)) });
  await savePhoneKeys(PROJECT.url, { u: p.u, a: p.a, k: p.k, d: p.d });
  phoneDevice = p.d;
}
const GOS_DEVICE = "ps.gos.device";
let onPhoneRemoved: (() => void) | null = null;
/** PS GOS: what to do when the Mac removed this phone (forget the Keystore keys). */
export function setOnPhoneRemoved(f: (() => void) | null) { onPhoneRemoved = f; }
/** PS GOS: after a fingerprint sign in, check this phone was not removed on the Mac. */
export function gosPhoneCheck(username: string) {
  if (import.meta.env.MODE !== "gos") return;
  try {
    const o = JSON.parse(localStorage.getItem(GOS_DEVICE) || "null") as { u?: string; d?: string } | null;
    if (o?.u === username && typeof o.d === "string") { phoneDevice = o.d; void phoneStillLinked(); }
  } catch { /* nothing kept */ }
}
/** Whether this phone stays signed in with the Mac's keys (no auto lock, like Stay signed in on PS GOS). */
export const phoneKept = () => !!phoneDevice;

export function lock() {
  void kvDel(kSession).catch(() => {});
  linkCreds = null; phoneDevice = null;
  stopLoops();
  VK = null; inboxPriv = null; WKS.clear(); meta = null; trustedAuthors = null; roleConfirmedFor = null;
  rows = new Map(); outbox = new Map(); undecryptable = new Set();
  mailCache = new Map(); mailSkip = new Set(); mailGone = new Set(); sentCache = new Map();
  pkgQueue = []; importing.clear();
  seen = {}; lastResync = 0; inboxRetry = false;
  blobCache.clear();
  emit({ status: "locked", docs: new Map(), role: null, red: false, primary: false, userId: null, pendingCount: 0, local: null });
}

export async function signOutAndForget() {
  if (meta?.local) { lock(); return; }   // the local vault is the only copy: signing out never deletes it
  const login = meta?.login;
  lock();
  await sb.auth.signOut().catch(() => {});
  if (login) { await kvDel(kMeta(login)); await kvDel(kRows(login)); await kvDel(kOut(login)); }
  await kvDel(kLastUser);
}

// ---------- owner setup / recovery / passphrase change ----------
async function seedOwner(red: boolean, name?: string) {
  // V1.49: no name at sign up any more. Empty until they give one (G Squad asks for it in plain words); greetings
  // and email drafts read fine without it.
  await put("settings", { ...DEFAULT_SETTINGS, ...(red ? {} : { ownerName: (name || "").trim().slice(0, 40) }) }, { ws: null });
  const now = new Date().toISOString();
  // The developer's own first tasks; everyone else starts with one neutral example they can delete.
  const seeds = red ? [
    { title: "Gym", type: "daily" },
    { title: "Psychology lesson", type: "daily" },
    { title: "Check client replies and follow ups", type: "daily" },
  ] : [{ title: "Add your first task", type: "once" }];
  let i = 0;
  for (const s of seeds) await put("todo", { ...s, done: false, order: i++, source: "manual", createdAt: now }, { ws: null });
}

/** Start now (local first): the same first settings and task as a new account's own Create account. */
export function seedNewOwner(name?: string) { return seedOwner(false, name); }

export async function ownerSetup(code: string, username: string, passphrase: string, onRecovery?: (key: string) => void, name?: string): Promise<string> {
  if (meta) lock();
  emit({ status: "busy" });
  try {
    const login = await acctLogin(username);
    const d = await acctDerive(passphrase, username);
    await callAuthFn({ action: "owner_setup", code: code.trim(), email: login, password: d.authPassword });
    const userId = await signIn(login, d.authPassword);
    const vk = await C.newAesKey();
    const recovery = C.randomBytes(32);
    const r = await C.deriveFromRecovery(recovery);
    const kp = await C.newInboxKeypair();
    const keys: KeysRow = {
      user_id: userId,
      kdf: C.KDF_PARAMS,
      wrapped_vk: await C.wrapKey(d.kek, vk, C.aad.vk),
      wrapped_vk_recovery: await C.wrapKey(r.kek, vk, C.aad.vkRecovery),
      recovery_check: await C.sha256hex(r.authToken),
      public_key: kp.publicKey,
      wrapped_private_key: await C.encryptBytes(vk, kp.privatePkcs8, C.aad.priv),
    };
    const { error } = await sb.from("user_keys").insert(keys);
    if (error) throw error;
    const vkLocked = await C.unwrapKey(d.kek, keys.wrapped_vk, C.aad.vk);
    onRecovery?.(C.formatRecovery(recovery)); // show the key before the app opens
    // owner_setup only ever creates the primary owner (app_owner): the developer on his own project. On a project
    // someone linked themselves (PS "Create account", 5 Nov 2026) it is them, with none of the developer's features.
    const red = onRedProject();
    const moved = await finishUnlock(login, username.trim(), userId, "owner", keys, vkLocked, red, true);
    if (!moved) await seedOwner(red, name);   // a moved local vault brings its own settings and tasks
    return C.formatRecovery(recovery);
  } catch (e) {
    emit({ status: "locked" });
    throw e;
  }
}

// A new owner from one of the developer's "Invite someone" links: their own vault, keys and recovery key, exactly like
// The developer's own setup, but never the primary owner (none of the developer's sealed feeds, which stay sealed to his key).
export async function ownerJoin(inviteId: string, token: string, name: string, username: string, passphrase: string, onRecovery?: (key: string) => void): Promise<string> {
  if (meta) lock();
  emit({ status: "busy" });
  try {
    const login = await acctLogin(username);
    const d = await acctDerive(passphrase, username);
    await callAuthFn({ action: "owner_join", inviteId, token, email: login, password: d.authPassword });
    const userId = await signIn(login, d.authPassword);
    const { role, red } = await fetchRole();
    if (role !== "owner" || red) throw new Error("This invite did not create an owner account. Ask for a new link.");
    const vk = await C.newAesKey();
    const recovery = C.randomBytes(32);
    const r = await C.deriveFromRecovery(recovery);
    const kp = await C.newInboxKeypair();
    const keys: KeysRow = {
      user_id: userId,
      kdf: C.KDF_PARAMS,
      wrapped_vk: await C.wrapKey(d.kek, vk, C.aad.vk),
      wrapped_vk_recovery: await C.wrapKey(r.kek, vk, C.aad.vkRecovery),
      recovery_check: await C.sha256hex(r.authToken),
      public_key: kp.publicKey,
      wrapped_private_key: await C.encryptBytes(vk, kp.privatePkcs8, C.aad.priv),
    };
    const { error } = await sb.from("user_keys").insert(keys);
    if (error) throw error;
    const vkLocked = await C.unwrapKey(d.kek, keys.wrapped_vk, C.aad.vk);
    onRecovery?.(C.formatRecovery(recovery));
    await finishUnlock(login, username.trim(), userId, "owner", keys, vkLocked, false);
    await seedOwner(false, name);
    return C.formatRecovery(recovery);
  } catch (e) {
    emit({ status: "locked" });
    throw e;
  }
}

// ---------- The developer only: invite new owners ----------
function redOnly() {
  if (!meta || meta.role !== "owner" || !meta.red) throw new Error("Only the developer's account can invite owners.");
  if (!navigator.onLine) throw new Error("Connect to the internet first.");
}

/** A one-time link that creates one new owner account. The secret never reaches the server. */
export async function createOwnerInvite(): Promise<{ id: string; link: string; expiresAt: string }> {
  redOnly();
  const token = C.b64url(C.randomBytes(32));
  const { data, error } = await sb.rpc("create_owner_invite", { p_token_hash: await C.sha256hex(token) });
  if (error) throw new Error(error.message);
  const id = String(data);
  return { id, link: ownerInviteLink(location.origin, BASE, id, token), expiresAt: new Date(Date.now() + 7 * 864e5).toISOString() };
}

export async function listOwnerInvites(): Promise<OwnerInviteRow[]> {
  redOnly();
  const { data, error } = await sb.rpc("list_owner_invites");
  if (error) throw new Error(error.message);
  return (data || []) as OwnerInviteRow[];
}

export async function revokeOwnerInvite(id: string): Promise<boolean> {
  redOnly();
  const { data, error } = await sb.rpc("revoke_owner_invite", { p_id: id });
  if (error) throw new Error(error.message);
  return !!data;
}

export async function ownerRecover(username: string, recoveryText: string, newPassphrase: string) {
  emit({ status: "busy" });
  try {
    const login = await acctLogin(username);
    const r = await C.deriveFromRecovery(C.parseRecovery(recoveryText));
    const d = await acctDerive(newPassphrase, username);
    await callAuthFn({ action: "owner_recover", email: login, recoveryAuth: r.authToken, password: d.authPassword });
    const userId = await signIn(login, d.authPassword);
    const keys = await fetchKeys(userId);
    if (!keys?.wrapped_vk_recovery) throw new Error("No recovery copy found.");
    const vk = await C.unwrapKey(r.kek, keys.wrapped_vk_recovery, C.aad.vkRecovery, true);
    const wrapped_vk = await C.wrapKey(d.kek, vk, C.aad.vk);
    const { error } = await sb.from("user_keys").update({ wrapped_vk }).eq("user_id", userId);
    if (error) throw error;
    emit({ status: "locked" });
    await unlock(username, newPassphrase);
  } catch (e) {
    emit({ status: "locked" });
    throw e;
  }
}

export async function changePassphrase(oldPass: string, newPass: string) {
  if (meta?.local) throw new Error(NEEDS_SYNC);
  if (!meta || !snap.username) throw new Error("Unlock first.");
  if (!navigator.onLine) throw new Error("Connect to the internet to change your passphrase.");
  const username = snap.username;
  const d1 = await acctDerive(oldPass, username);
  const keys = await fetchKeys(meta.userId);
  if (!keys) throw new Error("Keys not found.");
  let vk: CryptoKey;
  try { vk = await C.unwrapKey(d1.kek, keys.wrapped_vk, C.aad.vk, true); } catch { throw new Error("Current passphrase is wrong."); }
  const d2 = await acctDerive(newPass, username);
  const wrapped_vk = await C.wrapKey(d2.kek, vk, C.aad.vk);
  // Keep the old wrap as wrapped_vk_prev until the login password has changed, so a failure
  // between the two steps can never lock you out (unlock falls back to the previous wrap).
  const { error } = await sb.from("user_keys").update({ wrapped_vk, wrapped_vk_prev: keys.wrapped_vk }).eq("user_id", meta.userId);
  if (error) throw error;
  const { error: e2 } = await sb.auth.updateUser({ password: d2.authPassword });
  if (e2) {
    await sb.from("user_keys").update({ wrapped_vk: keys.wrapped_vk, wrapped_vk_prev: null }).eq("user_id", meta.userId);
    throw e2;
  }
  // The old wrap must not outlive the old passphrase.
  await sb.from("user_keys").update({ wrapped_vk_prev: null }).eq("user_id", meta.userId);
  meta.keys = { ...keys, wrapped_vk, wrapped_vk_prev: null };
  await persist();
  // This Mac's pairing keys follow the new passphrase; phones signed in with the old ones need it typed again.
  if (linkCreds && NATIVE) {
    try { const d3 = await acctDerive(newPass, username, undefined, true); holdLinkCreds(username, d3.authPassword, C.b64url(new Uint8Array(await crypto.subtle.exportKey("raw", d3.kek)))); }
    catch { linkCreds = null; }
  }
  void writeAccountHint(newPass, username);
}

// ---------- clients joining ----------
export interface InviteHint { name?: string; email?: string; user?: string; words?: boolean; owner?: string } // owner: inviting owner's first name (never set on the developer's links)
// "#<invite id>.<secret>" plus, optionally, ".<base64url JSON {n, e}>": the client's first name and
// email to greet them and fill in their username. All of it stays in the fragment, which browsers
// never send to any server.
export function parseInviteFragment(hash: string): { inviteId: string; secret: string; hint: InviteHint } | null {
  const m = hash.replace(/^#/, "").match(/^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})(?:\.([A-Za-z0-9_-]{1,800}))?$/);
  if (!m) return null;
  let hint: InviteHint = {};
  if (m[3]) {
    try {
      const j = JSON.parse(new TextDecoder().decode(C.unb64url(m[3])));
      hint = { name: typeof j.n === "string" ? j.n.slice(0, 60) : undefined, email: typeof j.e === "string" ? j.e.slice(0, 120) : undefined,
        user: typeof j.u === "string" && /^[A-Za-z0-9_-]{8,40}$/.test(j.u) ? j.u : undefined, words: j.w === 1,
        owner: typeof j.o === "string" && /^\p{L}[\p{L}' -]{0,23}$/u.test(j.o.trim()) ? j.o.trim() : undefined };
    } catch { hint = {}; }
  }
  return { inviteId: m[1], secret: m[2], hint };
}

async function adoptWorkspace(userId: string, d: C.Derived, ws: string, wk: CryptoKey) {
  let keys = await fetchKeys(userId);
  let vk: CryptoKey | null = null;
  if (keys) {
    try { vk = await C.unwrapKey(d.kek, keys.wrapped_vk, C.aad.vk, true); } catch { vk = null; }
    if (!vk && keys.wrapped_vk_prev) { try { vk = await C.unwrapKey(d.kek, keys.wrapped_vk_prev, C.aad.vk, true); } catch { vk = null; } }
    // An owner's vault key is never replaced here (that would destroy their vault): only a client's.
    if (!vk && (keys.wrapped_vk_recovery || keys.public_key)) throw new Error("Wrong username or passphrase.");
  }
  if (!vk) {
    // No usable vault key: either a new account, or the developer re-invited a client who forgot their
    // passphrase. In the second case the old key is unrecoverable by design (zero knowledge),
    // so a fresh one replaces it; the developer re-invites them to any other workspace they had.
    vk = await C.newAesKey();
    const row = { user_id: userId, kdf: C.KDF_PARAMS, wrapped_vk: await C.wrapKey(d.kek, vk, C.aad.vk) };
    const { error } = await sb.from("user_keys").upsert(row);
    if (error) throw error;
  }
  const { error } = await sb.from("workspace_keys").upsert({
    workspace_id: ws, user_id: userId, wrapped_key: await C.wrapKey(vk, wk, C.aad.wk(ws)),
  });
  if (error) throw error;
}

export async function joinWithInvite(inviteId: string, secretB64: string, username: string, passphrase: string) {
  emit({ status: "busy" });
  try {
    const login = await acctLogin(username);
    const m = await C.inviteMaterial(C.unb64url(secretB64));
    const d = await acctDerive(passphrase, username);
    const res = await callAuthFn({ action: "client_join", inviteId, token: m.token, email: login, password: d.authPassword });
    const wk = await C.unwrapKey(m.key, res.wrappedKey, C.aad.invite(res.workspaceId, inviteId), true);
    const userId = await signIn(login, d.authPassword);
    await adoptWorkspace(userId, d, res.workspaceId, wk);
    emit({ status: "locked" });
    await unlock(username, passphrase);
  } catch (e) {
    emit({ status: "locked" });
    throw e;
  }
}

/**
 * A three word login link: sign in if their account exists, otherwise use the link's invite to
 * create it (first visit). Same page, same words, every time.
 */
export async function openWithWords(inviteId: string, linkSecretB64: string, username: string, words: string) {
  const pass = C.normWords(words);
  if (pass.split(" ").length < 3) throw new Error("Type all three words.");
  try { await unlock(username, pass); return; } catch { /* no account yet, or wrong words: try the invite */ }
  const secret = C.b64url(await C.wordsSecret(C.unb64url(linkSecretB64), pass));
  try { await joinWithInvite(inviteId, secret, username, pass); }
  catch (e) {
    const msg = (e as Error).message || "";
    if (/not valid|expired|already been used/i.test(msg)) throw new Error("Those words did not work. Check the three words you were sent, or ask for a fresh link.");
    throw e;
  }
}

// Already has an account: sign in with the existing passphrase, then add this workspace.
export async function joinExisting(inviteId: string, secretB64: string, username: string, passphrase: string) {
  emit({ status: "busy" });
  try {
    const login = await acctLogin(username);
    const m = await C.inviteMaterial(C.unb64url(secretB64));
    const d = await acctDerive(passphrase, username);
    const userId = await signIn(login, d.authPassword);
    if ((await fetchRole()).role === "owner") throw new Error("This is an owner account. Client invites are for client accounts only.");
    const { data, error } = await sb.rpc("redeem_invite", { invite: inviteId, token: m.token });
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Invite is invalid or has expired");
    const { data: inv } = await sb.from("members").select("workspace_id").eq("user_id", userId);
    // The invite tells us the workspace through the wrap AAD; try each membership.
    let done = false;
    for (const row of inv || []) {
      try {
        const wk = await C.unwrapKey(m.key, data as string, C.aad.invite(row.workspace_id, inviteId), true);
        await adoptWorkspace(userId, d, row.workspace_id, wk);
        done = true; break;
      } catch { /* try next */ }
    }
    if (!done) throw new Error("Could not open this invite.");
    emit({ status: "locked" });
    await unlock(username, passphrase);
  } catch (e) {
    emit({ status: "locked" });
    throw e;
  }
}

// ---------- documents ----------
export function docs<T = any>(kind: Kind, ws?: string | null): Doc<T>[] {
  const out: Doc<T>[] = [];
  for (const d of snap.docs.values()) {
    if (d.kind !== kind) continue;
    if (ws !== undefined && d.ws !== ws) continue;
    out.push(d as Doc<T>);
  }
  return out;
}
export function doc<T = any>(id: string): Doc<T> | undefined {
  return snap.docs.get(id) as Doc<T> | undefined;
}

// PS Mac app, the Tab list (overlay) only: it holds no keys, so a write it is allowed to make (Fitness, now a
// screen inside the Tab list) lands on screen at once and goes to the page that holds the vault, which encrypts
// and saves it. That page's next copy replaces this one; a write is kept on top of copies older than it for a
// few seconds, so a set ticked here never flickers back while it travels.
type MirrorWrite = { op: "put"; kind: Kind; id: string; data: unknown } | { op: "remove"; id: string };
let mirrorWriter: ((w: MirrorWrite) => boolean) | null = null;
const mirrorPending = new Map<string, { doc: Doc | null; at: number }>();
const MIRROR_HOLD = 4000;
/** ps.ts (overlay only): where writes go; it answers false for a kind the Tab list may not write. */
export function setMirrorWriter(f: ((w: MirrorWrite) => boolean) | null) { mirrorWriter = f; }
const mirrored = () => snap.userId === "ps-overlay" && !!mirrorWriter;
function mirrorApply(id: string, doc: Doc | null) {
  mirrorPending.set(id, { doc, at: Date.now() });
  const docsMap = new Map(snap.docs);
  if (doc) docsMap.set(id, doc); else docsMap.delete(id);
  emit({ docs: docsMap });
}

export async function put<T>(kind: Kind, data: T, opts: { id?: string; ws?: string | null } = {}): Promise<string> {
  if (mirrored()) {
    const id = opts.id ?? uid(), old = snap.docs.get(id);
    if (!mirrorWriter!({ op: "put", kind, id, data })) throw new Error("Not from the Tab list.");
    mirrorApply(id, { id, ws: old?.ws ?? null, kind, data, author: old?.author ?? "ps-overlay", updatedAt: old?.updatedAt ?? null, pending: true });
    return id;
  }
  // DEV ONLY (/dev, fictional data): changes stay on screen, nothing is encrypted or saved.
  if (import.meta.env.DEV && snap.userId === "dev") {
    const id = opts.id ?? uid(), docsMap = new Map(snap.docs), old = snap.docs.get(id);
    docsMap.set(id, { id, ws: old?.ws ?? null, kind, data, author: "dev", updatedAt: new Date().toISOString() });
    emit({ docs: docsMap });
    return id;
  }
  if (!meta || !VK) throw new Error("Vault is locked.");
  const id = opts.id ?? uid();
  const existing = snap.docs.get(id);
  const privateProject = (kind === "project" && opts.ws === null && !!(data as { clientWs?: string }).clientWs)
    || (kind === "doc" && opts.ws === null);
  const ws = OWNER_KINDS.has(kind) || privateProject ? null : (opts.ws ?? existing?.ws ?? null);
  if (!OWNER_KINDS.has(kind) && !privateProject && !ws) throw new Error(`A ${kind} needs a workspace.`);
  // The server keeps a record's scope forever (and the AAD names it), so never move one.
  const known = existing ?? (rows.get(id) ? { ws: rows.get(id)!.workspace_id } : undefined);
  if (known && known.ws !== ws) throw new Error("A record cannot change scope. Create a new one instead.");
  const key = ws ? WKS.get(ws) : VK;
  if (!key) throw new Error("Missing key for this workspace.");
  const ct = await C.encryptJson(key, { kind, data }, C.aad.record(id, ws));
  const row: Row = {
    id, workspace_id: ws, author_id: existing?.author ?? meta.userId, ct, deleted: false,
    updated_at: existing?.updatedAt ?? null,
  };
  outbox.set(id, row);
  const docsMap = new Map(snap.docs);
  docsMap.set(id, { id, ws, kind, data, author: row.author_id, updatedAt: row.updated_at, pending: true });
  emit({ docs: docsMap, pendingCount: outbox.size });
  await persist();
  scheduleFlush();
  return id;
}

export async function remove(id: string) {
  if (mirrored()) {
    if (!snap.docs.has(id)) return;
    if (!mirrorWriter!({ op: "remove", id })) throw new Error("Not from the Tab list.");
    mirrorApply(id, null);
    return;
  }
  // DEV ONLY (/dev, fictional data): gone from the screen, nothing is saved (the same as put above).
  if (import.meta.env.DEV && snap.userId === "dev") {
    if (!snap.docs.has(id)) return;
    const docsMap = new Map(snap.docs);
    docsMap.delete(id);
    emit({ docs: docsMap });
    return;
  }
  if (!meta || !VK) throw new Error("Vault is locked.");
  const existing = snap.docs.get(id);
  if (!existing) return;
  const key = existing.ws ? WKS.get(existing.ws) : VK;
  if (!key) return;
  const ct = await C.encryptJson(key, { kind: "_deleted", data: null }, C.aad.record(id, existing.ws));
  outbox.set(id, { id, workspace_id: existing.ws, author_id: existing.author, ct, deleted: true, updated_at: existing.updatedAt });
  const docsMap = new Map(snap.docs);
  docsMap.delete(id);
  emit({ docs: docsMap, pendingCount: outbox.size });
  await persist();
  scheduleFlush();
}

// ---------- sync ----------
let flushTimer: number | null = null;
function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => { flushTimer = null; void flush(); }, 400);
}

// A sync that started more than STUCK_MS ago is never waited on again (requests have a limit, this is
// the second guard): the next sync runs instead of seeing "already running" forever.
const STUCK_MS = 90_000;
let flushing = false, flushAt = 0;
async function flush() {
  if (meta?.local) return localFlush();
  if (!meta || !outbox.size || !navigator.onLine) return;
  if (flushing && Date.now() - flushAt < STUCK_MS) return;
  // An unsent change of a mergeable record: see the server's copy first (a tiny probe when nothing moved).
  if (mergeable() && Date.now() - lastPull > 3000) await pull();
  if (!meta || !outbox.size) return;
  flushing = true; flushAt = Date.now();
  try {
    // The server's answer leaves out the ciphertext (egress): we already hold what we sent.
    const send = async (list: Row[]) => {
      const body = list.map((r) => ({ id: r.id, workspace_id: r.workspace_id, ct: r.ct, deleted: r.deleted }));
      const { data, error } = await sb.from("records").upsert(body, { onConflict: "id" }).select("id, workspace_id, author_id, deleted, updated_at");
      if (error) throw error;
      const sentCt = new Map(list.map((r) => [r.id, r.ct]));
      return ((data || []) as Omit<Row, "ct">[]).map((r) => ({ ...r, ct: sentCt.get(r.id)! })) as Row[];
    };
    const batch = [...outbox.values()].slice(0, 200);
    const kinds = new Set(batch.map((r) => String(snap.docs.get(r.id)?.kind ?? "")));
    let data: Row[] = [];
    let dropped = 0;
    try {
      data = await send(batch);
    } catch (e) {
      if (isNetworkError(e)) throw e;
      // One bad row must not block the rest: retry one by one and drop rows the server will
      // never accept (eg edits to a client that was destroyed on another device).
      for (const row of batch) {
        try { data.push(...await send([row])); }
        catch (e2) {
          if (isNetworkError(e2)) throw e2;
          const code = (e2 as { code?: string }).code;
          if ((row.workspace_id && !WKS.has(row.workspace_id)) || code === "42501" || code === "23503") { outbox.delete(row.id); dropped++; }
        }
      }
    }
    if (dropped) console.warn(`vault: dropped ${dropped} change(s) the server refused`);
    for (const r of data) {
      const sent = outbox.get(r.id);
      if (sent && sent.ct === r.ct) outbox.delete(r.id);
      rows.set(r.id, r);
      const d = snap.docs.get(r.id);
      if (d) d.updatedAt = r.updated_at, d.pending = outbox.has(r.id), d.author = r.author_id;
    }
    await persist();
    emit({ pendingCount: outbox.size, syncError: null });
    if (data.length) pokeSaved(kinds);
    if (outbox.size) scheduleFlush();
  } catch (e) {
    emit({ syncError: isNetworkError(e) ? "Offline. Changes are saved on this device and will sync." : String((e as Error).message || e) });
  } finally {
    flushing = false;
  }
}

// Local first: what the server would do on a save, done on this device. One transaction for meta, records and outbox.
let localFlushing: Promise<void> | null = null;
async function localFlush(): Promise<void> {
  if (localFlushing) { await localFlushing; if (!outbox.size) return; }
  const run = (async () => {
    if (!meta?.local || !outbox.size) return;
    const now = new Date().toISOString();
    const r = localCommit(rows, outbox, now, meta.userId);
    rows = r.rows;
    for (const id of r.committed) outbox.delete(id);
    for (const id of r.committed) { const d = snap.docs.get(id); const row = rows.get(id); if (d && row) { d.updatedAt = row.updated_at; d.pending = outbox.has(id); d.author = row.author_id; } }
    meta.lastSync = now;
    await persist();
    emit({ pendingCount: outbox.size, syncError: null, lastSync: now });
  })();
  localFlushing = run;
  try { await run; } catch (e) { emit({ syncError: `Could not save on this device: ${String((e as Error)?.message || e).slice(0, 120)}` }); }
  finally { if (localFlushing === run) localFlushing = null; }
}

// Edit packages wait here until the records they refer to are decrypted (see pull), then
// run one at a time in the order they were sent. Running them earlier, on a fresh login,
// meant a package could look for a client before the client list had loaded.
type QueuedPkg = { id: string; sealed: string; src?: string; at?: string; h: { kind: string; field: string; whole?: boolean; fn: (payload: unknown) => Promise<void> } };
let pkgQueue: QueuedPkg[] = [];
// PS writes one line per package handled (its source and how long it waited; never its content).
let pkgLog: ((source: string, at?: string) => void) | null = null;
export function setPkgLog(f: typeof pkgLog) { pkgLog = f; }
let pkgRunning = false;
async function runPackages() {
  if (pkgRunning) return;
  pkgRunning = true;
  try {
    while (pkgQueue.length) {
      const job = pkgQueue.shift()!;
      try {
        const pkg = await C.openSealed<Record<string, unknown>>(inboxPriv!, job.sealed);
        if (pkg.kind === job.h.kind && pkg[job.h.field]) await job.h.fn(job.h.whole ? pkg : pkg[job.h.field]);
        await sb.from("inbox").delete().eq("id", job.id);
        pkgLog?.(job.src || job.h.kind, job.at);
      } catch (e) {
        console.warn("vault: import package failed", e);
        inboxRetry = true;   // still on the server: try again on the next pull
      } finally {
        importing.delete(job.id);
      }
    }
  } finally {
    pkgRunning = false;
  }
}

// Instantly emails: each one becomes its own record, kept forever; a known one only has its
// read state updated. Throwing keeps the sealed copy until everything is on the server.
const INSTANTLY: QueuedPkg["h"] = { kind: "instantly", field: "emails", fn: async (payload) => {
  const have = new Map(docs<IEmail>("iemail").map((d) => [d.data.iid, d]));
  const ids: string[] = [];
  for (const e of payload as IEmail[]) {
    if (!e?.iid) continue;
    const ex = have.get(e.iid);
    if (!ex) ids.push(await put<IEmail>("iemail", e, { ws: null }));
    else if (!!ex.data.unread !== !!e.unread) ids.push(await put<IEmail>("iemail", { ...ex.data, unread: !!e.unread }, { id: ex.id, ws: null }));
  }
  await flush();
  if (ids.some((id) => outbox.has(id))) throw new Error("not on the server yet");
} };
// Instantly conversations (instantly-inbox): one record per thread, the newest 20 only. Threads
// that drop out of the 20 are removed, and the old preview-only emails are cleared.
const THREADS: QueuedPkg["h"] = { kind: "instantly-threads", field: "order", whole: true, fn: async (p) => {
  const pkg = p as { order: string[]; threads: IThread[] };
  const keep = new Set(pkg.order || []);
  const have = new Map(docs<IThread>("ithread").map((d) => [d.data.threadId, d]));
  const ids: string[] = [];
  for (const t of pkg.threads || []) {
    if (!t?.threadId) continue;
    const ex = have.get(t.threadId);
    if (ex && JSON.stringify(ex.data) === JSON.stringify(t)) continue;   // unchanged: no write, no egress
    ids.push(await put<IThread>("ithread", t, { id: ex?.id, ws: null }));
  }
  if (keep.size) for (const [tid, d] of have) if (!keep.has(tid)) await remove(d.id);
  for (const d of docs<IEmail>("iemail")) await remove(d.id);
  await flush();
  if (ids.some((id) => outbox.has(id))) throw new Error("not on the server yet");
} };
// Google Calendar: a newer snapshot replaces the stored one (one record).
// Follow-up Radar feeds: the warm follow-up engine snapshot (source "followup", from the Cincee project) and the
// near real time Instantly reply feed (source "instantly-replies"). One owner record each, replaced only when
// the content changed, so a quiet minute writes nothing.
async function applySnapshot(kind: "fup" | "irep", p: Record<string, unknown>) {
  const { kind: _k, ...data } = p;
  const all = docs<{ at?: string }>(kind).sort((x, y) => (y.data.at || "").localeCompare(x.data.at || ""));
  const ex = all[0];
  if (ex && (ex.data.at || "") > String(data.at || "")) return;
  // The reply feed keeps the lead events that came by webhook (booked meetings and the like) across polls.
  if (kind === "irep" && ex && Array.isArray((ex.data as { events?: unknown[] }).events)) (data as { events?: unknown[] }).events = (ex.data as { events: unknown[] }).events;
  const same = ex && JSON.stringify({ ...ex.data, at: "" }) === JSON.stringify({ ...data, at: "" });
  if (!same) {
    const rid = await put(kind, data, { id: ex?.id, ws: null });
    await flush();
    if (outbox.has(rid)) throw new Error("not on the server yet");
  }
  for (const old of all.slice(1)) await remove(old.id);
}
// Instantly webhook (source "instantly-hook"): one event at a time, folded into the same "irep" record.
type HookEvent = { type: string; id: string; threadId?: string | null; at: string; lead: string; fromName?: string | null; account: string; subject: string; opening: string; campaignId?: string | null; campaignName?: string | null; url: string; meeting?: unknown };
async function applyHook(ev: HookEvent) {
  if (!ev?.id || !ev.type) return;
  const all = docs<{ at?: string; replies?: unknown[]; sent?: unknown[]; events?: unknown[] }>("irep").sort((x, y) => (y.data.at || "").localeCompare(x.data.at || ""));
  const ex = all[0]?.data || { v: 1, at: ev.at, replies: [], sent: [] };
  const next = { ...ex, hookAt: new Date().toISOString() } as Record<string, unknown> & { replies: unknown[]; events?: unknown[] };
  if (/reply/i.test(ev.type)) {
    const r = { id: ev.id, threadId: ev.threadId || null, lead: ev.lead, from: ev.lead, fromName: ev.fromName || null, account: ev.account, at: ev.at, subject: ev.subject, opening: ev.opening, campaignId: ev.campaignId || null, url: ev.url, via: "webhook", type: ev.type };
    next.replies = [r, ...(ex.replies || []).filter((x) => (x as { id?: string }).id !== ev.id)].slice(0, 200);
  } else {
    next.events = [ev, ...(ex.events || []).filter((x) => (x as { id?: string }).id !== ev.id)].slice(0, 50);
  }
  const rid = await put("irep", next, { id: all[0]?.id, ws: null });
  await flush();
  if (outbox.has(rid)) throw new Error("not on the server yet");
}
// WhatsApp (source "whatsapp", core/whatsapp.ts): one chat record per number. A message folds into it (the same message id
// twice changes nothing); a delivery status moves the ticks of a reply the person sent. Only with WhatsApp on (core/wasnap.ts).
async function applyWhatsApp(pkg: Record<string, unknown>) {
  const ev = pkg.event as (WaEvent & WaStatusEvent) | undefined;
  if (!ev?.id) return;
  const all = groupChats(docs("wachat"));
  if (pkg.type === "status") {
    const g = all.find((x) => x.chat.msgs.some((m) => m.id === ev.id && m.dir === "out"));
    // The status can beat the person's own record of the reply: wait for the next pull, give up after ten minutes.
    if (!g) { if (Date.now() - Date.parse(String(pkg.at || "")) < 600_000) throw new Error("reply not recorded yet"); return; }
    const next = applyStatus(g.chat, ev);
    if (next) { const rid = await put("wachat", next, { id: g.id, ws: null }); await flush(); if (outbox.has(rid)) throw new Error("not on the server yet"); }
    return;
  }
  const key = chatKey({ from: ev.from, userId: ev.userId });
  if (!key) return;
  const id = all.find((x) => (x.chat.wa || `u:${x.chat.userId}`) === key)?.id ?? await waChatIdFor(key);
  const ex = all.find((x) => x.id === id)?.chat as WaChat | undefined;
  const country = prefsOf(docs<Settings>("settings")[0]?.data).country;
  const next = applyWaInbound(ex, ev, matchClient(docs<ClientRec>("client"), ev.from, country));
  if (!next) return;
  const rid = await put("wachat", next, { id, ws: null });
  await flush();
  if (outbox.has(rid)) throw new Error("not on the server yet");
}
const WHATSAPP: QueuedPkg["h"] = { kind: "whatsapp", field: "event", whole: true, fn: (p) => applyWhatsApp(p as Record<string, unknown>) };
const IHOOK: QueuedPkg["h"] = { kind: "instantly-hook", field: "event", fn: (e) => applyHook(e as HookEvent) };
const FOLLOWUP: QueuedPkg["h"] = { kind: "followup", field: "leads", whole: true, fn: (p) => applySnapshot("fup", p as Record<string, unknown>) };
const IREPLIES: QueuedPkg["h"] = { kind: "instantly-replies", field: "replies", whole: true, fn: (p) => applySnapshot("irep", p as Record<string, unknown>) };

const CALENDAR: QueuedPkg["h"] = { kind: "calendar", field: "events", whole: true, fn: (p) => applyCalendar(p as CalendarSnap & { kind?: string }) };
async function applyCalendar(p: CalendarSnap & { kind?: string }) {
  // V1.55: another Google calendar the developer linked to one Meetings panel (account "feed:<id>") keeps its own copy beside the
  // usual one; the usual one (his Google calendar, or the Mac's Calendar) replaces only the usual one (core/calfeeds.ts).
  const mine = feedOfAccount(p.account);
  const all = docs<CalendarSnap>("calendar").filter((d) => feedOfAccount(d.data.account) === mine).sort((x, y) => (y.data.at || "").localeCompare(x.data.at || ""));
  const ex = all[0];
  if (ex && (ex.data.at || "") > (p.at || "")) return;
  const { kind: _k, ...snap } = p;
  if (ex && JSON.stringify({ ...ex.data, at: "" }) === JSON.stringify({ ...snap, at: "" })) { for (const old of all.slice(1)) await remove(old.id); return; }
  const rid = await put<CalendarSnap>("calendar", snap, { id: ex?.id, ws: null });
  for (const old of all.slice(1)) await remove(old.id);
  await flush();
  if (outbox.has(rid)) throw new Error("not on the server yet");
  // No "Calendar refreshed" pop-up any more (4 Nov 2026): the calendar now arrives within a minute of every change,
  // so it would pop up (and write the notice history) on each one. The Meetings panel's "Updated X ago" says it,
  // and booked, declined and moved calls already get their own meeting alert cards (core/meetalerts.ts).
}

// Egress (25 Oct 2026, free plan quota): every pull starts with vault_probe(), a few hundred bytes of hashes
// computed under the caller's own RLS. Only the parts that changed are fetched: workspace keys when their hash
// moves, records as ids and timestamps first and then the full ciphertext of just the rows that differ from the
// copy on this device, and the inbox list when its hash moves. Nothing is re-downloaded when nothing changed.
type Probe = { r: string | null; rfp: string | null; i: string | null; k: string | null };
let seen: Partial<Probe> = {};       // the last probe values each part was brought up to date with
let lastResync = 0;                  // full id list check (rows committed out of order, hard deletes)
let inboxRetry = false;              // a package failed or waits for its records: look again on the next pull
type Stamp = { id: string; updated_at: string | null; deleted: boolean };

async function listStamps(since: string | null): Promise<Stamp[]> {
  const out: Stamp[] = [];
  for (let page = 0; page < 100; page++) {
    let q = sb.from("records").select("id, updated_at, deleted").order("updated_at").order("id").range(page * 1000, page * 1000 + 999);
    if (since) q = q.gt("updated_at", since);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...((data || []) as Stamp[]));
    if ((data || []).length < 1000) break;
  }
  return out;
}

async function pullRecords(full: boolean): Promise<boolean> {
  let cursor = meta!.cursor;
  // One fixed window (5s overlap for rows committed out of order), totally ordered, ids and times only.
  const stamps = await listStamps(full || !cursor ? null : new Date(Date.parse(cursor) - 5000).toISOString());
  const want = stamps.filter((s) => { const o = rows.get(s.id); return !o || o.updated_at !== s.updated_at || o.deleted !== s.deleted; }).map((s) => s.id);
  let changed = false;
  for (let i = 0; i < want.length; i += 100) {
    const { data, error } = await sb.from("records").select("id, workspace_id, author_id, ct, deleted, updated_at").in("id", want.slice(i, i + 100));
    if (error) throw error;
    for (const r of (data || []) as Row[]) {
      const old = rows.get(r.id);
      if (!old || old.ct !== r.ct || old.deleted !== r.deleted) changed = true;
      rows.set(r.id, r);
      if (mergers.size && outbox.has(r.id) && !r.deleted && (!old || old.ct !== r.ct)) await mergeInto(r);
    }
  }
  for (const s of stamps) if (s.updated_at && (!cursor || s.updated_at > cursor)) cursor = s.updated_at;
  if (full) {
    // Rows removed on the server (an owner hard delete) leave this device too.
    const live = new Set(stamps.map((s) => s.id));
    for (const id of [...rows.keys()]) if (!live.has(id) && !outbox.has(id)) { rows.delete(id); changed = true; }
    lastResync = Date.now();
  }
  meta!.cursor = cursor;
  return changed;
}

/** The server has a newer copy of a record this device has not sent yet: merge the two into the unsent one. */
async function mergeInto(remote: Row) {
  const mine = outbox.get(remote.id);
  if (!mine || mine.deleted || mine.ct === remote.ct) return;
  try {
    const a = await decryptRow(mine), b = await decryptRow(remote);
    const fn = a && b && a.kind === b.kind ? mergers.get(a.kind) : undefined;
    if (!a || !b || !fn) return;
    const key = a.ws ? WKS.get(a.ws) : VK;
    if (!key) return;
    const ct = await C.encryptJson(key, { kind: a.kind, data: fn(a.data, b.data) }, C.aad.record(a.id, a.ws));
    outbox.set(a.id, { ...mine, ct });
  } catch { /* leave the unsent copy as it is */ }
}

let pulling = false, pullAt = 0;
const pullStuck = () => pulling && Date.now() - pullAt >= STUCK_MS;
async function pull() {
  if (!meta || meta.local || !navigator.onLine) return;
  if (pulling && !pullStuck()) return;
  pulling = true; pullAt = Date.now();
  lastPull = Date.now();
  try {
    const { data: s } = await sb.auth.getSession();
    if (!s.session) { emit({ syncError: "Signed out on the server. Lock and unlock to reconnect." }); return; }
    const { data: pd, error: pe } = await sb.rpc("vault_probe");
    // Older database without the probe: behave as if everything changed.
    const p: Probe = pe || !pd ? { r: null, rfp: null, i: null, k: null } : pd as Probe;
    const fresh = (v: string | null, old: string | null | undefined) => v === null || v !== old;
    let changed = false;
    if (fresh(p.k, seen.k)) {
      const wsList = await fetchWsKeys(meta.userId);
      const before = WKS.size;
      await loadWsKeys(wsList);
      meta.wsKeys = wsList;
      changed = WKS.size !== before;
      seen.k = p.k ?? undefined;
    }
    if (fresh(p.rfp, seen.rfp)) {
      // The fingerprint moved but the newest time did not: a row landed out of order or vanished. Check every id.
      const full = !meta.cursor || (p.r !== null && p.r === seen.r) || Date.now() - lastResync > 6 * 3_600_000;
      changed = (await pullRecords(full)) || changed;
      seen.r = p.r ?? undefined; seen.rfp = p.rfp ?? undefined;
    }
    // The sealed inbox (Gmail, Telegram, Fireflies, Instantly, calendar, follow-ups, Claude's packages) is the developer's
    // only: sealed to his key and developer-only by RLS. Other owners never even ask for it (egress), unless they switched on
    // Client emails (core/mailswitch.ts): the primary owner of their own project, whose own functions sealed it to their own key.
    if ((meta.red || (meta.primary && mailOnSnap(snap))) && (fresh(p.i, seen.i) || inboxRetry)) {
      inboxRetry = false;
      const r = await pullInbox();
      changed = r.changed || changed;
      if (r.ok) seen.i = p.i ?? undefined;
    }
    meta.lastSync = new Date().toISOString();
    await persist();
    if (changed || undecryptable.size) await rebuildDocs();
    emit({ lastSync: meta.lastSync, syncError: null });
    if (pkgQueue.length) void runPackages();
  } catch (e) {
    emit({ syncError: isNetworkError(e) ? "Offline. Showing your saved copy." : String((e as Error).message || e) });
  } finally {
    pulling = false;
  }
}

// Sealed import packages (source "import"): encrypted to the developer's public key, opened here and
// handed to the importer, which re-encrypts everything under the right keys.
// Sealed packages by source: "import" (a whole import file) and "ops" (a list of edits).
type PackageHandler = (payload: unknown) => Promise<void>;
const packageHandlers: Record<string, { kind: string; field: string; fn: PackageHandler } | undefined> = {};
const importing = new Set<string>();
export function setImportHandler(h: PackageHandler | null) {
  packageHandlers.import = h ? { kind: "cincee-import", field: "file", fn: h } : undefined;
}
/** Tasks the developer texts his Telegram bot ("AT ..."), sealed by the telegram-inbox function. */
export function setTelegramHandler(h: PackageHandler | null) {
  packageHandlers.telegram = h ? { kind: "telegram", field: "task", fn: h } : undefined;
}
export function setOpsHandler(h: PackageHandler | null) {
  packageHandlers.ops = h ? { kind: "cincee-ops", field: "ops", fn: h } : undefined;
}
// DEV ONLY (/dev, fictional data): a package's ops go straight to the handler, as if they had arrived sealed.
if (import.meta.env.DEV) (globalThis as { __devOps?: (ops: unknown) => Promise<void> | undefined }).__devOps = (ops) => packageHandlers.ops?.fn(ops);

// Gmail (sources "gmail" and "gmail-sent"): sealed by the gmail-inbox function. Inbound mail
// from a known client becomes a "reply" record; the rest stays sealed on the server (pruned
// after 7 days) and is held here in memory only, so adding an address later still catches it.
const MAIL_SOURCES = new Set(["gmail", "gmail-sent"]);
interface MailItem { inboxId: string; p: GmailInbound }
let mailCache = new Map<string, MailItem>();   // opened, unmatched inbound, still on the server
let mailSkip = new Set<string>();              // could not be opened; never fetched again
let mailGone = new Set<string>();              // handled; delete may still be in flight
// "The developer sent" markers for threads with no client record stay sealed on the server (the same 7 day prune as
// unmatched inbound) and are held here, so the Follow-up Radar knows the developer answered a prospect in Gmail.
let sentCache = new Map<string, GmailSent>();  // inbox id -> marker
/** Latest time the developer sent in each Gmail thread with no client record (memory only): "account|threadId" -> ISO. */
export function gmailSentAt(): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of sentCache.values()) { const k = `${s.account}|${s.threadId}`; if (s.date && (m.get(k) || "") < s.date) m.set(k, s.date); }
  return m;
}

/** Recent mail that did not match any client (memory only, newest first), for linking senders. */
export function unmatchedMail(): GmailInbound[] {
  return [...mailCache.values()].map((m) => m.p).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

async function deleteInbox(ids: string[]) {
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const { error } = await sb.from("inbox").delete().in("id", chunk);
    if (!error) chunk.forEach((id) => mailCache.delete(id));
  }
}

/** Match cached mail (and any new "The developer sent" markers) to clients and fold it into reply records. Senders on the developer's
 *  "Always notify me" list get a reply record too, with no client (core/mailrules.ts). Every sender is also noted in
 *  its "msender" record for Settings' "Who emails me", written only when a message is new to it. */
async function processMail(sent: { inboxId: string; p: GmailSent }[] = []): Promise<boolean> {
  if (!meta || !VK) return false;
  const match = buildMatcher(docs<ClientRec>("client"));
  const rules = docs<Settings>("settings")[0]?.data.mailRules;
  const replyFor = (account: string, threadId: string) =>
    docs<Reply>("reply").find((d) => d.data.account === account && d.data.threadId === threadId);
  const done = new Map<string, string>(); // inbox id -> record id it landed in ("" = nothing to store)
  const inbound = [...mailCache.values()].sort((a, b) => (a.p.date || "").localeCompare(b.p.date || ""));
  // The developer's own Gmail accounts (every account mail came to, or a client thread lives in): never a colleague.
  const own = ownAccounts(snap.docs.values(), inbound.map((m) => m.p.account));
  let wrote = false;
  for (const m of inbound) {
    const ex = replyFor(m.p.account, m.p.threadId);
    const email = parseAddress(m.p.from).email;
    const clientId = clientForInbound(match, m.p, ex?.data, own)
      ?? (mailVerdict(email, null, rules, own).why === "notify" ? "" : null);
    if (clientId === null) continue;
    const next = applyInbound(ex?.data, m.p, clientId);
    // A thread's record id comes from its account and thread when there is none yet: two devices that both see it first write the
    // SAME record (core/maildedupe.ts), so an email never has two cards.
    done.set(m.inboxId, next ? await put<Reply>("reply", next, { id: ex?.id ?? await replyIdFor(m.p.account, m.p.threadId), ws: null }) : (ex?.id ?? ""));
  }
  // Who emails me: one small record per sender, changed only when one of their messages is new to it.
  const senders = new Map<string, Doc<MailSender>>();
  for (const d of docs<MailSender>("msender")) if (d.data?.email && !senders.has(d.data.email)) senders.set(d.data.email, d);
  for (const m of inbound) {
    const email = parseAddress(m.p.from).email;
    if (!email || own.has(email)) continue;
    const ex = senders.get(email);
    const next = logInbound(ex?.data, m.p);
    if (!next) continue;
    const id = await put<MailSender>("msender", next, { id: ex?.id, ws: null });
    senders.set(email, { ...(ex || { id, ws: null, kind: "msender", author: null, updatedAt: null }), id, data: next } as Doc<MailSender>);
    wrote = true;
  }
  for (const id of staleSenders(snap.docs.values())) { await remove(id); wrote = true; }
  for (const s of sent) {
    const ex = replyFor(s.p.account, s.p.threadId);
    const next = applySent(ex?.data, s.p);
    if (!ex) { sentCache.set(s.inboxId, s.p); continue; }   // no client thread: keep it for the radar
    done.set(s.inboxId, next ? await put<Reply>("reply", next, { id: ex.id, ws: null }) : "");
  }
  if (!done.size && !wrote) return false;
  await flush();
  // Only remove the sealed copy once its record is safely on the server.
  const del = [...done].filter(([, rid]) => !rid || !outbox.has(rid)).map(([iid]) => iid);
  del.forEach((id) => { mailGone.add(id); mailCache.delete(id); });
  if (del.length) await deleteInbox(del);
  return true;
}

/** Re-run matching after a client's addresses change (no network unless something matches). */
export async function rematchMail() {
  if (mailCache.size && (await processMail())) emit({});
}

// Sources this build opens. Anything else stays sealed on the server and is never downloaded here.
// Packages that need a handler this page has not registered (eg ops outside the main window) stay unread.
function handlerReady(src: string) {
  if (src === "ops" || src === "ops2" || src === "ops3") return !!packageHandlers.ops;
  if (src === "import" || src === "telegram") return !!packageHandlers[src];
  return true;
}
const PKG_SOURCES = new Set(["import", "ops", "ops2", "ops3", "followup", "instantly-replies", "instantly-hook", "instantly", "instantly2", "calendar", "telegram", "fireflies", "whatsapp"]);
/** V1.55: "calendar:<feed>" is one more Google calendar linked to one Meetings panel (calendar-inbox pollFeed). */
const pkgSource = (src: string) => (isFeedSource(src) ? "calendar" : src);
async function pullInbox(): Promise<{ changed: boolean; ok: boolean }> {
  if (!inboxPriv) return { changed: false, ok: true };
  const { data: list, error: listErr } = await sb.from("inbox").select("id, source, created_at").order("created_at");
  if (listErr || !list) return { changed: false, ok: false };
  const live = new Set(list.map((r) => r.id));
  let dropped = false;
  for (const id of [...mailCache.keys()]) if (!live.has(id)) { mailCache.delete(id); dropped = true; }
  for (const id of [...sentCache.keys()]) if (!live.has(id)) sentCache.delete(id);
  for (const id of [...mailGone]) if (!live.has(id)) mailGone.delete(id);
  const want = list.filter((r) => MAIL_SOURCES.has(r.source)
    ? !(mailCache.has(r.id) || sentCache.has(r.id) || mailSkip.has(r.id) || mailGone.has(r.id))
    : PKG_SOURCES.has(pkgSource(r.source)) && !importing.has(r.id) && handlerReady(pkgSource(r.source)));
  if (!want.length) return { changed: dropped, ok: true };

  const data: { id: string; source: string; sealed: string; created_at: string }[] = [];
  for (let i = 0; i < want.length; i += 100) {
    const { data: part, error } = await sb.from("inbox").select("id, source, sealed, created_at").in("id", want.slice(i, i + 100).map((r) => r.id));
    if (error) return { changed: dropped, ok: false };
    data.push(...(part || []));
  }
  data.sort((a, b) => a.created_at.localeCompare(b.created_at));

  const sent: { inboxId: string; p: GmailSent }[] = [];
  let mailNew = false;
  for (const item of data) {
    if (MAIL_SOURCES.has(item.source)) {
      try {
        const p = await C.openSealed<GmailInbound | GmailSent>(inboxPriv, item.sealed);
        if (p.kind === "gmail-sent") sent.push({ inboxId: item.id, p });
        else if (p.kind === "gmail") { mailCache.set(item.id, { inboxId: item.id, p }); mailNew = true; }
        else mailSkip.add(item.id);
      } catch { mailSkip.add(item.id); }
      continue;
    }
    // "ops2" = edit packages that need this version (tasks, documents). Older app versions
    // leave unknown sources untouched, so a stale tab can never swallow them.
    if (item.source === "import" || item.source === "ops" || item.source === "ops2" || item.source === "ops3") {
      const h = packageHandlers[item.source === "ops2" || item.source === "ops3" ? "ops" : item.source];
      if (!h || importing.has(item.id)) continue;
      importing.add(item.id);
      pkgQueue.push({ id: item.id, sealed: item.sealed, src: item.source, at: item.created_at, h });
      continue;
    }
    if (item.source === "whatsapp") {   // sealed by whatsapp-webhook; only opened with WhatsApp on, else left on the server
      if (importing.has(item.id) || !waOnSnap(snap)) continue;
      importing.add(item.id);
      pkgQueue.push({ id: item.id, sealed: item.sealed, src: item.source, at: item.created_at, h: WHATSAPP });
      continue;
    }
    if (item.source === "followup" || item.source === "instantly-replies" || item.source === "instantly-hook") {
      if (importing.has(item.id)) continue;
      importing.add(item.id);
      pkgQueue.push({ id: item.id, sealed: item.sealed, src: item.source, at: item.created_at, h: item.source === "followup" ? FOLLOWUP : item.source === "instantly-hook" ? IHOOK : IREPLIES });
      continue;
    }
    if (item.source === "instantly" || item.source === "instantly2" || item.source === "calendar" || isFeedSource(item.source)) {
      // Applied after the records are decrypted (see runPackages), so nothing is stored twice.
      if (importing.has(item.id)) continue;
      importing.add(item.id);
      pkgQueue.push({ id: item.id, sealed: item.sealed, src: item.source, at: item.created_at, h: item.source === "instantly" ? INSTANTLY : item.source === "instantly2" ? THREADS : CALENDAR });
      continue;
    }
    if (item.source === "telegram") {
      const h = packageHandlers.telegram;
      if (!h || importing.has(item.id)) continue;
      importing.add(item.id);
      pkgQueue.push({ id: item.id, sealed: item.sealed, src: item.source, at: item.created_at, h });
      continue;
    }
    if (item.source !== "fireflies") continue; // unknown package types are left alone
    try {
      const p = await C.openSealed<any>(inboxPriv, item.sealed);
      const ffId = p.id ? String(p.id) : null;
      if (ffId && [...snap.docs.values()].some((d) => d.kind === "meeting" && (d.data as { ffId?: string }).ffId === ffId)) {
        await sb.from("inbox").delete().eq("id", item.id);
        continue;
      }
      const actionItems = String(p.actionItems || "").split(/\n+/).map((s: string) => s.replace(/^[\s*•-]+/, "").trim()).filter(Boolean);
      const mid = await put("meeting", {
        title: p.title || "Meeting", date: p.date ? new Date(p.date).toISOString() : item.created_at,
        url: p.url || null, overview: p.overview || null, actionItems, bullets: p.bullets || null,
        participants: p.participants || [], source: "fireflies", clientId: null, addedToTodo: [], ffId,
      }, { ws: null });
      await flush();
      // Only remove the sealed copy once the meeting is safely stored on the server.
      if (!outbox.has(mid)) await sb.from("inbox").delete().eq("id", item.id);
    } catch { inboxRetry = true; /* leave it for next time */ }
  }
  if (mailNew || sent.length) await processMail(sent);
  return { changed: true, ok: true };
}

/** The Client emails switch was just changed (Settings): look at the sealed inbox on the next sync, even with nothing new. */
export function mailSwitchChanged() { inboxRetry = true; void sync(); }

/** PS, each time the developer holds Tab: asks the gmail-inbox function to read Gmail now (owner only, at
 *  most every 20 seconds there and here), then syncs, so a client's email shows straight away
 *  instead of after the next 2 minute cron run. Nothing comes back but "ok". */
let gmailAskedAt = 0;
export async function refreshGmail() {
  if (snap.status !== "unlocked" || !(snap.red || mailOnSnap(snap)) || Date.now() - gmailAskedAt < 20_000) return;
  gmailAskedAt = Date.now();
  try { await sb.functions.invoke("gmail-inbox", { body: { op: "refresh" } }); } catch { /* the cron run catches up */ }
  await sync();
}

/** Meetings refresh: asks the calendar-inbox function to read Google Calendar now (owner only), then syncs so a
 *  new snapshot lands before this returns. `connected` is false when Google is not linked (the server cannot read
 *  it; PS only has Claude's daily copy) and undefined when the server could not be asked. */
export async function refreshCalendar(): Promise<{ ok: boolean; lastOk: string | null; connected?: boolean; error?: string }> {
  let out: { ok: boolean; lastOk: string | null; connected?: boolean; error?: string } = { ok: false, lastOk: null };
  if (!snap.red) return out;
  try {
    const { data, error } = await sb.functions.invoke("calendar-inbox", { body: { op: "refresh" } });
    if (error) throw error;
    const off = data?.connected === false || data?.skipped === "not connected";
    out = { ok: !!data?.ok, lastOk: data?.lastOk ?? null, connected: !off, error: data?.error };
  } catch (e) {
    out.error = isNetworkError(e) ? "Offline" : String((e as Error).message || e);
  }
  await sync();
  return out;
}

/** This Mac's Calendar (core/localcal.ts, ps-mac LocalCalendar.swift) for any account but the developer's: kept in that
 *  person's own vault like the Google copy, written only when an event changed. The developer's account never takes it. */
export async function saveLocalCalendar(cal: CalendarSnap): Promise<void> {
  if (snap.status !== "unlocked" || snap.role !== "owner" || snap.red || snap.userId === "dev") return;
  try { await applyCalendar(cal); } catch { /* offline: the outbox sends it later */ }
}

/** Link Google Calendar (4 Nov 2026): the developer pastes his calendar's "Secret address in iCal format" once. The server
 *  checks it is Google's and opens it, keeps it in Supabase Vault and reads the calendar at once. Owner only. */
export async function linkCalendar(url: string, feed?: string): Promise<{ ok: boolean; lastOk: string | null; connected?: boolean; error?: string }> {
  if (!snap.red) return { ok: false, lastOk: null, error: "Only your own vault can link the calendar" };
  let out: { ok: boolean; lastOk: string | null; connected?: boolean; error?: string } = { ok: false, lastOk: null };
  try {
    // V1.55: a panel's own calendar only once the server knows about more calendars. An older calendar-inbox would
    // take the address as the usual calendar's, so it is asked first (op "feeds") and nothing is sent if it does not.
    if (feed) {
      if (!okFeedId(feed)) return { ok: false, lastOk: null, error: "Could not link" };
      const probe = await sb.functions.invoke("calendar-inbox", { body: { op: "feeds" } });
      if (probe.error || probe.data?.feeds !== true) return { ok: false, lastOk: null, error: "The server update for more calendars is not live yet" };
    }
    const { data, error } = await sb.functions.invoke("calendar-inbox", { body: { op: "link", url: url.trim(), ...(feed ? { feed } : {}) } });
    if (error) {
      // The function's own plain words for a refused link come back in the response body.
      const body = await (error as { context?: Response }).context?.json?.().catch(() => null);
      throw new Error(body?.error === "unknown op" ? "The server update for linking is not live yet" : body?.error || (error as Error).message);
    }
    out = { ok: !!data?.ok, lastOk: data?.lastOk ?? null, connected: data?.connected !== false, error: data?.error };
  } catch (e) {
    out.error = isNetworkError(e) ? "Offline" : String((e as Error).message || e).slice(0, 200);
  }
  await sync();
  return out;
}

/** Emails refresh button: asks instantly-inbox to read Instantly now (owner only), then syncs. */
export async function refreshInstantly(): Promise<{ ok: boolean; lastOk: string | null; connected: boolean; error?: string }> {
  let out = { ok: false, lastOk: null as string | null, connected: true, error: undefined as string | undefined };
  if (!(snap.red || mailOnSnap(snap))) return { ...out, connected: false };
  try {
    const { data, error } = await sb.functions.invoke("instantly-inbox", { body: { op: "refresh" } });
    if (error) throw error;
    out = { ok: !!data?.ok, lastOk: data?.lastOk ?? null, connected: data?.skipped !== "not connected", error: data?.error };
  } catch (e) {
    out.error = isNetworkError(e) ? "Offline" : String((e as Error).message || e);
  }
  await sync();
  return out;
}

/** Cincee Campaigns live numbers (core/campaignsLive.ts): asks campaigns-live (owner only, read only on
 *  Instantly) and opens the sealed reply with the inbox key, here in memory. The developer only; null when locked. */
export async function campaignsLiveFetch(today: string, have: string): Promise<{ data: Record<string, unknown>; payload: unknown | null } | null> {
  if (snap.status !== "unlocked" || !snap.red || !inboxPriv) return null;
  try {
    const { data, error } = await sb.functions.invoke("campaigns-live", { body: { op: "live", today, have } });
    const status = (error as { context?: { status?: number } } | null)?.context?.status;
    if (error && typeof status === "number") return { data: { ok: false, error: `http ${status}` }, payload: null };
    if (error) throw error;
    const d = (data || {}) as Record<string, unknown>;
    const payload = typeof d.sealed === "string" ? await C.openSealed(inboxPriv, d.sealed) : null;
    return { data: d, payload };
  } catch (e) {
    return { data: { ok: false, error: isNetworkError(e) ? "Offline" : String((e as Error).message || e).slice(0, 200) }, payload: null };
  }
}

export async function sync() {
  lastPoke = Date.now();
  await runSync();
}
async function runSync() {
  emit({ syncing: true, online: navigator.onLine });
  await flush();
  await pull();
  emit({ syncing: false });
}

// Poll pacing (egress): the probe is tiny, but there is no reason to ask every few seconds when nothing is
// watching. Realtime brings inbox packages (Telegram tasks, mail, feeds) within seconds either way; when the
// socket is down the poll stays at 25 s so they still arrive quickly.
let lastPull = 0;
let lastPoke = 0;                    // an explicit sync (Tab held, a button, a wake): counts as the developer being here
function pace(): number {
  if (secondary) return 30_000;      // the M1 at home: nobody touches it, but jobs must still arrive (the probe is tiny)
  if (!snap.live) return 25_000;
  const here = Math.max(lastActivity, lastPoke);
  if (Date.now() - here > 10 * 60_000) return 10 * 60_000;
  if (document.visibilityState === "hidden") return 2 * 60_000;
  return 25_000;
}
/** A paced pull: does nothing until the next one is due (PS's own 20 s nudge lands here). */
export function nudge() {
  if (snap.status !== "unlocked" || (pulling && !pullStuck())) return;
  if (localOnly()) { if (outbox.size) void flush(); return; }
  if (Date.now() - lastPull < pace()) { if (outbox.size) void flush(); return; }
  void runSync();
}

// ---------- loops: sync, auto lock ----------
function onActivity() { lastActivity = Date.now(); }
function onOnline() { emit({ online: true }); void runSync(); }
function onOffline() { emit({ online: false }); }
function onVisible() { if (document.visibilityState === "visible") { checkAutoLock(); void sync(); } }

export function autoLockMinutes(): number {
  const s = docs<{ autoLockMin?: number }>("settings")[0];
  return s?.data.autoLockMin ?? DEFAULT_SETTINGS.autoLockMin;
}
// PS Mac app with "Remember me", PS GOS with Stay signed in: never locks by itself (only Lock signs out).
let psKeepOpen = false;
export function setPsKeepOpen(v: boolean) { if (import.meta.env.MODE === "ps" || import.meta.env.MODE === "gos") psKeepOpen = v; }   // PS GOS: Stay signed in
function checkAutoLock() {
  if (psKeepOpen || localOnly()) return;   // the local vault has no passphrase to ask for again
  if (phoneDevice && MOBILE_PAGE) return;   // V1.55: a phone signed in from the Mac stays signed in (its Lock forgets that)
  const mins = autoLockMinutes();
  if (mins > 0 && Date.now() - lastActivity > mins * 60_000) { lock(); return; }
  // Keep the refresh session alive while you are active (at most one write a minute).
  if (snap.status === "unlocked" && lastActivity - sessionSavedFor > 60_000) void saveSession();
}

// Realtime: the server signals that something changed (the payload is ciphertext we ignore),
// and we pull straight away. RLS decides which signals this user receives. Polling stays as
// a fallback in case the socket drops.
let rtChannel: ReturnType<typeof sb.channel> | null = null;
let rtTimer: number | null = null;
function onRemoteChange() {
  if (rtTimer) clearTimeout(rtTimer);
  rtTimer = window.setTimeout(() => { rtTimer = null; void runSync(); }, 400);
}
function startRealtime() {
  stopRealtime();
  // The developer only: an empty "new inbox package" signal on his own private topic (migration 025). A records
  // subscription sent every changed row, ciphertext and all, to each open window, and the table change feed
  // shows deletes to everyone, so record changes from elsewhere arrive with the next paced probe instead.
  if (!meta?.red || meta.local) return;
  rtChannel = sb.channel(`inbox:${meta.userId}`, { config: { private: true } })
    .on("broadcast", { event: "inbox" }, onRemoteChange)
    .subscribe((status) => emit({ live: status === "SUBSCRIBED" }));
}
/** PS after the Mac wakes (or a long freeze): a fresh Realtime connection and a sync now. */
export function reconnect() {
  if (snap.status !== "unlocked" || !rtChannel) return;
  startRealtime();
  void sync();
}
function stopRealtime() {
  if (rtChannel) { void sb.removeChannel(rtChannel); rtChannel = null; }
  emit({ live: false });
}

// Second Computer (core/second.ts, migration 026): an empty "something for you" signal between this owner's
// Macs on their own private topic, so a job, a note or a file is picked up within seconds instead of at the
// next paced probe. The payload is only {k: "job" | "msg" | "file" | "stat"}; the data itself comes through
// the normal change-only pull. Only Macs with the Second Computer on join it.
let secondCh: ReturnType<typeof sb.channel> | null = null;
let secondary = false;
const pokeListeners = new Set<(k: string) => void>();
export function setSecondChannel(on: boolean, isSecondary = false) {
  secondary = on && isSecondary;
  if (!on || !meta || meta.local) {
    if (secondCh) {
      if (fitCh === secondCh) fitCh = null;
      void sb.removeChannel(secondCh); secondCh = null;
      if (LISTEN_FROM_UNLOCK && snap.role === "owner") listenFitPoke();   // V1.57: keep hearing the phone layout pokes
    }
    return;
  }
  if (secondCh) return;
  // One channel per topic: the live poke listener (listenFitPoke) is replaced by this one, which pulls on every poke.
  if (fitCh) { void sb.removeChannel(fitCh); fitCh = null; }
  secondCh = sb.channel(`second:${meta.userId}`, { config: { private: true, broadcast: { self: false } } })
    .on("broadcast", { event: "poke" }, (m) => {
      onRemoteChange();
      const k = String((m.payload as { k?: unknown } | undefined)?.k ?? "");
      pokeListeners.forEach((f) => f(k));
    })
    .subscribe();
}
export function onSecondPoke(f: (k: string) => void) { pokeListeners.add(f); return () => { pokeListeners.delete(f); }; }
/** Save what is waiting, then tell the other Macs to look. */
export async function pokeSecond(k: "job" | "msg" | "file" | "stat" | "cmd" | "idx" | "get") {
  await sync();
  void secondCh?.send({ type: "broadcast", event: "poke", payload: { k } });
}

// Fitness (V1.29): a set saved on one device is pulled by the other within seconds. After a flush that carried a
// Fitness record (fprog, fwork, fit), an empty {k: "fit"} poke goes out on the owner's own
// private "second:<uid>" topic (migration 026: only that owner reads and sends). The data itself still comes through
// the change only pull, so this adds no egress beyond the tiny probe. A device listens once Fitness has been on its
// screen; a Mac with the Second Computer on already pulls on every poke of that topic (the same channel is reused).
// V1.57 (phone-link-fast): the phone layout and the phone records poke too ({k: "pl"}), so a change made in the Mac's
// phone editor lands on the phone within a couple of seconds and the other way round, and a phone that just opened PS
// (its phonedev record) shows up in the Mac's Link your phone card at once. Phones (PS GOS, the iPhone web app) and the
// Mac's main window listen from unlock (startLoops); the Tab list has no session and gets it through the main window.
const pokeKinds = new Set<string>(["fprog", "fwork", "fit", "fsleep", "fact"]);
const phonePokeKinds = new Set<string>(["phonelayout", "phonedev", "rout"]);   // V1.59 rout: a reply from the email panel reaches the Mac that sends it at once
const LIVE_POKES = new Set(["fit", "pl", "card"]);   // V1.59 "card": a card changed on another device (pokeCardsAfterSave)
let fitCh: ReturnType<typeof sb.channel> | null = null;
let fitPokeTimer: number | null = null;
/** Listen for the other devices' Fitness pokes (idempotent; kept until the vault locks, an idle channel costs nothing). */
export function listenFitPoke() {
  if (fitCh || secondCh || !meta || meta.local || snap.status !== "unlocked") return;   // secondCh already pulls on every poke
  fitCh = sb.channel(`second:${meta.userId}`, { config: { private: true, broadcast: { self: false } } })
    .on("broadcast", { event: "poke" }, (m) => { if (LIVE_POKES.has(String((m.payload as { k?: unknown } | undefined)?.k ?? ""))) onRemoteChange(); })
    .subscribe();
}
let pokeWhat = new Set<string>();
// V1.59 (gos-island-159, the developer: "the notifications are laggy"): a card change made here (a finished chat or an AI message
// kept, a Dismiss or a Remind me in) pokes {k: "card"} on the owner's own "second:<uid>" topic once it is saved, so PS on
// the phone, which listens for it natively while its island or its live link runs (ps-gos LiveLink.kt), shows or clears
// the notification within seconds instead of at its next background check. Only the empty poke goes out, as for "fit".
let cardPokeWanted = false;
/** Ask for a {k: "card"} poke after the next save reaches the server (see above). */
export function pokeCardsAfterSave() { cardPokeWanted = true; }
function pokeSaved(kinds: Set<string>) {
  const list = [...kinds];
  const fit = list.some((k) => pokeKinds.has(k)), pl = list.some((k) => phonePokeKinds.has(k));
  const card = cardPokeWanted;
  cardPokeWanted = false;
  if (!meta || meta.local || (!fit && !pl && !card)) return;
  if (fit) pokeWhat.add("fit");
  if (pl) pokeWhat.add("pl");
  if (card) pokeWhat.add("card");
  if (fitPokeTimer) return;
  // One poke per kind for a burst of saves, sent once they are all on the server.
  fitPokeTimer = window.setTimeout(() => {
    fitPokeTimer = null;
    const what = pokeWhat; pokeWhat = new Set();
    if (!meta || snap.status !== "unlocked") return;
    if (!fitCh && !secondCh) listenFitPoke();
    for (const k of what) void (fitCh ?? secondCh)?.send({ type: "broadcast", event: "poke", payload: { k } }).catch(() => {});
  }, 600);
}
/** Phones and the Mac's main window listen for the live pokes from unlock (an idle channel costs nothing). */
const LISTEN_FROM_UNLOCK = import.meta.env.MODE === "ps" || import.meta.env.MODE === "gos" || MOBILE_PAGE;

function startLoops() {
  stopLoops();
  startRealtime();
  if (LISTEN_FROM_UNLOCK && snap.role === "owner") listenFitPoke();   // V1.57: the phone layout pokes (see pokeSaved)
  timers.push(window.setInterval(nudge, 5_000));   // only checks whether a pull is due; no network unless it is
  timers.push(window.setInterval(checkAutoLock, 20_000));
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  document.addEventListener("visibilitychange", onVisible);
}
function stopLoops() {
  if (rtChannel) stopRealtime();
  setSecondChannel(false);
  if (fitCh) { void sb.removeChannel(fitCh); fitCh = null; }
  if (fitPokeTimer) { clearTimeout(fitPokeTimer); fitPokeTimer = null; }
  timers.forEach((t) => clearInterval(t));
  timers = [];
  ["pointerdown", "keydown", "scroll", "touchstart"].forEach((e) => window.removeEventListener(e, onActivity));
  window.removeEventListener("online", onOnline);
  window.removeEventListener("offline", onOffline);
  document.removeEventListener("visibilitychange", onVisible);
}

// ---------- owner: workspaces, invites, access ----------
export async function createWorkspace(): Promise<string> {
  if (meta?.local) throw new Error(NEEDS_SYNC);
  if (!meta || meta.role !== "owner" || !VK) throw new Error("Owner only.");
  if (!navigator.onLine) throw new Error("Connect to the internet to add a new client.");
  const { data, error } = await sb.from("workspaces").insert({}).select("id").single();
  if (error) throw error;
  const ws = data.id as string;
  const wk = await C.newAesKey();
  const wrapped_key = await C.wrapKey(VK, wk, C.aad.wk(ws));
  const { error: e2 } = await sb.from("workspace_keys").insert({ workspace_id: ws, user_id: meta.userId, wrapped_key });
  if (e2) throw e2;
  meta.wsKeys = [...meta.wsKeys, { workspace_id: ws, wrapped_key }];
  WKS.set(ws, await C.unwrapKey(VK, wrapped_key, C.aad.wk(ws)));
  await persist();
  return ws;
}

export async function createInvite(ws: string, hint: InviteHint = {}, opts: { words?: string; days?: number } = {}): Promise<{ link: string; expiresAt: string }> {
  if (meta?.local) throw new Error(NEEDS_SYNC);
  if (!meta || meta.role !== "owner" || !VK) throw new Error("Owner only.");
  const own = meta.wsKeys.find((w) => w.workspace_id === ws);
  if (!own) throw new Error("No key for this client.");
  const wk = await C.unwrapKey(VK, own.wrapped_key, C.aad.wk(ws), true);
  const secret = C.randomBytes(32);
  // Three word logins: the invite only opens with the link AND the words.
  const m = await C.inviteMaterial(opts.words ? await C.wordsSecret(secret, opts.words) : secret);
  const id = uid();
  const expiresAt = new Date(Date.now() + (opts.days ?? 7) * 864e5).toISOString();
  // for_login: the login this invite is for (their email or three-word username), so a forgotten-password reset
  // only ever works for that one person (vault-auth, migration 025).
  const forWho = hint.user || hint.email?.trim();
  const row = {
    id, workspace_id: ws, token_hash: m.tokenHash,
    wrapped_key: await C.wrapKey(m.key, wk, C.aad.invite(ws, id)), expires_at: expiresAt,
    for_login: forWho ? await C.loginEmail(forWho) : null,
  };
  let { error } = await sb.from("invites").insert(row);
  if (error && (error.code === "PGRST204" || error.code === "42703")) {   // database before 025: no for_login yet
    const { for_login: _skip, ...old } = row;
    ({ error } = await sb.from("invites").insert(old));
  }
  if (error) throw error;
  // Owners other than the developer put their own first name in the fragment, so their client's join page names them.
  const myName = ([...snap.docs.values()].find((d) => d.kind === "settings" && !d.ws)?.data as { ownerName?: string } | undefined)?.ownerName;
  const named = (hint.owner || myName || "").trim();
  const owner = !meta.red && /^\p{L}[\p{L}' -]{0,23}$/u.test(named) ? named : undefined;
  const extra = hint.name || hint.email || hint.user || owner
    ? "." + C.b64url(new TextEncoder().encode(JSON.stringify({ n: hint.name?.trim() || undefined, e: hint.email?.trim().toLowerCase() || undefined,
      u: hint.user || undefined, w: opts.words ? 1 : undefined, o: owner })))
    : "";
  return { link: `${publicBase(location.origin, BASE)}join#${id}.${C.b64url(secret)}${extra}`, expiresAt };
}

// ---------- Claude access: client workspaces only, never the developer's own vault ----------
// The developer's vault makes one ordinary invite per client workspace (single use, 7 days) and hands the
// list to Claude as a file on this Mac. Claude's tool redeems them with its own account, whose
// passphrase lives only in the macOS Keychain. The developer's vault then sees who used the invites and
// trusts that one account (agents table + the developer's settings). Revoke removes it everywhere.
export type AgentInvite = { id: string; ws: string; secret: string };
export async function createAgentInvites(agentId: string | null): Promise<AgentInvite[]> {
  if (!meta || meta.role !== "owner" || !meta.red || !VK) throw new Error("Only the developer's account can give Claude access.");
  if (!navigator.onLine) throw new Error("Connect to the internet first.");
  let have = new Set<string>();
  if (agentId) {
    const { data } = await sb.from("members").select("workspace_id").eq("user_id", agentId);
    have = new Set((data || []).map((r) => r.workspace_id as string));
  }
  const out: AgentInvite[] = [];
  for (const w of meta.wsKeys) {
    if (have.has(w.workspace_id)) continue;
    const wk = await C.unwrapKey(VK, w.wrapped_key, C.aad.wk(w.workspace_id), true);
    const secret = C.randomBytes(32);
    const m = await C.inviteMaterial(secret);
    const id = uid();
    const { error } = await sb.from("invites").insert({
      id, workspace_id: w.workspace_id, token_hash: m.tokenHash,
      wrapped_key: await C.wrapKey(m.key, wk, C.aad.invite(w.workspace_id, id)),
      expires_at: new Date(Date.now() + 7 * 864e5).toISOString(),
    });
    if (error) throw error;
    out.push({ id, ws: w.workspace_id, secret: C.b64url(secret) });
  }
  return out;
}
/** Who used Claude's invites (one account, or null while Claude has not finished setting up). */
export async function confirmAgent(inviteIds: string[]): Promise<{ agentId: string | null; used: number }> {
  if (!meta || meta.role !== "owner" || !meta.red || !inviteIds.length) return { agentId: null, used: 0 };
  const { data, error } = await sb.from("invites").select("used_by").in("id", inviteIds);
  if (error) throw error;
  const users = [...new Set((data || []).map((r) => r.used_by as string | null).filter(Boolean))] as string[];
  if (users.length !== 1) return { agentId: null, used: 0 };
  const used = (data || []).filter((r) => r.used_by).length;
  const { error: e2 } = await sb.from("agents").upsert({ user_id: users[0] });
  if (e2) throw e2;
  return { agentId: users[0], used };
}
/** Takes Claude out of every client workspace and deletes its copies of their keys. */
export async function revokeAgent(agentId: string | null, pendingInvites: string[] = []) {
  if (!meta || meta.role !== "owner" || !meta.red) throw new Error("Only the developer's account can change Claude access.");
  if (agentId) {
    const a = await sb.from("members").delete().eq("user_id", agentId);
    if (a.error) throw a.error;
    const b = await sb.from("workspace_keys").delete().eq("user_id", agentId);
    if (b.error) throw b.error;
    const c = await sb.from("agents").delete().eq("user_id", agentId);
    if (c.error) throw c.error;
  }
  if (pendingInvites.length) await sb.from("invites").delete().in("id", pendingInvites).is("used_at", null);
}
export async function agentWorkspaceCount(agentId: string) {
  const { count } = await sb.from("members").select("workspace_id", { count: "exact", head: true }).eq("user_id", agentId);
  return count ?? 0;
}

export async function workspaceAccess(ws: string) {
  if (meta?.local) throw new Error(NEEDS_SYNC);
  const [{ data: members }, { data: invites }] = await Promise.all([
    sb.from("members").select("user_id, created_at").eq("workspace_id", ws),
    sb.from("invites").select("id, expires_at, used_at, created_at").eq("workspace_id", ws).order("created_at", { ascending: false }),
  ]);
  return { members: members || [], invites: invites || [] };
}

export async function revokeAccess(ws: string) {
  if (meta?.local) throw new Error(NEEDS_SYNC);
  const { error } = await sb.from("members").delete().eq("workspace_id", ws);
  if (error) throw error;
  await sb.from("invites").delete().eq("workspace_id", ws);
  await sb.from("workspace_keys").delete().eq("workspace_id", ws).neq("user_id", meta!.userId);
}

// Crypto shred: removes the client's workspace, its key and every record in it.
export async function destroyWorkspace(ws: string) {
  if (meta?.local) throw new Error(NEEDS_SYNC);
  if (!meta || meta.role !== "owner") throw new Error("Owner only.");
  const { error } = await sb.from("workspaces").delete().eq("id", ws);
  if (error) throw error;
  WKS.delete(ws);
  meta.wsKeys = meta.wsKeys.filter((w) => w.workspace_id !== ws);
  for (const [id, r] of rows) if (r.workspace_id === ws) rows.delete(id);
  for (const [id, r] of outbox) if (r.workspace_id === ws) outbox.delete(id);
  await persist();
  await rebuildDocs();
}

export async function accessLog() {
  if (meta?.local) throw new Error(NEEDS_SYNC);
  const [{ data: log }, { data: members }] = await Promise.all([
    // No "ip" (V1.57, 030_no_ip.sql): the server keeps no IP addresses, and user_agent is only a rough device name.
    sb.from("access_log").select("user_id, created_at, user_agent").order("created_at", { ascending: false }).limit(200),
    sb.from("members").select("user_id, workspace_id"),
  ]);
  return { log: log || [], members: members || [] };
}

// DEV ONLY: show fictional docs as an unlocked owner vault (no keys, nothing saved).
export function __devLoad(list: Doc[], red = false) {   // red false: as someone else's account (the mobile web app's pictures)
  if (!import.meta.env.DEV) return;
  emit({ status: "unlocked", role: "owner", red, userId: "dev", username: "dev", docs: new Map(list.map((d) => [d.id, d])), lastSync: new Date().toISOString() });
}

// PS Mac app, overlay window only: show the to-do list the main PS window hands over in memory.
// No keys live here; ticks go back to the main window, which encrypts and saves them.
export function __mirrorLoad(unlocked: boolean, list: Doc[], lastSync: string | null, red = false, local: { since: string } | null = null, primary = false) {
  if (import.meta.env.MODE !== "ps") return;
  const docs = new Map(list.map((d) => [d.id, d]));
  // Writes from this list still on their way (see put above) stay on top for a moment.
  const now = Date.now();
  for (const [id, w] of mirrorPending) {
    const came = docs.get(id);
    if (now - w.at > MIRROR_HOLD || (w.doc ? came && JSON.stringify(came.data) === JSON.stringify(w.doc.data) : !came)) { mirrorPending.delete(id); continue; }
    if (w.doc) docs.set(id, w.doc); else docs.delete(id);
  }
  if (!unlocked) mirrorPending.clear();
  emit(unlocked
    ? { status: "unlocked", role: "owner", red, primary, userId: "ps-overlay", username: null, docs, lastSync, local: local && typeof local.since === "string" ? { since: local.since } : null }
    : { status: "locked", role: null, red: false, primary: false, userId: null, docs: new Map(), lastSync: null, local: null });
}

// Owner can open a sealed Fireflies style payload pasted by hand (no server involved).
export function isOwner() { return snap.role === "owner"; }

// ---------- encrypted files (blobs) ----------
// Bytes are encrypted with the project's key (workspace key, or the vault key for a hidden
// project) and stored in public.blobs. Fetched on demand and cached in memory while unlocked.
const blobCache = new Map<string, Uint8Array>();
const blobAad = (id: string, ws: string | null) => `cincee-vault-v1:blob:${id}:${ws ?? "owner"}`;

export async function putBlob(ws: string | null, bytes: Uint8Array, opts: { cache?: boolean } = {}): Promise<string> {
  if (!meta || !VK) throw new Error("Vault is locked.");
  if (meta.local) throw new Error(NEEDS_SYNC);
  if (meta.role !== "owner") throw new Error("Owner only.");
  if (!navigator.onLine) throw new Error("Connect to the internet to attach a file.");
  const key = ws ? WKS.get(ws) : VK;
  if (!key) throw new Error("Missing key for this client.");
  const id = uid();
  const ct = await C.encryptBytes(key, bytes as Uint8Array<ArrayBuffer>, blobAad(id, ws));
  const { error } = await sb.from("blobs").insert({ id, workspace_id: ws, ct, size: bytes.length });
  if (error) throw error;
  if (opts.cache !== false) blobCache.set(id, bytes);   // Second Computer chunks are sent once and never kept
  return id;
}

export async function getBlob(id: string, ws: string | null, opts: { cache?: boolean } = {}): Promise<Uint8Array> {
  const hit = blobCache.get(id);
  if (hit) return hit;
  if (!VK) throw new Error("Vault is locked.");
  if (meta?.local) throw new Error(NEEDS_SYNC);
  const key = ws ? WKS.get(ws) : VK;
  if (!key) throw new Error("Missing key for this file.");
  const { data, error } = await sb.from("blobs").select("ct, workspace_id").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("File not found.");
  if ((data.workspace_id ?? null) !== ws) throw new Error("File is in the wrong place.");
  const bytes = await C.decryptBytes(key, data.ct, blobAad(id, ws));
  if (opts.cache !== false) blobCache.set(id, bytes);
  return bytes;
}

export async function deleteBlob(id: string) {
  blobCache.delete(id);
  if (meta?.local) return;
  await sb.from("blobs").delete().eq("id", id);
}

/** Which of these blobs the server still holds (ids only, a few bytes each: the background videos' 12 hour check). */
export async function blobsPresent(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (meta?.local) return out;
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await sb.from("blobs").select("id").in("id", ids.slice(i, i + 100));
    if (error) throw error;
    for (const r of data || []) out.add((r as { id: string }).id);
  }
  return out;
}
