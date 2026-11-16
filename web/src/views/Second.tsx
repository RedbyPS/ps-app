// Second Computer (the developer, 31 Oct 2026): the button top right of the Tab list, next to the Do Not Disturb moon,
// and its panel. The panel shows the other Mac (online or not, last seen, CPU, battery) and three tabs:
// Messages (notes to yourself between the Macs), Files (drag and drop, lands in ~/Downloads/From PS on the
// other Mac) and Jobs (self test, build, tests, a Claude task, with live status and the log).
// The data moves in src/second/store.ts; the rules are in core/second.ts. In the floating Tab list (no vault
// there) every action goes to the main window as a `secondOp` (PsApp.tsx), and a dropped file is handed over
// through IndexedDB (same origin and store as the main window), never through the bridge as text. Since v1.2
// (2 Nov 2026) PS takes the drop itself (second/dragzone.ts): any file, folder, Mail attachment or picture, up to 1 GB.
// The panel lives on document.body like the moon's pop-up, opens on a click, closes on Esc or a click outside.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { Snapshot } from "../core/vault";
import { FILE_MAX, fileRefusal, fmtSize, JOB_LABEL, seenText, STREAM_MAX, TEST_PRESETS, type CmdAction, type DropTarget, type JobType, type Role } from "../core/second";
import { secondStore } from "../second/store";
import { blocker, jobRunning, SEEK_WAIT, secondView, STATE_WORD, type FileRow, type JobRow, type SecondLocal, type SecondView } from "../second/view";
import { canNative, dropPlace, useDropOver } from "../second/dragzone";
import { sfx } from "../ui/sfx";
import "./second.css";

export type SecondOp =
  | { op: "msg"; text: string; keys?: string[]; files?: string[] }
  | { op: "outboxDrop"; id: string }
  | { op: "outsource"; title: string; prompt: string; model?: "opus" | "sonnet"; minutes?: number }
  | { op: "sendDrop"; key: string; root?: string; dir?: string }
  | { op: "job"; type: Exclude<JobType, "cancel">; project?: string; prompt?: string; preset?: string; only?: string; send?: boolean; model?: "opus" | "sonnet"; title?: string; minutes?: number }
  | { op: "fetch"; device: string; root: string; path: string; as: "download" | "preview" }
  | { op: "cmd"; action: CmdAction }
  | { op: "window"; tab?: string }
  | { op: "trustPhone"; device: string }
  | { op: "cancel"; job: string }
  | { op: "pair" } | { op: "unpair"; device: string }
  | { op: "role"; role: Role } | { op: "wait" } | { op: "projects" } | { op: "reveal" } | { op: "allow" };

/** Where the panel's buttons go: the main window runs them, the Tab list forwards them (PsApp.tsx). `native`
 *  goes straight to this page's PS (v1.2: second:pick, PS's Open panel; second:dragArm, a file about to be dragged out). */
export const secondActions: { run: (o: SecondOp) => void; drop: (f: File) => Promise<string | null>; native: (m: object) => void } = {
  run: () => {},
  drop: async () => null,
  native: () => {},
};
/** Send files: PS's own Open panel when it stages files itself (files and folders, up to 1 GB), else the page's. */
export function pickFiles(caps: string[] | undefined, target: DropTarget, fallback: () => void) {
  if (canNative(caps)) secondActions.native({ type: "second:pick", target }); else fallback();
}
/** What a file row says about where it is (shared by the Tab list panel and the window). */
export function fileState(f: FileRow, peer: string, landedText = "in Downloads, From PS"): string {
  const what = f.folder ? "folder" : "file";
  if (f.state === "sending") return f.stalled ? `waiting for ${peer} to take the first part (${f.pct ?? 0}%)` : `sending ${f.pct ?? 0}%`;
  if (f.state === "waiting") return f.pct !== undefined ? (f.mine ? `${peer} has ${f.pct}%` : `landing ${f.pct}%`) : f.mine ? `on its way to ${peer}` : "landing...";
  if (f.state === "landed") return f.mine ? `landed on ${peer}` : f.folder ? `${landedText} (a ${what})` : landedText;
  return f.reason || "failed";
}

export const DOWNLOAD_LINK = "https://cincee.com/client/ps/PS.dmg";   // V1.23: the download page is not live until the developer approves its words (ps-download/approved.json); then /client/ps/download/

