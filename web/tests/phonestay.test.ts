// Run: node --experimental-strip-types tests/phonestay.test.ts
// PS 1.71: the iPhone web app stays signed in after one passphrase sign in (core/phonestay.ts, vault.ts keepPhoneSignIn,
// phoneCheck, setPhoneStay). The pure parts run here; the vault's wiring is checked in its source (no IndexedDB or
// Supabase in node). Passphrases and usernames are made up.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as C from "../src/core/crypto.ts";
import { PHONE_CHECK_MS, STAY_KEY, checkDue, phoneVerdict, setStay, shouldKeep, stayOn } from "../src/core/phonestay.ts";
import { SETTINGS, groupsFor, rowsOf, visibleTo, type Ctx } from "../src/core/settingsindex.ts";

let n = 0;
const ok = async (name: string, fn: () => void | Promise<void>) => { await fn(); n++; console.log("ok -", name); };
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } }; };

const V = read("src/core/vault.ts");
/** The body of a top level function in vault.ts, from its line to the next top level line. */
function fn(name: string): string {
  const at = V.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  assert.ok(at >= 0, `${name} exists`);
  const end = V.indexOf("\n}\n", at);
  return V.slice(at, end + 2);
}

await ok("Stay signed in is on by default, off only when this phone switched it off", () => {
  const s = mem();
  assert.equal(stayOn(s), true, "nothing saved: on");
  setStay(false, s);
  assert.equal(s.m.get(STAY_KEY), "0");
  assert.equal(stayOn(s), false);
  setStay(true, s);
  assert.equal(stayOn(s), true);
  assert.equal(stayOn(null), true, "no storage: on (and nothing can be kept anyway)");
  assert.equal(stayOn({ getItem: () => { throw new Error("blocked"); }, setItem: () => {} }), true, "storage that throws: on");
  assert.doesNotThrow(() => setStay(false, { getItem: () => null, setItem: () => { throw new Error("full"); } }));
});

await ok("keep only on the phone web app, switch on, online, a project account, not kept yet, with keys to keep", () => {
  const base = { mobilePage: true, stay: true, online: true, local: false, kept: false, haveKeys: true };
  assert.equal(shouldKeep(base), true);
  assert.equal(shouldKeep({ ...base, mobilePage: false }), false, "never the website, PS on the Mac or PS GOS");
  assert.equal(shouldKeep({ ...base, stay: false }), false, "switch off");
  assert.equal(shouldKeep({ ...base, online: false }), false, "offline: the list row comes first");
  assert.equal(shouldKeep({ ...base, local: true }), false, "local first has no passphrase");
  assert.equal(shouldKeep({ ...base, kept: true }), false, "already kept (the Mac's scan)");
  assert.equal(shouldKeep({ ...base, haveKeys: false }), false, "a sign in with nothing exportable to keep");
});

await ok("the check: only a clear answer ends it; offline or a failed request keeps the phone signed in", () => {
  assert.equal(phoneVerdict({ listed: true, opens: true }), "keep");
  assert.equal(phoneVerdict({ listed: false, opens: null }), "removed", "Remove on the Mac");
  assert.equal(phoneVerdict({ listed: false, opens: true }), "removed");
  assert.equal(phoneVerdict({ listed: true, opens: false }), "new-passphrase", "a new passphrase");
  assert.equal(phoneVerdict({ listed: null, opens: false }), "new-passphrase");
  assert.equal(phoneVerdict({ listed: null, opens: null }), "no-answer", "offline or failed: keep");
  assert.equal(phoneVerdict({ listed: true, opens: null }), "keep");
  assert.equal(phoneVerdict({ listed: null, opens: true }), "keep");
});

await ok("the check runs when PS app opens, then at most every 5 minutes", () => {
  assert.equal(PHONE_CHECK_MS, 5 * 60_000);
  assert.equal(checkDue(0, 1_000_000), true);
  assert.equal(checkDue(1_000_000, 1_000_000 + 60_000), false);
  assert.equal(checkDue(1_000_000, 1_000_000 + 60_000, true), true, "forced on open");
  assert.equal(checkDue(1_000_000, 1_000_000 + PHONE_CHECK_MS), true);
});

