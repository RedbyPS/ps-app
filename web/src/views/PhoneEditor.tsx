// The phone layout editor in the Mac's Edit overview (V1.56, the developer 13 Nov 2026): "an icon thing when you're in the edit
// panel of a mobile device ... if you click the mobile device then ... I want to be able to customize my GOS app and
// move stuff around in the GOS app while on the Mac version ... And I want the same thing on the iOS as well ... it
// should detect what devices you actually have connected. But if it's unsure then ask you GrapheneOS or iOS ... you
// can move stuff around the screen the same exact way that you currently can on the macOS version. You can create new
// pages, you can move the navbar around, you can decide what stuff is in the navbar ... what background your phone
// has, all the different appearance options."
//
// - The phone button sits top left in the overview (never under the Dynamic Island, core/phonedevices.ts). It opens
//   the phone that opened PS (one), a small picker (several), or asks GrapheneOS or iPhone (none known yet).
// - The overview turns into that phone: its real shape, its pages side by side with the one being edited in the
//   middle, a + past each end for a new page of panels. Each page shows what the phone shows, with your real data
//   (the panels are the very elements the list draws, gos/PhonePages.tsx PanelTileBody).
// - On a page of panels: drag a panel to another cell (the others make room) or onto a page beside, the corner sizes
//   it in whole cells, x removes it, Add panel offers only what this phone can draw.
// - The navbar: drag it to the top or the bottom and to the left, centre or right; drag its buttons to reorder; x
//   takes one out; the side sheet puts any back (Settings always stays). Each page and the whole phone have a
//   background and a look.
// - "Mac layout" top left (or Esc) goes back to the Mac's overview; Done leaves Edit mode.
// The layout is one small vault record per phone kind (core/phonelayout.ts, actions.ts savePhoneLayout), written half
// a second after the last change; the phone follows it when it next syncs, or at once while it is open.
import { mailAllowed } from "../core/mailflag";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as RPE, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVault } from "../ui/kit";
import { vaultStore, type Snapshot } from "../core/vault";
import { phoneDevs, phoneLayout, settingsData, todos } from "../core/select";
import { savePhoneLayout } from "../core/actions";
import {
  COLS, HOME, addPage, addTile, cellAt, cellBox, cellsFor, defaultPhoneLayout, lookOf, moveTile, navChoices, navLabel, orderPages, phoneGallery,
  phoneName, removeTile, renamePage, resizeTile, rowsUsed, samePhoneLayout, setLook, setNavAlign, setNavEdge, setNavItems, tileLabel,
  tileToPage, toggleNav, type NavAlign, type PhoneKind, type PhoneLayout, type PhonePage, type Tile,
} from "../core/phonelayout";
import { PHONE_BTN, clearTop, phoneButtonSpot, phoneChoice, phoneLabel, phoneScreen, type PhoneDev } from "../core/phonedevices";
import { islandBox, onIsland } from "../ui/islandspot";
import { BG_DESIGNS } from "../core/prio";
import { BG_COLOURS, colourBgCss } from "../core/bgcolour";
import { offeredLooks } from "../core/looks";
import { PanelTileBody } from "../gos/PhonePages";
import { editSfx, sfx } from "../ui/sfx";
import { PhoneLooks, macLookSound } from "./PhoneLooks";
import { phoneSfx } from "../ui/phonesfx";
import { PhoneLinkCard } from "./PhoneLink";
import { DeletePage, UndoDelete } from "./PhoneDeletePage";
import { deletePage, pageAfterDelete, restorePage, type RemovedPage } from "../core/phonepagedelete";
import { rowPos, type Row } from "../core/phonepan";
import { usePhonePan, type PanApi } from "./usePhonePan";
import { dragDelta, dragSig, endKind, frameQueue, ghostFor, samePointer } from "../core/tiledrag";
import { carriedEl, carry, carryNav, release, releaseNav, settle } from "./tiledrive";
import "./phoneeditor.css";

