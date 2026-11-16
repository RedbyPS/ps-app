// Run: node --experimental-strip-types tests/public-on.test.ts
// V1.62: every feature Jan made is on for everyone in the public G Squad build, each with its switch in Settings, From the
// squad (the developer, 15 Nov 2026: "Why isn't the emails panel still not in the g squad release???? COME ON MAN").
// What a friend runs today is the developer's own release: one build for everyone, made from his private tree with no assembled
// profile, carrying only `own` (vite.config.ts psBuild). Before 1.62 that build answered "off" for every one of Jan's 13
// features on a friend's account (core/features.ts whoFor(null, "other")), and Client emails was "default": "off".
// Here: a friend gets every one on, Client emails included; the email panel shows even before Gmail is connected, with a
// Connect Gmail prompt; a person's own Off still wins; the developer's own build is exactly as 1.61 left it; Numerology, PS Rules
// and Second Computer stay the developer's only.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const file = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const json = (p: string) => JSON.parse(file(p));

const F = await import("../src/core/features.ts");
const P = await import("../src/core/profile.ts");
const M = await import("../src/core/mailswitch.ts");
const W = await import("../src/core/waswitch.ts");
const E = await import("../src/core/mailempty.ts");
const A = await import("../src/core/account.ts");
const SR = await import("../src/core/screenrec.ts");

const core = json("core-root/features.json");
const layerProfile = json("ps-layer/profile.json");
const JAN = ["client-emails", "feature-intros", "fitness-island", "gsquad-island-reply", "gsquad-newlook", "gsquad-notify", "gym-scan-better", "island-moments",
  "remind-push", "remind-ring", "screen-recording", "welcome-back", "whatsapp", "workout-summary"];
// The release build as vite.config.ts makes it from the developer's private tree: no profile, core's list, the developer's `own`.
const releaseBuild = { profile: null, features: core, own: { othersShared: layerProfile.othersShared, features: layerProfile.features } };
// The G Squad build from GitHub, once friends switch to it (core-root/tools/assemble.mjs): the gsquad profile.
const gsquadBuild = { profile: json("core-root/profiles/gsquad.json"), features: core };
const friend = { status: "unlocked" as const, role: "owner" as const, primary: true };   // first owner of their own project

const answers = (account: "red" | "other" | null, mine?: Record<string, boolean>) => {
  F.setFeatureContext(account, mine);
  return F.featureAnswers(F.registry(), F.whoFor(P.profile(), account), mine);
};
const asBuild = (b: unknown, fn: () => void) => { P.setBuildForTests(b as never); try { fn(); } finally { P.setBuildForTests(undefined); } };

ok("Jan's 13 shared features are all in core's registry, every one defaults on", () => {
  const jans = F.cleanRegistry(core).filter((f) => f.owner === "jan");
  assert.deepEqual(jans.map((f) => f.id).sort(), JAN);
  for (const f of jans) { assert.equal(f.scope, "shared", f.id); assert.equal(f.default, "on", f.id); }
});

for (const [label, build] of [["today's public release (the developer's one build for everyone)", releaseBuild], ["the assembled G Squad build", gsquadBuild]] as const) {
  ok(`${label}: a friend gets every one of Jan's features on, Client emails on`, () => asBuild(build, () => {
    const a = answers("other");
    for (const id of JAN) assert.equal(a[id], true, id);
    for (const id of JAN) assert.equal(F.feature(id), true, `feature(${id})`);
    assert.equal(M.mailSwitch(undefined, "other"), true, "Client emails switch");
    assert.equal(M.mailOn(friend, M.mailSwitch(undefined, "other")), true, "the email panel and cards");
    assert.equal(W.waOn(friend, {}, "other"), true, "WhatsApp's place is there (nothing arrives until the number is linked)");
    assert.equal(a.campaigns, false, "core's own off features stay off");
    assert.equal(a["notebook-looks"], false);
  }));
  ok(`${label}: every one keeps its switch in Settings, From the squad, which says they start on`, () => asBuild(build, () => {
    const who = F.whoFor(P.profile(), "other");
    assert.deepEqual(F.squadList(F.registry(), who).map((f) => f.id).sort(), JAN);
    assert.equal(who.othersShared, "on", "so From the squad shows SQUAD_WORDS.startsOn");
    assert.equal(F.SQUAD_WORDS.startsOn, "Each one is on until you switch it off.");
  }));
  ok(`${label}: a person's own Off still wins, one feature at a time`, () => asBuild(build, () => {
    const mine = { "client-emails": false, whatsapp: false, "island-moments": false };
    const a = answers("other", mine);
    assert.equal(a["client-emails"], false);
    assert.equal(a.whatsapp, false);
    assert.equal(a["island-moments"], false);
    assert.equal(a["welcome-back"], true, "the ones they did not touch stay on");
    assert.equal(M.mailSwitch(mine, "other"), false);
    assert.equal(M.mailOn(friend, M.mailSwitch(mine, "other")), false, "no panel, no cards");
    assert.equal(W.waOn(friend, { squadFeatures: mine }, "other"), false);
    assert.equal(W.waOn(friend, { wa: { on: false } as never }, "other"), false, "WhatsApp messages switched off in WhatsApp settings");
  }));
}