await ok("the exportable key the phone now derives is the same key: same login password, opens the same vault key", async () => {
  const pass = "amber-anchor-apple-arrow-atlas-autumn-42", iters = 1000;
  const vk = await C.importAesRaw(C.randomBytes(32), true);
  for (const [a, b] of [
    [await C.deriveFromPassphrase(pass, "jane", iters, false), await C.deriveFromPassphrase(pass, "jane", iters, true)],
    [await C.deriveForProject(pass, "abcdefghijklmnopqrst", iters, false), await C.deriveForProject(pass, "abcdefghijklmnopqrst", iters, true)],
    [await C.deriveForProjectWithHint(pass, "abcdefghijklmnopqrst", iters, false), await C.deriveForProjectWithHint(pass, "abcdefghijklmnopqrst", iters, true)],
  ] as const) {
    assert.equal(a.authPassword, b.authPassword);
    assert.equal(a.kek.extractable, false);
    assert.equal(b.kek.extractable, true);
    const wrapped = await C.wrapKey(a.kek, vk, C.aad.vk);
    await C.unwrapKey(b.kek, wrapped, C.aad.vk);
    // What the phone keeps (raw b64url) opens it after a restart, imported NON extractable as restorePhone does.
    const raw = C.b64url(new Uint8Array(await crypto.subtle.exportKey("raw", b.kek)));
    const back = await C.importAesRaw(C.unb64url(raw));
    assert.equal(back.extractable, false);
    await C.unwrapKey(back, wrapped, C.aad.vk);
  }
});

await ok("a new passphrase: the kept key no longer opens the vault key, the previous wrap still does mid change", async () => {
  const iters = 1000, vk = await C.importAesRaw(C.randomBytes(32), true);
  const oldD = await C.deriveFromPassphrase("old-old-old-old-old-old-1", "jane", iters, true);
  const newD = await C.deriveFromPassphrase("new-new-new-new-new-new-2", "jane", iters, true);
  const now = await C.wrapKey(newD.kek, vk, C.aad.vk), prev = await C.wrapKey(oldD.kek, vk, C.aad.vk);
  const opens = async (k: CryptoKey, ws: (string | null)[]) => { for (const w of ws) { if (!w) continue; try { await C.unwrapKey(k, w, C.aad.vk); return true; } catch { /* next */ } } return false; };
  assert.equal(await opens(oldD.kek, [now, prev]), true, "during the change wrapped_vk_prev still opens: keep");
  assert.equal(await opens(oldD.kek, [now, null]), false, "after it: the kept key is done");
  assert.equal(phoneVerdict({ listed: true, opens: await opens(oldD.kek, [now, null]) }), "new-passphrase");
});

