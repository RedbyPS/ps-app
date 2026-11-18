// Run: node --experimental-strip-types tests/gsquad-dir-client.test.ts
// G Squad directory client (V1.44 #3): "See available squads" showed no squads on the public build. The hub was fine;
// nothing was listed, because the developer's PS was already in his own private squad and the directory (with Create The G
// Squad) was hidden from anyone in a squad. These tests cover the request PS sends, what it makes of the answer,
// the empty and error states (an error is never shown as an empty list), and the developer moving into The G Squad.
// No network: every hub answer comes from a fake fetcher. Names are fictional.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as S from "../src/core/squadcrypto.ts";
import type { SquadRec } from "../src/core/squadrec.ts";
import { LISTED_NAME } from "../src/core/squaddir.ts";
import { HUB_FN, HubError, hubApi, hubDir } from "../src/squad/hub.ts";
import { listSquads, sayDir } from "../src/squad/dirflows.ts";
import { cleanSquadOp, dirState } from "../src/squad/view.ts";

const tests: [string, () => Promise<void> | void][] = [];
const ok = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

type Sent = { url: string; init: RequestInit; body: S.SignedRequest };
/** A fake hub: answers each act from `acts` (a value, or a status and error), and keeps what was sent. */
function fakeHub(acts: Record<string, unknown | { status: number; error: string }>) {
  const sent: Sent[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as S.SignedRequest;
    sent.push({ url, init, body });
    const a = acts[body.act];
    if (a === undefined) return new Response(JSON.stringify({ error: "unknown act" }), { status: 400 });
    if (a && typeof a === "object" && "status" in (a as object)) {
      const f = a as { status: number; error: string };
      return new Response(JSON.stringify({ error: f.error }), { status: f.status });
    }
    return new Response(JSON.stringify(a), { status: 200 });
  };
  return { sent, fetcher };
}
const UUID1 = "11111111-2222-4333-8444-555555555555";
async function boxPub() { return (await S.newBoxPair()).pub; }

// ---------- the request ----------
ok("dir: one signed POST to the hub's squad function, from a key that is not a member yet", async () => {
  const key = await S.newSignPair();
  const h = fakeHub({ dir: { squads: [] } });
  await hubDir(key, h.fetcher);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].url, HUB_FN);
  assert.equal(HUB_FN, "https://zxhvchchfrkfqxuyorqo.supabase.co/functions/v1/squad", "the G Squad hub, never the developer's vault");
  assert.equal(h.sent[0].init.method, "POST");
  const b = h.sent[0].body;
  assert.equal(b.act, "dir");
  assert.equal(b.member, "", "the directory is read before you are a member");
  assert.deepEqual(b.args, { sign: key.pub });
  assert.ok(await S.verifyRequest(key.pub, b), "the hub's own check passes");
  assert.ok(Math.abs(b.ts - Date.now() / 1000) < 5, "the time the hub checks (2 minutes either way)");
});
ok("listSquads signs with a new throwaway key when you have no request, and with your request's key when you do", async () => {
  const h = fakeHub({ dir: { squads: [] } });
  await listSquads(null, h.fetcher);
  await listSquads(null, h.fetcher);
  assert.notEqual((h.sent[0].body.args as { sign: string }).sign, (h.sent[1].body.args as { sign: string }).sign);
  const mine = await S.newSignPair();
  await listSquads(mine, h.fetcher);
  assert.equal((h.sent[2].body.args as { sign: string }).sign, mine.pub);
});

// ---------- the answer ----------
ok("a listed squad shows as The G Squad (or its new name) with Ask to join's admin key", async () => {
  const admin = await boxPub();
  const h = fakeHub({ dir: { squads: [{ id: UUID1.toUpperCase(), slot: "gsquad", admin_box: admin, name: null }] } });
  assert.deepEqual(await listSquads(null, h.fetcher), [{ id: UUID1, name: LISTED_NAME, adminBox: admin }]);
  const r = fakeHub({ dir: { squads: [{ id: UUID1, slot: "gsquad", admin_box: admin, name: "Night Shift" }] } });
  assert.equal((await listSquads(null, r.fetcher))[0].name, "Night Shift");
});
ok("nothing listed is an empty list (the state the friends saw: the hub had no listed squad)", async () => {
  const h = fakeHub({ dir: { squads: [] } });
  assert.deepEqual(await listSquads(null, h.fetcher), []);
});
ok("rows PS cannot use are dropped, not shown broken", async () => {
  const admin = await boxPub();
  const h = fakeHub({ dir: { squads: [
    { id: "nope", slot: "gsquad", admin_box: admin },
    { id: UUID1, slot: "other", admin_box: admin },
    { id: UUID1, slot: "gsquad", admin_box: "short" },
    null, 7,
  ] } });
  assert.deepEqual(await listSquads(null, h.fetcher), []);
  const g = fakeHub({ dir: { squads: "garbage" } });
  assert.deepEqual(await listSquads(null, g.fetcher), []);
});
ok("a hub error throws (so the screen shows an error with Retry, not an empty list)", async () => {
  const h = fakeHub({ dir: { status: 500, error: "database" } });
  await assert.rejects(listSquads(null, h.fetcher), (e) => e instanceof HubError && e.status === 500);
  const c = fakeHub({ dir: { status: 401, error: "clock" } });
  await assert.rejects(listSquads(null, c.fetcher), (e) => e instanceof HubError && e.status === 401 && /clock/.test(e.message));
  const net = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(listSquads(null, net), TypeError);
});

