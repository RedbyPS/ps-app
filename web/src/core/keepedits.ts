// PS 1.74, keep my edits (21 Nov 2026: "When i make updates to my checklist, on update it sometimes deletes the
// updates i made recently"). Three ways a copy from before an edit used to take the edit's place. Pure helpers here,
// wired in core/vault.ts (put, rebuildDocs, pullRecords) and tested in tests/keep-my-edits.test.ts.
//
// 1. A sync landing while you edit. After every download that changed anything, the vault decrypts every record again
//    (rebuildDocs) and then puts that whole list on screen. A task edited during that run was read before the edit, so
//    the list on screen went back to the copy from before it. The edit was still waiting to be sent, but the next edit
//    of the same task (the next mini task ticked, the next word typed) started from the old copy on screen and was
//    saved over the first one: the first edit was gone for good. Now the ids written during a rebuild keep their newest
//    copy (WriteWatch, keepWritten).
// 2. Two edits of one record back to back. put() only put the new copy in memory after encrypting it, so a second edit
//    started in that moment read the copy from before the first and saved over it. Now the copy is in memory at once,
//    and the encrypted copies of one record are queued in the order they were made (IdLane).
// 3. A device with an old copy. Every device sends a whole record, and the server keeps the last one. A device that was
//    closed for a while (the phone, a second Mac, a website tab) opens after an update and changes one small thing at
//    once (a reset, a tick, a migration): its old copy of everything else went up with it and took the place of the
//    edits made since on the other device. Now, when the server has a newer copy than the one an edit was made on, only
//    what this device changed comes from its copy (mergeStale, a three way merge against the copy it started from),
//    the same rule the settings record got in PS 1.68 (core/cardsync.ts mergeSettings).

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Deep equality that ignores the order of an object's keys (JSON from two devices can list them differently). */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
    return true;
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined), kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!same(a[k], b[k])) return false;
    return true;
  }
  return false;
}

type Item = Obj & { id: string };
/** A list of items that each have their own id (mini tasks, goals): merged item by item, not as one value. */
function idList(v: unknown): v is Item[] {
  if (!Array.isArray(v)) return false;
  const seen = new Set<string>();
  for (const x of v) {
    if (!isObj(x) || typeof x.id !== "string" || seen.has(x.id)) return false;
    seen.add(x.id);
  }
  return true;
}

function mergeFields(base: Obj, local: Obj, remote: Obj): Obj {
  const out: Obj = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    const b = base[k], l = local[k], r = remote[k];
    const mine = !same(l, b), theirs = !same(r, b);
    let v: unknown;
    if (mine && theirs && idList(l) && idList(r)) v = mergeList(idList(b) ? b : [], l, r);
    else if (mine && theirs && Array.isArray(b) && Array.isArray(l) && Array.isArray(r)) v = grownBoth(b, l, r) ?? l;
    else v = mine ? l : r;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Break-it 1.74: a list of entries (objects) without ids that both sides only added to, at its start (a project's
 *  history, newest first, core/actions.ts updatePrivate) or at its end: both sides' new entries are kept (it used to keep
 *  only this device's, so an old device's one new line took the place of every line added since). Anything else (an
 *  empty start, plain values such as weekdays, a removal on either side): null, this device's list wins as before. */
function grownBoth(b: unknown[], l: unknown[], r: unknown[]): unknown[] | null {
  if (!b.length || ![...b, ...l, ...r].every(isObj)) return null;
  const head = (x: unknown[]) => x.length >= b.length && same(x.slice(x.length - b.length), b);
  const tail = (x: unknown[]) => x.length >= b.length && same(x.slice(0, b.length), b);
  const fresh = (add: unknown[], mine: unknown[]) => add.filter((x) => !mine.some((y) => same(x, y)));
  if (head(l) && head(r)) { const ln = l.slice(0, l.length - b.length), rn = r.slice(0, r.length - b.length); return [...ln, ...fresh(rn, ln), ...b]; }
  if (tail(l) && tail(r)) { const ln = l.slice(b.length), rn = r.slice(b.length); return [...b, ...fresh(rn, ln), ...ln]; }
  return null;
}

/** Two changed lists of items with ids, from one list they both started from. An item deleted on either side stays
 *  deleted, items added on either side are both kept, an item changed on both keeps each side's own changes, and the
 *  order is the one of the side that reordered (this device's when both did). */