ok("Client emails still only works for the first owner of their own project (mailCan)", () => asBuild(releaseBuild, () => {
  const on = M.mailSwitch(undefined, "other");
  assert.equal(M.mailOn({ ...friend, primary: false }, on), false, "an owner who joined by invite");
  assert.equal(M.mailOn({ ...friend, role: "client" as never }, on), false, "a client member");
  assert.equal(M.mailOn({ ...friend, status: "locked" as never }, on), false, "locked");
  assert.equal(M.mailOn({ status: "unlocked", role: "owner" }, on), false, "primary unknown");
}));

ok("before anyone is signed in, nobody else's feature runs (fails closed)", () => asBuild(releaseBuild, () => {
  const a = answers(null);
  for (const id of JAN) assert.equal(a[id], false, id);
  assert.deepEqual(F.whoFor(null, null), { name: "", othersShared: "off", overrides: {} });
}));

ok("The developer's own build stays as 1.61 left it: everything on, Client emails on, WhatsApp off", () => asBuild(releaseBuild, () => {
  const a = answers("red");
  for (const id of JAN) assert.equal(a[id], id !== "whatsapp", id);
  assert.equal(M.mailSwitch(undefined, "red"), true);
  assert.equal(W.waSwitch(undefined, "red"), false, "his profile keeps WhatsApp off");
  assert.equal(M.mailSwitch({ "client-emails": false }, "red"), false, "his own Off wins");
  assert.deepEqual(layerProfile.features, { "client-emails": true, whatsapp: false });
  assert.equal(layerProfile.rules.tabOverProtectedApps, false, "the 1Password and Signal rules are untouched");
  assert.equal(layerProfile.rules.islandOverProtectedApps, false);
}));

ok("Screen recording keeps its own opt in: on as a feature, nothing records until the person says yes", () => {
  assert.equal(SR.DEFAULT_CHOICES.enabled, false);
  const st = SR.cleanState({ type: "screenrec", featureOn: true, enabled: false });
  assert.ok(st);
  assert.equal(SR.buttonShows({ ps: true, docked: false, st }), false, "no record button until they switch it on");
  assert.equal(SR.settingsShows({ ps: true, st }), true, "its setup is offered in Settings");
});

