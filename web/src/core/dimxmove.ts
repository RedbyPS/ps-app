// Moves between Dimension X's ideas (settings.dimx) and tasks (todo records), PS 1.68. The developer's friend, 18 Nov 2026: a task moved
// from Your tasks to Ideas "sometimes" stayed in both places, and moving things around made duplicate tasks.
//
// The rule: a move keeps the item's id on both sides. A task that becomes an idea gives its id to the card, a card that
// becomes a task gives its id to the task. So:
// - a move that runs twice (a retry, a message sent twice, two devices doing the same move) finds the id already there
//   and never adds a second copy;
// - a move cut in half (the new place saved, the old one not), or an old copy brought back by another device, leaves the
//   SAME id in both places, which proves the two are one item. tidyMoves then keeps the copy that arrived last (the
//   newest move is what the person did last) and takes the older one away, but only when both still say the same words.
//   If either was edited, both stay and the person decides.
// - Items with different ids are never merged, whatever their words: nothing is ever deleted on a guess.
// The writes themselves are in core/actions.ts (moveTaskToIdea, moveIdeaToTask, tidyMoves), one at a time in one lane.
import type { DimxItem, DimxZone, Doc, Todo } from "./model";

export const ZONES: readonly DimxZone[] = ["act", "soon", "x"];
const isZone = (v: unknown): v is DimxZone => v === "act" || v === "soon" || v === "x";

/** Puts a card into its band at a position counted inside that band only. A card with the same id moves (never two). */
export function insertDimx(list: DimxItem[], item: DimxItem, index: number): DimxItem[] {
  const rest = list.filter((x) => x.id !== item.id);
  const band = rest.filter((x) => x.zone === item.zone);
  const i = Math.max(0, Math.floor(Number.isFinite(index) ? index : band.length));
  const at = i < band.length ? rest.indexOf(band[i]) : band.length ? rest.indexOf(band[band.length - 1]) + 1 : rest.length;
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}

/** The cards after a task became an idea in `zone` at `index`: the card has the task's id and is dated now (when it
 *  arrived there). A card with that id already there (the same move again) stays where it is, unchanged. */
export function taskToIdea(dimx: DimxItem[], task: { id: string; title: string }, zone: DimxZone, index: number, now: string): DimxItem[] {
  if (dimx.some((x) => x.id === task.id)) return dimx;
  const text = task.title.trim().slice(0, 500) || "Untitled";
  return insertDimx(dimx, { id: task.id, text, zone, createdAt: now }, index);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const when = (s: unknown) => (typeof s === "string" ? Date.parse(s) : NaN);

/**
 * Half done moves: a card and a live task with the SAME id and the same words. The one that arrived in its place last
 * stays, the other goes. A task that is done, or either side edited (different words), or no clear newer side: both stay.
 */
export function moveLeftovers(dimx: DimxItem[], tasks: Doc<Todo>[]): { dimx: DimxItem[] | null; tasks: string[] } {
  const byId = new Map(tasks.filter((d) => d.kind === "todo").map((d) => [d.id, d]));
  const dropCards = new Set<string>(), dropTasks: string[] = [];
  for (const c of dimx) {
    const t = byId.get(c.id);
    if (!t || t.data.done || !same(c.text, t.data.title || "")) continue;
    const card = when(c.createdAt), task = when(t.data.createdAt);
    if (!Number.isFinite(card) || !Number.isFinite(task) || card === task) continue;
    if (card > task) dropTasks.push(t.id); else dropCards.add(c.id);
  }
  return { dimx: dropCards.size ? dimx.filter((c) => !dropCards.has(c.id)) : null, tasks: dropTasks };
}

/**
 * Two devices (PS 1.68): device A moved a task away (to Ideas, or deleted it) while device B still held an unsent edit of
 * it, made on its older copy (a tick, an order change). Sending that edit would bring the task back, so it is in both
 * places. When the server says the task was deleted after the copy the edit was made on, the edit is dropped.
 * base: the server time of the copy the unsent edit was made on (null: made fresh, eg Undo of a delete, which stays).
 */
export function staleEditOfDeleted(kind: string | undefined, mine: { deleted: boolean; base: string | null }, remote: { deleted: boolean; updated_at: string | null }): boolean {
  return kind === "todo" && !mine.deleted && remote.deleted && mine.base !== null && mine.base !== remote.updated_at;
}

/** A move asked for by the Tab list window on the Mac (it holds no keys): checked here, run by the main window. */
export type DimxOp =
  | { op: "toIdea"; id: string; zone: DimxZone; index: number }
  | { op: "toTask"; id: string; order: number; p1: boolean }
  | { op: "tidy" };
const okId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v);
export function cleanDimxOp(v: unknown): DimxOp | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.op === "tidy") return { op: "tidy" };
  if (!okId(o.id)) return null;
  const n = Number(o.op === "toIdea" ? o.index : o.order);
  if (!Number.isFinite(n)) return null;
  if (o.op === "toIdea" && isZone(o.zone)) return { op: "toIdea", id: o.id, zone: o.zone, index: Math.max(0, Math.min(10_000, Math.round(n))) };
  if (o.op === "toTask") return { op: "toTask", id: o.id, order: n, p1: o.p1 === true };
  return null;
}

/** Where a dragged task lands in a section, as core/groups.ts planMove counts it (the moved task still counted where it
 *  was). `shown`: the drop place counted on screen without the dragged row; `from`: its place in that same section
 *  before the drag (-1: it came from somewhere else). */
export function dropIndex(shown: number, from: number): number {
  return from >= 0 && from <= shown ? shown + 1 : shown;
}
