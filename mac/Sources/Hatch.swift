import AppKit
import WebKit

// PS 1.67 "Hatch": the update scene and the start scene (the rules: HatchCore.swift; the drawing: ui/hatch.html).
// One see-through window over the island's screen, above the island, that never becomes key, never activates PS and
// never shows while 1Password or Signal is in front. Everything that moves runs in WebKit's own process (transform and
// opacity only), so PS's main thread only passes a few short messages.
//
// The update, split across the relaunch:
//  - Update now (Updater.fromPage "macUpdate:start", or the pop-up's Install): updateStarted. The island leaves and the
//    icon builds with the real progress (Updater.pageSet feeds updaterStep). Waiting for "Relaunch to finish" the icon
//    rests, then tucks away (the island comes back) until the click. Esc while it downloads tucks it away too.
//  - The swap (Updater.swapIn): relaunching writes hatch.json (how far the icon got), then the old build quits.
//  - The new build (Updater.afterLaunch): afterUpdate. It holds the island off at once, takes the island queue's turn
//    (so What's new waits for it), picks the icon up where the old build stopped, finishes it and plays the rest.
//    A web only update (no relaunch) does the same in the same run.
// The start scene (atLaunch): every start of PS, unless switched off in Settings or this start follows an update.
// Esc: the start scene skips on Esc or a click. The update scene does NOT (the developer, 18 Nov 2026: the update animation must be
// watched; his own exception to "Esc always exits", HatchCore.skippable): its window lets every click through and never
// takes the keyboard, so nothing outside it is blocked, and it ends by itself within HatchCore.maxSeconds.
// The island in the scene is PS's REAL island (Island.hatchExit, hatchBorn): its own shape, looks, tick side and task. It
// pinches into a dot before the page carries a dot down, and at the end it grows out of the blob and its row fades in.
final class HatchPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class Hatch: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = Hatch()
  private let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil

  private var win: HatchPanel?
  private var web: WKWebView?
  private var ready = false
  private var waiting: [String] = []
  private var monitors: [Any] = []

  enum Phase: String { case idle, building, resting, tucked, waiting, finishing }
  private(set) var phase = Phase.idle
  private(set) var mode: HatchMode?
  /// How much of the icon is on screen (or was, when tucked away).
  private var built = 0.0
  /// Esc while it downloaded: no more of the build part for this download (the rest after the relaunch still plays).
  private var dismissed = false
  /// Tucked away because 1Password or Signal came to the front: it comes back when they go.
  private var hiddenForProtected = false
  private var restWork: DispatchWorkItem?
  private var safety: DispatchWorkItem?
  private var waitSince: Date?
  private var waitTimer: Timer?
  /// The update scene is due or playing: What's new waits for it (main.swift whatsNewFromIsland) and the island's own
  /// short "Updated to" moment stays away (the scene says it).
  private(set) var holding = false
  /// The page said the island has settled: the real one is back.
  private var islandBack = true
  /// PS 1.69: Settings, "Replay the update animation": the update scene with made up progress. Nothing is downloaded or
  /// installed, What's new does not follow, and Esc skips it.
  private(set) var replaying = false
  private var replayTimer: Timer?
  static let queueId = "hatch"

  // MARK: the switch and the sounds

  var launchOn: Bool {
    get { HatchCore.launchOn(UserDefaults.standard.object(forKey: HatchCore.launchKey)) }
    set { UserDefaults.standard.set(newValue, forKey: HatchCore.launchKey) }
  }
  /// The page's island state ({type:"island"}): its sound switch, kept for the next start (the page is not loaded then).
  func islandState(_ st: [String: Any]) {
    let d = UserDefaults.standard
    let on = (st["sounds"] as? Bool) != false
    if d.object(forKey: HatchCore.soundsKey) as? Bool != on { d.set(on, forKey: HatchCore.soundsKey) }
  }
  private func play(_ name: String) {
    let islandSounds = (UserDefaults.standard.object(forKey: HatchCore.soundsKey) as? Bool) != false
    guard !test, HatchCore.sounds(islandSounds: islandSounds, dndMutes: DND.shared.mutes("sounds"), privateOn: PrivateHold.shared.on) else { return }
    Sfx.shared.play(name, volume: HatchCore.volume)
  }

  // MARK: 1. before the relaunch

  /// Update now was clicked.
  func updateStarted() {
    guard !test, mode == nil || phase == .tucked else { return }
    mode = .update; dismissed = false; built = 0.04
    phase = .building
    if !HatchCore.mayShow(protectedFront: Protected.front) { phase = .tucked; hiddenForProtected = true; return }   // starts when they leave
    showBuild()
  }
  private func showBuild() {
    guard let sc = screenNow() else { return }
    ensure(sc)
    phase = .building
    hiddenForProtected = false
    let o = opts(sc, mode: .update, extra: ["built": built])   // where the island is, before it pinches away
    holdIsland()
    call("build", o)
    present()
  }

  // MARK: the replay (PS 1.69)

  /// Settings > About and updates > Replay the update animation. The whole update scene again: the island leaves, the icon
  /// builds with made up progress, then it cracks, falls and hatches the island, and the number reads 'Updated to'. No
  /// restart, no download, no What's new. Never while another scene is on screen, or over 1Password or Signal.
  func replay() {
    guard !test, mode == nil, Cake.shared.kind == nil, !Updater.shared.busy, HatchCore.mayShow(protectedFront: Protected.front) else { psLog("PS hatch: replay not started"); return }
    psLog("PS hatch: replay")
    replaying = true
    mode = .update; dismissed = false; built = HatchCore.replayBuilt(elapsed: 0)
    phase = .building
    showBuild()
    startEsc()
    let t0 = Date()
    replayTimer?.invalidate()
    replayTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { [weak self] tm in
      guard let self, self.replaying, self.phase == .building else { tm.invalidate(); return }
      let e = Date().timeIntervalSince(t0)
      self.built = HatchCore.replayBuilt(elapsed: e)
      self.call("progress", self.built)
      if e >= HatchCore.replaySeconds { tm.invalidate(); self.replayTimer = nil; self.replayFinish() }
    }
  }
  /// The made up download is done: the same hand over a real update makes after the relaunch (the icon is already up).
  private func replayFinish() {
    guard replaying, mode == .update else { return }
    take()
  }

  /// Every state the updater gives the gear menu (Updater.pageSet).
  func updaterStep(_ state: String, frac: Double?) {
    guard mode == .update, !replaying, phase == .building || phase == .resting || phase == .tucked else { return }
    switch HatchCore.step(state, frac: frac) {
    case .build(let f):
      built = f
      restWork?.cancel(); restWork = nil
      if phase == .tucked {
        // Back for Relaunch to finish (and the install around it), even after an Esc during the download.
        if state == "relaunching" || state == "installing" && !dismissed, HatchCore.mayShow(protectedFront: Protected.front) { showBuild() }
      } else {
        phase = .building
        call("progress", f)
      }
    case .rest(let f):
      built = f
      guard phase != .tucked else { return }
      phase = .resting
      call("progress", f)
      let w = DispatchWorkItem { [weak self] in if self?.phase == .resting { self?.tuck() } }
      restWork = w
      DispatchQueue.main.asyncAfter(deadline: .now() + HatchCore.restSeconds, execute: w)
    case .end:
      if phase == .tucked { reset() } else { tuck(thenEnd: true) }
    case .none: break
    }
  }
  private var endAfterTuck = false
  private func tuck(thenEnd: Bool = false) {
    endAfterTuck = endAfterTuck || thenEnd
    guard win?.isVisible == true, ready else { phase = .tucked; if endAfterTuck { reset() }; releaseIsland(); return }
    call("tuck")
    // A page that never answers must not keep the island away.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in if self?.phase == .resting || self?.phase == .building { self?.tucked() } }
  }
  private func tucked() {
    hideWindow()
    releaseIsland()
    phase = .tucked
    if endAfterTuck { reset() }
  }

  /// The app was swapped in: the new build starts in a moment. How far the icon got goes with it.
  func relaunching(to build: Int, version: String?) {
    let v = HatchCore.versionText(version ?? PSVersion.name)
    let c = HatchCarry(to: build, version: v, built: mode == .update ? built : 0, at: Date().timeIntervalSince1970)
    if let d = HatchCore.encode(c) { try? d.write(to: Hatch.carryURL, options: .atomic) }
  }
  static var carryURL: URL { UpdatePaths.work.appendingPathComponent(HatchCore.carryName) }

  // MARK: 2 to 4. after the update, and the start scene

  /// The new version is running (after the relaunch, or a web only update in this same run). True when the scene plays.
  @discardableResult func afterUpdate(sameRun: Bool) -> Bool {
    guard !test else { return false }
    let name = PSVersion.name
    guard HatchCore.playUpdate(played: UserDefaults.standard.string(forKey: HatchCore.playedKey), version: name) else { return false }
    UserDefaults.standard.set(name, forKey: HatchCore.playedKey)   // marked before it plays: never twice, even after a crash
    if !sameRun {
      let carry = HatchCore.decode(try? Data(contentsOf: Hatch.carryURL))
      built = HatchCore.resume(carry, mine: PSVersion.mine, now: Date().timeIntervalSince1970)
      try? FileManager.default.removeItem(at: Hatch.carryURL)
    }
    mode = .update
    holding = true
    take()
    return true
  }
  /// Every start of PS. PS Cake: no longer called; the Cake boot animation (Cake.swift) took the start scene's place and its
  /// Settings switch (hatch.launch). Kept so the launch mode and its tests stay whole.
  func atLaunch() {
    guard mode == nil, HatchCore.playLaunch(on: launchOn, afterUpdate: holding, test: test, install: INSTALL_MODE) else { return }
    mode = .launch
    built = 0
    take()
  }
  /// Holds the island off and takes the island queue's turn, so no card or What's new comes out in the middle.
  private func take() {
    restWork?.cancel(); restWork = nil
    holdIsland()
    if phase != .building && phase != .resting { phase = .waiting }   // before the queue: its answer may start the scene at once
    let o = IslandQueue.shared.enqueue(id: Hatch.queueId, kind: "hatch", priority: .high, ttl: nil,
                                       show: { [weak self] in self?.whenClear() }, visible: { [weak self] in self?.mode != nil },
                                       dropped: { [weak self] in self?.reset() })
    if case .showNow = o { whenClear() }
  }
  /// Never over 1Password or Signal: waits until they are not in front (a start scene not for long).
  private func whenClear() {
    guard let m = mode else { return }
    if HatchCore.mayShow(protectedFront: Protected.front) { startFinish(); return }
    if waitSince == nil { waitSince = Date() }
    waitTimer?.invalidate()
    waitTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      guard let self, let since = self.waitSince else { return }
      if HatchCore.giveUp(m, waited: Date().timeIntervalSince(since)) { psLog("PS hatch: 1Password or Signal stayed in front, the \(m.rawValue) scene is skipped"); self.reset() }
    }
    phase = .waiting
  }
  private func startFinish() {
    waitTimer?.invalidate(); waitTimer = nil; waitSince = nil
    guard let m = mode, let sc = screenNow() else { reset(); return }
    ensure(sc)
    phase = .finishing
    var extra: [String: Any] = ["built": built]
    if m == .update { extra["ver"] = HatchCore.versionText(PSVersion.name) }
    call("finish", opts(sc, mode: m, extra: extra))
    present()
    if HatchCore.skippable(m, replay: replaying) { startEsc() }
    // A page that never says it is done must not leave a stuck scene (the update scene is about 11 s, the start one 3 s).
    safety?.cancel()
    let w = DispatchWorkItem { [weak self] in if self?.phase == .finishing { psLog("PS hatch: the scene reached its longest, ended"); self?.end() } }
    safety = w
    DispatchQueue.main.asyncAfter(deadline: .now() + HatchCore.maxSeconds(m), execute: w)
    psLog("PS hatch: \(m.rawValue) scene (from \(Int(built * 100)) %)")
  }

  // MARK: Esc, a click, 1Password and Signal

  /// Esc or a click: skips the start scene. The update scene is watched to the end (the developer, 18 Nov 2026), so nothing happens.
  func skip() {
    guard let m = mode, HatchCore.skippable(m, replay: replaying) else { return }
    switch phase {
    case .finishing:
      call("skip")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in if self?.phase == .finishing { self?.end() } }
    case .building, .resting:
      if replaying { replayTimer?.invalidate(); replayTimer = nil; dismissed = true; tuck(thenEnd: true); return }   // a replay ends whole
      dismissed = true; tuck()
    case .waiting:
      end()
    case .idle, .tucked: break
    }
  }
  /// 1Password or Signal came to the front or went (main.swift Protected.onChange).
  func protectedChanged() {
    if Protected.front {
      stopEsc()
      switch phase {
      case .finishing: end()                                   // never over them: straight on to the end
      case .building, .resting: hideWindow(); releaseIsland(); phase = .tucked; hiddenForProtected = true
      default: break
      }
    } else {
      if phase == .waiting, mode != nil, IslandQueue.shared.isActive(Hatch.queueId) { whenClear() }
      else if phase == .tucked, mode == .update, hiddenForProtected, !dismissed { showBuild() }
    }
  }

  // MARK: the end

  /// The scene is over (done, skipped, given up): the island back, the window gone, the queue moves on (What's new).
  private func end() {
    psLog("PS hatch: \(mode?.rawValue ?? "") scene over")
    reset()
  }
  private func reset() {
    restWork?.cancel(); restWork = nil
    safety?.cancel(); safety = nil
    waitTimer?.invalidate(); waitTimer = nil; waitSince = nil
    replayTimer?.invalidate(); replayTimer = nil
    stopEsc()
    hideWindow()
    releaseIsland()
    let had = mode != nil
    replaying = false
    mode = nil; phase = .idle; holding = false; endAfterTuck = false; dismissed = false; hiddenForProtected = false
    if had { IslandQueue.shared.finish(Hatch.queueId) }
    // The window and its page go too (the scene is rare, its memory is not kept), on the next turn: this may run inside
    // one of the page's own messages.
    let w = win, v = web
    win = nil; web = nil; ready = false; waiting = []
    DispatchQueue.main.async {
      v?.configuration.userContentController.removeScriptMessageHandler(forName: "hatch"); v?.navigationDelegate = nil
      w?.orderOut(nil); w?.contentView = nil
    }
  }

  // MARK: the island

  /// The real island pinches into a dot and is held off (at once when it is not on screen).
  private func holdIsland() { islandBack = false; Island.shared.hatchExit() }
  /// The blob reached the island's place: the real island is born out of it. After a relaunch the page may not have told the
  /// island what to show yet: it waits for that a moment (at most 1.5 s), the blob hovering meanwhile.
  private func born(blob: Double, tries: Int = 0) {
    guard phase == .finishing else { return }
    // Just after a relaunch (update or start) the page has not told the island what to show yet: it waits for that a moment.
    if Island.shared.pageStates == 0, tries < 15 {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in self?.born(blob: blob, tries: tries + 1) }
      return
    }
    islandBack = true
    let real = Island.shared.hatchBorn(blob: CGFloat(max(8, min(80, blob))))
    var a: [String: Any] = ["real": real]
    if real, let sc = screenNow(), let r = HatchCore.pageRect(Island.shared.shapeOnScreen(), screen: sc.frame) { a["target"] = r }
    call("arrived", a)
  }
  private func releaseIsland() { guard !islandBack else { return }; islandBack = true; Island.shared.hatchHold(false) }

  // MARK: the window

  /// The island's screen (the scene gives birth to it there), else the main screen.
  private func screenNow() -> NSScreen? { IslandGeo.read().1 ?? NSScreen.main ?? NSScreen.screens.first }
  private func opts(_ sc: NSScreen, mode m: HatchMode, extra: [String: Any]) -> [String: Any] {
    var o: [String: Any] = ["mode": m.rawValue, "reduce": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
                            "words": ["updated": "Updated to"]]
    let isl = HatchCore.pageRect(Island.shared.shapeOnScreen(), screen: sc.frame)
    o["isl"] = isl ?? NSNull()
    o["target"] = targetNow(sc)
    for (k, v) in extra { o[k] = v }
    return o
  }
  /// Where the blob flies, as of now. PS 1.69 (the developer, 18 Nov 2026: it flew to the top under the notch although his island was
  /// moved): the real island on screen, else where it will rest, else the kept spot (a relaunch: the page has not told the
  /// island what to show yet, so it has no rest place, and this used to fall through to the top), else the top centre.
  private func targetNow(_ sc: NSScreen) -> [String: Double] {
    HatchCore.aim(shown: HatchCore.pageRect(Island.shared.shapeOnScreen(), screen: sc.frame),
                  rest: HatchCore.pageRect(Island.shared.restShape(), screen: sc.frame),
                  spot: HatchCore.pageRect(Island.shared.startShape(), screen: sc.frame),   // PS 1.74: also before the island has a window
                  fallback: fallbackTarget(sc))
  }
  /// Where the island will be when it is not on screen yet (a start: the page has not sent it anything): around the
  /// camera notch, or a pill just below the top centre.
  private func fallbackTarget(_ sc: NSScreen) -> [String: Double] {
    let w = Double(sc.frame.width), notch = Double(sc.safeAreaInsets.top)
    return notch > 0 ? ["x": w / 2 - 100, "y": 0, "w": 200, "h": notch] : ["x": w / 2 - 135, "y": 6, "w": 270, "h": 30]
  }
  private func ensure(_ sc: NSScreen) {
    if let w = win { if w.frame != sc.frame { w.setFrame(sc.frame, display: false) }; return }
    let p = HatchPanel(contentRect: sc.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)   // just above the island
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = IslandPlace.spaces
    p.ignoresMouseEvents = true
    p.setAccessibilityLabel("Update animation")
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.preferences.isFraudulentWebsiteWarningEnabled = false
    c.userContentController.add(self, name: "hatch")
    let v = ClickThroughWebView(frame: NSRect(origin: .zero, size: sc.frame.size), configuration: c)
    v.setValue(false, forKey: "drawsBackground")
    v.navigationDelegate = self
    v.autoresizingMask = [.width, .height]
    p.contentView = v
    p.setFrame(sc.frame, display: false)
    win = p; web = v; ready = false
    let res = Bundle.main.resourceURL!
    v.loadFileURL(res.appendingPathComponent("hatch.html"), allowingReadAccessTo: res)
  }
  private func present() {
    guard let p = win, HatchCore.mayShow(protectedFront: Protected.front) else { return }
    // Clicks pass through to whatever is under it, always for the update scene (it is watched, and must never block the
    // mouse), the replay too (Esc skips that one); only the start scene takes a click, as its skip.
    p.ignoresMouseEvents = !(phase == .finishing && mode == .launch)
    p.orderFrontRegardless()
  }
  private func hideWindow() { stopEsc(); win?.orderOut(nil) }

  /// Calls window.__hatch.<fn>(arg) once the page is ready (queued before that).
  private func call(_ fn: String, _ arg: Any? = nil) {
    var a = ""
    if let arg, let d = try? JSONSerialization.data(withJSONObject: arg, options: [.fragmentsAllowed]), let j = String(data: d, encoding: .utf8) { a = j }
    let js = "window.__hatch&&window.__hatch.\(fn)(\(a))"
    if ready { web?.evaluateJavaScript(js, completionHandler: nil) } else { waiting.append(js) }
  }

  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let s = message.body as? String, let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any], let t = o["type"] as? String else { return }
    switch t {
    case "ready":
      ready = true
      for js in waiting { web?.evaluateJavaScript(js, completionHandler: nil) }
      waiting = []
    case "cover": holdIsland()                       // the real island is (being) taken away
    case "aim":                                      // the blob is about to fly: where is the island now? (the page may have told it since)
      if phase == .finishing, let sc = screenNow() { call("aimed", ["target": targetNow(sc)]) } else { call("aimed", [:]) }
    case "arrive": born(blob: (o["blob"] as? Double) ?? 24)   // the blob is at the island's place
    case "tucked": tucked()
    case "done": if phase == .finishing { end() }
    case "error": psLog("PS hatch: the page stopped (\(String(describing: o["why"] ?? "").prefix(120)))"); end()
    case "click": if phase == .finishing { skip() }  // the start scene only (skip says no to the update scene)
    case "sfx": if let n = HatchCore.sound(o["name"]) { play(n) }
    default: break
    }
  }
  // The page is local; it may never navigate anywhere else.
  func webView(_ webView: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(a.request.url?.isFileURL == true ? .allow : .cancel)
  }
  /// WebKit's page process went away: the scene ends rather than sticking.
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { psLog("PS hatch: page process ended"); end() }

  // MARK: Esc (the window never takes the keyboard: it listens, as the big island does)

  private func startEsc() {
    guard monitors.isEmpty, !Protected.front else { return }
    if let l = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if e.keyCode == 53, self?.escapable == true { self?.skip() }
      return e   // never swallowed: the same Esc still backs out of the Tab list (EscAlways.swift)
    }) { monitors.append(l) }
    if let g = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if e.keyCode == 53 { DispatchQueue.main.async { if self?.escapable == true && !Protected.front { self?.skip() } } }
    }) { monitors.append(g) }
  }
  private var escapable: Bool { (phase == .finishing || phase == .building || phase == .resting) && win?.isVisible == true }
  private func stopEsc() { monitors.forEach { NSEvent.removeMonitor($0) }; monitors = [] }
}