ok("Numerology and PS Rules stay out of the public build; Second Computer is everyone's behind its switch (PS 1.65)", () => {
  for (const f of ["numerology", "rules"] as const) {
    assert.ok((A.RED_ONLY as readonly string[]).includes(f), f);
    assert.equal(A.canUse({ status: "unlocked", role: "owner", red: false }, f), false, `${f} on a friend's account`);
  }
  const ids = F.cleanRegistry(core).map((f) => f.id).join(" ");
  assert.doesNotMatch(ids, /numerology|rule/, "none of them is a feature a switch could turn on");
  assert.ok(!(A.RED_ONLY as readonly string[]).includes("secondComputer"), "Second Computer is not the developer only any more");
  assert.match(ids, /\bsecond-computer\b/, "Second Computer is a core feature with its own switch");
  const tm = file("src/views/TaskMap.tsx");
  assert.match(tm, /\{red && <Slot id="numerology"><Numerology /);
  assert.match(tm, /\{red && <Slot id="rules"><PsRuleButton /);
  assert.match(tm, /\{secondOnSnap\(s\) && <Slot id="second"><SecondButton /);
});

// ---------- the email panel with nothing in it ----------
ok("the panel's choice: emails, Connect Gmail, nothing new, or a moment's wait (never a flash of the prompt)", () => {
  assert.equal(E.mailPanelShows({ rows: 2, replied: 0, gmail: false, seen: false }), "list");
  assert.equal(E.mailPanelShows({ rows: 0, replied: 1, gmail: null, seen: false }), "list");
  assert.equal(E.mailPanelShows({ rows: 0, replied: 0, gmail: false, seen: false }), "connect", "no Gmail yet: the prompt");
  assert.equal(E.mailPanelShows({ rows: 0, replied: 0, gmail: true, seen: false }), "none");
  assert.equal(E.mailPanelShows({ rows: 0, replied: 0, gmail: null, seen: true }), "none", "the vault already holds emails: no need to ask");
  assert.equal(E.mailPanelShows({ rows: 0, replied: 0, gmail: null, seen: false }), "wait");
  assert.equal(E.gmailKnownFrom([{ account: "a" }], false), true);
  assert.equal(E.gmailKnownFrom([], false), false);
  assert.equal(E.gmailKnownFrom(null, false), false);
  assert.equal(E.gmailKnownFrom([{ account: "a" }], true), false, "a failed check shows the way to connect");
});

ok("the panel shows in the Tab list with the connect prompt, and Connect Gmail opens Settings, Client emails", () => {
  const tm = file("src/views/TaskMap.tsx");
  assert.match(tm, /\{\(mailOnSnap\(s\) \|\| waOnSnap\(s\)\) && <Slot id="mail">\{mailOnSnap\(s\) && <ClientMail s=\{s\} mail \/>\}/, "behind the Client emails switch only, not the developer's account");
  const body = tm.slice(tm.indexOf("function ClientMail("), tm.indexOf("// ---------- upcoming meetings"));
  assert.doesNotMatch(body, /if \(!list\.length && !replied\.length\) return null;/, "an empty panel no longer hides");
  assert.match(body, /const gmail = useGmailKnown\(empty && !seen && !gmailMail, gmailMail\);/, "Gmail is only asked about while the panel is empty and no Gmail mail has arrived");
  assert.match(body, /shows === "connect"/);
  assert.match(body, /openSettings\("notify", \{ jump: "client-emails" \}\); \}\}>\{MAIL_EMPTY_WORDS\.button\}<\/button>/);
  assert.match(body, /\{MAIL_EMPTY_WORDS\.connect\}/);
  assert.match(body, /\{MAIL_EMPTY_WORDS\.none\}/);
  assert.match(file("src/core/settingsindex.ts"), /\{ id: "client-emails", group: "notify", /, "the jump lands on a real row");
  assert.match(file("src/views/SettingsGroups.tsx"), /"client-emails": block\(\(\) => <ClientEmailsSettings compact \/>\)/);
  const ce = file("src/views/ClientEmailsSettings.tsx");
  assert.match(ce, /<CopyForAiChoice \/>/, "the Copy for your AI choice (two ways) leads the section");
  assert.match(ce, /<details className="stack tight ce-hand">/, "the old step guide is closed behind one small link");
  assert.match(ce, /\{AI_COPY_WORDS\.hand\}/);
  const hook = file("src/views/gmailknown.ts");
  assert.match(hook, /sb\.rpc\("gmail_status"\)/, "the same check as Settings, Gmail replies");
  assert.match(hook, /const KEEP_MS = 10 \* 60_000;/, "asked once per 10 minutes at most (egress)");
});

ok("the new words are plain, with no dashes, and say only what is true", () => {
  assert.deepEqual(E.MAIL_EMPTY_WORDS, { connect: "Connect your Gmail to see your clients' emails here.", button: "Connect Gmail", none: "No new client emails." });
  const ce = file("src/views/ClientEmailsSettings.tsx");
  assert.match(ce, /export const CE_LINE = "Show emails from your clients' Gmail and your Instantly replies as cards and in the email panel\. On until you switch it off\.";/);
  assert.doesNotMatch(ce, /Off until you switch it on/);
  assert.match(file("src/views/WhatsAppSettings.tsx"), /Reply to WhatsApp messages from PS\. Nothing shows until you link your number\./);
  for (const f of ["src/core/mailempty.ts", "src/views/gmailknown.ts", "src/views/ClientEmailsSettings.tsx", "src/core/features.ts", "src/core/mailswitch.ts", "src/core/waswitch.ts"]) {
    assert.doesNotMatch(file(f), /[–—]/, f);
  }
});

ok("WhatsApp for a friend with nothing linked: its place and the Link WhatsApp guide are in Settings", () => {
  const idx = file("src/core/settingsindex.ts");
  assert.match(idx, /\{ id: "whatsapp", group: "notify", name: "WhatsApp settings", [^\n]*mailCan: true,/, "offered to every first owner of their own project");
  const wa = file("src/views/WhatsAppSettings.tsx");
  assert.match(wa, /"Not linked"/);
  assert.match(wa, /onClick=\{\(\) => setGuide\(true\)\}>Link WhatsApp<\/button>/);
  assert.match(wa, /<WaGuide /);
  assert.match(wa, /const on = waSwitch\(st\.squadFeatures, waAccount\(s\)\) && p\.on !== false;/, "its switch shows the same answer as the panel");
});

ok("the Mac and the phone follow the page: a friend's answers go over as on", () => asBuild(releaseBuild, () => {
  const sync = file("src/featuresync.ts");
  assert.match(sync, /const on = featureAnswers\(registry\(\), whoFor\(profile\(\), account\), mine\);/);
  assert.match(sync, /post\(\{ type: "features", on \}\);/);
  const on = F.featureAnswers(F.registry(), F.whoFor(null, "other"), {});
  for (const id of ["island-moments", "welcome-back", "workout-summary", "feature-intros", "screen-recording", "remind-ring", "fitness-island"]) assert.equal(on[id], true, id);
}));

console.log(`${n} ok`);
