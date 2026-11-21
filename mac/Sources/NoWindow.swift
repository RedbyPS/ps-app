import AppKit
import WebKit

// PS without its main window (V1.23, the developer, 31 Oct 2026: "I only want it to be the tab overlay now").
// The main page is the engine (vault, sync, decryption, cards, the Dynamic Island, reminders, Do Not
// Disturb) and keeps running hidden: it is never shown and never unloaded. What the developer sees instead:
// - the "PS is active" pop-up (Popup.swift) at launch, on a Dock click and from the PS menu;
// - the Tab list (Open list, Settings: its Mac settings window, the end of day rule check);
// - a small Sign in window (this window, the engine page's own sign in screen) only when he asks to
//   sign in. The passphrase is typed into the engine page itself, never into PS or the pop-up.
extension App {
  /// The Sign in window's width, and its height until the page says how tall it is ("signin:size").
  static let signInSize = NSSize(width: 400, height: 560)
  /// Behind the page while the window grows or shrinks: the page's own colours (PsSignIn.tsx), light or dark.
  static let signInBackground = NSColor(name: nil) { a in
    a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(red: 0.12, green: 0.06, blue: 0.10, alpha: 1) : NSColor(red: 1, green: 0.97, blue: 0.98, alpha: 1)
  }
  /// The Tab list's Mac settings (web MacSettings.tsx); an older web build opens the gear menu.
  static let openSettingsJS = "(window.__psOpenSettings && window.__psOpenSettings()) || ((b) => b && b.click())(document.querySelector('.tm-tr button[aria-label=Settings]'))"

  func setUpPopup() {
    Popup.shared.onAction = { [weak self] a in
      guard let self else { return }
      switch a {
      case "list": self.openList()
      case "settings": self.openList(then: App.openSettingsJS)
      case "quit": psLog("PS: quit from the pop-up"); NSApp.terminate(nil)
      case "touch": self.touchUnlock()
      case "signin": self.showSignIn()
      case "fix": self.fixPermission()
      case "tabOn": self.setTab(true)
      case "second": Popup.shared.secondComputer?()
      default: break
      }
    }
    Popup.shared.onHidden = { [weak self] in self?.giveFocusBack() }
    // Second Computer (Second.swift): its window from the pop-up, and its one line state ("Home M1, online").
    // The developer's alone (V1.42): on anyone else's PS the pop-up has no Second Computer row at all.
    Owner.whenRed {
      Popup.shared.secondComputer = { Second.shared.handle("second:window", [:]) }
      Popup.shared.secondStatus = { Second.shared.statusLine }
    }
    Popup.shared.update { $0.version = PSVersion.name }
    updatePopup()
    // Remember me usually opens the vault within seconds; after that the pop-up stops saying "starting".
    DispatchQueue.main.asyncAfter(deadline: .now() + 20.5) { [weak self] in self?.updatePopup() }
  }

  /// What the pop-up says about the vault right now.
  func popupStage() -> PopupState.Stage {
    if vaultUnlocked { return .open }
    if TouchLock.cachedLocked { return .locked }
    if (!rememberKnown || Remember.cachedExists) && Date() < openingUntil && !selfTest { return .opening }
    return .signedOut
  }
  func updatePopup() {
    let st = popupStage()
    Popup.shared.update { $0.stage = st }
  }

