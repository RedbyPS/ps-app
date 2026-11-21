// The island inside PS on the phone (PS 1.66). The developer, 17 Nov 2026: the phone has no system island following him, so PS draws its own
// at the top of the app: just below the status bar, centred, the same moments as the Mac's island where they make sense on a
// phone (squad messages, new emails, reminders, Fitness, meetings, stand-ups, Pomodoro, the task being worked on). What it shows
// is decided in core/phoneisland.ts; this draws it, opens its card and answers from it.
//
// PS 1.72, like the Mac's island (the developer, 21 Nov 2026: a tap on the reminder did nothing): it shows the task being worked on by
// default; a reminder comes OUT of it on a spring for a few seconds and goes back in, leaving a small bell while it waits.
// A tap opens the card that grows out of the island: the reminder with its real buttons (its confirm words, typing the word
// first unless it is one tap, Remind me in, Open task on a task), the timer or meeting that shows, and the task with its tick
// and Undo. The same rules as the phone's ring card (ps-gos RemRing.kt) and the Mac's card: the answer is saved in the vault
// (remwatch.ts remAnswer), so the ring, the notification and the Mac's card all go. New messages, emails, AI chats and
// Fitness moments still open their own screen at once. Closes on a tap outside, a swipe up, Esc or Back.
//
// - Never over the status bar, never over a full screen panel (they sit above it), hidden on the Vault pages, in Settings and
//   while the tour's card shows (that card takes its place, gos/phoneisland.css).
// - When the GrapheneOS shell's own island (ps-gos Island.kt, over every app) is on and allowed, that one shows and this pill
//   does not. A tap on a reminder on that island opens PS on this card ({type:"open", what:"rem:<id>"}, openIslandCard).
// - Its own switch: Settings, This phone, Island inside PS (gos/phoneprefs.ts). On by default.
// - Light: it looks again only when something can change (each second only while a countdown shows), never polls the page.
// - Reduce Motion: nothing moves (gos/phoneisland.css).
import { IslandDayClocks, type DayPart } from "../views/DayCountdown";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVault } from "../ui/kit";
import { GOS, haptic, useGos } from "./bridge";
import { islandLocal, islandMessage } from "../island";
import { noteStore } from "../squad/chatengine";
import { allTodos, remindRec } from "../core/select";
import { alarmLook, confirms, doneAct, remPlan, remStatus, snoozeAct, taskInfos, type PlanItem, type Reminder } from "../core/remind";
import { remAnswer } from "../remwatch";
import { UNDO_MS } from "../core/island";
import { DEVICE_TZ } from "../core/tz";
import { ISL_WORDS, cardOf, countdown, islandLook, nextLook, remSeen, remTurn, tapDoes, type IslandIn, type MomentKind, type MomentOpen, type NoteIn, type PhoneMoment, type RemIn } from "../core/phoneisland";
import { usePhonePref } from "./phoneprefs";
import type { Snapshot } from "../core/vault";
import "./phoneisland.css";

/** A reminder showing now, with the words the ring card and the Mac card use (core/remind.ts remPlan) and the reminder itself
 *  for its answer. */
interface RemLive { in: RemIn; item: PlanItem; r: Reminder }
/** The reminders showing right now (the same rule as the Mac's card and the phone's ring: core/remind.ts remStatus, on the
 *  plan's state, so a ticked task's reminder is quiet as it is there). */
function remsNow(s: Snapshot, now: number): RemLive[] {
  if (s.status !== "unlocked") return [];
  const rec = remindRec(s);
  if (!rec?.list.length) return [];
  const plan = remPlan(rec, !!s.red, { tasks: taskInfos(allTodos(s)), now, deviceTz: DEVICE_TZ });
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const out: RemLive[] = [];
  for (const r of rec.list) {
    const i = byId.get(r.id);
    if (!i) continue;
    const st = i.done || i.snoozeUntil || i.stateAt ? { done: i.done || undefined, snoozeUntil: i.snoozeUntil || undefined, at: i.stateAt } : undefined;
    if (remStatus({ ...r, on: i.on }, st, now, DEVICE_TZ) !== "show") continue;
    out.push({ in: { id: r.id, text: i.text, task: r.task ?? "", snooze: r.snooze }, item: i, r });
  }
  return out;
}

