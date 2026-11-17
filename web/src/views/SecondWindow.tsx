// Second Computer, its own window (the developer, 31 Oct 2026: "its kind of own thing ... drag and drop files to my other
// computer like an actual file system ... message my other computer ... a full on file transferring machine as
// well as outsourcing research projects"). A sidebar with Files, Messages, Outsource and Machine.
// PS opens it from the Tab list button and the "PS is active" pop-up ({type:"second:window", tab}). Like the Tab
// list it holds no keys: the main page hands it the records (ps.ts startPsSecondWindow) and runs every action
// (secondActions -> `secondOp`). Dropped files: since v1.2 (2 Nov 2026, the developer: "make it so it can actually drag and
// drop files as well ... make it very compatible") PS takes every drop itself and stages it (second/dragzone.ts,
// ps-mac SecondDrop.swift): files, folders, packages, Mail attachments, browser pictures and links, up to 1 GB, onto
// the Files pane, a folder in it, or Messages; a file in the other Mac's list drags out to Finder. An older PS still
// gets dropped files through IndexedDB. Previews come back that way too.
// Rules live in core/second.ts; protocol in the shared notes second-computer/protocol.md.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Snapshot } from "../core/vault";
import { FILE_MAX, fileRefusal, fmtSize, STREAM_MAX, suiteWords, type DropTarget, JOB_LABEL, listDir, machineMs, timerOn, parseShareLink, seenText, shareLink, TEST_PRESETS, type IdxEntry, type JobType, type Machine, type StatBody } from "../core/second";
import { previewKey, secondStore } from "../second/store";
import { getPreview, type Preview } from "../second/drops";
import { appNum, blocker, jobRunning, ONE_CLICK_APP, SEEK_WAIT, secondView, STATE_WORD, type JobRow, type OffInfo, type SecondView, type ShareRoot } from "../second/view";
import { DOWNLOAD_LINK, fileState, pickFiles, secondActions } from "./Second";
import { canNative, dropPlace, onDroppedText, useDropOver } from "../second/dragzone";
import { sfx } from "../ui/sfx";
import { settingsData } from "../core/select";
import { aiGuide, CODE_DEFAULT_MINUTES, CODE_MINUTE_CHOICES, CODE_WORDS, codeJobsOn, codeLine, type CodeTool } from "../core/secondcode";
import "./secondwin.css";
import { RebootCard } from "./RebootCard";

type Tab = "files" | "messages" | "outsource" | "machine";
const TABS: { k: Tab; label: string }[] = [
  { k: "files", label: "Files" }, { k: "messages", label: "Messages" }, { k: "outsource", label: "Outsource" }, { k: "machine", label: "Machine" },
];
/** Until a second Mac is paired the sidebar starts with "Set up"; every tab still opens (1 Nov: they looked dead). */
type View = Tab | "setup";
const SETUP = { k: "setup" as const, label: "Set up" };
/** What each tab is for, said on the tab while there is no second Mac yet. */
const WAITS: Record<Tab, string> = {
  files: "Files shows the shared folders of both Macs, like Finder. Drop a file here to send it to the other Mac.",
  messages: "Messages are notes between your Macs and your phone, with files attached.",
  outsource: "Outsource sends research, Claude Code tasks, tests, builds and the PS app self test to your second Mac.",
  machine: "Machine shows both Macs: online, battery, CPU, and Lock, Restart and Shut down from here.",
};
const click = () => sfx.click();

function useView(s: Snapshot): SecondView {
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 20_000); return () => clearInterval(t); }, []);
  return useMemo(() => secondView([...s.docs.values()], local, now), [s.docs, local, now]);
}

/** Line icons, 20 px, currentColor. */
function I({ n, size = 18 }: { n: string; size?: number }) {
  const p: Record<string, React.ReactNode> = {
    files: <><path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /></>,
    messages: <><path d="M4 5.5h16v10H9l-5 4z" /></>,
    outsource: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" /></>,
    machine: <><rect x="3.5" y="5" width="17" height="11" rx="1.5" /><path d="M2 19h20" /></>,
    folder: <><path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /></>,
    file: <><path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4" /></>,
    image: <><rect x="4" y="5" width="16" height="14" rx="1.5" /><circle cx="9" cy="10" r="1.6" /><path d="m20 16-5-5-8 8" /></>,
    pdf: <><path d="M6 3.5h8l4 4v13H6z" /><path d="M9 14h6M9 17h4" /></>,
    text: <><path d="M6 3.5h8l4 4v13H6z" /><path d="M9 11h6M9 14h6M9 17h3" /></>,
    list: <><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></>,
    grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" /></>,
    link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
    down: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14" /></>,
    up: <><path d="M12 20V9M7.5 13.5 12 9l4.5 4.5M5 4h14" /></>,
    eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
    send: <><path d="M12 19V5M5 12l7-7 7 7" /></>,
    clip: <><path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" /></>,
    lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></>,
    power: <><path d="M12 3v8" /><path d="M6.3 6.8a8 8 0 1 0 11.4 0" /></>,
    restart: <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>,
    research: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.3-4.3" /></>,
    claude: <><path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5-2-6.5L3.5 12 10 10z" /></>,
    test: <><path d="M9 3.5h6M10 3.5v6L5 19a1.5 1.5 0 0 0 1.3 2h11.4A1.5 1.5 0 0 0 19 19l-5-9.5v-6" /></>,
    build: <><path d="m14.5 6.5 3 3M4 20l7.5-7.5M13 4l7 7-3 3-7-7z" /></>,
    shield: <><path d="M12 3 5 6v5.5c0 4.5 3 7.7 7 9.5 4-1.8 7-5 7-9.5V6z" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p[n] ?? p.file}</svg>;
}
const kindIcon = (e: IdxEntry) => e.d ? "folder" : e.k === "image" ? "image" : e.k === "pdf" ? "pdf" : e.k === "text" ? "text" : "file";
const baseName = (p: string) => p.split("/").pop() || p;
const fmtDate = (ms: number) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(ms);

