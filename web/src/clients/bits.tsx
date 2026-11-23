// Small shared pieces of the Clients screen (PS 1.73): the popover with its place in the Esc order, icons, the toggle.
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

// Esc closes whatever is open on top, then Clients (the developer's rule: every PS screen closes on Esc, never gated).
const stack: (() => void)[] = [];
/** Close the top popover if there is one. True when Esc was used up here (the host must not also close Clients). */
export function cwEscape(): boolean {
  const f = stack[stack.length - 1];
  if (!f) return false;
  f();
  return true;
}
export const cwPopOpen = () => stack.length > 0;

/** A popover: closes on Esc (top first) and on a press outside it. */
export function Pop({ className, onClose, children, style }: { className: string; onClose: () => void; children: ReactNode; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const f = () => close.current();
    stack.push(f);
    const out = (e: PointerEvent) => {
      if (stack[stack.length - 1] !== f) return;   // only the top one
      if (ref.current && !ref.current.contains(e.target as Node)) f();
    };
    const t = window.setTimeout(() => document.addEventListener("pointerdown", out, true), 0);
    return () => { window.clearTimeout(t); document.removeEventListener("pointerdown", out, true); const i = stack.lastIndexOf(f); if (i >= 0) stack.splice(i, 1); };
  }, []);
  return <div ref={ref} className={className} style={style} onPointerDown={(e) => e.stopPropagation()}>{children}</div>;
}

export const I = {
  plus: <svg className="clw-i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg>,
  dots: <svg className="clw-i" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></svg>,
  down: <svg className="clw-i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>,
  x: <svg className="clw-i" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>,
  cal: <svg className="clw-i" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></svg>,
  video: <svg className="clw-i" viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2" /><path d="m16 10 6-3v10l-6-3" /></svg>,
  flag: <svg className="clw-i" viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>,
  lock: <svg className="clw-i" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>,
  trash: <svg className="clw-i" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></svg>,
  link: <svg className="clw-i" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>,
  tpl: <svg className="clw-i" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 9h16M9 9v11" /></svg>,
  box: <svg className="clw-i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></svg>,
  gear: <svg className="clw-i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></svg>,
  pen: <svg className="clw-i" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z" /></svg>,
};

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`clw-sw${on ? " on" : ""}`} onClick={() => onChange(!on)} />;
}

/** "HR" from "Halden & Rye". */
export function initials(name: string): string {
  const w = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] ?? "") + (w[1]?.[0] ?? w[0]?.[1] ?? "")).toUpperCase() || "C";
}
