// The Tab list's Remote screen switch (PS 1.69 part 2): next to the Second Computer button, on the main Mac once Remote
// screen is switched on (Settings, Second Computer). A click opens the other Mac's screen and connects (the Tab list steps
// aside), or closes it when it is open. The dot is green while the picture is live. ps-mac RemoteScreen.toggle.
import { useSyncExternalStore } from "react";
import { psPost } from "../ps";
import { sfx } from "../ui/sfx";
import { screenStore } from "../second/screen";
import { SCREEN_WORDS } from "../core/screenswitch";

export function ScreenSwitch({ size = 18 }: { size?: number }) {
  const st = useSyncExternalStore(screenStore.subscribe, screenStore.get);
  if (!st.on) return null;
  return (
    <button type="button" className={`sc-btn${st.open ? " open" : ""}${st.live ? " sc-on" : ""}`} aria-pressed={st.open} aria-label={SCREEN_WORDS.switchTip}
      data-tip={SCREEN_WORDS.switchTip} data-tip-line={SCREEN_WORDS.switchLine} onClick={() => { sfx.click(); psPost({ type: "screen:toggle" }); }}>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2.5" y="4" width="19" height="12.5" rx="1.8" />
        <path d="M9 20.5h6M12 16.5v4" />
        <path d="M10.5 7.5v6l1.6-1.5 1.2 2.4 1.3-.6-1.2-2.4H15.5z" fill="currentColor" stroke="none" />
      </svg>
      {st.live && <i className="sc-dot" aria-hidden="true" />}
    </button>
  );
}
