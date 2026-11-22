// PS Mac app only (V1.26, the developer 1 Nov 2026: "make that screen look cleaner, it just looks like a cropped in
// version of the old retired screen"): the Sign in window's own page. No card inside the window, no
// scrollbar: the page tells PS how tall it is and the window takes that height. The website keeps its
// lock screen (Lock.tsx) with setup, the client invite and the demo.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { psPost, rememberChoice, setRememberChoice } from "../ps";
import icon from "../assets/cake-icon.png";
import "./pssignin.css";
import { appName } from "../core/appname";
import { SignInArt } from "./SignInArt";
import { artFits, artStepDown } from "../core/signinart";

/** art (PS 1.70): the developer's neon city picture in the middle of the screen (views/SignInArt.tsx); "small" a short band of it
 *  for the longer forms, so the window still fits a small screen. */
export function PsSignInShell({ title, sub, art: want = "full", children }: { title: string; sub?: string; art?: "full" | "small" | "none"; children: ReactNode }) {
  const avail = typeof screen !== "undefined" ? screen.availHeight : 0;
  const [art, setArt] = useState(() => artFits(want, avail));
  const artRef = useRef(art);
  artRef.current = art;
  const wantWas = useRef(want);   // another form (sign in, recovery) starts again from its own choice
  useEffect(() => { if (wantWas.current !== want) { wantWas.current = want; setArt(artFits(want, avail)); } }, [want, avail]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    document.documentElement.classList.add("ps-si-on");
    return () => document.documentElement.classList.remove("ps-si-on");
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    let last = 0;
    const send = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      // Taller than the screen allows (a long form on a small screen): the picture steps down, band first, then none.
      if (artStepDown(artRef.current, h, avail)) { setArt((a) => (a === "full" ? "small" : "none")); return; }
      if (h > 0 && h !== last) { last = h; psPost({ type: "signin:size", h }); }
    };
    send();
    const ro = new ResizeObserver(send);
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ps-si-page">
      <div className={`ps-si${art !== "none" ? " has-art" : ""}`} ref={box}>
        {art !== "none" && <SignInArt size={art} />}
        <header className="ps-si-head">
          <img className="ps-si-icon" src={icon} alt="" width={84} height={84} draggable={false} />
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
        </header>
        {children}
      </div>
    </div>
  );
}

/** Remember me, with what it means in one short line. */
export function PsSignInRemember() {
  const [on, setOn] = useState(rememberChoice());
  return (
    <label className="ps-si-remember">
      <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); setRememberChoice(e.target.checked); }} />
      <span><b>Remember me on this Mac</b><small>{appName()} stays signed in. Touch ID opens it after you lock it.</small></span>
    </label>
  );
}
