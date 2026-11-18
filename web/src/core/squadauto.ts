// One squad, everyone in (V1.49). The developer, 11 Nov 2026: "I want to make it there's automatically one squad already and
// we're all automatically in it." No claim code, no Ask to join, no approval. Pure crypto and rules, no vault and no
// screen, so the engine (squad/autoengine.ts), the unit tests and a live hub check run the same code.
//
// Joining: your PS makes your two key pairs for The G Squad and the hub gives you a member id at once. Then you need
// the squad key, which only members' devices ever hold:
//   * nobody has it yet (the squad is brand new, or everyone left): your PS makes the first one (start)
//   * otherwise the next PS in the squad that is running seals it to your box key (a key drop, as after someone
//     leaves), and your PS opens it with your box key
// Once you hold it, your PS posts your card (your name and your public keys, sealed with the squad key). Until then
// the others do not list you, and you do not hold up their re-keys or their chat.
//
// Who you are to the hub: a hash of your PS account (its project and account id), the same on your Mac and your phone,
// so the admin's Take out keeps you out, and two of your devices joining at the same moment become one member. The
// hub never sees the account id itself, your name or anything from your vault.
import * as S from "./squadcrypto.ts";
import { b64, sha256hex } from "./crypto.ts";
import { cleanName, openCard, type Card, type SquadRec } from "./squadrec.ts";
import type { KeyPairB64 } from "./squadcrypto.ts";

/** The one squad's name everywhere in PS. */
export const THE_SQUAD = "The G Squad";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PUB = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;

/** Your join record: ONE record of kind "squadjoin" in your own vault. */
export interface JoinRec {
  v: 1;
  gs?: string;               // The G Squad's id, once known
  left?: boolean;            // you left on purpose: PS does not join again by itself (Join again does)
  removed?: boolean;         // the admin took you out: PS does not try again by itself
  pending?: Pending | null;  // joined, waiting for the squad key
}
export interface Pending {
  me: string;
  sign: KeyPairB64;
  box: KeyPairB64;
  at: string;                // when this device started joining
  squadId?: string;          // from the hub's answer
  memberId?: string;
  /** V1.57 invite only: the admin's box key your name was sealed to (you asked to join; the check code comes from it). */
  asked?: string;
}
const pair = (v: unknown): KeyPairB64 | null => {
  const p = v as { pub?: unknown; priv?: unknown } | null;
  return p && typeof p.pub === "string" && typeof p.priv === "string" && PUB.test(p.pub) && B64.test(p.priv) && p.priv.length <= 400 ? { pub: p.pub, priv: p.priv } : null;
};
function cleanPending(v: unknown): Pending | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  const sign = pair(r.sign), box = pair(r.box);
  if (!sign || !box) return null;
  const ids = typeof r.squadId === "string" && UUID.test(r.squadId) && typeof r.memberId === "string" && UUID.test(r.memberId)
    ? { squadId: r.squadId.toLowerCase(), memberId: r.memberId.toLowerCase() } : {};
  const asked = ids.memberId && typeof r.asked === "string" && PUB.test(r.asked) ? { asked: r.asked } : {};
  return { me: cleanName(r.me) || "Me", sign, box, at: typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? r.at : new Date(0).toISOString(), ...ids, ...asked };
}
export function cleanJoinRec(v: unknown): JoinRec | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || r.v !== 1) return null;
  const out: JoinRec = { v: 1 };
  if (typeof r.gs === "string" && UUID.test(r.gs)) out.gs = r.gs.toLowerCase();
  if (r.left === true) out.left = true;
  if (r.removed === true) out.removed = true;
  const p = cleanPending(r.pending);
  if (p) out.pending = p;
  return out;
}
/** Two devices may each have written one before the vault met: the one with a member id wins, then the oldest. */
export function pickJoinRec<T extends { id: string; data: unknown }>(docs: T[]): { doc: T; rec: JoinRec } | null {
  const list = docs.map((d) => ({ doc: d, rec: cleanJoinRec(d.data) })).filter((x): x is { doc: T; rec: JoinRec } => !!x.rec);
  list.sort((a, b) => Number(!!b.rec.pending?.memberId) - Number(!!a.rec.pending?.memberId) || (a.rec.pending?.at ?? "").localeCompare(b.rec.pending?.at ?? "") || a.doc.id.localeCompare(b.doc.id));
  return list[0] ?? null;
}
/** Your join id on the hub: a hash of your account (project address and account id), never the id itself. */
export function whoHash(project: string, userId: string): Promise<string> {
  return sha256hex(`${S.V}|who|${project.trim().replace(/\/+$/, "")}|${userId}`);
}
/** The name PS joins with when Settings has none (V1.49: sign up asks for no name). G Squad's Members tab asks for one. */
export const NO_NAME = "New member";
/** New keys for joining. Your name: the first name in Settings, or "New member" (you can rename yourself later). */
export async function newPending(name: string): Promise<Pending> {
  const [sign, box] = await Promise.all([S.newSignPair(), S.newBoxPair()]);
  return { me: cleanName(name) || NO_NAME, sign, box, at: new Date().toISOString() };
}

// ---------- what the screen shows while you are not in yet ----------
/** joining: on the way in (the squad key is coming) / asked (V1.57 invite only): waiting for the admin to let you in,
 *  with the check code / left: you left on purpose (Join again) / removed: the admin took you out or said no / full:
 *  200 people (V1.55, was 30) / error: the hub could not be reached (Try again) / off: Settings, "Join The G Squad
 *  automatically" is Off, so PS does nothing by itself (Join switches it back on). */
