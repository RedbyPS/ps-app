// A background for each device (PS 1.65, feature "device-backgrounds", the developer 16 Nov 2026: "in Settings, Looks, click a
// background and tick which of your devices use it: this Mac, another Mac, the phone. Each device then shows its own").
//
// Two small pieces, both pure here (tests/devicebg.test.ts), drawn by views/DeviceBg.tsx:
//  1. THE DEVICES. Each device that opens PS signed in keeps one tiny encrypted vault record about itself (kind "bgdev"):
//     a random id kept on that device, what kind it is (Mac, phone, browser), a name, and when it was last seen. It is
//     written only when something changed or once a day (change only: nothing polls). A device not seen for 90 days is
//     no longer listed. A person can rename a device; their name is kept and never overwritten by the default.
//  2. THE PICKS. settings.tmBgDev: device id -> { b: background id or null, t: when }. A device with no entry (or one that
//     is no longer valid, for example a video that was deleted) shows what it always showed: the shared background
//     (settings.tmBg, or on a phone its own phone background, core/bgcrop.ts). So nothing changes until somebody ticks
//     a device, an older PS that does not know the field keeps working (it keeps showing tmBg and keeps the field when it
//     saves), and a removed or renamed device breaks nothing: its entry is simply never read.
//     b null is a "forgotten" mark (a removed pick) so two devices merge entry by entry and a removal sticks; marks go
//     after 30 days. At most 12 entries are kept, the newest first, so the setting stays under 1 KB.
// No em or en dashes in any word here.

export type DevKind = "mac" | "phone" | "web";
export interface Device { dev: string; kind: DevKind; name: string; own?: true; seen: string }
export interface Pick { b: string | null; t: number }
export type Picks = Record<string, Pick>;

const DEV = /^[a-z0-9]{8,32}$/;
const KINDS: DevKind[] = ["mac", "phone", "web"];
/** A device not seen for this long is no longer one of yours (its record stays in the vault, it is just not offered). */
export const STALE_DAYS = 90;
/** A device writes its record again at most this often when nothing changed. */
export const BEAT_HOURS = 20;
/** Most devices listed, most recently seen first. */
export const DEVICES_MAX = 8;
/** Most picks kept (a pick is about 60 bytes). */
export const PICKS_MAX = 12;
/** A removed pick is remembered this long so a merge does not bring it back. */
export const MARK_DAYS = 30;
export const NAME_MAX = 30;
const DAY = 864e5;

/** The words for "this device" in the list. */
export const HERE: Record<DevKind, string> = { mac: "This Mac", phone: "This phone", web: "This browser" };
/** The name a device gets until the person renames it. */
export const KIND_NAME: Record<DevKind, string> = { mac: "Mac", phone: "Phone", web: "Browser" };

/** Which kind this device is. mode: the build mode ("ps" Mac app, "gos" Android app); mobile: the iPhone web app. */
export function deviceKind(mode: string, mobile: boolean): DevKind {
  return mode === "ps" ? "mac" : mode === "gos" || mobile ? "phone" : "web";
}

/** A name from the user agent, for a phone that is not the Android app ("iPhone", "iPad"). */
export function uaName(kind: DevKind, ua: string): string {
  if (kind === "phone") return /iPad/.test(ua) ? "iPad" : /iPhone/.test(ua) ? "iPhone" : /Android/.test(ua) ? "Android phone" : KIND_NAME.phone;
  return KIND_NAME[kind];
}

export const cleanName = (v: unknown): string =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u2013\u2014]/g, " ").replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";

/** A device record, checked. Null: not one. */
export function cleanDevice(v: unknown): Device | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  if (typeof o.dev !== "string" || !DEV.test(o.dev) || !KINDS.includes(o.kind as DevKind)) return null;
  if (typeof o.seen !== "string" || Number.isNaN(Date.parse(o.seen))) return null;
  const kind = o.kind as DevKind;
  const d: Device = { dev: o.dev, kind, name: cleanName(o.name) || KIND_NAME[kind], seen: o.seen };
  if (o.own === true) d.own = true;
  return d;
}

/** The account's devices: each once (its newest record), stale ones left out, most recently seen first, at most 8. */
export function devicesOf(records: unknown[], now = Date.now()): Device[] {
  const best = new Map<string, Device>();
  for (const r of records) {
    const d = cleanDevice(r);
    if (!d || now - Date.parse(d.seen) > STALE_DAYS * DAY) continue;
    const had = best.get(d.dev);
    if (!had || Date.parse(d.seen) > Date.parse(had.seen)) best.set(d.dev, d);
  }
  return [...best.values()].sort((a, b) => Date.parse(b.seen) - Date.parse(a.seen) || a.dev.localeCompare(b.dev)).slice(0, DEVICES_MAX);
}

