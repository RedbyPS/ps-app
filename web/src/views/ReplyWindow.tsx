// Reply from PS: the reply panel (ps-mac ReplyWindow.swift, page /reply-window). Like the Tab list it holds no keys
// and no vault: the Mac hands it the email being answered with the developer's quick replies, signatures and send behaviour
// (window.__psReply.open), the queue of waiting sends and whether the account can send. It sends nothing itself:
// Send and Schedule hand a finished job to the Mac (ps-mac MailSend.swift), which sends it from the right account,
// in the same thread, at the time picked. Rules and words: core/mailreply.ts.
//
// One panel in the middle of the screen (the developer, 8 Nov 2026: no separate settings menu for any of this):
//  - top left: what Send does, "Send now" or "Random between 2 and 15 minutes" (wheel or typing), remembered;
//  - middle: From, To, Subject spelled out, the email being answered (its words visible), then the Message box;
//  - bottom left: the signature, always there and editable, saved as it is typed;
//  - right: the quick replies, this client's own first (named), then the General ones (a toggle hides them); click
//    one to fill the reply; add, edit (with the clients it is for), delete and reorder them right there.
// After Send the panel becomes a pill at the bottom ("Sending in 10 s, Undo" or "Sends at 04:21 (in 9 min)", with the
// same From, To and Subject), and the pill opens the queue (Send now, Edit, Cancel). With no email (Settings, Reply
// from PS) the same panel shows the quick replies, the signature, the send behaviour and the sending accounts.
// Esc steps back one layer: a menu, a time or a reply being edited, then "Throw away this reply?" when something was
// typed, then the panel. In the queue Esc goes back to the pill.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { PS, psPost, type MailSendStatus } from "../ps";
import {
  DEFAULT_SEND, LIMITS, PLACEHOLDERS, QUICK, SCHED, SEND_RANGE, UNDO_SECONDS, cleanSendMode, clampMins, fillOf, fillPlaceholders, firstWords, inText,
  isGeneral, makeJob, parseWhen, queueOrder, randomDelayMs, reSubject, responsesFor, rowText, sendSetupHint, sendsAtText, sigFor, stepMins, stepRange,
  type MailReplyOp, type OutRow, type ReplyCtx, type ReplyJob, type SavedResponse, type SendMode,
} from "../core/mailreply";
import "./reply.css";

type Prefs = { sig: string; sigs: Record<string, string>; responses: SavedResponse[]; send?: SendMode; clients?: { id: string; name: string }[]; accounts?: string[] };
interface Open { ctx: ReplyCtx | null; prefs: Prefs; job?: ReplyJob | null; at: number }
type View = "hidden" | "compose" | "pill" | "queue";
interface St { open: Open | null; prefs: Prefs | null; status: MailSendStatus | null; queue: OutRow[]; view: View; note: string; seq: number }

// ---------- the window's store (fed by the Mac) ----------
let st: St = { open: null, prefs: null, status: null, queue: [], view: "hidden", note: "", seq: 0 };
const subs = new Set<() => void>();
const set = (p: Partial<St>) => { st = { ...st, ...p }; subs.forEach((f) => f()); };
const useSt = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => st);
const waiting = (q: OutRow[]) => q.filter((r) => r.state === "queued" || r.state === "sending");

let started = false;
export function startReplyWindow() {
  if ((!PS && !import.meta.env.DEV) || started) return;
  started = true;
  document.documentElement.classList.add("rw-page");   // a see through page: the window shows only the panel or the pill
  (window as unknown as { __psReply: unknown }).__psReply = {
    open(o: { ctx: ReplyCtx | null; prefs: Prefs; job?: ReplyJob | null }) { set({ open: { ...o, ctx: o.ctx || null, at: Date.now() }, prefs: o.prefs, view: "compose", note: "", seq: st.seq + 1 }); },
    prefs(p: Prefs) { set({ prefs: p }); },
    status(s: MailSendStatus) { set({ status: s }); },
    queue(q: OutRow[]) {
      const was = waiting(st.queue).length;
      set({ queue: Array.isArray(q) ? q.slice(0, 50) : [] });
      // Nothing waiting any more and only the pill showing: the pill says its last word, then goes.
      if (st.view === "pill" && !waiting(st.queue).length && was) window.setTimeout(() => { if (st.view === "pill" && !waiting(st.queue).length) set({ view: "hidden" }); }, 2600);
    },
    note(text: string) { set({ note: String(text || "").slice(0, 200) }); },
    show(v: View) { if (v === "queue" || v === "pill" || v === "hidden") set({ view: v }); },
  };
  psPost({ type: "reply:ready" });
}

const post = (m: object) => psPost(m);
const op = (o: MailReplyOp) => post({ type: "looks", patch: { mailReplyOp: o } });
const newId = () => (crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/[^\w-]/g, "").slice(0, 40);
const viaName = (v: string) => v === "gmail" ? "Gmail" : "Instantly";

