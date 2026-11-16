// The phone's own settings as rows of Settings (V1.47). The developer, 10 Nov 2026: "Redesign the settings menu on the GOS app. I
// don't like how cluttered it is. Do the same kind of redesign we did with the macOS app, where everything's got its own
// tab." The long Phone settings sheet (gos/GosSettings.tsx) is gone: the gear opens the same Settings as the Mac (a
// search bar and a list of groups, each its own clean screen, views/SettingsScreen.tsx) and every phone setting is one
// row in the group it belongs to (core/settingsindex.ts, the entries with `shell`). The pieces are the old sheet's own
// (switches, permission rows, the update card, Your Macs, background videos), so nothing behaves differently.
// GrapheneOS app rows ("gos") only show inside ps-gos; the iPhone web app rows ("mweb") only in the web app.
import { useState } from "react";
import { MOBILE_APP_NAME } from "../core/appname";
import { activeProject } from "../core/project";
import { lock, lockPhone, phoneKept } from "../core/vault";
import { useVault } from "../ui/kit";
import { secondOnSnap } from "../core/secondsnap";
import { openSettings, SetRow, type Controls, type RowProps } from "../views/SettingsScreen";
import { canVibrate, gos, haptic, MWEB, setWebPrefs, useGos, type GosPrefs } from "./bridge";
import { LayoutPicker, PermBtn, PermRow, Row, Switch, OPENERS } from "./GosSettings";
import { GosUpdateCard } from "./GosUpdate";
import { GosBackgrounds } from "./GosBackgrounds";
import { GosMacs } from "./GosMacs";
import { projectHost } from "../mobile/link";
import { changeProject } from "../mobile/MobileSettings";
import { appBase, isStandalone } from "../mobile/platform";

const setP = (patch: Partial<GosPrefs>) => { haptic("press"); gos.setPrefs(patch); };
/** A body of old sheet pieces: their card look, without the sheet's own section heading (the row names it). */
const Card = ({ children }: { children: React.ReactNode }) => <div className="gs-phone"><div className="gos-card">{children}</div></div>;
const Bare = ({ children }: { children: React.ReactNode }) => <div className="gs-phone gs-phone-bare">{children}</div>;
const Note = ({ children }: { children: React.ReactNode }) => <p className="gs-set-note">{children}</p>;