/** Should this device write its record now? Only when it is new, its kind or name changed, or a day went by. */
export function shouldBeat(prev: Device | null, next: { kind: DevKind; name: string }, now = Date.now()): boolean {
  if (!prev) return true;
  if (prev.kind !== next.kind) return true;
  if (!prev.own && prev.name !== next.name) return true;
  return now - Date.parse(prev.seen) > BEAT_HOURS * 3600e3;
}

/** The record to write for a beat: a name the person chose is kept, the default name is only used until then. */
export function beatRecord(prev: Device | null, id: { dev: string; kind: DevKind; name: string }, now = Date.now()): Device {
  const keepOwn = !!prev?.own && prev.kind === id.kind;
  const d: Device = { dev: id.dev, kind: id.kind, name: keepOwn ? prev!.name : cleanName(id.name) || KIND_NAME[id.kind], seen: new Date(now).toISOString() };
  if (keepOwn) d.own = true;
  return d;
}

/** The record after the person renames a device. An empty name goes back to the default. */
export function renamed(prev: Device, name: string, now = Date.now()): Device {
  const n = cleanName(name);
  const d: Device = { dev: prev.dev, kind: prev.kind, name: n || KIND_NAME[prev.kind], seen: new Date(now).toISOString() };
  if (n) d.own = true;
  return d;
}

export interface Row { dev: string; kind: DevKind; label: string; here: boolean }
/** What the list shows: this device first as "This Mac", the others by name. Two with the same name get (1), (2). */
export function rows(devs: Device[], thisId: string): Row[] {
  const out: Row[] = [];
  const me = devs.find((d) => d.dev === thisId);
  if (me) out.push({ dev: me.dev, kind: me.kind, label: me.own ? `${HERE[me.kind]} (${me.name})` : HERE[me.kind], here: true });
  const rest = devs.filter((d) => d.dev !== thisId);
  for (const d of rest) {
    const twins = rest.filter((x) => x.name === d.name);
    out.push({ dev: d.dev, kind: d.kind, label: twins.length > 1 ? `${d.name} (${twins.indexOf(d) + 1})` : d.name, here: false });
  }
  return out;
}

