// Run: node --experimental-strip-types tests/public-controls.test.ts
// The developer, 7 Nov 2026: "I don't want any features to be in where you can't actually disable it". Anything that runs or
// shows for an account that is not the developer's must have its switch and settings visible on that account too. This reads
// the source (comments taken out) and fails when:
//  1. a control for a feature that runs for everyone sits behind `red &&` / `isRedAccount(...) &&`;
//  2. anything new is put behind a developer-only gate without being added to RED_GATED below with its reason
//     (so hiding a control is always a decision, never an accident);
//  3. a native feature PS starts for everyone (ps-mac main.swift, not inside Owner.whenRed) has its control hidden.
//     ps-mac is read from PS_MAC_DIR (default ~/Projects/ps/mac); skipped with a note when it is not there.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SRC = new URL("../src/", import.meta.url).pathname;
const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(tsx?)$/.test(f)) files.push(p); } };
walk(SRC);
const all = files.map((f) => ({ f: f.slice(SRC.length), t: strip(readFileSync(f, "utf8")) }));
let n = 0;
const ok = async (name: string, fn: () => unknown) => { await fn(); n++; console.log("ok -", name); };

// developer-only on purpose: (b) needs the developer's own accounts, keys or hardware, and the feature itself is off for anyone else;
// (c) the developer asked for it to stay out of the public PS.
const RED_GATED: Record<string, string> = {
  Numerology: "c: the developer asked", PsRuleButton: "c: the developer asked (PS rules)", RuleBookHost: "c: the developer asked (website rule book)", DockBtn: "c: phone Rules button",
  MorningBrief: "b: Morning brief from the developer's daily report (website Today)", YourNumbers: "c: the developer asked (Numerology on the website Today)",
  CampaignStats: "b: Instantly campaigns", BriefButton: "b: Morning brief from the developer's daily report",
  // Second Computer left this list in PS 1.65 (the developer, 16 Nov 2026: public, with its own switch, SecondSwitch below).
  ClientMail: "b: the developer's Gmail",
  ClientReplies: "b: the developer's Gmail", MatchField: "b: the developer's Gmail matching", GmailSettings: "b: the developer's Gmail", MailCardsWeb: "b: the developer's Gmail",
  NewTasks: "b: Telegram AT tasks and Claude suggestions", ClaudeAccess: "b: Claude's agent account", BgProblemCard: "b: the developer's background videos", GosAddVideoTile: "b: the developer's background videos",
  button: "c: phone Rule book menu item", p: "b: Invite owners note (the developer's project)", section: "b: Gmail replies, who emails me (the developer's Gmail)", div: "b: Add video for the developer's background videos",
};
// Controls of features that run for everyone, and where the feature runs.
const PUBLIC_CONTROLS: Record<string, string> = {
  MeetingsPeek: "the Meetings panel (meetings, reminders, private mode)", IslandSettingsWindow: "the Dynamic Island (src/island.ts, Island.swift), V1.58 its own window", IslandSettingsPage: "the same, Settings, Dynamic Island",
  MeetPrefsPanel: "meeting alerts and the notes pop-up (src/meetwatch.ts, src/notescard.ts)", DndButton: "Do Not Disturb (src/dnd.ts, DND.swift)",
  RemindSettings: "the Annoying 15 min reminders: Mac cards and phone notifications (Reminders.swift, ps-gos Remind.kt, V1.46)", GymReminder: "the gym reminder (src/gymwatch.ts)", AfkSettings: "the AFK timer (Afk.swift)",
  AysSettings: "Are you sure (AreYouSure.swift)", MiddleClickSettings: "middle click (MiddleClick.swift)", MixerButton: "the volume mixer (Mixer.swift)",
  NetButton: "the network monitor (NetMonitor.swift)", CalSwitch: "meetings from this Mac's Calendar (LocalCalendar.swift, src/calrefresh.ts; V1.43 its own row in Settings)", RebootCard: "auto reboot (AutoReboot.swift)", SecurityButton: "the Security panel",
  TypedPrioSwitch: "typed P1, P2, P3 in the add boxes (core/typedprio.ts)",
  TelegramBotSettings: "Add Telegram Bot: the key, Link my Telegram, Test, Remove, the rules (src/tgbot.ts, TelegramBot.swift, ps-gos TgBot.kt, V1.47)",
  HeadphonesSwitch: "Headphones mode and its auto switch (Headphones.swift, V1.40)",
  EditButton: "Edit mode: moved and removed panels (views/EditMode.tsx, G Squad)",
  IslandPlace: "the Dynamic Island's position on this Mac (Island.swift island.pos, G Squad)", IslandPosRow: "the same, in the island's own settings",
  IslandAwayRow: "Show it now while the island is away (right click > Disappear, V1.58)", IslandHideRow: "how long a click on the island's top line hides it (settings.island.hide, Island.swift, V1.40)",
  AutoResetSetting: "the automatic Reset and its time (core/resetday.ts, actions.ts maybeAutoReset, 8 Nov 2026)",
  SecondSwitch: "Second Computer's On/Off, Settings, Second Computer (the Mac's Second.setOn and the page's stopSecond, PS 1.65)",
  MediaGuardSettings: "the AirPods card (MediaGuard.swift, everyone's since V1.40)", AirPodsFix: "Give AirPods button back to Spotify (MediaGuard.swift reconfigure, V1.40)",
};
const GATE = /(?:\bred|isRedAccount\([^()]*(?:\([^()]*\))?[^()]*\))\s*&&\s*(?:import\.meta\.env\.MODE !== "gos"\s*&&\s*)?\(?\s*(?:<Slot id="[a-z0-9-]+">\s*)?<([A-Za-z]+)/g;   // through an Edit mode Slot (views/EditMode.tsx)

await ok("every developer-only gate in the web code is a listed decision", () => {
  const found = new Set<string>();
  for (const { f, t } of all) for (const m of t.matchAll(GATE)) {
    found.add(m[1]);
    assert.ok(m[1] in RED_GATED, `${f}: <${m[1]}> is hidden from everyone but the developer. Show it, or add it to RED_GATED with the reason (and make sure the feature itself is off for others)`);
  }
  assert.ok(found.size > 10, "the gate pattern still finds the gates");
});
await ok("the controls of features that run for everyone are on every account", () => {
  for (const [c, what] of Object.entries(PUBLIC_CONTROLS)) {
    const uses = all.filter(({ t }) => new RegExp(`<${c}\\b`).test(t));
    assert.ok(uses.length > 0, `${c} (${what}) is drawn somewhere`);
    assert.ok(!(c in RED_GATED), `${c} (${what}) is not the developer only`);
  }
});
await ok("the gym reminder runs for every owner and starts off for anyone but the developer", async () => {
  const g = all.find((x) => x.f === "gymwatch.ts")!.t;
  assert.match(g, /const unlocked = \(\) => \{ const s = vaultStore\.get\(\); return s\.status === "unlocked" && s\.role === "owner"; \};/);
  const G = await import("../src/core/gym.ts");
  assert.equal(G.gymPrefs({}, false).on, false);
  assert.equal(G.gymPrefs({}).on, true);                // The developer's, as before
  assert.equal(G.gymPrefs({ on: true }, false).on, true);
});

// Native: what main.swift starts for everyone needs its control shown; Owner.whenRed features may stay hidden.
const NATIVE: Record<string, string> = {
  Reminders: "RemindSettings", Afk: "AfkSettings", AreYouSure: "AysSettings", MiddleClick: "MiddleClickSettings", Mixer: "MixerButton",
  NetMonitor: "NetButton", AutoReboot: "RebootCard", MediaGuard: "MediaGuardSettings", AutoRoute: "AirPodsFix",
  HeadphonesMode: "HeadphonesSwitch", TelegramBot: "TelegramBotSettings", AutoApprove: "AutoApproveSettings",
};
const macDir = process.env.PS_MAC_DIR || join(homedir(), "Projects", "ps-mac");
const mainSwift = join(macDir, "Sources", "main.swift");
if (existsSync(mainSwift)) {
  await ok(`native features started for everyone have their controls shown (${macDir})`, () => {
    const m = strip(readFileSync(mainSwift, "utf8"));
    for (const [feature, control] of Object.entries(NATIVE)) {
      const starts = [...m.matchAll(new RegExp(`^.*\\b${feature}\\.shared\\.start\\(.*$`, "gm"))].map((x) => x[0]);
      assert.ok(starts.length > 0, `${feature} is started in main.swift`);
      const forAll = starts.some((l) => !/Owner\.whenRed/.test(l));
      if (forAll) assert.ok(!(control in RED_GATED), `${feature} runs for everyone but its control <${control}> is the developer only`);
    }
  });
} else console.log(`skip - native check: no ${mainSwift} (set PS_MAC_DIR)`);

await ok("the reminders' words: one line, trimmed, at most 80 characters; Settings shows them for everyone", async () => {
  const R = await import("../src/core/remind.ts");
  assert.equal(R.oneLine("  Have you taken the bins out?  ", R.REM_TEXT_MAX), "Have you taken the bins out?");
  assert.equal(R.oneLine("Line one\nline two\t!", R.REM_TEXT_MAX), "Line oneline two!");
  assert.equal(R.oneLine("x".repeat(300), R.REM_TEXT_MAX).length, 80);
  assert.equal(R.oneLine(42, R.REM_TEXT_MAX), "");
  assert.equal(R.oneLine("   ", R.REM_TEXT_MAX), "");
  const s = all.find((x) => x.f === "views/RemindSettings.tsx")!.t;
  assert.match(s, /maxLength=\{max\}/);
  assert.doesNotMatch(s, /dangerouslySetInnerHTML/);
  assert.match(all.find((x) => x.f === "views/PsSettings.tsx")!.t, /\n\s*<RemindSettings \/>/);
  assert.match(all.find((x) => x.f === "views/SettingsGroups.tsx")!.t, /<RemindSettings \/>/);
});
console.log(`public-controls: ${n} passed`);
