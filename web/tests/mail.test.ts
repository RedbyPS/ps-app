// Run: node tests/mail.test.ts  (Node 22.6+ strips types)
// Gmail replies: sender parsing, client matching, reply folding, the sealed payloads the
// gmail-inbox function builds, and that the browser can open what the function seals.
import assert from "node:assert/strict";
import * as M from "../src/core/mail.ts";
import * as L from "../supabase/functions/gmail-inbox/lib.ts";
import * as C from "../src/core/crypto.ts";

let n = 0;
const ok = (name: string, fn: () => void | Promise<void>) => Promise.resolve(fn()).then(() => { n++; }, (e) => { console.error("FAIL", name); throw e; });

// ---------- sender parsing ----------
await ok("parseAddress", () => {
  assert.deepEqual(M.parseAddress('"Morgan, Alex" <pmorgan@client5.example>'), { name: "Morgan, Alex", email: "pmorgan@client5.example" });
  assert.deepEqual(M.parseAddress("Alex morgan <pmorgan@client5.example>"), { name: "Alex morgan", email: "pmorgan@client5.example" });
  assert.deepEqual(M.parseAddress("<person1@b.co>"), { name: null, email: "person1@b.co" });
  assert.deepEqual(M.parseAddress("person1@b.co"), { name: null, email: "person1@b.co" });
  assert.deepEqual(M.parseAddress(null), { name: null, email: null });
  assert.equal(M.firstName("Morgan, Alex"), "Alex");
  assert.equal(M.firstName('"Alex morgan"'), "Alex");
  assert.equal(M.firstName("person14@x.com"), null);
});

await ok("match entries", () => {
  assert.deepEqual(M.parseMatchEntry(" Mailto:sam@client1.example "), { type: "addr", v: "sam@client1.example" });
  assert.deepEqual(M.parseMatchEntry("@acme.com"), { type: "domain", v: "acme.com" });
  assert.deepEqual(M.parseMatchEntry("https://www.acme.co.uk/about"), { type: "domain", v: "acme.co.uk" });
  assert.equal(M.parseMatchEntry("not an address"), null);
  assert.deepEqual(M.cleanMatchList("person2@x.com, acme.com\n\nacme.com ;nope"), { ok: ["person2@x.com", "acme.com"], bad: ["nope"] });
});

// ---------- matching ----------
const clients = [
  { id: "tp", data: { name: "Sample organics", email: "pmorgan@client1.example" } },
  { id: "dom", data: { name: "Northwind Cosmetics", email: "person3@aliasmail.example", matchAddrs: ["client2.example", "person4@aliasmail.example"] } },
  { id: "old", data: { name: "Old Co", email: "x@sharedco.example", archived: true } },
  { id: "new", data: { name: "New Co", matchAddrs: ["sharedco.example"] } },
  { id: "sub", data: { name: "Sub Team", matchAddrs: ["eu.client2.example"] } },
  { id: "free", data: { name: "Free Domain Try", matchAddrs: ["gmail.com"] } },
];
const match = M.buildMatcher(clients as never);
await ok("exact main email", () => assert.equal(match("pmorgan@client5.example"), "tp"));
await ok("company domain of main email", () => assert.equal(match("assistant@client5.example"), "tp"));
await ok("free provider main email matches exactly only", () => {
  assert.equal(match("person3@aliasmail.example"), "dom");
  assert.equal(match("person6@aliasmail.example"), null, "a free mail domain must never match a whole client");
});
await ok("explicit address and domain", () => {
  assert.equal(match("person4@aliasmail.example"), "dom");
  assert.equal(match("ops@client2.example"), "dom");
  assert.equal(match("ops@mail.client2.example"), "dom", "subdomains count");
  assert.equal(match("ops@eu.client2.example"), "sub", "longest domain wins");
  assert.equal(match("ops@notclient2.example"), null, "suffix must be a real subdomain");
});
await ok("exact address beats domain, active beats archived", () => {
  assert.equal(match("person19@sharedco.com"), "old", "exact main email still wins");
  assert.equal(match("person20@sharedco.com"), "new", "explicit domain beats an archived client's implicit domain");
});
await ok("strangers", () => { assert.equal(match("stranger@example.org"), null); assert.equal(match(null), null); });

