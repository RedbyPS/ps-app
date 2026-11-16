# PS

PS is a to do and productivity app for the Mac, with a phone app for Android (built for GrapheneOS) and a
website. Hold Tab over any app and your list appears. Your tasks, notes and settings are end to end
encrypted: they are locked on your device before they are uploaded, and only your passphrase opens them.

PS is made by the developer (Cincee). This is the source of every public feature of the app you download from
cincee.com/ps-app-mac, so you, or an AI you trust, can check what it does.

## What is in this repo

| Folder | What it is |
| --- | --- |
| `web/` | The app itself: a React and TypeScript web app. The Mac and phone apps show this page. Also the website at cincee.com/client. |
| `mac/` | The Mac app: a Swift shell around the web app (the Tab overlay, the Dynamic Island, the mixer, Sentry mode and the rest). |
| `mac/Helper/` | The optional restart helper (runs as root, only after you set it up). |
| `phone/` | The Android app: a Kotlin shell around the same web app. |
| `web/supabase/migrations/` | The database tables and rules an ordinary account uses. |
| `web/supabase/functions/vault-auth/` | The one server function an ordinary account uses (sign up and sign in). |
| `web/supabase/hub/` | The G Squad hub (the friends feature), a separate small database. |

Start with these:

- [PRIVACY.md](PRIVACY.md): exactly what the developer, as the developer and the person who runs the server, can and cannot see.
- [PERMISSIONS.md](PERMISSIONS.md): every Mac permission PS asks for, and why.
- [FEATURES.md](FEATURES.md): every feature and how to switch it off.
- [CHECK-WITH-AI.md](CHECK-WITH-AI.md): a prompt you can paste into Claude Code or Codex to check this repo yourself.

## What is left out

Features that only run on the developer's own account are not included. The app you download contains them
too, switched off for every account but the developer's, so this repo is not the complete source of the download.

- Left out: AirPods and microphone auto routing, the follow up
  radar, Campaigns, the Morning brief, Numerology, the PS rules, private release notes,
  inviting other owners, and the server feeds behind them (calendar, Telegram, Fireflies, follow up). Client
  emails (Gmail and Instantly replies, with Reply) is in core since 1.60, off until each person switches it on. Also the developer's release tools and notes.
- Second Computer is in this repo since 1.65, off until you switch it on (Settings, Second Computer).
- Where public code calls into a left out feature, a small placeholder keeps the names and does nothing: web files
  that start with "Left out of the public source" and `mac/Sources/DeveloperOnly.swift`. Tests of the left out
  features are not here.
- `web/src/core/account.ts` (`RED_ONLY`) and `mac/Sources/Owner.swift` show how those features are switched off
  for every other account.
- Names of the developer's clients and leads, real email addresses and the developer's folder paths were replaced with made up ones,
  mostly in tests and comments.

## Build it yourself

You need a Mac with Xcode's command line tools (`xcode-select --install`) and Node.js 22 or newer.

Web app:

```bash
cd web
cp .env.example .env
npm ci
npx tsc --noEmit -p .
npm run build
```

Mac app (uses the web app's build):

```bash
cd mac
./build.sh
```

`build.sh` also builds the Force Touch middle click helper from `mac/middle-click/` into the app.
`build.sh` signs with the developer's certificate by default. To sign with your own, make a self signed code signing
certificate (`mac/signing/cert.cnf` shows the settings) and set its name in `build.sh`. Updates from cincee.com
will not install over a copy you signed yourself, because the updater only accepts the developer's signature.

Phone app (needs Android Studio's SDK):

```bash
cd phone
./gradlew assembleDebug
```

## Using your own server

On the Mac, PS can keep your vault in a Supabase project of your own instead of the developer's (at setup, or later in
Settings, Sync and account, "Supabase project"). [PRIVACY.md](PRIVACY.md) explains what that changes and what it does not.

## Reporting a problem

If you find a security problem, please tell the developer privately first (the repo's Security tab, "Report a
vulnerability"), not in a public issue.
