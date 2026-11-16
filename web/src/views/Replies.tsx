// Client replies from the developer's Gmail accounts: the Today card, the client page section,
// the "match these addresses" field and the Gmail section in Settings.
// Read only: the vault opens Gmail threads in Gmail and never sends anything.
import { useEffect, useMemo, useState } from "react";
import type { ClientRec, Doc, Reply } from "../core/model";
import { accountLabel, cleanMatchList, gmailThreadLink, replierName } from "../core/mail";
import { openReplies, replies } from "../core/select";
import { setReplyHandled, updateClient } from "../core/actions";
import { sb } from "../core/vault";
import { gmailView, seenAccounts } from "../core/gmailtruth";
import { Field, Icon, toast, useVault } from "../ui/kit";
import { relTime } from "./Todo";
import "./replies.css";
import { MailPeople } from "./MailPeople";

function handle(r: Doc<Reply>, who: string) {
  void setReplyHandled(r.id, true).then(() =>
    toast(`Handled: ${who}`, { label: "Undo", run: () => { void setReplyHandled(r.id, false); } }));
}

export function ReplyRow({ r, client, showClient }: { r: Doc<Reply>; client?: Doc<ClientRec>; showClient?: boolean }) {
  const d = r.data;
  const who = replierName(client?.data, d);
  const link = gmailThreadLink(d.account, d.threadId);
  return (
    <li className={"rp-item" + (d.handled ? " done" : "")}>
      <span className="rp-av" aria-hidden="true">{who.charAt(0).toUpperCase()}</span>
      <div className="rp-body">
        <div className="rp-head">
          <b className="rp-who">{who} replied</b>
          {showClient && client && <a className="rp-client trunc" href={`#/client/${client.id}`}>{client.data.name}</a>}
        </div>
        <div className="rp-meta xs">
          <span title={new Date(d.date).toLocaleString()}>{relTime(d.date)}</span>
          <span>to {accountLabel(d.account)}</span>
          {d.count > 1 && <span>{d.count} messages</span>}
          {d.handled && <span className="rp-handled">{d.handledHow === "replied" ? "You answered in Gmail" : "Marked handled"}{d.handledAt ? `, ${relTime(d.handledAt)}` : ""}</span>}
        </div>
        <p className="rp-subj">{d.subject}</p>
        {d.snippet && <p className="rp-snip">{d.snippet}</p>}
        <div className="rp-actions">
          <a className="btn ghost sm" href={link} target="_blank" rel="noopener noreferrer"><Icon name="emails" size={15} /> Open in Gmail</a>
          {d.handled
            ? <button className="btn quiet sm" onClick={() => void setReplyHandled(r.id, false)}>Not handled yet</button>
            : <button className="btn quiet sm" onClick={() => handle(r, `${who}, ${d.subject}`)}><Icon name="check" size={15} /> Mark handled</button>}
        </div>
      </div>
    </li>
  );
}

const clientMap = (s: ReturnType<typeof useVault>) => {
  const m = new Map<string, Doc<ClientRec>>();
  for (const d of s.docs.values()) if (d.kind === "client") m.set(d.id, d as Doc<ClientRec>);
  return m;
};

/** Top of Today: every client reply nobody has dealt with yet. Hidden when there are none. */
export function RepliesCard() {
  const s = useVault();
  const [all, setAll] = useState(false);
  const open = openReplies(s);
  if (!open.length) return null;
  const cm = clientMap(s);
  const shown = all ? open : open.slice(0, 5);
  return (
    <section className="panel stack rp-card" aria-labelledby="rp-h">
      <div className="tv-card-h">
        <h2 className="h2" id="rp-h">Client replies</h2>
        <span className="pill plain num">{open.length} waiting</span>
      </div>
      <ul className="rp-list">
        {shown.map((r) => <ReplyRow key={r.id} r={r} client={cm.get(r.data.clientId)} showClient />)}
      </ul>
      {open.length > shown.length && <button className="btn quiet sm" style={{ justifySelf: "start" }} onClick={() => setAll(true)}>Show all {open.length}</button>}
    </section>
  );
}

/** Client page: their replies, open first, handled ones folded away. */
export function ClientReplies({ client, onEditMatching }: { client: Doc<ClientRec>; onEditMatching?: () => void }) {
  const s = useVault();
  const [showDone, setShowDone] = useState(false);
  const list = replies(s, client.id);
  const open = list.filter((r) => !r.data.handled);
  const done = list.filter((r) => r.data.handled).slice(0, 15);
  const sources = [client.data.email, ...(client.data.matchAddrs || [])].filter(Boolean) as string[];
  return (
    <section className="panel stack tight rp-client-sec" aria-labelledby="rp-c-h">
      <div className="row between wrap-ok">
        <h2 className="h3" id="rp-c-h">Gmail replies {open.length > 0 && <span className="pill plain num" style={{ marginLeft: 6 }}>{open.length} waiting</span>}</h2>
        {onEditMatching && <button className="btn quiet sm" onClick={onEditMatching}><Icon name="edit" size={14} /> Matching</button>}
      </div>
      {open.length > 0
        ? <ul className="rp-list">{open.map((r) => <ReplyRow key={r.id} r={r} client={client} />)}</ul>
        : <p className="small muted">{sources.length
          ? <>Nothing waiting. Mail from {sources.join(", ")} in any of your Gmail accounts shows up here.</>
          : <>Add their email address or company domain under Matching, and their replies in any of your Gmail accounts show up here.</>}</p>}
      {done.length > 0 && (
        <>
          <button className="btn quiet sm" style={{ justifySelf: "start" }} aria-expanded={showDone} onClick={() => setShowDone((v) => !v)}>
            {showDone ? "Hide" : "Show"} handled ({done.length})
          </button>
          {showDone && <ul className="rp-list">{done.map((r) => <ReplyRow key={r.id} r={r} client={client} />)}</ul>}
        </>
      )}
    </section>
  );
}

