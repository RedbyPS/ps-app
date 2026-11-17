// G Squad (V1.40) on the page that holds the vault (PS's main page on the Mac, the phone app's page). The Tab list
// holds no keys; it gets squadView() inside the state it already receives and sends its buttons back as a
// `squadOp` (squad/view.ts). Nothing here blocks: every hub call is async with a 20 s limit, all off the native
// main thread (this is the web page's own event loop).
//
// Egress (the hub is on Supabase's free plan): only changes are read and written.
//   working status  a beat every 3 minutes while PS runs (Working status switched on), answer about 60 bytes;
//                   it also says how many are working, hand overs waiting and the key gen, so the button needs nothing more
//   the pop-up      one pull when it opens, then every 20 s while it stays open, each pull only rows changed since the last
//   your tasks      4 s after a change, only the tasks whose sealed copy changed (fingerprint), in batches of 100
//   closed          no pulls at all; a peek at the count when the Tab list shows, at most once a minute when no beat runs
import { docs, put, remove, vaultStore } from "../core/vault";
import { addTodo, saveSettings, updateTodo } from "../core/actions";
import { settingsData } from "../core/select";
import type { ClientRec, Doc, Todo } from "../core/model";
import { cleanSquadRec, currentKey, keyFor, type SquadRec } from "../core/squadrec";
import { cleanShareOpts, planTaskSync, shareOn, taskShared } from "../core/squadshare";
import { clientTerms, squadTitle } from "../core/squadanon";
import { HubError, type HubApi, type HubMemberRow, type Pulse, type Since } from "./hub";
import { apiFor, handTask, handView, joinSquad, makeInvite, memberView, refreshCard, rekeyIfNeeded, renameMe, renameSquad, squadName, takeDrops, taskView, type HandView, type MemberView, type TaskView } from "./flows";
import { listSquads } from "./dirflows";
import { THE_SQUAD } from "../core/squadauto";
import { acceptFriend, callOffFriendCode, captureFriendLink, dropFriendLink, makeFriendCode, pendingFriendLink, type FriendCodeResult, type FriendResult } from "./addfriend";
import { DIR_OPS, EMPTY_VIEW, type FriendView, type SquadOp, type SquadView } from "./view";
import { dirCardMessage, dirOpen, dirPulse, dirSync, runDirOp, startDir } from "./direngine";
import { autoAgain, autoGone, autoLeft, autoOpen, autoPulse, startAuto } from "./autoengine";
import { hasCard } from "../core/squadauto";
import { feature } from "../core/features";
import { P1_FEATURE, p1Panel, p1Rows, type P1Row } from "../core/squadp1";
import { startP1 } from "./p1engine";
import { aiError, listAis, registerAiCode, unlinkAi } from "./devlink";
import { cleanSeenRows, openPresence, sealPresence } from "../core/squadpresence";
import { gymScreen, onGymScreen } from "./presence";
import type { FitWorkout } from "../core/fitness";
import { lpClear, lpInterval } from "../core/lowpower.ts";   // PS 1.65 Low power mode: these timers stop while asleep
export { dirCardMessage };

const BEAT_MS = 3 * 60_000, OPEN_PULL_MS = 20_000, PEEK_MS = 60_000, PUSH_DELAY_MS = 4_000;

let rec: SquadRec | null = null;
let recId: string | null = null;
let api: HubApi | null = null;
let view: SquadView = { ...EMPTY_VIEW };
let members = new Map<string, MemberView>();
let rawMembers = new Map<string, HubMemberRow>();
let tasks = new Map<string, TaskView>();
let hands = new Map<string, HandView>();
let since: Since | null = null;
let have: Map<string, string> | null = null;   // your copies on the hub: squad task id to fingerprint
let open = false, countAt = 0, pushTimer: number | undefined, pullTimer: number | undefined, beatTimer: number | undefined;
// PS 1.64 members list: each member's last beat and last gym time (opened), from the hub's change only `seen` list.
// `seenKnown` stays false while the hub does not send that list (an older hub): then "Online" comes from `working`.
let seen = new Map<string, { at: string | null; gym: string | null }>();
let seenKnown = false, gymSent = false, extraBeatAt = 0;
let pulling = false, pushing = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

