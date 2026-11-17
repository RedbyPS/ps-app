// Invite, remove access, export and destroy for one client.
import { useEffect, useRef, useState } from "react";
import type { ClientRec, Doc } from "../../core/model";
import { exportClient, privateDocsOfClient, updateClient } from "../../core/actions";
import { createInvite, destroyWorkspace, remove, revokeAccess, workspaceAccess } from "../../core/vault";
import { randomUsername, threeWords } from "../../core/crypto";
import { Icon, Modal, copyText, fmtDateTime, go, todayISO, toast } from "../../ui/kit";
import { errMsg, slug } from "./bits";

type Access = Awaited<ReturnType<typeof workspaceAccess>>;

function AccessState({ ws, refresh }: { ws: string; refresh: number }) {
  const [a, setA] = useState<Access | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    setErr("");
    workspaceAccess(ws).then((r) => live && setA(r)).catch((e) => live && setErr(errMsg(e)));
    return () => { live = false; };
  }, [ws, refresh]);
  if (err) return <p className="small muted">Could not load who has access right now ({err}).</p>;
  if (!a) return <p className="small muted">Checking who has access...</p>;
  const now = new Date().toISOString();
  const used = a.invites.filter((i: { used_at: string | null }) => !!i.used_at).length;
  const pending = a.invites.filter((i: { used_at: string | null; expires_at: string }) => !i.used_at && i.expires_at > now).length;
  const expired = a.invites.filter((i: { used_at: string | null; expires_at: string }) => !i.used_at && i.expires_at <= now).length;
  return (
    <div className="cv-access">
      <div><b className="num">{a.members.length}</b><span className="small muted">{a.members.length === 1 ? "person has" : "people have"} access</span></div>
      <div><b className="num">{used}</b><span className="small muted">invite{used === 1 ? "" : "s"} used</span></div>
      <div><b className="num">{pending}</b><span className="small muted">waiting to be used</span></div>
      {expired > 0 && <div><b className="num">{expired}</b><span className="small muted">expired</span></div>}
    </div>
  );
}