// ---------- folding messages into reply records ----------
const msg = (id: string, date: string, extra: Partial<M.GmailInbound> = {}): M.GmailInbound => ({
  kind: "gmail", account: "owner1@aliasmail.example", id, threadId: "t1", date,
  from: "Alex morgan <pmorgan@client1.example>", subject: "Re: Shopify draft", snippet: "Great response . I agree.", ...extra,
});
await ok("new reply", () => {
  const r = M.applyInbound(undefined, msg("m1", "2026-10-14T22:27:00.000Z"), "tp")!;
  assert.equal(r.clientId, "tp");
  assert.equal(r.from, "pmorgan@client5.example");
  assert.equal(r.fromName, "Alex morgan");
  assert.equal(r.count, 1);
  assert.equal(r.handled, false);
  assert.deepEqual(r.msgIds, ["m1"]);
});
await ok("same message twice is ignored", () => {
  const r = M.applyInbound(undefined, msg("m1", "2026-10-14T22:27:00.000Z"), "tp")!;
  assert.equal(M.applyInbound(r, msg("m1", "2026-10-14T22:27:00.000Z"), "tp"), null);
});
await ok("newer message updates preview, older one only counts", () => {
  const r1 = M.applyInbound(undefined, msg("m1", "2026-10-14T10:00:00.000Z"), "tp")!;
  const r2 = M.applyInbound(r1, msg("m2", "2026-10-14T12:00:00.000Z", { snippet: "One more thing" }), "tp")!;
  assert.equal(r2.snippet, "One more thing");
  assert.equal(r2.count, 2);
  const r3 = M.applyInbound(r2, msg("m0", "2026-10-13T12:00:00.000Z", { snippet: "older" }), "tp")!;
  assert.equal(r3.snippet, "One more thing");
  assert.equal(r3.count, 3);
});
await ok("handled thread reopens only for mail after it was handled", () => {
  const r1 = M.applyInbound(undefined, msg("m1", "2026-10-14T10:00:00.000Z"), "tp")!;
  const h = { ...r1, handled: true, handledAt: "2026-10-14T11:00:00.000Z", handledHow: "you" as const };
  const late = M.applyInbound(h, msg("m0", "2026-10-14T10:30:00.000Z"), "tp")!;
  assert.equal(late.handled, true, "a late-indexed older message keeps it handled");
  const again = M.applyInbound(h, msg("m2", "2026-10-14T12:00:00.000Z"), "tp")!;
  assert.equal(again.handled, false);
  assert.equal(again.handledAt, null);
});
// A colleague on another address (4 Nov 2026: a partner of a client wrote from his own company's domain and
// no pop up came). In a client's thread he counts for that client; a new thread from him still needs a link.
await ok("colleague in a client thread counts for that client", () => {
  const own = new Set(["owner1@aliasmail.example", "owner2@aliasmail.example"]);
  const thread = M.applyInbound(undefined, msg("m1", "2026-11-03T10:00:00.000Z"), "tp")!;
  const pat = msg("m2", "2026-11-03T19:40:36.000Z", { from: "Pat Partner <pat@partnerco.example>", subject: "" });
  assert.equal(M.clientForInbound(match, pat, thread, own), "tp", "his email in the client's thread is the client's");
  assert.equal(M.clientForInbound(match, pat, undefined, own), null, "a new thread from a sender with no link is not a client email");
  assert.equal(M.clientForInbound(match, msg("m3", "2026-11-03T20:00:00.000Z"), undefined, own), "tp", "the sender match still comes first");
  assert.equal(M.clientForInbound(match, msg("m4", "2026-11-03T20:00:00.000Z", { from: "The developer <owner2@aliasmail.example>" }), thread, own), null,
    "The developer writing from another of his own accounts never makes a card");
  assert.equal(M.clientForInbound(match, { from: null }, thread, own), null);
  const r = M.applyInbound(thread, pat, M.clientForInbound(match, pat, thread, own)!)!;
  assert.equal(r.clientId, "tp");
  assert.equal(r.from, "pat@partnerco.example");
  assert.equal(r.subject, "(no subject)", "an empty subject is kept readable");
  assert.equal(r.count, 2);
});
await ok("The developer answering in Gmail marks it handled", () => {
  const r1 = M.applyInbound(undefined, msg("m1", "2026-10-14T10:00:00.000Z"), "tp")!;
  const sent = (date: string): M.GmailSent => ({ kind: "gmail-sent", account: r1.account, id: "s1", threadId: "t1", date });
  assert.equal(M.applySent(r1, sent("2026-10-14T09:00:00.000Z")), null, "a send before their reply does not count");
  const h = M.applySent(r1, sent("2026-10-14T10:05:00.000Z"))!;
  assert.equal(h.handled, true);
  assert.equal(h.handledHow, "replied");
  assert.equal(M.applySent(h, sent("2026-10-14T10:06:00.000Z")), null, "already handled");
  assert.equal(M.applySent(undefined, sent("2026-10-14T10:06:00.000Z")), null, "no reply record");
});
await ok("msgIds stay bounded", () => {
  let r = M.applyInbound(undefined, msg("m0", "2026-10-01T00:00:00.000Z"), "tp")!;
  for (let i = 1; i < 80; i++) r = M.applyInbound(r, msg("m" + i, new Date(Date.parse("2026-10-01") + i * 60000).toISOString()), "tp")!;
  assert.equal(r.msgIds.length, 50);
  assert.equal(r.count, 80);
});