// For the parts of G Squad built after the core (squad/board.ts: Leaderboard and Screen time). They get your squad
// record (keys stay on this page), the hub's member list and whether the pop-up is open, and add to the plain view.
export interface SquadHook {
  /** Your squad changed (made, joined, left, or a new key gen): null when you are in none. */
  rec?: (rec: SquadRec | null) => void;
  /** The pop-up opened or closed. */
  open?: (on: boolean) => void;
  /** The pop-up's data came in (members, who left). */
  pulled?: () => void;
}
const hooks = new Set<SquadHook>();
export function onSquad(h: SquadHook) { hooks.add(h); return () => { hooks.delete(h); }; }
const tell = <K extends keyof SquadHook>(k: K, ...a: Parameters<NonNullable<SquadHook[K]>>) => hooks.forEach((h) => { try { (h[k] as ((...x: unknown[]) => void) | undefined)?.(...a); } catch { /* a part's own problem */ } });
/** Your squad record right now (this page only; never sent to the Tab list). */
export const squadRecNow = (): SquadRec | null => rec;
export const squadOpen = () => open;
/** Members still in the squad (ids), from the last pull. */
export const squadMemberIds = (): { id: string; me: boolean }[] => [...members.values()].filter((m) => !m.left).map((m) => ({ id: m.id, me: m.me }));
/** Adds a part's own field to the plain view (eg board). */
export function patchSquadView(p: Partial<SquadView>) { set(p); }

export const squadStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  get: () => view,
};
/** The plain view for the Tab list (no keys, no ids from your vault except your own task ids for its menus). */
export function squadView(): SquadView { return view; }
function set(p: Partial<SquadView>) { view = { ...view, ...p }; emit(); }
/** Every open or recent P1 of the squad from all the shared copies held (never cut to the panel's few rows). The alerts read this. */
function p1All(): P1Row[] {
  return feature(P1_FEATURE) && rec ? p1Rows([...tasks.values()], { me: rec.memberId, live: new Set([...members.values()].filter((m) => !m.left).map((m) => m.id)), now: Date.now() }) : [];
}
function rebuild() {
  set({
    members: [...members.values()].filter((m) => !m.left).sort((a, b) => Number(b.me) - Number(a.me) || Number(b.working) - Number(a.working) || a.name.localeCompare(b.name))
      .map((m) => {
        // PS 1.64: your own row follows this device (your switch, your Fitness screen); the others' come from the hub.
        const p = m.me ? { at: shareOn(share(), "working") ? new Date().toISOString() : null, gym: gymNow() ? new Date().toISOString() : null } : seen.get(m.id);
        const shares = m.me ? shareOn(share(), "working") : !seenKnown || !!p?.at || m.working;
        return { id: m.id, name: m.name, me: m.me, creator: m.creator, working: m.working, seen: p?.at ?? null, gym: p?.gym ?? null, known: m.me || seenKnown, shares };
      }),
    tasks: [...tasks.values()].filter((t) => members.has(t.member) && !members.get(t.member)!.left).slice(0, 600),
    p1: p1Panel(p1All()),
    hands: [...hands.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100),
  });
}

function settings() { return settingsData(vaultStore.get()); }
function share() { return cleanShareOpts(settings().squadShare); }
const say = (e: unknown) => (e instanceof HubError
  ? e.status === 403 && /invite/.test(e.message) ? "That invite link has been used, has run out, or is not right. Ask for a new one."
  : e.status === 409 && /full/.test(e.message) ? "That squad is full."
  : e.status === 401 && /clock/.test(e.message) ? "This device's clock is off. Set the date and time to automatic and try again."
  : "G Squad could not be reached. Try again in a moment."
  : e instanceof Error && /invite link/.test(e.message) ? e.message : "Something went wrong. Try again.");

