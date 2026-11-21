// "Are you sure" mode (the developer, 24 Oct 2026). When YouTube or Netflix (PS > Settings, his list) comes
// to the front in a browser, a card in the middle of the screen asks "Are you sure?" with a 10
// second countdown. Leaving the site during it cancels it quietly. When it runs out, "Continue"
// lets him in. Typing his phrase ("I am sure, I swear on PS") lets him in at once. Either way he
// gets a 30 minute pass, then it asks again even if he is still watching. A forced pause, not a block.
//
// How it knows: only the title of the front browser window, read through Accessibility (which PS
// already has), and only while a browser is in front: when the app in front changes, and every
// couple of seconds while a browser stays there. The title is matched and dropped at once: never
// kept, logged or sent anywhere. Nothing is read while 1Password or Signal is in front (golden
// rule), and the card never shows over them.
// Never in a meeting: while a calendar meeting with attendees or a Meet link is on (the main
// window tells PS), while the microphone is in use (a call in Zoom, Meet, Teams or FaceTime),
// or while a meeting app or a Meet tab is in front, the mode is off and an open card closes.
// The card takes the keyboard only for its phrase box while it is up, and hands it back after.
// Everything runs on its own queue; only the card itself is drawn on the main thread.
import AppKit
import ApplicationServices
import WebKit

final class AysPanel: NSPanel {
  var keyable = false
  override var canBecomeKey: Bool { keyable }
  override var canBecomeMain: Bool { false }
}

