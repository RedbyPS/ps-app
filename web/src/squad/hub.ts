// G Squad (V1.40): the only code that talks to the hub (its own Supabase project, edge function `squad`).
// Every request is signed with the member's own key (core/squadcrypto.ts signRequest); nothing here seals,
// opens or decides what is shared. Rows for the hub come from core/squadshare.ts (the opt-out gate) only.
// The hub URL is public (like a publishable key); there is no secret in the bundle.
import { signRequest } from "../core/squadcrypto.ts";
import type { TaskRow } from "../core/squadshare.ts";
import type { HubAskRow, HubWaitRow } from "../core/squaddir.ts";
import { lowPower } from "../core/lowpower.ts";

export const HUB_URL = "https://zxhvchchfrkfqxuyorqo.supabase.co";
export const HUB_FN = `${HUB_URL}/functions/v1/squad`;

export class HubError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

/** Bytes in and out per act since start (the egress estimate in the report; never sent anywhere). */
export const hubBytes: Record<string, { calls: number; up: number; down: number }> = {};

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const LIMIT_MS = 20_000;
function limited(f: Fetcher): Fetcher {
  return (url, init) => {
    if (typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") return f(url, init);
    return f(url, { ...init, signal: AbortSignal.timeout(LIMIT_MS) });
  };
}

/** Low power mode (core/lowpower.ts): every call to the G Squad hub throws while G Squad is asleep, so nothing pings it. */
// PS 1.65 (the developer): a message the person sends by hand (squad chat or a DM) still goes out in Low power mode. Nothing that polls does.
const BY_HAND = new Set(["c_post", "d_post"]);
export function hubAwake(act?: string) { if (act && BY_HAND.has(act)) return; if (lowPower.asleep("gsquad")) throw new HubError(0, "low power mode"); }

export interface HubIdent { member: string; priv: string }

export async function hubCall<T = unknown>(who: HubIdent, act: string, args: unknown, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<T> {
  hubAwake();   // PS 1.65 Low power mode: no hub call at all while G Squad sleeps
  const req = await signRequest(who.priv, act, who.member, args);
  const body = JSON.stringify(req);
  const res = await limited(fetcher)(HUB_FN, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  const text = await res.text();
  const b = (hubBytes[act] ??= { calls: 0, up: 0, down: 0 });
  b.calls++; b.up += body.length; b.down += text.length;
  let j: unknown = null;
  try { j = JSON.parse(text); } catch { /* below */ }
  if (!res.ok) throw new HubError(res.status, (j as { error?: string } | null)?.error || `hub ${res.status}`);
  return j as T;
}

export interface HubSquad { id: string; gen: number; rekey: boolean; meta_ct: string | null; meta_gen: number | null; created_by: string | null }
export interface HubMemberRow { id: string; sign_pub: string; box_pub: string; card_ct: string | null; card_gen: number | null; joined_at: string; left_at: string | null; updated_at: string; has_key?: boolean }
export interface HubTaskRow { id: string; member_id: string; ct: string; gen: number; deleted: boolean; updated_at: string }
export interface HubHandRow { id: string; from_member: string; to_member: string; ct: string; gen: number; state: "open" | "accepted" | "declined" | "cancelled"; created_at: string; updated_at: string }
export interface HubPull { now: string; squad: HubSquad; members: HubMemberRow[]; tasks: HubTaskRow[]; hands: HubHandRow[]; drops: { gen: number; sealed: string }[]; working: string[];
  /** PS 1.64 hub: last beats (and the sealed gym time) changed since `since.p` (core/squadpresence.ts). Missing on older hubs. */
  seen?: unknown }
/** n: working now; h: hand overs waiting for you; g: the squad key gen; rk: someone left, a re-key is due;
 *  q: requests to join waiting for you (the admin only, V1.42); k: people waiting for the squad key (V1.49). */
export interface Pulse { n: number; h: number; g: number; rk: boolean; q?: number; k?: number; /** V1.57: people asking to join (the admin only) */ w?: number }
/** V1.49: where your join stands while you wait for the squad key. */
export interface AutoKey { gen: number; start: boolean; drop: { gen: number; sealed: string } | null; admin: boolean; /** V1.57: false while you wait for the admin */ admitted?: boolean }
export interface Since { m?: string; t?: string; h?: string; /** PS 1.64: the members list's last beats */ p?: string }

/** Every act the hub knows, one function each. */
export function hubApi(who: HubIdent, fetcher?: Fetcher) {
  const call = <T,>(act: string, args: unknown) => hubCall<T>(who, act, args, fetcher);
  return {
    /** PS 1.64: extra = your gym time sealed with the squad key (core/squadpresence.ts), or st "" to clear it. */
    beat: (extra?: { st: string; sg: number } | null) => call<Pulse>("beat", extra ? extra : {}),
    /** PS 1.64: "working" switched off: the hub forgets your last beat and gym time. */
    away: () => call<{ ok: true }>("away", {}),
    count: () => call<Pulse>("count", {}),
    pull: (since: Since | null, gen: number) => call<HubPull>("pull", { since, gen }),
    mine: () => call<{ rows: { id: string; fp: string }[] }>("mine", {}),
    putTasks(rows: TaskRow[]) { return call<{ ok: true }>("put_tasks", { rows }); },
    delTasks: (ids: string[]) => call<{ ok: true }>("del_tasks", { ids }),
    card: (ct: string, gen: number) => call<{ ok: true }>("card", { ct, gen }),
    invite: (a: { id: string; hash: string; wrapped: string; gen: number; days?: number }) => call<{ ok: true }>("invite", a),
    // V1.44 Add friend: an invite you made and nobody used goes at once (the QR code closed)
    uninvite: (id: string) => call<{ ok: true }>("uninvite", { id }),
    leave: (target?: string) => call<{ gone: boolean }>("leave", target ? { target } : {}),
    rekey: (from: number, drops: { member: string; sealed: string }[], meta: string) => call<{ done: boolean; gen: number }>("rekey", { from, drops, meta }),
    hand: (a: { id: string; to: string; ct: string; gen: number }) => call<{ ok: true }>("hand", a),
    answer: (id: string, accept: boolean) => call<{ ok: true }>("answer", { id, accept }),
    cancel: (id: string) => call<{ ok: true }>("cancel", { id }),
    // V1.42 squad directory, the admin's side
    asks: () => call<{ rows: HubAskRow[] }>("asks", {}),
    approve: (a: { id: string; member: string; gen: number; drop: string; card: string }) => call<{ ok: true }>("approve", a),
    decline: (id: string) => call<{ ok: true }>("decline", { id }),
    // V1.43: the admin renames the squad (name only for the listed squad's public list)
    rename: (a: { gen: number; meta: string; name?: string }) => call<{ ok: true; listed: boolean }>("rename", a),
    // V1.49 one squad, everyone in
    autoKey: () => call<AutoKey>("auto_key", {}),
    autoStart: (gen: number, meta: string) => call<{ ok: true; gen: number }>("auto_start", { gen, meta }),
    autoWaiting: () => call<{ rows: unknown }>("auto_waiting", {}),
    autoDrop: (gen: number, drops: { member: string; sealed: string }[]) => call<{ added: number }>("auto_drop", { gen, drops }),
    /** The developer's PS only: a token of his own vault session; the hub asks his vault project whether it is the developer's. */
    admin: (token: string, anon: string) => call<{ ok: true }>("admin", { token, anon }),
    // V1.57 invite only: the asker leaves their name for the admin; the admin's list, Approve (admit) and Decline
    autoAsk: (sealed: string) => call<{ ok: true }>("auto_ask", { sealed }),
    waitList: () => call<{ rows: HubWaitRow[] }>("wait_list", {}),
    admit: (id: string) => call<{ ok: true }>("admit", { id }),
    turnAway: (id: string) => call<{ ok: true }>("turn_away", { id }),
  };
}
export type HubApi = ReturnType<typeof hubApi>;

/** Before there is a member id: make a squad, or join one with an invite. Signed with the new key itself. */
export function hubCreate(id: string, sign: { pub: string; priv: string }, box: string, meta: string, fetcher?: Fetcher) {
  return hubCall<{ squad: string; member: string; gen: number }>({ member: "", priv: sign.priv }, "create", { id, sign: sign.pub, box, meta }, fetcher);
}
export function hubJoin(sign: { pub: string; priv: string }, box: string, invite: string, token: string, fetcher?: Fetcher) {
  return hubCall<{ squad: string; member: string; gen: number; wrapped: string }>({ member: "", priv: sign.priv }, "join", { invite, token, sign: sign.pub, box }, fetcher);
}

// ---------- V1.42 squad directory: steps signed with a key that is not a member yet ----------
type KeyPair = { pub: string; priv: string };
/** The listed squads. Signed with any key (yours from a request, or a new one): it proves nothing, it keeps one door. */
export function hubDir(sign: KeyPair, fetcher?: Fetcher) {
  return hubCall<{ squads: unknown; gs?: unknown }>({ member: "", priv: sign.priv }, "dir", { sign: sign.pub }, fetcher);
}
/** Make a squad and list it, spending the developer's one-time claim code (the hub refuses any other code, and any second time). */
export function hubCreateListed(id: string, sign: KeyPair, box: string, meta: string, code: string, fetcher?: Fetcher) {
  return hubCall<{ squad: string; member: string; gen: number }>({ member: "", priv: sign.priv }, "create_listed", { id, sign: sign.pub, box, meta, code }, fetcher);
}
export function hubAsk(sign: KeyPair, a: { id: string; squad: string; box: string; admin: string; sealed: string }, fetcher?: Fetcher) {
  return hubCall<{ ok: true }>({ member: "", priv: sign.priv }, "ask", { ...a, sign: sign.pub }, fetcher);
}
export interface AskStatus { state: "none" | "open" | "approved" | "declined" | "cancelled"; id?: string; squad?: string; member?: string | null; at?: string; drop?: { gen: number; sealed: string } | null }
export function hubAskStatus(sign: KeyPair, fetcher?: Fetcher) {
  return hubCall<AskStatus>({ member: "", priv: sign.priv }, "ask_status", { sign: sign.pub }, fetcher);
}
/** V1.49: into The G Squad at once, signed with your new key. who: your join id (core/squadauto.ts whoHash). */
/** PS 1.68: acct, your vault session and the vault's public key, so the hub can check once that you are a PS account and let you
 *  straight in (never stored or logged there). Without it (a project of your own) the admin lets you in, as before. */
export function hubAutoJoin(sign: KeyPair, box: string, who: string, fetcher?: Fetcher, acct?: { token: string; anon: string } | null) {
  return hubCall<{ squad: string; member: string; gen: number; start: boolean; key: boolean; admitted?: boolean }>({ member: "", priv: sign.priv }, "auto_join",
    { sign: sign.pub, box, who, ...(acct ? { vault: acct.token, anon: acct.anon } : {}) }, fetcher);
}
export function hubAskCancel(sign: KeyPair, fetcher?: Fetcher) {
  return hubCall<{ ok: true }>({ member: "", priv: sign.priv }, "ask_cancel", { sign: sign.pub }, fetcher);
}