// ---------- your squad record (your own vault) ----------
function readRec() {
  const list = docs<SquadRec>("squad").map((d) => ({ d, r: cleanSquadRec(d.data) })).filter((x) => !!x.r)
    .sort((a, b) => b.r!.joinedAt.localeCompare(a.r!.joinedAt));
  const top = list[0];
  const next = top?.r ?? null;
  if (next && rec && next.squadId === rec.squadId && next.memberId === rec.memberId) {
    // The same squad: keep every key gen either copy holds (the Mac and the phone may each have taken a drop).
    const gens = new Map([...rec.keys, ...next.keys].map((k) => [k.gen, k.k]));
    const was = currentKey(rec).gen;
    rec = { ...next, keys: [...gens].sort((a, b) => a[0] - b[0]).map(([gen, k]) => ({ gen, k })) };
    recId = top.d.id;
    if (currentKey(rec).gen !== was) tell("rec", rec);
    return;
  }
  if ((next?.squadId ?? null) === (rec?.squadId ?? null)) return;
  rec = next; recId = top?.d.id ?? null;
  api = rec ? apiFor(rec) : null;
  members = new Map(); rawMembers = new Map(); tasks = new Map(); hands = new Map(); since = null; have = null; seen = new Map(); seenKnown = false;
  view = { ...EMPTY_VIEW, in: !!rec, me: rec?.memberId ?? "", meName: rec?.me ?? "", creator: !!rec?.creator };
  emit();
  restartBeat();
  tell("rec", rec);
  dirSync();
  if (rec) { schedulePush(); if (open) void pull(); else void peek(true); }
}
async function saveRec(next: SquadRec) {
  const gen = rec ? currentKey(rec).gen : 0;
  rec = next;
  if (currentKey(next).gen !== gen) tell("rec", next);
  recId = await put<SquadRec>("squad", next, recId ? { id: recId, ws: null } : { ws: null });
}
async function dropRec(msg: string | null) {
  const id = recId;
  rec = null; recId = null; api = null;
  members = new Map(); rawMembers = new Map(); tasks = new Map(); hands = new Map(); since = null; have = null; seen = new Map(); seenKnown = false;
  view = { ...EMPTY_VIEW, error: msg };
  emit();
  restartBeat();
  tell("rec", null);
  dirSync();
  if (id) await remove(id).catch(() => {});
}
/** A squad just made or joined on this device: saved in your vault, then everything starts from that record
 *  (readRec sees a new squad: view, beat, push, pull). */
async function adopt(r: SquadRec) {
  rec = null; recId = null;
  await put<SquadRec>("squad", r, { ws: null });
  readRec();
}
/** V1.44: the developer moved into The G Squad from his own squad (squad/direngine.ts): the old record goes from the vault so
 *  the Mac and the phone both settle on the new one. */
async function replace(r: SquadRec) {
  const old = recId;
  await adopt(r);
  if (old) await remove(old).catch(() => {});
  void pull();
}
/** The hub no longer knows you (taken out, or the squad is gone): your squad record goes too. */
function gone(e: unknown) {
  if (e instanceof HubError && e.status === 403 && /not a member/.test(e.message)) { autoGone(); void dropRec("You are no longer in The G Squad."); return true; }
  return false;
}

// ---------- working: the heartbeat and the count ----------
function onPulse(p: Pulse) {
  countAt = Date.now();
  set({ count: p.n, waiting: p.h });
  dirPulse(p.w);   // V1.57: people asking to join, for the admin
  autoPulse(p.k);   // V1.49: someone is waiting for the squad key, and you hold it
  if (rec && (p.rk || p.g > currentKey(rec).gen)) void pull();   // a new key or a re-key: the full state once
}
/** PS 1.64: this person is at the gym right now on this device (Fitness open, or a workout running). */
function gymNow(): boolean { return shareOn(share(), "fitness") && (gymScreen() || workoutOpen()); }   // only while you share Fitness
/** A workout started in the last 6 hours and not finished (the same rule as fitness/store.ts), from the vault as it is. */
function workoutOpen(): boolean {
  const s = vaultStore.get();
  if (s.status !== "unlocked") return false;
  const fresh = Date.now() - 6 * 3600_000;
  for (const d of s.docs.values()) {
    if ((d.kind as string) !== "fwork") continue;
    const w = d.data as FitWorkout;
    if (w && !w.endedAt && Date.parse(w.startedAt) > fresh) return true;
  }
  return false;
}
async function beat() {
  if (!rec || !api || !navigator.onLine) return;
  try {
    const opts = share();
    if (shareOn(opts, "working")) {
      // PS 1.64: the gym rides along, sealed with the squad key, only while it is on (and once more to clear it), so a
      // second device of yours that is not at the gym never overwrites the one that is.
      const gym = gymNow();
      const extra = gym ? await sealPresence(rec, new Date().toISOString()) : gymSent ? { st: "", sg: 0 } : null;
      onPulse(await api.beat(extra));
      gymSent = gym;
    }
    else if (Date.now() - countAt >= PEEK_MS) onPulse(await api.count());   // switched off: no beat at all, only the count
  } catch (e) { gone(e); }
}
/** PS 1.64: the gym started or stopped on this device: tell the squad now (a beat), not at the next 3 minute one.
 *  At most one extra beat every 20 seconds. */