// ---------- Esc: the innermost open thing closes first (registered before the overview's own Esc, so it goes first) ----------
const escStack: { fn: () => void }[] = [];
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !escStack.length) return;
    if ((e.target as Element | null)?.closest?.(".pe-rename")) return;   // the name box closes itself
    if (document.querySelector(".lk-panel, .lk-ask-wrap")) { e.preventDefault(); e.stopImmediatePropagation(); window.dispatchEvent(new Event("lk-close")); return; }   // the Looks panel first (views/PhoneLooks.tsx)
    e.preventDefault(); e.stopImmediatePropagation();
    escStack[escStack.length - 1].fn();
  }, true);
}
function useEsc(on: boolean, fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return;
    const h = { fn: () => ref.current() };
    escStack.push(h);
    return () => { const i = escStack.indexOf(h); if (i >= 0) escStack.splice(i, 1); };
  }, [on]);
}
/** The island's box, kept fresh (it opens, moves and hides). */
function useIsland() {
  const [, bump] = useState(0);
  useEffect(() => onIsland(() => bump((n) => n + 1)), []);
  return islandBox();
}
function useViewport() {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => { const f = () => setV({ w: window.innerWidth, h: window.innerHeight }); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  return v;
}
const at = () => new Date().toISOString();

// ---------- the phone button and the picker (inside the overview) ----------
export type Open = { phone: PhoneKind; dev: PhoneDev | null };
// The switch between the Mac's pages and the phone (the developer: "your macOS pages zooms into where the phone icon was and then
// your phone icon zooms out into the bigger picture ... the moment you click on the macOS icon at the top left then I
// want it to bring the macOS version back into view"). The Mac overview (its room, its bar and the live card) shrinks
// into the icon's spot (html.pe-mac-away, editmode's own transforms are untouched: this uses the separate translate and
// scale properties), a dark shade stays behind, then the phone's stage grows out of the same spot. Back: the reverse.
type Stage = "mac" | "toPhone" | "phone" | "toMac";
const T_SWAP = 360, T_BACK = 330, T_DONE = 780;
let macT = 0;
function macAway(on: boolean, p?: { x: number; y: number }) {
  const h = document.documentElement;
  window.clearTimeout(macT);
  if (on && p) {
    // From the middle of the page's own box (a scrollbar is not part of it), so the zoom lands on the icon's middle.
    h.style.setProperty("--pe-rx", `${Math.round(p.x - (h.clientWidth || window.innerWidth) / 2)}px`);
    h.style.setProperty("--pe-ry", `${Math.round(p.y - (h.clientHeight || window.innerHeight) / 2)}px`);
    h.classList.add("pe-anim");
    void h.offsetWidth;   // the transition starts from where everything is now
    h.classList.add("pe-mac-away");
    return;
  }
  h.classList.remove("pe-mac-away");
  macT = window.setTimeout(() => { h.classList.remove("pe-anim"); }, 900);
}
function macHome() {   // at once (the overview closing, or this unmounting)
  const h = document.documentElement;
  window.clearTimeout(macT);
  h.classList.remove("pe-mac-away", "pe-anim", "pe-mac-gone");
  h.style.removeProperty("--pe-rx"); h.style.removeProperty("--pe-ry");
}
export function PhoneMount({ live, leaving, red, onDone }: { live: boolean; leaving: boolean; red: boolean; onDone: () => void }) {
  const s = useVault();
  // The same list while nothing in it changed, so the side sheet does not draw again on every vault change (V1.57).
  const devsKeep = useRef<{ key: string; list: PhoneDev[] }>({ key: "", list: [] });
  const devs = useMemo(() => {
    const list = s.status === "unlocked" ? phoneDevs(s) : [];
    const key = JSON.stringify(list);
    if (key !== devsKeep.current.key) devsKeep.current = { key, list };
    return devsKeep.current.list;
  }, [s]);
  const [open, setOpen] = useState<Open | null>(null);
  const [stage, setStage] = useState<Stage>("mac");
  const [asking, setAsking] = useState(false);
  const [linking, setLinking] = useState<PhoneKind | null>(null);   // "Link your phone" (views/PhoneLink.tsx)
  const timers = useRef<number[]>([]);
  const later = (f: () => void, ms: number) => { timers.current.push(window.setTimeout(f, reduced() ? 0 : ms)); };
  const island = useIsland();
  const vp = useViewport();
  const spot = phoneButtonSpot(island, vp.w);
  const centre = { x: spot.left + PHONE_BTN / 2, y: spot.top + PHONE_BTN / 2 };   // the zoom goes into and out of the icon's middle
  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); macHome(); }, []);
  // Done (or the list put away) while the phone shows: everything goes home with the overview.
  useEffect(() => { if (!leaving) return; setAsking(false); macHome(); }, [leaving]);
  useEsc(asking && stage === "mac", () => { phoneSfx.click(); setAsking(false); });
  useEsc(!!linking && stage === "mac", () => { phoneSfx.click(); setLinking(null); });
  useEffect(() => { if (leaving) setLinking(null); }, [leaving]);
  // V1.57: once the phone is fully up, the Mac's pages behind it (shrunk into the icon) are not drawn at all; they are
  // back before the switch to the Mac starts.
  useEffect(() => { document.documentElement.classList.toggle("pe-mac-gone", stage === "phone" && !leaving); }, [stage, leaving]);
  // A kind no phone of which has opened PS yet: how to link one first (the developer), with a way to design it anyway.
  const choose = (k: PhoneKind, d: PhoneDev | null) => { if (d) { toPhone({ phone: k, dev: d }); return; } phoneSfx.click(); setAsking(false); setLinking(k); };
  const toPhone = (o: Open) => {
    if (stage !== "mac") return;
    timers.current.forEach((t) => window.clearTimeout(t)); timers.current = [];
    setAsking(false); setLinking(null);
    phoneSfx.zoomIn();
    macAway(true, centre);
    setOpen(o); setStage("toPhone");
    later(() => setStage("phone"), T_SWAP);
  };
  const toMac = () => {
    if (stage !== "phone" && stage !== "toPhone") return;
    timers.current.forEach((t) => window.clearTimeout(t)); timers.current = [];
    phoneSfx.zoomOut();
    setStage("toMac");
    later(() => macAway(false), T_BACK);
    later(() => { setOpen(null); setStage("mac"); }, T_DONE);
  };
  const tap = () => {
    if (stage !== "mac") { toMac(); return; }
    phoneSfx.click();
    const c = phoneChoice(devs);
    if ("open" in c) { toPhone({ phone: c.open.phone, dev: c.open }); return; }
    setLinking(null);
    setAsking((a) => !a);
  };
  const phoneUp = stage !== "mac";
  const shade = (phoneUp || !!linking) && !leaving;
  return (
    <>
      {/* The dark behind both, under the overview (89), so nothing of the screen shows while the Mac pages fly away. */}
      {createPortal(<div className={`pe-shade${shade ? " on" : ""}${linking && !phoneUp ? " top" : ""}`} aria-hidden="true" onClick={() => setLinking(null)} />, document.body)}
      {linking && !phoneUp && live && createPortal(
        <PhoneLinkCard key={linking} phone={linking} devs={devs} onClose={() => { phoneSfx.click(); setLinking(null); }}
          onLinked={(d) => toPhone({ phone: linking, dev: d })} onAnyway={() => toPhone({ phone: linking, dev: null })} />,
        document.body)}
      {/* The one button: the phone while the Mac shows, the Mac while the phone shows. */}
      <button type="button" className={`pe-phone-btn${live ? " on" : ""}${asking ? " lit" : ""}${phoneUp ? " mac" : ""}`} style={{ left: spot.left, top: spot.top }} onClick={tap}
        onMouseDown={(e) => e.stopPropagation()} aria-expanded={phoneUp ? undefined : asking}
        title={phoneUp ? "Back to the Mac layout" : "Design your phone's layout"} aria-label={phoneUp ? "Back to the Mac layout" : "Design your phone's layout"}>
        <span className="pe-face pe-face-phone"><PhoneGlyph size={30} /></span>
        <span className="pe-face pe-face-mac"><MacGlyph size={28} /></span>
      </button>
      {!phoneUp && asking && live && (
        <div className="pe-pick" style={{ left: spot.left, top: spot.top + PHONE_BTN + 10 }} role="menu" onMouseDown={(e) => e.stopPropagation()}>
          {devs.length > 1 && <>
            <p className="pe-pick-q">Which phone?</p>
            {devs.map((d) => (
              <button key={d.dev} type="button" role="menuitem" className="pe-pick-i" onClick={() => choose(d.phone, d)}>
                <PhoneGlyph small kind={d.phone} /><span>{phoneLabel(d, devs)}</span><em>{seenText(d.seen)}</em>
              </button>
            ))}
          </>}
          {devs.length <= 1 && <p className="pe-pick-q">GrapheneOS or iPhone?</p>}
          <div className="pe-pick-two">
            {(["gos", "ios"] as const).map((k) => (
              <button key={k} type="button" role="menuitem" className="pe-pick-k" onClick={() => choose(k, devs.find((d) => d.phone === k) ?? null)}>
                <PhoneGlyph kind={k} /><span>{phoneName(k)}</span>
              </button>
            ))}
          </div>
          {!devs.length && <p className="pe-pick-n">No phone has opened PS on this account yet. Pick one and PS shows you how to link it.</p>}
        </div>
      )}
      {open && createPortal(
        <PhoneEditor key={`${open.phone}:${open.dev?.dev ?? ""}`} phone={open.phone} dev={open.dev} devs={devs} red={red} leaving={leaving}
          stage={stage} onBack={toMac} onDone={onDone} onSwitch={(o) => setOpen(o)} />,
        document.body)}
    </>
  );
}
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
function seenText(iso: string): string {
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return "open now";
  if (m < 60 * 24) return "today";
  const d = Math.round(m / 1440);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

// ---------- the editor ----------
// The pieces below (PhoneScreen, Grid, NavBar, Sheet, PhoneGallery, the icons) are exported so the phone's own Edit
// mode can use the very same ones: one phone layout model (core/phonelayout.ts), one set of editing pieces.
// p0: how far the row was slid (core/phonepan.ts) when the drag began; out: the pointer is over no page at all.
export type TileDrag = { id: string; mode: "move" | "size"; sx: number; sy: number; dx: number; dy: number; over: string | null; p0?: number; out?: boolean };
export type NavDrag = { kind: "bar"; sx: number; sy: number; dx: number; dy: number } | { kind: "item"; id: string; sx: number; dx: number };
type PillDrag = { id: string; sx: number; dx: number };
// V1.57 (the developer: "make it so the mobile edit view is more responsive"): the side sheet narrows on a small window, and the
// pages keep to the part of the screen left of it, so the two never crowd each other.
const SHEET_MAX = 284, SHEET_MIN = 232;
// V1.57: a change draws at once; the vault write (which redraws the whole list behind the canvas) follows a moment
// later, and quick changes in a row go as one write. The phone still gets it well under a second.
const SAVE_SOON = 180, SAVE_LATER = 500;

/** Keeps a function's identity while always calling its newest version, so the pieces drawn with it can stay still. */
export function useStable<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useRef((...a: A) => ref.current(...a)).current;
}

