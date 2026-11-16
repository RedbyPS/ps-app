// PS > Settings (the gear, top right). Settings for this Mac only, kept by the PS app itself.
// Auto reboot, Are you sure and signing out of this Mac moved to Security (the padlock, views/Security.tsx,
// The developer 1 Nov 2026: "all the security settings all in one place"); a row here says so and opens it.
import { useEffect, useState } from "react";
import { psPost, usePsSettings, usePsTab } from "../ps";
import { Icon } from "../ui/kit";
import { SoundSetting } from "./Settings";
import { AfkSettings } from "./AfkSettings";
import { AutoResetSetting } from "./AutoReset";
import { MediaGuardSettings } from "./MediaGuardSettings";
import { MiddleClickSettings } from "./MiddleClickSettings";
import { RemindSettings } from "./RemindSettings";
import { MailPeople } from "./MailPeople";
import { ClientEmailsSettings } from "./ClientEmailsSettings";
import { ProtonBridgeSettings } from "./ProtonBridgeSettings";
import { WhatsAppSettings } from "./WhatsAppSettings";
import { mailOnSnap } from "../core/mailsnap";
import { mailCan } from "../core/mailswitch";
import { InviteOwners } from "./InviteOwners";
import { SecondSwitch } from "./SecondSwitch";
import { openSecurity } from "./Security";
import { openMacSettings } from "./MacSettings";
import { PsProjectSetting } from "./PsCreate";
import { isRedAccount } from "../core/account";
import { useVault } from "../ui/kit";
import { settingsData } from "../core/select";
import { saveSettings } from "../core/actions";
import type { Settings } from "../core/model";
import { islandPrefs, type IslandPrefs } from "../core/island";
import { IslandSettingsPage } from "./IslandSettings";
import { APP_NAME_MAX, appName, appNameProblem, macListHint, tidyAppName } from "../core/appname";
import { TAB_STAYS_HINT, tabStaysShown } from "../core/tabstays";
import { OpenShortcuts } from "./OpenShortcuts";
import "./screentime.css";

/** overlay: drawn in the Tab list's Mac settings window (MacSettings.tsx, V1.23), which holds no keys:
 *  vault settings go to the engine page as a "looks" patch (ps.ts cleanLooks), and Invite owners stays
 *  on the website (it needs the vault itself). */
export function PsSettingsView({ onBack, overlay }: { onBack?: () => void; overlay?: boolean }) {
  const st = usePsSettings();
  const s = useVault();
  const red = isRedAccount(s);
  const saveVault = (patch: Partial<Settings>) => {
    if (overlay) psPost({ type: "looks", patch });
    else void saveSettings(patch);
  };
  useEffect(() => { psPost({ type: "psSettings:get" }); }, []);

  return (
    <div className="stack">
      {onBack && (
        <div className="row" style={{ gap: 12, alignItems: "center" }}>
          <button className="btn ghost sm" onClick={onBack}><Icon name="back" /> To-do</button>
          <h1 className="h1">Settings</h1>
        </div>
      )}

      {overlay && <PermissionRow />}
      <SecurityMoved />
      <TabSettings />

      <ScreenTimeSection />

      {overlay && <AppNameSetting />}
      <IslandPlace moved={!!st?.islandMoved} ready={!!st} prefs={islandPrefs(settingsData(s).island)} save={saveVault} />
      <SecondSwitch />{/* PS 1.65: everyone's, behind its own switch */}
      <AfkSettings />
      <MediaGuardSettings />{/* the AirPods card: everyone's (V1.40), off until switched on */}
      <MiddleClickSettings />
      {/* The daily reminder is reminder one of the Annoying 15 min reminders (V1.46): everyone's, with its own words. */}
      <section className="panel stack" aria-labelledby="rem-ps-h">
        <h2 className="h2" id="rem-ps-h">Annoying 15 min reminder</h2>
        <RemindSettings />
      </section>
      {mailCan(s) && <ClientEmailsSettings compact />}
      <ProtonBridgeSettings />
      {mailCan(s) && <WhatsAppSettings />}
      {mailOnSnap(s) && (
        <section className="panel stack" aria-labelledby="gm-ps-h">
          <h2 className="h2" id="gm-ps-h">Gmail replies</h2>
          <MailPeople overlay={overlay} />
        </section>
      )}
      {overlay
        ? red && <p className="mac-note">Invite people to PS app: cincee.com/client, Settings, Invite owners.</p>
        : <InviteOwners />}

      <PsProjectSetting />{/* the Supabase project this Mac uses (views/PsCreate.tsx, 5 Nov 2026) */}

      {/* End of day: only the automatic reset and its time. PS never asks "Shall I end my day now?" (removed 2 Nov 2026). */}
      {overlay && (
      <section className="panel stack" aria-labelledby="eod-h">
        <h2 className="h2" id="eod-h">End of day</h2>
        <AutoResetSetting st={settingsData(s)} save={saveVault} />
      </section>
      )}

    </div>
  );
}

