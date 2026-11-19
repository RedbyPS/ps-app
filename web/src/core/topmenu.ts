// The top right menu of the Tab list (PS 1.70, the developer 19 Nov 2026: "all these different buttons and options everywhere,
// they're all very unclear... simplify it, kind of like Apple does"). Only Screen time and the Settings gear stay on the
// page; every other button that sat in the top right is a row here, with a clear icon and a plain name.
//
// How it opens each thing: the real buttons still render, hidden, inside the menu (views/TopMenu.tsx, the dock), so each
// screen and pop-up opens exactly as before and grows out of the menu button. A row names the real button it presses
// (`sel`, inside the dock); a row whose button is not there (a feature switched off, the developer's own on someone else's
// account, the website) is left out. The same idea as the phone's menu (gos/menu.ts).
// Pure: no React, no DOM, so tests/topmenu.test.ts checks it.

export type TopMenuId =
  | "afk" | "brief" | "endday"
  | "net" | "activity" | "mixer" | "lowpower" | "clipboard"
  | "dnd" | "gsquad" | "second" | "screen"
  | "tab" | "security" | "lock";

/** What a row does when picked. open: presses the button, the menu closes (its screen or pop-up opens). toggle: presses
 *  it, the menu stays and its switch flips. action: presses it, says it is done, then closes. moon: Do Not Disturb, a
 *  toggle while it is off (the moon turns it on at once) and open while it is on (the moon shows what it mutes). */
export type TopMenuKind = "open" | "toggle" | "action" | "moon";

export interface TopMenuItem {
  id: TopMenuId;
  /** The plain name on the row. */
  label: string;
  /** Rows are grouped, a thin line between groups: your day, this Mac, people and focus, PS itself. */
  group: 0 | 1 | 2 | 3;
  kind: TopMenuKind;
  /** The real button it presses, inside the dock. */
  sel: string;
  /** The Edit mode slot it lives in (core/tablayout.ts SLOTS, menu: true). */
  slot: string;
  /** A second, small button at the end of the row (Do Not Disturb's settings): its real button and its name. */
  more?: { sel: string; label: string };
  /** Was the button's old name (its hover text), for the report and the tests. */
  was: string;
}

export const TOP_MENU: readonly TopMenuItem[] = [
  { id: "afk", label: "AFK timer", group: 0, kind: "open", sel: ".afk-badge", slot: "afk", was: "AFK badge (AFK 14:32, Watcher 42:10 left)" },
  { id: "brief", label: "Morning brief", group: 0, kind: "open", sel: ".bf-sun", slot: "brief", was: "Morning brief" },
  { id: "endday", label: "End day", group: 0, kind: "open", sel: "[aria-label^='End your day']", slot: "endday", was: "End your day" },
  { id: "net", label: "Network", group: 1, kind: "open", sel: ".nm-btn", slot: "net", was: "Network monitor (this Mac only)" },
  { id: "activity", label: "Activity monitor", group: 1, kind: "open", sel: ".am-btn", slot: "activity", was: "Activity monitor" },
  { id: "mixer", label: "Volume mixer", group: 1, kind: "open", sel: ".mix-btn", slot: "mixer", was: "Volume mixer" },
  { id: "lowpower", label: "Low power mode", group: 1, kind: "toggle", sel: ".lp-btn", slot: "lowpower", was: "Low power mode: put the background to sleep, keep your list" },
  { id: "clipboard", label: "Clear clipboard", group: 1, kind: "action", sel: "[aria-label='Clear the clipboard']", slot: "clipboard", was: "Clear the clipboard (copies nothing)" },
  { id: "dnd", label: "Do Not Disturb", group: 2, kind: "moon", sel: ".dnd-btn", slot: "dnd", more: { sel: ".dnd-cog", label: "Do Not Disturb settings" }, was: "Do Not Disturb (the moon) and its small cog" },
  { id: "gsquad", label: "G Squad", group: 2, kind: "open", sel: ".gs-btn", slot: "gsquad", was: "G Squad" },
  { id: "second", label: "Second Computer", group: 2, kind: "open", sel: ".sc-btn[aria-haspopup]", slot: "second", was: "Second Computer" },
  // Its click opens the other Mac's screen and the Tab list steps aside, so the menu closes too (it says On while open).
  { id: "screen", label: "Remote screen", group: 2, kind: "open", sel: ".sc-btn[aria-pressed]", slot: "second", was: "Remote screen switch" },
  { id: "tab", label: "Tab overlay", group: 3, kind: "toggle", sel: ".ps-tab", slot: "pskeys", was: "Tab On / Off" },
  { id: "security", label: "Security", group: 3, kind: "open", sel: ".sec-btn", slot: "security", was: "Security (the padlock)" },
  { id: "lock", label: "Lock", group: 3, kind: "open", sel: ".ps-ovl-btn:not(.ps-tab)", slot: "pskeys", was: "Lock" },
];