export function SecondWindow({ s, initial }: { s: Snapshot; initial?: string }) {
  const v = useView(s);
  const local = useSyncExternalStore(secondStore.subscribe, secondStore.get);
  const paired = v.link.step === "paired";
  const [tab, setTab] = useState<View>(() => (TABS.some((t) => t.k === initial) ? initial as Tab : paired ? "files" : "setup"));
  const [jump, setJump] = useState<{ device: string; root: string; path: string } | null>(null);
  useEffect(() => {
    const f = (e: Event) => { const t = (e as CustomEvent<string>).detail; if (TABS.some((x) => x.k === t)) setTab(t as Tab); };
    window.addEventListener("ps-second-tab", f);
    return () => window.removeEventListener("ps-second-tab", f);
  }, []);
  // Paired while on Set up: on to Files (Set up leaves the sidebar).
  useEffect(() => { if (paired && tab === "setup") setTab("files"); }, [paired, tab]);
  const open = (t: View) => { if (t !== tab) { click(); setTab(t); } };
  const nav: { k: View; label: string }[] = paired ? TABS : [SETUP, ...TABS];
  const openLink = (link: string) => { const l = parseShareLink(link); if (l) { setJump(l); setTab("files"); } };
  const running = v.jobs.filter(jobRunning).length;
  const unseenMsgs = 0;
  return (
    <div className="sw">
      <aside className="sw-side">
        <div className="sw-brand"><span className="sw-logo"><I n="machine" size={20} /></span><b>Second Computer</b></div>
        <PeerCard v={v} />
        <nav className="sw-nav" aria-label="Second Computer">
          {nav.map((t) => (
            <button key={t.k} type="button" className={tab === t.k ? "sel" : ""} aria-current={tab === t.k ? "page" : undefined} onClick={() => open(t.k)}>
              <I n={t.k === "setup" ? "link" : t.k} /><span>{t.label}</span>
              {t.k === "outsource" && running > 0 && <b className="sw-badge live">{running}</b>}
              {t.k === "messages" && unseenMsgs > 0 && <b className="sw-badge">{unseenMsgs}</b>}
            </button>
          ))}
          <i className="sw-navbar" style={{ transform: `translateY(${Math.max(0, nav.findIndex((t) => t.k === tab)) * 44}px)` }} aria-hidden="true" />
        </nav>
        <div className="sw-me">
          <span>{v.me?.name ?? "This Mac"}</span>
          <em>{v.role === "primary" ? "Primary, sends the work" : v.role === "secondary" ? "Secondary, does the work" : "Not set up"}</em>
        </div>
      </aside>
      <main className="sw-main">
        {paired && tab !== "setup" && v.peer?.silent && <div className="sw-wait-note sw-silent" role="status"><I n="link" size={16} /><span>{status(v, null, Date.now()).text}</span></div>}
        {tab === "setup" ? <SetupPane v={v} pairing={local.pairing} off={local.off} /> : !paired ? <NotPaired key={tab} tab={tab} v={v} onSetup={() => open("setup")} /> : (
          <div className="sw-pane" key={tab}>
            {tab === "files" && <FilesPane v={v} jump={jump} onJumped={() => setJump(null)} />}
            {tab === "messages" && <MessagesPane v={v} onLink={openLink} />}
            {tab === "outsource" && <OutsourcePane v={v} projects={local.projects} onLink={openLink} code={codeJobsOn(settingsData(s))} />}
            {tab === "machine" && <MachinePane v={v} />}
          </div>
        )}
        {local.note && <div className="sw-toast" role="status" key={local.note}>{local.note}</div>}
      </main>
    </div>
  );
}

function PeerCard({ v }: { v: SecondView }) {
  const st = v.stat;
  if (!v.peer || v.link.step !== "paired") {
    const [b, e] = SIDE[v.link.step];
    return <div className={`sw-peer off step-${v.link.step}`}><b>{b}</b><em>{e}</em></div>;
  }
  return (
    <div className={`sw-peer${v.online ? " on" : " off"}${st?.busy ? " busy" : ""}`}>
      <span className="sw-dot" aria-hidden="true" />
      <b>{v.peer.name}</b>
      <em>{v.online ? (st?.busy ? "Online, working" : "Online") : `Offline, last seen ${seenText(st?.at)}`}</em>
      {st && <div className="sw-mini"><Bar label="CPU" pct={st.cpu} />{st.battery !== null && <Bar label={st.power === "ac" ? "Power" : "Battery"} pct={st.battery} warn={st.power === "battery" && st.battery < 25} />}</div>}
    </div>
  );
}
function Bar({ label, pct, warn }: { label: string; pct: number; warn?: boolean }) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  return <span className={`sw-bar${warn ? " warn" : ""}`}><em>{label}</em><i><s style={{ transform: `scaleX(${p / 100})` }} /></i><b>{p}%</b></span>;
}

/** A tab before any second Mac is paired: it opens, says what it is for and what is missing, and leads to Set up. */
function NotPaired({ tab, v, onSetup }: { tab: Tab; v: SecondView; onSetup: () => void }) {
  const label = TABS.find((t) => t.k === tab)?.label ?? "";
  const st = status(v, null, Date.now()), why = `${st.title}. ${st.text}`;
  return (
    <div className="sw-pane sw-wait" role="status">
      <span className="sw-wait-icon" aria-hidden="true"><I n={tab} size={30} /></span>
      <h1>{label}</h1>
      <p>{WAITS[tab]}</p>
      <div className="sw-wait-note"><I n="link" size={16} /><span>{why}</span></div>
      <button type="button" className="sw-primary" onClick={onSetup}>{v.link.step === "idle" ? "Pair my Macs" : "Show me"}</button>
    </div>
  );
}

// ---------- Set up: This Mac, Your other Mac, one button (1 Nov 2026, the developer: "I just click pair, it scans to see
// if my M1 is online and connects for me"). The second Mac answers by itself (src/second/store.ts). ----------
const ROLE_WORD: Record<string, string> = { primary: "main Mac", secondary: "second Mac", none: "no role yet" };
const chipShort = (chip?: string) => (chip ?? "").replace(/^Apple\s+/, "") || null;
const macLine = (d: { chip?: string; model?: string; app?: string }) => [chipShort(d.chip) ?? d.model ?? "Mac", d.app ? `PS app V${d.app}` : null].filter(Boolean).join(" · ");

/** The sidebar card before pairing is done: [bold line, small line]. */
const SIDE: Record<SecondView["link"]["step"], [string, string]> = {
  idle: ["No second Mac yet", "Pair one in Set up"],
  looking: ["Looking for your other Mac", "Pairs by itself"],
  waiting: ["Waiting for your main Mac", "To click Pair"],
  paired: ["Paired", ""],
};

/** What the page says now. `now` ticks while looking, so the wait and the reason stay current. */
function status(v: SecondView, pairing: string | null, now: number): { title: string; text: string; pair?: boolean; spin?: boolean } {
  const o = v.link.other, n = o?.name ?? "your other Mac";
  const why = blocker(o, now);
  switch (v.link.step) {
    case "paired": return o?.silent
      // PS trusts it, but its page has never said hello: on 1 Nov 2026 the M1 still ran the V1.26 page, whose hellos PS
      // dropped, because a web update on the other Mac waits for the developer's click there.
      ? { title: `Paired with ${n}`, text: `${n} has not said hello since it was paired, so nothing can go to it yet. If the gear in its Tab list shows Update available, click it, then Update.` }
      : { title: `Paired with ${n}`, text: "Files, Messages, Outsource and Machine are ready." };
    case "waiting": return { title: "Waiting for your main Mac", text: `Click Pair on your main Mac: this Mac connects by itself.${o && appNum(o.app) < ONE_CLICK_APP && o.role === "primary" ? ` ${n} needs PS V1.26 or newer for that.` : ""}` };
    case "looking": {
      const s = Math.max(0, Math.round((now - (v.link.since ?? now)) / 1000));
      if (now - (v.link.since ?? now) < SEEK_WAIT) return { title: "Looking for your other Mac...", text: o ? `Asking ${n}. It answers by itself while PS app runs there. ${s} s` : `Asking every Mac signed in to your vault. ${s} s`, spin: true };
      // After 30 s no more spinning: what is wrong, in plain words (the developer, 1 Nov 2026).
      return { title: `${o ? n : "Your other Mac"} has not answered`, text: `${why ?? "Is PS app open and signed in on it? It pairs by itself once it is."} PS app keeps looking in the background for a day.`, pair: true };
    }
    case "idle": return { title: pairing ? "Starting..." : "Pair with your other Mac", text: why && o ? why : "One click. PS app finds your other Mac, signed in to the same vault, and connects it. Nothing to do on that Mac.", pair: true };
  }
}

