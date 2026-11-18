// Dimension X, Lists view (Task API release; the developer's friend: "rn the new pages.. i can add tasks there but i dont have a
// way in dimension x to manage that"). Every to-do list page (V1.55, core/lists.ts) side by side in its order, with its
// sections and tasks: open a list (Dimension X closes and the Tab list slides to it), rename it (double click its name),
// move it left or right, delete it (move its tasks to the main list, or delete them too, with Undo), add a new list,
// and per task: tick, move to another list, delete (with Undo). Pages that hold panels (Edit mode) are left out.
// Every change goes through the same functions as the list's own menus (views/ListPager.tsx), so it is one write each.
// Also MoveMenu: the small menu that sends a task to another list, or out of the AI Inbox (core/aiinbox.ts).
// PS 1.68 (the developer's friend, 18 Nov 2026): press, hold and drag a task to reorder it inside a list, onto another list, or in from Your
// task list and the AI Inbox on the right. The drag is Dimension X's own (views/DimensionX.tsx Board: the same lifted
// card, the gap that opens, the glide into place, Esc puts it back), so the Lists view gets `dnd` from the Board and each
// section is a drop place (data-zone "s:<section>"). The Move menu offers every place, grouped and coloured by level:
// the action level (every list, then Actionables), The Upside Down, Dimension X.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Doc, DimxZone, Todo } from "../core/model";
import { MAIN, allPages, movePage, secsByPage, shownName, LIST_NAME_MAX, PAGES_MAX } from "../core/lists";
import { groupOf, newGroupId } from "../core/groups";
import { isEveryDay } from "../core/repeat";
import { inInbox, inboxMove } from "../core/aiinbox";
import { fmtDate } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { deleteList, goToPage, listCtx, moveToList, newList, renameList, setPageOrder } from "./ListPager";
import { taskMapActions } from "./TaskMap";
import "./dimxlists.css";

/** Esc inside the Lists view: a rename, a delete question or a menu closes first (Dimension X asks this first). */
let escNow: () => boolean = () => false;
export const listsEscape = () => escNow();

/** A task row as the Board's drag sees it (views/DimensionX.tsx Card). */
export type ListCard = { key: string; id: string; text: string; zone: string; due?: string | null; ai?: boolean; type?: Todo["type"]; done?: boolean; pending?: boolean };
/** What the Board lends the Lists view so its rows drag like every card in Dimension X. */
export type ListDnd = {
  /** The rows of one section, with the gap where a dragged task would land. */
  rows: (zone: string, render: (c: ListCard) => ReactNode) => ReactNode[];
  /** Spread on each row: its key for the glide, and the press that starts a drag. */
  rowProps: (c: ListCard) => { "data-k": string; onPointerDown: (e: React.PointerEvent<HTMLElement>) => void };
  /** The section a dragged task is over (its zone), and whether a task is being dragged at all. */
  over: string | null; dragging: boolean;
};
export const secZone = (key: string) => `s:${key}`;
export function secTasks(key: string): Doc<Todo>[] {
  const l = listCtx().lists, g = groupOf(key);
  if (g) return l.groups.get(g) ?? [];
  return key === "p1" ? l.p1 : key === "prio" ? l.prio : key === "daily" ? l.daily : [];
}
export const cardOf = (d: Doc<Todo>, zone: string): ListCard =>
  ({ key: `l:${d.id}`, id: d.id, text: d.data.title, zone, due: d.data.due, ai: d.data.ai === true, type: d.data.type, done: !!d.data.done });
/** Every task on a list, by id (a row held in its new place for a moment is still found). */
const allTasks = () => { const l = listCtx().lists; return new Map([...l.ranked, ...l.daily, ...[...l.groups.values()].flat()].map((d) => [d.id, d])); };
const secName = (key: string): string => {
  const c = listCtx(), g = groupOf(key);
  if (g) return c.groups.find((x) => x.id === g)?.name || "Group";
  if (key === "daily") return shownName(c.names, "daily", c.lists.daily.every((d) => isEveryDay(d.data)));
  return shownName(c.names, key as "p1" | "prio");
};
/** The list pages (not the pages of panels), left to right, with their names. */
export function taskPages(): { id: string; name: string }[] {
  const c = listCtx();
  return allPages(c.pages, c.names, c.order).filter((p) => p.id === MAIN || c.pages.find((x) => x.id === p.id)?.kind !== "panels");
}

