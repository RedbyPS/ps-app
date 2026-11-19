// Local first (V1.44) on screen: Start now, the local vault's own locked states, the one line warning, the week old
// reminder, the move screen of Turn on sync, and the Settings rows (data on this device, export and import).
// The logic is in src/localfirst.ts; nothing here deletes data. PS's Tab list holds no vault: its buttons ask the main
// page through "looks" (localOp), everywhere else they run here.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { passphraseScore, suggestPassphrase } from "../core/crypto";
import { NEEDS_SYNC, vaultStore, type Snapshot } from "../core/vault";
import type { Settings } from "../core/model";
import { psPost } from "../ps";
import { useVault } from "../ui/kit";
import {
  LOCAL_PLATFORM, allowAndOpen, canStartHere, localOp, moveChoice, notNow, openLocal, startNow, syncNudgeDue, syncWanted,
  reopenLocalBackup, useLocalView,
} from "../localfirst";
import { Strength } from "./Lock";
import { PsSignInShell } from "./PsSignIn";
import "./localfirst.css";

const inOverlay = () => vaultStore.get().userId === "ps-overlay";
/** Runs a local first action where the vault is (the main page), from wherever the button is. */
function act(op: Record<string, unknown>) {
  if (inOverlay()) psPost({ type: "looks", patch: { localOp: op } });
  else void localOp(op);
}
const device = () => (LOCAL_PLATFORM === "mac" ? "Mac" : LOCAL_PLATFORM === "phone" ? "phone" : "device");
export { NEEDS_SYNC };

// ---------- Start now ----------
/** Can this device offer Start now (nobody used it yet, nothing local on it)? null while it is being checked. */
export function useCanStart(): boolean | null {
  const [can, setCan] = useState<boolean | null>(null);
  const lf = useLocalView();
  useEffect(() => { let on = true; void canStartHere().then((v) => on && setCan(v)); return () => { on = false; }; }, [lf.head]);
  return can;
}
/** The first screen on a device nobody used yet (V1.44, the setup choice): keep everything on this device, or sync.
 *  On the Mac the installer may have asked already (window.__psSetup): the screen then opens on that answer. */
export type Store = "local" | "sync";
export const SETUP_WORDS = {
  title: "Where should your list live?",
  sub: "You can change this later, and nothing is lost when you do.",
  localTitle: (d: string) => `Keep everything on this ${d}`,
  localWhat: (d: string) => `No account and no Supabase. Your list is encrypted and stays on this ${d}. Everything that does not need a server works.`,
  syncTitleMac: "Sync with your own Supabase",
  syncWhatMac: "Your list on your phone and your other Macs too. PS sets up a free Supabase project of your own in about two minutes.",
  safe: "In a project that already holds your own app, PS stays in its own separate part and never touches your tables, functions or users.",
  syncTitlePhone: "Sync with your Mac",
  syncWhatGos: "Sign in with the account you made in PS on your Mac. Your list then stays in step on both.",
  syncWhatMweb: "Connect the Supabase project you set up in PS on your Mac, then sign in with the same account.",
  syncGoMac: "Set up sync",
  syncGoPhone: "Connect",
  haveAccount: "I already have an account",
} as const;
export function initialStore(injected: unknown): Store { return injected === "sync" ? "sync" : "local"; }

