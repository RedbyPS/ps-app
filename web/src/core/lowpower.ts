// Low power mode (PS 1.65, feature "low-power"): one switch puts every background feed to sleep and keeps only the
// to-do list going (ticking, adding, editing, the Tab list, the Dynamic Island and vault sync, change only and slower).
// The owner's ask, 17 Nov 2026: "One switch that puts everything in the background to sleep and keeps only the to-do list
// going, so PS uses almost no battery, CPU or network." Later the same day: the island stays fully active, and the on/off
// button is a Slot in the Tab list's top right, next to Network.
//
// ============================== THE API (for every feed, including features still being built) ==============================
//
//   import { lowPower } from "./core/lowpower.ts";           // (from src/: "./core/lowpower")
//
//   1. Declare your feed once, at module load:
//        lowPower.register({ id: "activity", name: "Activity monitor", group: "system" });
//      ids are lowercase words with hyphens. The name is what the island's leaf and Settings list as asleep, so it is a
//      new on screen word (put it on your New words list). group "alarms" means it keeps running while the
//      "Keep reminders ringing" switch is on (alarms the person set: run only from data already on the device, no network).
//      The known feeds are already declared in FEEDS below; register() with a known id just returns it.
//
//   2. A repeating timer or poll: use every() instead of setInterval. It really stops while asleep (no wake ups at all),
//      starts again on wake, and gets ONE staggered catch up call on wake (never a burst of every feed at once):
//        const stop = lowPower.every("activity", 30_000, () => void pull());
//        lowPower.every("activity", 1000, redraw, { catchUp: false });   // a plain tick: no catch up call
//
//   3. Anything else (a setTimeout loop, a socket, a fetch on an event): ask before it runs, and catch up on wake:
//        if (lowPower.asleep("activity")) return;
//        lowPower.onWake("activity", () => void pull());   // one change only pull, staggered with the others
//
//   4. Watch the state (React: src/lowpower.ts useLowPower()):
//        lowPower.subscribe(() => { ... lowPower.state() ... });
//
//   5. Mac (Swift, mac/Sources/LowPower.swift, a mirror the page keeps current): LowPower.shared.asleep("activity"),
//      LowPower.shared.onChange { ... }, and LowPower.shared.every(id, seconds) { ... } on the main run loop.
//      Phone: the page's own lowPower; Battery Saver comes in through window.__psLowPowerOs (gos/bridge.ts).
//
//   Vault sync never sleeps. It asks lowPower.syncEvery(normalMs) for how often to look (slower while on).
//   Big animations: lowPower.simple() is true while on (src/lowpower.ts makes matchMedia report reduced motion and puts
//   lp-simple on <html>). The Dynamic Island keeps its own animations.
//
// ====================================================================================================================
// Pure: no DOM, no React. The clock and the timers are handed in (tests use a fake clock), the default instance uses
// globalThis's. Saving the per device choice (localStorage) is the app glue's job (src/lowpower.ts).

export type LpGroup = "squad" | "mail" | "system" | "looks" | "alarms";
export interface LpFeed {
  id: string; name: string; group: LpGroup;
  /** Runs only in the Mac app (the island and Settings elsewhere leave it out). */
  only?: "mac";
  /** Declared for a feature still being built, or one only the owner's own build has: left out of the lists until
   *  something registers it (register() with this id makes it listed). */
  later?: true;
}
export type LpWhy = "hand" | "mac" | "phone";
/** What the person chose, per device. auto*: turn on by itself with macOS Low Power Mode or Android Battery Saver. */
export interface LpPrefs { hand: boolean; autoMac: boolean; autoPhone: boolean; alarms: boolean }
export interface LpState {
  on: boolean;
  /** Why it is on: by hand wins over the system's own mode. Null while off. */
  why: LpWhy | null;
  /** The ids of every feed asleep right now (registered order). */
  asleep: string[];
  prefs: LpPrefs;
  /** The system's own battery mode right now (macOS Low Power Mode, Android Battery Saver). */
  os: { mac: boolean; phone: boolean };
  /** Feeds still waiting for their catch up after a wake. */
  catching: number;
}

export const LP_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DEFAULT_PREFS: LpPrefs = { hand: false, autoMac: true, autoPhone: true, alarms: true };
/** Between two catch up calls after a wake. Twenty feeds take about half a minute, one at a time. */
export const STAGGER_MS = 1500;
/** The first catch up waits a moment, so the wake click itself stays smooth. */
export const FIRST_CATCH_MS = 800;
/** Vault sync while on: at most this often (the owner: "on open and every few minutes"). */
export const SLOW_SYNC_MS = 4 * 60_000;

