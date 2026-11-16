// "Copy for your AI" (Client emails, the developer's friend, 15 Nov 2026): one button that copies a complete, self
// contained prompt. Paste it into Claude Code or Codex and it connects Gmail (and Instantly, if used) to PS end to end.
// Every step below is the same one the manual guide (core/mailsetup.ts) lists, written for an AI helper: the migrations,
// the four mail functions, the Google Cloud client, the one time code, scripts/gmail-connect.mjs, the check in Settings,
// Client emails, and Reply from PS app for sending. Pure and unit tested (tests/mailaiprompt.test.ts).
// Never in the text: a key, a token, an address of a person, a password. The only project value is the public project
// ref and its public address, which the person already sees in their own Supabase dashboard.
import { deployCommand, functionsUrl, setProjectSql, validRef } from "./mailsetup.ts";

/** The words on screen, in one place (the developer approves them). */
export const AI_COPY_WORDS = {
  button: "Copy for your AI",
  line: "Copies everything your AI needs to connect your Gmail to PS. Paste it into Claude Code or Codex.",
  pick: "Copy for your AI. Pick how it helps:",
  guideButton: "AI guides, you click",
  guideLine: "Your AI opens each page and tells you exactly what to press.",
  clicksButton: "AI does the clicks",
  clicksLine: "Your AI uses screen or browser control to click through. You only sign in, type passwords and press Allow.",
  done: "Copied. Paste it into Claude Code or Codex.",
  failed: "Could not copy. Try again, or use Do it by hand instead.",
  hand: "Do it by hand instead",
} as const;

/** How the AI helps: "guide" tells me what to press, "clicks" presses it itself with screen or browser control. */
export type AiMode = "guide" | "clicks";
export const AI_MODES: readonly AiMode[] = ["guide", "clicks"];

export const PS_REPO = "https://github.com/RedbyPS/ps-app";

