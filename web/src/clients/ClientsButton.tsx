// The Clients workspace button and the screen's host (PS 1.73, the developer 21 Nov 2026). On the Mac's Tab list and the website's
// To-do page it sits in the bottom row after Fitness, in the Soundboard's old place (TaskMap.tsx, slot "clients"); on the
// phone (PS GOS and the iPhone web app) the dock has its own Clients button (gos/GosLayer.tsx) and the host is drawn there,
// so this button draws nothing on the phone. The screen itself is clients/ClientsScreen.tsx; this file is only the window.
// Full screen: on the Mac it covers the whole Tab list, on the phone everything but the dock, which stays lit under it.
// It grows out of the button like the Soundboard (views/DimensionX.tsx morph). While it is open on the Mac the list stays
// when Tab is let go and takes the keyboard.
// Esc always closes it (core/escape.ts): the screen's own pop-ups use the key first (preventDefault or stopping it); an
// Esc nobody used that reaches window closes Clients, and is marked used so the Tab list stays. The phone's back (no key)
// asks the screen first (cwEscape: its top pop-up), and closes Clients when nothing was open on top.
import { restBehind } from "../ui/screenrest";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PS, psPost } from "../ps";
import { GOS, MWEB } from "../gos/bridge";
import { sfx } from "../ui/sfx";
import { useVault } from "../ui/kit";
import { cleanCrmAppearance } from "../core/crmdata";
import { buildTokens, isLight, lookById } from "../core/looks";
import { settingsData } from "../core/select";
import { morph } from "../views/DimensionX";
import { closeRemindPop } from "../views/TaskRemind";
import { taskMapActions } from "../views/TaskMap";
import { ClientsScreen, cwEscape } from "./ClientsScreen";
import "./clientsbtn.css";

const MORPH = { body: ".clw-body", tint: ".clw-morph", flat: true };   // full size, square corners: it moves by transform only
const OPEN_EV = "ps-clw-open", CLOSE_EV = "ps-clw-close";
/** The phone: PS GOS and the iPhone web app (both draw the dock, gos/GosLayer.tsx). */
const PHONE = GOS || MWEB;
const WHERE: "mac" | "phone" | "web" = PHONE ? "phone" : PS ? "mac" : "web";

/** Opens Clients from anywhere (the phone's dock and menu, the Tab list button). `from`: what it grows out of. */
export function openClients(from?: HTMLElement | null) { window.dispatchEvent(new CustomEvent(OPEN_EV, { detail: from ?? null })); }
/** Closes it (the phone's dock: another button was tapped). */
export function closeClients() { window.dispatchEvent(new Event(CLOSE_EV)); }

// Open or not, for the dock's glow (useClientsOpen) and anyone who asks (clientsIsOpen).
let isOpen = false;
const subs = new Set<() => void>();
const setOpen = (v: boolean) => { if (isOpen === v) return; isOpen = v; subs.forEach((f) => f()); };
export const clientsIsOpen = () => isOpen;
export function useClientsOpen(): boolean {
  return useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => isOpen, () => false);
}

// One window at a time: a copy of the button added in Edit mode draws its own host, and the original stays mounted
// (hidden). The host whose button was pressed opens; with no button (the dock, the menu) the first one on screen.
type Reg = { anchor: () => HTMLElement | null };
const hosts: Reg[] = [];
const seen = (el: HTMLElement | null) => !!el && el.isConnected && el.getClientRects().length > 0;
function pick(from: HTMLElement | null): Reg | undefined {
  return (from && hosts.find((h) => h.anchor() === from)) || hosts.find((h) => seen(h.anchor())) || hosts[0];
}

export const ClientsIcon = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="7" width="17" height="12.5" rx="2.5" /><path d="M9 7V5.6A1.6 1.6 0 0 1 10.6 4h2.8A1.6 1.6 0 0 1 15 5.6V7M3.5 12.5h17M10.5 12.5v1.6h3v-1.6" />
  </svg>
);

function ClientWindow({ frame, close }: { frame: RefObject<HTMLDivElement | null>; close: () => void }) {
  const { look } = cleanCrmAppearance(settingsData(useVault()).crmAppearance);
  const palette = useMemo<CSSProperties | undefined>(() => look === "match" ? undefined : {
    ...buildTokens({ look, accent: null, density: "comfortable", text: 100, font: null }),
    colorScheme: isLight(lookById(look).base) ? "light" : "dark",
  }, [look]);
  return (
    <div ref={frame} className="clw-win" data-crm-look={look} style={palette} role="dialog" aria-modal="true" aria-label="CRM">
      <div className="clw-morph" aria-hidden="true" />
      <div className="clw-body"><ClientsScreen onClose={close} where={WHERE} /></div>
    </div>
  );
}

