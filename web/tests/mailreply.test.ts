// Run: node --experimental-strip-types tests/mailreply.test.ts
// Reply from PS (src/core/mailreply.ts, V1.44) with FICTIONAL people and mail: placeholders, the subject, the bodies,
// the email a card is for (Gmail and Instantly), the job handed to the Mac, the schedule times and wheel, saved
// responses and signatures, and a FAKE Mac that plays the queue (Send with Undo, Schedule, Edit, Cancel). Nothing here
// can send: there is no network and no Mac. The Mac's own half (threading headers, the queue, fake Gmail and
// Instantly clients) is ps-mac tests/mailsend-test.swift.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const M = await import("../src/core/mailreply.ts");
const S = await import("../src/core/settingsindex.ts");
const C = await import("../src/core/cardsync.ts");

let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const now = new Date(2026, 10, 8, 4, 12, 0).getTime();   // 8 Nov 2026 04:12 on this machine's clock
const fill = { first: "Jane", name: "Jane Doe", company: "Northwind", email: "jane@northwind.example" };

// ---------- placeholders ----------
ok("The developer's example: {first name} fills in, the rest stays word for word", () => {
  const t = "Hi {first name},\n\nPerfect, I'm on it, I'll get back to you shortly.\n\nThanks,\nRed";
  assert.equal(M.fillPlaceholders(t, fill), "Hi Jane,\n\nPerfect, I'm on it, I'll get back to you shortly.\n\nThanks,\nRed");
});
ok("any case and spacing: {First Name}, {firstname}, { first name }, {name}, {company}, {email}", () => {
  assert.equal(M.fillPlaceholders("{First Name} {firstname} { first name } {name} {company} {email}", fill), "Jane Jane Jane Jane Doe Northwind jane@northwind.example");
});
ok("no first name: 'there'; no company: no gap left before the full stop", () => {
  const f = { first: "", name: "", company: "", email: "x@y.example" };
  assert.equal(M.fillPlaceholders("Hi {first name},", f), "Hi there,");
  assert.equal(M.fillPlaceholders("Great to hear from {company}.", f), "Great to hear from.");
  assert.equal(M.fillPlaceholders("Thanks {company} team", f), "Thanks team");
});
ok("unknown braces stay as typed, and typed text with odd spacing is left alone", () => {
  assert.equal(M.fillPlaceholders("Price {in USD} is 5 !", fill), "Price {in USD} is 5 !");
});

// ---------- subject and bodies ----------
ok("Re: once", () => {
  assert.equal(M.reSubject("Homepage draft"), "Re: Homepage draft");
  assert.equal(M.reSubject("Re: Homepage draft"), "Re: Homepage draft");
  assert.equal(M.reSubject("RE:Homepage"), "RE:Homepage");
  assert.equal(M.reSubject("Aw: Angebot"), "Aw: Angebot");
  assert.equal(M.reSubject(""), "Re:");
  assert.equal(M.reSubject("Hi\r\nBcc: evil@x.example"), "Re: Hi Bcc: evil@x.example", "never two lines (no header injection)");
});
const quote = { at: new Date(now - 3600_000).toISOString(), who: "Jane Doe <jane@northwind.example>", text: "Loved the draft.\nCan we move the reviews up?" };
ok("text body: the reply, the signature under it, then their email quoted with >", () => {
  const { text } = M.buildBodies("Hi Jane,\n\nOn it.  \n", "Sam\nExample Studio", quote);
  assert.match(text, /^Hi Jane,\n\nOn it\.\n\nSam\nExample Studio\n\nOn .+, Jane Doe <jane@northwind\.example> wrote:\n> Loved the draft\.\n> Can we move the reviews up\?\n$/);
});
ok("html body: the same words, escaped, line breaks, the signature and a Gmail style quote", () => {
  const { html } = M.buildBodies("Hi <Jane> & co\nline 2", "Sam", quote);
  assert.match(html, /Hi &lt;Jane&gt; &amp; co<br>line 2/);
  assert.match(html, /class="gmail_signature">Sam</);
  assert.match(html, /<blockquote class="gmail_quote"[^>]*>Loved the draft\.<br>Can we move the reviews up\?<\/blockquote>/);
  assert.equal(/<script/i.test(M.buildBodies("<script>x</script>", "", null).html), false);
});
ok("no quote when it is switched off, no signature block when there is none", () => {
  const b = M.buildBodies("Hi", "", null);
  assert.equal(b.text, "Hi\n");
  assert.equal(b.html.includes("gmail_quote"), false);
  assert.equal(b.html.includes("gmail_signature"), false);
});