// ---------- display ----------
await ok("names and links", () => {
  const tp = { name: "Sample organics", contactName: "Alex morgan", greetingName: "Alex", email: "pmorgan@client1.example" };
  assert.equal(M.replierName(tp, { from: "pmorgan@client1.example", fromName: "P K" }), "Alex");
  assert.equal(M.replierName(tp, { from: "mike@client1.example", fromName: "Mike Lee" }), "Mike", "a colleague is named, not the main contact");
  assert.equal(M.replierName(tp, { from: "mike@client1.example", fromName: null }), "mike");
  const GM = "gmail" + ".com";   // the real Gmail ending, built here so no address-looking text sits in the file
  assert.equal(M.accountLabel(`owner1@${GM}`), "owner1");
  const link = M.gmailThreadLink("owner1@mail.example", "19a2b3c4d5e6f708");
  assert.equal(link, "https://mail.google.com/mail/?authuser=owner1%40mail.example#all/19a2b3c4d5e6f708");
});

// ---------- edge function helpers ----------
await ok("search window", () => {
  const now = Date.parse("2026-10-15T05:00:00Z");
  assert.equal(L.afterSec(null, now), Math.floor((now - L.BACKFILL_MS) / 1000), "first run looks back 7 days");
  const cur = now - 120_000;
  assert.equal(L.afterSec(cur, now), Math.floor((cur - L.OVERLAP_MS) / 1000), "then overlaps the last run by 15 minutes");
  assert.equal(L.afterSec(now - 30 * 86_400_000, now), Math.floor((now - L.BACKFILL_MS) / 1000), "never further back than 7 days");
  assert.match(L.inboundQuery(123), /^in:inbox -from:me .*after:123$/);
  assert.ok(L.inboundQuery(1).includes("-category:promotions"));
});
await ok("payloads carry headers, snippet and the opening only", () => {
  const gm: L.GmailMessage = {
    id: "m1", threadId: "t1", internalDate: String(Date.parse("2026-10-14T22:27:00Z")), snippet: "Great response &#39;n&#39; &amp; more",
    labelIds: ["INBOX"],
    payload: { headers: [{ name: "From", value: "Alex <person12@t.com>" }, { name: "Subject", value: "Re: x" }, { name: "Message-Id", value: "<person3@t.com>" }] },
  };
  const p = L.inboundPayload("owner1@aliasmail.example", gm);
  assert.deepEqual(Object.keys(p).sort(), ["account", "cc", "date", "from", "id", "kind", "msgId", "opening", "snippet", "subject", "threadId", "to"]);
  assert.equal(p.opening, null, "no body part: no opening");
  assert.equal(p.snippet, "Great response 'n' & more");
  assert.equal(p.date, "2026-10-14T22:27:00.000Z");
  assert.equal(p.msgId, "<person3@t.com>");
  assert.equal(p.to, null);
  const s = L.sentPayload("person1@aliasmail.example", gm);
  assert.deepEqual(Object.keys(s).sort(), ["account", "date", "id", "kind", "threadId"], "sent markers carry no content at all");
  const long = L.inboundPayload("a", { ...gm, snippet: "x".repeat(900) });
  assert.equal(long.snippet!.length, 400);
});
await ok("the opening: new words only, never the quoted thread or signature", () => {
  const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64url");
  const msg = (parts: L.GmailPart[]): L.GmailMessage => ({ id: "m", threadId: "t", payload: { mimeType: "multipart/alternative", parts } });
  const plain = "Hi the developer,\r\n\r\nLoved the draft! Can we move the banner up? Café fonts look small.\r\n\r\nThanks,\r\nAlex\r\n\r\nOn Fri, Oct 17, 2026 at 3:00 PM the developer <person15@x.com>\r\nwrote:\r\n> old words";
  assert.equal(L.bodyOpening(msg([{ mimeType: "text/plain", body: { data: b64(plain) } }])),
    "Hi the developer, Loved the draft! Can we move the banner up? Café fonts look small. Thanks, Alex");
  const html = "<div>Hello <b>the developer</b>,<br>Paid today &amp; thanks.</div><div class=\"gmail_quote\">On Mon ... wrote: <blockquote>secret old</blockquote></div>";
  assert.equal(L.bodyOpening(msg([{ mimeType: "text/html", body: { data: b64(html) } }])), "Hello the developer, Paid today & thanks.");
  assert.equal(L.bodyOpening(msg([{ mimeType: "text/plain", body: { data: b64("Short.\n-- \nAlex morgan\nCEO") } }])), "Short.");
  assert.equal(L.bodyOpening(msg([{ mimeType: "text/plain", body: { data: b64("x".repeat(2000)) } }])).length, 800);
});
await ok("accounts", () => {
  const a = { email: "Person1@aliasmail.example", client_id: "c", client_secret: "s", refresh_token: "r" };
  assert.deepEqual(L.parseAccounts(JSON.stringify([a, { email: "bad" }])), [{ ...a, email: "person1@aliasmail.example", readonly: true }]);
  assert.equal(L.parseAccounts(JSON.stringify([{ ...a, readonly: false }]))[0].readonly, false, "a reused connector login stays flagged");
  assert.deepEqual(L.parseAccounts("not json"), []);
  assert.deepEqual(L.parseAccounts(null), []);
  const merged = L.mergeAccounts([{ ...a, email: "person1@aliasmail.example" }], [{ ...a, email: "Person1@aliasmail.example", refresh_token: "r2" }, { ...a, email: "person2@aliasmail.example" }]);
  assert.deepEqual(merged.map((x) => [x.email, x.refresh_token]), [["person1@aliasmail.example", "r2"], ["person2@aliasmail.example", "r"]]);
  assert.equal(L.safeEqual("abc", "abc"), true);
  assert.equal(L.safeEqual("abc", "abd"), false);
  assert.equal(L.safeEqual("", ""), false, "an empty secret never authorises");
  assert.equal(L.errText(new Error("bad ya29.a0AfB_secret-token here")), "bad [token] here");
  // A per minute quota refusal is "slow down", not a broken account (first run on a busy inbox, 16 Nov 2026).
  assert.equal(L.isSlowDown(new Error("gmail 403 rateLimitExceeded: Quota exceeded for quota metric 'Total Query Cost'")), true);
  assert.equal(L.isSlowDown(new Error("gmail 403 userRateLimitExceeded: User rate limit exceeded")), true);
  assert.equal(L.isSlowDown(new Error("gmail 429")), true);
  assert.equal(L.isSlowDown(new Error("gmail 403 insufficientPermissions: Request had insufficient authentication scopes.")), false);
  assert.equal(L.isSlowDown(new Error("gmail 403")), false, "a bare 403 is a real problem");
  assert.equal(L.isSlowDown(new Error("token refresh failed: invalid_grant")), false);
});

