// G Squad pieces (PS 1.65, feature "gsquad-pieces"): parts of G Squad as panels of their own, placed in Edit mode on any page of the Tab list
// (the developer, 17 Nov 2026: "divide the G Squad interface up into elements... it all stays in sync at the same time").
// One engine, many views: every piece reads the same plain views as the window (useSquad, useChat: no keys) and sends the same ops
// (squadOp, chatOp, boardOp), so a message sent in one piece shows in the others and in the window at once. Off the page until added
// (core/tablayout.ts optIn). The rules are in core/squadpieces.ts (tests/squadpieces.test.ts); this file only draws.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { feature } from "../core/features";
import { DONE_PERIODS, chatPieceLive, PIECES_FEATURE, boardRows, convClick, doneRows, doneShare, pieceShows, unreadTotal, workHeadline, workRows } from "../core/squadpieces";
import { fmtMoney, placeLabel, type TasksPeriod } from "../core/squadboard";
import { useChat } from "../squad/chatmirror";
import { chatPiecesShown, holdChatPiece } from "../squad/chathold";
import { useSquad } from "../squad/mirror";
import { looksClass, looksVars } from "../squad/looks";
import { signalOn } from "../squad/signal";
import type { SquadView } from "../squad/view";
import { unreadText } from "../squad/chatgroups";
import { useOverlayShown } from "../ps";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { Slot, useShownHere } from "./EditMode";
import { ChatPanel } from "./GSquadChat";
import { openGSquad } from "./GSquad";
import { useShownLooks } from "./GSquadSettings";
import { ConvRow, openConv, useConvs, v3On } from "./GSquadV3";
import { Avatar } from "./SquadAvatar";
import "./gswin.css";
import "./gswnew.css";
import "./gssignal.css";
import "./gssignal3.css";
import "./gschat.css";
import "./gsquadboard.css";
import "./squadpieces.css";

const psFs = () => { try { return parseFloat(document.documentElement.style.getPropertyValue("--k-fs")) || 1; } catch { return 1; } };

/** The frame every piece sits in: the window's own look (light or dark, colours, size) without the window, so a piece reads like a
 *  piece of the same G Squad. head: the title; opens: the window section a click on the title opens (null: no link). */
function Piece({ title, opens, v, children, cls = "", extra }: { title: string; opens: string | null; v: SquadView; children: ReactNode; cls?: string; extra?: ReactNode }) {
  const looks = useShownLooks();
  const shown = useShownHere();
  if (!shown) return null;
  const style = { ...looksVars(looks, psFs()) } as CSSProperties;
  const frame = `gsw sqpiece ${looksClass(looks)}${looks.look === "new" && signalOn() ? " sg" : ""}${v3On() && looks.look === "new" ? " v3" : ""} ${cls}`;
  return (
    <section className={frame} style={style} aria-label={title}>
      <header className="sqp-h">
        {opens
          ? <button type="button" className="sqp-t" onClick={() => { sfx.click(); openGSquad(true, opens); }} data-tip={title} data-tip-line="Open G Squad"><b>{title}</b></button>
          : <span className="sqp-t"><b>{title}</b></span>}
        {extra}
      </header>
      {v.in ? children : <p className="sqp-note">Not in the squad yet.</p>}
    </section>
  );
}

/** A piece draws only while the feature is on and the page it sits on shows. */
function useOn(): boolean {
  useVault();
  return pieceShows(feature(PIECES_FEATURE), true);
}

// ---------- Squad chat ----------
export function SqChat() {
  const v = useSquad();
  const on = useOn();
  const shown = useShownHere();
  const listShown = useOverlayShown();   // PS keeps the Tab list alive while hidden: a hidden list is not an open chat
  const live = chatPieceLive({ on, shown, inSquad: v.in, listShown });
  const conv = useConvs(v);
  useEffect(() => (live ? holdChatPiece() : undefined), [live]);
  if (!on) return null;
  // The title is the conversation on screen (the squad, a group or a person), the same one the window shows.
  const title = v3On() ? conv.cur.title || "Squad chat" : "Squad chat";
  return <Piece title={title} opens="chat" v={v} cls="sqp-chat">{live && <ChatPanel hold={false} convKey={conv.active} />}</Piece>;
}

// ---------- Conversations ----------
export function SqConvs() {
  const v = useSquad();
  const chat = useChat();
  const on = useOn();
  const conv = useConvs(v);
  if (!on || !v3On()) return null;   // the list needs the Signal style switch: off gives the old one-chat window back
  const total = unreadTotal(conv.list);
  const pick = (id: string) => {
    sfx.click(); openConv(id);
    if (convClick(chatPiecesShown()) === "switch-open") openGSquad(true, "chat");
  };
  return (
    <Piece title="Conversations" opens="chat" v={v} cls="sqp-convs" extra={total > 0 ? <i className="gsw-count num" aria-label={`${total} new`}>{unreadText(total)}</i> : null}>
      <ul className="gsw-rows sqp-list" role="tablist" aria-label="Conversations">
        {conv.list.map((c) => <ConvRow key={c.id} c={c} v={v} on={chat.open && c.id === conv.active} onPick={() => pick(c.id)} />)}
      </ul>
    </Piece>
  );
}

