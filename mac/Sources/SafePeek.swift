import Cocoa
import Carbon.HIToolbox

// Hold Tab over Signal or 1Password WITHOUT PS seeing either (Signal: the developer, 17 Oct 2026. 1Password:
// The developer, 7 Nov 2026, V1.40). While either is in front the keyboard tap is OFF, so macOS gives PS none of their keys.
// Instead PS asks macOS for ONE system hotkey: plain Tab, no modifiers. macOS itself does the
// matching, so all PS ever learns is "Tab went down" and "Tab came up". Every other key,
// Shift+Tab and every shortcut go straight to the app and never reach PS. PS never reads which app
// it is beyond Protected's bundle id check, nor its window titles, screen, audio or network.
// Hold Tab = the list while held (pinned, or kept by "Tab keeps the list open": Tab closes it), Esc closes it.
// The one cost: a quick Tab tap no longer reaches the app (in 1Password it no longer moves to the next
// field; Shift+Tab still moves back). PS cannot hand it back without typing into the app, which the
// golden rule forbids. Tab + a key and the / then . chord do not work there (they need the tap). The
// list never takes the keyboard over either app.
// Esc is grabbed the same way while the list is up over 1Password or Signal (failsafe parity).
//
// V1.44 (the developer, 9 Nov 2026: "open on ANY app, even 1Password and Signal on the PUBLIC release"), rules in
// SafePeekCore.swift: the hotkey now also arms while PS is locked or signed out (a hold asks for Touch ID or shows
// the card with Sign in, as over any other app), whichever open key is chosen (Right Option cannot be seen over
// them, so plain Tab opens PS there), and while macOS Secure Input is stuck on in the background (the tap hears
// nothing then, over every app). Over a normal app a quick tap is sent on, so Tab still moves between fields.
//
// V1.47 Tab overlay shortcuts (OpenKeysCore.swift): once someone changes the list, the hold keys armed here are the
// list's hold keys that a hotkey may grab (Tab and the F keys, never a key that types), and every combo in the list
// (Control Option Space) is a hotkey all the time, over every app, so the keyboard tap never reads a combo. Chords and
// modifier holds need the tap, so they never work over 1Password or Signal. Nobody who never changed the list sees
// any difference: plain Tab, as before.
//
// V1.58 (the developer, 13 Nov 2026): two rules, one per account, in BuildRules.swift. Everyone except the developer: all of the above.
// The developer's account: never armed over 1Password or Signal (no hold key, no combo, no Esc), and a list left up (pinned,
// Keep overlay) goes away when one of them comes to the front (TabWatch.protectedChanged). Why friends still could not
// open PS over Signal before V1.58: see SafePeekCore.swift (a typing flag left over while the list was hidden).
// PS 1.71: "The developer's account" above now means "a build that says off" (the developer's own build, for every account), and
// "everyone else" means "a build that says on" (the G Squad build, the developer's account too). BuildRules.now decides.
final class SafePeek {
  static let shared = SafePeek()
  weak var app: App?
  /// Hold keys armed now, by key code (Tab is hotkey id 1 as before; any other key is 1000 + its code).
  private var holdRefs: [Int: EventHotKeyRef] = [:]
  private var escRef: EventHotKeyRef?
  /// V1.47: the list's combos, hotkey ids 3000 + their place in the list.
  private var comboRefs: [EventHotKeyRef] = []
  private var comboSig = ""
  /// Lists whose refused combos were already logged (V1.58: on the developer's account the combos are dropped while 1Password or
  /// Signal is in front and taken back after; a line then would write down when they were used).
  private var comboLogged: Set<String> = []
  /// V1.47: why each combo could not be registered (its place in the list), for Settings ("taken by another app").
  private(set) var comboTaken: Set<Int> = []
  /// V1.47: Settings is recording a new shortcut: no combo fires (it would close the list mid recording).
  var recording = false { didSet { if oldValue != recording { refresh() } } }
  /// Which hold key is down (SafePeek follows one at a time).
  private var downCode = OpenKeysCore.TAB
  private var handler: EventHandlerRef?
  private var down = false      // Tab is physically held (macOS repeats "pressed" while held)
  private var showing = false   // this hold brought the list up
  private var timer: Timer?
  private static let sig: OSType = 0x5053_5450   // "PSTP"
  var armed: Bool { !holdRefs.isEmpty || !testHolds.isEmpty }
  var escArmed: Bool { escRef != nil || testEsc }
  /// Self test copies only pretend to register (a real hotkey would take Tab from the developer's apps).
  private var testHolds: Set<Int> = [], testEsc = false
  /// Self test: how many combos a test copy pretended to register.
  private(set) var testCombos = 0
  /// Self test only: the result of the last RegisterEventHotKey call.
  private(set) var lastStatus: OSStatus = noErr
  /// Secure Input stuck on in the background (SecureInput.swift tells, debounced). Main thread.
  var secureStuck = false { didSet { if oldValue != secureStuck { refresh() } } }
  /// PS 1.70: the app in front holds Secure Input (SecureInput.swift onFront, debounced). Main thread. The hotkey is
  /// armed then only while the Tab blocked card is switched on, and only to see a hold (SafePeekCore.holdShowsCard).
  var secureFront = false { didSet { if oldValue != secureFront { refresh() } } }
  /// PS 1.70: this hold brings the Tab blocked card, not the list (decided when Tab went down).
  private var cardHold = false
  /// Tab is held right now, seen by the hotkey (TabBlocked leaves the hold to it then).
  var isDown: Bool { down }
  /// A quick tap is being sent on to a normal app: the hotkey is off until it has gone by.
  private var passingOn = false
  /// Self test: how many quick taps were sent on (a test copy never sends a key).
  private(set) var testPassed = 0
  /// Self test: what the last hold did.
  private(set) var lastHold: SafePeekCore.HoldAction?
  private let postQ = DispatchQueue(label: "ps.safepeek.post", qos: .userInteractive)