function useSecond(s: Snapshot): SecondView {
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  return useMemo(() => secondView([...s.docs.values()], local, now), [s.docs, local, now]);
}

/** Two Macs, the back one smaller: the second computer. A dot shows online (green), busy (pink, breathing). */
function Icon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 4.5h11a1.5 1.5 0 0 1 1.5 1.5v7" opacity=".55" />
      <rect x="3.5" y="8" width="13" height="8.5" rx="1.5" />
      <path d="M1.8 19.5h16.4" />
    </svg>
  );
}

export function SecondButton({ s, size = 18 }: { s: Snapshot; size?: number }) {
  const v = useSecond(s);
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!local.native) return null;   // PS on a Mac only (not the website, not the phone)
  const busy = v.jobs.some(jobRunning);
  const dot = v.role === "none" ? "" : !v.peer ? "none" : busy ? "busy" : v.online ? "on" : "off";
  const label = v.peer ? `${v.peer.name}: ${busy ? "working" : v.online ? "online" : "offline"}` : "Second Computer";
  return (
    <>
      <button ref={btn} type="button" className={`sc-btn${open ? " open" : ""}${dot ? ` sc-${dot}` : ""}`} onClick={() => { sfx.click(); setOpen((o) => !o); }}
        aria-haspopup="dialog" aria-expanded={open} aria-label={label}
        data-tip={v.peer ? `Second Computer: ${v.peer.name}` : "Second Computer"} data-tip-line={v.peer ? `${busy ? "Working" : v.online ? "Online" : "Offline"}. Send it files or research jobs` : "Pair your other Mac to share files and jobs"}>
        <Icon size={size} />
        {dot && dot !== "none" && <i className="sc-dot" aria-hidden="true" />}
      </button>
      {open && <SecondMenu v={v} anchor={btn} onClose={() => setOpen(false)} />}
    </>
  );
}

function SecondMenu({ v, anchor, onClose }: { v: SecondView; anchor: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 10, right: Math.max(8, window.innerWidth - r.right - 40) });
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => { const t = e.target as Node; if (!menu.current?.contains(t) && !anchor.current?.contains(t)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); window.removeEventListener("keydown", key, true); };
  }, [anchor, onClose]);
  if (!at) return null;
  return createPortal(
    <div ref={menu} className="sc-menu" role="dialog" aria-label="Second Computer" style={{ top: at.top, right: at.right }}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <SecondPanel v={v} />
    </div>, document.body);
}

type Tab = "msgs" | "files" | "jobs";
export function SecondPanel({ v }: { v: SecondView }) {
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const [tab, setTab] = useState<Tab>(() => (localGet("sc.tab") as Tab) || "msgs");
  const pick = (t: Tab) => { sfx.click(); setTab(t); localSet("sc.tab", t); };
  if (local.off) return <OffHere off={local.off} note={local.note} />;
  if (v.role === "none") return <Setup note={local.note} />;
  const unread = 0;
  return (
    <div className="sc-panel">
      <Header v={v} />
      <button type="button" className="sc-open" onClick={() => { sfx.click(); secondActions.run({ op: "window" }); }}>
        Open Second Computer<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8" /></svg>
      </button>
      {!v.peer ? <Pairing v={v} pairing={local.pairing} /> : (
        <>
          <div className="sc-tabs" role="tablist">
            {(["msgs", "files", "jobs"] as Tab[]).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "sel" : ""} onClick={() => pick(t)}>
                {t === "msgs" ? "Messages" : t === "files" ? "Files" : "Jobs"}
                {t === "jobs" && v.jobs.some(jobRunning) && <i className="sc-live" aria-hidden="true" />}
                {t === "msgs" && unread > 0 && <b className="sc-n">{unread}</b>}
              </button>
            ))}
            <i className="sc-tabbar" style={{ transform: `translateX(${["msgs", "files", "jobs"].indexOf(tab) * 100}%)` }} aria-hidden="true" />
          </div>
          <div className="sc-body" key={tab}>
            {tab === "msgs" && <Messages v={v} />}
            {tab === "files" && <Files v={v} />}
            {tab === "jobs" && <Jobs v={v} />}
          </div>
        </>
      )}
      {local.note && <p className="sc-note" role="status">{local.note}</p>}
    </div>
  );
}

