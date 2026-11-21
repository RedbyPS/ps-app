import AppKit
import WebKit

// PS Cake: the boot animation (every start) and the logo reveal (once, and from Settings). The rules: CakeCore.swift; the
// drawing: ui/cake.html (the approved demo's Mac view, ported 1 to 1 at 1710 x 1112, scaled to cover other screens).
// One window over the island's screen, BELOW the menu bar and the island and above every app and the Dock, so PS's real
// menu bar and real island float over the scene, as on the demo. It never becomes key and never activates PS; it takes a
// click (as its skip) so nothing behind the scene is clicked blind. Never while 1Password or Signal is in front.
//
// The boot animation:
//  - atLaunch: one of three scenes, never the one played last (CakeCore.pick). The island is held off at once (it does
//    not exist at first) and the island queue's turn is taken, so no card comes out in the middle.
//  - The page plays the scene at its fixed speed and builds the island in neon round the island's real place, then asks
//    {type:"built"}. The Mac answers when PS is ready (CakeCore.ending): signed in and the island knows its task, or
//    signed out. Until then the page holds its calm loop. Then the real island is born out of the neon (Island.hatchBorn)
//    and the page settles the glow into it.
//  - After the scene's own length the scene fades away ({type:"exit"}). Signed out: the Sign in window rises in during
//    the fade. Signed in: the "PS is active" pop-up comes as at every start.
//  - Esc or a click: the scene fades at once and the island comes back (signed out: the Sign in window).
// The logo reveal: the same window, the scene from card 4 of the demo, then it fades away. The real island is there all
// along (the bolts come out of it); at the end the page lights a neon edge round it.
final class CakePanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class Cake: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = Cake()
  private let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  weak var app: App?

  private var win: CakePanel?
  private var web: WKWebView?
  private var ready = false
  private var waiting: [String] = []
  private var monitors: [Any] = []
  private(set) var kind: CakeKind?
  private var playing = false
  private var startedAt: Date?
  private var waitSince: Date?
  private var waitTimer: Timer?
  private var holdTimer: Timer?
  private var safety: DispatchWorkItem?
  private var islandBack = true
  private var ending: CakeCore.Ending?
  /// Run when the boot animation is over (main.swift: the "PS is active" pop-up of every start).
  private var after: (() -> Void)?
  static let queueId = "cake"

  // MARK: the boot animation

  /// Every start of PS (main.swift, after the updater started, so a start after an update is known). True when it plays;
  /// `then` runs once it is over (never when it does not play: the caller does that itself).
  @discardableResult func atLaunch(app: App, then: (() -> Void)? = nil) -> Bool {
    self.app = app
    guard kind == nil, CakeCore.playBoot(on: Hatch.shared.launchOn, afterUpdate: Hatch.shared.holding, test: test, install: INSTALL_MODE) else { return false }
    let d = UserDefaults.standard
    let scene = CakeCore.pick(last: d.object(forKey: CakeCore.lastKey) as? Int, roll: Double.random(in: 0..<1))
    d.set(scene.rawValue, forKey: CakeCore.lastKey)   // kept before it plays: the next start picks another one, even after a crash
    psLog("PS cake: boot \(scene.rawValue) \(scene.name)")
    kind = .boot(scene)
    after = then
    take()
    return true
  }

  // MARK: the logo reveal

  /// Settings > About and updates > Replay the logo reveal. Never while another scene is on screen, or over 1Password or Signal.
  func replayReveal() {
    guard !test, kind == nil, Hatch.shared.mode == nil, HatchCore.mayShow(protectedFront: Protected.front) else { psLog("PS cake: reveal replay not started"); return }
    psLog("PS cake: reveal replay")
    kind = .reveal(replay: true)
    take()
  }
  /// The logo reveal by itself, once per Mac (CakeCore.revealDue). Marked as seen before it plays: never twice.
  /// The developer's approved plan (21 Nov 2026): on the first launch after the update that ships it, the Hatch update scene plays
  /// as always (watched to the end), then this (Esc skips it), then What's new. Updater.swift calls it only when the
  /// update scene plays, so a fresh install never sees it by itself; Settings replays it any time.
  @discardableResult func revealOnce() -> Bool {
    let d = UserDefaults.standard
    guard kind == nil, CakeCore.revealDue(seen: d.bool(forKey: CakeCore.revealKey), test: test, install: INSTALL_MODE) else { return false }
    d.set(true, forKey: CakeCore.revealKey)
    kind = .reveal(replay: false)
    take()
    return true
  }

  // MARK: the turn, 1Password and Signal

  /// Takes the island queue's turn (no card or What's new in the middle) and, for the boot animation, holds the island off.
  private func take() {
    if case .boot = kind { holdIsland() }
    let o = IslandQueue.shared.enqueue(id: Cake.queueId, kind: "cake", priority: .high, ttl: nil,
                                       show: { [weak self] in self?.whenClear() }, visible: { [weak self] in self?.kind != nil },
                                       dropped: { [weak self] in self?.end() })
    if case .showNow = o { whenClear() }
  }
  private func whenClear() {
    guard kind != nil else { return }
    if HatchCore.mayShow(protectedFront: Protected.front) { start(); return }
    if waitSince == nil { waitSince = Date() }
    waitTimer?.invalidate()
    waitTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      guard let self, let since = self.waitSince else { return }
      if HatchCore.mayShow(protectedFront: Protected.front) { self.start() }
      else if Date().timeIntervalSince(since) > CakeCore.startWait { psLog("PS cake: 1Password or Signal stayed in front, skipped"); self.end() }
    }
  }
  private func start() {
    waitTimer?.invalidate(); waitTimer = nil; waitSince = nil
    guard let k = kind, !playing, let sc = screenNow() else { if !playing { end() }; return }
    ensure(sc)
    playing = true; startedAt = Date(); ending = nil
    var o = opts(sc)
    switch k {
    case .boot(let s): o["mode"] = "boot"; o["scene"] = s.rawValue
    case .reveal: o["mode"] = "reveal"
    }
    call("play", o)
    present()
    startEsc()
    safety?.cancel()
    let w = DispatchWorkItem { [weak self] in if self?.playing == true { psLog("PS cake: the scene reached its longest, ended"); self?.end() } }
    safety = w
    DispatchQueue.main.asyncAfter(deadline: .now() + CakeCore.maxSeconds(k), execute: w)
  }

  /// 1Password or Signal came to the front or went (main.swift Protected.onChange): never over them, the scene ends at once.
  func protectedChanged() {
    if Protected.front { stopEsc(); if playing { end() } }
    else if kind != nil, !playing, waitSince != nil { whenClear() }
  }

  // MARK: PS ready? (the boot animation's end)

  private func endingNow() -> CakeCore.Ending {
    guard let a = app else { return .island }
    let st = a.popupStage()
    return CakeCore.ending(signedIn: a.vaultUnlocked, islandKnown: Island.shared.pageStates > 0, signedOut: st == .signedOut,
                           locked: st == .locked, held: startedAt.map { Date().timeIntervalSince($0) } ?? 0)
  }
  /// The page built the island in neon. Answers at once when PS is ready, else when it gets ready (the page holds its loop).
  private func built() {
    holdTimer?.invalidate(); holdTimer = nil
    let e = endingNow()
    if e != .hold { land(e); return }
    psLog("PS cake: holding for PS to be ready")
    holdTimer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] tm in
      guard let self, self.playing else { tm.invalidate(); return }
      let e = self.endingNow()
      if e != .hold { tm.invalidate(); self.holdTimer = nil; self.land(e) }
    }
  }
  /// The real island is born out of the neon outline (or will not show: switched off, nothing on it).
  private func land(_ e: CakeCore.Ending) {
    ending = e
    islandBack = true
    let real = Island.shared.hatchBorn(blob: 30)
    var a: [String: Any] = ["real": real, "signIn": e == .signIn]
    if real, let sc = screenNow(), let r = HatchCore.pageRect(Island.shared.shapeOnScreen(), screen: sc.frame) { a["target"] = r }
    call("land", a)
  }
  /// The scene starts to fade: what comes next comes up under it.
  private func exiting() {
    win?.ignoresMouseEvents = true
    stopEsc()
    if case .boot = kind { afterBoot() }
  }
  private func afterBoot() {
    let e = ending ?? endingNow()
    if e == .signIn { after = nil; app?.showSignIn(rise: true) }
    let f = after; after = nil
    f?()
  }

  // MARK: Esc and clicks

  func skip() {
    guard playing, let k = kind, CakeCore.skippable(k) else { return }
    psLog("PS cake: skipped")
    if case .boot = kind {
      holdTimer?.invalidate(); holdTimer = nil
      if ending == nil { ending = endingNow() == .signIn ? .signIn : .island }
    }
    call("skip")
    exiting()
    releaseIsland()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in if self?.playing == true { self?.end() } }
  }

  // MARK: the end

  private func end() {
    if kind != nil { psLog("PS cake: scene over") }
    if case .reveal = kind { UserDefaults.standard.set(true, forKey: CakeCore.revealKey) }
    let wasBoot: Bool = { if case .boot = kind { return true }; return false }()
    let pending = after; after = nil
    safety?.cancel(); safety = nil
    waitTimer?.invalidate(); waitTimer = nil; waitSince = nil
    holdTimer?.invalidate(); holdTimer = nil
    stopEsc()
    win?.orderOut(nil)
    releaseIsland()
    let had = kind != nil
    kind = nil; playing = false; startedAt = nil; ending = nil
    if had { IslandQueue.shared.finish(Cake.queueId) }
    if wasBoot { pending?() }   // never shown (1Password, a stuck page): the pop-up of every start still comes
    let w = win, v = web
    win = nil; web = nil; ready = false; waiting = []
    DispatchQueue.main.async {
      v?.configuration.userContentController.removeScriptMessageHandler(forName: "cake"); v?.navigationDelegate = nil
      w?.orderOut(nil); w?.contentView = nil
    }
  }

  // MARK: the island

  /// The island does not exist at the start of a boot animation: held off at once, with no pinch (the scene builds it).
  private func holdIsland() { islandBack = false; Island.shared.hatchHold(true) }
  private func releaseIsland() { guard !islandBack else { return }; islandBack = true; Island.shared.hatchHold(false) }

  // MARK: the window

  private func screenNow() -> NSScreen? { IslandGeo.read().1 ?? NSScreen.main ?? NSScreen.screens.first }
  private func opts(_ sc: NSScreen) -> [String: Any] {
    var o: [String: Any] = ["reduce": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
                            "headline": CakeCore.headline, "ver": CakeCore.versionLine(PSVersion.name)]
    let t = HatchCore.aim(shown: HatchCore.pageRect(Island.shared.shapeOnScreen(), screen: sc.frame),
                          rest: HatchCore.pageRect(Island.shared.restShape(), screen: sc.frame),
                          spot: HatchCore.pageRect(Island.shared.hatchSpot(), screen: sc.frame),
                          fallback: fallbackTarget(sc))
    o["target"] = t
    o["notch"] = CakeCore.notchShaped(t)
    o["shown"] = Island.shared.shapeOnScreen() != nil   // the reveal: the bolts and the neon edge need the real island on screen
    return o
  }
  /// Where the island will be when it is not on screen yet (the page has not told it anything at a start): round the
  /// camera notch, or a pill just below the top centre. The demo's island is 196 x 34 round the notch.
  private func fallbackTarget(_ sc: NSScreen) -> [String: Double] {
    let w = Double(sc.frame.width), notch = Double(sc.safeAreaInsets.top)
    return notch > 0 ? ["x": w / 2 - 98, "y": 0, "w": 196, "h": max(notch, 34)] : ["x": w / 2 - 135, "y": 6, "w": 270, "h": 30]
  }
  private func ensure(_ sc: NSScreen) {
    if let w = win { if w.frame != sc.frame { w.setFrame(sc.frame, display: false) }; return }
    let p = CakePanel(contentRect: sc.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    // The boot animation: over the apps and the Dock, under the menu bar and the island (nothing else of PS is up yet).
    // The reveal is replayed from Settings in the Tab list (.statusBar): it goes on that level, ordered in front of the
    // list, and stays under the island (mainMenu + 2), whose bolts and neon edge it draws round.
    if case .reveal = kind { p.level = .statusBar } else { p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue - 1) }
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = IslandPlace.spaces
    p.ignoresMouseEvents = true
    let label: String = { if case .reveal = kind { return "Logo reveal" }; return "Start animation" }()
    p.setAccessibilityLabel(label)
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.preferences.isFraudulentWebsiteWarningEnabled = false
    c.userContentController.add(self, name: "cake")
    let v = ClickThroughWebView(frame: NSRect(origin: .zero, size: sc.frame.size), configuration: c)
    v.setValue(false, forKey: "drawsBackground")
    v.navigationDelegate = self
    v.autoresizingMask = [.width, .height]
    p.contentView = v
    p.setFrame(sc.frame, display: false)
    win = p; web = v; ready = false
    let res = Bundle.main.resourceURL!
    v.loadFileURL(res.appendingPathComponent("cake.html"), allowingReadAccessTo: res)
  }
  private func present() {
    guard let p = win, HatchCore.mayShow(protectedFront: Protected.front) else { return }
    p.ignoresMouseEvents = false   // the scene covers the screen: a click skips it, it never reaches an app it hides
    p.orderFrontRegardless()
  }

  private func call(_ fn: String, _ arg: Any? = nil) {
    var a = ""
    if let arg, let d = try? JSONSerialization.data(withJSONObject: arg, options: [.fragmentsAllowed]), let j = String(data: d, encoding: .utf8) { a = j }
    let js = "window.__cake&&window.__cake.\(fn)(\(a))"
    if ready { web?.evaluateJavaScript(js, completionHandler: nil) } else { waiting.append(js) }
  }

  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let s = message.body as? String, let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any], let t = o["type"] as? String else { return }
    switch t {
    case "ready":
      ready = true
      for js in waiting { web?.evaluateJavaScript(js, completionHandler: nil) }
      waiting = []
    case "built": if playing, case .boot = kind { built() }
    case "exit": if playing { exiting() }
    case "done": if playing { end() }
    case "click": skip()
    case "error": psLog("PS cake: the page stopped (\(String(describing: o["why"] ?? "").prefix(120)))"); end()
    default: break
    }
  }
  func webView(_ webView: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(a.request.url?.isFileURL == true ? .allow : .cancel)
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { psLog("PS cake: page process ended"); end() }

  // MARK: Esc (the window never takes the keyboard: it listens, as Hatch and the big island do)

  private func startEsc() {
    guard monitors.isEmpty, !Protected.front else { return }
    if let l = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if e.keyCode == 53, self?.playing == true { self?.skip() }
      return e   // never swallowed (EscAlways.swift)
    }) { monitors.append(l) }
    if let g = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if e.keyCode == 53 { DispatchQueue.main.async { if self?.playing == true && !Protected.front { self?.skip() } } }
    }) { monitors.append(g) }
  }
  private func stopEsc() { monitors.forEach { NSEvent.removeMonitor($0) }; monitors = [] }
}
