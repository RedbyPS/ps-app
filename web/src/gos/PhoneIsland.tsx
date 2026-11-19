// The island inside PS on the phone (PS 1.66). The developer, 17 Nov 2026: the phone has no system island following him, so PS draws its own
// at the top of the app: just below the status bar, centred, the same moments as the Mac's island where they make sense on a
// phone (squad messages, new emails, reminders, Fitness, meetings, stand-ups, Pomodoro, the task being worked on). What it shows
// is decided in core/phoneisland.ts; this only draws it and sends a tap to the right page.
//
// - Never over the status bar, never over a full screen panel (they sit above it), hidden on the Vault pages, in Settings and
//   while the tour's card shows (that card takes its place, gos/phoneisland.css).
// - When the GrapheneOS shell's own island (ps-gos Island.kt, over every app) is on and allowed, that one shows and this does not.
// - Its own switch: Settings, This phone, Island inside PS (gos/phoneprefs.ts). On by default.
// - Light: it looks again only when something can change (each second only while a countdown shows), never polls the page.
import { IslandDayClocks, type DayPart } from "../views/DayCountdown";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVault } from "../ui/kit";
import { GOS, haptic, useGos } from "./bridge";
import { islandLocal } from "../island";
import { noteStore } from "../squad/chatengine";
import { remindRec, todos } from "../core/select";
import { remStatus, taskQuestion } from "../core/remind";
import { DEVICE_TZ } from "../core/tz";
import { countdown, nextLook, pickMoment, type IslandIn, type MomentKind, type MomentOpen, type NoteIn, type PhoneMoment, type RemIn } from "../core/phoneisland";
import { usePhonePref } from "./phoneprefs";
import type { Snapshot } from "../core/vault";
import "./phoneisland.css";

/** The reminders showing right now (the same rule as the Mac's card and the phone's ring: core/remind.ts remStatus). */
function remsNow(s: Snapshot, now: number): RemIn[] {
  if (s.status !== "unlocked") return [];
  const rec = remindRec(s);
  if (!rec?.list.length) return [];
  const titles = new Map(todos(s).map((d) => [d.id, d.data.title]));
  const out: RemIn[] = [];
  for (const r of rec.list) {
    if (remStatus(r, rec.state[r.id], now, DEVICE_TZ) !== "show") continue;
    out.push({ id: r.id, text: taskQuestion(r, r.task ? titles.get(r.task) : undefined), task: r.task ?? "" });
  }
  return out;
}

/** Is the shell's own island drawing (over every app, PS included): then this one stays away, so there are never two. */
export function nativeIslandOn(g: ReturnType<typeof useGos>): boolean {
  const p = g.perms;
  return GOS && g.prefs?.island !== false && !!p?.overlay && !(p.islandUsage && !p.usage);
}

const dayOf = (st: unknown): DayPart | null => ((st as { day?: DayPart | null } | null)?.day ?? null);
export function PhoneIsland({ hidden, onOpen }: { hidden: boolean; onOpen: (o: MomentOpen) => void }) {
  const on = usePhonePref("island");
  const g = useGos();
  const active = on && !nativeIslandOn(g) && g.visible && !hidden;
  const st = useSyncExternalStore(islandLocal.subscribe, islandLocal.get, islandLocal.get) as IslandIn | null;
  const cards = useSyncExternalStore(noteStore.subscribe, noteStore.get, noteStore.get);
  const notes = useMemo<NoteIn[]>(() => cards.map((c) => ({ id: c.id, title: c.title, body: c.body, at: c.at })), [cards]);
  const s = useVault();
  const [now, setNow] = useState(() => Date.now());
  const slot = Math.floor(now / 15_000);   // reminders are looked at again every 15 s at most
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rems = useMemo(() => remsNow(s, Date.now()), [s, slot]);
  const m = active ? pickMoment(st, notes, rems, now) : null;
  // Look again when something can change: each second while a countdown shows, else the next end it knows of (30 s at most).
  useEffect(() => {
    if (!active) return;
    const t = window.setTimeout(() => setNow(Date.now()), nextLook(m, st, notes, Date.now()));
    return () => window.clearTimeout(t);
  }, [active, now, m?.id, m?.to, st, notes]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving: the last moment stays drawn while the island shrinks away.
  const last = useRef<PhoneMoment | null>(null);
  const [, bump] = useState(0);
  if (m) last.current = m;
  useEffect(() => {
    if (m || !last.current) return;
    const t = window.setTimeout(() => { last.current = null; bump((n) => n + 1); }, 420);
    return () => window.clearTimeout(t);
  }, [m]);
  const view = m ?? last.current;
  if (!view) return null;
  const tap = () => { haptic("press"); onOpen(view.open); };
  return createPortal(
    <div className={`gos-isl ${view.big ? "big" : "small"} t-${view.tone}${m ? "" : " out"}`} data-kind={view.kind}>
      <button type="button" className="gos-isl-b" onClick={tap} aria-label={`${view.title}${view.sub ? `. ${view.sub}` : ""}`}>
        <span className="gos-isl-ic" aria-hidden="true">{ICONS[view.kind]}</span>
        <span className="gos-isl-txt" key={view.id}>
          <b>{view.title}</b>
          {view.big && view.sub && <em>{view.sub}</em>}
        </span>
        {view.to !== undefined && <span className="gos-isl-c">{countdown(view.to, now)}</span>}
        {/* PS 1.70: the day countdown beside the task (Settings, Countdown text), its Priority 1 timer first (views/DayCountdown.tsx). */}
        {view.kind === "task" && dayOf(st) && <IslandDayClocks d={dayOf(st)!} />}
      </button>
    </div>,
    document.body,
  );
}

const sv = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const ICONS: Record<MomentKind, ReactNode> = {
  squad: <svg {...sv}><path d="M5 18.5V7a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 19 7v6.5a2.5 2.5 0 0 1-2.5 2.5H9z" /></svg>,
  mail: <svg {...sv}><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4 7l8 6 8-6" /></svg>,
  lead: <svg {...sv}><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="M4 7l8 6 8-6" /></svg>,
  chat: <svg {...sv}><path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z" /><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" /></svg>,
  rem: <svg {...sv}><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg>,
  fit: <svg {...sv}><path d="M6.5 8v8M17.5 8v8M3.5 10v4M20.5 10v4M6.5 12h11" /></svg>,
  rest: <svg {...sv}><circle cx="12" cy="13" r="7.5" /><path d="M12 9.5V13l2.5 1.5M9.5 3h5" /></svg>,
  meet: <svg {...sv}><rect x="4" y="5" width="16" height="15" rx="2.5" /><path d="M4 10h16M8.5 3v4M15.5 3v4" /></svg>,
  stand: <svg {...sv}><circle cx="12" cy="4.8" r="2" /><path d="M12 7.5v7M8 10.5l4-2 4 2M9.5 21l2.5-6.5 2.5 6.5" /></svg>,
  pomo: <svg {...sv}><circle cx="12" cy="13.5" r="7" /><path d="M12 6.5c0-2 1.2-3 3-3M12 10v3.5" /></svg>,
  task: <svg {...sv}><circle cx="12" cy="12" r="7.5" /><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" /></svg>,
};