function SetupPane({ v, pairing, off }: { v: SecondView; pairing: string | null; off?: OffInfo | null }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = window.setTimeout(() => setCopied(false), 1600); return () => clearTimeout(t); }, [copied]);
  // A one second tick only while looking (no messages, no network: it only redraws the wait and the reason).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (v.link.step !== "looking") return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [v.link.step]);
  const me = v.me, l = v.link, o = l.other;
  const st = status(v, pairing, Math.max(now, Date.now()));
  const other = v.role === "secondary" ? "primary" : "secondary";
  const oldThere = !o || appNum(o.app) < ONE_CLICK_APP;
  return (
    <div className="sw-pane sw-setup">
      <h1>Your second computer</h1>
      <div className="sw-macs">
        <section className="sw-mac" aria-label="This Mac">
          <small>This Mac</small>
          <b>{me?.name ?? off?.name ?? "This Mac"}</b>
          <span className="sw-macline">{me ? macLine(me) : off ? macLine(off) : "Mac"}</span>
          <em className="sw-macrole">{off ? `Second Computer is off here: ${off.why}` : v.role === "none" ? "No role yet" : `Your ${ROLE_WORD[v.role]}`}{me?.chosen === false && v.role !== "none" ? " (from its chip)" : ""}</em>
          {v.link.step !== "paired" && v.role !== "none" && (
            <button type="button" className="sw-textbtn" onClick={() => { click(); secondActions.run({ op: "role", role: other }); }}>Make this my {ROLE_WORD[other]} instead</button>
          )}
        </section>
        <section className={`sw-mac other${o ? "" : " none"}`} aria-label="Your other Mac">
          <small>Your other Mac</small>
          {o ? <><b>{o.name}</b><span className="sw-macline">{macLine(o)}</span><em className="sw-macrole">{o.off ? "Second Computer is off there" : o.paired || l.step === "paired" ? `Your ${ROLE_WORD[o.role]}, paired` : `Last on ${seenText(o.at)}`}</em></>
            : <><b>Nothing yet</b><span className="sw-macline">No other Mac has said hello</span></>}
        </section>
      </div>
      {off ? (
        // V1.31: off here (4 Nov 2026, the M4's key needed an OK after an update): the reason and the fix, one click.
        <div className="sw-next step-off" role="status" aria-live="polite">
          <h2>{/needs your OK/.test(off.why) ? "PS needs your Mac password once" : "Second Computer is off on this Mac"}</h2>
          <p>{off.here || `Second Computer is off here: ${off.why}.`}</p>
          <div className="sw-fix">
            <button type="button" className="sw-primary" disabled={!!off.allowing} onClick={() => { click(); secondActions.run({ op: "allow" }); }}>
              {off.allowing ? "Waiting for macOS..." : /needs your OK/.test(off.why) ? (off.retried ? "Allow again" : "Allow") : "Try again"}</button>
          </div>
        </div>
      ) : (
      <div className={`sw-next step-${l.step}`} role="status" aria-live="polite">
        <h2>{st.spin && <i className="sw-seek" aria-hidden="true" />}{st.title}</h2>
        <p>{st.text}</p>
        {st.pair && (
          <div className="sw-fix">
            <button type="button" className="sw-primary" disabled={!!pairing} onClick={() => { click(); secondActions.run({ op: "pair" }); }}>{pairing ? "Starting..." : l.step === "looking" ? "Try again" : "Pair with my other Mac"}</button>
          </div>
        )}
      </div>
      )}
      {l.step !== "paired" && oldThere && (
        <div className="sw-linkrow"><code>{DOWNLOAD_LINK}</code><button type="button" onClick={() => { void navigator.clipboard?.writeText(DOWNLOAD_LINK); click(); setCopied(true); }}>{copied ? "Copied" : "Copy link"}</button></div>
      )}
      <p className="sw-fine">Everything travels through your encrypted vault, outbound only. Only a Mac signed in to your vault can pair, and each Mac signs with its own key.</p>
    </div>
  );
}

