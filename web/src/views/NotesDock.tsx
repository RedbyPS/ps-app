// The notes window: always there in the bottom right on desktop, a round button on phones.
// Looks and works like Apple Notes: a list of notes (pinned first, grouped by date, searchable),
// an editor with a title and a formatted body (title, heading, subheading, bold, italic,
// underline, strikethrough, bullets, numbers, checklists), and Recently deleted to undo.
// Every note is its own encrypted record in the vault.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Doc, Note } from "../core/model";
import { notes } from "../core/select";
import { newNote, purgeNote, restoreNote, saveNote, trashNote } from "../core/actions";
import { toast, useVault } from "../ui/kit";
import { holdEdit } from "../core/savenow";
import "./notes.css";

/** How notes are saved: straight to the vault. */
export const noteOps = {
  create: (id: string) => newNote(id) as Promise<unknown>,
  save: (id: string, patch: Partial<Note>) => saveNote(id, patch) as Promise<unknown>,
  trash: (id: string) => trashNote(id) as Promise<unknown>,
  restore: (id: string) => restoreNote(id) as Promise<unknown>,
  purge: (id: string) => purgeNote(id) as Promise<unknown>,
};

const OPEN_KEY = "cv-notes-open";
const SEL_KEY = "cv-notes-sel";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private window */ } };

// ---------- safe HTML: only the tags the toolbar can make ----------
const ALLOWED = new Set(["H1", "H2", "H3", "P", "DIV", "BR", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "UL", "OL", "LI", "A", "SPAN"]);
export function cleanHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const walk = (el: Element) => {
    for (const c of [...el.children]) {
      if (!ALLOWED.has(c.tagName)) { c.replaceWith(...[...c.childNodes]); continue; }
      for (const a of [...c.attributes]) {
        const keep = (c.tagName === "A" && a.name === "href" && /^https?:\/\//i.test(a.value))
          || (c.tagName === "UL" && a.name === "class" && a.value === "nt-check")
          || (c.tagName === "LI" && a.name === "data-done");
        if (!keep) c.removeAttribute(a.name);
      }
      if (c.tagName === "A") { c.setAttribute("target", "_blank"); c.setAttribute("rel", "noopener noreferrer"); }
      walk(c);
    }
  };
  const root = doc.body.firstElementChild!;
  walk(root);
  return root.innerHTML;
}
// Plain text of a note, with a line break after each block so words never run together.
export const textOf = (html: string) => new DOMParser().parseFromString(html.replace(/<\/(h1|h2|h3|p|div|li)>|<br\s*\/?>/gi, "$&\n"), "text/html").body.textContent || "";
export const titleOf = (n: Note) => n.title.trim() || textOf(n.html).trim().split("\n")[0].slice(0, 60) || "New Note";

function when(iso: string) {
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 864e5);
  if (days === 0) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
