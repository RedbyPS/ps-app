// Network monitor (PS only, the developer 18 Oct 2026): what this Mac sends and receives, which apps talk to
// where, whether the VPN holds, a speed test and the Wi-Fi signal. A "Network" button in the Tab
// list's gear menu opens it with a CLICK (never on hover); it fills almost the whole screen like
// Dimension X and Cincee Campaigns. Esc or the minimize button closes it (the Tab list stays).
//
// All the numbers come from PS on the Mac (ps-mac/Sources/NetMonitor.swift) through the bridge,
// only while this window is open. Nothing here touches the vault, Supabase or any server: the page
// only shows what PS hands it. 1Password and Signal never appear (PS drops them before anything
// reaches the page); only the whole-network totals include their bytes.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PS, psPost, useAppIcons } from "../ps";
import { sfx } from "../ui/sfx";
import { morph } from "./DimensionX";
import { vaultStore } from "../core/vault";
import { secondOnSnap } from "../core/secondsnap";
import { secondLocal } from "../second/store";
import { byDay, CAUSES, causeOf, devicesSeen, dropStats, dur, type Drop, type Uptime } from "../core/lastonline";
import "./cstats.css";
import "./netmonitor.css";

// ---------- what PS sends ----------
type Pair = [number, number];                       // [received, sent]
type Kind = "vpn" | "wifi" | "ethernet" | "other";
type Iface = { name: string; kind: Kind; label: string; rx: number; tx: number; primary: boolean };
type AppRow = { name: string; id: string; system: boolean; rx: number; tx: number; rxT: number; txT: number; conns: number; procs: number };
type ConnRow = { app: string; id: string; proto: string; ip: string; port: number; iface: string; kind: string; state: string; rxT: number; txT: number;
  rx: number; tx: number; since: number; public: boolean; leak: boolean; tunnel: boolean; cc?: string; host?: string };
type Leak = { app: string; ip: string; port: number; iface: string; proto: string; cc: string; at?: number };
type Vpn = { up: boolean; iface: string; address: string; servers: { ip: string; cc: string }[]; daemon: string; physical: string; gateway: string;
  dns: string[]; leaks: Leak[]; log: Leak[]; events: { at: number; up: boolean; iface: string }[]; alarm: boolean;
  vpnApp?: { state: string; city: string; country: string; host: string; entry: string; lockdown: boolean; blocking: boolean; features: string[] };
  blocked?: (Leak & { at: number; n: number })[]; netlog?: { at: number; tone: string; text: string }[] };
type Wifi = { available: boolean; iface?: string; power?: boolean; rssi?: number; noise?: number; snr?: number; rate?: number; channel?: number;
  band?: string; width?: number; phy?: string; connected?: boolean };
type Snap = { at: number; ifaces: Iface[]; series: { t: number; k: Partial<Record<Kind, Pair>> }[]; totals: { today: Partial<Record<Kind, Pair>>; week: Partial<Record<Kind, Pair>> };
  primary: string; apps?: AppRow[]; conns?: ConnRow[]; connCount?: number; vpn?: Vpn; wifi?: Wifi };
type Settings = { live: boolean; apps: boolean; conns: boolean; vpn: boolean; speed: boolean; wifi: boolean; countries: boolean; rdns: boolean;
  refresh: number; history: boolean; keepDays: number; alarm: boolean; alarmPopup: boolean; units: "bits" | "bytes";
  cardVpn?: boolean; cardOffline?: boolean; cardConn?: boolean; uptime?: boolean };
type SpeedTest = { at: number; down: number; up: number; rtt: number; rpm: number; iface: string; server: string };
type Speed = { running: boolean; startedAt: number; error: string; tests: SpeedTest[] };
type History = { on: boolean; days: { day: string; k: Partial<Record<Kind, Pair>>; apps: { name: string; rx: number; tx: number }[] }[]; note: string };
type NetState = { snap: Snap | null; settings: Settings | null; speed: Speed | null; history: History | null; uptime: Uptime | null };

let net: NetState = { snap: null, settings: null, speed: null, history: null, uptime: null };
const listeners = new Set<() => void>();
function apply(m: { kind?: string } & Record<string, unknown>) {
  if (m.kind === "snap") net = { ...net, snap: m as unknown as Snap };
  else if (m.kind === "settings") net = { ...net, settings: m.settings as Settings };
  else if (m.kind === "speed") net = { ...net, speed: m as unknown as Speed };
  else if (m.kind === "history") net = { ...net, history: m as unknown as History };
  else if (m.kind === "uptime") net = { ...net, uptime: m as unknown as Uptime };
  else return;
  listeners.forEach((l) => l());
}
if (PS && typeof window !== "undefined") (window as { __psNet?: typeof apply }).__psNet = apply;
function useNet() { return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => net); }
const ask = (op: string, extra: object = {}) => psPost({ type: "net", op, ...extra });

