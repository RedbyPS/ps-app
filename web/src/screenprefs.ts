// The remote screen's settings, the shell half (core/screenswitch.ts decides): tells the Mac (ps-mac RemoteScreen.setPrefs)
// the Picture and Delay numbers settings as {type: "screenPrefs", picture, numbers}. Sent when they change and every minute
// (a restarted shell catches up). While the vault is locked nothing is sent: the Mac keeps the last ones. Mac only.
import { vaultStore } from "./core/vault";
import { settingsData } from "./core/select";
import { screenPrefsMsg } from "./core/screenswitch";
import { lpInterval } from "./core/lowpower.ts";

type Post = (m: object) => void;

export function startScreenPrefs(post: Post) {
  let last = "";
  const sync = (force = false) => {
    const s = vaultStore.get();
    if (s.status !== "unlocked" || s.role !== "owner") return;
    const m = screenPrefsMsg(settingsData(s));
    const json = JSON.stringify(m);
    if (!force && json === last) return;
    last = json;
    post({ type: "screenPrefs", ...m });
  };
  let t = 0;
  vaultStore.subscribe(() => { clearTimeout(t); t = window.setTimeout(() => sync(), 150); });
  lpInterval("checks", () => sync(true), 60_000);
  sync();
}
