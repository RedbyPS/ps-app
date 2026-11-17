// Squad settings (V1.47), the developer 10 Nov 2026: "make the settings more intuitive so it's simpler and easier to navigate,
// and let you adjust appearance options". One short list of big rows; each opens one page with a back arrow (Esc
// steps back too): What you share, Your name, Notifications, Appearance, Leave the squad. Every sharing switch
// lives here (and on the join screen), so a stranger's PS shows them all.
import { PictureEdit, v3On } from "./GSquadV3";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { settingsData } from "../core/select";
import { feature } from "../core/features";
import { P1_FEATURE } from "../core/squadp1";
import { cleanShareOpts, SHARE_PIECES, shareOn, type ShareOpts, type SharePiece } from "../core/squadshare";
import { squadOp } from "../squad/mirror";
import { chatOp, useChat } from "../squad/chatmirror";
import { useBack } from "../squad/back";
import { SETTINGS_PAGES, THE_SQUAD, type SettingsPage } from "../squad/single";
import { ACCENTS, BGS, BUBBLES, LOOK_STYLES, looksStore, setLooks, TEXTS, THEMES, type GsLooks } from "../squad/looks";
import type { SquadView } from "../squad/view";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { Avatar } from "./SquadAvatar";
import { loadGifsStore, useLoadGifs } from "./GSquadPickers";
import { signalOn } from "../squad/signal";
import { newAiCode } from "../squad/devlink";
import { SquadP1Switch } from "./SquadP1Switch";

export function useShare(): ShareOpts {
  return cleanShareOpts(settingsData(useVault()).squadShare);
}
export const setShare = (piece: SharePiece, on: boolean) => { sfx.click(); squadOp({ op: "share", piece, on }); };
export const useLooks = (): GsLooks => useSyncExternalStore(looksStore.subscribe, looksStore.get, looksStore.get);

/** Every sharing switch, on every account. Off = never encrypted with the squad key, never sent. */
export function SharingList({ only }: { only?: SharePiece }) {
  const share = useShare();
  const list = only ? SHARE_PIECES.filter((p) => p.id === only) : SHARE_PIECES.filter((p) => p.id !== "p1" || feature("squad-p1"));
  return (
    <div className="gs-share">
      {!only && <span className="gs-h">What you share</span>}
      <ul className="gs-list">
        {list.map((p) => {
          const on = shareOn(share, p.id);
          return (
            <li key={p.id}>
              <button type="button" role="switch" aria-checked={on} className={`gs-sw${on ? " on" : ""}`} data-piece={p.id} onClick={() => setShare(p.id, !on)}>
                <span className="gs-tt">{p.label}{!p.ready && <small>Coming soon</small>}<em>{on ? p.line : "Off: never sent to the squad."}</em></span>
                <i className="gs-tog" aria-hidden="true"><b /></i>
              </button>
            </li>
          );
        })}
      </ul>
      {!only && <p className="gs-note">Anything switched off is never encrypted for the squad or sent, not even locked.</p>}
    </div>
  );
}

/** A name with a Rename button (V1.43): your own name in the squad. 1 to 40 characters; an empty name cannot be saved. */
export function NameEdit({ label, value, busy, onSave, onCancel, open = false }: { label: string; value: string; busy: boolean; onSave: (name: string) => void; onCancel?: () => void; open?: boolean }) {
  const [edit, setEdit] = useState(open);
  const [text, setText] = useState(value);
  const clean = text.replace(/\s+/g, " ").trim();
  const stop = () => { setEdit(false); setText(value); onCancel?.(); };
  useBack(edit, stop);
  if (!edit) return (
    <div className="gs-name">
      <span className="gs-tt">{value || "Me"}<em>{label}</em></span>
      <button type="button" className="gs-mini" onClick={() => { sfx.click(); setText(value); setEdit(true); }}>Rename</button>
    </div>
  );
  return (
    <form className="gs-name gs-name-edit" onSubmit={(e) => { e.preventDefault(); if (!clean || busy) return; sfx.click(); onSave(clean); setEdit(false); }}>
      <label className="gs-field">{label}<input value={text} maxLength={40} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} autoFocus spellCheck={false} /></label>
      <button type="submit" className="gs-mini go" disabled={!clean || clean === value || busy}>{busy ? "Saving..." : "Save"}</button>
      <button type="button" className="gs-mini" onClick={stop}>Cancel</button>
    </form>
  );
}