/** A number a wheel notch changes (and a click lets you type). */
function useWheel(ref: React.RefObject<HTMLElement | null>, step: (dir: number, shift: boolean) => void, deps: unknown[]) {
  const acc = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;   // lines to pixels
      let steps = 0;
      if (Math.abs(dy) >= 40) { acc.current = 0; steps = Math.max(1, Math.min(5, Math.round(Math.abs(dy) / 100))) * (dy < 0 ? 1 : -1); }   // a mouse: each notch one step (two quick notches can come as one event)
      else {   // a trackpad: a step per short swipe
        acc.current += dy;
        while (Math.abs(acc.current) >= 40) { const d = acc.current < 0 ? 1 : -1; acc.current += d * 40; steps += d; }
      }
      for (let i = 0; i < Math.abs(steps); i++) step(Math.sign(steps), e.shiftKey);   // wheel up (away from you): more
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, deps);   // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------- the window ----------
export function ReplyWindow() {
  const s = useSt();
  const box = useRef<HTMLDivElement>(null);
  // The Mac sizes the window to what shows (centred for the panel, at the bottom for the pill and the queue).
  useLayoutEffect(() => {
    const el = box.current;
    const say = () => {
      const r = el?.getBoundingClientRect();
      post({ type: "reply:size", mode: s.view, w: Math.ceil(r?.width || 0), h: Math.ceil(r?.height || 0) });
    };
    say();
    if (!el) return;
    const ro = new ResizeObserver(say);
    ro.observe(el);
    return () => ro.disconnect();
  }, [s.view]);
  if (s.view === "hidden") return <div ref={box} />;
  if (s.view === "compose" && s.open) return <div ref={box} className="rw-shell"><Panel key={s.seq} open={s.open} prefs={s.prefs || s.open.prefs} status={s.status} queue={s.queue} /></div>;
  if (s.view === "queue") return <div ref={box} className="rw-shell rw-low"><Queue rows={s.queue} /></div>;
  return <div ref={box} className="rw-shell rw-low"><Pill rows={s.queue} note={s.note} /></div>;
}

