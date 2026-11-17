# Porting PS to Windows, Linux or iPhone

A port is a new native shell around the same web app, in its own folder, with its own build and its own tests.
The web app is reused as is. Everything the Mac shell does natively is rebuilt with the new system's own tools.

Read `architecture.md` first (the bridge especially). The Mac shell in `mac/Sources/` is the reference: when this
guide and the Mac code disagree, the Mac code shows what PS really does.

## The shape of a port

```
windows/            (or linux/, ios/)
  README.md         what works, what does not, how to build, every feature with its off switch
  build script      builds web/ (one command), then the shell
  src/              the shell
  tests/            unit tests for the shell's pure rules (key handling, protected apps, Esc, window rules)
```

- **Where it lives.** While it is young, the port can live in the person's own layer (`add` lists the new folder;
  `layers-and-versions.md`), so it never touches core. When it is ready to share, it goes into core by pull request
  as a new top level folder with its own `features.json` entry, like any shared feature. `tools/build.mjs` only knows
  web, mac and phone: a port brings its own build script, and teaching `tools/build.mjs` or the GitHub checks about
  a new part is a change for the owner (those files are protected).
- **Read the profile.** Bundle the build's `profile.json` like the Mac and the phone do, and take the update
  channel and the two 1Password and Signal rules (`tabOverProtectedApps`, `islandOverProtectedApps`) from it, kept
  as two separate rules. No profile: behave as the Mac does with none (the per account answer).
- **Do not fork the web app.** Changes the port needs in `web/` go behind a mode check
  (`import.meta.env.MODE === "<your mode>"`, see `web/src/escstart.ts` and the `ps` and `gos` modes in
  `web/vite.config.ts`) and get their own tests in `web/tests/`. They must not change what the website, the Mac or
  the phone do.
- **Start from `--mode ps`.** The Mac page already expects a desktop shell. The shortest path is to build the page
  with `--mode ps` and give it the same bridge the Mac gives it (below). Add a mode of your own only when the page
  must behave differently.
- **Pure rules in testable files.** The Mac keeps every decision in `*Core.swift` files tested without a screen
  (`SafePeekCore.swift`, `TabHealthCore.swift`, `OpenKeysCore.swift`, `SentryCore.swift`). Do the same: key and
  window decisions in plain functions with unit tests, the system calls in thin wrappers.
- **A port README lists, for each Mac feature: done, partly, not possible on this system, or not started.**
- **Every rule in `SKILL.md` applies on every system**, the 1Password and Signal rule and "Esc always exits"
  included.

## What is reused as is

- The whole web app: every screen, the list, Dimension X, notes, Fitness, settings, the G Squad, the vault and its
  encryption (`web/src/core/crypto.ts` uses WebCrypto, available in WebView2, WebKitGTK and WKWebView on a secure
  origin).
- The database and `vault-auth`. One server change is needed: `vault-auth` only answers web origins on its
  `ALLOWED_ORIGINS` list. On your own Supabase you add your shell's origin yourself; on the owner's server, only
  the owner can (ask in your pull request).
- The rules: what counts as a protected app (`web/src/core/protected.ts`), Esc timings (`web/src/core/escape.ts`),
  the Island's content (`web/src/island.ts` works it out; a shell only draws it).

## What the Mac shell does, and must be rebuilt natively