// ---------- icons for the rows ----------
function I({ children }: { children: ReactNode }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
}
const PAGE_ICON: Record<SettingsPage, ReactNode> = {
  share: <I><path d="M12 3.5l7 3v5.2c0 4.3-2.9 7.6-7 8.8-4.1-1.2-7-4.5-7-8.8V6.5z" /><path d="M9 12l2 2 4-4.2" /></I>,
  name: <I><circle cx="12" cy="8.5" r="3.6" /><path d="M5 20c.7-3.7 3.5-5.8 7-5.8s6.3 2.1 7 5.8" /></I>,
  notify: <I><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.8H5z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></I>,
  looks: <I><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5a8.5 8.5 0 0 0 0 17z" fill="currentColor" stroke="none" /></I>,
  ai: <I><rect x="5" y="7.5" width="14" height="11" rx="3" /><path d="M12 7.5V4.5M9.5 12.5h.01M14.5 12.5h.01M9.5 15.5h5" /></I>,
  leave: <I><path d="M14 4.5h4.5v15H14" /><path d="M10.5 8L6.5 12l4 4M6.8 12H15" /></I>,
};
const TONE: Record<SettingsPage, string> = { share: "ok", name: "info", notify: "warn", looks: "acc2", ai: "info", leave: "bad" };
export function SettingsIcon() {
  return <I><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></I>;
}

