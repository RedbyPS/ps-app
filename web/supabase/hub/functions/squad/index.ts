// G Squad hub function (V1.40), project zxhvchchfrkfqxuyorqo only. The one door to the squad tables.
//
// No hub accounts and no passwords: every request is signed on the member's device with that member's own ECDSA
// P-256 key (kept in their own vault). This function checks the signature against the public key the hub holds
// for that member, refuses requests older than 2 minutes and any nonce seen before, and only then reads or writes
// with the service role. Everything it stores is ciphertext, public keys, hashes, ids and timestamps; it never
// sees a squad key, a name or a task title. verify_jwt is off on purpose: the signature is the check.
//
// V1.42 squad directory (migration dir_001_directory.sql): See available squads, Ask to join, the admin's Approve
// and Decline. Listing a squad needs the developer's one-time claim code (only its hash is on the hub, spent on use), so no
// other PS can list one. An ask is signed with the asker's own new key; their name is sealed to the admin.
//
// V1.49 one squad, everyone in (migration auto_001_one_squad.sql): The G Squad exists by itself and every PS joins it
// by itself (auto_join), with no claim code, no Ask to join and no approval. The squad key is still made only on a
// member's device: the first PS in makes it (auto_start); after that any PS in the squad that is running hands it to
// people waiting (auto_waiting, auto_drop), sealed to their box key, as a re-key does. The developer is the admin: his PS sends
// a token of his own vault session once (admin) and this function asks his vault project vault_role() with it; only
// 'red' makes him admin. The token is used for that one question and never stored or logged. Make a new squad
// (create) is refused now: PS has one squad.
//
// V1.55 never stuck (migration auto_002_never_stuck.sql): the hub heals The G Squad by itself when nobody who is in
// holds the squad key (it starts over and the next PS makes a new key), room for 200 people, and a second device of
// the same person no longer throws out the first one.
//
// V1.57 invite only (migration invite_001_invite_only.sql, rules in gate.ts): a PS that joins by itself gets a WAITING
// row (its Ask to join). Nobody hands a waiting row the squad key, and it can do nothing but wait, leave its name for
// the admin, or give up. A one time invite (Add friend) lets someone straight in; otherwise the admin lets them in
// (admit) or turns them away (turn_away). Everyone in before stays in. The old Ask to join and Approve are closed:
// V1.49+ admin PS approved those by itself.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { allowedWhileWaiting, leaveRoute, pulseCounts, waitingKey } from "./gate.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const te = new TextEncoder();
const CORS = {
  "Access-Control-Allow-Origin": "*",   // no cookies or ambient auth: the signature is the only credential
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const WORKING_MS = 7 * 60_000;          // a beat every 3 minutes while PS runs; gone 7 minutes after the last one
const SEEN_MS = 14 * 86_400_000;        // PS 1.64 members list: "Last seen" goes back 14 days
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUB = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
// The developer's vault project: the same owner signal PS uses for Numerology and PS Rules (vault_role() = 'red').
const RED_VAULT = "https://mxusokxekkecebwqgeru.supabase.co";
const JWT = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const ANON = /^(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|sb_publishable_[A-Za-z0-9_-]{10,200})$/;
/** True only when the developer's vault project says this session is the developer's (vault_role() = 'red'). Fails closed. */
async function isRed(token: unknown, anon: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length > 4000 || !JWT.test(token) || typeof anon !== "string" || !ANON.test(anon)) return false;
  try {
    const r = await fetch(`${RED_VAULT}/rest/v1/rpc/vault_role`, { method: "POST", body: "{}", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${token}` } });
    return r.ok && (await r.json()) === "red";
  } catch { return false; }
}

/** PS 1.68: true only when this vault session is a PS account that owns its own vault (vault_role() 'owner' or 'red') on the
 *  developer's vault project AND its join id is the one PS makes from that account (core/squadauto.ts whoHash). Fails closed. */
async function isPsAccount(token: unknown, anon: unknown, who: string): Promise<boolean> {
  if (typeof token !== "string" || token.length > 4000 || !JWT.test(token) || typeof anon !== "string" || !ANON.test(anon)) return false;
  try {
    const h = { "Content-Type": "application/json", apikey: anon, Authorization: `Bearer ${token}` };
    const [u, r] = await Promise.all([
      fetch(`${RED_VAULT}/auth/v1/user`, { headers: h, signal: AbortSignal.timeout(8000) }),
      fetch(`${RED_VAULT}/rest/v1/rpc/vault_role`, { method: "POST", body: "{}", headers: h, signal: AbortSignal.timeout(8000) }),
    ]);
    if (!u.ok || !r.ok) return false;
    const id = (await u.json() as { id?: unknown }).id, role = await r.json();
    if (typeof id !== "string" || !UUID.test(id) || (role !== "owner" && role !== "red")) return false;
    return (await sha256hex(`gsquad-v1|who|${RED_VAULT}|${id}`)) === who;
  } catch { return false; }
}

class Fail extends Error { constructor(public code: number, msg: string) { super(msg); } }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function sha256hex(s: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function verify(pub: string, act: string, member: string, ts: number, nonce: string, args: unknown, sig: string) {
  const bodyHash = await sha256hex(JSON.stringify(args ?? null));
  const text = `gsquad-v1|${act}|${member}|${ts}|${nonce}|${bodyHash}`;
  try {
    const k = await crypto.subtle.importKey("raw", unb64(pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, unb64(sig), te.encode(text));
  } catch { return false; }
}
const ct = (v: unknown, max = 2000) => { if (typeof v !== "string" || !v || v.length > max || !B64.test(v)) throw new Fail(400, "bad ciphertext"); return v; };
const int = (v: unknown, lo: number, hi: number) => { if (!Number.isInteger(v) || (v as number) < lo || (v as number) > hi) throw new Fail(400, "bad number"); return v as number; };
const uuid = (v: unknown) => { if (typeof v !== "string" || !UUID.test(v)) throw new Fail(400, "bad id"); return v.toLowerCase(); };
const must = <T,>(r: { data: T; error: { message: string } | null }) => { if (r.error) throw new Fail(500, "database"); return r.data; };

type Me = { id: string; squad_id: string; sign_pub: string; has_key: boolean; admitted: boolean };
type Sq = { id: string; gen: number; rekey: boolean; meta_ct: string | null; meta_gen: number | null; created_by: string | null };
async function squadOf(id: string): Promise<Sq> {
  const s = must(await db.from("squads").select("id, gen, rekey, meta_ct, meta_gen, created_by").eq("id", id).maybeSingle()) as Sq | null;
  if (!s) throw new Fail(404, "no squad");
  return s;
}
async function workingCount(squad: string) {
  const r = await db.from("squad_members").select("id", { count: "exact", head: true }).eq("squad_id", squad).is("left_at", null)
    .gt("last_beat", new Date(Date.now() - WORKING_MS).toISOString());
  if (r.error) throw new Fail(500, "database");
  return r.count ?? 0;
}

/** The cheap answer for the button: how many are working, hand overs waiting for you, and the key gen (so a
 *  member only pulls the full state when something about the squad itself changed). A few dozen bytes.
 *  q (V1.42): requests to join waiting for the admin (0 for everyone else). */
async function pulse(m: Me) {
  const [n, hands, sq, asks] = await Promise.all([workingCount(m.squad_id),
    db.from("squad_handoffs").select("id", { count: "exact", head: true }).eq("to_member", m.id).eq("state", "open"), squadOf(m.squad_id),
    db.from("dir_requests").select("id", { count: "exact", head: true }).eq("squad_id", m.squad_id).eq("state", "open")]);
  // k (V1.49): people waiting for the squad key, so a member's PS knows to hand it over (0 for anyone without it).
  // V1.57: admitted people only. w: people asking to join (the admin only).
  const admin = sq.created_by === m.id;
  const [kw, ask] = await Promise.all([
    m.has_key ? db.from("squad_members").select("id", { count: "exact", head: true }).eq("squad_id", m.squad_id).is("left_at", null).eq("has_key", false).eq("admitted", true) : null,
    admin ? db.from("squad_members").select("id", { count: "exact", head: true }).eq("squad_id", m.squad_id).is("left_at", null).eq("admitted", false) : null]);
  const c = pulseCounts({ has_key: m.has_key, admin }, kw?.count ?? 0, ask?.count ?? 0);
  return { n, h: hands.count ?? 0, g: sq.gen, rk: sq.rekey, q: admin ? asks.count ?? 0 : 0, k: c.k, w: c.w };
}
/** A directory step's refusal, in a word the app can tell apart (its status says what kind). */
const DIR_FAIL: Record<string, [number, string]> = {
  claim: [403, "claim"], unlisted: [404, "unlisted"], admin: [409, "admin changed"], member: [409, "already in"], open: [409, "already asked"],
  slow: [429, "wait"], busy: [429, "busy"], rekey: [409, "rekey first"], request: [404, "request"], full: [409, "full"],
  public: [400, "public name"],
  removed: [403, "removed"], started: [409, "started"], drops: [400, "drops"],
};
async function dirRpc(fn: string, args: Record<string, unknown>) {
  const r = await db.rpc(fn, args);
  if (r.error) {
    const w = /\b(claim|unlisted|admin|member|open|slow|busy|rekey|request|full|public|removed|started|drops)\b/.exec(r.error.message)?.[1];
    const f = w ? DIR_FAIL[w] : r.error.message.includes("duplicate") ? [409, "taken"] as [number, string] : [500, "database"] as [number, string];
    throw new Fail(f[0], f[1]);
  }
  return r.data;
}
const KEY_ACTS = new Set(["create", "join", "create_listed", "dir", "ask", "ask_status", "ask_cancel", "auto_join"]);
const BOX_ACTS = new Set(["create", "join", "create_listed", "ask", "auto_join"]);

async function handle(body: Record<string, unknown>) {
  const act = String(body.act || ""), member = String(body.member ?? ""), ts = Number(body.ts), nonce = String(body.nonce || ""), sig = String(body.sig || "");
  const args = (body.args && typeof body.args === "object" ? body.args : {}) as Record<string, unknown>;
  if (!/^[a-z_]{2,16}$/.test(act) || !/^[A-Za-z0-9_-]{16,32}$/.test(nonce) || !B64.test(sig) || sig.length > 200) throw new Fail(400, "bad request");
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 120) throw new Fail(401, "clock");

  // Who is asking: a new key (create, join, the directory steps) proves itself with the key it brings; anyone else
  // with the key we hold.
  let me: Me | null = null, pub: string;
  if (KEY_ACTS.has(act)) {
    if (member !== "" || typeof args.sign !== "string" || !PUB.test(args.sign)) throw new Fail(400, "bad keys");
    if (BOX_ACTS.has(act) && (typeof args.box !== "string" || !PUB.test(args.box))) throw new Fail(400, "bad keys");
    pub = args.sign;
  } else {
    me = must(await db.from("squad_members").select("id, squad_id, sign_pub, has_key, admitted").eq("id", uuid(member)).is("left_at", null).maybeSingle()) as Me | null;
    if (!me) throw new Fail(403, "not a member");
    pub = me.sign_pub;
  }
  if (!(await verify(pub, act, member, ts, nonce, body.args ?? null, sig))) throw new Fail(401, "signature");
  // V1.57: a waiting row (not let in yet) may only wait, leave its name for the admin, or give up.
  if (me && !me.admitted && !allowedWhileWaiting(act, me.id, args.target)) throw new Fail(403, "not let in");
  const used = await db.from("squad_nonces").insert({ member_key: await sha256hex(pub), nonce });
  if (used.error) throw new Fail(409, "replay");
  if (Math.random() < 0.01) { await db.rpc("squad_tidy"); await db.rpc("dir_tidy"); await db.rpc("auto_tidy"); }

  switch (act) {
    case "create":
      // V1.49: PS has one squad, The G Squad, and everyone is in it. Nobody makes another one (older PS versions).
      throw new Fail(403, "one squad");
    case "auto_join": {
      // V1.49: into The G Squad at once. who: sha256 of a secret only this person's own vault holds (the same on their
      // Mac and phone), so the admin's Take out keeps them out and two devices joining at once become one member.
      const who = typeof args.who === "string" && HEX64.test(args.who) ? args.who : null;
      // PS 1.68 one squad for everyone (migration invite_002_every_ps_user.sql): a PS account on the developer's vault is let in at
      // once. Its vault session is checked with the vault (who it is, and that it owns its vault) and must give the same who; the
      // token is used for that one question and never stored or logged. Anything else waits for the admin, as since V1.57.
      if (who && await isPsAccount(args.vault, args.anon, who)) {
        return await dirRpc("auto_join_account", { p_sign_pub: args.sign, p_box_pub: args.box, p_who: who });
      }
      return await dirRpc("auto_join", { p_sign_pub: args.sign, p_box_pub: args.box, p_who: who });
    }
    case "join": {
      if (typeof args.token !== "string" || args.token.length > 100) throw new Fail(400, "bad token");
      const r = await db.rpc("squad_join", { p_invite: uuid(args.invite), p_token_hash: await sha256hex(args.token), p_sign_pub: args.sign, p_box_pub: args.box });
      if (r.error) throw new Fail(r.error.message.includes("full") ? 409 : 403, r.error.message.includes("full") ? "full" : "invite");
      return r.data;
    }
    case "create_listed": {
      if (typeof args.code !== "string" || args.code.length < 20 || args.code.length > 100) throw new Fail(403, "claim");
      return await dirRpc("dir_create_listed", { p_id: uuid(args.id), p_sign_pub: args.sign, p_box_pub: args.box, p_meta_ct: ct(args.meta), p_code_hash: await sha256hex(args.code) });
    }
    case "dir":
      // V1.49: gs is The G Squad's id (made here if it does not exist yet), so a PS in an older squad knows to move.
      return { squads: await dirRpc("dir_list", {}), gs: await dirRpc("auto_squad", {}) };
    case "ask": {
      // V1.57: the old Ask to join is closed (the database refuses it too). Older PS: "not open to join right now".
      throw new Fail(404, "unlisted");
    }
    case "ask_status": {
      const r = must(await db.from("dir_requests").select("id, squad_id, state, member_id, updated_at").eq("sign_pub", pub).maybeSingle()) as
        { id: string; squad_id: string; state: string; member_id: string | null; updated_at: string } | null;
      if (!r) return { state: "none" };
      let drop: { gen: number; sealed: string } | null = null;
      if (r.state === "approved" && r.member_id) {
        drop = must(await db.from("squad_keydrops").select("gen, sealed").eq("member_id", r.member_id).order("gen").limit(1).maybeSingle()) as typeof drop;
      }
      return { state: r.state, id: r.id, squad: r.squad_id, member: r.member_id, at: r.updated_at, drop };
    }
    case "ask_cancel": {
      must(await db.from("dir_requests").update({ state: "cancelled", sealed: "", updated_at: new Date().toISOString() }).eq("sign_pub", pub).eq("state", "open"));
      return { ok: true };
    }
  }
  const m = me!;
  switch (act) {
    case "beat": {
      // PS 1.64 members list (migration presence_001_seen.sql): presence_at marks the change for the others' change only
      // pulls. st: the member's gym time sealed with the squad key ("" clears it); the hub never sees what is inside.
      const now = new Date().toISOString();
      const upd: Record<string, unknown> = { last_beat: now, presence_at: now, presence_off: false };
      if (args.st === "") { upd.presence_ct = null; upd.presence_gen = null; }
      else if (args.st !== undefined) { const sq = await squadOf(m.squad_id); upd.presence_ct = ct(args.st, 600); upd.presence_gen = int(args.sg, 1, sq.gen); }
      // Deployed before presence_001_seen.sql is applied, the presence columns are missing: the beat still counts.
      const r = await db.from("squad_members").update(upd).eq("id", m.id);
      if (r.error) must(await db.from("squad_members").update({ last_beat: now }).eq("id", m.id));
      return await pulse(m);
    }
    // PS 1.64: the member switched "working" off: the others' lists show no last beat and no gym time for them. last_beat
    // itself stays (auto_join reads it to keep a second device of the same person in), only presence_off hides it.
    case "away": {
      must(await db.from("squad_members").update({ presence_off: true, presence_ct: null, presence_gen: null, presence_at: new Date().toISOString() }).eq("id", m.id));
      return { ok: true };
    }
    case "count":
      return await pulse(m);
    case "card": {
      const sq = await squadOf(m.squad_id);
      must(await db.from("squad_members").update({ card_ct: ct(args.ct), card_gen: int(args.gen, 1, sq.gen), updated_at: new Date().toISOString() }).eq("id", m.id));
      return { ok: true };
    }
    case "pull": {
      const since = (args.since && typeof args.since === "object" ? args.since : {}) as Record<string, unknown>;
      const at = (k: string) => (typeof since[k] === "string" && !Number.isNaN(Date.parse(since[k] as string)) ? since[k] as string : null);
      const now = new Date().toISOString();
      const sq = await squadOf(m.squad_id);
      // V1.57: people asking to join are not members: never listed here.
      let mq = db.from("squad_members").select("id, sign_pub, box_pub, card_ct, card_gen, joined_at, left_at, updated_at, has_key").eq("squad_id", m.squad_id).eq("admitted", true);
      if (at("m")) mq = mq.gt("updated_at", at("m")!); else mq = mq.is("left_at", null);
      let tq = db.from("squad_tasks").select("id, member_id, ct, gen, deleted, updated_at").eq("squad_id", m.squad_id).order("updated_at").limit(1000);
      if (at("t")) tq = tq.gt("updated_at", at("t")!); else tq = tq.eq("deleted", false);
      let hq = db.from("squad_handoffs").select("id, from_member, to_member, ct, gen, state, created_at, updated_at").eq("squad_id", m.squad_id)
        .or(`from_member.eq.${m.id},to_member.eq.${m.id}`).order("updated_at").limit(200);
      if (at("h")) hq = hq.gt("updated_at", at("h")!); else hq = hq.eq("state", "open");
      const myGen = Number.isInteger(args.gen) ? args.gen as number : 0;
      // PS 1.64 members list: last beats (and the sealed gym time) that changed since `since.p`; the first time, everyone
      // seen in the last 14 days. Change only: a beat touches presence_at, never updated_at.
      let pq = db.from("squad_members").select("id, last_beat, presence_ct, presence_gen, presence_off").eq("squad_id", m.squad_id).eq("admitted", true).is("left_at", null).limit(300);
      pq = at("p") ? pq.gt("presence_at", at("p")!) : pq.gt("last_beat", new Date(Date.now() - SEEN_MS).toISOString()).eq("presence_off", false);
      const [members, tasks, hands, drops, working, seen] = await Promise.all([
        mq, tq, hq,
        db.from("squad_keydrops").select("gen, sealed").eq("member_id", m.id).gt("gen", myGen),
        db.from("squad_members").select("id").eq("squad_id", m.squad_id).is("left_at", null).gt("last_beat", new Date(Date.now() - WORKING_MS).toISOString()),
        pq,
      ]);
      return { now, squad: sq, members: must(members), tasks: must(tasks), hands: must(hands), drops: must(drops), working: (must(working) as { id: string }[]).map((r) => r.id),
        // No `seen` at all while the columns are missing (presence_001_seen.sql not applied yet): PS then shows "Online"
        // from `working` only, as it would with the hub before 1.64.
        ...(seen.error ? {} : { seen: (seen.data as { id: string; last_beat: string | null; presence_ct: string | null; presence_gen: number | null; presence_off: boolean }[])
          .map((r) => (r.presence_off ? { id: r.id, at: null, ct: null, gen: null } : { id: r.id, at: r.last_beat, ct: r.presence_ct, gen: r.presence_gen })) }) };
    }
    case "mine":
      return { rows: must(await db.from("squad_tasks").select("id, fp").eq("member_id", m.id).eq("deleted", false).limit(1000)) };
    case "put_tasks": {
      const sq = await squadOf(m.squad_id);
      const rows = Array.isArray(args.rows) ? args.rows : [];
      if (!rows.length || rows.length > 100) throw new Fail(400, "rows");
      const now = new Date().toISOString();
      const clean = rows.map((r: Record<string, unknown>) => {
        if (typeof r.fp !== "string" || !/^[0-9a-f]{16,64}$/.test(r.fp)) throw new Fail(400, "fp");
        return { id: uuid(r.id), squad_id: m.squad_id, member_id: m.id, ct: ct(r.ct), gen: int(r.gen, 1, sq.gen), fp: r.fp, deleted: false, updated_at: now };
      });
      const taken = must(await db.from("squad_tasks").select("id, member_id").in("id", clean.map((r) => r.id))) as { id: string; member_id: string }[];
      if (taken.some((t) => t.member_id !== m.id)) throw new Fail(403, "not yours");
      must(await db.from("squad_tasks").upsert(clean));
      return { ok: true, n: clean.length };
    }
    case "del_tasks": {
      const ids = (Array.isArray(args.ids) ? args.ids : []).slice(0, 500).map(uuid);
      if (ids.length) must(await db.from("squad_tasks").update({ deleted: true, ct: "", updated_at: new Date().toISOString() }).eq("member_id", m.id).in("id", ids).eq("deleted", false));
      return { ok: true };
    }
    case "invite": {
      const sq = await squadOf(m.squad_id);
      if (sq.rekey || int(args.gen, 1, 1e6) !== sq.gen) throw new Fail(409, "rekey first");
      if (typeof args.hash !== "string" || !HEX64.test(args.hash)) throw new Fail(400, "hash");
      const open = await db.from("squad_invites").select("id", { count: "exact", head: true }).eq("squad_id", m.squad_id).is("used_at", null).gt("expires_at", new Date().toISOString());
      if ((open.count ?? 0) >= 20) throw new Fail(429, "too many invites");
      const days = int(args.days ?? 7, 1, 7);
      must(await db.from("squad_invites").insert({ id: uuid(args.id), squad_id: m.squad_id, created_by: m.id, token_hash: args.hash, wrapped_key: ct(args.wrapped, 400), gen: sq.gen,
        expires_at: new Date(Date.now() + days * 864e5).toISOString() }));
      return { ok: true };
    }
    case "uninvite": {
      // V1.44 Add friend: the QR code closed before anyone used it, so its invite goes at once (only your own, only unused).
      must(await db.from("squad_invites").delete().eq("id", uuid(args.id)).eq("created_by", m.id).is("used_at", null));
      return { ok: true };
    }
    case "leave": {
      const target = args.target ? uuid(args.target) : m.id;
      // V1.49: the admin taking someone out also keeps them from joining again by themselves (auto_remove).
      // V1.57 (gate.ts leaveRoute): a waiting row giving up just goes (no re-key); the admin's no to an ask is turn_away.
      const t = target === m.id ? m : must(await db.from("squad_members").select("id, admitted").eq("id", target).eq("squad_id", m.squad_id).is("left_at", null).maybeSingle()) as Me | null;
      const route = leaveRoute(m, t);
      const r = route === "withdraw" ? await db.rpc("invite_withdraw", { p_member: m.id })
        : route === "turn_away" ? await db.rpc("invite_turn_away", { p_admin: m.id, p_target: target })
        : await db.rpc(route === "leave" ? "squad_leave" : "auto_remove", route === "leave" ? { p_member: m.id, p_target: target } : { p_admin: m.id, p_target: target });
      if (r.error) throw new Fail(403, "leave");
      return r.data;
    }
    case "rekey": {
      const drops = Array.isArray(args.drops) ? args.drops.slice(0, 201).map((d: Record<string, unknown>) => {
        if (typeof d.sealed !== "string" || d.sealed.length > 600) throw new Fail(400, "drop");
        return { member: uuid(d.member), sealed: d.sealed };
      }) : [];
      const r = await db.rpc("squad_rekey", { p_member: m.id, p_from_gen: int(args.from, 1, 1e6), p_drops: drops, p_meta_ct: ct(args.meta) });
      if (r.error) throw new Fail(409, "rekey");
      return r.data;
    }
    case "hand": {
      const sq = await squadOf(m.squad_id);
      const to = uuid(args.to);
      if (to === m.id) throw new Fail(400, "to");
      const them = must(await db.from("squad_members").select("id").eq("id", to).eq("squad_id", m.squad_id).is("left_at", null).maybeSingle());
      if (!them) throw new Fail(404, "no member");
      const open = await db.from("squad_handoffs").select("id", { count: "exact", head: true }).eq("from_member", m.id).eq("state", "open");
      if ((open.count ?? 0) >= 50) throw new Fail(429, "too many");
      must(await db.from("squad_handoffs").insert({ id: uuid(args.id), squad_id: m.squad_id, from_member: m.id, to_member: to, ct: ct(args.ct), gen: int(args.gen, 1, sq.gen) }));
      return { ok: true };
    }
    case "answer": {
      must(await db.from("squad_handoffs").update({ state: args.accept === true ? "accepted" : "declined", updated_at: new Date().toISOString() })
        .eq("id", uuid(args.id)).eq("to_member", m.id).eq("state", "open"));
      return { ok: true };
    }
    case "cancel": {
      must(await db.from("squad_handoffs").update({ state: "cancelled", updated_at: new Date().toISOString() }).eq("id", uuid(args.id)).eq("from_member", m.id).eq("state", "open"));
      return { ok: true };
    }
    // ---------- V1.42: the admin's side of Ask to join ----------
    case "asks": {
      const sq = await squadOf(m.squad_id);
      if (sq.created_by !== m.id) throw new Fail(403, "admin");
      return { rows: must(await db.from("dir_requests").select("id, sign_pub, box_pub, admin_box, sealed, created_at").eq("squad_id", m.squad_id).eq("state", "open").order("created_at").limit(20)) };
    }
    case "approve": {
      // V1.57: closed. V1.49 to V1.56 admin PS sent this by itself, with no button, for every old style Ask to join.
      throw new Fail(403, "admin");
    }
    case "rename": {
      // V1.43: the admin renames the squad (sealed name). The listed squad also sends its public name for the list.
      let name: string | null = null;
      if (args.name !== undefined && args.name !== null) {
        if (typeof args.name !== "string") throw new Fail(400, "name");
        name = args.name.replace(/\s+/g, " ").trim();
        if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) throw new Fail(400, "name");
      }
      return await dirRpc("dir_rename", { p_admin: m.id, p_gen: int(args.gen, 1, 1e6), p_meta_ct: ct(args.meta), p_name: name });
    }
    // ---------- V1.49: one squad, everyone in ----------
    case "auto_key": {
      // Waiting for the squad key: your drop once a member's PS sealed it to you, and whether the squad has no key at
      // all (then you make the first one with auto_start). A few dozen bytes.
      // V1.55 (auto_002_never_stuck.sql): first the heal, so a squad where nobody in holds the key starts over and this
      // PS can make the new one. Only a drop for the key in use now: never an old one from before a re-key.
      // V1.57: a waiting row (asked, not let in yet) just keeps waiting: no key, never "make the first one".
      if (!m.admitted) return waitingKey((await squadOf(m.squad_id)).gen);
      await db.rpc("auto_heal", { p_squad: m.squad_id });
      const sq = await squadOf(m.squad_id);
      const fresh = must(await db.from("squad_members").select("has_key").eq("id", m.id).maybeSingle()) as { has_key: boolean } | null;
      const drop = must(await db.from("squad_keydrops").select("gen, sealed").eq("member_id", m.id).eq("gen", sq.gen).maybeSingle()) as { gen: number; sealed: string } | null;
      return { gen: sq.gen, start: !sq.meta_ct && !(fresh?.has_key ?? m.has_key), drop, admin: sq.created_by === m.id, admitted: true };
    }
    case "auto_start":
      return await dirRpc("auto_start", { p_member: m.id, p_gen: int(args.gen, 1, 1e6), p_meta_ct: ct(args.meta) });
    case "auto_waiting":
      return { rows: await dirRpc("auto_waiting", { p_member: m.id }) };
    case "auto_drop": {
      const drops = (Array.isArray(args.drops) ? args.drops : []).slice(0, 30).map((d: Record<string, unknown>) => {
        if (typeof d.sealed !== "string" || !d.sealed || d.sealed.length > 600) throw new Fail(400, "drop");
        return { member: uuid(d.member), sealed: d.sealed };
      });
      if (!drops.length) return { added: 0 };
      return await dirRpc("auto_drop", { p_member: m.id, p_gen: int(args.gen, 1, 1e6), p_drops: drops });
    }
    case "admin": {
      // The developer's PS only: the hub asks his vault project whether this session is his. Anything else: refused.
      if (!(await isRed(args.token, args.anon))) throw new Fail(403, "admin");
      return await dirRpc("auto_admin", { p_member: m.id });
    }
    // ---------- V1.57: invite only, the admin's answer to an Ask to join ----------
    case "auto_ask": {
      // The asker leaves their name for the admin, sealed to the admin's box key (the hub cannot open it).
      if (typeof args.sealed !== "string" || !args.sealed || args.sealed.length > 2000) throw new Fail(400, "bad ciphertext");
      return await dirRpc("invite_ask", { p_member: m.id, p_sealed: args.sealed });
    }
    case "wait_list": {
      const sq = await squadOf(m.squad_id);
      if (sq.created_by !== m.id) throw new Fail(403, "admin");
      return { rows: must(await db.from("squad_members").select("id, sign_pub, box_pub, ask_ct, joined_at").eq("squad_id", m.squad_id).is("left_at", null)
        .eq("admitted", false).order("joined_at").limit(20)) };
    }
    case "admit": case "turn_away": {
      // Let in (members' PS then hand them the key as before), or no (the row goes, that join id cannot ask again).
      const sq = await squadOf(m.squad_id);
      if (sq.created_by !== m.id) throw new Fail(403, "admin");
      return await dirRpc(act === "admit" ? "invite_admit" : "invite_turn_away", { p_admin: m.id, p_target: uuid(args.id) });
    }
    case "decline": {
      const sq = await squadOf(m.squad_id);
      if (sq.created_by !== m.id) throw new Fail(403, "admin");
      must(await db.from("dir_requests").update({ state: "declined", sealed: "", updated_at: new Date().toISOString() }).eq("id", uuid(args.id)).eq("squad_id", m.squad_id).eq("state", "open"));
      return { ok: true };
    }
  }
  throw new Fail(400, "unknown act");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const text = await req.text();
  if (text.length > 300_000) return json({ error: "too big" }, 413);
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object") throw new Fail(400, "bad request");
    return json(await handle(body));
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, e.code);
    return json({ error: "bad request" }, 400);
  }
});