export function InviteModal({ client, onClose }: { client: Doc<ClientRec>; onClose: () => void }) {
  const [link, setLink] = useState<{ link: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // Their first name greets them; their email becomes their username (prefilled, they can change it).
  const firstAddr = (client.data.matchAddrs || []).find((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)) || "";
  const [first, setFirst] = useState(client.data.greetingName || (client.data.contactName || "").trim().split(/\s+/)[0] || "");
  const [email, setEmail] = useState(firstAddr);
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const make = async () => {
    if (!navigator.onLine) { toast("You are offline. Creating an invite needs the internet.", undefined, 7000); return; }
    if (!emailOk) { toast("That email does not look right."); return; }
    setBusy(true);
    try {
      const r = await createInvite(client.data.ws, { name: first, email });
      setLink(r);
      setRefresh((n) => n + 1);
      await updateClient(client.id, { invitedAt: new Date().toISOString() });
    } catch (e) { toast(errMsg(e), undefined, 7000); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={`Invite ${client.data.contactName || client.data.name}`} onClose={onClose}
      footer={<button className="btn quiet" onClick={onClose}>Done</button>}>
      <div className="stack">
        <ul className="cv-facts">
          <li><Icon name="lock" size={16} /> The link is private. Whoever opens it gets into {client.data.name}'s page only, never anything else.</li>
          <li><Icon name="check" size={16} /> It works once. After they set up their login it stops working.</li>
          <li><Icon name="cal" size={16} /> It expires in 7 days if nobody uses it.</li>
          <li><Icon name="emails" size={16} /> The app never sends it. You send it to them yourself.</li>
        </ul>
        <div className="panel tight stack tight">
          <span className="label">Access right now</span>
          <AccessState ws={client.data.ws} refresh={refresh} />
          {client.data.invitedAt && <span className="xs muted">Last invite made {fmtDateTime(client.data.invitedAt)}</span>}
        </div>
        {link ? (
          <div className="stack tight">
            <span className="label">Their invite link</span>
            <div className="row">
              <input className="input num" readOnly value={link.link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
              <button className="btn primary" onClick={() => void copyText(link.link)}><Icon name="link" size={16} /> Copy</button>
            </div>
            <span className="small muted">Expires {fmtDateTime(link.expiresAt)}. Making a new link does not cancel this one.</span>
          </div>
        ) : (
          <div className="stack tight">
            <div className="grid2" style={{ gap: 10 }}>
              <label className="field"><span>Their first name</span>
                <input className="input" value={first} onChange={(e) => setFirst(e.target.value)} placeholder="Alex" autoComplete="off" />
              </label>
              <label className="field"><span>Their email (becomes their username)</span>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" spellCheck={false} />
              </label>
            </div>
            <span className="xs muted">The page greets them by name with their email already filled in. They only choose a password. Both stay inside the link and are never stored on the server.</span>
            <button className="btn primary" style={{ justifySelf: "start" }} disabled={busy || !emailOk} onClick={() => void make()}>
              <Icon name="link" size={16} /> {busy ? "Creating..." : "Create invite link"}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * The door button: the client's login. One link plus three set words (eg "maple otter rocket"),
 * made once and kept in the developer's private records so he can always see and resend them. The client
 * opens the link, types the three words, and is on their dashboard. Same link and words every time.
 * "New login" makes a fresh pair (eg if a link was shared by mistake).
 */
/** What one Copy puts on the clipboard: the link and the three words, ready to paste. */
const loginText = (link: string, words: string) => `${link}\n\nYour three words: ${words}`;

export function LoginLinkButton({ client, compact }: { client: Doc<ClientRec>; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const portal = client.data.portal;
  useEffect(() => {
    if (!open) return;
    const out = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) { setOpen(false); setSure(false); } };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); setSure(false); } };
    document.addEventListener("mousedown", out);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", out); document.removeEventListener("keydown", key); };
  }, [open]);
  const make = async () => {
    if (!navigator.onLine) { toast("You are offline. A login needs the internet.", undefined, 7000); return; }
    setBusy(true);
    try {
      const first = client.data.greetingName || (client.data.contactName || "").trim().split(/\s+/)[0] || "";
      const user = randomUsername(), words = threeWords();
      // 30 days to open it the first time; after that the link and words keep working for good.
      const r = await createInvite(client.data.ws, { name: first, user }, { words, days: 30 });
      await updateClient(client.id, { invitedAt: new Date().toISOString(), portal: { link: r.link, words, user, createdAt: new Date().toISOString(), expiresAt: r.expiresAt } });
      setOpen(true); setSure(false);
      await copyText(loginText(r.link, words));
    } catch (e) { toast(errMsg(e), undefined, 7000); }
    finally { setBusy(false); }
  };
  const who = client.data.contactName?.split(" ")[0] || client.data.name;
  return (
    <span className="cv-door" ref={box}>
      <button type="button" className={compact ? "btn quiet icon" : "btn primary"} disabled={busy}
        onClick={() => { if (portal) setOpen((v) => !v); else void make(); }}
        aria-label={`Login for ${client.data.name}`} title={portal ? `${client.data.name}'s login link and words` : `Make a login for ${client.data.name}`}>
        <Icon name="door" size={compact ? 18 : 16} />{!compact && (busy ? " Making login..." : " Login link")}
      </button>
      {open && portal && (
        <div className="cv-door-pop" role="dialog" aria-label="Login link">
          <b className="small">{who}'s login</b>
          <label className="field"><span className="xs muted">Link</span>
            <div className="row">
              <input className="input num" readOnly value={portal.link} aria-label="Login link" onFocus={(e) => e.currentTarget.select()} />
              <button className="btn ghost sm" onClick={() => void copyText(portal.link)}><Icon name="link" size={14} /> Copy</button>
            </div>
          </label>
          <label className="field"><span className="xs muted">Their three words</span>
            <div className="row">
              <input className="input cv-door-words" readOnly value={portal.words} aria-label="Their three words" onFocus={(e) => e.currentTarget.select()} />
              <button className="btn ghost sm" onClick={() => void copyText(portal.words)}><Icon name="check" size={14} /> Copy</button>
            </div>
          </label>
          <button className="btn primary sm" onClick={() => void copyText(loginText(portal.link, portal.words))}><Icon name="link" size={14} /> Copy link and words</button>
          <ul className="cv-door-facts xs muted">
            <li>They open the link, type the three words, and see their dashboard only. Same link and words every time.</li>
            <li>Send the link and the words in two separate messages. The app never sends anything, you do.</li>
            <li>First open before {fmtDateTime(portal.expiresAt)}; after that it keeps working.</li>
          </ul>
          <div className="row">
            <span className="spacer" />
            <button className={`btn ${sure ? "danger" : "quiet"} sm`} disabled={busy}
              onClick={() => { if (!sure) { setSure(true); return; } void make(); }}>
              {sure ? "Click again: new link and words" : "New login"}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

export async function removeAccessFlow(client: Doc<ClientRec>) {
  if (!window.confirm(`Remove ${client.data.name}'s access? Everyone they invited is signed out of their page and unused invite links stop working. Your data stays. You can invite them again later.`)) return;
  if (!navigator.onLine) { toast("You are offline. Removing access needs the internet.", undefined, 7000); return; }
  try { await revokeAccess(client.data.ws); toast(`${client.data.name} no longer has access`); }
  catch (e) { toast(errMsg(e), undefined, 7000); }
}

export function exportFlow(client: Doc<ClientRec>) {
  const data = exportClient(client.id);
  if (!data) { toast("Nothing to export."); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(client.data.name)}-export-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`Exported ${data.documents.length} records (decrypted, keep the file safe)`);
}

export function DestroyModal({ client, onClose }: { client: Doc<ClientRec>; onClose: () => void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = typed.trim().toLowerCase() === client.data.name.trim().toLowerCase();
  const destroy = async () => {
    if (!ok) return;
    if (!navigator.onLine) { toast("You are offline. Destroying a client needs the internet so the server copy is shredded too.", undefined, 8000); return; }
    setBusy(true);
    try {
      // Collect the private ids first (they are found through the client's projects),
      // shred the workspace (fails safely if the server refuses), then remove the private records.
      const ids = privateDocsOfClient(client.id);
      await destroyWorkspace(client.data.ws);
      for (const id of ids) await remove(id);
      toast(`${client.data.name} and all their data were destroyed`, undefined, 7000);
      onClose();
      go("#/clients");
    } catch (e) {
      toast(errMsg(e), undefined, 8000);
      setBusy(false);
    }
  };
  return (
    <Modal title="Destroy all their data" onClose={onClose}
      footer={<>
        <button className="btn quiet" onClick={onClose}>Cancel</button>
        <button className="btn danger" disabled={!ok || busy} onClick={() => void destroy()}><Icon name="trash" size={16} /> {busy ? "Destroying..." : "Destroy forever"}</button>
      </>}>
      <div className="stack">
        <div className="cv-danger">
          <b>This cannot be undone.</b>
          <p className="small">Everything for {client.data.name} is deleted: their projects, stages, payments, tasks, updates, approvals, your private notes and next steps, and any meetings, drafts and to-dos linked to them. Their encryption key is destroyed, so even old backups of the server can never be read again. Their login stops working.</p>
          <p className="small">This is how you meet an NDA "return or destroy" request. Export their data first if you need to return it to them.</p>
        </div>
        <button className="btn ghost sm" style={{ justifySelf: "start" }} onClick={() => exportFlow(client)}><Icon name="down" size={16} /> Export their data first</button>
        <label className="field">
          <span>Type <b>{client.data.name}</b> to confirm</span>
          <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
      </div>
    </Modal>
  );
}
