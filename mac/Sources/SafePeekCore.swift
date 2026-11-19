import Foundation

// SafePeek's rules (V1.44, the developer, 9 Nov 2026: "Make it so the PS app can open on ANY app, even 1Password and Signal on
// the PUBLIC release. My G Squad friend just complained he can't open PS app while over Signal messenger."). Plain
// values only, so tests/safepeek-test.swift can check every case without macOS. SafePeek.swift asks macOS.
//
// The keyboard tap is "blind" in two cases, and SafePeek's one plain Tab hotkey stands in for it there:
//  - 1Password or Signal is in front: the tap is switched OFF on purpose (the golden rule).
//  - macOS Secure Input is stuck on (left on by the lock screen or an app in the background): macOS hands the tap
//    no keys at all, so holding Tab did nothing, silently, in every app.
// A hotkey needs no keys read: macOS does the matching and tells PS only "Tab went down" and "Tab came up".
//
// What was silent before V1.44, and is not any more:
//  - PS locked (Touch ID) or signed out: over 1Password or Signal the hotkey was not even armed. Now a hold asks for
//    Touch ID, or shows the "PS is active" card with Sign in, like a hold over any other app.
//  - "Hold Right Option" chosen: Right Option needs the tap (there is no hotkey for a modifier alone), so over
//    1Password or Signal nothing could open PS. Now a hold of plain Tab opens it there too.
//  - Secure Input stuck on: the hotkey is armed while it lasts.
//
// V1.58 (the developer, 13 Nov 2026), two rules, one per account (BuildRules.swift):
//  - Everyone except the developer: armed over 1Password and Signal, as above.
//  - the developer: never armed over them (tabOverProtected false). Secure Input stuck does not change that while one of them
//    is in front.
// And the cause of "Tab still does not open over Signal" on the public build: `editing` (typing in the floating list)
// stayed true after the list had gone, because the page can say "a screen is open" (G Squad, Fitness, Dimension X,
// Brief and the others send {type:"dimx"}, a box sends {type:"edit"}) while the list is hidden, for example a screen
// reopening itself. The keyboard tap only counts `editing` while the list is shown (main.swift), so Tab kept working
// over every normal app, but SafePeek counted it always and dropped the hotkey: over 1Password and Signal nothing
// opened PS, silently. Now `editing` only counts while the list is shown, as in the tap.
//
// PS 1.70 (the Tab blocked alert, TabBlockedCore.swift): a third blind case, the app in FRONT holding Secure Input (a
// password box, or one left on: DuckDuckGo on 19 Nov). Before, PS took that as normal and holding Tab did nothing,
// silently. Now the plain Tab hotkey is armed there too, but only to SEE a hold: a quick tap goes on to the app as
// always, and a hold of TabBlockedCore.holdFor brings the Tab blocked card (which names the app and says how to fix
// it), never the list. Only while the card's switch is on, never over 1Password or Signal, never in PS's own window or
// an app on the ignore list.
enum SafePeekCore {
  /// Why the keyboard tap cannot see Tab right now. nil: it can, SafePeek stays out of the way.
  enum Blind: String, Equatable { case protected, secureInput, secureFront }

  static func blind(protectedFront: Bool, secureStuck: Bool, secureFront: Bool = false) -> Blind? {
    if protectedFront { return .protected }
    if secureStuck { return .secureInput }
    if secureFront { return .secureFront }
    return nil
  }

  struct Inputs: Equatable {
    var protectedFront = false
    /// Secure Input is on and held by an app that is NOT in front (SecureInputCore.stuck), for a moment.
    var secureStuck = false
    /// Tab overlay switched on in Settings.
    var enabled = true
    /// "tab" or "rightOption".
    var triggerKey = "tab"
    /// Keep overlay ticked: the list stays up and Tab is the app's again.
    var kept = false
    /// Typing in the floating list: Tab moves between its boxes.
    var editing = false
    /// PS's own Sign in window is in front (it holds Secure Input itself while you type the passphrase).
    var appActive = false
    /// The app in front is on PS's "ignore Tab here" list (never 1Password or Signal: they cannot be picked).
    var frontIgnored = false
    /// Tab is physically held right now (never drop the hotkey mid hold).
    var held = false
    /// A Tab PS just sent on (a quick tap over a normal app): the hotkey stays off until it has gone by.
    var passingOn = false
    /// The list is on screen now. `editing` only counts then (a flag left over while hidden must not disarm Tab).
    var shown = false
    /// This account may open PS over 1Password and Signal (BuildRules: false for the developer, true for everyone else).
    var tabOverProtected = true
    /// PS 1.70: the app in front has held Secure Input for a moment AND the Tab blocked card is switched on.
    var secureFront = false
  }

