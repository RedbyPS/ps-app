// Run: node --experimental-strip-types tests/gsquad-auto.test.ts
// V1.49 one squad, everyone in. The developer, 11 Nov 2026: "I want to make it there's automatically one squad already and
// we're all automatically in it." These tests run the very code PS runs (core/squadauto.ts, squad/autoflows.ts)
// against an in-memory hub that follows the rules of supabase/hub/migrations/auto_001_one_squad.sql: it checks every
// signature, gives a member id at once, lets only the first PS make the key, lists people waiting for it, and takes
// a key drop only for someone still waiting. No network. Names are fictional.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/core/squadcrypto.ts";
import { openCard, planRekey } from "../src/core/squadrec.ts";
import { autoStage, cleanJoinRec, dropsFor, hasCard, newPending, pickJoinRec, sayAuto, shouldJoin, THE_SQUAD, whoHash, type Pending } from "../src/core/squadauto.ts";
import { autoCheck, autoJoin, handOut, theSquadId } from "../src/squad/autoflows.ts";
import { HubError, hubApi } from "../src/squad/hub.ts";

const tests: [string, () => Promise<void> | void][] = [];
const ok = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// ---------- an in-memory hub with the migration's rules ----------
interface Row { id: string; sign: string; box: string; who: string | null; has_key: boolean; card_ct: string | null; card_gen: number | null; left: boolean; joined: number }
function memHub() {
  const sq = { id: S.newUuid(), gen: 1, meta: null as string | null, meta_gen: null as number | null, created_by: null as string | null, rekey: false };
  const rows = new Map<string, Row>();
  const drops: { member: string; gen: number; sealed: string }[] = [];
  const blocked = new Set<string>();
  const acts: string[] = [];
  const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status });
  const ans = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
  const live = () => [...rows.values()].filter((r) => !r.left);
  const fetcher = async (_url: string, init: RequestInit) => {
    const b = JSON.parse(String(init.body)) as S.SignedRequest;
    const args = (b.args ?? {}) as Record<string, any>;
    acts.push(b.act);
    if (b.act === "auto_join" || b.act === "dir") {
      if (!(await S.verifyRequest(args.sign, b))) return fail(401, "signature");
      if (b.act === "dir") return ans({ squads: [], gs: sq.id });
      const same = live().find((r) => r.sign === args.sign);
      if (same) return ans({ squad: sq.id, member: same.id, gen: sq.gen, start: !sq.meta && !same.has_key, key: same.has_key });
      if (args.who && blocked.has(args.who)) return fail(403, "removed");
      const twin = live().find((r) => r.who && r.who === args.who);
      if (twin && Date.now() - twin.joined < 10 * 60_000) return fail(409, "already in");
      if (live().length >= 30) return fail(409, "full");
      const id = S.newUuid();
      rows.set(id, { id, sign: args.sign, box: args.box, who: args.who ?? null, has_key: false, card_ct: null, card_gen: null, left: false, joined: Date.now() });
      return ans({ squad: sq.id, member: id, gen: sq.gen, start: !sq.meta, key: false });
    }
    const me = rows.get(b.member);
    if (!me || me.left) return fail(403, "not a member");
    if (!(await S.verifyRequest(me.sign, b))) return fail(401, "signature");
    switch (b.act) {
      case "auto_key": {
        const d = drops.filter((x) => x.member === me.id).sort((a, c) => c.gen - a.gen)[0] ?? null;
        return ans({ gen: sq.gen, start: !sq.meta && !me.has_key, drop: d ? { gen: d.gen, sealed: d.sealed } : null, admin: sq.created_by === me.id });
      }
      case "auto_start": {
        if (sq.meta || args.gen !== sq.gen || live().some((r) => r.has_key && r.id !== me.id)) return fail(409, "started");
        sq.meta = args.meta; sq.meta_gen = args.gen; me.has_key = true;
        return ans({ ok: true, gen: args.gen });
      }
      case "auto_waiting":
        if (!me.has_key || !sq.meta) return ans({ rows: [] });
        return ans({ rows: live().filter((r) => !r.has_key).map((r) => ({ id: r.id, box: r.box, sign: r.sign })) });
      case "auto_drop": {
        if (!me.has_key) return fail(403, "not a member");
        if (sq.rekey || args.gen !== sq.gen) return fail(409, "rekey first");
        let added = 0;
        for (const d of args.drops) {
          const t = rows.get(d.member);
          if (!t || t.left || t.has_key || drops.some((x) => x.member === t.id && x.gen === args.gen)) continue;
          drops.push({ member: t.id, gen: args.gen, sealed: d.sealed }); t.has_key = true; added++;
        }
        return ans({ added });
      }
      case "card": me.card_ct = args.ct; me.card_gen = args.gen; return ans({ ok: true });
      case "leave": {
        const t = rows.get(args.target ?? me.id)!;
        if (t.id !== me.id && sq.created_by !== me.id) return fail(403, "leave");
        t.left = true; t.card_ct = null;
        if (t.id !== me.id && t.who) blocked.add(t.who);
        return ans({ gone: false });
      }
    }
    return fail(400, "unknown act");
  };
  return { sq, rows, drops, blocked, acts, fetcher };
}
const PROJECT = "https://abcdefghijklmnopqrst.supabase.co";
const user = () => S.newUuid();
async function join(h: ReturnType<typeof memHub>, name: string, uid = user()) {
  const p = await newPending(name);
  return (await autoJoin(await whoHash(PROJECT, uid), p, h.fetcher)).pending;
}