// ---------- formatting ----------
function rate(bytesPerSec: number, units: "bits" | "bytes") {
  const v = units === "bits" ? bytesPerSec * 8 : bytesPerSec;
  const u = units === "bits" ? ["b/s", "Kb/s", "Mb/s", "Gb/s"] : ["B/s", "KB/s", "MB/s", "GB/s"];
  let i = 0, x = v;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return { n: x >= 100 || i === 0 ? Math.round(x).toString() : x.toFixed(x >= 10 ? 1 : 2), u: u[i] };
}
const rateText = (b: number, units: "bits" | "bytes") => { const r = rate(b, units); return `${r.n} ${r.u}`; };
function size(bytes: number) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, x = bytes;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${u[i]}`;
}
const flag = (cc?: string) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "");
let regionNames: Intl.DisplayNames | null = null;
function countryName(cc?: string) {
  if (!cc) return "";
  try { regionNames ??= new Intl.DisplayNames(["en"], { type: "region" }); return regionNames.of(cc) || cc; } catch { return cc; }
}
function since(ms: number) {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}
const clock = (ms: number) => new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const KIND_LABEL: Record<Kind, string> = { vpn: "VPN", wifi: "Wi-Fi", ethernet: "Ethernet", other: "Other" };

// ---------- the button (gear menu) and the window ----------
type Tab = "live" | "uptime" | "apps" | "vpn" | "speed" | "wifi" | "history" | "settings";
const TABS: { id: Tab; label: string; need?: keyof Settings }[] = [
  { id: "live", label: "Live", need: "live" }, { id: "uptime", label: "Last online", need: "uptime" }, { id: "apps", label: "Apps", need: "apps" }, { id: "vpn", label: "VPN watch", need: "vpn" },
  { id: "speed", label: "Speed test", need: "speed" }, { id: "wifi", label: "Wi-Fi", need: "wifi" }, { id: "history", label: "History", need: "history" },
  { id: "settings", label: "Settings" },
];
const MORPH = { body: ".cs-content", tint: ".cs-morph" };

/** The "Network" row in the gear menu. Click opens the monitor; it never opens on hover. */
export function NetButton() {
  const [phase, setPhase] = useState<"closed" | "open" | "closing">("closed");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const btn = useRef<HTMLButtonElement>(null), win = useRef<HTMLElement>(null), dim = useRef<HTMLDivElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(btn.current?.closest<HTMLElement>(".tm-overlay") ?? null); }, []);

  const open = () => { if (phaseRef.current === "open") return; sfx.click(); setPhase("open"); };
  const close = () => { if (phaseRef.current !== "open") return; sfx.drop(); setPhase("closing"); };

  useLayoutEffect(() => {
    if (phase === "open") {
      psPost({ type: "dimx", open: true });          // PS pins the list and gives it the keyboard (Esc comes back here)
      ask("open");
      void morph(win.current, btn.current, dim.current, "in", MORPH);
    } else if (phase === "closing") {
      psPost({ type: "dimx", open: false });
      ask("close");
      void morph(win.current, btn.current, dim.current, "out", MORPH).then(() => setPhase((p) => (p === "closing" ? "closed" : p)));
    }
  }, [phase]);
  useEffect(() => {
    if (phase !== "open") return;
    const escape = () => { close(); return true; };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); escape(); } };
    const w = window as Window & { __psDimxClose?: () => boolean };
    window.addEventListener("keydown", key, true);
    w.__psDimxClose = escape;
    return () => { window.removeEventListener("keydown", key, true); if (w.__psDimxClose === escape) delete w.__psDimxClose; };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps
  // The list went away with the monitor open: PS stops polling by itself; this keeps the page in step.
  useEffect(() => () => { if (phaseRef.current === "open") ask("close"); }, []);
  // The self test opens it and picks a view without clicks.
  useEffect(() => {
    const on = (e: Event) => { open(); const t = (e as CustomEvent).detail; if (typeof t === "string") window.setTimeout(() => window.dispatchEvent(new CustomEvent("nm-tab", { detail: t })), 0); };
    window.addEventListener("ps-net-open", on);
    return () => window.removeEventListener("ps-net-open", on);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <button ref={btn} type="button" className={`tm-pill-btn icon nm-btn${phase !== "closed" ? " on" : ""}`} onClick={(e) => { if (e.button === 0) open(); }} aria-expanded={phase === "open"} aria-label="Open the network monitor" title="Network monitor (this Mac only)">
        {/* an Ethernet port */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h18v12h-4.5v3h-9v-3H3z" /><path d="M7.5 9v3M10.5 9v3M13.5 9v3M16.5 9v3" /></svg>
      </button>
      {phase !== "closed" && host && createPortal(
        <div className="dx-layer cs-layer nm-layer" onMouseDown={(e) => e.stopPropagation()}>
          <div ref={dim} className="cs-dim" onMouseDown={close} aria-hidden="true" />
          <section ref={win} className="cs-win nm-win" role="dialog" aria-modal="true" aria-label="Network monitor">
            <div className="cs-morph" aria-hidden="true" />
            <div className="cs-glow" aria-hidden="true" />
            <div className="cs-content"><Monitor onClose={close} /></div>
          </section>
        </div>, host)}
    </>
  );
}

function Monitor({ onClose }: { onClose: () => void }) {
  const { snap, settings, speed, history, uptime } = useNet();
  const s = settings;
  const tabs = TABS.filter((t) => !t.need || !s || s[t.need]);
  const [tab, setTab] = useState<Tab>("live");
  useEffect(() => { if (!tabs.some((t) => t.id === tab)) setTab(tabs[0].id); }, [tabs, tab]);
  useEffect(() => {
    const on = (e: Event) => { const t = (e as CustomEvent).detail as Tab; if (TABS.some((x) => x.id === t)) setTab(t); };
    window.addEventListener("nm-tab", on);
    return () => window.removeEventListener("nm-tab", on);
  }, []);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (el) setInk({ left: el.offsetLeft, width: el.offsetWidth });
  }, [tab, tabs.length]);
  const units = s?.units || "bits";
  const vpn = snap?.vpn;
  const leaks = vpn?.leaks.length ?? 0;
  return (
    <>
      <header className="cs-head nm-head">
        <button type="button" className="cs-min" onClick={onClose} aria-label="Close the network monitor" title="Back to the Tab list (Esc)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
        </button>
        <div className="cs-title"><span className="cs-eyebrow">This Mac only</span><h2>Network</h2></div>
        <div className="cs-fresh">
          {vpn && <VpnPill v={vpn} />}
          {vpn && vpn.alarm && <span className={`nm-pill ${leaks ? "bad" : "good"}`}>{leaks ? `${leaks} possible leak${leaks > 1 ? "s" : ""} now` : "No leaks"}</span>}
          {snap && <span className="cs-thru">Updated every {s?.refresh ?? 2} s. Nothing here leaves this Mac</span>}
        </div>
        <nav className="cs-tabs" ref={tabsRef} role="tablist" aria-label="Views">
          {ink && <span className="cs-ink" style={{ transform: `translateX(${ink.left}px)`, width: ink.width }} aria-hidden="true" />}
          {/* Click only (the developer, 18 Oct 2026): a tab never switches just because the mouse rests on it. */}
          {tabs.map((t) => <button key={t.id} type="button" data-tab={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : undefined}
            onClick={() => { if (tab !== t.id) { sfx.hover(); setTab(t.id); } }}>{t.label}</button>)}
        </nav>
      </header>
      <div className="cs-scroll">
        {!snap && tab !== "settings" && tab !== "uptime" ? <p className="cs-none nm-wait">Reading the network...</p> : (
          <div className="cs-view" key={tab}>
            {tab === "live" && snap && <Live snap={snap} units={units} />}
            {tab === "apps" && snap && <Apps snap={snap} units={units} showConns={!!s?.conns} />}
            {tab === "vpn" && snap && <VpnView snap={snap} />}
            {tab === "speed" && <SpeedView speed={speed} units={units} />}
            {tab === "wifi" && snap && <WifiView w={snap.wifi} />}
            {tab === "history" && <HistoryView h={history} />}
            {tab === "uptime" && <UptimeView u={uptime} />}
            {tab === "settings" && s && <SettingsView s={s} />}
          </div>
        )}
      </div>
    </>
  );
}

function Card({ title, sub, right, children, className }: { title: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`cs-card${className ? ` ${className}` : ""}`}>
      <header className="cs-card-h"><h3>{title}</h3>{sub && <span className="cs-card-sub">{sub}</span>}{right && <span className="cs-card-r">{right}</span>}</header>
      {children}
    </section>
  );
}
const Shield = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>;

// ---------- Live ----------
function Live({ snap, units }: { snap: Snap; units: "bits" | "bytes" }) {
  const vpnUp = !!snap.vpn?.up;
  const kinds = useMemo(() => {
    const set = new Set<Kind>();
    snap.series.forEach((p) => (Object.keys(p.k) as Kind[]).forEach((k) => set.add(k)));
    return (["vpn", "ethernet", "wifi", "other"] as Kind[]).filter((k) => set.has(k));
  }, [snap.series]);
  const [pick, setPick] = useState<Kind>(vpnUp ? "vpn" : "ethernet");
  const k = kinds.includes(pick) ? pick : kinds[0] || "vpn";
  const last = snap.series[snap.series.length - 1]?.k[k] || [0, 0];
  const down = rate(last[0], units), up = rate(last[1], units);
  const rows = (["vpn", "wifi", "ethernet", "other"] as Kind[]).filter((x) => snap.totals.today[x] || snap.totals.week[x]);
  const busy = [...(snap.apps || [])].filter((a) => a.rx + a.tx > 0).sort((a, b) => b.rx + b.tx - (a.rx + a.tx)).slice(0, 6);
  return (
    <>
      <div className="nm-live">
        <div className="cs-tile t-pink big nm-big"><span className="cs-tile-l">Download now · {KIND_LABEL[k]}</span><span className="cs-tile-v">{down.n} <small>{down.u}</small></span></div>
        <div className="cs-tile t-purple big nm-big"><span className="cs-tile-l">Upload now · {KIND_LABEL[k]}</span><span className="cs-tile-v">{up.n} <small>{up.u}</small></span></div>
        <Card title="Last few minutes" className="nm-graphcard" right={
          <span className="nm-seg">{kinds.map((x) => <button key={x} type="button" className={x === k ? "on" : ""} onClick={() => { sfx.hover(); setPick(x); }}>{KIND_LABEL[x]}</button>)}</span>}>
          <Graph series={snap.series} k={k} units={units} />
        </Card>
      </div>
      <div className="cs-two">
        <Card title="Totals" sub="Received and sent, counted while PS app runs">
          <table className="cs-table nm-table">
            <thead><tr><th>Network</th><th className="num">Today down</th><th className="num">Today up</th><th className="num">This week down</th><th className="num">This week up</th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x}><td className="nm">{KIND_LABEL[x]}</td>
                <td className="num">{size(snap.totals.today[x]?.[0] || 0)}</td><td className="num">{size(snap.totals.today[x]?.[1] || 0)}</td>
                <td className="num">{size(snap.totals.week[x]?.[0] || 0)}</td><td className="num">{size(snap.totals.week[x]?.[1] || 0)}</td></tr>))}
            </tbody>
          </table>
          {vpnUp && <p className="cs-foot">Ethernet and Wi-Fi also carry the VPN's encrypted copy of everything, so their numbers include the VPN traffic again.</p>}
        </Card>
        <Card title="Networks right now">
          <ul className="nm-ifs">
            {snap.ifaces.map((i) => (
              <li key={i.name} className={`k-${i.kind}`}>
                <span className="nm-if-n"><b>{i.label}</b><em>{i.name}{i.primary ? " · everything goes here" : ""}</em></span>
                <span className="nm-if-v"><i className="dn">↓</i>{rateText(i.rx, units)}</span>
                <span className="nm-if-v"><i className="up">↑</i>{rateText(i.tx, units)}</span>
              </li>))}
          </ul>
        </Card>
      </div>
      {busy.length > 0 && (
        <Card title="Busiest apps right now" sub="All apps and their connections are in Apps">
          <ul className="nm-busy">
            {busy.map((a) => (
              <li key={a.name}><b>{a.name}</b><span className="nm-if-v"><i className="dn">↓</i>{rateText(a.rx, units)}</span><span className="nm-if-v"><i className="up">↑</i>{rateText(a.tx, units)}</span></li>))}
          </ul>
        </Card>)}
    </>
  );
}

function Graph({ series, k, units }: { series: Snap["series"]; k: Kind; units: "bits" | "bytes" }) {
  const W = 900, H = 190;
  const pts = series.slice(-120);
  const max = Math.max(1, ...pts.map((p) => Math.max(p.k[k]?.[0] || 0, p.k[k]?.[1] || 0)));
  const x = (i: number) => (pts.length < 2 ? 0 : (i / (pts.length - 1)) * W);
  const y = (v: number) => H - 6 - (v / max) * (H - 18);
  const line = (j: 0 | 1) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.k[k]?.[j] || 0).toFixed(1)}`).join(" ");
  const area = pts.length > 1 ? `${line(0)} L${W},${H} L0,${H} Z` : "";
  return (
    <div className="nm-graph">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="Download and upload speed over the last few minutes">
        <defs><linearGradient id="nm-dn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#EC4E86" stopOpacity=".55" /><stop offset="1" stopColor="#EC4E86" stopOpacity="0" /></linearGradient></defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="nm-grid" />)}
        {area && <path d={area} fill="url(#nm-dn)" />}
        {pts.length > 1 && <path d={line(0)} className="nm-l-dn" />}
        {pts.length > 1 && <path d={line(1)} className="nm-l-up" />}
      </svg>
      <span className="nm-graph-max">{rateText(max, units)}</span>
      <span className="nm-legend"><i className="dn" />Download <i className="up" />Upload</span>
    </div>
  );
}