/** Every background feed in core today. A feature on another branch adds its own with register(). */
export const FEEDS: LpFeed[] = [
  { id: "gsquad", name: "G Squad presence", group: "squad" },
  { id: "squad-chat", name: "Squad chat", group: "squad" },
  { id: "squad-dms", name: "Direct messages", group: "squad" },
  { id: "squad-board", name: "Leaderboard", group: "squad" },
  { id: "squad-gym", name: "Gym board", group: "squad" },
  { id: "squad-p1", name: "Squad Priority 1", group: "squad" },
  { id: "squad-notify", name: "Squad notifications", group: "squad" },
  { id: "squad-join", name: "Join requests", group: "squad" },
  { id: "squad-auto", name: "Squad auto share", group: "squad" },
  { id: "gmail", name: "Gmail", group: "mail" },
  { id: "instantly", name: "Instantly", group: "mail", later: true },
  { id: "proton", name: "Proton Mail", group: "mail", only: "mac" },
  { id: "campaigns", name: "Campaigns", group: "mail", later: true },
  { id: "mail-cards", name: "Email cards", group: "mail" },
  { id: "telegram", name: "Telegram bot", group: "mail" },
  { id: "calendar", name: "Calendar refresh", group: "system" },
  { id: "updates", name: "Update checks", group: "system" },
  { id: "second", name: "Second Computer", group: "system", only: "mac" },
  { id: "net", name: "Network monitor", group: "system", only: "mac" },
  { id: "mixer", name: "Volume mixer", group: "system", only: "mac" },
  { id: "activity", name: "Activity monitor", group: "system", only: "mac", later: true },
  { id: "screentime", name: "Screen time", group: "system", only: "mac" },
  { id: "assistant", name: "Settings assistant", group: "system", later: true },
  { id: "receipts", name: "Purchases sync", group: "system", later: true },
  { id: "history", name: "History snapshots", group: "system" },
  { id: "fitness", name: "Fitness sync", group: "system" },
  { id: "devices", name: "Device status", group: "system" },
  { id: "checks", name: "Self checks", group: "system" },
  { id: "backgrounds", name: "Background videos and lightning", group: "looks" },
  { id: "alarms", name: "Alarms and reminders", group: "alarms" },
];

/** A saved choice, checked: anything odd falls back to the default, field by field. */
export function cleanPrefs(v: unknown): LpPrefs {
  const o = v && typeof v === "object" ? v as Record<string, unknown> : {};
  const b = (k: keyof LpPrefs) => (typeof o[k] === "boolean" ? o[k] as boolean : DEFAULT_PREFS[k]);
  return { hand: b("hand"), autoMac: b("autoMac"), autoPhone: b("autoPhone"), alarms: b("alarms") };
}

/** On or off, and why. By hand first, then the Mac's Low Power Mode, then Battery Saver, each only with its switch. */
export function decide(p: LpPrefs, os: { mac: boolean; phone: boolean }, featureOn = true): { on: boolean; why: LpWhy | null } {
  if (!featureOn) return { on: false, why: null };
  if (p.hand) return { on: true, why: "hand" };
  if (p.autoMac && os.mac) return { on: true, why: "mac" };
  if (p.autoPhone && os.phone) return { on: true, why: "phone" };
  return { on: false, why: null };
}

/** Is this feed asleep in this state? Alarms keep going while their switch is on. Unknown feeds sleep. */
export function feedAsleep(on: boolean, prefs: LpPrefs, feed: LpFeed | undefined): boolean {
  if (!on) return false;
  // PS 1.65 (the developer): screen time keeps counting in Low power mode. It stays on the Mac and uses no network.
  if (feed?.id === "screentime") return false;
  if (feed?.group === "alarms") return !prefs.alarms;
  return true;
}

/** The plain names of what is asleep, for the island and Settings: only feeds that run here (`mac`: the Mac app). */
export function asleepNames(st: LpState, feeds: readonly LpFeed[], mac = true): string[] {
  const by = new Map(feeds.map((f) => [f.id, f]));
  return st.asleep.map((id) => by.get(id)).filter((f): f is LpFeed => !!f && !f.later && (mac || f.only !== "mac")).map((f) => f.name);
}

