// Settings, Second Computer (PS 1.65): the feature's own On/Off switch, shown to every owner in PS on a Mac (public build
// too: every public feature has a visible switch). Off until switched on (it pairs two Macs); on for the developer as
// before (core/secondswitch.ts). Saved with the other settings in the vault (squadFeatures), so it follows the person to
// every device; src/featuresync.ts hands the answer to the Mac, which starts or stops its half (ps-mac Second.setOn), and
// ps.ts starts or stops the page's half. While it is on, the old settings panel follows (views/Second.tsx SecondSettings).
// It sits inside Settings, so Esc closes it with Settings (views/SettingsScreen.tsx).
import { useVault } from "../ui/kit";
import { sfx } from "../ui/sfx";
import { settingsData } from "../core/select";
import { cleanSwitches } from "../core/features";
import { SECOND_FEATURE, SECOND_WORDS, secondCan } from "../core/secondswitch";
import { secondOnSnap } from "../core/secondsnap";
import { Choice, taskMapActions } from "./TaskMap";
import { SecondSettings } from "./Second";
import { SCREEN_FEATURE, SCREEN_HOLDS, SCREEN_PICTURES, SCREEN_WORDS, screenPrefsMsg, screenSwitch, type ScreenHold } from "../core/screenswitch";
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
  const set = (o: { screenPicture?: (typeof SCREEN_PICTURES)[number]; screenNumbers?: boolean; screenHoldKey?: ScreenHold }) => { if (can) { sfx.hover(); void taskMapActions.looks(o); } };
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
      </ul>
    </div>
  );
}