// ---------- Files: the other Mac's shared folders, like Finder ----------
function FilesPane({ v, jump, onJumped }: { v: SecondView; jump: { device: string; root: string; path: string } | null; onJumped: () => void }) {
  const roots = v.shares.filter((r) => !r.mine).concat(v.shares.filter((r) => r.mine));
  const [rootKey, setRootKey] = useState(() => roots[0] ? `${roots[0].device}/${roots[0].root}` : "");
  const root = roots.find((r) => `${r.device}/${r.root}` === rootKey) ?? roots[0];
  const [dir, setDir] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [mode, setMode] = useState<"list" | "grid">(() => (localGet("sw.files.mode") as "list" | "grid") || "list");
  const [q, setQ] = useState("");
  const [htmlOver, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const caps = useSyncExternalStore(secondStore.subscribe, secondStore.get).caps;
  const native = canNative(caps), place = useDropOver();
  const over = htmlOver || place === "files";
  const max = native && v.peer?.stream ? STREAM_MAX : FILE_MAX;
  useEffect(() => {
    if (!jump) return;
    const r = roots.find((x) => x.device === jump.device && x.root === jump.root);
    if (r) { setRootKey(`${r.device}/${r.root}`); setDir(jump.path.split("/").slice(0, -1).join("/")); setSel(jump.path); }
    onJumped();
  }, [jump]); // eslint-disable-line react-hooks/exhaustive-deps
  const items = useMemo(() => {
    if (!root) return [];
    if (q.trim()) { const n = q.trim().toLowerCase(); return root.entries.filter((e) => baseName(e.p).toLowerCase().includes(n)).slice(0, 300); }
    return listDir(root.entries, dir);
  }, [root, dir, q]);
  const picked = root?.entries.find((e) => e.p === sel) ?? items.find((e) => e.p === sel) ?? null;
  const go = (d: string) => { click(); setDir(d); setSel(null); setQ(""); };
  const peerName = v.peer?.name ?? "the other Mac";
  const canDrop = !!root && !root.mine;
  const send = async (list: FileList | null) => {
    setErr(null);
    let waiting = v.waitingBytes;
    for (const f of Array.from(list || []).slice(0, 20)) {
      const why = fileRefusal(f.size, waiting);
      if (why) { setErr(`${f.name}: ${why}`); continue; }
      waiting += f.size;
      const key = await secondActions.drop(f);
      if (key) secondActions.run({ op: "sendDrop", key, ...(canDrop ? { root: root!.root, dir } : {}) });
    }
    click();
  };
  const crumbs = dir ? dir.split("/") : [];
  const moving = v.files.filter((f) => f.state === "sending" || (f.state === "waiting" && f.pct !== undefined));
  const here: DropTarget = canDrop ? { kind: "files", root: root!.root, dir } : { kind: "files" };
  const peerFolder = canDrop ? `${peerName}'s ${dir ? baseName(dir) : root!.name}` : peerName;
  // Drag out: a press on a file (or folder) arms it; PS starts a real macOS drag once the pointer moves.
  const arm = (e: IdxEntry | null) => secondActions.native({ type: "second:dragArm", item: e && root ? { device: root.device, root: root.root, path: e.p, dir: !!e.d, size: e.s, mine: root.mine } : null });
  return (
    <div className="sw-files" {...dropPlace("files", here)}
      onDragEnter={(e) => { if (!native && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragOver={(e) => { if (!native && e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); void send(e.dataTransfer.files); }}>
      <header className="sw-head">
        <div className="sw-roots" role="tablist">
          {roots.length === 0 && <span className="sw-muted">Waiting for {peerName} to share its PS Shared folder...</span>}
          {roots.map((r) => (
            <button key={`${r.device}/${r.root}`} type="button" role="tab" aria-selected={r === root} className={r === root ? "sel" : ""}
              onClick={() => { click(); setRootKey(`${r.device}/${r.root}`); setDir(""); setSel(null); }}>
              {r.mine ? "This Mac" : peerName}<em>{r.name}</em>
            </button>
          ))}
        </div>
        <div className="sw-tools">
          {native && v.peer && <button type="button" className="sw-send-files" onClick={() => { click(); pickFiles(caps, here, () => {}); }}><I n="up" size={15} /> Send files</button>}
          <input className="sw-search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="sw-seg">
            <button type="button" aria-label="List" className={mode === "list" ? "sel" : ""} onClick={() => { setMode("list"); localSet("sw.files.mode", "list"); }}><I n="list" size={16} /></button>
            <button type="button" aria-label="Grid" className={mode === "grid" ? "sel" : ""} onClick={() => { setMode("grid"); localSet("sw.files.mode", "grid"); }}><I n="grid" size={16} /></button>
          </div>
        </div>
      </header>
      {root && (
        <nav className="sw-crumbs" aria-label="Folder">
          <button type="button" onClick={() => go("")}>{root.name}</button>
          {crumbs.map((c, i) => <span key={i}><i>›</i><button type="button" onClick={() => go(crumbs.slice(0, i + 1).join("/"))}>{c}</button></span>)}
          <span className="sw-crumb-meta">{root.mine ? "Shared from this Mac" : `Updated ${seenText(root.at)}`}</span>
        </nav>
      )}
      <div className="sw-browse">
        <div className={`sw-items ${mode}`} role="listbox" aria-label="Files">
          {root && items.length === 0 && <p className="sw-empty">{q ? "Nothing matches." : canDrop ? `Empty. Drop files here to put them in ${peerName}'s ${dir ? baseName(dir) : root.name}.` : "Empty."}</p>}
          {items.map((e) => (
            <button key={e.p} type="button" role="option" aria-selected={sel === e.p} className={`sw-item${sel === e.p ? " sel" : ""}${e.d ? " dir" : ""}${place === `dir:${e.p}` ? " drop" : ""}`}
              {...(e.d && canDrop ? dropPlace(`dir:${e.p}`, { kind: "files", root: root!.root, dir: e.p }) : {})}
              onPointerDown={(ev) => { if (native && ev.button === 0) arm(e); }} onPointerUp={() => { if (native) arm(null); }}
              onClick={() => { click(); setSel(e.p); }} onDoubleClick={() => { if (e.d) go(e.p); }}>
              <span className={`sw-ic k-${kindIcon(e)}`}><I n={kindIcon(e)} size={mode === "grid" ? 34 : 18} /></span>
              <span className="sw-name">{baseName(e.p)}</span>
              {mode === "list" && <><span className="sw-size">{e.d ? "Folder" : fmtSize(e.s)}</span><span className="sw-date">{e.m ? fmtDate(e.m) : ""}</span></>}
            </button>
          ))}
        </div>
        {picked && root && <Inspector e={picked} root={root} key={picked.p} onOpen={() => go(picked.p)} max={max} />}
      </div>
      {(moving.length > 0 || err) && (
        <footer className="sw-transfers">
          {err && <p className="sw-err">{err}</p>}
          {moving.map((f) => (
            <div key={f.id} className={`sw-xfer${f.stalled ? " stalled" : ""}`} title={fileState(f, peerName)}><I n={f.mine ? "up" : "down"} size={16} /><span>{f.name}{f.stalled && <small>Waiting for {peerName}</small>}</span>
              <i className="sw-prog"><s style={{ transform: `scaleX(${(f.pct ?? 0) / 100})` }} /></i><em>{f.pct ?? 0}%</em></div>
          ))}
        </footer>
      )}
      <div className={`sw-dropveil${over ? " on" : ""}`} aria-hidden={!over}>
        <div><I n="up" size={30} /><b>{canDrop ? `Drop to put it in ${peerFolder}` : `Drop to send it to ${peerName}`}</b>
          <em>{native ? `Files and folders, up to ${fmtSize(max)} each` : `Up to ${fmtSize(FILE_MAX)} a file`}. Sealed end to end; only {peerName} can open it.</em></div>
      </div>
    </div>
  );
}

function Inspector({ e, root, onOpen, max }: { e: IdxEntry; root: ShareRoot; onOpen: () => void; max: number }) {
  const [prev, setPrev] = useState<Preview | null>(null);
  const [asked, setAsked] = useState(false);
  const [copied, setCopied] = useState(false);
  const key = previewKey(root.device, root.root, e.p);
  const previewable = !e.d && !root.mine && (e.k === "image" || e.k === "pdf" || e.k === "text") && e.s <= 10 * 1024 * 1024;
  useEffect(() => { void getPreview(key).then(setPrev); }, [key]);
  useEffect(() => {
    if (!asked || prev) return;
    const t = window.setInterval(() => { void getPreview(key).then((p) => { if (p) setPrev(p); }); }, 1200);
    return () => clearInterval(t);
  }, [asked, prev, key]);
  const url = useMemo(() => prev && prev.mime !== "text/plain" && !prev.mime.startsWith("text/") ? URL.createObjectURL(new Blob([prev.bytes as Uint8Array<ArrayBuffer>], { type: prev.mime })) : null, [prev]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  const text = prev && (prev.mime.startsWith("text/") || e.k === "text") ? new TextDecoder().decode(prev.bytes.subarray(0, 64 * 1024)) : null;
  const link = shareLink(root.device, root.root, e.p);
  return (
    <aside className="sw-insp">
      <div className="sw-insp-art">
        {prev && url && e.k === "image" ? <img src={url} alt="" /> : prev && url && e.k === "pdf" ? <iframe title="Preview" src={url} sandbox="" /> : text !== null ? <pre>{text}</pre>
          : <span className={`sw-ic big k-${kindIcon(e)}`}><I n={kindIcon(e)} size={56} />{asked && !prev && <i className="sw-spin" />}</span>}
      </div>
      <b className="sw-insp-name">{baseName(e.p)}</b>
      <dl><dt>Kind</dt><dd>{e.d ? "Folder" : e.k === "image" ? "Picture" : e.k === "pdf" ? "PDF" : e.k === "text" ? "Text" : "File"}</dd>
        {!e.d && <><dt>Size</dt><dd>{fmtSize(e.s)}</dd></>}
        {e.m > 0 && <><dt>Modified</dt><dd>{fmtDate(e.m)}</dd></>}</dl>
      <div className="sw-insp-acts">
        {e.d ? <>
          <button type="button" className="sw-primary" onClick={onOpen}>Open folder</button>
          {!root.mine && max > FILE_MAX && <button type="button" onClick={() => { click(); secondActions.run({ op: "fetch", device: root.device, root: root.root, path: e.p, as: "download" }); }}><I n="down" size={16} /> Download folder</button>}
        </> : !root.mine && (
          <>
            <button type="button" className="sw-primary" onClick={() => { click(); secondActions.run({ op: "fetch", device: root.device, root: root.root, path: e.p, as: "download" }); }}><I n="down" size={16} /> Download</button>
            {previewable && !prev && <button type="button" onClick={() => { click(); setAsked(true); secondActions.run({ op: "fetch", device: root.device, root: root.root, path: e.p, as: "preview" }); }}><I n="eye" size={16} /> Preview</button>}
          </>
        )}
        {!e.d && <button type="button" onClick={() => { void navigator.clipboard?.writeText(link); setCopied(true); click(); window.setTimeout(() => setCopied(false), 1600); }}><I n="link" size={16} /> {copied ? "Copied" : "Copy link"}</button>}
      </div>
      {!e.d && !root.mine && e.s > max && <p className="sw-fine">Over {fmtSize(max)}: too big to send through the vault{max === FILE_MAX ? " until PS is updated on both Macs" : ""}.</p>}
      {!root.mine && max > FILE_MAX && <p className="sw-fine">Or drag it to Finder: it lands where you drop it.</p>}
    </aside>
  );
}

// ---------- Messages ----------
function Linked({ text, onLink }: { text: string; onLink: (l: string) => void }) {
  const parts = text.split(/(ps:\/\/second\/\S+)/g);
  return <>{parts.map((p, i) => p.startsWith("ps://second/") && parseShareLink(p)
    ? <button key={i} type="button" className="sw-chip" onClick={() => onLink(p)}><I n="link" size={13} />{baseName(parseShareLink(p)!.path)}</button>
    : <span key={i}>{p}</span>)}</>;
}
function MessagesPane({ v, onLink }: { v: SecondView; onLink: (l: string) => void }) {
  const [text, setText] = useState("");
  const [att, setAtt] = useState<{ key: string; name: string; size: number }[]>([]);
  const [htmlOver, setOver] = useState(false);
  const caps = useSyncExternalStore(secondStore.subscribe, secondStore.get).caps;
  const native = canNative(caps), place = useDropOver(), over = htmlOver || place === "msg";
  useEffect(() => onDroppedText((t) => setText((x) => (x ? x + (x.endsWith(" ") ? "" : " ") : "") + t)), []);
  const list = useRef<HTMLDivElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const last = v.msgs[v.msgs.length - 1]?.id;
  useEffect(() => { const el = list.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" }); }, [last]);
  const add = async (fl: FileList | null) => {
    for (const f of Array.from(fl || []).slice(0, 10 - att.length)) {
      if (fileRefusal(f.size, v.waitingBytes)) continue;
      const key = await secondActions.drop(f);
      if (key) setAtt((a) => [...a, { key, name: f.name, size: f.size }]);
    }
  };
  const send = () => {
    if (!text.trim() && !att.length && !v.held.length) return;
    click();
    secondActions.run({ op: "msg", text: text.trim(), keys: att.map((a) => a.key), files: v.held.map((h) => h.id) });
    setText(""); setAtt([]);
  };
  const name = (from: string) => from === "phone" ? "Phone" : v.devices.find((d) => d.device === from)?.name ?? "Mac";
  const fileOf = (id: string) => v.files.find((f) => f.id === id);
  return (
    <div className="sw-msgs" {...dropPlace("msg", { kind: "msg" })} onDragOver={(e) => { if (!native && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); void add(e.dataTransfer.files); }}>
      <header className="sw-head"><h2>Messages</h2><span className="sw-muted">Between this Mac, {v.peer?.name ?? "your other Mac"} and your phone</span></header>
      <div ref={list} className="sw-thread">
        {v.msgs.length === 0 && <p className="sw-empty">Notes you send here show up on your other Mac and your phone. Drop files on the box to attach them.</p>}
        {v.msgs.slice(-200).map((m, i, a) => {
          const prev = a[i - 1];
          const gap = !prev || m.at - prev.at > 20 * 60_000 || prev.from !== m.from;
          return (
            <div key={m.id} className={`sw-bub${m.mine ? " mine" : ""}${gap ? " gap" : ""}`}>
              {gap && <em className="sw-who">{m.mine ? "This Mac" : name(m.from)} · {seenText(m.at)}{!m.mine && !m.phone && !m.verified ? " · not verified" : ""}</em>}
              {m.text && <span className="sw-txt"><Linked text={m.text} onLink={onLink} /></span>}
              {m.files.map((id) => { const f = fileOf(id); return f ? (
                <span key={id} className={`sw-att ${f.state}`}><I n={f.folder ? "folder" : "file"} size={15} /><b>{f.name}</b><em>{fmtSize(f.size)} · {f.state === "landed" ? (m.mine ? "delivered" : "in Downloads, From PS") : f.state === "failed" ? (f.reason || "failed") : f.pct !== undefined ? `on its way, ${f.pct}%` : "on its way"}</em></span>
              ) : null; })}
            </div>
          );
        })}
      </div>
      <div className={`sw-compose${over ? " over" : ""}`}>
        {(att.length > 0 || v.held.length > 0) && <div className="sw-atts">
          {att.map((a) => <span key={a.key} className="sw-chip">{a.name}<em>{fmtSize(a.size)}</em><button type="button" aria-label="Remove" onClick={() => setAtt((x) => x.filter((y) => y.key !== a.key))}>×</button></span>)}
          {v.held.map((h) => <span key={h.id} className="sw-chip">{h.name}{h.pack === "zip" ? " (folder)" : ""}<em>{fmtSize(h.size)}</em><button type="button" aria-label="Remove" onClick={() => secondActions.run({ op: "outboxDrop", id: h.id })}>×</button></span>)}
        </div>}
        <div className="sw-row">
          <button type="button" className="sw-icon" aria-label="Attach files" onClick={() => pickFiles(caps, { kind: "msg" }, () => pick.current?.click())}><I n="clip" /></button>
          <input ref={pick} type="file" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ""; }} />
          <textarea rows={1} value={text} placeholder={`Message ${v.peer?.name ?? "your other Mac"}`} maxLength={4000} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button type="button" className="sw-send" disabled={!text.trim() && !att.length && !v.held.length} onClick={send} aria-label="Send"><I n="send" size={17} /></button>
        </div>
      </div>
    </div>
  );
}

// ---------- Outsource ----------
type Kind = Exclude<JobType, "cancel"> | "code";
const KINDS: { type: Kind; title: string; hint: string; icon: string }[] = [
  { type: "research", title: "Research", hint: "A Claude research project. The report lands in PS Shared, Outsource.", icon: "research" },
  { type: "code", title: CODE_WORDS.kind, hint: CODE_WORDS.kindHint, icon: "claude" },
  { type: "claude", title: "Claude Code task", hint: "A project folder and a prompt. Changes come back as a patch.", icon: "claude" },
  { type: "tests", title: "Run tests", hint: "Any project's tests on your current code.", icon: "test" },
  { type: "selftest", title: "PS app self test", hint: "The full self test, off this Mac.", icon: "shield" },
  { type: "build", title: "Build PS app", hint: "Builds PS app from your current code.", icon: "build" },
];
/** A sealed job's own label: a code job says so (PS 1.65), the rest as before. */
const jobLabel = (j: JobRow) => j.sealed?.kind === "code" ? CODE_WORDS.kind : JOB_LABEL[j.type];
function OutsourcePane({ v, projects, onLink, code }: { v: SecondView; projects: { name: string }[]; onLink: (l: string) => void; code: boolean }) {
  const [form, setForm] = useState<Kind | null>(null);
  // Esc closes an open form (the window itself stays).
  useEffect(() => {
    if (!form) return;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setForm(null); } };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [form]);
  useEffect(() => { if (!code && form === "code") setForm(null); }, [code, form]);
  const kinds = KINDS.filter((k) => k.type !== "code" || (code && !!v.peer?.outsource));
  const [sel, setSel] = useState<string | null>(() => v.jobs[0]?.id ?? null);
  const primary = v.role === "primary";
  const job = v.jobs.find((j) => j.id === sel) ?? null;
  useEffect(() => { if (form === "tests" || form === "claude") secondActions.run({ op: "projects" }); }, [form]);
  const groups: [string, JobRow[]][] = [
    ["Running", v.jobs.filter(jobRunning)],
    ["Waiting", v.jobs.filter((j) => j.state === "sent")],
    ["Finished", v.jobs.filter((j) => !jobRunning(j) && j.state !== "sent")],
  ];
  return (
    <div className="sw-out">
      <section className="sw-out-list">
        <CodeSwitch on={code} primary={primary} peer={v.peer?.name ?? "your other Mac"} />
        {primary && (
          <div className="sw-kinds">
            {kinds.map((k) => (
              <button key={k.type} type="button" className={form === k.type ? "sel" : ""} onClick={() => { click(); setForm(form === k.type ? null : k.type); setSel(null); }}>
                <I n={k.icon} size={18} /><b>{k.title}</b>
              </button>
            ))}
          </div>
        )}
        {groups.map(([g, list]) => list.length > 0 && (
          <div key={g} className="sw-group"><h3>{g}</h3>
            {list.slice(0, 40).map((j) => (
              <button key={j.id} type="button" className={`sw-jrow s-${j.state}${sel === j.id && !form ? " sel" : ""}`} onClick={() => { click(); setSel(j.id); setForm(null); }}>
                <span><b>{jobTitle(j)}</b><em>{jobLabel(j)} · {seenText(j.at)}</em></span>
                <i className="sw-state">{STATE_WORD[j.state]}</i>
              </button>
            ))}
          </div>
        ))}
        {v.jobs.length === 0 && !primary && <p className="sw-empty">No work yet.</p>}
      </section>
      <section className="sw-out-detail">
        {form === "code" ? <CodeJobForm projects={projects} onDone={() => setForm(null)} /> : form ? <NewJob type={form} projects={projects} sealed={!!v.peer?.outsource} onDone={() => setForm(null)} /> : job ? <JobDetail j={job} v={v} primary={primary} onLink={onLink} />
          : <p className="sw-empty">{primary ? "Pick what to outsource, or ask any Claude chat to \"outsource these to my other Mac\". Research runs up to 3 at once on the second Mac, never on this one." : "Jobs from your main Mac show here."}</p>}
      </section>
    </div>
  );
}
const jobTitle = (j: JobRow) => j.type === "research" ? String(j.args.title ?? "Research") : j.type === "claude" ? String(j.args.prompt ?? "").slice(0, 70)
  : j.type === "tests" ? `${String(j.args.project ?? "")} tests` : j.type === "selftest" ? `Self test${j.args.only ? `: ${String(j.args.only)}` : ""}` : "Build PS app";

function NewJob({ type, projects, sealed, onDone }: { type: Exclude<Kind, "code">; projects: { name: string }[]; sealed: boolean; onDone: () => void }) {
  const [project, setProject] = useState("");
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [preset, setPreset] = useState("auto");
  const [only, setOnly] = useState("");
  const [send, setSend] = useState(false);
  const [model, setModel] = useState<"opus" | "sonnet">("opus");
  const [minutes, setMinutes] = useState(type === "research" && sealed ? 20 : 30);
  const needsProject = type === "tests" || type === "claude";
  const titleOk = /^[A-Za-z0-9][A-Za-z0-9 ,'()&+_-]{0,79}$/.test(title.trim());
  const ok = (!needsProject || !!project) && ((type !== "claude" && type !== "research") || prompt.trim().length > 0) && (type !== "research" || titleOk) && (!only || /^[a-z0-9]{1,20}$/.test(only));
  const go = () => {
    if (!ok) return;
    click();
    // v1.3: research goes sealed (post-quantum where both Macs can) once the second Mac's PS takes it.
    if (type === "research" && sealed) { secondActions.run({ op: "outsource", title: title.trim(), prompt: prompt.trim(), model, minutes: Math.min(30, minutes) }); onDone(); return; }
    secondActions.run({ op: "job", type, project: needsProject ? project : undefined, prompt: type === "claude" || type === "research" ? prompt.trim() : undefined,
      preset: type === "tests" ? preset : undefined, only: type === "selftest" && only ? only : undefined, send: type === "build" ? send : undefined,
      title: type === "research" ? title.trim() : undefined, model: type === "claude" || type === "research" ? model : undefined, minutes: type === "claude" || type === "research" ? minutes : undefined });
    onDone();
  };
  const k = KINDS.find((x) => x.type === type)!;
  return (
    <div className="sw-form">
      <h2><I n={k.icon} size={20} /> {k.title}</h2>
      <p className="sw-muted">{k.hint}</p>
      {type === "research" && <label><span>Title</span><input value={title} maxLength={80} placeholder="For example: Shopify review apps for beauty brands" onChange={(e) => setTitle(e.target.value)} /></label>}
      {needsProject && (
        <label><span>Project</span><select value={project} onChange={(e) => setProject(e.target.value)}>
          <option value="">Choose a project</option>{projects.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}</select></label>
      )}
      {(type === "claude" || type === "research") && (
        <label className="grow"><span>{type === "research" ? "What should it find out?" : "What should Claude do?"}</span>
          <textarea rows={7} value={prompt} maxLength={8000} onChange={(e) => setPrompt(e.target.value)}
            placeholder={type === "research" ? "The question, what to compare, which sources to trust, what the report should end with" : "For example: make the failing tests in tests/mail.test.ts pass"} /></label>
      )}
      {(type === "claude" || type === "research") && (
        <div className="sw-inline">
          <label><span>Model</span><select value={model} onChange={(e) => setModel(e.target.value as "opus")}><option value="opus">Opus</option><option value="sonnet">Sonnet</option></select></label>
          <label><span>Up to</span><select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{(type === "research" && sealed ? [10, 20, 30] : [10, 20, 30, 45, 60]).map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></label>
        </div>
      )}
      {type === "tests" && <label><span>Tests</span><select value={preset} onChange={(e) => setPreset(e.target.value)}>{TEST_PRESETS.map((p) => <option key={p} value={p}>{p === "auto" ? "Find them for me" : p}</option>)}</select></label>}
      {type === "selftest" && <label><span>Only one area (optional)</span><input value={only} placeholder="all of it" onChange={(e) => setOnly(e.target.value.toLowerCase())} /></label>}
      {type === "build" && <label className="sw-check"><input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} /> Send the built app back to this Mac</label>}
      <p className="sw-fine">{type === "research" ? `Runs with web search and reading only, in a folder of its own: no commands, no access to your files or projects.${sealed ? " Sealed to the second Mac and signed by this one." : ""}` : "Your current code goes with it, sealed in your vault. Uncommitted changes included; secrets and ignored files never."}</p>
      <div className="sw-acts"><button type="button" onClick={onDone}>Cancel</button><button type="button" className="sw-primary" disabled={!ok} onClick={go}>Send to the second Mac</button></div>
    </div>
  );
}

// ---------- Code jobs (PS 1.65): the switch, the form and the result ----------
/** The person's Code jobs switch (settings.secondCodeJobs, synced). Saved by the main page (the window's ops go there). */
function CodeSwitch({ on, primary, peer }: { on: boolean; primary: boolean; peer: string }) {
  const [copied, setCopied] = useState(false);
  const set = (want: boolean) => { if (want === on) return; click(); secondActions.run({ op: "codeJobs", on: want }); };
  return (
    <div className="sw-code">
      <div className="sw-code-row">
        <span><b>{CODE_WORDS.switchName}</b><em>{on ? CODE_WORDS.switchLine : CODE_WORDS.offNote}</em></span>
        <div className="sw-seg" role="radiogroup" aria-label={CODE_WORDS.switchName}>
          <button type="button" role="radio" aria-checked={on} className={on ? "sel" : ""} onClick={() => set(true)}>On</button>
          <button type="button" role="radio" aria-checked={!on} className={on ? "" : "sel"} onClick={() => set(false)}>Off</button>
        </div>
      </div>
      {on && <p className="sw-fine">{CODE_WORDS.bothMacs}</p>}
      {on && primary && (
        <button type="button" className="sw-code-ai" onClick={() => { void navigator.clipboard?.writeText(aiGuide(peer)); click(); setCopied(true); window.setTimeout(() => setCopied(false), 2400); }}>
          <I n="claude" size={14} /> {copied ? CODE_WORDS.forAICopied : CODE_WORDS.forAI}
        </button>
      )}
    </div>
  );
}

function CodeJobForm({ projects, onDone }: { projects: { name: string }[]; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [repo, setRepo] = useState("");
  const [base, setBase] = useState("main");
  const [prompt, setPrompt] = useState("");
  const [tool, setTool] = useState<CodeTool>("claude");
  const [model, setModel] = useState<"opus" | "sonnet">("opus");
  const [minutes, setMinutes] = useState(CODE_DEFAULT_MINUTES);
  const [shots, setShots] = useState(false);
  const ok = !!repo.trim() && !!base.trim() && !!prompt.trim();
  const go = () => {
    if (!ok) return;
    click();
    secondActions.run({ op: "ocode", job: { title: title.trim() || undefined, repo: repo.trim(), base: base.trim(), prompt: prompt.trim(), tool, model: tool === "claude" ? model : undefined, minutes, shots } });
    onDone();
  };
  return (
    <div className="sw-form">
      <h2><I n="claude" size={20} /> {CODE_WORDS.kind}</h2>
      <p className="sw-muted">{CODE_WORDS.kindHint}</p>
      <label><span>Title</span><input value={title} maxLength={80} placeholder="For example: Make the mail tests pass" onChange={(e) => setTitle(e.target.value)} /></label>
      <div className="sw-inline">
        <label><span>{CODE_WORDS.repo}</span><input value={repo} list="sw-code-repos" maxLength={300} placeholder={CODE_WORDS.repoHint} onChange={(e) => setRepo(e.target.value)} /></label>
        <label><span>{CODE_WORDS.base}</span><input value={base} maxLength={100} placeholder={CODE_WORDS.baseHint} onChange={(e) => setBase(e.target.value)} /></label>
      </div>
      <datalist id="sw-code-repos">{projects.map((p) => <option key={p.name} value={p.name} />)}</datalist>
      <label className="grow"><span>{CODE_WORDS.ask}</span>
        <textarea rows={6} value={prompt} maxLength={20_000} onChange={(e) => setPrompt(e.target.value)} placeholder={CODE_WORDS.askHint} /></label>
      <div className="sw-inline">
        <label><span>{CODE_WORDS.tool}</span><select value={tool} onChange={(e) => setTool(e.target.value === "codex" ? "codex" : "claude")}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
        {tool === "claude" && <label><span>Model</span><select value={model} onChange={(e) => setModel(e.target.value as "opus")}><option value="opus">Opus</option><option value="sonnet">Sonnet</option></select></label>}
        <label><span>Up to</span><select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>{CODE_MINUTE_CHOICES.map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`}</option>)}</select></label>
      </div>
      <label className="sw-check"><input type="checkbox" checked={shots} onChange={(e) => setShots(e.target.checked)} /> {CODE_WORDS.shots}</label>
      <p className="sw-fine">{CODE_WORDS.fine}</p>
      <div className="sw-acts"><button type="button" onClick={onDone}>Cancel</button><button type="button" className="sw-primary" disabled={!ok} onClick={go}>Send to the second Mac</button></div>
    </div>
  );
}

function CodeResult({ j }: { j: JobRow }) {
  const c = j.sealed?.code, [copied, setCopied] = useState(false);
  const line = codeLine(c);
  return (
    <div className="sw-coderes">
      {line && <p className="sw-fine">{line}{c?.base ? ` · base ${c.base.slice(0, 10)}` : ""}</p>}
      {c?.files && c.files.length > 0 && <pre className="sw-log sw-stat">{c.files.slice(0, 12).join("\n")}</pre>}
      {j.sealed?.bundle ? (
        <div className="sw-acts left">
          <span className="sw-chip"><I n="file" size={14} />{CODE_WORDS.landed} {j.sealed.bundle}</span>
          {j.sealed.fetch && <button type="button" onClick={() => { void navigator.clipboard?.writeText(j.sealed!.fetch!); click(); setCopied(true); window.setTimeout(() => setCopied(false), 2400); }}>{copied ? CODE_WORDS.copied : CODE_WORDS.fetch}</button>}
        </div>
      ) : j.state === "done" && (c?.commits ?? 0) > 0 && !j.sealed?.bundleProblem ? <p className="sw-fine">{CODE_WORDS.waiting}</p> : null}
      {j.sealed?.bundleProblem && <p className="sw-step">{j.sealed.bundleProblem}</p>}
      {j.sealed?.bundle && <p className="sw-fine">{CODE_WORDS.noMerge}</p>}
    </div>
  );
}

function JobDetail({ j, v, primary, onLink }: { j: JobRow; v: SecondView; primary: boolean; onLink: (l: string) => void }) {
  const st = j.status;
  const took = st?.startedAt ? Math.round(((st.endedAt ?? Date.now()) - st.startedAt) / 1000) : null;
  const result = st?.result ? v.files.find((f) => f.id === st.result) : undefined;
  const log = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = log.current; if (el && jobRunning(j)) el.scrollTop = el.scrollHeight; }, [st?.tail, j]);
  const folder = j.type === "research" && v.peer ? v.shares.find((r) => r.device === v.peer!.device) : undefined;
  const outDir = folder?.entries.filter((e) => e.d && e.p.startsWith("Outsource/") && e.p.endsWith(String(j.args.title ?? "\u0000"))).sort((a, b) => b.m - a.m)[0];
  return (
    <div className="sw-jd">
      <header><span className={`sw-state big s-${j.state}`}>{STATE_WORD[j.state]}</span><h2>{jobTitle(j)}</h2></header>
      <p className="sw-muted">{jobLabel(j)} · sent {seenText(j.at)}{took !== null ? ` · ${fmtDur(took)}` : ""}{st?.exit !== undefined ? ` · exit ${st.exit}` : ""}</p>
      {(st?.reason || st?.summary || st?.step) && <p className="sw-step">{st?.reason || st?.summary || st?.step}</p>}
      {j.sealed && <p className="sw-fine">Sealed with {suiteWords(j.sealed.suite)}{j.sealed.folder ? ` · copy in ${j.sealed.folder}` : ""}</p>}
      {j.sealed?.kind === "code" && <CodeResult j={j} />}
      {j.type !== "research" && j.type !== "claude" ? null : j.sealed?.kind === "code" ? null : <blockquote>{String(j.args.prompt ?? "")}</blockquote>}
      <pre ref={log} className="sw-log">{st?.tail || (j.state === "sent" ? "Waiting for the second Mac to pick it up..." : "No output yet.")}</pre>
      {st?.files && st.files.length > 0 && <p className="sw-fine">Changed: {st.files.slice(0, 20).join(", ")}{st.files.length > 20 ? ` and ${st.files.length - 20} more` : ""}</p>}
      <div className="sw-acts left">
        {result && <span className="sw-chip"><I n="file" size={14} />{result.name} · {result.state === "landed" ? "in Downloads, From PS" : "on its way"}</span>}
        {outDir && folder && <button type="button" onClick={() => onLink(shareLink(folder.device, folder.root, outDir.p + "/report.md"))}><I n="folder" size={16} /> Open in Files</button>}
        {primary && jobRunning(j) && <button type="button" onClick={() => { click(); secondActions.run({ op: "cancel", job: j.id }); }}>Stop this job</button>}
      </div>
    </div>
  );
}
const fmtDur = (s: number) => s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

// ---------- Machine ----------
function MachinePane({ v }: { v: SecondView }) {
  const [confirm, setConfirm] = useState<"restart" | "shutdown" | null>(null);
  const primary = v.role === "primary";
  const m = v.machine;
  const dl = machineMs(m?.timer?.deadline);
  const left = timerOn(m) && dl ? dl - Date.now() : null;
  return (
    <div className="sw-mach">
      <header className="sw-head"><h2>Machine</h2><span className="sw-muted">Read only status. PS app never changes your Mac's settings; it tells you where to switch them.</span></header>
      {left !== null && left > 0 && left < 3_600_000 && <div className="sw-warn">{v.peer?.name} restarts by its auto reboot timer in {Math.max(1, Math.round(left / 60_000))} minutes. Unlocking it at the Mac resets the timer.</div>}
      <div className="sw-cards">
        <MachineCard title={v.peer?.name ?? "Second Mac"} st={v.stat} online={v.online} away={v.role === "primary"} />
        <MachineCard title={`${v.me?.name ?? "This Mac"} (this Mac)`} st={v.myStat} online away={v.role === "secondary"} />
      </div>
      {v.phones.length > 0 && (
        <section className="sw-remote">
          <h3>Your phone</h3>
          <p className="sw-fine">A trusted phone can Restart, Shut down and Lock this Mac (after your fingerprint on the phone), never run jobs. Trust shows a six digit code here and on the phone; trust only if they match.</p>
          {v.phones.map((p) => (
            <div key={p.device} className="sw-pairrow">
              <span><b>{p.name}</b><em>{p.trusted ? "Trusted for restart, shut down and lock" : `Asked ${seenText(p.at)}`}</em></span>
              {p.trusted
                ? <button type="button" onClick={() => { click(); secondActions.run({ op: "unpair", device: p.device }); }}>Remove</button>
                : <button type="button" className="sw-primary" onClick={() => { click(); secondActions.run({ op: "trustPhone", device: p.device }); }}>Trust phone</button>}
            </div>
          ))}
        </section>
      )}
      {/* This Mac's auto reboot and restart helper settings (RebootCard.tsx), one place on the Mac. */}
      <RebootCard />
      {primary && v.peer && (
        <section className="sw-remote">
          <h3>Remote control of {v.peer.name}</h3>
          <p className="sw-fine">Signed by this Mac, good for 2 minutes, and refused if replayed. After a restart or shut down, {v.peer.name} stays offline for Second Computer until someone logs in at it: FileVault locks the disk, which is the point.</p>
          {m?.helper && m.helper !== "approved" && <p className="sw-warn">Restart and shut down need PS's restart helper approved once on {v.peer.name}: System Settings, General, Login Items & Extensions, Background App Activity. If it already looks on, switch it off and then on again.</p>}
          {confirm ? (
            <div className="sw-confirm">
              <b>{confirm === "restart" ? `Restart ${v.peer.name}?` : `Shut down ${v.peer.name}?`}</b>
              <em>{confirm === "restart" ? "Running jobs stop. It comes back only after you log in at it." : "Running jobs stop. It stays off until someone turns it on and logs in."} If someone is using it, it shows a 10 second Cancel first.</em>
              <div className="sw-acts left">
                <button type="button" className="sw-danger" onClick={() => { click(); secondActions.run({ op: "cmd", action: confirm }); setConfirm(null); }}>{confirm === "restart" ? "Restart now" : "Shut down now"}</button>
                <button type="button" onClick={() => setConfirm(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="sw-acts left">
              <button type="button" onClick={() => { click(); secondActions.run({ op: "cmd", action: "lock" }); }}><I n="lock" size={16} /> Lock now</button>
              <button type="button" onClick={() => { click(); setConfirm("restart"); }}><I n="restart" size={16} /> Restart</button>
              <button type="button" onClick={() => { click(); setConfirm("shutdown"); }}><I n="power" size={16} /> Shut down</button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
/** `away`: the Mac that sits at home doing the work, where awake and locked matter (on the Mac in front of the developer they do not). */
function MachineCard({ title, st, online, away }: { title: string; st: StatBody | null; online: boolean; away: boolean }) {
  const m: Machine | undefined = st?.machine;
  const row = (k: string, val: React.ReactNode, good?: boolean | null, fix?: string) => (
    <div className="sw-mrow"><span>{k}</span><b className={good === true ? "good" : good === false ? "bad" : ""}>{val}</b>{fix && good === false && <em>{fix}</em>}</div>
  );
  const dl = machineMs(m?.timer?.deadline);
  const left = timerOn(m) && dl ? Math.max(0, dl - Date.now()) : null;
  return (
    <article className="sw-mcard">
      <h3><span className={`sw-dot${online ? " on" : ""}`} />{title}</h3>
      {!st ? <p className="sw-fine">No status yet.</p> : (
        <>
          {row("Status", online ? (st.busy ? "Online, working" : "Online") : `Offline since ${seenText(st.at)}`, online)}
          {row("CPU", `${Math.round(st.cpu)}%`)}
          {st.mem !== undefined && row("Memory", `${Math.round(st.mem)}%`)}
          {row("Power", st.power === "ac" ? (st.charging ? "Charging" : "Plugged in") : `Battery ${st.battery ?? "?"}%`, st.power === "ac" ? true : (st.battery ?? 100) < 25 ? false : null, "Plug it in to keep it awake")}
          {st.disk !== undefined && row("Free disk", `${Math.round(st.disk)} GB`, st.disk < 10 ? false : null, "Under 10 GB: builds may fail")}
          {m && <>
            {row("Kept awake", m.awake ? "Yes, on power" : "No", away ? m.awake ?? null : null, "Plug it in; PS app keeps it awake while it is the secondary")}
            {row("Screen", m.locked ? "Locked" : "Unlocked", away ? m.locked ?? null : null, "Use Lock now below, or Control, Command, Q at it")}
            {row("FileVault", m.fileVault === "on" ? "On" : m.fileVault === "off" ? "Off" : "Unknown", m.fileVault === "on" ? true : m.fileVault === "off" ? false : null, "System Settings, Privacy & Security, FileVault: turn it on")}
            {row("Password after sleep", m.passwordImmediately ? "Immediately" : m.passwordImmediately === false ? "Delayed" : "Unknown", m.passwordImmediately ?? null, "System Settings, Lock Screen: Require password Immediately")}
            {row("Auto reboot", m.timer?.safeMode ? "Paused (Safe Mode)" : timerOn(m) ? `Every ${m.timer!.hours} h${left !== null ? `, next in ${fmtLeft(left)}` : ""}`
              : m.timer?.mode === "watch" ? `Watch only, ${m.timer.hours} h (logs, never restarts)` : "Off",
              timerOn(m) ? true : m.timer?.mode === "watch" ? null : away ? false : null, "Turn it on in PS app Settings on that Mac")}
            {m.lastRestart && row("Last restart", `${m.lastRestart.kind === "remote" ? "From your primary" : m.lastRestart.kind === "shutdown" ? "Shut down" : "Auto reboot"}, ${seenText(machineMs(m.lastRestart.at))}`)}
          </>}
          {st.app && row("PS", st.app)}
        </>
      )}
    </article>
  );
}
const fmtLeft = (ms: number) => { const h = Math.floor(ms / 3_600_000), mm = Math.round((ms % 3_600_000) / 60_000); return h ? `${h} h ${mm} min` : `${mm} min`; };

function localGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private window */ } }
