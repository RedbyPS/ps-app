// The email panel with nothing in it (V1.62, the developer 15 Nov 2026: "Why isn't the emails panel still not in the g squad
// release???"). Client emails is on for everyone now, so the panel shows in the Tab list even before Gmail is connected.
// With no email to show it says why: no Gmail account connected yet (a Connect Gmail button that opens Settings, Client
// emails, the 1.60 connect guide), or simply nothing new. Pure: no React, no network, so tests/public-on.test.ts loads it.

/** The panel's words in one place: the developer approves them (ps-handover-notes/v162-public-on.md, New words). */
export const MAIL_EMPTY_WORDS = {
  connect: "Connect your Gmail to see your clients' emails here.",
  button: "Connect Gmail",
  none: "No new client emails.",
  pick: "Gmail is connected. Pick whose emails show here.",
  pickButton: "Choose senders",
} as const;

/** true: at least one Gmail account is connected; false: none (or the check failed); null: not known yet. */
export type GmailKnown = boolean | null;

/** What the panel shows: the emails, the Connect Gmail prompt, "Gmail is connected, pick whose emails show" (nobody is a client
 *  or on the Always notify me list), the quiet "nothing new" line, or nothing for the moment it takes to ask (so the prompt never
 *  flashes up for someone who is connected). `gmail` is true as soon as the status check lists an account OR any Gmail mail
 *  already arrived (core/gmailtruth.ts). `seen`: the vault holds an Instantly reply. `picked`: someone is a client or on the list. */
export function mailPanelShows(o: { rows: number; replied: number; gmail: GmailKnown; seen: boolean; picked?: boolean }): "list" | "connect" | "pick" | "none" | "wait" {
  if (o.rows > 0 || o.replied > 0) return "list";
  if (o.gmail === true) return o.picked === false ? "pick" : "none";
  if (o.seen) return "none";
  return o.gmail === false ? "connect" : "wait";
}

/** The Gmail check's answer from the gmail_status rows (Settings, Client emails reads the same function). */
export function gmailKnownFrom(rows: unknown, failed: boolean): GmailKnown {
  if (failed) return false;
  return Array.isArray(rows) ? rows.length > 0 : false;
}
