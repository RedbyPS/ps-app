import { Suspense, lazy, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { lastUsername, ownerRecover, ownerSetup, unlock, unlockPassphraseOnly, BASE, PROJECT, PROJECT_HANDLE } from "../core/vault";
import { failedSignIn, signInUsername } from "../core/accountid";
import { passphraseScore, suggestPassphrase } from "../core/crypto";
import { Icon, Logo, copyText, useVault } from "../ui/kit";
import { PsRememberBox } from "./PsRemember";
import { PS, psPost } from "../ps";
import { PsSignInRemember, PsSignInShell } from "./PsSignIn";
import { SignInArt } from "./SignInArt";
import { PsCreateAccount, PsProjectLink, psCanCreate } from "./PsCreate";
import { MOBILE_APP_NAME, appName } from "../core/appname";
import { MWEB } from "../gos/bridge";
import { AppMark } from "../mobile/mark";
import { readAccountName } from "../mobile/link";
import { LocalLockPanel, SETUP_WORDS, SetupChoice, useCanStart } from "./LocalFirst";
import { syncWanted, useLocalView } from "../localfirst";

// V1.55: "Scan the code on your Mac" on the phone (the iPhone web app and PS GOS only; loaded only there).
const ScanSignInLazy = lazy(() => import("../mobile/ScanSignIn").then((m) => ({ default: m.ScanSignIn })));
function ScanSignIn(p: { className?: string }) { return <Suspense fallback={null}><ScanSignInLazy {...p} /></Suspense>; }

// The recovery key is shown once, right after setup, before the app opens.
let recovery: string | null = null;
const rl = new Set<() => void>();
export function usePendingRecovery() {
  return useSyncExternalStore((l) => { rl.add(l); return () => rl.delete(l); }, () => recovery);
}
export function setRecovery(v: string | null) { recovery = v; rl.forEach((l) => l()); }

export function Strength({ value }: { value: string }) {
  const sc = passphraseScore(value);
  const pct = Math.min(100, Math.round((sc.bits / 90) * 100));
  return (
    <div className="stack tight">
      <div className={`progress${sc.ok ? "" : " amber"}`}><i style={{ width: `${value ? pct : 0}%` }} /></div>
      <small className="hint">{sc.hint}</small>
    </div>
  );
}

function Seal() {
  return <div className="seal"><Icon name="shield" size={26} /></div>;
}

type Mode = "unlock" | "setup" | "recover";

// A setup link (#setup=CODE) opens the setup form already filled in. Read once, then
// removed from the address bar so the code is not left in history.
const setupFromLink = (() => {
  if (typeof location === "undefined") return null;
  const m = location.hash.match(/^#setup=([A-Za-z0-9-]{6,64})$/);
  if (!m) return null;
  history.replaceState(null, "", location.pathname);
  return m[1];
})();

/** A client who once opened their three word login link on this device gets a one tap way back. */
function storedClientLink(): { link: string; name?: string } | null {
  try { const j = JSON.parse(localStorage.getItem("cv.clientLogin") || "null"); return j && typeof j.link === "string" && j.link.includes("/join#") ? j : null; }
  catch { return null; }
}

export function LockScreen() {
  const clientLink = storedClientLink();
  const s = useVault();
  const pending = usePendingRecovery();
  const [mode, setMode] = useState<Mode>(setupFromLink && !PS ? "setup" : "unlock");
  const [username, setUsername] = useState(setupFromLink ? "admin" : "");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [code, setCode] = useState(setupFromLink ?? "");
  const [rec, setRec] = useState("");
  const [err, setErr] = useState("");
  const [show, setShow] = useState(false);
  const [create, setCreate] = useState(psCanCreate);   // PS on its own new Supabase project: Create account first
  // V1.49: on a Supabase project of the person's own the passphrase is all sign in needs (core/accountid.ts). A
  // username this device remembers (accounts made with one before V1.49) is used without asking; the field itself
  // only shows behind "Signed up with a username?". The developer's project, the website and the phone app: unchanged.
  const handle = PROJECT_HANDLE;
  const [typed, setTyped] = useState(!handle);
  const [remembered, setRemembered] = useState("");
  const who = signInUsername({ handle, typed, typedName: username, remembered });
  // Local first (V1.44, views/LocalFirst.tsx): Start now on a device nobody used, the local vault's own states.
  const lf = useLocalView();
  const canStart = useCanStart();
  const [signIn, setSignIn] = useState(false);
  const localHere = !!lf.head && lf.head.state !== "moved" && !syncWanted(lf.head);   // the data on this device opens without a password
  const startHere = canStart === true && !signIn && !localHere;
  const busy = s.status === "busy";
  const formRef = useRef<HTMLFormElement>(null);
  // Auto login: when a password manager fills the passphrase or it is pasted (many
  // characters arrive at once), submit straight away. Typing by hand still uses Enter,
  // because each attempt runs the deliberately slow 600,000 round key derivation.
  function onPass(v: string) {
    const jumped = v.length - pass.length >= 6;
    setPass(v);
    if (mode === "unlock" && jumped && who.trim() && !busy) setTimeout(() => formRef.current?.requestSubmit(), 60);
  }

  useEffect(() => {
    if (!setupFromLink) void lastUsername().then((last) => {
      // A phone linked by scan: the Mac's code said the account was made with a username, so this phone remembers it
      // and the passphrase alone signs in (src/mobile/link.ts). Only until the phone has signed in once and knows it itself.
      const u = last || (MWEB && handle ? readAccountName(PROJECT.url) : "");
      if (!u) return;
      setRemembered(u);
      if (u !== handle) setUsername(u);   // the hidden handle never goes into the visible field
    });
  }, []);
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } setErr(""); setPass(""); setPass2(""); }, [mode]);

  if (pending) return <RecoveryKeyScreen value={pending} />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      if (mode === "unlock") {
        // The passphrase alone on a project of the person's own (V1.55): a passphrase only account, or one made with a
        // username that this project can name from the passphrase (core/vault.ts unlockPassphraseOnly). Same keys as ever.
        if (handle && who === handle) await unlockPassphraseOnly(pass);
        else await unlock(who, pass);
      } else if (mode === "setup") {
        if (!passphraseScore(pass).ok) throw new Error("Pick a stronger passphrase. It is the only thing protecting the vault.");
        if (pass !== pass2) throw new Error("The two passphrases do not match.");
        await ownerSetup(code, username, pass, setRecovery);
      } else {
        if (!passphraseScore(pass).ok) throw new Error("Pick a stronger passphrase.");
        if (pass !== pass2) throw new Error("The two passphrases do not match.");
        await ownerRecover(who, rec, pass);
      }
    } catch (e2) {
      const m = (e2 as Error).message || "Something went wrong.";
      // A passphrase only sign in that fails may be an account made with a username: show the username field right away
      // (never a dead end), with a note in plain words.
      const f = failedSignIn({ handle, typed, setup: mode === "setup", message: m });
      if (f.openName) setTyped(true);
      setErr(f.text);
    } finally {
      setPass("");
      setPass2("");
    }
  }

  // G Squad, the mobile web app (src/mobile/): its own sign in, the same unlock and recovery key. No setup, no client
  // links and no demo: a G Squad account is made in PS on the Mac, in the person's own project.
  if (MWEB && (localHere || startHere)) {
    const toConnect = () => { try { sessionStorage.setItem("psm.connect", "1"); localStorage.removeItem("psm.local"); } catch { /* storage off */ } location.reload(); };
    return (
      <main className="psm-page psm-signin">
        <header className="psm-hero psm-in">
          <SignInArt />
          <AppMark size={64} />
          <h1>{localHere ? MOBILE_APP_NAME : `Welcome to ${MOBILE_APP_NAME}`}</h1>
        </header>
        {localHere ? <LocalLockPanel look="mweb" /> : <SetupChoice look="mweb" onSync={toConnect} />}
      </main>
    );
  }
  if (MWEB) {
    return (
      <main className="psm-page psm-signin">
        <header className="psm-hero psm-in">
          <SignInArt size={mode === "recover" ? "small" : "full"} />
          <AppMark size={64} />
          <h1>{mode === "recover" ? "Use your recovery key" : `Sign in to ${MOBILE_APP_NAME}`}</h1>
          <p>{mode === "recover" ? "Choose a new passphrase with the recovery key you saved when you made your account." : `The same ${typed ? "username and passphrase" : "passphrase"} as PS on your Mac. Your passphrase never leaves this phone.`}</p>
        </header>
        <LocalLockPanel look="mweb" />
        <form className="psm-form psm-in" style={{ ["--d" as string]: "100ms" }} onSubmit={submit} autoComplete="on" ref={formRef}>
          {typed ? (
            <label className="psm-field"><span>Username</span>
              <span className="psm-input"><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} required /></span>
            </label>
          ) : null}
          {mode === "recover" && (
            <label className="psm-field"><span>Recovery key</span>
              <span className="psm-input"><textarea value={rec} onChange={(e) => setRec(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} rows={3} required /></span>
            </label>
          )}
          <label className="psm-field"><span>{mode === "recover" ? "New passphrase" : "Passphrase"}</span>
            <span className="psm-input">
              <input type={show ? "text" : "password"} value={pass} onChange={(e) => onPass(e.target.value)}
                autoComplete={mode === "recover" ? "new-password" : "current-password"} autoCapitalize="none" spellCheck={false} required />
              <button type="button" className="psm-paste" onClick={() => setShow(!show)} aria-label={show ? "Hide passphrase" : "Show passphrase"}>{show ? "Hide" : "Show"}</button>
            </span>
          </label>
          {mode === "recover" && (
            <>
              <Strength value={pass} />
              <label className="psm-field"><span>Type it again</span>
                <span className="psm-input"><input type={show ? "text" : "password"} value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" spellCheck={false} required /></span>
              </label>
            </>
          )}
          {err && <p className="psm-err" role="alert">{err}</p>}
          <button className="psm-btn" disabled={busy} type="submit">
            {busy ? (mode === "unlock" ? "Unlocking..." : "Working on it...") : mode === "unlock" ? "Unlock" : "Recover and unlock"}
          </button>
          {busy && <p className="psm-fine">Deriving your key. This takes a moment on purpose.</p>}
          <button type="button" className="psm-link" onClick={() => setMode(mode === "unlock" ? "recover" : "unlock")}>
            {mode === "unlock" ? "Forgot it? Use your recovery key" : "Back to sign in"}
          </button>
          {handle && <button type="button" className="psm-link" onClick={() => { setErr(""); setTyped(!typed); }}>{typed ? "Sign in with my passphrase only" : "Signed up with a username?"}</button>}
          {mode === "unlock" && <ScanSignIn />}
        </form>
      </main>
    );
  }

  // PS on the Mac: its own clean Sign in window (PsSignIn.tsx). Only unlock and the recovery key here.
  if (PS) {
    if (localHere) return <PsSignInShell title={appName()} sub="Your list, encrypted on this Mac."><LocalLockPanel look="ps" /></PsSignInShell>;
    if (startHere) {
      // Local first (V1.44): the setup choice. Sync opens PS's own Supabase window (this page stays as it is).
      return (
        <PsSignInShell title={SETUP_WORDS.title} sub={SETUP_WORDS.sub} art="small">
          <SetupChoice look="ps" onSignIn={() => setSignIn(true)} onSync={() => psPost({ type: "project:setup" })} />
        </PsSignInShell>
      );
    }
    if (create) return <PsCreateAccount busy={busy} onSignIn={() => setCreate(false)} />;
    const eye = (
      <button type="button" className="ps-si-eye" onClick={() => setShow(!show)} aria-label={show ? "Hide passphrase" : "Show passphrase"}><Icon name="eye" size={17} /></button>
    );
    return (
      <PsSignInShell title={mode === "recover" ? "Use your recovery key" : `Sign in to ${appName()}`} art={mode === "recover" ? "small" : "full"}
        sub={mode === "recover" ? "Choose a new passphrase with the recovery key you saved at setup." : "Your passphrase never leaves this Mac."}>
        <form className="ps-si-form" onSubmit={submit} autoComplete="on" ref={formRef}>
          <LocalLockPanel look="ps" />
          {typed ? (
            <label className="ps-si-field"><span>Username</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus={!!handle && !username} />
            </label>
          ) : null}
          {mode === "recover" && (
            <label className="ps-si-field"><span>Recovery key</span>
              <textarea className="mono" value={rec} onChange={(e) => setRec(e.target.value)} autoComplete="off" spellCheck={false} required />
            </label>
          )}
          <label className="ps-si-field"><span>{mode === "recover" ? "New passphrase" : "Passphrase"}</span>
            <span className="ps-si-pass">
              <input type={show ? "text" : "password"} value={pass} onChange={(e) => onPass(e.target.value)}
                autoComplete={mode === "recover" ? "new-password" : "current-password"} spellCheck={false} required autoFocus={!typed || !!username} />
              {eye}
            </span>
          </label>
          {mode === "recover" && (
            <>
              <Strength value={pass} />
              <label className="ps-si-field"><span>Type it again</span>
                <input type={show ? "text" : "password"} value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" spellCheck={false} required />
              </label>
              <button type="button" className="ps-si-link start" onClick={() => { const p = suggestPassphrase(); setPass(p); setPass2(p); setShow(true); }}>Suggest a strong passphrase</button>
            </>
          )}
          {mode === "unlock" && <PsSignInRemember />}
          {err && <p className="err" role="alert">{err}</p>}
          <button className="ps-si-go" disabled={busy} type="submit">
            {busy ? (mode === "unlock" ? "Unlocking..." : "Working on it...") : mode === "unlock" ? "Unlock" : "Recover and unlock"}
          </button>
          {busy && <p className="ps-si-note">Deriving your key. This takes a moment on purpose.</p>}
          <button type="button" className="ps-si-link" onClick={() => setMode(mode === "unlock" ? "recover" : "unlock")}>
            {mode === "unlock" ? "Forgot it? Use your recovery key" : "Back to sign in"}
          </button>
          {handle && <button type="button" className="ps-si-link" onClick={() => { setErr(""); setTyped(!typed); }}>{typed ? "Sign in with my passphrase only" : "Signed up with a username?"}</button>}
          {mode === "unlock" && psCanCreate() && <button type="button" className="ps-si-link" onClick={() => setCreate(true)}>Create account</button>}
          {mode === "unlock" && <PsProjectLink />}
        </form>
      </PsSignInShell>
    );
  }

  // PS GOS uses the card below: Start now or the data on this phone first (the website never shows either).
  if (import.meta.env.MODE === "gos" && (localHere || startHere)) {
    return (
      <div className="lock">
        <div className="lock-card">
          <SignInArt size={localHere ? "full" : "small"} />
          {localHere ? <LocalLockPanel look="gos" /> : (
            <><h2 className="lf-h">{SETUP_WORDS.title}</h2><SetupChoice look="gos" onSync={() => setSignIn(true)} /></>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="lock">
      <form className="lock-card" onSubmit={submit} autoComplete="on" ref={formRef}>
        {/* PS 1.70: the developer's sign in picture on PS GOS too (never on the website's vault sign in, which clients use). */}
        {import.meta.env.MODE === "gos" && <SignInArt size={mode === "unlock" ? "full" : "small"} />}
        {import.meta.env.MODE === "gos" && <LocalLockPanel look="gos" />}
        {import.meta.env.MODE === "gos" && mode === "unlock" && <div className="stack tight"><ScanSignIn className="btn block" /><span className="hint" style={{ textAlign: "center" }}>Or type your username and password below.</span></div>}
        <div className="row between">
          <span className="brand"><Logo /> Cincee</span>
          <span className="pill good">AES-256</span>
        </div>
        <Seal />
        {clientLink && (
          <div className="stack tight">
            <a className="btn primary block" href={clientLink.link}>{clientLink.name ? `${clientLink.name}, open your project page` : "Open your project page"}</a>
            <span className="hint" style={{ textAlign: "center" }}>Or sign in with a username below.</span>
          </div>
        )}
        <div className="stack tight">
          <h1 className="h2" style={{ fontSize: 24 }}>
            {mode === "unlock" ? "Unlock your vault" : mode === "setup" ? "Set up your vault" : "Recover your vault"}
          </h1>
          <p className="muted small">
            {mode === "unlock" && "Your data is decrypted here, on this device. Your passphrase never leaves it."}
            {mode === "setup" && "One time only, with your one-time setup code. Nobody, not even the servers, can reset this passphrase, so keep it somewhere safe."}
            {mode === "recover" && "Use the recovery key you saved at setup to choose a new passphrase."}
          </p>
        </div>

        {mode === "setup" && (
          <label className="field"><span>Setup code</span>
            <input className="input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} required />
          </label>
        )}
        <label className="field"><span>Username or email</span>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
        </label>
        {mode === "recover" && (
          <label className="field"><span>Recovery key</span>
            <textarea className="textarea" style={{ minHeight: 70, fontFamily: "ui-monospace, Menlo, monospace" }} value={rec} onChange={(e) => setRec(e.target.value)} autoComplete="off" spellCheck={false} required />
          </label>
        )}
        <label className="field"><span>{mode === "unlock" ? "Password" : "New password"}</span>
          <div className="row">
            <input className="input" type={show ? "text" : "password"} value={pass} onChange={(e) => onPass(e.target.value)}
              autoComplete={mode === "unlock" ? "current-password" : "new-password"} spellCheck={false} required />
            <button type="button" className="btn quiet icon" onClick={() => setShow(!show)} aria-label={show ? "Hide passphrase" : "Show passphrase"}><Icon name="eye" /></button>
          </div>
        </label>
        {mode !== "unlock" && (
          <>
            <Strength value={pass} />
            <label className="field"><span>Type it again</span>
              <input className="input" type={show ? "text" : "password"} value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" spellCheck={false} required />
            </label>
            <button type="button" className="btn ghost sm" style={{ justifySelf: "start" }} onClick={() => { const p = suggestPassphrase(); setPass(p); setPass2(p); setShow(true); }}>
              Suggest a strong passphrase
            </button>
          </>
        )}

        {mode === "unlock" && <PsRememberBox />}
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn primary block" disabled={busy} type="submit">
          {busy ? "Working on it..." : mode === "unlock" ? "Unlock" : mode === "setup" ? "Create my vault" : "Recover and unlock"}
        </button>
        {busy && <p className="hint" style={{ textAlign: "center" }}>Deriving your key with 600,000 rounds. This takes a moment on purpose.</p>}

        <div className="divider" />
        <div className="stack tight small">
          {mode !== "unlock" && <button type="button" className="btn quiet sm" onClick={() => setMode("unlock")}>Back to unlock</button>}
          {mode === "unlock" && <button type="button" className="btn quiet sm" onClick={() => setMode("recover")}>Forgot it? Use your recovery key</button>}
          {mode === "unlock" && <button type="button" className="btn quiet sm" onClick={() => setMode("setup")}>First time here? Set up the vault</button>}
          <p className="hint" style={{ textAlign: "center" }}>
            Client? Open the private invite link you were sent. Want a look first? <a href={`${BASE}demo`}>See the demo</a>
          </p>
        </div>
      </form>
    </div>
  );
}

function RecoveryKeyScreen({ value }: { value: string }) {
  const [saved, setSaved] = useState(false);
  function download() {
    const text = `Cincee Vault recovery key\nCreated ${new Date().toLocaleString()}\n\n${value}\n\nThis key can unlock your vault if you forget your passphrase.\nKeep it offline (printed, or in your password manager). ${PROJECT_HANDLE ? "Anyone with it can reset your passphrase, so keep it as safe as the passphrase itself." : "Anyone with it AND your username can reset your passphrase."}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = "cincee-vault-recovery-key.txt"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="lock">
      <div className="lock-card">
        <Seal />
        <h1 className="h2" style={{ fontSize: 24 }}>Save your recovery key</h1>
        <p className="muted small">
          This is the only way back in if you ever forget your passphrase. It is shown once and is not stored anywhere readable.
          Put it in your password manager or print it and keep it somewhere safe.
        </p>
        <div className="recovery">{value}</div>
        <div className="row wrap-ok">
          <button className="btn ghost sm" onClick={() => void copyText(value)}>Copy</button>
          <button className="btn ghost sm" onClick={download}>Download .txt</button>
          <button className="btn ghost sm" onClick={() => window.print()}>Print</button>
        </div>
        <label className="row small" style={{ alignItems: "flex-start" }}>
          <input className="check" type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>I have saved my recovery key somewhere safe. If I lose both it and my passphrase, my data cannot be recovered by anyone.</span>
        </label>
        <button className="btn primary block" disabled={!saved} onClick={() => setRecovery(null)}>Open my vault</button>
      </div>
    </div>
  );
}
