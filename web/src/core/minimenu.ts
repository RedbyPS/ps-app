// Which menu the keyboard opens on a mini task (PS 1.74). The developer, 22 Nov 2026: the Menu key, or Shift+F10, with focus
// on a mini task (or after a click on one) opened its TASK's menu, whose Delete takes the whole task. These pure rules
// pick the mini task the key belongs to, so views/MiniTasks.tsx opens that mini task's own menu instead.
// Pure functions only (tests/mini-delete.test.ts).

/** The two keys that open a menu from the keyboard: the Menu key, and Shift+F10 (no other modifier). */
export function isMenuKey(e: { key: string; shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return e.key === "ContextMenu" || (e.key === "F10" && !!e.shiftKey);
}

/** A mini task as the page knows it: "<task id>/<mini task id>" (the data-mini mark on its row). */
export type MiniRef = string;

/** Splits "<task id>/<mini task id>" at its last slash. Null for anything else. */
export function splitMiniRef(ref: string | null | undefined): { id: string; subId: string } | null {
  if (!ref) return null;
  const i = ref.lastIndexOf("/");
  if (i <= 0 || i === ref.length - 1) return null;
  return { id: ref.slice(0, i), subId: ref.slice(i + 1) };
}

/**
 * The mini task whose menu the key opens, or null (then the key does what it did before).
 * - focused: the mini task the keyboard focus sits in (its tick, its name being edited), if any. It always wins.
 * - picked: the mini task last clicked or tapped (it shows a ring), if it is still on screen.
 * - focusHoldsPicked: the focus is on the page itself or on something that holds the picked mini task (its task's row),
 *   so the key is meant for it. Focus on anything else (another task, a text box) means the click is old news.
 * - menuOpen: a menu is already open; its own keys decide, nothing opens on top.
 */
export function miniMenuFor(a: { focused: MiniRef | null; picked: MiniRef | null; pickedShown: boolean; focusHoldsPicked: boolean; menuOpen: boolean }): MiniRef | null {
  if (a.menuOpen) return null;
  if (a.focused && splitMiniRef(a.focused)) return a.focused;
  if (a.picked && a.pickedShown && a.focusHoldsPicked && splitMiniRef(a.picked)) return a.picked;
  return null;
}

/** Shows the bin on a mini task: while its name is being edited (every device), or on the phone once it is tapped. */
export function miniBinShown(a: { editing: boolean; phone: boolean; picked: boolean }): boolean {
  return a.editing || (a.phone && a.picked);
}