// ---------- the settings screen ----------
export function SquadSettings({ view, page, onPage }: { view: SquadView; page: SettingsPage | null; onPage: (p: SettingsPage | null) => void }) {
  useBack(page !== null, () => onPage(null));
  if (!page) return (
    <div className="gss">
      <div className="gss-me">
        <Avatar id={view.me || "me"} name={view.meName || "Me"} size={64} working />
        <span className="gss-me-t">{view.meName || "Me"}<em>{view.creator ? `Admin of ${view.name || THE_SQUAD}` : `Member of ${view.name || THE_SQUAD}`}</em></span>
      </div>
      <ul className="gss-rows">
        {SETTINGS_PAGES.map((p) => (
          <li key={p.id}>
            <button type="button" className={`gss-row${p.id === "leave" ? " bad" : ""}`} onClick={() => { sfx.hover(); onPage(p.id); }}>
              <span className={`gsw-ico sm ${TONE[p.id]}`}>{PAGE_ICON[p.id]}</span>
              <span className="gss-row-t">{p.title}<em>{p.line}</em></span>
              <i className="gss-chev" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
  const title = SETTINGS_PAGES.find((p) => p.id === page)?.title ?? "";
  return (
    <div className="gss gss-page" key={page}>
      <button type="button" className="gss-back" onClick={() => { sfx.hover(); onPage(null); }} aria-label="Back to Squad settings" data-tip="Back" data-tip-line="Or press Esc">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5" /></svg>
        Squad settings
      </button>
      <h3 className="gss-h">{title}</h3>
      {page === "share" && <><SharingList /><SquadP1Switch /></>}
      {page === "name" && <NamePage view={view} />}
      {page === "notify" && <NotifyPage />}
      {page === "looks" && <LooksPage />}
      {page === "ai" && <AiPage view={view} />}
      {page === "leave" && <LeavePage view={view} onDone={() => onPage(null)} />}
    </div>
  );
}

function NamePage({ view }: { view: SquadView }) {
  return (
    <>
    {v3On() && <PictureEdit v={view} />}
    <div className="gss-card">
      <NameEdit label="Your name in the squad" value={view.meName} busy={view.busy === "Renaming"} onSave={(name) => squadOp({ op: "renameMe", name })} />
      <p className="gs-note">Everyone in {view.name || THE_SQUAD} sees this name next to your messages, tasks and boards. It is end to end encrypted like everything else.</p>
    </div>
    </>
  );
}

function NotifyPage() {
  const c = useChat();
  return (
    <div className="gss-card">
      <ul className="gs-list">
        {c.notify && (
          <>
            <li>
              <button type="button" role="switch" aria-checked={c.notifyOn} className={`gs-sw${c.notifyOn ? " on" : ""}`} onClick={() => { sfx.click(); chatOp({ op: "notify", on: !c.notifyOn }); }}>
                <span className="gs-tt">Message notifications<em>{c.notifyOn ? "A card pops up when someone writes, with Reply. Not while Do Not Disturb is on." : "Off: new messages only show a count on G Squad."}</em></span>
                <i className="gs-tog" aria-hidden="true"><b /></i>
              </button>
            </li>
            {c.notifyOn && c.islandOk && (
              <li>
                <button type="button" role="switch" aria-checked={c.noteIsland} className={`gs-sw${c.noteIsland ? " on" : ""}`} onClick={() => { sfx.click(); chatOp({ op: "noteIsland", on: !c.noteIsland }); }}>
                  <span className="gs-tt">Show messages on the island<em>{c.noteIsland ? "The message comes out of the Dynamic Island, with Reply. Esc closes it." : "Off: the message shows as a card in the top right."}</em></span>
                  <i className="gs-tog" aria-hidden="true"><b /></i>
                </button>
              </li>
            )}
            {c.notifyOn && (
              <li>
                <button type="button" role="switch" aria-checked={c.noteSound} className={`gs-sw${c.noteSound ? " on" : ""}`} onClick={() => { sfx.click(); chatOp({ op: "noteSound", on: !c.noteSound }); }}>
                  <span className="gs-tt">Sound<em>{c.noteSound ? "A short sound with each new message card." : "Off: the card comes in quietly."}</em></span>
                  <i className="gs-tog" aria-hidden="true"><b /></i>
                </button>
              </li>
            )}
          </>
        )}
        {!(c.notify && c.notifyOn) && (
          <li>
            <button type="button" role="switch" aria-checked={c.sound} className={`gs-sw${c.sound ? " on" : ""}`} onClick={() => { sfx.click(); chatOp({ op: "sound", on: !c.sound }); }}>
              <span className="gs-tt">Sound for new messages<em>{c.sound ? "A short sound when a message comes in while PS runs." : "Off: new messages only show a count on G Squad."}</em></span>
              <i className="gs-tog" aria-hidden="true"><b /></i>
            </button>
          </li>
        )}
      </ul>
      <p className="gs-note">Requests to join always show a card for the admin until they are answered. To keep G Squad quiet for a while, use Do Not Disturb: it can mute G Squad on its own.</p>
    </div>
  );
}

function Choice<T extends string>({ label, list, value, onPick, swatch }: { label: string; list: { id: T; label: string }[]; value: T; onPick: (v: T) => void; swatch?: (id: T) => ReactNode }) {
  return (
    <div className="gss-choice" role="radiogroup" aria-label={label}>
      <span className="gs-h">{label}</span>
      <div className="gss-opts">
        {list.map((o) => (
          <button key={o.id} type="button" role="radio" aria-checked={value === o.id} className={`gss-opt${value === o.id ? " on" : ""}`} onClick={() => { sfx.click(); onPick(o.id); }}>
            {swatch?.(o.id)}<span>{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Appearance: every choice shows at once on the screen behind it (and in the small preview here). */
function LooksPage() {
  const l = useLooks();
  const gifs = useLoadGifs();
  return (
    <div className="gss-looks">
      <div className="gss-preview" aria-hidden="true">
        <div className="gc-line first last"><span className="gc-av"><Avatar id="preview-sam" name="Sam" size={30} /></span><div className="gc-col"><div className="gc-bubble"><span className="gc-who t2">Sam</span><span className="gc-text">Gym at 6, who is in?</span></div></div></div>
        <div className="gc-line mine first last"><div className="gc-col"><div className="gc-bubble"><span className="gc-text">In. See you there</span></div></div></div>
      </div>
      <Choice label="G Squad look" list={LOOK_STYLES} value={l.look} onPick={(look) => setLooks({ look })} />
      <Choice label="Light or dark" list={THEMES} value={l.theme} onPick={(theme) => setLooks({ theme })} />
      <Choice label="Colour" list={ACCENTS} value={l.accent} onPick={(accent) => setLooks({ accent })}
        swatch={(id) => { const a = ACCENTS.find((x) => x.id === id)!; return <i className={`gss-sw${id === "ps" ? " ps" : ""}`} style={id === "ps" ? undefined : { background: `linear-gradient(140deg, ${a.c}, ${a.c2})` }} />; }} />
      <Choice label="Chat bubbles" list={BUBBLES} value={l.bubbles} onPick={(bubbles) => setLooks({ bubbles })} swatch={(id) => <i className={`gss-bb ${id}`} />} />
      <Choice label="Text size" list={TEXTS} value={l.text} onPick={(text) => setLooks({ text })} swatch={(id) => <i className={`gss-aa ${id}`}>Aa</i>} />
      <Choice label="Background" list={BGS} value={l.bg} onPick={(bg) => setLooks({ bg })} swatch={(id) => <i className={`gss-bgs ${id}`} />} />
      {signalOn() && (
        <ul className="gs-list">
          <li>
            <button type="button" role="switch" aria-checked={gifs} className={`gs-sw${gifs ? " on" : ""}`} onClick={() => { sfx.click(); loadGifsStore.set(!gifs); }}>
              <span className="gs-tt">Load GIFs<em>{gifs ? "GIFs in chat load from GIPHY's servers." : "Off: a GIF shows a box, and loads only when you tap it."}</em></span>
              <i className="gs-tog" aria-hidden="true"><b /></i>
            </button>
          </li>
        </ul>
      )}
      <p className="gs-note">Only this device, only G Squad. Your squad never sees it.</p>
    </div>
  );
}

// V1.62 Link my AI (squad/devlink.ts). One click makes the code here and copies it in the same click; PS then
// registers it with the hub. Words approved by the developer on 15 Nov 2026; lines marked NEW WORDS wait for his yes.
function AiPage({ view }: { view: SquadView }) {
  const ai = view.ai ?? null;
  const [shown, setShown] = useState<{ id: string; code: string } | null>(null);   // only when the clipboard said no
  useEffect(() => { squadOp({ op: "aiOpen" }); return () => squadOp({ op: "aiClose" }); }, []);
  const link = () => {
    sfx.click();
    const c = newAiCode();
    setShown(null);
    navigator.clipboard.writeText(c.code).catch(() => setShown({ id: c.id, code: c.code }));
    squadOp({ op: "aiCode", id: c.id, secret: c.secret });
  };
  const st = ai?.code?.state;
  return (
    <div className="gss-card">
      <button type="button" className="gs-mini big" data-ai="link" disabled={st === "busy"} onClick={link}>Link my AI</button>
      <p className="gs-note">Lets your AI (Claude Code or Codex) talk to your friends' AIs while you build PS together. It never sees your tasks or chats.</p>
      {st === "ready" && !shown && <p className="gs-note" data-ai="copied">Code copied. Tell your AI 'done'. It works for 10 minutes.</p>}
      {/* NEW WORDS */}
      {st === "ready" && shown && shown.id === ai?.code?.id && <p className="gs-note">Copy this code for your AI: <code className="gs-code">{shown.code}</code></p>}
      {ai?.error && <p className="gs-note bad">{ai.error}</p>}
      {!!ai?.list?.length && (
        <ul className="gs-list">
          {ai.list.map((a) => (
            <li key={a.id} className="gs-name">
              <span className="gs-tt">AI linked</span>
              <button type="button" className="gs-mini bad" onClick={() => { sfx.click(); squadOp({ op: "aiUnlink", id: a.id }); }}>Unlink</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LeavePage({ view, onDone }: { view: SquadView; onDone: () => void }) {
  const [sure, setSure] = useState(false);
  const name = view.name || THE_SQUAD;
  const alone = view.members.length <= 1;
  return (
    <div className="gss-card">
      <p className="gs-lead">{view.creator && !alone
        ? `You are the admin of ${name}. If you leave, the others stay in it, your shared tasks are taken off and everyone else gets a new key.`
        : `Your shared tasks are taken off and everyone else gets a new key. PS app does not put you back by itself: open G Squad and choose Join again whenever you like.`}</p>
      {sure
        ? <div className="gs-row">
          <button type="button" className="gs-mini bad big" onClick={() => { sfx.click(); squadOp({ op: "leave" }); onDone(); }}>Leave {name}</button>
          <button type="button" className="gs-mini big" onClick={() => setSure(false)}>Stay</button>
        </div>
        : <button type="button" className="gs-mini bad big" onClick={() => { sfx.click(); setSure(true); }}>Leave the squad</button>}
    </div>
  );
}