await ok("the vault keeps a sign in only on the phone web app, never the website, PS on the Mac or PS GOS", () => {
  assert.match(V, /const MOBILE_PAGE = \(globalThis as \{ __psMobile\?: unknown \}\)\.__psMobile === true && !NATIVE;/);
  const u = fn("unlock");
  assert.match(u, /acctDerive\(passphrase, username, undefined, ps \|\| MOBILE_PAGE\)/);
  assert.match(u, /if \(kekRaw && MOBILE_PAGE\) \{ phoneCreds = \{ u: username\.trim\(\), a: d\.authPassword, k: kekRaw \}; if \(!offline\) void keepPhoneSignIn\(\); \}/);
  assert.match(fn("unlockPassphraseOnly"), /deriveForProjectWithHint\(passphrase, id, undefined, NATIVE \|\| MOBILE_PAGE\)/);
  assert.match(fn("keepNow"), /shouldKeep\(\{ mobilePage: MOBILE_PAGE, stay: stayOn\(\),/);
  assert.match(fn("phoneCheck"), /if \(!MOBILE_PAGE \|\| snap\.status !== "unlocked" \|\| !meta \|\| meta\.local \|\| !navigator\.onLine\) return;/);
  assert.match(fn("setPhoneStay"), /^export async function setPhoneStay\(on: boolean\): Promise<void> \{\n  if \(!MOBILE_PAGE\) return;/);
  // The Mac's own Remember me is unchanged.
  assert.match(u, /if \(ps && \(opts\.remember \?\? !derived\) && psRememberHook && kekRaw\)/);
  assert.match(V, /function holdLinkCreds\(username: string, auth: string, kek: string\) \{\n  if \(import\.meta\.env\.MODE === "ps"\) linkCreds/);
});

await ok("never the passphrase: only { u, a, k, d } reaches savePhoneKeys, and the held sign in has no passphrase", () => {
  const calls = [...V.matchAll(/savePhoneKeys\(PROJECT\.url, \{([^}]*)\}\)/g)].map((m) => m[1].split(",").map((s) => s.trim().split(":")[0].trim()));
  assert.equal(calls.length, 3, "the Mac's scan, Stay signed in, and a passphrase change on the phone");
  for (const keys of calls) assert.deepEqual(keys, ["u", "a", "k", "d"]);
  assert.equal([...V.matchAll(/savePhoneKeys\(/g)].length, 3, "those three calls, nothing else");
  for (const m of V.matchAll(/phoneCreds = \{([^}]*)\}/g)) {
    assert.deepEqual(m[1].split(",").map((s) => s.trim().split(":")[0].trim()), ["u", "a", "k"]);
    assert.ok(!/passphrase/i.test(m[1]), "no passphrase in what is held");
  }
  assert.match(read("src/core/phonekeys.ts"), /export interface PhoneKeys \{ u: string; a: string; k: string; d: string \}/, "the stored format is unchanged");
});

await ok("Lock, Remove on the Mac, a new passphrase, the switch off and Change project all end it", () => {
  assert.match(fn("lock"), /linkCreds = null; phoneDevice = null; phoneCreds = null;/, "Lock clears what is held");
  assert.match(fn("lockPhone"), /phoneDevice = null;\n  await forgetPhoneKeys\(PROJECT\.url\);/, "the phone's Lock forgets the keys");
  assert.match(read("src/gos/PhoneRows.tsx"), /if \(MWEB && phoneKept\(\)\) void lockPhone\(\);/, "the Lock row uses it on a kept phone");
  const pc = fn("phoneCheck");
  assert.match(pc, /if \(v !== "removed" && v !== "new-passphrase"\) return;\n  phoneDevice = null;\n  await forgetPhoneKeys\(PROJECT\.url\);/);
  assert.match(pc, /\n  lock\(\);\n\}$/);
  assert.match(pc, /\.from\("ps_devices"\)\.select\("id"\)\.eq\("id", d\)/, "Remove on the Mac");
  assert.match(pc, /\.from\("user_keys"\)\.select\("wrapped_vk, wrapped_vk_prev"\)/, "a new passphrase");
  const off = fn("setPhoneStay");
  assert.match(off, /setStay\(on\);\n  if \(on\) \{ await keepPhoneSignIn\(\); return; \}\n  const d = phoneDevice;\n  phoneDevice = null;\n  await forgetPhoneKeys\(PROJECT\.url\);/);
  assert.match(off, /\.from\("ps_devices"\)\.delete\(\)\.eq\("id", d\)/, "off takes the phone off the Mac's list");
  const so = fn("signOutAndForget");
  assert.match(so, /^export async function signOutAndForget\(\) \{\n  if \(meta\?\.local\) \{ lock\(\); return; \}/, "local first still keeps its data");
  assert.match(so, /if \(MOBILE_PAGE\) \{\n    await forgetPhoneKeys\(PROJECT\.url\);/);
  assert.ok(so.indexOf('.from("ps_devices").delete()') < so.indexOf("sb.auth.signOut()"), "the row goes while still signed in");
  assert.match(read("src/mobile/MobileSettings.tsx"), /signOutAndForget/, "Change project signs out with it");
  // A passphrase changed on the phone itself: it keeps the new keys instead of locking itself at the next check.
  const cp = fn("changePassphrase");
  assert.match(cp, /const d2 = await acctDerive\(newPass, username, undefined, MOBILE_PAGE\);/);
  assert.match(cp, /if \(MOBILE_PAGE && phoneCreds\) \{[\s\S]*phoneCreds = \{ u: phoneCreds\.u, a: d2\.authPassword, k \};[\s\S]*if \(phoneDevice\) await savePhoneKeys/);
  // restorePhone (a fresh open) still forgets keys a new passphrase made useless, and now checks both.
  const rp = fn("restorePhone");
  assert.match(rp, /wrong username or passphrase\|no vault keys/);
  assert.match(rp, /void phoneCheck\(true\);/);
});

await ok("when PS app comes back to the front: the check runs, and a kept phone never locks by itself", () => {
  assert.match(V, /function onVisible\(\) \{ if \(document\.visibilityState === "visible"\) \{ checkAutoLock\(\); void sync\(\); void phoneCheck\(\); \} \}/);
  assert.match(fn("checkAutoLock"), /if \(phoneDevice && MOBILE_PAGE\) return;/);
  assert.match(fn("keepNow"), /phoneDevice = d;/);
  assert.match(fn("phoneCheck"), /if \(!phoneDevice\) \{ if \(stayOn\(\) && phoneCreds\) void keepPhoneSignIn\(\); return; \}/, "signed in offline: kept once online");
  assert.match(fn("phoneCheck"), /if \(!session\) return;/, "no login: no verdict");
});

await ok("the row on the Mac's list comes first; no row, nothing kept; switched off or locked meanwhile, nothing kept", () => {
  const k = fn("keepNow");
  assert.ok(k.indexOf('insert({ kind: "phone" })') < k.indexOf("savePhoneKeys("), "row first");
  assert.match(k, /if \(!r \|\| r\.error \|\| !r\.data\) return false;/);
  assert.match(k, /if \(phoneCreds !== c \|\| !stayOn\(\)\) \{ await drop\(!reused\); return false; \}/);
  assert.match(k, /if \(phoneCreds !== c \|\| !stayOn\(\)\) \{ await forgetPhoneKeys\(PROJECT\.url\); await drop\(true\); return false; \}/);
  assert.match(k, /if \(old && old\.u === c\.u\)/, "the same phone reuses its row");
  assert.match(V, /st\.persist\(\)/, "asks iOS to keep the storage");
});

await ok("the switch: approved words, the phone web app only, beside Lock now, and visible in the public build", () => {
  const e = SETTINGS.find((x) => x.id === "mweb-stay")!;
  assert.ok(e);
  assert.equal(e.name, "Stay signed in");
  assert.equal(e.line, "PS app opens straight away with no passphrase, and never locks by itself.");
  assert.equal(e.shell, "mweb");
  assert.equal(e.group, "privacy");
  assert.ok(!e.red, "for everyone (public build too)");
  const ids = SETTINGS.map((x) => x.id);
  assert.equal(ids.indexOf("mweb-stay") + 1, ids.indexOf("phone-lock"), "right before Lock now");
  const MW: Ctx = { red: false, where: "phone", shell: "mweb" }, GOS: Ctx = { red: true, where: "phone", shell: "gos" }, MAC: Ctx = { red: true, where: "mac" };
  assert.ok(visibleTo(e, MW));
  assert.ok(!visibleTo(e, GOS) && !visibleTo(e, MAC));
  const rows = groupsFor(MW).flatMap((g) => { const r = rowsOf(g.id, MW); return [...r.main, ...r.more].map((x) => x.id); });
  assert.ok(rows.includes("mweb-stay"));
  const pr = read("src/gos/PhoneRows.tsx");
  assert.ok(pr.includes('"mweb-stay": function MwebStay'));
  assert.ok(pr.includes('"Your sign in stays on this phone. Lock, Remove on your Mac or a new passphrase ends it."'));
  assert.ok(pr.includes('"Your passphrase every time PS app opens, and it locks after a while unused."'));
  assert.ok(pr.includes("<Note>This phone stays signed in. Lock forgets that here, and your passphrase opens it again.</Note>"));
  assert.ok(!pr.includes("Signed in from your Mac:"));
  assert.ok(read("src/views/LinkPair.tsx").includes("<b>Phones that stay signed in</b>"));
  assert.match(read("src/core/phonekeys.ts"), /export async function savePhoneKeys\([^)]*\): Promise<void> \{\n  setStay\(true\);/, "a scan from the Mac turns the switch on");
});

await ok("no em or en dashes in the new code", () => {
  for (const f of ["src/core/phonestay.ts", "src/core/phonekeys.ts", "src/gos/PhoneRows.tsx", "src/views/LinkPair.tsx", "tests/phonestay.test.ts"]) assert.ok(!/[\u2013\u2014]/.test(read(f)), f);
});

console.log(`\n${n} passed`);
