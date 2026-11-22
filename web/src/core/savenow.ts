// PS 1.74: an edit made just before PS updates, reloads or quits is saved first (the developer, 22 Nov 2026: "when I make
// updates to my checklist, on update it sometimes deletes the updates I made recently"). Three things could still be lost
// when the page went away: text typed in an open box that was never left (most boxes save when you leave them), a save
// still waiting a moment to group fast typing (Notes), and a save on its way to storage (encrypting, then written).
// saveNow leaves the open box (its own save runs, as if you clicked away), runs every waiting save at once, then waits until
// every save has reached this device's storage (core/vault.ts settled), never longer than a few seconds.
// Who calls it: the Mac before it quits (an app update and its relaunch, the Hatch scene's restart, Quit) and before it
// reloads a page for a new web build (mac/Sources/main.swift, window.__psSaveNow), the Refresh button and the website's
// update note before they reload, the phone before it installs an update, and every page when it is hidden or closed
// (waiting saves only: the open box stays open). Tested in tests/savenow.test.ts.

type Flush = () => unknown;
/** "always": a save that waits (a debounce), run when the page hides too. "leave": something typed that is only saved
 *  when PS really goes away (a new mini task not yet added with Enter), never when the page merely hides. */
type When = "always" | "leave";
const waiting = new Map<Flush, When>();

/** A save that waits: saveNow can run it at once. Returns the call that takes it off again. */
export function holdEdit(flush: Flush, when: When = "always"): () => void {
  const f: Flush = () => flush();   // its own entry, even when the same function is held twice
  waiting.set(f, when);
  return () => { waiting.delete(f); };
}

/** Every waiting save, at once (leaving: the "leave" ones too). A failing one never stops the others. */
export function flushWaiting(leaving = false): number {
  let n = 0;
  for (const [f, when] of [...waiting]) {
    if (when === "leave" && !leaving) continue;
    try { f(); n++; } catch { /* that one is lost, the rest still save */ }
  }
  return n;
}

export type SaveNowDeps = {
  /** Leaves the box being typed in (its blur handler saves it). */
  leaveBox?: () => void;
  /** Resolves true once every save reached storage, false when it gave up (core/vault.ts settled). */
  settle: (maxMs: number) => Promise<boolean>;
};

/** Saves everything now. True when it all reached storage in time. */
export async function saveNow(deps: SaveNowDeps, maxMs = 3000): Promise<boolean> {
  flushWaiting(true);   // first, while a box being typed in still holds its words
  try { deps.leaveBox?.(); } catch { /* no box */ }
  await Promise.resolve();   // a blur handler's own save starts in the same turn; this lets a chained one start too
  try { return await deps.settle(maxMs); } catch { return false; }
}

/** The page's open box, left: an input, a text area or an editable area loses focus, so its own save runs. */
export function leaveOpenBox(doc: { activeElement: unknown } | undefined) {
  const a = doc?.activeElement as { blur?: () => void; tagName?: string; isContentEditable?: boolean } | null | undefined;
  if (!a || typeof a.blur !== "function") return;
  if (a.isContentEditable || a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT") a.blur();
}

type Win = {
  __psSaveNow?: () => Promise<boolean>;
  addEventListener: (t: string, f: () => void) => void;
};
type Doc = { activeElement: unknown; visibilityState?: string; addEventListener: (t: string, f: () => void) => void };
/** Once per page: window.__psSaveNow for the Mac, and the waiting saves run when the page is hidden or closed. */
export function installSaveNow(win: Win, doc: Doc, settle: SaveNowDeps["settle"]) {
  if (win.__psSaveNow) return;
  // One at a time: a second ask while one runs (the Mac's update save and its auto reload save both ask the Tab list, a
  // double click) waits for the first. Running the waiting saves twice adds a half typed mini task twice, because the box
  // only reads its emptied text on its next render.
  let running: Promise<boolean> | null = null;
  win.__psSaveNow = () => running || (running = saveNow({ leaveBox: () => leaveOpenBox(doc), settle }).finally(() => { running = null; }));
  win.addEventListener("pagehide", () => { flushWaiting(); });
  doc.addEventListener("visibilitychange", () => { if (doc.visibilityState === "hidden") flushWaiting(); });
}
/** saveNow on this page, before a reload or an update the page starts itself. */
export function saveBeforeLeaving(win: Win | undefined, maxMs = 3000): Promise<boolean> {
  return win?.__psSaveNow ? Promise.race([win.__psSaveNow(), new Promise<boolean>((r) => setTimeout(() => r(false), maxMs + 500))]) : Promise.resolve(true);
}