/** Track my screen time (this Mac, kept by PS). */
function ScreenTimeSection() {
  const st = usePsSettings();
  return (
    <section className="panel stack" aria-labelledby="st-set-h">
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 className="h2" id="st-set-h">Screen time</h2>
        {st && <span className={`pill ${st.screenTime ? "good" : "ink"}`}>{st.screenTime ? "On" : "Off"}</span>}
      </div>
      <label className="st-switch">
        <input type="checkbox" className="check" checked={!!st?.screenTime} disabled={!st}
          onChange={(e) => psPost({ type: "psSettings:screenTime", on: e.target.checked })} />
        <span className="stack tight" style={{ gap: 2 }}>
          <b className="small">Track my screen time with {appName()}</b>
          <span className="xs muted">
            {appName()} counts how long each app is in front, so you can see it on your To-do page and in the Map.
            Only app names are kept: never window titles, websites or screenshots. Five minutes with no
            mouse or keyboard, a locked screen or a sleeping Mac do not count. Your totals are saved
            encrypted in your vault; this Mac keeps the last two weeks in a small file in its own folder.
          </span>
        </span>
      </label>
    </section>
  );
}

/** App name (V1.36, the developer 6 Nov 2026: "in the settings menu make it so you can change the name of the app too"). The name is
 *  the app's folder in Applications; PS renames it in one step and opens itself again (ps-mac AppRename.swift). A click on
 *  Rename only; a name that cannot be used is said in plain words here, a taken one by PS. */
export function AppNameSetting() {
  const a = usePsSettings()?.appName;
  const cur = a?.name ?? appName();
  const [typed, setTyped] = useState<string | null>(null);   // null: the current name
  const [mine, setMine] = useState<string | null>(null);     // what is wrong with the typed name, said here
  const [edited, setEdited] = useState(false);               // typed since PS last answered: its old answer goes
  const value = typed ?? cur;
  const off = !a || a.busy || !a.canRename;
  const go = () => {
    if (off) return;
    const t = tidyAppName(value);
    const why = appNameProblem(t) ?? (t === cur ? `It is already called ${t}.` : null);
    setMine(why); setEdited(false);
    if (!why) psPost({ type: "appName:set", name: t });
  };
  const err = mine ?? (edited ? null : a?.error ?? null);
  return (
    <section className="panel stack" aria-labelledby="an-h">
      <h2 className="h2" id="an-h">App name</h2>
      <div className="row an-row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input className="input" value={value} maxLength={a?.max ?? APP_NAME_MAX} disabled={off} spellCheck={false} autoComplete="off"
          aria-labelledby="an-h" style={{ maxWidth: 320 }}
          onChange={(e) => { setTyped(e.target.value); setMine(null); setEdited(true); }} onKeyDown={(e) => { if (e.key === "Enter") go(); }} />
        <button className="btn primary sm an-go" disabled={off} onClick={go}>{a?.busy ? "Renaming…" : "Rename"}</button>
      </div>
      {err && <small className="hint an-err" role="alert">{err}</small>}
      <small className="hint">
        {a && !a.canRename ? "Only the copy in your Applications folder can be renamed. " : ""}
        What it is called in Applications, Finder, Launchpad and Spotlight. Renaming opens it again once. The bold name in
        the menu bar stays PS: macOS reads that from inside the app.
      </small>
    </section>
  );
}

/** Where the security settings went (the padlock, top right of the Tab list). */
function SecurityMoved() {
  return (
    <div className="ms-moved" role="note">
      <span>
        <b>Security has its own place now:</b> auto reboot and the restart helper, your other Mac (lock, restart, shut down,
        postpone), your phone, Are you sure and Sign out are behind the padlock, top right of the Tab list.
      </span>
      {/* Mac settings goes first (PS's pin follows the last window to say so), then Security grows out of the padlock. */}
      <button type="button" className="btn primary sm" onClick={() => { openMacSettings(false); window.setTimeout(() => openSecurity(true), 150); }}>Open Security</button>
    </div>
  );
}