  /// The blind case for these inputs.
  static func blind(_ i: Inputs) -> Blind? { blind(protectedFront: i.protectedFront, secureStuck: i.secureStuck, secureFront: i.secureFront) }

  /// Whether the plain Tab hotkey is armed.
  static func wantTab(_ i: Inputs) -> Bool {
    if i.held { return true }
    guard let why = blind(i) else { return false }
    guard i.enabled, !i.kept, !(i.editing && i.shown), !i.passingOn else { return false }
    switch why {
    case .protected:
      // The developer's account: never over them. Everyone else: any chosen key (Right Option cannot be seen over them, so
      // plain Tab is the way in there).
      return i.tabOverProtected
    case .secureInput, .secureFront:
      // PS's own Sign in window and apps on the ignore list keep their Tab.
      return !i.appActive && !i.frontIgnored
    }
  }

  /// PS 1.70: what a hold does in this blind case. Secure Input held by the app in front: the Tab blocked card, after
  /// TabBlockedCore.holdFor (a shorter press is a quick tap and goes on to the app). Every other case: the list, as before.
  static func holdShowsCard(_ why: Blind?) -> Bool { why == .secureFront }

  /// Whether Esc is grabbed the same way (the tap cannot see it either): only while the list is up.
  /// The developer's account: never over 1Password or Signal (the list does not stay up there for him anyway).
  static func wantEsc(protectedFront: Bool, secureStuck: Bool, shown: Bool, tabOverProtected: Bool = true) -> Bool {
    if protectedFront && !tabOverProtected { return false }
    return shown && blind(protectedFront: protectedFront, secureStuck: secureStuck) != nil
  }

  /// Whether the list's combos (V1.47, Control Option Space and the like) are registered. Everyone else: always while
  /// the Tab overlay is on and Settings is not recording. The developer's account: dropped while 1Password or Signal is in
  /// front, so no combo can open PS over them and no combo key is taken from them.
  static func wantCombos(enabled: Bool, recording: Bool, protectedFront: Bool, tabOverProtected: Bool) -> Bool {
    enabled && !recording && !(protectedFront && !tabOverProtected)
  }

  /// When 1Password or Signal comes to the front with the list up (pinned, Keep overlay): the developer's account puts it away
  /// (PS steps aside completely), everyone else keeps it where it is.
  static func hideListOnProtected(protectedFront: Bool, shown: Bool, tabOverProtected: Bool) -> Bool {
    protectedFront && shown && !tabOverProtected
  }

  enum HoldAction: Equatable { case showList, askTouchID, showCard, nothing }

  /// What a hold of Tab (held for HOLD_SECONDS) does. Same as the keyboard tap does over any other app.
  static func onHold(unlocked: Bool, locked: Bool, askingTouchID: Bool, sleepUp: Bool) -> HoldAction {
    if sleepUp { return .nothing }                       // Sleep mode: Wake up first (showOverlay says so in the log)
    if unlocked { return .showList }
    if locked { return askingTouchID ? .nothing : .askTouchID }
    return .showCard                                     // signed out or still opening: the card with Sign in
  }

  /// A quick tap (let go before the hold time): does PS send the Tab on to the app in front?
  /// NEVER into 1Password or Signal: PS never types into them (that Tab is simply lost there, the known cost).
  /// Over any other app it goes on, as the keyboard tap does, so Tab still moves between fields.
  static func passOnTap(protectedFront: Bool) -> Bool { !protectedFront }

  /// The log line when the hotkey arms or drops. Never names an app.
  static func logLine(armed: Bool, why: Blind?) -> String {
    guard armed else { return "PS safepeek: Tab hotkey off, the keyboard tap has Tab again" }
    switch why {
    case .protected?: return "PS safepeek: Tab hotkey on (a protected app is in front, the keyboard tap is off)"
    case .secureInput?: return "PS safepeek: Tab hotkey on (macOS Secure Input is stuck on, the keyboard tap hears nothing)"
    case .secureFront?: return "PS safepeek: Tab hotkey on (the app in front holds macOS Secure Input, watching for a hold of Tab)"
    case nil: return "PS safepeek: Tab hotkey on (held)"
    }
  }
}
