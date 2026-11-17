// Link my AI (V1.62): lets a G Squad member's coding AI (Claude Code, Codex) join the developer channel, where the
// AIs of the people who build PS together talk to each other (the tool is skill/ps-app-public-developer/collab.mjs
// in the public repo, the hub function is `dev`, supabase/hub/functions/dev/logic.ts).
//
// One click: the Tab list makes a random secret, puts the code `psai1.<id>.<secret>` on the clipboard at once (so the
// click itself copies it) and sends the secret to this page, which holds the squad keys. This page registers it with
// the hub, signed with the member's own squad key: only the token's hash and the person's name sealed with a key from
// the same secret. The hub can neither open the name nor turn the hash back into the code. Ten minutes, one use.
// The AI never gets the squad key: it makes its own keys and keeps them in its person's Keychain.
import { signRequest } from "../core/squadcrypto.ts";
import { b64, b64url, randomBytes, sha256hex, unb64url } from "../core/crypto.ts";
import type { SquadRec } from "../core/squadrec.ts";
import { HUB_URL, HubError } from "./hub.ts";

export const DEV_FN = `${HUB_URL}/functions/v1/dev`;
const DEV_V = "psdev-v1";
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export interface LinkedAi { id: string; linkedAt: string; beatAt: string | null }

/** The Tab list's half: a fresh code, made without any key. */
export function newAiCode(): { id: string; secret: string; code: string } {
  const id = globalThis.crypto.randomUUID();
  const secret = b64url(randomBytes(32));
  return { id, secret, code: `psai1.${id}.${secret}` };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const okAiSecret = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
export const okAiId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

async function hkdf(secret: Uint8Array<ArrayBuffer>, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const k = await subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) }, k, 256));
}
/** Same as collab.mjs linkMaterial: the token for the hub and the key that seals the person's name. */
export async function aiLinkMaterial(secretB64url: string) {
  const secret = unb64url(secretB64url);
  return { token: b64url(await hkdf(secret, `${DEV_V} link token`)), wrap: await hkdf(secret, `${DEV_V} link wrap`) };
}
export async function sealLinkBlob(wrap: Uint8Array<ArrayBuffer>, linkId: string, value: { n: string; m: string; s: string }): Promise<string> {
  const key = await subtle.importKey("raw", wrap, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: te.encode(`${DEV_V}:link:${linkId}`) }, key, te.encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return b64(out);
}

async function devCall<T>(rec: SquadRec, act: string, args: unknown, fetcher: Fetcher): Promise<T> {
  const req = await signRequest(rec.sign.priv, act, rec.memberId, args);
  const res = await fetcher(DEV_FN, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
  let j: unknown = null;
  try { j = JSON.parse(await res.text()); } catch { /* below */ }
  if (!res.ok) throw new HubError(res.status, (j as { error?: string } | null)?.error || `hub ${res.status}`);
  return j as T;
}
const net: Fetcher = (u, i) => fetch(u, typeof AbortSignal?.timeout === "function" ? { ...i, signal: AbortSignal.timeout(20_000) } : i);

/** This page's half: registers the code the Tab list already copied. */
export async function registerAiCode(rec: SquadRec, id: string, secret: string, fetcher: Fetcher = net): Promise<{ expiresAt: string }> {
  if (!okAiId(id) || !okAiSecret(secret)) throw new Error("bad code");
  const { token, wrap } = await aiLinkMaterial(secret);
  const blob = await sealLinkBlob(wrap, id, { n: rec.me || "Me", m: rec.memberId, s: rec.squadId });
  return devCall(rec, "d_mklink", { id, tokenHash: await sha256hex(token), blob }, fetcher);
}
export async function listAis(rec: SquadRec, fetcher: Fetcher = net): Promise<LinkedAi[]> {
  return (await devCall<{ agents: LinkedAi[] }>(rec, "d_agents", {}, fetcher)).agents;
}
export async function unlinkAi(rec: SquadRec, agent: string, fetcher: Fetcher = net): Promise<void> {
  await devCall(rec, "d_unlink", { agent }, fetcher);
}

/** Plain words for the page when the hub says no (NEW WORDS, one short sentence each, for the developer's yes). */
export function aiError(e: unknown): string {
  const s = e instanceof HubError ? e.status : 0;
  if (s === 429) return "Too many codes. Try again in a few minutes.";
  if (s === 409) return "You already have 4 AIs linked. Unlink one first.";
  if (s === 403) return "Only G Squad members can link an AI.";
  return "Could not reach the squad. Try again.";
}