// ---------- the panel ----------
function Panel({ open, prefs, status, queue }: { open: Open; prefs: Prefs; status: MailSendStatus | null; queue: OutRow[] }) {
  const { ctx } = open;
  const d = open.job?.draft;
  const accounts = prefs.accounts || [];
  const [sigAcct, setSigAcct] = useState<string>(ctx?.account || "");   // setup: "" is every account
  const [to, setTo] = useState(d?.ctx.to || ctx?.to || "");
  const [subject, setSubject] = useState(open.job?.subject || reSubject(ctx?.subject || ""));
  const [message, setMessage] = useState(d?.message || "");
  const [sig, setSig] = useState(d?.sig ?? sigFor({ sig: prefs.sig, sigs: prefs.sigs }, ctx?.account || ""));
  const [sigNote, setSigNote] = useState("");
  const [withQuote, setWithQuote] = useState(d?.quote ?? true);
  const [mode, setMode] = useState<SendMode>(cleanSendMode(prefs.send) || DEFAULT_SEND);
  const [sched, setSched] = useState(false);
  const [ask, setAsk] = useState(false);
  const [closing, setClosing] = useState(false);
  const [err, setErr] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  const start = useRef({ message: d?.message || "" });
  const layers = useRef<(() => boolean)[]>([]);
  const shown = useRef<SavedResponse[]>([]);      // the quick replies on the right, in order (Cmd+1 to Cmd+9)   // sheets open inside (a reply being edited, a typed time): Esc asks them first
  const fill = useMemo(() => fillOf({ first: ctx?.first || "", name: ctx?.name || "", company: ctx?.company || "", to }), [ctx, to]);

  const conn = ctx?.via === "gmail" ? status?.gmail.find((g) => g.account.toLowerCase() === ctx.account) : null;
  const ready = !ctx ? false : ctx.via === "gmail" ? !!conn?.connected : !!status?.instantly.saved;
  const problem = !ctx ? "" : ctx.via === "gmail" ? conn?.problem : status?.instantly.problem;
  const dirty = !!ctx && message.trim() !== start.current.message.trim();
  const setupHint = ctx ? sendSetupHint(ctx.via, ready, !!status, problem) : "";

  useEffect(() => { const t = window.setTimeout(() => area.current?.focus(), 60); return () => clearTimeout(t); }, []);

  // The signature saves as it is typed (a moment after the last key), for this account.
  const sigSaved = useRef(sig);   // what is saved now: only a real change is written
  useEffect(() => {
    if (sig === sigSaved.current) return;
    const t = window.setTimeout(() => {
      sigSaved.current = sig;
      op(sigAcct ? { op: "sig", account: sigAcct, text: sig } : { op: "sig", account: null, text: sig });
      setSigNote(sigAcct ? `Saved for ${sigAcct}` : "Saved for every account");
    }, 700);
    return () => clearTimeout(t);
  }, [sig]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Setup: another account picked, its own signature shows.
  const pickSigAcct = (a: string) => { const v = a ? sigFor({ sig: prefs.sig, sigs: prefs.sigs }, a) : prefs.sig; setSigAcct(a); sigSaved.current = v; setSig(v); setSigNote(""); };
  // The send behaviour is remembered (a moment after the last change).
  const modeSaved = useRef(JSON.stringify(mode));
  useEffect(() => {
    if (JSON.stringify(mode) === modeSaved.current) return;
    const t = window.setTimeout(() => { modeSaved.current = JSON.stringify(mode); op({ op: "send", mode }); }, 500);
    return () => clearTimeout(t);
  }, [mode]);

  const close = () => { setClosing(true); window.setTimeout(() => { set({ view: waiting(st.queue).length ? "pill" : "hidden" }); post({ type: "reply:close" }); }, 170); };
  const tryClose = () => { if (dirty) setAsk(true); else close(); };

  // Esc: one layer at a time (core/escape.ts rules; this window answers its own Esc, ps-mac EscRules .own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        e.preventDefault(); e.stopPropagation();
        if (ask) setAsk(false);
        else if (sched) setSched(false);
        else if (layers.current.some((f) => f())) { /* a sheet inside closed */ }
        else tryClose();
        return;
      }
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key === "Enter" && !ask && ctx) { e.preventDefault(); send(null); return; }
      if (cmd && /^[1-9]$/.test(e.key) && ctx && shown.current[Number(e.key) - 1]) { e.preventDefault(); pick(shown.current[Number(e.key) - 1]); return; }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  function pick(r: SavedResponse) {
    if (!ctx) return;
    const text = fillPlaceholders(r.text, fill);
    const el = area.current;
    if (!message.trim() || !el) setMessage(text);
    else {   // something typed already: the reply goes in where the cursor is
      const a = el.selectionStart ?? message.length, b = el.selectionEnd ?? a;
      setMessage(message.slice(0, a) + text + message.slice(b));
    }
    window.setTimeout(() => area.current?.focus(), 30);
  }
  function insert(ph: string) {
    const el = area.current, a = el?.selectionStart ?? message.length, b = el?.selectionEnd ?? a;
    const v = fillPlaceholders(ph, fill);
    setMessage(message.slice(0, a) + v + message.slice(b));
    window.setTimeout(() => { el?.focus(); el?.setSelectionRange(a + v.length, a + v.length); }, 20);
  }
  /** mins null: Send, as the send behaviour says (now with Undo, or a random time in the range). A number: the
   *  schedule picker's own time for this one email. */
  function send(mins: number | null) {
    if (!ctx) return;
    if (!ready) { setErr(ctx.via === "gmail" ? "Connect this Gmail account for sending first (the button on the From line)." : "Add your Instantly API key first (the button on the From line)."); return; }
    const now = Date.now();
    const random = mins === null && mode.random;
    const at = mins !== null ? now + clampMins(mins) * 60_000 : random ? now + randomDelayMs(mode) : now + UNDO_SECONDS * 1000;
    try {
      const job = makeJob(ctx, { message: fillPlaceholders(message, fill), sig, quote: withQuote, to, subject }, at, now, open.job?.id || newId());
      post({ type: "reply:queue", job, undo: mins === null && !random });
      setClosing(true);
      window.setTimeout(() => set({ view: "pill", note: mins !== null || random ? `Scheduled. ${sendsAtText(job.sendAt)} (${inText(Math.max(1, Math.round((job.sendAt - now) / 60_000)))})` : "" }), 160);
    } catch (e) { setErr((e as Error).message); }
  }
  const waitingN = waiting(queue).length;
  const subjectChanged = !!ctx && subject.trim() !== reSubject(ctx.subject);

  return (
    <div className={`rw-card rw-wide${closing ? " rw-out" : ""}`} role="dialog" aria-label={ctx ? "Reply" : "Replies"}>
      <div className="rw-top">
        <SendBehaviour mode={mode} set={setMode} />
        <h2 className="rw-title">{ctx ? `Reply to ${ctx.first || ctx.to}` : "Replies"}</h2>
        <div className="rw-top-acts">
          {waitingN > 0 && <button className="rw-btn" onClick={() => set({ view: "queue" })} data-tip="Scheduled replies" data-tip-line="See who each waiting reply goes to. Send now, edit or cancel.">Scheduled {waitingN}</button>}
          <button className="rw-x" aria-label="Close" onClick={tryClose} data-tip="Close" data-tip-line="Esc closes too. PS asks first if you typed something.">×</button>
        </div>
      </div>

      <div className="rw-cols">
        <div className="rw-main">
          {ctx ? <>
            <div className="rw-fields">
              <div className="rw-row"><span className="rw-k">From</span>
                <span className="rw-v"><b>{ctx.via === "gmail" && ctx.replyFrom ? ctx.replyFrom : ctx.account}</b><span className={`rw-via rw-${ctx.via}`}>{viaName(ctx.via)}</span>
                  {ctx.via === "gmail" && ctx.replyFrom && <span className="rw-via" data-tip="Sent from the address the email came to" data-tip-line={`This Gmail alias is set up in ${ctx.account}. If Gmail will not send from it, PS stops and tells you, it never switches address.`}>{`through ${ctx.account}`}</span>}</span>
                {ready ? <span className="rw-ok">Ready to send</span>
                  : <button className="rw-btn rw-connect" onClick={() => post({ type: "reply:connect", via: ctx.via, account: ctx.account })}
                      data-tip={ctx.via === "gmail" ? "Connect Gmail for sending" : "Add your Instantly API key"}
                      data-tip-line={ctx.via === "gmail" ? "Opens Google's own sign in in your browser. PS app keeps the sign in in this Mac's Keychain." : "PS app asks for it in a Mac window and keeps it in this Mac's Keychain."}>
                      {ctx.via === "gmail" ? "Connect Gmail for sending" : "Add Instantly key"}</button>}
              </div>
              {problem && <div className="rw-problem">{problem}</div>}
              {setupHint && <div className="rw-hint rw-hint-row rw-setup" role="note">{setupHint}</div>}
              <label className="rw-row"><span className="rw-k">To</span>
                {ctx.toName && to === ctx.to && <span className="rw-name">{ctx.toName}</span>}
                <input className="rw-in" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} aria-label="To" /></label>
              <label className="rw-row"><span className="rw-k">Subject</span><input className="rw-in" value={subject} maxLength={LIMITS.subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" /></label>
              {subjectChanged && <div className="rw-hint rw-hint-row">{ctx.via === "gmail"
                ? "A new subject still goes in the same Gmail thread (PS app sends it as a reply to their email). Some mail apps may show it apart."
                : "Instantly sends it as the reply to their email with your subject. Their mail app may show it apart."}</div>}
            </div>
            <div className="rw-theirs selectable" aria-label="The email you are answering">
              <div className="rw-theirs-who">{ctx.quote.who}{ctx.quote.at ? `, ${new Date(ctx.quote.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}` : ""}</div>
              <div className="rw-theirs-t">{ctx.quote.text || "PS has no words of this email."}</div>
              <label className="rw-check" data-tip="Quote it" data-tip-line="Puts their email under your reply, the way Gmail does."><input type="checkbox" checked={withQuote} onChange={(e) => setWithQuote(e.target.checked)} />Include it under your reply</label>
            </div>
            <div className="rw-k rw-k-block">Message</div>
            <textarea ref={area} className="rw-msg" value={message} maxLength={LIMITS.message} placeholder={`Hi ${ctx.first || "there"},`} aria-label="Message" onChange={(e) => { setMessage(e.target.value); setErr(""); }} />
            <div className="rw-ph">
              {PLACEHOLDERS.map((p) => <button key={p} className="rw-chip" onClick={() => insert(p)} data-tip={`Put in ${p}`} data-tip-line={`Fills in "${fillPlaceholders(p, fill) || "nothing"}" from this email.`}>{p}</button>)}
            </div>
          </> : <Accounts status={status} accounts={accounts} />}

          {err && <div className="rw-err" role="alert">{err}</div>}

          <div className="rw-foot">
            <div className="rw-sigbox">
              <div className="rw-sig-h"><span className="rw-k">Signature</span>
                {!ctx && <select className="rw-sel" value={sigAcct} aria-label="Which account's signature" onChange={(e) => pickSigAcct(e.target.value)}>
                  <option value="">Every account</option>{accounts.map((a) => <option key={a} value={a}>{a}</option>)}</select>}
                <span className="rw-ok">{sigNote}</span></div>
              <textarea className="rw-sig-in" value={sig} maxLength={LIMITS.sig} rows={Math.min(5, Math.max(2, sig.split("\n").length))} placeholder="Your name, your title, your website"
                aria-label="Signature" onChange={(e) => setSig(e.target.value)} data-tip="Your signature" data-tip-line="Goes under every reply from this account. Saved as you type." />
            </div>
            {ctx && <div className="rw-send-wrap">
              {sched && <Schedule go={(m) => { setSched(false); send(m); }} layers={layers} />}
              <span className="rw-send-says">{mode.random ? `Sends at a random time in ${mode.min} to ${mode.max} min` : `Sends now, ${UNDO_SECONDS} s to undo`}</span>
              <button className="rw-btn" aria-expanded={sched} onClick={() => setSched(!sched)} data-tip="Pick a time" data-tip-line="For this email only: in 3, 5, 10, 15 or 30 minutes, or any time with the wheel.">Pick a time</button>
              <button className="rw-send" onClick={() => send(null)} data-tip="Send" data-tip-line={mode.random ? `Goes at a random time ${mode.min} to ${mode.max} minutes from now. Cmd+Enter too.` : `Goes in ${UNDO_SECONDS} seconds, with an Undo until then. Cmd+Enter too.`}>Send</button>
            </div>}
          </div>
        </div>

        <QuickReplies list={prefs.responses || []} ctx={ctx} clients={prefs.clients || []} pick={pick} layers={layers} shown={shown} />
      </div>

      {ask && <div className="rw-ask" role="alertdialog" aria-label="Throw away this reply?">
        <div className="rw-sure-card"><b>Throw away this reply?</b><span>What you typed is not saved anywhere.</span>
          <div className="rw-sure-acts"><button className="rw-btn" autoFocus onClick={() => setAsk(false)} data-tip="Keep writing" data-tip-line="Back to your reply, nothing lost.">Keep writing</button>
            <button className="rw-danger" onClick={close} data-tip="Throw away" data-tip-line="Closes the reply. Nothing is sent.">Throw away</button></div></div>
      </div>}
    </div>
  );
}

