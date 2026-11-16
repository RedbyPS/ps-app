# PSMiddleClicker

A small menu bar app for the developer's MacBook. A firm Force Touch press on the trackpad (the second,
deeper click) becomes a middle click at the cursor. In Brave, Safari, Chrome and Arc that opens
a link in a new background tab, and closes a tab when pressed on the tab.

## How it works

- `Sources/ClickMachine.swift`: the click logic, no macOS calls, unit tested (`Tests/main.swift`).
  A left press is held back for a moment. If it reaches the chosen firmness before the finger
  lifts, a middle button down is sent instead (and the lift becomes the middle up, drags become
  middle drags). If the finger lifts, the cursor moves more than 4 points, or 0.6 s pass, the held
  click is given back untouched, so clicks, drags, text selection and long presses work as before.
  While a press is held or turned into a middle click, the pressure events are kept from the app
  so it does not also start Look Up.
- `Sources/Tap.swift`: the mouse event tap, on its own thread. On macOS 27 the Force Touch pressure
  never arrives as Quartz type 34: it comes as gesture events (Quartz type 29) that
  `NSEvent(cgEvent:)` turns into `.pressure`, so the tap listens to gesture carriers (29 to 34).
  Every pressure stage change and one line per press go to the log, for reading a real test back.
- `Sources/Windows.swift`: only a browser window at the normal level can get a middle click. Each
  click event names the window under the pointer; a cache filled off the tap says what it is.
  Measured on the developer's Mac: that window field is only filled at the annotated session level. So there
  are two taps on one thread, one shared click machine: an active tap for clicks at the annotated
  level (its callback only reads fields and the cache), and a LISTEN-ONLY tap for pressure at the
  session level, which macOS never waits on, so it can never hold up a swipe or Mission Control.
  Pressure is only converted (AppKit) while a browser press is being held.
- Log: `~/Library/Logs/PSMiddleClicker.log`, the one before it in `PSMiddleClicker.previous.log`.
  Mission Control, the Dock, Spaces, the menu bar and other apps get their clicks straight through,
  and Mission Control and Dock swipes (Quartz 30 to 32) are not tapped at all. Never waits on the main thread.
  Steps aside if the main thread is silent for 1.5 s, switches itself back on when macOS pauses it,
  and is switched off entirely while 1Password or Signal is in front (`Sources/Protected.swift`,
  same list as PS).
- `Sources/main.swift`: the menu bar item (On, How firm to press, Test Pad, Launch at Login, Quit).
- `Sources/TestPad.swift`: a window to try the press and read the numbers macOS reports.
- No network code at all. Log (local only): `~/Library/Logs/PSMiddleClicker.log`.

## Build

`./build.sh` runs the tests, builds, signs with "PS Local Signing" (the PS signing keychain in
`~/Projects/ps/mac/signing`, so the Accessibility permission survives rebuilds), installs to
`/Applications/PSMiddleClicker.app` and starts it. `./build.sh test` runs the tests only.

Firmness: Normal fires at the Mac's own Force Click point (stage 2). Light fires halfway towards
it (stage 1, transition 0.5 or more), Firm needs stage 2 pressure of 0.3 or more. These numbers are
first guesses until the developer has tried them; tune them in `Firmness.reached`.

## Inside PS

The same code builds "PS Middle Click.app" (`./build.sh helper <dir>`, Info-helper.plist,
com.cincee.ps.middleclick), which PS ships at PS.app/Contents/Library/LoginItems and runs as its own
process. Embedded mode (Sources/Helper.swift): no menu bar icon, PS Settings is the switch; it keeps its
tap off while the standalone PSMiddleClicker runs (never both at once); it reports to PS through
~/Library/Application Support/PS/middleclick.json and the distributed notification
com.cincee.ps.middleclick.changed. Its log is ~/Library/Logs/PS Middle Click.log.