type Phase = "closed" | "open" | "closing";
/** The full screen window, its open and close and its Esc. One per page is used (see pick). */
export function ClientsHost({ anchor, docked }: { anchor: () => HTMLElement | null; docked?: boolean }) {
  const [phase, setPhase] = useState<Phase>("closed");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const win = useRef<HTMLDivElement>(null), dim = useRef<HTMLDivElement>(null);
  const from = useRef<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const reg = useRef<Reg>({ anchor });
  reg.current.anchor = anchor;
  useLayoutEffect(() => { setHost(docked || PHONE ? document.body : anchor()?.closest<HTMLElement>(".tm-overlay") ?? document.body); }, [docked]);   // eslint-disable-line react-hooks/exhaustive-deps

  const open = (el?: HTMLElement | null) => {
    if (phaseRef.current === "open") return;
    from.current = el ?? anchor();
    sfx.click(); setPhase("open");
  };
  const close = () => { if (phaseRef.current !== "open") return; sfx.drop(); setPhase("closing"); };
  useEffect(() => {
    const me = reg.current;
    hosts.push(me);
    const f = (e: Event) => { const el = (e as CustomEvent<HTMLElement | null>).detail; if (pick(el) === me) open(el); };
    const c = () => close();
    window.addEventListener(OPEN_EV, f);
    window.addEventListener(CLOSE_EV, c);
    return () => { window.removeEventListener(OPEN_EV, f); window.removeEventListener(CLOSE_EV, c); hosts.splice(hosts.indexOf(me), 1); };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Esc, added once the screen is in (so after its own listeners): an Esc the screen did not use closes Clients.
  useEffect(() => {
    if (phase !== "open") return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      e.preventDefault(); e.stopImmediatePropagation();
      close();
    };
    // The phone's back: taken before the dock's own back (a pane change). The screen's top pop-up first, then Clients.
    const back = (e: Event) => {
      e.preventDefault(); e.stopImmediatePropagation();
      let used = false;
      try { used = closeRemindPop() || cwEscape(); } catch { /* a broken pop-up never keeps Clients open */ }
      if (!used) close();
    };
    window.addEventListener("keydown", key);
    if (PHONE) window.addEventListener("gos-back", back, { capture: true });
    return () => { window.removeEventListener("keydown", key); window.removeEventListener("gos-back", back, { capture: true }); };
  }, [phase]);   // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => {
    const root = anchor()?.closest<HTMLElement>(".tm-overlay");
    if (phase === "open") {
      setOpen(true);
      restBehind(root, "clients", true);   // the Tab list's moving looks rest while this covers them (ui/screenrest.ts)
      if (PS) psPost({ type: "dimx", open: true }); else if (!PHONE) taskMapActions.editing(true);
      void morph(win.current, from.current ?? anchor(), dim.current, "in", MORPH);
    } else if (phase === "closing") {
      setOpen(false);
      if (PS) psPost({ type: "dimx", open: false }); else if (!PHONE) taskMapActions.editing(false);
      const a = document.activeElement as HTMLElement | null;
      if (a && win.current?.contains(a)) a.blur();
      const back = from.current?.isConnected ? from.current : anchor();
      void morph(win.current, back, dim.current, "out", MORPH).then(() => {
        restBehind(root, "clients", false);
        setPhase((p) => (p === "closing" ? "closed" : p));
      });
    }
  }, [phase]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (phaseRef.current === "open") { setOpen(false); if (PS) psPost({ type: "dimx", open: false }); } }, []);

  if (!host || phase === "closed") return null;
  return createPortal(
    <div className={`clw-layer${docked ? " docked" : ""}${PHONE ? " gos" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
      <div ref={dim} className="clw-dim" aria-hidden="true" />
      <ClientWindow frame={win} close={close} />
    </div>,
    host,
  );
}

/** The bottom row button (Mac Tab list, website To-do page). Draws the host too. */
export function ClientsButton({ docked }: { docked?: boolean }) {
  const btn = useRef<HTMLButtonElement>(null);
  const on = useClientsOpen();
  if (PHONE) return null;
  return (
    <>
      <button ref={btn} type="button" className={`clw-tab-btn${on ? " on" : ""}`} onClick={() => openClients(btn.current)} onMouseDown={(e) => e.stopPropagation()}
        aria-label="Open CRM" title="CRM">
        <ClientsIcon /><span>CRM</span>
      </button>
      <ClientsHost anchor={() => btn.current} docked={docked} />
    </>
  );
}
