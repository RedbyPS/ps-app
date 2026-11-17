# Mac permissions

Every permission PS can ask for on a Mac, why, and what happens if you say no. Names are as macOS 27 shows them in
System Settings, Privacy and Security. Saying no never breaks the rest of PS: only the feature that needs it stops.

## Device Control and Data Access (called Accessibility on older macOS)

- **Why**: PS's main feature. Holding Tab over any app shows your list. To see the Tab key while another app is in
  front, PS watches the keyboard with a standard macOS keyboard tap (`mac/Sources/main.swift`, `tapCreate`). It
  only acts on Tab and its own shortcuts and passes every other key straight through. It does not record or store
  what you type.
- **Also used by**: "Are you sure" (reads the title of the front browser window to spot sites you asked it to
  watch, `mac/Sources/AreYouSure.swift`) and the Force Touch middle click (a separate small helper with its own entry).
- **When it asks**: on the install screen, and at launch until you allow it.
- **If you say no**: Tab does nothing. The rest of PS works from the menu bar icon and the website.
- **Turn it off**: menu bar icon, "Tab Overlay: On" (click to turn off). Are you sure: Settings, Privacy and
  sharing, Security, "Are you sure". You can also remove PS from the list in System Settings at any time.
- **Never**: while 1Password or Signal is in front, PS switches its keyboard watch off completely
  (`mac/Sources/Protected.swift`, `mac/Sources/main.swift`).

## Screen and System Audio Recording, "System Audio Recording Only"

- **Why**: the volume mixer, which turns each app up, down or off on its own. It uses Core Audio process taps
  (`mac/Sources/Mixer.swift`). The sound goes straight to your speakers; nothing is recorded, saved or sent.
- **When it asks**: only after you move a mixer slider and click Continue on the explanation.
- **If you say no**: the mixer cannot change apps; everything plays as normal.
- **Turn it off**: do not use the mixer, or remove PS from this list in System Settings.
- **Never**: PS does not ask to record your screen. It has no screen capture code outside a self test of its own
  windows.

## Calendars

- **Why**: show your meetings from the Calendar app in the Meetings panel and meeting alerts. Read only: PS never
  adds, changes or deletes an event (`mac/Sources/LocalCalendar.swift`). Meetings for the next 8 days are copied
  into your encrypted vault.
- **When it asks**: only when you switch on "Meetings from this Mac's Calendar".
- **If you say no**: the Meetings panel shows "Open settings" and stays empty.
- **Turn it off**: Settings, Notifications and Do Not Disturb, "Meetings from this Mac's Calendar".

## Automation (Spotify, Music, and Terminal and iTerm2 for Auto approve)

- **Why**: the AirPods card's "Give AirPods button back to Spotify" button. It asks Spotify or Music to take back
  the play and pause button, and only talks to those two apps (`mac/Sources/MediaGuard.swift`).
- **When it asks**: the first time you click that button.
- **If you say no**: the card says the music app did not take the button back.
- **Turn it off**: Settings, Mac, "AirPods card" (off by default).
- **Also used by Auto approve** (below): it reads the text of Terminal and iTerm2 windows through AppleScript. macOS
  asks for each app when you turn an Auto approve switch on, never in the middle of a mode.

## Auto approve (Settings, Sentry mode)

Says Yes to permission prompts of AI coding tools (Claude Code, Codex) so an AI keeps working while you are away.
Settings says plainly what this risks: if a web page or a file tricks an AI into something harmful, nothing stops
it. Three switches: "In AI mode" (while Sentry mode is on), "In Sleep mode" (while the sleep screen is up for Sleep mode,
not for an alarm alone) and "Always auto approve" (while PS is open). Since 1.65 "In AI mode" and "In Sleep mode" are on
until you choose and "Always auto approve" is off; on each Mac the defaults count only after PS has shown its short
notice there, where Turn off switches them off on every one of your Macs. A choice you saved is never changed. Code: `mac/Sources/AutoApprove.swift`,
`mac/Sources/AutoApproveCore.swift`, `web/src/core/autoapprove.ts`.

- **What it writes, and when**: one hook line (`hooks.PermissionRequest`) in `~/.claude/settings.json`,
  and in `~/.codex/hooks.json` when Codex is on this Mac. The line runs `~/Library/PS/auto-approve/hook.sh`, which
  answers "allow" only while PS keeps a fresh time in `~/Library/PS/auto-approve/active` (PS moves it on every 30
  seconds; if PS stops or the mode ends, the time runs out within 2 minutes and prompts show as usual). Before each
  change PS keeps a copy of the file next to it (`.ps-auto-approve-backup`), and it never rewrites a file it cannot
  read. Only PS's own entry changes: every other byte of the file (order, spacing) stays as it was. With a switch you
  turned On yourself the line stays from the moment PS opens; a switch that is only on by its default never writes at
  launch: the line goes in when Sentry or Sleep mode starts and comes out when it ends. Turning every switch off takes
  out exactly the lines PS added, the script and the time file.
- **What it never answers**: questions an AI asks you and plan approvals (`AskUserQuestion`, `ExitPlanMode`) go to
  you as usual.
- **What it reads and presses**: for prompts the hook cannot reach, every 2.5 seconds it reads the text of Terminal
  and iTerm2 windows (Automation, above) and of Warp, VS Code and Cursor windows (Device Control and Data Access).
  Only when the text is clearly a yes or no permission prompt with Yes chosen, twice in a row, it presses Return:
  in iTerm2 straight into that session; in the other apps only with "Always auto approve" on, the Mac unlocked, no
  Sentry or Sleep screen up, and no typing or mouse movement for 3 seconds. It then brings that window forward,
  presses Return and puts your app back in front. It never looks at 1Password or Signal.
