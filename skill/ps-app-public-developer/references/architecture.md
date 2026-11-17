# How PS fits together

Everything here is from the public repo (V1.58). File paths are relative to the repo root. When the code says
something different, the code wins.

## One web app, three shells

```
                 web/  (React 19 + TypeScript + Vite)
                 |
   default mode  |  --mode ps          |  --mode gos
   dist/client   |  dist-ps            |  dist-gos
   website       |  inside the Mac app |  inside the Android APK
                 |  (mac/, Swift)      |  (phone/, Kotlin)
```

- **The website** (default build) is the full app in a browser, plus an installable phone web app
  (`web/todolist-mobile/`, `web/src/mobile/`) that iPhone users use today.
- **The Mac app** shows the same page in WebKit views. The shell adds what a web page cannot do: the hold Tab
  overlay over every app, the Dynamic Island, PS's own notification cards, Sleep mode, Sentry mode, the volume
  mixer, screen time, the AFK timer, the network monitor, Calendar access, Remember me in the Keychain, Touch ID,
  the restart helper and the updater.
- **The Android app** bundles the page and serves it from `https://appassets.androidplatform.net/client/` (a
  secure origin, so WebCrypto works offline). The shell adds notifications without Google services (WorkManager
  and AlarmManager), the Fitness rest timer on the lock screen, alarms, a Quick Settings tile, a widget, screen time
  and Remember me sealed by an Android Keystore key. The keyboard tap, middle click, mixer and per app network rows
  stay Mac only on purpose (`phone/README.md`).

Code that only makes sense in one shell checks `import.meta.env.MODE` (`"ps"` or `"gos"`), for example
`web/src/escstart.ts`. A new shell (a port) follows the same pattern: see `porting.md`.

## The vault (sync and encryption)

- `web/src/core/crypto.ts` and `web/src/core/vault.ts`. Your passphrase and username go through PBKDF2 and HKDF on
  your device. One part becomes the login password sent to Supabase, the other unlocks a random vault key. Every
  record is encrypted with AES-256-GCM on the device before upload. The server stores ciphertext, hashes and
  times. The login id it sees is a hash, not your name. Read `PRIVACY.md` for exactly what the server can and
  cannot see, including the weak spots it lists.
- Database: `web/supabase/migrations/` (row level security on every table). Sign up and sign in:
  `web/supabase/functions/vault-auth/` (it has a list of allowed web origins; a new shell origin must be on it).
- Sync pulls only what changed and uses a tiny `vault_probe` call to ask "anything new?" (migration
  `021_vault_probe.sql`). Keep it that way: Supabase free plans have small transfer limits.
- **Local first**: a person can keep everything on one Mac with no server (`web/src/localfirst.ts`).
- **Your own Supabase**: `web/supabase/ps-core.json` lists the migrations and the one function a personal
  project needs. The Mac's `mac/Sources/ProjectSetup.swift` applies them for you; `mac/Sources/Project.swift`
  hands the page its project as `window.__psProject` before any page code runs.

## Accounts and the left out features

- `web/src/core/account.ts`: an unlocked account is `"red"` (the owner's own account on the owner's server),
  `"owner"` (anyone else with their own vault) or `"client"` (a member of someone's client workspace). The server
  decides the role (`vault_role()`, migration `025_multi_owner.sql`). A wrong answer only shows or hides UI; data the
  owner's features use is sealed to the owner's key on the server side.
- `RED_ONLY` in `account.ts` and `mac/Sources/Owner.swift` switch the owner's personal features off for everyone
  else. The code of those features is not in core; it lives in the owner's layer. Plug points stand in (web files
  that begin "Left out of the public source" and `mac/Sources/DeveloperOnly.swift`, all listed
  in `layers/plugpoints.json`) and do nothing in the G Squad build.
- `web/src/core/features.ts` holds `feature("id")` and the switches for things turned off for everyone but kept
  (for example Campaigns and the Notebook looks).
- Left out of the repo (README, "What is left out"): AirPods and microphone auto routing, email
  cards, replies and sending, the follow up radar, the Instantly inbox, Campaigns, the Morning brief, Numerology,
  the PS rules, private release notes, inviting other owners, the server feeds behind them, and the owner's
  release tools. Do not rebuild these and do not wire new features to them.

## Builds, profiles and features (since V1.58)

- `tools/assemble.mjs` copies core's tracked files and a layer into `.build/<name>/` and writes
  `.build/<name>/ps-build.json` (which build, the core and layer commits, the whole profile). `tools/build.mjs` builds
  inside that tree. No layer: the G Squad build with `profiles/gsquad.json`.
- How each part reads it: web defines `__PS_BUILD__` from `ps-build.json` (`web/vite.config.ts`); the Mac app gets
  `profile.json` and `ps-build.json` in its Resources (`mac/build.sh`); the phone gets `profile.json` in its assets.
  A build with no `ps-build.json` (the dev server, a plain `npm run build`, a plain `mac/build.sh`) has no profile,
  and every rule falls back to the per account answer.