function PhoneEditor({ phone, dev, devs, red, leaving, stage, onBack, onDone, onSwitch }: {
  phone: PhoneKind; dev: PhoneDev | null; devs: PhoneDev[]; red: boolean; leaving: boolean; stage: Stage;
  onBack: () => void; onDone: () => void; onSwitch: (o: Open) => void;
}) {
  const s = useVault();
  // V1.57: the saved layout stays the very same object while its content is the same (a vault change that did not touch
  // this phone, or this canvas's own save coming back), so the pages drawn from it do not draw again.
  const steady = useRef<PhoneLayout | null>(null);
  const saved = useMemo(() => {
    const fresh = s.status === "unlocked" ? phoneLayout(s, phone, red) : defaultPhoneLayout(phone, red);
    const k = steady.current;
    const out = k && (k === fresh || samePhoneLayout(k, fresh, red)) ? k : fresh;
    steady.current = out;
    return out;
  }, [s, phone, red]);
  // What was just changed here, until the vault catches up (then the saved one again).
  const [pending, setPending] = useState<PhoneLayout | null>(null);
  const timer = useRef(0);
  const latest = useRef<PhoneLayout | null>(null);
  const layout = pending ?? saved;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  useEffect(() => { if (pending && !timer.current && (pending === saved || samePhoneLayout(pending, saved, red))) setPending(null); }, [pending, saved, red]);
  const flush = () => { if (timer.current) { window.clearTimeout(timer.current); timer.current = 0; } if (latest.current) { const l = latest.current; latest.current = null; void savePhoneLayout(l).catch(() => {}); } };
  const change = useStable((next: PhoneLayout, now = false) => {
    if (next === layoutRef.current) return;
    latest.current = next;
    steady.current = next;
    layoutRef.current = next;
    setPending(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = 0; flush(); }, now ? SAVE_SOON : SAVE_LATER);
  });
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const [cur, setCur] = useState(HOME);
  const pages = layout.pages;
  const ci = Math.max(0, pages.findIndex((p) => p.id === cur));
  const page = pages[ci];
  useEffect(() => { if (!pages.some((p) => p.id === cur)) setCur(HOME); }, [pages, cur]);
  const [gal, setGal] = useState(false);
  const [sure, setSure] = useState<string | null>(null);   // the page whose "Are you sure?" is open
  const [undo, setUndo] = useState<{ removed: RemovedPage; name: string; key: number } | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [tile, setTile] = useState<TileDrag | null>(null);
  // V1.65: tileRef is the live pose (read once per frame, never written to state per move); `tile` follows only when the landing cell or page changes.
  const tileRef = useRef<TileDrag | null>(null);
  const frames = useRef(frameQueue()).current;
  const ptr = useRef({ x: 0, y: 0 });
  const sigRef = useRef("");
  useEffect(() => () => frames.cancel(), [frames]);
  const [nav, setNav] = useState<NavDrag | null>(null);
  const [pill, setPill] = useState<PillDrag | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => { if (!fresh) return; const t = window.setTimeout(() => setFresh(null), 700); return () => window.clearTimeout(t); }, [fresh]);
  useEffect(() => { setSure(null); }, [cur]);
  useEsc(true, () => { if (gal) { sfx.click(); setGal(false); } else if (sure) { sfx.click(); setSure(null); } else onBack(); });

  // ---------- geometry: the phone at its real shape, scaled to fit, the pages beside it ----------
  const vp = useViewport();
  const island = useIsland();
  const scr = phoneScreen(dev, phone);
  const W = scr.w, H = scr.h;
  const sheetW = Math.round(Math.max(SHEET_MIN, Math.min(SHEET_MAX, vp.w * 0.22)));
  const pageW = Math.min(vp.w, document.documentElement.clientWidth || vp.w);   // without a scrollbar, like the sheet's own place
  const area = Math.max(300, pageW - 16 - sheetW - 20);   // the pages' part of the screen: left of the side sheet, 20 px clear of it
  const top = 104, bottom = vp.h - (gal ? 262 : 100);     // the name pills above, Delete page and the hint below
  const k = Math.max(0.22, Math.min(1, (bottom - top) / H, (area * 0.46) / W));
  const ks = k * 0.62;
  const cx = area / 2, cy = (top + bottom) / 2;
  const Wc = W * k, Ws = W * ks;
  const row = useMemo<Row>(() => ({ wc: Wc, ws: Ws, gap: 34, gap2: 26 }), [Wc, Ws]);
  const posOf = (d: number) => rowPos(d, row);
  const step = Ws + 26;
  // While a name pill is dragged: the order it would make.
  const order = pages.map((p) => p.id);
  const shown = pill ? (() => { const o = order.filter((x) => x !== pill.id); const from = order.indexOf(pill.id); const to = Math.max(0, Math.min(order.length - 1, from + Math.round(pill.dx / step))); o.splice(to, 0, pill.id); return o; })() : order;
  const rightTop = clearTop(island, { left: vp.w - 320, top: 16, right: vp.w - 16, bottom: 56 });

  // ---------- the mouse: drag, swipe, wheel and the edges slide the row (V1.57, views/usePhonePan.ts) ----------
  const roomRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const live = stage === "phone" && !leaving;
  const goTo = (id: string, how: "click" | "pan") => {
    if (id === layoutRef.current.pages[ci]?.id) return;
    if (how === "click") sfx.click(); else editSfx("edit-tick");
    setCur(id); setRenaming(null);
  };
  const panApi = useRef<PanApi>(null as unknown as PanApi);
  panApi.current = {
    live: live && !renaming, ci, n: pages.length, row, left: 0, right: area,
    quiet: gal || !!sure || !!pill || !!nav, carrying: tile?.mode === "move",
    go: (j) => { const p = layoutRef.current.pages[j]; if (p) goTo(p.id, "pan"); },
    onPan: (x, y) => tileAt(x, y),
  };
  const pan = usePhonePan(roomRef, trackRef, panApi);

  const newPage = (index: number) => {
    editSfx("edit-page-add");
    const r = addPage(layout, index, at());
    if (!r.id) return;
    change(r.layout, true);
    setCur(r.id);
    window.setTimeout(() => setGal(true), 280);
  };
  const add = (kind: string) => {
    sfx.click();
    let l = layout, target = page.id;
    if (page.kind !== "panels") {   // a panel goes on a page of panels: a new one right of this page
      const r = addPage(l, ci + 1, at());
      if (!r.id) return;
      l = r.layout; target = r.id;
    }
    const r = addTile(l, target, kind, red, at());
    if (!r.id) return;
    change(r.layout, true);
    setCur(target);
    setFresh(r.id);
  };
  // ---------- Delete page (V1.57): asks first, Undo after, never a page the phone cannot lose ----------
  const delPage = (id: string) => {
    const before = layoutRef.current;
    const r = deletePage(before, id, at());
    if (!r.removed) return;
    editSfx("edit-page-remove");
    change(r.layout, true);
    setCur(pageAfterDelete(before, id));
    setSure(null);
    setUndo({ removed: r.removed, name: pageName(r.removed.page), key: Date.now() });
  };
  const undoDel = () => {
    const u = undo;
    if (!u) return;
    editSfx("edit-switch");
    change(restorePage(layoutRef.current, u.removed, at()), true);
    setCur(u.removed.page.id);
    setUndo(null);
  };

  // ---------- dragging a tile ----------
  const held = useRef<number | null>(null);   // V1.65 quality pass: the pointer carrying a panel or the navbar (core/tiledrag.ts samePointer)
  const tileDown = useStable((e: RPE, id: string, mode: "move" | "size") => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    held.current = e.pointerId;   // only this pointer moves or drops it
    const d: TileDrag = { id, mode, sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, over: null, p0: pan.off() };
    tileRef.current = d; sigRef.current = "";
    setTile(d);
  });
  /** The carried tile under the pointer at x, y (also as the row slides under a still pointer): one frame at most. */
  const tileFrame = () => {
    const t = tileRef.current;
    const tl = t && page.tiles?.find((x) => x.id === t.id);
    if (!t || !tl) return;
    const { x, y } = ptr.current;
    if (x < 0) return;
    let over: string | null = null, onCur = false;
    if (t.mode === "move") for (const el of document.elementsFromPoint(x, y)) {
      const id = (el as HTMLElement).dataset?.pePage;
      if (!id) continue;
      if (id === page.id) { onCur = true; break; }
      over = id; break;
    }
    const { dx, dy } = dragDelta(t.sx, t.sy, x, y, k, pan.off() - (t.p0 ?? 0));
    const next = { ...t, dx, dy, over, out: t.mode === "move" && !over && !onCur };
    tileRef.current = next;
    carry(carriedEl(roomRef.current, t.id), tl, t.mode, dx, dy, W);
    const sig = dragSig(tl, t.mode, dx, dy, W, over, next.out);
    if (sig !== sigRef.current) { sigRef.current = sig; setTile(next); }
  };
  const tileAt = (x: number, y: number) => {
    if (!tileRef.current) return;
    ptr.current = { x, y };
    frames.push(tileFrame);
  };
  const tileMove = useStable((e: RPE) => { if (samePointer(held.current, e.pointerId)) tileAt(e.clientX, e.clientY); });
  const ghostOf = useStable((t: Tile, d: TileDrag) => ghostFor(t, d.mode, d.dx, d.dy, W));
  const tileUp = useStable((e?: RPE) => {
    if (!samePointer(held.current, e?.pointerId)) return;
    held.current = null;
    frames.flush();
    const d = tileRef.current;
    if (!d) return;
    const t = page.tiles?.find((x) => x.id === d.id);
    const el = carriedEl(roomRef.current, d.id);
    setTile(null); tileRef.current = null;
    if (!t || (Math.abs(d.dx) < 3 && Math.abs(d.dy) < 3)) { release(el); pan.settle(); return; }
    if (endKind(e?.type) === "cancel") { settle(el, t, d.mode, d.dx, d.dy, t, W); pan.settle(); return; }   // the system took the pointer: back where it was, nothing saved
    if (d.mode === "move" && d.over) {
      const j = pages.findIndex((p) => p.id === d.over);
      if (pages[j]?.kind !== "panels") release(el);
      if (pages[j]?.kind === "panels") { release(el); sfx.drop(); change(tileToPage(layout, page.id, t.id, pages[j].id, at())); setFresh(t.id); pan.settle(j); return; }
      pan.settle(); return;   // a page that holds no panels (List, Plan, Inbox): the panel goes back where it was
    }
    if (d.mode === "move" && d.out) { settle(el, t, d.mode, d.dx, d.dy, t, W); pan.settle(); return; }   // let go on no page: back where it was
    pan.settle();
    const g = ghostOf(t, d);
    settle(el, t, d.mode, d.dx, d.dy, g, W);
    sfx.drop();
    change(d.mode === "move" ? moveTile(layout, page.id, t.id, g.c, g.r, at()) : resizeTile(layout, page.id, t.id, g.w, g.h, at()));
  });

  // ---------- dragging the navbar or one of its buttons ----------
  const navLive = useRef<NavDrag | null>(null);
  const navSig = useRef("");
  const navDown = useStable((e: RPE, d: NavDrag) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    held.current = e.pointerId;
    navLive.current = d; navSig.current = "";
    setNav(d);
  });
  const navFrame = () => {
    const d = navLive.current;
    if (!d) return;
    const { x, y } = ptr.current;
    const next: NavDrag = d.kind === "bar" ? { ...d, dx: (x - d.sx) / k, dy: (y - d.sy) / k } : { ...d, dx: (x - d.sx) / k };
    navLive.current = next;
    carryNav(roomRef.current, next);
    const sig = next.kind === "bar" ? (() => { const t = barDrop(next); return `${t.edge}.${t.align}`; })() : String(reorderTo(next));
    if (sig !== navSig.current) { navSig.current = sig; setNav(next); }
  };
  const navMove = useStable((e: RPE) => {
    if (!navLive.current || !samePointer(held.current, e.pointerId)) return;
    ptr.current = { x: e.clientX, y: e.clientY };
    frames.push(navFrame);
  });
  const navItemsNow = layout.nav.items;
  const itemW = navItemsW(layout, W);
  const reorderTo = (d: Extract<NavDrag, { kind: "item" }>) => {
    const from = navItemsNow.indexOf(d.id);
    return Math.max(0, Math.min(navItemsNow.length - 1, from + Math.round(d.dx / itemW)));
  };
  const barDrop = (d: Extract<NavDrag, { kind: "bar" }>) => {
    // Where the bar would land: the edge from where it is dropped, the place along it from how far sideways it went.
    const startY = layout.nav.edge === "top" ? 60 : H - 60;
    const edge = startY + d.dy < H / 2 ? "top" : "bottom";
    const bw = layout.nav.align === "full" ? W - 20 : Math.min(W - 20, layout.nav.items.length * 58 + 14);
    const startX = layout.nav.align === "left" ? 10 + bw / 2 : layout.nav.align === "right" ? W - 10 - bw / 2 : W / 2;
    const x = startX + d.dx;
    const align: NavAlign = Math.abs(d.dx) < 24 ? layout.nav.align : x < W * 0.36 ? "left" : x > W * 0.64 ? "right" : layout.nav.align === "full" ? "full" : "center";
    return { edge, align } as const;
  };
  const navUp = useStable((e?: RPE) => {
    if (!samePointer(held.current, e?.pointerId)) return;
    held.current = null;
    frames.flush();
    const d = navLive.current;
    if (!d) return;
    navLive.current = null;
    setNav(null);
    releaseNav(roomRef.current);
    if (endKind(e?.type) === "cancel") return;   // the system took the pointer: the bar stays where it was
    if (d.kind === "bar") {
      if (Math.abs(d.dx) < 3 && Math.abs(d.dy) < 3) return;
      const t = barDrop(d);
      sfx.drop();
      change(setNavAlign(setNavEdge(layout, t.edge, at()), t.align, at()));
      return;
    }
    if (Math.abs(d.dx) < 3) return;
    const to = reorderTo(d);
    const items = navItemsNow.filter((x) => x !== d.id);
    items.splice(to, 0, d.id);
    sfx.drop();
    change(setNavItems(layout, items, red, at()));
  });
  // While dragging: the navbar as it would land (the same object while nothing is dragged, so the page can stay still).
  const navShown = useMemo(() => {
    if (!nav) return layout.nav;
    if (nav.kind === "bar") return { ...layout.nav, ...barDrop(nav) };
    const to = reorderTo(nav);
    const items = navItemsNow.filter((x) => x !== nav.id);
    items.splice(to, 0, nav.id);
    return { ...layout.nav, items };
  }, [nav, layout.nav]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- the cards ----------
  const removeTileCb = useStable((id: string) => { sfx.click(); change(removeTile(layoutRef.current, page.id, id, at()), true); });
  const removeNavCb = useStable((id: string) => { sfx.click(); change(toggleNav(layoutRef.current, id, red, at()), true); });
  const editProps = useMemo<EditProps>(() => ({
    tile, ghostOf, tileDown, tileMove, tileUp, nav, navShown, navDown, navMove, navUp, fresh, removeTile: removeTileCb, removeNav: removeNavCb,
  }), [tile, nav, navShown, fresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const switchPhone = useStable(onSwitch);
  const addCb = useStable(add);
  const closeGal = useStable(() => setGal(false));
  const cardTop = (isCur: boolean) => cy - (H * (isCur ? k : ks)) / 2;
  return (
    <div ref={roomRef} className={`pe-room${live ? " on" : ""}${leaving ? " leaving" : ""}${stage === "toMac" ? " closing" : ""}`} style={{ ["--pe-sheet" as string]: `${sheetW}px`, ["--pe-area" as string]: `${area}px` }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className="pe-dim" aria-hidden="true" onClick={() => { if (gal) { sfx.click(); setGal(false); } else if (sure) setSure(null); }} />
      {/* The stage: grows out of the top left icon, and back into it (the switch between the Mac and the phone). */}
      <div className="pe-stage">
      {/* The pages' part of the screen (left of the side sheet), and in it the row, which the mouse slides. */}
      <div className="pe-clip">
      <div ref={trackRef} className="pe-track">
      {/* Every page, the one being edited big in the middle, the others beside it; a + past each end. */}
      {shown.map((id, i) => {
        const p = pages.find((x) => x.id === id)!;
        const isCur = id === page.id;
        const d = i - shown.indexOf(page.id);
        const x = cx + posOf(isCur ? 0 : d) + (pill?.id === id ? pill.dx : 0);
        const sc = isCur ? k : ks;
        return (
          <div key={id} className={`pe-card${isCur ? " cur" : ""}${tile?.over === id ? " lit" : ""}`} data-pe-page={id}
            style={{ width: W, height: H, transform: `translate(${x - W / 2}px, ${cy - H / 2}px) scale(${sc})`, ["--d" as string]: Math.abs(d), ["--inv" as string]: 1 / sc }}
            onClick={isCur ? undefined : () => { pan.settle(); goTo(id, "click"); }}>
            <PhoneScreen layout={layout} page={p} phone={phone} W={W} H={H} red={red} edit={isCur ? editProps : null} />
            {!isCur && <span className="pe-card-hit" aria-hidden="true" />}
          </div>
        );
      })}
      {(["left", "right"] as const).map((side) => {
        const d = side === "left" ? -ci - 1 : pages.length - ci;
        const x = cx + posOf(d);
        const pw = Ws * 0.8, ph = H * ks * 0.6;
        return (
          <button key={side} type="button" className="pe-plus" aria-label={`New page on the ${side}`} style={{ transform: `translate(${x - pw / 2}px, ${cy - ph / 2}px)`, width: pw, height: ph }}
            onClick={() => newPage(side === "left" ? 0 : pages.length)}>
            <span aria-hidden="true">+</span><em>New page</em>
          </button>
        );
      })}
      {/* Each page's name: drag it sideways to reorder; the current page of panels can be renamed (double click). */}
      {shown.map((id, i) => {
        const p = pages.find((x) => x.id === id)!;
        const isCur = id === page.id;
        const d = i - shown.indexOf(page.id);
        const x = cx + posOf(isCur ? 0 : d) + (pill?.id === id ? pill.dx : 0);
        const name = pageName(p);
        return (
          <div key={id} className={`pe-pill${isCur ? " cur" : ""}${pill?.id === id ? " lifting" : ""}`} style={{ transform: `translate(calc(${x}px - 50%), ${cardTop(isCur) - 34}px)` }}
            onPointerDown={(e) => { if (e.button !== 0 || (e.target as Element).closest("button, input")) return; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); setPill({ id, sx: e.clientX, dx: 0 }); }}
            onPointerMove={(e) => { if (pill?.id === id) setPill({ ...pill, dx: e.clientX - pill.sx }); }}
            onPointerUp={() => { if (pill?.id !== id) return; const moved = Math.abs(pill.dx) > 4; setPill(null); if (moved && shown.join() !== order.join()) { sfx.drop(); change(orderPages(layout, shown, at())); } else if (!moved && !isCur) { pan.settle(); goTo(id, "click"); } }}
            onPointerCancel={() => setPill(null)}
            onDoubleClick={() => { if (p.kind === "panels") setRenaming(id); }}>
            {renaming === id ? (
              <input className="pe-rename" autoFocus defaultValue={name} maxLength={30}
                onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { e.stopPropagation(); setRenaming(null); } }}
                onBlur={(e) => { const v = e.target.value; setRenaming(null); if (v.trim()) change(renamePage(layout, id, v, at()), true); }} />
            ) : <span>{name}</span>}
            {isCur && p.kind === "panels" && renaming !== id && (
              <button type="button" className="pe-pill-x" aria-label={`Delete ${name}`} title="Delete page" onClick={() => { sfx.click(); setSure(id); }}>{"×"}</button>
            )}
          </div>
        );
      })}
      {/* V1.57 Delete page, under the page being edited (the developer: "add a delete page button on the bottom"). */}
      {!gal && (
        <div className="pe-del-at" style={{ transform: `translate(${cx}px, ${cy + (H * k) / 2 + 14}px)` }}>
          <DeletePage layout={layout} page={page} name={pageName(page)} asking={sure === page.id}
            onAsk={(o) => { sfx.click(); setSure(o ? page.id : null); }} onDelete={() => delPage(page.id)} onWhy={() => sfx.click()} />
        </div>
      )}
      </div>
      <i className="pe-clip-fade" aria-hidden="true" />
      </div>
      </div>
      {/* Top left is the Mac icon (PhoneMount's button). Top right: Add panel and Done. */}
      <div className="pe-top" style={{ top: rightTop }}>
        <PhoneLooks layout={layout} red={red} variant="mac" sound={macLookSound} apply={(l) => change(l, true)} />{/* V1.56 Saved looks and Reset (views/PhoneLooks.tsx) */}
        <button type="button" className={`ed-btn pe-add${gal ? " on" : ""}`} aria-expanded={gal} onClick={() => { sfx.click(); setGal(!gal); }}><span className="ed-plus" aria-hidden="true">+</span>Add panel</button>
        <button type="button" className="ed-btn ed-done" onClick={() => { sfx.click(); onDone(); }}>Done</button>
      </div>

      <Sheet layout={layout} page={page} phone={phone} dev={dev} devs={devs} red={red} change={change} onSwitch={switchPhone} />
      <p className="pe-hint" aria-live="polite">{page.kind === "panels"
        ? "Drag a panel to move it, or onto a page beside. The corner sizes it. Drag the background, scroll, or rest at an edge to slide between pages."
        : "This page is the phone's own. Add panel makes a page of panels beside it. Drag the background, scroll, or rest at an edge to slide between pages."}</p>
      {undo && <UndoDelete key={undo.key} name={undo.name} onUndo={undoDel} onGone={() => setUndo(null)} style={{ left: area / 2, bottom: 10 }} />}
      {gal && <PhoneGallery layout={layout} page={page} red={red} onAdd={addCb} onClose={closeGal} />}
    </div>
  );
}
export const pageName = (p: PhonePage) => (p.kind === "panels" ? p.name || "Page" : p.kind === "list" ? "List" : p.kind === "plan" ? "Plan" : "Inbox");
const navItemsW = (l: PhoneLayout, W: number) => {
  const bw = l.nav.align === "full" ? W - 20 : Math.min(W - 20, l.nav.items.length * 58 + 14);
  return Math.max(30, (bw - 14) / Math.max(1, l.nav.items.length));
};