- **The log**: what it approved (the command shortened, secrets taken out, the folder name only) is kept in
  `~/Library/PS/auto-approve/` and shown under "What it approved". Nothing is sent anywhere.
- **Turn it off**: Settings, Sentry mode, Auto approve, all three switches Off.

## Login Items and Extensions: the restart helper

- **What it is**: an optional helper that runs as root (`mac/Helper/rebootd.swift`). It can restart or shut down
  the Mac for Auto reboot and Sentry mode, set a wake time, and keep the Mac awake with the lid closed in Sentry
  mode. Only PS, checked by its code signature, may talk to it (`mac/Helper/RebootXPC.swift`).
- **When it asks**: only when you click "Set up the restart helper". macOS then asks you to switch PS on under
  Allow in the Background.
- **If you say no**: Auto reboot and Sentry's timed restart cannot restart the Mac. Nothing else changes.
- **Turn it off**: Settings, Privacy and sharing, Security, "Auto reboot" Off, and Sentry mode's "Restart if not
  unlocked" set to 0. To stop the reminder pop up: "Remind me to set up the restart helper" Off, next to Auto
  reboot. You can also switch PS off under Allow in the Background in System Settings.
- **Note**: `mac/Helper/pinned/rebootd` is the prebuilt, signed copy of this helper that the release ships. It is
  kept prebuilt so its code signature does not change between releases (each change makes every Mac approve it
  again). Its source is `mac/Helper/`. `mac/Helper/pinned/rebootd.pin` records a hash of those source files, and
  `mac/tools/helper-pin.sh --check` confirms the sources still match it. A rebuild on another Mac gives different
  bytes (the compiler version is written into the binary), so if you would rather not trust the prebuilt copy,
  build the helper from source and use that.

## Login Items: PS Middle Click

- **What it is**: a small separate helper that turns a Force Touch click into a middle click.
- **When it asks**: only when you click "Open Privacy & Security" under "Force Touch middle click". Until then it
  waits quietly. It needs its own Device Control and Data Access entry.
- **Turn it off**: Settings, Keyboard and Tab, "Force Touch middle click" (on by default).

## Microphone and Speech Recognition (Speak your tasks)

- **Why**: the microphone button in the Add task window turns what you say into tasks (PS 1.65,
  `mac/Sources/VoiceCapture.swift`, rules in `VoiceCaptureCore.swift`). Speech is recognised on this Mac only
  (`requiresOnDeviceRecognition`): nothing is sent to Apple's servers. Where this Mac cannot recognise your language
  on device, PS says so and does not listen. The words are split into tasks by Apple's on device model when Apple
  Intelligence is on, else by PS itself. The sound is never saved and the words are never logged.
- **When it asks**: only the first time you click the microphone button, with one plain line why. It listens only
  while you hold the button or until you click Stop (two minutes at most), with a red dot and a level meter while it
  does, and never while 1Password or Signal is in front (it stops at once if one comes to the front).
- **If you say no**: the button says so and offers "Open System Settings". Nothing else changes.
- **Turn it off**: Settings, Your list, "Speak your tasks".

## Touch ID

- **Why**: unlock PS after Lock, and wake it from Sleep mode, with your fingerprint (`mac/Sources/TouchLock.swift`).
- **If you say no or have no Touch ID**: you type your passphrase instead.

## Keychain (no prompt)

PS keeps its own items in your login Keychain, never synced to iCloud: your sign in for "Remember me", the key of
a vault kept on this Mac only, the key of the network monitor's history, a Supabase token if you connect your own
project and let PS keep it, and keys for features you set up yourself (Telegram bot, mail sending, the Proton Mail Bridge password and the fingerprint of its certificate).

## What PS does NOT ask for

Input Monitoring, screen recording, camera, contacts, location, Bluetooth, Full Disk Access and
notifications (the microphone only for the features above that say so, on their own click). (PS's pop ups are its own windows, not macOS notifications.) You can confirm this: search
`mac/Sources/` for `AVCaptureDevice`, `CNContactStore`, `CLLocationManager`, `CBCentralManager`,
`SCShareableContent`, `CGRequestScreenCaptureAccess`, `IOHIDRequestAccess` and `UNUserNotificationCenter`. None
appear.

## A local address (no prompt)

The AI task API (off until you switch it on in Settings, AI task API) listens on `127.0.0.1` port 47836. That address
only exists inside your Mac: no other computer can reach it, and macOS does not ask about it. Requests need the key
shown in that tab, and anything a browser sends is refused (`mac/Sources/TaskApiCore.swift`).

## Things PS reads without a prompt

macOS does not ask for these, but you should know:

- **The name of the app in front and how long you are idle**, for screen time and the AFK timer
  (`mac/Sources/ScreenTime.swift`, `mac/Sources/Afk.swift`). Switches: "Track my screen time", "AFK timer".
- **Per app network traffic**, using macOS's own `nettop` tool, only while the network monitor panel is open
  (`mac/Sources/NetMonitor.swift`). Switch: Settings, Mac, "Network monitor".
- **AI coding tools such as Claude Code**: every tool starts Off. Only if you switch one on under Settings,
  Notifications and Do Not Disturb, "AI chat finished cards", PS adds a small hook to that tool's settings file (for Claude Code,
  `~/.claude/settings.json`, with a backup copy next to it) so it can show a card when a chat finishes
  (`mac/Sources/AiDone.swift`). Switching it off takes the hook out again.