export function group(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);
  return days < 1 ? "Today" : days < 7 ? "Previous 7 days" : days < 30 ? "Previous 30 days" : new Date(iso).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export function NotesDock() {
  const s = useVault();
  const { live, deleted } = notes(s);
  // Desktop remembers whether the window was open; phones always start with just the round button.
  const [open, setOpen] = useState(() => read(OPEN_KEY) === "1" && matchMedia("(min-width: 980px)").matches);
  const [big, setBig] = useState(false);
  const [sel, setSel] = useState<string | null>(() => read(SEL_KEY));
  const [q, setQ] = useState("");
  const [trash, setTrash] = useState(false);
  const [mobileEdit, setMobileEdit] = useState(false); // phones: list or editor

  const toggle = (v: boolean) => { setOpen(v); write(OPEN_KEY, v ? "1" : "0"); };
  const pick = (id: string | null) => { setSel(id); write(SEL_KEY, id); if (id) setMobileEdit(true); };
  const current = live.find((d) => d.id === sel) || deleted.find((d) => d.id === sel) || null;

  // Leaving a note that was never written removes it, like Apple Notes.
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = sel;
    if (!p || p === sel) return;
    const n = live.find((d) => d.id === p);
    if (n && !n.data.title.trim() && !textOf(n.data.html).trim()) void noteOps.purge(p);
  }, [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && big) { e.preventDefault(); setBig(false); } };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open, big]);

  async function create() {
    try { const id = crypto.randomUUID(); await noteOps.create(id); setTrash(false); setQ(""); pick(id); }
    catch (e) { toast(String((e as Error).message || e)); }
  }

  const needle = q.trim().toLowerCase();
  const shown = (trash ? deleted : live).filter((d) => !needle || `${d.data.title} ${textOf(d.data.html)}`.toLowerCase().includes(needle));
  const pinned = trash ? [] : shown.filter((d) => d.data.pinned);
  const rest = trash ? shown : shown.filter((d) => !d.data.pinned);
  const groups = useMemo(() => {
    const out: [string, Doc<Note>[]][] = [];
    for (const d of rest) {
      const g = trash ? "Recently deleted" : group(d.data.updatedAt);
      const last = out[out.length - 1];
      if (last && last[0] === g) last[1].push(d); else out.push([g, [d]]);
    }
    return out;
  }, [rest, trash]);

  if (!open) {
    return (
      <button type="button" className="nt-launch" onClick={() => toggle(true)} aria-label="Open notes" title="Notes">
        <NoteGlyph /> <span className="nt-launch-l">Notes</span>
      </button>
    );
  }

  return (
    <section className={`nt-win${big ? " big" : ""}${mobileEdit ? " m-edit" : ""}`} aria-label="Notes">
      <header className="nt-head">
        <span className="nt-head-t"><NoteGlyph /> Notes</span>
        <div className="nt-head-b">
          <button type="button" className="nt-ib" onClick={() => void create()} title="New note" aria-label="New note"><Compose /></button>
          <button type="button" className="nt-ib nt-desk" onClick={() => setBig((v) => !v)} title={big ? "Smaller" : "Bigger"} aria-label={big ? "Make smaller" : "Make bigger"}><Grow big={big} /></button>
          <button type="button" className="nt-ib" onClick={() => toggle(false)} title="Minimise" aria-label="Minimise notes"><Minus /></button>
        </div>
      </header>
      <div className="nt-body">
        <aside className="nt-side">
          <input className="nt-search" type="search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
          <div className="nt-list" role="list">
            {pinned.length > 0 && <div className="nt-g">Pinned</div>}
            {pinned.map((d) => <NoteRow key={d.id} d={d} on={d.id === sel} onPick={() => pick(d.id)} />)}
            {groups.map(([g, list]) => (
              <div key={g} role="presentation">
                <div className="nt-g">{g}</div>
                {list.map((d) => <NoteRow key={d.id} d={d} on={d.id === sel} onPick={() => pick(d.id)} />)}
              </div>
            ))}
            {shown.length === 0 && <p className="nt-none">{trash ? "Nothing deleted." : needle ? "No notes match." : "No notes yet."}</p>}
          </div>
          <button type="button" className="nt-trash-btn" onClick={() => { setTrash((v) => !v); setQ(""); }}>
            {trash ? "Back to notes" : `Recently deleted${deleted.length ? ` (${deleted.length})` : ""}`}
          </button>
        </aside>
        <div className="nt-main">
          {current ? (
            <Editor key={current.id} d={current} onBack={() => setMobileEdit(false)}
              onTrash={() => { void noteOps.trash(current.id); pick(null); setMobileEdit(false); toast("Moved to Recently deleted"); }}
              onRestore={() => { void noteOps.restore(current.id); setTrash(false); }}
              onPurge={() => { if (window.confirm("Delete this note forever? This cannot be undone.")) { void noteOps.purge(current.id); pick(null); setMobileEdit(false); } }} />
          ) : (
            <div className="nt-blank">
              <NoteGlyph big />
              <button type="button" className="btn ghost sm" onClick={() => void create()}>New note</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function NoteRow({ d, on, onPick }: { d: Doc<Note>; on: boolean; onPick: () => void }) {
  const body = textOf(d.data.html).replace(/\s+/g, " ").trim();
  const title = titleOf(d.data);
  const preview = d.data.title.trim() ? body : body.slice(title.length).trim();
  return (
    <button type="button" role="listitem" className={`nt-row${on ? " on" : ""}`} onClick={onPick}>
      <b className="nt-row-t">{title}</b>
      <span className="nt-row-s"><span className="num">{when(d.data.updatedAt)}</span> {preview || "No additional text"}</span>
    </button>
  );
}

const FORMATS: [string, string][] = [["h1", "Title"], ["h2", "Heading"], ["h3", "Subheading"], ["p", "Body"]];

export function Editor({ d, onBack, onTrash, onRestore, onPurge }: { d: Doc<Note>; onBack: () => void; onTrash: () => void; onRestore: () => void; onPurge: () => void }) {
  const n = d.data;
  const [title, setTitle] = useState(n.title);
  const body = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const deleted = !!n.deletedAt;

  // Load the body once per note; afterwards only take outside changes while not typing here.
  useEffect(() => { if (body.current) body.current.innerHTML = cleanHtml(n.html); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (body.current && document.activeElement !== body.current && cleanHtml(body.current.innerHTML) !== cleanHtml(n.html)) body.current.innerHTML = cleanHtml(n.html);
  }, [n.html]);
  useEffect(() => { if (document.activeElement?.className !== "nt-title") setTitle(n.title); }, [n.title]);
  useEffect(() => { if (!n.title && !n.html) document.querySelector<HTMLInputElement>(".nt-title")?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveBody = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      if (!body.current) return;
      const html = cleanHtml(body.current.innerHTML);
      if (html !== n.html) void noteOps.save(d.id, { html });
    }, 500);
  };
  // PS 1.74 (core/savenow.ts): a body save still waiting runs at once when PS updates, reloads, quits or the page hides.
  useEffect(() => holdEdit(() => {
    if (!timer.current || !body.current) return;
    window.clearTimeout(timer.current); timer.current = undefined;
    const html = cleanHtml(body.current.innerHTML);
    if (html !== n.html) void noteOps.save(d.id, { html });
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    // Save anything still waiting when the note closes.
    window.clearTimeout(timer.current);
    if (body.current) { const html = cleanHtml(body.current.innerHTML); if (html !== n.html) void noteOps.save(d.id, { html }); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const cmd = (c: string, v?: string) => { body.current?.focus(); document.execCommand(c, false, v); saveBody(); };
  const block = (tag: string) => cmd("formatBlock", `<${tag}>`);
  function checklist() {
    body.current?.focus();
    document.execCommand("insertUnorderedList");
    const sel = window.getSelection();
    let el = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
    while (el && el !== body.current && el.tagName !== "UL") el = el.parentElement;
    if (el && el.tagName === "UL") el.classList.toggle("nt-check");
    saveBody();
  }
  function onClick(e: React.MouseEvent) {
    const li = (e.target as HTMLElement).closest("li");
    if (!li || !li.parentElement?.classList.contains("nt-check")) return;
    if (e.clientX - li.getBoundingClientRect().left > 26) return;
    if (li.hasAttribute("data-done")) li.removeAttribute("data-done"); else li.setAttribute("data-done", "");
    saveBody();
  }

  return (
    <div className="nt-ed">
      <div className="nt-tools" role="toolbar" aria-label="Formatting">
        <button type="button" className="nt-tb nt-back" onClick={onBack} aria-label="Back to notes">&#8249; Notes</button>
        {deleted ? (
          <>
            <button type="button" className="nt-tb" onClick={onRestore}>Recover</button>
            <button type="button" className="nt-tb danger" onClick={onPurge}>Delete forever</button>
          </>
        ) : (
          <>
            <select className="nt-sel" aria-label="Text style" defaultValue="" onChange={(e) => { if (e.target.value) block(e.target.value); e.target.value = ""; }}>
              <option value="" disabled>Aa</option>
              {FORMATS.map(([t, l]) => <option key={t} value={t}>{l}</option>)}
            </select>
            <button type="button" className="nt-tb" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("bold")} aria-label="Bold"><b>B</b></button>
            <button type="button" className="nt-tb" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("italic")} aria-label="Italic"><i>I</i></button>
            <button type="button" className="nt-tb" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("underline")} aria-label="Underline"><u>U</u></button>
            <button type="button" className="nt-tb" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("strikeThrough")} aria-label="Strikethrough"><s>S</s></button>
            <span className="nt-sep" aria-hidden="true" />
            <button type="button" className="nt-tb" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("insertUnorderedList")} aria-label="Bulleted list">&#8226;&#8801;</button>
            <button type="button" className="nt-tb" onMouseDown={(e) => e.preventDefault()} onClick={() => cmd("insertOrderedList")} aria-label="Numbered list">1.</button>
            <button type="button" className="nt-tb" onMouseDown={(e) => e.preventDefault()} onClick={checklist} aria-label="Checklist">&#9711;&#10003;</button>
            <span className="nt-grow" />
            <button type="button" className={`nt-tb${n.pinned ? " on" : ""}`} onClick={() => void noteOps.save(d.id, { pinned: !n.pinned })} aria-pressed={!!n.pinned} title={n.pinned ? "Unpin" : "Pin"}>{n.pinned ? "Pinned" : "Pin"}</button>
            <button type="button" className="nt-tb" onClick={onTrash} aria-label="Delete note" title="Delete">&#128465;</button>
          </>
        )}
      </div>
      <div className="nt-scroll">
        <span className="nt-date">{new Date(n.updatedAt).toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" })}</span>
        <input className="nt-title" value={title} placeholder="Title" readOnly={deleted} aria-label="Note title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { if (title !== n.title) void noteOps.save(d.id, { title: title.trim() }); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); body.current?.focus(); } }} />
        <div ref={body} className="nt-text" contentEditable={!deleted} suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Note"
          data-placeholder="Start writing" onInput={saveBody} onBlur={saveBody} onClick={onClick} />
      </div>
    </div>
  );
}

// ---------- small glyphs ----------
function NoteGlyph({ big }: { big?: boolean }) {
  const s = big ? 46 : 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true" className="nt-glyph">
      <rect x="3" y="2.5" width="18" height="19" rx="4" fill="currentColor" opacity=".18" />
      <rect x="3" y="2.5" width="18" height="5" rx="2.5" fill="currentColor" />
      <path d="M7 12h10M7 15.5h10M7 19h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
const Compose = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" /><path d="M17.5 3.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z" /></svg>;
const Minus = () => <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M5 12h14" /></svg>;
const Grow = ({ big }: { big: boolean }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{big ? <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /> : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}</svg>;