final class AreYouSure: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = AreYouSure()

  /// Settings changed or a count went up: PS > Settings redraws.
  var onSettings: (() -> Void)?

  // ---------- settings (this Mac only) ----------
  struct Prefs: Codable {
    var on = true
    var sites = ["YouTube", "Netflix"]
    var countdown = 10          // seconds
    var pass = 30               // minutes
    var phrase = "I am sure, I swear on PS"
    /// The card's button words, set in Settings (the developer, 10 Nov 2026). nil = the default; {site} is the site's name.
    var button: String? = nil
  }
  static let defaultButton = "Continue to {site}"
  /// The developer's phrase is his own; everyone else sees and types this one (the developer, 10 Nov 2026).
  static let publicPhrase = "Yes, I am absolutely sure"
  static func shownPhrase(_ p: String) -> String { (!Owner.red && p == Prefs().phrase) ? publicPhrase : p }
  struct Counts: Codable { var day = ""; var prompts = 0; var passes = 0 }
  private(set) var prefs = Prefs()
  private var counts = Counts()
  private var passUntil: Date?
  private var testDir: String?
  private let q = DispatchQueue(label: "PS are you sure", qos: .utility)
  private var timer: DispatchSourceTimer?

  // ---------- what it looks at (a self test swaps these for fakes; never the developer's real windows) ----------
  var frontNow: () -> (id: String?, pid: pid_t) = {
    let a = NSWorkspace.shared.frontmostApplication
    return (a?.bundleIdentifier, a?.processIdentifier ?? 0)
  }
  var titleNow: (pid_t) -> String? = { AreYouSure.focusedTitle($0) }
  var micNow: () -> Bool = { Mic.inUse }   // the audio queue's last known state (AudioQueue.swift), never waits
  var clock: () -> Date = { Date() }
  /// A calendar meeting is on right now (from the main window). Read and written on q.
  private var meeting = false

  // ---------- the card's state (on q) ----------
  private var cardStart: Date?        // the card is up since then
  private var site = ""
  private var returnTo: pid_t = 0     // the browser to hand the keyboard back to

  static let browsers = ["com.brave.Browser", "com.google.Chrome", "com.apple.Safari", "org.mozilla.firefox", "com.duckduckgo.macos.browser",
                         "company.thebrowser.Browser", "com.microsoft.edgemac", "com.operasoftware.Opera", "com.vivaldi.Vivaldi"]
  static let browserNames = ["brave", "google chrome", "chrome", "safari", "safari technology preview", "firefox", "mozilla firefox",
                             "duckduckgo", "arc", "microsoft edge", "edge", "opera", "vivaldi"]
  static let meetingApps = ["us.zoom.xos", "com.microsoft.teams", "com.microsoft.teams2", "com.apple.FaceTime", "com.cisco.webexmeetingsapp", "com.webex.meetingmanager"]
  static func isBrowser(_ id: String?) -> Bool { guard let id else { return false }; return browsers.contains { id == $0 || id.hasPrefix($0 + ".") } }

  // ---------- matching (the title is never kept) ----------
  private static let separators = [" - ", " | ", " / ", " \u{2014} ", " \u{2013} ", " \u{00B7} "]
  static func segments(_ title: String) -> [String] {
    var parts = [title]
    for s in separators { parts = parts.flatMap { $0.components(separatedBy: s) } }
    return parts.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
  }
  /// The site this title belongs to, or nil. A site counts only when its name is a whole part of
  /// the title with nothing after it but the browser's own name ("Video - YouTube - Brave"), so a
  /// search for "youtube" on Google never counts.
  static func site(in title: String?, sites: [String]) -> String? {
    guard let title, !title.isEmpty else { return nil }
    var segs = segments(title)
    if let first = segs.first, let r = first.range(of: #"^\(\d+\+?\)\s*"#, options: .regularExpression) { segs[0] = String(first[r.upperBound...]) }   // "(3) Video"
    for (i, s) in segs.enumerated() {
      guard let hit = sites.first(where: { $0.caseInsensitiveCompare(s) == .orderedSame || siteName($0).caseInsensitiveCompare(s) == .orderedSame }) else { continue }
      let rest = segs[(i + 1)...]
      if rest.isEmpty || browserNames.contains(rest.first!.lowercased()) { return hit }
    }
    return nil
  }
  /// A site typed as a domain ("youtube.com", "https://www.x.com/home") counts by its name ("youtube", "x"),
  /// because PS only sees the tab title, never the address (the developer, 10 Nov 2026: type in domain names).
  static func siteName(_ site: String) -> String {
    var t = site.lowercased().trimmingCharacters(in: .whitespaces)
    if let r = t.range(of: "://") { t = String(t[r.upperBound...]) }
    if let i = t.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) { t = String(t[..<i]) }
    var parts = t.split(separator: ".").map(String.init)
    guard parts.count >= 2 else { return site }
    while parts.count > 2, ["www", "m", "mobile", "web"].contains(parts[0]) { parts.removeFirst() }
    if parts[0] == "www" { parts.removeFirst() }
    return parts.first ?? site
  }
  /// A Google Meet call in the front tab.
  static func isMeetTab(_ title: String?) -> Bool {
    guard let t = title?.lowercased() else { return false }
    return t.hasPrefix("meet - ") || t.hasPrefix("meet: ") || t.contains("google meet")
  }
  /// What he types, compared without case, extra spaces or the punctuation at the end.
  static func norm(_ s: String) -> String {
    var t = s.lowercased().replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
    while let c = t.last, ".!?,;:".contains(c) || c == " " { t.removeLast() }
    return t
  }

  // ---------- reading the title and the microphone (off the main thread) ----------
  static func focusedTitle(_ pid: pid_t) -> String? {
    guard pid > 0 else { return nil }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.5)
    var win: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &win) == .success, let w = win else { return nil }
    var t: CFTypeRef?
    guard AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &t) == .success else { return nil }
    return t as? String
  }
  // ---------- start ----------
  func start(testDir: String? = nil) {
    self.testDir = testDir
    if testDir == nil {
      if let d = UserDefaults.standard.data(forKey: "ays.prefs"), let p = try? JSONDecoder().decode(Prefs.self, from: d) { prefs = p }
      if let d = UserDefaults.standard.data(forKey: "ays.counts"), let c = try? JSONDecoder().decode(Counts.self, from: d) { counts = c }
      passUntil = UserDefaults.standard.object(forKey: "ays.passUntil") as? Date
    } else {
      // A test copy never looks at the developer's windows or microphone: the self test hands it fakes.
      prefs.on = false
      frontNow = { (nil, 0) }; titleNow = { _ in nil }; micNow = { false }
    }
    publish()
    let ws = NSWorkspace.shared.notificationCenter
    ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] _ in self?.q.async { self?.check() } }
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + 2, repeating: 1, leeway: .milliseconds(250))
    t.setEventHandler { [weak self] in self?.tick() }
    t.resume()
    timer = t
  }

  private var lastPoll = Date.distantPast
  /// Every second: the countdown while the card is up (and a look at the site); otherwise a look
  /// every two seconds, only while a browser is in front.
  private func tick() {
    guard prefs.on || cardStart != nil else { return }
    if cardStart != nil { check(); sendCard(); return }
    let now = Date()
    if now.timeIntervalSince(lastPoll) < 1.9 { return }
    lastPoll = now
    if AreYouSure.isBrowser(frontNow().id) { check() }
  }

  /// The one decision, on q. Leaves no trace of what the title said.
  private func check() {
    guard prefs.on else { if cardStart != nil { close(pass: false) }; return }
    let front = frontNow()
    // Golden rule: nothing is read while 1Password or Signal is in front, and the card goes.
    if Protected.matches(front.id) { if cardStart != nil { close(pass: false) }; return }
    if meeting || micNow() || AreYouSure.meetingApps.contains(front.id ?? "") { if cardStart != nil { close(pass: false) }; return }
    guard AreYouSure.isBrowser(front.id) else { if cardStart != nil { close(pass: false) }; return }   // left the site: cancelled
    let title = titleNow(front.pid)
    if AreYouSure.isMeetTab(title) { if cardStart != nil { close(pass: false) }; return }
    let hit = AreYouSure.site(in: title, sites: prefs.sites)
    guard let hit else { if cardStart != nil { close(pass: false) }; return }          // another tab: cancelled
    if cardStart != nil { return }
    if let p = passUntil, p > clock() { return }                                         // a pass is running
    open(site: hit, pid: front.pid)
  }

  private func today() -> String {
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.locale = Locale(identifier: "en_US_POSIX")
    return f.string(from: clock())
  }
  private func bump(prompt: Bool) {
    let d = today()
    if counts.day != d { counts = Counts(day: d) }
    if prompt { counts.prompts += 1 } else { counts.passes += 1 }
    if testDir == nil, let data = try? JSONEncoder().encode(counts) { UserDefaults.standard.set(data, forKey: "ays.counts") }
    publish()
    DispatchQueue.main.async { self.onSettings?() }
  }

  private func open(site: String, pid: pid_t) {
    cardStart = clock(); self.site = site; returnTo = pid
    bump(prompt: true)
    psLog("PS are you sure: card")
    sendCard()
    DispatchQueue.main.async { self.present() }
  }
  /// pass: he chose to go in (Continue or the phrase).
  private func close(pass: Bool) {
    guard cardStart != nil else { return }
    cardStart = nil
    if pass {
      passUntil = clock().addingTimeInterval(TimeInterval(prefs.pass * 60))
      if testDir == nil { UserDefaults.standard.set(passUntil, forKey: "ays.passUntil") }
      bump(prompt: false)   // publishes too
    }
    let back = pass ? returnTo : 0
    DispatchQueue.main.async { self.dismiss(handBackTo: back) }
  }

  /// Seconds left in the countdown (0: Continue is there).
  private func left() -> Int {
    guard let s = cardStart else { return 0 }
    return max(0, prefs.countdown - Int(clock().timeIntervalSince(s)))
  }
  private func sendCard() {
    let st: [String: Any] = ["site": site, "left": left(), "total": prefs.countdown, "pass": prefs.pass, "phrase": AreYouSure.shownPhrase(prefs.phrase), "button": prefs.button ?? AreYouSure.defaultButton]
    guard let d = try? JSONSerialization.data(withJSONObject: st), let s = String(data: d, encoding: .utf8) else { return }
    DispatchQueue.main.async { [self] in if ready { web?.evaluateJavaScript("window.__ays.set(\(s))", completionHandler: nil) } else { queued = s } }
  }

  // ---------- from PS > Settings and the main window ----------
  func handle(_ msg: [String: Any]) {
    q.async { [self] in
      var p = prefs
      if let b = msg["on"] as? Bool { p.on = b }
      if let s = msg["sites"] as? [String] {
        var seen = Set<String>()
        p.sites = s.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty && $0.count <= 40 && seen.insert($0.lowercased()).inserted }.prefix(20).map { String($0) }
      }
      if let c = msg["countdown"] as? Int, [5, 10, 15, 20, 30, 60].contains(c) { p.countdown = c }
      if let m = msg["pass"] as? Int, [10, 15, 20, 30, 45, 60, 90, 120].contains(m) { p.pass = m }
      if let ph = msg["phrase"] as? String {
        let t = ph.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.count >= 3 && t.count <= 80 { p.phrase = t }
      }
      if let b = msg["button"] as? String {
        let t = b.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.count <= 40 { p.button = (t.isEmpty || t == AreYouSure.defaultButton) ? nil : t }
      }
      prefs = p
      if testDir == nil, let d = try? JSONEncoder().encode(p) { UserDefaults.standard.set(d, forKey: "ays.prefs") }
      publish()
      check()
      if cardStart != nil { sendCard() }
      DispatchQueue.main.async { self.onSettings?() }
    }
  }
  /// A calendar meeting with attendees or a Meet link started or ended (the main window says so).
  func setMeeting(_ on: Bool) { q.async { [self] in if meeting != on { meeting = on; check() } } }

  // What PS > Settings shows, kept ready so the main thread never waits on the queue (a title read can take a moment).
  private let shownLock = NSLock()
  private var shown: (prefs: Prefs, counts: Counts, pass: Date?) = (Prefs(), Counts(), nil)
  private func publish() { shownLock.lock(); shown = (prefs, counts, passUntil); shownLock.unlock() }
  func settingsJSON() -> [String: Any] {
    shownLock.lock(); let s = shown; shownLock.unlock()
    let d = today()
    let c = s.counts.day == d ? s.counts : Counts(day: d)
    return ["on": s.prefs.on, "sites": s.prefs.sites, "countdown": s.prefs.countdown, "pass": s.prefs.pass, "phrase": AreYouSure.shownPhrase(s.prefs.phrase), "button": s.prefs.button ?? AreYouSure.defaultButton,
            "today": ["prompts": c.prompts, "passes": c.passes],
            "passLeft": s.pass.map { max(0, Int(ceil($0.timeIntervalSince(clock()) / 60))) } ?? 0]
  }

  // ---------- the card (main thread) ----------
  private var panel: AysPanel?
  private var dim: NSPanel?
  private var web: WKWebView?
  private var ready = false
  private var queued: String?
  static let size = NSSize(width: 480, height: 330)

  private func setUp() {
    guard panel == nil else { return }
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.userContentController.add(self, name: "ays")
    // The first click counts (a plain WKWebView dropped it). The countdown gate on Continue and the phrase rules stay in the page.
    let w = ClickThroughWebView(frame: NSRect(origin: .zero, size: AreYouSure.size), configuration: c)
    w.setValue(false, forKey: "drawsBackground")
    w.navigationDelegate = self
    let p = AysPanel(contentRect: NSRect(origin: .zero, size: AreYouSure.size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.contentView = w
    // The soft dim behind it: never catches a click, so leaving the site stays one click away.
    let d = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    d.isOpaque = false; d.backgroundColor = NSColor(calibratedWhite: 0, alpha: 0.38); d.hasShadow = false
    d.level = .statusBar; d.ignoresMouseEvents = true; d.hidesOnDeactivate = false; d.isReleasedWhenClosed = false
    d.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    if testDir != nil { p.alphaValue = 0; p.ignoresMouseEvents = true; d.alphaValue = 0 }
    panel = p; dim = d; web = w
    w.loadHTMLString(AreYouSure.page, baseURL: nil)
  }
  private var screen: NSScreen { NSScreen.main ?? NSScreen.screens.first! }

  private func present() {
    setUp()
    guard let panel, let dim else { return }
    let sf = screen.frame
    let to = NSRect(x: sf.midX - AreYouSure.size.width / 2, y: sf.midY - AreYouSure.size.height / 2 + 40, width: AreYouSure.size.width, height: AreYouSure.size.height)
    dim.setFrame(sf, display: false)
    web?.evaluateJavaScript("window.__ays && window.__ays.enter()", completionHandler: nil)
    if testDir != nil {
      dim.orderFrontRegardless(); panel.setFrame(to, display: true); panel.orderFrontRegardless()
      return
    }
    panel.setFrame(to.offsetBy(dx: 0, dy: -24), display: false)
    panel.alphaValue = 0; dim.alphaValue = 0
    dim.orderFrontRegardless(); panel.orderFrontRegardless()
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0.5
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
      panel.animator().setFrame(to, display: true)
      panel.animator().alphaValue = 1
      dim.animator().alphaValue = 1
    }
    // The keyboard, for the phrase box only (never over 1Password or Signal: the card is not up then).
    if !Protected.front { panel.keyable = true; panel.makeKey(); web?.evaluateJavaScript("window.__ays && window.__ays.focus()", completionHandler: nil) }
  }
  /// V1.41 Esc always backs out (EscAlways.swift). The card is a timed pause, not a PS screen: closing it would only
  /// start it again two seconds later while the site is still open. So Esc gives the keyboard back to the browser and
  /// the countdown carries on (leaving the site still cancels it, as before). Never 1Password or Signal.
  func escape() {
    guard let panel, panel.keyable || panel.isKeyWindow else { return }
    panel.keyable = false
    if panel.isKeyWindow { panel.resignKey() }
    let pid = returnTo   // set on q when the card opened; read without waiting (nothing on main may block)
    if pid > 0, testDir == nil, let app = NSRunningApplication(processIdentifier: pid), !Protected.matches(app),
       NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { app.activate(options: []) }
  }
  private func dismiss(handBackTo pid: pid_t) {
    guard let panel, let dim, panel.isVisible else { return }
    let wasKey = panel.isKeyWindow
    panel.keyable = false
    if wasKey { panel.resignKey() }
    // Hand the keyboard back to the browser he was in (only when he chose to go in, and never 1Password or Signal).
    if wasKey, pid > 0, testDir == nil, let app = NSRunningApplication(processIdentifier: pid), !Protected.matches(app),
       NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { app.activate(options: []) }
    if testDir != nil { panel.orderOut(nil); dim.orderOut(nil); return }
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = 0.32
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.5, 0, 0.75, 0)
      panel.animator().setFrame(panel.frame.offsetBy(dx: 0, dy: 18), display: true)
      panel.animator().alphaValue = 0
      dim.animator().alphaValue = 0
    }) { panel.orderOut(nil); dim.orderOut(nil) }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    ready = true
    if let s = queued { webView.evaluateJavaScript("window.__ays.set(\(s))", completionHandler: nil); queued = nil }
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.navigationType == .other ? .allow : .cancel)    // nothing in the card navigates anywhere
  }
  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    if let m = message.body as? String { receive(m) }
  }
  private func receive(_ m: String) {
    q.async { [self] in
      guard cardStart != nil else { return }
      if m == "continue" { if left() == 0 { close(pass: true) } }       // only once the countdown has run out
      else if m.hasPrefix("sworn:") { if AreYouSure.norm(String(m.dropFirst(6))) == AreYouSure.norm(AreYouSure.shownPhrase(prefs.phrase)) { close(pass: true) } }
    }
  }

  // ---------- self test helpers ----------
  var cardUp: Bool { q.sync { cardStart != nil } }
  var cardVisible: Bool { panel?.isVisible == true }
  var webForTest: WKWebView? { web }
  func checkForTest() { q.sync { check() } }
  func tickForTest() { q.sync { if cardStart != nil { check(); sendCard() } } }
  func setPrefsForTest(_ p: Prefs) { q.sync { prefs = p; publish() } }
  func setMeetingForTest(_ on: Bool) { q.sync { meeting = on; check() } }
  func resetForTest() { q.sync { passUntil = nil; counts = Counts(); if cardStart != nil { close(pass: false) }; publish() } }
  var passUntilForTest: Date? { q.sync { passUntil } }
  var countsForTest: Counts { q.sync { counts } }
  func messageForTest(_ m: String) { receive(m); q.sync {} }

  // The card. Built in: no network, no vault, it only knows the site's name and the countdown.
  private static let page = #"""
  <!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;color:#fff;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;cursor:default}
  #card{position:absolute;inset:8px;border-radius:26px;overflow:hidden;padding:26px 28px 24px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;text-align:center;
    background:radial-gradient(120% 90% at 50% 0%,rgba(236,78,134,.22),transparent 60%),linear-gradient(165deg,rgba(46,27,84,.98),rgba(20,12,28,.98) 70%);
    border:1.5px solid rgba(167,139,250,.6);box-shadow:0 24px 60px rgba(0,0,0,.5),0 0 0 1px rgba(0,0,0,.25)}
  body.in #card{animation:pop .5s cubic-bezier(.22,1,.36,1) both}
  @keyframes pop{from{transform:scale(.94);opacity:.3}}
  #card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,#8B5CF6,#EC4E86,#8B5CF6);background-size:200% 100%;animation:stripe 4s linear infinite}
  @keyframes stripe{to{background-position:-200% 0}}
  .pill{display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border-radius:99px;font-size:11px;font-weight:850;letter-spacing:.14em;text-transform:uppercase;background:rgba(236,78,134,.18);color:#F9A8D4}
  .pill i{width:7px;height:7px;border-radius:50%;background:#EC4E86;box-shadow:0 0 8px #EC4E86;animation:pulse 1.4s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.3}}
  h1{margin:14px 0 2px;font-size:38px;font-weight:850;letter-spacing:-.02em;line-height:1.05;background:linear-gradient(90deg,#fff 40%,#F5C2FD);-webkit-background-clip:text;background-clip:text;color:transparent}
  #why{margin:0;color:rgba(255,255,255,.62);font-size:13.5px}
  #mid{position:relative;height:92px;width:100%;margin:12px 0 6px;display:grid;place-items:center}
  #ring,#go{position:absolute;transition:opacity .45s cubic-bezier(.22,1,.36,1),transform .45s cubic-bezier(.22,1,.36,1)}
  #ring{width:84px;height:84px}
  #ring svg{position:absolute;inset:0;transform:rotate(-90deg)}
  #ring circle{fill:none;stroke-width:6}
  #ring .bg{stroke:rgba(255,255,255,.1)}
  #ring .fg{stroke:url(#g);stroke-linecap:round;transition:stroke-dashoffset 1s linear}
  #num{position:absolute;inset:0;display:grid;place-items:center;font-size:32px;font-weight:850;font-variant-numeric:tabular-nums}
  #go{opacity:0;transform:scale(.9);pointer-events:none;border:0;border-radius:99px;padding:13px 26px;font:800 15px -apple-system,sans-serif;color:#fff;cursor:pointer;
    background:linear-gradient(180deg,#F06A9A,#C8366B);box-shadow:0 10px 26px rgba(236,78,134,.4)}
  #go:active{transform:scale(.96)}
  body.ready #ring{opacity:0;transform:scale(.85)}
  body.ready #go{opacity:1;transform:none;pointer-events:auto}
  #say{width:100%;margin-top:auto}
  #say label{display:block;font-size:11.5px;color:rgba(255,255,255,.5);margin-bottom:6px}
  #say label b{color:rgba(255,255,255,.82);font-weight:700}
  #phrase{width:100%;box-sizing:border-box;border:1px solid rgba(167,139,250,.45);background:rgba(0,0,0,.28);color:#fff;border-radius:12px;padding:10px 13px;font:600 14px -apple-system,sans-serif;outline:none;-webkit-user-select:text;cursor:text}
  #phrase:focus{border-color:#F06A9A;box-shadow:0 0 0 3px rgba(240,106,154,.18)}
  #phrase::placeholder{color:rgba(255,255,255,.32)}
  </style></head><body>
  <div id="card">
    <span class="pill"><i></i><span id="site">YouTube</span></span>
    <h1>Are you sure?</h1>
    <p id="why">Take a breath first. You can still change your mind.</p>
    <div id="mid">
      <div id="ring"><svg viewBox="0 0 84 84"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#EC4E86"/></linearGradient></defs>
        <circle class="bg" cx="42" cy="42" r="37"/><circle class="fg" id="arc" cx="42" cy="42" r="37" stroke-dasharray="232.5" stroke-dashoffset="0"/></svg><div id="num">10</div></div>
      <button id="go" type="button">Continue</button>
    </div>
    <div id="say"><label>Or type <b id="ph">Yes, I am absolutely sure</b> to go in now</label>
      <input id="phrase" type="text" autocomplete="off" spellcheck="false" placeholder="Type it here"></div>
  </div>
  <script>
  const post = (m) => window.webkit.messageHandlers.ays.postMessage(m);
  const $ = (id) => document.getElementById(id);
  window.__ays = {
    set(s) {
      $('site').textContent = s.site || 'This site';
      $('ph').textContent = s.phrase;
      $('num').textContent = s.left;
      $('arc').style.strokeDashoffset = String(232.5 * (1 - (s.left / Math.max(1, s.total))));
      $('go').textContent = String(s.button || 'Continue to {site}').split('{site}').join(s.site || 'it');
      document.body.classList.toggle('ready', s.left <= 0);
      $('why').textContent = s.left > 0 ? 'Take a breath first. You can still change your mind.' : 'Still want it? You get ' + s.pass + ' minutes, then I ask again.';
    },
    enter() { $('phrase').value = ''; document.body.classList.remove('in'); void document.body.offsetWidth; document.body.classList.add('in'); },
    focus() { setTimeout(() => $('phrase').focus(), 60); },
  };
  $('go').addEventListener('click', () => post('continue'));
  $('phrase').addEventListener('input', (e) => post('sworn:' + e.target.value));
  $('phrase').addEventListener('keydown', (e) => { if (e.key === 'Enter') post('sworn:' + e.target.value); });
  </script></body></html>
  """#
}