function Header({ v }: { v: SecondView }) {
  const st = v.stat;
  const other = v.peer;
  const title = v.role === "secondary" ? "This Mac is your second computer" : other ? other.name : "Second Computer";
  const sub = v.role === "secondary"
    ? (other ? `Working for ${other.name}` : "Not paired yet")
    : !other ? "No second Mac paired yet"
    : v.online ? (st?.busy ? "Online, working" : "Online") : `Offline, last seen ${seenText(st?.at)}`;
  return (
    <div className="sc-top">
      <span className={`sc-orb${v.online ? " on" : ""}${st?.busy ? " busy" : ""}`} aria-hidden="true"><Icon size={22} /></span>
      <span className="sc-t">{title}<em>{sub}</em></span>
      {st && (v.role === "secondary" || other) && (
        <span className="sc-meters">
          <Meter label="CPU" pct={st.cpu} />
          {st.battery !== null && <Meter label={st.power === "ac" ? (st.charging ? "Charging" : "Plugged in") : "Battery"} pct={st.battery} warn={st.power === "battery" && st.battery < 25} />}
        </span>
      )}
    </div>
  );
}
function Meter({ label, pct, warn }: { label: string; pct: number; warn?: boolean }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <span className={`sc-meter${warn ? " warn" : ""}`} title={`${label} ${p}%`}>
      <b>{p}%</b><i><s style={{ transform: `scaleX(${p / 100})` }} /></i><em>{label}</em>
    </span>
  );
}

/** Second Computer is off on this Mac (V1.31): the reason and the one button that fixes it, never role buttons that
 *  PS cannot act on (4 Nov 2026: on the M4 "This is my main Mac" did nothing because the key needed an OK). */
function OffHere({ off, note }: { off: NonNullable<SecondLocal["off"]>; note: string | null }) {
  const key = /needs your OK/.test(off.why);
  return (
    <div className="sc-panel sc-setup">
      <div className="sc-top"><span className="sc-orb" aria-hidden="true"><Icon size={22} /></span>
        <span className="sc-t">Second Computer is off<em>{key ? "PS needs your Mac password once" : "It could not start on this Mac"}</em></span></div>
      <p className="sc-p" role="status">{off.here || `Second Computer is off on this Mac: ${off.why}.`}</p>
      <button type="button" className="sc-wide" disabled={!!off.allowing} onClick={() => { sfx.click(); secondActions.run({ op: "allow" }); }}>
        {off.allowing ? "Waiting for macOS..." : key ? (off.retried ? "Allow again" : "Allow") : "Try again"}</button>
      <button type="button" className="sc-open" onClick={() => { sfx.click(); secondActions.run({ op: "window" }); }}>Open Second Computer</button>
      {note && note !== off.here && <p className="sc-note" role="status">{note}</p>}
    </div>
  );
}

function Setup({ note }: { note: string | null }) {
  return (
    <div className="sc-panel sc-setup">
      <div className="sc-top"><span className="sc-orb" aria-hidden="true"><Icon size={22} /></span>
        <span className="sc-t">Second Computer<em>Send jobs, files and notes to your other Mac</em></span></div>
      <p className="sc-p">Set this Mac up once. The <b>primary</b> sends the work. The <b>secondary</b> does it.</p>
      <div className="sc-roles">
        <button type="button" className="sc-role" onClick={() => secondActions.run({ op: "role", role: "primary" })}>
          <b>This is my main Mac</b><em>Primary: sends the work</em></button>
        <button type="button" className="sc-role" onClick={() => secondActions.run({ op: "role", role: "secondary" })}>
          <b>This is my second Mac</b><em>Secondary: does the work</em></button>
      </div>
      {note && <p className="sc-note" role="status">{note}</p>}
      <p className="sc-small">Everything goes through your encrypted vault, outbound only. No local network, no open ports.</p>
    </div>
  );
}

