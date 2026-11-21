// The phone's menu, top left (PS 1.72). The developer, 21 Nov 2026: the 1.67 wheel (hold the round button bottom left) goes: "this
// awkward GTA 5 looking radio station nav bar", "it sucks", and a button parked bottom left blocks what other apps put there.
// The hamburger is back at the top left, always there, and a tap brings out a plain list with every destination the wheel had:
// the old menu's items (gos/menu.ts, the same the developer only and switched off rules) plus the screens that were never in it (Sleep
// mode, Do Not Disturb, Gym, Sounds, What's new, Meetings, Inbox, Vault), under the wheel's headings.
// Pure: no React, no DOM (gos/GosLayer.tsx draws it, tests/phonemenu.test.ts checks it).
import { menuItems } from "./menu.ts";
import type { MenuId } from "./menu.ts";

/** A point on the screen (where an item's icon sits, so its screen can zoom out of it, gos/launch.ts). */
export interface Pt { x: number; y: number }

export type NavId = MenuId | "sleep" | "dnd" | "gym" | "sounds" | "whatsnew" | "plan" | "inbox" | "vault";
export type NavSection = "Most used" | "Your day" | "Tools";

export interface NavItem {
  id: NavId;
  label: string;
  /** The one plain line under its name. */
  line: string;
  section: NavSection;
  /** An SVG path, 24 by 24, stroked. PS Rules draws its badge instead. */
  icon: string;
}

/** The items that are not in the old menu: each has its own screen or page on the phone. */
const EXTRA: Record<"sleep" | "dnd" | "gym" | "sounds" | "whatsnew" | "plan" | "inbox" | "vault", { label: string; line: string; icon: string }> = {
  sleep: { label: "Sleep mode", line: "A calm clock and your alarms, logged when you wake.",
    icon: "M3 18v-6.5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2V18M3 15h18M3 18v2M21 18v2M6.5 9.5V8a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 12.5 8v1.5" },
  dnd: { label: "Do Not Disturb", line: "Mutes cards and sounds until you say.",
    icon: "M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" },
  gym: { label: "Gym", line: "Your workout, sets and the rest timer.",
    icon: "M6.5 6.5v11M17.5 6.5v11M3.5 9v6M20.5 9v6M6.5 12h11" },
  sounds: { label: "Sounds", line: "Your soundboard, the player and the queue.",
    icon: "M9 18.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 16.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM9 18.5V6l11-2.5v13" },
  whatsnew: { label: "What's new", line: "What changed in this version of PS.",
    icon: "M12 3l1.8 4.6L18.5 9.5l-4.7 1.9L12 16l-1.8-4.6L5.5 9.5l4.7-1.9zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" },
  plan: { label: "Meetings", line: "Your calls coming up, on the Plan page.",
    icon: "M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM4 9.5h16M8.5 3v3M15.5 3v3" },
  inbox: { label: "Inbox", line: "Client emails, notes, new tasks and Urgent.",
    icon: "M4 13.5l2.2-7.2A1.5 1.5 0 0 1 7.6 5.3h8.8a1.5 1.5 0 0 1 1.4 1l2.2 7.2V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18zM4 13.5h4.5l1.2 2h4.6l1.2-2H20" },
  vault: { label: "Vault", line: "The website's pages: clients, projects and more.",
    icon: "M4 6.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2zM12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4z" },
};

/** Every item, in order of use, under its heading: Most used, Your day, Tools (the wheel's order, kept). */
export const NAV_ORDER: { id: NavId; section: NavSection }[] = [
  { id: "sleep", section: "Most used" }, { id: "dnd", section: "Most used" }, { id: "clocks", section: "Most used" },
  { id: "gym", section: "Most used" }, { id: "gsquad", section: "Most used" }, { id: "receipts", section: "Most used" },
  { id: "timelines", section: "Most used" }, { id: "settings", section: "Most used" },
  { id: "goals", section: "Your day" }, { id: "screentime", section: "Your day" }, { id: "numerology", section: "Your day" },
  { id: "plan", section: "Your day" }, { id: "inbox", section: "Your day" }, { id: "series", section: "Your day" },
  { id: "brief", section: "Your day" },
  { id: "sounds", section: "Tools" }, { id: "dimx", section: "Tools" }, { id: "rules", section: "Tools" },
  { id: "whatsnew", section: "Tools" }, { id: "edit", section: "Tools" }, { id: "endday", section: "Tools" },
  { id: "clipboard", section: "Tools" }, { id: "campaigns", section: "Tools" }, { id: "vault", section: "Tools" },
];
export function navItems({ red, has, show }: { red: boolean; has: (sel: string) => boolean; show: (id: NavId) => boolean }): NavItem[] {
  const menu = new Map(menuItems({ red, has }).map((m) => [m.id as NavId, m]));
  const out: NavItem[] = [];
  for (const o of NAV_ORDER) {
    const m = menu.get(o.id);
    const x = (EXTRA as Record<string, { label: string; line: string; icon: string }>)[o.id];
    if (m) { if (!show(o.id)) continue; }
    else if (!x || !show(o.id)) continue;
    out.push({ id: o.id, label: m?.label ?? x.label, line: m?.line ?? x.line, icon: m?.icon ?? x.icon, section: o.section });
  }
  return out;
}
