// V1.63: Gmail connected truth. Fake data only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const ok = (name: string, fn: () => void) => { try { fn(); console.log("ok", name); } catch (e) { console.error("FAIL", name, e); process.exitCode = 1; } };
const T = await import("../src/core/gmailtruth.ts");
const E = await import("../src/core/mailempty.ts");
const file = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

const sender = (email: string, accounts: string[], last: string) => ({ id: email, kind: "msender", data: { email, accounts, last } });
const reply = (account: string) => ({ id: "r" + account, kind: "reply", data: { account } });
const row = { account: "me@example.com", last_ok: "2026-11-16T10:00:00Z", last_error: null, readonly: true };

ok("seen accounts: from sender and reply records, newest time, sorted, lower case", () => {
  assert.deepEqual(T.seenAccounts([]), []);
  const got = T.seenAccounts([sender("a@client.example", ["Me@Example.com"], "2026-11-16T09:00:00Z"), sender("b@client.example", ["me@example.com", "two@example.com"], "2026-11-16T11:00:00Z"), reply("Three@example.com"), { id: "x", kind: "todo", data: {} }]);
  assert.deepEqual(got, [{ account: "me@example.com", last: "2026-11-16T11:00:00Z" }, { account: "three@example.com", last: null }, { account: "two@example.com", last: "2026-11-16T11:00:00Z" }]);
});

ok("view: status rows win, mail seen beats a failed or empty check, none only when asked and nothing seen", () => {
  const seen = T.seenAccounts([sender("a@client.example", ["me@example.com"], "2026-11-16T09:00:00Z")]);
  assert.equal(T.gmailView({ rows: [row], asked: true, error: null, seen: [] }).state, "status");
  assert.equal(T.gmailView({ rows: [row], asked: true, error: "boom", seen }).state, "status", "an older good answer stays");
  const a = T.gmailView({ rows: [], asked: true, error: null, seen });
  assert.equal(a.state, "seen"); assert.match((a as { note: string }).note, /mail is arriving/);
  const b = T.gmailView({ rows: null, asked: true, error: "permission denied for function", seen });
  assert.equal(b.state, "seen"); assert.match((b as { note: string }).note, /refused/);
  assert.equal(T.gmailView({ rows: [], asked: true, error: null, seen: [] }).state, "none");
  assert.equal(T.gmailView({ rows: null, asked: true, error: "Failed to fetch", seen: [] }).state, "error", "a failed check with no mail is unknown, not 'not connected'");
  assert.equal(T.gmailView({ rows: null, asked: false, error: null, seen: [] }).state, "asking");
  assert.equal(T.gmailView({ rows: [{ nope: 1 }], asked: true, error: null, seen: [] }).state, "none", "rows without an account are ignored");
});

ok("error words are plain and short", () => {
  assert.match(T.checkWords("Failed to fetch"), /could not be reached/);
  assert.match(T.checkWords({ message: "Could not find the function public.gmail_status" }), /missing on the server/);
  assert.match(T.checkWords(null), /did not answer/);
  assert.ok(T.checkWords("x".repeat(500)).length < 160);
  for (const x of [T.checkWords("a"), T.checkWords(undefined)]) assert.doesNotMatch(x, /[–—]/);
});

ok("picked: a client with an address, or someone on the notify list", () => {
  const c = (data: object) => ({ data });
  assert.equal(T.mailPicked([], undefined), false);
  assert.equal(T.mailPicked([c({ name: "A" })], undefined), false, "a client with no address cannot match mail");
  assert.equal(T.mailPicked([c({ email: "a@client.example" })], undefined), true);
  assert.equal(T.mailPicked([c({ matchAddrs: ["client.example"] })], undefined), true);
  assert.equal(T.mailPicked([c({ email: "a@client.example", archived: true })], undefined), false);
  assert.equal(T.mailPicked([], { e: { "x@client.example": { l: "mute", at: "t" } } }), false, "muted is not picked");
  assert.equal(T.mailPicked([], { e: { "x@client.example": { l: "notify", at: "t" } } }), true);
});

ok("cache: a failed call never turns connected into not connected; evidence always wins", () => {
  assert.equal(T.nextKnown(null, { rows: [row], failed: false, evidence: false }), true);
  assert.equal(T.nextKnown(null, { rows: [], failed: false, evidence: false }), false);
  assert.equal(T.nextKnown(true, { rows: null, failed: true, evidence: false }), true);
  assert.equal(T.nextKnown(null, { rows: null, failed: true, evidence: false }), false);
  assert.equal(T.nextKnown(false, { rows: [], failed: false, evidence: true }), true, "mail arrived: forget the cached 'not connected'");
  assert.ok(T.RETRY_FAILED_MS < 10 * 60_000, "a failure is asked again sooner than a good answer");
});

ok("panel: connected + nobody picked leads to the pick screen; not connected only when truly not", () => {
  const p = (o: object) => E.mailPanelShows({ rows: 0, replied: 0, gmail: true, seen: false, ...o });
  assert.equal(p({ picked: false }), "pick");
  assert.equal(p({ picked: true }), "none");
  assert.equal(p({}), "none", "old callers: unchanged");
  assert.equal(p({ gmail: false, picked: false }), "connect");
  assert.equal(p({ gmail: null }), "wait");
  assert.equal(p({ gmail: false, seen: true }), "none", "an Instantly reply: as before");
  assert.equal(p({ rows: 1, picked: false }), "list");
  assert.equal(E.MAIL_EMPTY_WORDS.pick, "Gmail is connected. Pick whose emails show here.");
  assert.equal(E.MAIL_EMPTY_WORDS.pickButton, "Choose senders");
});

ok("wiring: the panel leads to Who emails me, Settings shows the failure, the hook forgets on mail", () => {
  const tm = file("src/views/TaskMap.tsx");
  assert.match(tm, /openSettings\("notify", \{ jump: "gmail-replies" \}\)/);
  assert.match(tm, /useGmailKnown\(empty && !seen && !gmailMail, gmailMail\)/);
  assert.match(file("src/core/settingsindex.ts"), /\{ id: "gmail-replies", group: "notify"/);
  const r = file("src/views/Replies.tsx");
  assert.match(r, /gmailView\(\{ rows, asked, error, seen: seenAccounts/);
  assert.doesNotMatch(r, /setStatus\(\(data as GmailStatus\[\]\) \|\| \[\]\)/, "the error is no longer swallowed");
  assert.match(file("src/views/gmailknown.ts"), /function noteMail\(\)/);
  for (const f of ["src/core/gmailtruth.ts", "src/core/mailempty.ts", "src/views/gmailknown.ts", "src/views/Replies.tsx"]) assert.doesNotMatch(file(f), /[–—]/, f);
});