export function mergeList(base: Item[], local: Item[], remote: Item[]): Item[] {
  const B = new Map(base.map((x) => [x.id, x])), L = new Map(local.map((x) => [x.id, x])), R = new Map(remote.map((x) => [x.id, x]));
  const common = (list: Item[], other: Map<string, Item>) => list.filter((x) => other.has(x.id)).map((x) => x.id);
  const localMoved = !same(common(base, L), common(local, B));
  const spine = localMoved ? local : remote, other = localMoved ? remote : local;
  const out: Item[] = [];
  const at = new Map<string, number>();
  const value = (id: string): Item | null => {
    const b = B.get(id), l = L.get(id), r = R.get(id);
    if (b) return l && r ? mergeFields(b, l, r) as Item : null;   // there before: deleted on one side means deleted
    return l && r ? mergeFields({}, l, r) as Item : (l || r || null);
  };
  for (const x of spine) { const v = value(x.id); if (v) { at.set(x.id, out.length); out.push(v); } }
  // What only the other side has (added there): right after the item it followed there, or first.
  for (let i = 0; i < other.length; i++) {
    const id = other[i].id;
    if (at.has(id)) continue;
    const v = value(id);
    if (!v) continue;
    let after = -1;
    for (let j = i - 1; j >= 0; j--) { const p = at.get(other[j].id); if (p !== undefined) { after = p; break; } }
    out.splice(after + 1, 0, v);
    for (const [k, p] of at) if (p > after) at.set(k, p + 1);
    at.set(id, after + 1);
  }
  return out;
}

/** This device's unsent copy (`local`) was made on `base`; the server now has a newer `remote`. What this device changed
 *  since `base` comes from its copy, everything else from the server's. Not an object on any side: this device's copy,
 *  as before. */
export function mergeStale<T>(base: unknown, local: T, remote: unknown): T {
  if (!isObj(base) || !isObj(local) || !isObj(remote)) return local;
  return mergeFields(base, local, remote) as T;
}

/** Records written by a machine, not edited by a person: each device's own screen time and hours, the Second Computer's
 *  jobs and messages between Macs (core/second.ts), and whole snapshots a feed replaces (calendar, brief, campaign
 *  numbers, which devices exist). Never merged (the newest copy is the whole truth) and never a reason to ask the server
 *  first, so their frequent writes cost nothing more. */
const OWN_DEVICE = new Set(["screentime", "stline", "calendar", "brief", "cstats", "phonedev", "bgdev",
  // Break-it 1.74: written by the mail feeds and the reply relay, never typed by a person (core/mailrules.ts, replyengine).
  "rout", "iemail", "ithread", "irep", "rwd",
  "sdev", "spair", "sjob", "sjobst", "smsg", "sfile", "sack", "sstat", "scmd", "sidx", "sget", "sgot", "sbudget", "sojob", "sores"]);
/** Does an unsent change of this kind look at the server first, so a newer copy there is merged and not replaced? */
export function checksFirst(kind: string | undefined): boolean {
  return !!kind && !OWN_DEVICE.has(kind);
}

/** The ids written while a long job ran (a rebuild of every record from storage). */
export class WriteWatch {
  private open = new Set<Set<string>>();
  private busy = new Map<string, number>();
  /** Starts watching. Ids being written right now count as written too (their copy may be read mid write). */
  start(): Set<string> {
    const s = new Set<string>(this.busy.keys());
    this.open.add(s);
    return s;
  }
  stop(s: Set<string>) { this.open.delete(s); }
  /** Is a write of this id on its way right now (begun, not yet in storage)? */
  busyWith(id: string): boolean { return this.busy.has(id); }
  /** A write of this id begins (memory first) ... */
  begin(id: string) {
    this.busy.set(id, (this.busy.get(id) || 0) + 1);
    for (const s of this.open) s.add(id);
  }
  /** ... and has reached storage. */
  end(id: string) {
    const n = (this.busy.get(id) || 1) - 1;
    if (n > 0) this.busy.set(id, n); else this.busy.delete(id);
    for (const s of this.open) s.add(id);
  }
}

/** A rebuilt list of records, with every id written during the rebuild taken from memory as it is now (or left out,
 *  when it was deleted meanwhile). */