/** Client details: which addresses and domains count as this client. Saves when you leave the box. */
export function MatchField({ client }: { client: Doc<ClientRec> }) {
  const saved = (client.data.matchAddrs || []).join("\n");
  const [text, setText] = useState(saved);
  const [bad, setBad] = useState<string[]>([]);
  const save = () => {
    const { ok, bad } = cleanMatchList(text);
    setBad(bad);
    if (ok.join("\n") === saved) return;
    void updateClient(client.id, { matchAddrs: ok }).then(() => { setText(ok.join("\n")); toast("Reply matching saved"); });
  };
  return (
    <Field label="Gmail replies come from" hint={
      (client.data.email ? `Their main email ${client.data.email} always counts. ` : "") +
      "Add more addresses, or a company domain like acme.com for everyone there. One per line. Private to you."}>
      <textarea className="input" rows={3} value={text} placeholder={"person5@acme.com\nacme.com"} spellCheck={false}
        onChange={(e) => setText(e.target.value)} onBlur={save} />
      {bad.length > 0 && <span className="xs err">Not an address or domain: {bad.join(", ")}</span>}
    </Field>
  );
}

/** Settings: which Gmail accounts are connected, and who can pop up (MailPeople: lists and Who emails me). */
export function GmailSettings({ embedded = false }: { embedded?: boolean } = {}) {
  const s = useVault();
  const [rows, setRows] = useState<unknown>(null);
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    // The reason a status check fails is shown, never swallowed (V1.63): "not connected" is only said when nothing says otherwise.
    const load = () => void sb.rpc("gmail_status").then(({ data, error: e }) => { if (live) { if (!e) setRows(data); setError(e ? e.message || "error" : null); setAsked(true); } },
      (e: unknown) => { if (live) { setError(String((e as Error)?.message || e) || "error"); setAsked(true); } });
    load();
    const t = window.setInterval(load, 60_000);
    return () => { live = false; clearInterval(t); };
  }, []);
  const view = useMemo(() => gmailView({ rows, asked, error, seen: seenAccounts(s.docs.values()) }), [rows, asked, error, s]);
  const Shell = embedded ? "div" : "section";
  return (
    <Shell className={embedded ? "stack" : "panel stack"} aria-labelledby="gm-h">
      <div className="stack tight" style={{ gap: 2 }}>
        <h2 className={embedded ? "h3" : "h2"} id="gm-h">Gmail replies</h2>
        <p className="small muted">Your Gmail accounts are checked every 2 minutes with read-only access. Each message's sender, subject and short preview are sealed to your key before they are stored, so only this vault can read them. Reading never sends anything.</p>
      </div>
      {view.state === "asking" ? <p className="small muted">Checking...</p> : view.state === "none" ? (
        <p className="empty">No Gmail accounts connected yet.</p>
      ) : view.state === "error" ? (
        <p className="small muted">{view.note}</p>
      ) : view.state === "seen" ? (
        <>
          <ul className="gm-accts">
            {view.accounts.map((a) => (
              <li key={a.account}>
                <span className="pill good">Mail arriving</span>
                <b className="trunc">{a.account}</b>
                <span className="xs muted">{a.last ? `latest email ${relTime(a.last)}` : "mail seen from this account"}</span>
              </li>
            ))}
          </ul>
          {view.note && <p className="xs muted">{view.note}</p>}
        </>
      ) : (
        <ul className="gm-accts">
          {view.rows.map((a) => {
            const stale = !a.last_ok || Date.now() - new Date(a.last_ok).getTime() > 15 * 60_000;
            return (
              <li key={a.account}>
                <span className={"pill " + (a.last_error ? "bad" : stale ? "amber" : "good")}>{a.last_error ? "Problem" : stale ? "Late" : "Live"}</span>
                <b className="trunc">{a.account}</b>
                <span className="xs muted">{a.last_error ? a.last_error : a.last_ok ? `checked ${relTime(a.last_ok)}` : "not checked yet"}</span>
                {a.readonly === false && <span className="xs muted" title="Google blocked a read-only sign-in for this account, so it uses an existing Gmail login. The vault only reads with it.">connector login</span>}
              </li>
            );
          })}
        </ul>
      )}
      <MailPeople />
    </Shell>
  );
}