export const PHONE_CONTROLS: Controls = {
  // Appearance
  "phone-layout": ({ e }: RowProps) => <SetRow e={e} body={<Bare><LayoutPicker bare /></Bare>} open plain />,
  "phone-videos": ({ e }: RowProps) => <SetRow e={e} body={<Bare><GosBackgrounds /></Bare>} plain />,

  // Notifications
  "phone-checks": function Checks({ e }: RowProps) {
    const p = useGos().prefs;
    return <SetRow e={e} right={<Switch on={!!p?.background} onChange={(v) => setP({ background: v })} label={e.name} />}
      body={<Note>Every 15 minutes or so (less while the phone sleeps) PS app asks the vault one tiny question: did anything change? Only then does it fetch the changes. No Google services, no push servers. Instant notifications make it seconds.</Note>} />;
  },
  "phone-live": function Live({ e }: RowProps) {
    const g = useGos(), p = g.prefs, on = p?.live !== false;
    return <SetRow e={e} right={<Switch on={on} onChange={(v) => setP({ live: v })} label={e.name} />}
      body={<Note>{!p?.background ? "Needs Background checks on." : on
        ? `PS app keeps one quiet connection to your vault and hears the moment something new arrives, so notifications come within seconds. Only an empty signal travels; the email itself comes through the normal sync.${g.perms?.live ? " Connected now." : ""}`
        : "Off: notifications come with the background check, every 15 minutes or so."}</Note>} open />;
  },
  "phone-perms": function Perms({ e }: RowProps) {
    const perms = useGos().perms;
    return <SetRow e={e} plain body={<Card>
      <PermRow perms={perms} which="notifications" title="Notifications" desc="So client emails and calls can reach you." />
      <PermRow perms={perms} which="exactAlarm" title="Calls on the minute" desc="The 10 minute call alert rings on time instead of up to 15 minutes late." />
      <PermRow perms={perms} which="fullScreen" title="Gym alarm on the lock screen" desc="The gym ring and your alarms show their big card over the lock screen. Without it, they still ring, as a notification." />
      <PermRow perms={perms} which="battery" title="Run while the phone sleeps" desc="Optional. Without it checks still happen, just later when the phone is idle." />
    </Card>} />;
  },
  "mweb-alerts": ({ e }: RowProps) => <SetRow e={e} body={<Note>{`Meetings and new tasks show inside ${MOBILE_APP_NAME} while it is open. Alerts while it is closed come in a later version.`}</Note>} />,

  // Time and reset
  "phone-screen-time": function ScreenTimeRow({ e }: RowProps) {
    const p = useGos().prefs;
    return <SetRow e={e} right={<Switch on={p?.screenTime !== false} onChange={(v) => setP({ screenTime: v })} label={e.name} />} />;
  },
  "phone-usage": function Usage({ e }: RowProps) {
    const perms = useGos().perms;
    return <SetRow e={e} right={perms?.usage ? <span className="gos-ok">Allowed</span> : <PermBtn which="usage" text="Allow" />} />;
  },

  // Sync and account
  "mweb-project": function Project({ e }: RowProps) {
    const local = !!useVault().local;
    const [sure, setSure] = useState(false);
    if (local) return null;
    const host = projectHost(activeProject()?.url || "") || "Not connected";
    return <SetRow e={e} right={sure
      ? <button type="button" className="gos-btn sm" onClick={() => { haptic("reject"); void changeProject(); }}>Sign out</button>
      : <button type="button" className="gos-btn sm ghost" onClick={() => { haptic("press"); setSure(true); }}>Change</button>}
      body={<Note>{host}. Changing it signs you out on this phone; nothing is deleted.</Note>} open />;
  },

  // Privacy and sharing
  "phone-ays": function Ays({ e }: RowProps) {
    const g = useGos(), p = g.prefs, perms = g.perms;
    const need = p?.ays && perms && (!perms.usage || !perms.overlay);
    return <SetRow e={e} right={<Switch on={!!p?.ays} onChange={(v) => setP({ ays: v })} label={e.name} />}
      body={need ? <div className="gs-phone-need"><Note>Never during a call or a meeting. It needs one more permission:</Note><PermBtn which={!perms.usage ? "usage" : "overlay"} text={!perms.usage ? "Allow Usage access" : "Allow Display over other apps"} /></div> : undefined} open={!!need} />;
  },
  "phone-signin": function SignIn({ e }: RowProps) {
    const g = useGos();
    return <SetRow e={e} right={g.remembered
      ? <button type="button" className="gos-btn sm ghost" onClick={() => { haptic("reject"); gos.forget(); }}>Forget</button>
      : <span className="gos-ok gs-phone-off">Off</span>}
      body={g.remembered ? undefined : <Note>Sign in with your passphrase once and PS app offers it.</Note>} open />;
  },
  "phone-stay": function Stay({ e }: RowProps) {
    const g = useGos();
    if (!g.remembered) return null;   // it keeps a copy of the fingerprint keys: nothing to keep without them
    const on = g.prefs?.stay !== false;
    return <SetRow e={e} right={<Switch on={on} onChange={(v) => setP({ stay: v })} label={e.name} />}
      body={<Note>{on ? "Your keys stay sealed in this phone's Keystore. Lock still locks it: the next open then asks for your fingerprint once." : "Your fingerprint every time PS app opens, and it locks after a while unused."}</Note>} open />;
  },
  "phone-lock": function Lock({ e }: RowProps) {
    const local = !!useVault().local;
    if (MWEB && local) return null;   // local first: no passphrase yet, so nothing to lock with
    return <SetRow e={e} right={<button type="button" className="gos-btn sm" onClick={() => { haptic("press"); openSettings(null); if (MWEB && phoneKept()) void lockPhone(); else if (MWEB) lock(); else gos.lock(); }}>Lock</button>}
      body={MWEB && phoneKept() ? <Note>Signed in from your Mac: this phone stays signed in. Lock forgets that here, and your passphrase opens it again.</Note> : undefined} open={MWEB && phoneKept()} />;
  },

  // This phone
  "phone-open": function Open({ e }: RowProps) {
    const g = useGos(), p = g.prefs, perms = g.perms;
    return <SetRow e={e} plain body={<Card>
      {OPENERS.map((o) => (
        <Row key={o.k} title={o.t} desc={o.d}
          right={<Switch on={!!p?.[o.k]} onChange={(v) => setP({ [o.k]: v } as Partial<GosPrefs>)} label={o.t} />}
          extra={o.k === "bubble" && p?.bubble && perms && !perms.overlay ? <PermBtn which="overlay" text="Allow Display over other apps" /> : null} />
      ))}
    </Card>} open />;
  },
  "phone-island": function IslandRow({ e }: RowProps) {
    const g = useGos(), p = g.prefs, perms = g.perms, on = p?.island !== false;
    const needOverlay = on && perms && !perms.overlay;
    const needUsage = on && perms && !needOverlay && perms.islandUsage && !perms.usage;
    return <SetRow e={e} right={<Switch on={on} onChange={(v) => setP({ island: v })} label={e.name} />}
      body={<div className="gs-phone-need">
        <Note>Your next meeting, Pomodoro breaks, stand-ups, reminders and AI messages show around the camera, over every app. Tap it to open PS app, hold it to hide it for 30 minutes. Never on the lock screen; it steps aside while an app is full screen.</Note>
        {needOverlay && <><Note>It needs one permission, called Display over other apps.</Note><PermBtn which="overlay" text="Allow Display over other apps" /></>}
        {needUsage && <><Note>On your build it stays away from 1Password and Signal. To know when they are open it needs Usage access.</Note><PermBtn which="usage" text="Allow Usage access" /></>}
      </div>} open={on} />;
  },
  "phone-haptics": function Haptics({ e }: RowProps) {
    const p = useGos().prefs;
    if (MWEB && !canVibrate()) return <SetRow e={e} body={<Note>This browser cannot vibrate (iPhone browsers never can), so there is nothing to switch on here.</Note>} open />;
    return <SetRow e={e} right={<Switch on={p?.haptics !== false} label={e.name}
      onChange={(v) => { if (MWEB) { setWebPrefs({ haptics: v }); if (v) haptic("press"); } else setP({ haptics: v }); }} />} />;
  },
  "mweb-install": function Install({ e }: RowProps) {
    if (isStandalone()) return null;
    return <SetRow e={e} right={<a className="gos-btn sm" href={`${appBase(location.pathname)}install`}>How</a>}
      body={<Note>A Home Screen app keeps its own sign in, so you sign in there once more.</Note>} />;
  },
  "phone-macs": function Macs({ e }: RowProps) {
    const on = secondOnSnap(useVault());   // PS 1.65: Second Computer's switch (core/secondswitch.ts); the index says so too (core/settingsindex.ts)
    return <SetRow e={e} body={<Bare>{on && <GosMacs />}</Bare>} open plain />;
  },
  "phone-not-here": ({ e }: RowProps) => <SetRow e={e} body={<Note>Per app network rows are left out on purpose: they would need a VPN service, which would push your VPN aside. All PS app traffic goes through your VPN like every other app.</Note>} />,

  // About and updates
  "phone-updates": function Updates({ e }: RowProps) {
    const perms = useGos().perms;
    return <SetRow e={e} plain open body={<Bare>
      <GosUpdateCard />
      {perms && !perms.install && <div className="gos-card"><PermRow perms={perms} which="install" title="Install updates" desc="Once only: lets PS install its own updates (you still confirm each one). GrapheneOS lists it as Install unknown apps." /></div>}
    </Bare>} />;
  },
};