// ---------- the join record and the rules ----------
ok("join id: the same on every device of one account, different per account and project, never the id itself", async () => {
  const u = user();
  const a = await whoHash(PROJECT, u), b = await whoHash(PROJECT + "/", u);
  assert.equal(a, b, "the Mac and the phone (same project, same account) give the same id");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.ok(!a.includes(u.replace(/-/g, "")));
  assert.notEqual(a, await whoHash(PROJECT, user()));
  assert.notEqual(a, await whoHash("https://zzzzzzzzzzzzzzzzzzzz.supabase.co", u));
});
ok("join record: checked field by field; two devices' records settle on the one the hub knows", async () => {
  assert.equal(cleanJoinRec(null), null);
  assert.equal(cleanJoinRec({ v: 2 }), null);
  const p = await newPending("Sam");
  assert.deepEqual(cleanJoinRec({ v: 1, left: true, gs: "NOPE", pending: { me: "x" } }), { v: 1, left: true });
  const known = { ...p, squadId: S.newUuid(), memberId: S.newUuid() };
  const pick = pickJoinRec([{ id: "b", data: { v: 1, pending: p } }, { id: "c", data: { v: 1, pending: known } }, { id: "a", data: { v: 1 } }]);
  assert.equal(pick?.doc.id, "c", "the record with a member id wins");
  assert.equal(pickJoinRec([{ id: "x", data: "junk" }]), null);
});
ok("who joins by itself: not when in, not after leaving or being taken out, not twice", () => {
  assert.equal(shouldJoin(false, null), true, "a brand new PS joins");
  assert.equal(shouldJoin(true, null), false);
  assert.equal(shouldJoin(false, { v: 1, left: true }), true, "PS 1.68 one squad for everyone: a left from an older PS joins again");
  assert.equal(shouldJoin(false, { v: 1, removed: true }), false, "taken out");
  assert.equal(shouldJoin(false, { v: 1, pending: {} as Pending }), false, "a join already on its way");
  assert.equal(autoStage(null, null), "joining");
  assert.equal(autoStage({ v: 1, left: true }, null), "joining", "PS 1.68: nobody stays left");
  assert.equal(autoStage({ v: 1, left: true }, "removed"), "removed");
  assert.equal(autoStage(null, "full"), "full");
  assert.equal(autoStage(null, "error"), "error");
});
ok("plain words for each refusal", () => {
  assert.equal(sayAuto(403, "removed").problem, "removed");
  assert.equal(sayAuto(403, "removed").text, "The admin took you out of The G Squad.");
  assert.equal(sayAuto(409, "full").text, "The G Squad is full (200 people).");
  assert.equal(sayAuto(500, "database").problem, "error");
  assert.match(sayAuto(401, "clock").text, /clock is off/);
  assert.equal(THE_SQUAD, "The G Squad");
});

