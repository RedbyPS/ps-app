// DEV ONLY (/dev-second): fictional Second Computer records for pictures and checking the panel by eye.
// The envelopes carry no real signatures (the dev page never runs anything); every name and log is made up.
import type { Doc } from "../core/model";
import type { SecondLocal } from "../second/view";

const M4 = "dev-m4", M1 = "dev-m1";
const env = (by: string, body: object) => ({ body: JSON.stringify(body), sig: "dev", by });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (c: string) => c.repeat(40).slice(0, 40);

/** `as`: "unpaired" (a primary with no second Mac yet) or "none" (a Mac not set up), from ?as= on the dev page. */
export function fakeSecond(now = Date.now(), as?: string | null): { docs: Doc[]; local: SecondLocal } {
  const all = fakeSecondAll(now);
  if (as !== "unpaired" && as !== "none") return all;
  return {
    docs: all.docs.filter((d) => d.kind === "sdev" && (d.data as { device?: string }).device === M4),
    local: { ...all.local, trusted: [], verified: [], progress: [], me: all.local.me && { ...all.local.me, role: as === "none" ? "none" : "primary" } },
  };
}

function fakeSecondAll(now: number): { docs: Doc[]; local: SecondLocal } {
  const M = 60_000;
  const d = (id: string, kind: string, data: unknown): Doc => ({ id, ws: null, kind: kind as Doc["kind"], data, author: "dev", updatedAt: new Date(now).toISOString() });
  const b = (t: string, from: string, to: string, at: number, extra: object, id = uuid(Math.round(at % 1e9))) => ({ v: 1, t, id, from, to, at, ...extra });
  const docs: Doc[] = [
    d("sd1", "sdev", { device: M4, env: env(M4, b("dev", M4, "all", now - 90 * M, { name: "The developer's MacBook Air M4", model: "MacBook Air 13 inch, M4", role: "primary", pub: "BDEV4" })) }),
    d("sd2", "sdev", { device: M1, env: env(M1, b("dev", M1, "all", now - 80 * M, { name: "Home M1", model: "MacBook Air, M1", role: "secondary", pub: "BDEV1" })) }),
    d("sp1", "spair", { env: env(M1, b("pairok", M1, M4, now - 79 * M, { primary: M4, primaryPub: "BDEV4", secondary: M1, secondaryPub: "BDEV1" })) }),
    d("ss1", "sstat", { device: M1, env: env(M1, b("stat", M1, "all", now - 2 * M, { cpu: 62, battery: 100, charging: false, power: "ac", busy: uuid(901), queue: 1, have: { "ps-mac": sha("a"), "web": sha("b") }, disk: 188, mem: 48, app: "V1.23",
      machine: { awake: true, locked: true, fileVault: "on", passwordImmediately: true, timer: { hours: 18, deadline: Math.round((now + 7 * 3_600_000 + 12 * M) / 1000), mode: "active" }, bootedAt: Math.round((now - 11 * 3_600_000) / 1000), lastRestart: { at: Math.round((now - 11 * 3_600_000) / 1000), kind: "restart" }, helper: "approved" } })) }),
    d("ss2", "sstat", { device: M4, env: env(M4, b("stat", M4, "all", now - 1 * M, { cpu: 21, mem: 61, battery: 74, charging: false, power: "battery", busy: null, queue: 0, have: {}, disk: 96, app: "V1.23",
      machine: { awake: false, locked: false, fileVault: "on", passwordImmediately: true, timer: { hours: 12, deadline: null, mode: "watch" }, helper: "approved" } })) }),
    d("si1", "sidx", { device: M1, root: "ps-shared", env: env(M1, b("idx", M1, "all", now - 6 * M, { root: "ps-shared", name: "PS Shared", entries: [
      { p: "Outsource", d: true, s: 0, m: now - 30 * M },
      { p: "Outsource/2026-10-31 09.40 Shopify review apps", d: true, s: 0, m: now - 30 * M },
      { p: "Outsource/2026-10-31 09.40 Shopify review apps/report.md", s: 18_400, m: now - 30 * M, k: "text" },
      { p: "Outsource/2026-10-31 09.40 Shopify review apps/sources.md", s: 6_100, m: now - 31 * M, k: "text" },
      { p: "Outsource/2026-10-30 22.15 middle-click threshold/patch.diff", s: 4_900, m: now - 12 * 60 * M, k: "text" },
      { p: "Brand boards/Brand board v3.pdf", s: 4_812_000, m: now - 49 * M, k: "pdf" },
      { p: "Brand boards/Mood references/linen-01.jpg", s: 2_310_000, m: now - 3 * 24 * 60 * M, k: "image" },
      { p: "Brand boards/Mood references/linen-02.jpg", s: 1_980_000, m: now - 3 * 24 * 60 * M, k: "image" },
      { p: "Self test pictures/tab-list.png", s: 812_000, m: now - 60 * M, k: "image" },
      { p: "Self test pictures/second-panel.png", s: 640_000, m: now - 60 * M, k: "image" },
      { p: "Invoices/October.pdf", s: 210_000, m: now - 5 * 24 * 60 * M, k: "pdf" },
      { p: "notes from the M1.txt", s: 1_200, m: now - 2 * 60 * M, k: "text" },
      { p: "selftest-2610311402.zip", s: 11_300_000, m: now - 20 * M, k: "other" },
    ] })) }),
    d("si2", "sidx", { device: M4, root: "ps-shared", env: env(M4, b("idx", M4, "all", now - 9 * M, { root: "ps-shared", name: "PS Shared", entries: [
      { p: "For the M1/brief.md", s: 3_200, m: now - 9 * M, k: "text" },
    ] })) }),
    d(uuid(905), "sjob", { env: env(M4, b("job", M4, M1, now - 40 * M, { exp: now, type: "research", args: { title: "Shopify review apps", prompt: "Compare the top 5 Shopify review apps for beauty brands under 10 people: price, photo reviews, Klaviyo sync, page speed cost. End with one pick and why." } }, uuid(905))) }),
    d("st5", "sjobst", { job: uuid(905), env: env(M1, b("jobst", M1, M4, now - 30 * M, { job: uuid(905), state: "done", exit: 0, startedAt: now - 39 * M, endedAt: now - 30 * M,
      summary: "Report written: PS Shared, Outsource, Shopify review apps", tail: "Searched 14 sources, read 9.\nWrote report.md (2,140 words) and sources.md.\nPick: Judge.me for under 10 people (free tier, photo reviews, Klaviyo sync, lightest script)." })) }),
    d("sm1", "smsg", { env: env(M4, b("msg", M4, "all", now - 75 * M, { text: "Remember to plug the M1 in before you leave for the airport" })) }),
    d("sm2", "smsg", { env: env(M1, b("msg", M1, "all", now - 60 * M, { text: "Self test finished: all clean. Build 2610311402 is in Downloads, From PS." })) }),
    d("sm3", "smsg", { phone: true, text: "Idea for the morning brief: show the weather in the developer's city", at: now - 30 * M }),
    d("sm4", "smsg", { env: env(M4, b("msg", M4, "all", now - 4 * M, { text: "Run the fitness tests on the M1 tonight, then the full self test" })) }),
    d("sf1", "sfile", { env: env(M4, b("file", M4, M1, now - 50 * M, { name: "Brand board v3.pdf", size: 4_812_000, sha256: "0", mime: "application/pdf", purpose: "user", chunk: 4194304, n: 2 }, uuid(201))), chunks: [] }),
    d("sa1", "sack", { ref: uuid(201), env: env(M1, b("ack", M1, M4, now - 49 * M, { ref: uuid(201), ok: true })) }),
    d("sf2", "sfile", { env: env(M1, b("file", M1, M4, now - 20 * M, { name: "selftest-pictures.zip", size: 11_300_000, sha256: "0", mime: "application/zip", purpose: "user", chunk: 4194304, n: 3 }, uuid(202))), chunks: [] }),
    d("sa2", "sack", { ref: uuid(202), env: env(M4, b("ack", M4, M1, now - 19 * M, { ref: uuid(202), ok: true, path: "~/Downloads/From PS/selftest-pictures.zip" })) }),
    // Jobs: one running, one done, one Claude task done with changed files, one refused.
    d(uuid(901), "sjob", { env: env(M4, b("job", M4, M1, now - 9 * M, { exp: now + 23 * 60 * M, type: "selftest", args: { mac: sha("a"), web: sha("b") } }, uuid(901))) }),
    d("st1", "sjobst", { job: uuid(901), env: env(M1, b("jobst", M1, M4, now - 20_000, { job: uuid(901), state: "running", startedAt: now - 8 * M, step: "self test: Do Not Disturb (14 of 22 areas)",
      tail: "BUILD ok (test copy, ad hoc signed)\nNETWORK blocked for the test copy\nTAB LIST ok\nURGENT ok\nDIMX STYLE ok\nSTATS DAY ok\nRADAR ok\nP1 LOOKS ok\nNEWTASKS OPEN ok\nNET ok\nMEET CARDS ok\nAFK ok\nNOTES ok\nDND CHECK 9 of 16 ..." })) }),
    d(uuid(902), "sjob", { env: env(M4, b("job", M4, M1, now - 70 * M, { exp: now, type: "tests", args: { project: "web", head: sha("c"), preset: "node-tests" } }, uuid(902))) }),
    d("st2", "sjobst", { job: uuid(902), env: env(M1, b("jobst", M1, M4, now - 66 * M, { job: uuid(902), state: "done", exit: 0, startedAt: now - 69 * M, endedAt: now - 66 * M, summary: "41 test files, 612 checks passed, types clean", tail: "ok - every allowed job type with good arguments is accepted\nok - an unknown job type (for example a shell command) is refused\n\n30 passed\n" })) }),
    d(uuid(903), "sjob", { env: env(M4, b("job", M4, M1, now - 120 * M, { exp: now, type: "claude", args: { project: "middle-click", head: sha("d"), prompt: "Make the Force Touch threshold a setting with a slider, keep it off over 1Password and Signal" } }, uuid(903))) }),
    d("st3", "sjobst", { job: uuid(903), env: env(M1, b("jobst", M1, M4, now - 98 * M, { job: uuid(903), state: "done", exit: 0, startedAt: now - 119 * M, endedAt: now - 98 * M, summary: "3 files changed, patch in Downloads, From PS", files: ["Sources/Settings.swift", "Sources/Press.swift", "tests/press.test.swift"], tail: "Added a Force Touch threshold slider (0.6 to 1.0) in Settings.\nThe press handler reads it on every event.\nTests: 9 passed." })) }),
    d(uuid(904), "sjob", { env: env(M4, b("job", M4, M1, now - 200 * M, { exp: now, type: "build", args: { mac: sha("a"), web: sha("b") } }, uuid(904))) }),
    d("st4", "sjobst", { job: uuid(904), env: env(M1, b("jobst", M1, M4, now - 199 * M, { job: uuid(904), state: "refused", reason: "Code bundle missing", tail: "" })) }),
  ];
  const local: SecondLocal = {
    native: true,
    me: { device: M4, name: "The developer's MacBook Air M4", model: "MacBook Air 13 inch, M4", pub: "BDEV4", role: "primary" },
    trusted: [{ device: M1, name: "Home M1", pub: "BDEV1", role: "secondary", at: now - 80 * M }],
    verified: ["sm2"],
    progress: [{ id: "up1", name: "Invoice October.pdf", size: 2_400_000, done: 0, total: 1, dir: "up" }],
    projects: ["web", "middle-click", "ps-gos", "ps-mac"].map((name) => ({ name, path: `/Users/dev/Projects/${name}` })),
    pairing: null, waitingSince: null, note: null,
  };
  return { docs, local };
}
