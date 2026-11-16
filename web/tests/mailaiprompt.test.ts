// Run: node --experimental-strip-types tests/mailaiprompt.test.ts
// Copy for your AI (core/mailaiprompt.ts): the prompt holds the project ref when known, works when it is not, names both
// AIs, never holds anything that looks like a key, a token or an address, and has no em or en dash.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let n = 0;
const ok = (name: string, fn: () => unknown) => { fn(); n++; console.log("ok -", name); };
const file = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const A = await import("../src/core/mailaiprompt.ts");
const S = await import("../src/core/mailsetup.ts");

const REF = "abcdefghijklmnopqrst";
const known = A.mailAiPrompt(REF), unknown = A.mailAiPrompt(null);
const knownC = A.mailAiPrompt(REF, "clicks"), unknownC = A.mailAiPrompt(null, "clicks");
const ALL = [known, unknown, knownC, unknownC];

ok("the project ref and its address are in the prompt when known, and in the right commands", () => {
  assert.ok(known.includes(`https://${REF}.supabase.co`));
  assert.ok(known.includes(`Project ref: ${REF}`) || known.includes(`My project ref: ${REF}`));
  assert.ok(known.includes(S.setProjectSql(REF)));
  for (const line of S.deployCommand(REF).split("\n")) assert.ok(known.includes(line), line);
  assert.ok(known.includes(`--project ${REF} `), "the connect script gets the ref");
  assert.ok(known.includes(`https://supabase.com/dashboard/project/${REF}/sql/new`));
  assert.ok(known.includes(`${S.functionsUrl(REF)}/instantly-webhook/<the secret>`));
});
ok("when the project is not known yet it still works: asks for the ref, no fake value, no empty command", () => {
  assert.match(unknown, /does not know my Supabase project yet/);
  assert.match(unknown, /Settings, Sync and account/);
  assert.ok(!unknown.includes("supabase.co/functions/v1/instantly-webhook/<the secret>") || unknown.includes("<my project ref>"));
  assert.ok(unknown.includes("--project <my project ref> "));
  assert.ok(unknown.includes("--project-ref <my project ref>"));
  assert.ok(!/undefined|null|\bNaN\b|\[object/.test(unknown));
  for (const bad of ["", "ABC", "short", "abcdefghijklmnopqrs!", undefined as unknown as null]) assert.ok(!A.mailAiPrompt(bad).includes("supabase.co/dashboard"), String(bad));
});
ok("it names both Claude Code and Codex, and says the person does the Google click", () => {
  for (const p of ALL) {
    assert.match(p, /Claude Code/); assert.match(p, /Codex/);
    assert.match(p, /Google's Allow click is always mine/);
    assert.match(p, /never type my passwords/);
    assert.match(p, /Keychain/);
  }
});
ok("nothing that looks like a key, a token, a secret value or an address", () => {
  for (const p of ALL) {
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/.test(p), "an address");
    assert.ok(!/eyJ[A-Za-z0-9_-]{10,}\./.test(p), "a jwt");
    const shapes = [["s", "k-"], ["sb_", "secret_"], ["sb_", "publishable_"], ["gh", "p_"], ["github_", "pat_"], ["AK", "IA"], ["BEGIN ", "PRIVATE"], ["ya", "29."], ["GOC", "SPX"]].map((x) => x.join(""));
    for (const w of shapes) assert.ok(!p.includes(w), `a key shape ${w}`);
    assert.ok(!/\b[A-Za-z0-9_-]{40,}\b/.test(p.replace(/https?:\/\/\S+/g, "")), "a long random string");
    assert.ok(!/\/Users\//.test(p), "a personal path");
  }
  assert.ok(known.includes("PASTE_YOUR_INSTANTLY_KEY_HERE"), "the Instantly key stays a placeholder");
});
ok("no em or en dash, short numbered steps 1 to 10 in order", () => {
  for (const p of ALL) {
    assert.ok(!/[–—]/.test(p));
    const nums = [...p.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    assert.deepEqual(nums, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  }
  for (const p of ALL) assert.ok(p.length < 11000, "short enough to paste");
});
ok("every file and script the prompt names exists in the repo", () => {
  for (const f of ["scripts/gmail-connect.mjs", "supabase/migrations/031_gmail_inbox.sql", "supabase/migrations/037_instantly_replies_cron.sql", "supabase/functions/gmail-inbox/index.ts"]) assert.ok(file(f).length > 0, f);
  assert.match(file("supabase/functions/gmail-inbox/index.ts"), /gmail_enroll/);
});
ok("the words: two ways with one line each, a confirmation line, a small by hand link, no dashes", () => {
  assert.deepEqual(A.AI_COPY_WORDS, {
    button: "Copy for your AI",
    line: "Copies everything your AI needs to connect your Gmail to PS. Paste it into Claude Code or Codex.",
    pick: "Copy for your AI. Pick how it helps:",
    guideButton: "AI guides, you click",
    guideLine: "Your AI opens each page and tells you exactly what to press.",
    clicksButton: "AI does the clicks",
    clicksLine: "Your AI uses screen or browser control to click through. You only sign in, type passwords and press Allow.",
    done: "Copied. Paste it into Claude Code or Codex.",
    failed: "Could not copy. Try again, or use Do it by hand instead.",
    hand: "Do it by hand instead",
  });
  for (const f of ["src/core/mailaiprompt.ts", "src/views/CopyForAi.tsx", "src/views/ClientEmailsSettings.tsx"]) assert.ok(!/[–—]/.test(file(f)), f);
});
ok("the button sits in Settings, Client emails and in the email panel's not connected state; the old steps stay behind the link", () => {
  const ce = file("src/views/ClientEmailsSettings.tsx");
  assert.match(ce, /<CopyForAiChoice \/>/); assert.match(file("src/views/CopyForAi.tsx"), /copy\("guide"\)[\s\S]*copy\("clicks"\)/); assert.match(ce, /mailSteps\(ref, code, hash\)/); assert.match(ce, /<details className="stack tight ce-hand">/);
  assert.ok(!/<details[^>]*\bopen=/.test(ce), "the by hand steps never open by themselves");
  const tm = file("src/views/TaskMap.tsx");
  assert.match(tm, /<CopyForAiButton className="tm-meet-j tm-mail-copy" mode="guide" \/>/);
  assert.match(tm, /<CopyForAiButton className="tm-meet-j tm-mail-copy" mode="clicks" \/>/);
});
ok("step 6 is run by the person in their own Terminal (it waits for a Google sign in the AI cannot see)", () => {
  const p = A.mailAiPrompt("abcdefghijklmnopqrst");
  for (const q of [p, A.mailAiPrompt("abcdefghijklmnopqrst", "clicks")]) {
    const l6 = q.split("\n").find((l) => l.startsWith("6. "))!;
    assert.match(l6, /my own Terminal/); assert.match(l6, /Wait until I say it is done/);
  }
  const step6 = p.split("\n").find((l) => l.startsWith("6. "))!;
  assert.match(step6, /my own Terminal/);
  assert.match(step6, /Wait until I say it is done/);
  assert.match(step6, /gmail-connect\.mjs --project abcdefghijklmnopqrst/);
});


const SAFETY = [
  /I sign in to Google and Supabase myself\. You never type my passwords/,
  /Never ask me to paste, and never print or read out, a key, a token, a password or the contents of my Google client file/,
  /Google's Allow click is always mine/,
  /Delete nothing\. Ask before installing any software/,
  /If a step fails, show me the plain error and stop there/,
  /Keychain/,
  /which only I type/,
];
ok("both variants keep every safety rule", () => { for (const p of ALL) for (const re of SAFETY) assert.match(p, re); });
ok("the two variants share one step list: the numbered steps differ only where the mode says so", () => {
  const steps = (p: string) => p.split("\n").filter((l) => /^(\d+\. |   )/.test(l));
  const a = steps(known), b = steps(knownC);
  assert.equal(a.length, b.length);
  const diff = a.map((l, i) => (l === b[i] ? 0 : 1) as number).reduce((x, y) => x + y, 0);
  assert.ok(diff >= 1 && diff <= 3, `only step 4 header and step 6 link line differ, got ${diff}`);
  assert.equal(A.mailAiPrompt(REF), A.mailAiPrompt(REF, "guide"), "guide is the default");
  assert.deepEqual([...A.AI_MODES], ["guide", "clicks"]);
});
ok("the AI does the clicks: names screen control, every hand over point, the project check and the fallback", () => {
  for (const p of [knownC, unknownC]) {
    assert.match(p, /screen or browser control/); assert.match(p, /Claude in Chrome/); assert.match(p, /Claude computer use/); assert.match(p, /Codex computer use/);
    assert.match(p, /ONLY for: signing in, any password \(including my Mac password when something installs\), Google's Allow and consent screens, and the Advanced, Go to app warning/);
    assert.match(p, /project picker/); assert.match(p, /MY PS project/);
    assert.match(p, /If you have no screen or browser control, or a page will not load/);
    assert.match(p, /tell me exactly what to press/);
  }
  for (const p of [known, unknown]) { assert.ok(!/Claude computer use/.test(p)); assert.match(p, /I do the clicks, you open each page and tell me exactly what to press/); }
});
ok("lessons from the real run are in both: SQL run by the AI, Auth Platform pages, client_secret_ download, file picker, first check, senders", () => {
  for (const p of ALL) {
    assert.match(p, /supabase db query/); assert.match(p, /--read-only/); assert.match(p, /--yes/);
    for (const w of ["Google Auth Platform", "Get started", "Audience", "Data access", "Clients"]) assert.ok(p.includes(w), w);
    assert.match(p, /client_secret_/); assert.match(p, /Downloads/); assert.match(p, /Move it, do not open or print it/);
    assert.match(p, /Cmd\+Shift\+G/); assert.match(p, /~\/\.ps-gmail\/client\.json/);
    assert.match(p, /only after its first check/);
    assert.match(p, /Always notify me/); assert.match(p, /Who emails me/);
  }
});

console.log(`${n} passed`);
