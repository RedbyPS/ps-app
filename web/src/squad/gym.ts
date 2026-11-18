// G Squad Fitness (V1.40) on the page that holds the vault (PS's main page on the Mac, the phone app's page). It
// shares your Fitness and Sleep cards with the squad and reads everyone else's, through the hub's `gym` function.
//
// The opt-outs are enforced where the squad key is used: every row is sealed by core/squadshare.ts sealForSquad
// with its own piece ("fitness" or "sleep"), which refuses a switched off piece before it touches the key. When a
// piece is switched off, what the hub held of it is deleted at once.
//
// Egress (the hub is on Supabase's free plan): only changes travel.
//   your cards     15 s after a Fitness change, only the rows whose sealed copy changed (fingerprint); one list of
//                  your row fingerprints per session (gym_mine)
//   the boards     one pull when the Squad screen opens, then every 45 s while it stays open, each pull only rows
//                  and posts changed since the last one
//   compare        the rows of the one exercise on screen (by its tag), changed since that exercise was last read
//   closed         nothing at all
import { docs, vaultStore } from "../core/vault";
import { settingsData } from "../core/select";
import { todayISO } from "../ui/kit";
import { cleanSquadRec, currentKey, keyFor, openCard, type SquadRec } from "../core/squadrec";
import { cleanShareOpts, shareOn } from "../core/squadshare";
import { newUuid } from "../core/squadcrypto";
import { addDays, cleanEx, cleanSleepCard, cleanSum, exTag, gymRowId, reactId, type GymEx, type GymPost, type GymSleep, type GymSum } from "../core/gymsquad";
import { gymCall, gymPlan, gymWanted, openGymPost, openGymRow, sealGymPost, sleepOn, type PullOut, type RowIn } from "./gymplan";
import { HubError } from "./hub";
import { runSquadOp, squadStore, squadView } from "./engine";
import { fitnessNow, savePrefs } from "../fitness/store";
import { activitiesNow } from "../fitness/activity-store";
import { sleepNow } from "../fitness/sleep-store";
import { GYM_EMPTY, type GymOp, type GymSquadView, type GymPostV } from "./gymview";
import { lpClear, lpInterval } from "../core/lowpower.ts";   // PS 1.65 Low power mode: these timers stop while asleep

const PUSH_DELAY_MS = 15_000, OPEN_PULL_MS = 45_000, LEASE_MS = 100_000, BATCH_BYTES = 300_000;

// ---------- state ----------
let rec: SquadRec | null = null;
let view: GymSquadView = { ...GYM_EMPTY };
let names = new Map<string, string>();
let ins: string[] = [];
const sums = new Map<string, GymSum | null>(), sleeps = new Map<string, GymSleep | null>();
let posts = new Map<string, GymPostV>();
let exKeyOn: string | null = null;
const exCache = new Map<string, { since: string | null; rows: Map<string, { member: string; ex: GymEx }> }>();
let since: { r: string | null; p: string | null } = { r: null, p: null };
let have: Map<string, { fp: string; part: string }> | null = null;
let leaseUntil = 0, pullTimer: number | undefined, pushTimer: number | undefined, pulling = false, pushing = false, started = false, missingKey = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const gymStore = { subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }, get: () => view };
/** The plain view (no keys) for the Fitness screens and the Tab list. */
export function gymView(): GymSquadView { return view; }
function set(p: Partial<GymSquadView>) { view = { ...view, ...p }; emit(); }

const share = () => cleanShareOpts(settingsData(vaultStore.get()).squadShare);
const sleepShared = () => sleepOn(share(), fitnessNow().prefs);
const who = (): { member: string; priv: string } | null => (rec ? { member: rec.memberId, priv: rec.sign.priv } : null);
const say = (e: unknown) => (e instanceof HubError && e.status === 401 && /clock/.test(e.message) ? "This device's clock is off. Set the date and time to automatic and try again."
  : "G Squad could not be reached. Try again in a moment.");