/** Top left: what Send does. Send now, or a random time between min and max minutes (wheel or typing on each). */
type ModeSet = (f: (m: SendMode) => SendMode) => void;
function SendBehaviour({ mode, set: update }: { mode: SendMode; set: ModeSet }) {
  const setMode = (m: SendMode) => update(() => m);
  return (
    <div className="rw-mode" role="group" aria-label="When Send sends">
      <div className="rw-seg" role="radiogroup" aria-label="Send behaviour">
        <button role="radio" aria-checked={!mode.random} className={!mode.random ? "on" : ""} onClick={() => setMode({ ...mode, random: false })}
          data-tip="Send now" data-tip-line={`Send goes at once, with ${UNDO_SECONDS} seconds to undo.`}>Send now</button>
        <button role="radio" aria-checked={mode.random} className={mode.random ? "on" : ""} onClick={() => setMode({ ...mode, random: true })}
          data-tip="Random time" data-tip-line="Send waits a random number of minutes in your range, so replies do not look automatic.">Random</button>
      </div>
      {mode.random && <span className="rw-range">between <RangeNum v={mode.min} end="min" update={update} /> and <RangeNum v={mode.max} end="max" update={update} /> min</span>}
    </div>
  );
}
function RangeNum({ v, end, update }: { v: number; end: "min" | "max"; update: ModeSet }) {
  const ref = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState<string | null>(null);
  useWheel(ref, (dir) => update((m) => stepRange(m, end, dir)), [end]);
  const commit = () => {
    if (typed === null) return;
    const n = Number(typed.trim());
    if (Number.isFinite(n) && typed.trim()) {
      const x = Math.max(SEND_RANGE.min, Math.min(SEND_RANGE.max, Math.round(n)));
      update((m) => end === "min" ? { ...m, min: x, max: Math.max(m.max, x) } : { ...m, max: x, min: Math.min(m.min, x) });
    }
    setTyped(null);
  };
  return <input ref={ref} className="rw-num" inputMode="numeric" value={typed ?? String(v)} aria-label={end === "min" ? "Fewest minutes" : "Most minutes"}
    onChange={(e) => setTyped(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); (e.target as HTMLInputElement).blur(); } }}
    data-tip={end === "min" ? "Fewest minutes" : "Most minutes"} data-tip-line={`Scroll the wheel on it, or type. ${SEND_RANGE.min} to ${SEND_RANGE.max} minutes.`} />;
}