/** The prompt. `ref`: the person's own Supabase project ref, or null when PS does not know it yet. */
export function mailAiPrompt(ref: string | null, mode: AiMode = "guide"): string {
  const clicks = mode === "clicks";
  const known = validRef(ref);
  const r = known ? ref : "";
  const project = known
    ? [
        `My Supabase project address: ${functionsUrl(r).replace("/functions/v1", "")}`,
        `My project ref: ${r}`,
      ]
    : [
        "PS does not know my Supabase project yet. Ask me for my project ref before step 2. It is 20 lowercase letters and numbers and is the first part of my Supabase project address.",
        "If I have no Supabase project connected to PS, tell me to do that first in PS (Settings, Sync and account, Supabase project) and stop. Client emails only works for the first owner of their own project.",
      ];
  const R = known ? r : "<my project ref>";
  const L = [
    "Please help me connect my Gmail to PS, my to do app, so my clients' emails show up in PS. You can be Claude Code, Codex or any other coding AI. Work through the steps below with me, one at a time, and tell me in plain words what you are doing.",
    "",
    "HOW WE WORK",
    ...(clicks
      ? [
          "You do the clicks yourself. Use whatever screen or browser control you have (for example Claude in Chrome, Claude computer use or Codex computer use) to open each Google Cloud and Supabase page and press the buttons, type the names and read the pages. Tell me in one short line what you are about to do before each step.",
          "You hand over to me ONLY for: signing in, any password (including my Mac password when something installs), Google's Allow and consent screens, and the Advanced, Go to app warning. Say clearly when you are waiting for me and what I should do, then carry on when I say done.",
          "Before each Google Cloud step, check the project picker at the top of the page shows MY PS project (the one made in step 4). If it shows another project, switch to the right one first, and never change anything in a project that is not mine.",
          "If you have no screen or browser control, or a page will not load or looks different from what I describe, do that step the other way: open the page link for me and tell me exactly what to press, then carry on with the next step.",
        ]
      : [
          "I do the clicks, you open each page and tell me exactly what to press. You run the commands.",
        ]),
    "",
    "WHAT PS IS",
    `PS is a to do app for Mac, the web and Android. Its source is public: ${PS_REPO}. Its Client emails feature checks my Gmail every 2 minutes with read only access, using functions that run in my OWN Supabase project, and shows the emails as cards and in an email panel. Replying is done by the PS Mac app with its own Google sign in, which it keeps in this Mac's Keychain. Instantly replies can be added too, but that part is optional.`,
    "",
    "MY PROJECT",
    ...project,
    "",
    "SAFETY RULES (follow all of them)",
    "- I sign in to Google and Supabase myself. You never type my passwords.",
    "- Never ask me to paste, and never print or read out, a key, a token, a password or the contents of my Google client file, here or in any file. The only places they may live are the ones PS's own script uses (the folder ~/.ps-gmail, made private by the script) and this Mac's Keychain.",
    "- Before any click or command that grants access to my accounts, say what it grants and wait for my yes. Google's Allow click is always mine.",
    "- Only change PS's folder, my own Google Cloud project and my own Supabase project. Delete nothing. Ask before installing any software.",
    "- If a step fails, show me the plain error and stop there. Do not invent a different way around it.",
    "",
    "STEPS",
    `1. Get PS's code. If there is no copy on this Mac, run: git clone ${PS_REPO}. If there is one, git pull it. Everything below is run from its web folder. You need node and the Supabase command line. Tell me which is missing and ask before installing it. On a Mac the Supabase command line comes from Homebrew (brew install supabase/tap/supabase). If Homebrew is missing too, give me the install line from brew.sh to run in my own Terminal app (it asks for my Mac password, which only I type), then add brew to my shell yourself.`,
    "2. I sign in to the Supabase command line myself: give me the line supabase login to run in my own Terminal app (it opens my browser). From then on you run the SQL below yourself with supabase db query, so I do not copy and paste. Newer versions ask an AI helper to confirm: add --yes to a command that changes something (after telling me what it does), and --read-only to one that only reads.",
    `   Check my project has PS's mail setup: supabase db query --remote=${R} --yes "${setProjectSql(R)}" (it stores my project's own address for the 2 minute timers). If you cannot run it, open my SQL editor${known ? ` (https://supabase.com/dashboard/project/${r}/sql/new)` : ""} and have me run: ${setProjectSql(R)}`,
    `   If it says the function does not exist, the mail tables are missing. Run each file web/supabase/migrations/031_gmail_inbox.sql, 032, 033, 034, 035, 036 and 037 (the file names in that folder that start with those numbers), in that order, with supabase db query --remote=${R} --yes --file <that file>. Then run the check again.`,
    `3. Deploy the four mail functions to my project. Run these from the web folder (add --yes if it asks you to confirm):`,
    ...deployCommand(R).split("\n").map((x) => `   ${x}`),
    clicks
      ? "4. Google Cloud. Do these clicks yourself with screen or browser control, after the project check from HOW WE WORK on every page. I sign in if Google asks, and any Allow or consent screen is mine:"
      : "4. Google Cloud. I do the clicks, you open each page and tell me exactly what to press:",
    "   a. Make a new project (any name, for example PS app) at console.cloud.google.com, and make sure it is the selected one in the project picker.",
    "   b. APIs and Services, Library, Gmail API, Enable.",
    "   c. Google's consent screen is now called Google Auth Platform. Open it, press Get started, give any app name and my own address as the contact, choose audience External, and finish. Leave it in Testing. On the Audience page add the Gmail address I want to connect as a Test user. On the Data access page add the Gmail scopes gmail.readonly, gmail.send and gmail.metadata. If I also want PS to upload screen recordings to Google Drive, add drive.file too and enable the Google Drive API in the same project: the same client file works for that.",
    "   d. On the Clients page press Create client, application type Desktop app, any name. Download the JSON file. It lands in my Downloads folder with a name that starts with client_secret_.",
    "   e. Move that file to ~/.ps-gmail/client.json: mkdir -p ~/.ps-gmail; mv ~/Downloads/client_secret_*.json ~/.ps-gmail/client.json; chmod 600 ~/.ps-gmail/client.json. If more than one file matches, ask me which one. Move it, do not open or print it.",
    "   Note: Google can end sign ins of apps left in Testing after about 7 days. If PS later shows Problem for the account, set the publishing status to In production (Google calls it unverified, which is fine for my own use) and run step 6 again.",
    `5. Make a one time code that lets the connect script hand my Gmail login to my own project for one hour. Run: mkdir -p ~/.ps-gmail; openssl rand -hex 16 | tr -d '\\n' > ~/.ps-gmail/enroll-code; chmod 600 ~/.ps-gmail/enroll-code; shasum -a 256 ~/.ps-gmail/enroll-code`,
    `   Never show me the code. Take only the first word of the last output (the hash, which is safe to show), tell me it lets my Gmail login be handed to my own project for one hour, and after my yes run: supabase db query --remote=${R} --yes "insert into public.gmail_enroll (code_hash, expires_at) values ('<the hash>', now() + interval '1 hour');" (or have me run that insert in my SQL editor). If it says duplicate key, the first run already worked.`,
    `6. Connect each Gmail account. Ask me for the part of the address before the at sign (a normal gmail.com address only), then give me this exact command to run myself in my own Terminal app (it waits for me to sign in to Google in the browser, which you cannot see or click for me): cd <the web folder> && node scripts/gmail-connect.mjs --project ${R} <that part>=$HOME/.ps-gmail/client.json. Wait until I say it is done.`,
    clicks
      ? "   The script prints one Google link per account. Open it yourself in the browser profile that is signed in to that account and pick the account. Then hand over to me: the Advanced, Go to app warning and the Allow click are mine. After my Allow I press Enter in the terminal (if you cannot, tell me to). The script sends the login straight to my project and prints OK. Rerun it for each further account."
      : "   The script prints one Google link per account. Have me open it in the browser profile that is signed in to that account, pick the account, press Advanced then Go to app if Google warns, and Allow read access. That click is mine. Then I press Enter in the terminal (if you cannot, tell me to). The script sends the login straight to my project and prints OK. Rerun it for each further account.",
    `7. Check it worked. My address appears in PS only after its first check, which runs every 2 minutes. Read the result yourself: supabase db query --remote=${R} --read-only "select account, last_ok, last_error from public.gmail_state;" A time in last_ok and an empty last_error means it works. Anything in last_error is Google's own reason: show it to me in plain words and fix that. Then have me open PS, Settings, Notifications and Do Not Disturb, Client emails: under Gmail replies my address must show Live, and a new email to that account should appear in the email panel.`,
    "8. Replying from PS (Mac only). In PS open Settings, Reply from PS app, and press Connect Gmail for sending. PS asks for the same client file. The folder ~/.ps-gmail is hidden, so in the file picker press Cmd+Shift+G, type ~/.ps-gmail/client.json and press Enter. Then PS opens Google's own page where I sign in and tick the permission to send. That is my click. PS keeps the sign in in this Mac's Keychain.",
    "9. Pick who shows up. The email panel only shows emails from my clients or from senders I set to Always notify me, so a working connection can still look empty. Have me open PS, Settings, Notifications and Do Not Disturb, Gmail replies, Who emails me, and pick the senders I want (a client, or Always notify me). Then a new email from one of them should appear in the email panel.",
    `10. Optional, only if I use Instantly. I put my read only Instantly API key into my own project's Vault myself, in the SQL editor, so you never see it: select vault.create_secret('PASTE_YOUR_INSTANTLY_KEY_HERE', 'instantly_api_key'); Then I read my webhook secret in the SQL editor myself: select decrypted_secret from vault.decrypted_secrets where name = 'instantly_webhook_secret'; and in Instantly I add a webhook to this address, with that secret in place of the last word: ${known ? functionsUrl(r) : "https://<my project ref>.supabase.co/functions/v1"}/instantly-webhook/<the secret>`,
    "",
    "When you are done, tell me in plain words what works now and what is left for me.",
  ];
  return L.join("\n");
}
