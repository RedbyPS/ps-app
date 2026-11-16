// Second Computer drag and drop, the page's half (protocol v1.2, 2 Nov 2026). PS itself takes every drop on the
// Second Computer window and the Tab list's Second panel (ps-mac SecondDrop.swift), so Finder files, folders, Mail
// attachments, browser pictures and links, screenshots and text all work the same. The page only answers PS's
// question "what is under the pointer?" (window.__psSecondDrag.over / drop) from the elements marked as drop places,
// and lights that place up. A place: data-sdrop="<name>" and data-sdrop-target='<DropTarget JSON>'; the innermost
// one under the pointer wins (a folder row inside the Files pane).
// A PS without native drops (before v1.2, no "drop" in its caps) never asks: the HTML drop handlers then work as before.
import { useSyncExternalStore } from "react";
import { dropTargetOk, type DropTarget } from "../core/second";

let over: string | null = null;
const listeners = new Set<() => void>();
const textListeners = new Set<(t: string) => void>();
function setOver(z: string | null) { if (z !== over) { over = z; listeners.forEach((l) => l()); } }
const store = { subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }, get: () => over };

/** The drop place under the pointer right now (its data-sdrop name), or null. */
export function useDropOver(): string | null { return useSyncExternalStore(store.subscribe, store.get, store.get); }

/** Props for a drop place. */
export function dropPlace(name: string, target: DropTarget) {
  return { "data-sdrop": name, "data-sdrop-target": JSON.stringify(target) };
}

function placeAt(x: number, y: number): { name: string; target: DropTarget } | null {
  const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-sdrop]");
  if (!el) return null;
  try {
    const t = JSON.parse(el.dataset.sdropTarget ?? "null") as unknown;
    return dropTargetOk(t) ? { name: el.dataset.sdrop ?? "", target: t } : null;
  } catch { return null; }
}

/** A link or text PS took on a Messages drop place: it goes into the note being written. */
export function onDroppedText(f: (t: string) => void) { textListeners.add(f); return () => { textListeners.delete(f); }; }

type Api = { over(x: number, y: number): DropTarget | null; drop(x: number, y: number): DropTarget | null; leave(): void; text(t: string): void };
export function installDropZones() {
  const w = window as unknown as { __psSecondDrag?: Api };
  if (w.__psSecondDrag) return;
  w.__psSecondDrag = {
    over(x, y) { const p = placeAt(x, y); setOver(p?.name ?? null); return p?.target ?? null; },
    drop(x, y) { const p = placeAt(x, y); setOver(null); return p?.target ?? null; },
    leave() { setOver(null); },
    text(t) { if (typeof t === "string") textListeners.forEach((f) => f(t.slice(0, 4000))); },
  };
}
/** Whether this page's PS takes drops natively (it says so in its caps, mirrored from the main window). */
export const canNative = (caps: string[] | undefined) => !!caps?.includes("drop");
