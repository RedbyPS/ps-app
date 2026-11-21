// The top right menu of the Tab list (PS 1.70, the developer 19 Nov 2026: "all these different buttons and options everywhere,
// they're all very unclear... simplify it, kind of like Apple does"). On the page: Screen time, this button, the gear.
// Everything else that sat in the top right is a row in here (core/topmenu.ts): a clear icon and a plain name, no
// description, with a switch, a short value or a dot on the right where the thing has a state.
//
// - The real buttons still render inside the menu's dock, hidden but laid out where this button is (topmenu.css). A row
//   presses its real button, so every screen and pop-up opens exactly as before, and grows out of this button.
// - It opens like an Apple popover: it springs out of the button (scale and fade from its corner), the rows follow a
//   few milliseconds apart, a soft highlight glides from row to row, and the three lines turn into a cross. Only
//   transform and opacity animate (no layout, no jitter); reduced motion: it simply appears.
// - Keyboard: Enter or Space on the button opens it with the first row focused; Up, Down, Home, End and a row's first
//   letter move; Enter or Space picks; Right on Do Not Disturb reaches its settings; Esc closes it (core/escape.ts: the
//   key is marked as used, so PS keeps the list) and puts the focus back on the button. A click outside closes it too.
// - While it is open the list stays when Tab is let go, and takes the keyboard (PS: "dimx", like the other screens).
// - A mark on the button: pink when something needs a look (Security, a new Morning brief), soft
//   blue while a mode runs (Do Not Disturb, Low power mode, an AFK timer, the Remote screen). Its label says which.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PS, psPost, useOverlayShown } from "../ps";
import { sfx } from "../ui/sfx";
import { menuMark, nextRow, rowLive, topMenuItems, TOP_MENU_WORDS, type RowLive, type TopMenuId, type TopMenuItem } from "../core/topmenu";
import { taskMapActions } from "./TaskMap";
import { TopIcon } from "./topicons";
import "./topmenu.css";

type Row = { item: TopMenuItem; live: RowLive; disabled: boolean };
type Phase = "closed" | "open" | "closing";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The rows, read from the real buttons in the dock. */
function readRows(dock: HTMLElement | null): Row[] {
  if (!dock) return [];
  const q = (sel: string) => dock.querySelector<HTMLElement>(sel);
  return topMenuItems((sel) => !!q(sel)).map((item) => {
    const b = q(item.sel)!;
    const p = b.getAttribute("aria-pressed");
    const real = { pressed: p === null ? null : p === "true", label: b.getAttribute("aria-label") || "", text: b.textContent || "", cls: typeof b.className === "string" ? b.className : "" };
    return { item, live: rowLive(item.id, real), disabled: (b as HTMLButtonElement).disabled === true };
  });
}
const rowsKey = (rows: Row[]) => JSON.stringify(rows.map((r) => [r.item.id, r.live, r.disabled]));

/** The rows, kept in step with the real buttons (their state changes on its own: Do Not Disturb, an AFK timer ticking). */
function useDockRows(dock: React.RefObject<HTMLDivElement | null>): Row[] {
  const [rows, setRows] = useState<Row[]>([]);
  const key = useRef("");
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    let raf = 0;
    const read = () => {
      raf = 0;
      const next = readRows(el), k = rowsKey(next);
      if (k !== key.current) { key.current = k; setRows(next); }
    };
    read();
    const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(read); });
    mo.observe(el, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-pressed", "aria-label", "class", "disabled"] });
    return () => { mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [dock]);
  return rows;
}