/** The words the menu itself shows (besides the row names). */
export const TOP_MENU_WORDS = {
  button: "Menu",
  on: "On",
  cleared: "Cleared",
  watcher: "Watcher",
  online: "Online",
  offline: "Offline",
  working: "Working",
} as const;

/** The rows for this page, in order: only those whose real button is in the dock. */
export function topMenuItems(has: (sel: string) => boolean): TopMenuItem[] {
  return TOP_MENU.filter((m) => has(m.sel));
}

/** What a row shows on its right, read from its real button as the menu draws (the button keeps its own state). */
export interface RealButton { pressed: boolean | null; label: string; text: string; cls: string; disabled?: boolean }
export interface RowLive {
  /** A short value on the right ("On", "14:32", "Online"). */
  value?: string;
  /** The switch on the right (toggle rows). */
  on?: boolean;
  /** A small number badge (new G Squad messages). */
  badge?: string;
  /** Something needs a look (Security, a new Morning brief). */
  dot?: boolean;
  /** The row's name for now (the AFK row says Watcher while Watcher mode runs). */
  label?: string;
}
export function rowLive(id: TopMenuId, b: RealButton | null, badge = ""): RowLive {
  if (!b) return {};
  switch (id) {
    case "afk": {
      const watch = /\bwatch\b/.test(b.cls);
      const t = b.text.replace(/^\s*(AFK|Watcher)\s*/i, "").trim();
      return watch ? { label: TOP_MENU_WORDS.watcher, value: t } : { value: t };
    }
    case "brief": return { dot: /,\s*new$/.test(b.label) };
    case "dnd": case "screen": return b.pressed ? { value: TOP_MENU_WORDS.on } : {};
    case "lowpower": case "tab": return { on: !!b.pressed };
    case "security": return { dot: /\bsec-warn\b/.test(b.cls) };
    case "gsquad": return badge ? { badge } : {};
    case "second": {
      const m = /:\s*(online|offline|working)\s*$/i.exec(b.label);
      if (!m) return {};
      const k = m[1].toLowerCase() as "online" | "offline" | "working";
      return { value: TOP_MENU_WORDS[k] };
    }
    case "clipboard": return /\bok\b/.test(b.cls) ? { value: TOP_MENU_WORDS.cleared } : {};
    default: return {};
  }
}

/** The small mark on the menu button: "warn" when something needs a look (Security, new messages, a new brief), "on"
 *  when a mode is running (Do Not Disturb, Low power mode, an AFK timer, the Remote screen), else none. */
export function menuMark(rows: { id: TopMenuId; live: RowLive }[]): { mark: "warn" | "on" | null; why: string[] } {
  const warn = rows.filter((r) => r.live.dot || r.live.badge);
  if (warn.length) return { mark: "warn", why: warn.map((r) => r.live.badge ? `${r.live.label ?? labelOf(r.id)}, ${r.live.badge} new` : `${r.live.label ?? labelOf(r.id)} needs a look`) };
  const on = rows.filter((r) => ((r.id === "dnd" || r.id === "screen") && r.live.value) || (r.id === "lowpower" && r.live.on) || r.id === "afk");
  if (on.length) return { mark: "on", why: on.map((r) => `${r.live.label ?? labelOf(r.id)} is on`) };
  return { mark: null, why: [] };
}
const labelOf = (id: TopMenuId) => TOP_MENU.find((m) => m.id === id)?.label ?? id;

/** Keyboard: the row to move to from `i` of `n` rows (wraps round), or the first row whose name starts with a letter. */
export function nextRow(i: number, n: number, key: string, names?: string[]): number {
  if (n <= 0) return -1;
  if (key === "ArrowDown") return i < 0 ? 0 : (i + 1) % n;
  if (key === "ArrowUp") return i < 0 ? n - 1 : (i - 1 + n) % n;
  if (key === "Home" || key === "PageUp") return 0;
  if (key === "End" || key === "PageDown") return n - 1;
  if (names && key.length === 1 && /\S/.test(key)) {
    const k = key.toLowerCase();
    for (let s = 1; s <= n; s++) { const j = (Math.max(i, -1) + s) % n; if (names[j]?.toLowerCase().startsWith(k)) return j; }
  }
  return i;
}
