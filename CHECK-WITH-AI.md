# Check PS with your own AI

Clone this repo, open the folder in Claude Code, Codex or another coding AI, and paste the prompt below. It asks
the AI to look for itself. It does not tell it what to conclude.

```text
This folder is the source code of PS, a to do app for macOS (mac/, Swift), Android (phone/, Kotlin) and the web
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
plainly if you could not check something.
```

## Tips

- The audit takes a while on a repo this size. If your AI runs out of room, give it one numbered step at a time.
- `mac/Helper/pinned/rebootd` is a prebuilt binary (see [PERMISSIONS.md](PERMISSIONS.md), the restart helper).
  If you would rather not trust it, build the helper from `mac/Helper/` yourself.
- The app you download is built by the developer from his full tree, which also holds the developer only features this repo
  leaves out, so a rebuild from here will not match it byte for byte. The strongest check is to build and run PS
  from this source yourself ([README.md](README.md), Build it yourself).