function gymChanged() {
  if (!rec || !shareOn(share(), "working")) return;
  rebuild();
  if (gymNow() === gymSent) return;
  const wait = Math.max(0, extraBeatAt + 20_000 - Date.now());
  window.setTimeout(() => { if (gymNow() !== gymSent) { extraBeatAt = Date.now(); void beat(); } }, wait);
}
/** PS 1.64: "working" switched off: the hub forgets your last beat (and gym), so nobody sees a stale "Last seen".
 *  Once per switch; the hub before 1.64 does not know the step, which is fine (it is only skipped). */
async function away() {
  if (!rec || !api || !navigator.onLine) return;
  try { await api.away(); gymSent = false; try { localStorage.setItem(AWAY_KEY, rec.memberId); } catch { /* storage off */ } } catch (e) { gone(e); }
}
const AWAY_KEY = "ps.sqAwaySent";
function restartBeat() {
  if (beatTimer !== undefined) lpClear(beatTimer);
  beatTimer = undefined;
  if (!rec) return;
  // PS 1.64: "working" is off and the hub was never told on this device: clear the last beat once (members list).
  if (!shareOn(share(), "working")) { let sent: string | null = null; try { sent = localStorage.getItem(AWAY_KEY); } catch { /* storage off */ } if (sent !== rec.memberId) void away(); }
  beatTimer = lpInterval("gsquad", () => void beat(), BEAT_MS);
  void beat();
}
/** The Tab list just showed: the count, if the last one is over a minute old (never more often). */
async function peek(force = false) {
  if (!rec || !api || !navigator.onLine) return;
  if (!force && Date.now() - countAt < PEEK_MS) return;
  countAt = Date.now();
  try { onPulse(await api.count()); } catch (e) { gone(e); }
}