- Profile readers: web `web/src/core/profile.ts` (`profile()`, `profileName()`), Mac `mac/Sources/Profile.swift`
  (`Profile.current`, `.rule(_:)`), phone `Profile.kt`.
- Feature registry: `features.json` (core, shared only) plus a layer's own `features.json` (private). Code asks web
  `feature("id")`, Mac `Features.on("id")` (`mac/Sources/Features.swift`), phone `Features.on(ctx, "id")`.
  `web/src/featuresync.ts` sends the page's answers to the Mac. "From the squad" is
  `web/src/views/FromTheSquad.tsx`, a row in Settings, G Squad (`web/src/core/settingsindex.ts`).
- Versions: `web/ps-version.json` holds the number, the release names and, since V1.58, who made each one
  (`made`). `web/scripts/ps-version.mjs claim` and `tools/claim-version.mjs` claim the next number with a tag.
  `web/src/core/releaseby.ts` makes the "V1.59 by Jan" line.
- Update channels: the app reads its channel from its bundled profile only (Mac `UpdateCore.swift`, phone
  `UpdateWhere.kt`): `gsquad` (the G Squad channel), `url` (a person's own server) or `local` (no updates). No
  profile: the G Squad channel, exactly as before V1.58. A note for another channel is refused.

## The G Squad

The friends feature: a shared space where members choose what to share (working status, money, screen time
total, fitness, sleep; tasks only when marked). Web code `web/src/squad/` and `web/src/core/squad*.ts`; the hub
is a separate small database in `web/supabase/hub/` (migrations and functions). The hub only ever stores data
locked with the squad's key. Since V1.57 the squad is invite only. Settings, G Squad holds every switch.

## The Mac shell (mac/)

- `mac/Sources/main.swift`: the app, its two web pages and the bridge. The **main page** holds the keys and does
  all saving; the **overlay page** is the Tab list and holds no keys. Messages are checked by which page sent them
  (`fromMain`, `fromOverlay`) before anything happens.
- The page is served from PS's own scheme, `ps://app/client/`, with a strict Content-Security-Policy.
- Keyboard: a macOS keyboard tap (`tapCreate` in `main.swift`) that only acts on Tab and PS's own shortcuts and
  passes every other key through; `TabHealthCore.swift`, `SecureInput.swift` (when macOS Secure Input is on the
  tap hears nothing, and PS says so), `OpenKeysCore.swift` (custom hold keys and combos), `SafePeek.swift` and
  `SafePeekCore.swift` (one system hotkey for plain Tab while 1Password or Signal is in front), `Protected.swift`
  (spots those two apps by bundle id only), `EscAlways.swift` (three ways Esc always gets through).
- Windows: `Island.swift`, `IslandPlace.swift`, `IslandColumn.swift` (the Dynamic Island, drawn by SwiftUI; the
  page works out what it shows and posts it), `Toast.swift` and `Popup.swift` (PS's own cards), `SleepScreen.swift`,
  `Sentry*.swift`, `NotesCard.swift`, `Soundboard.swift`, `ScreenGuard.swift` (hidden windows shrink to 1x1).
- System features: `ScreenTime.swift`, `Afk.swift`, `NetMonitor.swift`, `Mixer.swift` (Core Audio process taps),
  `LocalCalendar.swift` (read only), `Headphones.swift`, `MediaGuard.swift`, `MiddleClick.swift`, `AreYouSure.swift`,
  `TouchLock.swift`, `Remember.swift` and `KeychainQuiet.swift` (Remember me), `TaskApi*.swift` (the local AI task
  API, off by default), `AutoApprove*.swift` (off by default), `TelegramBot*.swift` (your own bot).
- Updates: `UpdateCore.swift`, `Updater.swift`, `UpdateHandoff.swift`, `Installer.swift`. A signed note (Ed25519)
  on the channel's GitHub releases names each file with its SHA-256 and says its channel and who made it; an app
  update must also carry the expected code signature. Only the G Squad release workflow (G Squad keys, GitHub
  secrets) or the owner can publish to the G Squad channel.
- `mac/Helper/`: the optional restart helper (root, only after the person clicks Set up). Its signed binary is
  pinned in `Helper/pinned/`; any edit in `Helper/` changes it and makes every Mac approve it again.

## The bridge, page and Mac shell

From the page: `window.webkit.messageHandlers.ps.postMessage(JSON.stringify({ type, ... }))`
(`psPost` in `web/src/ps.ts`). From the shell: `window.__ps.apply(msg)` on the main page and
`window.__psOverlay.load(state)` on the overlay. Smaller windows have their own handler names: `afk`, `ays`
(Are you sure), `notes`, `sb` (Supabase setup), `fu` (reminders), `guide`, `sbcard` (soundboard), `note` (cards).

Other shell to page entry points the page installs: `__psBg`, `__psScreen`, `__psMacUpdate`, `__psAppName`,
`__psOpenSetup`, `__psRemSound`, `__psSentry`, `__psEscape`, `__psUpdateReady`; and `__psProject` (set by the
shell before the page loads).

Message types the Mac shell handles (`case "..."` in `mac/Sources/main.swift`), grouped. A port implements the
ones its features need and answers the rest with "not available" or ignores them.

| Area | Messages |
| --- | --- |
| Page life | `ready`, `state`, `overlayReady`, `log`, `psStatus`, `owner`, `sfx` |
| Sign in and lock | `remember:save`, `remember:forget`, `signout`, `signin:show`, `signin:size`, `signin:done`, `lock:mac`, `touchid:unlock`, `localkey:get`, `clipboard:clear` |
| Tab overlay and keys | `tab:set`, `tab:permission`, `tab:fix`, `shortcuts:set`, `shortcuts:reset`, `shortcuts:record`, `psSettings:get`, `psSettings:trigger`, `psSettings:tabStays`, `psSettings:slash`, `psSettings:ignore`, `close`, `keep`, `pin`, `hitRects`, `backdrop`, `edit` (shortcut keys are named with the modifiers `cmd`, `ctrl`, `opt`, `shift`, `fn`) |
| List actions from the overlay | `tick`, `work`, `reorder`, `looks`, `update`, `tmScale`, `dimx` |
| Island and cards | `island`, `island:edit`, `island:reset`, `notify`, `cardShow`, `cardHide`, `meetCard`, `meetPrivacy`, `noteLook`, `dnd` |
| Time and focus | `afk`, `afk:get`, `afkShow`, `afkMeetings`, `ays`, `aysMeeting`, `rem:plan`, `rem:legacyDone`, `screentime:send`, `screentime:icons`, `timeline:get`, `presence:get`, `psSettings:screenTime`, `localCal` |
| Mac extras | `mixer`, `hpmode`, `mediaGuard`, `airpods`, `middleClick`, `net`, `power:get`, `thunder`, `bg:get`, `bg:list`, `bg:choose`, `sentryPrefs`, `appName:set`, `aiDone:set`, `aiDone:taken`, `autoApprove:set`, `autoApprove:clearLog` |
| Setup, updates, helper | `setup:can`, `setup:store`, `project:setup`, `project:created`, `macUpdate:get`, `macUpdate:check`, `macUpdate:start`, `update:every`, `reboot:check`, `reboot:refresh`, `reboot:set`, `reboot:setup`, `reboot:remove`, `reboot:test`, `psSettings:helperRemind` |
| Owner only (left out; a port skips them) | `reply:*`, `second:pick`, `mic:get`, `mic:set`, `airpodsAuto`, `airpodsAuto:get`, `nuke` |
| Switched off for everyone (a port skips it) | `mc` (Minecraft mode, behind `MINECRAFT_ENABLED`) |

The page side of each message is in `web/src/ps.ts` (the `ShellMsg` type and the `apply` handlers). Before
building on any message, read both ends: the table above is a map, not a contract.

## The bridge, page and Android shell

From the page: `window.gosNative.postMessage(json)`; the shell answers on the same object's `onmessage`. The
listener is `WebViewCompat.addWebMessageListener` for the one origin `https://appassets.androidplatform.net` only
(`phone/.../WebHost.kt`), so no other page can reach it. Handlers are in `phone/.../Bridge.kt`; the page side is
`web/src/gos/bridge.ts`. Message names include `fitness:*` (start, add, skip, cancel, get, awake), `sleep:*`
(Sleep mode and alarms), `remember:save`, `remember:unlock`, `kb:show`, `back:none` and `cmd:sign`.

## 1Password and Signal in code

- Mac: `Protected.swift` matches bundle ids containing `1password`, `agilebits`, `whispersystems` or `signal`. While
  one is in front the keyboard tap is off. `SafePeek.swift` registers one system hotkey (plain Tab, plus Esc while
  the list is up) so the list can still come up without PS seeing any key typed in those apps.
- Web: `web/src/core/protected.ts` `isProtectedApp` drops anything about them that ever reaches the page (Android
  package names included).
- The per account answer: `mac/Sources/BuildRules.swift` (`tabOverProtected`, `islandOverProtected`; the owner's
  account off, everyone else on). The bundled profile can only narrow it (`Profile.allows`, `BuildRules.fromProfile`
  in `Profile.swift`; profile keys `tabOverProtectedApps`, `islandOverProtectedApps`). `SafePeek.swift` and
  `Island.swift` ask `BuildRules.now`. Tests: `mac/tests/profile-test.sh`, `mac/tests/safepeek-test.sh`.
- The rule (two rules, one per build) is in `SKILL.md`, rule 7.