  func start() {
    guard handler == nil else { return }
    var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                 EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
    InstallEventHandler(GetEventDispatcherTarget(), { _, event, _ in
      guard let event else { return OSStatus(eventNotHandledErr) }
      var id = EventHotKeyID()
      GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                        MemoryLayout<EventHotKeyID>.size, nil, &id)
      guard id.signature == SafePeek.sig else { return OSStatus(eventNotHandledErr) }
      SafePeek.shared.hit(id.id, pressed: GetEventKind(event) == UInt32(kEventHotKeyPressed))
      return noErr
    }, types.count, &types, nil, &handler)
    refresh()
  }

  private func inputs() -> SafePeekCore.Inputs? {
    guard let app else { return nil }
    let w = TabWatch.shared
    return SafePeekCore.Inputs(protectedFront: Protected.front, secureStuck: secureStuck, enabled: w.enabled,
                               triggerKey: w.triggerKey, kept: app.kept, editing: w.editing, appActive: w.appActive,
                               frontIgnored: w.frontIgnored, held: down, passingOn: passingOn, shown: app.shown,
                               tabOverProtected: BuildRules.now.tabOverProtected,
                               secureFront: secureFront && TabBlocked.shared.on)
  }

  /// Registers or drops the two hotkeys to match the moment. Called on every change that matters.
  func refresh() {
    guard let app, let i = inputs() else { return }
    // `held` in the rules: never drop the key while it is held.
    let w = TabWatch.shared
    var holds = OpenKeysCore.blindHolds(w.shortcutList, legacy: w.customList == nil)
    let why = SafePeekCore.blind(i)
    if why == .secureFront { holds = holds.filter { $0 == OpenKeysCore.TAB } }   // PS 1.70: only Tab, only to see a hold
    var want = Set(SafePeekCore.wantTab(i) ? holds : [])
    if down { want.insert(downCode) }
    for code in Set(holdRefs.keys).union(testHolds).subtracting(want) { hold(code, on: false) }
    for code in want where holdRefs[code] == nil && !testHolds.contains(code) { hold(code, on: true) }
    combos(w.customList.map { OpenKeysCore.Plan($0).combos } ?? [],
           on: SafePeekCore.wantCombos(enabled: w.enabled, recording: recording, protectedFront: Protected.front,
                                       tabOverProtected: i.tabOverProtected))
    hotkey(&escRef, on: SafePeekCore.wantEsc(protectedFront: Protected.front, secureStuck: secureStuck, shown: app.shown,
                                             tabOverProtected: i.tabOverProtected),
           key: kVK_Escape, id: 2)
    // One line when it arms or drops for Secure Input. Golden rule: never a line for 1Password or Signal coming to
    // the front or going (that would write down WHEN they were used), so those changes are not logged at all.
    let forSecure: SafePeekCore.Blind? = armed && !Protected.front && (why == .secureInput || why == .secureFront) ? why : nil
    if forSecure != loggedSecure {
      loggedSecure = forSecure
      psLog(SafePeekCore.logLine(armed: forSecure != nil, why: forSecure))
    }
  }
  private var loggedSecure: SafePeekCore.Blind?

  private static func holdId(_ code: Int) -> UInt32 { code == OpenKeysCore.TAB ? 1 : UInt32(1000 + code) }
  private func hold(_ code: Int, on: Bool) {
    if app?.selfTest == true { if on { testHolds.insert(code) } else { testHolds.remove(code) }; return }
    var ref = holdRefs[code]
    hotkey(&ref, on: on, key: code, id: SafePeek.holdId(code))
    holdRefs[code] = ref
  }
  /// V1.47: the list's combos, all registered or all dropped (re-registered only when the list changes).
  private func combos(_ list: [OpenKeysCore.Shortcut], on: Bool) {
    let sig = on ? OpenKeysCore.encode(list) : ""
    guard sig != comboSig else { return }
    comboSig = sig
    comboRefs.forEach { UnregisterEventHotKey($0) }
    comboRefs = []
    comboTaken = []
    if app?.selfTest == true { testCombos = on ? list.count : 0; return }
    guard on else { return }
    defer { comboLogged.insert(sig) }
    for (n, c) in list.enumerated() {
      var ref: EventHotKeyRef?
      let st = RegisterEventHotKey(UInt32(c.key), OpenKeysCore.carbonMods(c.mods ?? []), EventHotKeyID(signature: SafePeek.sig, id: UInt32(3000 + n)),
                                   GetEventDispatcherTarget(), 0, &ref)
      if st == noErr, let ref { comboRefs.append(ref) }
      else {
        comboTaken.insert(n)
        if !comboLogged.contains(sig) { psLog("PS safepeek: combo \(n + 1) not registered (\(st)), another app may use it") }
      }
    }
  }

  private func hotkey(_ ref: inout EventHotKeyRef?, on: Bool, key: Int, id: UInt32) {
    if app?.selfTest == true { if id == 2 { testEsc = on }; return }
    if on, ref == nil {
      lastStatus = RegisterEventHotKey(UInt32(key), 0, EventHotKeyID(signature: SafePeek.sig, id: id),
                                       GetEventDispatcherTarget(), 0, &ref)
      if lastStatus != noErr { ref = nil; psLog("PS safepeek: hotkey \(id) not registered (\(lastStatus)), another app may hold plain \(id == 1 ? "Tab" : id == 2 ? "Esc" : "key \(key)") as a shortcut") }
    } else if !on, let r = ref {
      UnregisterEventHotKey(r)
      ref = nil
    }
  }

  func hit(_ id: UInt32, pressed: Bool) {
    guard let app else { return }
    if id == 2 { if pressed { app.escKey() }; return }
    if id >= 3000 { if pressed { combo(app) }; return }
    let code = id == 1 ? OpenKeysCore.TAB : Int(id) - 1000
    if pressed {
      if down { return }        // the key repeating while held
      down = true
      downCode = code
      if app.shown {            // already up (pinned or kept): Tab puts it away
        if !app.kept { app.hideOverlay() }
        return
      }
      // PS 1.70: with Secure Input held by the app in front, a hold brings the Tab blocked card (after a longer hold);
      // anything shorter is a quick tap and goes on to the app below.
      cardHold = code == OpenKeysCore.TAB && inputs().map { SafePeekCore.holdShowsCard(SafePeekCore.blind($0)) } == true
      timer = Timer(timeInterval: cardHold ? TabBlockedCore.holdFor : HOLD_SECONDS, repeats: false) { [weak self] _ in
        guard let self, self.down, !app.shown else { return }
        // Not blind any more (Secure Input went off a moment ago, before the next look): the list, as for any hold.
        if self.cardHold && TabBlocked.shared.sawHold(signal: "hotkey") { return }
        self.held(app)
      }
      RunLoop.main.add(timer!, forMode: .common)
    } else {
      guard code == downCode else { return }   // another hold key let go while this one is held
      let wasDown = down
      down = false
      let quick = timer?.isValid == true   // let go before the hold time: a tap, not a hold
      timer?.invalidate()
      if showing {
        showing = false
        // Tab keeps the list open: it stays up (pinned) over Signal too, without the keyboard; the next
        // press of Tab puts it away (a tap never reaches Signal from here anyway).
        let w = TabWatch.shared
        w.mu.lock()
        if !w.pinned && w.stays && !app.kept { w.pinned = true }
        let keep = w.pinned
        w.mu.unlock()
        if !keep { app.hideOverlay() }
      } else if wasDown && quick && SafePeekCore.passOnTap(protectedFront: Protected.front) {
        passOn(code)
        return                  // passOn refreshes once the Tab has gone by
      }
      refresh()
    }
  }

  /// V1.47: a combo from the Tab overlay shortcuts list was pressed (macOS matched it, PS read no key). Up: it goes
  /// (unless Keep overlay holds it). Down: as a hold of Tab, then it stays open (pinned) like Open list, so letting go
  /// of the keys does not close it; the combo again, Tab or Esc puts it away.
  private func combo(_ app: App) {
    if app.shown { if !app.kept { app.hideOverlay() }; return }
    if Protected.front && !BuildRules.now.tabOverProtected { return }   // The developer's account: never over them (V1.58)
    let a = SafePeekCore.onHold(unlocked: app.vaultUnlocked, locked: TouchLock.cachedLocked,
                                askingTouchID: TouchLock.isAsking, sleepUp: app.sleepUp)
    lastHold = a
    switch a {
    case .showList:
      let w = TabWatch.shared
      w.mu.lock(); w.pinned = true; w.mu.unlock()
      app.showOverlay()
    case .askTouchID:
      TabWatch.shared.noteOnce("PS tab: a shortcut pressed while PS is locked, asking for Touch ID")
      app.touchUnlock()
    case .showCard:
      TabWatch.shared.noteOnce("PS tab: a shortcut pressed while PS is signed out or still opening, showing the pop-up")
      app.showPopup(asked: true)
    case .nothing:
      if app.sleepUp { app.showOverlay() }   // it refuses and logs why (Wake up first)
    }
  }

  /// Tab held for the hold time: the same as the keyboard tap does over any other app.
  private func held(_ app: App) {
    if Protected.front && !BuildRules.now.tabOverProtected { return }   // The developer's account: never over them (V1.58)
    let a = SafePeekCore.onHold(unlocked: app.vaultUnlocked, locked: TouchLock.cachedLocked,
                                askingTouchID: TouchLock.isAsking, sleepUp: app.sleepUp)
    lastHold = a
    switch a {
    case .showList:
      showing = true
      app.showOverlay()
    case .askTouchID:
      TabWatch.shared.noteOnce("PS tab: Tab held while PS is locked, asking for Touch ID")
      app.touchUnlock()
    case .showCard:
      TabWatch.shared.noteOnce("PS tab: Tab held while PS is signed out or still opening, showing the pop-up")
      app.showPopup(asked: true)
    case .nothing:
      if app.sleepUp { app.showOverlay() }   // it refuses and logs why (Wake up first)
    }
  }

  /// A quick tap over a normal app (Secure Input stuck on): the Tab goes on to the app, as the keyboard tap sends
  /// it on. The hotkey is dropped first so it cannot catch this Tab again, and comes back once it has gone by.
  /// Never over 1Password or Signal (the golden rule: PS never types into them).
  private func passOn(_ code: Int = OpenKeysCore.TAB) {
    guard !Protected.front else { refresh(); return }
    passingOn = true
    refresh()                   // drops the Tab hotkey (passingOn)
    if app?.selfTest == true { testPassed += 1 }
    else {
      postQ.async {
        let src = CGEventSource(stateID: .hidSystemState)
        for d in [true, false] {
          guard let ev = CGEvent(keyboardEventSource: src, virtualKey: CGKeyCode(code), keyDown: d) else { continue }
          ev.flags = []
          ev.setIntegerValueField(.eventSourceUserData, value: MAGIC)   // the keyboard tap lets it through
          ev.post(tap: .cgSessionEventTap)
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      guard let self else { return }
      self.passingOn = false
      self.refresh()
    }
  }
}
