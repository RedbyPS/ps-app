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
  done: "Copied. Paste it into Claude Code or Codex.",
  failed: "Could not copy. Try again, or use Do it by hand instead.",
  hand: "Do it by hand instead",
} as const;

export const PS_REPO = "https://github.com/RedbyPS/ps-app";

/** The prompt. `ref`: the person's own Supabase project ref, or null when PS does not know it yet. */
export function mailAiPrompt(ref: string | null): string {
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
    "4. Google Cloud. I do the clicks, you open each page and tell me exactly what to press:",
    "   a. Make a new project (any name, for example PS app) at console.cloud.google.com.",
    "   b. APIs and Services, Library, Gmail API, Enable.",
    "   c. OAuth consent screen (also called Google Auth Platform): user type External, any app name, my own address as the contact. Leave it in Testing. Add the Gmail address I want to connect as a Test user. If Google offers a Data access step, add the Gmail scopes gmail.readonly, gmail.send and gmail.metadata. If I also want PS to upload screen recordings to Google Drive, add drive.file too and enable the Google Drive API in the same project: the same client file works for that.",
    "   d. Clients, Create client, application type Desktop app. Download the JSON file.",
    "   e. Move that file to ~/.ps-gmail/client.json (make the folder if needed, then make the file private with chmod 600). Move it, do not open or print it.",
    "   Note: Google can end sign ins of apps left in Testing after about 7 days. If PS later shows Problem for the account, set the publishing status to In production (Google calls it unverified, which is fine for my own use) and run step 6 again.",
    `5. Make a one time code that lets the connect script hand my Gmail login to my own project for one hour. Run: mkdir -p ~/.ps-gmail; openssl rand -hex 16 | tr -d '\\n' > ~/.ps-gmail/enroll-code; chmod 600 ~/.ps-gmail/enroll-code; shasum -a 256 ~/.ps-gmail/enroll-code`,
    `   Never show me the code. Take only the first word of the last output (the hash, which is safe to show), tell me it lets my Gmail login be handed to my own project for one hour, and after my yes run: supabase db query --remote=${R} --yes "insert into public.gmail_enroll (code_hash, expires_at) values ('<the hash>', now() + interval '1 hour');" (or have me run that insert in my SQL editor). If it says duplicate key, the first run already worked.`,
    `6. Connect each Gmail account. Ask me for the part of the address before the at sign (a normal gmail.com address only), then give me this exact command to run myself in my own Terminal app (it waits for me to sign in to Google in the browser, which you cannot see or click for me): cd <the web folder> && node scripts/gmail-connect.mjs --project ${R} <that part>=$HOME/.ps-gmail/client.json. Wait until I say it is done.`,
    "   The script prints one Google link per account. Have me open it in the browser profile that is signed in to that account, pick the account, press Advanced then Go to app if Google warns, and Allow read access. That click is mine. Then I press Enter in the terminal (if you cannot, tell me to). The script sends the login straight to my project and prints OK. Rerun it for each further account.",
    `7. Check it worked. My address appears in PS only after its first check, which runs every 2 minutes. Read the result yourself: supabase db query --remote=${R} --read-only "select account, last_ok, last_error from public.gmail_state;" A time in last_ok and an empty last_error means it works. Anything in last_error is Google's own reason: show it to me in plain words and fix that. Then have me open PS, Settings, Notifications and Do Not Disturb, Client emails: under Gmail replies my address must show Live, and a new email to that account should appear in the email panel.`,
    "8. Replying from PS (Mac only). In PS open Settings, Reply from PS app, and press Connect Gmail for sending. PS asks for the same client file (~/.ps-gmail/client.json), then opens Google's own page where I sign in and tick the permission to send. That is my click. PS keeps the sign in in this Mac's Keychain.",
    `9. Optional, only if I use Instantly. I put my read only Instantly API key into my own project's Vault myself, in the SQL editor, so you never see it: select vault.create_secret('PASTE_YOUR_INSTANTLY_KEY_HERE', 'instantly_api_key'); Then I read my webhook secret in the SQL editor myself: select decrypted_secret from vault.decrypted_secrets where name = 'instantly_webhook_secret'; and in Instantly I add a webhook to this address, with that secret in place of the last word: ${known ? functionsUrl(r) : "https://<my project ref>.supabase.co/functions/v1"}/instantly-webhook/<the secret>`,
    "",
    "When you are done, tell me in plain words what works now and what is left for me.",
  ];
  return L.join("\n");
}