// ---------- the email a card is for ----------
const rep = { clientId: "c1", account: "Studio@example.com", threadId: "t123", msgIds: ["a"], from: "jane@northwind.example", fromName: "Jane Doe",
  subject: "Homepage draft", snippet: "Loved it", opening: "Loved the draft.", date: new Date(now - 600_000).toISOString(), count: 1, handled: false };
const client = { name: "Northwind", email: "jane@northwind.example", contactName: "Jane Doe" } as never;
ok("Gmail card: From is the account it came to, To the sender, the thread, the client as {company}", () => {
  const c = M.ctxFromGmail("m:r1", rep, client)!;
  assert.equal(c.via, "gmail"); assert.equal(c.account, "studio@example.com"); assert.equal(c.to, "jane@northwind.example");
  assert.equal(c.first, "Jane"); assert.equal(c.name, "Jane Doe"); assert.equal(c.company, "Northwind"); assert.equal(c.threadId, "t123");
  assert.deepEqual(c.clientIds, ["c1"], "the reply record's own client");
  assert.equal(c.quote.text, "Loved the draft.");
});
ok("Gmail card with no client: the company comes from the sender's own domain, never a free mail domain", () => {
  assert.equal(M.ctxFromGmail("m:r2", rep, undefined)!.company, "Northwind");
  assert.equal(M.ctxFromGmail("m:r3", { ...rep, from: "person9@mail.example" }, undefined)!.company, "");
});
ok("a card PS cannot answer gives nothing (no thread, no sender address)", () => {
  assert.equal(M.ctxFromGmail("m:x", { ...rep, threadId: "" }, client), null);
  assert.equal(M.ctxFromGmail("m:x", { ...rep, from: "nobody" }, client), null);
});
ok("Instantly card: From is the inbox the lead wrote to, reply_to_uuid is the email answered", () => {
  const c = M.ctxFromLead("n:e9", { id: "e9", threadId: "th", from: "lena@acme-co.example", fromName: "Lena Park", account: "The developer@Outreach.example", at: rep.date, subject: "Re: quick idea", opening: "Sounds good" })!;
  assert.equal(c.via, "instantly"); assert.equal(c.account, "red@outreach.example"); assert.equal(c.emailId, "e9"); assert.equal(c.first, "Lena"); assert.equal(c.company, "Acme-co");
  assert.equal(M.ctxFromLead("n:x", { id: "x", from: "lena@acme.example" }), null, "no sending inbox: nothing");
});

// ---------- the job ----------
const ctx = M.ctxFromGmail("m:r1", rep, client)!;
ok("the job: checked fields, Re: subject, both bodies, the draft kept for Edit", () => {
  const j = M.makeJob(ctx, { message: "Hi Jane", sig: "Sam", quote: true }, now + 10_000, now, "job1");
  assert.equal(j.subject, "Re: Homepage draft"); assert.equal(j.account, "studio@example.com"); assert.equal(j.threadId, "t123");
  assert.equal(j.sendAt, now + 10_000); assert.match(j.text, /^Hi Jane\n\nSam\n\nOn /); assert.equal(j.draft.message, "Hi Jane");
});
ok("the job refuses: nothing typed, a bad To, no thread", () => {
  assert.throws(() => M.makeJob(ctx, { message: "  ", sig: "", quote: false }, now, now, "j"), /Type a reply/);
  assert.throws(() => M.makeJob(ctx, { message: "x", sig: "", quote: false, to: "not-an-email" }, now, now, "j"), /To address/);
  assert.throws(() => M.makeJob({ ...ctx, threadId: null }, { message: "x", sig: "", quote: false }, now, now, "j"), /Gmail thread/);
  assert.throws(() => M.makeJob({ ...ctx, via: "instantly", emailId: null }, { message: "x", sig: "", quote: false }, now, now, "j"), /Instantly email/);
});
ok("a time in the past means now", () => { assert.equal(M.makeJob(ctx, { message: "x", sig: "", quote: false }, now - 5000, now, "j").sendAt, now); });