export function SetupChoice({ look, onSignIn, onSync }: { look: "ps" | "mweb" | "gos"; onSignIn?: () => void; onSync: () => void }) {
  const [pick, setPick] = useState<Store>(() => initialStore((window as { __psSetup?: unknown }).__psSetup));
  const d = device();
  const mac = look === "ps";
  const opt = (id: Store, title: string, what: string, extra?: React.ReactNode) => (
    <button type="button" role="radio" aria-checked={pick === id} className={`lf-opt${pick === id ? " sel" : ""}`} onClick={() => setPick(id)}>
      <span className="lf-radio" aria-hidden="true" />
      <b>{title}</b>
      <span className="lf-opt-what">{what}</span>
      {extra}
    </button>
  );
  return (
    <div className={`lf-choice lf-${look}`}>
      <div className="lf-opts" role="radiogroup" aria-label={SETUP_WORDS.title}>
        {opt("local", SETUP_WORDS.localTitle(d), SETUP_WORDS.localWhat(d))}
        {opt("sync", mac ? SETUP_WORDS.syncTitleMac : SETUP_WORDS.syncTitlePhone, mac ? SETUP_WORDS.syncWhatMac : look === "gos" ? SETUP_WORDS.syncWhatGos : SETUP_WORDS.syncWhatMweb,
          mac ? <span className="lf-opt-safe">{SETUP_WORDS.safe}</span> : undefined)}
      </div>
      <div className={`lf-reveal${pick === "local" ? " on" : ""}`} aria-hidden={pick !== "local"}><div>
        <StartNow look={look} bare hidden={pick !== "local"} />
      </div></div>
      <div className={`lf-reveal${pick === "sync" ? " on" : ""}`} aria-hidden={pick !== "sync"}><div>
        <button className="lf-go lf-wide" type="button" tabIndex={pick === "sync" ? 0 : -1} onClick={() => {
          if (mac) psPost({ type: "setup:store", store: "sync" });
          onSync();
        }}>{mac ? SETUP_WORDS.syncGoMac : SETUP_WORDS.syncGoPhone}</button>
      </div></div>
      {onSignIn && <button type="button" className="lf-link lf-center" onClick={onSignIn}>{SETUP_WORDS.haveAccount}</button>}
    </div>
  );
}

/** The welcome tour's account card while the list lives on this device: Turn on sync, right there. */
export function StoreBox() {
  const s = useVault();
  if (!s.local) return null;
  return (
    <div className="lf-set">
      <p>{SETUP_WORDS.localTitle(device())}: on now.</p>
      <button type="button" className="lf-go sm" onClick={() => act({ op: "sync" })}>Turn on sync</button>
    </div>
  );
}

/** On the sign in of a device nobody used yet: Start now, nothing to fill in. V1.49 (the developer, 12 Nov 2026): no first name
 *  any more; G Squad asks for a name in plain words when it needs one. */
