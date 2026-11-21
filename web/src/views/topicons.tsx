// The top right's icons (PS 1.70, the developer 19 Nov 2026: "one clear icon each that makes sense"). One set, 24 by 24 and
// stroked, used by the menu's rows (views/TopMenu.tsx) and by the buttons themselves, so a button added back on its own
// in Edit mode looks like its row.
import type { ReactNode } from "react";
import type { TopMenuId } from "../core/topmenu";

/** PS 1.72: The G Squad left the menu (its own button beside it, Jan) and keeps the icon its row had. */
type IconId = TopMenuId | "gsquad";
const P: Record<IconId, ReactNode> = {
  // A stopwatch: the AFK timer counting.
  afk: <><circle cx="12" cy="13.5" r="7.5" /><path d="M12 9.5v4l2.6 1.6M10 2.8h4M12 2.8V6M18.4 6.4l1.3-1.3" /></>,
  // A folded newspaper: the Morning brief.
  brief: <path d="M5 4.5h10.5A1.5 1.5 0 0 1 17 6v12.5a2 2 0 0 0 2 2M17 9h2.5a1.5 1.5 0 0 1 1.5 1.5v8a2 2 0 0 1-2 2H6.5A2.5 2.5 0 0 1 4 18V5.5a1 1 0 0 1 1-1zM7.5 8.5h6M7.5 12h6M7.5 15.5h4" />,
  // The sun going down: the day ends (the developer chose this one, 4 Nov 2026).
  endday: <path d="M2.5 18h19M6.5 18a5.5 5.5 0 0 1 11 0M8 21.5h8M3.9 13.3l1.7 1M20.1 13.3l-1.7 1M12 2.5v6M9.4 6.3L12 8.9l2.6-2.6" />,
  // Up and down arrows: data going out and coming in (the old Ethernet port read as a plug).
  net: <path d="M8 20V4.5M4.5 8L8 4.5 11.5 8M16 4v15.5M12.5 16l3.5 3.5 3.5-3.5" />,
  // A pulse line in a window: what the Mac is doing now.
  activity: <><rect x="2.5" y="4" width="19" height="16" rx="3" /><path d="M6 12.5h2.5l2-4.5 3 8 2-3.5H18" /></>,
  // A speaker with sound waves: how loud each app is.
  mixer: <path d="M4 9.5h3.2L12 5.5v13l-4.8-4H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1zM15.5 9.2a4 4 0 0 1 0 5.6M18.3 6.6a7.6 7.6 0 0 1 0 10.8" />,
  // The leaf, as on the Low power mode button (it fills in while it is on).
  lowpower: <path d="M4.5 19.5c.6-8.6 6-14.4 15-15-.4 9-6.4 14.4-15 15zM4.5 19.5l7.5-7.5" />,
  // A clipboard with a cross: empties what was copied.
  clipboard: <path d="M9 3.5h6a1 1 0 0 1 1 1v1.5a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1zM8 5.2H6.5A1.5 1.5 0 0 0 5 6.7v12.8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V6.7a1.5 1.5 0 0 0-1.5-1.5H16M9.8 11.3l4.4 4.4M14.2 11.3l-4.4 4.4" />,
  // The moon, as everywhere for Do Not Disturb.
  dnd: <path d="M20 14.6A8.2 8.2 0 0 1 9.4 4a8.2 8.2 0 1 0 10.6 10.6z" />,
  // Two people: your squad.
  gsquad: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.7a3.5 3.5 0 0 1 0 6.6M21.5 20a6.5 6.5 0 0 0-3.8-5.9" /></>,
  // Two screens, one behind the other: your other Mac.
  second: <><path d="M8 7V5a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 22 5v7.5a1.5 1.5 0 0 1-1.5 1.5H18" /><rect x="2" y="8" width="14" height="9.5" rx="1.5" /><path d="M6.5 21h5M9 17.5V21" /></>,
  // A screen with a pointer on it: see and control the other Mac.
  screen: <><rect x="2.5" y="4" width="19" height="12.5" rx="1.8" /><path d="M9 20.5h6M12 16.5v4" /><path d="M10.4 7.4v6.2l1.6-1.5 1.2 2.4 1.3-.6-1.2-2.4h2.2z" fill="currentColor" stroke="none" /></>,
  // The Tab key: hold it to see your list.
  tab: <path d="M3 12h13.5M12.5 8l4 4-4 4M20.5 6v12" />,
  // A shield with a tick: Security (the padlock means Lock now).
  security: <><path d="M12 3l7.5 2.8v5.6c0 4.5-3.1 8.3-7.5 9.6-4.4-1.3-7.5-5.1-7.5-9.6V5.8z" /><path d="M8.9 12.1l2.2 2.2 4.1-4.3" /></>,
  // A padlock: lock PS now.
  lock: <><rect x="4.5" y="10.5" width="15" height="10.5" rx="2.2" /><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7M12 14.6v2.4" /></>,
};

export function TopIcon({ id, size = 18, stroke = 1.8, className }: { id: IconId; size?: number; stroke?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[id]}
    </svg>
  );
}