export function TopMenu({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("closed");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const wrap = useRef<HTMLDivElement>(null), dock = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null), pop = useRef<HTMLDivElement>(null);
  const rows = useDockRows(dock);
  const shown = useOverlayShown();
  const viaKey = useRef(false);
  const [hi, setHi] = useState(-1);          // the row the highlight sits on (mouse or keyboard)
  const [hiAt, setHiAt] = useState<{ y: number; h: number } | null>(null);
  const glide = useRef(false);               // the highlight glides once it has a place (it appears where it is first)
  // The mouse takes the highlight only when it really moves: a pointer resting where the menu opens, or a row sliding
  // under it, never pulls the highlight away from the keyboard.
  const lastPt = useRef("");
  const pointAt = (i: number) => (e: React.PointerEvent) => {
    const k = `${e.clientX},${e.clientY}`, was = lastPt.current;
    if (k === was) return;
    lastPt.current = k;
    if (was !== "key") setHi(i);   // opened from the keyboard: the first move only says where the pointer rests
  };
  const id = useId();
  // Where it opens: under the button, from its right edge, as usual. A button moved low or far left in Edit mode opens
  // it upward or from its left edge, and it never runs past the screen (it scrolls inside instead).
  const [place, setPlace] = useState<{ up: boolean; left: boolean; maxH: number }>({ up: false, left: false, maxH: 0 });

  // While it is open the list stays when Tab is let go and has the keyboard (PS), like the other screens.
  const hold = (on: boolean) => { if (PS) psPost({ type: "dimx", open: on }); else taskMapActions.editing(on); };
  const open = (byKey: boolean, at = "") => {
    if (phaseRef.current === "open") return;
    viaKey.current = byKey;
    const r = btn.current?.getBoundingClientRect(), vh = window.innerHeight || 800;
    if (r) {
      const up = r.top > vh * 0.55;
      setPlace({ up, left: r.right < 320, maxH: Math.max(160, Math.floor((up ? r.top : vh - r.bottom) - 22)) });
    }
    glide.current = false;
    lastPt.current = byKey ? "key" : at;
    setHi(-1);
    sfx.click();
    setPhase("open");
    hold(true);
  };
  const close = (focusBack = false) => {
    if (phaseRef.current !== "open") return;
    setPhase("closing");
    hold(false);
    if (focusBack) btn.current?.focus({ preventScroll: true });
  };
  // The closing animation, then gone.
  useEffect(() => {
    if (phase !== "closing") return;
    const t = window.setTimeout(() => setPhase((p) => (p === "closing" ? "closed" : p)), reduced() ? 0 : 170);
    return () => window.clearTimeout(t);
  }, [phase]);
  // The list put away: the menu goes with it, at once.
  useEffect(() => { if (!shown && phaseRef.current !== "closed") setPhase("closed"); }, [shown]);
  useEffect(() => () => { if (phaseRef.current === "open") hold(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc and a click outside close it. Esc is marked as used, so PS keeps the list (core/escape.ts).
  useEffect(() => {
    if (phase !== "open") return;
    const key = (e: KeyboardEvent) => { if (e.key !== "Escape") return; e.preventDefault(); e.stopImmediatePropagation(); close(true); };
    const down = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) close(); };
    const w = window as Window & { __psDimxClose?: () => boolean };
    const esc = () => { close(true); return true; };
    window.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", down, true);
    w.__psDimxClose = esc;
    return () => {
      window.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", down, true);
      if (w.__psDimxClose === esc) delete w.__psDimxClose;
    };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowEls = () => [...(pop.current?.querySelectorAll<HTMLButtonElement>("button.tm-menu-row") ?? [])];
  const focusRow = (i: number) => { const el = rowEls()[i]; if (el) { el.focus({ preventScroll: true }); setHi(i); } };
  // Opened from the keyboard: the first row has the focus. With the mouse: the menu itself (arrows still work).
  useLayoutEffect(() => {
    if (phase !== "open") return;
    if (viaKey.current) focusRow(0); else pop.current?.focus({ preventScroll: true });
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  // Where the highlight sits: the row's own box inside the menu (layout numbers, never mid animation).
  useLayoutEffect(() => {
    const el = hi >= 0 ? rowEls()[hi] : null;
    const wrapEl = el?.parentElement;
    if (!el || !wrapEl) { setHiAt(null); return; }
    setHiAt({ y: wrapEl.offsetTop + el.offsetTop, h: el.offsetHeight });
  }, [hi, rows]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (hiAt && !glide.current) { const r = requestAnimationFrame(() => { glide.current = true; }); return () => cancelAnimationFrame(r); } }, [hiAt]);

  /** A row picked: press its real button. */
  const press = (row: Row, more = false) => {
    if (row.disabled) return;
    const b = dock.current?.querySelector<HTMLElement>(more && row.item.more ? row.item.more.sel : row.item.sel);
    if (!b) return;
    const k = row.item.kind;
    if (more || k === "open" || (k === "moon" && row.live.value)) { close(); b.click(); return; }
    if (k === "action") { b.click(); window.setTimeout(() => close(), reduced() ? 300 : 760); return; }
    b.click();   // a switch (or the moon turning Do Not Disturb on): the menu stays and shows it
  };

  const onKey = (e: React.KeyboardEvent) => {
    const els = rowEls();
    const cur = els.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const more = (document.activeElement as HTMLElement | null)?.closest(".tm-menu-item")?.querySelector<HTMLButtonElement>(".tm-menu-more");
      if (e.key === "ArrowRight" && cur >= 0 && more) { e.preventDefault(); more.focus({ preventScroll: true }); return; }
      if (e.key === "ArrowLeft" && document.activeElement?.classList.contains("tm-menu-more")) {
        e.preventDefault(); (document.activeElement.closest(".tm-menu-item")?.querySelector<HTMLButtonElement>("button.tm-menu-row"))?.focus({ preventScroll: true }); return;
      }
      return;
    }
    const from = cur >= 0 ? cur : document.activeElement?.classList.contains("tm-menu-more") ? els.indexOf(document.activeElement.closest(".tm-menu-item")?.querySelector("button.tm-menu-row") as HTMLButtonElement) : -1;
    const to = nextRow(from, els.length, e.key, rows.map((r) => r.live.label ?? r.item.label));
    if (to !== from && to >= 0) { e.preventDefault(); focusRow(to); }
  };

  const items = rows.map((r) => ({ id: r.item.id, live: { ...r.live, label: r.live.label } }));
  const mark = menuMark(items);
  const groups: Row[][] = [];
  for (const r of rows) { const g = groups[groups.length - 1]; if (g && g[0].item.group === r.item.group) g.push(r); else groups.push([r]); }
  let n = 0;
  const isOpen = phase === "open";

  return (
    <div className="tm-menu" ref={wrap}>
      <button ref={btn} type="button" className={`tm-pill-btn icon tm-menu-btn${isOpen ? " on" : ""}`} aria-haspopup="menu" aria-expanded={isOpen} aria-controls={isOpen ? id : undefined}
        aria-label={mark.why.length ? `${TOP_MENU_WORDS.button}. ${mark.why.join(". ")}` : TOP_MENU_WORDS.button} title={TOP_MENU_WORDS.button}
        onClick={(e) => { if (e.button !== 0) return; if (phaseRef.current === "open") close(); else open(e.detail === 0, `${e.clientX},${e.clientY}`); }}>
        <span className="tm-menu-ic" aria-hidden="true"><i /><i /><i /></span>
        {mark.mark && <i className={`tm-menu-mark ${mark.mark}`} aria-hidden="true" />}
      </button>
      {/* The real buttons: hidden, laid out where this button is, so what they open grows out of it. */}
      <div className="tm-menu-dock" ref={dock}>{children}</div>
      {phase !== "closed" && (
        <div ref={pop} id={id} className={`tm-menu-pop${phase === "closing" ? " out" : ""}${place.up ? " up" : ""}${place.left ? " left" : ""}`} role="menu" aria-label={TOP_MENU_WORDS.button} tabIndex={-1}
          style={place.maxH ? { maxHeight: place.maxH } : undefined}
          onKeyDown={onKey} onPointerLeave={() => { if (!(document.activeElement as HTMLElement | null)?.closest?.(".tm-menu-item")) setHi(-1); }}>
          <i className={`tm-menu-hi${hiAt ? " show" : ""}${glide.current ? " glide" : ""}`} aria-hidden="true"
            style={hiAt ? { transform: `translate3d(0, ${hiAt.y}px, 0)`, height: hiAt.h } : undefined} />
          {groups.map((g, gi) => (
            <div key={gi} className="tm-menu-group" role="group">
              {g.map((r) => {
                const i = n++;
                const toggle = r.item.kind === "toggle";
                const label = r.live.label ?? r.item.label;
                return (
                  <div key={r.item.id} className="tm-menu-item" style={{ ["--i" as string]: i } as CSSProperties}>
                    <button type="button" role={toggle ? "menuitemcheckbox" : "menuitem"} aria-checked={toggle ? !!r.live.on : undefined}
                      className={`tm-menu-row${r.live.value === TOP_MENU_WORDS.on || r.live.on ? " is-on" : ""}${r.live.value === TOP_MENU_WORDS.cleared ? " is-done" : ""}`}
                      disabled={r.disabled} tabIndex={-1} data-row={r.item.id}
                      onClick={() => press(r)} onPointerMove={pointAt(i)} onFocus={() => setHi(i)}>
                      <span className="tm-menu-ico" aria-hidden="true">{r.live.value === TOP_MENU_WORDS.cleared ? DONE_ICON : <TopIcon id={r.item.id} />}</span>
                      <span className="tm-menu-name">{label}</span>
                      {r.live.value && <span className="tm-menu-val num">{r.live.value}</span>}
                      {r.live.badge && <span className="tm-menu-badge num">{r.live.badge}</span>}
                      {r.live.dot && <i className="tm-menu-dot" aria-label="Needs a look" />}
                      {toggle && <span className={`tm-menu-sw${r.live.on ? " on" : ""}`} aria-hidden="true"><i /></span>}
                    </button>
                    {r.item.more && (
                      <button type="button" className="tm-menu-more" aria-label={r.item.more.label} title={r.item.more.label} tabIndex={-1}
                        onClick={() => press(r, true)} onPointerMove={pointAt(i)} onFocus={() => setHi(i)}>
                        {MORE_ICON}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DONE_ICON = <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>;
const MORE_ICON = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" />
  </svg>
);