/** Before pairing is done: where it stands in one line, and the one Pair button (V1.26: the other Mac connects by itself). */
function Pairing({ v, pairing }: { v: SecondView; pairing: string | null }) {
  const why = blocker(v.link.other, Date.now());
  const late = v.link.step === "looking" && Date.now() - (v.link.since ?? Date.now()) >= SEEK_WAIT;
  const line = late ? `${v.link.other?.name ?? "Your other Mac"} has not answered. ${why ?? "Is PS app open and signed in on it? It pairs by itself once it is."}`
    : v.link.step === "looking" ? "Looking for your other Mac..." : v.link.step === "waiting" ? "Waiting for your main Mac. Click Pair there: this Mac connects by itself."
    : why && v.link.other ? why : "One click: PS app finds your other Mac and connects it.";
  return (
    <div className="sc-pair">
      <p className="sc-p">{line}</p>
      {v.link.step === "idle" && (
        <button type="button" className="sc-wide" disabled={!!pairing} onClick={() => secondActions.run({ op: "pair" })}>{pairing ? "Starting..." : "Pair with my other Mac"}</button>
      )}
      {!v.link.other && (
        <div className="sc-link"><code>{DOWNLOAD_LINK}</code>
          <button type="button" onClick={() => { void navigator.clipboard?.writeText(DOWNLOAD_LINK); sfx.click(); }}>Copy link</button></div>
      )}
    </div>
  );
}

// ---------- Messages ----------
function Messages({ v }: { v: SecondView }) {
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const last = v.msgs[v.msgs.length - 1]?.id;
  useLayoutEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [last]);
  const send = () => { const t = text.trim(); if (!t) return; sfx.click(); secondActions.run({ op: "msg", text: t }); setText(""); };
  const name = (from: string) => from === "phone" ? "Phone" : v.devices.find((d) => d.device === from)?.name ?? "Mac";
  return (
    <div className="sc-msgs">
      <div ref={list} className="sc-thread">
        {v.msgs.length === 0 && <p className="sc-empty">Notes you send here show up on your other Mac{v.role === "primary" ? " and your phone" : ""}.</p>}
        {v.msgs.slice(-80).map((m) => (
          <div key={m.id} className={`sc-bub${m.mine ? " mine" : ""}`}>
            <span>{m.text}</span>
            <em>{m.mine ? "This Mac" : name(m.from)} · {seenText(m.at)}{!m.mine && !m.phone && !m.verified ? " · not verified" : ""}</em>
          </div>
        ))}
      </div>
      <div className="sc-compose">
        <textarea rows={1} value={text} placeholder="Note to yourself" maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button type="button" disabled={!text.trim()} onClick={send} aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </div>
    </div>
  );
}

// ---------- Files ----------
function Files({ v }: { v: SecondView }) {
  const [htmlOver, setOver] = useState(false);
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const native = canNative(local.caps), over = useDropOver() === "tab" || htmlOver;
  const max = v.peer?.stream ? STREAM_MAX : FILE_MAX;
  const [err, setErr] = useState<string | null>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const send = async (list: FileList | null) => {
    setErr(null);
    let waiting = v.waitingBytes;
    for (const f of Array.from(list || []).slice(0, 10)) {
      const why = fileRefusal(f.size, waiting);
      if (why) { setErr(`${f.name}: ${why}`); continue; }
      waiting += f.size;
      sfx.click();
      const key = await secondActions.drop(f);
      if (key) secondActions.run({ op: "sendDrop", key });
    }
  };
  const peer = v.peer?.name ?? "the other Mac";
  return (
    <div className="sc-files">
      <div className={`sc-drop${over ? " over" : ""}`} {...dropPlace("tab", { kind: "files" })}
        onDragEnter={(e) => { if (native) return; e.preventDefault(); setOver(true); }} onDragOver={(e) => { if (native) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setOver(false); }}
        onDrop={(e) => { e.preventDefault(); setOver(false); void send(e.dataTransfer.files); }}
        onClick={() => pickFiles(local.caps, { kind: "files" }, () => pickRef.current?.click())} role="button" tabIndex={0}>
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
        <b>{native ? `Drop files or folders to send them to ${peer}` : `Drop a file to send it to ${peer}`}</b>
        <em>Lands in Downloads, From PS. Up to {fmtSize(native ? max : FILE_MAX)} a {native ? "file or folder" : "file"}.</em>
        <input ref={pickRef} type="file" multiple hidden onChange={(e) => { void send(e.target.files); e.target.value = ""; }} />
      </div>
      {err && <p className="sc-err">{err}</p>}
      <ul className="sc-flist">
        {v.files.slice(0, 30).map((f) => (
          <li key={f.id} className={`sc-file ${f.state}`}>
            <span className="sc-fi">{f.mine ? "↑" : "↓"}</span>
            <span className="sc-fn"><b>{f.name}</b>
              <em>{fmtSize(f.size)} · {fileState(f, peer)}
                {f.purpose === "result" ? " · job result" : ""}</em>
              {(f.state === "sending" || f.pct !== undefined) && <i className="sc-bar"><s style={{ transform: `scaleX(${(f.pct ?? 0) / 100})` }} /></i>}
            </span>
          </li>
        ))}
      </ul>
      {v.files.some((f) => !f.mine && f.state === "landed") && (
        <button type="button" className="sc-ghost" onClick={() => secondActions.run({ op: "reveal" })}>Open the From PS folder</button>
      )}
    </div>
  );
}

