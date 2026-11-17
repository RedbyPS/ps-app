// G Squad chat (V1.40), the developer 7 Nov 2026: the Chat tab in the G Squad pop-up (PS), and on the website a chat button in
// the To-do page's top bar with the same panel. End to end encrypted: the words are opened on the page that holds
// the vault (squad/chatengine.ts) and arrive here as plain lines; this window holds no key in PS.
// Text only, smooth and simple. Your own messages: Edit and Delete (for everyone). New messages: a small badge on the
// G Squad icon; no sound unless switched on here (Mac). History votes: a pop-up with Yes and No (a PS card on the
// Mac, a pop-up on the website) and the same question at the top of this tab until answered.
import { holdChatOpen } from "../squad/chathold";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { registerSquadTab, TAB_ORDER, type SquadTabProps } from "../squad/tabs";
import { chatNow, chatOp, useChat } from "../squad/chatmirror";
import { convWords } from "../core/gsconv";
import { composeStore } from "../squad/chatopen";
import { badgeText, type ChatLine, type ChatVoteView } from "../squad/chatview";
import { clockTime, groupChat, GROUP_GAP_MS } from "../squad/chatgroups";
import { looksStore } from "../squad/looks";
import { startChat } from "../squad/chatengine";
import { signalOn } from "../squad/signal";
import { emojiOnly, emojiSize, placeIn, whoLine } from "../squad/chatreact";
import { parseGifMessage } from "../squad/chatgif";
import { useBack } from "../squad/back";
import { sfx } from "../ui/sfx";
import { toneOf } from "../squad/window";
import { Avatar } from "./SquadAvatar";
import { About, ChatComposer, sendChat, useComposer, type ReplyDraft } from "./GSquadComposer";
import { replySnippet } from "../core/squadchat";
import { EmojiPicker, GifImage, GifPicker, ReactBar } from "./GSquadPickers";
import { MsgText, v3On } from "./GSquadV3";
import { bubbleShape, nearBottom } from "../core/gsmsg";
import "./gschat.css";
import "./gssignal.css";

const PS = import.meta.env.MODE === "ps";

const when = clockTime;   // the time in a bubble: the day is on the day line above the messages

// ---------- a history vote, in the tab and in the website's pop-up ----------
export function VoteBox({ v }: { v: ChatVoteView }) {
  return (
    <div className="gc-vote" role="group" aria-label="History vote">
      <p className="gc-vote-t">{v.title}</p>
      <p className="gc-vote-s">{v.sub}</p>
      <p className="gc-vote-b">{v.body}</p>
      <div className="gc-vote-row">
        <button type="button" className={`gs-mini go${v.mine === true ? " on" : ""}`} onClick={() => { sfx.click(); chatOp({ op: "vote", id: v.id, yes: true }); }}>Yes</button>
        <button type="button" className={`gs-mini bad${v.mine === false ? " on" : ""}`} onClick={() => { sfx.click(); chatOp({ op: "vote", id: v.id, yes: false }); }}>No</button>
        {v.n > 0 && <span className="gc-vote-n">{v.k} of {v.n} answered</span>}
      </div>
    </div>
  );
}

