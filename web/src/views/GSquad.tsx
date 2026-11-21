// G Squad (V1.40), the developer 7 Nov 2026: a small live icon in the Tab list's top bar. Hover: "X people are working
// right now" ("working" = that person's PS is running, never "online"). Click: a simple pop-up with tabs,
// Leaderboard, Tasks, Screen time, Members, Chat. Tasks and Members work now; Leaderboard, Screen time and Chat
// are placeholders the later V1.40 chats fill in through squad/tabs.ts. Everything the squad sees is opened on
// the main page and arrives here as a plain view (squad/mirror.ts); this window holds no key.
// Every account sees it in PS (public too), and every sharing switch is here, so a stranger's PS shows them all.
import { TopIcon } from "./topicons";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { shareOn, type SharePiece } from "../core/squadshare";
import { useOverlayShown } from "../ps";
import { squadOp, useSquad } from "../squad/mirror";
import { onSquadTabs, registerSquadTab, squadLayers, TAB_ORDER, type SquadTabProps } from "../squad/tabs";
import { workingLine, type SquadHand, type SquadTask, type SquadView } from "../squad/view";
import { notInStage, THE_SQUAD } from "../squad/single";
import { NO_NAME } from "../core/squadauto";
import { NO_NAME_ASK } from "../core/squaddir";
import { fmtDate } from "../ui/kit";
import { feature } from "../core/features";
import { P1_FEATURE, cleanStart, p1State } from "../core/squadp1";
import { BOARD_FEATURE, leftTone, leftWords } from "../core/squadp1board";
import { sfx } from "../ui/sfx";
import { useChat } from "../squad/chatmirror";
import { composeStore } from "../squad/chatopen";
import { badgeText } from "../squad/chatview";
import "./GSquadChat";   // registers the Chat tab (G Squad chat, V1.40) before the placeholders below
import "./GSquadFit";    // registers the Fitness section (V1.43): the squad's gym boards from Fitness, the same code
import { GSquadWindow } from "./GSquadWindow";
import { Avatar } from "./SquadAvatar";
import { v3On } from "./GSquadV3";
import { NameEdit, setShare, SharingList, useShare } from "./GSquadSettings";
import { startPhoneSquad } from "../squad/phonehost";
import "./gsquad.css";

export { SharingList };

/** Three heads; the middle one a touch forward. */
function SquadIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8.2" r="3.2" /><path d="M5.6 19.5c.6-3.4 3.2-5.4 6.4-5.4s5.8 2 6.4 5.4" />
      <circle cx="5.2" cy="9.6" r="2.2" opacity=".7" /><path d="M1.8 17.6c.4-2.2 1.8-3.6 3.6-3.9" opacity=".7" />
      <circle cx="18.8" cy="9.6" r="2.2" opacity=".7" /><path d="M22.2 17.6c-.4-2.2-1.8-3.6-3.6-3.9" opacity=".7" />
    </svg>
  );
}

let popOpen = false;
let wantTab: string | null = null;   // a tab asked for from outside (the chat hook opens on Chat)
const popSubs = new Set<() => void>();
function setPop(v: boolean) { if (v !== popOpen) { popOpen = v; popSubs.forEach((l) => l()); } }
const usePop = () => useSyncExternalStore((l) => { popSubs.add(l); return () => { popSubs.delete(l); }; }, () => popOpen);
const useWantTab = () => useSyncExternalStore((l) => { popSubs.add(l); return () => { popSubs.delete(l); }; }, () => wantTab);
/** Opens or closes the pop-up (also used by the self test and the setup menu), on a given tab if asked. */
export function openGSquad(v = true, tab?: string) { if (tab) { wantTab = tab; popSubs.forEach((l) => l()); } setPop(v); }

/** What the button says before you are in (V1.49: PS joins The G Squad by itself): hovering it and a screen reader. */
export const NO_SQUAD = "Joining The G Squad";

