// The full screen reminder card of the iPhone web app (1.60): the Mac card's words and buttons, over everything, until Done
// or the reminder's own snooze. Esc (a keyboard) and Back (the phone's back swipe) put it away until it rings again.
import { useEffect, useState } from "react";
import { answerCard, closeCard, useRemCard } from "../remweb";
import { confirms, laterOf, wordOf, yesOf, type Reminder } from "../core/remind";
import "./remcard.css";

export function RemCard() {
  const c = useRemCard();
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  useEffect(() => {
    if (!c) return;
    setTyped(""); setWrong(false);
    history.pushState({ remCard: true }, "");
    const back = () => closeCard();
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); closeCard(); } };
    addEventListener("popstate", back); addEventListener("keydown", key);
    return () => { removeEventListener("popstate", back); removeEventListener("keydown", key); };
  }, [c?.id]);
  if (!c) return null;
  const r = c as unknown as Reminder;
  const done = () => { if (!confirms(r, typed)) { setWrong(true); return; } answerCard("done"); };
  return (
    <div className="remcard" role="alertdialog" aria-label={c.pill} style={{ "--rc-bg": c.bg, "--rc-acc": c.accent, "--rc-ink": c.ink } as React.CSSProperties}>
      <div className="remcard-in">
        <span className="remcard-pill">{c.pill}</span>
        <p className="remcard-q">{c.text}</p>
        {!c.click && <input className="remcard-type" value={typed} autoCapitalize="off" autoCorrect="off" placeholder={`Type ${wordOf(r)}`} aria-label={`Type ${wordOf(r)}`}
          onChange={(e) => { setTyped(e.target.value); setWrong(false); }} onKeyDown={(e) => { if (e.key === "Enter") done(); }} />}
        {wrong && <p className="remcard-wrong">{`Only ${wordOf(r)} clears this`}</p>}
        <button type="button" className="remcard-yes" onClick={done}>{yesOf(r)}</button>
        {!c.one && <button type="button" className="remcard-later" onClick={() => answerCard("snooze")}>{laterOf(r)}</button>}   {/* PS 1.73: the P1 alarm has one button */}
        <button type="button" className="remcard-x" onClick={closeCard} aria-label="Close">Close</button>
      </div>
    </div>
  );
}