export function StartNow({ look, children, bare, hidden }: { look: "ps" | "mweb" | "gos"; children?: React.ReactNode; bare?: boolean; hidden?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function go(e: FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try { if (look === "ps") psPost({ type: "setup:store", store: "local" }); await startNow(""); }
    catch (x) { setErr((x as Error).message || "Something went wrong. Try again."); }
    finally { setBusy(false); }
  }
  return (
    <form className={`lf-start lf-${look}`} onSubmit={go}>
      {!bare && <h2 className="lf-h">Start now</h2>}
      {!bare && <p className="lf-sub">No account, no password. Your list is encrypted and kept on this {device()}. Turn on sync later and everything moves with you.</p>}
      {err && <p className="err" role="alert">{err}</p>}
      <button className="lf-go" type="submit" disabled={busy} tabIndex={hidden ? -1 : 0} autoFocus={!hidden}>{busy ? "Getting ready..." : "Start now"}</button>
      {children && <div className="lf-or"><span>or</span></div>}
      {children}
    </form>
  );
}

// ---------- the sign in while a local vault is on this device ----------
/** Above the sign in: what state the data on this device is in, and the way back to it. Null when nothing to say. */
export function LocalLockPanel({ look }: { look: "ps" | "mweb" | "gos" | "web" }) {
  const lf = useLocalView();
  const [busy, setBusy] = useState(false);
  const h = lf.head;
  if (!h) return null;
  const run = (f: () => Promise<unknown>) => async () => { setBusy(true); try { await f(); } finally { setBusy(false); } };
  if (h.state === "moved") {
    return (
      <div className={`lf-note lf-${look}`}>
        <p>Your data moved to your synced account. A copy is still kept on this {device()}.</p>
        <button type="button" className="lf-link" disabled={busy} onClick={run(reopenLocalBackup)}>Open the copy on this {device()} instead</button>
      </div>
    );
  }
  if (lf.open === "opening") return <div className={`lf-note lf-${look}`}><p>Opening your data on this {device()}...</p></div>;
  if (lf.open === "denied") {
    return (
      <div className={`lf-card lf-${look}`}>
        <h2 className="lf-h">Allow PS to open your data</h2>
        <p className="lf-sub">Your data is safe on this {device()}. This version of PS needs your OK once to read its key from the Keychain. macOS may ask for your Mac password; choose Always Allow.</p>
        <button className="lf-go" type="button" disabled={busy} onClick={run(allowAndOpen)}>Allow</button>
      </div>
    );
  }
  if (lf.open === "lost" || lf.open === "error") {
    return (
      <div className={`lf-card lf-${look}`}>
        <h2 className="lf-h">PS cannot open your data on this {device()}</h2>
        <p className="lf-sub">Nothing was deleted. The key that opens it could not be found{lf.error ? ` (${lf.error})` : ""}. Try again; if you saved a backup file you can also bring it back in once PS is open.</p>
        <button className="lf-go" type="button" disabled={busy} onClick={run(openLocal)}>Try again</button>
      </div>
    );
  }
  if (syncWanted(h)) {
    return (
      <div className={`lf-note lf-${look}`}>
        <p>Sign in, or create your account, and your data on this {device()} moves into it. It moves encrypted and is checked record by record before anything switches over.</p>
        <button type="button" className="lf-link" disabled={busy} onClick={run(notNow)}>Not now, keep using it on this {device()}</button>
      </div>
    );
  }
  return (
    <div className={`lf-card lf-${look}`}>
      <h2 className="lf-h">Your data on this {device()}</h2>
      <p className="lf-sub">No password needed: this {device()} holds the key.</p>
      <button className="lf-go" type="button" disabled={busy} onClick={run(openLocal)}>Open</button>
    </div>
  );
}

// ---------- Turn on sync: the move ----------
/** While the move runs, or waits for the person (a question, a failure). Shown instead of the app. */
export function MoveScreen({ look }: { look: "ps" | "mweb" | "gos" | "web" }) {
  const { move } = useLocalView();
  let body: React.ReactNode = null;
  if (move.phase === "confirm") {
    body = <>
      <h2 className="lf-h">Move your data into this account?</h2>
      <p className="lf-sub">{move.count} record{move.count === 1 ? "" : "s"} from this {device()} join{move.count === 1 ? "s" : ""} the {move.existing} already in this account. Nothing in the account is changed or removed.</p>
      <button className="lf-go" type="button" onClick={() => moveChoice("start")}>Move my data</button>
      <button className="lf-link" type="button" onClick={() => moveChoice("back")}>Not now, keep using this {device()} only</button>
    </>;
  } else if (move.phase === "running") {
    const p = move.progress;
    const label = !p ? "Getting ready" : p.phase === "read" ? "Reading your data" : p.phase === "check" ? "Looking at your account" : p.phase === "send" ? "Moving, encrypted" : p.phase === "verify" ? "Checking every record arrived" : "Done";
    const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
    body = <>
      <h2 className="lf-h">Turning on sync</h2>
      <p className="lf-sub">{label}{p && p.total ? ` (${p.done} of ${p.total})` : ""}. Your data stays on this {device()} the whole time.</p>
      <div className="lf-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
    </>;
  } else if (move.phase === "failed") {
    body = <>
      <h2 className="lf-h">{move.unreadable ? "Some records could not be read" : "The move did not finish"}</h2>
      <p className="lf-sub">{move.message}</p>
      <p className="lf-fine">Nothing was deleted or switched over. Trying again carries on where it stopped and never makes a second copy.</p>
      {move.unreadable
        ? <button className="lf-go" type="button" onClick={() => moveChoice("rest")}>Move the rest</button>
        : <button className="lf-go" type="button" onClick={() => moveChoice("retry")}>Try again</button>}
      <button className="lf-link" type="button" onClick={() => moveChoice("back")}>Back to my data on this {device()}</button>
    </>;
  } else if (move.phase === "key") {
    body = <>
      <h2 className="lf-h">{move.denied ? "Allow PS to open your data" : "PS cannot open your data on this device"}</h2>
      <p className="lf-sub">{move.denied ? "Your data is safe. PS needs your OK once to read its key from the Keychain, then the move starts." : "The key that opens it was not found. Nothing was deleted or moved."}</p>
      <button className="lf-go" type="button" onClick={() => moveChoice(move.denied ? "allow" : "retry")}>{move.denied ? "Allow" : "Try again"}</button>
      <button className="lf-link" type="button" onClick={() => moveChoice("back")}>Back</button>
    </>;
  }
  // PS: inside its own Sign in window, which takes this screen's height (PsSignInShell).
  if (look === "ps") return <PsSignInShell title="Turn on sync" art="small"><div className="lf-card lf-ps">{body}</div></PsSignInShell>;
  return <div className={`lf-screen lf-${look}`}><div className="lf-card">{body}</div></div>;
}

// ---------- the Tab list and the phone: one line, and the reminder after a week ----------
/** One line while the data is only on this device, and once it is a week old a gentle card to turn on sync. */
export function LocalLine({ s, st }: { s: Snapshot; st: Settings }) {
  const [hidden, setHidden] = useState(false);
  const lf = useLocalView();
  const note = inOverlay() ? lf.mirror?.note ?? null : lf.note;
  if (!s.local) {
    // Synced: the one time "all moved and checked" note (or another local first note), until OK.
    return note ? <div className="lf-line-wrap"><p className="lf-line lf-ok" role="status">{note} <button type="button" className="lf-link" onClick={() => act({ op: "noteSeen" })}>OK</button></p></div> : null;
  }
  const due = !hidden && syncNudgeDue(s.local, st.syncNudgeAt);
  return (
    <div className="lf-line-wrap">
      <p className="lf-line">Your data lives only on this {device()} until you turn on sync. <button type="button" className="lf-link" onClick={() => act({ op: "sync" })}>Turn on sync</button></p>
      {due && (
        <div className="lf-nudge" role="note">
          <p><b>A week in.</b> Turn on sync so your list is safe if this {device()} is lost, and on your other devices too. It moves everything for you, encrypted.</p>
          <div className="lf-row">
            <button type="button" className="lf-go sm" onClick={() => act({ op: "sync" })}>Turn on sync</button>
            <button type="button" className="lf-link" onClick={() => { setHidden(true); act({ op: "nudgeOff" }); }}>Not now</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Settings ----------
/** The phone home's own settings sheet (mobile web app and PS GOS): Sync and Backup groups, in local mode or while a
 *  copy is kept after the move. */
export function LocalPhoneSettings() {
  const s = useVault();
  const lf = useLocalView();
  if (!s.local && lf.head?.state !== "moved") return null;
  return <>
    <section className="gos-group"><h3>Sync</h3><div className="gos-card lf-phone"><LocalDataSetting s={s} /></div></section>
    <section className="gos-group"><h3>Backup</h3><div className="gos-card lf-phone"><LocalBackupSetting s={s} /></div></section>
  </>;
}
/** Settings, Sync and account: where the data is, Turn on sync, and the copy kept after a move. */
export function LocalDataSetting({ s }: { s: Snapshot }) {
  const lf = useLocalView();
  const [sure, setSure] = useState(false);
  const backup = inOverlay() ? lf.mirror?.backup ?? null : lf.head?.state === "moved" ? { movedAt: lf.head.movedAt || "", count: lf.head.move?.verified?.count ?? 0 } : null;
  const note = inOverlay() ? lf.mirror?.note ?? null : lf.note;
  if (s.local) {
    return (
      <div className="lf-set">
        <p>Your data is encrypted and lives only on this {device()}. If the {device()} is lost, so is the data, unless you turn on sync or keep a backup file.</p>
        <button type="button" className="btn sm" onClick={() => act({ op: "sync" })}>Turn on sync</button>
        {LOCAL_PLATFORM === "mac" && <p className="lf-fine">You make a free Supabase project of your own and a passphrase. Every record then moves into it, encrypted with the new key, and is checked before PS switches over. The copy here is kept until you remove it.</p>}
        {LOCAL_PLATFORM === "web" && <p className="lf-fine">You need a synced account made in PS on a Mac. Connect its project here and sign in; your data on this phone then moves into it, and is checked before anything switches over.</p>}
        {LOCAL_PLATFORM === "phone" && <p className="lf-fine">Turn on sync is not in the Android app yet. Export a backup to keep a copy somewhere safe.</p>}
      </div>
    );
  }
  if (!backup) return null;
  return (
    <div className="lf-set">
      <p>Sync is on. A copy of your data from before ({backup.count} record{backup.count === 1 ? "" : "s"}, moved {backup.movedAt ? new Date(backup.movedAt).toLocaleDateString() : "earlier"}) is still kept on this {device()} as a backup.</p>
      {!sure
        ? <button type="button" className="btn sm" onClick={() => setSure(true)}>Remove the copy on this {device()}</button>
        : <div className="lf-row">
            <span className="lf-fine">Your synced account has everything and was checked. Remove the copy here?</span>
            <button type="button" className="btn sm danger" onClick={() => { setSure(false); act({ op: "removeBackup", confirm: true }); }}>Yes, remove it</button>
            <button type="button" className="btn sm" onClick={() => setSure(false)}>Keep it</button>
          </div>}
      {note && <p className="lf-fine" role="status">{note}</p>}
    </div>
  );
}

/** Settings: Export my data (an encrypted file) and bring one back in. Every account (V1.44): local mode, where it is
 *  the only copy elsewhere, and synced accounts too. The file holds one JSON of { id, kind, data } records of every kind
 *  (core/backup.ts), the same record shape as the Fitness health export (format "ps-health"). */
export function LocalBackupSetting({ s }: { s: Snapshot }) {
  const lf = useLocalView();
  const [mode, setMode] = useState<"" | "export" | "import">("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");
  const note = inOverlay() ? lf.mirror?.note ?? null : lf.note;
  const picker = useRef<HTMLInputElement>(null);
  if (s.status !== "unlocked") return null;
  const reset = () => { setPass(""); setPass2(""); setErr(""); };
  function doExport(e: FormEvent) {
    e.preventDefault();
    setErr("");
    if (!passphraseScore(pass).ok) { setErr("Pick a stronger passphrase for the file."); return; }
    if (pass !== pass2) { setErr("The two passphrases do not match."); return; }
    act({ op: "export", pass });
    reset(); setMode("");
  }
  // Passphrase first, then the file: on the Mac the Tab list steps aside for the Open panel, and the import runs as
  // soon as a file is picked, so nothing waits on a screen that is out of sight.
  function doImport(e: FormEvent) {
    e.preventDefault();
    setErr("");
    if (!pass) { setErr("Type the file's passphrase first."); return; }
    picker.current?.click();
  }
  function picked(f: File | undefined) {
    if (!f) return;
    if (f.size > 150_000_000) { setErr("That file is too big to be a PS backup."); return; }
    const p = pass;
    void f.text().then((text) => { act({ op: "import", text, pass: p }); reset(); setMode(""); }).catch(() => setErr("Could not read that file."));
  }
  return (
    <div className="lf-set">
      <p>Save an encrypted copy of everything as a file, and keep it somewhere safe. Only the passphrase you pick here opens it.{s.local ? "" : " Your synced account keeps everything anyway; this is an extra copy that is yours."}</p>
      <div className="lf-row">
        <button type="button" className="btn sm" aria-pressed={mode === "export"} onClick={() => { reset(); setMode(mode === "export" ? "" : "export"); }}>Export my data</button>
        <button type="button" className="btn sm" aria-pressed={mode === "import"} onClick={() => { reset(); setMode(mode === "import" ? "" : "import"); }}>Import a backup</button>
      </div>
      {mode === "export" && (
        <form className="lf-form" onSubmit={doExport}>
          <label className="lf-field"><span>A passphrase for the file</span>
            <input type={show ? "text" : "password"} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" spellCheck={false} />
          </label>
          <Strength value={pass} />
          <label className="lf-field"><span>Type it again</span>
            <input type={show ? "text" : "password"} value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" spellCheck={false} />
          </label>
          <div className="lf-row">
            <button type="button" className="lf-link" onClick={() => { const p = suggestPassphrase(); setPass(p); setPass2(p); setShow(true); }}>Suggest one</button>
            <button type="submit" className="btn sm primary">Save the file</button>
          </div>
          <p className="lf-fine">Nobody can open the file without this passphrase, not even PS. Write it down.</p>
        </form>
      )}
      {mode === "import" && (
        <form className="lf-form" onSubmit={doImport}>
          <label className="lf-field"><span>The backup file's passphrase</span>
            <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
          <input ref={picker} type="file" hidden accept=".psbackup,application/json,application/octet-stream" onChange={(e) => { picked(e.target.files?.[0]); e.target.value = ""; }} />
          <button type="submit" className="btn sm primary">Choose the file and import</button>
          <p className="lf-fine">Adds what is missing here. Nothing on this {device()} is deleted or replaced, except your settings, which take the file's values.</p>
        </form>
      )}
      {err && <p className="err" role="alert">{err}</p>}
      {note && <p className="lf-fine" role="status">{note}</p>}
    </div>
  );
}