// ---------- send-as address in the job ----------
ok("an email addressed to a send-as address: the card, the screen's context and the job carry it", () => {
  const c = M.ctxFromGmail("m:a1", { ...rep, replyFrom: "Work@Example.com" } as never, client)!;
  assert.equal(c.replyFrom, "work@example.com"); assert.equal(c.account, "studio@example.com");
  const j = M.makeJob(c, { message: "Hi Jane", sig: "", quote: false }, now, now, "ja");
  assert.equal(j.replyFrom, "work@example.com"); assert.equal(j.account, "studio@example.com", "the account still signs in and sends");
  assert.equal(j.draft.ctx.replyFrom, "work@example.com", "Edit opens it again with the same From");
});
ok("no send-as address (old record, the account itself, junk, Instantly): no field in the job", () => {
  for (const rf of [undefined, null, "studio@example.com", "x y", "a@b.example\nBcc: z@y.example"]) {
    const j = M.makeJob(M.ctxFromGmail("m:a2", { ...rep, replyFrom: rf } as never, client)!, { message: "Hi", sig: "", quote: false }, now, now, "jb");
    assert.equal("replyFrom" in j, false, String(rf));
  }
  const lead = M.ctxFromLead("n:e9", { id: "e9", from: "lena@acme-co.example", account: "ann@outreach.example" })!;
  assert.equal("replyFrom" in M.makeJob({ ...lead, replyFrom: "work@example.com" }, { message: "Hi", sig: "", quote: false }, now, now, "jc"), false);
});

