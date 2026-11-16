// Keeps feature() (core/features.ts) knowing who is signed in and their own "From the squad" switches, and hands every
// feature's answer to the Mac (V1.58, multiple developers). The Mac stores the answers (ps-mac Features.swift) so
// Features.on("id") agrees with the page, also on the next launch before the vault is open.
// Message to the Mac: {type: "features", on: {"<feature id>": true | false, ...}}, sent only when the answers change
// and only once someone is signed in (before that the Mac keeps what it was last told).
import { vaultStore, type Snapshot } from "./core/vault";
import { settingsData } from "./core/select";
import { accountKind } from "./core/account";
import { cleanSwitches, featureAnswers, registry, setFeatureContext, whoFor, type Account } from "./core/features";
import { profile } from "./core/profile";
import { SECOND_FEATURE, secondSwitch } from "./core/secondswitch";

// The person's own switches live with the other settings in the vault (saved per account, so they follow the person).
declare module "./core/model" {
  interface Settings {
    /** Settings, "From the squad" (V1.58): this person's On/Off per feature made by someone else (core/features.ts). Missing: the build's default. */
    squadFeatures?: Record<string, boolean>;
  }
}

/** The developer's own account, anyone else's, or nobody signed in yet. */
export function accountOf(s: Pick<Snapshot, "status" | "role" | "red">): Account {
  const k = accountKind(s);
  return k === null ? null : k === "red" ? "red" : "other";
}

// V1.61: every page starts it (App.tsx for the website, the Mac and the phone; the Mac's ps.ts and the phone's
// gos/main.tsx also hand over their shell's post), so feature() knows who is signed in everywhere. Before 1.61 only the
// Mac started it, so on the website and the phone feature() never knew the account and every friend's feature was off.
// The phone gets the same {type: "features"} message (ps-gos Features.kt receive), which keeps it for Remind.kt.
let started = false;
let post: ((m: object) => void) | undefined;
let last = "";
let run: () => void = () => {};
export function startFeatureSync(shellPost?: (m: object) => void): void {
  if (shellPost && !post) { post = shellPost; last = ""; }
  if (started) { run(); return; }
  started = true;
  run = () => {
    const s = vaultStore.get();
    const account = accountOf(s);
    const mine = cleanSwitches(settingsData(s).squadFeatures);
    setFeatureContext(account, mine);
    if (!post || account === null) return;
    const on = featureAnswers(registry(), whoFor(profile(), account), mine);
    // PS 1.65: Second Computer is a core feature with its own switch (Settings, Second Computer), so the person's answer
    // wins for it like on the page (core/secondswitch.ts), also on the developer's account. The Mac starts or stops it.
    if (SECOND_FEATURE in on) on[SECOND_FEATURE] = secondSwitch(mine, account);
    const key = JSON.stringify(on);
    if (key === last) return;
    last = key;
    post({ type: "features", on });
  };
  vaultStore.subscribe(run);
  run();
}
