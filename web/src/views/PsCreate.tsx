// PS on the Mac, linked to a Supabase project of the person's own (5 Nov 2026, "Connect your own
// Supabase"): the first account of that empty project is made here, in the Sign in window. Same zero
// knowledge model as everywhere else: the passphrase never leaves this Mac, the server stores a derived
// hash and wrapped keys only, and a recovery key is shown once. The one time setup code that lets the
// first account in comes from PS's setup (core/project.ts setupCode); nobody types it.
// V1.49 (the developer, 12 Nov 2026: "all it needs is the passphrase really"): no first name and no username any more. The
// project's own hidden handle stands in for the username (core/accountid.ts), so the same passphrase opens this
// account on a second Mac or after a reinstall once that Mac links the same project.
import { useState, type FormEvent } from "react";
import { ownerSetup, PROJECT, PROJECT_HANDLE } from "../core/vault";
import { passphraseScore, suggestPassphrase } from "../core/crypto";
import { Icon, useVault } from "../ui/kit";
import { PS, psPost } from "../ps";
import { PsSignInShell } from "./PsSignIn";
import { setRecovery, Strength } from "./Lock";
import { PrivacyNote } from "./PrivacyNote";
import { LocalLockPanel } from "./LocalFirst";

/** The Sign in window offers Create account: PS on a linked project that has no account yet. */
let spent = false;   // made on this page already (the shell stops handing the code in from the next load)
export const psCanCreate = () => PS && PROJECT.custom && !!PROJECT.setupCode && !spent;

export function PsCreateAccount({ busy, onSignIn }: { busy: boolean; onSignIn: () => void }) {
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      if (!PROJECT_HANDLE) throw new Error("This Supabase project is not set up for PS. Open the PS menu, Supabase Project, and run the setup again.");
      if (!passphraseScore(pass).ok) throw new Error("Pick a stronger passphrase. It is the only thing protecting your data.");
      if (pass !== pass2) throw new Error("The two passphrases do not match.");
      await ownerSetup(PROJECT.setupCode || "", PROJECT_HANDLE, pass, (key) => { spent = true; setRecovery(key); psPost({ type: "project:created" }); });
    } catch (e2) {
      const m = (e2 as Error).message || "";
      setErr(/already has an owner/i.test(m) ? "This Supabase project already has an account. Sign in instead."
        : /setup code/i.test(m) ? "This setup has expired. Open the PS menu, Supabase Project, and run the setup again."
        : /fetch|network|load failed/i.test(m) ? "Could not reach your Supabase project. Check the internet connection and try again."
        : m || "Something went wrong. Try again.");
    } finally { setPass(""); setPass2(""); }
  }

  const eye = <button type="button" className="ps-si-eye" onClick={() => setShow(!show)} aria-label={show ? "Hide passphrase" : "Show passphrase"}><Icon name="eye" size={17} /></button>;
  return (
    <PsSignInShell title="Create your PS account" sub="All you need is a passphrase. It never leaves this Mac." art="small">
      <form className="ps-si-form" onSubmit={submit} autoComplete="on">
        <LocalLockPanel look="ps" />
        <label className="ps-si-field"><span>Choose a passphrase</span>
          <span className="ps-si-pass">
            <input type={show ? "text" : "password"} value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" spellCheck={false} required autoFocus />
            {eye}
          </span>
        </label>
        <Strength value={pass} />
        <label className="ps-si-field"><span>Type it again</span>
          <input type={show ? "text" : "password"} value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" spellCheck={false} required />
        </label>
        <button type="button" className="ps-si-link start" onClick={() => { const p = suggestPassphrase(); setPass(p); setPass2(p); setShow(true); }}>Suggest a strong passphrase</button>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="ps-si-go" disabled={busy} type="submit">{busy ? "Creating your account..." : "Create account"}</button>
        {busy && <p className="ps-si-note">Deriving your key. This takes a moment on purpose.</p>}
        <p className="ps-si-note">Nobody can reset this passphrase. You get a recovery key next: keep it somewhere safe.</p>
        <PrivacyNote own device="Mac" />
        <button type="button" className="ps-si-link" onClick={onSignIn}>I already have an account</button>
        <PsProjectLink />
      </form>
    </PsSignInShell>
  );
}

/** PS > Settings (Mac settings): which Supabase project this Mac uses, and a way to change it. */
export function PsProjectSetting() {
  const local = !!useVault().local;
  if (!PS || local) return null;   // local first: "Data on this device" says where the data is and has Turn on sync
  return (
    <section className="panel stack" aria-labelledby="ps-proj-h">
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 className="h2" id="ps-proj-h">Supabase project</h2>
        <span className="pill ink">{PROJECT.custom ? "Your own" : "PS default"}</span>
      </div>
      <p className="xs muted">
        {PROJECT.custom
          ? `This Mac keeps your encrypted data in your own Supabase project${PROJECT.ref ? ` (${PROJECT.ref})` : ""}. Changing it signs you out of this Mac; your data stays in that project.`
          : "This Mac uses the PS default server. To keep your data in a Supabase project of your own, change it here."}
      </p>
      <button type="button" className="btn sm" style={{ justifySelf: "start" }} onClick={() => psPost({ type: "project:setup" })}>Change Supabase project</button>
    </section>
  );
}

/** Under the Sign in form: set up (or change) the Supabase project this Mac uses. */
export function PsProjectLink() {
  if (!PS) return null;
  return (
    <button type="button" className="ps-si-link" onClick={() => psPost({ type: "project:setup" })}>
      {PROJECT.custom ? "Change Supabase project" : "New to PS? Connect your own Supabase"}
    </button>
  );
}