  /// The pop-up, with a fresh sync so "Synced just now" is true. asked: Tab was held for it (SafePeek, V1.44), so it
  /// comes up over 1Password or Signal too (it never takes their keyboard); on its own it never does.
  func showPopup(asked: Bool = false) {
    updatePopup()
    if vaultUnlocked { sendToMain(#"{"type":"pull"}"#) }
    Popup.shared.show(asked: asked)
    if selfTest { print("POPUP: shown stage=\(Popup.shared.model.st.stage.rawValue)") }
  }

  /// PS counts as "in front" for the Tab key only while the Sign in window is up.
  func syncAppActive() {
    TabWatch.shared.appActive = NSApp.isActive && window.isVisible
    SafePeek.shared.refresh()   // PS's own Sign in window keeps its Tab (V1.44, while Secure Input is stuck)
  }

  /// A Dock click made PS the active app; once the pop-up or Sign in goes, the keyboard goes back to
  /// the app the developer was in. Never activates 1Password or Signal (golden rule): PS just steps back.
  func giveFocusBack() {
    guard !selfTest, NSApp.isActive, !window.isVisible, !shown else { syncAppActive(); return }
    if let a = lastOtherApp, !a.isTerminated, !Protected.matches(a) { a.activate(options: []) }
    else { NSApp.deactivate() }
    syncAppActive()
  }

  /// The Tab list, pinned open as if Tab was tapped (Tab or Esc puts it away), then optional page code.
  func openList(then js: String? = nil) {
    guard vaultUnlocked else { showPopup(); return }
    giveFocusBack()
    if !shown { TabWatch.shared.pinned = true; showOverlay() }
    if let js { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.overlay.evaluateJavaScript(js, completionHandler: nil) } }
  }


  /// The small Sign in window: the engine page's own sign in (passphrase, Remember me, recovery, Touch
  /// ID). Only on the developer's click. Over 1Password or Signal it appears but never takes the keyboard.
  /// rise: PS Cake, the end of a signed out boot animation: the window comes up a little as it fades in, as on the demo.
  func showSignIn(rise: Bool = false) {
    if vaultUnlocked { showPopup(); return }
    if ProjectSetup.shared.holding { ProjectSetup.shared.show(mode: .first); return }   // no project yet: set one up first
    Popup.shared.hide(giveBack: false)
    let mouse = NSEvent.mouseLocation
    if let s = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main {
      let v = s.visibleFrame, w = App.signInSize.width, h = min(signInHeight ?? App.signInSize.height, v.height - 40)
      window.setFrame(NSRect(x: (v.midX - w / 2).rounded(), y: (v.midY - h / 2 + v.height * 0.06).rounded(), width: w, height: h), display: false)
    }
    signInCover?.removeFromSuperview(); signInCover = nil
    window.title = SIGN_IN_TITLE
    window.styleMask = [.titled, .closable, .fullSizeContentView]
    window.backgroundColor = App.signInBackground
    signInOpen = true
    psLog("PS: sign in window shown")
    if selfTest { window.orderFrontRegardless(); syncAppActive(); return }   // parked off screen, invisible, never key
    window.alphaValue = 0
    // The boot animation's scene sits over every app window (Cake.swift): for its rise the window goes up to the scene's
    // own level, in front of it, while the scene fades behind; then it is a normal window again.
    if rise { window.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue - 1) }
    if Protected.front { window.orderFrontRegardless() }
    else { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    let rest = window.frame
    if rise && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { window.setFrame(rest.offsetBy(dx: 0, dy: -16), display: false) }
    NSAnimationContext.runAnimationGroup({ c in
      c.duration = rise ? 0.52 : 0.22
      c.timingFunction = rise ? CAMediaTimingFunction(controlPoints: 0.16, 1, 0.3, 1) : CAMediaTimingFunction(name: .easeOut)
      window.animator().alphaValue = 1
      if rise { window.animator().setFrame(rest, display: true) }
    }, completionHandler: { [weak self] in
      guard rise, let w = self?.window else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { w.level = .normal }   // the scene has gone by then
    })
    syncAppActive()
  }

  /// The page's height (V1.26): the window is exactly as tall as the sign in, so no scrollbar and no
  /// card inside a window. Its top edge stays put.
  func setSignInHeight(_ h: CGFloat) {
    guard h >= 200 else { return }
    signInHeight = h.rounded()
    guard signInOpen, window.title == SIGN_IN_TITLE, let s = window.screen ?? NSScreen.main else { return }
    let f = window.frame, nh = min(signInHeight ?? f.height, s.visibleFrame.height - 40)
    guard abs(nh - f.height) >= 1 else { return }
    let y = max(s.visibleFrame.minY + 20, f.maxY - nh)
    window.setFrame(NSRect(x: f.minX, y: y, width: App.signInSize.width, height: nh), display: true, animate: !selfTest && window.isVisible)
  }

  /// Closing the Sign in window (its close button, Cmd+W): it hides and the keyboard goes back.
  /// (The Fitness window that also used this left on 2 Nov 2026: Fitness is a screen inside the Tab list.)
  func hideEngineWindow() {
    guard window.isVisible else { return }
    window.orderOut(nil)
    signInOpen = false
    syncAppActive()
    giveFocusBack()
  }

  /// Signed in (and past any new recovery key): a tick over the window, it fades, the pop-up says PS is active.
  func finishSignIn() {
    guard window.isVisible, signInCover == nil, window.title == SIGN_IN_TITLE else { return }
    psLog("PS: signed in, sign in window closing")
    let cover = NSVisualEffectView(frame: main.bounds)
    cover.autoresizingMask = [.width, .height]
    cover.material = .hudWindow; cover.blendingMode = .withinWindow; cover.state = .active
    cover.appearance = NSAppearance(named: .darkAqua)
    let tick = NSImageView(image: NSImage(systemSymbolName: "checkmark.circle.fill", accessibilityDescription: "Signed in") ?? NSImage())
    tick.symbolConfiguration = .init(pointSize: 54, weight: .semibold)
    tick.contentTintColor = NSColor(red: 0.36, green: 0.80, blue: 0.60, alpha: 1)
    let label = NSTextField(labelWithString: "Your vault is open")
    label.font = .systemFont(ofSize: 20, weight: .bold); label.textColor = .white
    let stack = NSStackView(views: [tick, label]); stack.orientation = .vertical; stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    cover.addSubview(stack)
    NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: cover.centerXAnchor), stack.centerYAnchor.constraint(equalTo: cover.centerYAnchor)])
    cover.alphaValue = 0
    main.addSubview(cover)
    signInCover = cover
    // Timed steps, not animation callbacks: those never fire while the screen is locked or asleep.
    NSAnimationContext.runAnimationGroup { $0.duration = 0.18; cover.animator().alphaValue = 1 }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
      guard let self else { return }
      NSAnimationContext.runAnimationGroup { $0.duration = 0.25; self.window.animator().alphaValue = 0 }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
        self.window.orderOut(nil)
        self.signInOpen = false
        self.window.alphaValue = self.selfTest ? 0 : 1
        self.signInCover?.removeFromSuperview(); self.signInCover = nil
        self.syncAppActive()
        self.giveFocusBack()
        if !self.selfTest { self.showPopup() }
      }
    }
  }
}
