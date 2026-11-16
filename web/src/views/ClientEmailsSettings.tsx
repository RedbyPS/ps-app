// Settings, Client emails (PS 1.60): the per person switch (core/mailswitch.ts), the Gmail accounts that are connected, and the
// ONE button, Copy for your AI (core/mailaiprompt.ts), that copies everything an AI needs to connect Gmail for you (the
// developer's friend, 15 Nov 2026), and behind a small link the old step guide (core/mailsetup.ts). On unless you switch it off (V1.62: the public build gets
// every feature; before that it was off until switched on), and only offered to the first owner of their own Supabase
// project, because the mail functions seal every email to that project's own owner. The email panel's Connect Gmail lands here.
// Replies are sent by the Mac (Reply from PS app). On the website and the phone, Reply hands the reply to your Mac.
import { useEffect, useMemo, useState } from "react";
import { saveSettings } from "../core/actions";
import { settingsData } from "../core/select";
import { mailCan, MAIL_FEATURE } from "../core/mailswitch";
import { mailOnSnap } from "../core/mailsnap";
import { cleanSwitches } from "../core/features";
import { mailSteps, newCode, sha256Hex } from "../core/mailsetup";
import { AI_COPY_WORDS } from "../core/mailaiprompt";
import { mailSwitchChanged } from "../core/vault";
import { toast, useVault } from "../ui/kit";
import { GmailSettings } from "./Replies";
import { CopyForAiChoice, ownRef } from "./CopyForAi";
import { forgetGmailKnown, useGmailKnown } from "./gmailknown";
import "./clientemails.css";

export const CE_NEEDS = "Client emails needs your own Supabase project, and you must be its first owner. Connect it in Settings, Sync and account.";
export const CE_LINE = "Show emails from your clients' Gmail and your Instantly replies as cards and in the email panel. On until you switch it off.";
export const CE_MAC_SENDS = "Replies are sent by your Mac, when it is on. On the website and on your phone, Reply hands your reply to your Mac.";

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); } catch { toast("Could not copy. Select the text and copy it."); }
}

export function ClientEmailsSettings({ compact: _compact = false }: { compact?: boolean }) {
  const s = useVault();
  const can = mailCan(s);
  const st = settingsData(s);
  const on = mailOnSnap(s);   // V1.61: the same answer the cards use (the developer's own account takes his layer's default too)
  const ref = ownRef();
  const [code, setCode] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => { let live = true; if (code) void sha256Hex(code).then((h) => { if (live) setHash(h); }); else setHash(null); return () => { live = false; }; }, [code]);
  const steps = useMemo(() => mailSteps(ref, code, hash), [ref, code, hash]);
  useGmailKnown(can);
  useEffect(() => forgetGmailKnown, []);   // after Settings closes, the email panel asks again (an account may be connected now)
  const set = (v: boolean) => {
    if (!can) return;
    void saveSettings({ squadFeatures: { ...cleanSwitches(st.squadFeatures), [MAIL_FEATURE]: v } }).then(() => { if (v) mailSwitchChanged(); toast(v ? "Client emails on" : "Client emails off"); }).catch((e) => toast(String((e as Error).message || e)));
  };
  return (
    <section className="panel stack" aria-labelledby="ce-h">
      <div className="stack tight" style={{ gap: 2 }}>
        <h2 className="h2" id="ce-h">Client emails</h2>
        <p className="small muted">{CE_LINE}</p>
      </div>
      <div className="x-segs" role="radiogroup" aria-label="Client emails">
        <button className="chip" role="radio" aria-checked={on} aria-pressed={on} disabled={!can} onClick={() => set(true)}>On</button>
        <button className="chip" role="radio" aria-checked={!on} aria-pressed={!on} disabled={!can} onClick={() => set(false)}>Off</button>
      </div>
      {!can && <p className="small muted ce-note">{CE_NEEDS}</p>}
      <p className="small muted ce-note">{CE_MAC_SENDS}</p>
      {can && (
        <div className="stack tight">
          <CopyForAiChoice />
        </div>
      )}
      {can && (
        <details className="stack tight ce-hand">
          <summary className="small muted ce-hand-link">{AI_COPY_WORDS.hand}</summary>
          <ol className="ce-steps small">
            {steps.map((x) => (
              <li key={x.n}>
                {x.text}
                {x.n === 5 && (
                  <div className="ce-row">
                    <button type="button" className="btn quiet sm" onClick={() => setCode(newCode())}>{code ? "Make another code" : "Make a code"}</button>
                  </div>
                )}
                {x.code && (
                  <>
                    <code className="ce-code">{x.code}</code>
                    <div className="ce-row"><button type="button" className="btn quiet sm" onClick={() => void copy(x.code!)}>Copy</button></div>
                  </>
                )}
              </li>
            ))}
          </ol>
        </details>
      )}
      {can && on && <GmailSettings embedded />}
    </section>
  );
}