/** The G Squad button. It always draws (no squad yet, hub not reachable, any account): never return null here. */
export function GSquadButton() {
  const v = useSquad();
  const chat = useChat();
  const open = usePop();
  const shown = useOverlayShown();
  const btn = useRef<HTMLButtonElement>(null);
  // The chat hook (squad/chatopen.ts): another part of PS asked to message the squad about something.
  const ask = useSyncExternalStore(composeStore.subscribe, composeStore.get);
  useEffect(() => { if (ask.n) openGSquad(true, "chat"); }, [ask.n]);
  // The Tab list showed: the count, at most once a minute (the main page decides; no beat runs here).
  useEffect(() => { if (shown && v.in) squadOp({ op: "peek" }); }, [shown, v.in]);
  useEffect(() => { if (!shown) setPop(false); }, [shown]);
  const n = v.in ? v.count : null;
  const live = (n ?? 0) > 0;
  const outLine = v.in ? "" : v.auto?.stage === "removed" ? "Not in The G Squad" : NO_SQUAD;
  return (
    <span className="gs-wrap">
      <button ref={btn} type="button" className={`gs-btn${open ? " open" : ""}${live ? " live" : ""}${v.in ? "" : " gs-none"}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={v.in ? `The G Squad. ${workingLine(n)}${chat.unread ? `. ${chat.unread} new ${chat.unread === 1 ? "message" : "messages"}` : ""}` : `The G Squad. ${outLine}`}
        data-tip="The G Squad" data-tip-line={v.in ? workingLine(n) : outLine}
        onClick={() => { sfx.click(); setPop(!open); }}>
        <TopIcon id="gsquad" />   {/* PS 1.72: the two people its menu row had (Jan saw it there) */}
        {live && <b className="gs-n num" aria-hidden="true">{n}</b>}
        {!v.in && <i className="gs-plus" aria-hidden="true" />}
        {v.waiting > 0 && <i className="gs-wait" aria-hidden="true" />}
        {chat.unread > 0 && !open && <b className="gc-badge num" aria-hidden="true">{badgeText(chat.unread)}</b>}
      </button>
      {open && <GSquadPop anchor={btn} onClose={() => setPop(false)} />}
      <SquadLayers />
    </span>
  );
}

/** What other G Squad parts show over the Tab list by themselves (squad/tabs.ts registerSquadLayer). */
function SquadLayers() {
  const list = useSyncExternalStore(onSquadTabs, squadLayers);
  return <>{list.map((L, i) => <L key={i} />)}</>;
}

// V1.47: the G Squad screen (views/GSquadWindow.tsx) fills the Tab list's screen, a messenger in PS's own look. This
// only hands it the view, the sections' props, the join screen and the pinned cards.
function GSquadPop({ anchor, onClose }: { anchor: React.RefObject<HTMLElement | null> | null; onClose: () => void }) {
  const v = useSquad();
  const share = useShare();
  const asked = useWantTab();
  const props: SquadTabProps = { view: v, op: squadOp, share, setShare };
  return (
    <GSquadWindow anchor={anchor} onClose={onClose} v={v} props={props} asked={asked} onAsked={() => { wantTab = null; }} Icon={SquadIcon}
      welcome={<JoinScreen v={v} />} asks={<AskList view={v} />} />
  );
}

/** THE PHONE ENTRY POINT (V1.47): GOS and the iPhone web app have no G Squad button. The phone's hamburger menu calls
 *  openGSquad() (optionally openGSquad(true, "chat")); this host, mounted once on the phone's home, draws the same G
 *  Squad screen laid out for the phone, and starts G Squad on the iPhone web app (PS GOS starts it in gos/bridge.ts). */
export function GSquadHost() {
  const open = usePop();
  useEffect(() => { startPhoneSquad(); }, []);
  // The chat hook (squad/chatopen.ts): another part of PS asked to message the squad about something.
  const ask = useSyncExternalStore(composeStore.subscribe, composeStore.get);
  useEffect(() => { if (ask.n) openGSquad(true, "chat"); }, [ask.n]);
  return <>{open && <GSquadPop anchor={null} onClose={() => setPop(false)} />}<SquadLayers /></>;
}
/** How many new things the phone's menu item can show (unread messages, hand overs). */
export function useGSquadBadge(): number {
  const v = useSquad();
  const chat = useChat();
  return (v.in ? v.waiting : 0) + chat.unread;
}

// ---------- V1.57 invite only: the admin's Approve and Decline ----------
/** The admin: who asked to join, with Approve and Decline (on every section but Members). Approve lets them in and
 *  members' PS hand them the squad key; Decline removes the request and that PS does not ask again by itself. */
function AskList({ view }: { view: SquadView }) {
  const list = view.in && view.creator ? view.asks ?? [] : [];
  if (!list.length) return null;
  const squad = view.name || THE_SQUAD;
  return (
    <div className="gs-asks" role="region" aria-label="Asked to join">
      <span className="gs-h">Asked to join</span>
      <ul className="gs-list">
        {list.map((a) => (
          <li key={a.id} className="gs-task gs-hand">
            <span className="gs-tt">{a.ok ? a.name : "Someone"} asked to join {squad}<em>{a.ok ? `Check code ${a.code}` : NO_NAME_ASK}</em></span>
            {a.ok && <button type="button" className="gs-mini go" onClick={() => { sfx.drop(); squadOp({ op: "approve", id: a.id }); }}>Approve</button>}
            <button type="button" className="gs-mini" onClick={() => { sfx.click(); squadOp({ op: "decline", id: a.id }); }}>Decline</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- not in yet (V1.49: one squad, everyone in) ----------
// The developer 11 Nov 2026: "I want to make it there's automatically one squad already and we're all automatically in it." No
// list, no Create a squad, no Ask to join, no claim code, no approval: PS joins The G Squad by itself as soon as you are
// signed in (squad/autoengine.ts), so this screen only shows how that is going (squad/single.ts notInStage).
function JoinScreen({ v }: { v: SquadView }) {
  const stage = notInStage(v) ?? "joining";
  const again = () => { sfx.click(); squadOp({ op: "rejoin" }); };
  return (
    <div className="gs-welcome">
      {stage === "joining" && (
        <div className="gs-card gs-looking" role="status">
          <i className="gs-spin" aria-hidden="true" />
          <span className="gs-tt">Getting you into {THE_SQUAD}<em>Someone already in hands your PS app the squad key: it takes a moment, or a few minutes if nobody else has PS app open.</em></span>
        </div>
      )}
      {stage === "asked" && (
        <div className="gs-ask" role="status">
          <span className="gs-ask-t">You asked to join {THE_SQUAD}</span>
          <p className="gs-lead">{THE_SQUAD} is invite only. The admin lets you in, even if PS app is closed for a while. To get in at once, scan the Add friend code of a friend who is in it.</p>
          {v.auto?.code && <p className="gs-code">Check code <b className="num">{v.auto.code}</b><em>The admin sees the same code on your request.</em></p>}
        </div>
      )}
      {stage === "removed" && (
        <div className="gs-card bad" role="status">
          <span className="gs-tt">You are not in {THE_SQUAD}<em>The admin took you out or did not let you in. A friend's Add friend code still lets you in.</em></span>
        </div>
      )}
      {stage === "full" && (
        <div className="gs-card" role="status">
          <span className="gs-tt">{THE_SQUAD} is full<em>It has room for 200 people.</em></span>
          <button type="button" className="gs-ghost" onClick={again}>Check again</button>
        </div>
      )}
      {stage === "error" && (
        <div className="gs-card bad" role="alert">
          <span className="gs-tt">Could not reach {THE_SQUAD}<em>{v.auto?.error || "Check your internet and try again."}</em></span>
          <button type="button" className="gs-go" onClick={again}>Try again</button>
        </div>
      )}
      <SharingList />
    </div>
  );
}

// ---------- Tasks ----------
function TasksTab({ view, op, share }: SquadTabProps) {
  const names = useMemo(() => new Map(view.members.map((m) => [m.id, m.me ? "You" : m.name])), [view.members]);
  const byMember = useMemo(() => {
    const m = new Map<string, SquadTask[]>();
    for (const t of view.tasks) { const l = m.get(t.member) ?? []; l.push(t); m.set(t.member, l); }
    for (const l of m.values()) l.sort((a, b) => Number(a.x) - Number(b.x) || (a.p ?? 99) - (b.p ?? 99));
    return view.members.filter((x) => m.has(x.id)).map((x) => ({ who: x, list: m.get(x.id)! }));
  }, [view.tasks, view.members]);
  // PS 1.68 (Jan 18 Nov: "you see what the person did"): opens on All, not Done.
  const [show, setShow] = useState<"done" | "open" | "all">("all");   // PS 1.65 (gsquad-v3)
  const now = useTasksNow();
  const left = feature(P1_FEATURE) && feature(BOARD_FEATURE);
  const v3 = v3On();
  const toMe = view.hands.filter((h) => h.to === view.me && h.state === "open");
  const fromMe = view.hands.filter((h) => h.from === view.me);
  return (
    <div className="gs-tasks">
      {!shareOn(share, "tasks") && <p className="gs-note">You are not sharing any tasks. Task sharing starts off: switch Tasks on in Squad settings, What you share, then pick each task with Share with G Squad.</p>}
      {toMe.length > 0 && <>
        <span className="gs-h">Handed to you</span>
        <ul className="gs-list">{toMe.map((h) => <HandRow key={h.id} h={h} who={names.get(h.from) ?? "Someone"} op={op} />)}</ul>
      </>}
      {!view.loaded && byMember.length === 0 && <p className="gs-note">Loading...</p>}
      {view.loaded && byMember.length === 0 && <p className="gs-note">No shared tasks yet.</p>}
      {v3 && byMember.length > 0 && (
        <div className="gst-bar">
          <div className="gsb-chips" role="radiogroup" aria-label="Show">
            {([["done", "Done"], ["open", "Open"], ["all", "All"]] as const).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={show === id} className={`gsb-chip${show === id ? " on" : ""}`}
                onClick={() => { if (show !== id) { sfx.hover(); setShow(id); } }}>{label}</button>
            ))}
          </div>
        </div>
      )}
      {v3 && byMember.map(({ who, list }, i) => {
        const done = list.filter((t) => t.x), open = list.filter((t) => !t.x);
        const rows = show === "done" ? done : show === "open" ? open : [...done, ...open];
        return (
          <section key={who.id} className="gst-card" style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }} aria-label={who.me ? "You" : who.name}>
            <header className="gst-head">
              <Avatar id={who.id} name={who.name} size={36} working={who.working} />
              <span className="gst-who">{who.me ? "You" : who.name}<em>{done.length} done, {open.length} open</em></span>
              <span className="gst-n num" aria-hidden="true">{done.length}</span>
            </header>
            {rows.length === 0
              ? <p className="gst-none">{show === "done" ? "Nothing done yet." : "Nothing open."}</p>
              : <ul className="gst-list">
                {rows.map((t) => (
                  <li key={t.id} className={`gst-row${t.x ? " done" : ""}${t.a ? " anon" : ""}`}>
                    <i className="gst-tick" aria-hidden="true">{t.x && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}</i>
                    <span className="gst-t">{t.t}<span className="gs-sr"> {t.x ? "done" : "open"}</span></span>
                    {(t.e || t.p) && <span className={`gs-p${t.p === 1 ? " p1" : ""}`}>{t.e ? "Daily" : `P${t.p}`}</span>}
                    {t.d && !t.x && <span className="gs-due">{fmtDate(t.d)}</span>}
                    {left && <TimeLeft t={t} now={now} />}
                  </li>
                ))}
              </ul>}
          </section>
        );
      })}
      {!v3 && byMember.map(({ who, list }) => (
        <section key={who.id} className="gs-mem">
          <span className="gs-h">{who.me ? "You" : who.name}{who.working && <i className="gs-dot" title="Working" />}</span>
          <ul className="gs-list">
            {list.map((t) => (
              <li key={t.id} className={`gs-task${t.x ? " done" : ""}${t.a ? " anon" : ""}`}>
                <span className={`gs-p${t.p === 1 ? " p1" : ""}`}>{t.e ? "Daily" : t.p ? `P${t.p}` : ""}</span>
                <span className="gs-tt">{t.t}</span>
                {t.d && !t.x && <span className="gs-due">{fmtDate(t.d)}</span>}
                {left && <TimeLeft t={t} now={now} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {fromMe.length > 0 && <>
        <span className="gs-h">You handed over</span>
        <ul className="gs-list">
          {fromMe.map((h) => (
            <li key={h.id} className="gs-task">
              <span className="gs-tt">{h.t}</span>
              <span className="gs-st">{h.state === "open" ? `Waiting for ${names.get(h.to) ?? "them"}` : h.state === "accepted" ? `${names.get(h.to) ?? "They"} accepted` : h.state === "declined" ? `${names.get(h.to) ?? "They"} declined` : "Cancelled"}</span>
              {h.state === "open" && <button type="button" className="gs-mini" onClick={() => { sfx.click(); op({ op: "cancel", id: h.id }); }}>Cancel</button>}
            </li>
          ))}
        </ul>
      </>}
      <p className="gs-foot">Right click one of your tasks to share it with G Squad. Once shared, you can hand it to someone or hide a client's name.</p>
    </div>
  );
}
/** PS 1.68: the time left of an open Priority 1 (its 24 hours), coloured by core/squadp1board.ts leftTone. */
function TimeLeft({ t, now }: { t: SquadTask; now: number }) {
  if (t.x || t.p !== 1 || !t.s) return null;
  const s = cleanStart(t.s, now);
  if (!s) return null;
  const st = p1State({ s, x: false }, now);
  return st.kind === "open"
    ? <span className={`gs-left ${leftTone(st.left)}`} data-tip={leftWords(st.left)} data-tip-line="Time left of the 24 hours this Priority 1 task has">{leftWords(st.left)}</span>
    : <span className="gs-left bad" data-tip="Missed" data-tip-line="Its 24 hours ran out">Missed</span>;
}
function useTasksNow(every = 30_000): number {
  const [n, setN] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setN(Date.now()), every); return () => window.clearInterval(t); }, [every]);
  return n;
}
function HandRow({ h, who, op }: { h: SquadHand; who: string; op: SquadTabProps["op"] }) {
  return (
    <li className="gs-task gs-hand">
      <span className="gs-tt">{h.t}<em>From {who}{h.d ? `, ${fmtDate(h.d)}` : ""}</em></span>
      <button type="button" className="gs-mini go" onClick={() => { sfx.drop(); op({ op: "answer", id: h.id, accept: true }); }}>Accept</button>
      <button type="button" className="gs-mini" onClick={() => { sfx.click(); op({ op: "answer", id: h.id, accept: false }); }}>Decline</button>
    </li>
  );
}

// ---------- Members ----------
// V1.47: who is in and who is working (V1.49: nobody invites or approves any more, everyone is in by themselves).
// Your name, what you share and Leave live in Squad settings. The admin can take someone out.
function MembersTab({ view, op }: SquadTabProps) {
  const [sure, setSure] = useState<string | null>(null);
  const working = view.members.filter((m) => m.working).length;
  return (
    <div className="gs-members">
      {view.meName === NO_NAME && (
        // V1.49: sign up no longer asks for a name, so PS joined you as "New member". Ask once, here, in plain words.
        <div className="gss-card">
          <NameEdit label="What should the squad call you?" value="" open busy={view.busy === "Renaming"} onSave={(name) => squadOp({ op: "renameMe", name })} />
          <p className="gs-note">Everyone in {view.name || THE_SQUAD} sees this name. You can change it any time in Squad settings.</p>
        </div>
      )}
      <span className="gs-h">{view.members.length} {view.members.length === 1 ? "member" : "members"}, {working} working</span>
      <ul className="gs-list">
        {view.members.map((m) => (
          <li key={m.id} className={`gs-member${m.working ? " working" : ""}`}>
            <Avatar id={m.id} name={m.name} size={44} working={m.working} />
            <span className="gs-tt">{m.me ? `${m.name} (you)` : m.name}{m.creator && <small>Admin</small>}<em>{m.working ? `${m.me ? "You are" : `${m.name} is`} working` : "Not working right now"}</em></span>
            {view.creator && !m.me && (sure === m.id
              ? <><button type="button" className="gs-mini bad" onClick={() => { op({ op: "remove", member: m.id }); setSure(null); }}>Take out</button>
                <button type="button" className="gs-mini" onClick={() => setSure(null)}>Keep</button></>
              : <button type="button" className="gs-mini" onClick={() => setSure(m.id)}>Take out</button>)}
          </li>
        ))}
      </ul>
      <p className="gs-note">Everyone with PS is in {view.name || THE_SQUAD} by themselves. Nobody needs an invite.</p>
    </div>
  );
}

function Placeholder({ text, piece }: { text: string; piece?: SharePiece }) {
  return (
    <div className="gs-soon">
      <p className="gs-lead">{text}</p>
      {piece && <SharingList only={piece} />}
    </div>
  );
}

registerSquadTab({ id: "leaderboard", title: "Leaderboard", order: TAB_ORDER.leaderboard, placeholder: true,
  Panel: () => <Placeholder text="Coming soon: money made over the last few months, and tasks done." piece="money" /> });
registerSquadTab({ id: "tasks", title: "Tasks", order: TAB_ORDER.tasks, Panel: TasksTab, badge: (v) => v.waiting });
registerSquadTab({ id: "screen", title: "Screen time", order: TAB_ORDER.screen, placeholder: true,
  Panel: () => <Placeholder text="Coming soon: everyone's daily screen time total. Never which apps." piece="screen" /> });
registerSquadTab({ id: "members", title: "Members", order: TAB_ORDER.members, Panel: MembersTab });
// Chat: views/GSquadChat.tsx (imported above).