// ---------- schedule ----------
ok("quick choices 3, 5, 10, 15, 30 minutes; the wheel starts at 5", () => {
  assert.deepEqual([...M.QUICK], [3, 5, 10, 15, 30]);
  assert.equal(M.SCHED.start, 5);
});
ok("the wheel: one notch is a minute, so 5 becomes 6 or 7; Shift moves 5 and snaps", () => {
  assert.equal(M.stepMins(5, 1), 6); assert.equal(M.stepMins(M.stepMins(5, 1), 1), 7); assert.equal(M.stepMins(5, -1), 4);
  assert.equal(M.stepMins(1, -1), 1, "never under a minute");
  assert.equal(M.stepMins(7, 1, true), 10); assert.equal(M.stepMins(7, -1, true), 5); assert.equal(M.stepMins(10, 1, true), 15); assert.equal(M.stepMins(5, -1, true), 1);
  assert.equal(M.stepMins(M.SCHED.max, 1), M.SCHED.max, "never past 7 days");
});
ok("Sends at 04:17 (and tomorrow, and a date further out)", () => {
  assert.equal(M.sendsAtText(now + 5 * 60_000, now), "Sends at 04:17");
  assert.equal(M.sendsAtText(now + 24 * 3600_000, now), "Sends at 04:12 tomorrow");
  assert.match(M.sendsAtText(now + 3 * 24 * 3600_000, now), /^Sends at 04:12 on \w{3} 11 Nov$/);
  assert.equal(M.inText(7), "in 7 min"); assert.equal(M.inText(65), "in 1 h 05 min"); assert.equal(M.inText(120), "in 2 h");
});
ok("typed times: minutes, hours, or a clock time (the next time the clock shows it)", () => {
  assert.equal(M.parseWhen("7", now), 7); assert.equal(M.parseWhen("7 min", now), 7); assert.equal(M.parseWhen("1h 30", now), 90); assert.equal(M.parseWhen("2 hours", now), 120);
  assert.equal(M.parseWhen("04:17", now), 5); assert.equal(M.parseWhen("4.42", now), 30);
  assert.equal(M.parseWhen("04:00", now), 24 * 60 - 12, "a time already gone today means tomorrow");
  for (const bad of ["", "soon", "25:00", "0", "99999"]) assert.equal(M.parseWhen(bad, now), null, bad);
});
ok("the queue's words: Sending in 8 s, Sends at 04:17, Sending now, Sent, Not sent: why", () => {
  const r = { id: "a", cardId: "m:r1", via: "gmail" as const, account: "a@b.example", to: "c@d.example", toName: null, subject: "Re: x", sendAt: now + 8000, state: "queued" as const };
  assert.equal(M.rowText({ ...r, undo: true }, now), "Sending in 8 s");
  assert.equal(M.rowText({ ...r, sendAt: now + 5 * 60_000 }, now), "Sends at 04:17 (in 5 min)");
  assert.equal(M.rowText({ ...r, state: "sending" }, now), "Sending now");
  assert.equal(M.rowText({ ...r, state: "sent" }, now), "Sent");
  assert.equal(M.rowText({ ...r, state: "failed", error: "Gmail refused this email." }, now), "Not sent: Gmail refused this email.");
  assert.deepEqual(M.queueOrder([{ ...r, id: "f", state: "failed" }, { ...r, id: "late", sendAt: now + 9e6 }, { ...r, id: "soon" }, { ...r, id: "s", state: "sending" }]).map((x) => x.id), ["s", "soon", "late", "f"]);
});

// ---------- saved responses and signatures ----------
ok("starters show until the developer changes one; the developer's has his name, everyone else's does not", () => {
  assert.match(M.responsesOf(undefined, "Sam")[0].text, /Thanks,\nSam$/);
  assert.match(M.responsesOf(undefined, "")[0].text, /Thanks$/);
});
ok("create, edit, delete, reorder (any id the list did not name keeps its place at the end)", () => {
  let p = M.applyMailReplyOp(undefined, { op: "addResp", id: "r2", name: "Call", text: "Hi {first name}, call tomorrow?" }, "Sam", now);
  assert.deepEqual(p.responses!.map((r) => r.id), ["starter-on-it", "r2"]);
  p = M.applyMailReplyOp(p, { op: "editResp", id: "r2", text: "Hi {first name}, a call on Tuesday?" }, "Sam", now);
  assert.equal(p.responses![1].text, "Hi {first name}, a call on Tuesday?");
  p = M.applyMailReplyOp(p, { op: "addResp", id: "r3", name: "", text: "Hi {first name}, thanks for the files" }, "Sam", now);
  assert.equal(p.responses![2].name, "thanks for the files", "no name: its first words");
  p = M.applyMailReplyOp(p, { op: "orderResp", ids: ["r3", "starter-on-it"] }, "Sam", now);
  assert.deepEqual(p.responses!.map((r) => r.id), ["r3", "starter-on-it", "r2"]);
  p = M.applyMailReplyOp(p, { op: "delResp", id: "starter-on-it" }, "Sam", now);
  assert.deepEqual(p.responses!.map((r) => r.id), ["r3", "r2"]);
  assert.equal(p.at, new Date(now).toISOString());
});
ok("signatures: one for every account, an account's own wins, clearing goes back", () => {
  let p = M.applyMailReplyOp(undefined, { op: "sig", account: null, text: "Sam\nStudio" }, "", now);
  p = M.applyMailReplyOp(p, { op: "sig", account: "studio@example.com", text: "Sam (studio)" }, "", now);
  assert.equal(M.sigFor(p, "Studio@example.com"), "Sam (studio)");
  assert.equal(M.sigFor(p, "other@example.com"), "Sam\nStudio");
  p = M.applyMailReplyOp(p, { op: "sigClear", account: "studio@example.com" }, "", now);
  assert.equal(M.sigFor(p, "studio@example.com"), "Sam\nStudio");
  assert.equal(M.sigFor(p, "studio@example.com") === M.sigFor({ ...p, sigs: { "studio@example.com": "" } }, "studio@example.com"), false, "an empty own signature is kept as none");
});
ok("ops from another page are checked field by field", () => {
  assert.equal(M.cleanMailReplyOp({ op: "addResp", id: "bad id!", name: "x", text: "y" }), null);
  assert.equal(M.cleanMailReplyOp({ op: "sig", account: "not an email", text: "x" }), null);
  assert.equal(M.cleanMailReplyOp({ op: "orderResp", ids: Array.from({ length: 41 }, (_, i) => `r${i}`) }), null);
  assert.equal(M.cleanMailReplyOp({ op: "nuke" }), null);
  assert.deepEqual(M.cleanMailReplyOp({ op: "sig", account: "A@B.example", text: "x".repeat(5000) }), { op: "sig", account: "a@b.example", text: "x".repeat(M.LIMITS.sig) });
});
ok("two devices: the newer change wins, and the settings merger keeps it", () => {
  const a = { sig: "old", at: "2026-11-08T01:00:00.000Z" }, b = { sig: "new", at: "2026-11-08T02:00:00.000Z" };
  assert.equal(M.mergeMailReply(a, b)!.sig, "new");
  assert.equal(M.mergeMailReply(b, a)!.sig, "new");
  assert.equal(C.mergeSettings({ mailReply: a } as never, { mailReply: b } as never).mailReply!.sig, "new");
});

