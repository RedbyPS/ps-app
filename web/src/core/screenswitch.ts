// The remote screen's switch and settings (PS 1.69): see and control your other Mac from this one, directly on the same
// network (ps-mac RemoteScreen*.swift). Part of Second Computer: it is offered only while Second Computer is on, and has its
// own switch, the feature "remote-screen" in core's features.json, off until switched on like Second Computer itself (on for
// the developer through his own layer). Its two settings travel with the other settings in the vault, so both Macs agree:
// Picture (how sharp the picture is, against how quick) and Delay numbers (a small line of delay numbers in the window).
// Pure, so tests import it directly.
import { switchOn, type Account } from "./features.ts";
import { secondCan } from "./secondswitch.ts";
import type { Snapshot } from "./vault.ts";

export const SCREEN_FEATURE = "remote-screen";
export type ScreenPicture = "sharp" | "faster" | "fastest";
export const SCREEN_PICTURES: ScreenPicture[] = ["sharp", "faster", "fastest"];
/** The hold key (part 2): § by default (the key left of 1 on Apple's British and European keyboards), others for keyboards
 *  without it, or off. The Mac maps them to key codes (ps-mac RSHoldKeys). */
export type ScreenHold = "section" | "grave" | "f13" | "f14" | "f15" | "f16" | "off";
export const SCREEN_HOLDS: ScreenHold[] = ["section", "grave", "f13", "f14", "f15", "f16", "off"];

declare module "./model" {
  interface Settings {
    /** Remote screen, Picture: sharp (the other Mac's own pixels), faster (1920 wide), fastest (1280 wide). Missing: sharp. */
    screenPicture?: ScreenPicture;
    /** Remote screen, Delay numbers in the window's corner. Missing: off. */
    screenNumbers?: boolean;
    /** Remote screen, Hold key: hold it to see the other Mac. Missing: § ("section"). */
    screenHoldKey?: ScreenHold;
  }
}

/** The person's own switch against this build's registry (off by default; on for the developer through his layer). */
export function screenSwitch(squadFeatures: unknown, account: Account): boolean {
  return switchOn(SCREEN_FEATURE, squadFeatures, account);
}
/** On only while Second Computer is on too (the remote screen uses its pairing). */
export function screenOn(s: Pick<Snapshot, "status" | "role">, secondIsOn: boolean, squadFeatures: unknown, account: Account): boolean {
  return secondCan(s) && secondIsOn && screenSwitch(squadFeatures, account);
}

/** The settings as the Mac takes them ({type: "screenPrefs", picture, numbers}); anything unknown falls back to the default. */
export function screenPrefsMsg(settings: { screenPicture?: unknown; screenNumbers?: unknown; screenHoldKey?: unknown }): { picture: ScreenPicture; numbers: boolean; hold: ScreenHold } {
  const p = settings.screenPicture, h = settings.screenHoldKey;
  return {
    picture: SCREEN_PICTURES.includes(p as ScreenPicture) ? (p as ScreenPicture) : "sharp",
    numbers: settings.screenNumbers === true,
    hold: SCREEN_HOLDS.includes(h as ScreenHold) ? (h as ScreenHold) : "section",
  };
}

/** The words in Settings (Second Computer, Remote screen): the developer approves them. */
export const SCREEN_WORDS = {
  name: "Remote screen",
  line: "See and control your other Mac from this one, on the same network.",
  picture: "Picture",
  pictureLine: "Faster is a little softer and quicker to react.",
  pictures: { sharp: "Sharp", faster: "Faster", fastest: "Fastest" } as Record<ScreenPicture, string>,
  numbers: "Delay numbers",
  numbersLine: "Shows how quick the picture is, in the window's corner.",
  hold: "Hold key",
  holdLine: "Hold it to see your other Mac, let go to put it away. Click while holding to keep it open.",
  holds: { section: "§", grave: "`", f13: "F13", f14: "F14", f15: "F15", f16: "F16", off: "Off" } as Record<ScreenHold, string>,
  switchTip: "Remote screen",
  switchLine: "See and control your other Mac",
};