export function keepWritten<D>(built: Map<string, D>, now: ReadonlyMap<string, D>, written: ReadonlySet<string>): Map<string, D> {
  for (const id of written) {
    const d = now.get(id);
    if (d !== undefined) built.set(id, d); else built.delete(id);
  }
  return built;
}

/** Steps for one id run one after another, in the order they were asked for; other ids never wait. */
export class IdLane {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(id) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    this.tails.set(id, tail);
    void tail.then(() => { if (this.tails.get(id) === tail) this.tails.delete(id); });
    return p;
  }
  idle(id: string) { return !this.tails.has(id); }
}

/** The series map's journal: one entry per day, week or month. Two records for one key (two saves that raced, two
 *  devices): the newest one, never whichever came last in the list (a month title could look deleted when the older,
 *  empty one won). */
export function journalByKey<D extends { id: string; updatedAt?: string | null; data: { key?: unknown; updatedAt?: string | null } }>(list: D[]): Map<string, D> {
  const out = new Map<string, D>();
  const at = (d: D) => `${d.data.updatedAt || ""}|${d.updatedAt || ""}|${d.id}`;
  for (const d of list) {
    const k = d.data?.key;
    if (typeof k !== "string") continue;
    const o = out.get(k);
    if (!o || at(d) > at(o)) out.set(k, d);
  }
  return out;
}

// Break-it 1.74: sends whose answer was lost (a request past its limit that may still have gone through). Kept on the unsent
// outbox row itself (`sent`, the copies sent since its server copy, oldest first), so they survive a reload and every one
// of them is known, not only the last. Never sent to the server (the send lists its fields).
// Break-it 1.74 round 2: `past`, sends no longer in doubt for the merge (answered, or made on a server copy older than
// the one the unsent copy is made on now). Only to know them if one comes down; never a merge's start, or a field another
// device set back to a value one of them held looked like this device's own send and the other device's change was undone.
export type SentRow = { ct: string; sent?: string[]; past?: string[] };
const SENT_MAX = 8;
const cap = (l: string[]) => (l.length ? l.slice(-SENT_MAX) : undefined);
/** Just before the request goes out (in place: the outbox keeps the same row). */
export function markSent(row: SentRow) {
  row.sent = [...(row.sent ?? []).filter((c) => c !== row.ct), row.ct].slice(-SENT_MAX);
}
/** A downloaded copy that is one this device sent itself (its answer was lost): never merged as another device's. */
export function isOwnSent(row: SentRow | undefined, ct: string): boolean {
  return !!row?.sent?.includes(ct) || !!row?.past?.includes(ct);
}
/** What a newer unsent copy of the record carries over from the one it replaces (put). */
export function carrySent(prev: SentRow | undefined): { sent?: string[]; past?: string[] } {
  return { ...(prev?.sent?.length ? { sent: prev.sent } : {}), ...(prev?.past?.length ? { past: prev.past } : {}) };
}
/** The answer for the send `ct` came back while a newer unsent copy stays (in place): it and the sends before it are
 *  settled, the server's copy is now the base of the next merge. */
export function settleSent(row: SentRow, ct: string) {
  const i = row.sent?.indexOf(ct) ?? -1;
  if (i < 0) return;
  row.past = cap([...(row.past ?? []), ...row.sent!.slice(0, i + 1)]);
  row.sent = cap(row.sent!.slice(i + 1));
}
/** The unsent copy is now made on the server's newer copy (mergeInto): the sends that copy shows arrived (`seen`,
 *  landedIn) are settled. One it does not show may still be on its way and land later, so it stays in doubt.
 *  Break-it 1.74 round 3: so are the sends made before the newest one it shows (they went first, as with settleSent and
 *  sentAfterOwn). A title changed twice, both answers lost, showed only the second: the first stayed in doubt, and
 *  another device renaming back to the first title looked like this device's own send and was undone. */
export function sentAfterMerge(row: SentRow, seen: string[]): { sent: string[] | undefined; past: string[] | undefined } {
  const l = row.sent ?? [];
  let last = -1;
  l.forEach((c, i) => { if (seen.includes(c)) last = i; });
  const past = [...(row.past ?? [])];
  for (const c of [...l.slice(0, last + 1), ...seen]) if (!past.includes(c)) past.push(c);
  return { sent: cap(l.slice(last + 1)), past: cap(past) };
}
/** Does the server's copy show that this send arrived: a field it changed from `old` (or, in a list of items with ids, an
 *  item it changed) is exactly what the server has now. */