/** Is the shell's own island drawing (over every app, PS included): then this one stays away, so there are never two. */
export function nativeIslandOn(g: ReturnType<typeof useGos>): boolean {
  const p = g.perms;
  return GOS && g.prefs?.island !== false && !!p?.overlay && !(p.islandUsage && !p.usage);
}

// The shell asks for the card (a tap on a reminder on the GrapheneOS island, GosLayer's "open" handler).
let asked: { rem: string | null; n: number } = { rem: null, n: 0 };
const askSubs = new Set<() => void>();
export function openIslandCard(rem: string | null) { asked = { rem, n: asked.n + 1 }; askSubs.forEach((f) => f()); }
const askStore = { subscribe(f: () => void) { askSubs.add(f); return () => { askSubs.delete(f); }; }, get: () => asked };

const dayOf = (st: unknown): DayPart | null => ((st as { day?: DayPart | null } | null)?.day ?? null);
export function PhoneIsland({ hidden, onOpen }: { hidden: boolean; onOpen: (o: MomentOpen) => void }) {
  const on = usePhonePref("island");
  const g = useGos();
  const native = nativeIslandOn(g);
  const up = g.visible && !hidden;
  const active = on && !native && up;
  const st = useSyncExternalStore(islandLocal.subscribe, islandLocal.get, islandLocal.get) as IslandIn | null;
  const cards = useSyncExternalStore(noteStore.subscribe, noteStore.get, noteStore.get);
  const notes = useMemo<NoteIn[]>(() => cards.map((c) => ({ id: c.id, title: c.title, body: c.body, at: c.at })), [cards]);
  const s = useVault();
  // The clock: each render reads the real time (a saved one would be old after the island was away, and a reminder would then
  // count as long out when PS comes back); `tick` only asks for the next look.
  const [, setTick] = useState(0);
  const now = Date.now();
  const [card, setCard] = useState<{ pick: string | null } | null>(null);
  const slot = Math.floor(now / 15_000);   // reminders are looked at again every 15 s at most
  // Answered here a moment ago: away at once, before the vault's copy says so.
  const [answered, setAnswered] = useState<Record<string, number>>({});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const live = useMemo(() => remsNow(s, Date.now()).filter((x) => !(answered[x.in.id] > Date.now() - 20_000)), [s, slot, answered]);
  const rems = useMemo(() => live.map((x) => x.in), [live]);
  // When each reminder came out first. Cleared whenever the island is not up, so each one comes out again when PS comes back.
  const seen = useRef<Record<string, number>>({});
  if (!active) seen.current = {};
  else seen.current = remSeen(seen.current, rems, now);
  const look = active ? islandLook(st, notes, rems, seen.current, now) : null;
  const m = look?.face ?? null;
  // Look again when something can change: each second while a countdown shows, a reminder coming out or going back in,
  // else the next end it knows of (30 s at most).
  const turn = active ? remTurn(rems, seen.current, now) : null;
  useEffect(() => {
    if (!active && !card) return;
    const wait = Math.min(nextLook(m, st, notes, Date.now()), turn ? Math.max(60, turn - Date.now() + 20) : 30_000);
    const t = window.setTimeout(() => setTick((n) => n + 1), wait);
    return () => window.clearTimeout(t);
  });
  // ---------- the card ----------
  const ask = useSyncExternalStore(askStore.subscribe, askStore.get, askStore.get);
  const askSeen = useRef(ask.n);
  useEffect(() => {
    if (ask.n === askSeen.current) return;
    askSeen.current = ask.n;
    setCard({ pick: ask.rem });
    setTick((n) => n + 1);
  }, [ask]);
  const cardUp = !!card && up && (on || native);
  useEffect(() => { if (card && !up) setCard(null); }, [card, up]);
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
  const close = () => setCard(null);
  const tap = () => {
    if (!view) return;
    haptic("press");
    if (look && tapDoes(look, st) === "card") { setCard({ pick: null }); return; }
    onOpen(view.open);
  };
  const bell = !!look && look.waiting.length > 0 && view?.kind !== "rem";
  const label = view ? `${view.title}${view.sub ? `. ${view.sub}` : ""}${bell ? `. ${look!.waiting[0].text}` : ""}` : "";
  const pill = view && !cardUp && (
    <div className={`gos-isl ${view.big ? "big" : "small"} t-${view.tone}${m ? "" : " out"}${look?.out ? " pop" : ""}`} data-kind={view.kind}>
      <button type="button" className="gos-isl-b" onClick={tap} aria-label={label} aria-haspopup="dialog">
        <span className="gos-isl-ic" aria-hidden="true">{ICONS[view.kind]}{bell && <span className="gos-isl-bell">{ICONS.rem}</span>}</span>
        <span className="gos-isl-txt" key={view.id}>
          <b>{view.title}</b>
          {view.big && view.sub && <em>{view.sub}</em>}
        </span>
        {view.to !== undefined && <span className="gos-isl-c">{countdown(view.to, now)}</span>}
        {/* PS 1.70: the day countdown beside the task (Settings, Countdown text), its Priority 1 timer first (views/DayCountdown.tsx). */}
        {view.kind === "task" && dayOf(st) && <IslandDayClocks d={dayOf(st)!} />}
      </button>
    </div>
  );
  if (!pill && !cardUp) return null;
  const cardLook = look ?? islandLook(st, notes, rems, seen.current, now);
  const c = cardUp ? cardOf(cardLook, st, card!.pick, rems) : null;
  const remLive = c?.rem ? live.find((x) => x.in.id === c.rem!.id) ?? null : null;
  return createPortal(
    <>
      {pill}
      {cardUp && c && (
        <IslandCard key={`card:${remLive?.in.id ?? ""}`} rem={remLive} moment={c.moment} task={c.task} st={st} now={now} native={native}
          onClose={close} onOpen={(o) => { close(); onOpen(o); }}
          onAnswered={(id) => { setAnswered((a) => ({ ...a, [id]: Date.now() })); }} />
      )}
    </>,
    document.body,
  );
}