// ---------- a FAKE Mac: what the compose window and the queue do with a job ----------
// Plays ps-mac MailSend.swift's queue rules from the page's side: Send waits UNDO_SECONDS with Undo, Schedule waits
// until its time, Edit and Undo take it back with its draft, Cancel drops it. It records "sends"; nothing leaves.
class FakeMac {
  jobs = new Map<string, { job: ReturnType<typeof M.makeJob>; state: "queued" | "sent" | "cancelled" }>();
  sent: string[] = [];
  queue(job: ReturnType<typeof M.makeJob>) { this.jobs.set(job.id, { job, state: "queued" }); }
  takeBack(id: string) { const j = this.jobs.get(id); if (!j || j.state !== "queued") return null; j.state = "cancelled"; return j.job; }
  run(at: number) { for (const [id, j] of this.jobs) if (j.state === "queued" && j.job.sendAt <= at) { j.state = "sent"; this.sent.push(id); } }
}
ok("Send: nothing goes for 10 seconds, Undo inside them brings the reply back as typed", () => {
  const mac = new FakeMac();
  const j = M.makeJob(ctx, { message: "Hi {first name}", sig: "Sam", quote: true }, now + M.UNDO_SECONDS * 1000, now, "s1");
  mac.queue(j);
  mac.run(now + 9_000);
  assert.deepEqual(mac.sent, []);
  const back = mac.takeBack("s1")!;
  assert.equal(back.draft.message, "Hi {first name}");
  mac.run(now + 60_000);
  assert.deepEqual(mac.sent, [], "undone: never sent");
});
ok("Send without Undo goes after the 10 seconds, once", () => {
  const mac = new FakeMac();
  mac.queue(M.makeJob(ctx, { message: "x", sig: "", quote: false }, now + M.UNDO_SECONDS * 1000, now, "s2"));
  mac.run(now + 10_000); mac.run(now + 20_000);
  assert.deepEqual(mac.sent, ["s2"]);
  assert.equal(mac.takeBack("s2"), null, "too late to undo");
});
ok("Schedule in 5, wheel to 7: goes at 7 minutes, not before; Edit takes it back and a new time replaces it", () => {
  const mac = new FakeMac();
  const mins = M.stepMins(M.stepMins(5, 1), 1);
  mac.queue(M.makeJob(ctx, { message: "x", sig: "", quote: false }, now + mins * 60_000, now, "s3"));
  mac.run(now + 6 * 60_000);
  assert.deepEqual(mac.sent, []);
  const back = mac.takeBack("s3")!;
  mac.queue(M.makeJob(back.draft.ctx, { message: back.draft.message + " (edited)", sig: back.draft.sig, quote: back.draft.quote }, now + 10 * 60_000, now, back.id));
  mac.run(now + 7 * 60_000);
  assert.deepEqual(mac.sent, []);
  mac.run(now + 10 * 60_000);
  assert.deepEqual(mac.sent, ["s3"]);
});

