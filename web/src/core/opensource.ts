// Open source (V1.56, the developer 13 Nov 2026): PS's public code will be on GitHub. Two things live here and nowhere else:
//
//  - OPEN_SOURCE_URL: the repo's address. null until the repo is public (the manager fills it in the day it goes live).
//    While it is null the "PS is open source" pop-up (views/NewPopups.tsx) never shows and nothing links anywhere.
//    When it is set, the pop-up shows on the next launch for anyone who has not seen it.
//  - CHECK_WITH_AI_PROMPT: the prompt the pop-up's "Copy for your AI" button copies. It is the same text as the code
//    block in the open source repo's CHECK-WITH-AI.md (scripts/open-source/CHECK-WITH-AI.md on the open source branch).
//    Keep the two in step: tests/newpopups.test.ts compares them and fails if they differ.
//
// Plain words, no em or en dashes.

/** The public repo's address, or null while it is not live yet. Set it to the https address (for example
 *  "https://github.com/OWNER/REPO") when the repo is public. Anything that is not https counts as not set. */
export const OPEN_SOURCE_URL: string | null = "https://github.com/RedbyPS/ps-app";

/** The address when it is a real https link, else null (so a typo can never put a bad link in front of anyone). */
export function cleanSourceUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length < 12 || s.length > 200 || /\s/.test(s)) return null;
  try { const u = new URL(s); return u.protocol === "https:" && !!u.hostname ? u.toString() : null; } catch { return null; }
}

/** The repo's address now, or null while it is not live. */
export const openSourceUrl = (): string | null => cleanSourceUrl(OPEN_SOURCE_URL);

/** The prompt that asks a person's own AI to check the code (the repo's CHECK-WITH-AI.md). */
export const CHECK_WITH_AI_PROMPT = `This folder is the source code of PS, a to do app for macOS (mac/, Swift), Android (phone/, Kotlin) and the web
(web/, React and TypeScript), with its Supabase database setup (web/supabase/). I am deciding whether to install
it. Audit it for me as a skeptical security reviewer. Do not trust the README, PRIVACY.md, PERMISSIONS.md or any
comment in the code: check the code itself, and tell me where the docs and the code disagree.

1. Network. List every place each app can send data off the device, with file and line. Search for at least:
   fetch(, XMLHttpRequest, WebSocket, new URL(, URLSession, URLRequest, NWConnection, getaddrinfo, Process( and
   /usr/bin/ commands, HttpURLConnection, openConnection, supabase, http:// and https://. For each destination
   say what is sent, when, whether it is on by default, and whether there is a switch to turn it off. Check the
   Content-Security-Policy in web/vite.config.ts and in the Mac and phone shells.

2. Encryption. Read web/src/core/crypto.ts and web/src/core/vault.ts. Confirm or refute: the passphrase and the
   vault key never leave the device; what the server receives at sign in (web/supabase/functions/vault-auth/);
   which data is encrypted before upload and which columns stay readable on the server
   (web/supabase/migrations/). Look for any path where decrypted text is sent, logged or stored in plain text.

3. Mac permissions and powers. Read mac/Info.plist, mac/ps.entitlements and mac/Sources/. List every macOS
   permission it requests and every privileged thing it does (keyboard tap, reading window titles, running
   command line tools, the root helper in mac/Helper/, Apple events, writing files outside its own folders).
   Check that the keyboard tap does not record or send keystrokes. Look closely at Auto approve
   (mac/Sources/AutoApprove*.swift: what it writes to ~/.claude/settings.json, what it reads and when it presses
   keys) and the AI task API (mac/Sources/TaskApi*.swift, web/src/core/taskapi.ts: who can reach it and what it
   allows).

4. Code that only runs for the developer is not in this repo. Placeholders stand in for it: web files that start
   with "Left out of the public source" and mac/Sources/DeveloperOnly.swift. Confirm they
   do nothing. web/src/core/account.ts (RED_ONLY) and mac/Sources/Owner.swift decide which account counts as the
   developer's: work out what decides it and whether a server could make another person's account count.

5. Updates. Read mac/Sources/UpdateCore.swift, mac/Sources/Updater.swift and phone/app/src/main/java/**/Updater.kt.
   How is a new version checked before it is installed? Can a download be installed without the user agreeing?

6. The G Squad. Read web/src/squad/, web/src/core/squad*.ts and web/supabase/hub/. Who can join, who can read what
   is shared, and what the hub server can see.

7. Anything else that looks like tracking, hidden data collection, obfuscated code, prebuilt binaries
   (for example mac/Helper/pinned/rebootd, mac/geo/ip-country.bin) or code that does more than its comments say.

Report: a short verdict, then each finding with file and line, how sure you are, and how serious it is. Say
plainly if you could not check something.`;

/** What lands on the clipboard: a first line saying where the code is, then the prompt. It is written for the AI that
 *  reads it: clone the repo, work from that folder, do the audit. */
export function checkWithAiText(url: string): string {
  return `The source code of PS is at ${url}. Clone it into a folder and work from that folder. Then do this:\n\n${CHECK_WITH_AI_PROMPT}\n`;
}
