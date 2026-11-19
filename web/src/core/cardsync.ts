// A Dismiss never comes back (the developer, 3 Nov 2026: dismissed Instantly and chat cards kept returning on the Mac
// and the phone). Lead and chat Dismisses live in the ONE settings record and client email Dismisses on each
// reply record, and the vault used to send a device's whole copy as it was: the phone (or a background check,
// or an unsent change kept from before a restart) still holding the copy from before the Mac's Dismiss wrote it
// back over the server's, and the card returned on both devices. These mergers join the two copies instead
// (core/vault.ts setMerger: before an unsent change goes up, the server's newer copy is merged into it).
// Everything else in the settings stays as this device has it, the same as before.
import type { Settings } from "./model";
import { mergeLeadState } from "./leadcards.ts";
import { mergeChatDone } from "./chatdone.ts";
import { mergeAiMsgs } from "./aimessage.ts";
import { mergeMailRules } from "./mailrules.ts";
import { mergeMailReply } from "./mailreply.ts";
import { mergePicks } from "./devicebg.ts";
import { LIST_KEYS, mergeLists } from "./keepunknown.ts";

// PS 1.68 (Jan, 18 Nov 2026: "on every single update it resets my things ... it deletes all of it and moves it all on the
// main page", and "sometimes it's resetting my settings"). The cause: every device writes the WHOLE settings record from
// its own copy, and this merger used to keep that whole copy. A device that had been closed for a while (the phone, a
// second Mac, a website tab) wakes up after an update, writes one small thing at once (What's new seen, the setup menu,
// the tips), and its old copy of everything else went up with it: the pages made since on the Mac (tmPages), so every
// panel on them fell back to the main page, and any setting changed elsewhere went back to its old value. Now the
// device says which settings it really changed (`changed`, from settingsWrite below): only those come from its copy,
// everything else stays as the server has it. Without `changed` (a change kept from before a restart whose list was
// lost) it does what it always did.
// PS 1.71 (core/keepunknown.ts mergeLists): a list this device changed (its pages, their order, the section order, the
// groups) is merged item by item with the server's, from `base` (the list as it was here before the change): pages made
// on another device meanwhile stay, even when this device's copy was old when the person changed a list here.
export function mergeSettings(local: Settings, remote: Settings, changed?: ReadonlySet<string>, base?: Readonly<Record<string, unknown>>): Settings {
  let out: Settings = { ...local };
  if (changed) {
    const o = { ...remote } as Record<string, unknown>, l = local as unknown as Record<string, unknown>;
    for (const k of changed) {
      if (!(k in l) || l[k] === undefined) { delete o[k]; continue; }
      o[k] = base && LIST_KEYS.has(k) && k in base ? mergeLists(k, base[k], l[k], o[k]) : l[k];
    }
    out = o as unknown as Settings;
  }
  const lead = mergeLeadState(local.leadCards, remote.leadCards);
  if (lead) out.leadCards = lead;
  const chat = mergeChatDone(local.chatDone, remote.chatDone);
  if (chat) out.chatDone = chat;
  const msgs = mergeAiMsgs(local.aiMsgs, remote.aiMsgs);   // V1.58: messages from AIs, a Dismiss on either device holds
  if (msgs) out.aiMsgs = msgs;
  const rules = mergeMailRules(local.mailRules, remote.mailRules);   // Always notify me and Muted, entry by entry
  if (rules) out.mailRules = rules;
  const reply = mergeMailReply(local.mailReply, remote.mailReply);   // signatures and saved responses: the newer change
  if (reply) out.mailReply = reply;
  const picks = mergePicks(local.tmBgDev, remote.tmBgDev);   // a background for each device (PS 1.65): per device, the later pick wins
  if (picks) out.tmBgDev = picks;
  return out;
}

/** One settings save (core/actions.ts saveSettings): the record to write and the settings it really changes (a value the
 *  same as before is no change, so the other device's newer value of it wins). base: this device's copy, or null when
 *  the account has no settings record here yet: then only the change is written, never the defaults, so the record that
 *  is about to arrive keeps every choice in it (core/select.ts folds two records by time, the newer one's keys win).
 *  fresh: the first download is done and there really is no record (a new account): the defaults go in as before. */
export function settingsWrite(base: Settings | null | undefined, patch: Partial<Settings>, defaults: Settings, fresh = false): { data: Settings; changed: string[] } {
  const b = (base ?? {}) as Record<string, unknown>, p = patch as Record<string, unknown>;
  // A key set to undefined takes that setting away (as it always did): a change too, when there was one.
  const changed = Object.keys(p).filter((k) => JSON.stringify(p[k]) !== JSON.stringify(b[k]));
  return { data: (base ? { ...defaults, ...base, ...patch } : { ...(fresh ? defaults : {}), ...patch }) as Settings, changed };
}

/** What one page run remembers of the cards the developer dismissed on it (src/mailcards.ts), so a Dismiss lost on the way
 *  (a race with the other device, a save that never left) is written again instead of the card coming back.
 *  A client email or a chat counts only for the email or the finish it was on; a lead card is one email. */
export type Dismissed = Map<string, { at: string; t: number }>;
export const DISMISS_HOLD_MS = 24 * 3600_000;

export function heldDismissed(d: Dismissed, id: string, at: string, now: number): boolean {
  const x = d.get(id);
  if (!x || now - x.t > DISMISS_HOLD_MS) return false;
  return id.startsWith("n:") || (!!x.at && x.at === at);
}
