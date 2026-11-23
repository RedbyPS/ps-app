// Settings, Second Computer (PS 1.65): the feature's own On/Off switch, shown to every owner in PS on a Mac (public build
// too: every public feature has a visible switch). Off until switched on (it pairs two Macs); on for the developer as
// before (core/secondswitch.ts). Saved with the other settings in the vault (squadFeatures), so it follows the person to
// every device; src/featuresync.ts hands the answer to the Mac, which starts or stops its half (ps-mac Second.setOn), and
// ps.ts starts or stops the page's half. While it is on, the old settings panel follows (views/Second.tsx SecondSettings).
// It sits inside Settings, so Esc closes it with Settings (views/SettingsScreen.tsx).
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { settingsData } from "../core/select";
import { cleanSwitches } from "../core/features";
import { SECOND_FEATURE, SECOND_WORDS, secondCan } from "../core/secondswitch";
import { secondOnSnap } from "../core/secondsnap";
import { Choice, taskMapActions } from "./TaskMap";
import { SecondSettings } from "./Second";
import { SCREEN_FEATURE, SCREEN_HOLDS, SCREEN_PICTURES, SCREEN_WORDS, relayKeyOK, relayUrlClean, screenPrefsMsg, screenSwitch, type ScreenHold } from "../core/screenswitch";
import { askRelay, relayStore, sendRelayKey } from "../second/screenrelay";
import { accountOf } from "../featuresync";
// Its look is From the squad's rows (fromthesquad.css, loaded with Settings through views/FromTheSquad.tsx). Not imported here:
// this module is a placeholder in the public core, and a style it imported would count as cut there.

export function SecondSwitch() {
  const v = useVault();
  const can = secondCan(v);
  const on = secondOnSnap(v);
  const set = (want: boolean) => {
    if (!can) return;
    sfx.hover();
    void taskMapActions.looks({ squadFeatures: { ...cleanSwitches(settingsData(v).squadFeatures), [SECOND_FEATURE]: want } });
  };
  return (
    <>
      <div className="fts">
        <ul className="fts-list">
          <li className="fts-row" data-feature={SECOND_FEATURE}>
            <div className="fts-t">
              <b>Second Computer</b>
              <span>{SECOND_WORDS.line}</span>
            </div>
            <div className={`tm-ed-seg${can ? "" : " gs-notyet"}`} role="radiogroup" aria-label="Second Computer">
              <Choice selected={can && on} onPick={() => set(true)}>On</Choice>
              <Choice selected={can && !on} onPick={() => set(false)}>Off</Choice>
            </div>
          </li>
        </ul>
      </div>
      {on && <ScreenRows />}
      {on && <SecondSettings />}
    </>
  );
}

// Settings, Second Computer, Remote screen (PS 1.69): its own switch and its two settings, right under Second Computer's switch
// and only while Second Computer is on (it uses the pairing). Visible in every build (a public feature has a visible switch).
// The Mac starts or stops its half from the switch (src/featuresync.ts, ps-mac RemoteScreen.allowed) and takes Picture and
// Delay numbers from src/screenprefs.ts.
function ScreenRows() {
  const v = useVault();
  const can = secondCan(v);
  const data = settingsData(v);
  const on = can && screenSwitch(data.squadFeatures, accountOf(v));
  const prefs = screenPrefsMsg(data);
  const setOn = (want: boolean) => {
    if (!can) return;
    sfx.hover();
    void taskMapActions.looks({ squadFeatures: { ...cleanSwitches(data.squadFeatures), [SCREEN_FEATURE]: want } });
  };
  const set = (o: { screenPicture?: (typeof SCREEN_PICTURES)[number]; screenNumbers?: boolean; screenHoldKey?: ScreenHold; screenAnywhere?: boolean; screenRelayUrl?: string }) => { if (can) { sfx.hover(); void taskMapActions.looks(o); } };
  return (
    <div className="fts">
      <ul className="fts-list">
        <li className="fts-row" data-feature={SCREEN_FEATURE}>
          <div className="fts-t">
            <b>{SCREEN_WORDS.name}</b>
            <span>{SCREEN_WORDS.line}</span>
          </div>
          <div className={`tm-ed-seg${can ? "" : " gs-notyet"}`} role="radiogroup" aria-label={SCREEN_WORDS.name}>
            <Choice selected={on} onPick={() => setOn(true)}>On</Choice>
            <Choice selected={!on} onPick={() => setOn(false)}>Off</Choice>
          </div>
        </li>
        {on && (
          <li className="fts-row" data-feature={`${SCREEN_FEATURE}-picture`}>
            <div className="fts-t">
              <b>{SCREEN_WORDS.picture}</b>
              <span>{SCREEN_WORDS.pictureLine}</span>
            </div>
            <div className="tm-ed-seg" role="radiogroup" aria-label={SCREEN_WORDS.picture}>
              {SCREEN_PICTURES.map((p) => <Choice key={p} selected={prefs.picture === p} onPick={() => set({ screenPicture: p })}>{SCREEN_WORDS.pictures[p]}</Choice>)}
            </div>
          </li>
        )}
        {on && (
          <li className="fts-row" data-feature={`${SCREEN_FEATURE}-hold`}>
            <div className="fts-t">
              <b>{SCREEN_WORDS.hold}</b>
              <span>{SCREEN_WORDS.holdLine}</span>
            </div>
            <div className="tm-ed-seg" role="radiogroup" aria-label={SCREEN_WORDS.hold}>
              {SCREEN_HOLDS.map((h) => <Choice key={h} selected={prefs.hold === h} onPick={() => set({ screenHoldKey: h })}>{SCREEN_WORDS.holds[h]}</Choice>)}
            </div>
          </li>
        )}
        {on && (
          <li className="fts-row" data-feature={`${SCREEN_FEATURE}-numbers`}>
            <div className="fts-t">
              <b>{SCREEN_WORDS.numbers}</b>
              <span>{SCREEN_WORDS.numbersLine}</span>
            </div>
            <div className="tm-ed-seg" role="radiogroup" aria-label={SCREEN_WORDS.numbers}>
              <Choice selected={prefs.numbers} onPick={() => set({ screenNumbers: true })}>On</Choice>
              <Choice selected={!prefs.numbers} onPick={() => set({ screenNumbers: false })}>Off</Choice>
            </div>
          </li>
        )}
        {on && (
          <li className="fts-row" data-feature={`${SCREEN_FEATURE}-anywhere`}>
            <div className="fts-t">
              <b>{SCREEN_WORDS.anywhere}</b>
              <span>{SCREEN_WORDS.anywhereLine}</span>
            </div>
            <div className="tm-ed-seg" role="radiogroup" aria-label={SCREEN_WORDS.anywhere}>
              <Choice selected={prefs.anywhere} onPick={() => set({ screenAnywhere: true })}>On</Choice>
              <Choice selected={!prefs.anywhere} onPick={() => set({ screenAnywhere: false })}>Off</Choice>
            </div>
          </li>
        )}
        {on && prefs.anywhere && <RelayRows url={prefs.relayUrl} saveUrl={(u) => set({ screenRelayUrl: u })} />}
      </ul>
    </div>
  );
}