// ---------- Jobs ----------
const KINDS: { type: Exclude<JobType, "cancel">; title: string; hint: string }[] = [
  { type: "selftest", title: "Self test", hint: "The full PS app self test on your current code" },
  { type: "build", title: "Build PS app", hint: "Builds PS app from your current code" },
  { type: "tests", title: "Run tests", hint: "Any project's tests" },
  { type: "claude", title: "Claude task", hint: "A headless Claude Code run, changes come back" },
];
function Jobs({ v }: { v: SecondView }) {
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const [form, setForm] = useState<Exclude<JobType, "cancel"> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const primary = v.role === "primary";
  useEffect(() => { if (form === "tests" || form === "claude") secondActions.run({ op: "projects" }); }, [form]);
  return (
    <div className="sc-jobs">
      {primary && (
        <div className="sc-kinds">
          {KINDS.map((k) => (
            <button key={k.type} type="button" className={`sc-kind${form === k.type ? " sel" : ""}`} onClick={() => { sfx.click(); setForm(form === k.type ? null : k.type); }}>
              <b>{k.title}</b><em>{k.hint}</em>
            </button>
          ))}
        </div>
      )}
      {primary && form && <JobForm type={form} projects={local.projects} onDone={() => setForm(null)} />}
      {v.jobs.length === 0 && <p className="sc-empty">{primary ? "Nothing sent yet. Jobs run one at a time on the second Mac, with no focus stealing here." : "No jobs yet."}</p>}
      <ul className="sc-jlist">
        {v.jobs.slice(0, 25).map((j) => <JobItem key={j.id} j={j} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} primary={primary} v={v} />)}
      </ul>
    </div>
  );
}

function JobForm({ type, projects, onDone }: { type: Exclude<JobType, "cancel">; projects: { name: string }[]; onDone: () => void }) {
  const [project, setProject] = useState("");
  const [prompt, setPrompt] = useState("");
  const [preset, setPreset] = useState("auto");
  const [only, setOnly] = useState("");
  const [send, setSend] = useState(false);
  const needsProject = type === "tests" || type === "claude";
  const ok = (!needsProject || !!project) && (type !== "claude" || prompt.trim().length > 0) && (!only || /^[a-z0-9]{1,20}$/.test(only));
  const go = () => {
    if (!ok) return;
    sfx.click();
    secondActions.run({ op: "job", type, project: needsProject ? project : undefined, prompt: type === "claude" ? prompt.trim() : undefined,
      preset: type === "tests" ? preset : undefined, only: type === "selftest" && only ? only : undefined, send: type === "build" ? send : undefined });
    onDone();
  };
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  return (
    <div className="sc-form">
      {needsProject && (
        <label className="sc-f"><span>Project</span>
          <select value={project} onChange={(e) => setProject(e.target.value)} onKeyDown={stop}>
            <option value="">Choose a project</option>
            {projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select></label>
      )}
      {type === "tests" && (
        <label className="sc-f"><span>Tests</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)} onKeyDown={stop}>
            {TEST_PRESETS.map((p) => <option key={p} value={p}>{p === "auto" ? "Find them for me" : p}</option>)}
          </select></label>
      )}
      {type === "selftest" && (
        <label className="sc-f"><span>Only one area</span>
          <input value={only} placeholder="all of it" onChange={(e) => setOnly(e.target.value.toLowerCase())} onKeyDown={stop} /></label>
      )}
      {type === "build" && (
        <label className="sc-check"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> Send the built app back to this Mac</label>
      )}
      {type === "claude" && (
        <label className="sc-f sc-ta"><span>What should Claude do?</span>
          <textarea rows={4} value={prompt} maxLength={8000} onChange={(e) => setPrompt(e.target.value)} onKeyDown={stop}
            placeholder="For example: make the failing tests in tests/mail.test.ts pass" /></label>
      )}
      <p className="sc-small">Your current code goes with it, sealed in your vault. Uncommitted changes included, secrets and ignored files never.</p>
      <button type="button" className="sc-wide" disabled={!ok} onClick={go}>Send {JOB_LABEL[type].toLowerCase()}</button>
    </div>
  );
}