export function DimxLists({ onOpen, onUndo, dnd }: { onOpen: () => void; onUndo: (text: string, restore: () => void) => void; dnd?: ListDnd }) {
  const c = listCtx();
  const byPage = secsByPage(c.full, c.pages);
  const pages = taskPages();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; page: string; at: DOMRect } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cancelRename = useRef<() => void>(() => setRenaming(null));
  escNow = () => {
    if (menu) { setMenu(null); return true; }
    if (renaming) { cancelRename.current(); return true; }
    if (asking) { setAsking(null); return true; }
    return false;
  };
  useEffect(() => () => { escNow = () => false; }, []);

  const move = (id: string, by: -1 | 1) => { sfx.drop(); setPageOrder(movePage(c.order, id, by)); };
  const open = (id: string) => { sfx.click(); onOpen(); window.setTimeout(() => goToPage(id), 60); };
  const docs = allTasks();
  const delTask = (d: Doc<Todo>) => {
    sfx.click();
    void taskMapActions.remove(d.id);
    onUndo(d.data.title, () => { void taskMapActions.restore(d.id, d.data); });
  };
  const order = c.order.filter((id) => pages.some((p) => p.id === id));

  return (
    <div ref={root} className="dl-wrap" aria-label="Your lists">
      <div className="dl-cols">
        {pages.map((p) => {
          const keys = byPage.get(p.id) ?? [];
          const count = keys.reduce((n, k) => n + secTasks(k).filter((d) => !d.data.done).length, 0);
          const at = order.indexOf(p.id);
          return (
            <section key={p.id} className={`dl-col${p.id === MAIN ? " home" : ""}`} aria-label={p.name}>
              <header className="dl-head">
                {renaming === p.id ? (
                  <RenameBox value={p.name} cancelRef={cancelRename} onDone={(v) => { setRenaming(null); if (v !== null && v.trim() !== p.name) { sfx.click(); renameList(p.id, v); } }} />
                ) : (
                  <h3 className="dl-name" title="Double click to rename" onDoubleClick={() => { sfx.click(); setRenaming(p.id); }}>
                    {p.id === MAIN ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-label="Home"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg> : null}
                    <span>{p.name}</span>
                  </h3>
                )}
                <span className="dx-band-n num">{count}</span>
                <span className="dl-tools">
                  <button type="button" className="dl-btn" disabled={at <= 0} onClick={() => move(p.id, -1)} aria-label={`Move ${p.name} left`} title="Move left">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
                  </button>
                  <button type="button" className="dl-btn" disabled={at < 0 || at >= order.length - 1} onClick={() => move(p.id, 1)} aria-label={`Move ${p.name} right`} title="Move right">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
                  </button>
                  <button type="button" className="dl-btn" onClick={() => { sfx.click(); setRenaming(p.id); }} aria-label={`Rename ${p.name}`} title="Rename">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
                  </button>
                  <button type="button" className="dl-btn wide" onClick={() => open(p.id)} title="Show this list in the Tab list">Open</button>
                  {p.id !== MAIN ? <button type="button" className="dl-btn bad" onClick={() => { sfx.click(); setAsking(asking === p.id ? null : p.id); }} aria-label={`Delete ${p.name}`} title="Delete list" aria-expanded={asking === p.id}>×</button> : null}
                </span>
              </header>
              {asking === p.id ? (
                <div className="dl-ask" role="group" aria-label={`Delete ${p.name}?`}>
                  <b>Delete {p.name}?</b>
                  <button type="button" className="dl-pick" onClick={() => { setAsking(null); deleteList(p.id, false); }}>{count ? `Delete, move its ${count} ${count === 1 ? "task" : "tasks"} to the main list` : "Delete the list"}</button>
                  {count ? <button type="button" className="dl-pick bad" onClick={() => { setAsking(null); deleteList(p.id, true); }}>Delete it and its {count} {count === 1 ? "task" : "tasks"}</button> : null}
                  <button type="button" className="dl-pick ghost" onClick={() => { sfx.click(); setAsking(null); }}>Cancel</button>
                </div>
              ) : null}
              <div className="dl-body" data-scroll>
                {keys.map((k) => {
                  const list = secTasks(k), zone = secZone(k);
                  if (!list.length && dnd?.over !== zone && (k === "p1" || (p.id === MAIN && k === "daily"))) return null;
                  const row = (c: ListCard) => {
                    const d = docs.get(c.id);
                    const done = d ? !!d.data.done : !!c.done, title = d?.data.title ?? c.text, due = d ? d.data.due : c.due, ai = d ? d.data.ai : c.ai;
                    return (
                      <div key={c.key} className={`dl-row${done ? " done" : ""}${c.pending ? " pending" : ""}${menu?.id === c.id ? " menu-on" : ""}`} {...(dnd && !c.pending ? dnd.rowProps(c) : { "data-k": c.key })}>
                        <button type="button" className="dx-tick" disabled={!d} onClick={() => { sfx.done(); void taskMapActions.tick(c.id, !done); }} aria-label={`${done ? "Untick" : "Tick off"}: ${title}`} title={done ? "Untick" : "Tick off"}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
                        </button>
                        <span className="dl-tx"><span className="dl-t">{title}</span>
                          {ai || due ? <span className="dl-meta">{ai ? <span className="dx-ai" title="Added by an AI">AI</span> : null}{due ? <span className="dx-due num">{fmtDate(due)}</span> : null}</span> : null}</span>
                        {d ? <span className="dl-acts">
                          <button type="button" className="dx-mv" onClick={(e) => { sfx.click(); const b = root.current?.getBoundingClientRect(), r = e.currentTarget.getBoundingClientRect(); if (b) setMenu((m) => (m?.id === c.id ? null : { id: c.id, page: p.id, at: new DOMRect(r.left - b.left, r.top - b.top, r.width, r.height) })); }}
                            aria-label={`Move: ${title}`} title="Move to another list" aria-expanded={menu?.id === c.id}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                          </button>
                          <button type="button" className="dx-del" onClick={() => delTask(d)} aria-label={`Delete: ${title}`} title="Delete">×</button>
                        </span> : null}
                      </div>
                    );
                  };
                  const rows = dnd ? dnd.rows(zone, row) : list.map((d) => row(cardOf(d, zone)));
                  return (
                    <div key={k} className={`dl-sec${dnd?.over === zone ? " target" : ""}`} data-zone={dnd ? zone : undefined}>
                      <h4>{secName(k)}</h4>
                      {rows}
                      {!rows.length ? <p className="dl-empty">{dnd?.dragging ? "Drop it here." : "Nothing here."}</p> : null}
                    </div>
                  );
                })}
                {!keys.length ? <p className="dl-empty">No sections on this list yet.</p> : null}
              </div>
            </section>
          );
        })}
        {c.pages.length < PAGES_MAX ? (
          <button type="button" className="dl-new" onClick={() => { newList({ at: c.order.length }); }} title="A new list on the right">
            <span aria-hidden="true">+</span>New list
          </button>
        ) : null}
      </div>
      {menu && (() => {
        const d = docs.get(menu.id);
        return d ? <MoveMenu task={d} from={menu.page} at={menu.at} bounds={root.current} onClose={() => setMenu(null)} onMoved={() => setMenu(null)} /> : null;
      })()}
    </div>
  );
}