function rebuild() {
  const working = new Map(squadView().members.map((m) => [m.id, m.working]));
  const members = ins.map((id) => ({ id, name: names.get(id) || (id === rec?.memberId ? rec.me : "Someone"), me: id === rec?.memberId, working: working.get(id) === true }))
    .sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name));
  const cards = ins.map((id) => ({ id, sum: sums.get(id) ?? null, sleep: sleeps.get(id) ?? null }));
  const live = new Set(ins);
  const ps = [...posts.values()].filter((p) => live.has(p.by)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 600);
  const ex = exKeyOn ? { key: exKeyOn, loading: !exCache.get(exKeyOn)?.since, rows: [...(exCache.get(exKeyOn)?.rows.values() ?? [])].filter((r) => live.has(r.member)) } : null;
  set({ members, cards, posts: ps, ex, share: { fitness: shareOn(share(), "fitness"), sleep: sleepShared() } });
}

// ---------- your squad record (read from your own vault, the same record the core engine keeps) ----------
function readRec() {
  const list = docs<SquadRec>("squad").map((d) => cleanSquadRec(d.data)).filter((r): r is SquadRec => !!r).sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
  const next = list[0] ?? null;
  const same = next && rec && next.squadId === rec.squadId && next.memberId === rec.memberId;
  if (same) {
    const more = next.keys.length > rec!.keys.length;
    rec = next;
    if (more && missingKey) { missingKey = false; since = { r: null, p: null }; exCache.clear(); if (open()) void pull(); }
    if (more) schedulePush();
    return;
  }
  rec = next;
  names = new Map(); ins = []; sums.clear(); sleeps.clear(); posts = new Map(); exCache.clear(); since = { r: null, p: null }; have = null;
  view = { ...GYM_EMPTY, on: true, in: !!rec, me: rec?.memberId ?? "", share: { fitness: shareOn(share(), "fitness"), sleep: sleepShared() } };
  emit();
  if (rec) { schedulePush(); if (open()) void pull(); }
}

// ---------- your cards: change only, through the opt-out gate ----------
function schedulePush(ms = PUSH_DELAY_MS) {
  if (!rec) return;
  if (pushTimer !== undefined) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => { pushTimer = undefined; void push(); }, ms);
}
/** What you share right now (empty for a switched off piece), from this vault. */
function wanted(r: SquadRec) {
  const f = fitnessNow(), s = sleepNow();
  return gymWanted(r, share(), { workouts: f.workouts.map((d) => ({ id: d.id, data: d.data })), acts: activitiesNow(), prefs: f.prefs, today: todayISO(), sleepLogs: s.days.values(), sleepToday: s.today });
}
async function push() {
  const r = rec, w = who();
  if (!r || !w || !navigator.onLine) return;
  if (pushing) { schedulePush(); return; }
  pushing = true;
  try {
    if (!have) have = new Map((await gymCall<{ rows: { id: string; part: string; fp: string }[] }>(w, "gym_mine", {})).rows.map((x) => [x.id, { fp: x.fp, part: x.part }]));
    const want = await wanted(r);
    const { put: rows, del } = await gymPlan(r, share(), want, have);
    let batch: typeof rows = [], size = 0;
    const send = async () => { if (!batch.length) return; await gymCall(w, "gym_put", { rows: batch }); for (const x of batch) have!.set(x.id, { fp: x.fp, part: x.part }); batch = []; size = 0; };
    for (const x of rows) { if (batch.length >= 40 || size + x.ct.length > BATCH_BYTES) await send(); batch.push(x); size += x.ct.length + 200; }
    await send();
    if (del.length) { await gymCall(w, "gym_del", { ids: del }); for (const id of del) have.delete(id); }
  } catch (e) {
    if (!gone(e)) have = null;   // read the hub's list again next time
  } finally { pushing = false; }
}
/** A piece switched off: whatever the hub holds of it goes now (by part, whatever this device remembers). */
async function dropParts(parts: ("sum" | "ex" | "sleep")[]) {
  const w = who();
  if (!w) return;
  await gymCall(w, "gym_del", { parts });
  if (have) for (const [id, x] of have) if ((parts as string[]).includes(x.part)) have.delete(id);
}
function gone(e: unknown) {
  return e instanceof HubError && e.status === 403 && /not a member/.test(e.message);
}