// PS 1.77, From anywhere: the relay's address (with the other settings in the vault, so both Macs have it) and the relay key
// (typed on each Mac, straight to that Mac's own key store: the box is cleared and the key is never shown or kept here).
function RelayRows({ url, saveUrl }: { url: string; saveUrl: (u: string) => void }) {
  const relay = useSyncExternalStore(relayStore.subscribe, relayStore.get);
  const [draft, setDraft] = useState(url);
  const [bad, setBad] = useState(false);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { askRelay(); }, []);
  useEffect(() => { setDraft(url); }, [url]);
  const commitUrl = () => {
    const t = draft.trim();
    if (t === "") { setBad(false); if (url !== "") saveUrl(""); return; }
    const c = relayUrlClean(t);
    setBad(!c);
    if (c && c !== url) saveUrl(c);
  };
  const [keyNote, setKeyNote] = useState<string | null>(null);
  const saveKey = () => {
    const k = box.current?.value.trim() ?? "";
    if (box.current) box.current.value = "";
    if (!relayKeyOK(k)) { setKeyNote(SCREEN_WORDS.relayKeyBad); return; }
    setKeyNote(null);
    sfx.click();
    sendRelayKey(k);
  };
  const status = keyNote ?? (relay.last === "bad" ? SCREEN_WORDS.relayKeyBad : relay.key ? SCREEN_WORDS.relayKeySaved : SCREEN_WORDS.relayKeyMissing);
  return (
    <>
      <li className="fts-row" data-feature={`${SCREEN_FEATURE}-relay-url`}>
        <div className="fts-t">
          <b>{SCREEN_WORDS.relayUrl}</b>
          <span>{bad ? SCREEN_WORDS.relayUrlBad : SCREEN_WORDS.relayUrlLine}</span>
        </div>
        <input className="input" type="url" value={draft} maxLength={200} placeholder={SCREEN_WORDS.relayUrlHint} spellCheck={false} autoComplete="off"
          aria-label={SCREEN_WORDS.relayUrl} style={{ maxWidth: 320 }} onChange={(e) => setDraft(e.target.value)} onBlur={commitUrl}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitUrl(); } }} />
      </li>
      <li className="fts-row" data-feature={`${SCREEN_FEATURE}-relay-key`}>
        <div className="fts-t">
          <b>{SCREEN_WORDS.relayKey}</b>
          <span>{SCREEN_WORDS.relayKeyLine} {status}</span>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input ref={box} className="input" type="password" autoComplete="off" spellCheck={false} placeholder={SCREEN_WORDS.relayKeyHint} aria-label={SCREEN_WORDS.relayKey}
            defaultValue="" style={{ maxWidth: 220 }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveKey(); } }} />
          <button type="button" className="btn ghost sm" onClick={saveKey}>{SCREEN_WORDS.relayKeySave}</button>
          {relay.key && <button type="button" className="btn quiet sm" onClick={() => { sfx.click(); setKeyNote(null); sendRelayKey(""); }}>{SCREEN_WORDS.relayKeyRemove}</button>}
        </div>
      </li>
    </>
  );
}
