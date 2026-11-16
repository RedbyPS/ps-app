// Run: node --experimental-strip-types tests/settingsindex.test.ts
// V1.43 Settings search and side menu (core/settingsindex.ts). The developer, 8 Nov 2026: "Add a search bar and a settings menu so
// you can search for settings."
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GROUPS, SETTINGS, groupById, groupsFor, landingOf, norm, rowsOf, searchSettings, settingById, stem, visibleTo, type Ctx } from "../src/core/settingsindex.ts";

let n = 0;
const ok = (name: string, fn: () => void) => { fn(); n++; console.log("ok -", name); };
const RED_MAC: Ctx = { red: true, where: "mac", pf: true, ck: true }, FRIEND_MAC: Ctx = { red: false, where: "mac", pf: true, ck: true };
const FRIEND_WEB: Ctx = { red: false, where: "web", pf: true, ck: true }, PHONE: Ctx = { red: false, where: "phone", shell: "gos" };
const ids = (q: string, ctx: Ctx) => searchSettings(q, ctx).map((h) => h.e.id);
const first = (q: string, ctx: Ctx) => ids(q, ctx)[0];

ok("ids are unique, every entry has a name, one plain line and a known group", () => {
  const seen = new Set<string>();
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const e of SETTINGS) {
    assert.ok(!seen.has(e.id), `duplicate ${e.id}`); seen.add(e.id);
    assert.ok(groups.has(e.group), `${e.id}: group ${e.group}`);
    assert.ok(e.name.length > 1 && e.name.length <= 44, `${e.id}: a short name`);
    assert.ok(e.line.length > 10 && e.line.length < 110, `${e.id}: one plain line (${e.line.length})`);
    assert.ok(/[.!?]$/.test(e.line), `${e.id}: the line is a sentence`);
    if (e.parent) assert.ok(settingById(e.parent), `${e.id}: parent ${e.parent} exists`);
    if (e.go === "vault") assert.ok(e.anchor, `${e.id}: a vault setting names its heading`);
  }
});
ok("no em or en dashes anywhere in the words", () => {
  const src = readFileSync(new URL("../src/core/settingsindex.ts", import.meta.url), "utf8");
  assert.ok(!/[–—]/.test(src));
});
ok("the words the developer gave find their setting first", () => {
  assert.equal(first("sound", FRIEND_MAC), "sounds");
  assert.equal(first("reset", FRIEND_MAC), "auto-reset");
  assert.equal(first("transparency", FRIEND_MAC), "transparency");
  assert.equal(first("AFK", FRIEND_MAC), "afk");
  assert.equal(first("time zone", FRIEND_MAC), "home-tz");
});
ok("names match, and so does the start of a word", () => {
  assert.equal(first("tick sound", FRIEND_MAC), "tick-sound");
  assert.equal(first("dynamic isl", FRIEND_MAC), "island");
  assert.equal(first("Completed keeps", FRIEND_MAC), "completed-keep");
  assert.equal(first("airpods", FRIEND_MAC), "airpods");
});
ok("the one line is searched too", () => {
  assert.ok(ids("spotlight", FRIEND_MAC).includes("app-name"), "app name says Spotlight in its line");
  assert.ok(ids("scoreboard", FRIEND_MAC).includes("ignored-apps"));
  assert.ok(ids("downpour", FRIEND_MAC).includes("rain-amount"));
});
ok("other words for a setting (synonyms) find it", () => {
  assert.equal(first("dark mode", FRIEND_MAC), "look");
  assert.equal(first("wallpaper", FRIEND_MAC), "background");
  assert.equal(first("vpn", FRIEND_MAC), "network");
  assert.equal(first("glass", FRIEND_MAC), "transparency");
  assert.equal(first("dnd", FRIEND_MAC), "dnd");
  assert.equal(first("trackpad", FRIEND_MAC), "middle-click");
  assert.equal(first("midnight", FRIEND_MAC), "auto-reset");
  assert.ok(ids("password", FRIEND_WEB).includes("passphrase"));
  assert.ok(ids("vibration", PHONE).includes("phone-haptics"));
});
ok("plurals, case and spaces do not matter", () => {
  assert.equal(stem("sounds"), "sound");
  assert.equal(stem("colours"), "colour");
  assert.equal(norm("  Time   Zone! "), "time zone");
  assert.deepEqual(ids("SOUNDS", FRIEND_MAC).slice(0, 2), ids("sound", FRIEND_MAC).slice(0, 2));
  assert.equal(first("timezone", FRIEND_MAC), "home-tz");
});
ok("every typed word must match; nothing typed or only small words finds nothing", () => {
  assert.deepEqual(searchSettings("", FRIEND_MAC), []);
  assert.deepEqual(searchSettings("   ", FRIEND_MAC), []);
  assert.deepEqual(searchSettings("the my", FRIEND_MAC), []);
  assert.deepEqual(searchSettings("zzqx", FRIEND_MAC), []);
  assert.ok(!ids("tick xylophone", FRIEND_MAC).length);
});
ok("Fitness and Sleep settings are found from the main search and open their screens", () => {
  const rest = searchSettings("rest timer", FRIEND_MAC)[0].e;
  assert.equal(rest.id, "fit-rest");
  assert.equal(rest.go, "fitness");
  assert.equal(first("gym reminder", PHONE), "gym-reminder");
  // V1.47: Sleep mode's settings are its own full screen; the search here still finds each one and opens it there.
  assert.equal(first("alarm", FRIEND_MAC), "sleep.alarms");
  assert.equal(landingOf(settingById("sleep.alarms")!).id, "sleep-settings");
  assert.equal(searchSettings("clock size", FRIEND_MAC)[0].e.id, "sleep.size");
  assert.equal(searchSettings("clock size", FRIEND_MAC)[0].e.go, "sleepSettings");
  assert.equal(first("sleep log", FRIEND_MAC), "sleep.goal");
});
ok("the V1.43 merge's new settings are found: reset time, clock names, sharing, money, wake styles, clock face, focus modes", () => {
  for (const c of [FRIEND_MAC, FRIEND_WEB, PHONE]) {
    assert.ok(ids("reset time", c).includes("auto-reset"), "reset time");
    assert.ok(ids("rename clock", c).includes("tz-names"), "clock names");
    assert.ok(ids("task sharing", c).includes("gs-share"), "task sharing");
    assert.ok(ids("money", c).includes("gs-money"), "money");
    assert.ok(ids("sunrise", c).includes("sleep.styles"), "wake styles");
    assert.ok(ids("nap", c).includes("sleep.wake-in"), "wake me up in");
    assert.ok(ids("analogue", c).includes("sleep.face"), "clock face");
    assert.ok(ids("focus mode", c).includes("dnd"), "focus modes");
  }
  assert.equal(landingOf(settingById("sleep.styles")!).id, "sleep-settings");
  assert.equal(settingById("gs-money")!.go, "gsquad");
});
ok("The developer only settings stay hidden from friends, in search, in the menu and on the pages", () => {
  for (const q of ["gmail", "invite", "claude access"]) {
    assert.ok(!ids(q, FRIEND_MAC).some((id) => settingById(id)!.red), `${q}: nothing the developer only for a friend on a Mac`);
    assert.ok(!ids(q, FRIEND_WEB).some((id) => settingById(id)!.red), `${q}: nothing the developer only for a friend on the web`);
  }
  const secondHere = visibleTo(settingById("second")!, RED_MAC);   // false only where Second Computer's code is a placeholder (the public core)
  if (secondHere) assert.equal(first("second computer", RED_MAC), "second");
  assert.ok(ids("gmail", { red: false, where: "mac", mail: true }).includes("gmail-replies"), "Client emails on: Who emails me shows, for anyone");
  assert.ok(!ids("gmail", FRIEND_MAC).includes("gmail-replies"));
  for (const g of GROUPS) for (const ctx of [FRIEND_MAC, FRIEND_WEB, PHONE]) {
    const r = rowsOf(g.id, ctx);
    assert.ok([...r.main, ...r.more].every((e) => !e.red), `${g.id}: no the developer only row for a friend`);
  }
  if (secondHere) assert.ok(rowsOf("sync", RED_MAC).main.some((e) => e.id === "second"));
  // V1.47: the phone sheet's two the developer only pieces became rows: Your Macs (through Second Computer) and his own videos.
  // V1.55: Sign in your phone is the the developer's project twin of Link your iPhone (friends get the same sign in from that row).
  assert.equal(SETTINGS.filter((e) => e.red).length, 4, "the the developer only list is a decision: invite, claude-access, phone-videos, mac-phone-signin");
  // PS 1.65: Second Computer is everyone's on a Mac (its row holds its On/Off); the phone's Your Macs shows once it is on.
  assert.ok(!settingById("second")!.red, "Second Computer's row (its On/Off) is not the developer only");
  assert.ok(settingById("phone-macs")!.second && !settingById("phone-macs")!.red);
  assert.ok(SETTINGS.some((e) => e.id === "link-iphone" && !e.red), "friends keep Link your iPhone, which signs the phone in too");
});
ok("Meetings from this Mac's Calendar is everyone's but the developer's (his come from Google)", () => {
  assert.ok(ids("calendar", FRIEND_MAC).includes("calendar"));
  assert.ok(!ids("calendar", RED_MAC).includes("calendar"));
});
ok("Mac only settings never show on the website or phone, phone ones only on the phone", () => {
  assert.ok(!ids("transparency", FRIEND_WEB).length);
  assert.ok(!ids("afk", PHONE).length);
  assert.ok(!groupsFor(FRIEND_WEB).some((g) => g.id === "keys" || g.id === "mac" || g.id === "phone"));
  assert.ok(groupsFor(PHONE).some((g) => g.id === "phone"));
  assert.ok(!ids("haptics", FRIEND_MAC).length);
  assert.ok(visibleTo(settingById("passphrase")!, FRIEND_WEB) && !visibleTo(settingById("passphrase")!, FRIEND_MAC));
});
ok("the side menu has the developer's groups in order, each with something in it", () => {
  const mac = groupsFor(FRIEND_MAC).map((g) => g.id);
  assert.deepEqual(mac, ["about", "friend", "list", "controls", "assistant", "looks", "notify", "remind", "chkremind", "telegram", "api", "time", "shortcuts", "keys", "island", "mac", "sync", "privacy", "fitness", "pomodoro", "standup", "posture", "sleep", "sentry", "gsquad"]);   // V1.58: the Dynamic island, Pomodoro timer and Stand-up reminders, tabs of their own
  for (const ctx of [FRIEND_MAC, FRIEND_WEB, PHONE, RED_MAC]) for (const g of groupsFor(ctx)) {
    const r = rowsOf(g.id, ctx);
    assert.ok(r.main.length > 0, `${ctx.where} ${g.id}: a row before More`);
  }
});
ok("the Posture Reminder tab and its rows hide where the feature is off", () => {
  assert.ok(groupsFor(FRIEND_MAC).some((g) => g.id === "posture"));
  const off: Ctx = { red: false, where: "mac" };
  assert.ok(!groupsFor(off).some((g) => g.id === "posture"));
  assert.ok(!visibleTo(settingById("posture-on")!, off) && visibleTo(settingById("posture-on")!, FRIEND_MAC));
});
ok("the Checklist Reminder tab and its rows hide where the feature is off", () => {
  assert.ok(groupsFor(FRIEND_MAC).some((g) => g.id === "chkremind"));
  const off: Ctx = { red: false, where: "mac" };
  assert.ok(!groupsFor(off).some((g) => g.id === "chkremind"));
  assert.ok(!visibleTo(settingById("chk-on")!, off) && visibleTo(settingById("chk-on")!, FRIEND_MAC));
});
ok("Add Telegram Bot (V1.47) is a group of its own for everyone, on every device, and search finds it", () => {
  for (const ctx of [FRIEND_MAC, FRIEND_WEB, PHONE, RED_MAC]) {
    const g = groupsFor(ctx).find((x) => x.id === "telegram");
    assert.equal(g?.label, "Add Telegram Bot", ctx.where);
    assert.deepEqual(rowsOf("telegram", ctx).main.map((e) => e.id), ["telegram-bot"]);
  }
  for (const q of ["telegram", "botfather", "bot key"]) assert.equal(landingOf(searchSettings(q, FRIEND_WEB)[0].e).id, "telegram-bot", q);
});
ok("More holds the rare ones, and a piece drawn inside a row is not a row of its own", () => {
  const list = rowsOf("list", FRIEND_MAC);
  assert.ok(list.more.some((e) => e.id === "typed-prio") && !list.main.some((e) => e.id === "typed-prio"));
  const sleep = rowsOf("sleep", FRIEND_MAC);
  // V1.47: one line and a button, like Security; every Sleep setting is inside it.
  assert.deepEqual([...sleep.main, ...sleep.more].map((e) => e.id), ["sleep-settings"]);
  assert.equal(groupById("sleep").line, "Sleep mode has its own settings");
  assert.equal(settingById("sleep-settings")!.go, "sleepSettings");
});
ok("a search hit says its section, and the row comes before a piece inside it when both match", () => {
  const h = searchSettings("sleep mode", FRIEND_MAC);
  assert.equal(h[0].e.id, "sleep-settings");
  assert.ok(h.every((x) => GROUPS.some((g) => g.id === x.e.group)));
});
ok("the Settings screen draws every row it lists (a control or an Open button)", () => {
  // V1.47: the phone's own rows have their controls in gos/PhoneRows.tsx (spread into CONTROLS).
  const groups = readFileSync(new URL("../src/views/SettingsGroups.tsx", import.meta.url), "utf8") + readFileSync(new URL("../src/gos/PhoneRows.tsx", import.meta.url), "utf8");
  assert.match(groups, /\.\.\.PHONE_CONTROLS,/);
  for (const e of SETTINGS) {
    if (e.parent || e.go) continue;
    assert.ok(new RegExp(`["']?${e.id.replace(/-/g, "\\-")}["']?\\s*:`).test(groups), `${e.id} has a control in SettingsGroups.tsx or PhoneRows.tsx`);
  }
});
console.log(`settingsindex: ${n} passed`);
ok("AI task API: its own group on the Mac only, and search finds it by the words people use", () => {
  assert.ok(groupsFor(FRIEND_MAC).some((g) => g.id === "api"));
  assert.ok(!groupsFor(FRIEND_WEB).some((g) => g.id === "api") && !groupsFor(PHONE).some((g) => g.id === "api"));
  for (const q of ["api", "claude code", "codex", "copy for ai", "api key"]) assert.ok(searchSettings(q, FRIEND_MAC).slice(0, 3).some((h) => h.e.group === "api"), q);
});