// ---------- one page drawn at the phone's real size ----------
export type EditProps = {
  tile: TileDrag | null; ghostOf: (t: Tile, d: TileDrag) => Tile; tileDown: (e: RPE, id: string, mode: "move" | "size") => void; tileMove: (e: RPE) => void; tileUp: (e?: RPE) => void;
  nav: NavDrag | null; navShown: PhoneLayout["nav"]; navDown: (e: RPE, d: NavDrag) => void; navMove: (e: RPE) => void; navUp: (e?: RPE) => void;
  fresh: string | null; removeTile: (id: string) => void; removeNav: (id: string) => void;
};
type ScreenProps = { layout: PhoneLayout; page: PhonePage; phone: PhoneKind; W: number; H: number; red: boolean; edit: EditProps | null };
/** One value from the vault, drawing again only when that value changes (not on every vault change). */
function useVaultPick<T>(pick: (s: Snapshot) => T): T {
  return useSyncExternalStore(vaultStore.subscribe, () => pick(vaultStore.get()), () => pick(vaultStore.get()));
}
/** The phone's own background from its Settings (tmBgPhone, else the account's), for pages with none of the layout's. */
const phoneOwnBgOf = (s: Snapshot): string | null => { if (s.status !== "unlocked") return null; const st = settingsData(s); return st.tmBgPhone ?? st.tmBg ?? null; };
function PhoneScreenBody({ layout, page, phone, W, H, red, edit }: ScreenProps) {
  const lk = lookOf(layout, page.id);
  // No background of the layout's own: the phone's own from its Settings, so a change made on the phone shows here live too.
  const phoneOwnBg = useVaultPick(phoneOwnBgOf);
  const nv = edit?.navShown ?? layout.nav;
  const SB = phone === "ios" ? 50 : 34;
  const top = SB + (nv.edge === "top" ? 76 : 0) + 8;
  const bottom = nv.edge === "bottom" ? 64 + 18 : 18;
  return (
    <div className={`pe-screen ${phone}`} style={{ background: bgCss(lk.bg ?? phoneOwnBg) }} data-look={lk.look ?? undefined}>
      <div className="pe-status" style={{ height: SB }}>
        <b>9:41</b>{phone === "ios" ? <i className="pe-di" aria-hidden="true" /> : <i className="pe-cam" aria-hidden="true" />}<span className="pe-sig" aria-hidden="true" />
      </div>
      <div className="pe-content" style={{ top, bottom }}>
        {page.kind === "list" && <ListPreview />}
        {page.kind === "plan" && <div className="pe-pane"><div className="pe-panel"><StillPanel id="meetings" width /></div></div>}
        {page.kind === "inbox" && <div className="pe-pane">{[...(mailAllowed() ? ["mail"] : []), "meetnotes", "leftovers", "overdue"].map((x) => <div key={x} className="pe-panel"><StillPanel id={x} width /></div>)}</div>}
        {page.kind === "panels" && <Grid tiles={page.tiles ?? []} W={W} edit={edit} />}
      </div>
      <NavBar layout={layout} nav={nv} W={W} H={H} edit={edit} />
      {lk.look && <span className="pe-look-chip">Look: {lookName(lk.look)}</span>}
    </div>
  );
}
/** The names of the pages of panels, when the navbar shows any of them (their buttons carry the names). */
const navPageNames = (l: PhoneLayout) => (l.nav.items.some((i) => i.startsWith("page:")) ? l.pages.map((p) => `${p.id}\u0001${p.name ?? ""}`).join("\u0002") : "");
/** V1.57: a page draws again only when something it shows changed (its own page, the navbar, the looks), never because
 *  another page changed or a panel is being dragged on the page in the middle. */
