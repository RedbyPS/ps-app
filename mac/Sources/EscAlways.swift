// Esc always backs out of PS (V1.41, the developer, 8 Nov 2026: "No matter what screen you're on, no matter what's going on in
// the PS app, make sure the escape button always works to back you out of the PS app, no matter what.").
// The same numbers and steps as web src/core/escape.ts (its tests/esc-always.test.ts checks they match).
//
// Three ways an Esc reaches PS, so one always works:
//  - the keyboard tap (TabWatch.handleLocked): while the list or Sleep mode is up, Esc is PS's, whatever app is key;
//  - PS's own key monitor (App.localEsc): Esc typed in a PS window when the tap is off (macOS Secure Input on, or the
//    tap failed). It only ever sees PS's own windows, never a key typed in another app;
//  - over 1Password or Signal, the SafePeek Esc hotkey while the list is up (the tap is off there; golden rule).
// What it does is in App.escKey (the list and Sleep mode) and EscRules.native (every other PS window).
// The one case it cannot cover: PS's main thread itself frozen. Then the watchdog passes every key straight through
// (hard rule 4), so Esc reaches the app behind; the list cannot be hidden by a frozen app.
import Cocoa

enum EscRules {
  /// How long PS waits for the page's answer before hiding the list anyway (core/escape.ts PAGE_WAIT_MS).
  static let pageWait: Double = 0.7
  /// Esc this many times within `burst` seconds hides the list whatever the page says (BURST_COUNT, BURST_MS).
  static let burstCount = 3
  static let burst: Double = 1.5

  /// What Esc does in each PS window that can hold the keyboard.
  enum Native: Equatable {
    case list        // the Tab list: App.escKey (step back, then hide)
    case own         // the window answers Esc itself (Torch: leaves; Second Computer question: No)
    case ays         // Are you sure card: the keyboard goes back to the browser, the pause carries on
    case posture     // the Posture reminder card (after a click gave it the keyboard): Esc closes it
    case reminder    // a reminder card's confirm box: the keyboard goes back (the Test card: it closes)
    case card        // a meeting or notification card's remind time box: typing ends, the keyboard goes back
    case signIn      // the small Sign in window: it goes (PS keeps running)
    case close       // any other titled PS window: closed like its close button (Second Computer, Update, setup)
    case letGo       // anything else: it lets go of the keyboard
  }
  static func native(for w: NSWindow, panel: NSWindow?, signIn: NSWindow?) -> Native {
    if w === panel { return .list }
    if w === signIn { return .signIn }
    if w is TorchLightWindow || w is SecondConfirmPanel || w is ReplyPanel || w is GuideCardPanel || w is AssistPanel || w is StandIgnorePanel { return .own }   // GuideCardPanel: the token guide card closes the guide (SetupGuide.swift)   // ReplyPanel: the page asks before throwing away a reply
    if w is AysPanel { return .ays }
    if w is FuPanel { return .reminder }
    if w is PosturePanel { return .posture }
    if w is NotePanel { return .card }
    if w.styleMask.contains(.titled) && w.styleMask.contains(.closable) { return .close }
    return .letGo
  }
}