// ---------- Apps and connections ----------
function Apps({ snap, units, showConns }: { snap: Snap; units: "bits" | "bytes"; showConns: boolean }) {
  const apps = useMemo(() => [...(snap.apps || [])].sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx) || (b.rxT + b.txT) - (a.rxT + a.txT) || b.conns - a.conns), [snap.apps]);
  const icons = useAppIcons(apps.map((a) => a.id).filter(Boolean).slice(0, 40));
  const [only, setOnly] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const conns = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (snap.conns || []).filter((c) => (!only || c.app === only)
      && (!needle || [c.app, c.ip, c.host, c.cc, countryName(c.cc), String(c.port), c.iface].some((v) => (v || "").toLowerCase().includes(needle))));
  }, [snap.conns, only, q]);
  return (
    <>
      <Card title="Apps using the network" sub={`${apps.length} apps · click one to see only its connections`}>
        <div className="cs-tablewrap">
          <table className="cs-table nm-table nm-apps">
            <thead><tr><th>App</th><th className="num">Down now</th><th className="num">Up now</th><th className="num">Received today</th><th className="num">Sent today</th><th className="num">Connections</th></tr></thead>
            <tbody>{apps.map((a) => (
              <tr key={a.name} className={only === a.name ? "sel" : ""} onClick={() => { sfx.click(); setOnly(only === a.name ? null : a.name); }}>
                <td className="nm"><span className="nm-app">{icons[a.id] ? <img src={icons[a.id]} alt="" /> : <span className="nm-letter">{a.name.slice(0, 1).toUpperCase()}</span>}{a.name}{a.system && <span className="cs-chip">macOS</span>}</span></td>
                <td className="num">{a.rx > 0 ? rateText(a.rx, units) : "-"}</td><td className="num">{a.tx > 0 ? rateText(a.tx, units) : "-"}</td>
                <td className="num">{size(a.rxT)}</td><td className="num">{size(a.txT)}</td><td className="num">{a.conns}</td>
              </tr>))}
            </tbody>
          </table>
        </div>
        <p className="cs-foot">Seen as your own user, no admin rights: every app's TCP and UDP connections, including macOS's own services. Not seen: anything outside TCP and UDP (for example ping), connections that open and close between two updates, and what is inside the traffic (no packet capture).</p>
      </Card>
      {showConns && (
        <Card title="Open connections" sub={`${conns.length}${snap.connCount && snap.connCount > (snap.conns?.length || 0) ? ` of ${snap.connCount}` : ""}${only ? ` · ${only}` : ""}`}
          right={<span className="nm-search">{only && <button type="button" className="cs-chip nm-x" onClick={() => setOnly(null)}>All apps ×</button>}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search app, address, country, port" aria-label="Search connections" /></span>}>
          <div className="cs-tablewrap">
            <table className="cs-table nm-table nm-conns">
              <thead><tr><th>App</th><th>Remote</th><th>Country</th><th className="num">Port</th><th>Type</th><th>Network</th><th>Open for</th><th className="num">Down now</th><th className="num">Up now</th></tr></thead>
              <tbody>{conns.slice(0, 250).map((c, i) => (
                <tr key={`${c.app}${c.ip}${c.port}${i}`} className={c.leak ? "leak" : ""}>
                  <td className="nm">{c.app}</td>
                  <td className="nm-ip">{c.host ? <><b>{c.host}</b><em>{c.ip}</em></> : c.ip}{c.tunnel && <span className="cs-chip">VPN server</span>}{c.leak && <span className="cs-chip nm-leak">Outside the VPN</span>}</td>
                  <td>{c.cc ? <span title={countryName(c.cc)}>{flag(c.cc)} {countryName(c.cc)}</span> : c.public ? "-" : <span className="nm-dim">Local</span>}</td>
                  <td className="num">{c.port || "-"}</td>
                  <td>{c.proto.toUpperCase().replace("4", " v4").replace("6", " v6")}{c.state ? <em className="nm-dim"> {c.state}</em> : null}</td>
                  <td className={`k-${c.kind}`}>{c.iface ? `${KIND_LABEL[c.kind as Kind] || c.kind} (${c.iface})` : "-"}</td>
                  <td className="nm-dim">{since(c.since)}</td>
                  <td className="num">{c.rx > 0 ? rateText(c.rx, units) : "-"}</td><td className="num">{c.tx > 0 ? rateText(c.tx, units) : "-"}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <p className="cs-foot">"Open for" counts from when PS app first saw the connection. Countries come from an offline database inside PS app (IP Geolocation by DB-IP), never an online lookup.</p>
        </Card>
      )}
    </>
  );
}

// ---------- VPN watch ----------
/** "on", "blocking" (the VPN app reconnecting or lockdown: nothing gets out) or "off". */
const vpnLook = (v: Vpn) => (v.up ? "on" : v.vpnApp?.blocking ? "blocking" : "off");
function VpnPill({ v }: { v: Vpn }) {
  const look = vpnLook(v), m = v.vpnApp;
  if (look === "on") return <span className="nm-pill good"><Shield />VPN on <b>{v.daemon || v.iface}</b>{m?.city ? <> {m.city}</> : v.servers[0]?.cc && <> {flag(v.servers[0].cc)} {countryName(v.servers[0].cc)}</>}</span>;
  if (look === "blocking") return <span className="nm-pill warn"><Shield />VPN {m?.state === "disconnected" ? "disconnected" : "reconnecting"}, the VPN app is blocking traffic</span>;
  return <span className="nm-pill bad"><Shield />VPN OFF</span>;
}
function VpnView({ snap }: { snap: Snap }) {
  const v = snap.vpn;
  if (!v) return <p className="cs-none">VPN watch is off in Settings.</p>;
  const look = vpnLook(v), m = v.vpnApp;
  return (
    <>
      <div className={`nm-vpnhero ${look === "on" ? "good" : look === "blocking" ? "warn" : "bad"}`}>
        <span className="nm-vpnicon"><Shield /></span>
        <div>
          <h3>{look === "on" ? `The VPN is on${m?.city ? `, ${m.city}` : ""}` : look === "blocking" ? (m?.state === "disconnected" ? "VPN disconnected, traffic blocked" : "VPN reconnecting") : "The VPN is OFF"}</h3>
          <p>{look === "on" ? `Everything goes through ${v.iface}${v.daemon ? `, run by ${v.daemon}` : ""}.`
            : look === "blocking" ? "The VPN app is blocking all traffic until it is back, so nothing goes out without the VPN."
            : "Traffic is going out on the normal network."}</p>
        </div>
        <span className={`nm-pill ${v.leaks.length ? "bad" : "good"} nm-leaknow`}>{!v.alarm ? "Leak alarm off" : v.leaks.length ? `${v.leaks.length} possible leak${v.leaks.length > 1 ? "s" : ""}` : "No leaks right now"}</span>
      </div>
      <div className="cs-two">
        <Card title="Tunnel">
          <dl className="nm-dl">
            <dt>Interface</dt><dd>{v.iface || "-"}</dd>
            <dt>Tunnel address</dt><dd>{v.address || "-"}</dd>
            <dt>VPN app</dt><dd>{v.daemon || "Not recognised"}{m && <span className="nm-dim"> · the VPN app says {m.state}</span>}</dd>
            {m && <><dt>Location</dt><dd>{[m.city, m.country].filter(Boolean).join(", ") || "-"}{m.host && <span className="nm-dim"> · {m.host}{m.entry && m.entry !== m.host ? ` via ${m.entry}` : ""}</span>}</dd>
              <dt>Features</dt><dd>{m.features.length ? m.features.map((f) => f.replace(/([a-z])([A-Z])/g, "$1 $2")).join(", ") : "-"}{m.lockdown && !m.features.includes("LockdownMode") ? ", Lockdown Mode" : ""}</dd></>}
            {!m && <><dt>Server</dt><dd>{v.servers.length ? v.servers.map((x) => <span key={x.ip} className="nm-srv">{x.ip} {x.cc && <>{flag(x.cc)} {countryName(x.cc)}</>}</span>) : "-"}</dd></>}
            <dt>Under the tunnel</dt><dd>{v.physical ? `${v.physical} via ${v.gateway}` : "-"}</dd>
            <dt>DNS servers</dt><dd>{v.dns.length ? v.dns.join(", ") : "-"}</dd>
          </dl>
          <p className="cs-foot">The server is the address the VPN's encrypted tunnel goes to (for a single hop VPN that is also where your traffic comes out). Finding the public exit address would need an online lookup, which PS app never does.</p>
        </Card>
        <Card title="Leak alarm" sub={v.alarm ? "Checks every few seconds, even with this window closed" : "Off (switch it on in Settings)"}>
          {v.leaks.length > 0 ? <LeakList list={v.leaks} /> : <p className="cs-none">{v.alarm ? "Every app's traffic to the internet is going through the VPN." : "Not checking."}</p>}
          <p className="cs-foot">A leak is an app whose data went BOTH ways with a public address on Ethernet or Wi-Fi instead of the VPN. The VPN's own encrypted packets to its relays, and the VPN app itself, never count. A try that got nothing back was blocked, not leaked: it is listed below, never a pop-up.</p>
        </Card>
      </div>
      {(v.blocked?.length ?? 0) > 0 && (
        <Card title="Blocked attempts" sub="Apps that tried to go around the VPN and got nothing back (the VPN's firewall stopped them)">
          <ul className="nm-blocked">
            {[...v.blocked!].sort((a, b) => b.at - a.at).slice(0, 20).map((b, i) => (
              <li key={i}><time>{clock(b.at)}</time><span><b>{b.app}</b> to {b.ip}:{b.port} {b.cc && <>{flag(b.cc)} </>}on {b.iface}{b.n > 1 && <em className="nm-dim"> · {b.n} times</em>}</span></li>))}
          </ul>
        </Card>
      )}
      <Card title="Alarm log" sub="Leaks, VPN changes, connection changes and offline spells">
        {v.log.length + (v.netlog?.length ?? 0) === 0 ? <p className="cs-none">Nothing so far.</p> : (
          <ul className="nm-log">
            {[...v.log.map((l) => ({ at: l.at || 0, el: <><b className="bad">Possible leak</b> {l.app} to {l.ip}:{l.port} {flag(l.cc)} on {l.iface}</> })),
              ...(v.netlog || []).map((e) => ({ at: e.at, el: <b className={e.tone === "ok" ? "good" : e.tone === "bad" ? "bad" : "warn"}>{e.text}</b> }))]
              .sort((a, b) => b.at - a.at).slice(0, 40).map((x, i) => <li key={i}><time>{clock(x.at)}</time><span>{x.el}</span></li>)}
          </ul>)}
      </Card>
    </>
  );
}
function LeakList({ list }: { list: Leak[] }) {
  return <ul className="nm-leaks">{list.map((l, i) => <li key={i}><b>{l.app}</b> to {l.ip}:{l.port} {l.cc && <>{flag(l.cc)} {countryName(l.cc)}</>} <span className="cs-chip nm-leak">on {l.iface}</span></li>)}</ul>;
}

// ---------- Speed test ----------
function SpeedView({ speed, units }: { speed: Speed | null; units: "bits" | "bytes" }) {
  const [, tick] = useState(0);
  useEffect(() => { if (!speed?.running) return; const t = window.setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, [speed?.running]);
  const tests = speed?.tests || [];
  const last = tests[tests.length - 1];
  const secs = speed?.running ? Math.round((Date.now() - speed.startedAt) / 1000) : 0;
  const max = Math.max(1, ...tests.map((t) => Math.max(t.down, t.up)));
  // networkQuality reports bits per second; rate() takes bytes.
  const sp = (bits: number) => rate(bits / 8, units);
  return (
    <>
      <div className="nm-speedhero">
        <button type="button" className={`nm-run${speed?.running ? " busy" : ""}`} disabled={!!speed?.running} onClick={() => { sfx.click(); ask("speedtest"); }}>
          {speed?.running ? <><span className="nm-spin" aria-hidden="true" />Testing... {secs} s</> : "Run speed test"}
        </button>
        <p className="cs-note">Apple's own test (networkQuality), about 20 seconds. It goes through the VPN like everything else, so it measures the speed you really get.</p>
        {speed?.error && <p className="cs-note warn">{speed.error}</p>}
      </div>
      {last && (
        <div className="cs-tiles four">
          <div className="cs-tile t-pink big"><span className="cs-tile-l">Download</span><span className="cs-tile-v">{sp(last.down).n} <small>{sp(last.down).u}</small></span></div>
          <div className="cs-tile t-purple big"><span className="cs-tile-l">Upload</span><span className="cs-tile-v">{sp(last.up).n} <small>{sp(last.up).u}</small></span></div>
          <div className="cs-tile big"><span className="cs-tile-l">Latency (idle)</span><span className="cs-tile-v">{Math.round(last.rtt)} <small>ms</small></span></div>
          <div className="cs-tile big"><span className="cs-tile-l">Responsiveness</span><span className="cs-tile-v">{Math.round(last.rpm)} <small>RPM</small></span>
            <span className="cs-tile-s">{last.rpm >= 1000 ? "High" : last.rpm >= 300 ? "Medium" : "Low"} (round trips a minute under load)</span></div>
        </div>
      )}
      <Card title="Past tests" sub={tests.length ? `${tests.length} test${tests.length > 1 ? "s" : ""}` : undefined}>
        {!tests.length ? <p className="cs-none">No tests yet.</p> : (
          <table className="cs-table nm-table">
            <thead><tr><th>When</th><th>Download</th><th>Upload</th><th className="num">Latency</th><th className="num">RPM</th><th>Through</th></tr></thead>
            <tbody>{[...tests].reverse().slice(0, 30).map((t) => (
              <tr key={t.at}><td>{clock(t.at)}</td>
                <td><span className="nm-sbar"><i style={{ width: `${(t.down / max) * 100}%` }} /></span>{rateText(t.down / 8, units)}</td>
                <td><span className="nm-sbar up"><i style={{ width: `${(t.up / max) * 100}%` }} /></span>{rateText(t.up / 8, units)}</td>
                <td className="num">{Math.round(t.rtt)} ms</td><td className="num">{Math.round(t.rpm)}</td><td className="nm-dim">{t.iface}</td></tr>))}
            </tbody>
          </table>)}
      </Card>
    </>
  );
}

// ---------- Wi-Fi ----------
function WifiView({ w }: { w?: Wifi }) {
  if (!w) return <p className="cs-none">Wi-Fi is off in Settings.</p>;
  if (!w.available) return <p className="cs-none">This Mac has no Wi-Fi.</p>;
  const q = (w.rssi ?? -100) >= -55 ? ["Excellent", 4] : (w.rssi ?? -100) >= -65 ? ["Good", 3] : (w.rssi ?? -100) >= -75 ? ["Fair", 2] : ["Weak", 1];
  return (
    <>
      {!w.power ? <p className="cs-none nm-big-note">Wi-Fi is switched off on this Mac ({w.iface}). You are on a cable.</p> : !w.connected ? <p className="cs-none nm-big-note">Wi-Fi is on but not joined to a network.</p> : (
        <div className="cs-tiles four">
          <div className="cs-tile t-pink big"><span className="cs-tile-l">Signal</span><span className="cs-tile-v">{w.rssi} <small>dBm</small></span>
            <span className="cs-tile-s"><span className="nm-bars">{[1, 2, 3, 4].map((b) => <i key={b} className={b <= (q[1] as number) ? "on" : ""} />)}</span>{q[0]}</span></div>
          <div className="cs-tile big"><span className="cs-tile-l">Noise</span><span className="cs-tile-v">{w.noise} <small>dBm</small></span><span className="cs-tile-s">Signal to noise {w.snr} dB</span></div>
          <div className="cs-tile big"><span className="cs-tile-l">Channel</span><span className="cs-tile-v">{w.channel}</span><span className="cs-tile-s">{w.band} · {w.width} MHz wide</span></div>
          <div className="cs-tile t-purple big"><span className="cs-tile-l">Link rate</span><span className="cs-tile-v">{Math.round(w.rate || 0)} <small>Mb/s</small></span><span className="cs-tile-s">{w.phy}</span></div>
        </div>)}
      <Card title="Network name">
        <p className="cs-note">macOS only gives an app the Wi-Fi network's name once it has Location Services, so PS app does not show it and does not ask. If you want the name here, that would mean turning Location Services on for PS app in System Settings: your call.</p>
      </Card>
    </>
  );
}

// ---------- History ----------
function HistoryView({ h }: { h: History | null }) {
  const [sure, setSure] = useState(false);
  if (!h) return <p className="cs-none">Loading...</p>;
  if (!h.on) return <p className="cs-none">History is off. Switch it on in Settings to keep daily totals, speed tests and alarms.</p>;
  const days = [...h.days].reverse();
  const tot = (d: History["days"][number]) => (["vpn", "wifi", "ethernet"] as Kind[]).reduce((s, k) => s + (d.k[k]?.[0] || 0) + (d.k[k]?.[1] || 0), 0);
  const max = Math.max(1, ...days.map((d) => (d.k.vpn?.[0] || 0) + (d.k.vpn?.[1] || 0) || tot(d)));
  return (
    <>
      {h.note && <p className="cs-note warn">{h.note}</p>}
      <Card title="Day by day" sub="Through the VPN (Ethernet and Wi-Fi in small print)" right={<button type="button" className={`cs-chip nm-x${sure ? " nm-sure" : ""}`} onMouseLeave={() => setSure(false)}
          onClick={() => { if (!sure) { setSure(true); return; } sfx.click(); setSure(false); ask("clearHistory"); }}>{sure ? "Click again to clear" : "Clear history"}</button>}>
        {!days.length ? <p className="cs-none">Nothing saved yet.</p> : (
          <ul className="nm-days">
            {days.map((d) => {
              const v = d.k.vpn || [0, 0];
              return (
                <li key={d.day}>
                  <span className="nm-day">{new Date(`${d.day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}</span>
                  <span className="nm-dbar"><i className="dn" style={{ width: `${(v[0] / max) * 100}%` }} /><i className="up" style={{ width: `${(v[1] / max) * 100}%` }} /></span>
                  <span className="nm-dv">↓ {size(v[0])} · ↑ {size(v[1])}</span>
                  <span className="nm-dsub">{(["ethernet", "wifi"] as Kind[]).filter((k) => d.k[k]).map((k) => `${KIND_LABEL[k]} ↓ ${size(d.k[k]![0])} ↑ ${size(d.k[k]![1])}`).join(" · ")}
                    {d.apps.length ? ` · top: ${d.apps.slice(0, 3).map((a) => a.name).join(", ")}` : ""}</span>
                </li>);
            })}
          </ul>)}
        <p className="cs-foot">Kept on this Mac only, sealed (AES-256) with a key in PS app's own Keychain item. A new PS app build cannot open the old key without a password prompt, so after a PS app update the history starts again.</p>
      </Card>
    </>
  );
}

// ---------- Last online (the developer, 4 Nov 2026) ----------
const hm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (key: string) => {
  const today = new Date().toLocaleDateString("en-CA"), yday = new Date(Date.now() - 864e5).toLocaleDateString("en-CA");
  if (key === today) return "Today";
  if (key === yday) return "Yesterday";
  return new Date(`${key}T12:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
};
/** "14:32 (just now)", "yesterday 09:10", "Tue 3 Nov, 09:10". */
function seenWhen(at: number, now: number) {
  if (!at) return "never";
  const d = now - at;
  if (d < 90_000) return "just now";
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  if (sameDay) return `${hm(at)}, ${dur(d)} ago`;
  if (new Date(at).toDateString() === new Date(now - 864e5).toDateString()) return `yesterday ${hm(at)}`;
  return clock(at);
}
const Globe = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z" /></svg>;
const MacIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
const PhoneIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /></svg>;

function UptimeView({ u }: { u: Uptime | null }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((n) => n + 1), 15_000); return () => clearInterval(t); }, []);
  const [sure, setSure] = useState(false);
  const vault = useSyncExternalStore(vaultStore.subscribe, vaultStore.get);
  const now = Date.now();
  const devices = useMemo(() => (vault.status === "unlocked" ? devicesSeen([...vault.docs.values()], secondLocal(), now) : []),
    // Recount when the vault copy changes or a minute passes ("online" turns to "last seen" with time).
    [vault.docs, Math.floor(now / 60_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!u) return <p className="cs-none">Waiting for PS app... (this needs the PS app build that has Last online)</p>;
  const drops: (Drop & { also: Drop["cause"][] })[] = u.drops.map((d) => ({ ...d, cause: causeOf(d.cause), also: (d.also || []).map(causeOf) }));
  const open = !u.online ? drops.find((d) => d.end === undefined) : undefined;
  const cause = open ? CAUSES[open.cause] : u.cause ? CAUSES[causeOf(u.cause)] : null;
  const st = dropStats(drops, now);
  const lastEnd = drops.find((d) => d.end !== undefined)?.end;
  const lastSync = vault.lastSync ? Date.parse(vault.lastSync) : 0;
  return (
    <>
      <div className={`nm-vpnhero nm-uphero ${u.online ? "good" : "bad"}`}>
        <span className="nm-vpnicon"><Globe /></span>
        <div>
          <h3>{u.online ? "Online now" : `Offline since ${hm(open?.start ?? u.since)}, ${dur(now - (open?.start ?? u.since))}`}</h3>
          <p>{u.online
            ? (lastEnd ? `The last drop ended ${seenWhen(lastEnd, now)}.` : `No drops in the last ${u.keepDays} days.`)
            : <>Likely cause: <b>{cause?.label ?? "checking"}</b>. {cause?.why}</>}</p>
        </div>
        <span className="nm-pill nm-leaknow">{u.checkedAt ? `Checked ${seenWhen(u.checkedAt, now)}` : "Checking..."}</span>
      </div>
      <Timeline drops={drops} now={now} />
      <div className="cs-tiles four">
        <div className={`cs-tile big${st.day ? " t-pink" : ""}`}><span className="cs-tile-l">Drops, last 24 h</span><span className="cs-tile-v">{st.day}</span></div>
        <div className="cs-tile big"><span className="cs-tile-l">Drops, last 7 days</span><span className="cs-tile-v">{st.week}</span></div>
        <div className="cs-tile big t-purple"><span className="cs-tile-l">Offline, last 7 days</span><span className="cs-tile-v nm-tv">{st.weekMs ? dur(st.weekMs) : "None"}</span></div>
        <div className="cs-tile big"><span className="cs-tile-l">Longest, {u.keepDays} days</span><span className="cs-tile-v nm-tv">{st.longest ? dur(st.longestMs) : "None"}</span>
          {st.longest && <span className="cs-tile-s">{clock(st.longest.start)}, {CAUSES[st.longest.cause].label}</span>}</div>
      </div>
      <Card title="Your devices" sub="Last seen, from what PS app already has">
        <ul className="nm-devs">
          <li className={u.online ? "on" : "off"}>
            <span className="nm-devic"><MacIcon /></span>
            <span className="nm-devn"><b>This Mac</b><em>Watched by PS every 10 s{lastSync ? ` · vault synced ${seenWhen(lastSync, now)}` : ""}</em></span>
            <span className={`nm-pill ${u.online ? "good" : "bad"}`}>{u.online ? "Online now" : `Offline ${dur(now - (open?.start ?? u.since))}`}</span>
            <span className="nm-devt">{u.online ? (u.goodAt ? `Last check ${hm(u.goodAt)}` : "") : `Last online ${hm(open?.start ?? u.since)}`}</span>
          </li>
          {devices.map((x) => ({ ...x, online: x.online && u.online })).map((d) => (
            <li key={d.id} className={d.online ? "on" : "off"}>
              <span className="nm-devic">{d.kind === "phone" ? <PhoneIcon /> : <MacIcon />}</span>
              <span className="nm-devn"><b>{d.name}</b><em>{[d.detail, `from ${d.source}`].filter(Boolean).join(" · ")}</em></span>
              <span className={`nm-pill ${d.online ? "good" : ""}`}>{d.online ? "Online now" : d.at ? "Last seen" : "Not seen yet"}</span>
              <span className="nm-devt">{d.at ? seenWhen(d.at, now) : ""}</span>
            </li>))}
        </ul>
        {!devices.length && <p className="cs-none">{secondOnSnap(vault) ? "No other devices yet. The other Mac shows once Second Computer is set up there, the phone once PS GOS has saved something." : "No other devices yet. The phone shows once PS GOS has saved something."}</p>}
        {(devices.length > 0 || !u.online) && <p className="cs-foot">{u.online
          ? "The other Mac sends a heartbeat every 5 minutes; the phone is seen when PS app GOS saves (screen time, a note, a command). Nothing new is fetched for this."
          : "While this Mac is offline it cannot hear from the others: their times are what PS app saw before the drop."}</p>}
      </Card>
      <Card title="Every drop" sub={drops.length ? `${drops.length} in the last ${u.keepDays} days, newest first` : undefined}
        right={drops.length ? <button type="button" className={`cs-chip nm-x${sure ? " nm-sure" : ""}`} onMouseLeave={() => setSure(false)}
          onClick={() => { if (!sure) { setSure(true); return; } sfx.click(); setSure(false); ask("clearUptime"); }}>{sure ? "Click again to clear" : "Clear"}</button> : undefined}>
        {!drops.length ? <p className="cs-none">No drops recorded yet. PS keeps them for {u.keepDays} days.</p> : (
          <div className="nm-dropdays">
            {byDay(drops).map((g) => (
              <section key={g.day}>
                <h4>{dayLabel(g.day)}<span className="nm-dim"> · {g.drops.length} drop{g.drops.length > 1 ? "s" : ""}</span></h4>
                <ul className="nm-drops">
                  {g.drops.map((d) => {
                    const c = CAUSES[d.cause];
                    return (
                      <li key={d.start} className={d.end === undefined ? "now" : undefined}>
                        <time>{hm(d.start)} <span className="nm-dim">to</span> {d.end === undefined ? "now" : hm(d.end)}</time>
                        <span className="nm-dlen">{dur((d.end ?? now) - d.start)}</span>
                        <span className="nm-dwhy"><span className={`cs-chip nm-cause ${c.tone}`}>{c.label}</span>
                          {(d.also ?? []).length > 0 && <span className="nm-dim"> then {(d.also ?? []).map((a) => { const l = CAUSES[a].label; return /^[A-Z]{2}/.test(l) ? l : l.toLowerCase(); }).join(", ")}</span>}
                          {d.via && <span className="nm-dim"> · on {d.via}</span>}
                          {d.note === "slept" && <span className="nm-dim"> · ended when the Mac went to sleep</span>}
                          {d.note === "ps-stopped" && <span className="nm-dim"> · PS app was closed, so the end is its last check</span>}
                        </span>
                      </li>);
                  })}
                </ul>
              </section>))}
          </div>)}
        <p className="cs-foot">How PS app tells: a cable or Wi-Fi link, a router, the VPN not blocking, then one DNS look up of a made up name (so no cache can answer) once a minute, every 10 s during a drop. PS app opens no connection for it: macOS asks, through the VPN. A drop counts once it is seen twice 8 s apart, and not in the first 40 s after a wake. Kept on this Mac only (times and causes, nothing else).</p>
      </Card>
    </>
  );
}

/** The last 7 days as one strip, offline spans in red, a tick at each midnight. */
function Timeline({ drops, now }: { drops: Drop[]; now: number }) {
  const span = 7 * 864e5, from = now - span;
  const x = (t: number) => Math.min(100, Math.max(0, ((t - from) / span) * 100));
  const mids: number[] = [];
  const d0 = new Date(from); d0.setHours(24, 0, 0, 0);
  for (let t = d0.getTime(); t < now; t += 864e5) mids.push(t);
  const shown = drops.filter((d) => (d.end ?? now) > from);
  return (
    <div className="nm-strip" role="img" aria-label={`${shown.length} drop${shown.length === 1 ? "" : "s"} in the last 7 days`}>
      <div className="nm-strip-bar">
        {mids.map((t) => <i key={t} className="nm-strip-mid" style={{ left: `${x(t)}%` }} />)}
        {shown.map((d) => <b key={d.start} className={`nm-strip-off ${CAUSES[causeOf(d.cause)].tone}${d.end === undefined ? " now" : ""}`}
          style={{ left: `${x(d.start)}%`, width: `${Math.max(0.35, x(d.end ?? now) - x(d.start))}%` }} title={`${clock(d.start)}, ${dur((d.end ?? now) - d.start)}, ${CAUSES[causeOf(d.cause)].label}`} />)}
      </div>
      <div className="nm-strip-days">
        {mids.filter((t) => x(t) < 95).map((t) => <span key={t} style={{ left: `${x(t)}%` }}>{new Date(t).toLocaleDateString("en-GB", { weekday: "short" })}</span>)}
        <span className="nm-strip-now" style={{ left: "100%" }}>Now</span>
      </div>
    </div>
  );
}

// ---------- Settings ----------
function Switch({ on, label, sub, onChange }: { on: boolean; label: string; sub?: string; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`nm-sw${on ? " on" : ""}`} onClick={() => { sfx.click(); onChange(!on); }}>
      <span className="nm-sw-t"><b>{label}</b>{sub && <em>{sub}</em>}</span><span className="nm-sw-k" aria-hidden="true"><i /></span>
    </button>
  );
}
function Choice<T extends string | number>({ value, options, onPick, label }: { value: T; options: { v: T; l: string }[]; onPick: (v: T) => void; label: string }) {
  return (
    <div className="nm-choice"><span>{label}</span>
      <span className="nm-seg">{options.map((o) => <button key={String(o.v)} type="button" className={o.v === value ? "on" : ""} onClick={() => { if (o.v !== value) { sfx.click(); onPick(o.v); } }}>{o.l}</button>)}</span>
    </div>
  );
}
function SettingsView({ s }: { s: Settings }) {
  const set = (patch: Partial<Settings>) => ask("settings", { settings: { ...s, ...patch } });
  return (
    <div className="cs-two">
      <Card title="Panels">
        <div className="nm-sws">
          <Switch on={s.live} label="Live" sub="Speed now, graph, totals per network" onChange={(v) => set({ live: v })} />
          <Switch on={s.apps} label="Apps" sub="Which apps use the network" onChange={(v) => set({ apps: v })} />
          <Switch on={s.conns} label="Open connections" sub="Every connection, address, port and network" onChange={(v) => set({ conns: v })} />
          <Switch on={s.vpn} label="VPN watch" sub="Tunnel, server, DNS and the leak list" onChange={(v) => set({ vpn: v })} />
          <Switch on={s.speed} label="Speed test" onChange={(v) => set({ speed: v })} />
          <Switch on={s.wifi} label="Wi-Fi" sub="Signal, noise, channel, rate" onChange={(v) => set({ wifi: v })} />
          <Switch on={s.uptime !== false} label="Last online" sub="Every drop and its cause (one DNS check a minute through the VPN), and when your other devices were last seen" onChange={(v) => set({ uptime: v })} />
        </div>
      </Card>
      <div className="nm-col">
        <Card title="Data">
          <div className="nm-sws">
            <Switch on={s.countries} label="Countries" sub="From the offline database inside PS app" onChange={(v) => set({ countries: v })} />
            <Switch on={s.rdns} label="Look up host names" sub="Reverse DNS: asks your DNS (through the VPN) for each address. Off by default" onChange={(v) => set({ rdns: v })} />
          </div>
          <Choice label="Refresh every" value={s.refresh} options={[1, 2, 5, 10].map((v) => ({ v, l: `${v} s` }))} onPick={(v) => set({ refresh: v })} />
          <Choice label="Speeds in" value={s.units} options={[{ v: "bits", l: "Mb/s" }, { v: "bytes", l: "MB/s" }]} onPick={(v) => set({ units: v })} />
        </Card>
        <Card title="History and alarms">
          <div className="nm-sws">
            <Switch on={s.history} label="Keep history" sub="Daily totals, speed tests, alarms. Sealed on this Mac" onChange={(v) => set({ history: v })} />
          </div>
          {s.history && <Choice label="Keep for" value={s.keepDays} options={[7, 30, 90, 365].map((v) => ({ v, l: v === 365 ? "1 year" : `${v} days` }))} onPick={(v) => set({ keepDays: v })} />}
          <div className="nm-sws">
            <Switch on={s.alarm} label="Leak alarm" sub="A light check every few seconds, even with this window closed" onChange={(v) => set({ alarm: v })} />
            {s.alarm && <Switch on={s.alarmPopup} label="Leak pop-ups" sub="A red card top right when data really went around the VPN (repeats become one card with a count)" onChange={(v) => set({ alarmPopup: v })} />}
            <Switch on={s.cardVpn !== false} label="VPN cards" sub="Connected, reconnecting (the VPN app blocking), disconnected, server or city changed" onChange={(v) => set({ cardVpn: v })} />
            <Switch on={s.cardOffline !== false} label="Offline cards" sub="Internet offline, and back online with how long it was down" onChange={(v) => set({ cardOffline: v })} />
            <Switch on={s.cardConn !== false} label="Connection changed cards" sub="Ethernet, Wi-Fi, iPhone hotspot and so on (never the Wi-Fi name)" onChange={(v) => set({ cardConn: v })} />
          </div>
        </Card>
        <p className="cs-foot">Everything stays on this Mac: no vault, no servers. 1Password and Signal never appear here; only the network totals include their bytes. Countries: IP Geolocation by DB-IP (db-ip.com, CC BY 4.0).</p>
      </div>
    </div>
  );
}
