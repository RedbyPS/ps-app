// G Squad v3 (PS 1.65): the only code that talks to the hub's `dm` function (direct messages, group chats, pictures).
// Signed exactly like the chat (core/squadcrypto.ts signRequest, the member's own key); nothing here seals or opens
// anything. A hub that has not deployed `dm` answers 404: the callers treat that as "not there yet" and stay quiet.
import { signRequest } from "../core/squadcrypto.ts";
import { HUB_URL, HubError, hubBytes, type HubIdent, hubAwake } from "./hub.ts";

export const DM_FN = `${HUB_URL}/functions/v1/dm`;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const LIMIT_MS = 20_000;

export async function dmCall<T = unknown>(who: HubIdent, act: string, args: unknown, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<T> {
  hubAwake(act);   // PS 1.65 Low power mode: no hub call while G Squad sleeps, except a message sent by hand
  const req = await signRequest(who.priv, act, who.member, args);
  const body = JSON.stringify(req);
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(LIMIT_MS);
  const res = await fetcher(DM_FN, init);
  const text = await res.text();
  const b = (hubBytes[act] ??= { calls: 0, up: 0, down: 0 });
  b.calls++; b.up += body.length; b.down += text.length;
  let j: unknown = null;
  try { j = JSON.parse(text); } catch { /* below */ }
  if (!res.ok) throw new HubError(res.status, (j as { error?: string } | null)?.error || `hub ${res.status}`);
  return j as T;
}

export interface DmStatusConv { id: string; k: "dm" | "group"; e: number; last: string | null; upd: string; rot: boolean; closed: boolean; u: number }
export interface DmStatus { convs: DmStatusConv[]; av: string | null; more?: boolean }
export interface DmMsgRow { id: string; member_id: string; epoch: number; ct: string; edited: boolean; deleted: boolean; created_at: string; updated_at: string }
export interface DmPull { now: string; conv: { id: string; kind: "dm" | "group"; epoch: number; title_ct: string | null }; people: string[]; drops: { epoch: number; sealed: string; sig?: string }[]; epochs?: { epoch: number; signer: string; creator: string; members: string[]; title_ct: string }[]; msgs: DmMsgRow[]; more: boolean }
export interface AvatarRow { member_id: string; ct: string; gen: number; updated_at: string }

export function dmApi(who: HubIdent, fetcher?: Fetcher) {
  const call = <T,>(act: string, args: unknown) => dmCall<T>(who, act, args, fetcher);
  return {
    tick: () => call<DmStatus>("d_tick", {}),
    pull: (conv: string, since: string | null, before?: string | null) => call<DmPull>("d_pull", before ? { conv, before } : { conv, since }),
    create: (a: { id: string; kind: "dm" | "group"; others: string[]; title?: string; drops?: { member: string; sealed: string; sig: string }[] }) =>
      call<{ created: boolean; epoch: number }>("d_new", a),
    change: (conv: string, a: { add?: string[]; remove?: string }) => call<{ ok: true }>("d_change", { conv, ...a }),
    rotate: (conv: string, from: number, drops: { member: string; sealed: string; sig?: string }[], title?: string) => call<{ done: boolean; epoch: number }>("d_rotate", { conv, from, drops, ...(title ? { title } : {}) }),
    post: (conv: string, id: string, epoch: number, ct: string) => call<{ at: string }>("d_post", { conv, id, epoch, ct }),
    edit: (conv: string, id: string, epoch: number, ct: string) => call<{ ok: true }>("d_edit", { conv, id, epoch, ct }),
    del: (conv: string, id: string) => call<{ ok: true }>("d_del", { conv, id }),
    read: (conv: string, at: string) => call<{ ok: true }>("d_read", { conv, at }),
    avatars: (since: string | null) => call<{ rows: AvatarRow[]; more: boolean }>("d_apull", { since }),
    setAvatar: (ct: string, gen: number) => call<{ ok: true }>("d_aset", { ct, gen }),
    clearAvatar: () => call<{ ok: true }>("d_aset", { clear: true }),
  };
}
export type DmApi = ReturnType<typeof dmApi>;