function RenameBox({ value, onDone, cancelRef }: { value: string; onDone: (v: string | null) => void; cancelRef: React.MutableRefObject<() => void> }) {
  const done = useRef(false);
  const end = (v: string | null) => { if (done.current) return; done.current = true; taskMapActions.editing(false); onDone(v); };
  cancelRef.current = () => end(null);
  return (
    <input className="dl-rename" autoFocus defaultValue={value} maxLength={LIST_NAME_MAX} aria-label="List name" spellCheck={false}
      onFocus={(e) => { e.currentTarget.select(); taskMapActions.editing(true); }}
      onBlur={(e) => end(e.currentTarget.value)}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); end(e.currentTarget.value); } }} />
  );
}

/** The three levels, top to bottom, in their colours (dimx.css): the action level holds every list, then the bands. */
const BANDS: { zone: DimxZone; label: string }[] = [{ zone: "act", label: "Actionables" }, { zone: "soon", label: "The Upside Down" }, { zone: "x", label: "Dimension X" }];
/** Send a task to any place: another list, or an idea card in a band (PS 1.68: every task, not only the AI Inbox's), as
 *  one move that keeps its id (core/dimxmove.ts). An AI Inbox task leaves the inbox (into that list's first section that
 *  takes it, or a new "To do" group there). A repeating task stays on a list: an idea card has no repeat. onBand: the
 *  Board's own band move (it shows the card there at once). */