// ---------- end to end crypto: what the function seals, the browser opens ----------
await ok("seal from the function, open in the vault", async () => {
  const kp = await C.newInboxKeypair();
  const priv = await C.importInboxPrivate(kp.privatePkcs8);
  const payload = L.inboundPayload("owner1@aliasmail.example", {
    id: "m1", threadId: "t1", internalDate: "1792016820000", snippet: "Hello",
    payload: { headers: [{ name: "From", value: "Alex morgan <pmorgan@client5.example>" }, { name: "Subject", value: "Re: draft" }] },
  });
  const sealed = await L.seal(kp.publicKey, payload);
  assert.ok(!sealed.includes("Alex") && !sealed.includes("sampleorganics"), "no plaintext in the sealed blob");
  const opened = await C.openSealed<M.GmailInbound>(priv, sealed);
  assert.deepEqual(opened, payload);
  assert.equal(match(M.parseAddress(opened.from).email), "tp");
  const other = await C.newInboxKeypair();
  await assert.rejects(C.openSealed(await C.importInboxPrivate(other.privatePkcs8), sealed), "another key cannot open it");
});

// ---------- send-as address: the email's own alias, kept for the reply ----------
const hd = (...h: [string, string][]): L.GmailMessage => ({ id: "m", threadId: "t", payload: { headers: h.map(([name, value]) => ({ name, value })) } });
await ok("verifiedAliases: only accepted, not the account itself, not primary, lower case", () => {
  const list = { sendAs: [
    { sendAsEmail: "Owner@Example.com", isPrimary: true, verificationStatus: "accepted" },
    { sendAsEmail: "Work@Example.com", verificationStatus: "accepted" },
    { sendAsEmail: "later@example.com", verificationStatus: "pending" },
    { sendAsEmail: "owner@example.com", verificationStatus: "accepted" },
    { sendAsEmail: "not an email", verificationStatus: "accepted" },
  ] };
  assert.deepEqual(L.verifiedAliases("owner@example.com", list), ["work@example.com"]);
  assert.deepEqual(L.verifiedAliases("owner@example.com", {}), []);
  assert.deepEqual(L.verifiedAliases("owner@example.com", null), []);
});
await ok("replyFromOf: Delivered-To first, then To, then Cc, case insensitive", () => {
  const al = ["work@example.com", "shop@example.com"];
  assert.equal(L.replyFromOf("owner@example.com", al, hd(["Delivered-To", "owner@example.com"], ["Delivered-To", "Work@Example.com"], ["To", "shop@example.com"])), "work@example.com");
  assert.equal(L.replyFromOf("owner@example.com", al, hd(["Delivered-To", "owner@example.com"], ["To", "Jane <jane@northwind.example>, SHOP@example.com"])), "shop@example.com");
  assert.equal(L.replyFromOf("owner@example.com", al, hd(["To", "list@northwind.example"], ["Cc", "Work@example.com"])), "work@example.com");
});
await ok("replyFromOf: nothing for the account's own mail, no aliases, no match, or an address inside another one", () => {
  const al = ["work@example.com"];
  assert.equal(L.replyFromOf("owner@example.com", al, hd(["To", "owner@example.com"])), null);
  assert.equal(L.replyFromOf("owner@example.com", al, hd(["To", "owner@example.com, work@example.com"])), null, "addressed to the account too: stay on the account");
  assert.equal(L.replyFromOf("owner@example.com", [], hd(["To", "work@example.com"])), null);
  assert.equal(L.replyFromOf("owner@example.com", al, hd(["To", "xwork@example.com"])), null, "a longer address is not the alias");
  assert.equal(L.replyFromOf("owner@example.com", al, hd(["Subject", "work@example.com"])), null, "only the address headers count");
});
await ok("the sealed payload carries replyFrom only for an alias; old payloads and the browser side still work", () => {
  const m = hd(["From", "Jane <jane@northwind.example>"], ["To", "work@example.com"], ["Subject", "Hi"]);
  assert.equal((L.inboundPayload("owner@example.com", m, ["work@example.com"]) as { replyFrom?: string }).replyFrom, "work@example.com");
  assert.equal("replyFrom" in L.inboundPayload("owner@example.com", m), false, "no aliases known: no field");
  assert.equal("replyFrom" in L.inboundPayload("owner@example.com", hd(["To", "owner@example.com"]), ["work@example.com"]), false);
  const r = M.applyInbound(undefined, msg("m1", "2026-10-14T22:27:00.000Z", { replyFrom: "Work@Example.com" }), "tp")!;
  assert.equal(r.replyFrom, "work@example.com");
  assert.equal(M.applyInbound(undefined, msg("m2", "2026-10-14T22:27:00.000Z"), "tp")!.replyFrom, null, "an old payload: From the account");
  assert.equal(M.cleanReplyFrom("Bcc: x@y.example", "a@b.example"), null);
  assert.equal(M.cleanReplyFrom("a@b.example", "A@B.example"), null, "the account itself is no alias");
});

console.log(`mail tests: ${n} passed`);
