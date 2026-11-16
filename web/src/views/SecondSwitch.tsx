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
      {on && <SecondSettings />}
    </>
  );
}