export function MoveMenu({ task, from, at, bounds, onClose, onMoved, onBand }: {
  task: Doc<Todo>; from?: string; at: DOMRect; bounds: HTMLElement | null; onClose: () => void; onMoved: () => void; onBand?: (zone: DimxZone) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !bounds) return;
    const W = bounds.clientWidth, H = bounds.clientHeight, w = el.offsetWidth, h = el.offsetHeight;
    const below = at.bottom + 6, above = at.top - 6 - h;
    setPos({ left: Math.max(4, Math.min(W - w - 4, at.right - w)), top: below + h > H && above >= 0 ? above : Math.max(4, Math.min(H - h - 4, below)) });
  }, [at, bounds]);
  useEffect(() => {
    const out = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.(".dx-mv")) onClose(); };
    window.addEventListener("pointerdown", out, true);
    return () => window.removeEventListener("pointerdown", out, true);
  }, [onClose]);
  const inbox = inInbox(task.data);
  const go = (page: string) => {
    if (!inbox) { moveToList([task.id], page); onMoved(); return; }
    const c = listCtx();
    const m = inboxMove(task.data, page, { lists: c.lists, full: c.full, pages: c.pages, groups: c.groups }, newGroupId);
    if (!m) { onClose(); return; }
    sfx.drop();
    if (m.settings) void taskMapActions.looks(m.settings);
    void taskMapActions.update(task.id, m.patch);
    onMoved();
  };
  const repeats = task.data.type === "daily";
  const band = (zone: DimxZone) => {
    if (repeats) return;
    if (onBand) { onBand(zone); return; }
    sfx.drop();
    window.setTimeout(() => sfx.plop(), 120);
    void taskMapActions.toIdea(task.id, zone, IDEA_END);   // at the end of that band
    onMoved();
  };
  const pages = taskPages().filter((p) => p.id !== from);
  const idea = (b: { zone: DimxZone; label: string }) => (
    <button type="button" role="menuitem" className={`dl-item band z-${b.zone}`} onClick={() => band(b.zone)} disabled={repeats}
      aria-label={`Ideas, ${b.label}`} title={repeats ? "A repeating task stays on a list" : `An idea card in ${b.label}`}><i aria-hidden="true" />Ideas</button>
  );
  return (
    <div ref={ref} className="dl-menu" role="menu" aria-label="Move to" style={pos ? { left: pos.left, top: pos.top } : { left: at.left, top: at.bottom + 6, visibility: "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}>
      <span className="dl-menu-h">{inbox ? "Move to a list" : "Move to"}</span>
      {BANDS.map((b) => (
        <div key={b.zone} className={`dl-lvl z-${b.zone}`} role="group" aria-label={b.label}>
          <span className="dl-lvl-h">{b.label}</span>
          {b.zone === "act" ? pages.map((p) => (
            <button key={p.id} type="button" role="menuitem" className="dl-item" onClick={() => go(p.id)}>
              {p.id === MAIN ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" /></svg> : <i aria-hidden="true" />}
              {p.name}
            </button>
          )) : null}
          {idea(b)}
        </div>
      ))}
    </div>
  );
}
/** An index past the end of any band: the card goes last in its band (core/dimxmove.ts insertDimx). */
const IDEA_END = 100_000;
