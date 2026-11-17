// A page of panels on the phone (V1.56 phone layout, core/phonelayout.ts): the tiles laid out on the four wide grid
// the Mac's phone editor shows (views/PhoneEditor.tsx), each one the very panel the list draws (the same element its
// Slot draws, views/EditMode.tsx panelElement), so it shows your real meetings, timelines and the rest, and works.
//
// <PhoneTilesHost /> is mounted inside the list (views/TaskMap.tsx Overlay), so every panel keeps whatever the list
// gives it; it draws into a layer of its own over the list, only while the phone shows a page of panels. A sideways
// swipe on it goes to the page beside, like the panes.
import { panelOpen } from "../core/phonepanels";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { panelElement } from "../views/EditMode";
import { cellBox, rowsUsed, tileLabel, type Tile } from "../core/phonelayout";
import { kindOf } from "../core/tablayout";
import { useVault } from "../ui/kit";
import { settingsData } from "../core/select";
import { swiped } from "../core/lists";
import { setDnd } from "../core/actions";
import { DndButton } from "../views/Dnd";
import { SleepRow } from "../views/SleepMode";
import { usePhoneNow } from "./phonepage";
import "./phonepages.css";

/** One panel, live, scaled down (never up) to fit its tile. width: fit the width only, as tall as it then is (the phone's
 *  own panes in the Mac's editor). */
export function PanelTileBody({ id, interactive = true, width = false }: { id: string; interactive?: boolean; width?: boolean }) {
  const kind = kindOf(id);
  const el = useElementFor(kind);
  const box = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [k, setK] = useState(1);
  const [natH, setNatH] = useState(0);
  useLayoutEffect(() => {
    const b = box.current, i = inner.current;
    if (!b || !i || typeof ResizeObserver === "undefined") return;
    const fit = () => {
      const bw = b.clientWidth, bh = b.clientHeight, iw = i.scrollWidth, ih = i.scrollHeight;
      if (!bw || (!bh && !width) || !iw || !ih) return;
      const s = width ? Math.min(1, bw / iw) : Math.min(1, bw / iw, bh / ih);
      setK((old) => (Math.abs(old - s) < 0.01 ? old : s));
      setNatH(ih);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(b); ro.observe(i);
    fit();
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className={`pp-body${interactive ? "" : " still"}${width ? " wide" : ""}`} data-kind={kind} style={width ? { height: Math.max(40, Math.ceil(natH * k)) } : undefined}>
      <div ref={inner} className="pp-inner" style={{ transform: k === 1 ? undefined : `scale(${k})`, transformOrigin: width ? "0 0" : undefined }}>
        {el ?? <span className="pp-none">{tileLabel(id)}<em>Not on this device yet</em></span>}
      </div>
    </div>
  );
}
/** The element for a kind: the panel's own (from its Slot), or the two the phone draws itself (Sleep and Do Not
 *  Disturb live in the phone's thumb row, not in the list). */
function useElementFor(kind: string): ReactNode | undefined {
  const s = useVault();
  if (kind === "sleep") return <SleepRow where="side" />;
  if (kind === "dnd" && s.status === "unlocked") {
    const st = settingsData(s);
    return <DndButton st={st} s={s} act={(o) => setDnd(o)} homeTz={st.tmHomeTz || undefined} size={24} />;
  }
  return panelElement(kind);
}

/** Inside the list (views/TaskMap.tsx): the page of panels the phone shows, if any. */
export function PhoneTilesHost() {
  const now = usePhoneNow();
  const invert = settingsData(useVault()).swipeInvert === true;   // Settings, Controls, Invert swipe (V1.57)
  const p = now.page;
  if (!p || p.kind !== "panels") return null;
  return createPortal(<PanelsPage key={p.id} tiles={p.tiles ?? []} side={now.side} order={now.order} self={`page:${p.id}`} go={now.go} name={p.name ?? "Page"} invert={invert} />, document.body);
}

function PanelsPage({ tiles, side, order, self, go, name, invert }: { tiles: Tile[]; side: "l" | "r"; order: string[]; self: string; go: (v: string) => void; name: string; invert?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(() => (typeof window === "undefined" ? 390 : window.innerWidth));
  useEffect(() => { const f = () => setW(window.innerWidth); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  // A sideways swipe goes to the page beside (the same feel as the panes, gos/GosLayer.tsx Swipe).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let sx = 0, sy = 0, mode: "?" | "x" | "y" | null = null, dx = 0;
    const start = (e: TouchEvent) => {
      if (panelOpen()) { mode = null; return; }   // PS 1.66: never move the pages behind an open panel (core/phonepanels.ts)
      if (e.touches.length !== 1 || (e.target as Element).closest("input, textarea, [contenteditable='true'], input[type='range']")) { mode = null; return; }
      sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; mode = "?";
    };
    const move = (e: TouchEvent) => {
      if (!mode || mode === "y") return;
      const x = swiped(e.touches[0].clientX - sx, invert), y = e.touches[0].clientY - sy;
      if (mode === "?") { if (Math.abs(x) < 12 && Math.abs(y) < 12) return; mode = Math.abs(x) > Math.abs(y) * 1.4 ? "x" : "y"; if (mode === "y") return; }
      dx = x;
      el.style.setProperty("--pp-drag", `${dx}px`);
      el.classList.add("dragging");
      if (e.cancelable) e.preventDefault();
    };
    const end = () => {
      if (mode !== "x") { mode = null; return; }
      mode = null;
      el.classList.remove("dragging");
      el.style.setProperty("--pp-drag", "0px");
      const i = order.indexOf(self), lim = (el.clientWidth || 400) * 0.22;
      if (dx < -lim && i >= 0 && i < order.length - 1) go(order[i + 1]);
      else if (dx > lim && i > 0) go(order[i - 1]);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => { el.removeEventListener("touchstart", start); el.removeEventListener("touchmove", move); el.removeEventListener("touchend", end); el.removeEventListener("touchcancel", end); };
  }, [order, self, go, invert]);
  const rows = rowsUsed(tiles);
  const height = rows ? cellBox({ c: 0, r: rows - 1, w: 1, h: 1 }, w).top + cellBox({ c: 0, r: 0, w: 1, h: 1 }, w).height : 0;
  return (
    <div ref={ref} className={`pp-page from-${side}`} aria-label={name}>
      <div className="pp-grid" style={{ height }}>
        {tiles.map((t, i) => {
          const b = cellBox(t, w);
          return (
            <div key={t.id} className="pp-tile" style={{ left: b.left, top: b.top, width: b.width, height: b.height, ["--i" as string]: i }}>
              <PanelTileBody id={t.id} />
            </div>
          );
        })}
      </div>
      {!tiles.length && <p className="pp-empty">An empty page. On your Mac: Edit, then the phone button top left, then Add panel.</p>}
    </div>
  );
}
