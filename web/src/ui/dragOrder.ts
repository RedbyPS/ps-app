// Drag rows up and down to reorder a list. Mouse: grab anywhere on the row (a short move starts
// the drag, so a plain click still works). Touch: grab the row's .drag-grip only, so the page
// still scrolls. Rows move out of the way while you drag; the new order is saved on drop.
import { useEffect, useRef, useState } from "react";

type Live = {
  id: string; pointerId: number; touch: boolean; startY: number; startScroll: number; started: boolean;
  scroller: HTMLElement | null; base: string[]; mids: number[]; halves: number[]; step: number; from: number; to: number; onto: number | null; x: number; y: number;
};

/** How much of a row, round its middle, counts as ON it (PS 1.77): the middle half. Above or below that is between rows. */
export const ONTO_BAND = 0.5;
/**
 * Where a dragged row would land. `mids` and `halves`: each row's middle and half height where it started; `centre`: the
 * dragged row's middle now. Plain: `to` is its new index. With `canOnto`, a row whose middle half the dragged row is over
 * (and that may be dropped onto) is `onto`: it stays where it is, the dragged row sits on it, and `to` puts the dragged
 * row next to it on the side it came from.
 */
export function dragTarget(mids: number[], halves: number[], from: number, centre: number, canOnto?: (i: number) => boolean): { to: number; onto: number | null } {
  let onto: number | null = null;
  if (canOnto) for (let i = 0; i < mids.length; i++) {
    if (i !== from && Math.abs(centre - mids[i]) <= halves[i] * ONTO_BAND && canOnto(i)) { onto = i; break; }
  }
  let to = 0;
  mids.forEach((m, i) => { if (i !== from && i !== onto && m < centre) to++; });
  if (onto !== null && onto < from) to++;
  return { to, onto };
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/** Each row's middle and half height where its layout puts it now, without the slide the drag gave it (its transform, read
 *  as it is drawn, mid slide too). null when a row is missing (the list changed under the drag). */
function livePlaces(rows: (HTMLElement | undefined)[]): { mids: number[]; halves: number[] } | null {
  const mids: number[] = [], halves: number[] = [];
  for (const el of rows) {
    if (!el) return null;
    const r = el.getBoundingClientRect(), tf = getComputedStyle(el).transform;
    const ty = tf && tf !== "none" ? new DOMMatrixReadOnly(tf).m42 : 0;
    mids.push(r.top + r.height / 2 - ty);
    halves.push(r.height / 2);
  }
  return { mids, halves };
}

export type DragEnd = { id: string; next: string[]; moved: boolean; x: number; y: number; onto?: string };
/** opts.onMove: the pointer while a row is dragged. opts.onEnd: called on every drop (even when the
 *  order did not change), instead of commit, with where the pointer was let go. opts.alone: a list
 *  of one row still drags (it can be let go somewhere else, see onEnd). opts.canOnto (PS 1.77): which rows the dragged
 *  row may be let go ON (the middle of the row); that row lights up (data-drop-on) and onEnd gets it as `onto`. */
export function useDragOrder(ids: string[], commit: (ids: string[]) => void, opts: { onDrop?: () => void; onMove?: (x: number, y: number, id: string) => void; onEnd?: (e: DragEnd) => void; alone?: boolean; canOnto?: (over: string, dragged: string) => boolean } = {}) {
  const els = useRef(new Map<string, HTMLElement>());
  const live = useRef<Live | null>(null);
  const [dy, setDy] = useState(0);
  const [drag, setDrag] = useState<{ id: string; from: number; to: number; step: number; onto: string | null } | null>(null);
  const [pending, setPending] = useState<string[] | null>(null);
  const cb = useRef({ commit, opts });
  cb.current = { commit, opts };

  // Show the dropped order straight away, until the saved order comes back from the vault.
  const key = ids.join(",");
  useEffect(() => {
    if (!pending) return;
    if (pending.join(",") === key) { setPending(null); return; }
    const t = window.setTimeout(() => setPending(null), 2500);
    return () => window.clearTimeout(t);
  }, [key, pending]);
  const view = pending && pending.length === ids.length && pending.every((id) => ids.includes(id)) ? pending : ids;

  useEffect(() => {
    const scrollY = (l: Live) => (l.scroller ? l.scroller.scrollTop : window.scrollY);
    const move = (e: PointerEvent) => {
      const l = live.current;
      if (!l || e.pointerId !== l.pointerId) return;
      const d = e.clientY - l.startY + (scrollY(l) - l.startScroll);
      if (!l.started) {
        if (Math.abs(e.clientY - l.startY) < 6) return;
        l.started = true;
        document.body.classList.add("is-dragging");
      }
      e.preventDefault();
      // PS 1.77: where the rows sit now, not only where they sat at the press. On the phone a long pressed row is a little
      // taller for a moment while it lifts, so the press time places were off by up to 17px (src/gos/touch.ts).
      const now = livePlaces(l.base.map((x) => els.current.get(x)));
      const mids = now?.mids ?? l.mids, halves = now?.halves ?? l.halves;
      const centre = mids[l.from] + d;
      const can = cb.current.opts.canOnto;
      const { to, onto } = dragTarget(mids, halves, l.from, centre, can ? (i) => can(l.base[i], l.id) : undefined);
      l.to = to;
      l.onto = onto;
      l.x = e.clientX; l.y = e.clientY;
      cb.current.opts.onMove?.(e.clientX, e.clientY, l.id);
      setDy(d);
      setDrag({ id: l.id, from: l.from, to, step: l.step, onto: onto === null ? null : l.base[onto] });
    };
    const end = (e: PointerEvent) => {
      const l = live.current;
      if (!l || e.pointerId !== l.pointerId) return;
      live.current = null;
      document.body.classList.remove("is-dragging");
      if (l.started) {
        // The drag ends with a click on the row; swallow it so it doesn't also mark the task.
        const stop = (c: MouseEvent) => { c.stopPropagation(); c.preventDefault(); };
        window.addEventListener("click", stop, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 50);
        const next = l.base.filter((x) => x !== l.id);
        next.splice(l.to, 0, l.id);
        if (l.to !== l.from) setPending(next);
        const onto = l.onto === null ? undefined : l.base[l.onto];
        if (cb.current.opts.onEnd) cb.current.opts.onEnd({ id: l.id, next, moved: l.to !== l.from, x: e.clientX, y: e.clientY, ...(onto ? { onto } : {}) });
        else if (l.to !== l.from) cb.current.commit(next);
        cb.current.opts.onDrop?.();
      }
      setDrag(null);
      setDy(0);
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  /** Spread onto each row: <li {...row(id)}>. */
  function row(id: string) {
    const i = view.indexOf(id);
    let shift = 0, dragging = false;
    if (drag) {
      if (id === drag.id) dragging = true;
      else if (drag.from < drag.to && i > drag.from && i <= drag.to) shift = -drag.step;
      else if (drag.to < drag.from && i >= drag.to && i < drag.from) shift = drag.step;
    }
    return {
      ref: (el: HTMLElement | null) => { if (el) els.current.set(id, el); else els.current.delete(id); },
      "data-dragging": dragging || undefined,
      "data-drop-on": (drag && drag.onto === id) || undefined,
      style: dragging ? { transform: `translateY(${dy}px)`, zIndex: 5, transition: "none" }
        : drag ? { transform: `translateY(${shift}px)` } : undefined,
      onPointerDown: (e: React.PointerEvent) => {
        if (e.button !== 0 || ids.length < (cb.current.opts.alone ? 1 : 2)) return;
        const target = e.target as HTMLElement;
        const touch = e.pointerType !== "mouse";
        if (touch && !target.closest(".drag-grip")) return;
        if (target.closest("input, textarea, select, a, .no-drag, [contenteditable='true']")) return;
        const rects = view.map((x) => els.current.get(x)?.getBoundingClientRect());
        if (rects.some((r) => !r)) return;
        const rs = rects as DOMRect[];
        const gap = rs.length > 1 ? Math.max(0, rs[1].top - rs[0].bottom) : 10;
        const me = rs[i];
        const scroller = scrollParent(els.current.get(id) || null);
        live.current = {
          id, pointerId: e.pointerId, touch, startY: e.clientY, started: false, scroller,
          startScroll: scroller ? scroller.scrollTop : window.scrollY,
          base: [...view], mids: rs.map((r) => r.top + r.height / 2), halves: rs.map((r) => r.height / 2), step: me.height + gap, from: i, to: i, onto: null, x: e.clientX, y: e.clientY,
        };
      },
    };
  }

  return { order: view, row, dragging: !!drag };
}