// ---------- the pop-up's data: change only ----------
async function pull() {
  if (!rec || !api || pulling || !navigator.onLine) return;
  pulling = true;
  try {
    const myGen = currentKey(rec).gen;
    const p = await api.pull(since, myGen);
    // New keys first (after someone left), then everything that changed.
    if (p.drops.length) {
      const next = await takeDrops(rec, p.drops);
      if (next.keys.length !== rec.keys.length) { await saveRec(next); since = null; }
    }
    for (const m of p.members) rawMembers.set(m.id, m);
    const working = new Set(p.working);
    for (const m of rawMembers.values()) {
      // V1.49: someone who joined but has no card yet is not in yet (their PS is still getting the squad key).
      if (!m.left_at && !hasCard(m) && m.id !== rec.memberId) { members.delete(m.id); continue; }
      members.set(m.id, await memberView(rec, m, p.squad.created_by, working));
    }
    for (const t of p.tasks) {
      const v = await taskView(rec, t);
      if (v) tasks.set(t.id, v); else tasks.delete(t.id);
    }
    for (const h of p.hands) {
      const v = await handView(rec, h);
      if (v && v.state === "open") hands.set(h.id, v); else if (v && hands.has(h.id)) hands.set(h.id, v); else if (!v) hands.delete(h.id);
    }
    // PS 1.64: last beats and gym times that changed (the first pull: everyone seen in the last 14 days).
    if (Array.isArray(p.seen)) {
      seenKnown = true;
      for (const r of cleanSeenRows(p.seen)) {
        const body = r.at ? await openPresence(rec, r.id, r.ct, r.gen) : null;
        seen.set(r.id, { at: r.at, gym: body?.g ?? null });
      }
    }
    const name = await squadName(rec, p.squad);
    const back = new Date(Date.parse(p.now) - 5_000).toISOString();   // a little overlap: a row written as we read is never missed
    since = { m: back, t: back, h: back, p: back };
    countAt = Date.now();
    set({ in: true, name, me: rec.memberId, meName: rec.me, creator: p.squad.created_by === rec.memberId, count: working.size,
      waiting: [...hands.values()].filter((h) => h.to === rec!.memberId && h.state === "open").length, loaded: true, error: null });
    rebuild();
    dirSync();
    tell("pulled");
    // Someone left: re-key for the rest (the first member to get here does it); then your card under the newest gen.
    if (p.squad.rekey) {
      const next = await rekeyIfNeeded(rec, api, p, [...rawMembers.values()], name);
      if (next !== rec) { await saveRec(next); since = null; schedulePush(); }
    }
    if (keyFor(rec, p.squad.gen)) await refreshCard(rec, api, rawMembers.get(rec.memberId));
    if (currentKey(rec).gen !== myGen) schedulePush();   // every copy is sealed again under the new gen
  } catch (e) {
    if (!gone(e)) set({ error: say(e) });
  } finally { pulling = false; }
}
function setOpen(on: boolean) {
  if (open === on) return;
  open = on;
  if (pullTimer !== undefined) { lpClear(pullTimer); pullTimer = undefined; }
  tell("open", on);
  dirOpen(on);
  autoOpen(on);
  if (!on) { set({ loaded: false }); return; }
  void pull();
  pullTimer = lpInterval("gsquad", () => { if (document.visibilityState !== "hidden" || PS_PAGE) void pull(); }, OPEN_PULL_MS);
}
const PS_PAGE = import.meta.env.MODE === "ps";   // PS's main page is never on screen, yet it is the one that runs this

// ---------- your shared tasks: change only, through the gate (V1.43: the Tasks switch AND Share with G Squad) ----------
function schedulePush() {
  if (!rec) return;
  if (pushTimer !== undefined) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => { pushTimer = undefined; void push(); }, PUSH_DELAY_MS);
}
async function push() {
  if (!rec || !api || !navigator.onLine) return;
  if (pushing) { schedulePush(); return; }
  pushing = true;
  try {
    if (!have) have = new Map((await api.mine()).rows.map((r) => [r.id, r.fp]));
    const s = vaultStore.get();
    const todos = docs<Todo>("todo").filter((d) => d.ws === null);
    const clients = docs<ClientRec>("client").map((d) => d.data);
    // PS 1.63: with the squad-p1 feature off, the Priority 1 piece is off too (the gate then refuses it before the key is touched).
    const st = settingsData(s);
    const gated = feature(P1_FEATURE) ? st : { ...st, squadShare: { ...cleanShareOpts(st.squadShare), p1: false } };
    const plan = await planTaskSync({ todos, settings: gated, clients, squad: rec.squadId, member: rec.memberId, secret: rec.secret, key: currentKey(rec), have });
    for (let i = 0; i < plan.put.length; i += 100) {
      const rows = plan.put.slice(i, i + 100);
      await api.putTasks(rows);
      for (const r of rows) have.set(r.id, r.fp);
    }
    if (plan.del.length) { await api.delTasks(plan.del); for (const id of plan.del) have.delete(id); }
  } catch (e) {
    if (!gone(e)) have = null;   // read the hub's list again next time
  } finally { pushing = false; }
}