// Tab over other apps needs macOS's permission (it used to be a banner on the main window).
export function PermissionRow() {
  const tab = usePsTab();
  if (!tab || !tab.enabled || tab.trusted) return null;
  return (
    <div className="mac-perm" role="status">
      <span><b>Tab over other apps is off.</b> Turn on {appName()}{macListHint()} in Privacy and Security, Accessibility.</span>
      <span className="row" style={{ gap: 8 }}>
        <button className="btn sm primary" onClick={() => psPost({ type: "tab:fix" })}
          title={`Clears ${appName()}'s old permission entry and asks macOS for a fresh one. Then switch ${appName()} on in the list.`}>Fix permission</button>
        <button className="btn sm" onClick={() => psPost({ type: "tab:permission" })}>Open Settings</button>
      </span>
    </div>
  );
}

// Tab keeps the list open (the developer, 7 Nov 2026), this Mac only. Everyone sees it, the public build too. Click only.
export function TabStaysSetting() {
  const st = usePsSettings();
  const on = tabStaysShown(st, isRedAccount(useVault()));
  return (
    <div className="stack tight">
      <span className="small" style={{ fontWeight: 600, color: "var(--ink-2)" }} id="ts-l">Tab keeps the list open</span>
      <div className="tabs" role="radiogroup" aria-labelledby="ts-l" style={{ justifySelf: "start" }}>
        <button className="tab" role="radio" aria-checked={on} aria-selected={on} disabled={!st} onClick={() => { if (!on) psPost({ type: "psSettings:tabStays", on: true }); }}>On</button>
        <button className="tab" role="radio" aria-checked={!on} aria-selected={!on} disabled={!st} onClick={() => { if (on) psPost({ type: "psSettings:tabStays", on: false }); }}>Off</button>
      </div>
      <small className="hint">{TAB_STAYS_HINT}</small>
    </div>
  );
}

// Which key shows the list over other apps, and apps where PS leaves that key alone.
function TabSettings() {
  return (
    <section className="panel stack" aria-labelledby="tk-h">
      <h2 className="h2" id="tk-h">Task list over other apps</h2>
      <OpenShortcuts permission={false} />
      <TabStaysSetting />
      <SoundSetting />
      <IgnoredAppsSetting />
    </section>
  );
}

/** Apps where PS leaves the key alone (games that use hold Tab). */
export function IgnoredAppsSetting() {
  const st = usePsSettings();
  const [pick, setPick] = useState("");
  const ignored = st?.ignoredApps ?? [];
  const options = (st?.runningApps ?? []).filter((a) => !ignored.some((i) => i.id === a.id));
  const setIgnored = (ids: string[]) => psPost({ type: "psSettings:ignore", ids });
  return (
    <div className="stack tight">
      <span className="small" style={{ fontWeight: 600, color: "var(--ink-2)" }}>Leave the key alone in these apps</span>
      {ignored.length === 0 && <small className="hint">None. Add games that use hold Tab for their scoreboard.</small>}
      {ignored.map((a) => (
        <div key={a.id} className="row" style={{ gap: 8 }}>
          <span>{a.name}</span>
          <button className="btn quiet sm" onClick={() => setIgnored(ignored.filter((i) => i.id !== a.id).map((i) => i.id))}>Remove</button>
        </div>
      ))}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">Pick an open app</option>
          {options.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button className="btn ghost sm" disabled={!pick} onClick={() => { setIgnored([...ignored.map((i) => i.id), pick]); setPick(""); }}>Add</button>
        <button className="btn quiet sm" onClick={() => psPost({ type: "psSettings:get" })}>Refresh list</button>
      </div>
      <small className="hint">The app has to be open to appear in the list.</small>
    </div>
  );
}

/** Where the Dynamic Island sits and everything else about it, on the older Mac settings page: the same shared settings
 *  as the island settings window and Settings, Dynamic Island (V1.58, views/IslandSettings.tsx), so they never drift. */
export function IslandPlace({ moved, ready, prefs, save }: { moved: boolean; ready: boolean; prefs: IslandPrefs; save: (p: Partial<Settings>) => void }) {
  return (
    <section className="panel stack" aria-labelledby="isl-pos-h">
      <div className="row" style={{ gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 className="h2" id="isl-pos-h">Dynamic Island</h2>
        {ready && <span className={`pill ${moved ? "ink" : "good"}`}>{moved ? "Moved" : "At the top"}</span>}
      </div>
      <IslandSettingsPage prefs={prefs} save={(p) => save({ island: { ...prefs, ...p } })} />
    </section>
  );
}