// ---------- the whole way in, against the in-memory hub ----------
ok("the first PS in makes the key; its card goes up; the name opens as The G Squad", async () => {
  const h = memHub();
  const p = await join(h, "Alex");
  assert.equal(p.squadId, h.sq.id);
  const out = await autoCheck(p, h.fetcher);
  assert.equal(out.state, "in");
  if (out.state !== "in") return;
  assert.equal(out.rec.keys[0].gen, 1);
  assert.equal((await S.open<{ n: string }>(out.rec.keys[0].k, h.sq.meta!, S.sqAad.meta(h.sq.id, 1))).n, "The G Squad");
  const row = h.rows.get(p.memberId!)!;
  assert.equal((await openCard(out.rec, row.id, row.card_ct, row.card_gen))?.n, "Alex");
  assert.deepEqual(h.acts, ["auto_join", "auto_key", "auto_start", "card"]);
});
ok("the next PS waits, a member's PS hands it the key, then it is in with the same key; no approval anywhere", async () => {
  const h = memHub();
  const a = await autoCheck(await join(h, "Alex"), h.fetcher);
  assert.equal(a.state, "in");
  const p = await join(h, "Sam");
  assert.deepEqual(await autoCheck(p, h.fetcher), { state: "wait" }, "nobody has handed it over yet");
  if (a.state !== "in") return;
  const api = hubApi({ member: a.rec.memberId, priv: a.rec.sign.priv }, h.fetcher);
  assert.equal(await handOut(a.rec, api), 1);
  assert.equal(await handOut(a.rec, api), 0, "nobody waits any more: nothing sent twice");
  const s = await autoCheck(p, h.fetcher);
  assert.equal(s.state, "in");
  if (s.state !== "in") return;
  assert.equal(s.rec.keys[0].k, a.rec.keys[0].k, "the same squad key");
  assert.equal(h.rows.get(s.rec.memberId)!.card_ct !== null, true, "Sam's card is up, so the others list Sam");
  assert.ok(!h.acts.some((x) => /ask|approve|create_listed/.test(x)), "no Ask to join, no approval, no claim");
});
ok("a key drop opens only for the person it was sealed to (the hub cannot hand it to someone else)", async () => {
  const h = memHub();
  const a = await autoCheck(await join(h, "Alex"), h.fetcher);
  if (a.state !== "in") throw new Error("not in");
  const sam = await join(h, "Sam"), kit = await join(h, "Kit");
  const d = await dropsFor(a.rec, [{ id: sam.memberId!, box: sam.box.pub, sign: sam.sign.pub }, { id: a.rec.memberId, box: a.rec.box.pub, sign: a.rec.sign.pub }]);
  assert.deepEqual(d.drops.map((x) => x.member), [sam.memberId], "never to yourself");
  await assert.rejects(S.openKeyDrop(kit.box.priv, d.drops[0].sealed, S.sqAad.drop(a.rec.squadId, kit.memberId!, d.gen)));
  await assert.rejects(S.openKeyDrop(sam.box.priv, d.drops[0].sealed, S.sqAad.drop(a.rec.squadId, kit.memberId!, d.gen)), "moved onto another member: refused");
  assert.equal(await S.openKeyDrop(sam.box.priv, d.drops[0].sealed, S.sqAad.drop(a.rec.squadId, sam.memberId!, d.gen)), a.rec.keys[0].k);
});
ok("two PS joining an empty squad at once: one makes the key, the other waits for it (never two keys)", async () => {
  const h = memHub();
  const p1 = await join(h, "Alex"), p2 = await join(h, "Sam");
  const [o1, o2] = [await autoCheck(p1, h.fetcher), await autoCheck(p2, h.fetcher)];
  assert.equal(o1.state, "in");
  assert.equal(o2.state, "wait", "the second was refused the start and waits for a drop");
});
ok("a retry with the same keys is the same member; your other device joining a moment later is refused, then waits", async () => {
  const h = memHub();
  const uid = user();
  const p = await newPending("Alex");
  const who = await whoHash(PROJECT, uid);
  const r1 = await autoJoin(who, p, h.fetcher), r2 = await autoJoin(who, p, h.fetcher);
  assert.equal(r1.pending.memberId, r2.pending.memberId);
  await assert.rejects(autoJoin(who, await newPending("Alex"), h.fetcher), (e) => e instanceof HubError && e.status === 409 && /already in/.test(e.message));
  assert.equal([...h.rows.values()].length, 1);
});
ok("Take out keeps them out: their PS cannot join again by itself", async () => {
  const h = memHub();
  const a = await autoCheck(await join(h, "Alex"), h.fetcher);
  if (a.state !== "in") throw new Error("not in");
  h.sq.created_by = a.rec.memberId;   // The developer's admin step (the hub checked his vault)
  const uid = user();
  const sam = await join(h, "Sam", uid);
  await hubApi({ member: a.rec.memberId, priv: a.rec.sign.priv }, h.fetcher).leave(sam.memberId!);
  await assert.rejects(join(h, "Sam", uid), (e) => e instanceof HubError && e.status === 403 && sayAuto(e.status, e.message).problem === "removed");
});
ok("someone still getting in (no card) never holds up a re-key, and is never sealed to by it", async () => {
  const h = memHub();
  const a = await autoCheck(await join(h, "Alex"), h.fetcher);
  if (a.state !== "in") throw new Error("not in");
  const sam = await join(h, "Sam");
  const rows = [...h.rows.values()].map((r) => ({ id: r.id, sign_pub: r.sign, box_pub: r.box, card_ct: r.card_ct, card_gen: r.card_gen, left_at: null }));
  assert.equal(hasCard(rows.find((r) => r.id === sam.memberId)!), false);
  const plan = await planRekey(a.rec, rows.filter(hasCard), "The G Squad");
  assert.deepEqual(plan!.drops.map((d) => d.member), [a.rec.memberId]);
});
ok("The G Squad's id comes with the directory answer (a PS in an older squad knows to move)", async () => {
  const h = memHub();
  assert.equal(await theSquadId(null, h.fetcher), h.sq.id);
});

