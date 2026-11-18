// G Squad (V1.40) in the Tab list: the plain view the main page sent (it holds no keys here) and the one way back.
// On the website (V1.44, the To-do page in web form) the engine runs in this very page (squad/webhost.ts), so the
// screens read it and call it directly, the way the chat does (squad/chatmirror.ts).
import { useSyncExternalStore } from "react";
import { cleanAiView, cleanAutoView, cleanSquadOp, EMPTY_VIEW, type DirView, type FriendView, type SquadOp, type SquadView } from "./view";
import { runSquadOp, squadStore } from "./engine";
import { runBoardOp } from "./board";
import { cleanBoardView } from "./boardmirror";
import type { BoardOp } from "../core/squadboard";

const PS = import.meta.env.MODE === "ps";
let mirror: SquadView = EMPTY_VIEW;
const subs = new Set<() => void>();
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const arr = (v: unknown, max: number) => (Array.isArray(v) ? v.slice(0, max).filter((x) => x && typeof x === "object") : []);

function cleanDirView(v: unknown): DirView | null {
  const o = (v && typeof v === "object" ? v : null) as Record<string, unknown> | null;
  if (!o) return null;
  const a = (o.ask && typeof o.ask === "object" ? o.ask : null) as Record<string, unknown> | null;
  const state = a?.state === "declined" || a?.state === "cancelled" ? a.state : "open";
  return {
    list: Array.isArray(o.list) ? arr(o.list, 20).map((e) => ({ id: str((e as { id?: unknown }).id, 40), name: str((e as { name?: unknown }).name, 40) })) : null,
    canCreate: o.canCreate === true,
    ask: a ? { squadId: str(a.squadId, 40), name: str(a.name, 40), me: str(a.me, 40), state, code: str(a.code, 8), at: str(a.at, 40), againAt: typeof a.againAt === "string" ? a.againAt.slice(0, 40) : null } : null,
    busy: typeof o.busy === "string" ? o.busy.slice(0, 60) : null, error: typeof o.error === "string" ? o.error.slice(0, 200) : null,
  };
}
function cleanFriendView(v: unknown): FriendView | null {
  const o = (v && typeof v === "object" ? v : null) as Record<string, unknown> | null;
  if (!o) return null;
  if (o.kind === "join") return { kind: "join", url: str(o.url, 300), expiresAt: str(o.expiresAt, 40) };
  if (o.kind === "ask") return { kind: "ask", url: str(o.url, 300), expiresAt: str(o.expiresAt, 40) };
  if (o.kind === "none") return { kind: "none", why: o.why === "private" ? "private" : "no-squad" };
  if (o.kind === "busy") return { kind: "busy" };
  if (o.kind === "error") return { kind: "error", message: str(o.message, 200) };
  return null;
}
/** The squad's Priority 1 rows, shape and length checked (squad/view.ts P1Row). */
function cleanP1Rows(v: unknown): SquadView["p1"] {
  return arr(v, 8).map((r) => { const x = r as Record<string, unknown>;
    return { id: str(x.id, 60), member: str(x.member, 40), t: str(x.t, 300), s: str(x.s, 40), x: x.x === true, ...(typeof x.xa === "string" ? { xa: x.xa.slice(0, 40) } : {}) }; })
    .filter((r) => r.id && r.member && r.t && Number.isFinite(Date.parse(r.s)));
}
/** PS 1.68 the Squad Priority 1 board (core/squadp1board.ts P1Person), shape and length checked. */
function cleanP1Board(v: unknown): SquadView["p1b"] {
  if (!Array.isArray(v)) return undefined;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.min(1e13, Math.round(x)) : 0);
  return arr(v, 40).map((p) => { const x = p as Record<string, unknown>; const s = (x.stats ?? {}) as Record<string, unknown>;
    const rate = typeof s.rate === "number" && s.rate >= 0 && s.rate <= 100 ? Math.round(s.rate) : null;
    return { member: str(x.member, 40), name: str(x.name, 60), me: x.me === true, place: Number.isInteger(x.place) && (x.place as number) > 0 ? Math.min(999, x.place as number) : null,
      rows: (cleanP1Rows(arr(x.rows, 12)) ?? []).slice(0, 12), stats: { hits: n(s.hits), total: n(s.total), rate, streak: n(s.streak), from: n(s.from) } }; })
    .filter((p) => p.member);
}
/** From the state PS hands the Tab list (null while locked). Checked lightly: shapes and lengths only. */
export function setSquadMirror(v: unknown) {
  const o = (v && typeof v === "object" ? v : null) as Record<string, unknown> | null;
  const next: SquadView = !o ? EMPTY_VIEW : {
    in: o.in === true, name: str(o.name, 60), me: str(o.me, 40), meName: str(o.meName, 40), creator: o.creator === true,
    count: Number.isInteger(o.count) ? (o.count as number) : null, waiting: Number.isInteger(o.waiting) ? (o.waiting as number) : 0,
    members: arr(o.members, 40) as SquadView["members"], tasks: arr(o.tasks, 600) as SquadView["tasks"], hands: arr(o.hands, 100) as SquadView["hands"],
    link: o.link && typeof o.link === "object" ? { url: str((o.link as { url?: unknown }).url, 300), expiresAt: str((o.link as { expiresAt?: unknown }).expiresAt, 40) } : null,
    busy: typeof o.busy === "string" ? o.busy.slice(0, 60) : null, error: typeof o.error === "string" ? o.error.slice(0, 200) : null, loaded: o.loaded === true,
    board: cleanBoardView(o.board),
    dir: cleanDirView(o.dir), asks: arr(o.asks, 20).map((a) => { const x = a as Record<string, unknown>;
      return { id: str(x.id, 40), name: str(x.name, 40), code: str(x.code, 8), at: str(x.at, 40), ok: x.ok === true }; }),
    auto: cleanAutoView(o.auto),
    friend: cleanFriendView(o.friend),
    ai: cleanAiView(o.ai),
    p1: cleanP1Rows(o.p1),
    p1b: cleanP1Board(o.p1b),
    p1since: typeof o.p1since === "string" && Number.isFinite(Date.parse(o.p1since)) ? o.p1since.slice(0, 40) : undefined,
  };
  if (o) mirrorSet = true;
  if (JSON.stringify(next) === JSON.stringify(mirror)) return;
  mirror = next;
  subs.forEach((l) => l());
}
const mirrorStore = { subscribe: (l: () => void) => { subs.add(l); return () => { subs.delete(l); }; }, get: () => mirror };
/** The website reads the engine in its own page; PS's Tab list (and the dev pictures, which fill the mirror) the copy. */
const local = () => !PS && !mirrorSet;
let mirrorSet = false;
export function useSquad(): SquadView {
  const st = local() ? squadStore : mirrorStore;
  return useSyncExternalStore(st.subscribe, st.get);
}
export function squadNow(): SquadView { return local() ? squadStore.get() : mirror; }

type W = Window & { webkit?: { messageHandlers?: { ps?: { postMessage(m: string): void } } } };
/** A button in the Tab list: to the main page, which checks it again (squad/view.ts cleanSquadOp) and runs it. */
export function squadOp(o: SquadOp) {
  if (local()) { const c = cleanSquadOp(o); if (c) void runSquadOp(c); return; }
  try { (window as W).webkit?.messageHandlers?.ps?.postMessage(JSON.stringify({ type: "looks", patch: { squadOp: o } })); } catch { /* not inside PS */ }
}
/** A Leaderboard button in the Tab list: to the main page (squad/board.ts checks it again). */
export function boardOp(o: BoardOp) {
  if (local()) { void runBoardOp(o).catch(() => {}); return; }
  try { (window as W).webkit?.messageHandlers?.ps?.postMessage(JSON.stringify({ type: "looks", patch: { boardOp: o } })); } catch { /* not inside PS */ }
}
