// The sign in picture (PS 1.70, the developer 19 Nov 2026: "implement this as the login screen in the middle of the screen...
// looking very neat, fancy animations etc."). The developer's neon night city, framed in the middle of the sign in screen: on the
// Mac's Sign in window (PsSignIn.tsx, every screen that uses it: sign in, locked, create, setup), on PS GOS and on the
// iPhone web app (Lock.tsx). Every build: the developer approved it for friends too.
//
// The motion, all on the GPU (transform and opacity only, nothing lays out again):
// - it rises in (a short spring up out of a soft scale, then the words and fields follow);
// - a neon edge: a thin pink, violet and cyan light runs slowly round the frame, with a soft glow behind that breathes;
// - the glowing globe in the middle of the picture pulses gently, a slow light sweeps across now and then, and the
//   picture drifts very slowly (a Ken Burns move);
// - a gentle parallax: the picture leans a few pixels after the pointer, eased, never more than 6 px.
// Reduce motion: it simply fades in and stands still. Nothing here takes a click or the keyboard; the fields stay clear.
import { useEffect, useRef } from "react";
import { NEON_CITY, NEON_CITY_SMALL } from "./neoncity";
import "./signinart.css";

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** size: "full" the whole picture (3 by 2); "small" a short band on the globe, for the longer forms (recovery, create). */
export function SignInArt({ size = "full", className = "" }: { size?: "full" | "small"; className?: string }) {
  const pic = useRef<HTMLDivElement>(null);
  // The parallax: the pointer anywhere on the page, eased on each frame, only while it is still moving.
  useEffect(() => {
    const el = pic.current;
    if (!el || reduced()) return;
    let tx = 0, ty = 0, x = 0, y = 0, raf = 0;
    const step = () => {
      x += (tx - x) * 0.08; y += (ty - y) * 0.08;
      el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
      raf = Math.abs(tx - x) > 0.05 || Math.abs(ty - y) > 0.05 ? requestAnimationFrame(step) : 0;
    };
    const move = (e: PointerEvent) => {
      const w = window.innerWidth || 1, h = window.innerHeight || 1;
      tx = ((e.clientX / w) - 0.5) * -12; ty = ((e.clientY / h) - 0.5) * -8;
      if (!raf) raf = requestAnimationFrame(step);
    };
    const leave = () => { tx = 0; ty = 0; if (!raf) raf = requestAnimationFrame(step); };
    window.addEventListener("pointermove", move, { passive: true });
    document.documentElement.addEventListener("pointerleave", leave);
    return () => { window.removeEventListener("pointermove", move); document.documentElement.removeEventListener("pointerleave", leave); if (raf) cancelAnimationFrame(raf); };
  }, []);
  return (
    <div className={`si-art si-art-${size}${className ? ` ${className}` : ""}`} aria-hidden="true">
      <i className="si-art-glow" />
      <div className="si-art-frame">
        <div className="si-art-pic" ref={pic}>
          <img src={NEON_CITY_SMALL} srcSet={`${NEON_CITY_SMALL} 800w, ${NEON_CITY} 1536w`} sizes="(max-width: 520px) 92vw, 340px"
            width={800} height={534} alt="" draggable={false} decoding="async" />
          <i className="si-art-orb" />
          <i className="si-art-sweep" />
          <i className="si-art-shade" />
        </div>
      </div>
    </div>
  );
}