// ---------- the picks ----------
/** The saved picks, checked: known device ids, a short background id or a removed mark, newest 12, old marks gone. */
export function cleanPicks(v: unknown, now = Date.now()): Picks {
  const o = (v && typeof v === "object" && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const list: [string, Pick][] = [];
  for (const k of Object.keys(o).slice(0, 100)) {
    const p = o[k] as { b?: unknown; t?: unknown } | null;
    if (!DEV.test(k) || !p || typeof p !== "object") continue;
    const t = typeof p.t === "number" && Number.isFinite(p.t) && p.t > 0 ? Math.round(p.t) : 0;
    const b = p.b === null ? null : typeof p.b === "string" && p.b.length > 0 && p.b.length <= 60 ? p.b : undefined;
    if (b === undefined || !t) continue;
    if (b === null && now - t > MARK_DAYS * DAY) continue;
    list.push([k, { b, t }]);
  }
  list.sort((a, b) => b[1].t - a[1].t || a[0].localeCompare(b[0]));
  return Object.fromEntries(list.slice(0, PICKS_MAX));
}

/** This device's own pick, or null (no choice, a removed mark, or a background that is no longer there): then it shows what it always did. */
export function pickOf(picks: unknown, dev: string, valid: (bg: string) => boolean): string | null {
  const p = picks && typeof picks === "object" ? (picks as Picks)[dev] : undefined;
  return p && typeof p.b === "string" && valid(p.b) ? p.b : null;
}

/** The background a device shows: its own pick, else the fallback (the shared background, or the phone's own). */
export function effective(picks: unknown, dev: string, valid: (bg: string) => boolean, fallback: string | null | undefined): string | null | undefined {
  return pickOf(picks, dev, valid) ?? fallback;
}

/** One pick set (bg) or removed (null), the rest kept. Returns the whole next map. */
export function withPick(picks: unknown, dev: string, bg: string | null, now = Date.now()): Picks {
  const cur = cleanPicks(picks, now);
  if (bg === null && !cur[dev]) return cur;
  return cleanPicks({ ...cur, [dev]: { b: bg, t: now } }, now);
}

/** Every device back to the shared background. */
export function withoutPicks(picks: unknown, now = Date.now()): Picks {
  const cur = cleanPicks(picks, now);
  const out: Record<string, Pick> = {};
  for (const k of Object.keys(cur)) out[k] = { b: null, t: now };
  return cleanPicks(out, now);
}

export const hasPicks = (picks: unknown, valid: (bg: string) => boolean): boolean =>
  Object.keys(cleanPicks(picks)).some((k) => pickOf(picks, k, valid) !== null);

/** Two devices' copies joined: per device, the pick set later wins (a removal too); a tie keeps the local one. */
export function mergePicks(local: unknown, remote: unknown, now = Date.now()): Picks | null {
  const a = cleanPicks(local, now), b = cleanPicks(remote, now);
  if (!Object.keys(a).length && !Object.keys(b).length) return null;
  const out: Record<string, Pick> = { ...a };
  for (const k of Object.keys(b)) if (!out[k] || b[k].t > out[k].t) out[k] = b[k];
  return cleanPicks(out, now);
}

export interface Tick { dev: string; label: string; here: boolean; on: boolean; /** Shows it only because the shared background is it: there is no pick of its own to remove. */ shared: boolean }
/** The ticks for one background: a device is ticked when it shows that background now. */
export function ticks(list: Row[], picks: unknown, bg: string, shared: string | null | undefined, valid: (bg: string) => boolean): Tick[] {
  return list.map((r) => {
    const own = pickOf(picks, r.dev, valid);
    return { dev: r.dev, label: r.label, here: r.here, on: (own ?? shared) === bg, shared: own === null && shared === bg };
  });
}

/** A tick clicked. Ticking sets this device's pick; unticking removes it (a device that only follows the shared one has none to remove). */
export function applyTick(picks: unknown, dev: string, bg: string, on: boolean, now = Date.now()): Picks {
  return withPick(picks, dev, on ? bg : null, now);
}

/** A background tile clicked on this device: only a device that already has a pick of its own moves it (the shared background is always written by the caller). */
export function tilePicks(picks: unknown, dev: string, bg: string, valid: (bg: string) => boolean, now = Date.now()): Picks | null {
  return pickOf(picks, dev, valid) === null ? null : withPick(picks, dev, bg, now);
}

/** A video was replaced by a new copy: every pick of the old one moves to the new one (null: none did). */
export function followPicks(picks: unknown, from: string, to: string, now = Date.now()): Picks | null {
  const cur = cleanPicks(picks, now);
  const hit = Object.keys(cur).filter((k) => cur[k].b === from);
  if (!hit.length) return null;
  const out: Record<string, Pick> = { ...cur };
  for (const k of hit) out[k] = { b: to, t: now };
  return cleanPicks(out, now);
}

/** "Same background on every device": every pick removed and the shared background becomes the one on screen. */
export function resetPatch(picks: unknown, shown: string | null | undefined, now = Date.now()): { tmBgDev: Picks; tmBg: string } {
  return { tmBgDev: withoutPicks(picks, now), tmBg: typeof shown === "string" && shown ? shown : "none" };
}

/** Which device records are old enough to delete (not seen for STALE_DAYS, or not a record at all is left alone). */
export function staleIds(recs: { id: string; data: unknown }[], now = Date.now()): string[] {
  return recs.filter((r) => { const d = cleanDevice(r.data); return !!d && now - Date.parse(d.seen) > STALE_DAYS * DAY; }).map((r) => r.id);
}

/** A device id: random, kept in that device's own storage, never anything that identifies the hardware. */
export interface Store { getItem(k: string): string | null; setItem(k: string, v: string): void }
export const ID_KEY = "ps.device.id";
let memoryId = "";
export function deviceId(store: Store | null, rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  try { const v = store?.getItem(ID_KEY); if (v && /^[a-z0-9]{16}$/.test(v)) return v; } catch { /* storage off */ }
  const id = memoryId || Array.from(rand(16), (x) => "abcdefghijklmnopqrstuvwxyz0123456789"[x % 36]).join("");
  try { store?.setItem(ID_KEY, id); } catch { /* storage off: the id lasts until the page closes */ }
  memoryId = id;
  return id;
}
export const forgetMemoryId = () => { memoryId = ""; };