// ---------- what the Tab list asks for ----------
function myName(asked: string) {
  return asked || (settings().ownerName || "").trim().split(/\s+/)[0] || "";
}
export async function runSquadOp(o: SquadOp): Promise<void> {
  const st = vaultStore.get();
  if (st.status !== "unlocked" || st.role !== "owner") return;
  if (DIR_OPS.has(o.op)) return runDirOp(o);   // V1.42 squad directory (squad/direngine.ts)
  try {
    switch (o.op) {
      case "open": setOpen(o.on); return;
      case "peek": void peek(); return;
      case "refresh": void pull(); return;
      case "clearLink": set({ link: null }); return;
      // V1.49: Join again (after leaving) or Try again (after a problem joining)
      case "rejoin": await autoAgain(); return;
      case "friend": { set({ friend: { kind: "busy" } }); const f = await friendCode(); if (f !== CLOSED) set({ friend: f }); return; }
      case "friendClose": await friendClose(); set({ friend: null }); return;
      // V1.62 Link my AI (squad/devlink.ts). Errors stay on the page, never the squad's own error line.
      case "aiOpen": await aiRefresh(); return;
      case "aiClose": set({ ai: null }); return;
      case "aiCode": {
        if (!rec) return;
        const cur = view.ai ?? { list: null, code: null, error: null };
        set({ ai: { ...cur, code: { id: o.id, state: "busy", expiresAt: null }, error: null } });
        try {
          const r = await registerAiCode(rec, o.id, o.secret);
          set({ ai: { ...(view.ai ?? cur), code: { id: o.id, state: "ready", expiresAt: r.expiresAt }, error: null } });
        } catch (e) {
          set({ ai: { ...(view.ai ?? cur), code: { id: o.id, state: "error", expiresAt: null }, error: aiError(e) } });
        }
        return;
      }
      case "aiUnlink": {
        if (!rec) return;
        try { await unlinkAi(rec, o.id); } catch (e) { set({ ai: { ...(view.ai ?? { list: null, code: null }), error: aiError(e) } }); return; }
        await aiRefresh();
        return;
      }
      // V1.47 (the developer, 10 Nov 2026): one squad, The G Squad. Nobody makes a new squad from PS any more; the op is still
      // read (an older Tab list may send it) and does nothing. The hub and every existing squad stay as they are.
      case "create": return;
      case "join": {
        if (rec) return;
        set({ busy: "Joining", error: null });
        await adopt(await joinSquad(o.link, myName(o.me)));
        set({ busy: null }); void pull();
        return;
      }
      case "invite": {
        if (!rec) return;
        set({ busy: "Making a link", error: null });
        const base = new URL(import.meta.env.BASE_URL || "/client/", "https://cincee.com").href;
        const inv = await makeInvite(rec, base);
        set({ link: { url: inv.link, expiresAt: inv.expiresAt }, busy: null });
        return;
      }
      case "leave": {
        if (!rec || !api) return;
        set({ busy: "Leaving", error: null });
        await api.leave();
        await dropRec(null);
        await autoLeft();   // V1.49: left on purpose, so PS does not join again by itself (Join again does)
        return;
      }
      case "renameSquad": {
        if (!rec || !api || !view.creator) return;   // the admin only (the hub checks it too)
        set({ busy: "Renaming", error: null });
        const listed = (await listSquads(rec.sign)).some((e) => e.id === rec!.squadId);
        const name = await renameSquad(rec, api, o.name, listed);
        set({ busy: null, name });
        void pull();
        return;
      }
      case "renameMe": {
        if (!rec || !api) return;
        set({ busy: "Renaming", error: null });
        await saveRec(await renameMe(rec, api, o.name));
        const mine = members.get(rec.memberId);
        if (mine) { members.set(rec.memberId, { ...mine, name: rec.me }); rebuild(); }
        set({ busy: null, meName: rec.me });
        // V1.49: no name at sign up, so the first name you give the squad also greets you around PS.
        if (!(settings().ownerName || "").trim()) void saveSettings({ ownerName: rec.me }).catch(() => {});
        void pull();
        return;
      }
      case "remove": {
        if (!rec || !api || o.member === rec.memberId) return;
        await api.leave(o.member);
        void pull();
        return;
      }
      case "share": {
        await saveSettings({ squadShare: { ...share(), [o.piece]: o.on } });
        if (o.piece === "tasks" || o.piece === "p1") schedulePush();
        if (o.piece === "fitness") gymChanged();
        if (o.piece === "working") { if (!o.on) void away(); else { try { localStorage.removeItem(AWAY_KEY); } catch { /* storage off */ } } restartBeat(); rebuild(); }
        return;
      }
      case "p1show": await saveSettings({ squadP1Show: o.on }); void pull(); return;
      case "task": {
        const d = docs<Todo>("todo").find((x) => x.id === o.id);
        if (!d) return;
        const patch: Partial<Todo> = {};
        if (typeof o.sqOff === "boolean") patch.sqOff = o.sqOff;
        // V1.43 Share with G Squad: sharing clears an old Not shared mark; stopping clears the share mark.
        if (typeof o.sqOn === "boolean") { patch.sqOn = o.sqOn; if (o.sqOn) patch.sqOff = false; }
        if ("sqAnon" in o) patch.sqAnon = o.sqAnon ?? null;
        await updateTodo(o.id, patch);
        schedulePush();
        return;
      }
      case "hand": {
        if (!rec || !api) return;
        const d = docs<Todo>("todo").find((x) => x.id === o.id) as Doc<Todo> | undefined;
        if (!d || !taskShared(d.data)) return;   // only a task you share can be handed over
        const terms = clientTerms(docs<ClientRec>("client").map((c) => c.data));
        const title = squadTitle(d.data, terms).title;
        const id = await handTask(rec, api, share(), o.to, { t: title, d: d.data.due ?? null });
        if (!id) { set({ error: "Tasks are switched off in What you share." }); return; }
        void pull();
        return;
      }
      case "answer": {
        if (!rec || !api) return;
        const h = hands.get(o.id);
        if (!h || h.to !== rec.memberId || h.state !== "open") return;
        await api.answer(o.id, o.accept);
        if (o.accept) await addTodo({ title: h.t, due: h.d, type: "once", unranked: true });
        hands.set(o.id, { ...h, state: o.accept ? "accepted" : "declined" });
        rebuild();
        set({ waiting: Math.max(0, view.waiting - 1) });
        return;
      }
      case "cancel": {
        if (!api) return;
        await api.cancel(o.id);
        hands.delete(o.id); rebuild();
        return;
      }
    }
  } catch (e) {
    if (!gone(e)) set({ busy: null, error: say(e) });
  }
}