// ---------- one message ----------
// V1.43, the messenger look: messages from one person in a row are one group; others' groups carry their picture at
// the bottom and their name (in their colour) at the top; the last bubble of a group has a small tail.
interface Extras { onReact: (id: string, e: string) => void; onMore: (id: string, el: HTMLElement) => void; onMedia: () => void }
/** PS 1.64 replies: Reply on hover and in the right click menu; a click on a quote goes to the original. */
interface Replies { onReply: (l: ChatLine) => void; onMenu: (l: ChatLine, at: { x: number; y: number }) => void; onJump: (id: string, gone: boolean) => void }
const ReplyIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9.5 6.5L4.5 11.5l5 5" /><path d="M4.8 11.5h9.2c3.2 0 5.5 2.3 5.5 5.5v1" /></svg>;
export const NOT_AVAILABLE = "Original message not available";
const CopyIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="8.5" y="8.5" width="11" height="11" rx="2.4" /><path d="M15.5 8.5V6.9a2.4 2.4 0 0 0-2.4-2.4H6.9a2.4 2.4 0 0 0-2.4 2.4v6.2a2.4 2.4 0 0 0 2.4 2.4h1.6" /></svg>;
function Line({ l, first, last, onEdit, x, rp }: { l: ChatLine; first: boolean; last: boolean; onEdit: (l: ChatLine) => void; x?: Extras; rp: Replies }) {
  const [sure, setSure] = useState(false);
  const [bar, setBar] = useState(false);          // touch: a long press opens the reaction bar
  const press = useRef<number | undefined>(undefined);
  const gif = x ? parseGifMessage(l.t) : null;
  const big = x && !gif ? emojiSize(emojiOnly(l.t)) : "";
  const live = !!x && !l.sending && !l.failed;   // a message not on the hub yet cannot be reacted to
  const v3 = v3On();                             // PS 1.65: Read more, and the hover buttons never move the message
  const canReply = !l.sending && !l.failed;      // the same for a reply: it needs the original's hub id
  useEffect(() => {
    if (!bar) return;
    const down = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.(`[data-id="${l.id}"] .gc-rbar`)) setBar(false); };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [bar, l.id]);
  useBack(bar, () => setBar(false));
  const stop = () => { if (press.current !== undefined) { window.clearTimeout(press.current); press.current = undefined; } };
  return (
    <li data-shape={bubbleShape(first, last)} className={`gc-line${l.mine ? " mine" : ""}${first ? " first" : ""}${last ? " last" : ""}${l.edited ? " edited" : ""}${l.sending ? " sending" : ""}${l.failed ? " failed" : ""}${bar ? " bar-open" : ""}${l.r?.length ? " has-r" : ""}`} data-id={l.id}>
      {!l.mine && <span className="gc-av">{last && <Avatar id={l.from} name={l.name} size={30} />}</span>}
      <div className="gc-col">
        <div className={`gc-bubble${gif ? " gif" : ""}${big ? ` emo emo-${big}` : ""}`}
          onPointerDown={(e) => {
            if (e.pointerType !== "touch" || !canReply) return;
            stop();
            const at = { x: e.clientX, y: e.clientY };
            press.current = window.setTimeout(() => { press.current = undefined; if (live) setBar(true); else rp.onMenu(l, at); }, 420);
          }}
          onPointerUp={stop} onPointerCancel={stop} onPointerMove={stop}
          onContextMenu={(e) => {
            if ((e.nativeEvent as PointerEvent).pointerType === "touch") { if (canReply) e.preventDefault(); return; }
            if (!canReply || window.getSelection()?.toString()) return;   // selected words keep the usual menu (Copy)
            e.preventDefault(); rp.onMenu(l, { x: e.clientX, y: e.clientY });
          }}>
          {live && x && <ReactBar mine={l.mine} onPick={(e) => { setBar(false); x.onReact(l.id, e); }} onMore={(el) => { setBar(false); x.onMore(l.id, el); }} onReply={() => { setBar(false); rp.onReply(l); }} />}
          {first && !l.mine && <span className={`gc-who t${toneOf(l.from || l.name)}`}>{l.name}{l.left && <em> (left)</em>}</span>}
          {l.q && (
            <button type="button" className={`gc-quote t${toneOf(l.q.from || l.q.name)}${l.q.gone ? " gone" : ""}`} onClick={() => { sfx.hover(); rp.onJump(l.q!.id, l.q!.gone); }}
              aria-label={l.q.gone ? `Reply to ${l.q.name}. ${NOT_AVAILABLE}` : `Reply to ${l.q.name}: ${l.q.s}. Go to the message`}>
              <b>{l.q.name}</b><span>{l.q.gone ? NOT_AVAILABLE : l.q.s}</span>
            </button>
          )}
          {l.a && <About a={l.a} />}
          {gif
            ? <GifImage url={gif} onLoad={x?.onMedia} />
            : v3 ? <MsgText t={l.t}><span className="gc-pad" aria-hidden="true" /></MsgText>
            : <span className="gc-text selectable">{l.t}<span className="gc-pad" aria-hidden="true" /></span>}
          <span className="gc-meta">{l.failed ? "Not sent" : l.sending ? "Sending" : `${l.edited ? "edited " : ""}${when(l.at)}`}</span>
        </div>
        {x && !!l.r?.length && (
          <span className="gc-pills" role="group" aria-label="Reactions">
            {l.r.map((p) => (
              <button key={p.e} type="button" className={`gc-pill${p.mine ? " mine" : ""}`} aria-pressed={p.mine} title={whoLine(p.who)}
                aria-label={`${p.e} ${p.n}, ${whoLine(p.who)}${p.mine ? ". Tap to take yours back" : ""}`} onClick={() => { sfx.click(); x.onReact(l.id, p.e); }}>
                <span className="gc-pill-e">{p.e}</span>{p.n > 1 && <span className="gc-pill-n num">{p.n}</span>}
              </button>
            ))}
          </span>
        )}
        {canReply && (
          <button type="button" className="gc-rp" aria-label={`Reply to ${l.mine ? "your message" : l.name}`} title="Reply" onClick={() => { sfx.click(); rp.onReply(l); }}><ReplyIcon /></button>
        )}
        {l.mine && !l.sending && (
          <span className="gc-acts">
            {l.failed
              ? <button type="button" className="gc-act" onClick={() => chatOp({ op: "retry" })}>Try again</button>
              : sure
                ? <><button type="button" className="gc-act bad" onClick={() => { sfx.click(); chatOp({ op: "del", id: l.id }); setSure(false); }}>Delete for everyone</button>
                  <button type="button" className="gc-act" onClick={() => setSure(false)}>Keep</button></>
                : <>{!gif && <button type="button" className="gc-act" onClick={() => onEdit(l)}>Edit</button>}
                  <button type="button" className="gc-act" onClick={() => setSure(true)}>Delete</button></>}
          </span>
        )}
      </div>
    </li>
  );
}
// ---------- the panel ----------
/** hold: this panel says the chat is open (default). The window holds it once itself, so a conversation switch does not close and reopen it.
 *  convKey: a panel that stays mounted across conversations (a piece) keeps its draft and quote per conversation. */
