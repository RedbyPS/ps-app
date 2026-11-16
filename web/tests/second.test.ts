// Run: node --experimental-strip-types tests/second.test.ts
// PS Second Computer (src/core/second.ts): the pairing code, signed messages, which jobs the M1 accepts and
// which it refuses, file limits and safe names, secret paths in code bundles, online status, housekeeping.
// FICTIONAL keys and data only. Writes the shared test vector for the native side when SAS_VECTOR=<path>.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
const S = await import("../src/core/second.ts");

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok -", name); };
const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const H = 3600_000, M = 60_000;
const sha = (c: string) => c.repeat(40).slice(0, 40);
const uuid = (c: string) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`;

const m4 = await S.makeKeys(), m1 = await S.makeKeys(), evil = await S.makeKeys();
const M4 = "m4-device", M1 = "m1-device";
const trustedOnM1: import("../src/core/second.ts").Peer[] = [{ device: M4, pub: m4.pub, role: "primary" }];
const trustedOnM4: import("../src/core/second.ts").Peer[] = [{ device: M1, pub: m1.pub, role: "secondary" }];

const bundles = [
  { project: "ps-mac", file: uuid("a"), head: sha("1") },
  { project: "web", file: uuid("b"), head: sha("2") },
];
const job = (over: Partial<import("../src/core/second.ts").JobBody> = {}) => ({
  v: 1 as const, t: "job" as const, id: uuid("c"), from: M4, to: M1, at: T0, exp: T0 + 24 * H,
  type: "selftest" as const, args: { mac: sha("1"), web: sha("2") } as Record<string, unknown>, bundles, ...over,
});
const accept = (env: unknown, o: Partial<{ now: number; seen: Set<string>; myRole: "primary" | "secondary" | "none"; trusted: typeof trustedOnM1 }> = {}) =>
  S.acceptJob(env, { trusted: trustedOnM1, me: M1, now: T0 + M, myRole: "secondary", ...o });
const refused = async (env: unknown, reason: string, o = {}) => {
  const r = await accept(env, o);
  assert.equal(r.ok, false, "should be refused: " + reason);
  if (!r.ok) assert.equal(r.reason, reason);
};

// ---------- pairing ----------
await ok("pairing code: six digits shown as 123 456, the same on both Macs", async () => {
  const a = await S.pairCode(m4.pub, m1.pub), b = await S.pairCode(m4.pub, m1.pub);
  assert.match(a, /^\d{3} \d{3}$/);
  assert.equal(a, b);
});
await ok("pairing code: a swapped key (someone in the middle) gives a different code", async () => {
  const real = await S.pairCode(m4.pub, m1.pub);
  assert.notEqual(await S.pairCode(evil.pub, m1.pub), real);
  assert.notEqual(await S.pairCode(m4.pub, evil.pub), real);
  assert.notEqual(await S.pairCode(m1.pub, m4.pub), real, "order matters: primary first");
});
await ok("pairing code: fixed test vector (the Swift side checks the same numbers)", async () => {
  const p = "BPrimaryKeyForTheTestVectorOnly", s = "BSecondaryKeyForTheTestVectorOnly";
  const code = await S.pairCode(p, s);
  assert.equal(code, await S.pairCode(p, s));
  assert.match(code, /^\d{3} \d{3}$/);
});

// ---------- signatures ----------
await ok("a job signed by the paired primary is accepted", async () => {
  const r = await accept(await S.signBody(m4.priv, M4, job()));
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  if (r.ok) assert.equal(r.body.type, "selftest");
});
await ok("a job signed by an unknown key is refused", async () => {
  await refused(await S.signBody(evil.priv, "evil-device", { ...job(), from: "evil-device" }), "Not signed by a paired Mac");
});
await ok("a forged job that claims to be from the primary but is signed with another key is refused", async () => {
  await refused(await S.signBody(evil.priv, M4, job()), "Signature does not match");
});
await ok("a job whose body was changed after signing is refused", async () => {
  const env = await S.signBody(m4.priv, M4, job());
  const body = JSON.parse(env.body);
  body.args.only = "dnd";
  await refused({ ...env, body: JSON.stringify(body) }, "Signature does not match");
});
await ok("a job signed by the secondary itself (not a primary) is refused", async () => {
  const both = [...trustedOnM1, { device: M1, pub: m1.pub, role: "secondary" as const }];
  await refused(await S.signBody(m1.priv, M1, { ...job(), from: M1 }), "Not signed by your primary", { trusted: both });
});
await ok("a signature from one device cannot be passed off as another's (from must match by)", async () => {
  const two = [...trustedOnM1, { device: "m4-second", pub: evil.pub, role: "primary" as const }];
  await refused(await S.signBody(evil.priv, "m4-second", job()), "Sender does not match the signature", { trusted: two });
});
await ok("missing or broken envelopes are refused", async () => {
  await refused(null, "Not signed");
  await refused({ body: "{}" }, "Not signed");
  await refused({ body: job(), sig: "x", by: M4 }, "Not signed");
  const env = await S.signBody(m4.priv, M4, job());
  await refused({ ...env, sig: env.sig.slice(4) }, "Signature does not match");
});
await ok("a job for another Mac is refused", async () => {
  await refused(await S.signBody(m4.priv, M4, job({ to: "other-mac" })), "Meant for another Mac");
  await refused(await S.signBody(m4.priv, M4, job({ to: "all" })), "Meant for another Mac");
});
await ok("a job older than a day, or dated in the future, is refused", async () => {
  await refused(await S.signBody(m4.priv, M4, job({ at: T0 - 25 * H, exp: T0 - H })), "Too old");
  await refused(await S.signBody(m4.priv, M4, job({ at: T0 + 10 * M })), "Clock is off");
});
await ok("a replayed job (seen before) is refused", async () => {
  const env = await S.signBody(m4.priv, M4, job());
  assert.equal((await accept(env)).ok, true);
  await refused(env, "Seen before", { seen: new Set([`job:${uuid("c")}`]) });
});
await ok("a Mac not set as a secondary runs nothing", async () => {
  await refused(await S.signBody(m4.priv, M4, job()), "Not set as a secondary", { myRole: "primary" });
  await refused(await S.signBody(m4.priv, M4, job()), "Not set as a secondary", { myRole: "none" });
});
await ok("other signed messages are not jobs", async () => {
  const msg = { v: 1, t: "msg", id: "m1", from: M4, to: M1, at: T0, text: "hi" };
  await refused(await S.signBody(m4.priv, M4, msg), "Unexpected message");
});
await ok("messages and stats may go to all paired Macs; the primary checks the secondary's signature", async () => {
  const stat = { v: 1, t: "stat", id: "s1", from: M1, to: "all", at: T0, cpu: 12, battery: 100, charging: false, power: "ac", busy: null, queue: 0, have: {} };
  const r = await S.openEnv(await S.signBody(m1.priv, M1, stat), { trusted: trustedOnM4, me: M4, now: T0 + M, want: ["stat"], fromRole: "secondary" });
  assert.equal(r.ok, true);
  const fake = await S.openEnv(await S.signBody(evil.priv, M1, stat), { trusted: trustedOnM4, me: M4, now: T0 + M, want: ["stat"] });
  assert.equal(fake.ok, false);
});

await ok("any other signed message older than 30 days is refused (the seen set forgets after 30 days)", async () => {
  const msg = (at: number) => ({ v: 1, t: "msg", id: `m-${at}`, from: M4, to: "all", at, text: "hi" });
  const o = { trusted: trustedOnM4.concat([{ device: M4, pub: m4.pub, role: "primary" as const }]), me: M1, now: T0, want: ["msg" as const] };
  assert.equal((await S.openEnv(await S.signBody(m4.priv, M4, msg(T0 - 29 * 24 * H)), o)).ok, true);
  const r = await S.openEnv(await S.signBody(m4.priv, M4, msg(T0 - 31 * 24 * H)), o);
  assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, "Too old");
});

// ---------- the job allowlist ----------
const signed = (over: Partial<import("../src/core/second.ts").JobBody>) => S.signBody(m4.priv, M4, job(over));
await ok("every allowed job type with good arguments is accepted", async () => {
  const cases = [
    { type: "selftest" as const, args: { mac: sha("1"), web: sha("2"), only: "dnd" } },
    { type: "build" as const, args: { mac: sha("1"), web: sha("2"), send: true } },
    { type: "tests" as const, args: { project: "ps-gos", head: sha("3"), preset: "auto" }, bundles: [{ project: "ps-gos", file: uuid("d"), head: sha("3") }] },
    { type: "claude" as const, args: { project: "middle-click", head: sha("4"), prompt: "Fix the failing test in tests/x.test.ts", model: "opus", minutes: 30 }, bundles: [{ project: "middle-click", file: uuid("e"), head: sha("4"), base: sha("5") }] },
    { type: "cancel" as const, args: { job: uuid("f") }, bundles: [] },
  ];
  for (const c of cases) {
    const r = await accept(await signed(c));
    assert.equal(r.ok, true, `${c.type}: ${r.ok ? "" : r.reason}`);
  }
});
await ok("an unknown job type (for example a shell command) is refused", async () => {
  await refused(await signed({ type: "shell" as never, args: { cmd: "rm -rf ~" } }), "Unknown job type");
  await refused(await signed({ type: "exec" as never, args: {} }), "Unknown job type");
});
await ok("an extra argument on an allowed type is refused (no smuggled shell)", async () => {
  await refused(await signed({ args: { mac: sha("1"), web: sha("2"), cmd: "curl x | sh" } }), "Bad arguments");
  await refused(await signed({ type: "tests", args: { project: "ps-gos", head: sha("3"), preset: "auto", script: "evil" }, bundles: [{ project: "ps-gos", file: uuid("d"), head: sha("3") }] }), "Bad arguments");
});
await ok("bad argument values are refused", async () => {
  await refused(await signed({ args: { mac: "HEAD", web: sha("2") } }), "Bad arguments");
  await refused(await signed({ args: { mac: sha("1"), web: sha("2"), only: "dnd; rm" } }), "Bad arguments");
  await refused(await signed({ type: "tests", args: { project: "../etc", head: sha("3"), preset: "auto" } }), "Bad arguments");
  await refused(await signed({ type: "tests", args: { project: "ps-gos", head: sha("3"), preset: "bash" }, bundles: [{ project: "ps-gos", file: uuid("d"), head: sha("3") }] }), "Bad arguments");
  await refused(await signed({ type: "claude", args: { project: "x", head: sha("3"), prompt: "" } }), "Bad arguments");
  await refused(await signed({ type: "claude", args: { project: "x", head: sha("3"), prompt: "a".repeat(8001) } }), "Bad arguments");
  await refused(await signed({ type: "claude", args: { project: "x", head: sha("3"), prompt: "go", minutes: 600 } }), "Bad arguments");
  await refused(await signed({ type: "claude", args: { project: "x", head: sha("3"), prompt: "go", model: "gpt" } }), "Bad arguments");
  await refused(await signed({ type: "cancel", args: { job: "all" }, bundles: [] }), "Bad arguments");
  await refused(await signed({ args: [] as never }), "Bad arguments");
});
await ok("a job whose code bundle is not attached is refused", async () => {
  await refused(await signed({ bundles: [bundles[0]] }), "Code bundle missing");
  await refused(await signed({ type: "tests", args: { project: "ps-gos", head: sha("3"), preset: "auto" }, bundles: [] }), "Code bundle missing");
  await refused(await signed({ bundles: [{ ...bundles[0], head: "nope" }, bundles[1]] }), "Bad arguments");
});
await ok("an expiry stretched past a day is refused", async () => {
  await refused(await signed({ exp: T0 + 30 * H }), "Bad arguments");
});

// ---------- files ----------
await ok("file limits: 50 MB a file, 100 MB waiting in total, empty files refused", () => {
  assert.equal(S.fileRefusal(10 * S.MB, 0), null);
  assert.equal(S.fileRefusal(50 * S.MB, 0), null);
  assert.match(S.fileRefusal(50 * S.MB + 1, 0)!, /Too big: 50 MB\. The limit is 50 MB a file\./);
  assert.match(S.fileRefusal(5 * S.MB, 96 * S.MB)!, /Wait for the files on their way to land first/);
  assert.equal(S.fileRefusal(4 * S.MB, 96 * S.MB), null);
  assert.equal(S.fileRefusal(0, 0), "That file is empty.");
  assert.equal(S.fileRefusal(NaN, 0), "Cannot read that file.");
});
await ok("files are split into 4 MB chunks", () => {
  assert.equal(S.chunkCount(1), 1);
  assert.equal(S.chunkCount(4 * S.MB), 1);
  assert.equal(S.chunkCount(4 * S.MB + 1), 2);
  assert.equal(S.chunkCount(25 * S.MB), 7);
  assert.equal(S.chunkCount(50 * S.MB), 13);
});
await ok("landing names: no folders, no hidden files, short, and never overwrite", () => {
  assert.equal(S.cleanName("../../.ssh/authorized_keys"), "-..-.ssh-authorized_keys");
  assert.equal(S.cleanName(".zshrc"), "zshrc");
  assert.equal(S.cleanName("a/b\\c:d"), "a-b-c-d");
  assert.equal(S.cleanName(""), "file");
  assert.equal(S.cleanName("x".repeat(300) + ".pdf").length, 120);
  assert.ok(S.cleanName("x".repeat(300) + ".pdf").endsWith(".pdf"));
  const have = new Set(["report.pdf", "report 2.pdf"]);
  assert.equal(S.freeName("report.pdf", (x) => have.has(x)), "report 3.pdf");
  assert.equal(S.freeName("notes", (x) => x === "notes"), "notes 2");
  assert.equal(S.freeName("new.txt", (x) => have.has(x)), "new.txt");
});
await ok("sizes read plainly", () => {
  assert.equal(S.fmtSize(512), "512 B");
  assert.equal(S.fmtSize(2048), "2 KB");
  assert.equal(S.fmtSize(3.5 * S.MB), "3.5 MB");
  assert.equal(S.fmtSize(25 * S.MB), "25 MB");
});

// ---------- code bundles ----------
await ok("secret looking paths never travel in a code bundle", () => {
  for (const p of [".env", ".env.local", "signing/update-ed25519.key", "certs/dev.pem", "references/.drop-secret", "private/real-clients-import.json", "config/client_secret.json"]) assert.equal(S.secretPath(p), true, p);
  for (const p of ["src/App.tsx", "tests/second.test.ts", "Sources/main.swift", "package.json", "docs/environment.md", "supabase/migrations-cincee/001_followup_drop_secret.sql", "src/vite-env.d.ts"]) assert.equal(S.secretPath(p), false, p);
});

// ---------- status, logs, housekeeping ----------
await ok("online when the newest status is under 7 minutes old", () => {
  assert.equal(S.isOnline({ at: T0 - 4 * M }, T0), true);
  assert.equal(S.isOnline({ at: T0 - 8 * M }, T0), false);
  assert.equal(S.isOnline(null, T0), false);
  assert.equal(S.seenText(T0 - 30_000, T0), "just now");
  assert.equal(S.seenText(T0 - 14 * M, T0), "14 min ago");
  assert.equal(S.seenText(T0 - 3 * H, T0, "UTC"), "09:00");
  assert.equal(S.seenText(T0 - 20 * H, T0, "UTC"), "yesterday 16:00");
  assert.equal(S.seenText(null, T0), "never");
});
await ok("logs are cut to their last bytes on a line break", () => {
  const log = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const t = S.tail(log, S.TAIL_RUNNING);
  assert.ok(new TextEncoder().encode(t).length <= S.TAIL_RUNNING);
  assert.ok(t.startsWith("line "));
  assert.ok(t.endsWith("line 1999"));
  assert.equal(S.tail("short", 100), "short");
});
await ok("housekeeping: old jobs, landed files and old notes go; recent ones stay", () => {
  const D = 86_400_000;
  const out = new Set(S.prune({
    now: T0,
    jobs: [{ id: "j-old", at: T0 - 8 * D }, { id: "j-new", at: T0 - D }],
    statuses: [{ id: "s-old", job: "j-old" }, { id: "s-new", job: "j-new" }, { id: "s-orphan", job: "j-gone" }],
    msgs: Array.from({ length: 302 }, (_, i) => ({ id: `m${i}`, at: T0 - i * M })),
    files: [{ id: "f-landed", at: T0 - 3 * D, acked: true }, { id: "f-fresh", at: T0 - H, acked: true }, { id: "f-stuck", at: T0 - 5 * D, acked: false }],
    acks: [{ id: "a-landed", ref: "f-landed", at: T0 - 3 * D }, { id: "a-fresh", ref: "f-fresh", at: T0 - H }],
  }));
  for (const id of ["j-old", "s-old", "s-orphan", "m300", "m301", "f-landed", "f-stuck", "a-landed"]) assert.ok(out.has(id), id);
  for (const id of ["j-new", "s-new", "m0", "m299", "f-fresh", "a-fresh"]) assert.ok(!out.has(id), id);
});

// ---------- v1.1: research jobs, remote commands, shared folders ----------
await ok("research: a titled prompt with no code is accepted; bundles, shell or odd titles are refused", async () => {
  const r = (args: Record<string, unknown>, extra: object = {}) => S.signBody(m4.priv, M4, job({ type: "research" as never, args, bundles: [], ...extra }));
  assert.equal((await accept(await r({ prompt: "Compare the top 5 Shopify review apps for beauty brands", title: "Review apps" }))).ok, true);
  assert.equal((await accept(await r({ prompt: "x", title: "Deep dive (UK) & US", minutes: 30, model: "sonnet" }))).ok, true);
  await refused(await r({ prompt: "x", title: "../../etc" }), "Bad arguments");
  await refused(await r({ prompt: "x", title: ".hidden" }), "Bad arguments");
  await refused(await r({ prompt: "x", title: "ok", cmd: "ls" }), "Bad arguments");
  await refused(await r({ prompt: "", title: "ok" }), "Bad arguments");
  await refused(await r({ prompt: "x", title: "ok" }, { bundles }), "Bad arguments");
});

const cmd = (over: object = {}) => ({ v: 1, t: "cmd", id: "c-1", from: M4, to: M1, at: T0, exp: T0 + 2 * M, action: "restart", ...over });
const acceptCmd = (env: unknown, o = {}) => S.acceptCmd(env, { trusted: trustedOnM1, me: M1, now: T0 + 30_000, ...o });
const cmdRefused = async (env: unknown, reason: string, o = {}) => { const r = await acceptCmd(env, o); assert.equal(r.ok, false); if (!r.ok) assert.equal(r.reason, reason); };
await ok("remote restart, shut down and lock: accepted when signed by the primary inside 2 minutes", async () => {
  for (const action of ["restart", "shutdown", "lock", "cancel", "postpone"]) assert.equal((await acceptCmd(await S.signBody(m4.priv, M4, cmd({ action })))).ok, true, action);
});
await ok("postpone (V1.28, one more hour on the other Mac's auto reboot) takes no arguments", async () => {
  await cmdRefused(await S.signBody(m4.priv, M4, cmd({ id: "c-pp", action: "postpone", minutes: 600 })), "Bad arguments");
});
await ok("set:<mode>:<minutes> (V1.28): the main Mac chooses the other Mac's auto reboot, 10 to 4320 minutes; anything else is refused", async () => {
  for (const [i, a] of ["set:active:1080", "set:watch:10", "set:off:4320"].entries()) assert.equal((await acceptCmd(await S.signBody(m4.priv, M4, cmd({ id: `c-set-${i}`, action: a })))).ok, true, a);
  for (const [i, a] of ["set:active:9", "set:active:4321", "set:boom:600", "set:active:0600", "set:active:1:2", "set:active:", "set::600", "SET:active:600", "set:active:10000"].entries()) {
    await cmdRefused(await S.signBody(m4.priv, M4, cmd({ id: `c-bad-${i}`, action: a })), "Unknown command");
  }
  assert.deepEqual(S.rebootSet("set:active:1080"), { mode: "active", minutes: 1080 });
  assert.equal(S.rebootSet("set:active:7.5"), null);
});
await ok("remote commands: expired, replayed, forged, from the secondary, unknown or padded are refused", async () => {
  await cmdRefused(await S.signBody(m4.priv, M4, cmd()), "Too old", { now: T0 + 3 * M });
  await cmdRefused(await S.signBody(m4.priv, M4, cmd({ exp: T0 + 60 * M })), "Too old");
  await cmdRefused(await S.signBody(m4.priv, M4, cmd()), "Seen before", { seen: new Set(["cmd:c-1"]) });
  await cmdRefused(await S.signBody(evil.priv, M4, cmd()), "Signature does not match");
  await cmdRefused(await S.signBody(evil.priv, "x", cmd({ from: "x" })), "Not signed by a paired Mac");
  const both = [...trustedOnM1, { device: "m1-other", pub: m1.pub, role: "secondary" as const }];
  await cmdRefused(await S.signBody(m1.priv, "m1-other", cmd({ from: "m1-other" })), "Not signed by your primary", { trusted: both });
  await cmdRefused(await S.signBody(m4.priv, M4, cmd({ action: "erase" })), "Unknown command");
  await cmdRefused(await S.signBody(m4.priv, M4, cmd({ shell: "shutdown -h now" })), "Bad arguments");
  await cmdRefused(await S.signBody(m4.priv, M4, cmd({ to: "all" })), "Meant for another Mac");
});

await ok("shared folders: only plain relative paths inside the shared folder can be asked for", () => {
  for (const p of ["notes.txt", "Outsource/2026-10-31 Review apps/report.md", "a b/c (1).pdf"]) assert.equal(S.sharePathOk(p), true, p);
  for (const p of ["", "/etc/passwd", "../x", "a/../../b", "a/./b", ".ssh/id_rsa", "a/.git/config", "a//b", "a\\b", "x\u0000y", "a/"]) assert.equal(S.sharePathOk(p), false, JSON.stringify(p));
  const g = (o: object) => ({ v: 1 as const, t: "get" as const, id: "g1", from: M4, to: M1, at: T0, root: "ps-shared", path: "a.pdf", as: "download" as const, ...o });
  assert.equal(S.checkGet(g({})), null);
  assert.equal(S.checkGet(g({ path: "../../Library/Keychains" })), "Bad arguments");
  assert.equal(S.checkGet(g({ root: "/Users" })), "Bad arguments");
  assert.equal(S.checkGet(g({ as: "exec" })), "Bad arguments");
  assert.equal(S.checkGet(g({ follow: true })), "Bad arguments");
});
await ok("ps://second links round trip and never carry a bad path", () => {
  const l = S.shareLink(M1, "ps-shared", "Outsource/2026-10-31 Review apps/report.md");
  assert.equal(l, "ps://second/m1-device/ps-shared/Outsource/2026-10-31%20Review%20apps/report.md");
  assert.deepEqual(S.parseShareLink(l), { device: M1, root: "ps-shared", path: "Outsource/2026-10-31 Review apps/report.md" });
  assert.equal(S.parseShareLink("ps://second/m1/ps-shared/..%2F..%2Fetc"), null);
  assert.equal(S.parseShareLink("https://example.com/x"), null);
});
await ok("Files pane: one folder level at a time, folders first", () => {
  const e = [
    { p: "b.txt", s: 1, m: 1 }, { p: "A folder/x.pdf", s: 2, m: 2 }, { p: "A folder/sub/y.png", s: 3, m: 3 },
    { p: "a.txt", s: 1, m: 1 }, { p: "Outsource", d: true, s: 0, m: 4 }, { p: "Outsource/r/report.md", s: 5, m: 5 },
  ];
  assert.deepEqual(S.listDir(e, "").map((x) => [x.p, !!x.d]), [["A folder", true], ["Outsource", true], ["a.txt", false], ["b.txt", false]]);
  assert.deepEqual(S.listDir(e, "A folder").map((x) => x.p), ["A folder/sub", "A folder/x.pdf"]);
  assert.deepEqual(S.listDir(e, "Outsource/r").map((x) => x.p), ["Outsource/r/report.md"]);
});

await ok("machine status: the helper's clock is in seconds, the timer counts only in active mode", () => {
  assert.equal(S.machineMs(1761900000), 1761900000000);
  assert.equal(S.machineMs(1761900000000), 1761900000000);
  assert.equal(S.machineMs(null), null);
  assert.equal(S.timerOn({ timer: { hours: 18, deadline: 1, mode: "active" } }), true);
  assert.equal(S.timerOn({ timer: { hours: 12, deadline: null, mode: "watch" } }), false);
  assert.equal(S.timerOn({ timer: { hours: 18, deadline: null, mode: "off" } }), false);
  assert.equal(S.timerOn({}), false);
});

await ok("a trusted phone may send restart, shut down or lock, but never a job", async () => {
  const phone = await S.makeKeys();
  const withPhone = [...trustedOnM1, { device: "phone-1", pub: phone.pub, role: "phone" as never }];
  const c = await S.signBody(phone.priv, "phone-1", cmd({ from: "phone-1", action: "lock" }));
  assert.equal((await acceptCmd(c, { trusted: withPhone })).ok, true);
  // The phone may postpone, but never choose a Mac's auto reboot settings (only the main Mac, V1.28).
  assert.equal((await acceptCmd(await S.signBody(phone.priv, "phone-1", cmd({ id: "c-ph-pp", from: "phone-1", action: "postpone" })), { trusted: withPhone })).ok, true);
  const ps = await acceptCmd(await S.signBody(phone.priv, "phone-1", cmd({ id: "c-ph-set", from: "phone-1", action: "set:active:60" })), { trusted: withPhone });
  assert.equal(ps.ok, false); if (!ps.ok) assert.equal(ps.reason, "Not signed by your primary");
  await refused(await S.signBody(phone.priv, "phone-1", job({ from: "phone-1" })), "Not signed by your primary", { trusted: withPhone });
  await cmdRefused(c, "Not signed by a paired Mac");   // not trusted on this Mac: refused
});

// ---------- what the panel shows (src/second/view.ts) ----------
const V = await import("../src/second/view.ts");
await ok("panel: the paired secondary, its status, notes, files and jobs, from the records", () => {
  const env = (by: string, body: object) => ({ body: JSON.stringify({ v: 1, ...body }), sig: "x", by });
  const doc = (id: string, kind: string, data: unknown) => ({ id, ws: null, kind, data, author: "a", updatedAt: null });
  const docs = [
    doc("d1", "sdev", { device: M4, env: env(M4, { t: "dev", id: "1", from: M4, to: "all", at: T0 - H, name: "M4", role: "primary", pub: m4.pub }) }),
    doc("d2", "sdev", { device: M1, env: env(M1, { t: "dev", id: "2", from: M1, to: "all", at: T0 - H, name: "Home M1", role: "secondary", pub: m1.pub }) }),
    doc("d3", "sdev", { device: "m1b", env: env("m1b", { t: "dev", id: "3", from: "m1b", to: "all", at: T0 - H, name: "Spare", role: "secondary", pub: evil.pub }) }),
    doc("p1", "spair", { env: env(M1, { t: "pairok", id: "4", from: M1, to: M4, at: T0 - H, primary: M4, secondary: M1, primaryPub: m4.pub, secondaryPub: m1.pub }) }),
    doc("s1", "sstat", { device: M1, env: env(M1, { t: "stat", id: "5", from: M1, to: "all", at: T0 - 3 * M, cpu: 40, battery: 100, charging: false, power: "ac", busy: null, queue: 0, have: {} }) }),
    doc("m1", "smsg", { env: env(M4, { t: "msg", id: "6", from: M4, to: "all", at: T0 - 2 * M, text: "second" }) }),
    doc("m2", "smsg", { phone: true, text: "first", at: T0 - 5 * M }),
    doc("f1", "sfile", { env: env(M4, { t: "file", id: "f1", from: M4, to: M1, at: T0 - M, name: "a.pdf", size: 3 * S.MB, purpose: "user", chunk: S.CHUNK, n: 1 }), chunks: ["c1"] }),
    doc("f2", "sfile", { env: env(M4, { t: "file", id: "f2", from: M4, to: M1, at: T0 - M, name: "ps-mac.bundle", size: 2 * S.MB, purpose: "bundle", chunk: S.CHUNK, n: 1 }), chunks: ["c2"] }),
    doc("f3", "sfile", { env: env(M1, { t: "file", id: "f3", from: M1, to: M4, at: T0 - 9 * M, name: "b.zip", size: S.MB, purpose: "user", chunk: S.CHUNK, n: 1 }), chunks: ["c3"] }),
    doc("a3", "sack", { ref: "f3", env: env(M4, { t: "ack", id: "7", from: M4, to: M1, at: T0 - 8 * M, ref: "f3", ok: true }) }),
    doc("j1", "sjob", { env: env(M4, { t: "job", id: "j1", from: M4, to: M1, at: T0 - 4 * M, type: "tests", args: { project: "x" } }) }),
    doc("t1", "sjobst", { job: "j1", env: env(M1, { t: "jobst", id: "8", from: M1, to: M4, at: T0 - 3 * M, job: "j1", state: "running", tail: "" }) }),
    doc("t2", "sjobst", { job: "j1", env: env(M1, { t: "jobst", id: "9", from: M1, to: M4, at: T0 - M, job: "j1", state: "done", tail: "ok" }) }),
  ] as never[];
  const local = { ...V.EMPTY_LOCAL, native: true, me: { device: M4, name: "M4", pub: m4.pub, role: "primary" as const }, trusted: [{ device: M1, pub: m1.pub, role: "secondary" as const }] };
  const v = V.secondView(docs, local, T0);
  assert.equal(v.peer?.name, "Home M1"); assert.equal(v.peer?.paired, true);
  assert.deepEqual(v.unpaired.map((d) => d.name), ["Spare"]);
  assert.equal(v.online, true); assert.equal(v.stat?.cpu, 40);
  assert.deepEqual(v.msgs.map((m) => [m.text, m.mine, m.phone]), [["first", false, true], ["second", true, false]]);
  assert.deepEqual(v.files.map((f) => [f.name, f.state]), [["a.pdf", "waiting"], ["b.zip", "landed"]], "bundles stay out of sight");
  assert.equal(v.waitingBytes, 5 * S.MB, "bundles on their way still count toward the 100 MB");
  assert.equal(v.jobs[0].state, "done", "the newest status wins");
  assert.equal(V.secondView(docs, local, T0 + 10 * M).online, false);
  const withPhone = V.secondView([...docs, doc("ph", "sdev", { phone: true, device: "phone-1", pub: "BPHONE", name: "Pixel", at: T0 })] as never[], local, T0);
  assert.deepEqual(withPhone.phones.map((p) => [p.name, p.trusted]), [["Pixel", false]], "an unsigned phone record is listed, never trusted by itself");
  assert.equal(withPhone.unpaired.length, 1, "a phone is not a Mac to pair");
  const noTrust = V.secondView(docs, { ...local, trusted: [] }, T0);
  assert.equal(noTrust.peer, null, "nobody counts as the secondary until this Mac trusts it");
  assert.equal(noTrust.unpaired.length, 2);
});

// Shared vector for the native side (ps-mac tests): a WebCrypto signature CryptoKit must verify, and a code.
if (process.env.SAS_VECTOR) {
  const p = "BPrimaryKeyForTheTestVectorOnly", s = "BSecondaryKeyForTheTestVectorOnly";
  const k = await S.makeKeys();
  const body = { v: 1, t: "job", id: uuid("c"), from: M4, to: M1, at: T0, exp: T0 + 24 * H, type: "selftest", args: { mac: sha("1"), web: sha("2") }, bundles };
  const env = await S.signBody(k.priv, M4, body);
  writeFileSync(process.env.SAS_VECTOR, JSON.stringify({
    pairCode: { primaryPub: p, secondaryPub: s, code: await S.pairCode(p, s) },
    signature: { pub: k.pub, env, note: "x963 public key and raw r||s signature over SHA-256 of the UTF-8 body, as WebCrypto makes them" },
    pairCodeReal: { primaryPub: m4.pub, secondaryPub: m1.pub, code: await S.pairCode(m4.pub, m1.pub) },
  }, null, 2));
  console.log("wrote", process.env.SAS_VECTOR);
}

console.log(`\n${n} passed`);