export type AutoStage = "joining" | "asked" | "left" | "removed" | "full" | "error" | "off";
export interface AutoView { stage: AutoStage; error?: string | null; /** asked: the check code the admin sees too */ code?: string | null }
/** The screen's one step from the join record and the last problem (null: no record yet, so joining). `auto`: the
 *  "Join The G Squad automatically" setting (on unless switched off). */
export function autoStage(j: JoinRec | null, problem: "full" | "removed" | "error" | null, _auto = true): AutoStage {
  // PS 1.68 one squad for everyone (Jan 18 Nov 2026: "there should not be an option to leave or join squad, we're all the app
  // users"): a "left" from an older PS and the old "Join automatically: Off" no longer keep anyone out. Only the admin's
  // Take out does.
  if (j?.removed || problem === "removed") return "removed";
  if (problem === "full") return "full";
  if (problem === "error") return "error";
  return "joining";
}
/** Whether this device should start joining now: not in, not left or removed, no join already on its way, and
 *  "Join The G Squad automatically" not switched off (`auto`). */
export function shouldJoin(inSquad: boolean, j: JoinRec | null, _auto = true): boolean {
  if (inSquad) return false;
  if (j?.removed) return false;   // PS 1.68: left and the old Off switch no longer keep anyone out (autoStage)
  return !j?.pending;
}

// ---------- the squad key ----------
/** You make the first key: the squad's name sealed under it, for the hub (auto_start). */
export async function startMaterial(squadId: string, gen: number): Promise<{ raw: string; meta: string }> {
  const raw = await S.newSquadKey();
  return { raw, meta: await S.seal(raw, { n: THE_SQUAD }, S.sqAad.meta(squadId, gen)) };
}
/** Your squad record once you hold the key (made it, or opened your drop). The task id secret comes from your box
 *  key, so your Mac and your phone make the very same record from the same join. */
export async function recFromKey(p: Pending, raw: string, gen: number, at?: string, creator = false): Promise<SquadRec> {
  if (!p.squadId || !p.memberId) throw new Error("Not joined yet.");
  const h = await sha256hex(`${S.V}|secret|${p.squadId}|${p.box.priv}`);
  const secret = b64(Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16))));
  return { v: 1, squadId: p.squadId, memberId: p.memberId, me: p.me, keys: [{ gen, k: raw }], sign: p.sign, box: p.box, secret,
    joinedAt: at && !Number.isNaN(Date.parse(at)) ? new Date(Date.parse(at)).toISOString() : p.at, ...(creator ? { creator: true } : {}) };
}
/** Your drop opened with your box key (the aad names squad, member and gen, so the hub cannot hand you someone
 *  else's or call an old key new). */
export async function openMyDrop(p: Pending, drop: { gen: number; sealed: string }): Promise<string> {
  if (!p.squadId || !p.memberId) throw new Error("Not joined yet.");
  return S.openKeyDrop(p.box.priv, drop.sealed, S.sqAad.drop(p.squadId, p.memberId, drop.gen));
}

/** Someone waiting, as the hub lists them for a member who holds the key. */
export interface Waiting { id: string; box: string; sign: string }
export function cleanWaiting(v: unknown): Waiting[] {
  return (Array.isArray(v) ? v : []).flatMap((x) => {
    const o = x as Partial<Waiting> | null;
    return o && typeof o.id === "string" && UUID.test(o.id) && typeof o.box === "string" && PUB.test(o.box) && typeof o.sign === "string" && PUB.test(o.sign)
      ? [{ id: o.id.toLowerCase(), box: o.box, sign: o.sign }] : [];
  }).slice(0, 30);
}
/** The squad key you hold now, sealed to each person waiting (never to yourself). */
export async function dropsFor(rec: SquadRec, waiting: Waiting[]): Promise<{ gen: number; drops: { member: string; sealed: string }[] }> {
  const k = rec.keys[rec.keys.length - 1];
  const drops: { member: string; sealed: string }[] = [];
  for (const w of waiting) {
    if (w.id === rec.memberId) continue;
    drops.push({ member: w.id, sealed: await S.sealKeyTo(w.box, k.k, S.sqAad.drop(rec.squadId, w.id, k.gen)) });
  }
  return { gen: k.gen, drops };
}

// ---------- who counts ----------
/** A member without a card has joined but is not in yet (their PS has not posted their name): not on the members
 *  list, and not needed for a re-key or a chat period. */
export const hasCard = (m: { card_ct?: string | null }): boolean => typeof m.card_ct === "string" && m.card_ct.length > 0;

/** A card that opens and names the hub's keys for that member (the same check as before re-keying). */
export async function cardChecks(rec: SquadRec, m: { id: string; sign_pub: string; box_pub: string; card_ct: string | null; card_gen: number | null }): Promise<Card | null> {
  const c = await openCard(rec, m.id, m.card_ct, m.card_gen);
  return c && c.sign === m.sign_pub && c.box === m.box_pub ? c : null;
}

// ---------- plain words ----------
/** What a refused join step says (status and the hub's word). */
export function sayAuto(status: number, word: string): { problem: "full" | "removed" | "error"; text: string } {
  if (status === 403 && /removed/.test(word)) return { problem: "removed", text: `The admin took you out of ${THE_SQUAD}.` };
  if (status === 409 && /full/.test(word)) return { problem: "full", text: `${THE_SQUAD} is full (200 people).` };
  if (status === 429) return { problem: "error", text: "Lots of people are joining right now. PS app tries again by itself in a while." };
  if (status === 401 && /clock/.test(word)) return { problem: "error", text: "This device's clock is off. Set the date and time to automatic and try again." };
  if (status >= 500) return { problem: "error", text: `The ${THE_SQUAD} server had a problem. Try again in a moment.` };
  return { problem: "error", text: `${THE_SQUAD} could not be reached. Try again in a moment.` };
}