// ---------- the hub, the admin step and the screen (source checks) ----------
ok("hub migration: made once and listed by spending the claim; never deleted; Take out blocks; no card means not in yet", () => {
  const m = read("supabase/hub/migrations/auto_001_one_squad.sql");
  assert.match(m, /select public\.auto_squad\(\);/);
  assert.match(m, /if left_now = 0 and not listed then\s+delete from public\.squads/, "only an older squad is ever deleted");
  assert.match(m, /insert into public\.squad_blocked \(squad_id, who\)/);
  assert.match(m, /raise exception 'removed'/);
  assert.match(m, /left_at is null and card_ct is not null;/, "chat periods count members with a card");
  assert.match(m, /into want from public\.squad_members where squad_id = sq\.id and left_at is null and card_ct is not null;/, "so does the re-key");
  assert.match(m, /if n >= 30 then raise exception 'full'/);
  assert.match(m, /if n >= 60 then raise exception 'busy'/);
  for (const f of ["auto_join", "auto_start", "auto_waiting", "auto_drop", "auto_admin", "auto_remove", "auto_tidy", "auto_squad"]) {
    assert.match(m, new RegExp(`revoke all on function public\\.${f}\\(`), `${f}: nothing for the Data API`);
    assert.match(m, new RegExp(`grant execute on function public\\.${f}\\([^)]*\\) to service_role;`), f);
  }
  assert.match(m, /force row level security/);
});
ok("edge function: admin only when the developer's vault says 'red' (fails closed); nobody makes another squad; the key is never on the hub", () => {
  const f = read("supabase/hub/functions/squad/index.ts");
  assert.match(f, /const RED_VAULT = "https:\/\/mxusokxekkecebwqgeru\.supabase\.co";/);
  assert.match(f, /return r\.ok && \(await r\.json\(\)\) === "red";/);
  assert.match(f, /catch \{ return false; \}/);
  assert.match(f, /if \(!\(await isRed\(args\.token, args\.anon\)\)\) throw new Fail\(403, "admin"\);/);
  assert.match(f, /case "create":\s+\/\/[^\n]*\n\s+throw new Fail\(403, "one squad"\);/);
  assert.match(f, /const KEY_ACTS = new Set\(\[[^\]]*"auto_join"\]\);/, "joining is signed with the new key itself");
  assert.ok(!/console\.log|token\)\s*;?\s*\/\/ store/.test(f), "the token is never logged");
});
ok("PS: only the developer's account sends the admin step, once per session; PS 1.68 nobody leaves, a PS account shows the hub who it is", () => {
  const e = read("src/squad/autoengine.ts");
  assert.match(e, /if \(!v\.creator && isRedAccount\(vaultStore\.get\(\)\) && adminTried !== rec\.memberId\) \{/);
  assert.match(e, /await ctx!\.api\(\)\?\.admin\(token, PROJECT\.key\)/);
  assert.doesNotMatch(e, /left: true/);
  assert.match(e, /autoJoin\(await whoHash\(PROJECT\.url, s\.userId!\), p, undefined, await account\(\)\)/, "the join carries the account");
  assert.match(e, /Date\.now\(\) - admitTried > ADMIT_EVERY_MS/, "a waiting join shows its account at most every 10 minutes");
  const g = read("src/squad/engine.ts");
  assert.match(g, /case "leave": return;/);
  const hub = read("supabase/hub/functions/squad/index.ts");
  assert.match(hub, /if \(who && await isPsAccount\(args\.vault, args\.anon, who\)\)/);
  assert.match(hub, /role !== "owner" && role !== "red"/, "only an account that owns its vault");
  assert.match(hub, /sha256hex\(`gsquad-v1\|who\|\$\{RED_VAULT\}\|\$\{id\}`\)\) === who/, "the join id must be that account's own");
  const sql = read("supabase/hub/migrations/invite_002_every_ps_user.sql");
  assert.match(sql, /squad_blocked where squad_id = sid and who = p_who/, "Take out still keeps people out");
  assert.match(sql, /grant execute on function public\.auto_join_account\(text, text, text\) to service_role;/);
  assert.match(g, /autoPulse\(p\.k\);/);
});
ok("the join pop up and shared tasks off still apply: the vote starts when a card arrives, sharing still starts off", () => {
  const c = read("supabase/hub/migrations/chat_001_chat.sql");
  assert.match(c, /insert into public\.chat_votes \(squad_id, joiner, before_epoch, voters\)/, "a new period with someone new starts the history vote");
  assert.match(read("src/core/squadchat.ts"), /just joined the G Squad\. Do you want them to see your entire conversation history\?/);
  assert.match(read("src/views/GSquad.tsx"), /Task sharing starts off/);
});
ok("no em or en dashes in anything new", () => {
  for (const p of ["src/core/squadauto.ts", "src/squad/autoflows.ts", "src/squad/autoengine.ts", "supabase/hub/migrations/auto_001_one_squad.sql", "supabase/hub/functions/squad/index.ts", "src/views/GSquad.tsx", "src/views/AddFriend.tsx", "src/views/GSquadLink.tsx", "src/views/GSquadSettings.tsx"]) {
    assert.ok(!/[–—]/.test(read(p)), p);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok -", name); } catch (e) { failed++; console.error("FAIL -", name, "\n ", e); }
}
console.log(`gsquad-auto: ${tests.length - failed} of ${tests.length} passed`);
if (failed) process.exit(1);