function JobItem({ j, open, onToggle, primary, v }: { j: JobRow; open: boolean; onToggle: () => void; primary: boolean; v: SecondView }) {
  const st = j.status;
  const what = j.type === "tests" || j.type === "claude" ? String(j.args.project ?? "") : `ps-mac ${String(j.args.mac ?? "").slice(0, 7)}`;
  const took = st?.startedAt ? Math.round(((st.endedAt ?? Date.now()) - st.startedAt) / 1000) : null;
  const result = st?.result ? v.files.find((f) => f.id === st.result) : undefined;
  return (
    <li className={`sc-job s-${j.state}`}>
      <button type="button" className="sc-jhead" onClick={() => { sfx.click(); onToggle(); }} aria-expanded={open}>
        <span className="sc-jt"><b>{JOB_LABEL[j.type]}</b><em>{what}{j.type === "claude" ? ` · ${String(j.args.prompt ?? "").slice(0, 60)}` : ""}</em></span>
        <span className="sc-chip">{STATE_WORD[j.state]}{took !== null ? ` · ${fmtDur(took)}` : ""}</span>
      </button>
      {(st?.step || st?.summary || st?.reason) && <p className="sc-step">{st?.reason || st?.summary || st?.step}</p>}
      {open && (
        <div className="sc-jbody">
          {st?.tail ? <pre className="sc-log">{st.tail}</pre> : <p className="sc-small">No output yet.</p>}
          {st?.files && st.files.length > 0 && <p className="sc-small">Changed: {st.files.slice(0, 12).join(", ")}{st.files.length > 12 ? ` and ${st.files.length - 12} more` : ""}</p>}
          {result && <p className="sc-small">Result: {result.name} ({result.state === "landed" ? "in Downloads, From PS" : "on its way"})</p>}
          {primary && jobRunning(j) && <button type="button" className="sc-ghost" onClick={() => secondActions.run({ op: "cancel", job: j.id })}>Stop this job</button>}
        </div>
      )}
    </li>
  );
}
const fmtDur = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

function localGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private window */ } }

/** PS > Settings: which Mac this is, who it is paired with (Unpair asks in a PS alert), the download link. */
export function SecondSettings() {
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  if (!local.native) return null;
  const role = local.me?.role ?? "none";
  const set = (r: Role) => { if (r !== role) secondActions.run({ op: "role", role: r }); };
  return (
    <section className="panel stack" aria-labelledby="sc-set-h">
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 className="h2" id="sc-set-h">Second Computer</h2>
        <span className={`pill ${role === "none" ? "ink" : "good"}`}>{role === "primary" ? "Primary" : role === "secondary" ? "Secondary" : "Off"}</span>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Send jobs, files and notes to your other Mac. The primary sends the work; the secondary does it. Everything goes through your encrypted vault, outbound only: no local network, no open ports.
        A job only runs when it is signed by a primary this Mac trusts, and only from a short list (self test, build, tests, a Claude task).
      </p>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }} role="radiogroup" aria-label="This Mac is">
        {(["primary", "secondary", "none"] as Role[]).map((r) => (
          <button key={r} type="button" role="radio" aria-checked={role === r} className={`btn ${role === r ? "" : "ghost"} sm`} onClick={() => set(r)}>
            {r === "primary" ? "Primary (sends work)" : r === "secondary" ? "Secondary (does work)" : "Off"}
          </button>
        ))}
      </div>
      {local.trusted.length > 0 && (
        <ul className="stack tight" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {local.trusted.map((t) => (
            <li key={t.device} className="row" style={{ gap: 10, alignItems: "center" }}>
              <span className="small"><b>{t.name || "Mac"}</b> <span className="muted">{t.role === "primary" ? "your primary" : "your secondary"}</span></span>
              <button type="button" className="btn ghost sm" onClick={() => secondActions.run({ op: "unpair", device: t.device })}>Unpair</button>
            </li>
          ))}
        </ul>
      )}
      <p className="xs muted" style={{ margin: 0 }}>Get PS app on your other Mac: <code>{DOWNLOAD_LINK}</code></p>
    </section>
  );
}