function sameScreen(a: ScreenProps, b: ScreenProps): boolean {
  if (a.page !== b.page || a.phone !== b.phone || a.W !== b.W || a.H !== b.H || a.red !== b.red || a.edit !== b.edit) return false;
  if (a.layout === b.layout) return true;
  const x = a.layout, y = b.layout;
  return x.nav === y.nav && x.bg === y.bg && x.look === y.look && navPageNames(x) === navPageNames(y);
}
export const PhoneScreen = memo(PhoneScreenBody, sameScreen);
/** A panel drawn still (a picture of the real one, with your real data): draws again only when its data does. */
const StillPanel = memo(function StillPanel({ id, width = false }: { id: string; width?: boolean }) {
  return <PanelTileBody id={id} interactive={false} width={width} />;
});

type TileActs = { down: (e: RPE, id: string, mode: "move" | "size") => void; remove: (id: string) => void };
export function Grid({ tiles, W, edit }: { tiles: Tile[]; W: number; edit: EditProps | null }) {
  const rows = Math.max(rowsUsed(tiles), 1);
  const h = cellBox({ c: 0, r: rows - 1, w: 1, h: 1 }, W).top + cellBox({ c: 0, r: 0, w: 1, h: 1 }, W).height + 40;
  const d = edit?.tile;
  // The tiles keep the same handlers while a panel is dragged, so only the dragged one draws again on each move.
  const cb = useRef(edit);
  cb.current = edit;
  const acts = useMemo<TileActs>(() => ({ down: (e, id, m) => cb.current?.tileDown(e, id, m), remove: (id) => cb.current?.removeTile(id) }), []);
  return (
    <div className="pe-grid" style={{ height: h }} onPointerMove={edit?.tileMove} onPointerUp={edit?.tileUp} onPointerCancel={edit?.tileUp}>
      {edit && <Cells rows={rows} W={W} />}
      {tiles.map((t) => <GridTile key={t.id} t={t} W={W} drag={d?.id === t.id ? d : null} fresh={edit?.fresh === t.id} editing={!!edit} acts={acts} />)}
      {d && !d.over && !d.out && (() => { const t = tiles.find((x) => x.id === d.id); if (!t) return null; const g = cellBox(edit!.ghostOf(t, d), W); return <div className="pe-ghost" style={{ left: g.left, top: g.top, width: g.width, height: g.height }} />; })()}
      {!tiles.length && <p className="pe-empty">An empty page. Add panel puts panels here.</p>}
    </div>
  );
}
const Cells = memo(function Cells({ rows, W }: { rows: number; W: number }) {
  return <div className="pe-cells" aria-hidden="true">{Array.from({ length: (rows + 2) * COLS }, (_, i) => { const b = cellBox({ c: i % COLS, r: Math.floor(i / COLS), w: 1, h: 1 }, W); return <i key={i} style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />; })}</div>;
});
const GridTile = memo(function GridTile({ t, W, drag, fresh, editing, acts }: { t: Tile; W: number; drag: TileDrag | null; fresh: boolean; editing: boolean; acts: TileActs }) {
  const b = cellBox(t, W);
  // V1.65: a carried panel moves by CSS variables (views/tiledrive.ts), never by this style, so a drag writes no React state per move.
  const style = { left: b.left, top: b.top, width: `calc(${b.width}px + var(--dw, 0px))`, height: `calc(${b.height}px + var(--dh, 0px))` };
  return (
    <div className={`pe-tile${drag ? " dragging" : ""}${drag?.out ? " away" : ""}${fresh ? " fresh" : ""}`} style={style} data-tid={t.id}>
      <StillPanel id={t.id} />
      {editing && <>
        <div className="pe-tile-hit" onPointerDown={(e) => acts.down(e, t.id, "move")} title={tileLabel(t.id)} />
        <span className="pe-tile-name">{tileLabel(t.id)}</span>
        <button type="button" className="pe-tile-x" aria-label={`Remove ${tileLabel(t.id)}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => acts.remove(t.id)}>{"×"}</button>
        <span className="pe-tile-rs" onPointerDown={(e) => acts.down(e, t.id, "size")} aria-label="Size" role="slider" aria-valuenow={t.w * 10 + t.h} />
      </>}
    </div>
  );
});
export function NavBar({ layout, nav, W, H, edit }: { layout: PhoneLayout; nav: PhoneLayout["nav"]; W: number; H: number; edit: EditProps | null }) {
  const n = nav.items.length;
  const bw = nav.align === "full" ? W - 20 : Math.min(W - 20, n * 58 + 14);
  const left = nav.align === "left" ? 10 : nav.align === "right" ? W - 10 - bw : (W - bw) / 2;
  const d = edit?.nav;
  const barStyle: Record<string, number | string> = { width: bw, left, [nav.edge === "top" ? "top" : "bottom"]: nav.edge === "top" ? (layoutSB(layout) + 8) : 14 };
  return (
    <nav className={`pe-nav${d?.kind === "bar" ? " lifting" : ""}`} style={barStyle} data-h={H} onPointerMove={edit?.navMove} onPointerUp={edit?.navUp} onPointerCancel={edit?.navUp}>
      {edit && <span className="pe-nav-grip" title="Drag the navbar" onPointerDown={(e) => edit.navDown(e, { kind: "bar", sx: e.clientX, sy: e.clientY, dx: 0, dy: 0 })} />}
      {nav.items.map((it) => (
        <span key={it} className={`pe-nav-i${d?.kind === "item" && d.id === it ? " lifting" : ""}`}
          data-nid={it}
          onPointerDown={edit ? (e) => edit.navDown(e, { kind: "item", id: it, sx: e.clientX, dx: 0 }) : undefined}>
          <NavIcon id={it} />
          <em>{navLabel(layout, it)}</em>
          {edit && it !== "settings" && <button type="button" className="pe-nav-x" aria-label={`Take ${navLabel(layout, it)} out of the navbar`} onPointerDown={(e) => e.stopPropagation()} onClick={() => edit.removeNav(it)}>{"×"}</button>}
        </span>
      ))}
    </nav>
  );
}
const layoutSB = (l: PhoneLayout) => (l.phone === "ios" ? 50 : 34);
/** The task list page: your real tasks as the phone lists them (titles only, Priority 1 first). */
export const ListPreview = memo(function ListPreview() {
  const s = useVault();
  if (s.status !== "unlocked") return null;
  const st = settingsData(s);
  const list = todos(s).filter((d) => !d.data.done).sort((a, b) => Number(!!b.data.p1) - Number(!!a.data.p1)).slice(0, 12);
  return (
    <div className="pe-list">
      <h3>{st.tmHeadline || "Mission agenda"}</h3>
      {list.map((d) => <div key={d.id} className={`pe-row${d.data.p1 ? " p1" : ""}`}><i />{d.data.title}</div>)}
      {!list.length && <p className="pe-empty">Nothing on your list.</p>}
      <span className="pe-add-btn" aria-hidden="true">+</span>
    </div>
  );
});

// ---------- the side sheet: the phone, its navbar, this page's and every page's looks ----------
export const Sheet = memo(function Sheet({ layout, page, phone, dev, devs, red, change, onSwitch }: {
  layout: PhoneLayout; page: PhonePage; phone: PhoneKind; dev: PhoneDev | null; devs: PhoneDev[]; red: boolean; change: (l: PhoneLayout, now?: boolean) => void; onSwitch: (o: Open) => void;
}) {
  const choices = navChoices(layout, red);
  const others = devs.filter((d) => d.dev !== dev?.dev);
  return (
    <aside className="pe-sheet" onMouseDown={(e) => e.stopPropagation()}>
      <div className="pe-sec pe-who">
        <PhoneGlyph kind={phone} />
        <div><b>{dev ? phoneLabel(dev, devs) : phoneName(phone)}</b><em>{dev ? `Last open ${seenText(dev.seen)}` : "Shows on the phone once it signs in"}</em></div>
      </div>
      {(others.length > 0 || !dev) && (
        <div className="pe-switch">
          {others.map((d) => <button key={d.dev} type="button" onClick={() => onSwitch({ phone: d.phone, dev: d })}>{phoneLabel(d, devs)}</button>)}
          {(["gos", "ios"] as const).filter((x) => x !== phone && !devs.some((d) => d.phone === x)).map((x) => <button key={x} type="button" onClick={() => onSwitch({ phone: x, dev: null })}>{phoneName(x)}</button>)}
        </div>
      )}
      <div className="pe-sec">
        <h4>Navbar</h4>
        <Seg label="Edge" value={layout.nav.edge} options={[["top", "Top"], ["bottom", "Bottom"]]} onPick={(v) => change(setNavEdge(layout, v as "top" | "bottom", at()), true)} />
        <Seg label="Place" value={layout.nav.align} options={[["full", "Full"], ["left", "Left"], ["center", "Centre"], ["right", "Right"]]} onPick={(v) => change(setNavAlign(layout, v as NavAlign, at()), true)} />
        <div className="pe-navlist" role="group" aria-label="Navbar buttons">
          {choices.map((c) => (
            <label key={c.id} className={`pe-chk${c.keep ? " keep" : ""}`}>
              <input type="checkbox" checked={c.on} disabled={c.keep} onChange={() => { sfx.click(); change(toggleNav(layout, c.id, red, at()), true); }} />
              <NavIcon id={c.id} /><span>{c.label}</span>{c.keep && <em>always</em>}
            </label>
          ))}
        </div>
      </div>
      <div className="pe-sec">
        <h4>This page: {pageName(page)}</h4>
        <LookPick label="Background" value={page.bg ?? null} same="Same as every page" options={bgOptions()} onPick={(v) => change(setLook(layout, page.id, "bg", v, at()), true)} />
        <LookPick label="Look" value={page.look ?? null} same="Same as every page" options={offeredLooks().map((l) => [l.id, l.label] as [string, string])} onPick={(v) => change(setLook(layout, page.id, "look", v, at()), true)} />
      </div>
      <div className="pe-sec">
        <h4>Every page</h4>
        <LookPick label="Background" value={layout.bg ?? null} same="As set in Settings" options={bgOptions()} onPick={(v) => change(setLook(layout, null, "bg", v, at()), true)} />
        <LookPick label="Look" value={layout.look ?? null} same="As set in Settings" options={offeredLooks().map((l) => [l.id, l.label] as [string, string])} onPick={(v) => change(setLook(layout, null, "look", v, at()), true)} />
      </div>
      <p className="pe-note">Changes reach the phone when it next syncs, at once while PS is open on it.</p>
    </aside>
  );
});
export function Seg({ label, value, options, onPick }: { label: string; value: string; options: [string, string][]; onPick: (v: string) => void }) {
  return (
    <div className="pe-seg" role="radiogroup" aria-label={label}>
      <span>{label}</span>
      <div>{options.map(([v, t]) => <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => { if (value !== v) { sfx.click(); onPick(v); } }}>{t}</button>)}</div>
    </div>
  );
}
export function LookPick({ label, value, same, options, onPick }: { label: string; value: string | null; same: string; options: [string, string][]; onPick: (v: string | null) => void }) {
  return (
    <label className="pe-look">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(e) => { sfx.click(); onPick(e.target.value || null); }}>
        <option value="">{same}</option>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  );
}
/** The backgrounds a phone can show: the designs and the colours (videos stay on the device that has them). */
export const bgOptions = (): [string, string][] => [...BG_DESIGNS.map((d) => [d.id, d.label] as [string, string]), ...BG_COLOURS.map((c) => [`color:${c.id}`, c.label] as [string, string])];
const lookName = (id: string) => offeredLooks().find((l) => l.id === id)?.label ?? id;
/** A still picture of a background for the editor (the phone draws the real, moving one). */
export function bgCss(v: string | null): string {
  if (!v) return "radial-gradient(120% 80% at 50% 0%, #2a1730 0%, #140d12 60%)";
  const colour = colourBgCss(v);
  if (colour) return colour;
  if (v === "none") return "#140d12";
  if (v === "spotlight") return "radial-gradient(60% 45% at 50% 38%, rgba(255,255,255,.22), rgba(255,255,255,0) 70%), #0c0a10";
  if (v === "converge") return "conic-gradient(from 0deg at 50% 45%, #1a1030, #3a1d4a, #1a1030, #2a1a40, #1a1030)";
  if (v === "tunnel") return "repeating-radial-gradient(circle at 50% 45%, #120c18 0 14px, #1f1428 14px 28px)";
  if (v === "hypno") return "repeating-conic-gradient(from 0deg at 50% 45%, #1a0f22 0 12deg, #2e1a3a 12deg 24deg)";
  if (v.startsWith("storm")) return "linear-gradient(180deg, #0a0f1f 0%, #1a2440 60%, #0d1222 100%)";
  return "#140d12";
}

// ---------- the gallery ----------
/** focus: put the cursor in Search at once (the Mac); the phone leaves it for a tap (no keyboard popping up). */
export const PhoneGallery = memo(function PhoneGallery({ layout, page, red, onAdd, onClose, focus = true }: { layout: PhoneLayout; page: PhonePage; red: boolean; onAdd: (kind: string) => void; onClose: () => void; focus?: boolean }) {
  const [q, setQ] = useState("");
  const items = phoneGallery(layout, page.id, red).filter((x) => !q.trim() || x.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="pe-gal" role="dialog" aria-label="Add a panel to the phone" onMouseDown={(e) => e.stopPropagation()}>
      <div className="pe-gal-head">
        <b>Add panel</b>
        <span>{page.kind === "panels" ? `to ${pageName(page)}` : "on a new page beside this one"}</span>
        <input type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus={focus} />
        <button type="button" className="pe-gal-x" onClick={onClose} aria-label="Close">{"×"}</button>
      </div>
      <div className="pe-gal-list">
        {items.map((it, i) => (
          <button key={it.kind} type="button" className="pe-gal-i" style={{ ["--i" as string]: i }} onClick={() => onAdd(it.kind)}>
            <span className="pe-gal-prev"><StillPanel id={it.kind} /></span>
            <b className="pe-gal-n">{it.label}</b>
            <em>{it.all ? `${it.here} here, ${it.all} on the phone` : "Not on the phone"}</em>
          </button>
        ))}
        {!items.length && <p className="pe-empty">Nothing by that name.</p>}
      </div>
    </div>
  );
});

// ---------- icons ----------
const sv = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
export function PhoneGlyph({ small, kind, size }: { small?: boolean; kind?: PhoneKind; size?: number }) {
  const z = size ?? (small ? 16 : 20);
  return (
    <svg {...sv} width={z} height={z}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="3" />
      {kind === "ios" ? <path d="M10.5 5.2h3" strokeWidth="2.4" /> : <circle cx="12" cy="5.4" r=".9" fill="currentColor" stroke="none" />}
      <path d="M10 18.6h4" />
    </svg>
  );
}
export function MacGlyph({ size = 16 }: { size?: number }) { return <svg {...sv} width={size} height={size}><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8 20h8M12 16.5V20" /></svg>; }
export function NavIcon({ id }: { id: string }): ReactNode {
  const p: Record<string, ReactNode> = {
    plan: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
    list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
    inbox: <><path d="M3 13l3-8h12l3 8v6H3z" /><path d="M3 13h5l1 2h6l1-2h5" /></>,
    gym: <path d="M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11" />,
    soundboard: <><path d="M9 18V5l11-2v13" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>,
    vault: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    rules: <><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M8.5 10h7M8.5 14h4" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>,
  };
  const page = <><rect x="4" y="4" width="7" height="7" rx="2" /><rect x="13" y="4" width="7" height="7" rx="2" /><rect x="4" y="13" width="7" height="7" rx="2" /><rect x="13" y="13" width="7" height="7" rx="2" /></>;
  return <svg {...sv} width={18} height={18}>{p[id] ?? page}</svg>;
}