// ---------- send behaviour: now, or a random time in a range ----------
ok("random delay: always inside the range, to the second", () => {
  const m = { random: true, min: 2, max: 15 };
  assert.equal(M.randomDelayMs(m, () => 0), 2 * 60_000);
  assert.ok(M.randomDelayMs(m, () => 0.9999999) <= 15 * 60_000 && M.randomDelayMs(m, () => 0.9999999) > 14.9 * 60_000);
  assert.equal(M.randomDelayMs(m, () => 0.5), 8.5 * 60_000);
  for (let i = 0; i < 2000; i++) { const d = M.randomDelayMs(m); assert.ok(d >= 120_000 && d <= 900_000 && d % 1000 === 0, String(d)); }
});
ok("random delay: min equal to max gives exactly that", () => {
  assert.equal(M.randomDelayMs({ random: true, min: 7, max: 7 }, () => 0.42), 7 * 60_000);
});
ok("send behaviour: bad input is refused or put right (numbers only, 1 to 240, min never above max)", () => {
  assert.equal(M.cleanSendMode(null), null); assert.equal(M.cleanSendMode({ min: "2", max: 15 }), null); assert.equal(M.cleanSendMode({ min: NaN, max: 15 }), null);
  assert.deepEqual(M.cleanSendMode({ random: true, min: 20, max: 5 }), { random: true, min: 5, max: 20 }, "typed the other way round: swapped");
  assert.deepEqual(M.cleanSendMode({ random: 1, min: -4, max: 9999 }), { random: false, min: 1, max: 240 });
  assert.deepEqual(M.sendModeOf(undefined), { random: false, min: 2, max: 15 }, "default: Send now, range 2 to 15");
  assert.equal(M.randomDelayMs({ random: true, min: 0, max: -3 }, () => 0.5), 60_000, "a range below a minute is put right to 1 minute, never sent at once");
  assert.equal(M.randomDelayMs({ random: true, min: "x", max: 3 } as never, () => 0), 2 * 60_000, "not numbers: the default range 2 to 15");
});
ok("send behaviour: the wheel moves one end a minute and pushes the other along", () => {
  const m = { random: true, min: 2, max: 15 };
  assert.deepEqual(M.stepRange(m, "min", 1), { random: true, min: 3, max: 15 });
  assert.deepEqual(M.stepRange({ ...m, min: 15 }, "min", 1), { random: true, min: 16, max: 16 });
  assert.deepEqual(M.stepRange({ ...m, max: 2 }, "max", -1), { random: true, min: 1, max: 1 });
  assert.deepEqual(M.stepRange({ ...m, min: 1 }, "min", -1).min, 1);
  assert.equal(M.stepRange({ ...m, max: 240 }, "max", 1).max, 240);
});
ok("send behaviour: remembered in settings, checked when it crosses pages", () => {
  const o = M.cleanMailReplyOp({ op: "send", mode: { random: true, min: 3, max: 9 } })!;
  assert.deepEqual(o, { op: "send", mode: { random: true, min: 3, max: 9 } });
  assert.deepEqual(M.applyMailReplyOp(undefined, o, "", now).send, { random: true, min: 3, max: 9 });
  assert.equal(M.cleanMailReplyOp({ op: "send", mode: { min: "x" } }), null);
});
ok("the random time is picked once, at Send: the job carries a fixed time and nothing picks again", () => {
  const delay = M.randomDelayMs({ random: true, min: 2, max: 15 }, () => 0.5);
  const j = M.makeJob(ctx, { message: "x", sig: "", quote: false }, now + delay, now, "rnd1");
  assert.equal(j.sendAt, now + 8.5 * 60_000);
  const mac = new FakeMac();
  mac.queue(j);
  mac.run(now + 8 * 60_000);           // the Mac wakes early: nothing goes, and the time stays as it was
  assert.equal(mac.jobs.get("rnd1")!.job.sendAt, now + 8.5 * 60_000);
  assert.deepEqual(mac.sent, []);
  mac.run(now + 60 * 60_000);          // wakes late: it goes once, at the time it had
  assert.deepEqual(mac.sent, ["rnd1"]);
  const w = readFileSync(new URL("../src/views/ReplyWindow.tsx", import.meta.url), "utf8");
  assert.equal((w.match(/randomDelayMs\(/g) || []).length, 1, "picked in one place only: the Send click");
});

// ---------- quick replies per client ----------
const clients = [
  { id: "north", name: "Northwind", email: "jane@northwind.example" },
  { id: "north2", name: "Northwind Retail", email: "ops@northwind.example" },
  { id: "acme", name: "Acme", email: "person7@aliasmail.example", matchAddrs: ["sam.work@acme.example", "@acme-group.example"] },
  { id: "solo", name: "Solo", email: "person5@aliasmail.example" },
];
ok("the sender's clients: their exact address first", () => {
  assert.deepEqual(M.clientsForSender("Jane@Northwind.example", clients), ["north"]);
  assert.deepEqual(M.clientsForSender("sam.work@acme.example", clients), ["acme"], "a 'replies come from' address");
  assert.deepEqual(M.clientsForSender("person5@aliasmail.example", clients), ["solo"]);
});
ok("the sender's clients: a domain in a match list (subdomains too), then the company domain of a client's email", () => {
  assert.deepEqual(M.clientsForSender("anyone@mail.acme-group.example", clients), ["acme"]);
  assert.deepEqual(M.clientsForSender("new.person@northwind.example", clients), ["north", "north2"], "two clients at one company: both");
});
ok("the sender's clients: an unknown sender or a free mail domain matches no one", () => {
  assert.deepEqual(M.clientsForSender("someone@else.example", clients), []);
  assert.deepEqual(M.clientsForSender("person8@aliasmail.example", clients), [], "a client on a free mail domain never claims the whole domain");
  assert.deepEqual(M.clientsForSender("not an email", clients), []);
});
const qr = [
  { id: "g1", name: "On it", text: "x" },
  { id: "n1", name: "Northwind homepage", text: "x", clients: ["north"] },
  { id: "a1", name: "Acme invoice", text: "x", clients: ["acme"] },
  { id: "g2", name: "Call", text: "x", clients: [] },
  { id: "both", name: "Shared", text: "x", clients: ["north", "acme"] },
];
const names = { north: "Northwind", acme: "Acme" };
ok("quick replies: this client's own first, named, then General underneath", () => {
  const g = M.responsesFor(qr, ["north"], names);
  assert.deepEqual(g.map((x) => [x.label, x.items.map((r) => r.id)]), [["Northwind", ["n1", "both"]], ["General", ["g1", "g2"]]]);
});
ok("quick replies: several clients each get their group; Show general replies off hides General", () => {
  assert.deepEqual(M.responsesFor(qr, ["north", "acme"], names).map((x) => x.label), ["Northwind", "Acme", "General"]);
  assert.deepEqual(M.responsesFor(qr, ["north"], names, false).map((x) => x.label), ["Northwind"]);
});
ok("quick replies: an unknown sender sees only General, never another client's", () => {
  const g = M.responsesFor(qr, [], names);
  assert.deepEqual(g.map((x) => [x.label, x.items.map((r) => r.id)]), [["General", ["g1", "g2"]]]);
});
ok("quick replies: ticks change when edited; no ticks means General again", () => {
  let p = M.applyMailReplyOp({ responses: qr }, M.cleanMailReplyOp({ op: "editResp", id: "g1", clients: ["acme"] })!, "", now);
  assert.deepEqual(p.responses!.find((r) => r.id === "g1")!.clients, ["acme"]);
  p = M.applyMailReplyOp(p, M.cleanMailReplyOp({ op: "editResp", id: "g1", clients: [] })!, "", now);
  assert.equal(p.responses!.find((r) => r.id === "g1")!.clients, undefined);
  assert.equal(M.isGeneral(p.responses!.find((r) => r.id === "g1")!), true);
  const add = M.cleanMailReplyOp({ op: "addResp", id: "x1", name: "Hi", text: "Hi", clients: ["north", "north"] })!;
  assert.deepEqual((add as { clients?: string[] }).clients, ["north"]);
  assert.equal(M.cleanMailReplyOp({ op: "addResp", id: "x2", name: "Hi", text: "Hi", clients: ["bad id!"] }), null);
});

// ---------- who sees it ----------
ok("Settings: Reply from PS only for people whose PS shows client email cards, on a Mac", () => {
  const e = S.settingById("reply-from-ps")!;
  assert.ok(e);
  assert.equal(S.visibleTo(e, { red: false, where: "mac", mail: true }), true);
  assert.equal(S.visibleTo(e, { red: false, where: "mac", mail: false }), false, "a friend with no client email cards sees nothing new");
  assert.equal(S.visibleTo(e, { red: true, where: "web", mail: true }), false);
  assert.ok(S.searchSettings("signature", { red: false, where: "mac", mail: true }).some((h) => h.e.id === "reply-from-ps"));
});

// ---------- the pieces fit ----------
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
ok("the Mac's cards get a Reply button, the phone and the website do not", () => {
  const m = src("mailcards.ts");
  assert.match(m, /const REPLY = import\.meta\.env\.MODE === "ps" \? \{ reply: true \} : \{\};/);
  assert.equal((m.match(/\.\.\.REPLY/g) || []).length, 3, "client email cards, lead cards and WhatsApp cards");
});
ok("the main page never sends: it only hands the email to the Mac, saves prefs, and dismisses a card the Mac sent", () => {
  const e = src("replyengine.ts");
  assert.match(e, /type: "reply:open", ctx, prefs/);
  assert.equal(/fetch\(|XMLHttpRequest|gmail\.googleapis|api\.instantly\.ai/.test(e + src("views/ReplyWindow.tsx") + src("core/mailreply.ts")), false, "no network from the web side");
});
ok("the compose window: Esc, Cmd+Enter, Cmd+E, Cmd+1 to 9, hover words on every button", () => {
  const w = src("views/ReplyWindow.tsx");
  assert.match(w, /e\.key === "Escape"/); assert.match(w, /Throw away this reply\?/);
  assert.match(w, /cmd && e\.key === "Enter"/); assert.match(w, /\^\[1-9\]\$/);
  for (const label of ['"rw-k">From<', '"rw-k">To<', '"rw-k">Subject<', '>Message<', '>Signature<', '>Quick replies<', '>Send now<', '>Random<', '>Send<']) assert.ok(w.includes(label), label);
  const buttons = w.match(/<button\b(?:=>|>=|[^>])*>/g) || [];
  assert.ok(buttons.length > 20);
  const bare = buttons.filter((b) => !/data-tip=|aria-label=/.test(b));
  assert.deepEqual(bare, [], "every button has hover words (data-tip) or a name");
});
ok("no em or en dashes in the new code and words", () => {
  for (const f of ["core/mailreply.ts", "replyengine.ts", "views/ReplyWindow.tsx", "views/reply.css", "dev/reply-fake.ts"]) assert.equal(/[\u2013\u2014]/.test(src(f)), false, f);
});

console.log(`\n${n} passed`);