// ---------- Squad leaderboard (money only, last month on top) ----------
export function SqBoard() {
  const v = useSquad();
  const on = useOn();
  if (!on) return null;
  const b = v.board;
  const { rows, more, exact } = boardRows(b, 6);
  const names = new Map(v.members.map((m) => [m.id, m]));
  return (
    <Piece title={b?.rules.money === "profit" ? "Squad profit" : "Squad leaderboard"} opens="leaderboard" v={v} cls="sqp-board"
      extra={<span className="sqp-sub">Last month</span>}>
      {!b || (!b.loaded && rows.length === 0) ? <p className="sqp-note">Loading...</p>
        : rows.length === 0 ? <p className="sqp-note">Nothing here yet.</p>
        : <ol className="gsb-list gsb-money sqp-rows">
          {rows.map((r) => {
            const m = names.get(r.member);
            const me = r.member === v.me;
            return (
              <li key={r.member} className={`gsb-row ${r.state}${me ? " me" : ""}`}>
                <span className="gsb-place-n num" aria-label={r.rank ? `${placeLabel(r.rank)} place` : undefined}>{r.rank ?? ""}</span>
                <Avatar id={r.member} name={m?.name ?? "Someone"} size={30} />
                <span className="gsb-who">{me ? "You" : m?.name ?? "Someone"}</span>
                <span className="gsb-val num">{r.state === "off" ? <span className="gsb-off">Not shared</span> : r.state === "none" ? <span className="gsb-off">Not added yet</span>
                  : r.amount !== null && exact ? fmtMoney(r.amount, b.rules.currency) : <span className="gsb-off">{r.rank ? placeLabel(r.rank) : ""}</span>}</span>
              </li>
            );
          })}
        </ol>}
      {more > 0 && <button type="button" className="sqp-more" onClick={() => { sfx.click(); openGSquad(true, "leaderboard"); }}>{`${more} more`}</button>}
    </Piece>
  );
}

// ---------- Tasks done ----------
export function SqDone() {
  const v = useSquad();
  const on = useOn();
  const [period, setPeriod] = useState<TasksPeriod>("7d");
  if (!on) return null;
  const { rows, more } = doneRows(v.board, period, 6);
  const top = Math.max(0, ...rows.map((r) => r.n));
  const names = new Map(v.members.map((m) => [m.id, m]));
  const chips = (
    <span className="gsb-chips" role="group" aria-label="Tasks done over">
      {DONE_PERIODS.map((p) => <button key={p.id} type="button" className={`gsb-chip${p.id === period ? " on" : ""}`} aria-pressed={p.id === period} onClick={() => { sfx.click(); setPeriod(p.id); }}>{p.label}</button>)}
    </span>
  );
  return (
    <Piece title="Tasks done" opens="tasks" v={v} cls="sqp-done" extra={chips}>
      {!v.board ? <p className="sqp-note">Loading...</p>
        : rows.length === 0 ? <p className="sqp-note">Nothing here yet.</p>
        : <ol className="gsb-list gsb-money sqp-rows">
          {rows.map((r) => {
            const m = names.get(r.member);
            const share = doneShare(r.n, top);
            const me = r.member === v.me;
            return (
              <li key={r.member} className={`gsb-row ${r.state}${me ? " me" : ""}`}>
                <span className="gsb-place-n num">{r.rank ?? ""}</span>
                <Avatar id={r.member} name={m?.name ?? "Someone"} size={30} />
                <span className="gsb-who">{me ? "You" : m?.name ?? "Someone"}
                  {typeof share === "number" && <i className="gsb-bar" aria-hidden="true"><b style={{ transform: `scaleX(${share})` }} /></i>}</span>
                <span className="gsb-val num">{r.state === "ok" ? r.n : <span className="gsb-off">Not shared</span>}</span>
              </li>
            );
          })}
        </ol>}
      {more > 0 && <button type="button" className="sqp-more" onClick={() => { sfx.click(); openGSquad(true, "leaderboard"); }}>{`${more} more`}</button>}
    </Piece>
  );
}

// ---------- Working now ----------
export function SqNow() {
  const v = useSquad();
  const on = useOn();
  if (!on) return null;
  const { working, rest } = workRows(v.members);
  return (
    <Piece title="Working now" opens="members" v={v} cls="sqp-now" extra={<span className="sqp-sub">{`${working.length} of ${v.members.length}`}</span>}>
      {v.members.length === 0 ? <p className="sqp-note">Nobody here yet.</p>
        : working.length === 0 ? <p className="sqp-note">{workHeadline(0)}</p>
        : <ul className="sqp-people">
          {[...working, ...rest].map((m) => (
            <li key={m.id} className={m.working ? "on" : "off"}>
              <span className="sqp-av"><Avatar id={m.id} name={m.name} size={34} working={m.working} /></span>
              <span className="sqp-n">{m.me ? "You" : m.name.split(" ")[0]}</span>
            </li>
          ))}
        </ul>}
    </Piece>
  );
}

/** The originals' Slots (never drawn: core/tablayout.ts optIn). They only have to exist, so the Add panel gallery offers each piece and
 *  every copy draws the same element. Gone while the feature is off, so nothing is offered. */
export function SquadPieceSlots() {
  const on = useOn();
  if (!on) return null;
  return (
    <>
      <Slot id="sqchat"><SqChat /></Slot>
      {v3On() && <Slot id="sqconvs"><SqConvs /></Slot>}
      <Slot id="sqboard"><SqBoard /></Slot>
      <Slot id="sqdone"><SqDone /></Slot>
      <Slot id="sqnow"><SqNow /></Slot>
    </>
  );
}