/** No email (Settings, Reply from PS): which accounts can send, with Connect and Disconnect. */
function Accounts({ status, accounts }: { status: MailSendStatus | null; accounts: string[] }) {
  const list = [...new Set([...accounts, ...(status?.gmail || []).map((g) => g.account.toLowerCase())])].sort();
  return (
    <div className="rw-accts">
      <div className="rw-k rw-k-block">Sending accounts</div>
      <span className="rw-hint">PS app sends only when you press Send, or at the time it shows. Never by itself.</span>
      {list.map((a) => {
        const g = status?.gmail.find((x) => x.account.toLowerCase() === a);
        return <div key={a} className="rw-acct"><b>{a}</b><span className="rw-via rw-gmail">Gmail</span><span className={g?.connected ? "rw-ok" : "rw-hint"}>{g?.connected ? "Can send" : "Not connected"}</span>
          {g?.problem && <span className="rw-bad">{g.problem}</span>}
          {g?.connected
            ? <button className="rw-link" onClick={() => post({ type: "reply:forget", via: "gmail", account: a })} data-tip="Disconnect" data-tip-line="PS forgets this account's sign in on this Mac.">Disconnect</button>
            : <button className="rw-link" onClick={() => post({ type: "reply:connect", via: "gmail", account: a })} data-tip="Connect for sending" data-tip-line="Opens Google's sign in in your browser.">Connect</button>}
        </div>;
      })}
      {list.length === 0 && <span className="rw-hint">No Gmail account has sent PS app an email yet.</span>}
      <div className="rw-acct"><b>Instantly</b><span className="rw-via rw-instantly">Instantly</span><span className={status?.instantly.saved ? "rw-ok" : "rw-hint"}>{status?.instantly.saved ? "Key saved in this Mac's Keychain" : "No key yet"}</span>
        {status?.instantly.problem && <span className="rw-bad">{status.instantly.problem}</span>}
        {status?.instantly.saved
          ? <button className="rw-link" onClick={() => post({ type: "reply:forget", via: "instantly" })} data-tip="Remove the key" data-tip-line="PS deletes it from this Mac's Keychain.">Remove key</button>
          : <button className="rw-link" onClick={() => post({ type: "reply:connect", via: "instantly" })} data-tip="Add your Instantly API key" data-tip-line="A Mac window asks for it. PS never shows it again.">Add key</button>}
      </div>
    </div>
  );
}