// ---------- the boards and the compare screen: change only, while on screen ----------
const open = () => Date.now() < leaseUntil;
async function tagsFor(r: SquadRec, m: string): Promise<string[]> {
  const cur = currentKey(r).gen, out: string[] = [];
  for (const g of [cur, cur - 1]) { const raw = keyFor(r, g); if (raw) out.push(await exTag(raw, m)); }
  return out;
}
async function openRow(r: SquadRec, row: RowIn): Promise<unknown | null> {
  const v = await openGymRow(r, row);
  if (v === undefined) { missingKey = true; return null; }
  return v;
}
async function pull() {
  const r = rec, w = who();
  if (!r || !w || !navigator.onLine) return;
  // PS 1.68: a pull asked for while one runs (Fitness opened, or an exercise picked, during a pull) runs right after it,
  // instead of being dropped until the next 45 second pull.
  if (pulling) { pullAgain = true; return; }
  pulling = true;
  try {
    const key = exKeyOn;
    const ex = key ? (exCache.get(key) ?? { since: null, rows: new Map() }) : null;
    if (key && ex) exCache.set(key, ex);
    const cards = !ins.length || ins.some((id) => !names.has(id));
    const p = await gymCall<PullOut>(w, "gym_pull", { r: since.r, p: since.p, ...(cards ? { cards: true } : {}), ...(key ? { tags: await tagsFor(r, key), x: ex!.since } : {}) });
    ins = p.members.map((m) => m.id);
    // PS 1.68 (Jan 18 Nov: "Fitness takes long to load"): every sealed card, row and post of a pull is opened at once, not one
    // after another (each open is a separate trip to the browser's crypto), then applied in the hub's order, exactly as before.
    const cardsOpen = await Promise.all(p.members.map((m) => (m.card_ct ? openCard(r, m.id, m.card_ct, m.card_gen).catch(() => null) : Promise.resolve(null))));
    p.members.forEach((m, i) => { const c = cardsOpen[i]; if (c) names.set(m.id, c.n); });
    if (ins.some((id) => !names.has(id)) && !cards) window.setTimeout(() => void pull(), 1_000);   // someone new: their name next
    const rowsOpen = await Promise.all(p.rows.map((row) => (row.deleted ? Promise.resolve(null) : openRow(r, row))));
    for (const [i, row] of p.rows.entries()) {
      const map = row.part === "sleep" ? sleeps : sums;
      if (row.deleted) { map.set(row.member_id, null); continue; }
      const v = rowsOpen[i];
      if (v == null) continue;
      if (row.part === "sum") sums.set(row.member_id, cleanSum(v));
      else if (row.part === "sleep") sleeps.set(row.member_id, cleanSleepCard(v));
    }
    const postsOpen = await Promise.all(p.posts.map((x) => (x.deleted ? Promise.resolve(null) : openGymPost(r, x))));
    for (const [i, x] of p.posts.entries()) {
      if (x.deleted) { posts.delete(x.id); continue; }
      const post = postsOpen[i];
      if (post === undefined) { missingKey = true; continue; }
      if (post) posts.set(x.id, { id: x.id, by: x.member_id, at: x.updated_at, post });
    }
    if (key && ex) {
      const exOpen = await Promise.all(p.ex.map((row) => (row.deleted ? Promise.resolve(null) : openRow(r, row))));
      for (const [i, row] of p.ex.entries()) {
        if (row.deleted) { ex.rows.delete(row.id); continue; }
        const v = cleanEx(exOpen[i]);
        if (v && v.m === key) ex.rows.set(row.id, { member: row.member_id, ex: v }); else ex.rows.delete(row.id);
      }
      ex.since = new Date(Date.parse(p.now) - 5_000).toISOString();
    }
    const back = new Date(Date.parse(p.now) - 5_000).toISOString();   // a little overlap: a row written as we read is never missed
    since = { r: back, p: back };
    set({ loaded: true, error: null });
    rebuild();
  } catch (e) {
    if (!gone(e)) set({ error: say(e) });
  } finally { pulling = false; if (pullAgain) { pullAgain = false; void pull(); } }
}
let pullAgain = false;
function keepPulling() {
  if (pullTimer !== undefined) return;
  pullTimer = lpInterval("squad-gym", () => {
    if (!open()) { lpClear(pullTimer); pullTimer = undefined; exKeyOn = null; return; }
    if (document.visibilityState !== "hidden" || PS_PAGE) void pull();
  }, OPEN_PULL_MS);
}
const PS_PAGE = import.meta.env.MODE === "ps";   // PS's main page is never on screen, yet it is the one that runs this