// ---------- V1.44 Add friend (squad/addfriend.ts) ----------
// The code shown now (with its hub id, which the Tab list never needs) and the record it was made with.
let shown: { code: FriendCodeResult; rec: SquadRec | null } | null = null;
const CLOSED: FriendView = { kind: "error", message: "Closed." };
let friendRound = 0;   // a close while a code is still being made calls that code off as soon as it exists
/** Your squad record: the engine's, or (the website, where the engine does not run) the newest one in your vault. */
function recHere(): SquadRec | null {
  if (rec) return rec;
  return docs<SquadRec>("squad").map((d) => cleanSquadRec(d.data)).filter((r): r is SquadRec => !!r).sort((a, b) => b.joinedAt.localeCompare(a.joinedAt))[0] ?? null;
}
const toView = (c: FriendCodeResult): FriendView => (c.kind === "none" ? c : c.kind === "join" ? { kind: "join", url: c.url, expiresAt: c.expiresAt } : { kind: "ask", url: c.url, expiresAt: c.expiresAt });
/** A fresh Add friend code (the one before is called off first). V1.57 invite only: every member's code is a one time
 *  invite (24 hours, works once), so anyone in can bring a friend straight in. Never throws. */
export async function friendCode(): Promise<FriendView> {
  await friendClose();
  const round = friendRound;
  const r = recHere();
  try {
    const code = await makeFriendCode(r, { admin: !!r, listed: false });
    if (round !== friendRound) { await callOffFriendCode(r, code); return CLOSED; }
    shown = { code, rec: r };
    return toView(code);
  } catch (e) {
    return { kind: "error", message: e instanceof HubError && e.status === 429 ? "Too many codes are waiting. Each one runs out within a day." : say(e) };
  }
}
/** The code closed (Esc, back, or the page left): a join code nobody used is deleted on the hub. */
async function aiRefresh(): Promise<void> {
  if (!rec) return;
  const cur = view.ai ?? { list: null, code: null, error: null };
  try { set({ ai: { ...cur, list: await listAis(rec), error: null } }); }
  catch (e) { set({ ai: { ...cur, error: aiError(e) } }); }
}
export async function friendClose(): Promise<void> {
  friendRound++;
  const s = shown;
  shown = null;
  if (s) await callOffFriendCode(s.rec, s.code);
}

