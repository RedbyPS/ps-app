// PS: the developer's To-do page as a Mac app, plus a see-through task map that floats over every app
// while Tab is held. The page itself is the Cincee Vault web code (~/Projects/ps/web,
// built with `--mode ps`), served from disk inside this app. Nothing here stores or sends data:
// the web code unlocks the vault, encrypts and syncs with Supabase exactly as the website does.
import Cocoa
import WebKit
import AVFoundation

let SB = "https://mxusokxekkecebwqgeru.supabase.co"
let WEBSITE_VERSION = URL(string: "https://cincee.com/client/version.json")!
let HOLD_SECONDS = 0.18
/// The / and . keys for the slash chord: physical ANSI key codes (the same keys on the developer's layout).
let SLASH_KEY: Int64 = 44, DOT_KEY: Int64 = 47
let MAGIC: Int64 = 0x5053_5441_4221 // marks the Tab presses PS sends on, so the tap lets them through

// Same rules as the website's Content-Security-Policy (scripts only from the app itself,
// network only to the vault's Supabase project: the developer's, or the one this Mac was linked to, Project.swift),
// plus the G Squad hub's one function over https (V1.40, web src/squad/hub.ts; no socket, no other host).
var CSP: String { pageCSP("'self' " + ProjectStore.connectSources(ProjectStore.url) + " " + ProjectStore.squadHub) }

/// A self test copy: it never goes online (the developer's Little Snitch saw test builds connect, 20 Oct 2026).
let IS_TEST_COPY = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
/// The page policy for test copies: everything only from PS's own local address, no other site at all.
let TEST_CSP = pageCSP("'self'")
/// And a WebKit rule list that blocks every web and socket request in test copies (made at launch).
var testBlockList: WKContentRuleList?

// The web files. `npm run release` (or ps-mac/install-web.sh) puts new builds in Application
// Support, so a web update never changes the signed app and macOS keeps the Accessibility
// permission. The copy inside the app is only used until the first install.
func webRoot() -> URL {
  // Self test only: try a fresh web build before it is installed.
  let env = ProcessInfo.processInfo.environment
  if env["PS_SELFTEST"] != nil, let dir = env["PS_SELFTEST_WEB"] { return URL(fileURLWithPath: dir, isDirectory: true) }
  let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("PS/web", isDirectory: true)
  if FileManager.default.fileExists(atPath: support.appendingPathComponent("index.html").path) { return support }
  return Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
}

func readText(_ url: URL) -> String { (try? String(contentsOf: url, encoding: .utf8)) ?? "" }

// MARK: - Serving the app files at ps://app/client/...

final class AppFiles: NSObject, WKURLSchemeHandler {
  static let types: [String: String] = [
    "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
    "json": "application/json", "svg": "image/svg+xml", "png": "image/png", "webp": "image/webp",
    "woff2": "font/woff2", "woff": "font/woff", "webmanifest": "application/manifest+json", "txt": "text/plain",
    "ico": "image/x-icon",
  ]

  /// Requests the page has cancelled (a video skipping ahead): never answered afterwards.
  private var stopped = Set<ObjectIdentifier>()
  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    let root = webRoot().standardizedFileURL
    var rel = url.path
    guard rel.hasPrefix("/client") else { return fail(task, url, 404) }
    // V1.47 the Soundboard's files (Sources/Soundboard.swift): from its storage folder, never the web folder.
    if rel.hasPrefix("/client/media/") {
      let name = String(rel.dropFirst("/client/media/".count)), key = ObjectIdentifier(task)
      stopped.remove(key)
      if !Soundboard.shared.serve(name, task, url, alive: { [weak self] in !(self?.stopped.contains(key) ?? true) }) { fail(task, url, 404) }
      return
    }
    // The developer's background videos: the local copies (Sources/Backgrounds.swift), never the web folder.
    if rel.hasPrefix("/client/bg/") && rel.hasSuffix(".mp4") {
      let id = String(rel.dropFirst("/client/bg/".count).dropLast(4)), key = ObjectIdentifier(task)
      stopped.remove(key)
      if !Backgrounds.shared.serve(id, task, url, alive: { [weak self] in !(self?.stopped.contains(key) ?? true) }) { fail(task, url, 404) }
      return
    }
    rel = String(rel.dropFirst("/client".count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    var file = root.appendingPathComponent(rel).standardizedFileURL
    // Never serve anything outside the web folder.
    guard file.path == root.path || file.path.hasPrefix(root.path + "/") else { return fail(task, url, 403) }
    var isDir: ObjCBool = false
    if rel.isEmpty || !FileManager.default.fileExists(atPath: file.path, isDirectory: &isDir) || isDir.boolValue {
      // App routes (/client/, /client/overlay) are the single page; missing files are 404s.
      if !rel.isEmpty && rel.contains(".") { return fail(task, url, 404) }
      file = root.appendingPathComponent("index.html")
    }
    guard let data = try? Data(contentsOf: file) else { return fail(task, url, 404) }
    var headers = [
      "Content-Type": AppFiles.types[file.pathExtension.lowercased()] ?? "application/octet-stream",
      "Content-Length": "\(data.count)",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    ]
    if file.pathExtension == "html" {
      headers["Content-Security-Policy"] = IS_TEST_COPY ? TEST_CSP : CSP
      headers["Referrer-Policy"] = "no-referrer"
    }
    let resp = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
    task.didReceive(resp)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) { stopped.insert(ObjectIdentifier(task)) }

  private func fail(_ task: WKURLSchemeTask, _ url: URL, _ code: Int) {
    let resp = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
    task.didReceive(resp)
    task.didReceive(Data("Not found".utf8))
    task.didFinish()
  }
}

// MARK: - Web views

final class ClickThroughWebView: SecondDropWebView {
  // The floating window never takes focus from the app you are in, so the first click must count.
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

// Sends every mouse move to the overlay page even though PS is not the active app, so the
// list scrolls when the pointer nears the top or bottom edge while Tab is held.
final class MouseFeed: NSView {
  weak var target: NSView?
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseMoved, .inVisibleRect], owner: self))
    super.updateTrackingAreas()
  }
  // Never hand the event to the web view itself: when it is not tracking it passes the event
  // back up to this view, which looped forever and crashed PS. Instead the pointer position
  // goes straight to the page as a mousemove at that point (what the edge scroll listens to).
  static let feed = "(function(x,y){var t=document.elementFromPoint(x,y)||document.body,o=window.__psHov;"
    + "if(o!==t){if(o&&o.isConnected)o.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,clientX:x,clientY:y,relatedTarget:t}));"
    + "t.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,clientX:x,clientY:y,relatedTarget:(o&&o.isConnected)?o:null}));window.__psHov=t}"
    + "t.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}))})"
  static let moveOnly = "(function(x,y){var t=document.elementFromPoint(x,y)||document.body;t.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:x,clientY:y}))})"
  /// The pointer left the list for the app behind: everything under it gets a mouseout.
  static let leave = "(function(){var o=window.__psHov;if(o&&o.isConnected)o.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:null}));window.__psHov=null})()"
  // One call to the page at a time, but never lose the last position: a move that arrives while
  // one is in flight is kept and sent the moment it finishes (fast moves used to leave parts of
  // the list lit, or never light them).
  var pending = false
  var latest: (Int, Int)?
  /// A self test copy ignores the developer's real mouse (only its own test moves count), so it can never
  /// react to him and his mouse can never upset a test.
  static var selfTest = false, testMove = false
  override func mouseMoved(with event: NSEvent) {
    if MouseFeed.selfTest && !MouseFeed.testMove { return }
    guard let web = target as? WKWebView else { return }
    let v = web.convert(event.locationInWindow, from: nil)
    let p = ScreenFit.toPage(NSPoint(x: v.x, y: web.isFlipped ? v.y : web.bounds.height - v.y), web)   // points to page pixels (V1.40 zoom)
    latest = (Int(p.x), Int(p.y))
    flush()
  }
  private func flush() {
    guard let web = target as? WKWebView, !pending, let (x, y) = latest else { return }
    latest = nil
    pending = true
    // Also mouseover/mouseout when the element under the pointer changes: pop-ups that open on
    // hover (Timelines, time zones, Suggested, screen time, the gear) listen for those, and the
    // page gets nothing else while PS is not the front app (eg Keep overlay over a video).
    // While the list is the key window the real events already do this, so only the move goes.
    let js = (window?.isKeyWindow ?? false) ? MouseFeed.moveOnly : MouseFeed.feed
    web.evaluateJavaScript(js + "(\(x),\(y))") { [weak self] _, _ in self?.pending = false; self?.flush() }
  }
}

final class OverlayPanel: NSPanel {
  var onMouseDown: (() -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
  /// The list takes the keyboard while it is up (for hover), so a key nothing on the page wants used
  /// to end here and play the Mac's alert sound. The list never beeps (the developer, 2 Nov 2026).
  static func silent(_ sel: Selector) -> Bool { sel == #selector(NSResponder.keyDown(with:)) || sel == #selector(NSResponder.keyUp(with:)) }
  override func noResponder(for eventSelector: Selector) {
    if OverlayPanel.silent(eventSelector) { return }
    super.noResponder(for: eventSelector)
  }
  override func sendEvent(_ event: NSEvent) {
    if event.type == .leftMouseDown { onMouseDown?() }
    super.sendEvent(event)
  }
}

// MARK: - App

final class App: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate, WKDownloadDelegate {
  var window: NSWindow!
  var main: WKWebView!
  var panel: OverlayPanel!
  var overlay: WKWebView!
  var lastState: String?
  var vaultUnlocked = false { didSet { if oldValue != vaultUnlocked { SafePeek.shared.refresh(); keepAwake(vaultUnlocked); Second.shared.setUnlocked(vaultUnlocked); Updater.shared.lockChanged() } } }
  /// While the vault is open PS tells macOS it is doing work the user asked for, so App Nap never
  /// freezes the hidden main page (Telegram tasks and Claude's packages sat for hours, 17 Oct).
  /// It does not stop the Mac from sleeping.
  var syncActivity: NSObjectProtocol?
  func keepAwake(_ on: Bool) {
    if on, syncActivity == nil {
      syncActivity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "PS keeps your vault in sync")
    } else if !on, let a = syncActivity {
      ProcessInfo.processInfo.endActivity(a); syncActivity = nil
    }
  }
  var tabMenuItem: NSMenuItem?
  /// The last app in front that was not PS: the keyboard goes back to it when the pop-up or Sign in goes.
  var lastOtherApp: NSRunningApplication?
  /// Until then a launch with Remember me says "Opening your vault" instead of "signed out" (NoWindow.swift).
  var openingUntil = Date().addingTimeInterval(20)
  var rememberKnown = false
  /// The tick shown over the Sign in window as it closes (NoWindow.swift finishSignIn).
  var signInCover: NSView?
  /// Self test: how many psStatus messages came from the hidden engine page.
  var testStatusSeen = 0
  /// Self test only: a check shows its own made up vault state; the test copy's real (signed out) page must not replace it.
  var testHoldState = false
  /// The Sign in window was asked for (the developer's click): the only time the main page's window may be on screen.
  var signInOpen = false
  var signInHeight: CGFloat?        // the Sign in page's own height (NoWindow.swift setSignInHeight)
  var selfTest: Bool { ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil }
  lazy var secondWin = SecondWindow(app: self)
  lazy var replyWin = ReplyWindow(app: self)   // Reply from PS (V1.44): the compose window, the pill and the queue
  var loadedIndex = ""
  var overlayIndex = ""            // the build the overlay page runs
  var updateSeen: Date?            // when a newer build was first noticed on disk
  var updateWait = ""              // why the last auto reload waited (logged once per reason)
  var lastKeyAt = Date.distantPast // the last key typed in PS's own windows (time only)
  var updateTimer: Timer?
  let files = AppFiles()

  func config(main isMain: Bool = false) -> WKWebViewConfiguration {
    let c = WKWebViewConfiguration()
    // The main page is hidden almost all the time (closing the window only hides it). WebKit would
    // then slow its timers and Realtime to a crawl; PS needs it to keep listening for new tasks.
    if isMain, #available(macOS 14.0, *) { c.preferences.inactiveSchedulingPolicy = .none }
    c.setURLSchemeHandler(files, forURLScheme: "ps")
    if IS_TEST_COPY {
      // A test copy: its own empty, in memory data (never the developer's vault copy or sign in), and no
      // request to any site at all (the rule list), no Safe Browsing lookups either.
      c.websiteDataStore = .nonPersistent()
      if let list = testBlockList { c.userContentController.add(list) }
      c.preferences.isFraudulentWebsiteWarningEnabled = false
    } else {
      c.websiteDataStore = .default()          // keeps the encrypted offline copy and the stay-signed-in session
    }
    c.userContentController.add(self, name: "ps")
    ProjectSetup.addPageScript(c.userContentController)   // the linked Supabase project, before the page's code (Project.swift)
    c.userContentController.addUserScript(WKUserScript(source: "window.__psAppName=\(AppName.pageJS);", injectionTime: .atDocumentStart, forMainFrameOnly: true))   // the app's name (AppName.swift, V1.36)
    if IS_TEST_COPY && isMain {   // test copies: page errors are kept for the self test's engine probe
      c.userContentController.addUserScript(WKUserScript(source: "window.__errs=[];addEventListener('error',function(e){__errs.push(String(e.message).slice(0,160))});addEventListener('unhandledrejection',function(e){__errs.push('rejection '+String(e.reason).slice(0,160))})", injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }
    c.preferences.isElementFullscreenEnabled = false
    c.mediaTypesRequiringUserActionForPlayback = []   // the Tab list's hover and click sounds
    return c
  }

  /// A self test copy is a background app from the very start (no moment of focus at launch).
  func applicationWillFinishLaunching(_ n: Notification) {
    if selfTest { NSApp.setActivationPolicy(.accessory) }
    if selfTest {
      // Block every http, https and socket request (made before any page exists, waited for here).
      let rules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^ftp://"},"action":{"type":"block"}}]"#
      var waiting = true
      WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "ps-selftest-offline", encodedContentRuleList: rules) { list, err in
        testBlockList = list
        if list == nil { print("SELFTEST: could not make the offline rule list: \(err?.localizedDescription ?? "?")"); exit(4) }
        waiting = false
      }
      let until = Date().addingTimeInterval(10)
      while waiting && Date() < until { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) }
      if testBlockList == nil { print("SELFTEST: offline rule list not ready, not starting"); exit(4) }
    }
  }
  func applicationDidFinishLaunching(_ n: Notification) {
    if selfTest { ScreenGuard.installTestParking(); ScreenGuard.startTestWatch(); NetGuard.start() }   // before any window exists
    if SecondSelfTest.peer { SecondSelfTest.runPeer(); return }   // the Secondary half of the SECOND check: no windows at all
    Protected.start()      // golden rule first: before anything watches the keyboard or the apps
    MacOSWatch.atLaunch(app: self)   // V1.47: the macOS version, and a check after every macOS update (MacOSWatch.swift)
    NoReload.install()     // no "Reload" in any WebKit right click menu (Sources/NoReload.swift, V1.34)
    if !selfTest { TorchLight.restoreLeftover() }   // a brightness the torch left raised when PS last quit (Torch.swift)
    MouseFeed.selfTest = selfTest
    // Screen fit (V1.40): a self test copy keeps the page at zoom 1 (every area clicks by page coordinates) except in
    // its own area; the live app re-fits when a screen is plugged in, unplugged, rearranged or changes resolution.
    ScreenFit.enabled = !selfTest || ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "screenfit"
    NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
      guard let self, self.shown, !self.selfTest, let p = self.panel, let o = self.overlay else { return }
      let s = p.screen ?? NSScreen.main
      if let s { p.setFrame(s.frame, display: true); ScreenFit.apply(o, ScreenFit.Info(s)) }
    }
    Sfx.shared.testOnly = selfTest
    buildMenu()
    if INSTALL_MODE { Installer.shared.start(); if selfTest { UpdaterSelfTest.install() }; return }
    _ = Sfx.shared   // make the sounds now, so the first hover plays at once
    Mic.watch { [weak self] in self?.sendMic() }

    main = WKWebView(frame: .zero, configuration: config(main: true))
    main.uiDelegate = self
    main.navigationDelegate = self
    // V1.23 (the developer, 31 Oct 2026: "do away with the actual PS app application screen ... I only want it to
    // be the tab overlay now"): the main page is PS's engine (vault, sync, cards, island, reminders) and
    // runs hidden, never shown and never unloaded. Its window only ever appears as the small Sign in
    // window, when the developer asks to sign in (the pop-up, or the Tab list while signed out).
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: App.signInSize.width, height: App.signInSize.height),
                      styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
    window.title = SIGN_IN_TITLE
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.backgroundColor = App.signInBackground
    window.contentView = main
    window.delegate = self
    window.isReleasedWhenClosed = false
    window.center()
    SetupIsland.shared.appLaunched(app: AppName.name(of: Bundle.main.bundleURL))   // V1.58: loading square, first setup guide
    ProjectSetup.shared.launch(self)   // loads the page now, or first asks which Supabase project to use (ProjectSetup.swift)
    if selfTest {
      // Self test copies stay out of the developer's way: invisible and click-through whenever they are shown.
      window.alphaValue = 0
      window.ignoresMouseEvents = true
    }

    setupOverlay()
    if selfTest {
      // Its windows sit off screen (ScreenGuard), so tell WebKit to keep drawing the main page too.
      let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
      if main.responds(to: sel) {
        typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(main.method(for: sel), to: SetBool.self)(main, sel, false)
      }
    } else {
      ScreenGuard.startLiveGuard(overlay: { [weak self] in self?.panel }, listShown: { [weak self] in self?.shown ?? true }, tuck: { [weak self] in self?.tuck() })
    }
    UserDefaults.standard.register(defaults: ["tabEnabled": true])
    // Keychain never on main. The page hears the answer again in case it loaded first (locked: the Touch ID screen).
    if !selfTest { DispatchQueue.global(qos: .userInitiated).async { [weak self] in Remember.refresh(); TouchLock.refresh(); DispatchQueue.main.async { self?.sendRememberStatus() } } }
    TabWatch.shared.app = self
    TabWatch.shared.loadStays()   // Tab keeps the list open: this Mac's choice, or the default for who signed in last
    SafePeek.shared.app = self
    DND.shared.onChange.append { Toast.shared.dndChanged(); Reminders.shared.dndChanged(); Updater.shared.conditionsChanged() }   // Do Not Disturb: held cards come up when it ends
    // V1.58: who is signed in decides the 1Password and Signal rules (BuildRules.swift), so a change re-applies them.
    Owner.onChange = { [weak self] in TabWatch.shared.protectedChanged(); SafePeek.shared.refresh(); Island.shared.rulesChanged(); self?.sendSettings() }
    Protected.onChange = { [weak self] in Posture.shared.place(); self?.replyWin.protectedChanged(); TabWatch.shared.protectedChanged(); SafePeek.shared.refresh(); Reminders.shared.check(); Toast.shared.protectedChanged(); Island.shared.protectedChanged(); Popup.shared.protectedChanged(); Updater.shared.conditionsChanged(); Soundboard.shared.protectedChanged(); HelperAlert.shared.protectedChanged() }
    TabWatch.shared.start()
    KeyLayout.watch()
    KeyLayout.onChange = { [weak self] in self?.sendSettings(); self?.sendTabState(force: true) }   // V1.47: key labels follow the layout
    TabWatch.shared.loadShortcuts()   // V1.47 Tab overlay shortcuts: the saved list, or the old settings as the list
    SafePeek.shared.start()   // hold Tab over Signal, through one macOS hotkey (never the tap)
    // Re-check the Accessibility permission and the keyboard tap every 3 seconds: installs the tap
    // as soon as the developer switches PS on (no relaunch) and re-enables it if macOS turned it off.
    // Tolerances (27 Oct 2026, macOS 27.2 energy check): macOS may bundle these wake ups with others.
    Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in TabWatch.shared.check(); self?.sendTabState() }.tolerance = 0.5
    logTabStatus("launch")
    // While macOS has not allowed PS yet, write the full state every 30 seconds.
    Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in if !AXIsProcessTrusted() { self?.logTabStatus("waiting") } }.tolerance = 5
    AutoReboot.shared.onChange = { [weak self] in self?.sendSettings() }
    // Set up and Open it again open Login Items in System Settings: the Tab list floats above every
    // window, so it is put away first or the page opened underneath it (1 Nov).
    AutoReboot.shared.beforeSystemSettings = { [weak self] in if self?.shown == true { self?.hideOverlay(force: true, giveBack: false) } }
    AutoReboot.shared.start()
    // V1.49: the restart helper pop up, whenever the helper is not active and auto reboot or Sentry's restart needs it (HelperAlert.swift).
    HelperAlert.shared.start()
    // Screen time (PS > Settings; never chosen: on for everyone but the developer, ScreenTime.swift): totals go to the page, which saves them encrypted.
    ScreenTime.shared.onSend = { [weak self] json in if self?.vaultUnlocked == true { self?.sendToMain(json) } }
    ScreenTime.shared.start()
    // AFK timer (Sources/Afk.swift): finished breaks go to the main window, which saves them in the vault.
    Afk.shared.deliver = { [weak self] j in guard let self, self.vaultUnlocked else { return false }; self.sendToMain(j); return true }
    Afk.shared.onSettings = { [weak self] in self?.sendSettings() }
    // The Tab list's volume mixer (Sources/Mixer.swift): its state goes to the overlay page only, while the pop-up is open.
    Mixer.shared.deliver = { [weak self] j in self?.overlay?.callAsyncJavaScript("window.__psMixer && window.__psMixer(JSON.parse(m))", arguments: ["m": j], in: nil, in: .page, completionHandler: nil) }
    Mixer.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // Screen recorder (Sources/ScreenRec.swift, ScreenRecCore.swift, PS 1.60): OFF until the person says yes. This only builds the
    // controller from the saved choices: no capture runs and no macOS permission is asked. Its state goes to both pages.
    ScreenRec.shared.deliver = { [weak self] j in
      for w in [self?.overlay, self?.main] { w?.callAsyncJavaScript("window.__psScreenRec && window.__psScreenRec(JSON.parse(m))", arguments: ["m": j], in: nil, in: .page, completionHandler: nil) }
    }
    ScreenRec.shared.privateOn = { PrivateHold.shared.on }
    ScreenRec.shared.start()
    // Minecraft mode's power out stopwatch (Sources/PowerWatch.swift): IOKit notifications on its own thread;
    // the state goes to both pages (the Minecraft panel asks with power:get), only on a change.
    PowerWatch.shared.deliver = { [weak self] j in
      for w in [self?.overlay, self?.main] { w?.callAsyncJavaScript("window.__psPower && window.__psPower(JSON.parse(m))", arguments: ["m": j], in: nil, in: .page, completionHandler: nil) }
    }
    if MINECRAFT_ENABLED { PowerWatch.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"]) }   // off: no power watch at all (MinecraftSwitch.swift)
    // Sleep mode (Sources/SleepScreen.swift, V1.40): its state goes to both pages; the Tab list goes away while it is up,
    // and comes back pinned after Wake up (Touch ID or the Mac password) so the sleep can be confirmed there.
    SleepScreen.shared.deliver = { [weak self] js in for w in [self?.overlay, self?.main] { w?.evaluateJavaScript(js, completionHandler: nil) } }
    SleepScreen.shared.onOpen = { [weak self] in self?.hideOverlay(force: true, giveBack: false) }
    // V1.41: Esc left Sleep mode without Touch ID, so PS locks. Tab is refused at once (vaultUnlocked off here too),
    // even if the main page is slow to say it locked; Touch ID or the password opens the list again.
    SleepScreen.shared.onEscaped = { [weak self] in
      guard let self else { return }
      self.lockPS(popup: false)
      if !self.selfTest { self.vaultUnlocked = false }
    }
    // V1.52: the AI Sentry mode button on the sleep screen puts Sentry mode's protection under it (SleepSentry.swift).
    SleepScreen.shared.guardian = SleepSentry.shared
    // Sentry mode (Sources/Sentry.swift, V1.48): its state goes to both pages; the Tab list goes away while it engages.
    Sentry.shared.deliver = { [weak self] js in for w in [self?.overlay, self?.main] { w?.evaluateJavaScript(js, completionHandler: nil) } }
    Sentry.shared.onOpen = { [weak self] in self?.hideOverlay(force: true, giveBack: false); Reminders.shared.check() }   // V1.55: reminder cards step aside at once
    SleepScreen.shared.onWoke = { [weak self] in
      guard let self, !self.selfTest else { return }
      self.showOverlay()
      let w = TabWatch.shared
      w.mu.lock(); w.pinned = true; w.mu.unlock()
      self.keepOpen()
    }
    // Switch to AirPods Max when they connect (Sources/AutoRoute.swift): Core Audio listeners, own queue.
    // The developer's own (Owner.swift): on anyone else's PS it never starts.
    Owner.whenRed { AutoRoute.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"]) }
    // Headphones mode (Sources/Headphones.swift, V1.40): every account, its switch is in the volume mixer. Own queue.
    HeadphonesMode.shared.deliver = { [weak self] j in self?.overlay?.callAsyncJavaScript("window.__psHpMode && window.__psHpMode(JSON.parse(m))", arguments: ["m": j], in: nil, in: .page, completionHandler: nil) }
    HeadphonesMode.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // The Tab list's badge ("AFK 14:32" or "Watcher 42:10 left"): status goes to the overlay page only.
    Afk.shared.onStatus = { [weak self] j in self?.overlay?.callAsyncJavaScript("window.__psAfk && window.__psAfk(JSON.parse(m))", arguments: ["m": j], in: nil, in: .page, completionHandler: nil) }
    Afk.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // AirPods controls card (Sources/MediaGuard.swift): reads mediaremoted's log, read only, off the main thread, and only
    // while its switch is on (off until chosen). Every account since V1.40 (the developer: only Numerology and the PS rules stay his).
    MediaGuard.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // "Are you sure" mode (Sources/AreYouSure.swift): a pause card before YouTube or Netflix.
    AreYouSure.shared.onSettings = { [weak self] in self?.sendSettings() }
    AreYouSure.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // Force Touch middle click (Sources/MiddleClick.swift): the helper inside PS, its own process.
    MiddleClick.shared.onChange = { [weak self] in self?.sendSettings() }
    MiddleClick.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // AI chat finished cards (Sources/AiDone.swift, V1.53): a card when a Claude Code, Codex, Gemini CLI or Cursor chat
    // on this Mac finishes, for everyone. Straight from this Mac into the vault, never through a server.
    AiDone.shared.onChange = { [weak self] in self?.sendSettings() }
    AiDone.shared.deliver = { [weak self] items in
      guard let data = try? JSONSerialization.data(withJSONObject: ["type": "aiDone", "items": items]), let json = String(data: data, encoding: .utf8) else { return }
      self?.sendToMain(json)
    }
    AiDone.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // Auto approve (Sources/AutoApprove.swift): answers AI tools' permission prompts in AI mode, Sleep mode or always,
    // as the person chose in Settings, Sentry mode (all off by default). Questions always wait. Everyone's.
    AutoApprove.shared.onChange = { [weak self] in self?.sendSettings() }
    AutoApprove.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // The Annoying 15 min reminders (Sources/Reminders.swift, V1.46): the cards of every reminder in Settings >
    // Annoying 15 min reminder (web views/RemindSettings.tsx). Everyone's. The built in daily reminder
    // is gone since 1.60.
    Posture.shared.onMessage = { [weak self] json in self?.sendCardAction(json) }   // PS 1.65: the Posture reminder's idle time and answers go to the page (Sources/Posture.swift)
    Reminders.shared.onSettings = { [weak self] in self?.sendSettings() }
    Reminders.shared.onAnswer = { [weak self] json in self?.sendCardAction(json) }
    // V1.55 Open task on a reminder card: the Tab list opens (pinned, like a tap of Tab) and the task glows. The id was
    // checked against RemMath.taskPattern (letters, digits and dashes only), so it is safe inside the line of code.
    Reminders.shared.onOpenTask = { [weak self] id in
      guard id.range(of: RemMath.taskPattern, options: .regularExpression) != nil else { return }
      self?.openList(then: "window.__psOpenTask && window.__psOpenTask('\(id)')")
    }
    // PS 1.65 Checklist reminder: a choice on its card. Rethink and I forgot open the Tab list on their screen; the page (engine) is told
    // which one it was either way, so it starts counting again.
    Reminders.shared.onChk = { [weak self] outcome in
      guard ["rethink", "forgot", "sure", "esc"].contains(outcome) else { return }
      if outcome == "rethink" || outcome == "forgot" { self?.openList(then: "window.__psChk && window.__psChk('\(outcome)')") }
      Reminders.shared.deliver?("window.__psChkAnswered && window.__psChkAnswered('\(outcome)')")
    }
    Reminders.shared.deliver = { [weak self] js in for w in [self?.overlay, self?.main] { w?.evaluateJavaScript(js, completionHandler: nil) } }
    Reminders.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    // Network monitor (gear menu > Network): its data goes only to the overlay page, only while open.
    // The developer's background videos: the list goes to the Tab list page (Sources/Backgrounds.swift); the
    // videos themselves come from his vault through the main window (bg:put, bg:list, bg:read).
    Backgrounds.shared.deliver = { [weak self] j in self?.overlay?.callAsyncJavaScript("window.__psBg && window.__psBg(JSON.parse(m))", arguments: ["m": j], in: nil, in: .page, completionHandler: nil) }
    Backgrounds.shared.toMain = { [weak self] j in self?.sendToMain(j) }
    LocalCalendar.shared.toMain = { [weak self] j in self?.sendToMain(j) }   // the Meetings panel from this Mac's Calendar (not the developer's PS)
    Backgrounds.shared.start()
    // Second Computer (Sources/Second.swift): the page carries everything through the vault; native holds
    // the device key and the trust store, checks and signs, runs allowlisted jobs and lands files.
    Second.shared.toPage = { [weak self] j in if self?.vaultUnlocked == true { self?.sendToMain(j) } }
    Second.shared.openWindow = { [weak self] tab in self?.secondWin.open(tab) }
    Second.shared.beforePanel = { [weak self] in if self?.shown == true { self?.hideOverlay(force: true, giveBack: false) } }
    Backgrounds.shared.beforePanel = { [weak self] in if self?.shown == true { self?.hideOverlay(force: true, giveBack: false) } }
    SleepSound.shared.beforePanel = { [weak self] in if self?.shown == true { self?.hideOverlay(force: true, giveBack: false) } }
    SleepSound.shared.deliver = { [weak self] js in for w in [self?.overlay, self?.main] { w?.evaluateJavaScript(js, completionHandler: nil) } }
    // V1.47 Soundboard (Sources/Soundboard.swift): the files, their serving (AppFiles), imports, the storage folder and
    // the timed plays. Everyone's.
    Soundboard.shared.pages = { [weak self] in [self?.overlay, self?.main].compactMap { $0 } }
    Soundboard.shared.beforePanel = { [weak self] in if self?.shown == true { self?.hideOverlay(force: true, giveBack: false) } }
    Soundboard.shared.start()
    // Second Computer's questions float above the Tab list, and the list is put away first (SecondConfirm.swift).
    SecondConfirm.shared.beforeShow = { [weak self] in if self?.shown == true { self?.hideOverlay(force: true, giveBack: false) } }
    // Second Computer (PS 1.65): everyone's, behind its switch (Settings, Second Computer; feature "second-computer", off
    // until switched on, on for the developer through his layer). It starts or stops with the page's answer; nobody with it
    // off sees it or its Keychain question. The developer's alone V1.42 to V1.64 (Owner.whenRed).
    Second.shared.setOn(Second.switchedOn)
    Features.observers.append { Second.shared.setOn(Second.switchedOn) }
    if IS_TEST_COPY { Owner.whenRed { Second.shared.setOn(Second.switchedOn) } }   // a self test copy: as before, once its account is known
    // Remote Restart, Shut down and Lock (protocol section 13): Second checks the signed command, then
    // RemoteCommand carries it out (10 s Cancel card when unlocked) through the restart helper. The
    // machine block of the stat body (locked, timer, helper) comes from AutoReboot and is resent when it changes.
    Second.shared.cmdRunner = { a, id, from, at, done in RemoteCommand.shared.run(action: a, id: id, from: from, at: at, done: done) }
    Second.shared.machine = { AutoReboot.shared.machine() }
    AutoReboot.shared.observe { Second.shared.machineChanged() }
    NetMonitor.shared.deliver = { [weak self] j in self?.overlay?.callAsyncJavaScript("window.__psNet && window.__psNet(JSON.parse(m))", arguments: ["m": j], in: nil, in: .page, completionHandler: nil) }
    // Minecraft mode (Sources/Minecraft.swift): the offline translator; answers go to the Tab list page only.
    MinecraftMode.shared.deliver = { [weak self] j in self?.overlay?.callAsyncJavaScript("window.__psMc && window.__psMc(JSON.parse(m))", arguments: ["m": j], in: nil, in: .page, completionHandler: nil) }
    if MINECRAFT_ENABLED { MinecraftMode.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"]) }   // off: no translator (MinecraftSwitch.swift)
    NetMonitor.shared.alarmPopup = { t, b in Toast.shared.show(title: t, body: b) }
    NetMonitor.shared.start(testDir: ProcessInfo.processInfo.environment["PS_SELFTEST"])
    Owner.whenRed { NetMonitor.shared.ownerKnown() }   // the VPN leak watch is the developer's own
    // PS no longer shows a lag symbol or reads anything from another app (the developer, 4 Nov 2026: "These are two
    // different applications"). The two settings the old lag symbol kept are dropped once, unread.
    for k in ["lag.peaks", "lag.dot"] where UserDefaults.standard.object(forKey: k) != nil { UserDefaults.standard.removeObject(forKey: k) }
    // V1.55: cards under the Dynamic Island that come up while the Tab list is up stay behind it (island clearance).
    Toast.shared.listWindow = { [weak self] in self?.shown == true ? self?.panel : nil }
    // Card buttons go to the page (the end of day question that used this first is gone since 2 Nov 2026).
    Toast.shared.onAction = { [weak self] id, action in
      if id.hasPrefix("sr:") { ScreenRecIsland.shared.cardAction(id, action); return }   // 12b: the screen recorder's cards (meeting question, Resources are high, Saved, controls)
      if id.hasPrefix("ma:") { MediaGuard.shared.action(id, action); return }   // the AirPods controls card is handled here, not by the page
      if id.hasPrefix("ar:") { AutoRoute.shared.action(id, action); return }   // the honest "sound still on the speakers" card's Play through AirPods Max
      if id.hasPrefix("rr:") { RemoteCommand.shared.cardAction(id, action); return }   // Cancel on a remote restart countdown
      if id.hasPrefix("sk:") { Second.shared.keyAction(id, action); return }   // Allow PS to use its Second Computer key
      if id.hasPrefix("rh:") { AutoReboot.shared.cardAction(id, action); return }   // the restart helper was switched off by an update: open System Settings
      if id.hasPrefix("bg:") { Backgrounds.shared.cardAction(id, action); return }   // a background video problem: Copy error code
      // V1.60 a WhatsApp card's Reply: the Tab list comes up and opens the reply box on that chat (never sends, the person's own Send does).
      if WhatsAppCardCore.opensReply(id: id, action: action), let d = try? JSONSerialization.data(withJSONObject: ["type": "waReply", "id": id]), let j = String(data: d, encoding: .utf8) {
        self?.showOverlay()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self?.sendToOverlay(j) }
      }
      // V1.60 a G Squad message card's Open: the Tab list comes up and opens the chat (the page also marks the message handled).
      if SquadMessageCore.opensChat(id: id, action: action) {
        self?.showOverlay()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { self?.sendToOverlay(#"{"type":"squadOpen"}"#) }
      }
      guard let d = try? JSONSerialization.data(withJSONObject: ["type": "cardAction", "id": id, "action": action]),
            let json = String(data: d, encoding: .utf8) else { return }
      self?.sendCardAction(json)
    }
    // V1.60 a G Squad message card's Reply: the words go to the page, which sends them through the chat composer.
    Toast.shared.onSquadReply = { [weak self] id, text in
      if let json = SquadMessageCore.replyJSON(id: id, text: text) { self?.sendCardAction(json) }
    }
    // Reply from PS (V1.44): the sign ins and the queue live here (MailSend.swift); only the developer's Send or schedule sends.
    MailSend.shared.app = self
    MailSend.shared.onChange = { [weak self] in
      self?.sendSettings(); self?.replyWin.status(); self?.replyWin.queue()
      // V1.59 Reply in the email panel: the queue's rows (state and any problem, never the words) to the main page, which
      // writes "Replied" or "Not sent" on the reply's vault record so the phone and the Tab list show it too.
      if let d = try? JSONSerialization.data(withJSONObject: ["type": "reply:rows", "rows": MailSend.shared.rows]), let json = String(data: d, encoding: .utf8) { self?.sendToMain(json) }
    }
    MailSend.shared.onSent = { [weak self] card in   // really sent: the card is dismissed on every device
      guard let d = try? JSONSerialization.data(withJSONObject: ["type": "reply:sent", "cardId": card]), let json = String(data: d, encoding: .utf8) else { return }
      self?.sendCardAction(json)
    }
    MailSend.shared.start()
    // Add Telegram Bot (V1.47): the bot key in the Keychain and the relay for the main page's reader (TelegramBot.swift).
    TelegramBot.shared.app = self
    TelegramBot.shared.start()
    // Proton Mail through Proton Bridge (PS 1.65): the link in the Keychain, a check of the inbox once a minute while PS runs (ProtonBridge.swift).
    ProtonBridge.shared.app = self
    ProtonBridge.shared.start()
    // AI task API: a local API on 127.0.0.1 for AI tools on this Mac, off until switched on (TaskApi.swift).
    TaskApi.shared.app = self
    TaskApi.shared.start()
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in   // replies still waiting from before a restart: the pill shows them
      if MailSend.shared.rows.contains(where: { ($0["state"] as? String) == "queued" }) { self?.replyWin.showPill() }
    }
    // The island moved or put back (G Squad): PS > Settings shows where it is.
    Island.shared.onMoved = { [weak self] in self?.sendSettings() }
    // V1.58 the island's right click menu: away and back (Settings shows it), and Settings opens the Tab list with the
    // island settings window (web views/IslandSettings.tsx; the usual Settings if that page is older).
    Island.shared.onAway = { [weak self] in self?.sendSettings() }
    Island.shared.onSettings = { [weak self] in self?.openList(then: Island.openSettingsJS) }
    // V1.59: See settings on the first stand-up's question: the Tab list, Settings open on Stand-up reminders.
    IslandTimers.shared.onStandSettings = { [weak self] in self?.openList(then: StandAsk.settingsJS) }
    // V1.53 island clearance: the list hears where the island is, so Keep overlay and Hover mode slide out of its way.
    Island.shared.onShape = { [weak self] in self?.pushIsland() }
    // The Dynamic Island's tick and Undo go back to the main window, which ticks the task as the list does.
    Island.shared.onAction = { [weak self] action, id in
      guard let d = try? JSONSerialization.data(withJSONObject: ["type": "islandAction", "action": action, "id": id]),
            let json = String(data: d, encoding: .utf8) else { return }
      self?.sendToMain(json)
    }
    // PS 1.61: the island's envelope or reply arrow brings the Tab list up (kept up, like the menu's Open) on the email
    // panel with the newest email open (IslandMailOpen.swift). Esc or Tab closes it as always.
    Island.shared.onOpenMail = { [weak self] via in
      guard let self, self.vaultUnlocked, let j = IslandMailOpen.json(via: via) else { return }
      self.openList()
      DispatchQueue.main.asyncAfter(deadline: .now() + IslandMailOpen.delay) { [weak self] in self?.sendToOverlay(j) }
    }

    // A newer build installed on disk: PS reloads itself as soon as that is safe (see
    // checkLocalUpdate); until then the refresh button lights up.
    // Only the time of the last key in PS's own windows is kept, never which key.
    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in self?.lastKeyAt = Date(); return e }
    // V1.41 Esc always backs out, also with the keyboard tap off (macOS Secure Input): PS's own windows only.
    NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] e in (self?.localEsc(e) == true) ? nil : e }
    updateTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in self?.checkLocalUpdate() }
    updateTimer?.tolerance = 3
    // Every 20 s PS itself asks the page for a sync (inbox included), so a task the developer texts lands
    // within seconds even if the page's own timers or Realtime socket stalled.
    let pull = Timer(timeInterval: 20, repeats: true) { [weak self] _ in
      guard let self, self.vaultUnlocked else { return }
      self.sendToMain(#"{"type":"pull"}"#)
    }
    pull.tolerance = 2
    RunLoop.main.add(pull, forMode: .common)
    // After sleep the Realtime socket is usually dead: a fresh one and a sync once the network is back.
    for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification] {
      NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        for delay in [3.0, 15.0] {
          DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard let self, self.vaultUnlocked else { return }
            self.sendToMain(#"{"type":"wake"}"#)
          }
        }
        psLog("PS sync: Mac woke, reconnecting")
      }
    }
    if !selfTest {   // a test copy never goes online
      checkWebsite()
      Timer.scheduledTimer(withTimeInterval: 15 * 60, repeats: true) { [weak self] _ in self?.checkWebsite() }.tolerance = 60
    }
    // The keyboard tap's watchdog: the main thread says it is alive every 0.4 s (at most 0.5 s apart,
    // well inside the watchdog's 1 s; was 0.25 s, 27 Oct 2026, fewer wake ups for the battery).
    let beat = Timer(timeInterval: 0.4, repeats: true) { _ in TabWatch.shared.heartbeat() }
    beat.tolerance = 0.1
    RunLoop.main.add(beat, forMode: .common)
    // What the tap needs to know, kept here on main (the tap never asks AppKit from its thread).
    TabWatch.shared.frontID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
      let front = n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      TabWatch.shared.frontID = front?.bundleIdentifier
      if let front, front.processIdentifier != ProcessInfo.processInfo.processIdentifier { self?.lastOtherApp = front }
      if SafePeek.shared.secureStuck { SafePeek.shared.refresh() }   // the ignore list counts while Secure Input is stuck
    }
    // PS counts as "in front" for Tab only while its Sign in window is up (Tab moves between the boxes
    // there). With no window, PS being the active app (a Dock click) never stops Tab showing the list.
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.syncAppActive() }
    NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.syncAppActive() }
    // No window to bring forward: the "PS is active" pop-up says PS is running, without taking the keyboard.
    setUpPopup()
    // Secure Input stuck on (V1.41, SecureInput.swift): no key reaches PS, so the card says why and how to fix it.
    SecureInputWatch.shared.onChange = { note in Popup.shared.update { $0.secureNote = note } }   // the card comes up by itself
    SecureInputWatch.shared.onEnded = { TabWatch.shared.afterSecureInput() }
    SecureInputWatch.shared.onStuck = { SafePeek.shared.secureStuck = $0 }   // V1.44: hold Tab works while it is stuck
    TabWatch.shared.onDeaf = { deaf in Popup.shared.update { $0.deaf = deaf } }   // the tap hears nothing (V1.41)
    SecureInputWatch.shared.start()
    // At launch (also the relaunch after an update) it stays quiet while Do Not Disturb holds system notices.
    if !selfTest && !DND.shared.mutes("system") { showPopup() }
    // Updates from the synced Drive folder (Updater.swift); after an install, the DMG is ejected.
    Updater.shared.start(app: self)
    Installer.ejectIfAsked()
    if selfTest && UpdaterSelfTest.run(self) { return }
    if let dir = ProcessInfo.processInfo.environment["PS_SELFTEST"] { SelfTest.run(self, dir) }
  }

  // Tells the page whether the Tab watcher is on, so PS only says "PS is open" to the website
  // when it can really show the overlay.
  var lastTabJSON = ""
  func sendTabState(force: Bool = false) {
    let w = TabWatch.shared
    let on = w.tap != nil && w.enabled
    let json = #"{"type":"tab","enabled":\#(w.enabled),"trusted":\#(AXIsProcessTrusted()),"on":\#(on)}"#
    tabMenuItem?.state = w.enabled ? .on : .off
    tabMenuItem?.title = w.enabled ? "Tab Overlay: On" : "Tab Overlay: Off"
    guard force || json != lastTabJSON else { return }
    lastTabJSON = json
    psLog("PS tab: \(json)")
    sendToMain(json); sendToOverlay(json)
    // V1.47: the first shortcut in the Tab overlay shortcuts list ("Hold Tab", "Hold P and press O"), Tab as before.
    let first = w.shortcutList.first.map { OpenKeysCore.describe($0, label: KeyLayout.label) } ?? "Tab"
    Popup.shared.update { $0.tabOn = w.enabled; $0.trusted = AXIsProcessTrusted(); $0.keyName = first }
  }
  func sendTapState() { sendTabState(force: true) }
  func sendMic() { let j = Mic.stateJSON(); sendToMain(j); sendToOverlay(j) }

  func logTabStatus(_ why: String) {
    let w = TabWatch.shared
    let front = Protected.front ? "(protected)" : NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"
    psLog("PS tab: \(why) trusted=\(AXIsProcessTrusted() ? 1 : 0) tap=\(w.tap == nil ? "nil" : "ok") enabled=\(w.enabled ? 1 : 0) vaultUnlocked=\(vaultUnlocked ? 1 : 0) key=\(w.triggerKey) front=\(front) tapOn=\(w.tap.map { CGEvent.tapIsEnabled(tap: $0) ? 1 : 0 } ?? 0) signalPeek=\(SafePeek.shared.armed ? 1 : 0) app=\(Bundle.main.bundlePath)")
  }

  // "Fix permission" (banner button, the developer's click only): clears THIS app's own Accessibility entry
  // (a stale row from an older build can never match), asks macOS for a fresh one, opens the pane.
  func fixPermission() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/tccutil")
    p.arguments = ["reset", "Accessibility", "com.cincee.ps"]
    let out = Pipe(); p.standardOutput = out; p.standardError = out
    // Run off the main thread (a waiting process must never hold the main thread, or the Mac's keys).
    DispatchQueue.global(qos: .userInitiated).async {
      do { try p.run(); p.waitUntilExit() } catch { psLog("PS tab: tccutil failed to start: \(error)") }
      let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      psLog("PS tab: fix permission, tccutil exit=\(p.terminationStatus) \(text.trimmingCharacters(in: .whitespacesAndNewlines))")
    }
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { TabWatch.shared.askPermission(force: true) }
    logTabStatus("after fix")
  }

  func sendToOverlay(_ json: String) {
    overlay?.callAsyncJavaScript("window.__ps && window.__ps.apply(JSON.parse(m))", arguments: ["m": json], in: nil, in: .page, completionHandler: nil)
  }

  func sendRememberStatus() {
    rememberKnown = true
    // locked: Lock was pressed with Remember me on; Touch ID (or the Mac password) opens PS again.
    let json = #"{"type":"rememberStatus","exists":\#(Remember.cachedExists),"locked":\#(TouchLock.cachedLocked)}"#
    sendToMain(json); sendToOverlay(json)
    updatePopup()
  }
  /// Touch ID (or the Mac password), then the locked keys open the vault (TouchLock.swift). The
  /// system sheet runs off the main thread; the answer comes back here.
  func touchUnlock() {
    guard !vaultUnlocked, TouchLock.cachedLocked else { return }
    TouchLock.unlock { [weak self] keys in
      guard let self else { return }
      self.sendRememberStatus()
      if let keys { self.sendRemembered(keys) } else { self.sendToMain(#"{"type":"touchid","ok":false}"#) }
    }
  }

  /// Hands the Keychain keys to the page (in memory), which signs in with them.
  /// Opens the vault silently with the remembered sign in, when there is one.
  func openRemembered() {
    if !selfTest && Remember.cachedExists && !vaultUnlocked {
      // The Keychain is read off the main thread (it can stall); the answer comes back to main.
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let d = Remember.read()
        DispatchQueue.main.async {
          psLog("PS remember: ready, keychain read=\(d == nil ? "failed" : "ok")")
          self?.sendRemembered(d)
        }
      }
    } else { psLog("PS remember: ready, exists=\(Remember.cachedExists ? 1 : 0) unlocked=\(vaultUnlocked ? 1 : 0)") }
  }
  func sendRemembered(_ data: Data?) {
    guard let data, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
    var m = obj; m["type"] = "remember"
    guard let d = try? JSONSerialization.data(withJSONObject: m), let json = String(data: d, encoding: .utf8) else { return }
    sendToMain(json)
  }

  func setTab(_ on: Bool) {
    TabWatch.shared.enabled = on
    if !on { hideOverlay(force: true) }
    SafePeek.shared.refresh()
    sendTabState(force: true)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if webView === main { sendTapState() }
    // The page that held the What's new panel is gone (a reload): it can never say it is done, so the island queue lets go.
    if webView === overlay { IslandQueue.shared.finish("whatsnew") }
  }

  // ---------- V1.47 Tab overlay shortcuts ----------
  /// What Settings shows: the list (saved, or the old settings as a list), what each key types on this layout, which
  /// combos another app holds, and which shortcuts work over 1Password and Signal. Never a key anyone typed.
  func shortcutsJSON() -> [String: Any] {
    let w = TabWatch.shared
    let list = w.shortcutList
    var codes = Set<Int>([OpenKeysCore.TAB])
    for s in list { codes.insert(s.key); if let f = s.first { codes.insert(f) } }
    for c in 0...127 { codes.insert(c) }
    let labels = KeyLayout.labels(Array(codes))
    let items: [[String: Any]] = list.map { s in
      var o: [String: Any] = ["kind": s.kind.rawValue, "key": s.key]
      if let f = s.first { o["first"] = f }
      if let m = s.mods { o["mods"] = m }
      o["protected"] = OpenKeysCore.hotkeyable(s)
      return o
    }
    return ["custom": w.customList != nil, "list": items, "labels": Dictionary(uniqueKeysWithValues: labels.map { (String($0.key), $0.value) }),
            "layout": KeyLayout.layoutName(), "taken": Array(SafePeek.shared.comboTaken).sorted(),
            "legacyProtected": w.customList == nil,   // never changed: plain Tab opens PS over 1Password and Signal
            "overProtected": BuildRules.now.tabOverProtected]   // V1.58: false on the developer's account (never over them)
  }
  func setShortcuts(_ raw: Any?) {
    guard let arr = raw as? [Any], let data = try? JSONSerialization.data(withJSONObject: arr),
          let list = try? JSONDecoder().decode([OpenKeysCore.Shortcut].self, from: data) else { sendSettings(error: "That shortcut list could not be read."); return }
    if let bad = OpenKeysCore.problems(list).first(where: { $0.error }) {
      sendSettings(error: bad.index >= 0 ? "Shortcut \(bad.index + 1): \(bad.text)" : bad.text); return
    }
    TabWatch.shared.setCustom(list, save: true)
    logTabStatus("shortcuts changed (\(list.count))")
    // A combo another app already holds is only known once PS tries it: say so at once.
    DispatchQueue.main.async { [weak self] in self?.sendSettings(); self?.sendTabState(force: true) }
  }
  private var recordTimer: Timer?
  /// Record shortcut in Settings: while it listens, every key goes to the page (the list takes the keyboard, like
  /// typing in it) and no combo fires. Never over 1Password or Signal (the list never has their keyboard). It ends by
  /// itself after 30 s, so a page that never says "done" cannot leave the combos off.
  func recordShortcut(_ on: Bool) {
    recordTimer?.invalidate(); recordTimer = nil
    let w = TabWatch.shared
    SafePeek.shared.recording = on
    if on {
      w.mu.lock(); w.editing = true; w.pinned = true; w.mu.unlock()
      if shown && !Protected.front && !selfTest { panel.makeKey() }
      recordTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in self?.recordShortcut(false) }
    } else {
      w.mu.lock(); w.editing = false; w.mu.unlock()
    }
  }

  // PS > Settings (Mac only, kept in this Mac's PS settings, never in the vault).
  /// PS 1.60, What's new from the island. The page asks (start) before it opens the panel and says it is done (start false).
  /// The shared island queue decides when it is the panel's turn (never over a reminder or the update card); the answer
  /// to the page is {state:"queued"} or {state:"go", rect}, rect nil when the island cannot do it and the panel opens
  /// as it always did. Closing it shrinks it back into the island and lets the next card come.
  func whatsNewFromIsland(start: Bool) {
    let id = "whatsnew"
    func tell(_ js: String) { overlay.evaluateJavaScript("window.__psWnIsland&&window.__psWnIsland(\(js))", completionHandler: nil) }
    func go() {
      SetupIsland.shared.whatsNew(overlay: panel) { rect in
        if let r = rect, let d = try? JSONSerialization.data(withJSONObject: ["state": "go", "rect": r]), let t = String(data: d, encoding: .utf8) { tell(t) }
        else { tell("{\"state\":\"go\"}") }
      }
    }
    if !start {
      if IslandQueue.shared.finish(id) { Island.shared.swell(false) } else { IslandQueue.shared.finish(id) }
      return
    }
    // A panel the page never closes (a reload, a lost message) must not hold the queue for good: after 30 minutes it is let go.
    let since = Date()
    let o = IslandQueue.shared.enqueue(id: id, kind: "whatsnew", priority: .normal, ttl: 120, show: { go() },
                                       visible: { Date().timeIntervalSince(since) < 1800 }, dropped: { tell("{\"state\":\"go\"}") })
    switch o {
    case .showNow: go()
    case .wait: tell("{\"state\":\"queued\"}")
    case .updated: break
    case .dropped: tell("{\"state\":\"go\"}")
    }
  }

  /// PS 1.60, a "Did you know?" feature intro from the island (web/src/views/FeatureIntro.tsx; the list and the clock rules are in
  /// web/src/core/featureintro.ts). The page decides when one is due and asks here (start). The Mac answers {state:"blocked", why}
  /// (Sentry mode, Sleep mode, screen sharing, a full screen app, the feature off: the page asks again at the next free moment),
  /// {state:"queued"} (another card is on the island: the shared queue, never one over another), or {state:"go", rect} when it is the
  /// intro's turn (rect nil when the island cannot do it: the page draws the same card plainly). The island squeezes, bounces and
  /// chimes first. The page says it is done (start false) when the card or the guide it grows into is closed: the queue moves on.
  func introFromIsland(start: Bool, id: String) {
    let qid = "intro:" + id
    func tell(_ js: String) { overlay.evaluateJavaScript("window.__psIntroIsland&&window.__psIntroIsland(\(js))", completionHandler: nil) }
    func blocked(_ why: String) { tell("{\"state\":\"blocked\",\"why\":\"\(why)\"}") }
    if !start {
      if IslandQueue.shared.finish(qid) { Island.shared.swell(false) }
      return
    }
    // Only a plain id (letters, digits, dashes): it goes into the queue's key and nothing else.
    guard !id.isEmpty, id.count <= 40, id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return }
    if let why = IslandIntroCore.blocked(IslandIntro.facts()) { blocked(why); return }
    func go() {
      // Asked again at its turn: the moment may have turned quiet while it waited.
      if let why = IslandIntroCore.blocked(IslandIntro.facts()) { IslandQueue.shared.finish(qid); blocked(why); return }
      SetupIsland.shared.featureIntro(overlay: panel) { rect in
        if let r = rect, let d = try? JSONSerialization.data(withJSONObject: ["state": "go", "rect": r]), let t = String(data: d, encoding: .utf8) { tell(t) }
        else { tell("{\"state\":\"go\"}") }
      }
    }
    // A card or guide the page never closes (a reload, a lost message) must not hold the queue for good.
    let since = Date()
    let o = IslandQueue.shared.enqueue(id: qid, kind: "intro", priority: .low, ttl: IslandIntroCore.queueTTL, show: { go() },
                                       visible: { Date().timeIntervalSince(since) < IslandIntroCore.holdCap }, dropped: { blocked("busy") })
    switch o {
    case .showNow: go()
    case .wait: tell("{\"state\":\"queued\"}")
    case .updated: break
    case .dropped: blocked("busy")
    }
  }

  func sendSettings(error: String? = nil) {
    var d: [String: Any] = ["reboot": AutoReboot.shared.status()]
    if let error { d["error"] = error }
    let w = TabWatch.shared
    func name(_ id: String) -> String {
      NSWorkspace.shared.runningApplications.first { $0.bundleIdentifier == id }?.localizedName
        ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: id).map { $0.deletingPathExtension().lastPathComponent } ?? id
    }
    d["triggerKey"] = w.triggerKey
    if let h = Host.current().localizedName, !h.isEmpty { d["hostName"] = String(h.prefix(60)) }   // PS 1.65: this Mac's own name for the device list (Settings, Looks)
    d["shortcuts"] = shortcutsJSON()
    let k = KeyLayout.slashKeys()
    d["slashChord"] = w.slashOn
    w.mu.lock(); d["tabStays"] = w.stays; w.mu.unlock()
    d["tabStaysChosen"] = w.staysChoice != nil
    d["slashKeys"] = ["slash": k.slash, "dot": k.dot, "layout": k.name]
    d["screenTime"] = ScreenTime.shared.enabled
    d["helperRemind"] = HelperAlert.shared.remind   // Security > Remind me to set up the restart helper (HelperAlert.swift)
    d["afk"] = Afk.shared.settingsJSON()
    d["mediaGuard"] = MediaGuard.shared.settingsJSON()
    d["ays"] = AreYouSure.shared.settingsJSON()
    d["rem"] = Reminders.shared.settingsJSON()   // the Annoying 15 min reminders
    d["middleClick"] = MiddleClick.shared.settingsJSON()
    d["aiDone"] = AiDone.shared.settingsJSON()        // Notifications > AI chat finished cards: which tools are on (AiDone.swift)
    d["autoApprove"] = AutoApprove.shared.settingsJSON()   // Sentry mode > Auto approve: switches, state and log (AutoApprove.swift)
    d["appName"] = AppRename.shared.settingsJSON()   // Mac settings > App name (AppRename.swift, V1.36)
    d["islandMoved"] = Island.shared.moved            // Mac settings > Dynamic Island: moved off the top centre (G Squad)
    // V1.58: away from its right click menu, until when (ms): the island settings say so and offer Show it now.
    d["islandAway"] = Island.shared.away.map { ["kind": $0.kind.rawValue, "until": ($0.until * 1000).rounded()] as [String: Any] } ?? NSNull()
    d["mailSend"] = MailSend.shared.settingsJSON()    // Reply from PS: which accounts can send, never a token or a key
    d["proton"] = ProtonBridge.shared.settingsJSON()   // Proton Mail through Bridge: linked or not, the problem if any, never the password
    d["tgBot"] = TelegramBot.shared.settingsJSON()    // Add Telegram Bot: a key kept here or not and the reader's status, never the key
    d["taskApi"] = TaskApi.shared.settingsJSON()      // AI task API: on, listening, the switches, the key's last 4 characters, never the key
    d["ignoredApps"] = w.ignoredApps.map { ["id": $0, "name": name($0)] }
    d["runningApps"] = NSWorkspace.shared.runningApplications
      .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil && $0.bundleIdentifier != Bundle.main.bundleIdentifier && !Protected.matches($0) }
      .map { ["id": $0.bundleIdentifier!, "name": $0.localizedName ?? $0.bundleIdentifier!] }
      .sorted { ($0["name"] ?? "") < ($1["name"] ?? "") }
    guard let data = try? JSONSerialization.data(withJSONObject: ["type": "psSettings", "data": d]),
          let json = String(data: data, encoding: .utf8) else { return }
    sendToMain(json); sendToOverlay(json)   // the Tab list's Mac settings (V1.23) shows them too
    secondWin.send(json)
  }

  func loadMain() {
    if ProjectSetup.shared.holding { return }   // no page until this Mac knows its Supabase project (ProjectSetup.swift)
    loadedIndex = readText(webRoot().appendingPathComponent("index.html"))
    main.load(URLRequest(url: URL(string: "ps://app/client/")!))
    secondWin.reloadPage()   // an open Second Computer window must not keep the old build (1 Nov 2026)
    replyWin.reloadPage()    // the Reply window too (only while nothing shows in it)
  }

  func checkLocalUpdate() {
    let now = readText(webRoot().appendingPathComponent("index.html"))
    guard !now.isEmpty, now != loadedIndex else { updateSeen = nil; return }
    if updateSeen == nil { updateSeen = Date() }
    main.evaluateJavaScript("window.__psUpdateReady = true", completionHandler: nil)
    window.subtitle = "New version ready: click the refresh button"
    // The overlay holds no state of its own, so it can simply reload (once per build).
    if !shown && !kept && now != overlayIndex { overlayIndex = now; overlay.load(URLRequest(url: URL(string: "ps://app/client/overlay")!)) }
    autoReload()
  }

  /// Why an auto reload must wait right now, or nil when it is safe. The developer (17 Oct): new features
  /// must run without clicking refresh, but never while the Tab list is up, while he is typing in
  /// PS, or when the reload could not sign him straight back in.
  static func reloadBlocker(listUp: Bool, remembered: Bool, active: Bool, sinceKey: TimeInterval) -> String? {
    if listUp { return "Tab list showing" }
    if !remembered { return "no Remember me" }
    if active && sinceKey < 30 { return "typing in PS" }
    return nil
  }

  /// Reloads both pages on a newer build when safe; the 20 second check tries again otherwise.
  /// After the reload the page says "ready" and the Remember me keys sign it in silently.
  func autoReload() {
    func wait(_ why: String) {
      if why != updateWait { updateWait = why; psLog("PS update: newer web build, waiting (\(why))") }
    }
    if selfTest { return wait("self test") }
    if let why = App.reloadBlocker(listUp: shown || kept, remembered: Remember.cachedExists,
                                   active: NSApp.isActive, sinceKey: Date().timeIntervalSince(lastKeyAt)) { return wait(why) }
    // Text typed into a box and not saved yet (only whether one exists, never what it says).
    // Waits for it up to 10 minutes; past that the rules above are enough.
    let draft = """
      (() => { const a = document.activeElement; if (!a) return false;
        if (a.isContentEditable) return (a.textContent || "").trim().length > 0;
        if (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "range"].includes(a.type))) return a.value.trim().length > 0;
        return false; })()
      """
    main.evaluateJavaScript(draft) { [weak self] r, _ in
      guard let self else { return }
      let fresh = Date().timeIntervalSince(self.updateSeen ?? Date()) < 600
      if (r as? Bool) == true && fresh { return wait("unsaved text in a box") }
      // Things may have changed while the page answered.
      if let why = App.reloadBlocker(listUp: self.shown || self.kept, remembered: Remember.cachedExists,
                                     active: NSApp.isActive, sinceKey: Date().timeIntervalSince(self.lastKeyAt)) { return wait(why) }
      let now = readText(webRoot().appendingPathComponent("index.html"))
      guard !now.isEmpty, now != self.loadedIndex else { return }
      psLog("PS update: auto reload to the newer web build (waited \(Int(Date().timeIntervalSince(self.updateSeen ?? Date())))s)")
      self.updateWait = ""; self.updateSeen = nil
      if self.window.subtitle.hasPrefix("New version") { self.window.subtitle = "" }
      self.loadMain()
      if now != self.overlayIndex { self.overlayIndex = now; self.overlay.load(URLRequest(url: URL(string: "ps://app/client/overlay")!)) }
    }
  }

  // Does the website run newer code than PS? Both builds write version.json from the same source.
  /// Native requests give up within seconds (18 Oct 2026: one sat 180 s on a stalled VPN path).
  static let quick: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.timeoutIntervalForRequest = 10
    c.timeoutIntervalForResource = 15
    c.waitsForConnectivity = false
    return URLSession(configuration: c)
  }()
  /// Only for the developer's own account (Owner.red): the hint is for him, and nobody else's PS looks at cincee.com for it.
  /// Not while "Check for updates every" is Off (no automatic looks at all).
  func checkWebsite() {
    guard Owner.red, !Updater.shared.autoOff else {
      if window.subtitle.hasPrefix("The website") { window.subtitle = "" }
      return
    }
    var req = URLRequest(url: WEBSITE_VERSION, timeoutInterval: 10)
    req.cachePolicy = .reloadIgnoringLocalCacheData
    App.quick.dataTask(with: req) { [weak self] data, resp, _ in
      guard let self, let data, (resp as? HTTPURLResponse)?.statusCode == 200,
            let remote = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let local = try? JSONSerialization.jsonObject(with: Data(contentsOf: webRoot().appendingPathComponent("version.json"))) as? [String: Any],
            let rs = remote["src"] as? String, let ls = local["src"] as? String,
            let rb = remote["built"] as? String, let lb = local["built"] as? String else { return }
      DispatchQueue.main.async {
        if rs != ls && rb > lb && Owner.red { self.window.subtitle = "The website has newer changes. Ask Claude to update PS app." }
        else if self.window.subtitle.hasPrefix("The website") { self.window.subtitle = "" }
      }
    }.resume()
  }

  // MARK: overlay

  func setupOverlay() {
    panel = OverlayPanel(contentRect: NSScreen.main?.frame ?? .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.level = .statusBar
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]   // transient: Mission Control hides it (it is always on screen, invisible)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    // Clicking a task no longer pins the list open: letting go of Tab always closes it (the developer, 15 Oct).
    panel.onMouseDown = {}

    panel.acceptsMouseMovedEvents = true
    // The blur is its own layer behind the page, so the glass slider can fade it without ever
    // dimming the list itself.
    let blur = MouseFeed()
    panel.contentView = blur
    let glass = NSVisualEffectView(frame: blur.bounds)
    glass.autoresizingMask = [.width, .height]
    glass.material = .hudWindow
    glass.blendingMode = .behindWindow
    glass.state = .active
    glass.appearance = NSAppearance(named: .darkAqua)
    glass.alphaValue = CGFloat(max(0, min(1, (UserDefaults.standard.object(forKey: "overlayBackdrop") as? Double ?? 50) / 50)))
    blur.addSubview(glass)
    backdropView = glass

    overlay = ClickThroughWebView(frame: blur.bounds, configuration: config())
    overlay.autoresizingMask = [.width, .height]
    PageSwipe.install(overlay)   // V1.55: tells the Tab list when the fingers touch and lift (PageSwipe.swift)
    // Files dropped on the Second panel go to the other Mac (SecondDrop.swift): only while Second Computer is on (PS 1.65).
    (overlay as? SecondDropWebView)?.takeSecondDrops()
    (overlay as? SecondDropWebView)?.takeAlarmDrops()   // V1.47: audio files dropped on the alarm playlist (everyone)
    // V1.47: files and folders dropped on the Tab list while the Soundboard is open go to it (Soundboard.swift). Everyone's.
    (overlay as? SecondDropWebView)?.takeSoundboardDrops()
    overlay.setValue(false, forKey: "drawsBackground")
    overlay.underPageBackgroundColor = .clear
    if selfTest {
      // The test copy's window is invisible (alpha 0), which WebKit treats as covered and stops
      // drawing frames; the per look picture checks need real frames (test only, WebKit SPI).
      let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
      if overlay.responds(to: sel) {
        typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(overlay.method(for: sel), to: SetBool.self)(overlay, sel, false)
      }
    }
    overlay.navigationDelegate = self
    overlay.uiDelegate = self
    blur.addSubview(overlay)
    blur.target = overlay
    overlayIndex = readText(webRoot().appendingPathComponent("index.html"))
    overlay.load(URLRequest(url: URL(string: "ps://app/client/overlay")!))
    // The list stays on screen at all times, invisible and click-through, so macOS never puts the
    // page to sleep: it appears instantly with its sounds and animations already running.
    panel.alphaValue = 0
    panel.ignoresMouseEvents = true
    panel.orderFrontRegardless()
    tuck()
  }
  /// While hidden, the list's window shrinks to one invisible pixel in a corner. It stays awake
  /// (so it appears instantly) but no longer covers the screen, which had hidden the desktop
  /// previews in Mission Control. showOverlay() sizes it back to the screen.
  func tuck() {
    let f = (NSScreen.main ?? NSScreen.screens.first)?.frame ?? .zero
    panel.setFrame(NSRect(x: f.minX, y: f.minY, width: 1, height: 1), display: false)
  }
  /// Sleep mode or the Sentry mode cover is up (read by the keyboard tap for its Esc and by SafePeek, like `shown`).
  var sleepUp: Bool { SleepScreen.shared.isUp || Sentry.shared.isUp }
  /// True while the list is actually showing (the window itself is always there, invisible).
  var shown = false { didSet { if oldValue != shown { SafePeek.shared.refresh(); if shown { Updater.shared.listShown() } } } }

  func showOverlay() {
    if Sentry.shared.isUp { TabWatch.shared.noteOnce("PS tab: the list stays hidden while Sentry mode is engaged"); return }   // Sentry.swift (V1.48)
    if SleepScreen.shared.isUp { TabWatch.shared.noteOnce("PS tab: the list stays hidden while Sleep mode is up (Wake up first)"); return }   // Sleep mode is up (SleepScreen.swift)
    let mouse = NSEvent.mouseLocation
    let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
    if let f = screen?.frame { panel.setFrame(f, display: false) }
    // Screen fit (V1.40, ScreenFit.swift): the page zoom for this screen, and the page told about it (size, menu bar
    // or notch for --safe-top, the Dock, the backing scale).
    if let screen { ScreenFit.apply(overlay, ScreenFit.Info(screen)) }
    pushState(opening: true)
    pushIsland(opening: true)   // V1.53: the buttons already clear of the island as the list appears, no slide
    sendToMain(#"{"type":"sync"}"#)
    Popup.shared.hide(giveBack: false)   // the list is up: the "PS app is active" card has done its job
    Toast.shared.reveal(true)            // holding Tab shows the meeting cards hidden during a meeting
    shown = true
    if vaultUnlocked { SetupIsland.shared.listShown() }   // V1.58 setup island: "Hold Tab to see your list" done
    panel.ignoresMouseEvents = selfTest   // a self test copy never catches the developer's clicks
    clickThrough = selfTest
    panel.orderFrontRegardless()
    // Key, without activating PS: the page then gets real hover (tasks light up, time zones open,
    // hover ticks) straight away instead of only after a click. Focus goes back to your app on hide.
    // Over 1Password or Signal the list never takes the keyboard: it stays theirs (hover comes from
    // MouseFeed instead), so nothing typed there can ever land in PS.
    if !Protected.front && !selfTest { panel.makeKey() }
    NSAnimationContext.runAnimationGroup { $0.duration = 0.07; panel.animator().alphaValue = selfTest ? 0 : 1 }
  }

  // MARK: keep overlay (the tick above the glass slider): the list stays up over other apps, eg a
  // video. Clicks land on the list where the list is, and go straight through to the app behind
  // everywhere else (the page sends the rectangles of everything it shows).
  var kept = false { didSet { if oldValue != kept { SafePeek.shared.refresh() } } }
  private(set) var hitRects: [NSRect] = []
  private var keepMonitors: [Any] = []
  func setKeep(_ on: Bool, stay: Bool = false) {
    guard on != kept else { return }
    kept = on
    if on {
      TabWatch.shared.pinned = true
      let g = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] _ in self?.updateClickThrough() }
      let l = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged]) { [weak self] e in self?.updateClickThrough(); return e }
      keepMonitors = [g, l].compactMap { $0 }
      updateClickThrough()
    } else {
      keepMonitors.forEach { NSEvent.removeMonitor($0) }
      keepMonitors = []
      hitRects = []
      // V1.57 (KeepCore): leaving Edit keeps the list up, pinned, until the next Tab or a click on empty space.
      // Clicks land on the list everywhere again, so the page's own background click can close it.
      if KeepCore.off(stay: stay, shown: shown) == .stayPinned {
        let w = TabWatch.shared
        w.mu.lock(); w.pinned = true; w.mu.unlock()
        panel.ignoresMouseEvents = selfTest
        clickThrough = selfTest
        overlay.evaluateJavaScript("var o=document.querySelector('.tm-overlay');if(o)o.removeAttribute('data-mouse-out')", completionHandler: nil)
        keepOpen()
        if selfTest { print("KEEP OFF: stays, pinned") }
      } else {
        hideOverlay(force: true)
      }
    }
  }
  func setHitRects(_ list: [[Double]]) {
    hitRects = list.compactMap { $0.count == 4 ? NSRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
    updateClickThrough()
  }
  /// Whether clicks go through to the app behind (the panel's own flag stays on in a self test).
  var clickThrough = true
  /// `at` (page coordinates) is for the self test; normally the real mouse position is used.
  func updateClickThrough(at test: NSPoint? = nil) {
    guard kept, shown else { return }
    if selfTest && test == nil { return }   // a self test copy follows only its own test points, never the developer's real mouse
    let m = NSEvent.mouseLocation, f = panel.frame
    let p = test ?? ScreenFit.toPage(NSPoint(x: m.x - f.minX, y: f.maxY - m.y), overlay)   // page coordinates, top left origin (V1.40: over the page zoom)
    let onList = hitRects.contains { $0.contains(p) }
    if clickThrough == onList {
      clickThrough = !onList
      panel.ignoresMouseEvents = selfTest || !onList
      // The page gets no mouse events while the pointer is over the app behind: tell it (hover mode),
      // with an attribute React never rewrites. Coming back onto the list, the page is told where
      // the mouse is straight away, so the part under it lights up without waiting for another move.
      let flag = "var o=document.querySelector('.tm-overlay');if(o){if(\(!onList))o.setAttribute('data-mouse-out','');else o.removeAttribute('data-mouse-out')}"
      overlay.evaluateJavaScript(flag + ";" + (onList ? MouseFeed.feed + "(\(Int(p.x)),\(Int(p.y)))" : MouseFeed.leave), completionHandler: nil)
    }
  }

  // The glass slider: how much of the screen behind shows through (0 clear, 100 solid).
  // Up to the default (50) the blur fades in; past it the page's own tint turns solid.
  var backdropView: NSVisualEffectView?
  func applyBackdrop(_ v: Double, save: Bool) {
    guard let view = backdropView else { return }
    let a = CGFloat(max(0, min(1, v / 50)))
    // Small steps (dragging the slider) go straight on; jumps (reset, Hover mode) fade.
    if abs(view.alphaValue - a) > 0.15 { NSAnimationContext.runAnimationGroup { $0.duration = 0.22; view.animator().alphaValue = a } }
    else { view.alphaValue = a }
    if save { UserDefaults.standard.set(v, forKey: "overlayBackdrop") }
  }
  /// Tab+1: the overlay page opens its Add task window (it then asks for the keyboard itself).
  func openAddTask() {
    psLog("PS tab: Tab+1, add task")
    overlay.evaluateJavaScript("window.__psAddTask && window.__psAddTask()", completionHandler: nil)
  }
  /// Dimension X (the big planning screen inside the list) is open: the first Esc closes only it.
  var dimxOpen = false
  /// A screen in the list is pinned (double click on its top bar). It comes back with the list on
  /// every hold of Tab or /, and opening a screen no longer keeps the list up when the key is let go.
  var screenPinned = false
  /// Self test: every message type the list sent (to prove hovering sends nothing).
  var testLog: [String] = []
  /// Self test: the full text of the list's reorder and drop messages (to check Priority 1 is set).
  var testRaw: [String] = []
  /// Esc from the keyboard tap, PS's own key monitor (the tap off) or the Signal hotkey. V1.41 (the developer, 8 Nov 2026: "No
  /// matter what screen you're on, no matter what's going on in the PS app, make sure the escape button always works
  /// to back you out of the PS app, no matter what."), the rules in web src/core/escape.ts:
  ///  - Sleep mode up: it leaves at once (no Touch ID) and PS locks (SleepScreen.escape).
  ///  - The list up: the page closes its top screen or pop-up (window.__psEscape) and the list stays; with nothing
  ///    open the list goes and the keyboard goes back to the app you were in.
  ///  - The page busy or broken (no answer in EscRules.pageWait) or Esc pressed 3 times quickly: the list goes anyway.
  func escKey() {
    if Sentry.shared.isUp { Sentry.shared.escape(); return }   // V1.48: Esc locks the Mac at once (Sentry.swift)
    if SleepScreen.shared.isUp { SleepScreen.shared.escape(); return }
    if HelperAlert.shared.escape() { return }   // V1.49: the restart helper pop up closes (until the next check)
    if Soundboard.shared.escape() { return }   // V1.47: a timed Soundboard play ringing stops first
    if Toast.shared.escapeStack() { return }   // PS 1.65: a notification list a click is keeping open closes
    guard shown else { escapeOut(); return }
    let now = CACurrentMediaTime()
    escTimes = escTimes.filter { now - $0 < EscRules.burst } + [now]
    if escTimes.count >= EscRules.burstCount {
      escTimes = []
      psLog("PS esc: pressed \(EscRules.burstCount) times, the list goes")
      escapeOut(); return
    }
    escSeq += 1
    let seq = escSeq
    var settled = false
    let finish: (Bool, String?) -> Void = { [weak self] stepped, why in
      guard let self, !settled, seq == self.escSeq else { return }
      settled = true
      if stepped && self.shown { return }      // the page keeps dimxOpen right with its own "dimx" messages
      if let why { psLog("PS esc: \(why), the list goes") }
      self.escapeOut()
    }
    let js = "if (window.__psEscape) return await window.__psEscape(); return !!(window.__psDimxClose && window.__psDimxClose());"
    overlay.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
      if case .success(let v) = r { finish((v as? Bool) == true, nil) } else { finish(false, "the page could not answer") }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + EscRules.pageWait) { finish(false, "the page did not answer in time") }
  }
  private var escTimes: [CFTimeInterval] = []
  private var escSeq = 0
  /// V1.41: Esc inside one of PS's own windows that the keyboard tap did not take first (the tap is off while macOS
  /// Secure Input is on, or it failed). Only PS's own windows reach this monitor, so no key typed in another app
  /// (1Password and Signal included) is ever seen here. True: the Esc was PS's and is used up.
  func localEsc(_ e: NSEvent) -> Bool {
    guard e.type == .keyDown, e.keyCode == 53 else { return false }
    if Sentry.shared.isUp { Sentry.shared.escape(); return true }   // V1.48 Sentry mode: Esc locks the Mac at once
    if SleepScreen.shared.isUp { SleepScreen.shared.escape(); return true }
    if HelperAlert.shared.escape() { return true }   // V1.49: the restart helper pop up
    if Soundboard.shared.escape() { return true }   // V1.47: a timed Soundboard play ringing
    if Toast.shared.escapeStack() { return true }   // PS 1.65: a notification list a click is keeping open closes
    guard let w = e.window ?? NSApp.keyWindow else { return false }
    switch EscRules.native(for: w, panel: panel, signIn: window) {
    case .list: escKey()
    case .own: return false                         // the window answers Esc itself (Torch, Second Computer questions)
    case .ays: AreYouSure.shared.escape()
    case .reminder: Reminders.shared.escape(w)
    case .posture: Posture.shared.escape()
    case .card: Toast.shared.escape()
    case .signIn: hideEngineWindow()
    case .close: w.performClose(nil)
    case .letGo: if w.isKeyWindow { w.resignKey() }
    }
    return true
  }
  /// Tab keeps the list open: the hold was let go and the list stays (TabWatch.released). It keeps the
  /// keyboard, so typing and clicks in it work as they do while Tab is held. Never over 1Password or
  /// Signal (their keyboard stays theirs), never in a test copy. Hidden meanwhile: nothing is kept.
  func keepOpen() {
    let w = TabWatch.shared
    guard shown else { w.mu.lock(); w.pinned = false; w.mu.unlock(); return }
    if !Protected.front && !selfTest { panel.makeKey() }
  }
  /// A screen pinned or unpinned by double clicking its top bar (web src/ui/pin.ts).
  func pinChanged(_ on: Bool) {
    screenPinned = on
    // Pinned while Tab (or /) is held: letting go now hides the list and the screen, like any hold
    // (with Tab keeps the list open on, letting go keeps both up instead, TabWatch.released).
    let w = TabWatch.shared
    w.mu.lock()
    if screenPinned && w.state == .showing && !kept { w.pinned = false }
    w.mu.unlock()
    if selfTest { print("PIN FLAG:", screenPinned ? "on" : "off", "listPinned=\(w.pinned)") }
  }
  /// The padlock's lock (Lock button, and Esc out of Sleep mode since V1.41): the page locks the vault, the remembered
  /// keys become the locked Keychain item, so the next Tab hold asks for Touch ID or the Mac password.
  func lockPS(popup: Bool) {
    sendToMain(#"{"type":"lock"}"#); hideOverlay(force: true)
    DispatchQueue.global(qos: .userInitiated).async { TouchLock.lock(); DispatchQueue.main.async { self.sendRememberStatus(); if popup && !self.selfTest { self.showPopup() } } }   // the pop-up says it is locked
  }
  /// The failsafe: Esc (or clicking PS in the Dock) always puts the list away, Keep and Hover mode off.
  func escapeOut() {
    overlay.evaluateJavaScript("window.__psUnkeep && window.__psUnkeep()", completionHandler: nil)
    hideOverlay(force: true)
  }

  /// giveBack: hand the keyboard back to the app the developer was in (not when a PS window or question comes next).
  func hideOverlay(force: Bool = false, giveBack: Bool = true) {
    if kept && !force { return }          // kept up: only the Keep overlay tick (or locking) closes it
    SleepSound.shared.stopTest()   // V1.44: an alarm Test never plays on after the Tab list goes away
    Reminders.shared.stopTest()    // V1.46: nor does a reminder Test card
    if kept { kept = false; keepMonitors.forEach { NSEvent.removeMonitor($0) }; keepMonitors = []; hitRects = [] }
    TabWatch.shared.pinned = false
    TabWatch.shared.editing = false
    Island.shared.setEditing(false)       // the Tab list's Edit mode ends with the list (views/EditMode.tsx)
    dimxOpen = false
    NetMonitor.shared.listHidden()
    Toast.shared.reveal(false)
    guard shown else { return }
    shown = false
    panel.ignoresMouseEvents = true
    clickThrough = true
    overlay.evaluateJavaScript("window.__psOverlayHidden && window.__psOverlayHidden()", completionHandler: nil)
    NSAnimationContext.runAnimationGroup({ $0.duration = 0.06; panel.animator().alphaValue = 0 }) { [weak self] in
      guard let self, !self.shown else { return }
      if self.panel.isKeyWindow { self.panel.resignKey() }
      self.tuck()
      // Hand the keyboard straight back to the app you were in (the list took it to get hover).
      if giveBack, !self.selfTest, let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != ProcessInfo.processInfo.processIdentifier,
         !Protected.matches(front) {   // golden rule: never touch 1Password or Signal
        front.activate(options: [])
      }
    }
  }

  /// V1.53 island clearance (the developer, 12 Nov 2026: "the dynamic island is STILL over the top two buttons"): where the
  /// Dynamic Island's shape is over the list, in points from the list window's top left, with the window's size (the
  /// page scales it by its own zoom: src/ui/islandspot.ts, src/core/islandclear.ts). null when the island is not on
  /// this screen or not showing. Only while the list is up, and once as it opens (opening: placed at once, no glide).
  func pushIsland(opening: Bool = false) {
    guard shown || opening else { return }
    let f = panel.frame
    var spot = "null"
    if f.width > 200, f.height > 200, let r = Island.shared.shapeOnScreen(), r.intersects(f) {
      spot = String(format: "{\"x\":%.1f,\"y\":%.1f,\"w\":%.1f,\"h\":%.1f,\"vw\":%.1f,\"vh\":%.1f}",
                    r.minX - f.minX, f.maxY - r.maxY, r.width, r.height, f.width, f.height)
    }
    overlay.evaluateJavaScript("window.__psIslandNow = \(spot); window.__psIsland && window.__psIsland(window.__psIslandNow, \(opening))", completionHandler: nil)
  }

  /// opening: the list is being shown right now (its pop-in plays and its backgrounds start).
  /// Every other push (new data while it is up or hidden) changes only the words: no blink.
  func pushState(opening: Bool = false) {
    guard let s = lastState else { return }
    // Whether this Mac's screen has a notch, for the Dynamic Island menu (a Mac without one shows the pill).
    if opening { overlay.evaluateJavaScript("window.__psNotch = \(IslandGeo.read().0.notch)", completionHandler: nil) }
    overlay.callAsyncJavaScript("window.__psOverlay && window.__psOverlay.load(JSON.parse(s), o)", arguments: ["s": s, "o": opening], in: nil, in: .page, completionHandler: nil)
    secondWin.load(s)
  }

  func sendToMain(_ json: String) {
    main.callAsyncJavaScript("window.__ps && window.__ps.apply(JSON.parse(m))", arguments: ["m": json], in: nil, in: .page, completionHandler: nil)
  }
  /// A card's Dismiss or Remind me in must reach the page (the developer, 3 Nov 2026: dismissed cards kept coming back).
  /// While the main page loads (an update reload, a wake) window.__ps is not there yet: the answer was dropped,
  /// the card stayed in the vault and came back at the next resync. It is tried again every second for a minute.
  func sendCardAction(_ json: String, tries: Int = 0) {
    main.callAsyncJavaScript("if (!window.__ps) return false; window.__ps.apply(JSON.parse(m)); return true", arguments: ["m": json], in: nil, in: .page) { [weak self] r in
      if case .success(let v) = r, (v as? Bool) == true { return }
      guard tries < 60 else { return }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self?.sendCardAction(json, tries: tries + 1) }
    }
  }

  // MARK: bridge (in memory only)

  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let text = message.body as? String,
          let msg = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
          let type = msg["type"] as? String else { return }
    // The Second Computer window (SecondWindow.swift) holds no keys: its own messages, or a few handled as the main page's.
    let fromSecondWin = secondWin.isWeb(message.webView)
    if fromSecondWin && (secondWin.handle(type, text) || !SecondWindow.asMain(type)) { return }   // nothing else from it reaches the cases below
    if replyWin.isWeb(message.webView) { replyWin.handle(type, msg, text); return }   // the Reply window (ReplyWindow.swift): its own messages only
    let fromMain = message.webView === main || (fromSecondWin && SecondWindow.asMain(type)), fromOverlay = message.webView === overlay
    if selfTest && fromOverlay {
      testLog.append(type == "net" ? "net:\(msg["op"] as? String ?? "")" : type)
      if ["reorder", "awareToList", "suggest", "add", "update", "tick", "work", "looks"].contains(type) || type.hasPrefix("mark-") { testRaw.append(text) }
    }
    if type.hasPrefix("torch:") && !MINECRAFT_ENABLED { return }   // Minecraft mode is off (MinecraftSwitch.swift): no torch
    if (fromMain || fromOverlay) && TorchLight.shared.handle(type, msg, from: message.webView) { return }   // torch:* (Torch.swift)
    if (fromMain || fromOverlay) && type.hasPrefix("assist:") && AssistService.shared.handle(type, msg, from: message.webView) { return }   // PS 1.65 Settings assistant (AssistProviders.swift)
    if (fromMain || fromOverlay) && SleepSound.shared.handle(type, msg) { return }
    if (fromMain || fromOverlay) && AlarmListStore.shared.handle(type, msg) { return }   // V1.47 alarm playlists
    if (fromMain || fromOverlay) && type.hasPrefix("rem:") && Reminders.shared.handle(type, msg) { return }    // reminders: own sounds, Test (Reminders.swift)    // V1.44 alarm sound: own sound, Test (SleepSound.swift)
    if fromMain && type.hasPrefix("posture:") && Posture.shared.handle(type, msg) { return }    // the Posture reminder: sensor on or off, show, hide (Sources/Posture.swift, PS 1.65)
    if (fromMain || fromOverlay) && SleepScreen.shared.handle(type, msg) { return }   // sleep:* Sleep mode (SleepScreen.swift, V1.40)
    if (fromMain || fromOverlay) && Sentry.shared.handle(type, msg) { return }   // sentry:* Sentry mode (Sentry.swift, V1.48)
    if (fromMain || fromOverlay) && ProtonBridge.shared.handle(type, msg, fromMain: fromMain, fromOverlay: fromOverlay) { return }   // proton:* Proton Mail through Bridge (ProtonBridge.swift, PS 1.65)
    if (fromMain || fromOverlay) && TelegramBot.shared.handle(type, msg, fromMain: fromMain, fromOverlay: fromOverlay) { return }   // tg:* Add Telegram Bot (TelegramBot.swift, V1.47)
    if (fromMain || fromOverlay) && TaskApi.shared.handle(type, msg, fromMain: fromMain, fromOverlay: fromOverlay) { return }   // api:* AI task API (TaskApi.swift)
    if (fromMain || fromOverlay) && type.hasPrefix("sb:") && Soundboard.shared.handle(type, msg, from: message.webView) { return }   // V1.47 Soundboard (Soundboard.swift)
    if fromMain && Features.handle(type, msg) { return }   // V1.61: the page's feature answers (Features.swift), so Features.on follows the page
    switch type {
    case "state" where fromMain && !(selfTest && testHoldState):
      lastState = msg["payload"] as? String
      let now = msg["unlocked"] as? Bool ?? false
      if vaultUnlocked && !now { hideOverlay(force: true) }   // signed out: Tab is left alone again
      let justUnlocked = !vaultUnlocked && now
      vaultUnlocked = now
      SetupIsland.shared.vault(unlocked: now)   // V1.58 setup island: signed in, database loaded
      updatePopup()
      if justUnlocked { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { ScreenTime.shared.send() } }
      pushState()
    case "ready" where fromMain:
      // The page that just loaded runs the build on disk (also after its own refresh button).
      let disk = readText(webRoot().appendingPathComponent("index.html"))
      if !disk.isEmpty && disk != loadedIndex {
        loadedIndex = disk; updateSeen = nil; updateWait = ""
        if window.subtitle.hasPrefix("New version") { window.subtitle = "" }
      }
      sendTabState(force: true)
      sendRememberStatus()
      SetupIsland.shared.pageReady(remembered: Remember.cachedExists, unlocked: vaultUnlocked)
      Updater.shared.pageReady()       // just updated: healthy once the keyboard tap is up too
      // "Remember me": signed in before on this Mac, so open silently (launch, restart, update refresh).
      // Just updated: the sign in may still be coming from the old build, so ask again once it is here.
      if !selfTest && UpdateHandoff.pending {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
          UpdateHandoff.waitDone(30); Remember.refresh(); TouchLock.refresh()
          DispatchQueue.main.async { self?.sendRememberStatus(); self?.openRemembered() }
        }
      } else { openRemembered() }
    case "log" where fromMain || fromOverlay:   // a short status line from the page (never data)
      if let t = msg["text"] as? String { psLog("PS page: " + String(t.prefix(200))) }
    case "remember:save" where fromMain:
      if !selfTest, let u = msg["username"] as? String, let a = msg["auth"] as? String, let k = msg["kek"] as? String,
         let d = try? JSONSerialization.data(withJSONObject: ["username": u, "auth": a, "kek": k]) {
        DispatchQueue.global(qos: .userInitiated).async { Remember.save(d); DispatchQueue.main.async { self.sendRememberStatus() } }   // Keychain off main
      }
    case "remember:forget" where fromMain:   // signed in with "Remember me" unticked
      if !selfTest { DispatchQueue.global(qos: .userInitiated).async { Remember.forget(); DispatchQueue.main.async { self.sendRememberStatus() } } } else { sendRememberStatus() }
    case "signout":                           // Settings > Sign out of this Mac: both items deleted
      guard fromMain || fromOverlay else { break }
      Owner.set(false)
      sendToMain(#"{"type":"lock"}"#); hideOverlay(force: true)
      DispatchQueue.global(qos: .userInitiated).async { TouchLock.signOut(); DispatchQueue.main.async { self.sendRememberStatus(); if fromOverlay { self.showPopup() } } }
    case "nuke":                              // the rule book: a rule marked Failed at the end of the day (Nuke.swift)
      guard fromMain || fromOverlay else { break }
      Nuke.run(self)
    // "rules:show" (the end of day card's rule check) left with that card on 2 Nov 2026: PS never asks to end the day.
    case "signin:show" where fromOverlay:     // the Tab list while locked or signed out: Sign in / Use my passphrase
      hideOverlay(force: true)
      showSignIn()
    case "signin:size" where fromMain:        // the Sign in page's height: the window takes it (no scrollbar)
      if let h = msg["h"] as? Double { setSignInHeight(CGFloat(h)) }
    case "signin:done" where fromMain:        // the page is past its sign in (and any new recovery key): the window can go
      finishSignIn()
    case "psStatus" where fromMain:           // the pop-up's status: synced, next meeting (src/psstatus.ts)
      if let st = msg["state"] as? [String: Any] { Popup.shared.update { $0.take(st) }; if selfTest { testStatusSeen += 1 } }
    case "lock:mac":                          // Lock button (main window, overlay): Touch ID opens it again
      guard fromMain || fromOverlay else { break }
      lockPS(popup: fromOverlay)
    case "touchid:unlock" where fromMain || fromOverlay:
      touchUnlock()
    case "tab:set":
      if fromMain || fromOverlay { setTab(msg["enabled"] as? Bool ?? true) }
    case "tab:permission" where fromMain || fromOverlay:
      TabWatch.shared.askPermission(force: true)
    case "tab:fix" where fromMain || fromOverlay:
      fixPermission()
    case "psSettings:trigger" where fromMain || fromOverlay:
      if let k = msg["key"] as? String, ["tab", "rightOption"].contains(k) { TabWatch.shared.triggerKey = k; SafePeek.shared.refresh(); logTabStatus("key changed"); sendSettings() }
    // V1.47 Tab overlay shortcuts (OpenKeysCore.swift), clicks in Settings only. The list is checked here again: a
    // list with an error is never saved, and there is always at least one shortcut.
    case "shortcuts:set" where fromMain || fromOverlay:
      setShortcuts(msg["list"])
    case "shortcuts:reset" where fromMain || fromOverlay:        // Reset to Tab: hold Tab and / then . , as a new user
      let w = TabWatch.shared
      w.triggerKey = "tab"
      w.mu.lock(); w.slashOn = true; w.mu.unlock()
      w.setCustom(nil, save: true)
      logTabStatus("shortcuts reset to Tab"); sendSettings(); sendTabState(force: true)
    case "shortcuts:record" where fromMain || fromOverlay:       // Record shortcut: the keys go to the page, combos rest
      recordShortcut(msg["on"] as? Bool ?? false)
    case "psSettings:tabStays" where fromMain || fromOverlay:     // Tab keeps the list open, Mac settings (click only)
      if let on = msg["on"] as? Bool { TabWatch.shared.setStays(on); logTabStatus("Tab keeps the list open \(on ? "on" : "off")"); sendSettings() }
    case "psSettings:slash" where fromMain || fromOverlay:        // hold / and press . , PS > Settings (click only)
      if let on = msg["on"] as? Bool { TabWatch.shared.mu.lock(); TabWatch.shared.slashOn = on; TabWatch.shared.mu.unlock(); logTabStatus("slash chord \(on ? "on" : "off")"); sendSettings() }
    case "afk" where fromMain || fromOverlay:                  // PS > Settings > AFK timer (Sources/Afk.swift)
      Afk.shared.handle(msg)
    case "afk" where fromOverlay:               // the Tab list's gear: AFK timer On or Off, nothing else from there
      if let on = msg["on"] as? Bool { Afk.shared.handle(["on": on]) }
    case "ays" where fromMain || fromOverlay:                  // PS > Settings > Are you sure (Sources/AreYouSure.swift)
      AreYouSure.shared.handle(msg)
    case "aysMeeting" where fromMain:           // a calendar meeting with attendees or a Meet link is on (or over)
      AreYouSure.shared.setMeeting(msg["on"] as? Bool ?? false)
      Reminders.shared.setMeeting(msg["on"] as? Bool ?? false)
    case "afkMeetings" where fromMain:          // calendar meeting windows: no AFK card in them, and they are not away (Sources/MeetingTime.swift)
      if MeetingTime.shared.set(msg["windows"]) { psLog("PS afk: meeting times updated (\((msg["windows"] as? [Any])?.count ?? 0))") }
    case "rem:plan" where fromMain:                            // the Annoying 15 min reminders' plan (Sources/Reminders.swift)
      Reminders.shared.setPlan(msg["plan"])
    case "mediaGuard" where fromMain || fromOverlay:           // PS > Settings > AirPods controls card (Sources/MediaGuard.swift)
      MediaGuard.shared.handle(msg); sendSettings()
    case "middleClick" where fromMain || fromOverlay:          // PS > Settings > Force Touch middle click (Sources/MiddleClick.swift)
      MiddleClick.shared.handle(msg); sendSettings()
    case "aiDone:set" where fromMain || fromOverlay:           // Settings > AI chat finished cards, a click on On or Off (Sources/AiDone.swift)
      AiDone.shared.handle(msg)
    case "autoApprove:set" where fromMain || fromOverlay, "autoApprove:clearLog" where fromMain || fromOverlay, "autoApprove:noticed" where fromMain || fromOverlay:   // Settings > Sentry mode > Auto approve (AutoApprove.swift)
      AutoApprove.shared.handle(msg)
    case "aiDone:taken" where fromMain:                        // those finished chats are in the vault now: their files go
      if let keys = msg["keys"] as? [String] { AiDone.shared.taken(Array(keys.prefix(100))) }
    case "psSettings:helperRemind" where fromMain || fromOverlay:   // Security > Remind me to set up the restart helper (HelperAlert.swift)
      if let on = msg["on"] as? Bool { HelperAlert.shared.setRemind(on); sendSettings() }
    case "psSettings:screenTime" where fromMain || fromOverlay:   // the switch in PS > Settings, or Turn on in the screen time pop-up
      if let on = msg["on"] as? Bool { ScreenTime.shared.enabled = on; sendSettings() }
    case "screentime:send" where fromMain:          // the page asks for the latest totals (opening the card)
      ScreenTime.shared.send()
    case "psSettings:ignore" where fromMain || fromOverlay:
      if let ids = msg["ids"] as? [String] { TabWatch.shared.ignoredApps = ids; sendSettings() }
    case "appName:set" where fromMain || fromOverlay:            // Mac settings > App name, a click on Rename only (AppRename.swift)
      AppRename.shared.set(String((msg["name"] as? String ?? "").prefix(200))) { [weak self] in self?.sendSettings() }
    case "update" where fromOverlay && selfTest && (msg["patch"] as? [String: Any])?["subOp"] != nil:
      // A mini task change: the test copy has no vault, so the list it makes goes into its test state.
      if let id = msg["id"] as? String, let subs = (msg["patch"] as? [String: Any])?["subtasks"] as? [Any], let st = lastState,
         var j = try? JSONSerialization.jsonObject(with: Data(st.utf8)) as? [String: Any], var docs = j["docs"] as? [[String: Any]],
         let i = docs.firstIndex(where: { $0["id"] as? String == id }) {
        var d = docs[i]["data"] as? [String: Any] ?? [:]
        d["subtasks"] = subs
        docs[i]["data"] = d
        j["docs"] = docs
        lastState = (try? JSONSerialization.data(withJSONObject: j)).flatMap { String(data: $0, encoding: .utf8) }
        pushState()
      }
    case "looks" where fromOverlay && selfTest:   // the test copy has no vault: save into its test state
      if let patch = msg["patch"] as? [String: Any], let st = lastState, var j = try? JSONSerialization.jsonObject(with: Data(st.utf8)) as? [String: Any],
         var docs = j["docs"] as? [[String: Any]], let i = docs.firstIndex(where: { $0["kind"] as? String == "settings" }) {
        var d = docs[i]["data"] as? [String: Any] ?? [:]
        for (k, v) in patch where k.hasPrefix("tm") || k == "theme" || k == "netMonitor" || k == "briefSeen" || k == "rules" { d[k] = v }
        if let op = patch["dndOp"] as? [String: Any] { d["dnd"] = SelfTest.dndApplyForTest(d["dnd"] as? [String: Any], op) }   // Do Not Disturb
        if let op = patch["squadOp"] as? [String: Any] { SelfTest.squadOpForTest(op, settings: &d) }   // G Squad (GSquadSelfTest.swift)
        docs[i]["data"] = d
        j["docs"] = docs
        lastState = (try? JSONSerialization.data(withJSONObject: j)).flatMap { String(data: $0, encoding: .utf8) }
        pushState()
      }
    case "overlayReady" where fromOverlay:
      pushState(opening: shown); sendTabState(force: true); sendRememberStatus()
    case "tick" where fromOverlay, "work" where fromOverlay, "reorder" where fromOverlay, "tmScale" where fromOverlay,
         "tmClockScale" where fromOverlay, "update" where fromOverlay, "remove" where fromOverlay, "aware" where fromOverlay,
         "headline" where fromOverlay, "add" where fromOverlay, "sound" where fromOverlay, "homeTz" where fromOverlay, "timelines" where fromOverlay, "timelineOrder" where fromOverlay, "timelineHidden" where fromOverlay, "meetingNotes" where fromOverlay, "suggest" where fromOverlay, "workStyle" where fromOverlay, "stHours" where fromOverlay, "awayPatch" where fromOverlay, "goals" where fromOverlay, "reset" where fromOverlay, "resetUndo" where fromOverlay, "notifyPref" where fromOverlay, "replyHandled" where fromOverlay, "inboxMin" where fromOverlay, "dimxList" where fromOverlay, "awareDone" where fromOverlay, "awareUndone" where fromOverlay, "awareToList" where fromOverlay, "p1Style" where fromOverlay, "meetPrefs" where fromOverlay, "eod" where fromOverlay, "looks" where fromOverlay:
      if ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil { print("BRIDGE:", type, msg["id"] ?? "", msg["action"] ?? "", msg["zone"] ?? "") }
      if type == "add" && ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil { SelfTest.lastAdd = msg }   // the add task check reads what was sent
      sendToMain(text)
    case "timeline:get" where fromOverlay:          // the screen time timeline, last N hours
      if let j = ScreenTime.shared.timelineJSON(hours: msg["hours"] as? Double ?? 24) { sendToOverlay(j) }
    case "presence:get" where fromOverlay:          // when the developer was last on (screen time pop-up)
      if let j = ScreenTime.shared.presenceJSON() { sendToOverlay(j) }
    case "screentime:icons" where fromOverlay:      // app icons for the screen time pop-up
      if let ids = msg["ids"] as? [String], let j = ScreenTime.shared.iconsJSON(ids) { sendToOverlay(j) }
    case "close" where fromOverlay:
      hideOverlay()
    case "keep" where fromOverlay:            // the Keep overlay tick; "stay" (V1.57, leaving Edit): the list stays up, pinned
      setKeep(msg["on"] as? Bool ?? false, stay: msg["stay"] as? Bool == true)
    case "hitRects" where fromOverlay:        // what the page shows while kept (clicks elsewhere pass through)
      setHitRects(msg["rects"] as? [[Double]] ?? [])
    case "backdrop" where fromOverlay:        // the glass slider; "save" when let go (then the vault keeps it)
      if let v = msg["v"] as? Double { applyBackdrop(v, save: msg["save"] as? Bool == true) }
      if msg["save"] as? Bool == true { sendToMain(text) }
    case "airpodsAuto" where fromOverlay:     // Tab list gear > AirPods > Switch to AirPods Max when connected
      if let b = msg["on"] as? Bool { AutoRoute.shared.setOn(b) }
      fallthrough
    case "airpodsAuto:get" where fromOverlay:
      let on = (msg["on"] as? Bool) ?? AutoRoute.shared.isOn
      overlay?.callAsyncJavaScript("window.__psAirpodsAuto && window.__psAirpodsAuto(on)", arguments: ["on": on], in: nil, in: .page, completionHandler: nil)
    case "screenrec" where fromOverlay || fromMain:   // the screen recorder (Sources/ScreenRec.swift): its own gate answers first
      ScreenRec.shared.handle(msg)
    case "mixer" where fromOverlay:           // the volume mixer pop-up (Sources/Mixer.swift); click only, except slider drags
      Mixer.shared.handle(msg)
    case "hpmode" where fromOverlay || fromMain:   // Headphones mode (Sources/Headphones.swift): the switch, its lists (synced settings.tmAudio)
      HeadphonesMode.shared.handle(msg)
    case "power:get" where MINECRAFT_ENABLED: // Minecraft mode's power out stopwatch asks for the state (Sources/PowerWatch.swift)
      PowerWatch.shared.request()
    case "airpods" where fromOverlay:         // mixer gear > Give AirPods button back to Spotify (Sources/MediaGuard.swift), click only
      MediaGuard.shared.reconfigure { [weak self] text, ok in
        self?.overlay?.callAsyncJavaScript("window.__psAirpods && window.__psAirpods(t, ok)", arguments: ["t": text, "ok": ok], in: nil, in: .page, completionHandler: nil)
      }
    case "macUpdate:get" where fromOverlay, "macUpdate:check" where fromOverlay, "macUpdate:start" where fromOverlay,
         "macUpdate:finish" where fromOverlay, "macUpdate:seen" where fromOverlay:
      Updater.shared.fromPage(type)            // the gear menu's update row (Updater.swift), real clicks only
    case "update:every" where fromOverlay:     // Settings, "Check for updates every": 5, 10, 15 or 30 minutes, or 0 = Off (Updater.setEvery)
      if let min = msg["min"] as? Int { Updater.shared.setEvery(min) }
    case "setup:can" where fromOverlay:        // V1.40: the Tab list page has the setup menu (web src/setuphook.ts)
      Updater.shared.setupCan((msg["gen"] as? Int) ?? 0)
    case "afk:get" where fromOverlay:         // the Tab list badge asks for the AFK timer's state
      Afk.shared.pushStatus()
    case "afkShow" where fromOverlay:         // a click on that badge: the full AFK card (or the Watcher card)
      Afk.shared.showFromBadge()
    case "bg:get" where fromOverlay:          // the Tab list page asks for the developer's background videos
      Backgrounds.shared.resend()
    case "second:pick" where fromOverlay:     // the Second panel's Send files: PS's Open panel (the developer's click)
      if let t = msg["target"] as? [String: Any] { Second.shared.pick(t) }
    case _ where fromMain && type.hasPrefix("second:"):   // Second Computer (Sources/Second.swift): native signs, checks and runs
      Second.shared.handle(type, msg)
    case "localCal" where fromMain || (fromOverlay && msg["op"] as? String == "settings"):
      LocalCalendar.shared.handle(msg)        // this Mac's Calendar, read only (LocalCalendar.swift); the overlay may only open its setting
    case "owner" where fromMain:              // who unlocked: the developer's own native features (Owner.swift)
      if let r = msg["red"] as? Bool {
        Owner.set(r)
        let w = TabWatch.shared   // Tab keeps the list open: its default depends on who this is
        w.mu.lock(); let was = w.stays; w.mu.unlock()
        w.loadStays()
        w.mu.lock(); let now = w.stays; w.mu.unlock()
        if was != now { sendSettings() }
      }
      ProjectSetup.shared.unlocked()
    case "project:setup" where fromMain || fromOverlay:   // Sign in or Mac settings: Connect / Change Supabase project
      if fromOverlay { hideOverlay(force: true) }
      // Local first (V1.44): from Turn on sync, the window says the list on this Mac moves into the project.
      ProjectSetup.shared.show(mode: .change, fromLocal: msg["local"] as? Bool == true)
    case "setup:store" where fromMain:         // the page's own choice (V1.44): "local" (Start now) or "sync"
      if let s = msg["store"] as? String, ["local", "sync"].contains(s), ProjectStore.current == nil { ProjectStore.setupStore = s }
    case "project:created" where fromMain:    // the first account of a linked project exists: its setup code is spent
      ProjectSetup.shared.accountCreated()
    case "localkey:get" where fromMain, "localkey:create" where fromMain, "localkey:allow" where fromMain, "localkey:forget" where fromMain:
      // Local first (LocalKey.swift): the local vault's key, Keychain work off the main thread, the answer to the page only.
      guard let req = msg["req"] as? String, req.range(of: #"^[A-Za-z0-9_-]{4,40}$"#, options: .regularExpression) != nil else { break }
      let op = String(type.dropFirst("localkey:".count))
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        var a = LocalKey.answer(op)
        a["type"] = "localkey"; a["req"] = req
        guard let d = try? JSONSerialization.data(withJSONObject: a), let j = String(data: d, encoding: .utf8) else { return }
        DispatchQueue.main.async { self?.sendCardAction(j) }
      }
    case "bg:choose" where fromOverlay:       // More settings, Background, Add video: PS's Open panel (the developer's click)
      Backgrounds.shared.pick()
    case "bg:list" where fromMain, "bg:put" where fromMain, "bg:read" where fromMain, "bg:adopt" where fromMain, "bg:status" where fromMain, "bg:progress" where fromMain:
      Backgrounds.shared.handle(type, msg)    // the vault's videos (Backgrounds.swift); files only, never keys
    case "mc" where fromOverlay && MINECRAFT_ENABLED:   // Minecraft mode: the offline translator (Sources/Minecraft.swift), clicks only
      MinecraftMode.shared.handle(msg)
    case "net" where fromOverlay:             // the network monitor (Sources/NetMonitor.swift)
      NetMonitor.shared.handle(msg)
    // Fitness (2 Nov 2026) is a screen inside the Tab list: no window of its own any more. It opens like
    // Dimension X ("dimx" below), and its saves go to the main page through "looks".
    case "dimx" where fromOverlay:            // Dimension X opened or closed inside the list
      let on = msg["open"] as? Bool ?? false
      dimxOpen = on && shown
      TabWatch.shared.editing = on
      // Open: the list stays when Tab is let go, and takes the keyboard so typing works (never over
      // 1Password or Signal: the golden rule, the list never takes their keyboard). Not while a
      // screen is pinned: then letting go of Tab or / always hides everything. Never while the list
      // is hidden (a pinned screen reopening itself after a restart must not take the keyboard).
      // PS 1.65: `quiet` (a choice notice) keeps the list up without taking the keyboard; Esc still reaches it (escape above).
      let quiet = msg["quiet"] as? Bool == true
      if on && shown { if !screenPinned { TabWatch.shared.pinned = true }; if !quiet && !Protected.front && !selfTest { panel.makeKey() } }
      if selfTest { print("DIMX FLAG:", on ? "open" : "closed") }
    case "pin" where fromOverlay:             // a screen pinned by double clicking its top bar (web src/ui/pin.ts)
      pinChanged(msg["on"] as? Bool ?? false)
    case "edit" where fromOverlay:            // typing in the floating list: keep it open, send it the keys
      let on = msg["on"] as? Bool ?? false
      TabWatch.shared.editing = on
      if on { TabWatch.shared.pinned = true; if !selfTest { panel.makeKey() } }
    case "clipboard:clear" where fromOverlay || fromMain:
      NSPasteboard.general.clearContents()
    case "mic:get" where fromOverlay || fromMain:   // the microphone picker in Settings
      sendMic()
    case "mic:set" where fromOverlay || fromMain:   // The developer picked a microphone: make it the Mac's default
      if let uid = msg["uid"] as? String { let ok = Mic.setDefault(uid: uid); psLog("PS mic: set default input ok=\(ok)") }
      sendMic()
    case "thunder" where fromOverlay:           // the lightning backgrounds' thunder: only while the list is showing
      if shown, let name = msg["name"] as? String { Sfx.shared.thunder(name, volume: msg["vol"] as? Double ?? 0) }
    case "sfx" where fromOverlay || fromMain:   // the Tab list's hover and click sounds
      // V1.57: a card's own sound (card:true: mail, meetings, the gym card, squad messages) is skipped in private mode.
      if (msg["card"] as? Bool) == true && !PrivateCore.cardSound(privateOn: PrivateHold.shared.on) { break }
      if let name = msg["name"] as? String { Sfx.shared.play(name, volume: msg["vol"] as? Double ?? 0.4) }
    // Reply from PS (V1.44, ReplyWindow.swift, MailSend.swift, web src/replyengine.ts).
    case "reply:open" where fromMain:           // a card's Reply: the compose window for that email
      if let ctx = msg["ctx"], let prefs = msg["prefs"] { replyWin.lastPrefs = prefs; replyWin.open(ctx: ctx, prefs: prefs) }
    // V1.59 Reply in the email panel (web src/replyengine.ts handOver): the developer's own reply from the email panel's
    // box, handed over only after his Send and its 10 second Undo ran out on the page. Checked by OutJob.from like any job.
    case "reply:queue" where fromMain:
      if let j = msg["job"] as? [String: Any] { MailSend.shared.queue(j, undo: false) }
    case "reply:prefs" where fromMain:          // signatures and saved responses changed
      if let p = msg["prefs"] { replyWin.lastPrefs = p; replyWin.prefs(p) }
    case "reply:cannot" where fromMain:
      Toast.shared.show(title: "PS app cannot reply to this one here", body: "Use Open in Gmail or Open in Instantly on its card.")
    case "reply:connect" where fromMain || fromOverlay:   // Settings, Reply from PS: Connect (Gmail) or Add key (Instantly)
      if fromOverlay && shown { hideOverlay(force: true, giveBack: false) }   // the browser or the key window must not open under the list
      replyWin.connect(msg)
    case "reply:forget" where fromMain || fromOverlay:
      MailSend.shared.forget(msg["via"] as? String ?? "", msg["account"] as? String)
    case "reply:showQueue" where fromMain || fromOverlay:
      if fromOverlay && shown { hideOverlay(force: true, giveBack: false) }
      replyWin.showQueue()
    case "cardShow" where fromMain:             // a card with buttons ("Shall I end my day now?")
      if let c = msg["card"] as? [String: Any] { Toast.shared.showCard(c) }
    case "sqresult" where fromMain:             // PS 1.63: the page's answer to a G Squad reply sent from the island (src/squad/chatengine.ts noteAction)
      if let id = msg["id"] as? String { SquadIsland.shared.result(id: String(id.prefix(40)), ok: (msg["ok"] as? Bool) == true, why: (msg["why"] as? String).map { String($0.prefix(60)) }) }
    case "cardHide" where fromMain:
      if let id = msg["id"] as? String { Toast.shared.hideCard(id) }
    case "dnd" where fromMain:                  // Do Not Disturb: what is muted right now (src/dnd.ts, DND.swift)
      if let st = msg["state"] as? [String: Any] { DND.shared.fromPage(st) }
    case "island" where fromMain:               // the Dynamic Island's state (src/island.ts, Island.swift)
      if let st = msg["state"] as? [String: Any] { Island.shared.fromPage(st); SetupIsland.shared.islandState(st); AssistIsland.shared.islandState(st) }
    case "setupIsland" where fromMain || fromOverlay:   // the setup menu opened or closed (views/Welcome.tsx, SetupIsland.swift)
      SetupIsland.shared.menu(open: msg["menu"] as? Bool ?? false)
    case "island:intro" where fromOverlay:               // PS 1.60: a "Did you know?" intro asks to come out of the island (views/FeatureIntro.tsx)
      introFromIsland(start: (msg["start"] as? Bool) ?? true, id: (msg["id"] as? String) ?? "")
    case "island:whatsnew" where fromOverlay:            // PS 1.60: the What's new panel asks to come out of the island (views/WhatsNew.tsx)
      whatsNewFromIsland(start: (msg["start"] as? Bool) ?? true)
    case "island:edit" where fromMain || fromOverlay:    // the Tab list's Edit mode (views/EditMode.tsx): show it, ready to move
      Island.shared.setEditing(msg["on"] as? Bool ?? false)
    case "island:reset" where fromMain || fromOverlay:   // Mac settings or Edit mode: back to the top centre
      Island.shared.resetPos()
    case "island:show" where fromMain || fromOverlay:    // V1.58 Show it now: back from its right click menu's away at once
      Island.shared.showNow()
    case "meetCard" where fromMain:             // a meeting alert card (src/meetwatch.ts)
      if let c = msg["card"] as? [String: Any] { Toast.shared.showMeet(c) }
    case "sentryPrefs" where fromMain:          // Sentry mode's restart if not unlocked, for the restart helper pop up (src/sentryprefs.ts, V1.49)
      if let h = (msg["restartH"] as? NSNumber)?.intValue { HelperAlert.shared.setSentryRestart(h) }
    case "noteLook" where fromMain:             // the cards' colours per kind and the Other alerts sound (src/notelook.ts, V1.36)
      if let l = msg["look"] as? [String: Any] { Toast.shared.setLook(l) }
    case "meetPrivacy" where fromMain:          // a calendar meeting started or ended: hide or show card details
      Toast.shared.meetPrivacy(msg["on"] as? Bool ?? false)
    case "notify" where fromMain:               // a pop-up saying what just changed (the developer can switch these off)
      if let t = msg["text"] as? String, !t.isEmpty {
        Toast.shared.show(title: (msg["title"] as? String) ?? String(t.prefix(200)), sub: msg["sub"] as? String, body: msg["body"] as? String, url: msg["url"] as? String)
      }
    case "psSettings:get" where fromMain || fromOverlay:
      AutoReboot.shared.refreshFileVault()
      sendSettings()
    // Auto reboot (AutoReboot.swift, Helper/rebootd.swift). Only PS's own pages (main window or Tab list).
    case "reboot:set" where fromMain || fromOverlay:
      if let n = msg["minutes"] as? Int, AutoReboot.minuteRange.contains(n) { AutoReboot.shared.minutes = n }
      else if let h = msg["hours"] as? Int, (1...72).contains(h) { AutoReboot.shared.minutes = h * 60 }   // an older page
      if let m = msg["mode"] as? String { AutoReboot.shared.mode = m }
    case "reboot:setup" where fromMain || fromOverlay:   // only from the developer's click on "Set up"
      AutoReboot.shared.setUp { [weak self] err in self?.sendSettings(error: err) }
    case "reboot:remove" where fromMain || fromOverlay:
      AutoReboot.shared.remove { [weak self] err in self?.sendSettings(error: err) }
    case "reboot:test" where fromMain || fromOverlay:
      AutoReboot.shared.testOnce()
    case "reboot:refresh" where fromMain || fromOverlay:
      AutoReboot.shared.refresh(); AutoReboot.shared.refreshFileVault(); sendSettings()
    case "reboot:check" where fromMain || fromOverlay:   // V1.54: the AI button asks the restart helper fresh (HelperCheckCore)
      AutoReboot.shared.refreshFileVault()
      AutoReboot.shared.checkFromPage((msg["id"] as? String) ?? "")
    default: break
    }
  }

  // MARK: window

  func windowShouldClose(_ sender: NSWindow) -> Bool {
    // Closing the Sign in window hides it; PS keeps running (the engine page never unloads). Quit with Cmd+Q.
    hideEngineWindow()
    return false
  }

  /// Clicking PS in the Dock: the "PS is active" pop-up (V1.23, there is no main window to bring back).
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if shown { escapeOut() }     // a second way out of a stuck or kept list: click PS in the Dock
    if selfTest { return true }  // a test copy never takes focus
    if window.isVisible { window.makeKeyAndOrderFront(nil); return true }   // signing in: that window, as it was
    showPopup()
    return false
  }

  /// A recording is finished before PS quits, restarts for an update or reboots (the last seconds and the mic tail are kept, the file is closed).
  /// Waits for the file at most 6 seconds, then goes on anyway.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    var replied = false
    let reply = { if !replied { replied = true; NSApp.reply(toApplicationShouldTerminate: true) } }
    guard ScreenRec.shared.finishForQuit({ DispatchQueue.main.async { reply() } }) else { return .terminateNow }
    DispatchQueue.main.asyncAfter(deadline: .now() + 6) { reply() }
    return .terminateLater
  }

  func applicationWillTerminate(_ n: Notification) { AutoApprove.shared.stop(); Sentry.shared.quitting(); ScreenTime.shared.save(); Second.shared.quit(); MCEngine.shared.stop() }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // MARK: links, dialogs, downloads

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    guard let url = action.request.url, let scheme = url.scheme?.lowercased() else { return decisionHandler(.cancel) }
    if scheme == "ps" || scheme == "blob" || scheme == "about" || scheme == "data" { return decisionHandler(.allow) }
    // Web links and mailto open in your normal browser or mail app.
    if (action.navigationType == .linkActivated || action.targetFrame == nil) && !selfTest { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
    let save = NSSavePanel()
    save.nameFieldStringValue = suggestedFilename
    save.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
    // No main window to hang a sheet on (V1.23): a free standing Save panel, PS in front only while it is up.
    if window.isVisible { save.beginSheetModal(for: window) { r in completionHandler(r == .OK ? save.url : nil) }; return }
    NSApp.activate(ignoringOtherApps: true)
    save.begin { [weak self] r in completionHandler(r == .OK ? save.url : nil); self?.giveFocusBack() }
  }

  // A file chooser (local first, V1.44: Import a backup in Settings). PS's own Open panel, the Tab list steps aside first
  // like Add video does; nothing is read here, the page reads the one file picked.
  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    if IS_TEST_COPY { completionHandler(nil); return }
    if shown { hideOverlay(force: true, giveBack: false) }
    let p = NSOpenPanel()
    p.allowsMultipleSelection = parameters.allowsMultipleSelection; p.canChooseDirectories = false; p.canChooseFiles = true
    p.prompt = "Open"
    if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    p.begin { r in completionHandler(r == .OK ? p.urls : nil) }
  }

  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if !selfTest, let url = action.request.url, ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
    return nil
  }

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    if IS_TEST_COPY { print("SELFTEST: JS alert skipped, no window: \(message.prefix(80))"); completionHandler(); return }
    let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK")
    a.runModal(); completionHandler()
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    if IS_TEST_COPY { print("SELFTEST: JS confirm answered No, no window: \(message.prefix(80))"); completionHandler(false); return }
    let a = NSAlert(); a.messageText = message
    a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn)
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    if IS_TEST_COPY { print("SELFTEST: JS prompt cancelled, no window: \(prompt.prefix(80))"); completionHandler(nil); return }
    let a = NSAlert(); a.messageText = prompt
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
    field.stringValue = defaultText ?? ""
    a.accessoryView = field
    a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
    completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
  }

  // MARK: menu (Edit gives copy, paste and undo their usual shortcuts)

  func buildMenu() {
    let bar = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) {
      let top = NSMenuItem(); let m = NSMenu(title: title)
      items.forEach { m.addItem($0) }
      top.submenu = m; bar.addItem(top)
    }
    func item(_ t: String, _ a: Selector?, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: t, action: a, keyEquivalent: k); i.keyEquivalentModifierMask = mods; return i
    }
    let access = item("Tab Overlay Permission...", #selector(openAccessibility), "")
    access.target = self
    let n = AppName.current   // the menu names the app as it is called on this Mac (V1.36); V1.49: Info.plist says PS app too, so macOS's bold name matches
    let show = item("Show \(n)", #selector(showMain), "0")
    show.target = self
    let list = item("Open Tab List", #selector(openListMenu), "l", [.command, .shift])
    list.target = self
    let prefs = item("Settings...", #selector(openSettingsMenu), ",")
    prefs.target = self
    let tab = item("Tab Overlay: On", #selector(toggleTab), "")
    tab.target = self
    tabMenuItem = tab
    let updates = item("Check for Updates...", #selector(checkUpdates), "")
    updates.target = self
    let project = item("Supabase Project...", #selector(openProjectSetup), "")   // ProjectSetup.swift
    project.target = self
    add(n, [item("About \(n)", #selector(showAbout), ""), updates, .separator(), list, prefs, tab, access, project, .separator(),
               item("Hide \(n)", #selector(NSApplication.hide(_:)), "h"), item("Quit \(n)", #selector(NSApplication.terminate(_:)), "q")])
    add("Edit", [item("Undo", Selector(("undo:")), "z"), item("Redo", Selector(("redo:")), "z", [.command, .shift]), .separator(),
                 item("Cut", #selector(NSText.cut(_:)), "x"), item("Copy", #selector(NSText.copy(_:)), "c"),
                 item("Paste", #selector(NSText.paste(_:)), "v"), item("Select All", #selector(NSText.selectAll(_:)), "a")])
    let reload = item("Reload", #selector(reloadMain), "r")
    reload.target = self
    add("View", [reload])
    add("Window", [show, item("Close", #selector(NSWindow.performClose(_:)), "w")])
    NSApp.mainMenu = bar
  }

  /// "Show PS" (Cmd+0): the pop-up, or the Sign in window while it is up. The big window is gone (V1.23).
  @objc func showMain() {
    if window.isVisible { if !selfTest { window.makeKeyAndOrderFront(nil) }; return }
    showPopup()
  }
  @objc func openListMenu() { openList() }
  @objc func openSettingsMenu() { openList(then: App.openSettingsJS) }
  @objc func reloadMain() { loadMain() }
  @objc func checkUpdates() { Updater.shared.checkNow(manual: true) }
  @objc func openProjectSetup() { ProjectSetup.shared.show(mode: ProjectSetup.shared.holding ? .first : .change) }
  /// About PS shows the version the developer knows (V1.02), not the internal build number.
  @objc func showAbout() {
    NSApp.activate(ignoringOtherApps: true)
    NSApp.orderFrontStandardAboutPanel(options: [.applicationName: AppName.current, .applicationVersion: PSVersion.name, .version: ""])
  }
  @objc func openAccessibility() { TabWatch.shared.askPermission(force: true) }
  @objc func toggleTab() { setTab(!TabWatch.shared.enabled) }
}

/// One log line per reason a minute (the ignored Tab line).
struct OncePerMinute {
  private var last: [String: Date] = [:]
  mutating func allow(_ key: String, _ now: Date) -> Bool {
    if let t = last[key], now.timeIntervalSince(t) < 60 { return false }
    last[key] = now
    return true
  }
}

// MARK: - Hold Tab anywhere

// A quick tap of Tab still reaches the app you are in (sent on as soon as you let go, or as soon
// as you press another key). Holding it for HOLD_SECONDS shows the task map until you let go.
// Inside PS itself the web page handles Tab (tap to pin, hold to peek), so PS stays out of it.
final class TabWatch {
  static let shared = TabWatch()
  weak var app: App?
  var tap: CFMachPort?
  enum State { case idle, pending, showing, swallowUp, passUp, optPending, optShowing }
  var state = State.idle
  var pinned = false
  var swallowOneUp = false          // Tab+1 (Tab+W, / . Space) swallowed its key: that key's up is swallowed too
  var swallowUpCode: Int64 = 18     // which key that was (V1.34)
  var editing = false { didSet { if oldValue != editing { SafePeek.shared.refresh() } } }   // typing in the floating list: every key goes to it
  var held: CGEvent?
  /// The key that started the current hold: 48 Tab, or SLASH_KEY for the / then . chord. V1.47: any key from the
  /// Tab overlay shortcuts list (OpenKeysCore), with `fromChord` saying which kind started it.
  var chordKey: Int64 = 48
  /// V1.47: the current hold was started by a chord's first key (the / then . kind), not a hold key.
  var fromChord = false
  /// V1.47: when the chord's first key went down (a chord on a typing key needs a moment before the second counts).
  var chordAt = 0.0
  var swallowDotUp = false          // the chord's . was swallowed: its key up is swallowed too
  var swallowDotCode: Int64 = 47    // V1.47: which key that was (DOT_KEY for the / then . chord)
  /// V1.47: the modifier key that started a modifier hold (61 Right Option before V1.47).
  var modCode: Int64 = 61
  /// V1.47 Tab overlay shortcuts: the saved list, or nil while never changed (then the old settings are the list).
  /// Set on main under the lock; the tap reads it under the lock.
  var customPlan: OpenKeysCore.Plan?
  /// Main thread: the saved list (nil while never changed). A test copy keeps its own in memory.
  private(set) var customList: [OpenKeysCore.Shortcut]?
  private var legacyCache: (String, Bool, OpenKeysCore.Plan)?
  /// The plan for this key event (set at the top of handleLocked, read by slashChord and optionKey).
  private var p = OpenKeysCore.Plan()
  /// Under the lock: the plan in force. The old settings build it while no list was saved (cached, so the tap
  /// thread builds nothing per key).
  func currentPlan() -> OpenKeysCore.Plan {
    if let c = customPlan { return c }
    let t = triggerKey, sl = slashOn
    if let c = legacyCache, c.0 == t, c.1 == sl { return c.2 }
    let plan = OpenKeysCore.Plan(OpenKeysCore.legacy(triggerKey: t, slashOn: sl), legacy: true)
    legacyCache = (t, sl, plan)
    return plan
  }
  /// The list as shown in Settings: the saved one, or the old settings as a list.
  var shortcutList: [OpenKeysCore.Shortcut] { customList ?? OpenKeysCore.legacy(triggerKey: triggerKey, slashOn: slashOn) }
  /// Main thread: reads the saved list at launch.
  func loadShortcuts() {
    let l = testCopy ? customList : OpenKeysCore.decode(UserDefaults.standard.string(forKey: "openShortcuts"))
    setCustom(l, save: false)
  }
  /// Main thread: a new list from Settings (already checked), or nil for Reset to Tab (the defaults, as a new user).
  func setCustom(_ l: [OpenKeysCore.Shortcut]?, save: Bool) {
    customList = l
    if save && !testCopy {
      if let l { UserDefaults.standard.set(OpenKeysCore.encode(l), forKey: "openShortcuts") }
      else { UserDefaults.standard.removeObject(forKey: "openShortcuts") }
    }
    mu.lock()
    customPlan = l.map { OpenKeysCore.Plan($0) }
    mu.unlock()
    SafePeek.shared.refresh()
  }
  /// Hold / and press . : the list, like holding Tab (the developer, 20 Oct 2026). PS > Settings, on by default.
  /// A test copy only flips it in memory (it shares the developer's preferences file).
  var slashOn: Bool = UserDefaults.standard.object(forKey: "slashChord") as? Bool ?? true {
    didSet { if ProcessInfo.processInfo.environment["PS_SELFTEST"] == nil { UserDefaults.standard.set(slashOn, forKey: "slashChord") } }
  }
  /// Tab keeps the list open (the developer, 7 Nov 2026): hold Tab (or Right Option, or / and .) and let go, and
  /// the list stays up; the next hold puts it away. A quick tap is still a normal key. This Mac only,
  /// like the other Tab settings. Never chosen: on for everyone else, off for the developer (Owner.red). The tap
  /// thread only reads `stays` (set on main under the lock), never UserDefaults or Owner.
  var stays = false
  private var testStays: Bool?      // a test copy only flips it in memory
  private let testCopy = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  /// The choice made in Settings, nil while never chosen.
  var staysChoice: Bool? { testCopy ? testStays : UserDefaults.standard.object(forKey: "tabStays") as? Bool }
  static func staysDefault(red: Bool) -> Bool { !red }
  /// Main thread: at launch, after each sign in (who it is decides the default) and on a change.
  func loadStays() {
    let v = staysChoice ?? TabWatch.staysDefault(red: Owner.red)
    mu.lock(); stays = v; mu.unlock()
  }
  /// From the Settings switch (clicks only). nil forgets the choice (self test only).
  func setStays(_ on: Bool?) {
    if testCopy { testStays = on } else if let on { UserDefaults.standard.set(on, forKey: "tabStays") } else { UserDefaults.standard.removeObject(forKey: "tabStays") }
    loadStays()
  }
  /// This hold is putting a kept list away (/ and . or Right Option): its key up does nothing more.
  var closingHold = false
  /// Self test: keys the tap would have sent on are recorded here instead (a test copy never types).
  var testPosted: [CGEvent]?
  var holdWork: DispatchWorkItem?   // "Tab has been held long enough": runs on main, cancellable from the tap thread
  // Tab health (V1.41, TabHealthCore.swift). Under the lock: WHEN the tap last got a key down (never which key).
  var lastTapKey = CACurrentMediaTime()
  private var tapLoop: CFRunLoop?           // under the lock: the tap thread's run loop, stopped on a reinstall
  // main thread only
  private var installedAt = CACurrentMediaTime()
  private var protectedEndedAt = 0.0
  private var deafRetried = false           // this deaf spell already got a fresh tap
  private var deafTold = false
  private var lostTrust = false
  /// Main: the tap is deaf even after a fresh one (true), or keys reach it again (false). The card says so.
  var onDeaf: ((Bool) -> Void)?
  var retry: Timer?
  // The tap runs on its OWN thread (18 Oct 2026: the developer's Mac froze for 3 minutes; a tap on the main
  // run loop makes every key on the Mac wait for PS). Its state is guarded by this lock; the main
  // thread only holds it for a moment.
  let mu = NSLock()
  private let postQ = DispatchQueue(label: "ps.tap.post", qos: .userInteractive)
  // Why a Tab press was left alone (the developer, 28 Oct 2026): one short line per reason, at most once a
  // minute each. Only the reason, never a key. Written off the tap thread, so no key ever waits on it.
  private let ignoreQ = DispatchQueue(label: "ps.tab.ignored", qos: .utility)
  private var ignoreLog = OncePerMinute()   // ignoreQ only
  static func ignoredWhy(mods: Bool, appActive: Bool, unlocked: Bool) -> String? {
    if appActive { return "PS window in front" }
    if !unlocked { return "not signed in yet" }
    if mods { return "modifiers held" }
    return nil
  }
  /// One log line, at most once a minute per line (any thread; written off the tap thread).
  func noteOnce(_ line: String) {
    let now = Date()
    ignoreQ.async { [self] in if ignoreLog.allow(line, now) { psLog(line) } }
  }
  func noteIgnored(_ why: String) {
    let now = Date()
    ignoreQ.async { [self] in if ignoreLog.allow(why, now) { psLog("PS tab: Tab hold ignored, \(why)") } }
  }
  /// The main thread's heartbeat (every 0.25 s). Over 1 s old: the main thread is stuck, so the
  /// tap passes every key straight through until it is back (the watchdog).
  var beat = CACurrentMediaTime()
  private var stalled = false
  /// Kept up to date on main, so the tap never asks AppKit from its own thread.
  var appActive = false
  var frontID: String?
  func heartbeat() {
    beat = CACurrentMediaTime()
    if stalled { stalled = false; psLog("PS tab: main thread back, keys handled again") }
  }
  var enabled: Bool {
    get { UserDefaults.standard.bool(forKey: "tabEnabled") }
    set { UserDefaults.standard.set(newValue, forKey: "tabEnabled") }
  }
  /// "tab" (hold Tab, default) or "rightOption" (hold the right Option key), PS > Settings.
  var triggerKey: String {
    get { UserDefaults.standard.string(forKey: "triggerKey") ?? "tab" }
    set { UserDefaults.standard.set(newValue, forKey: "triggerKey") }
  }
  /// Apps where PS leaves the key alone (eg games that hold Tab for the scoreboard).
  var ignoredApps: [String] {
    get { UserDefaults.standard.stringArray(forKey: "ignoredApps") ?? [] }
    set { UserDefaults.standard.set(newValue, forKey: "ignoredApps") }
  }
  var frontIgnored: Bool {
    guard let id = frontID else { return false }
    return ignoredApps.contains(id)
  }

  /// Called every 3 seconds: install the tap once allowed, and switch it back on if macOS disabled it.
  func check() {
    let trusted = AXIsProcessTrusted()
    if tap == nil { if trusted { install() }; return }
    // V1.41: the permission taken away (an update, a restart, Fix permission) leaves a tap that hears nothing;
    // when it is back, a fresh tap is installed by itself.
    if !trusted {
      if !lostTrust { lostTrust = true; psLog("PS tab: macOS took away the Accessibility permission, no key reaches PS until it is back") }
      return
    }
    if lostTrust { lostTrust = false; psLog("PS tab: Accessibility permission is back, installing a fresh keyboard tap"); reinstall(); return }
    guard let tap else { return }
    if Protected.front { protectedEndedAt = CACurrentMediaTime(); return }
    if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true); psLog("PS tab: tap re-enabled (macOS had switched it off)") }
    deafCheck()
  }

  /// The tap is on but hears nothing while you type (V1.41): first a fresh tap, then, if it still hears nothing,
  /// the card says how to fix it. Keys reaching it again clear both. Never while Tab is switched off.
  private func deafCheck() {
    guard enabled else { return }
    let now = CACurrentMediaTime()
    mu.lock(); let tapAgo = now - lastTapKey; mu.unlock()
    if tapAgo < 4 {
      if deafRetried || deafTold { psLog("PS tab: keys reach the keyboard tap again") }
      deafRetried = false
      if deafTold { deafTold = false; onDeaf?(false) }
      return
    }
    let sysAgo = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .keyDown)
    let settled = min(now - installedAt, now - protectedEndedAt)
    guard sysAgo < 4, tapAgo > 20, settled > 20 else { return }   // the cheap part first; the rest only then
    let console = (CGSessionCopyCurrentDictionary() as? [String: Any])?["kCGSSessionOnConsoleKey"] as? Bool ?? true
    guard TabHealth.deaf(systemKeyAgo: sysAgo, tapKeyAgo: tapAgo, settledFor: settled, onConsole: console, secureInput: SecureInputWatch.isOn()) else { return }
    if !deafRetried {
      deafRetried = true
      psLog("PS tab: the keyboard tap got no keys for \(Int(tapAgo)) s while you typed, installing a fresh one")
      reinstall()
    } else if !deafTold {
      deafTold = true
      psLog("PS tab: a fresh keyboard tap gets no keys either: macOS is not passing keys to PS (its Accessibility entry needs switching off and on)")
      onDeaf?(true)
    }
  }

  /// A fresh keyboard tap: the old one is switched off, invalidated and its thread let go, a half done hold forgotten.
  func reinstall() {
    mu.lock()
    let loop = tapLoop; tapLoop = nil
    holdWork?.cancel(); held = nil; closingHold = false; swallowOneUp = false; swallowDotUp = false
    if state != .showing && state != .optShowing { state = .idle }
    mu.unlock()
    if let t = tap { CGEvent.tapEnable(tap: t, enable: false); CFMachPortInvalidate(t) }
    if let loop { CFRunLoopStop(loop) }
    tap = nil
    install()
  }

  /// Secure Input went off again (SecureInput.swift, V1.41). While it was on macOS sent the tap no keys at all, so
  /// a hold that was half way (a key down whose key up went elsewhere) is forgotten, and the tap is switched back
  /// on if macOS had switched it off. Never over 1Password or Signal: there it stays off. Says what it did.
  func afterSecureInput() -> String {
    mu.lock()
    if state == .pending || state == .swallowUp || state == .passUp || state == .optPending {
      holdWork?.cancel(); held = nil; closingHold = false; state = .idle
    }
    mu.unlock()
    guard let tap else { return "not installed" }
    if Protected.front { return "off, a protected app is in front" }
    if CGEvent.tapIsEnabled(tap: tap) { return "was on, nothing needed" }
    CGEvent.tapEnable(tap: tap, enable: true)
    return CGEvent.tapIsEnabled(tap: tap) ? "re-enabled" : "could not be re-enabled"
  }

  /// Golden rule: while 1Password or Signal is in front the tap is OFF, so macOS hands PS none of
  /// the keys typed there (not even to glance at and pass on). A Tab press that was waiting is
  /// dropped, never sent into them.
  func protectedChanged() {
    mu.lock()
    var hide = false
    if Protected.front && state != .idle {
      holdWork?.cancel()
      held = nil
      closingHold = false
      hide = (state == .showing || state == .optShowing) && !pinned
      state = .idle
    }
    mu.unlock()
    if hide { app?.hideOverlay() }
    // V1.58, the developer's account (BuildRules): a list left up (pinned, Keep overlay) goes away too. Everyone else keeps it.
    else if let a = app, SafePeekCore.hideListOnProtected(protectedFront: Protected.front, shown: a.shown,
                                                           tabOverProtected: BuildRules.now.tabOverProtected) {
      a.hideOverlay(force: true, giveBack: false)
    }
    if let tap { CGEvent.tapEnable(tap: tap, enable: !Protected.front) }
    protectedEndedAt = CACurrentMediaTime()   // Tab health: the tap was off on purpose until now
  }
  /// After HOLD_SECONDS on main: `check` (under the lock) says whether it still applies.
  private func afterHold(_ seconds: Double = HOLD_SECONDS, _ check: @escaping () -> Bool, _ run: @escaping () -> Void) {
    holdWork?.cancel()
    let w = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.mu.lock(); let go = check(); self.mu.unlock()
      if go { run() }
    }
    holdWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: w)
  }

  func askPermission(force: Bool) {
    if force {
      NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    } else {
      // macOS shows its own "PS would like to control this computer" prompt with a button to Settings.
      let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
      _ = AXIsProcessTrustedWithOptions(opts)
    }
  }

  func start() {
    // Self test copies never install a real keyboard tap (the developer may be typing while one runs).
    if ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil { return }
    if !AXIsProcessTrusted() {
      if ProcessInfo.processInfo.environment["PS_SELFTEST"] == nil { askPermission(force: false) }
      // Start as soon as the developer switches PS on in System Settings, no restart needed.
      retry = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] t in
        if AXIsProcessTrusted() { t.invalidate(); self?.install() }
      }
      return
    }
    install()
  }

  func install() {
    guard tap == nil else { return }
    let mask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
    tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                            eventsOfInterest: CGEventMask(mask), callback: { _, type, event, ref in
      let me = Unmanaged<TabWatch>.fromOpaque(ref!).takeUnretainedValue()
      return me.handle(type, event)
    }, userInfo: Unmanaged.passUnretained(self).toOpaque())
    guard let tap else { noteOnce("PS tab: could not create the keyboard tap (trusted=\(AXIsProcessTrusted() ? 1 : 0)), trying again every 3 s"); return }
    psLog("PS tab: keyboard tap installed")
    installedAt = CACurrentMediaTime()   // the last key time is NOT reset: a fresh tap that hears nothing must still count as deaf
    let src = CFMachPortCreateRunLoopSource(nil, tap, 0)
    // Its own thread and run loop: a busy main thread can never hold up a key on the Mac.
    let t = Thread { [weak self] in
      let loop = CFRunLoopGetCurrent()
      self?.mu.lock(); self?.tapLoop = loop; self?.mu.unlock()
      CFRunLoopAddSource(loop, src, .commonModes)
      CFRunLoopRun()
    }
    t.name = "PS keyboard tap"
    t.qualityOfService = .userInteractive
    t.start()
    CGEvent.tapEnable(tap: tap, enable: !Protected.front)
    app?.sendTapState()
  }

  /// Runs on the tap's own thread. Decides pass or swallow from plain state only; anything for the
  /// screen goes to main with async. If main is stuck the watchdog passes every key through.
  func handle(_ type: CGEventType, _ e: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap, !Protected.front { CGEvent.tapEnable(tap: tap, enable: true) }
      noteOnce("PS tab: macOS switched the keyboard tap off (\(type == .tapDisabledByTimeout ? "timeout" : "user input check")), switched it back on")
      return Unmanaged.passUnretained(e)
    }
    if CACurrentMediaTime() - beat > 1.0 { return mainStuck(e) }
    mu.lock(); defer { mu.unlock() }
    return handleLocked(type, e)
  }
  /// The watchdog: main has not answered for over a second. A Tab that was waiting goes out at once
  /// with this key, nothing is swallowed, and the list's state is reset.
  func mainStuck(_ e: CGEvent) -> Unmanaged<CGEvent>? {
    mu.lock()
    lastTapKey = CACurrentMediaTime()
    holdWork?.cancel()
    swallowOneUp = false
    closingHold = false
    if state == .pending, let h = held {
      state = .idle
      repost([h, e.copy()])
      mu.unlock()
      noteStall()
      return nil
    }
    held = nil
    state = .idle
    mu.unlock()
    noteStall()
    return Unmanaged.passUnretained(e)
  }
  private func noteStall() {
    if !stalled { stalled = true; psLog("PS tab: main thread busy for over 1 s, every key passes straight through") }
  }
  private func handleLocked(_ type: CGEventType, _ e: CGEvent) -> Unmanaged<CGEvent>? {
    if type == .keyDown { lastTapKey = CACurrentMediaTime() }   // Tab health: when, never which key
    // Golden rule: with 1Password or Signal in front, PS does nothing at all with any key (the tap
    // is switched off then; this line only covers a key already on its way when they came forward).
    if Protected.front && state == .idle { if type == .keyDown { noteIgnored("protected app in front") }; return Unmanaged.passUnretained(e) }
    // FAILSAFE (the developer, 16 Oct): whenever the list is up and Tab is not held, Esc closes it,
    // whatever mode it is in (pinned, Keep overlay, Hover mode, typing in it). V1.47: a timed Soundboard play ringing
    // takes the Esc too, whatever app is in front (that one Esc stops it; Soundboard.swift). V1.49: so does the restart
    // helper pop up while it is on screen (HelperAlert.swift; never over 1Password or Signal, the tap is off there).
    if state == .idle && type == .keyDown && e.getIntegerValueField(.keyboardEventKeycode) == 53 && (app?.shown == true || app?.sleepUp == true || Soundboard.ringingNow || HelperAlert.upNow || Toast.stackOpenNow) {   // 1.65: an open notification list takes the Esc too
      DispatchQueue.main.async { self.app?.escKey() }
      return nil
    }
    // Kept up over another app: every other key is the app's (Tab included).
    if app?.kept == true && state == .idle { return Unmanaged.passUnretained(e) }
    if e.getIntegerValueField(.eventSourceUserData) == MAGIC { return Unmanaged.passUnretained(e) }
    if !enabled && state == .idle { return Unmanaged.passUnretained(e) }   // Tab overlay switched off
    if editing && state == .idle && app?.shown == true { return Unmanaged.passUnretained(e) }   // Tab moves between boxes
    p = currentPlan()   // V1.47: which keys open the list (Tab overlay shortcuts, or the old settings)
    if type == .flagsChanged { optionKey(e); return Unmanaged.passUnretained(e) }
    if state == .optPending && type == .keyDown { holdWork?.cancel(); state = .idle }   // Option + a letter: typing, not the list
    if state == .optPending || state == .optShowing { return Unmanaged.passUnretained(e) }
    switch slashChord(type, e) {
    case .pass: return Unmanaged.passUnretained(e)
    case .swallow: return nil
    case .notMine: break
    }
    // Hold Right Option chosen, or this app is on the ignore list: Tab is just Tab.
    // V1.47: no hold key in the list (only Right Option, chords or combos) is the same as Right Option chosen.
    if state == .idle && (p.holdKeys.isEmpty || frontIgnored) { return Unmanaged.passUnretained(e) }
    // V1.47: "Tab" below is the hold key from the list that started this hold (48 Tab before V1.47).
    let keyCode = e.getIntegerValueField(.keyboardEventKeycode)
    let isTab = state == .idle ? p.hold(keyCode) != nil : (!fromChord && keyCode == chordKey)
    let down = type == .keyDown

    // Tab + 1 (the developer, 18 Oct): while Tab is held, 1 opens the Add task window. The 1 (and its key up)
    // never reaches the app in front; the list is shown at once if it was still waiting, and pinned,
    // so it stays when Tab is let go. Never over 1Password or Signal: the tap is off there.
    let code = e.getIntegerValueField(.keyboardEventKeycode)
    // V1.34 (the developer, 5 Nov 2026): Tab held and W opens Add task the same way, and so does Space while / (and .) hold the
    // list up ("hold down '/' and '.' at the same time... and also the space button 3rd"). Each key and its key up
    // are swallowed. Never over 1Password or Signal (the tap is off there) and never through SafePeek.
    // V1.47: "chordKey == 48" read "a Tab hold" and "chordKey == SLASH_KEY" read "the chord"; with any key in the
    // list that is fromChord. The key that started the hold is never its own add key (hold W, hold 1).
    let addKey = (state == .idle || code != chordKey) && (code == 18 || (code == 13 && !fromChord) || (code == 49 && fromChord && state == .showing))
    if !down && swallowOneUp && code == swallowUpCode { swallowOneUp = false; return nil }
    if addKey && down && ((state == .pending && !fromChord) || state == .showing)
        && e.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty {
      swallowOneUp = true
      swallowUpCode = code
      if e.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return nil }
      if state == .pending { holdWork?.cancel(); held = nil; state = .showing }
      pinned = true
      DispatchQueue.main.async {
        guard let app = self.app else { return }
        if !app.shown { app.showOverlay() }
        app.openAddTask()
      }
      return nil
    }

    // Another key while Tab is waiting: it was a normal Tab, send it first so the order stays right.
    if !isTab {
      if state == .pending && down {
        holdWork?.cancel()
        state = .passUp
        repost([held, e.copy()])
        return nil
      }
      return Unmanaged.passUnretained(e)
    }

    let mods = e.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
    let repeatKey = e.getIntegerValueField(.keyboardEventAutorepeat) != 0
    let overlayOpen = app?.shown == true
    let holdTime = p.hold(code) ?? HOLD_SECONDS   // V1.47: a typing key held to open the list needs a longer hold

    if down {
      switch state {
      case .pending, .showing, .swallowUp: return nil            // held down: swallow the repeats
      case .passUp, .optPending, .optShowing: return Unmanaged.passUnretained(e)
      case .idle:
        if repeatKey { return Unmanaged.passUnretained(e) }
        // Tab keeps the list open: up and kept, only a HOLD of Tab puts it away. A quick tap is still a
        // normal Tab (sent on when let go, to wherever the keyboard is), Shift+Tab and shortcuts pass.
        if overlayOpen && pinned && stays {
          if !mods.isEmpty { return Unmanaged.passUnretained(e) }
          state = .pending
          chordKey = code; fromChord = false
          held = e.copy()
          afterHold(holdTime, { [weak self] in
            guard let self, self.state == .pending else { return false }
            self.state = .swallowUp
            return true
          }, { [weak self] in self?.app?.hideOverlay() })
          return nil
        }
        if overlayOpen && pinned {                               // pinned open: Tab closes it
          DispatchQueue.main.async { self.app?.hideOverlay() }
          state = .swallowUp
          return nil
        }
        // Shift+Tab and shortcuts pass straight through, PS's own window handles Tab itself, and
        // while the vault is locked Tab is left alone (the website's own overlay works then).
        // Signed out: PS leaves Tab alone (the website's own Tab list works then).
        // Locked with Touch ID: holding Tab asks for it (hold Tab again once it is open).
        if mods.isEmpty && !appActive && app?.vaultUnlocked != true && TouchLock.cachedLocked && !TouchLock.isAsking {
          state = .pending
          chordKey = code; fromChord = false
          held = e.copy()
          afterHold(holdTime, { [weak self] in
            guard let self, self.state == .pending else { return false }
            self.state = .swallowUp
            return true
          }, { [weak self] in self?.noteOnce("PS tab: Tab held while PS is locked, asking for Touch ID"); self?.app?.touchUnlock() })
          return nil
        }
        // Signed out (no Touch ID lock): holding Tab shows the pop-up with Sign in, since PS has no
        // window to sign in from any more (V1.23). A quick tap is still a normal Tab.
        if mods.isEmpty && !appActive && app?.vaultUnlocked != true && !TouchLock.cachedLocked {
          state = .pending
          chordKey = code; fromChord = false
          held = e.copy()
          afterHold(holdTime, { [weak self] in
            guard let self, self.state == .pending else { return false }
            self.state = .swallowUp
            return true
          }, { [weak self] in self?.noteOnce("PS tab: Tab held while PS is signed out or still opening, showing the pop-up"); self?.app?.showPopup() })
          return nil
        }
        if !mods.isEmpty || appActive || app?.vaultUnlocked != true {
          if let why = TabWatch.ignoredWhy(mods: !mods.isEmpty, appActive: appActive, unlocked: app?.vaultUnlocked == true) { noteIgnored(why) }
          return Unmanaged.passUnretained(e)
        }
        state = .pending
        chordKey = code; fromChord = false
        held = e.copy()
        afterHold(holdTime, { [weak self] in
          guard let self, self.state == .pending else { return false }
          self.state = .showing
          return true
        }, { [weak self] in self?.app?.showOverlay() })
        return nil
      }
    } else {
      switch state {
      case .pending:                                             // a quick tap: a normal Tab
        holdWork?.cancel()
        state = .idle
        repost([held, e.copy()])
        return nil
      case .showing:
        state = .idle
        released()
        return nil
      case .swallowUp:
        state = .idle
        return nil
      case .passUp:
        state = .idle
        return Unmanaged.passUnretained(e)
      case .idle, .optPending, .optShowing:
        return Unmanaged.passUnretained(e)
      }
    }
  }

  /// Tab, / or Right Option let go after this hold showed the list (under the lock, tap thread or main).
  /// Off: hide unless pinned, as always. Tab keeps the list open: the list stays, pinned, with the keyboard
  /// (never over 1Password or Signal). A hold that put a kept list away does nothing more.
  func released() {
    if closingHold { closingHold = false; return }
    if !pinned && stays && app?.kept != true {
      pinned = true
      DispatchQueue.main.async { self.app?.keepOpen() }
      return
    }
    if !pinned { DispatchQueue.main.async { self.app?.hideOverlay() } }
    else { DispatchQueue.main.async { self.app?.panel.makeKey() } }
  }
  /// A hold while the list is kept open by `stays` puts it away (/ and . or Right Option). Under the lock.
  func closesKept() -> Bool { stays && pinned && app?.shown == true && app?.kept != true }

  // ---------- hold / and press . (the developer, 20 Oct 2026) ----------
  // In addition to Tab. When / goes down it is held back (like Tab). A . while / is still down:
  // both are swallowed and the list shows at once (the chord is deliberate, no hold delay), and it
  // stays while / is held; letting go of / hides it unless pinned or kept, like Tab. Anything else
  // (another key, / let go, / repeating) and the / is sent first, in order, so typing "a/b", "//",
  // paths and URLs comes out exactly as typed. Physical keys (ANSI 44 and 47, the same places on
  // The developer's layout, see KeyLayout). With Cmd, Control, Option or Shift it is plain typing.
  enum SlashDecision { case pass, swallow, notMine }
  private func slashChord(_ type: CGEventType, _ e: CGEvent) -> SlashDecision {
    guard type == .keyDown || type == .keyUp else { return .notMine }
    let code = e.getIntegerValueField(.keyboardEventKeycode), down = type == .keyDown
    let plain = e.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty
    let rep = e.getIntegerValueField(.keyboardEventAutorepeat) != 0
    // V1.47: the chord is any pair from the Tab overlay shortcuts list (p.chords); before V1.47 only / then . (the
    // legacy list still is exactly that). chordKey is the first key, swallowDotCode the second.
    if code == swallowDotCode && !down && swallowDotUp { swallowDotUp = false; return .swallow }
    // The chord's . still held down (the developer, 2 Nov 2026: "a sound in the background, like I'm typing"):
    // its repeats used to pass on, landing in the list (which has the keyboard while it is up) or the
    // app behind, and each one played the Mac's alert sound. Every repeat goes until its key up,
    // whatever / does meanwhile. A fresh . down here means its key up was lost (eg a watchdog spell).
    if code == swallowDotCode && down && swallowDotUp {
      if rep { return .swallow }
      swallowDotUp = false
    }
    if state == .idle {
      guard p.startsChord(code), down, plain, !rep, !appActive, !frontIgnored, app?.vaultUnlocked == true else { return .notMine }
      state = .pending
      chordKey = code; fromChord = true; chordAt = CACurrentMediaTime()
      held = e.copy()
      return .swallow
    }
    guard fromChord else { return .notMine }
    switch state {
    case .pending:
      if down && plain && !rep && p.finishesChord(first: chordKey, code: code, heldFor: CACurrentMediaTime() - chordAt) {   // the chord: the list, at once
        held = nil
        state = .showing
        swallowDotUp = true
        swallowDotCode = code
        if closesKept() {                                        // kept open: the chord puts it away
          closingHold = true
          DispatchQueue.main.async { self.app?.hideOverlay() }
          return .swallow
        }
        DispatchQueue.main.async { if let app = self.app, !app.shown { app.showOverlay() } }
        return .swallow
      }
      if code == chordKey && !down {                           // / let go without a . : it was a /
        state = .idle
        repost([held, e.copy()])
        return .swallow
      }
      if down {                                                  // another key, or / repeating: a /
        state = .passUp
        repost([held, e.copy()])
        return .swallow
      }
      return .pass                                               // some other key's key up
    case .showing:
      if code == chordKey {
        if down { return .swallow }                              // / held down: its repeats
        state = .idle
        released()
        return .swallow
      }
      if down && plain && p.chords[chordKey]?.contains(code) == true {   // . pressed again while / holds the list
        swallowDotUp = true
        swallowDotCode = code
        return .swallow
      }
      if code == 48 { return .pass }                             // Tab is Tab while / holds the list
      return .notMine                                            // everything Tab-held does (/ + 1 and so on)
    case .passUp:
      if code == chordKey && !down { state = .idle }
      return .pass
    default:
      return .notMine
    }
  }

  // Hold the RIGHT Option key (keycode 61) for HOLD_SECONDS: list shows while held. Never swallowed,
  // so Option shortcuts and special characters keep working (pressing another key cancels).
  // V1.47: any modifier held alone from the Tab overlay shortcuts list (p.modHolds: Right Option, Right Command, fn
  // and so on), Right Option only before V1.47 (the legacy list still is exactly that).
  static func familyFlag(_ code: Int64) -> CGEventFlags? {
    switch OpenKeysCore.modifierFamily[Int(code)] {
    case "cmd": return .maskCommand
    case "shift": return .maskShift
    case "opt": return .maskAlternate
    case "ctrl": return .maskControl
    case "fn": return .maskSecondaryFn
    default: return nil
    }
  }
  func optionKey(_ e: CGEvent) {
    let code = e.getIntegerValueField(.keyboardEventKeycode)
    guard p.modHolds.contains(code), let flag = TabWatch.familyFlag(code) else { return }
    if state != .idle && code != modCode { return }       // another modifier of the list while one is held
    let down = e.flags.contains(flag)
    let others = !e.flags.intersection(CGEventFlags([.maskCommand, .maskControl, .maskShift, .maskAlternate]).subtracting(flag)).isEmpty
    if down {
      guard state == .idle, !others, !frontIgnored, app?.vaultUnlocked == true else { return }
      state = .optPending
      modCode = code
      afterHold(HOLD_SECONDS, { [weak self] in
        guard let self, self.state == .optPending else { return false }
        self.state = .optShowing
        self.closingHold = self.closesKept()                     // kept open: this hold puts it away
        return true
      }, { [weak self] in
        guard let self else { return }
        self.mu.lock(); let closing = self.closingHold; self.mu.unlock()
        if closing { self.app?.hideOverlay() } else { self.app?.showOverlay() }
      })
    } else {
      if state == .optPending { holdWork?.cancel(); state = .idle }
      else if state == .optShowing {
        state = .idle
        released()
      }
    }
  }

  // Send held key presses on after this callback returns, marked so the tap ignores them.
  func repost(_ events: [CGEvent?]) {
    let list = events.compactMap { $0 }
    held = nil
    if testPosted != nil { testPosted! += list; return }   // a self test copy never sends a key
    postQ.async {   // never through main: a busy main thread must not hold up a key
      for ev in list {
        ev.setIntegerValueField(.eventSourceUserData, value: MAGIC)
        ev.post(tap: .cgSessionEventTap)
      }
    }
  }
}

// MARK: - Self test (PS_SELFTEST=<folder> /Applications/PS.app/Contents/MacOS/PS)
// Checks the page loads with the right security, Supabase (REST, Realtime, vault-auth) is
// reachable, and renders the floating window with FICTIONAL tasks to <folder>/overlay.png (plus
// newtasks-open.png and newtasks-min.png: the New tasks pop-up and its bubble).
enum SelfTest {
  /// The last "add" the list sent (test copies only): the engine has no open vault in a test run, so the new row never
  /// comes back to the list; the add task check judges the message itself.
  static var lastAdd: [String: Any]? = nil
  static func run(_ a: App, _ dir: String) {
    setvbuf(stdout, nil, _IONBF, 0)   // every line reaches the log at once, even if the test is stopped
    // PS_SELFTEST_ONLY=middleclick: the helper inside this PS and the status logic. Native only, no
    // window is shown and no helper is started (Sources/MiddleClick.swift).
    if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "middleclick" {
      print(MiddleClick.selfCheck()); print("DONE"); exit(0)
    }
    if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "project" { ProjectSelfTest.run(a, dir); return }   // Connect your own Supabase (ProjectSelfTest.swift)
    NoWindowWatch.start(a)            // V1.23: from launch on, the main window must never appear (NoWindowSelfTest.swift)
    // PS_SELFTEST_ONLY=power: Minecraft mode's power out stopwatch with a FAKE power source (Sources/PowerWatch.swift).
    // Native only; waits a few seconds so the network and screen guards have samples.
    if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "power" && !MINECRAFT_ENABLED { mcSkipped(a, "power"); return }
    if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "power" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 6) { print(PowerWatch.selfCheck()); print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) }
      return
    }
    if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "nowindow" {
      DispatchQueue.main.asyncAfter(deadline: .now() + 6) { noWindow(a, dir) { hiddenTimers(a) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } } }
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
      let js = """
      // A test copy never goes online: each of these must be stopped inside WebKit, before any connection.
      const r = { secure: isSecureContext, subtle: !!crypto.subtle, title: document.title, text: document.body.innerText.slice(0, 160) };
      const blocked = async (f) => { try { await f(); return 'ALLOWED (bad)'; } catch (e) { return 'blocked'; } };
      r.supabase = await blocked(() => fetch('https://mxusokxekkecebwqgeru.supabase.co/auth/v1/health', { signal: AbortSignal.timeout(3000) }));
      r.website = await blocked(() => fetch('https://cincee.com/client/version.json', { signal: AbortSignal.timeout(3000) }));
      r.socket = await new Promise((res) => { try { const w = new WebSocket('wss://mxusokxekkecebwqgeru.supabase.co/realtime/v1/websocket'); w.onopen = () => { w.close(); res('ALLOWED (bad)'); }; w.onerror = () => res('blocked'); setTimeout(() => res('blocked'), 3000); } catch (e) { res('blocked'); } });
      return JSON.stringify(r);
      """
      a.main.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { res in
        print("MAIN:", (try? res.get()) ?? "error \(res)")
        // Auto reboot: a test copy never registers or talks to the real helper.
        let r = AutoReboot.shared
        print("UNARMED CHECK:", r.helperState == "test" && r.helper.isEmpty ? "ok (test copy: helper never touched)" : "FAIL helper \(r.helperState)", "fileVault=\(r.fileVault)")
        print(MiddleClick.selfCheck())   // Force Touch middle click helper (Sources/MiddleClick.swift)
        if MINECRAFT_ENABLED { print(PowerWatch.selfCheck()) }   // Minecraft mode's power out stopwatch, fake power source (Sources/PowerWatch.swift)
        // Auto reload on a new web build: only when the list is down, the developer is not typing in PS, and
        // Remember me can sign him straight back in.
        let rb = App.reloadBlocker
        let reloadChecks = [
          ("idle-reloads", rb(false, true, false, 0) == nil), ("active-idle-30s-reloads", rb(false, true, true, 31) == nil),
          ("list-up-waits", rb(true, true, false, 999) != nil), ("typing-waits", rb(false, true, true, 5) != nil),
          ("no-remember-waits", rb(false, false, false, 999) != nil)]
        print("AUTORELOAD CHECK:", reloadChecks.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "))
        // The ignored Tab line: the right reason, and at most one line per reason a minute.
        var once = OncePerMinute(); let t0 = Date()
        let why = TabWatch.ignoredWhy
        let tabChecks = [
          ("ps-front", why(true, true, true) == "PS window in front"), ("signed-out", why(false, false, false) == "not signed in yet"),
          ("modifiers", why(true, false, true) == "modifiers held"), ("plain-tab-not-ignored", why(false, false, true) == nil),
          ("first-line", once.allow("a", t0)), ("same-reason-quiet", !once.allow("a", t0.addingTimeInterval(59))),
          ("other-reason-own-line", once.allow("b", t0.addingTimeInterval(1))), ("after-a-minute", once.allow("a", t0.addingTimeInterval(61)))]
        print("TAB IGNORED CHECK:", tabChecks.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "))
        // The nuke only ever aims at a PS.app inside the test folder, never the live app.
        let env = ProcessInfo.processInfo.environment, home = env["PS_SELFTEST"] ?? "/nonexistent"
        let probe = home + "/nukecheck/PS.app"   // an empty folder named PS.app, only for this check
        try? FileManager.default.createDirectory(atPath: probe, withIntermediateDirectories: true)
        let nukeChecks = [
          ("no-target-nothing", Nuke.target(test: true, env: ["PS_SELFTEST": home], bundle: "/Applications/PS.app") == nil),
          ("live-app-refused", Nuke.target(test: true, env: ["PS_SELFTEST": "/Applications", "PS_SELFTEST_NUKE_TARGET": "/Applications/PS.app"], bundle: "/Applications/PS.app") == nil),
          ("outside-folder-refused", Nuke.target(test: true, env: ["PS_SELFTEST": home, "PS_SELFTEST_NUKE_TARGET": "/tmp/PS.app"], bundle: "x") == nil),
          ("escape-refused", Nuke.target(test: true, env: ["PS_SELFTEST": home, "PS_SELFTEST_NUKE_TARGET": home + "/../PS.app"], bundle: "x") == nil),
          ("not-ps-app-refused", Nuke.target(test: true, env: ["PS_SELFTEST": home, "PS_SELFTEST_NUKE_TARGET": home + "/Other.app"], bundle: "x") == nil),
          ("dummy-in-folder-ok", Nuke.target(test: true, env: ["PS_SELFTEST": home, "PS_SELFTEST_NUKE_TARGET": probe], bundle: "x") != nil),
          ("dotdot-escape-refused", Nuke.target(test: true, env: ["PS_SELFTEST": home + "/nukecheck", "PS_SELFTEST_NUKE_TARGET": home + "/nukecheck/PS.app/../../nukecheck/PS.app/.."], bundle: "x") == nil),
          ("live-own-bundle", !FileManager.default.fileExists(atPath: "/Applications/PS.app") || Nuke.target(test: false, env: [:], bundle: "/Applications/PS.app")?.path == "/Applications/PS.app"),
          ("live-missing-refused", Nuke.target(test: false, env: [:], bundle: "/Applications/Other.app") == nil)]
          + NukeRules.renamed(home + "/nukecheck")   // V1.36: a renamed own bundle (fake Applications folder), never anything else
        try? FileManager.default.removeItem(atPath: home + "/nukecheck")   // the test folder's own probe
        print("NUKE TARGET CHECK:", nukeChecks.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "))
        let today = ISO8601DateFormatter().string(from: Date()).prefix(10)
        let todo: (String, String, String, Bool, String?) -> [String: Any] = { id, title, type, done, due in
          ["id": id, "ws": NSNull(), "kind": "todo", "author": NSNull(), "updatedAt": NSNull(),
           "data": ["title": title, "type": type, "done": done, "due": due as Any? ?? NSNull(), "order": 0]] }
        let p1todo: (String) -> [String: Any] = { id in   // t3 joins the P1 group
          var d = todo(id, "Send Northwind Silk the homepage draft", "once", false, String(today)); var data = d["data"] as! [String: Any]; data["p1"] = true; d["data"] = data; return d }
        // "red": the fictional account counts as the developer's (his own panels), like Owner.red in a test copy
        // (PS_SELFTEST_RED=0 makes it a stranger's). Live PS gets it from the vault's own answer only.
        let state: [String: Any] = ["type": "state", "unlocked": true, "red": Owner.red, "lastSync": NSNull(), "docs": [
          todo("t1", "Gym", "daily", true, nil), todo("t2", "Psychology lesson", "daily", false, nil),
          p1todo("t3"),
          todo("t4", "Invoice Example Co", "once", false, String(today)),
          // 48 hours past its date: on the Overdue card bottom right, not on the list (the developer, 4 Nov 2026; it replaced Urgent).
          todo("t7", "Chase the Example Co deposit", "once", false, "2026-01-02"),
          // Priority 1 group (optional, several at once): t3 and t5; t6 counts on from P2.
          ["id": "t5", "ws": NSNull(), "kind": "todo", "author": NSNull(), "updatedAt": NSNull(), "data": ["title": "Approve the Northwind Silk lookbook", "type": "once", "done": false, "order": 1, "p1": true]],
          ["id": "t6", "ws": NSNull(), "kind": "todo", "author": NSNull(), "updatedAt": NSNull(), "data": ["title": "Reply to Example Co about the A+ images", "type": "once", "done": false, "order": 3]],
          ["id": "s1", "ws": NSNull(), "kind": "settings", "author": NSNull(), "updatedAt": NSNull(), "data": ["workingOn": "t3",
            "lastResetAt": ISO8601DateFormatter().string(from: Date()),   // reset just now: no end of day question in the usual pictures
            // Dimension X: fictional cards in all three bands, plus Be aware.
            "dimx": [("dx1", "Send Northwind Silk the revised timeline", "act"), ("dx2", "Record the homepage walkthrough video", "act"),
                     ("dx3", "Reply to the Example Co pricing question", "act"),
                     ("dx4", "Plan the CRO test list for Q1", "soon"), ("dx5", "Redo the case study page", "soon"),
                     ("dx6", "Learn the new checkout extensibility", "soon"), ("dx7", "Write the holiday offer email", "soon"),
                     ("dx8", "Maybe a podcast about redesigns?", "x"), ("dx9", "Buy a better microphone", "x"), ("dx10", "Ask for a referral", "x"),
                     ("dx11", "Try a 4 day week in November", "x"), ("dx12", "New portfolio photos", "x"), ("dx13", "Read the Hormozi offer book again", "x")]
              .map { (t: (String, String, String)) -> [String: Any] in
                var item: [String: Any] = ["id": t.0, "text": t.1, "zone": t.2, "createdAt": ISO8601DateFormatter().string(from: Date())]
                // A few styled cards (the style menu): glisten, flicker, glow, highlight, upside down, caps.
                let styles: [String: [String: Any]] = [
                  "dx1": ["fx": "glisten", "color": "gold", "bold": true], "dx4": ["fx": "flicker", "color": "red"],
                  "dx8": ["fx": "glow", "color": "purple", "size": "l"], "dx9": ["highlight": "pink"],
                  "dx10": ["fx": "flip"], "dx11": ["caps": true, "underline": true, "color": "ice"], "dx13": ["size": "xl", "italic": true]]
                if let st = styles[t.0] { item["style"] = st }
                return item
              },
            "aware": [["id": "aw1", "text": "Northwind Silk launch is tomorrow at 9", "createdAt": ISO8601DateFormatter().string(from: Date())],
                      ["id": "aw2", "text": "Card payment fails on the test store", "createdAt": ISO8601DateFormatter().string(from: Date())]],
            "suggestions": [
            // New tasks pop-up: one ASAP from Telegram, one plain Telegram task, one from Claude (all fictional).
            ["id": "sg1", "title": "Call the printer about the Northwind Silk lookbook proof", "type": "once", "asap": true, "from": "telegram",
             "createdAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-240))],
            ["id": "sg2", "title": "Book the dentist for next week", "type": "once", "from": "telegram", "zone": "soon",
             "createdAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3 * 3600))],
            ["id": "sg3", "title": "Send Northwind Silk the homepage mobile fixes", "type": "once", "clientId": "cl1", "due": String(today),
             "note": "Mobile fixes are live on the preview link", "claudeDone": true,
             "createdAt": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-1800))]]]],
          ["id": "cl1", "ws": NSNull(), "kind": "client", "author": NSNull(), "updatedAt": NSNull(), "data": ["name": "Northwind Silk", "contactName": "Jane Doe", "email": "jane@northwindsilk.example"]],
          ["id": "r1", "ws": NSNull(), "kind": "reply", "author": NSNull(), "updatedAt": NSNull(), "data": [
            "clientId": "cl1", "account": "person18@gmail.com", "threadId": "abc", "msgIds": ["m1"], "from": "jane@northwindsilk.example", "fromName": "Jane Doe",
            "subject": "Homepage draft", "snippet": "Hi Sam. Loved the draft! Can we move the banner up a little? Also the font feels small on phones.",
            "date": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600)), "count": 2, "handled": false]],
          ["id": "c1", "ws": NSNull(), "kind": "calendar", "author": NSNull(), "updatedAt": NSNull(), "data": [
            "account": "test", "at": ISO8601DateFormatter().string(from: Date()), "from": "", "to": "", "events": [
              ["id": "e1", "title": "Call with Northwind Silk", "allDay": false, "link": "https://meet.google.com/abc-defg-hij",
               "start": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3 * 3600)),
               "end": ISO8601DateFormatter().string(from: Date().addingTimeInterval(4 * 3600)), "attendees": []]]]],
        ]]
        // Campaign stats: FICTIONAL numbers from web scripts/cstats-fake.ts (PS_SELFTEST_STATS=<file>).
        var withStats = state
        if let path = ProcessInfo.processInfo.environment["PS_SELFTEST_STATS"], let raw = FileManager.default.contents(atPath: path),
           let stats = try? JSONSerialization.jsonObject(with: raw), var docs = state["docs"] as? [Any] {
          docs.append(["id": "cs1", "ws": NSNull(), "kind": "cstats", "author": NSNull(), "updatedAt": NSNull(), "data": stats])
          withStats["docs"] = docs
        }
        // Follow-up Radar: FICTIONAL follow-up engine and reply feed from web scripts/radar-fake.ts (PS_SELFTEST_RADAR=<file>).
        if let path = ProcessInfo.processInfo.environment["PS_SELFTEST_RADAR"], let raw = FileManager.default.contents(atPath: path),
           let feeds = try? JSONSerialization.jsonObject(with: raw) as? [String: Any], var docs = withStats["docs"] as? [Any] {
          if let f = feeds["fup"] { docs.append(["id": "fup1", "ws": NSNull(), "kind": "fup", "author": NSNull(), "updatedAt": NSNull(), "data": f]) }
          if let r = feeds["irep"] { docs.append(["id": "irep1", "ws": NSNull(), "kind": "irep", "author": NSNull(), "updatedAt": NSNull(), "data": r]) }
          withStats["docs"] = docs
        }
        a.lastState = String(data: try! JSONSerialization.data(withJSONObject: withStats), encoding: .utf8)
        a.showOverlay()
        // PS_SELFTEST_ONLY=jitter: just the per look pixel check (quick to repeat).
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "panels" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { panels(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "reboot" {   // RebootSelfTest.swift
          DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { rebootCheck(a) { rebootCardCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } } }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "seriesmap" {   // the Map pill (SeriesMapSelfTest.swift)
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { mapCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "minecraft" && !MINECRAFT_ENABLED { mcSkipped(a, "minecraft"); return }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "mcoff" {   // Minecraft mode switched off: every way in is gone (MinecraftSelfTest.swift)
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { minecraftOffCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "minecraft" {   // translator, screenshot reader, torch (MinecraftSelfTest.swift)
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { minecraftCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "screenfit" {   // the list on every screen size (ScreenFitSelfTest.swift, V1.40)
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { screenFitCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "pin" {   // tap a task, pin a screen (PinSelfTest.swift)
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { pinCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "gsquad" {   // G Squad in the Tab list, V1.40 (GSquadSelfTest.swift)
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { gsquadCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "editmode" {   // the Tab list's Edit mode, G Squad (EditModeSelfTest.swift); PS_SELFTEST_RED=0 too
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { editModeCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "numerology" {   // Numerology (NumerologySelfTest.swift)
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { numCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        // PS_SELFTEST_ONLY=screentime: screen time on someone else's PS (ScreenTimeSelfTest.swift). Run with PS_SELFTEST_RED=0 and =1.
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "screentime" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { screenTimeCheck(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        // PS_SELFTEST_ONLY=tabstays: Tab keeps the list open (TabStaysSelfTest.swift). PS_SELFTEST_RED=0 for a stranger's default.
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "tabstays" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2) { tabStays(a) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "watchdog" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2) { watchdog(a) { slashChord(a) { tabStays(a) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } } } }
          return
        }
        // PS_SELFTEST_ONLY=stack: the card stack at the top right, its first checks then the capped, scrollable
        // stack (Toast.selfTest ends in StackSelfTest.swift).
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "stack" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2) { Toast.shared.selfTest(dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          return
        }
        // PS_SELFTEST_ONLY=notelook: the notification colours and sounds per kind (NoteLookSelfTest.swift, V1.36).
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "notelook" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2) { Toast.shared.noteLookSelfTest(dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "netcheck" {
          // Proves the network check sees sockets: one local only socket (127.0.0.1), never online.
          let fd = socket(AF_INET, SOCK_DGRAM, 0)
          var addr = sockaddr_in(); addr.sin_family = sa_family_t(AF_INET); addr.sin_addr.s_addr = inet_addr("127.0.0.1"); addr.sin_port = 0
          _ = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
          DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            print("NETCHECK CONTROL (must FAIL, it sees the local socket):", NetGuard.report())
            close(fd)
            print(ScreenGuard.report()); print("DONE"); exit(0)
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "clickopen" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { clickOnlyOpen(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "mini" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { miniTasks(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "work" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { workClick(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "sections" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { sectionMove(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "brief" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { briefTab(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if let only = ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"], only == "settingsui" || only == "settingsupdate" || only == "rename" || only == "updatepopup" {
          // Updates in the gear menu (Updater.swift, UpdaterSelfTest.swift); fixtures from tests/updater-test.sh. rename: Settings > App name (V1.36).
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { if only == "settingsui" { UpdaterSelfTest.settingsPictures(a) } else if only == "updatepopup" { UpdaterSelfTest.updatePopup(a) } else if only == "rename" { UpdaterSelfTest.renameFlow(a) } else { UpdaterSelfTest.settingsUpdate(a) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "bgvideo" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { bgVideo(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if let only = ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"], only == "rulebook" || only == "nuke" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { ruleBook(a, dir, nuke: only == "nuke") { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "looks" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { p1Looks(a, dir) {
              if ProcessInfo.processInfo.environment["PS_SELFTEST_THEN"] == "panels" { panels(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } } else { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) }
            } }
          }
          return
        }
        if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "jitter" {
          DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { jitter(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } }
          }
          return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
          a.overlay.evaluateJavaScript("document.querySelectorAll('.tm-tick')[1].click(); document.querySelectorAll('.tm-text')[0].click()", completionHandler: nil)
          // Mouse near the bottom edge: must not crash, and the page must receive it.
          if let feed = a.panel.contentView as? MouseFeed, let ev = NSEvent.mouseEvent(with: .mouseMoved, location: NSPoint(x: 400, y: 30), modifierFlags: [], timestamp: 0, windowNumber: a.panel.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0) {
            a.overlay.evaluateJavaScript("window.__mm=0;document.addEventListener('mousemove',function(){window.__mm++},true)", completionHandler: nil)
            MouseFeed.testMove = true
            for _ in 0..<5 { feed.mouseMoved(with: ev) }
            MouseFeed.testMove = false
            Thread.sleep(forTimeInterval: 0.05)
          }
          a.overlay.evaluateJavaScript("window.__mm") { v, _ in print("MOUSE CHECK: page got \(v ?? "nothing") mousemove") }
          // New tasks: the big pop-up first, then minimized into its bubble above Be aware.
          let ntJS = "JSON.stringify({cards: document.querySelectorAll('.nt-card').length, asap: document.querySelectorAll('.nt-chip.asap').length, telegram: document.querySelectorAll('.nt-chip.tg').length, claude: document.querySelectorAll('.nt-chip.cl').length, zone: document.querySelectorAll('.nt-chip.zone').length, dests: document.querySelectorAll('.nt-dest').length, accept: [...document.querySelectorAll('.nt-yes small')].map(function(e){return e.textContent}), bubble: !!document.querySelector('.nt-slot.show .nt-bubble'), count: (document.querySelector('.nt-b-n') || {}).textContent || null})"
          a.overlay.evaluateJavaScript(ntJS) { v, _ in print("NEWTASKS OPEN:", v ?? "nothing") }
          snap(a.overlay, "\(dir)/newtasks-open.png") {
            // Accept the Claude task straight into Dimension X (the bridge must carry the zone).
            a.overlay.evaluateJavaScript("document.querySelectorAll('.nt-card')[2].querySelector('.nt-dest.d-x').click()", completionHandler: nil)
            a.overlay.evaluateJavaScript("document.querySelector('.nt-min').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
              a.overlay.evaluateJavaScript(ntJS) { v, _ in print("NEWTASKS MINIMIZED:", v ?? "nothing") }
              snap(a.overlay, "\(dir)/newtasks-min.png") { if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "net" { netMonitor(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "island" { listAndLocked(a, dir); return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "netmon" { netMonitor(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "afk" { afkCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "media" { mediaCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "mixer" { mixCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "route" { routeCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "hpmode" { hpCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "fu" { fuCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "ays" { aysCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "meet" { meetCards(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "dnd" { dndCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "fitness" { fitnessCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "second" { secondCheck(a, dir) { listAndLocked(a, dir) }; return }; if ProcessInfo.processInfo.environment["PS_SELFTEST_ONLY"] == "addtask" { addTask(a, dir) { listAndLocked(a, dir) }; return }; urgent(a, dir) { dimx(a, dir) { stats(a, dir) { radar(a, dir) { p1Looks(a, dir) { panels(a, dir) { addTask(a, dir) { netMonitor(a, dir) { meetCards(a, dir) { afkCheck(a, dir) { notesCheck(a, dir) { mediaCheck(a, dir) { mixCheck(a, dir) { aysCheck(a, dir) { fuCheck(a, dir) { routeCheck(a, dir) { hpCheck(a, dir) { dndCheck(a, dir) { secondCheck(a, dir) { fitnessCheck(a, dir) { ruleBook(a, dir, nuke: false) { numCheck(a, dir) { mapCheck(a, dir) { listAndLocked(a, dir) } } } } } } } } } } } } } } } } } } } } } } } }
            }
          }
        }
      }
    }
  }
  // Dimension X: open it by resting on the purple X, picture it, drag two cards (band to band, band
  // into the task list), then Esc: the first closes only Dimension X, the second the whole list.
  static func dimx(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let count = "JSON.stringify({open: !!document.querySelector('.dx-win'), act: document.querySelectorAll('.z-act .dx-card').length, soon: document.querySelectorAll('.z-soon .dx-card').length, x: document.querySelectorAll('.z-x .dx-card').length, prio: document.querySelectorAll('.z-prio .dx-row').length, aware: document.querySelectorAll('.z-aware .dx-row').length, button: !!document.querySelector('.tm-left .dx-x')})"
    a.overlay.evaluateJavaScript("(function(){var b=document.querySelector('.dx-x'); if(!b) return 'no button'; b.click(); return 'clicked'})()") { v, _ in print("DIMX OPEN BY CLICK:", v ?? "nothing") }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
      a.overlay.evaluateJavaScript(count) { v, _ in print("DIMX OPEN:", v ?? "nothing", "flag=\(a.dimxOpen)", "pinned=\(TabWatch.shared.pinned)") }
      a.overlay.evaluateJavaScript("window.dispatchEvent(new CustomEvent('dx-strike', {detail: 'hold'}))", completionHandler: nil)
      snap(a.overlay, "\(dir)/dimx-open.png") {
        a.overlay.evaluateJavaScript("window.dispatchEvent(new CustomEvent('dx-strike', {detail: 'go'}))", completionHandler: nil)
        styleMenu(a, dir) {
        let drag = """
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const mid = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
        const fire = (t, type, x, y) => t.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true }));
        async function dragTo(card, tx, ty) {
          const [x, y] = mid(card);
          fire(card, 'pointerdown', x, y);
          for (let i = 1; i <= 14; i++) { fire(window, 'pointermove', x + (tx - x) * i / 14, y + (ty - y) * i / 14); await sleep(28); }
          await sleep(140);
          fire(window, 'pointerup', tx, ty);
          await sleep(500);
        }
        const act = document.querySelector('.z-act').getBoundingClientRect();
        await dragTo(document.querySelector('.z-x .dx-card'), act.right - 40, act.bottom - 24);
        const rows = document.querySelector('.z-prio .dx-rows').getBoundingClientRect();
        await dragTo(document.querySelector('.z-act .dx-card'), rows.left + rows.width / 2, rows.top + 8);
        return 'dragged';
        """
        a.overlay.callAsyncJavaScript(drag, arguments: [:], in: nil, in: .page) { r in
          print("DIMX DRAG:", (try? r.get()) ?? "error \(r)")
          a.overlay.evaluateJavaScript(count) { v, _ in print("DIMX AFTER DRAG:", v ?? "nothing") }
          snap(a.overlay, "\(dir)/dimx-drag.png") {
            a.escKey()                                         // the first Esc
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
              a.overlay.evaluateJavaScript("!!document.querySelector('.dx-win')") { v, _ in
                let first = (v as? Bool) == false && a.shown && !a.dimxOpen
                snap(a.overlay, "\(dir)/dimx-closed.png") {
                  a.escKey()                                   // the second Esc
                  DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    print("DIMX ESC CHECK:", "first-closes-only-dimx=\(first ? "ok" : "FAIL")", "second-closes-list=\(!a.shown ? "ok" : "FAIL")")
                    a.showOverlay()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { done() }
                  }
                }
              }
            }
          }
        }
        }
      }
    }
  }
  // Dimension X card styles: right click opens the style menu (picture), a pick saves; a click
  // selects, Backspace deletes (Undo toast), Cmd+Z brings it back; Esc while editing keeps it open.
  static func styleMenu(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let js = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const r = {};
    const card = document.querySelector('.z-soon .dx-card');
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await sleep(500);
    r.menu = !!document.querySelector('.dx-menu');
    r.styled = { glisten: document.querySelectorAll('.fx-glisten').length, flicker: document.querySelectorAll('.dx-card .fx-flicker').length, glow: document.querySelectorAll('.dx-card .fx-glow').length,
      flip: document.querySelectorAll('.dx-card .fx-flip').length, highlight: document.querySelectorAll('.dx-t.hl').length, xl: document.querySelectorAll('.dx-card.sz-xl').length };
    return JSON.stringify(r);
    """
    a.overlay.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { res in
      print("DIMX STYLE:", (try? res.get()) ?? "error \(res)")
      // Pick Glisten for that card while the menu is open (the picture shows the live preview).
      a.overlay.evaluateJavaScript("[...document.querySelectorAll('.dx-menu .dx-opt')].find(function(b){return b.textContent==='Glisten'}).click()", completionHandler: nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
        snap(a.overlay, "\(dir)/dimx-menu.png") {
          let keys = """
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const r = {};
          document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          await sleep(200);
          r.menuClosed = !document.querySelector('.dx-menu');
          const card = document.querySelector('.z-x .dx-card');
          const b = card.getBoundingClientRect(), x = b.left + 20, y = b.top + b.height / 2;
          card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 }));
          await sleep(150);
          r.selected = !!document.querySelector('.dx-card.sel');
          const before = document.querySelectorAll('.z-x .dx-card').length;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
          await sleep(500);
          r.deleted = before - document.querySelectorAll('.z-x .dx-card').length;
          r.toast = !!document.querySelector('.dx-toast');
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
          await sleep(300);
          r.restored = document.querySelectorAll('.z-x .dx-card').length === before;
          document.querySelector('.z-act .dx-card').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          await sleep(200);
          r.editing = !!document.querySelector('.dx-edit');
          return JSON.stringify(r);
          """
          a.overlay.callAsyncJavaScript(keys, arguments: [:], in: nil, in: .page) { res in
            print("DIMX KEYS:", (try? res.get()) ?? "error \(res)")
            a.escKey()                                       // Esc while editing: the edit stops, Dimension X stays
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
              a.overlay.evaluateJavaScript("JSON.stringify({open: !!document.querySelector('.dx-win'), editing: !!document.querySelector('.dx-edit')})") { v, _ in
                print("DIMX EDIT ESC:", v ?? "nothing", "flag=\(a.dimxOpen)")
                done()
              }
            }
          }
        }
      }
    }
  }
  // Campaign stats: rest on the pink envelope left of Dimension X, picture each view, then Esc: the
  // first closes only the panel (same native path as Dimension X), the second the whole list.
  // Follow-up Radar (FUP): the button sits left of the Campaign stats envelope; a click opens the panel.
  // Pictures of the tabs, then Esc: the first closes only the panel, the second the list.
  static func radar(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let info = "JSON.stringify({open: !!document.querySelector('.rd-win'), order: [...document.querySelectorAll('.tm-left .tm-xrow > :not(.ed-slot), .tm-left .tm-xrow > .ed-slot > *')].map(function(e){return e.className.split(' ')[0]}), btn: (document.querySelector('.rd-btn') || {}).textContent || null, tab: (document.querySelector('.rd-tabs .on') || {}).textContent || null, rows: document.querySelectorAll('.rd-row, .rd-gate li, .rd-park li, .rd-names li, .rd-decl li, .rd-meet li').length, pin: (document.querySelector('.rd-pin b') || {}).textContent || null})"
    a.overlay.evaluateJavaScript("document.querySelector('.rd-btn') && document.querySelector('.rd-btn').click()", completionHandler: nil)
    let tabs: [(Int, String)] = [(0, "radar-owed"), (1, "radar-gate"), (2, "radar-parked"), (3, "radar-manual"), (4, "radar-meetings"), (5, "radar-waiting")]
    func shoot(_ i: Int) {
      guard i < tabs.count else {
        a.escKey()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
          a.overlay.evaluateJavaScript("!!document.querySelector('.rd-win')") { v, _ in
            let first = (v as? Bool) == false && a.shown && !a.dimxOpen
            a.escKey()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
              print("RADAR ESC CHECK:", "first-closes-only-radar=\(first ? "ok" : "FAIL")", "second-closes-list=\(!a.shown ? "ok" : "FAIL")")
              a.showOverlay()
              DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { done() }
            }
          }
        }
        return
      }
      a.overlay.evaluateJavaScript("(function(){var b=document.querySelectorAll('.rd-tabs button')[\(tabs[i].0)]; if(b) b.click()})()", completionHandler: nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
        a.overlay.evaluateJavaScript(info) { v, _ in print("RADAR \(tabs[i].1.uppercased()):", v ?? "nothing", "flag=\(a.dimxOpen)") }
        snap(a.overlay, "\(dir)/\(tabs[i].1).png") { shoot(i + 1) }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { shoot(0) }
  }
  static func stats(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let count = "JSON.stringify({open: !!document.querySelector('.cs-win'), expanded: document.querySelectorAll('.cs-crow.open').length, steps: document.querySelectorAll('.cs-seq li').length, leftOfDimx: !!document.querySelector('.tm-left .tm-xrow > .cs-dock + .dx-dock, .tm-left .tm-xrow > .ed-slot:has(> .cs-dock) + .ed-slot > .dx-dock'), tab: (document.querySelector('.cs-tabs .on') || {}).textContent || null, tiles: document.querySelectorAll('.cs-tile').length, rows: document.querySelectorAll('.cs-row, .cs-table tbody tr, .cs-rank li, .cs-body').length, stale: !!document.querySelector('.cs-upd.stale'), updated: (document.querySelector('.cs-upd') || {}).textContent || null})"
    a.overlay.evaluateJavaScript("(function(){var b=document.querySelector('.cs-btn'); if(!b) return 'no button'; b.click(); return 'clicked'})()") { v, _ in print("STATS OPEN BY CLICK:", v ?? "nothing") }
    let views: [(String, String)] = [("day", "stats-yesterday"), ("accounts", "stats-accounts"), ("copy", "stats-copy"), ("seq", "stats-sequences"), ("camps", "stats-campaigns"), ("camps+open", "stats-campaign-open")]
    func shoot(_ i: Int) {
      guard i < views.count else {
        a.escKey()                                             // the first Esc
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
          a.overlay.evaluateJavaScript("!!document.querySelector('.cs-win')") { v, _ in
            let first = (v as? Bool) == false && a.shown && !a.dimxOpen
            a.escKey()                                         // the second Esc
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
              print("STATS ESC CHECK:", "first-closes-only-stats=\(first ? "ok" : "FAIL")", "second-closes-list=\(!a.shown ? "ok" : "FAIL")")
              a.showOverlay()
              DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { done() }
            }
          }
        }
        return
      }
      let tab = views[i].0.replacingOccurrences(of: "+open", with: "")
      a.overlay.evaluateJavaScript("window.dispatchEvent(new CustomEvent('cs-tab', {detail: '\(tab)'}))" + (views[i].0.hasSuffix("+open") ? ";setTimeout(function(){window.dispatchEvent(new CustomEvent('cs-expand-first'))},300)" : ""), completionHandler: nil)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
        a.overlay.evaluateJavaScript(count) { v, _ in print("STATS \(views[i].0.uppercased()):", v ?? "nothing", "flag=\(a.dimxOpen)", "pinned=\(TabWatch.shared.pinned)") }
        snap(a.overlay, "\(dir)/\(views[i].1).png") { shoot(i + 1) }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { shoot(0) }
  }
  // Overdue (it replaced Urgent and keeps its .tm-aware look): every item has a tick; ticking sends
  // tick like the list, the Undo button ticks it back. Picture of Overdue with its ticks first.
  static func urgent(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    a.overlay.evaluateJavaScript("JSON.stringify({items: document.querySelectorAll('.tm-aware li').length, ticks: document.querySelectorAll('.tm-aware-tick').length, title: (document.querySelector('.tm-aware-h') || {}).textContent})") { v, _ in
      print("URGENT:", v ?? "nothing")
      snap(a.overlay, "\(dir)/urgent-ticks.png") {
        a.overlay.evaluateJavaScript("document.querySelector('.tm-aware-tick').click()", completionHandler: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
          a.overlay.evaluateJavaScript("JSON.stringify({left: document.querySelectorAll('.tm-aware li').length, undo: (document.querySelector('.tm-undo .tm-undo-t') || {}).textContent || null})") { v, _ in
            print("URGENT TICKED:", v ?? "nothing")
            a.overlay.evaluateJavaScript("document.querySelector('.tm-undo') && document.querySelector('.tm-undo').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { done() }
          }
        }
      }
    }
  }
  // The hidden main page must answer PS at once: PS's own 20 s "pull" nudge is what keeps Telegram
  // tasks and Claude's packages flowing, so every nudge (one every 2 s here, for 30 s, window
  // hidden) must run in the page within half a second. The page's own timer ticks are shown too
  // (WebKit still slows hidden page timers somewhat; informational only).
  static func hiddenTimers(_ a: App, _ done: @escaping () -> Void) {
    a.main.evaluateJavaScript("window.__t = 0; setInterval(function () { window.__t++; }, 2000); true", completionHandler: nil)
    a.window.orderOut(nil)
    a.keepAwake(true)
    var worst = 0.0, answered = 0
    for k in 1...15 {
      DispatchQueue.main.asyncAfter(deadline: .now() + Double(k) * 2) {
        let sent = Date()
        a.main.callAsyncJavaScript("return 1", arguments: [:], in: nil, in: .page) { _ in
          worst = max(worst, Date().timeIntervalSince(sent)); answered += 1
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 31.5) {
      a.main.evaluateJavaScript("window.__t") { v, _ in
        let n = (v as? Int) ?? -1
        let ok = answered == 15 && worst < 0.5
        print("HIDDEN PAGE CHECK:", ok ? "ok" : "FAIL", "nudges answered=\(answered)/15 slowest=\(Int(worst * 1000))ms", "page timer ticks=\(n) of 15 (info)")
        a.keepAwake(false)
        done()
      }
    }
  }
  // Priority 1: one outline round the whole P1 group, P numbers 1, 1, then 2, 3; pictures of
  // several looks (picked by clicking their tiles in the gear menu).
  /// Opens the gear's Settings on Looks, clicks one Outline or Background tile (click only), optionally turns the
  /// lightning up to full and thunder on or off, then closes Settings again.
  static func pickLook(_ a: App, _ kind: String, _ id: String, storm: Bool = false, sound: Bool? = nil, _ done: @escaping (String) -> Void) {
    let js = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    if (!document.querySelector('.ms-win')) {
      const gear = document.querySelector('.tm-tr button[aria-label=Settings]');
      if (!gear) return 'no gear';
      if (!document.querySelector('.gs-win')) { gear.click(); await sleep(250); }   // V1.32: the gear opens the full screen Settings
      const more = document.querySelector('.gs-win [data-tab=looks]') || document.querySelector('.tm-more-btn');
      if (!more) return 'no Looks tab';
      more.click(); await sleep(800);
    }
    const win = document.querySelector('.ms-win');
    if (!win) return 'no window';
    const counts = { outline: win.querySelectorAll('.ms-tile[data-kind=outline]').length, bg: win.querySelectorAll('.ms-tile[data-kind=bg]').length,
      previews: win.querySelectorAll('.ms-peek-btn').length, dwell: win.querySelectorAll('.ms-grid .dwell').length };
    const t = win.querySelector('.ms-tile[data-kind="' + kind + '"][data-id="' + id + '"]');
    if (!t) { window.__psDimxClose && window.__psDimxClose(); await sleep(700); return 'no tile ' + kind + ' ' + id; }
    t.click(); await sleep(350);
    if (storm) {
      for (const [l, v] of [['Lightning brightness', 100], ['How often it strikes', 100]]) {
        const r = win.querySelector('input[aria-label="' + l + '"]');
        if (!r) continue;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, String(v));
        r.dispatchEvent(new Event('input', { bubbles: true })); await sleep(80);
        r.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true })); await sleep(200);
      }
    }
    if (sound !== null) {
      const seg = win.querySelector('[aria-label="Thunder sounds"]');
      const b = seg && [...seg.querySelectorAll('button')].find((x) => x.textContent === (sound ? 'On' : 'Off'));
      if (b) { b.click(); await sleep(300); }
    }
    window.__psDimxClose && window.__psDimxClose(); await sleep(750);
    return JSON.stringify({ ok: !document.querySelector('.ms-win'), samplesWhileClosed: document.querySelectorAll('.tm-p1-sample').length, ...counts });
    """
    let args: [String: Any] = ["kind": kind, "id": id, "storm": storm, "sound": sound.map { $0 as Any } ?? NSNull()]
    a.overlay.callAsyncJavaScript(js, arguments: args, in: nil, in: .page) { r in
      done(((try? r.get()) as? String) ?? "error \(r)")
    }
  }
  static func p1Looks(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let q = "JSON.stringify({labels: [...document.querySelectorAll('.tm-list[data-sec=prio] > .tm-row .tm-prio')].map(function(e){return e.textContent}), p1rows: document.querySelectorAll('.tm-row.p1').length, frames: document.querySelectorAll('.tm-p1-frame:not(.mini)').length, look: ((document.querySelector('.tm-p1-frame:not(.mini)')||{}).className||'').replace('tm-p1-frame ',''), bg: ((document.querySelector('.tm-overlay > .tm-p1-scene, .tm-overlay > .tm-storm')||{}).className||'none'), covers: (function(){var f=document.querySelector('.tm-p1-frame:not(.mini)'); var r=[...document.querySelectorAll('.tm-row.p1')]; if(!f||!r.length) return false; var fb=f.getBoundingClientRect(), x=r[0].getBoundingClientRect(), y=r[r.length-1].getBoundingClientRect(); return fb.top<=x.top && fb.bottom>=y.bottom && fb.left<=x.left && fb.right>=x.right})()})"
    a.overlay.evaluateJavaScript(q) { v, _ in print("P1 CHECK:", v ?? "nothing") }
    moreSettings(a, dir) { clickOnly(a, dir) { clocks(a, dir) { p1Drops(a, dir) { bgVideo(a, dir) { briefTab(a, dir) { clickOnlyOpen(a, dir) { sectionMove(a, dir) { miniTasks(a, dir) { workClick(a, dir) { p1LooksRun(a, dir, q, done) } } } } } } } } } }
  }
  /// The big screens open only on a real click (the developer, 23 Oct 2026): resting the mouse on Dimension X,
  /// Campaigns, FUP and the morning brief's sun for 3 s each opens nothing; a click opens each.
  static func clickOnlyOpen(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    // a fictional brief, so the sun button is live for this check
    let keep = a.lastState
    if let st = keep, var j = try? JSONSerialization.jsonObject(with: Data(st.utf8)) as? [String: Any], var docs = j["docs"] as? [[String: Any]] {
      docs.append(["id": "brief-test-2", "ws": NSNull(), "kind": "brief", "author": NSNull(), "updatedAt": NSNull(), "data": [
        "date": String(ISO8601DateFormatter().string(from: Date()).prefix(10)), "headline": "A fictional brief", "createdAt": ISO8601DateFormatter().string(from: Date()),
        "weather": [], "stats": [], "sections": [["title": "Alerts", "tone": "alert", "items": ["Nothing real"]]]]])
      j["docs"] = docs
      a.lastState = (try? JSONSerialization.data(withJSONObject: j)).flatMap { String(data: $0, encoding: .utf8) }
      a.pushState()
    }
    let js = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const list = [['dimension-x', '.dx-x', '.dx-win'], ['campaigns', '.cs-btn', '.cs-win'], ['fup', '.rd-btn', '.rd-win'], ['brief', '.bf-sun', '.bf-win']];
    const anyOpen = () => !!document.querySelector('.dx-win, .cs-win, .rd-win, .bf-win');
    const out = [];
    for (const [name, btn, win] of list) {
      const b = document.querySelector(btn);
      if (!b) { out.push(name + '=absent'); continue; }
      if (b.disabled) { out.push(name + '=disabled'); continue; }
      const r = b.getBoundingClientRect(), o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      b.dispatchEvent(new MouseEvent('mouseover', Object.assign({ relatedTarget: document.body }, o)));
      for (let i = 0; i < 15; i++) { b.dispatchEvent(new MouseEvent('mousemove', o)); await sleep(200); }   // resting 3 s
      const hovered = anyOpen();
      b.dispatchEvent(new MouseEvent('mouseout', Object.assign({ relatedTarget: document.body }, o)));
      b.click(); await sleep(1000);
      const clicked = !!document.querySelector(win);
      window.__psDimxClose && window.__psDimxClose(); await sleep(1000);
      out.push(name + '=' + (!hovered && clicked ? 'ok' : 'FAIL(hover-opened=' + hovered + ' click-opened=' + clicked + ')'));
    }
    return out.join(' ');
    """
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
    a.overlay.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
      let res = ((try? r.get()) as? String) ?? "error \(r)"
      print("CLICK OPENS CHECK:", res.contains("FAIL") || res.contains("error") || res.contains("absent") || res.contains("disabled") ? "FAIL" : "ok", res)
      a.lastState = keep; a.pushState()
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { done() }
    }
    }
  }
  /// Working on (the developer, 27 Oct 2026: clicks often needed several tries). The test copy never saves, like
  /// a slow main window: one click must turn the task white at once; the saved list catching up keeps
  /// it white; a click with no reply shows the saved state again after 6 s; one "work" per click.
  static func workClick(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let keep = a.lastState
    func js(_ code: String, _ next: @escaping (String) -> Void) {
      a.overlay.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in next(String(describing: (try? r.get()) ?? "error")) }
    }
    let row = "const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const row = () => [...document.querySelectorAll('.tm-list > .tm-row')].find((r) => r.querySelector(':scope > .tm-text .tm-t')?.textContent === 'Invoice Example Co'); const w = () => row()?.classList.contains('working') ? 'white' : 'plain';"
    func setSaved(_ ids: [String]) {
      guard let st = a.lastState, var j = try? JSONSerialization.jsonObject(with: Data(st.utf8)) as? [String: Any],
            var docs = j["docs"] as? [[String: Any]], let i = docs.firstIndex(where: { $0["kind"] as? String == "settings" }) else { return }
      var d = docs[i]["data"] as? [String: Any] ?? [:]
      d["workingIds"] = ids; d["workingOn"] = ids.first ?? NSNull()
      docs[i]["data"] = d; j["docs"] = docs
      a.lastState = (try? JSONSerialization.data(withJSONObject: j)).flatMap { String(data: $0, encoding: .utf8) }
      a.pushState()
    }
    let sent0 = a.testRaw.filter { $0.contains("\"type\":\"work\"") }.count
    js(row + " if (!row()) return 'no row'; const errs = []; window.addEventListener('error', (e) => errs.push(String(e.message))); const before = w(); row().querySelector(':scope > .tm-text').click(); await sleep(60); return before + ' -> ' + w() + (errs.length ? ' errors: ' + errs.join(' | ') : '') + ' rows=' + document.querySelectorAll('.tm-list > .tm-row').length + ' pressed=' + row().querySelector(':scope > .tm-text').getAttribute('aria-pressed');") { first in
      print("WORK CHECK click:", first, "(want plain -> white)")
      js(row + " await sleep(2500); return w();") { waiting in
        print("WORK CHECK still white while the save is slow:", waiting)
        setSaved(["t3", "t4"])
        js(row + " await sleep(6800); return w();") { caught in
          print("WORK CHECK saved list caught up, after 6.8 s:", caught, "(want white)")
          js(row + " row().querySelector(':scope > .tm-text').click(); await sleep(60); const now = w(); await sleep(6800); return now + ' then ' + w();") { second in
            print("WORK CHECK second click with no reply:", second, "(want plain then white)")
            let sent = a.testRaw.filter { $0.contains("\"type\":\"work\"") }.count - sent0
            print("WORK CHECK messages sent:", sent, "(want 2)")
            a.lastState = keep; a.pushState()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { done() }
          }
        }
      }
    }
  }
  /// The morning brief in the Tab list (the developer, 23 Oct 2026), with a fictional brief: the sun sits
  /// between screen time and the moon with a gold NEW, a click opens the brief (pictures), it stays
  /// when Tab is let go, resting on a section opens its extra lines and leaving closes them, NEW
  /// clears once opened (the seen mark goes back through the main window, here the test state).
  /// Mini tasks (the developer, 24 Oct 2026): open a task's mini list with a click, add three, tick one and
  /// Undo, edit, delete and Undo, reorder, all done (a glow, never an automatic tick), the task's own
  /// tick and its Undo, the P1 outline taking an open list in, and kept after a reload. The task's own tick and Reset run in PS's main window,
  /// so their effect on mini tasks is proved by the unit test (tests/subtasks.test.ts).
  static func miniTasks(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let keep = a.lastState
    let helpers = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const P = (t, x, y, extra) => new PointerEvent(t, Object.assign({ bubbles: true, cancelable: true, pointerId: 6, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }, extra || {}));
    const setVal = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const key = (el, k, extra) => el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {})));
    window.__mt = {
      T: 'Invoice Example Co',
      row: (t) => [...document.querySelectorAll('.tm-list > .tm-row')].find((r) => r.querySelector(':scope > .tm-text .tm-t')?.textContent === (t || window.__mt.T)),
      items: (r) => [...(r || window.__mt.row()).querySelectorAll('.mt-item')].map((i) => (i.classList.contains('done') ? 'x ' : 'o ') + (i.querySelector('.mt-t')?.textContent || '')),
      count: (r) => (r || window.__mt.row()).querySelector('.mt-count')?.textContent || '',
      mark: (id) => window.webkit.messageHandlers.ps.postMessage(JSON.stringify({ type: 'mark-' + id })),
      open: async () => {
        const r = window.__mt.row(); if (!r) return { error: 'no row' };
        const tg = r.querySelector(':scope > .mt-toggle'), emptyBefore = tg.classList.contains('empty');
        tg.click(); await sleep(750);
        const open = r.classList.contains('mini-open');
        let inp = r.querySelector('.mt-input'); const autoBox = !!inp;
        if (!inp) { r.querySelector('.mt-add').click(); await sleep(200); inp = r.querySelector('.mt-input'); }
        inp.focus();
        for (const t of ['Call Jo', 'Email Sam', 'Text Ana']) { setVal(inp, t); key(inp, 'Enter'); await sleep(160); inp = r.querySelector('.mt-input'); }
        const stillReady = !!inp && document.activeElement === inp;
        inp && inp.blur(); await sleep(500);
        return { emptyBefore, open, autoBox, stillReady, items: window.__mt.items(r), count: window.__mt.count(r) };
      },
      tickUndo: async () => {
        const r = window.__mt.row();
        r.querySelectorAll('.mt-item')[0].querySelector('.mt-tick').click(); await sleep(450);
        const ticked = window.__mt.count(r);
        const undo = document.querySelector('.tm-undo'); const label = undo?.querySelector('.tm-undo-t')?.textContent || '';
        undo && undo.click(); await sleep(450);
        return { ticked, label, undone: window.__mt.count(r) };
      },
      edit: async () => {
        const r = window.__mt.row();
        r.querySelectorAll('.mt-item')[1].querySelector('.mt-t').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await sleep(150);
        const ed = r.querySelector('.mt-edit'); if (!ed) return { error: 'no edit box' };
        setVal(ed, 'Email Sam today'); key(ed, 'Enter'); await sleep(450);
        return { items: window.__mt.items(r) };
      },
      del: async () => {
        const r = window.__mt.row();
        r.querySelectorAll('.mt-item')[2].click(); await sleep(80);
        document.activeElement && document.activeElement.blur && document.activeElement.blur();
        key(window, 'Backspace'); await sleep(450);
        const after = window.__mt.items(r);
        key(window, 'z', { metaKey: true }); await sleep(450);
        return { after, back: window.__mt.items(r) };
      },
      reorder: async () => {
        const r = window.__mt.row(), it = r.querySelectorAll('.mt-item');
        const a0 = it[0].getBoundingClientRect(), a1 = it[1].getBoundingClientRect(), sx = a0.left + 90, sy = a0.top + a0.height / 2, ty = a1.bottom - 3;
        it[0].dispatchEvent(P('pointerdown', sx, sy));
        for (let i = 1; i <= 10; i++) { window.dispatchEvent(P('pointermove', sx, sy + (ty - sy) * i / 10)); await sleep(30); }
        window.dispatchEvent(P('pointerup', sx, ty, { buttons: 0 })); await sleep(600);
        return { items: window.__mt.items(r) };
      },
      allDone: async () => {
        const r = window.__mt.row();
        for (const b of [...r.querySelectorAll('.mt-item:not(.done) .mt-tick')]) { b.click(); await sleep(120); }
        await sleep(500);
        return { count: window.__mt.count(r), glow: r.classList.contains('mini-all'), parentTicked: r.classList.contains('done'), toggleAll: r.querySelector(':scope > .mt-toggle').classList.contains('all') };
      },
      parentTick: async () => {
        const r = window.__mt.row();
        window.__mt.mark('ptick'); r.querySelector(':scope > .tm-tick').click(); await sleep(400);
        window.__mt.mark('pundo'); document.querySelector('.tm-undo')?.click(); await sleep(400);
        return 'ok';
      },
      // the P1 outline takes an open list in (its bottom follows the group's last row)
      p1: async () => {
        const rows = [...document.querySelectorAll('.tm-list[data-sec=prio] > .tm-row.p1')], f = document.querySelector('.tm-list[data-sec=prio] > .tm-p1-frame');
        if (!rows.length || !f) return { error: 'no P1 group' };
        const r = rows[0], tg = r.querySelector(':scope > .mt-toggle');
        const h0 = f.getBoundingClientRect().height;
        tg.click(); await sleep(900);
        const last = rows[rows.length - 1].getBoundingClientRect(), fr = f.getBoundingClientRect();
        const res = { open: r.classList.contains('mini-open'), grew: Math.round(fr.height - h0), fits: Math.abs(fr.bottom - (last.bottom + 10)) < 3 };
        window.__mt.p1row = r;
        return res;
      },
      p1close: async () => { const r = window.__mt.p1row; r && r.querySelector(':scope > .mt-toggle').click(); await sleep(800); return 'ok'; },
    };
    return 'ready';
    """
    func js(_ code: String, _ next: @escaping (String) -> Void) {
      a.overlay.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
        let v = try? r.get()
        if let s = v as? String { next(s) }
        else if let o = v, JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o) { next(String(data: d, encoding: .utf8) ?? "?") }
        else { next("error \(r)") }
      }
    }
    func sentAfter(_ id: String) -> [String] {
      let raw = a.testRaw
      let at = raw.lastIndex { $0.contains("\"mark-\(id)\"") } ?? raw.count
      return raw.count > at ? raw[(at + 1)...].filter { !$0.contains("\"type\":\"mark-") } : []
    }
    // the saved test state: this task's mini tasks and whether its list is open
    func saved() -> (subs: [String], open: Bool) {
      guard let st = a.lastState, let j = try? JSONSerialization.jsonObject(with: Data(st.utf8)) as? [String: Any], let docs = j["docs"] as? [[String: Any]] else { return ([], false) }
      let subs = (docs.first { $0["id"] as? String == "t4" }?["data"] as? [String: Any])?["subtasks"] as? [[String: Any]] ?? []
      let open = ((docs.first { $0["kind"] as? String == "settings" }?["data"] as? [String: Any])?["tmSubOpen"] as? [String])?.contains("t4") ?? false
      return (subs.map { "\(($0["done"] as? Bool) == true ? "x" : "o") \($0["title"] as? String ?? "")" }, open)
    }
    var r: [(String, Bool)] = []
    var notes: [String] = []
    let has = { (s: String, k: String) in s.replacingOccurrences(of: "\\/", with: "/").contains(k) }   // the JSON writer escapes "/"
    js(helpers) { _ in
      js("window.__mt.mark('mt'); return await window.__mt.open()") { o in
        notes.append("open=\(o)")
        r.append(("opens-on-click", has(o, "\"open\":true") && has(o, "\"emptyBefore\":true")))
        r.append(("add-three-enter", has(o, "\"items\":[\"o Call Jo\",\"o Email Sam\",\"o Text Ana\"]") && has(o, "\"count\":\"0/3\"") && has(o, "\"stillReady\":true")))
        r.append(("open-state-saved", saved().open))
        js("return await window.__mt.tickUndo()") { t in
          notes.append("tick=\(t)")
          r.append(("tick-counts-and-undo", has(t, "\"ticked\":\"1/3\"") && has(t, "\"undone\":\"0/3\"") && has(t, "\"label\":\"Call Jo\"")))
          js("return await window.__mt.edit()") { e in
            r.append(("double-click-edit", has(e, "\"o Email Sam today\"")))
            js("return await window.__mt.del()") { d in
              notes.append("delete=\(d)")
              r.append(("backspace-delete-and-undo", has(d, "\"after\":[\"o Call Jo\",\"o Email Sam today\"]") && has(d, "\"back\":[\"o Call Jo\",\"o Email Sam today\",\"o Text Ana\"]")))
              js("return await window.__mt.reorder()") { o2 in
                r.append(("drag-reorder", has(o2, "\"items\":[\"o Email Sam today\",\"o Call Jo\",\"o Text Ana\"]")))
                snap(a.overlay, "\(dir)/mini-open.png") {
                  js("window.__mt.mark('all'); return await window.__mt.allDone()") { al in
                    notes.append("all=\(al)")
                    let parentTicks = sentAfter("all").filter { $0.contains("\"type\":\"tick\"") }
                    r.append(("all-done-glow-no-auto-tick", has(al, "\"glow\":true") && has(al, "\"parentTicked\":false") && has(al, "\"count\":\"3/3\"") && parentTicks.isEmpty))
                    snap(a.overlay, "\(dir)/mini-all-done.png") {
                      js("return await window.__mt.parentTick()") { _ in
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                          // one tick for the task, then one more from its Undo
                          let tk = sentAfter("ptick").filter { $0.contains("\"type\":\"tick\"") && $0.contains("\"t4\"") }
                          let un = sentAfter("pundo").filter { $0.contains("\"type\":\"tick\"") && $0.contains("\"t4\"") }
                          r.append(("parent-tick-and-undo", tk.count >= 2 && un.count >= 1))
                          js("return await window.__mt.p1()") { p in
                            notes.append("p1=\(p)")
                            r.append(("p1-outline-takes-it-in", has(p, "\"open\":true") && has(p, "\"fits\":true")))
                            snap(a.overlay, "\(dir)/mini-p1.png") {
                              js("return await window.__mt.p1close()") { _ in
                                let sv = saved()
                                notes.append("saved=\(sv.subs)")
                                r.append(("saved-in-the-task", sv.subs == ["x Email Sam today", "x Call Jo", "x Text Ana"]))
                                a.overlay.reload()
                                DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
                                  a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
                                  DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                                    js(helpers) { _ in
                                      js("const r = window.__mt.row(); return JSON.stringify({ open: r.classList.contains('mini-open'), items: window.__mt.items(r), count: window.__mt.count(r) })") { rl in
                                        notes.append("reload=\(rl)")
                                        r.append(("kept-after-reload", has(rl, "\"open\":true") && has(rl, "\"count\":\"3/3\"") && has(rl, "\"items\":[\"x Email Sam today\",\"x Call Jo\",\"x Text Ana\"]")))
                                        let ok = r.allSatisfy { $0.1 }
                                        print("MINI TASKS CHECK:", ok ? "ok" : "FAIL", r.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "), notes.joined(separator: " "))
                                        // put the test state back for the steps after this one
                                        a.lastState = keep; a.pushState()
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { done() }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  /// Moving a whole section (the developer, 23 Oct 2026): "Every day" dragged above the main tasks by its
  /// header, the order saved (and still there after the page reloads), dragged back again, and
  /// task drags inside each section still working in the new arrangement.
  static func sectionMove(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let helpers = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const P = (t, x, y, extra) => new PointerEvent(t, Object.assign({ bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }, extra || {}));
    const secs = () => [...document.querySelectorAll('.tm-inner > .tm-sec')];
    window.__sm = {
      order: () => secs().map((s) => s.dataset.key).join(','),
      mark: (id) => window.webkit.messageHandlers.ps.postMessage(JSON.stringify({ type: 'mark-' + id })),
      // grab section k by its header and hold it past the middle of the other one
      hold: async (k) => {
        const me = document.querySelector('.tm-inner > .tm-sec[data-key=' + k + ']'), other = secs().find((s) => s !== me);
        if (!me || !other) return { error: 'missing section' };
        const h = me.querySelector(':scope > .tm-sec-h').getBoundingClientRect(), m = me.getBoundingClientRect(), o = other.getBoundingClientRect();
        const sx = h.left + 16, sy = h.top + h.height / 2, mid = m.top + m.height / 2;
        const d = o.top < m.top ? o.top + 2 - mid : o.bottom - 2 - mid;
        me.querySelector(':scope > .tm-sec-h').dispatchEvent(P('pointerdown', sx, sy));
        for (let i = 1; i <= 14; i++) { window.dispatchEvent(P('pointermove', sx, sy + d * i / 14)); await sleep(30); }
        await sleep(450);
        window.__sm.last = [sx, sy + d];
        return { lifted: 'lifted' in me.dataset, line: !!me.querySelector(':scope > .tm-sec-line'), drop: other.dataset.drop || null, shifted: !!other.style.transform };
      },
      release: async () => { const [x, y] = window.__sm.last; window.dispatchEvent(P('pointerup', x, y, { buttons: 0 })); await sleep(800);
        return { order: window.__sm.order(), clean: !document.querySelector('.tm-sec[data-lifted], .tm-sec[data-drop], .tm-sec-line') && secs().every((s) => !s.style.transform) }; },
      // a task row inside section k: the first dragged just below the second
      row: async (k) => {
        const rows = [...document.querySelectorAll('.tm-list[data-sec=' + k + '] > .tm-row')];
        if (rows.length < 2) return 'too few rows';
        const r0 = rows[0].getBoundingClientRect(), r1 = rows[1].getBoundingClientRect(), sx = r0.left + 70, sy = r0.top + r0.height / 2;
        rows[0].dispatchEvent(P('pointerdown', sx, sy));
        for (let i = 1; i <= 12; i++) { window.dispatchEvent(P('pointermove', sx, sy + (r1.bottom - 4 - sy) * i / 12)); await sleep(30); }
        window.dispatchEvent(P('pointerup', sx, r1.bottom - 4, { buttons: 0 })); await sleep(600);
        return 'ok';
      },
      // the P1 looks follow the group: the overlay's --p1t matches where the group is now
      p1: () => {
        const root = document.querySelector('.tm-overlay'), row = document.querySelector('.tm-list[data-sec=prio] > .tm-row.p1');
        if (!row) return 'none';
        const want = row.getBoundingClientRect().top - root.getBoundingClientRect().top - 10, got = parseFloat(root.style.getPropertyValue('--p1t'));
        return Math.abs(want - got) < 2.5 ? 'ok' : 'FAIL ' + Math.round(got) + ' vs ' + Math.round(want);
      },
    };
    return window.__sm.order();
    """
    func js(_ code: String, _ next: @escaping (String) -> Void) {
      a.overlay.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in
        let v = try? r.get()
        if let s = v as? String { next(s) }
        else if let o = v, JSONSerialization.isValidJSONObject(o), let d = try? JSONSerialization.data(withJSONObject: o) { next(String(data: d, encoding: .utf8) ?? "?") }
        else { next("error \(r)") }
      }
    }
    // what the list sent after a mark
    func sentAfter(_ id: String) -> [String] {
      let raw = a.testRaw
      let at = raw.lastIndex { $0.contains("\"mark-\(id)\"") } ?? raw.count
      return raw.count > at ? raw[(at + 1)...].filter { !$0.contains("\"type\":\"mark-") } : []
    }
    var r: [(String, Bool)] = []
    var notes: [String] = []
    js(helpers) { start in
      r.append(("starts-below", start == "prio,daily"))
      js("window.__sm.mark('up'); return await window.__sm.hold('daily')") { during in
        notes.append("during=\(during)")
        r.append(("lifts-with-line", during.contains("\"lifted\":true") && during.contains("\"line\":true") && during.contains("\"drop\":\"before\"") && during.contains("\"shifted\":true")))
        snap(a.overlay, "\(dir)/section-drag.png") {
          js("return await window.__sm.release()") { after in
            r.append(("every-day-above", after.contains("\"order\":\"daily,prio\"") && after.contains("\"clean\":true")))
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
              r.append(("order-saved", sentAfter("up").contains { $0.contains("looks") && $0.contains("\"tmDailyFirst\":true") }))
              js("return window.__sm.p1()") { p1 in
                notes.append("p1=\(p1)")
                r.append(("p1-follows", p1 == "ok" || p1 == "none"))
                js("window.__sm.mark('rowd'); return await window.__sm.row('daily')") { _ in
                  js("window.__sm.mark('rowp'); return await window.__sm.row('prio')") { _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                      let d = sentAfter("rowd"), p = sentAfter("rowp")
                      r.append(("task-drag-in-every-day", d.contains { $0.contains("\"type\":\"reorder\"") }))
                      r.append(("task-drag-in-main", p.contains { $0.contains("\"type\":\"reorder\"") }))
                      snap(a.overlay, "\(dir)/section-daily-first.png") {
                        // reload the page: the saved order comes back from the settings
                        a.overlay.reload()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) {
                          a.overlay.evaluateJavaScript("document.querySelector('.nt-min') && document.querySelector('.nt-min').click()", completionHandler: nil)
                          DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                            js(helpers) { reloaded in
                              r.append(("kept-after-reload", reloaded == "daily,prio"))
                              js("window.__sm.mark('down'); await window.__sm.hold('prio'); return await window.__sm.release()") { back in
                                r.append(("dragged-back", back.contains("\"order\":\"prio,daily\"") && back.contains("\"clean\":true")))
                                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                                  r.append(("back-saved", sentAfter("down").contains { $0.contains("looks") && $0.contains("\"tmDailyFirst\":false") }))
                                  let ok = r.allSatisfy { $0.1 }
                                  print("SECTION MOVE CHECK:", ok ? "ok" : "FAIL", r.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "), notes.joined(separator: " "))
                                  DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { done() }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  static func briefTab(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let keep = a.lastState
    if let st = keep, var j = try? JSONSerialization.jsonObject(with: Data(st.utf8)) as? [String: Any], var docs = j["docs"] as? [[String: Any]] {
      let today = String(ISO8601DateFormatter().string(from: Date()).prefix(10))
      docs.append(["id": "brief-test-1", "ws": NSNull(), "kind": "brief", "author": NSNull(), "updatedAt": NSNull(), "data": [
        "date": today, "headline": "Two things need you before lunch", "source": "Fictional test brief", "createdAt": ISO8601DateFormatter().string(from: Date()),
        "weather": [["city": "Springfield", "today": "13 C, light rain", "tomorrow": "12 C, windy"], ["city": "Lisbon", "today": "16 C, showers", "tomorrow": "20 C, foggy start"]],
        "stats": [["label": "Replies to answer", "value": "1", "sub": "Northwind Silk", "tone": "warn"], ["label": "Days since a new prospect", "value": "3", "sub": "Book one this week", "tone": "good"]],
        "sections": [["title": "Alerts", "tone": "alert", "items": ["The Northwind invoice is overdue", "A warm lead asked for a call", "The follow up engine is paused", "Two drafts are waiting", "One more alert"]],
                     ["title": "Client updates", "items": ["Northwind posted a teaser", "Petal and Pine started a giveaway", "Halden opened a pop up", "Lumi hired a manager", "Marisol added a gift guide"]]]]])
      j["docs"] = docs
      a.lastState = (try? JSONSerialization.data(withJSONObject: j)).flatMap { String(data: $0, encoding: .utf8) }
      a.pushState()
    }
    func js(_ code: String, _ next: @escaping (String) -> Void) { a.overlay.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in next(((try? r.get()) as? String) ?? "error \(r)") } }
    let step1 = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const b = document.querySelector('.bf-sun');
    const R = { button: !!b };
    if (!b) return JSON.stringify(R);
    const box = b.closest('.ed-slot') || b, prev = box.previousElementSibling, next = box.nextElementSibling;
    const prevEl = prev && prev.classList.contains('ed-slot') ? prev.firstElementChild : prev;
    R.afterScreenTime = !!prevEl && prevEl.classList.contains('tm-st');
    R.beforeMoon = !!next && !!next.querySelector('button[aria-label^="End your day"]');
    R.newBadge = !!b.querySelector('.bf-new');
    b.click(); await sleep(1100);
    R.opens = !!document.querySelector('.bf-win .mb-card');
    R.headline = (document.querySelector('.bf-win .mb-title') || {}).textContent || '';
    return JSON.stringify(R);
    """
    let step2 = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const R = {};
    const sec = [...document.querySelectorAll('.bf-win .mb-sec.mb-hover')].find((x) => /Client updates/.test(x.textContent));
    const col = sec && sec.querySelector('.acc-collapse');
    const ev = (t, rel) => sec.dispatchEvent(new MouseEvent(t, { bubbles: true, relatedTarget: rel || null }));
    // a passing mouse (in and out within 150 ms) opens nothing
    ev('mouseover'); await sleep(150); ev('mouseout', document.body); await sleep(500);
    R.passingStaysShut = !!col && !col.classList.contains('open');
    // resting opens, smoothly (the box below slides: its top moves over several frames)
    const below = sec.nextElementSibling || sec.parentElement.nextElementSibling;
    const y0 = below ? below.getBoundingClientRect().top : 0;
    ev('mouseover'); await sleep(450);
    R.restOpens = col.classList.contains('open');
    await sleep(120); const y1 = below ? below.getBoundingClientRect().top : 0;
    await sleep(500); const y2 = below ? below.getBoundingClientRect().top : 0;
    R.slides = !below || (y1 >= y0 && y2 >= y1);
    R.newGone = !document.querySelector('.bf-sun .bf-new');
    return JSON.stringify(R);
    """
    let step3 = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const sec = [...document.querySelectorAll('.bf-win .mb-sec.mb-hover')].find((x) => /Client updates/.test(x.textContent));
    sec.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); await sleep(800);
    const R = { leaveCloses: !sec.querySelector('.acc-collapse').classList.contains('open') };
    window.__psDimxClose && window.__psDimxClose(); await sleep(900);
    R.escCloses = !document.querySelector('.bf-win');
    return JSON.stringify(R);
    """
    let from = a.testRaw.count
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      js(step1) { r1 in
        let pinned = TabWatch.shared.pinned && a.dimxOpen
        // Tab let go while the brief is open: the list stays
        let w = TabWatch.shared
        w.mu.lock(); w.state = .showing; w.chordKey = 48; w.fromChord = false; w.mu.unlock()
        DispatchQueue.global(qos: .userInteractive).async {
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 48, keyDown: false)!
          _ = w.handle(.keyUp, up)
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            let stays = a.shown
            snap(a.overlay, "\(dir)/brief-open.png") {
              js(step2) { r2 in
                snap(a.overlay, "\(dir)/brief-hover-open.png") {
                  js(step3) { r3 in
                    let seenSent = a.testRaw[from...].contains { $0.contains("briefSeen") && $0.contains("brief-test-1") }
                    let ok = r1.contains("\"button\":true") && r1.contains("\"afterScreenTime\":true") && r1.contains("\"beforeMoon\":true") && r1.contains("\"newBadge\":true")
                      && r1.contains("\"opens\":true") && pinned && stays && r2.contains("\"passingStaysShut\":true") && r2.contains("\"restOpens\":true") && r2.contains("\"slides\":true")
                      && r2.contains("\"newGone\":true") && seenSent && r3.contains("\"leaveCloses\":true") && r3.contains("\"escCloses\":true")
                    print("BRIEF CHECK:", ok ? "ok" : "FAIL", "open=\(r1)", "pinned=\(pinned) stays-on-tab-release=\(stays)", "hover=\(r2)", "close=\(r3)", "seen-sent=\(seenSent)")
                    w.mu.lock(); w.state = .idle; w.pinned = false; w.mu.unlock()
                    a.lastState = keep; a.pushState()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { done() }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  /// The developer's own background videos (the developer, 20 Oct 2026), with a 4 s synthetic clip made here (never his
  /// Drive): PS makes a silent copy, the tile appears, the video plays only while the list shows and
  /// lets go when hidden, the rows do not change, CPU while playing, and the glass slider at minimum.
  static func bgVideo(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let src = URL(fileURLWithPath: dir).appendingPathComponent("bgsrc", isDirectory: true)
    try? FileManager.default.createDirectory(at: src, withIntermediateDirectories: true)
    let clip = src.appendingPathComponent("Test Clip.mp4")
    let ff = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].first { FileManager.default.isExecutableFile(atPath: $0) }
    // PS_SELFTEST_BGCLIP: measure with a real clip (a local file) instead of the made up one.
    let real = ProcessInfo.processInfo.environment["PS_SELFTEST_BGCLIP"]
    guard ff != nil || real != nil else { print("BG VIDEO CHECK: skipped (no ffmpeg to make the test clip)"); done(); return }
    DispatchQueue.global(qos: .utility).async {
      if let real { try? FileManager.default.removeItem(at: clip); try? FileManager.default.copyItem(at: URL(fileURLWithPath: real), to: clip) }
      let p = Process()
      p.executableURL = URL(fileURLWithPath: ff ?? "/usr/bin/true")
      p.arguments = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-f", "lavfi", "-i", "sine=frequency=440",
                     "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip.path]
      if real == nil { try? p.run(); p.waitUntilExit() }
      DispatchQueue.main.async {
        let t0 = CACurrentMediaTime()
        Backgrounds.shared.useTestSource(src) {
          let copy = Backgrounds.shared.localDir.appendingPathComponent("test-clip.mp4")
          let asset = AVURLAsset(url: copy)
          let silent = asset.tracks(withMediaType: .audio).isEmpty && !asset.tracks(withMediaType: .video).isEmpty
          let made = "copy=\(FileManager.default.fileExists(atPath: copy.path)) silent=\(silent) in \(Int(CACurrentMediaTime() - t0)) s listed=\(Backgrounds.shared.list.map { $0["id"] ?? "" })"
          Backgrounds.shared.resend()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            pickLook(a, "bg", "video:test-clip") { picked in
              DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                let probe = "const v = document.querySelector('.tm-bgvideo'); return JSON.stringify(v ? { playing: !v.paused && v.currentTime > 0.2, ready: v.readyState, w: v.videoWidth, src: v.getAttribute('src') || '', muted: v.muted, loop: v.loop, calm: !!document.querySelector('.tm-overlay.tm-calm') } : { none: true })"
                func js(_ code: String, _ next: @escaping (String) -> Void) { a.overlay.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in next(((try? r.get()) as? String) ?? "error \(r)") } }
                js(probe) { playing in
                  // rows: two pictures 150 ms apart, the task rows must not change (since V1.34 the headline is bare text over the background, the developer 5 Nov 2026, so the video may show between its letters)
                  let rowsJS = "return JSON.stringify([...document.querySelectorAll('.tm-list[data-sec=prio] > .tm-row')].map(function(e){var r=e.getBoundingClientRect(); return [r.left+12,r.top+2,r.width-24,r.height-4]}).concat([[0,0,innerWidth,innerHeight]]))"
                  js(rowsJS) { rj in
                    let rects = (try? JSONSerialization.jsonObject(with: Data(rj.utf8)) as? [[Double]]) ?? []
                    a.overlay.takeSnapshot(with: nil) { i1, _ in
                      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                        a.overlay.takeSnapshot(with: nil) { i2, _ in
                          var rowsChanged = -1, screenChanged = -1
                          if let p1 = pixels(i1), let p2 = pixels(i2), let W = rects.last?[2], W > 0 {
                            let k = Double(p1.w) / W
                            rowsChanged = rects.dropLast().reduce(0) { $0 + max(0, changed(p1, p2, CGRect(x: ceil($1[0] * k), y: ceil($1[1] * k), width: floor($1[2] * k), height: floor($1[3] * k)))) }
                            screenChanged = changed(p1, p2, CGRect(x: 0, y: 0, width: p1.w, height: p1.h))
                          }
                          snap(a.overlay, "\(dir)/bg-video.png") {
                            let pid = (a.overlay.value(forKey: "_webProcessIdentifier") as? Int32) ?? 0
                            let gpu = (a.overlay.value(forKey: "_gpuProcessIdentifier") as? Int32) ?? 0
                            let c0 = pid > 0 ? cpuSeconds(pid) : 0, g0 = gpu > 0 ? cpuSeconds(gpu) : 0
                            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                              let cpu = pid > 0 ? String(format: "%.0f%%", (cpuSeconds(pid) - c0) / 3 * 100) : "n/a"
                              let gcpu = gpu > 0 ? String(format: "%.0f%%", (cpuSeconds(gpu) - g0) / 3 * 100) : "n/a"
                              // glass slider at its minimum: since V1.34 the background fades out with it and the video pauses (the developer, 5 Nov 2026), rows still solid
                              js("const r = document.querySelector('.tm-glass-range'); const v0 = r.value; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, '0'); r.dispatchEvent(new Event('input', { bubbles: true })); await new Promise((x) => setTimeout(x, 600)); const v = document.querySelector('.tm-bgvideo'); const out = JSON.stringify({ playing: !!v && !v.paused, opacity: v ? getComputedStyle(v).opacity : null, clear: !!document.querySelector('.tm-overlay.tm-clear') }); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, v0); r.dispatchEvent(new Event('input', { bubbles: true })); return out") { slider in
                                snap(a.overlay, "\(dir)/bg-video-glass-min.png") {
                                  // hidden: it lets go of the file; shown again: it plays again
                                  a.hideOverlay(force: true)
                                  DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                                    js(probe) { hidden in
                                      let g1 = gpu > 0 ? cpuSeconds(gpu) : 0
                                      DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                                        let hcpu = gpu > 0 ? String(format: "%.0f%%", (cpuSeconds(gpu) - g1) / 3 * 100) : "n/a"
                                        a.showOverlay()
                                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                                          js(probe) { again in
                                            let ok = silent && picked.contains("\"ok\":true") && playing.contains("\"playing\":true") && playing.contains("\"muted\":true") && playing.contains("\"calm\":true")
                                              && rowsChanged == 0 && slider.contains("\"playing\":false") && slider.contains("\"opacity\":\"0\"") && hidden.contains("\"src\":\"\"") && !hidden.contains("\"playing\":true")
                                              && again.contains("\"playing\":true") && Backgrounds.shared.ranges > 0
                                            print("BG VIDEO CHECK:", ok ? "ok" : "FAIL", made, "tile-picked=\(picked)", "showing=\(playing)", "rows-changed=\(rowsChanged) screen-changed=\(screenChanged)",
                                                  "cpu-page=\(cpu) cpu-gpu=\(gcpu) gpu-hidden=\(hcpu)", "glass-min=\(slider)", "hidden=\(hidden)", "shown-again=\(again)", "range-requests=\(Backgrounds.shared.ranges)")
                                            pickLook(a, "bg", "none") { _ in bgSync(a, dir, src, done) }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    }
  }
  /// The rule book (the developer, 28 Oct 2026): the white PS button right of Dimension X, WORSHIP full screen,
  /// writing rules (add, edit, move, delete, undo), the end of day rule check from the moon, a stray
  /// click, a scroll and an early let go on Failed doing nothing, all Complied ending the day.
  /// nuke: then holds Failed with real mouse events. Nuke.swift signs the test copy out (memory only,
  /// never the Keychain), puts the dummy PS.app from PS_SELFTEST_NUKE_TARGET in the Trash and quits.
  static func ruleBook(_ a: App, _ dir: String, nuke: Bool, _ done: @escaping () -> Void) {
    let keep = a.lastState
    let rules = ["Fictional rule one: train before the first call", "Fictional rule two: no phone for the first hour", "Fictional rule three: ship one thing a day"]
    if let st = keep, var j = try? JSONSerialization.jsonObject(with: Data(st.utf8)) as? [String: Any], var docs = j["docs"] as? [[String: Any]],
       let i = docs.firstIndex(where: { $0["kind"] as? String == "settings" }) {
      var d = docs[i]["data"] as? [String: Any] ?? [:]
      d["rules"] = rules.enumerated().map { ["id": "rl\($0.offset + 1)", "text": $0.element, "createdAt": ISO8601DateFormatter().string(from: Date())] }
      docs[i]["data"] = d; j["docs"] = docs
      a.lastState = (try? JSONSerialization.data(withJSONObject: j)).flatMap { String(data: $0, encoding: .utf8) }
      a.pushState()
    }
    // A fictional remembered sign in (memory only): the nuke must clear it, as Sign out of this Mac does.
    TouchLock.memSet("remember", Data("fictional-test-sign-in".utf8))
    let from = a.testRaw.count
    let head = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mark = (id) => window.webkit.messageHandlers.ps.postMessage(JSON.stringify({ type: 'mark-' + id }));
    const P = (t, el, extra) => { const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(t, Object.assign({ bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: t === 'pointerup' ? 0 : 1, clientX: r.left + 8, clientY: r.top + 8 }, extra || {}))); };
    const setv = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
    const texts = () => [...document.querySelectorAll('.rb-rule .rb-text')].map((e) => e.textContent);
    const grey = (v) => { const m = String(v).match(/[0-9.]+/g); if (!m || m.length < 3) return true; const [r, g, b] = m.map(Number); return Math.max(r, g, b) - Math.min(r, g, b) <= 14; };
    const R = {};
    """
    let step1 = head + """
    const btn = document.querySelector('.rb-btn'), dx = document.querySelector('.dx-x');
    R.button = !!btn && btn.textContent === 'PS' && !!btn.closest('.tm-xrow');
    R.rightOfDimensionX = !!btn && !!dx && btn.getBoundingClientRect().left >= dx.getBoundingClientRect().right - 1;
    const bs = btn ? getComputedStyle(btn) : {};
    R.white = bs.color === 'rgb(255, 255, 255)'; R.glow = /255, 255, 255/.test(bs.boxShadow || '');
    R.nothingLoops = !!btn && btn.getAnimations().length === 0;
    btn.click(); await sleep(1300);
    R.open = !!document.querySelector('.tm-overlay .rb-layer');
    R.title = (document.querySelector('.rb-title') || {}).textContent;
    R.titleAtTop = !!document.querySelector('.rb-title') && document.querySelector('.rb-title').getBoundingClientRect().top < 140;
    R.fullScreen = !!document.querySelector('.rb') && Math.abs(document.querySelector('.rb').getBoundingClientRect().width - innerWidth) < 2 && Math.abs(document.querySelector('.rb').getBoundingClientRect().height - innerHeight) < 2;
    R.rules = texts().length;
    R.mono = [...document.querySelectorAll('.rb-layer, .rb-layer *')].every((el) => { const c = getComputedStyle(el); return grey(c.color) && grey(c.backgroundColor) && grey(c.borderTopColor); });
    return JSON.stringify(R);
    """
    let step2 = head + """
    const n0 = texts().length;
    mark('add');
    const inp = document.querySelector('.rb-add-in'); setv(inp, 'Fictional rule four: in bed by four'); await sleep(50);
    inp.closest('form').requestSubmit(); await sleep(700);
    R.added = texts().length === n0 + 1 && texts()[n0] === 'Fictional rule four: in bed by four';
    mark('move');
    document.querySelectorAll('.rb-rule')[0].querySelectorAll('.rb-tool')[1].click(); await sleep(700);
    R.moved = texts()[1] === '\(rules[0])' && texts()[0] === '\(rules[1])';
    mark('edit');
    document.querySelectorAll('.rb-rule .rb-text')[0].click(); await sleep(200);
    const ta = document.querySelector('.rb-edit'); setv(ta, 'Fictional rule two, edited'); await sleep(50);
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(700);
    R.edited = texts()[0] === 'Fictional rule two, edited';
    mark('delete');
    const rows = document.querySelectorAll('.rb-rule'); rows[rows.length - 1].querySelector('.rb-tool.del').click(); await sleep(700);
    R.deleted = texts().length === n0 && !!document.querySelector('.rb-undo');
    mark('undo');
    document.querySelector('.rb-undo button').click(); await sleep(700);
    R.undone = texts().length === n0 + 1;
    mark('end');
    window.__psDimxClose && window.__psDimxClose(); await sleep(900);
    R.escCloses = !document.querySelector('.rb-layer');
    return JSON.stringify(R);
    """
    let step3 = head + """
    document.querySelector('.tm-tr [aria-label="End your day (reset the list)"]').click(); await sleep(1300);
    R.checkOpens = (document.querySelector('.rb') || { getAttribute: () => '' }).getAttribute('aria-label') === 'Rule check';
    R.noPopover = !document.querySelector('.tm-endday');
    R.rows = document.querySelectorAll('.rb-tick').length; R.fails = document.querySelectorAll('.rb-fail').length;
    R.endWaits = document.querySelector('.rb-end').disabled;
    const row = document.querySelector('.rb-checklist .rb-rule');
    const tk = row.querySelector('.rb-tick').getBoundingClientRect(), fl = row.querySelector('.rb-fail').getBoundingClientRect();
    R.gapPx = Math.round(tk.left - fl.right);
    const f = () => document.querySelectorAll('.rb-fail')[1];
    mark('stray');
    P('pointerdown', f()); await sleep(90); P('pointerup', f()); f().click(); await sleep(1500);
    R.strayClickSafe = !!document.querySelector('.rb-checklist') && !document.querySelector('.rb-gone');
    P('pointerdown', f()); await sleep(450); R.fillShows = f().classList.contains('holding');
    document.querySelector('.rb-scroll').dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true })); await sleep(1400);
    R.scrollSafe = !!document.querySelector('.rb-checklist') && !document.querySelector('.rb-gone') && !f().classList.contains('holding');
    P('pointerup', f());
    P('pointerdown', f()); await sleep(700); P('pointerup', f()); await sleep(1000);
    R.earlyLetGoSafe = !!document.querySelector('.rb-checklist') && !document.querySelector('.rb-gone');
    document.querySelectorAll('.rb-tick')[0].click(); document.querySelectorAll('.rb-tick')[2].click(); await sleep(400);
    R.count = (document.querySelector('.rb-count') || {}).textContent;
    return JSON.stringify(R);
    """
    let step4 = head + """
    document.querySelectorAll('.rb-tick').forEach((b) => { if (!b.classList.contains('on')) b.click(); }); await sleep(300);
    R.endReady = !document.querySelector('.rb-end').disabled;
    mark('endday');
    document.querySelector('.rb-end').click(); await sleep(900);
    R.closedAfter = !document.querySelector('.rb-layer');
    mark('done');
    return JSON.stringify(R);
    """
    func js(_ code: String, _ next: @escaping (String) -> Void) {
      a.overlay.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in next(((try? r.get()) as? String) ?? "error \(r)") }
    }
    func obj(_ s: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any]) ?? [:] }
    func verdict(_ name: String, _ r: [String: Any], _ want: [String: Any]) {
      let bad = want.filter { k, v in "\(r[k] ?? "nil")" != "\(v)" }.map { "\($0.key)=\(r[$0.key] ?? "nil")" }
      print("\(name):", bad.isEmpty ? "ok" : "FAIL \(bad.sorted().joined(separator: " "))", r)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
      snap(a.overlay, "\(dir)/rulebook-button.png") {
        js(step1) { r1 in
          let pinned = a.dimxOpen
          verdict("RULEBOOK OPEN", obj(r1), ["button": 1, "rightOfDimensionX": 1, "white": 1, "glow": 1, "nothingLoops": 1, "open": 1, "title": "WORSHIP", "titleAtTop": 1, "fullScreen": 1, "rules": 3, "mono": 1])
          print("RULEBOOK PIN:", pinned ? "ok (the list stays and takes the keyboard while it is up)" : "FAIL")
          snap(a.overlay, "\(dir)/rulebook.png") {
            js(step2) { r2 in
              let raw = Array(a.testRaw[from...])
              let saves = raw.filter { $0.contains("\"type\":\"looks\"") && $0.contains("\"rules\"") }
              verdict("RULEBOOK WRITE", obj(r2), ["added": 1, "moved": 1, "edited": 1, "deleted": 1, "undone": 1, "escCloses": 1])
              print("RULEBOOK SAVES:", saves.count >= 5 ? "ok (\(saves.count) saves through the main window)" : "FAIL \(saves.count)")
              js(step3) { r3 in
                let o3 = obj(r3)
                verdict("RULEBOOK CHECK", o3, ["checkOpens": 1, "noPopover": 1, "rows": 4, "fails": 4, "endWaits": 1, "strayClickSafe": 1, "fillShows": 1, "scrollSafe": 1, "earlyLetGoSafe": 1])
                print("RULEBOOK APART:", ((o3["gapPx"] as? Int) ?? 0) >= 200 ? "ok" : "FAIL", "Failed and Complied are \(o3["gapPx"] ?? "?") px apart")
                snap(a.overlay, "\(dir)/rulecheck.png") {
                  if nuke { realHold(); return }
                  let before = a.testLog.count
                  js(step4) { r4 in
                    let reset = a.testLog[before...].contains("reset")
                    verdict("RULEBOOK END DAY", obj(r4), ["endReady": 1, "closedAfter": 1])
                    print("RULEBOOK RESET SENT:", reset ? "ok" : "FAIL")
                    a.lastState = keep; a.pushState()
                    TouchLock.memSet("remember", nil)
                    done()
                  }
                }
              }
            }
          }
        }
      }
    }
    // Holds Failed on rule 2 with real mouse events into the overlay window; Nuke.swift then quits.
    func realHold() {
      let target = ProcessInfo.processInfo.environment["PS_SELFTEST_NUKE_TARGET"] ?? ""
      print("NUKE BEFORE: dummy exists=\(FileManager.default.fileExists(atPath: target)) remembered=\(TouchLock.readRemembered() != nil)")
      js("const b = document.querySelectorAll('.rb-fail')[1].getBoundingClientRect(); return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 });") { r in
        let o = obj(r)
        guard let x = o["x"] as? Double, let y = o["y"] as? Double else { print("NUKE: FAIL no Failed button"); done(); return }
        let v = a.overlay!
        let inView = NSPoint(x: x, y: v.isFlipped ? y : v.bounds.height - y)
        let p = v.convert(inView, to: nil)
        func ev(_ t: NSEvent.EventType) -> NSEvent? {
          NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: a.panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: t == .leftMouseDown ? 1 : 0)
        }
        print("NUKE HOLD: real mouse down on Failed (rule 2), held 1.8 s")
        if let d = ev(.leftMouseDown) { a.panel.sendEvent(d) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
          if let u = ev(.leftMouseUp) { a.panel.sendEvent(u) }
          // Still here 4 s later: the real hold did not reach the page.
          DispatchQueue.main.asyncAfter(deadline: .now() + 4) { print("NUKE: FAIL the real hold did not remove PS"); done() }
        }
      }
    }
  }

  /// Dropping into the Priority 1 outline makes a task P1 (the developer, 19 Oct 2026): the lowest task dragged
  /// into the middle of the outline, onto its bottom edge padding, and just below it (stays as it
  /// was), then an Overdue item dragged into it. Checks the drop messages, the highlight while over
  /// the outline, and that the outline itself never moves. Pictures mid drag.
  static func p1Drops(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let helpers = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const P = (t, x, y, extra) => new PointerEvent(t, Object.assign({ bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }, extra || {}));
    window.__p1t = {
      frame: () => document.querySelector('.tm-list[data-sec=prio] > .tm-p1-frame:not(.mini)'),
      box: () => { const r = window.__p1t.frame().getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; },
      // start dragging `el` and move it to (tx, ty) in steps; returns what the screen shows there
      start: async (el, tx, ty) => {
        const r = el.getBoundingClientRect(), sx = r.left + 60, sy = r.top + r.height / 2;
        const f0 = JSON.stringify(window.__p1t.box());
        el.dispatchEvent(P('pointerdown', sx, sy));
        for (let i = 1; i <= 12; i++) { window.dispatchEvent(P('pointermove', sx + (tx - sx) * i / 12, sy + (ty - sy) * i / 12)); await sleep(30); }
        await sleep(250);
        window.__p1t.last = [tx, ty];
        // The outline may only grow downwards by the room the drop opens (--p1-grow): its top, left and width never move.
        const a0 = JSON.parse(f0), a1 = window.__p1t.box(), grow = parseFloat(window.__p1t.frame().style.getPropertyValue('--p1-grow')) || 0;
        const still = a0.t === a1.t && a0.l === a1.l && a0.w === a1.w && Math.abs(a1.h - a0.h - grow) < 1.5;
        return { hint: window.__p1t.frame().classList.contains('drop-p1'), label: getComputedStyle(window.__p1t.frame().querySelector('.tm-p1-hint')).opacity, frameStill: still, grow: grow };
      },
      release: async () => { const [x, y] = window.__p1t.last; window.dispatchEvent(P('pointerup', x, y, { buttons: 0 })); await sleep(400); return !document.querySelector('.tm-p1-frame.drop-p1'); },
      mark: (id) => window.webkit.messageHandlers.ps.postMessage(JSON.stringify({ type: 'mark-' + id })),
      lowest: () => { const rows = [...document.querySelectorAll('.tm-list[data-sec=prio] > .tm-row')]; return rows[rows.length - 1]; },
    };
    return 1;
    """
    func js(_ code: String, _ next: @escaping (String) -> Void) {
      a.overlay.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { r in next(((try? r.get()) as? String) ?? "error \(r)") }
    }
    // (name, how to pick the dragged element, where to let go, should it be P1)
    let cases: [(String, String, String, Bool)] = [
      ("middle", "window.__p1t.lowest()", "const b = window.__p1t.box(); return [b.l + b.w / 2, b.t + b.h / 2];", true),
      ("edge", "window.__p1t.lowest()", "const b = window.__p1t.box(); return [b.l + 8, b.b - 3];", true),
      ("outside", "window.__p1t.lowest()", "const b = window.__p1t.box(); return [b.l + b.w / 2, b.b + 12];", false),
      ("overdue", "document.querySelector('.tm-aware li .tm-aware-t')", "const b = window.__p1t.box(); return [b.l + b.w / 2, b.t + b.h / 2];", true),
    ]
    var lines: [String] = []
    var ok = true
    let from = a.testRaw.count
    js(helpers) { _ in
      func run(_ i: Int) {
        guard i < cases.count else {
          print("P1 DROP CHECK:", ok ? "ok" : "FAIL", lines.joined(separator: " "))
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { done() }
          return
        }
        let (name, pick, spot, want) = cases[i]
        let start = "const p = (() => { \(spot) })(); window.__p1t.mark('\(name)'); const el = \(pick); if (!el) return 'no element'; return JSON.stringify(await window.__p1t.start(el.closest('li') || el, p[0], p[1]));"
        js(start) { during in
          snap(a.overlay, "\(dir)/p1-drop-\(name).png") {
            js("return String(await window.__p1t.release())") { cleared in
              DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                // the drop message sent after this case's mark
                let raw = Array(a.testRaw[from...])
                let at = raw.lastIndex { $0.contains("\"mark-\(name)\"") } ?? raw.count
                // no mark seen (the message never came): nothing was sent, the case fails instead of trapping
                let sent = at < raw.count ? raw[(at + 1)...].filter { !$0.contains("\"type\":\"mark-") } : []
                let msg = sent.last ?? ""
                let p1On = msg.contains("\"on\":true") || msg.contains("\"p1\":true")
                let hinted = during.contains("\"hint\":true")
                let still = during.contains("\"frameStill\":true")
                // every case moves the task, so each one must send a message; only the outline ones set P1
                let pass = p1On == want && hinted == want && still && cleared == "true" && !msg.isEmpty
                if !pass { ok = false }
                lines.append("\(name)=\(pass ? "ok" : "FAIL") (p1=\(p1On) hint=\(hinted) outline-still=\(still) msg=\(msg.isEmpty ? "none" : String(msg.prefix(120))))")
                // let the shown order settle back before the next drag
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.8) { run(i + 1) }
              }
            }
          }
        }
      }
      run(0)
    }
  }
  /// The time zone clocks (the developer, 18 Oct 2026: bigger, readable 1 to 12). Opens the panel and hovers
  /// each zone: pictures of each, the pop-up fully on screen (with its clients card), the numbers'
  /// real size, nothing below moved and the list beside not covered; again with the glass slider at
  /// its minimum, in a small window, and the overlay page's CPU with a pop-up open.
  static func clocks(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let helpers = """
    window.__ckt = {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ev: (el, t, rel) => el.dispatchEvent(new MouseEvent(t, { bubbles: true, relatedTarget: rel || null })),
      pos: () => [...document.querySelectorAll('.tm-left > .tm-tl, .tm-left > .tm-meet, .tm-left > .ed-slot > .tm-meet, .tm-left .tm-xrow')].map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.left) + ':' + Math.round(r.top); }).join(' '),
      popup: () => {
        const c = document.querySelector('.tm-cmp'); if (!c) return null;
        const r = c.getBoundingClientRect(), sub = c.querySelector('.tm-cmp-sub'), sr = sub ? sub.getBoundingClientRect() : r;
        const face = c.querySelector('.tm-cmp-face').getBoundingClientRect();
        const nums = [...c.querySelectorAll('.ck-num')];
        const nb = nums.map((n) => n.getBoundingClientRect());
        return { onScreen: r.left >= 0 && r.top >= 0 && Math.max(r.right, sr.right) <= innerWidth && Math.max(r.bottom, sr.bottom) <= innerHeight,
          card: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(Math.max(r.bottom, sr.bottom) - r.top)], face: Math.round(face.width),
          numbers: nums.map((n) => n.textContent).join(','), numberHeightPx: Math.round(Math.min(...nb.map((b) => b.height)) * 10) / 10,
          fit: getComputedStyle(c).getPropertyValue('--fit').trim() || '1', view: innerWidth + 'x' + innerHeight };
      },
    };
    return 1;
    """
    let open = """
    const k = window.__ckt, dock = document.querySelector('.tm-ckdock');
    const before = k.pos();
    k.ev(dock, 'mouseover'); await k.sleep(700);
    const panel = document.querySelector('.tm-clocks'); if (!panel) return JSON.stringify({ open: false });
    const pr = panel.getBoundingClientRect(), row = document.querySelector('.tm-list .tm-row').getBoundingClientRect();
    return JSON.stringify({ open: true, faces: [...document.querySelectorAll('.tm-ck-face')].map((f) => Math.round(f.getBoundingClientRect().width)).join(','),
      zones: document.querySelectorAll('.tm-ck:not(.you)').length, panelRight: Math.round(pr.right), listLeft: Math.round(row.left),
      coversList: pr.right > row.left, belowMoved: k.pos() !== before });
    """
    func js(_ code: String, _ args: [String: Any] = [:], _ next: @escaping (String) -> Void) {
      a.overlay.callAsyncJavaScript(code, arguments: args, in: nil, in: .page) { r in next(((try? r.get()) as? String) ?? "error \(r)") }
    }
    let hover = """
    const k = window.__ckt, rows = [...document.querySelectorAll('.tm-ck:not(.you)')];
    const row = rows[i], prev = i > 0 ? rows[i - 1] : null;
    if (!row) return 'null';
    if (prev) k.ev(prev, 'mouseout', row);
    if (!prev) k.ev(row, 'mouseover');          // the first one: the mouse arrives on it
    await k.sleep(800);
    const c = document.querySelector('.tm-cmp'), cr = c && c.getBoundingClientRect();
    const top = cr ? document.elementFromPoint(cr.right - 30, cr.top + cr.height / 2) : null;
    return JSON.stringify(Object.assign({ zone: row.querySelector('.tm-ck-n').textContent, dockOpen: !!document.querySelector('.tm-ckdock.open'),
      onTop: top ? (c.contains(top) ? 'card' : (top.className || top.tagName).toString().slice(0, 30)) : null,
      cardOpacity: c ? getComputedStyle(c).opacity : null, cardBg: c ? getComputedStyle(c).backgroundColor : null, leftZ: getComputedStyle(document.querySelector('.tm-left')).zIndex }, k.popup()));
    """
    var lines: [String] = []
    js(helpers) { _ in
      js(open) { o in
        lines.append("panel=\(o)")
        snap(a.overlay, "\(dir)/clocks-panel.png") {
          func zone(_ i: Int) {
            js(hover, ["i": i]) { r in
              guard r != "null" else {
                // a pop-up open: the overlay page's CPU for 3 s
                let pid = (a.overlay.value(forKey: "_webProcessIdentifier") as? Int32) ?? 0
                let c0 = pid > 0 ? cpuSeconds(pid) : 0
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                  lines.append("cpu-with-popup=" + (pid > 0 ? String(format: "%.0f%%", (cpuSeconds(pid) - c0) / 3 * 100) : "n/a"))
                  // glass slider at its minimum (solid backings)
                  let glassJS = """
                  const r = document.querySelector('.tm-glass-range');
                  const set = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, String(v)); r.dispatchEvent(new Event('input', { bubbles: true })); };
                  const v0 = r.value; set(0); await window.__ckt.sleep(500);
                  const c = document.querySelector('.tm-cmp'), cr = c.getBoundingClientRect();
                  const hits = [...document.querySelectorAll('.tm-list .tm-row')].map((row) => { const rr = row.getBoundingClientRect(); if (rr.bottom < cr.top || rr.top > cr.bottom || rr.left > cr.right) return null;
                    const x = Math.max(rr.left, cr.left) + 20, y = (Math.max(rr.top, cr.top) + Math.min(rr.bottom, cr.bottom)) / 2; const e = document.elementFromPoint(x, y); return c.contains(e) ? 'card' : (e.className || e.tagName).toString().slice(0, 24); }).filter(Boolean);
                  window.__ckt.glassMin = JSON.stringify({ onTopOverRows: hits, clear: !!document.querySelector('.tm-overlay.tm-clear'), cardBg: getComputedStyle(c).backgroundColor });
                  return v0
                  """
                  js(glassJS) { v0 in
                    js("return window.__ckt.glassMin") { gm in lines.append("glass-min=\(gm)") }
                    snap(a.overlay, "\(dir)/clocks-glass-min.png") {
                      js("const r = document.querySelector('.tm-glass-range'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, String(v)); r.dispatchEvent(new Event('input', { bubbles: true })); return 1", ["v": v0]) { _ in
                        // a small window: the last zone's pop-up still fits
                        let frame = a.panel.frame
                        a.panel.setFrame(NSRect(x: frame.minX, y: frame.maxY - 640, width: 1000, height: 640), display: true)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                          js("const k = window.__ckt, rows = [...document.querySelectorAll('.tm-ck:not(.you)')], row = rows[rows.length - 1]; k.ev(rows[0], 'mouseout', row); k.ev(row, 'mouseover', rows[0]); await k.sleep(800); return JSON.stringify(k.popup())") { small in
                            lines.append("small-window=\(small)")
                            snap(a.overlay, "\(dir)/clocks-small-window.png") {
                              a.panel.setFrame(frame, display: true)
                              // Wait until the page is back at full size before the next checks use screen points.
                              let back = "const k = window.__ckt; for (let n = 0; n < 40 && (innerWidth !== w || innerHeight !== h); n++) await k.sleep(100); await k.sleep(600); k.ev(document.querySelector('.tm-ckdock'), 'mouseout', document.querySelector('.tm-inner')); await k.sleep(900); return innerWidth + 'x' + innerHeight"
                              js(back, ["w": Int(frame.width), "h": Int(frame.height)]) { _ in
                                let all = lines.joined(separator: " ")
                                let shown = lines.filter { $0.hasPrefix("zone") && $0.contains("\"onScreen\":true") }.count
                                let zones = lines.filter { $0.hasPrefix("zone") }.count
                                let ok = all.contains("\"open\":true") && !all.contains("\"coversList\":true") && !all.contains("\"belowMoved\":true") && !all.contains("\"onScreen\":false") && zones >= 5 && shown == zones && all.contains("small-window={\"onScreen\":true")
                                  && lines.filter { $0.hasPrefix("zone") && $0.contains("\"onTop\":\"card\"") }.count == zones
                                print("CLOCKS CHECK:", ok ? "ok" : "FAIL", lines.joined(separator: "\n  "))
                                done()
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
                return
              }
              lines.append("zone\(i)=\(r)")
              snap(a.overlay, "\(dir)/clocks-popup-\(i).png") { zone(i + 1) }
            }
          }
          zone(0)
        }
      }
    }
  }
  /// The gear menu is click only (the developer, 18 Oct 2026). Hover over the gear, then over every item in
  /// the menu, the Network window's tabs and the More settings tiles (with right clicks too):
  /// nothing opens, no setting message goes out, nothing on the page changes. Then left click each
  /// one and see it apply. Skips the microphone (it would switch the Mac's real one) and the speed test.
  static func clickOnly(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let js = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const mark = (id) => window.webkit.messageHandlers.ps.postMessage(JSON.stringify({ type: 'mark-' + id }));
    const ev = (el, t, extra) => { const r = el.getBoundingClientRect(); const o = Object.assign({ bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }, extra || {});
      el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)); };
    const hover = async (el, ms, during) => {
      for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) ev(el, t, { relatedTarget: null });
      await sleep(ms);
      if (during) during();                     // looked at while the mouse is still resting on it
      for (const t of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) ev(el, t, { relatedTarget: document.body });
    };
    const right = (el) => { for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu', 'auxclick']) ev(el, t, { button: 2, buttons: 2 }); };
    const gear = () => document.querySelector('.tm-tr button[aria-label=Settings]');
    const isOpen = () => !!document.querySelector('.gs-win');   // V1.32: the gear opens the full screen Settings
    const gone = async () => { for (let i = 0; i < 40 && document.querySelector('.gs-layer, .nm-layer'); i++) await sleep(100); await sleep(150); };   // a closing screen is still in the page
    // The microphone radios show the Mac's real default input, which macOS may switch by itself mid check (AirPods
    // taken off, 6 Nov 2026), so they are left out here; a hover that picked one would still send mic:set (caught below).
    const state = () => JSON.stringify({ gear: isOpen(), checked: [...document.querySelectorAll('.gs-gen [aria-checked]:not(.tm-mics [aria-checked])')].map((e) => e.getAttribute('aria-checked')).join(''),
      ranges: [...document.querySelectorAll('.gs-gen input[type=range]')].map((e) => e.value).join(','), sel: (document.querySelector('.gs-gen select') || {}).value,
      hist: !!document.querySelector('.tm-hist'), more: !!document.querySelector('.ms-win'), net: !!document.querySelector('.nm-win'), peek: !!document.querySelector('.ms-layer.peek'),
      light: !!document.querySelector('.tm-light'), look: ((document.querySelector('.tm-p1-frame:not(.mini)') || {}).className || '') });
    const drag = async (r, v) => { ev(r, 'pointerdown', { button: 0, buttons: 1 }); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(r, String(v));
      r.dispatchEvent(new Event('input', { bubbles: true })); await sleep(60); ev(r, 'pointerup', { button: 0 }); await sleep(250); };
    const R = {};
    if (isOpen()) { gear().click(); await sleep(300); }
    mark('start');
    // 1. the gear: resting on it or right clicking it does nothing
    let openedWhileHovered = false;
    await hover(gear(), 1500, () => { openedWhileHovered = isOpen(); }); right(gear()); await sleep(300);
    R.gearStaysClosedOnHover = !openedWhileHovered && !isOpen();
    mark('gear-hovered');
    gear().click(); await sleep(350);
    R.gearOpensOnClick = isOpen();
    mark('opened');
    // 2. every item in the menu: hover 600 ms and right click
    const before = state();
    const items = [...new Set(document.querySelectorAll('.gs-gen button, .gs-gen input, .gs-gen select, .gs-gen [role=radio]'))];
    R.itemsHovered = items.length;
    const changedOn = [];
    const label = (el) => (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24);
    for (const el of items) { await hover(el, 600, () => { if (state() !== before) changedOn.push(label(el)); }); right(el); await sleep(50); }
    if (changedOn.length) R.changedWhileHovering = changedOn;
    await sleep(400);
    R.menuUnchangedAfterHover = state() === before && !changedOn.length;
    if (!R.menuUnchangedAfterHover) R.diff = [before, state()];
    mark('menu-hovered');
    // 3. left clicks apply
    const orig = { sv: (document.querySelector('.gs-gen input[aria-label="Sound volume"]') || {}).value, sz: (document.querySelector('.gs-gen input[aria-label="Task size"]') || {}).value,
      tz: document.querySelector('.gs-gen select').value, st: (([...document.querySelectorAll('.gs-gen .tm-ed-seg')].find((g) => /hours/.test(g.textContent)) || document).querySelector('[aria-checked=true]') || {}).textContent,
      notify: ((document.querySelector('.gs-gen [aria-label="Notification pop-ups"] [aria-checked=true]')) || {}).textContent };
    const unchosen = (label) => document.querySelector('.gs-gen [aria-label="' + label + '"] [aria-checked=false]');
    const st = [...document.querySelectorAll('.gs-gen .tm-ed-seg')].find((g) => /hours/.test(g.textContent));
    const stBtn = st && st.querySelector('[aria-checked=false]');
    mark('c-sthours'); if (stBtn) { stBtn.click(); await sleep(300); }
    mark('c-notify'); const nb = unchosen('Notification pop-ups'); if (nb) { nb.click(); await sleep(300); }
    mark('c-history'); const hb = document.querySelector('.tm-hist-btn'); const h0 = !!document.querySelector('.tm-hist'); hb.click(); await sleep(250); R.historyClick = !!document.querySelector('.tm-hist') !== h0;
    mark('c-sound'); const ranges = [...document.querySelectorAll('.gs-gen input[type=range]')];
    const sv = ranges.find((r) => r.getAttribute('aria-label') === 'Sound volume'); await drag(sv, Number(sv.value) === 50 ? 55 : 50);
    mark('c-size'); const sz = ranges.find((r) => r.getAttribute('aria-label') === 'Task size'); if (sz) await drag(sz, Number(sz.value) === 90 ? 95 : 90);
    mark('c-tz'); const sel = document.querySelector('.gs-gen select'); const opt = [...sel.options].find((o) => o.value && o.value !== sel.value);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value); sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(300);
    // the Network window: its tabs switch on a click only
    if (isOpen()) { window.__psDimxClose && window.__psDimxClose(); await gone(); }   // Settings covers the top bar now
    mark('c-net'); const nbtn = document.querySelector('.tm-tr .nm-btn');
    if (nbtn) {
      nbtn.click(); await sleep(900);
      R.networkOpensOnClick = !!document.querySelector('.nm-win');
      const tabs = [...document.querySelectorAll('.nm-win [role=tab]')];
      const sel0 = (tabs.find((t) => t.getAttribute('aria-selected') === 'true') || {}).dataset;
      const other = tabs.find((t) => t.getAttribute('aria-selected') !== 'true');
      if (other) {
        await hover(other, 900); right(other); await sleep(200);
        R.netTabStaysOnHover = other.getAttribute('aria-selected') !== 'true';
        other.click(); await sleep(300);
        R.netTabSwitchesOnClick = other.getAttribute('aria-selected') === 'true';
      }
      window.__psDimxClose && window.__psDimxClose(); await gone();
    }
    // More settings: hovering tiles and Preview buttons does nothing; a click picks
    if (!isOpen()) { gear().click(); await sleep(300); }
    mark('c-more'); (document.querySelector('.gs-win [data-tab=looks]') || document.querySelector('.tm-more-btn')).click(); await sleep(900);
    R.moreOpensOnClick = !!document.querySelector('.ms-win');
    const mBefore = state();
    mark('more-open');
    const moreChanged = [];
    for (const el of document.querySelectorAll('.ms-win .ms-tile, .ms-win .ms-peek-btn, .ms-win [role=radio]')) { await hover(el, 120, () => { if (state() !== mBefore) moreChanged.push(label(el)); }); right(el); }
    await sleep(500);
    R.moreUnchangedAfterHover = state() === mBefore && !moreChanged.length;
    if (moreChanged.length) R.moreChangedWhileHovering = moreChanged;
    mark('more-hovered');
    const tile = document.querySelector('.ms-win .ms-tile[data-kind=outline]:not(.on)');
    tile.click(); await sleep(400);
    mark('more-clicked');
    window.__psDimxClose && window.__psDimxClose(); await gone();
    // put back what the clicks changed (the later checks expect the usual layout)
    if (!isOpen()) { gear().click(); await sleep(300); }
    const gtab = document.querySelector('.gs-win [data-tab=general]'); if (gtab && gtab.getAttribute('aria-selected') !== 'true') { gtab.click(); await sleep(400); }
    const back = async () => {
      const sv2 = document.querySelector('.gs-gen input[aria-label="Sound volume"]'); if (sv2 && orig.sv) await drag(sv2, orig.sv);
      const sz2 = document.querySelector('.gs-gen input[aria-label="Task size"]'); if (sz2 && orig.sz) await drag(sz2, orig.sz);
      const sel2 = document.querySelector('.gs-gen select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel2, orig.tz); sel2.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200);
      const stb = [...document.querySelectorAll('.gs-gen .tm-ed-seg button')].find((b) => b.textContent === orig.st && b.getAttribute('aria-checked') === 'false'); if (stb) { stb.click(); await sleep(200); }
      const nb2 = [...document.querySelectorAll('.gs-gen [aria-label="Notification pop-ups"] button')].find((b) => b.textContent === orig.notify && b.getAttribute('aria-checked') === 'false'); if (nb2) { nb2.click(); await sleep(200); }
      if (document.querySelector('.tm-hist')) { document.querySelector('.tm-hist-btn').click(); await sleep(200); }
    };
    await back();
    // a left click outside Settings (on the dimmed list round it) closes it
    const dimEl = document.querySelector('.gs-layer .cs-dim'); R.dimThere = !!dimEl; if (dimEl) { ev(dimEl, 'mousedown', { button: 0, buttons: 1 }); ev(dimEl, 'mouseup', { button: 0 }); } await gone();
    R.outsideClickCloses = !isOpen();
    mark('end');
    return JSON.stringify(R);
    """
    let from = a.testLog.count
    a.overlay.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { r in
      let page = ((try? r.get()) as? String) ?? "error \(r)"
      let log = Array(a.testLog[from...])
      func slice(_ x: String, _ y: String) -> [String] {
        guard let i = log.firstIndex(of: "mark-" + x), let j = log[(i + 1)...].firstIndex(where: { $0.hasPrefix("mark-") }) else { return ["missing \(x)"] }
        _ = y; return Array(log[(i + 1)..<j])
      }
      let changes: Set<String> = ["sound", "tmScale", "stHours", "notifyPref", "homeTz", "looks", "p1Style", "workStyle", "mic:set", "net:open", "net:enable", "net:settings", "net:speedtest", "dimx", "sfx", "backdrop", "meetPrefs"]
      let hoverGear = slice("start", "").filter { changes.contains($0) }
      let hoverMenu = slice("opened", "").filter { changes.contains($0) }
      let hoverMore = slice("more-open", "").filter { changes.contains($0) }
      func applied(_ m: String, _ want: String) -> String { slice(m, "").contains(want) ? "ok" : "FAIL(\(slice(m, "")))" }
      let pass = hoverGear.isEmpty && hoverMenu.isEmpty && hoverMore.isEmpty && page.contains("\"gearStaysClosedOnHover\":true") && page.contains("\"menuUnchangedAfterHover\":true") && page.contains("\"moreUnchangedAfterHover\":true")
      print("CLICK ONLY CHECK:", pass ? "ok" : "FAIL",
            "hover-sent: gear=\(hoverGear) menu=\(hoverMenu) more=\(hoverMore)",
            "clicks: screen-time=\(applied("c-sthours", "stHours")) notify=\(applied("c-notify", "notifyPref")) sound=\(applied("c-sound", "sound")) size=\(applied("c-size", "tmScale")) time-zone=\(applied("c-tz", "homeTz")) network=\(applied("c-net", "net:open")) outline-tile=\(applied("more-hovered", "looks"))",
            "page=\(page)")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { if !a.shown { a.showOverlay() }; DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { done() } }
    }
  }
  /// More settings: the big window (pictures), a 2 second Preview that ends by itself and one ended
  /// by a click, the light theme (picture, CPU), and the network monitor switched off and on again.
  static func moreSettings(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let js = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const look = () => ((document.querySelector('.tm-p1-frame:not(.mini)') || {}).className || '').replace('tm-p1-frame ', '');
    const r = {};
    if (!document.querySelector('.gs-win')) { document.querySelector('.tm-tr button[aria-label=Settings]').click(); await sleep(250); }
    // V1.32: the gear opens the full screen Settings (General first, every other one a tab); More settings is its Looks tab.
    const gw = document.querySelector('.gs-win'), gb = gw && gw.getBoundingClientRect();
    r.fullScreen = !!gb && gb.width >= innerWidth * 0.9 && gb.height >= innerHeight * 0.9;
    r.noDropDown = !document.querySelector('.tm-pop[aria-label=Settings]');
    r.tabs = [...document.querySelectorAll('.gs-win [role=tab]')].map((t) => t.textContent).join('|');
    // Minecraft mode's card is there only while it is switched on (MinecraftSwitch.swift).
    r.general = !!document.querySelector('.gs-win .gs-gen input[aria-label="Sound volume"]') && !!document.querySelector('.gs-win .gs-gen .mcw-entry') === mc;
    (document.querySelector('.gs-win [data-tab=looks]') || document.querySelector('.tm-more-btn')).click(); await sleep(800);
    const win = document.querySelector('.ms-win');
    r.window = !!win;
    r.gearClosed = !document.querySelector('.tm-pop-wrap.open');
    r.sections = [...win.querySelectorAll('.ms-h')].map((h) => h.textContent).join('|');
    r.previewButtons = win.querySelectorAll('.ms-peek-btn').length;
    const saved = look();
    win.querySelector('.ms-peek-btn[data-kind=outline][data-id=neon]').click(); await sleep(300);
    r.previewShows = look() === 'p1d-neon' && !!document.querySelector('.ms-layer.peek');
    await sleep(2100);
    r.previewEnds = look() === saved && !document.querySelector('.ms-layer.peek') && !!document.querySelector('.ms-win');
    win.querySelector('.ms-peek-btn[data-kind=theme][data-id=light]').click(); await sleep(300);
    r.themePreview = !!document.querySelector('.tm-overlay.tm-light');
    document.querySelector('.ms-catch').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(250);
    r.clickEndsPreview = !document.querySelector('.tm-overlay.tm-light') && !document.querySelector('.ms-layer.peek') && !!document.querySelector('.ms-win');
    return JSON.stringify(r);
    """
    a.overlay.evaluateJavaScript("document.querySelector('.tm-tr button[aria-label=Settings]').click()") { _, _ in
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { snap(a.overlay, "\(dir)/gear-menu.png") {
    a.overlay.callAsyncJavaScript(js, arguments: ["mc": MINECRAFT_ENABLED], in: nil, in: .page) { r in
      let first = ((try? r.get()) as? String) ?? "error \(r)"
      // The full screen Settings (V1.32): checks the runner counts (name=ok or name=FAIL).
      let gs: [(String, Bool)] = [("settings-full-screen", first.contains("\"fullScreen\":true")), ("no-drop-down-menu", first.contains("\"noDropDown\":true")),
        // V1.36: Notifications (the cards' colours and sounds, web views/NoteLook.tsx) is a tab on a Mac.
        ("settings-tabs", first.contains("\"tabs\":\"General|Notifications|Looks|Mac settings\"")), ("general-page", first.contains("\"general\":true")),
        ("looks-tab-is-more-settings", first.contains("\"window\":true"))]
      print("SETTINGS SCREEN CHECK:", gs.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "))
      snap(a.overlay, "\(dir)/more-settings.png") {
        a.overlay.callAsyncJavaScript("const s = document.querySelector('.ms-scroll'); s.scrollTop = s.scrollHeight; await new Promise((r) => setTimeout(r, 250)); return 1", arguments: [:], in: nil, in: .page) { _ in
          snap(a.overlay, "\(dir)/more-settings-2.png") {
            // Light theme for real (saved), window closed: picture and the overlay page's CPU.
            pickLook(a, "theme", "light") { _ in
              DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                let pid = (a.overlay.value(forKey: "_webProcessIdentifier") as? Int32) ?? 0
                let c0 = pid > 0 ? cpuSeconds(pid) : 0
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                  let cpu = pid > 0 ? String(format: "%.0f%%", (cpuSeconds(pid) - c0) / 3 * 100) : "n/a"
                  a.overlay.evaluateJavaScript("!!document.querySelector('.tm-overlay.tm-light') && getComputedStyle(document.querySelector('.tm-overlay')).filter") { lt, _ in
                    snap(a.overlay, "\(dir)/light-theme.png") {
                      pickLook(a, "theme", "dark") { _ in netOffCheck(a) { net in
                        print("MORE SETTINGS CHECK:", first, "light=\(lt ?? "nothing") lightCPU=\(cpu)", net)
                        done()
                      } }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    } }
    }
  }
  /// Network monitor Off in More settings: nothing polls any more and the Network button is gone;
  /// On again brings both back.
  static func netOffCheck(_ a: App, _ done: @escaping (String) -> Void) {
    func pickNet(_ on: Bool, _ next: @escaping () -> Void) {
      let js = """
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (!document.querySelector('.gs-win')) { document.querySelector('.tm-tr button[aria-label=Settings]').click(); await sleep(250); }
      (document.querySelector('.gs-win [data-tab=looks]') || document.querySelector('.tm-more-btn')).click(); await sleep(800);
      const seg = document.querySelector('.ms-win [aria-label="Network monitor"]');
      const b = seg && [...seg.querySelectorAll('button')].find((x) => x.textContent === (on ? 'On' : 'Off'));
      if (b) b.click();
      await sleep(400);
      window.__psDimxClose && window.__psDimxClose(); await sleep(750);
      return 1
      """
      a.overlay.callAsyncJavaScript(js, arguments: ["on": on], in: nil, in: .page) { _ in DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { next() } }
    }
    let btn = "!!document.querySelector('.nm-btn')"
    pickNet(false) {
      NetMonitor.shared.running { en, polling in
        a.overlay.evaluateJavaScript(btn) { b, _ in
          let off = !en && !polling && (b as? Bool) == false
          pickNet(true) {
            NetMonitor.shared.running { en2, polling2 in
              a.overlay.evaluateJavaScript(btn) { b2, _ in
                let on = en2 && polling2 && (b2 as? Bool) == true
                done("net-off=\(off ? "ok" : "FAIL (on=\(en) polling=\(polling))") net-back-on=\(on ? "ok" : "FAIL (on=\(en2) polling=\(polling2))")")
              }
            }
          }
        }
      }
    }
  }
  static func p1LooksRun(_ a: App, _ dir: String, _ q: String, _ done: @escaping () -> Void) {
    snap(a.overlay, "\(dir)/p1-red-glisten.png") {
      let looks: [(String, String)] = [("outline", "target"), ("bg", "converge"), ("bg", "spotlight"), ("outline", "lightning"), ("bg", "tunnel"), ("outline", "neon"), ("outline", "eyes"), ("outline", "crown"), ("bg", "storm-aimed")]
      func next(_ i: Int) {
        guard i < looks.count else {
          pickLook(a, "bg", "none") { _ in pickLook(a, "outline", "red-glisten") { _ in done() } }
          return
        }
        pickLook(a, looks[i].0, looks[i].1, storm: looks[i].1.hasPrefix("storm")) { r in
          if i == 0 { print("P1 PICKER:", r) }
          DispatchQueue.main.asyncAfter(deadline: .now() + (looks[i].1.hasPrefix("storm") ? 2.2 : 0.5)) {
            a.overlay.evaluateJavaScript(q) { v, _ in if i < 2 { print("P1 LOOK SWITCH:", v ?? "nothing") } }
            snap(a.overlay, "\(dir)/look-\(looks[i].1).png") { next(i + 1) }
          }
        }
      }
      next(0)
    }
  }
  // The glass slider never moves anything (row, headline and section label stay put at every value),
  // every panel stays readable at the minimum (a bright test pattern behind), and Hover mode lights
  // each panel when the mouse is over it (PS's own click-through check plus the mouse it passes on).
  static func panels(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let slide = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rng = document.querySelector('.tm-glass-range');
    const setv = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(rng, String(v)); rng.dispatchEvent(new Event('input', { bubbles: true })); };
    const at = () => [document.querySelector('.tm-row'), document.querySelector('.tm-head .tm-title'), document.querySelector('.tm-sec-h'), document.querySelector('.tm-meet')].map((e) => { const r = e.getBoundingClientRect(); return Math.round(r.left) + ':' + Math.round(r.top); }).join(' ');
    const seen = {};
    for (const v of [100, 60, 46, 44, 30, 0]) { setv(v); await sleep(160); seen[v] = at(); }
    const first = seen[100];
    document.documentElement.style.background = 'repeating-linear-gradient(45deg, #ffffff 0 40px, #ffe066 40px 80px, #7dd3fc 80px 120px)';
    document.body.style.background = 'transparent';
    return JSON.stringify({ moved: Object.keys(seen).filter((k) => seen[k] !== first), positions: first });
    """
    a.overlay.callAsyncJavaScript(slide, arguments: [:], in: nil, in: .page) { r in
      print("SLIDER CHECK:", (try? r.get()) ?? "error \(r)")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
        snap(a.overlay, "\(dir)/min-transparency.png") {
          // Hover mode on (it keeps the list up), then the mouse goes to each panel in turn.
          a.overlay.evaluateJavaScript("document.querySelectorAll('.tm-keep')[1].click()", completionHandler: nil)
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            snap(a.overlay, "\(dir)/hover-mode-idle.png") {
              // The last three open their own window when rested on (by design), so they go last and
              // that window is closed again after each check.
              let names = [("tasks", ".tm-sec"), ("headline", ".tm-head"), ("meetings", ".tm-meet:not(.tm-mail)"), ("client-emails", ".tm-mail"),
                           ("urgent", ".tm-aware"), ("time-zones", ".tm-ckdock"), ("timelines", ".tm-tl"), ("top-right", ".tm-tr"), ("undo", ".tm-undo"),
                           ("dimension-x", ".dx-dock"), ("campaigns", ".cs-dock"), ("new-tasks", ".nt-slot.show")]
              let closeOpened = "setTimeout(function(){ if (document.querySelector('.dx-win, .cs-win')) { window.__psDimxClose && window.__psDimxClose(); } var m=document.querySelector('.nt-min'); if (m) m.click(); }, 700)"
              var results: [String] = []
              let H = a.panel.frame.height, W = a.panel.frame.width
              func step(_ i: Int) {
                guard i < names.count else {
                  print("HOVER CHECK:", results.joined(separator: " "))
                  // Hover mode off and Keep off again (Keep off puts the list away), then back up.
                  a.overlay.evaluateJavaScript("document.querySelectorAll('.tm-keep')[1].click(); document.querySelector('.tm-glass-range') && (function(r){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(r,'50'); r.dispatchEvent(new Event('input',{bubbles:true}))})(document.querySelector('.tm-glass-range')); document.documentElement.style.background=''", completionHandler: nil)
                  DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    a.overlay.evaluateJavaScript("document.querySelectorAll('.tm-keep')[0].click()", completionHandler: nil)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { if !a.shown { a.showOverlay() }; DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { done() } }
                  }
                  return
                }
                let (name, sel) = names[i]
                a.overlay.evaluateJavaScript("(function(){var e=document.querySelector('\(sel)'); if(!e) return null; var r=e.getBoundingClientRect(); return [r.left+Math.min(r.width/2, 60), r.top+r.height/2]})()") { v, _ in
                  guard let xy = v as? [Double], xy.count == 2 else { results.append("\(name)=absent"); step(i + 1); return }
                  // Over the app behind first: a point no part of the list covers.
                  let empties = [NSPoint(x: W / 2, y: H - 12), NSPoint(x: W * 0.3, y: H * 0.6), NSPoint(x: W * 0.7, y: H * 0.6), NSPoint(x: W * 0.5, y: H * 0.85), NSPoint(x: 6, y: H / 2)]
                  let empty = empties.first { pt in !a.hitRects.contains { $0.contains(pt) } } ?? empties[0]
                  a.updateClickThrough(at: empty)
                  let outOK = a.clickThrough
                  // A real mouse takes a moment to get there, so a pop-out from the panel before (the
                  // clocks panel, which floats over Timelines) has closed by the time it arrives.
                  DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                  a.updateClickThrough(at: NSPoint(x: xy[0], y: xy[1]))          // then onto the panel
                  let inOK = !a.clickThrough
                  DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                    // Looked at up to 5 times, 0.4 s apart (the mouse fed again each time): the page
                    // can be a moment late lighting a panel on a busy run.
                    func look(_ n: Int) {
                    a.overlay.evaluateJavaScript("(function(){var p=document.querySelector('\(sel)'), l=document.querySelector('[data-hm]'); if (('\(name)'==='new-tasks' && document.querySelector('.nt-pop')) || ('\(name)'==='dimension-x' && document.querySelector('.dx-win')) || ('\(name)'==='campaigns' && document.querySelector('.cs-win'))) return 'ok'; if(!p||!l) return 'none efp='+((document.elementFromPoint(\(xy[0]),\(xy[1]))||{}).className||'?').toString().slice(0,40)+' mo='+document.querySelector('.tm-overlay').hasAttribute('data-mouse-out'); var o=+getComputedStyle(l).opacity; return (l===p||l.contains(p)||p.contains(l)) && o>0.9 && !document.querySelector('.tm-overlay').hasAttribute('data-mouse-out') ? 'ok' : 'lit='+(l.className||l.tagName)+' o='+o+' efp='+((document.elementFromPoint(\(xy[0]),\(xy[1]))||{}).className||'?').toString().slice(0,40)+' mo='+document.querySelector('.tm-overlay').hasAttribute('data-mouse-out')})()") { r, _ in
                      let page = (r as? String) ?? "?"
                      if page != "ok" && n < 4 {
                        a.overlay.evaluateJavaScript(MouseFeed.feed + "(\(Int(xy[0])),\(Int(xy[1])))", completionHandler: nil)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { look(n + 1) }
                        return
                      }
                      results.append("\(name)=\(outOK && inOK && page == "ok" ? "ok" : "FAIL(out=\(outOK) in=\(inOK) page=\(page))")")
                      let after = { () -> Void in
                        if ["dimension-x", "campaigns", "new-tasks"].contains(name) {
                          a.overlay.evaluateJavaScript(closeOpened, completionHandler: nil)
                          // Wait until the window has really closed (PS holds every click while one is open).
                          func settled(_ n: Int) { if (a.dimxOpen || !empties.contains { pt in !a.hitRects.contains { $0.contains(pt) } }) && n < 25 { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { settled(n + 1) } } else { step(i + 1) } }
                          DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { settled(0) }
                        } else { step(i + 1) }
                      }
                      if ["tasks", "urgent", "meetings", "dimension-x"].contains(name) { snap(a.overlay, "\(dir)/hover-\(name).png") { after() } } else { after() }
                    }
                    }
                    look(0)
                  }
                  }
                }
              }
              step(0)
            }
          }
        }
      }
    }
  }
  // Add task: the window (as Tab+1 opens it), the keyboard in its title box, Add sends the task, Esc closes only
  // the window. Then Tab+1 itself: the 1 and its key up are swallowed. Quick add (V1.33): it opens with only the
  // name (Advanced closed), Add clears the name and keeps the keyboard there for the next one, the task has no
  // priority, Advanced opens the other settings, and it is closed again the next time the window opens.
  // PS_SELFTEST_ONLY=addtask runs just this.
  static func addTask(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    a.openAddTask()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
      a.overlay.evaluateJavaScript("JSON.stringify({win: !!document.querySelector('.tm-add-win'), focus: (document.activeElement||{}).className||null})") { v, _ in print("ADD TASK OPEN:", v ?? "nothing", "flag=\(a.dimxOpen) pinned=\(TabWatch.shared.pinned)") }
      a.overlay.evaluateJavaScript("[!document.querySelector('.tm-add-adv'), !document.querySelector('.tm-add-notes'), !!document.querySelector('.tm-add-layer.quick'), (document.activeElement||{}).className === 'tm-add-title']") { q, _ in
        let quick = (q as? [Bool]) ?? []
        a.overlay.evaluateJavaScript("(function(){var t=document.querySelector('.tm-add-title'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(t,'Book the Northwind Silk photo shoot'); t.dispatchEvent(new Event('input',{bubbles:true}))})()", completionHandler: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
          snap(a.overlay, "\(dir)/add-task.png") {
            a.overlay.evaluateJavaScript("document.querySelector('.tm-add-go').click()", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
              let after = "(function(){var t=document.querySelector('.tm-add-title');"
                + " return [!!t && t.value === '', document.activeElement === t, !!document.querySelector('.tm-add-done'), !!document.querySelector('.tm-add-win')]})()"
              // What the list sent for this task (Add in the quick form): a one-off, no date, no priority.
              let m = SelfTest.lastAdd ?? [:]
              let noPrio = (m["title"] as? String) == "Book the Northwind Silk photo shoot" && (m["kind"] as? String) == "once" && (m["unranked"] as? Bool) == true
                && (m["p1"] as? Bool) != true && (m["due"] == nil || m["due"] is NSNull)
              print("ADD TASK SENT:", "kind=\(m["kind"] ?? "none") unranked=\(m["unranked"] ?? "none") p1=\(m["p1"] ?? "none") due=\(m["due"] ?? "none") (info)")
              do {
              a.overlay.evaluateJavaScript(after) { r, _ in
                let added = (r as? [Bool]) ?? []
                a.overlay.evaluateJavaScript("document.querySelector('.tm-add-advbtn').click()", completionHandler: nil)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                  a.overlay.evaluateJavaScript("[!!document.querySelector('.tm-add-adv'), !!document.querySelector('.tm-add-notes'), !!document.querySelector('.tm-p1-switch')]") { av, _ in
                    let adv = (av as? [Bool]) ?? []
                    let ok = { (x: [Bool], i: Int) -> String in x.count > i && x[i] ? "ok" : "FAIL" }
                    print("ADD TASK QUICK CHECK:", "opens-quick=\(ok(quick, 0))", "no-notes-until-advanced=\(ok(quick, 1))", "quick-class=\(ok(quick, 2))", "name-focused=\(ok(quick, 3))",
                          "add-clears-name=\(ok(added, 0))", "focus-stays=\(ok(added, 1))", "added-shown=\(ok(added, 2))", "no-priority=\(noPrio ? "ok" : "FAIL")", "stays-open=\(ok(added, 3))",
                          "advanced-opens=\(ok(adv, 0))", "advanced-has-notes=\(ok(adv, 1))", "advanced-has-priority=\(ok(adv, 2))")
                    a.escKey()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                      a.overlay.evaluateJavaScript("!!document.querySelector('.tm-add-win')") { v, _ in
                        let closed = (v as? Bool) == false
                        let w = TabWatch.shared
                        w.state = .showing
                        let d1 = CGEvent(keyboardEventSource: nil, virtualKey: 18, keyDown: true)!, u1 = CGEvent(keyboardEventSource: nil, virtualKey: 18, keyDown: false)!
                        let swDown = w.handle(.keyDown, d1) == nil, swUp = w.handle(.keyUp, u1) == nil
                        w.state = .idle
                        // V1.34: Tab held + W, and / . held + Space, open Add task too; both keys and their key ups are swallowed.
                        let keepChord = w.chordKey
                        func chordKeys(_ chord: Int64, _ key: CGKeyCode) -> (Bool, Bool) {
                          w.state = .showing; w.chordKey = chord; w.fromChord = chord == SLASH_KEY
                          let dn = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true)!, up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false)!
                          let r = (w.handle(.keyDown, dn) == nil, w.handle(.keyUp, up) == nil)
                          w.state = .idle; w.chordKey = keepChord
                          return r
                        }
                        let tw = chordKeys(48, 13), ss = chordKeys(SLASH_KEY, 49)
                        // Space with Tab held, or W with / held, stay theirs (only the chords above are PS's).
                        w.state = .showing; w.chordKey = 48; w.fromChord = false
                        let spaceTab = w.handle(.keyDown, CGEvent(keyboardEventSource: nil, virtualKey: 49, keyDown: true)!) != nil
                        w.state = .idle; w.chordKey = keepChord
                        print("ADD TASK KEYS CHECK:", "tabw-swallows-w=\(tw.0 ? "ok" : "FAIL")", "tabw-swallows-up=\(tw.1 ? "ok" : "FAIL")",
                              "slash-dot-space-swallows-space=\(ss.0 ? "ok" : "FAIL")", "slash-dot-space-swallows-up=\(ss.1 ? "ok" : "FAIL")",
                              "space-with-tab-is-space=\(spaceTab ? "ok" : "FAIL")")
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                          a.overlay.evaluateJavaScript("[!!document.querySelector('.tm-add-win'), !document.querySelector('.tm-add-adv')]") { v2, _ in
                            let re = (v2 as? [Bool]) ?? []
                            print("ADD TASK CHECK:", "esc-closes-window=\(closed ? "ok" : "FAIL")", "list-stays=\(a.shown ? "ok" : "FAIL")",
                                  "tab1-swallows-1=\(swDown ? "ok" : "FAIL")", "tab1-swallows-up=\(swUp ? "ok" : "FAIL")", "tab1-opens=\(ok(re, 0))", "reopens-without-advanced=\(ok(re, 1))")
                            a.escKey()
                            w.pinned = false
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { done() }
                          }
                        }
                      }
                    }
                  }
                }
              }
              }
            }
          }
        }
      }
    }
  }
  // Static check for every Priority 1 look: three pictures 150 ms apart; count the pixels that
  // change in task text OUTSIDE the outline (P2 row, the Every day row), in the Urgent panel, and
  // (for comparison) inside the outline. Outside must stay at 0. Also the CPU of PS's web pages.
  static func pixels(_ img: NSImage?) -> (data: [UInt8], w: Int, h: Int, bpr: Int, spp: Int)? {
    guard let img, let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    let rep = NSBitmapImageRep(cgImage: cg)
    guard let p = rep.bitmapData else { return nil }
    return (Array(UnsafeBufferPointer(start: p, count: rep.bytesPerRow * rep.pixelsHigh)), rep.pixelsWide, rep.pixelsHigh, rep.bytesPerRow, rep.samplesPerPixel)
  }
  /// Where on the picture anything changed between two frames (for finding what moves).
  static func changedBox(_ a: (data: [UInt8], w: Int, h: Int, bpr: Int, spp: Int), _ b: (data: [UInt8], w: Int, h: Int, bpr: Int, spp: Int)) -> String {
    guard a.w == b.w, a.h == b.h else { return "size" }
    var x0 = Int.max, y0 = Int.max, x1 = -1, y1 = -1
    for y in 0..<a.h { for x in 0..<a.w {
      let o = y * a.bpr + x * a.spp
      for c in 0..<min(3, a.spp) where abs(Int(a.data[o + c]) - Int(b.data[o + c])) > 2 { x0 = min(x0, x); y0 = min(y0, y); x1 = max(x1, x); y1 = max(y1, y); break }
    } }
    return x1 < 0 ? "none" : "\(x0),\(y0) to \(x1),\(y1) of \(a.w)x\(a.h)"
  }
  static func changed(_ a: (data: [UInt8], w: Int, h: Int, bpr: Int, spp: Int), _ b: (data: [UInt8], w: Int, h: Int, bpr: Int, spp: Int), _ r: CGRect) -> Int {
    guard a.w == b.w, a.h == b.h else { return -1 }
    var n = 0
    let x0 = max(0, Int(r.minX)), x1 = min(a.w, Int(r.maxX)), y0 = max(0, Int(r.minY)), y1 = min(a.h, Int(r.maxY))
    if x1 <= x0 || y1 <= y0 { return -1 }
    for y in y0..<y1 { for x in x0..<x1 {
      let o = y * a.bpr + x * a.spp
      for c in 0..<min(3, a.spp) where abs(Int(a.data[o + c]) - Int(b.data[o + c])) > 2 { n += 1; break }
    } }
    return n
  }
  /// CPU seconds used so far by one process (from ps), for the CPU check of the overlay page.
  static func cpuSeconds(_ pid: Int32) -> Double {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/ps"); p.arguments = ["-o", "time=", "-p", String(pid)]
    let pipe = Pipe(); p.standardOutput = pipe
    try? p.run()
    let out = (String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    p.waitUntilExit()
    let parts = out.split(separator: ":").map { Double($0) ?? 0 }
    return parts.reversed().enumerated().reduce(0) { $0 + $1.element * pow(60, Double($1.offset)) }
  }
  static func jitter(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    // Every outline (no background), then every background (behind the still red outline).
    let outlines = ["none", "red-glisten", "white-glisten", "red", "purple", "gold", "lightning", "target", "radar", "neon", "glitch", "rainbow", "crown", "eyes"]
    let bgs = ["spotlight", "converge", "tunnel", "hypno", "storm-forked", "storm-sheet", "storm-edges", "storm-aimed", "storm-rumble"]
    let steps: [(String, String)] = outlines.map { ("outline", $0) } + [("outline", "red")] + bgs.map { ("bg", $0) } + [("bg", "none"), ("theme", "light"), ("outline", "white-glisten"), ("theme", "dark")]
    let rectsJS = "JSON.stringify((function(){var W=innerWidth; var rows=[...document.querySelectorAll('.tm-list[data-sec=prio] > .tm-row')]; var p2=rows.find(function(r){return !r.classList.contains('p1')}); var d=[...document.querySelectorAll('.tm-list[data-sec=daily] > .tm-row')].pop(); var p1=rows[1]; var u=document.querySelector('.tm-aware li'); var f=function(e){if(!e) return null; var r=e.getBoundingClientRect(); var q=Math.min(parseFloat(getComputedStyle(e).borderTopLeftRadius)||0, r.height/2); return [r.left+q,r.top,r.width-2*q,r.height]}; return {W:W, p2:f(p2), daily:f(d), urgent:f(u), headline:f(document.querySelector('.tm-head .tm-title')), label:f(document.querySelector('.tm-list[data-sec=daily]').previousElementSibling), meetings:f(document.querySelector('.tm-meet:not(.tm-mail)')), inside:f(p1)}})())"
    a.overlay.evaluateJavaScript(rectsJS) { v, _ in
      guard let s = v as? String, let j = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any] else { print("JITTER: no rects"); done(); return }
      let W = (j["W"] as? Double) ?? 1
      var lines: [String] = []
      var outsideTotal = 0
      print("JITTER RECTS:", s)
      func run(_ i: Int) {
        guard i < steps.count else {
          print("JITTER CHECK (changed pixels between frames; every number but inside must be 0; frames=pictures compared, screen=pairs where something on screen moved):\n" + lines.joined(separator: "\n"))
          print("JITTER TOTAL OUTSIDE:", outsideTotal == 0 ? "0 ok" : "\(outsideTotal) FAIL")
          thunderCheck(a) { pickLook(a, "bg", "none", sound: false) { _ in pickLook(a, "outline", "red-glisten") { _ in done() } } }
          return
        }
        let (kind, id) = steps[i]
        let storm = id.hasPrefix("storm")
        pickLook(a, kind, id, storm: storm) { picked in
          DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            // The overlay page's own web process (test only: WebKit's private pid property).
            let pid = (a.overlay.value(forKey: "_webProcessIdentifier") as? Int32) ?? 0
            let c0 = pid > 0 ? cpuSeconds(pid) : 0
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
              let cpu = pid > 0 ? String(format: "%.0f%%", (cpuSeconds(pid) - c0) / 3 * 100) : "n/a"
              // Lightning strikes come and go, so those get 16 pictures over 2.4 s (strikes about
              // every 1.5 s at full frequency); everything else 3 pictures 150 ms apart.
              var imgs: [NSImage?] = []
              let n = storm ? 16 : 3
              func shoot() {
                a.overlay.takeSnapshot(with: nil) { img, _ in
                  imgs.append(img)
                  if imgs.count < n { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { shoot() } ; return }
                  let px = imgs.compactMap { pixels($0) }
                  guard px.count == n else { lines.append("  \(kind) \(id): no pictures"); run(i + 1); return }
                  let k = Double(px[0].w) / W
                  // Whole pixels only: a box edge at a fraction of a pixel shares that pixel with whatever is behind.
                  func rect(_ key: String) -> CGRect? {
                    guard let r = j[key] as? [Double], r.count == 4 else { return nil }
                    let x0 = ceil(r[0] * k), y0 = ceil(r[1] * k), x1 = floor((r[0] + r[2]) * k), y1 = floor((r[1] + r[3]) * k)
                    return CGRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
                  }
                  var parts: [String] = []
                  for key in ["p2", "daily", "urgent", "headline", "label", "meetings", "inside"] {
                    guard let r = rect(key) else { parts.append("\(key)=n/a"); continue }
                    var c = 0
                    for f in 1..<n { c += changed(px[f - 1], px[f], r) }
                    if key != "inside" { outsideTotal += c }
                    parts.append("\(key)=\(c)")
                  }
                  let whole = CGRect(x: 0, y: 0, width: px[0].w, height: px[0].h)
                  var moved = 0
                  for f in 1..<n where changed(px[f - 1], px[f], whole) > 0 { moved += 1 }
                  a.overlay.evaluateJavaScript("JSON.stringify({vis: document.visibilityState, anims: document.getAnimations().filter(function(x){return x.playState==='running'}).length, strikes: (document.querySelector('.tm-storm')||{dataset:{}}).dataset.strikes||0, paused: !!document.querySelector('.tm-paused'), calm: !!document.querySelector('.tm-calm')})") { pv, _ in print("    probe \(id):", pv ?? "") }
                  lines.append("  \(kind) \(id): " + parts.joined(separator: " ") + " frames=\(n) screen=\(moved)/\(n - 1) webCPU=\(cpu)" + (picked.contains("\"ok\":true") ? "" : " pick=\(picked)")
                    + (id == "none" ? " moving-area=\(changedBox(px[0], px[1]))" : ""))
                  if id == "none" || id == "white-glisten" || storm {
                    // the brightest picture (a strike, if one was caught)
                    let best = storm ? (1..<n).max(by: { changed(px[$0 - 1], px[$0], whole) < changed(px[$1 - 1], px[$1], whole) }) ?? 0 : n - 1
                    if let img = imgs[best], let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                      try? png.write(to: URL(fileURLWithPath: "\(dir)/jitter-\(id).png"))
                    }
                    if best > 0, let img = imgs[best - 1], let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
                      try? png.write(to: URL(fileURLWithPath: "\(dir)/jitter-\(id)-before.png"))
                    }
                  }
                  run(i + 1)
                }
              }
              shoot()
            }
          }
        }
      }
      run(0)
    }
  }
  // Thunder (written down, never played in a test): sounds come while the list shows, at most one
  // at a time and never above the cap; none at all once it is hidden.
  static func thunderCheck(_ a: App, _ done: @escaping () -> Void) {
    pickLook(a, "bg", "storm-forked", storm: true, sound: true) { _ in
      Sfx.shared.clearThunderLog()
      DispatchQueue.main.asyncAfter(deadline: .now() + 7) {
        let shownLog = Sfx.shared.thunderLog
        a.hideOverlay()
        Sfx.shared.clearThunderLog()
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) {
          let hiddenLog = Sfx.shared.thunderLog
          let loudest = shownLog.compactMap { Double($0.split(separator: "@").last ?? "") }.max() ?? 0
          let ok = !shownLog.isEmpty && hiddenLog.isEmpty && loudest <= 0.42
          print("THUNDER CHECK:", ok ? "ok" : "FAIL", "while-shown=\(shownLog)", "while-hidden=\(hiddenLog.count)", "loudest=\(loudest) (cap 0.42)")
          a.showOverlay()
          DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { done() }
        }
      }
    }
  }
  /// Hold / and press . (the developer, 20 Oct 2026). Keys go straight into the tap's own decision code on
  /// another thread, as they do for real; anything the tap would send on is recorded, never typed.
  /// Checks the exact text that comes out ("a/b", "//", "/.", paths, a held / repeating, Cmd+/,
  /// with the option off and on), the chord showing and hiding the list, / + 1, and typing in the list.
  static func slashChord(_ a: App, _ done: @escaping () -> Void) {
    let w = TabWatch.shared
    if Protected.front { print("SLASH CHORD CHECK: skipped (1Password or Signal is in front, where the tap is off by design)"); done(); return }
    let was = (a.vaultUnlocked, w.appActive, w.frontID, w.slashOn, w.staysChoice, a.testHoldState)
    // The test copy's own main page is signed out and sends its "state" (unlocked false) now and then; one
    // landing mid check set vaultUnlocked back to false and hid the list, so / passed as typing (meet, 7 Nov
    // 2026: held-dot-repeats-silent got "/.../."). The page state is held for the check, as NoWindow does.
    a.testHoldState = true
    a.vaultUnlocked = true; w.appActive = false; w.frontID = nil
    // Letting go of / hides the list: that is the setting "Tab keeps the list open" off (the developer's default). With
    // it on (anyone else's default) letting go keeps it, checked at the end here and in TAB STAYS.
    w.setStays(false)
    if a.shown { a.hideOverlay(force: true) }
    w.mu.lock(); w.testPosted = []; w.state = .idle; w.held = nil; w.pinned = false; w.closingHold = false; w.mu.unlock()
    let names: [Int64: String] = [0: "a", 11: "b", 7: "x", 16: "y", 44: "/", 47: ".", 18: "1"]
    typealias K = (code: Int64, down: Bool, rep: Bool, cmd: Bool)
    func k(_ c: Int64, _ d: Bool, rep: Bool = false, cmd: Bool = false) -> K { (c, d, rep, cmd) }
    func tap(_ c: Int64) -> [K] { [k(c, true), k(c, false)] }
    /// Feeds keys to the tap and returns what would reach the app, as text (⌘ marks a Cmd key).
    func feed(_ keys: [K]) -> String {
      var out: [CGEvent] = []
      for x in keys {
        let e = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(x.code), keyDown: x.down)!
        e.flags = x.cmd ? .maskCommand : []
        if x.rep { e.setIntegerValueField(.keyboardEventAutorepeat, value: 1) }
        w.mu.lock(); w.testPosted = []; w.mu.unlock()
        let r = w.handle(x.down ? .keyDown : .keyUp, e)
        w.mu.lock(); out += w.testPosted ?? []; w.mu.unlock()
        if r != nil { out.append(e) }
      }
      return out.filter { $0.type == .keyDown }.map { ($0.flags.contains(.maskCommand) ? "⌘" : "") + (names[$0.getIntegerValueField(.keyboardEventKeycode)] ?? "?") }.joined()
    }
    var res: [String] = []
    var ok = true
    func expect(_ name: String, _ got: String, _ want: String) { let pass = got == want; if !pass { ok = false }; res.append("\(name)=\(pass ? "ok" : "FAIL(got \"\(got)\" want \"\(want)\")")") }
    let typing: [(String, [K], String)] = [
      ("a/b", tap(0) + tap(44) + tap(11), "a/b"),
      ("a/b-fast", tap(0) + [k(44, true), k(11, true), k(44, false), k(11, false)], "a/b"),
      ("//", tap(44) + tap(44), "//"),
      ("/.", tap(44) + tap(47), "/."),
      ("/x/y", tap(44) + tap(7) + tap(44) + tap(16), "/x/y"),
      ("held-/", [k(44, true), k(44, true, rep: true), k(44, true, rep: true), k(44, false)], "///"),
      ("cmd+/", [k(44, true, cmd: true), k(44, false, cmd: true)], "⌘/"),
    ]
    DispatchQueue.global(qos: .userInteractive).async {
      // Option OFF: everything types exactly, the chord included.
      w.mu.lock(); w.slashOn = false; w.mu.unlock()
      for (n, keys, want) in typing { expect("off:\(n)", feed(keys), want) }
      expect("off:chord-types", feed([k(44, true), k(47, true), k(47, false), k(44, false)]), "/.")
      // Option ON: typing still comes out exactly.
      w.mu.lock(); w.slashOn = true; w.mu.unlock()
      for (n, keys, want) in typing { expect("on:\(n)", feed(keys), want) }
      DispatchQueue.main.async {
        let shownOff = a.shown            // the OFF chord above must not have shown the list
        DispatchQueue.global(qos: .userInteractive).async {
          // The chord: / down, . down shows the list at once; letting go of / hides it.
          let t0 = CACurrentMediaTime()
          expect("chord-types-nothing", feed([k(44, true), k(47, true)]), "")
          Thread.sleep(forTimeInterval: 0.35)
          DispatchQueue.main.sync { res.append("chord-shows=\(a.shown && !shownOff ? "ok" : "FAIL") in \(Int((CACurrentMediaTime() - t0) * 1000)) ms") ; if !a.shown || shownOff { ok = false } }
          expect("dot-up-and-/-up-swallowed", feed([k(47, false), k(44, false)]), "")
          Thread.sleep(forTimeInterval: 0.4)
          DispatchQueue.main.sync { let hid = !a.shown; res.append("release-hides=\(hid ? "ok" : "FAIL")"); if !hid { ok = false } }
          // The chord makes no sound (the developer, 2 Nov 2026): a held . repeats, . pressed again, and . still held
          // after / is let go all stay out of every app, then plain / and . type as before.
          expect("held-dot-repeats-silent", feed([k(44, true), k(47, true), k(47, true, rep: true), k(47, true, rep: true), k(44, true, rep: true), k(47, true, rep: true), k(47, false), k(44, false)]), "")
          expect("dot-again-silent", feed([k(44, true), k(47, true), k(47, false), k(47, true), k(47, true, rep: true), k(47, false), k(44, false)]), "")
          expect("dot-held-after-/-up-silent", feed([k(44, true), k(47, true), k(44, false), k(47, true, rep: true), k(47, true, rep: true), k(47, false)]), "")
          Thread.sleep(forTimeInterval: 0.4)
          expect("after-chord:/-and-.-type", feed(tap(44) + tap(47) + [k(47, true), k(47, true, rep: true), k(47, false)]), "/...")
          w.mu.lock(); w.swallowDotUp = true; w.mu.unlock()            // a . key up lost (eg a watchdog spell)
          expect("lost-dot-up-still-types", feed(tap(47)), ".")
          let silent = OverlayPanel.silent(#selector(NSResponder.keyDown(with:))) && !OverlayPanel.silent(#selector(NSResponder.mouseDown(with:)))
          res.append("list-never-beeps=\(silent ? "ok" : "FAIL")"); if !silent { ok = false }
          DispatchQueue.main.sync { let hid = !a.shown && w.state == .idle; res.append("silent-chords-hide=\(hid ? "ok" : "FAIL")"); if !hid { ok = false } }
          // / + 1: the Add task window, pinned, so the list stays when / is let go.
          expect("slash+1-types-nothing", feed([k(44, true), k(47, true), k(47, false), k(18, true), k(18, false), k(44, false)]), "")
          Thread.sleep(forTimeInterval: 0.4)
          DispatchQueue.main.sync {
            let stays = a.shown && w.pinned
            res.append("slash+1-pins=\(stays ? "ok" : "FAIL")"); if !stays { ok = false }
            // Typing in the list: / and . are text.
            w.mu.lock(); w.editing = true; w.mu.unlock()
          }
          expect("typing-in-list", feed([k(44, true), k(47, true), k(47, false), k(44, false)]), "/.")
          // Tab keeps the list open on: letting go of / keeps the list, the chord again puts it away, silently.
          DispatchQueue.main.sync {
            w.mu.lock(); w.editing = false; w.pinned = false; w.state = .idle; w.held = nil; w.swallowDotUp = false; w.closingHold = false; w.mu.unlock()
            a.hideOverlay(force: true)
            w.setStays(true)
          }
          expect("stays:chord-types-nothing", feed([k(44, true), k(47, true), k(47, false), k(44, false)]), "")
          Thread.sleep(forTimeInterval: 0.4)
          DispatchQueue.main.sync { w.mu.lock(); let p = w.pinned; w.mu.unlock(); let kept = a.shown && p; res.append("stays:release-keeps=\(kept ? "ok" : "FAIL")"); if !kept { ok = false } }
          expect("stays:chord-again-types-nothing", feed([k(44, true), k(47, true), k(47, true, rep: true), k(47, false), k(44, false)]), "")
          Thread.sleep(forTimeInterval: 0.4)
          DispatchQueue.main.sync { let hid = !a.shown && w.state == .idle; res.append("stays:chord-again-hides=\(hid ? "ok" : "FAIL")"); if !hid { ok = false } }
          expect("stays:after-/-types", feed(tap(44)), "/")
          DispatchQueue.main.async {
            w.mu.lock(); w.editing = false; w.pinned = false; w.state = .idle; w.held = nil; w.testPosted = nil; w.slashOn = was.3; w.closingHold = false; w.mu.unlock()
            a.hideOverlay(force: true)
            w.setStays(was.4)
            a.vaultUnlocked = was.0; w.appActive = was.1; w.frontID = was.2; a.testHoldState = was.5
            let k = KeyLayout.slashKeys()
            print("SLASH CHORD CHECK:", ok ? "ok" : "FAIL", res.joined(separator: " "), "layout=\(k.name) keys=\"\(k.slash)\" \"\(k.dot)\"", "real-tap-installed=\(w.tap != nil)")
            done()
          }
        }
      }
    }
  }
  // The keyboard tap never waits for the main thread. Its handler runs on another thread here, as
  // it does for real: with main alive a Tab press is held (the list may show); with main stuck for
  // 2.5 s, keys pressed meanwhile pass straight through within milliseconds. No real keys are posted.
  static func watchdog(_ a: App, _ done: @escaping () -> Void) {
    let w = TabWatch.shared
    let was = (a.vaultUnlocked, w.appActive, w.frontID)
    a.vaultUnlocked = true; w.appActive = false; w.frontID = nil   // the case where Tab is normally held back (whatever app the developer has in front)
    // No modifiers: a made up key takes the real keyboard's modifiers, and one held on the developer's keyboard during the run
    // made PS rightly leave Tab alone ("Tab hold ignored, modifiers held"), failing main-back-tab-held (1 Nov 2026).
    let key = { (code: CGKeyCode) -> CGEvent in let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!; e.flags = []; return e }
    DispatchQueue.global(qos: .userInteractive).async {
      let held = w.handle(.keyDown, key(48)) == nil
      w.mu.lock(); w.holdWork?.cancel(); w.held = nil; w.state = .idle; w.mu.unlock()
      DispatchQueue.main.async {
        var res: [String] = []
        DispatchQueue.global(qos: .userInteractive).asyncAfter(deadline: .now() + 1.4) {
          for (name, code) in [("tab", CGKeyCode(48)), ("a", CGKeyCode(0)), ("esc", CGKeyCode(53))] {
            let t0 = CACurrentMediaTime()
            let passed = w.handle(.keyDown, key(code)) != nil
            res.append("\(name)=\(passed ? "passed" : "HELD") in \(Int((CACurrentMediaTime() - t0) * 1000))ms")
          }
        }
        Thread.sleep(forTimeInterval: 2.5)                // the main thread is stuck
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
          DispatchQueue.global(qos: .userInteractive).async {
            let back = w.handle(.keyDown, key(48)) == nil
            w.mu.lock(); w.holdWork?.cancel(); w.held = nil; w.state = .idle; w.mu.unlock()
            DispatchQueue.main.async {
              a.vaultUnlocked = was.0; w.appActive = was.1; w.frontID = was.2
              let ok = held && back && res.count == 3 && res.allSatisfy { $0.contains("passed") }
              print("WATCHDOG CHECK:", ok ? "ok" : "FAIL", "main-alive-tab-held=\(held)", "main-stuck:", res.joined(separator: ", "), "main-back-tab-held=\(back)", "real-tap-installed=\(w.tap != nil)")
              done()
            }
          }
        }
      }
    }
  }
  /// "Shall I end my day now?" is gone (V1.28, the developer: never prompt him to end his day): even with the last
  /// Reset long ago, the Tab list shows no end of day strip.
  static func eodStrip(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    guard let st = a.lastState, let rx = try? NSRegularExpression(pattern: #""lastResetAt":"[^"]*""#) else { return done() }
    let keep = st
    a.lastState = rx.stringByReplacingMatches(in: st, range: NSRange(st.startIndex..., in: st), withTemplate: #""lastResetAt":"2026-01-01T10:00:00Z""#)
    a.pushState()
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
      a.overlay.evaluateJavaScript("JSON.stringify({ strip: !!document.querySelector('.eod-strip'), ask: /end my day/i.test(document.body.innerText || '') })") { t, _ in
        let r = t as? String ?? ""
        snap(a.overlay, "\(dir)/overlay-no-eod.png") {
          print("EOD STRIP CHECK: gone=\(r.contains("\"strip\":false") && r.contains("\"ask\":false") ? "ok" : "FAIL")")
          a.lastState = keep; a.pushState()
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { done() }
        }
      }
    }
  }

  static func listAndLocked(_ a: App, _ dir: String) {
    snap(a.overlay, "\(dir)/overlay.png") {
      eodStrip(a, dir) {
        // Locked view: the overlay card (the Sign in window's pictures are in NoWindowSelfTest.swift).
        a.lastState = #"{"type":"state","unlocked":false,"lastSync":null,"docs":[]}"#
        a.pushState()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
          snap(a.overlay, "\(dir)/overlay-locked.png") { a.hideOverlay(); safePeek(a) { Toast.shared.selfTest(dir) { Island.shared.selfTest(dir) { hiddenTimers(a) { watchdog(a) { slashChord(a) { tabStays(a) { noWindow(a, dir) { print(ScreenGuard.report()); print(NetGuard.report()); print("DONE"); exit(0) } } } } } } } } }
        }
      }
    }
  }
  // Hold Tab over Signal or 1Password (simulated, no real app): the tap goes off, the Tab hotkey arms
  // over both (1Password since V1.40), a hold shows the list without taking the keyboard, a quick tap shows nothing.
  static func safePeek(_ a: App, _ done: @escaping () -> Void) {
    let p = SafePeek.shared, w = TabWatch.shared
    let wasUnlocked = a.vaultUnlocked, wasHold = a.testHoldState, wasStays = w.staysChoice
    // V1.58: two accounts (BuildRules.swift). Everything up to redPart is the public / G Squad account (Tab opens PS
    // over 1Password and Signal); redPart is the developer's (it never does). The real owner answer is never changed.
    let wasAccount = BuildRules.testAccount
    BuildRules.testAccount = false
    a.testHoldState = true               // the signed out main page's own "state" never lands mid check
    a.vaultUnlocked = true
    // Letting go hides: the setting "Tab keeps the list open" off (the developer's default). On (anyone else's) it is
    // checked below: letting go keeps it, without the keyboard, and the next press puts it away.
    w.setStays(false)
    w.mu.lock(); w.pinned = false; w.mu.unlock()
    var r: [String] = []
    func ok(_ name: String, _ pass: Bool) { r.append("\(name)=\(pass ? "ok" : "FAIL")") }
    func finish() {
      w.mu.lock(); w.pinned = false; w.mu.unlock()
      w.setStays(wasStays)
      Protected.simulate(front: false, signal: false)                    // back to a normal app
      ok("disarmed-after", !p.armed)
      if let t = w.tap { ok("tap-back-on", CGEvent.tapIsEnabled(tap: t)) }
      a.vaultUnlocked = wasUnlocked; a.testHoldState = wasHold
      BuildRules.testAccount = wasAccount; p.refresh()
      let line: String = r.joined(separator: " ")
      print("SAFEPEEK CHECK:", line, "status=\(p.lastStatus)")
      done()
    }
    /// V1.44 (the developer: "open on ANY app"): Right Option chosen, signed out, and Secure Input stuck over a normal app.
    func anyAppPart() {
      w.setStays(false)
      let key = w.triggerKey
      w.triggerKey = "rightOption"; p.refresh()
      ok("any:rightoption-armed-over-protected", p.armed)
      w.triggerKey = key; p.refresh()
      a.vaultUnlocked = false
      p.hit(1, pressed: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + HOLD_SECONDS + 0.3) {
        ok("any:signed-out-armed", p.armed)
        ok("any:signed-out-hold-asks", p.lastHold == .showCard || p.lastHold == .askTouchID)
        ok("any:signed-out-no-list", !a.shown)
        p.hit(1, pressed: false)
        Popup.shared.hide(giveBack: false)
        a.vaultUnlocked = true
        Protected.simulate(front: false, signal: false)                  // a normal app, Secure Input stuck on
        ok("any:normal-app-disarmed", !p.armed)
        p.secureStuck = true
        ok("any:secure-stuck-armed", p.armed)
        let before = p.testPassed
        p.hit(1, pressed: true); p.hit(1, pressed: false)               // a quick tap goes on to the app
        ok("any:secure-tap-passed-on", p.testPassed == before + 1 && !a.shown)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
          ok("any:secure-rearmed-after-pass", p.armed)
          p.hit(1, pressed: true)
          DispatchQueue.main.asyncAfter(deadline: .now() + HOLD_SECONDS + 0.3) {
            ok("any:secure-hold-shows", a.shown)
            p.hit(1, pressed: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
              ok("any:secure-release-hides", !a.shown)
              p.secureStuck = false
              ok("any:secure-cleared-disarmed", !p.armed)
              stalePart()
            }
          }
        }
      }
    }
    /// V1.58, the cause of "Tab does not open over Signal" for friends: a typing flag left on while the list is hidden
    /// (the page said a screen was open) disarmed the hotkey over 1Password and Signal only. Now it counts only while
    /// the list is shown, as in the keyboard tap.
    func stalePart() {
      w.setStays(false)
      Protected.simulate(front: true, signal: true)
      w.editing = true                                                  // left over, the list is hidden
      ok("public:stale-typing-flag-still-armed", !a.shown && p.armed)
      p.hit(1, pressed: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + HOLD_SECONDS + 0.3) {
        ok("public:stale-typing-flag-hold-shows", a.shown)
        p.hit(1, pressed: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
          ok("public:stale-typing-flag-release-hides", !a.shown)
          w.editing = false
          redPart()
        }
      }
    }
    /// V1.58, the developer's account: PS never opens over 1Password or Signal (no hold key, no Esc, no combo), whatever else
    /// is going on, and a list left up goes away when one of them comes to the front. The tap stays off there as before.
    func redPart() {
      BuildRules.testAccount = true
      let list = w.customList
      w.setCustom([OpenKeysCore.Shortcut(kind: .hold, key: OpenKeysCore.TAB),
                   OpenKeysCore.Shortcut(kind: .combo, key: OpenKeysCore.SPACE, mods: ["ctrl", "opt"])], save: false)
      Protected.simulate(front: false, signal: false)
      ok("red:combos-on-normal-app", p.testCombos == 1)
      Protected.simulate(front: true, signal: false)                     // 1Password
      ok("red:1password-not-armed", !p.armed)
      ok("red:1password-combos-dropped", p.testCombos == 0)
      if let t = w.tap { ok("red:1password-tap-off", !CGEvent.tapIsEnabled(tap: t)) }
      Protected.simulate(front: true, signal: true)                      // Signal
      ok("red:signal-not-armed", !p.armed)
      p.secureStuck = true
      ok("red:secure-stuck-still-not-armed", !p.armed)
      p.secureStuck = false
      a.vaultUnlocked = false
      ok("red:signed-out-not-armed", !p.armed)
      a.vaultUnlocked = true
      Protected.simulate(front: false, signal: false)
      ok("red:combos-back-after", p.testCombos == 1)
      a.showOverlay()                                                   // a list left up (pinned) on a normal app
      w.mu.lock(); w.pinned = true; w.mu.unlock()
      Protected.simulate(front: true, signal: false)
      ok("red:pinned-list-goes", !a.shown)
      ok("red:esc-not-armed", !p.escArmed)
      w.mu.lock(); w.pinned = false; w.mu.unlock()
      Protected.simulate(front: false, signal: false)
      w.setCustom(list, save: false)
      // Everyone else keeps a list left up when one of them comes to the front.
      BuildRules.testAccount = false
      a.showOverlay()
      w.mu.lock(); w.pinned = true; w.mu.unlock()
      Protected.simulate(front: true, signal: true)
      ok("public:pinned-list-stays", a.shown)
      ok("public:esc-armed-while-up", p.escArmed)
      a.hideOverlay(force: true)
      finish()
    }
    /// Tab keeps the list open on: hold, let go, it stays (no keyboard); the next press hides it.
    func staysPart() {
      w.setStays(true)
      p.hit(1, pressed: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + HOLD_SECONDS + 0.3) {
        ok("stays:hold-shows", a.shown)
        p.hit(1, pressed: false)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
          w.mu.lock(); let pinned = w.pinned; w.mu.unlock()
          ok("stays:release-keeps", a.shown && pinned)
          ok("stays:keyboard-stays-with-app", !a.panel.isKeyWindow)
          p.hit(1, pressed: true)
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
            ok("stays:press-hides", !a.shown)
            p.hit(1, pressed: false)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { ok("stays:stays-hidden", !a.shown); anyAppPart() }
          }
        }
      }
    }
    Protected.simulate(front: true, signal: false)                       // 1Password
    ok("1password-armed", p.armed)
    if let t = w.tap { ok("1password-tap-off", !CGEvent.tapIsEnabled(tap: t)) }
    Protected.simulate(front: true, signal: true)                        // Signal
    ok("signal-armed", p.armed)
    if let t = w.tap { ok("signal-tap-off", !CGEvent.tapIsEnabled(tap: t)) } else { r.append("tap=none-in-test") }
    p.hit(1, pressed: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + HOLD_SECONDS + 0.3) {
      ok("hold-shows", a.shown)
      ok("keyboard-stays-with-app", !a.panel.isKeyWindow)
      p.hit(1, pressed: false)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        ok("release-hides", !a.shown)
        p.hit(1, pressed: true); p.hit(1, pressed: false)               // a quick tap
        DispatchQueue.main.asyncAfter(deadline: .now() + HOLD_SECONDS + 0.3) {
          ok("tap-shows-nothing", !a.shown)
          staysPart()
        }
      }
    }
  }
  static func snap(_ w: WKWebView, _ path: String, _ done: @escaping () -> Void) {
    w.takeSnapshot(with: nil) { img, err in
      if let img, let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
        try? png.write(to: URL(fileURLWithPath: path)); print("saved", path)
      } else { print("snapshot failed", err as Any) }
      done()
    }
  }
}

// Second Computer's Keychain items: before anything else can reach them, only a PS with Second Computer switched on may
// (SecondCrypto.swift SecondKeychain.gate; it is closed until this line; PS 1.65, the developer's alone V1.44 to V1.64). A PS with
// it off never reads, writes or hands over one, so the Keychain never asks about Second Computer.
SecondKeychain.gate = { Second.switchedOn }

// Sentry mode's guard (Sentry.swift SentryGuard, V1.48): PS's own binary started as `--ps-sentry-guard`; it waits for its
// PS to exit and locks the Mac if Sentry mode was still engaged. It never gets past this line.
SentryGuard.runIfAsked()

// The installer and updater come first: the update helper and test children stop here
// (UpdateHandoff.swift), and PS opened from the DMG shows "Install PS" instead (Installer.swift).
UpdateBoot.early()
let INSTALL_MODE = Installer.shouldRun()
// Sentry mode was engaged when PS last stopped (a crash, a kill, a quit): lock the Mac first thing (Sentry.swift).
if !INSTALL_MODE { Sentry.recoverAtLaunch() }

// Only one self test copy at a time on this Mac, whichever session starts it (20 Oct 2026).
var testLockFD: Int32 = -1
if IS_TEST_COPY {
  testLockFD = open("/tmp/ps-selftest.lock", O_CREAT | O_RDWR, 0o644)
  if SecondSelfTest.peerAllowed(lockFD: testLockFD) {
    // The Secondary half of the SECOND check: its parent, the test copy that holds the lock, started it.
  } else {
    if testLockFD < 0 || flock(testLockFD, LOCK_EX | LOCK_NB) != 0 {
      let other = (try? String(contentsOfFile: "/tmp/ps-selftest.lock", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "?"
      print("SELFTEST: another test copy is running (pid \(other)), not starting")
      exit(3)
    }
    ftruncate(testLockFD, 0)
    let me = "\(getpid())\n"
    _ = me.withCString { write(testLockFD, $0, strlen($0)) }
  }
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
// A self test copy is a background app from the first line: no Dock icon, never handed focus.
app.setActivationPolicy(ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil ? .accessory : .regular)
app.run()