// ---------- quick replies (right side) ----------
type Edit = { id: string | null; name: string; text: string; general: boolean; clients: string[] };
function QuickReplies({ list, ctx, clients, pick, layers, shown }: { list: SavedResponse[]; ctx: ReplyCtx | null; clients: { id: string; name: string }[]; pick: (r: SavedResponse) => void;
  layers: React.MutableRefObject<(() => boolean)[]>; shown: React.MutableRefObject<SavedResponse[]> }) {
  const [showGeneral, setShowGeneral] = useState(true);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [find, setFind] = useState("");
  const names = useMemo(() => Object.fromEntries(clients.map((c) => [c.id, c.name])), [clients]);
  // With an email: this sender's clients first, then General. With none (setup): every client that has its own, then General.
  const ids = ctx ? ctx.clientIds : [...new Set(list.flatMap((r) => r.clients || []))].sort((a, b) => (names[a] || "").localeCompare(names[b] || ""));
  const groups = responsesFor(list, ids, names, showGeneral);
  const flat = groups.flatMap((g) => g.items);
  shown.current = flat;
  // Esc closes an edit first (asked by the panel before it closes itself).
  const editRef = useRef(edit); editRef.current = edit;
  useEffect(() => {
    const f = () => { if (!editRef.current) return false; setEdit(null); return true; };
    layers.current.push(f);
    return () => { layers.current = layers.current.filter((x) => x !== f); };
  }, [layers]);
  const move = (r: SavedResponse, group: SavedResponse[], dir: number) => {
    const i = group.indexOf(r), other = group[i + dir];
    if (!other) return;
    const order = list.map((x) => x.id), a = order.indexOf(r.id), b = order.indexOf(other.id);
    [order[a], order[b]] = [order[b], order[a]];
    op({ op: "orderResp", ids: order });
  };
  const save = () => {
    if (!edit || (!edit.name.trim() && !edit.text.trim()) || (!edit.general && !edit.clients.length)) return;
    const cl = edit.general ? [] : edit.clients;
    if (edit.id) op({ op: "editResp", id: edit.id, name: edit.name, text: edit.text, clients: cl });
    else op({ op: "addResp", id: newId(), name: edit.name || firstWords(edit.text), text: edit.text, clients: cl });
    setEdit(null);
  };
  const shownClients = clients.filter((c) => !find.trim() || c.name.toLowerCase().includes(find.trim().toLowerCase()));

  if (edit) return (
    <aside className="rw-side" aria-label={edit.id ? "Edit quick reply" : "New quick reply"}>
      <div className="rw-side-h"><b>{edit.id ? "Edit quick reply" : "New quick reply"}</b></div>
      <input className="rw-in rw-in-box" placeholder="Name, for example On it" value={edit.name} maxLength={LIMITS.respName} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus aria-label="Name" />
      <textarea className="rw-msg rw-msg-small" value={edit.text} maxLength={LIMITS.respText} placeholder="Hi {first name}, perfect, I'm on it..." aria-label="Words" onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
      <span className="rw-hint">{"{first name}, {name} and {company} fill in from each email."}</span>
      <div className="rw-k rw-k-block">For</div>
      <label className="rw-check"><input type="checkbox" checked={edit.general} onChange={(e) => setEdit({ ...edit, general: e.target.checked })} />General (every client)</label>
      {!edit.general && <>
        {clients.length > 8 && <input className="rw-in rw-in-box" placeholder="Find a client" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a client" />}
        <div className="rw-ticks">
          {shownClients.map((c) => <label key={c.id} className="rw-check"><input type="checkbox" checked={edit.clients.includes(c.id)}
            onChange={(e) => setEdit({ ...edit, clients: e.target.checked ? [...edit.clients, c.id] : edit.clients.filter((x) => x !== c.id) })} />{c.name}</label>)}
          {clients.length === 0 && <span className="rw-hint">No clients in your vault yet.</span>}
        </div>
        {!edit.clients.length && <span className="rw-hint">Tick at least one client, or General.</span>}
      </>}
      <div className="rw-manage-acts">
        <button className="rw-btn" onClick={() => setEdit(null)} data-tip="Cancel" data-tip-line="Leaves it as it was.">Cancel</button>
        <button className="rw-send" disabled={!edit.general && !edit.clients.length} onClick={save} data-tip="Save" data-tip-line="Shows in this list from now on.">Save</button>
      </div>
    </aside>
  );

  return (
    <aside className="rw-side" aria-label="Quick replies">
      <div className="rw-side-h"><b>Quick replies</b>
        <label className="rw-check rw-small" data-tip="Show general replies" data-tip-line="The ones for every client, under this client's own."><input type="checkbox" checked={showGeneral} onChange={(e) => setShowGeneral(e.target.checked)} />Show general replies</label></div>
      <div className="rw-side-list">
        {groups.map((g) => (
          <div key={g.clientId || "general"} className="rw-group">
            <div className="rw-group-h">{g.label}</div>
            {g.items.length === 0 && <span className="rw-hint">None yet.</span>}
            {g.items.map((r, i) => (
              <div key={r.id} className="rw-qr">
                <button className="rw-qr-pick" disabled={!ctx} onClick={() => pick(r)} data-tip={r.name} data-tip-line={ctx ? "Fills the reply with it, the name and company filled in." : "Open an email's Reply to use it."}>
                  <b>{r.name}</b><span>{(ctx ? fillPlaceholders(r.text, fillOf({ first: ctx.first, name: ctx.name, company: ctx.company, to: ctx.to })) : r.text).replace(/\s+/g, " ").slice(0, 110)}</span>
                  {ctx && flat.indexOf(r) < 9 && <kbd className="rw-kbd">Cmd {flat.indexOf(r) + 1}</kbd>}
                </button>
                <div className="rw-qr-acts">
                  <button className="rw-icon" aria-label="Move up" disabled={i === 0} onClick={() => move(r, g.items, -1)} data-tip="Move up">↑</button>
                  <button className="rw-icon" aria-label="Move down" disabled={i === g.items.length - 1} onClick={() => move(r, g.items, 1)} data-tip="Move down">↓</button>
                  <button className="rw-link" onClick={() => setEdit({ id: r.id, name: r.name, text: r.text, general: isGeneral(r), clients: r.clients || [] })} data-tip="Edit" data-tip-line="Its name, its words and which clients it is for.">Edit</button>
                  <button className="rw-link rw-del" onClick={() => op({ op: "delResp", id: r.id })} data-tip="Delete" data-tip-line="Removes this quick reply.">Delete</button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <button className="rw-btn rw-new" disabled={list.length >= LIMITS.responses} onClick={() => setEdit({ id: null, name: "", text: "", general: true, clients: [] })} data-tip="New quick reply" data-tip-line="General by default. Untick General to keep it for some clients.">New quick reply</button>
    </aside>
  );
}

/** "Pick a time", for one email: quick choices, and a time set by scrolling the wheel on it (a minute a notch,
 *  Shift 5) or by typing. Overrides the send behaviour for this one email. */
function Schedule({ go, layers }: { go: (mins: number) => void; layers: React.MutableRefObject<(() => boolean)[]> }) {
  const [mins, setMins] = useState<number>(SCHED.start);
  const [typing, setTyping] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const wheel = useRef<HTMLButtonElement>(null);
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  useWheel(wheel, (dir, shift) => setMins((m) => stepMins(m, dir, shift)), [typing]);
  // Esc stops a typed time first.
  const typingRef = useRef(typing); typingRef.current = typing;
  useEffect(() => {
    const f = () => { if (typingRef.current === null) return false; setTyping(null); return true; };
    layers.current.unshift(f);
    return () => { layers.current = layers.current.filter((x) => x !== f); };
  }, [layers]);
  const typed = typing !== null ? parseWhen(typing, now) : null;
  return (
    <div className="rw-sched" role="dialog" aria-label="Pick a time">
      <div className="rw-quick">
        {QUICK.map((q) => <button key={q} className="rw-chip" onClick={() => go(q)} data-tip={`In ${q} minutes`} data-tip-line={sendsAtText(now + q * 60_000, now)}>{q} min</button>)}
      </div>
      <div className="rw-when">
        {typing === null
          ? <button ref={wheel} className="rw-wheel" onClick={() => setTyping("")} aria-label={`Send ${inText(mins)}`}
              data-tip="Scroll to change the time" data-tip-line="Wheel up for later, down for sooner. Shift moves 5 minutes. Click to type a time.">
              <span className="rw-wheel-n">{inText(mins)}</span><span className="rw-wheel-at">{sendsAtText(now + mins * 60_000, now)}</span></button>
          : <input className="rw-in rw-in-box" autoFocus placeholder="7, 1h 30 or 04:17" value={typing} onChange={(e) => setTyping(e.target.value)} aria-label="Time"
              onKeyDown={(e) => { if (e.key === "Enter" && typed) { e.preventDefault(); setMins(typed); setTyping(null); } }} />}
        {typing !== null && <span className="rw-hint">{typed ? `${inText(typed)}, ${sendsAtText(now + typed * 60_000, now)}` : "Minutes, hours, or a time like 04:17"}</span>}
      </div>
      <button className="rw-send" disabled={typing !== null && !typed} onClick={() => go(typing !== null && typed ? typed : mins)} data-tip="Schedule send" data-tip-line="PS sends it at that time, even after a short sleep.">Schedule send</button>
    </div>
  );
}

// ---------- the pill and the queue: always From, To and Subject, so there is never doubt where it goes ----------
function useTick(on: boolean) {
  const [, setT] = useState(0);
  useEffect(() => { if (!on) return; const t = window.setInterval(() => setT((x) => x + 1), 500); return () => clearInterval(t); }, [on]);
}
function Where({ r }: { r: OutRow }) {
  return (
    <div className="rw-where">
      <span><i>From</i> {r.account} <span className={`rw-via rw-${r.via}`}>{viaName(r.via)}</span></span>
      <span><i>To</i> {r.toName ? `${r.toName} <${r.to}>` : r.to}</span>
      <span><i>Subject</i> {r.subject}</span>
    </div>
  );
}

function Pill({ rows, note }: { rows: OutRow[]; note: string }) {
  const w = queueOrder(waiting(rows));
  useTick(w.length > 0);
  const now = Date.now();
  const undo = w.find((r) => r.undo && r.state === "queued");
  const last = queueOrder(rows).filter((r) => r.state === "sent" || r.state === "failed").sort((a, b) => b.sendAt - a.sendAt)[0];
  let text = note, act: { label: string; tip: string; run: () => void } | null = null, row: OutRow | null = null;
  if (undo) {
    row = undo;
    text = `Sending in ${Math.max(0, Math.ceil((undo.sendAt - now) / 1000))} s`;
    act = { label: "Undo", tip: "Stops it and opens the reply again.", run: () => post({ type: "reply:undo", id: undo.id }) };
  } else if (w[0]?.state === "sending") { row = w[0]; text = "Sending now"; }
  else if (w.length) {
    row = w[0];
    text = w.length === 1 ? rowText(w[0], now) : `${w.length} replies waiting. Next: ${rowText(w[0], now)}`;
    act = { label: "Open", tip: "Send now, edit or cancel.", run: () => set({ view: "queue" }) };
  } else if (last) {
    row = last;
    text = last.state === "sent" ? "Sent" : rowText(last, now);
    act = last.state === "failed" ? { label: "Open", tip: "Try again or cancel.", run: () => set({ view: "queue" }) } : null;
  }
  const total = undo ? UNDO_SECONDS * 1000 : 0;
  return (
    <div className="rw-pill" role="status">
      {undo && <span className="rw-pill-bar" style={{ transform: `scaleX(${Math.max(0, Math.min(1, (undo.sendAt - now) / total))})` }} />}
      <div className="rw-pill-top">
        <span className="rw-pill-t">{text || "Nothing waiting"}</span>
        {act && <button className="rw-pill-btn" onClick={act.run} data-tip={act.label} data-tip-line={act.tip}>{act.label}</button>}
        <button className="rw-x rw-x-small" aria-label="Hide" onClick={() => set({ view: "hidden" })} data-tip="Hide" data-tip-line="Waiting replies still send. Settings, Reply from PS shows them.">×</button>
      </div>
      {row && <Where r={row} />}
    </div>
  );
}

function Queue({ rows }: { rows: OutRow[] }) {
  const list = queueOrder(rows).filter((r) => r.state !== "cancelled").slice(0, 12);
  useTick(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); set({ view: waiting(st.queue).length ? "pill" : "hidden" }); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  const now = Date.now();
  return (
    <div className="rw-queue" role="dialog" aria-label="Scheduled replies">
      <div className="rw-queue-h"><b>Scheduled replies</b>
        <button className="rw-x rw-x-small" aria-label="Close" onClick={() => set({ view: waiting(st.queue).length ? "pill" : "hidden" })} data-tip="Close" data-tip-line="Esc closes too. Waiting replies still send.">×</button></div>
      {list.length === 0 && <div className="rw-empty">Nothing waiting.</div>}
      {list.map((r) => (
        <div key={r.id} className={`rw-q rw-q-${r.state}`}>
          <span className="rw-q-when">{rowText(r, now)}</span>
          <Where r={r} />
          {(r.state === "queued" || r.state === "failed") && <div className="rw-q-acts">
            <button className="rw-link" onClick={() => post({ type: "reply:sendNow", id: r.id })} data-tip="Send now" data-tip-line="Sends it straight away.">Send now</button>
            <button className="rw-link" onClick={() => post({ type: "reply:edit", id: r.id })} data-tip="Edit" data-tip-line="Takes it off the schedule and opens it again.">Edit</button>
            <button className="rw-link rw-del" onClick={() => post({ type: "reply:cancel", id: r.id })} data-tip="Cancel" data-tip-line="It never sends.">Cancel</button>
          </div>}
        </div>
      ))}
    </div>
  );
}