/** Reads the scanned link from the address (once, at load; the key then leaves the address bar). */
export const takeFriendLink = () => captureFriendLink();
export { pendingFriendLink, dropFriendLink };
/** THE JOIN ENTRY POINT. Call it once the vault is open as owner (website, web app, local first start): joins with
 *  the scanned link, or sends the Ask to join, and starts G Squad on this page. `name` is your name in the squad
 *  (empty: your first name from Settings). The link is dropped unless the hub could not be reached. */
export async function acceptFriendLink(name = ""): Promise<FriendResult> {
  const link = pendingFriendLink();
  if (!link) return { state: "none" };
  const st = vaultStore.get();
  if (st.status !== "unlocked" || st.role !== "owner") return { state: "error", message: "Open PS app first." };
  startSquad();
  readRec();
  const me = myName(name) || "Me";
  const r = await acceptFriend(link, me, {
    inSquad: () => !!rec,
    async join(l, n) {
      await adopt(await joinSquad(l, n));
      await pull();
      return view.name || "G Squad";
    },
    // V1.49: no asking any more. Scanning a code is a clear yes, so PS joins The G Squad by itself now (even after
    // leaving it before).
    async ask(_squadId, n) {
      if (n && !(settings().ownerName || "").trim()) void saveSettings({ ownerName: n }).catch(() => {});
      await autoAgain();
      return THE_SQUAD;
    },
    say: (e) => (e instanceof HubError && e.status === 403 && /invite/.test(e.message) ? "This code was used already or has run out. Ask them to show a new one."
      : e instanceof HubError ? say(e) : e instanceof Error && e.message.length < 160 ? e.message : say(e)),
  });
  if (!(r.state === "error" && /could not be reached|clock/.test(r.message))) dropFriendLink();
  return r;
}

// ---------- start (once, on the page that holds the vault) ----------
let started = false;
/** Main page of PS (Mac) and the phone app only: the website never talks to the hub. */
export function startSquad(post: ((m: object) => void) | null = null) {
  if (started) return;
  started = true;
  // V1.42 squad directory: See available squads, your request, the admin's Approve and Decline (and their Mac card).
  startDir({ rec: () => rec, api: () => api, view: () => view, patch: (p) => set(p), adopt, replace, pull: () => void pull(), post });
  // V1.49 one squad, everyone in: joins The G Squad by itself, hands the squad key to people waiting, the developer's admin step.
  startAuto({ rec: () => rec, api: () => api, view: () => view, patch: (p) => set(p), adopt, drop: () => dropRec(null), pull: () => void pull() });
  let lastTodos = "";
  vaultStore.subscribe(() => {
    const s = vaultStore.get();
    if (s.status !== "unlocked" || s.role !== "owner" || s.userId === "ps-overlay" || s.userId === "dev") {
      if (rec) { rec = null; recId = null; api = null; view = { ...EMPTY_VIEW }; emit(); restartBeat(); tell("rec", null); }
      return;
    }
    readRec();
    // Your tasks, settings or clients changed: plan a push (the plan itself sends only what changed).
    if (rec) {
      let sig = "";
      for (const d of s.docs.values()) if (d.kind === "todo" || d.kind === "settings" || d.kind === "client") sig += `${d.id}:${d.updatedAt}:${d.pending ? 1 : 0};`;
      if (sig !== lastTodos) { lastTodos = sig; schedulePush(); }
    }
  });
  // PS 1.63 Priority 1 (squad/p1engine.ts): the 24 hour clock on your own P1 tasks, the side panel's data, the missed task cards.
  startP1({ post, rec: () => rec, view: () => view, p1All, onPulled: (f) => { hooks.add({ pulled: f }); }, pull: () => void pull(), push: () => schedulePush(), isOpen: () => open });
  window.addEventListener("online", () => { void beat(); if (open) void pull(); schedulePush(); });
  // PS 1.64: Fitness opened or closed on this device, or a workout started or ended (it is in the vault).
  onGymScreen(gymChanged);
  let wasWorkout = false;
  vaultStore.subscribe(() => { const w = workoutOpen(); if (w !== wasWorkout) { wasWorkout = w; gymChanged(); } });
}
