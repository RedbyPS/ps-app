// Run: node --experimental-strip-types tests/second-outsource.test.ts
// Outsourcing from a chat (protocol v1.3, 2 Nov 2026, the developer: "outsource these to the M1"): scripts/second.ts against a
// fake PS (a temp folder standing in for PS's CLI folder) for the batch, the plain refusals, wait, result and cancel;
// then the page code (src/second/store.ts, view.ts) with two fake Macs carrying sealed records it cannot read.
// The sealing itself is native and tested there (ps-mac tests/second-outsource-test.swift). FICTIONAL data, no network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { looksSecret, outsourceTitle, suiteWords } from "../src/core/second.ts";
import { secondView, EMPTY_LOCAL } from "../src/second/view.ts";

let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok -", name); };
const root = mkdtempSync(join(tmpdir(), "ps-second-outsource-"));
const DIR = join(root, "cli");
mkdirSync(DIR, { recursive: true });
const cli = (args: string[]) => new Promise<{ code: number; out: string }>((resolve) => {
  const p = spawn(process.execPath, ["--experimental-strip-types", "scripts/second.ts", ...args], { env: { ...process.env, PS_SECOND_DIR: DIR }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
  p.on("close", (code) => resolve({ code: code ?? -1, out }));
});
const state = (o: object = {}) => writeFileSync(join(DIR, "state.json"), JSON.stringify({ ps: true, unlocked: true, role: "primary", at: Date.now(),
  secondary: { device: "m1", name: "Home M1", online: true, lastSeen: Date.now(), outsource: true, suite: "xwing" }, ...o }));
const res = (rid: string, o: object) => { const f = join(DIR, `res-${rid}.json`); writeFileSync(f + ".tmp", JSON.stringify({ id: rid, kind: "outsource", at: Date.now(), ...o })); renameSync(f + ".tmp", f); };

/** A fake PS: seals nothing, but answers each outsource request as the real one would. */
function fakePs(seen: Record<string, unknown>[], finish?: (rid: string, job: string, title: string) => void) {
  let k = 0;
  const t = setInterval(() => {
    for (const f of readdirSync(DIR)) {
      if (!/^req-.*\.json$/.test(f)) continue;
      const req = JSON.parse(readFileSync(join(DIR, f), "utf8"));
      rmSync(join(DIR, f));
      seen.push(req);
      if (req.type === "ocancel") continue;
      const job = `00000000-0000-4000-8000-00000000000${k++}`;
      res(req.id, { state: "sent", job, title: req.args.title, suite: "xwing" });
      finish?.(req.id, job, req.args.title);
    }
  }, 50);
  return () => clearInterval(t);
}

try {
  await ok("rules: a secret is never sent, titles from the task, the suite in plain words", () => {
    assert.equal(looksSecret("Find the best CRM, my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA"), "an API key");
    assert.equal(looksSecret("-----BEGIN OPENSSH PRIVATE KEY-----"), "a private key");
    assert.equal(looksSecret("passphrase = correct horse"), "a password");
    assert.equal(looksSecret("Compare the three best note apps for a Mac"), null);
    assert.equal(outsourceTitle("Compare the top 3 note apps for Mac, price, sync & privacy?"), "Compare the top 3 note apps for Mac, price");
    assert.equal(suiteWords("xwing"), "X-Wing (ML-KEM-768 + X25519, post-quantum)");
  });

  await ok("never hangs: PS away, the M1 offline, or an M1 without the update: exit 3 at once in plain words", async () => {
    let r = await cli(["outsource", "Find fictional facts"]);
    assert.equal(r.code, 3); assert.match(r.out, /not sent: PS is not running/);
    state({ secondary: { device: "m1", name: "Home M1", online: false, lastSeen: Date.now() - 3_600_000, outsource: true } });
    r = await cli(["outsource", "Find fictional facts"]);
    assert.equal(r.code, 3); assert.match(r.out, /not sent: Home M1 is offline/);
    state({ secondary: { device: "m1", name: "Home M1", online: true, lastSeen: Date.now(), outsource: false } });
    r = await cli(["outsource", "Find fictional facts"]);
    assert.equal(r.code, 3); assert.match(r.out, /PS on Home M1 needs the update that takes sealed research/);
    state({ unlocked: false });
    r = await cli(["outsource", "Find fictional facts"]);
    assert.equal(r.code, 3); assert.match(r.out, /PS is locked/);
    assert.equal(readdirSync(DIR).filter((f) => f.startsWith("req-")).length, 0, "nothing was asked of PS");
  });

  state();
  await ok("PS not picking it up: exit 3 after 30 s at most, never a hang", async () => {
    const t0 = Date.now();
    const r = await cli(["outsource", "Find fictional facts"]);
    assert.equal(r.code, 3); assert.match(r.out, /PS did not pick it up within 30 s/);
    assert.ok(Date.now() - t0 < 40_000);
  });

  await ok("a secret in a task: nothing goes, exit 1", async () => {
    const seen: Record<string, unknown>[] = [];
    const stop = fakePs(seen);
    const r = await cli(["outsource", "Look up pricing", "Check the API with AKIAABCDEFGHIJKLMNOP"]);
    stop();
    assert.equal(r.code, 1); assert.match(r.out, /looks like it holds an AWS key/); assert.equal(seen.length, 0);
  });

  await ok("a batch: each task its own sealed job, with titles, model and minutes; the chat is told how to wait", async () => {
    const seen: Record<string, unknown>[] = [];
    const stop = fakePs(seen);
    writeFileSync(join(root, "tasks.json"), JSON.stringify([{ title: "Fictional CRM prices", prompt: "Compare three fictional CRMs on price" }, "Summarise fictional reviews of a note app"]));
    const r = await cli(["outsource", "--model", "sonnet", "--minutes", "15", "--json", join(root, "tasks.json"), "Find three fictional coffee grinders under 200 dollars"]);
    stop();
    assert.equal(r.code, 0, r.out);
    assert.equal(seen.length, 3);
    assert.deepEqual(seen.map((s) => (s.args as { title: string }).title), ["Find three fictional coffee grinders under 200 dollars", "Fictional CRM prices", "Summarise fictional reviews of a note app"]);
    assert.ok(seen.every((s) => s.type === "outsource" && (s.args as { model: string }).model === "sonnet" && (s.args as { minutes: number }).minutes === 15));
    assert.match(r.out, /sealed with X-Wing \(ML-KEM-768 \+ X25519, post-quantum\)/);
    assert.match(r.out, /3 running on Home M1 \(3 at a time\)/);
    assert.match(r.out, /node scripts\/second\.ts wait 00000000-0000-4000-8000-000000000000 00000000-0000-4000-8000-000000000001 00000000-0000-4000-8000-000000000002/);
  });

  await ok("wait: exits when every job is finished, with each report; result prints it; cancel goes sealed", async () => {
    const report = join(root, "report.md");
    writeFileSync(report, "# Fictional grinders\nThe second one.\n");
    for (const f of readdirSync(DIR).filter((x) => x.startsWith("res-"))) {
      const r = JSON.parse(readFileSync(join(DIR, f), "utf8"));
      if (r.job?.endsWith("0")) res(r.id, { ...r, state: "running" });
      setTimeout(() => res(r.id, { ...r, state: r.job.endsWith("2") ? "timeout" : "done", reason: r.job.endsWith("2") ? "It ran past 15 minutes" : undefined,
        summary: r.job.endsWith("2") ? undefined : "Two fictional sentences.", report: r.job.endsWith("2") ? undefined : report, folder: join(root, "From your other Mac") }), 3000);
    }
    const w = await cli(["wait", "00000000-0000-4000-8000-000000000000", "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]);
    assert.equal(w.code, 1, "one timed out");
    assert.match(w.out, /"Find three fictional coffee grinders under 200 dollars" running on the other Mac/);
    assert.match(w.out, /"Fictional CRM prices" finished\n  Two fictional sentences\.\n  report: .*report\.md/);
    assert.match(w.out, /"Summarise fictional reviews of a note app" timeout: It ran past 15 minutes/);
    const r = await cli(["result", "00000000-0000-4000-8000-000000000001"]);
    assert.equal(r.code, 0); assert.match(r.out, /# Fictional grinders/);
    const seen: Record<string, unknown>[] = [];
    const stop = fakePs(seen);
    const c = await cli(["cancel", "00000000-0000-4000-8000-000000000000"]);
    await new Promise((x) => setTimeout(x, 200)); stop();
    assert.equal(c.code, 0); assert.deepEqual(seen.map((s) => [s.type, (s.args as { job: string }).job]), [["ocancel", "00000000-0000-4000-8000-000000000000"]]);
  });

  await ok("wait: a task the M1 never opened ends as expired after 11 minutes, with the reason", async () => {
    res("old-1", { state: "sent", job: "00000000-0000-4000-8000-0000000000aa", title: "Old fictional task", at: Date.now() - 12 * 60_000 });
    const w = await cli(["wait", "00000000-0000-4000-8000-0000000000aa"]);
    assert.equal(w.code, 1); assert.match(w.out, /"Old fictional task" expired: the other Mac never picked it up \(offline or PS closed there\)/);
  });

  await ok("status lists outsourced jobs and the suite", async () => {
    const r = await cli(["status"]);
    assert.match(r.out, /Outsourcing: sealed with X-Wing/); assert.match(r.out, /00000000-0000-4000-8000-000000000001 {2}done/);
  });

  await ok("the window: sealed jobs show with their title, state, suite and report, from PS's list only", () => {
    const local = { ...EMPTY_LOCAL, native: true, me: { device: "m4", name: "M4", pub: "P", role: "primary" as const }, trusted: [{ device: "m1", pub: "Q", role: "secondary" as const }],
      ojobs: [{ job: "00000000-0000-4000-8000-0000000000b1", title: "Fictional grinders", state: "done" as const, suite: "xwing", at: 1000, endedAt: 2000, mine: true, summary: "Two sentences.", report: "# R", folder: "Downloads/From your other Mac/x" },
        { job: "00000000-0000-4000-8000-0000000000b2", title: "Fictional CRMs", state: "running" as const, step: "Researching", suite: "p256", at: 1500, mine: true }] };
    const v = secondView([], local, 3000);
    assert.deepEqual(v.jobs.map((j) => [j.args.title, j.state, j.sealed?.suite]), [["Fictional CRMs", "running", "p256"], ["Fictional grinders", "done", "xwing"]]);
    assert.equal(v.jobs[1].status?.tail, "# R");
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(`\n${n} passed`);
process.exit(0);