| Mac piece | What it does | Mac files |
| --- | --- | --- |
| Web view host | Loads the page from its own scheme (`ps://app/client/`) with a strict Content-Security-Policy; two pages: the main page (holds keys, saves) and the overlay page (the Tab list, holds no keys). | `main.swift`, `Project.swift` |
| Bridge | Page to shell `window.webkit.messageHandlers.ps.postMessage(json)`; shell to page `window.__ps.apply(msg)`, `window.__psOverlay.load(state)`; every message checked by which page sent it. | `main.swift`, `web/src/ps.ts` |
| Hold Tab overlay | A system wide key watch. Holding Tab shows the overlay over every app; a quick tap is passed on so Tab still moves between fields; custom hold keys and combos; the `/` then `.` chord. Runs on its own thread with a watchdog: if the app hangs, every key passes through. | `main.swift` (`tapCreate`), `OpenKeysCore.swift`, `TabHealthCore.swift` |
| Overlay window | See-through, above every app, never steals focus from the app behind; clicks outside the drawn parts (`hitRects`) pass through; shrinks to 1x1 when hidden so it never covers the screen invisibly. | `main.swift`, `ScreenGuard.swift`, `ScreenFit.swift` |
| Protected apps | Spots 1Password and Signal by app id only; the key watch switches off while they are in front; one plain Tab hotkey (and Esc while the list is up) still works there, so PS never sees a key typed in them. | `Protected.swift`, `SafePeek.swift`, `SafePeekCore.swift` |
| Secure input | When the system hides keys from every app (macOS Secure Input), PS notices and says so instead of silently failing. | `SecureInput.swift`, `SecureInputCore.swift` |
| Esc always exits | Three independent ways Esc reaches PS so one always works. | `EscAlways.swift` |
| Dynamic Island | A shape at the top centre showing the task you work on, with a tick; grows for notifications; dims over full screen apps; a grab line hides it for a few seconds; never takes the keyboard. | `Island.swift`, `IslandPlace.swift`, `IslandColumn.swift` |
| Notifications | PS's own cards (not the system's), from the island or the top right; colours, sounds, Do Not Disturb, private mode. | `Toast.swift`, `Popup.swift`, `DND.swift`, `PrivateCore.swift` |
| Remember me and lock | Keeps the derived keys (never the passphrase) in the Keychain; unlock with Touch ID. | `Remember.swift`, `KeychainQuiet.swift`, `TouchLock.swift`, `LocalKey.swift` |
| Updates | Signed manifest, hashes, signature check, atomic swap. A port has no update channel of its own until the owner sets one up. | `UpdateCore.swift`, `Updater.swift` |
| System features | Screen time, AFK, network monitor, volume mixer, Calendar, Sleep mode, Sentry mode, keep awake, restart helper, Telegram bot, AI task API, Auto approve. Each is optional and has its switch. | see `architecture.md` |

## The bridge to implement

Give the page the same objects the Mac gives it, so `web/src/ps.ts` works unchanged:

1. Before any page script runs, inject a small script that defines
   `window.webkit = { messageHandlers: { ps: { postMessage: (m) => <your native send>(m) } } }`. Do the same for
   the small windows' handler names you implement (`note`, `afk`, `ays` and so on, `architecture.md`).
2. To answer, run `window.__ps.apply(<json>)` in the main page and `window.__psOverlay.load(<state>)` in the
   overlay page.
3. Check every incoming message: which page sent it, its `type`, and every field (the Mac's `fromMain` and
   `fromOverlay` checks in `main.swift`). The overlay page holds no keys and may only ask for what the overlay
   needs.
4. Start with the messages the list needs to work (`ready`, `state`, `overlayReady`, `tick`, `work`, `reorder`,
   `update`, `close`, `keep`, `hitRects`, `tab:*`, `psSettings:get`, `remember:*`, `lock:mac`, `signin:*`, `log`).
   Answer messages for features you have not built with nothing, or with the same "not available" state the Mac
   gives on an older macOS, and keep that list in your README.
5. If you need `window.__psProject` (your own Supabase), set it exactly as `mac/Sources/Project.swift` does:
   frozen, before the page loads, every field checked by `web/src/core/project.ts`.

## Windows

