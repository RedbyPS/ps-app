// "Copy for your AI" (core/mailaiprompt.ts): one button that puts the whole Gmail connect prompt on the clipboard. Used in
// Settings, Client emails and in the email panel when Gmail is not connected yet.
import { useEffect, useState } from "react";
import { AI_COPY_WORDS, mailAiPrompt, type AiMode } from "../core/mailaiprompt";
import { validRef } from "../core/mailsetup";
import { activeProject } from "../core/project";
import { toast } from "../ui/kit";

/** The person's own project ref, or null when PS does not know it yet. */
export const ownRef = (): string | null => { const r = activeProject()?.ref ?? null; return validRef(r) ? r : null; };

export function useCopyForAi() {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = window.setTimeout(() => setCopied(false), 6000); return () => clearTimeout(t); }, [copied]);
  const copy = (mode: AiMode = "guide") => {
    const text = mailAiPrompt(ownRef(), mode);
    const fail = () => toast(AI_COPY_WORDS.failed);
    try { navigator.clipboard.writeText(text).then(() => setCopied(true), fail); } catch { fail(); }
  };
  return { copied, copy };
}

const BUTTON: Record<AiMode, string> = { guide: AI_COPY_WORDS.guideButton, clicks: AI_COPY_WORDS.clicksButton };

/** One copy button for one way of helping. `mode`: "guide" (AI tells me what to press) or "clicks" (AI presses it). */
export function CopyForAiButton({ className = "btn", mode = "guide", onCopied }: { className?: string; mode?: AiMode; onCopied?: () => void }) {
  const { copied, copy } = useCopyForAi();
  return (
    <>
      <button type="button" className={className} onClick={() => { copy(mode); onCopied?.(); }}>{BUTTON[mode]}</button>
      {copied && <span className="small muted ce-copied" role="status">{AI_COPY_WORDS.done}</span>}
    </>
  );
}

/** The calm two way choice for Settings, Client emails: two buttons, one line under each. One confirmation line. */
export function CopyForAiChoice() {
  const { copied, copy } = useCopyForAi();
  return (
    <div className="stack tight" role="group" aria-label={AI_COPY_WORDS.button}>
      <p className="small muted">{AI_COPY_WORDS.pick}</p>
      <div className="ce-pick">
        <div className="ce-opt">
          <button type="button" className="btn" onClick={() => copy("guide")}>{AI_COPY_WORDS.guideButton}</button>
          <p className="small muted">{AI_COPY_WORDS.guideLine}</p>
        </div>
        <div className="ce-opt">
          <button type="button" className="btn" onClick={() => copy("clicks")}>{AI_COPY_WORDS.clicksButton}</button>
          <p className="small muted">{AI_COPY_WORDS.clicksLine}</p>
        </div>
      </div>
      {copied && <span className="small muted ce-copied" role="status">{AI_COPY_WORDS.done}</span>}
    </div>
  );
}
