// "Developed by Cincee" (PS 1.66, the developer, 17 Nov 2026: the same as his Who's Lagging app). Small and dim, brighter under the pointer,
// with a little up-right arrow; a click opens cincee.com in the browser (on the Mac a new-window link goes to the default browser,
// main.swift createWebViewWith; never inside PS). Shown at the top left of Settings and on the first setup menu (views/Welcome.tsx).
// The installer has its own copy (ps-mac ui/update.html), so it shows even if setup is never finished.
import "./cinceecredit.css";

export const CREDIT_WORDS = { text: "Developed by Cincee", url: "https://cincee.com", title: "cincee.com" } as const;

export function CinceeCredit({ className }: { className?: string }) {
  return (
    <a className={`ps-credit${className ? ` ${className}` : ""}`} href={CREDIT_WORDS.url} target="_blank" rel="noopener noreferrer" title={CREDIT_WORDS.title}
      onMouseDown={(e) => e.stopPropagation()}>
      {CREDIT_WORDS.text}
      <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M2.5 7.5 7.5 2.5M3.5 2.5h4v4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </a>
  );
}
