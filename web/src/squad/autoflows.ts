// One squad, everyone in (V1.49): the steps, with no vault and no screen in them, so the engine (squad/autoengine.ts)
// and the unit tests (tests/gsquad-auto.test.ts, against a fake hub) run the very same code. Rules and crypto:
// core/squadauto.ts.
import * as S from "../core/squadcrypto.ts";
import { sealCard, type SquadRec } from "../core/squadrec.ts";
import { cleanWaiting, dropsFor, openMyDrop, recFromKey, startMaterial, type Pending } from "../core/squadauto.ts";
import { cleanDir, sealJoinAsk } from "../core/squaddir.ts";
import { HubError, hubApi, hubAutoJoin, hubDir, type HubApi } from "./hub.ts";

type Fetcher = Parameters<typeof hubDir>[1];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The hub's answer to joining, on your pending join (it now has your member id). `start`: make the first key. */
export async function autoJoin(who: string, p: Pending, fetcher?: Fetcher, acct?: { token: string; anon: string } | null): Promise<{ pending: Pending; start: boolean; key: boolean; gen: number }> {
  const r = await hubAutoJoin(p.sign, p.box.pub, who, fetcher, acct);
  if (!UUID.test(r.squad) || !UUID.test(r.member)) throw new HubError(500, "bad answer");
  return { pending: { ...p, squadId: r.squad.toLowerCase(), memberId: r.member.toLowerCase() }, start: r.start === true, key: r.key === true, gen: r.gen };
}

const pendingApi = (p: Pending, fetcher?: Fetcher): HubApi => hubApi({ member: p.memberId!, priv: p.sign.priv }, fetcher);

/** wait with admitted false (V1.57 invite only): you asked to join and wait for the admin (or a friend's invite). */
export type CheckOutcome = { state: "wait"; admitted?: false } | { state: "in"; rec: SquadRec };
/** Waiting for the squad key: your drop if a member's PS sealed it to you, or the first key if the squad has none
 *  (someone else may make it at the same moment: then you wait for their drop). Once in, your card goes up. */
export async function autoCheck(p: Pending, fetcher?: Fetcher): Promise<CheckOutcome> {
  if (!p.squadId || !p.memberId) return { state: "wait" };
  const api = pendingApi(p, fetcher);
  const k = await api.autoKey();
  if (k.admitted === false) return { state: "wait", admitted: false };
  let rec: SquadRec | null = null;
  if (k.drop) {
    rec = await recFromKey(p, await openMyDrop(p, k.drop), k.drop.gen, undefined, k.admin);
  } else if (k.start) {
    const m = await startMaterial(p.squadId, k.gen);
    try { await api.autoStart(k.gen, m.meta); } catch (e) {
      if (e instanceof HubError && e.status === 409) return { state: "wait" };   // someone else made it first
      throw e;
    }
    rec = await recFromKey(p, m.raw, k.gen, undefined, k.admin);
  }
  if (!rec) return { state: "wait" };
  const card = await sealCard(rec, rec.me);
  await api.card(card.ct, card.gen);
  return { state: "in", rec };
}

/** V1.57 invite only: you asked to join, so leave your name for the admin, sealed to the admin's box key (the hub
 *  cannot read it). Returns that box key (your check code comes from it), or null when there is no admin to ask yet. */
export async function askAdmin(p: Pending, fetcher?: Fetcher): Promise<string | null> {
  if (!p.squadId || !p.memberId) return null;
  const entry = cleanDir((await hubDir(p.sign, fetcher)).squads).find((e) => e.id === p.squadId);
  if (!entry) return null;
  await pendingApi(p, fetcher).autoAsk(await sealJoinAsk(p.squadId, p.memberId, entry.adminBox, p.me, p.sign.pub, p.box.pub));
  return entry.adminBox;
}

/** You hold the squad key: hand it to everyone waiting for it. Returns how many got it from you. */
export async function handOut(rec: SquadRec, api: HubApi): Promise<number> {
  const waiting = cleanWaiting((await api.autoWaiting()).rows);
  if (!waiting.length) return 0;
  const d = await dropsFor(rec, waiting);
  if (!d.drops.length) return 0;
  return (await api.autoDrop(d.gen, d.drops)).added;
}

/** The G Squad's id (the hub makes the squad if it does not exist yet). Signed with any key; it proves nothing. */
export async function theSquadId(sign?: { pub: string; priv: string } | null, fetcher?: Fetcher): Promise<string | null> {
  const key = sign ?? await S.newSignPair();
  const gs = (await hubDir(key, fetcher)).gs;
  return typeof gs === "string" && UUID.test(gs) ? gs.toLowerCase() : null;
}