/** The card that grows out of the island. */
function IslandCard({ rem, moment, task, st, now, native, onClose, onOpen, onAnswered }: {
  rem: RemLive | null; moment: PhoneMoment | null; task: { id: string; title: string; dim: boolean } | null; st: IslandIn | null; now: number; native: boolean;
  onClose: () => void; onOpen: (o: MomentOpen) => void; onAnswered: (id: string) => void;
}) {
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  const [ticked, setTicked] = useState<{ id: string; title: string; at: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shut = () => {
    if (leaving) return;
    setLeaving(true);
    const quick = matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(onClose, quick ? 0 : 240);
  };
  // Esc (a keyboard) and Back (the phone's back gesture, gos/touch.ts sends "gos-back" first) close it, before anything under it.
  // Only while it is on top: Sleep mode, Sentry mode or anything else drawn over it keeps its own Esc and Back.
  const onTop = () => {
    const b = box.current?.getBoundingClientRect();
    if (!b) return false;
    const el = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(24, b.height / 2));
    return !!el && !!box.current?.contains(el);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && onTop()) { e.preventDefault(); e.stopPropagation(); shut(); } };
    const back = (e: Event) => { if (!onTop()) return; e.preventDefault(); e.stopImmediatePropagation(); shut(); };
    window.addEventListener("keydown", key, true);
    window.addEventListener("gos-back", back, true);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("gos-back", back, true); };
  });
  // Nothing left in it (the reminder answered elsewhere, the task finished, the timer over): it closes by itself.
  const empty = !rem && !moment && !task && !ticked;
  useEffect(() => { if (empty) onClose(); }, [empty]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Undo leaves after the island's own Undo time.
  useEffect(() => {
    if (!ticked) return;
    const t = window.setTimeout(() => setTicked(null), Math.max(0, ticked.at + UNDO_MS - Date.now()));
    return () => window.clearTimeout(t);
  }, [ticked]);
  // Swipe up closes it.
  const drag = useRef<{ y: number; id: number } | null>(null);
  const [dy, setDy] = useState(0);
  // From anywhere on it but the box to type in; a swipe that started on a button never also presses it (swiped, below).
  const swiped = useRef(false);
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("input")) return;
    swiped.current = false;
    drag.current = { y: e.clientY, id: e.pointerId };
  };
  const move = (e: React.PointerEvent) => { if (drag.current?.id === e.pointerId) setDy(Math.min(0, e.clientY - drag.current.y)); };
  const up = (e: React.PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    const moved = e.clientY - drag.current.y;   // from the release itself: a quick flick ends before the next render
    drag.current = null;
    if (moved < -12) swiped.current = true;
    if (moved < -48) { haptic("press"); shut(); } else setDy(0);
  };

  const by = GOS ? "phone" : "web";
  const r = rem?.r, item = rem?.item;
  const confirm = () => {
    if (!r || !item) return;
    if (!confirms(r, typed)) { haptic("reject"); setWrong(true); return; }
    haptic("tick");
    remAnswer(doneAct(r, Date.now(), DEVICE_TZ, by));
    onAnswered(r.id);
    shut();
  };
  const later = () => {
    if (!r) return;
    haptic("press");
    remAnswer(snoozeAct(r, Date.now(), by));
    onAnswered(r.id);
    shut();
  };
  const tick = () => {
    if (!task) return;
    haptic("tick");
    islandMessage({ type: "islandAction", action: "tick", id: task.id });
    setTicked({ ...task, at: Date.now() });
  };
  const undo = () => {
    if (!ticked) return;
    haptic("press");
    islandMessage({ type: "islandAction", action: "untick", id: ticked.id });
    setTicked(null);
  };
  const rl = item ? alarmLook(item.bg, item.accent) : null;
  const showTask = task && task.id !== ticked?.id ? task : null;
  return (
    <>
      <div className={`gos-isl-dim${leaving ? " out" : ""}`} onClick={shut} aria-hidden="true" />
      <div ref={box} className={`gos-isl-card${leaving ? " out" : ""}${native ? " under-native" : ""}`} role="dialog" aria-modal="true" aria-label={item?.pill || task?.title || moment?.title || ""}
        style={dy ? { transform: `translateY(${dy}px)`, transition: "none" } : undefined}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
        onClickCapture={(e) => { if (swiped.current) { swiped.current = false; e.preventDefault(); e.stopPropagation(); } }}>
        {item && r && rl && (
          <section className="gos-isl-rem" style={{ "--ir-bg": item.bg, "--ir-acc": item.accent, "--ir-ink": rl.ink, "--ir-sub": rl.sub, "--ir-on": rl.on } as React.CSSProperties}>
            <span className="gos-isl-rem-pill">{item.pill}</span>
            <p className="gos-isl-rem-q">{item.text}</p>
            {!item.click && (
              <input className="gos-isl-rem-type" value={typed} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} enterKeyHint="done"
                placeholder={`Type ${item.word}`} aria-label={`Type ${item.word}`}
                onChange={(e) => { setTyped(e.target.value); setWrong(false); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }} />
            )}
            {wrong && <p className="gos-isl-rem-wrong" role="alert">{`Only ${item.word} clears this`}</p>}
            <button type="button" className="gos-isl-rem-yes" onClick={confirm}>{item.yes}</button>
            <button type="button" className="gos-isl-rem-later" onClick={later}>{item.later}</button>
            {item.open && item.task && (
              <button type="button" className="gos-isl-rem-open" onClick={() => { haptic("press"); onOpen(`task:${item.task}`); }}>{item.open}</button>
            )}
          </section>
        )}
        {moment && (
          <button type="button" className={`gos-isl-row t-${moment.tone}`} onClick={() => { haptic("press"); onOpen(moment.open); }}>
            <span className="gos-isl-ic" aria-hidden="true">{ICONS[moment.kind]}</span>
            <span className="gos-isl-txt"><b>{moment.title}</b>{moment.sub && <em>{moment.sub}</em>}</span>
            {moment.to !== undefined && <span className="gos-isl-c">{countdown(moment.to, now)}</span>}
          </button>
        )}
        {showTask && (
          <div className={`gos-isl-task${showTask.dim ? " dim" : ""}`}>
            <button type="button" className="gos-isl-task-b" onClick={() => { haptic("press"); onOpen(`task:${showTask.id}`); }}>
              {!showTask.dim && <em>{ISL_WORDS.working}</em>}
              <b>{showTask.title}</b>
              {dayOf(st) && <span className="gos-isl-task-day"><IslandDayClocks d={dayOf(st)!} /></span>}
            </button>
            <button type="button" className="gos-isl-tick" onClick={tick} aria-label={`Tick off: ${showTask.title}`}>
              <svg {...sv} width={20} height={20}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </button>
          </div>
        )}
        {ticked && (
          <div className="gos-isl-task done">
            <span className="gos-isl-task-b"><s>{ticked.title}</s></span>
            <button type="button" className="gos-isl-undo" onClick={undo}>Undo</button>
          </div>
        )}
        <span className="gos-isl-grip" aria-hidden="true" />
      </div>
    </>
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
