// G Squad chat (V1.40): the only code that talks to the hub's `chat` function (its own function next to the core's
// `squad`). Signed exactly like the core (core/squadcrypto.ts signRequest, the member's own key); nothing here
// seals or opens anything.
import { signRequest } from "../core/squadcrypto.ts";
import { HUB_URL, HubError, hubBytes, type HubIdent, type HubMemberRow, hubAwake } from "./hub.ts";

export const CHAT_FN = `${HUB_URL}/functions/v1/chat`;
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
const LIMIT_MS = 20_000;

export async function chatCall<T = unknown>(who: HubIdent, act: string, args: unknown, fetcher: Fetcher = (u, i) => fetch(u, i)): Promise<T> {
  hubAwake(act);   // PS 1.65 Low power mode: no hub call while G Squad sleeps, except a message sent by hand
  const req = await signRequest(who.priv, act, who.member, args);
  const body = JSON.stringify(req);
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body };
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") init.signal = AbortSignal.timeout(LIMIT_MS);
  const res = await fetcher(CHAT_FN, init);
  const text = await res.text();
  const b = (hubBytes[act] ??= { calls: 0, up: 0, down: 0 });
  b.calls++; b.up += body.length; b.down += text.length;
  let j: unknown = null;
  try { j = JSON.parse(text); } catch { /* below */ }
  if (!res.ok) throw new HubError(res.status, (j as { error?: string } | null)?.error || `hub ${res.status}`);
  return j as T;
}

export interface ChatStatus { epoch: number; rot: boolean; u: number; last: string | null; read: string; votes: unknown; give: { vote: string; j: string; e: number[] }[] }
export interface ChatMsgRow { id: string; member_id: string; epoch: number; ct: string; edited: boolean; deleted: boolean; created_at: string; updated_at: string }
export interface ChatPull { now: string; status: ChatStatus; drops: { epoch: number; sealed: string }[]; members: HubMemberRow[]; msgs: ChatMsgRow[]; more: boolean }

export function chatApi(who: HubIdent, fetcher?: Fetcher) {
  const call = <T,>(act: string, args: unknown) => chatCall<T>(who, act, args, fetcher);
  return {
    tick: () => call<ChatStatus>("c_tick", {}),
    pull: (since: string | null, before?: string | null) => call<ChatPull>("c_pull", before ? { before } : { since }),
    post: (id: string, epoch: number, ct: string) => call<{ at: string }>("c_post", { id, epoch, ct }),
    edit: (id: string, ct: string) => call<{ ok: true }>("c_edit", { id, ct }),
    del: (id: string) => call<{ ok: true }>("c_del", { id }),
    read: (at: string) => call<{ ok: true }>("c_read", { at }),
    rotate: (from: number, drops: { member: string; sealed: string }[]) => call<{ done: boolean; epoch: number }>("c_rotate", { from, drops }),
    ballot: (vote: string, yes: boolean) => call<{ res: "yes" | "no" | null }>("c_ballot", { vote, yes }),
    give: (vote: string, drops: { epoch: number; sealed: string }[]) => call<{ added: number }>("c_give", { vote, drops }),
  };
}
export type ChatApi = ReturnType<typeof chatApi>;