export function ChatPanel({ hold = true, convKey }: { hold?: boolean; convKey?: string } = {}) {
  const v = useChat();
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const looks = useSyncExternalStore(looksStore.subscribe, looksStore.get);
  const c = useComposer({ onSent: () => { atBottom.current = true; }, convKey });
  const { about, editing } = c;
  const sig = signalOn();
  const root = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState<{ k: "box" } | { k: "gif" } | { k: "react"; to: string; at: { left: number; top: number } } | null>(null);
  const rel = (el: HTMLElement) => {
    const b = root.current!.getBoundingClientRect(), a = el.getBoundingClientRect();
    return placeIn({ left: b.left, top: b.top, width: b.width, height: b.height }, { left: a.left, top: a.top, width: a.width, height: a.height }, { width: 300, height: 300 });
  };
  const x: Extras | undefined = sig ? {
    onReact: (id, e) => chatOp({ op: "react", to: id, e }),
    onMore: (id, el) => { if (root.current) setPick({ k: "react", to: id, at: rel(el) }); },
    onMedia: () => { const el = list.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight; },
  } : undefined;

  // ---------- PS 1.64 replies ----------
  const [menu, setMenu] = useState<{ l: ChatLine; x: number; y: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const waitJump = useRef<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const say = (t: string) => { setToast(t); window.clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(null), 2600); };
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const startReply = (l: ChatLine) => {
    setMenu(null);
    const d: ReplyDraft = { id: l.id, w: l.from, name: l.mine ? "You" : l.name, s: parseGifMessage(l.t) ? "GIF" : replySnippet(l.t) };
    c.startReply(d);
  };
  /** Glides to a message on screen and lights it up for a moment. False when it is not in the list. */
  const flash = (id: string): boolean => {
    const el = list.current?.querySelector<HTMLElement>(`.gc-line[data-id="${CSS.escape(id)}"]`);
    if (!el) return false;
    atBottom.current = false;
    const calm = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: calm ? "instant" : "smooth" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1700);
    return true;
  };
  const jumpTo = (id: string, gone: boolean) => {
    if (gone) { say(NOT_AVAILABLE); return; }
    if (flash(id)) return;
    waitJump.current = id;
    chatOp({ op: "seek", id });   // the page with the keys loads older history until it is there
  };
  // The answer to a seek: once the lines are drawn, glide there; or say it is gone.
  useLayoutEffect(() => {
    const j = v.jump;
    if (!j || j.id !== waitJump.current) return;
    waitJump.current = null;
    if (!j.ok || !flash(j.id)) say(NOT_AVAILABLE);
  }, [v.jump?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  useBack(!!menu, () => setMenu(null));
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.(".gc-menu")) setMenu(null); };
    const away = () => setMenu(null);
    document.addEventListener("pointerdown", down, true);
    list.current?.addEventListener("scroll", away, { passive: true });
    const el = list.current;
    return () => { document.removeEventListener("pointerdown", down, true); el?.removeEventListener("scroll", away); };
  }, [menu]);
  const rp: Replies = { onReply: startReply, onJump: jumpTo, onMenu: (l, at) => { sfx.hover(); setMenu({ l, x: at.x, y: at.y }); } };
  const menuAt = (() => {
    if (!menu || !root.current) return null;
    const b = root.current.getBoundingClientRect();
    return { left: Math.max(6, Math.min(menu.x - b.left, b.width - 170)), top: Math.max(6, Math.min(menu.y - b.top, b.height - 100)) };
  })();

  // Open while on screen: the page that holds the keys pulls every 5 s and marks what you see as read.
  useEffect(() => (hold ? holdChatOpen() : undefined), [hold]);   // PS 1.65: counted, so a chat piece and this window never close each other (squad/chathold.ts)
  // Stay at the newest message when it comes in, unless you scrolled up to read.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const el = list.current;
    if (!el || !atBottom.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: placed.current ? "smooth" : "instant" });   // the first time straight to the newest, then gliding
    if (v.lines.length) placed.current = true;
  }, [v.lines.length, v.lines.at(-1)?.id, v.votes.length, v.note, about, editing, c.reply]);
  // Quality pass: the list's own height changes too (the box grows to a second line, the emoji panel docks, the window is resized).
  // At the newest message, stay there, so the last message never ends up cut off at the bottom.
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => { if (atBottom.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const convKind = v.convs?.find((x) => x.id === v.activeConv)?.kind;
  const words = convWords(convKind);
  const votes = v.votes;
  // The new look also starts a new group after a pause; the classic look groups by sender and day only.
  const items = useMemo(() => groupChat(v.lines, { gapMs: looks.look === "new" ? GROUP_GAP_MS : Infinity }), [v.lines, looks.look]);
  return (
    <div className={`gc${sig ? " sig" : ""}${convKind === "dm" ? " dm" : ""}`} ref={root}>
      <div ref={list} className="gc-list" onScroll={(e) => { atBottom.current = nearBottom(e.currentTarget); }}>
        {votes.map((x) => <VoteBox key={x.id} v={x} />)}
        {v.note && <p className="gc-note">{v.note}</p>}
        {v.more && <button type="button" className="gc-older" onClick={() => { atBottom.current = false; chatOp({ op: "older" }); }}>Show older messages</button>}
        {!v.loaded && v.lines.length === 0 && <p className="gc-empty">Opening the chat...</p>}
        {v.loaded && v.lines.length === 0 && <p className="gc-empty">{words.empty}</p>}
        <ul className="gc-lines">
          {items.map((it) => it.kind === "day"
            ? <li key={it.key} className="gc-day" aria-label={it.label}><span>{it.label}</span></li>
            : <Line key={it.key} l={it.line} first={it.first} last={it.last} onEdit={c.startEdit} x={x} rp={rp} />)}
        </ul>
      </div>
      {v.seeking && <p className="gc-toast" role="status">Finding the message...</p>}
      {!v.seeking && toast && <p className="gc-toast" role="status">{toast}</p>}
      {menu && menuAt && (
        <div className="gc-menu" role="menu" aria-label="Message" style={menuAt} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" autoFocus onClick={() => { sfx.click(); startReply(menu.l); }}><ReplyIcon />Reply</button>
          {!parseGifMessage(menu.l.t) && (
            <button type="button" role="menuitem" onClick={() => { sfx.click(); void navigator.clipboard?.writeText(menu.l.t).catch(() => {}); setMenu(null); }}><CopyIcon />Copy text</button>
          )}
        </div>
      )}
      {v.error && <p className="gs-err" role="alert">{v.error}</p>}
      {pick?.k === "react" && <EmojiPicker className="over" style={{ left: pick.at.left, top: pick.at.top }} onClose={() => setPick(null)} onPick={(e) => { chatOp({ op: "react", to: pick.to, e }); setPick(null); }} />}
      {pick?.k === "box" && <EmojiPicker className="dock" onClose={() => setPick(null)} onPick={(e) => { c.insert(e); }} />}
      {pick?.k === "gif" && <GifPicker className="dock" onClose={() => setPick(null)} onPick={(url) => { sendChat(url); atBottom.current = true; setPick(null); }} />}
      <ChatComposer c={c} ready={v.ready} loaded={v.loaded} box={words.box}
        extras={sig ? { emoji: pick?.k === "box", gif: v.gif.on === true ? pick?.k === "gif" : null, onEmoji: () => setPick(pick?.k === "box" ? null : { k: "box" }), onGif: () => setPick(pick?.k === "gif" ? null : { k: "gif" }) } : undefined} />
      {PS && (
        <button type="button" role="switch" aria-checked={v.sound} className={`gc-sound${v.sound ? " on" : ""}`} onClick={() => { sfx.click(); chatOp({ op: "sound", on: !v.sound }); }}>
          <i className="gs-tog" aria-hidden="true"><b /></i>Sound for new messages
        </button>
      )}
      <p className="gc-foot">{words.foot}</p>
    </div>
  );
}

function ChatTab(_: SquadTabProps) { return <ChatPanel hold={false} />; }   // the window holds the chat open itself (GSquadWindow)
registerSquadTab({ id: "chat", title: "Chat", order: TAB_ORDER.chat, Panel: ChatTab, badge: () => chatNow().unread });

// ---------- the website: a chat button in the To-do page's top bar, and the history vote pop-up ----------
export function GSquadChatWeb() {
  useEffect(() => { startChat(null); }, []);
  const v = useChat();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const ask = useSyncExternalStore(composeStore.subscribe, composeStore.get);
  useEffect(() => { if (ask.n) setOpen(true); }, [ask.n]);
  if (!v.in) return null;
  const due = v.votes.filter((x) => x.stage);
  return (
    <span className="gs-wrap">
      <button ref={btn} type="button" className={`gs-btn${open ? " open" : ""}`} aria-haspopup="dialog" aria-expanded={open} aria-label={v.unread ? `G Squad chat, ${v.unread} new` : "G Squad chat"}
        title="G Squad chat" onClick={() => { sfx.click(); setOpen(!open); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5.5h16v10H9l-5 4z" /></svg>
        {v.unread > 0 && <b className="gc-badge num" aria-hidden="true">{badgeText(v.unread)}</b>}
      </button>
      {open && <WebPop anchor={btn} onClose={() => setOpen(false)} />}
      {!open && due.length > 0 && createPortal(
        <div className="gc-modal" role="dialog" aria-modal="true" aria-label="History vote"><div className="gc-modal-card"><VoteBox v={due[0]} /></div></div>, document.body)}
    </span>
  );
}
function WebPop({ anchor, onClose }: { anchor: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 10, right: Math.max(8, window.innerWidth - r.right - 8) });
  }, [anchor]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose(); };
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down, true);
    return () => { window.removeEventListener("keydown", key); document.removeEventListener("pointerdown", down, true); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!at) return null;
  return createPortal(
    <div ref={box} className="gs-pop gc-pop" role="dialog" aria-label="G Squad chat" style={{ top: at.top, right: at.right }}>
      <div className="gs-head">
        <span className="gs-title">G Squad chat<em>End to end encrypted</em></span>
        <button type="button" className="gs-x" onClick={onClose} aria-label="Close" title="Close (Esc)">×</button>
      </div>
      <div className="gs-body"><ChatPanel /></div>
    </div>, document.body);
}