| Piece | Suggested tools |
| --- | --- |
| Web view host | WebView2 (C# with WinUI 3 or WPF, or C++, or Rust with `wry`/Tauri). Serve the page with `SetVirtualHostNameToFolderMapping` on an `https://` host name (a secure origin, so WebCrypto works); inject the bridge with `AddScriptToExecuteOnDocumentCreatedAsync`; receive with `WebMessageReceived`; answer with `ExecuteScriptAsync`. Set the CSP with a response header or the page's meta. |
| Hold Tab key watch | A low level keyboard hook (`SetWindowsHookEx(WH_KEYBOARD_LL)`) on its own thread with its own message loop, plus a watchdog that lets every key through when the UI thread stops answering. Swallow Tab only while deciding hold or tap; replay a quick tap with `SendInput`. Hooks time out if slow: never do work inside the hook callback. |
| Protected apps | `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` and the foreground process's image name (`GetWindowThreadProcessId`, `QueryFullProcessImageName`): `1Password.exe`, `Signal.exe` and their helpers. While one is in front, unhook (or ignore every key) and use `RegisterHotKey` for plain Tab and Esc only. |
| Overlay window | A borderless top most window with `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED`, a transparent WebView2 background (`DefaultBackgroundColor` with alpha 0); clicks outside `hitRects` pass through (toggle `WS_EX_TRANSPARENT`, or answer `WM_NCHITTEST` with `HTTRANSPARENT`). Shrink or hide it fully when not shown. |
| Elevated windows | A normal app's hook gets no keys while an elevated (admin) window is in front: the Windows cousin of Secure Input. Detect it and tell the person, as the Mac does. |
| Island | A small top centre top most pill window (there is no notch). Full screen detection: `SHQueryUserNotificationState`. |
| Notifications | PS's own cards as top most no activate windows (same look as the Mac), optionally Windows toast notifications for when PS is in the background. |
| Remember me | DPAPI (`ProtectedData`, current user) or Credential Manager (`CredWrite`); Windows Hello (`KeyCredentialManager` or `UserConsentVerifier`) for the Touch ID step. |
| Screen time, AFK | Foreground app changes (the same `SetWinEventHook`); `GetLastInputInfo` for idle time. |
| Volume mixer | Per app volume is built in: Core Audio `IAudioSessionManager2` and `ISimpleAudioVolume`. |
| Network monitor | IP Helper (`GetExtendedTcpTable`) for per app connections; keep it local only, as on the Mac. |
| Keep awake, lid | `SetThreadExecutionState`; lid and power events through `RegisterPowerSettingNotification`. |
| Updates | None at first. Never reuse the Mac updater's key or manifest. A port follows its profile's channel: `local` (no updates) until a channel exists for it. Never the G Squad channel's notes for another system. |
| Signing | Unsigned builds trigger SmartScreen warnings; that is fine for friends who build it themselves. |

## Linux

The big question is the desktop: **X11 or Wayland**.

| Piece | Suggested tools |
| --- | --- |
| Web view host | WebKitGTK (GTK 4) or Tauri/`wry`. WebKitGTK has `window.webkit.messageHandlers` natively (`WebKitUserContentManager`), so the Mac bridge script may not even need a shim. Serve from a custom URI scheme registered as secure, so WebCrypto works. |
| Hold Tab on X11 | XInput2 raw key events (or XRecord) to watch keys; passing a tap through needs XTest. Works for every app on the X server. |
| Hold Tab on Wayland | Apps cannot watch global keys by design. Use the `GlobalShortcuts` portal (xdg-desktop-portal), whose Activated and Deactivated signals give press and release for a hold; support depends on the desktop (KDE yes, others vary). Reading `/dev/input` (evdev) works everywhere but needs special rights and sees every key: do not ship that as the default, and if offered, say plainly what it can see. |
| Protected apps | X11: the active window's `_NET_WM_PID` and its process name. Wayland: apps generally cannot see which app is in front; then the safest rule is that PS's key watch is portal only (it never sees other apps' keys anyway). Write down what your desktop allows. |
| Overlay and island | X11: an override redirect or dock type window with an input shape for click through. Wayland: the `wlr-layer-shell` protocol (wlroots desktops, KDE) via `gtk4-layer-shell`; GNOME has no layer shell, so say so in the README. |
| Remember me | The Secret Service API (`libsecret`), unlocked with the person's login keyring. |
| Notifications | PS's own cards where the desktop allows overlays; otherwise `org.freedesktop.Notifications`. |
| Mixer, network | PipeWire or PulseAudio per stream volume; `/proc/net` or netlink for connections. |

## iPhone

There is no system wide key watch or overlay on iPhone, so an iPhone PS is like the Android app, not the Mac one.

- **Today** iPhone users have the installable web app (`web/todolist-mobile/`, `web/src/mobile/`), signed in by QR
  from a Mac ("Link your iPhone or phone").
- **A native shell**: Swift, `WKWebView`. It already has `window.webkit.messageHandlers`, so the page talks to it
  through the same names. Serve the page from a custom scheme (`WKURLSchemeHandler`, as the Mac does with
  `ps://app`). Use the phone layout the Android app uses rather than the desktop overlay; check how `--mode gos`
  differs before choosing a mode.
- Native pieces worth having: Keychain plus Face ID (`LAContext`) for Remember me; local notifications for
  reminders and alarms (exact alarms are limited on iPhone: test them on a real phone); a Live Activity for the
  Fitness rest timer; a widget and a Control Center control instead of the Quick Settings tile; Screen Time data is
  not readable by other apps except through Apple's Screen Time API with a special permission.
- Building needs a Mac with Xcode. A free Apple account can put a build on your own iPhone for a few days at a
  time; anything longer or for other people needs a paid Apple developer account. That is the porter's choice.
- 1Password and Signal: an iPhone app cannot see other apps, so there is nothing to step aside from, but the rule
  still means PS never tries to read anything about them.

## Before offering a port as shared

- The port lives entirely in its own folder plus mode gated web changes with tests.
- Its README says which features work, which do not, and every switch; `FEATURES.md` gets a line only for things
  that are actually in a release.
- Its tests run with one command and need no real accounts, network or screen.
- The 1Password and Signal rule and the Esc rule are tested on the new system, and the README says how they were
  proven on the real apps.
- The audits are clean. Then follow `contributing.md`.