/** One line for Settings and the island: "Asleep: Gmail, Squad chat and 12 more". */
export function asleepLine(names: string[], max = 3): string {
  if (!names.length) return "Nothing is asleep";
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  if (rest > 0) return `Asleep: ${shown.join(", ")} and ${rest} more`;
  if (shown.length === 1) return `Asleep: ${shown[0]}`;
  return `Asleep: ${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}
const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

interface Every { feed: string; ms: number; fn: () => void; catchUp: boolean; handle: unknown; stopped: boolean }
interface Hook { feed: string; fn: () => void; gone: boolean }

export interface LowPower {
  register(f: LpFeed): LpFeed;
  feeds(): LpFeed[];
  asleep(id: string): boolean;
  on(): boolean;
  simple(): boolean;
  state(): LpState;
  subscribe(fn: () => void): () => void;
  every(id: string, ms: number, fn: () => void, opts?: { catchUp?: boolean }): () => void;
  onWake(id: string, fn: () => void): () => void;
  syncEvery(normalMs: number): number;
  /** The person's own choice (Settings, the Tab list's button, the island's Wake everything). */
  setPrefs(p: Partial<LpPrefs>): void;
  setOs(kind: "mac" | "phone", on: boolean): void;
  /** Feature switch (features.json "low-power"): off means never on. */
  setFeature(on: boolean): void;
  /** The island's and Settings' Wake everything: by hand off, and the system's mode ignored until it changes. */
  wakeAll(): void;
  /** How many timers this instance holds right now (tests). */
  liveTimers(): number;
}

export function createLowPower(clock: Clock = realClock, start?: { prefs?: Partial<LpPrefs>; os?: { mac?: boolean; phone?: boolean } }): LowPower {
  const feeds = new Map<string, LpFeed>(FEEDS.map((f) => [f.id, f]));
  let prefs: LpPrefs = cleanPrefs({ ...DEFAULT_PREFS, ...(start?.prefs ?? {}) });
  const os = { mac: !!start?.os?.mac, phone: !!start?.os?.phone };
  /** Wake everything while the system's mode is on: that mode is ignored until it goes off and on again. */
  const ignoreOs = { mac: false, phone: false };
  let featureOn = true;
  const subs = new Set<() => void>();
  const everys: Every[] = [];
  const hooks: Hook[] = [];
  let queue: { feed: string; fn: () => void }[] = [];
  let queueTimer: unknown = null;
  let cur = compute();

  function compute(): LpState {
    const d = decide(prefs, { mac: os.mac && !ignoreOs.mac, phone: os.phone && !ignoreOs.phone }, featureOn);
    const asleep = [...feeds.values()].filter((f) => feedAsleep(d.on, prefs, f)).map((f) => f.id);
    return { on: d.on, why: d.why, asleep, prefs: { ...prefs }, os: { ...os }, catching: queue.length };
  }
  const isAsleep = (id: string) => feedAsleep(cur.on, prefs, feeds.get(id) ?? { id, name: id, group: "system" });

  function arm(e: Every) {
    if (e.stopped || e.handle !== null || isAsleep(e.feed)) return;
    e.handle = clock.setInterval(() => { if (!isAsleep(e.feed)) e.fn(); }, e.ms);
  }
  function disarm(e: Every) {
    if (e.handle === null) return;
    clock.clearInterval(e.handle);
    e.handle = null;
  }
  function stopQueue() {
    if (queueTimer !== null) clock.clearTimeout(queueTimer);
    queueTimer = null;
    queue = [];
  }
  function runQueue() {
    queueTimer = null;
    const job = queue.shift();
    if (!job) return;
    if (!isAsleep(job.feed)) { try { job.fn(); } catch { /* one feed's catch up never stops the others */ } }
    if (queue.length) queueTimer = clock.setTimeout(runQueue, STAGGER_MS);
    tell();
  }

  const key = (s: LpState) => JSON.stringify([s.on, s.why, s.asleep, s.prefs, s.os]);
  function tell() {
    cur = { ...cur, catching: queue.length };
    for (const f of [...subs]) { try { f(); } catch { /* a listener's error is its own */ } }
  }

  function changed() {
    const before = cur;
    cur = compute();
    const woke = new Set(before.asleep.filter((id) => !cur.asleep.includes(id)));
    // Timers: off for what fell asleep, on again for what woke.
    for (const e of everys) { if (isAsleep(e.feed)) disarm(e); else arm(e); }
    if (cur.on && !before.on) stopQueue();   // back asleep before every catch up ran: the rest waits for the next wake
    if (woke.size) {
      // One catch up per registration, in the order feeds were declared, one at a time.
      const order = [...feeds.keys()];
      const jobs: { feed: string; fn: () => void }[] = [];
      for (const e of everys) if (!e.stopped && e.catchUp && woke.has(e.feed)) jobs.push({ feed: e.feed, fn: e.fn });
      for (const h of hooks) if (!h.gone && woke.has(h.feed)) jobs.push({ feed: h.feed, fn: h.fn });
      jobs.sort((a, b) => order.indexOf(a.feed) - order.indexOf(b.feed));
      const queued = new Set(queue.map((q) => q.fn));
      for (const j of jobs) if (!queued.has(j.fn)) queue.push(j);
      if (queue.length && queueTimer === null) queueTimer = clock.setTimeout(runQueue, FIRST_CATCH_MS);
    }
    if (key(before) !== key(cur)) tell();
  }

  return {
    register(f) {
      const have = feeds.get(f.id);
      if (have) {
        if (have.later) { const live: LpFeed = { ...have }; delete live.later; feeds.set(f.id, live); tell(); return live; }
        return have;
      }
      if (!LP_ID_RE.test(f.id)) throw new Error(`low power: bad feed id ${f.id}`);
      const clean: LpFeed = { id: f.id, name: String(f.name || f.id).slice(0, 40), group: f.group, ...(f.only === "mac" ? { only: "mac" as const } : {}) };
      feeds.set(f.id, clean);
      changed();
      return clean;
    },
    feeds: () => [...feeds.values()],
    asleep: isAsleep,
    on: () => cur.on,
    simple: () => cur.on,
    state: () => cur,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    every(id, ms, fn, opts) {
      const e: Every = { feed: id, ms: Math.max(50, ms), fn, catchUp: opts?.catchUp !== false, handle: null, stopped: false };
      everys.push(e);
      arm(e);
      return () => { e.stopped = true; disarm(e); const i = everys.indexOf(e); if (i >= 0) everys.splice(i, 1); queue = queue.filter((q) => q.fn !== fn || everys.some((x) => x.fn === fn)); };
    },
    onWake(id, fn) {
      const had = hooks.find((x) => x.feed === id && x.fn === fn);   // the same hook asked again (every skipped run): once
      if (had) return () => { had.gone = true; const i = hooks.indexOf(had); if (i >= 0) hooks.splice(i, 1); };
      const h: Hook = { feed: id, fn, gone: false };
      hooks.push(h);
      return () => { h.gone = true; const i = hooks.indexOf(h); if (i >= 0) hooks.splice(i, 1); };
    },
    syncEvery: (ms) => (cur.on ? Math.max(ms, SLOW_SYNC_MS) : ms),
    setPrefs(p) {
      const next = cleanPrefs({ ...prefs, ...p });
      if (p.hand === true) { ignoreOs.mac = false; ignoreOs.phone = false; }
      prefs = next;
      changed();
    },
    setOs(kind, on) {
      if (os[kind] === on) return;
      os[kind] = on;
      ignoreOs[kind] = false;   // the system's mode changed: a fresh start for it
      changed();
    },
    setFeature(on) { if (featureOn === on) return; featureOn = on; changed(); },
    wakeAll() {
      prefs = { ...prefs, hand: false };
      if (os.mac) ignoreOs.mac = true;
      if (os.phone) ignoreOs.phone = true;
      changed();
    },
    liveTimers: () => everys.filter((e) => e.handle !== null).length + (queueTimer !== null ? 1 : 0),
  };
}

/** The one instance the app uses (the main page on the Mac, the website, the phone). */
export const lowPower: LowPower = createLowPower();

// ---------- drop in for setInterval and clearInterval (existing code keeps its number handles) ----------
const handles = new Map<number, () => void>();
let nextHandle = 1;
/** Like setInterval(fn, ms), for the feed `id`: really stops while it is asleep, one catch up on wake. */
export function lpInterval(id: string, fn: () => void, ms: number, opts?: { catchUp?: boolean }, lp: LowPower = lowPower): number {
  const h = nextHandle++;
  handles.set(h, lp.every(id, ms, fn, opts));
  return h;
}
/** Like clearInterval for a handle from lpInterval (undefined is fine). */
export function lpClear(h: number | undefined): void {
  if (h === undefined) return;
  const stop = handles.get(h);
  if (stop) { handles.delete(h); stop(); }
}