// ---------- the words ----------
ok("sayDir: each failure says what failed, in plain words", () => {
  assert.match(sayDir(new HubError(500, "database")), /server had a problem/);
  assert.match(sayDir(new HubError(401, "clock")), /clock is off/);
  assert.match(sayDir(new HubError(403, "claim")), /claim code is not right/);
  assert.match(sayDir(new HubError(429, "wait")), /in an hour/);
  assert.match(sayDir(new HubError(404, "unlisted")), /not open to join/);
  assert.match(sayDir(new HubError(409, "full")), /full/);
  assert.match(sayDir(new TypeError("Failed to fetch")), /could not be reached\. Check your internet/);
  assert.match(sayDir(new TypeError("Load failed")), /could not be reached/);
  const slow = new Error("timed out"); slow.name = "TimeoutError";
  assert.match(sayDir(slow), /took too long/);
  assert.equal(sayDir(new TypeError("x is not a function")), "x is not a function", "a code bug is not called a network problem");
  assert.match(sayDir("??"), /Something went wrong/);
  for (const e of [new HubError(500, "x"), new TypeError("Failed to fetch"), new HubError(403, "claim")]) assert.ok(!/[–—]/.test(sayDir(e)), "no dashes");
});

// ---------- the box's state ----------
ok("dirState: loading, error, empty and list are told apart", () => {
  assert.equal(dirState(null), "loading");
  assert.equal(dirState({ list: null, busy: null, error: null }), "loading");
  assert.equal(dirState({ list: null, busy: "Looking", error: null }), "loading");
  assert.equal(dirState({ list: [], busy: "Looking", error: null }), "loading", "a Retry shows Looking again");
  assert.equal(dirState({ list: null, busy: null, error: "G Squad could not be reached." }), "error");
  assert.equal(dirState({ list: [], busy: null, error: null }), "empty");
  assert.equal(dirState({ list: [{ id: UUID1, name: LISTED_NAME }], busy: null, error: null }), "list");
  assert.equal(dirState({ list: [{ id: UUID1, name: LISTED_NAME }], busy: null, error: "You already asked." }), "list", "an Ask error keeps the list");
});

ok("V1.49: the Tab list can no longer ask for createListed", () => {
  assert.equal(cleanSquadOp({ op: "createListed", code: " " + "e".repeat(30) + " ", me: "Alex" }), null);
});

// ---------- the wiring (source checks: the engine and the screen need the vault and React) ----------
ok("engine: a failed look clears the list; nothing offers Create The G Squad or moves the developer by claim any more", () => {
  const e = read("src/squad/direngine.ts");
  assert.match(e, /catch \(e\) \{ list = null; throw e; \}/, "a failed look never leaves an old empty list on screen");
  assert.ok(!/moveToListed|createListed|listable/.test(e));
  assert.ok(!/listable|older: o\.older/.test(read("src/squad/mirror.ts")));
});
ok("screen: an error says so with Try again; joining, left, removed and full each say what is going on", () => {
  const s = read("src/views/GSquad.tsx");
  assert.ok(!/No squads are open to join right now/.test(s), "the old line that hid errors is gone");
  assert.match(s, /Could not reach \{THE_SQUAD\}/);
  assert.match(s, />Try again</);
  assert.match(s, /Getting you into \{THE_SQUAD\}/);
  assert.doesNotMatch(s, />Join again</, "PS 1.68 one squad for everyone: no Join again");
  assert.ok(!/opens soon|ClaimCard/.test(s));
  assert.ok(!/[\u2013\u2014]/.test(s), "no em or en dashes");
});
let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log("ok -", name); } catch (e) { failed++; console.error("FAIL -", name, "\n ", e); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