export function landedIn(old: unknown, sent: unknown, remote: unknown): boolean {
  if (!isObj(old) || !isObj(sent) || !isObj(remote)) return false;
  for (const k of Object.keys(sent)) {
    if (same(sent[k], old[k])) continue;
    if (same(sent[k], remote[k])) return true;
    const s = sent[k], o = old[k], r = remote[k];
    if (idList(s) && idList(r)) {
      const O = new Map((idList(o) ? o : []).map((x) => [x.id, x])), R = new Map(r.map((x) => [x.id, x]));
      if (s.some((x) => !same(x, O.get(x.id)) && same(x, R.get(x.id)))) return true;
    }
  }
  return false;
}
/** This device's own send `ct` came down as the server's copy (mergeInto): the sends after it stay in doubt. */
export function sentAfterOwn(row: SentRow, ct: string): { sent: string[] | undefined; past: string[] | undefined } {
  const l = row.sent ?? [], i = l.indexOf(ct);
  return i < 0 ? { sent: cap(l), past: cap(row.past ?? []) } : { sent: cap(l.slice(i + 1)), past: cap([...(row.past ?? []), ...l.slice(0, i + 1)]) };
}
/** The copy a merge starts from while sends of this device are in doubt (`sent`: the copies it sent, any of which may or
 *  may not have arrived; `old`: the server copy before them; `remote`: the server's newer copy). Field by field, and item
 *  by item in lists of items with ids (mini tasks): where the server has exactly what one of the sends had, that send
 *  arrived and the server built on it, so it is the start (what this device changed after it is kept, and nothing it
 *  already sent comes back as the other device's change). Anywhere else the old value (this device's change is kept). */
export function inDoubtBase(old: unknown, sent: unknown[], remote: unknown): unknown {
  if (!isObj(old) || !isObj(remote)) return old;
  const sents = sent.filter(isObj);
  if (!sents.length) return old;
  const out: Obj = {};
  for (const k of new Set([...Object.keys(old), ...sents.flatMap((x) => Object.keys(x))])) {
    const r = remote[k];
    let v: unknown = old[k];
    if (sents.some((x) => same(x[k], r))) v = r;
    else if (idList(r) && sents.some((x) => idList(x[k]))) v = itemBase(idList(old[k]) ? old[k] as Item[] : [], sents.map((x) => x[k]).filter(idList), r);
    if (v !== undefined) out[k] = v;
  }
  return out;
}
/** inDoubtBase for one list of items with ids: per item, a send's version (or its absence) where the server's matches it. */
function itemBase(old: Item[], sents: Item[][], remote: Item[]): Item[] {
  const O = new Map(old.map((x) => [x.id, x])), R = new Map(remote.map((x) => [x.id, x]));
  const S = sents.map((l) => new Map(l.map((x) => [x.id, x])));
  const pick = (id: string): Item | undefined => (S.some((m) => same(m.get(id), R.get(id))) ? R.get(id) : O.get(id));
  const out: Item[] = [];
  const seen = new Set<string>();
  for (const x of [...old, ...sents.flat(), ...remote]) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    const v = pick(x.id);
    if (v) out.push(v);
  }
  return out;
}

/** Another device deleted the record after the copy this device's unsent edit was made on: the edit is dropped, or
 *  sending it would bring the record back (core/dimxmove.ts staleEditOfDeleted, PS 1.68 for tasks; break-it 1.74: every
 *  kind a person edits, except kinds with their own merger, such as the settings record). */
export function staleEditGone(kind: string | undefined, hasMerger: boolean, mine: { deleted: boolean; base: string | null }, remote: { deleted: boolean; updated_at: string | null }): boolean {
  // journal: a second record for one month is deleted as a normal step when two saves raced (core/actions.ts setJournal
  // folds it); a newer title in it must not be dropped with it (the newest one wins on screen, core/keepedits.ts journalByKey).
  if (!kind || hasMerger || kind === "journal" || !(kind === "todo" || checksFirst(kind))) return false;
  return !mine.deleted && remote.deleted && mine.base !== null && mine.base !== remote.updated_at;
}