// ---------- posts ----------
async function post(id: string, value: GymPost) {
  const r = rec, w = who();
  if (!r || !w) return;
  // Posts are Fitness: switched off, you cannot react, comment or join (nothing is sealed).
  const s = await sealGymPost(r, share(), id, value);
  if (!s) { set({ error: "Fitness is switched off in What you share." }); return; }
  await gymCall(w, "gym_post", { id, ct: s.ct, gen: s.gen });
  posts.set(id, { id, by: r.memberId, at: new Date().toISOString(), post: value });
  rebuild();
}
async function unpost(id: string) {
  const w = who();
  if (!w) return;
  await gymCall(w, "gym_unpost", { ids: [id] });
  posts.delete(id);
  rebuild();
}

// ---------- what the screens ask for ----------
export async function runGymOp(o: GymOp): Promise<void> {
  if (import.meta.env.DEV && devOp) { devOp(o); return; }
  const st = vaultStore.get();
  if (st.status !== "unlocked" || st.role !== "owner" || !started) return;
  try {
    switch (o.op) {
      case "open": {
        if (!o.on) { leaseUntil = 0; exKeyOn = null; rebuild(); return; }
        const wasOpen = open(), newEx = (o.ex ?? null) !== exKeyOn;
        leaseUntil = Date.now() + LEASE_MS;
        exKeyOn = o.ex ?? null;
        keepPulling();
        if (!wasOpen || newEx) { rebuild(); void pull(); }
        return;
      }
      case "refresh": void pull(); return;
      case "react": {
        if (!rec) return;
        const id = await reactId(rec.secret, o.to, o.pb);
        if (o.e === null) await unpost(id); else await post(id, { k: "re", to: o.to, pb: o.pb, e: o.e });
        return;
      }
      case "comment": await post(newUuid(), { k: "cm", to: o.to, pb: o.pb, t: o.t }); return;
      case "unpost": { const p = posts.get(o.id); if (p && p.by === rec?.memberId) await unpost(o.id); return; }
      case "challenge": {
        const to = addDays(o.from, o.days - 1);
        await post(newUuid(), { k: "ch", metric: o.metric, from: o.from, to, ...(o.t ? { t: o.t } : {}) });
        return;
      }
      case "join": {
        if (!rec) return;
        const id = await gymRowId(rec.secret, `join:${o.ch}`);
        if (o.on) await post(id, { k: "join", ch: o.ch }); else await unpost(id);
        return;
      }
      case "share": {
        await runSquadOp({ op: "share", piece: o.piece, on: o.on });
        if (o.piece === "sleep") await savePrefs({ sleepShare: o.on });
        if (!o.on) await dropParts(o.piece === "sleep" ? ["sleep"] : ["sum", "ex"]);
        else schedulePush(1_000);
        rebuild();
        return;
      }
    }
  } catch (e) {
    if (!gone(e)) set({ error: say(e) });
  }
}

// ---------- start (once, on the page that holds the vault) ----------
/** Main page of PS (Mac) and the phone app only: the website never talks to the hub. */
export function startGymSquad() {
  if (started) return;
  started = true;
  view = { ...view, on: true };
  let sig = "";
  vaultStore.subscribe(() => {
    const s = vaultStore.get();
    if (s.status !== "unlocked" || s.role !== "owner" || s.userId === "ps-overlay" || s.userId === "dev") {
      if (rec) { rec = null; view = { ...GYM_EMPTY, on: true }; emit(); }
      return;
    }
    readRec();
    if (!rec) return;
    // Your Fitness, Sleep, activities or sharing switches changed: plan a push (it sends only what changed).
    let next = "";
    for (const d of s.docs.values()) {
      const k = d.kind as string;
      if (k === "fwork" || k === "fact" || k === "fsleep" || k === "fit" || k === "settings") next += `${d.id}:${d.updatedAt};`;
    }
    if (next !== sig) { sig = next; schedulePush(); }
  });
  // Names and working dots: the core engine's copy when it has one (the G Squad pop-up was opened).
  squadStore.subscribe(() => { if (rec && ins.length) rebuild(); });
  window.addEventListener("online", () => { schedulePush(2_000); if (open()) void pull(); });
  // A new day moves the boards' windows: check once an hour (nothing is sent unless a card changed).
  lpInterval("squad-gym", () => schedulePush(1_000), 3600_000);
}

// ---------- the dev server only: a fictional squad (src/dev/gym-fake.ts) ----------
let devOp: ((o: GymOp) => void) | null = null;
export function __devGym(v: GymSquadView, onOp: (o: GymOp) => void) {
  if (!import.meta.env.DEV) return;
  devOp = onOp;
  view = v;
  emit();
}
