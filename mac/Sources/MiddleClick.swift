import Cocoa
import ServiceManagement

// Force Touch middle click (the developer, 31 Oct 2026: "I also want it to just be embedded in a PS app too").
// PS ships the helper "PS Middle Click.app" at PS.app/Contents/Library/LoginItems, built from
// ~/Projects/middle-click (the same code as the standalone PSMiddleClicker app, so fixes reach both).
// The helper runs as its own process: PS restarting never drops a click, and a mouse tap problem can
// never take PS down. PS only switches it on and off and shows how it is doing:
// - on: registers it as a login item (SMAppService) and opens it; off: unregisters it and asks the
//   running helper to quit through its own NSRunningApplication handle. Never by name.
// - Its state comes from ~/Library/Application Support/PS/middleclick.json, re-read on the helper's
//   distributed notification "com.cincee.ps.middleclick.changed".
// - Never both at once: while the standalone PSMiddleClicker app runs, the helper keeps its tap off.
// - The helper needs its own Accessibility switch ("PS Middle Click"); PS Settings says so and opens
//   the right page. PS never changes the setting itself.
// On by default for everyone, public build too (the developer, 16 Nov 2026); an explicit off in PS Settings stays
// off. The helper never asks for its permission by itself: it waits quietly until the person clicks
// the button in PS Settings. A self test copy never starts the helper.
// It heals itself (16 Nov 2026, rules in MiddleClickHealCore.swift): after a PS update the older
// helper still running is quit and the new one opened; a helper that says running with its taps
// off for over 60 s is restarted once (logged, no pop up, at most once every 10 minutes). The
// files are read off the main thread; only the helper's own process (com.cincee.ps.middleclick,
// by its handle) is ever quit.
final class MiddleClick {
  static let shared = MiddleClick()
  static let helperID = "com.cincee.ps.middleclick"
  static let standaloneID = "com.cincee.psmiddleclicker"
  /// Tells the helper to ask macOS for its permission now (after the person clicked in Settings).
  static let askNotice = Notification.Name("com.cincee.ps.middleclick.ask")
  static let stateURL = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/PS/middleclick.json")

  var onChange: (() -> Void)?
  private var test = false
  private var watch = MiddleClickHealCore.StuckWatch()
  private var restarting = false
  private let readQ = DispatchQueue(label: "ps.middleclick.read", qos: .utility)
  private var service: SMAppService { .loginItem(identifier: MiddleClick.helperID) }
  var helperURL: URL { Bundle.main.bundleURL.appendingPathComponent("Contents/Library/LoginItems/PS Middle Click.app") }

  /// PS Settings > Force Touch middle click. On by default for everyone (the developer, 16 Nov 2026): a Mac that
  /// never chose is on; an explicit off stays off (MiddleClickHealCore.isOn).
  private(set) var on: Bool {
    get { MiddleClickHealCore.isOn(stored: UserDefaults.standard.object(forKey: "middleClick.on")) }
    set { UserDefaults.standard.set(newValue, forKey: "middleClick.on") }
  }

  func start(testDir: String?) {
    test = testDir != nil
    DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.cincee.ps.middleclick.changed"), object: nil, queue: .main) { [weak self] _ in
      self?.onChange?()
      self?.watchHelper()
    }
    guard !test else { return }
    if on { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.ensureRunning() } }
    let t = Timer(timeInterval: MiddleClickHealCore.watchEvery, repeats: true) { [weak self] _ in self?.watchHelper() }
    t.tolerance = 3
    RunLoop.main.add(t, forMode: .common)
  }

  /// From the page: {op: "set", on: Bool} or {op: "accessibility"}.
  func handle(_ msg: [String: Any]) {
    switch msg["op"] as? String {
    case "set":
      guard let v = msg["on"] as? Bool, v != on else { return }
      on = v
      psLog("PS middle click: switched \(v ? "on" : "off")")
      if !test { v ? switchOn() : switchOff() }
    case "accessibility":
      // The one click ask, as the install screen does for PS itself: the helper asks macOS now (that
      // puts "PS Middle Click" in the list, with macOS's own prompt) and the page opens. The helper
      // never asks by itself, so nobody gets a prompt they did not click for. The user flips the
      // switch themselves.
      if !test {
        psLog("PS middle click: asking for permission (Settings button)")
        DistributedNotificationCenter.default().postNotificationName(MiddleClick.askNotice, object: nil, userInfo: nil, deliverImmediately: true)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
      }
    default: break
    }
  }

  private func running() -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: MiddleClick.helperID).filter { !$0.isTerminated }
  }

  private func switchOn() {
    do { try service.register() } catch { psLog("PS middle click: login item not registered (\(error.localizedDescription)), PS opens it at each start instead") }
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.ensureRunning() }
  }

  private func switchOff() {
    try? service.unregister()
    for h in running() { h.terminate() }   // its own handle: a polite quit, it gives back any held click
  }

  /// On: the helper from THIS PS runs. After a PS update the old helper may still run, from the old
  /// bundle or (the usual case) from the same path with the new files under it, so its build is
  /// checked too. It is asked to quit and the new one opens (a gap of about a second).
  private func ensureRunning() {
    guard on, !test, FileManager.default.fileExists(atPath: helperURL.path) else { return }
    facts { f in
      let mine = self.helperURL.resolvingSymlinksInPath().path
      let old = self.running().filter { $0.bundleURL?.resolvingSymlinksInPath().path != mine || self.stale($0, f) }
      for h in old {
        psLog("PS middle click: an older helper is still running (pid \(h.processIdentifier), build \(f.report?.pid == h.processIdentifier ? f.report?.build ?? "?" : "?"), this PS has \(f.disk ?? "?")), restarting it")
      }
      self.replace(old)
    }
  }

  /// What the helper said and what is on disk, read off the main thread; done() runs on main.
  private struct Facts { var report: MiddleClickHealCore.Report?; var disk: String?; var written: Date? }
  private func facts(_ done: @escaping (Facts) -> Void) {
    let url = helperURL
    readQ.async {
      let raw = (try? Data(contentsOf: MiddleClick.stateURL)).flatMap { String(data: $0, encoding: .utf8) }
      // Read fresh each time: Bundle(url:) keeps the first Info.plist it read for the whole run.
      let disk = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist"))?["CFBundleVersion"] as? String
      let exe = url.appendingPathComponent("Contents/MacOS/PSMiddleClick").path
      let written = (try? FileManager.default.attributesOfItem(atPath: exe))?[.modificationDate] as? Date
      let f = Facts(report: MiddleClickHealCore.report(raw), disk: disk, written: written)
      DispatchQueue.main.async { done(f) }
    }
  }

  private func stale(_ h: NSRunningApplication, _ f: Facts) -> Bool {
    MiddleClickHealCore.stale(runningPid: h.processIdentifier, report: f.report, diskBuild: f.disk, launched: h.launchDate, written: f.written)
  }

  /// Every 15 s and on each change notice: an older helper after an update, or one stuck with its
  /// taps off for over 60 s, is restarted (at most once every 10 minutes, logged, never a pop up).
  private func watchHelper() {
    guard on, !test, !restarting else { return }
    facts { f in
      guard self.on, !self.restarting else { return }
      let now = ProcessInfo.processInfo.systemUptime
      let helpers = self.running()
      if let old = helpers.first(where: { self.stale($0, f) }), self.watch.mayRestart(at: now) {
        self.watch.noteRestart(at: now)
        self.restart("an older helper (pid \(old.processIdentifier)) was still running, this PS has build \(f.disk ?? "?")")
        return
      }
      let alive = helpers.contains { $0.processIdentifier == f.report?.pid }
      if self.watch.observe(f.report, alive: alive, on: self.on, at: now) {
        self.restart("it said running with its mouse taps off for over \(Int(MiddleClickHealCore.stuckAfter)) s, build \(f.report?.build ?? "?")")
      }
    }
  }

  private func restart(_ why: String) {
    psLog("PS middle click: restarting the helper (\(why))")
    replace(running())
  }

  /// Asks these helpers to quit (their own handles), makes any still there after 1.5 s quit, then
  /// opens this PS's helper if none is running. Main thread, never waits.
  private func replace(_ old: [NSRunningApplication]) {
    restarting = true
    for h in old { h.terminate() }   // a polite quit first: it gives back any held click
    DispatchQueue.main.asyncAfter(deadline: .now() + (old.isEmpty ? 0 : 1.5)) {
      let left = old.filter { !$0.isTerminated }
      for h in left where h.bundleIdentifier == MiddleClick.helperID {
        psLog("PS middle click: the old helper (pid \(h.processIdentifier)) did not quit, making it quit")
        h.forceTerminate()
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + (left.isEmpty ? 0 : 1)) {
        self.restarting = false
        guard self.on, self.running().isEmpty else { return }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = false
        cfg.addsToRecentItems = false
        NSWorkspace.shared.openApplication(at: self.helperURL, configuration: cfg) { _, err in
          if let err { psLog("PS middle click: could not open the helper (\(err.localizedDescription))") }
        }
      }
    }
  }

  /// For PS Settings. The helper's own report, checked against what is really running.
  func settingsJSON() -> [String: Any] {
    let raw = (try? Data(contentsOf: MiddleClick.stateURL)).flatMap { String(data: $0, encoding: .utf8) }
    let alive = !running().isEmpty
    let standalone = NSRunningApplication.runningApplications(withBundleIdentifier: MiddleClick.standaloneID).contains { !$0.isTerminated }
    var d = MiddleClick.status(on: on, stateJSON: raw, helperAlive: alive, standalone: standalone)
    d["present"] = FileManager.default.fileExists(atPath: helperURL.path)
    d["approval"] = !test && service.status == .requiresApproval
    return d
  }

  /// Pure, for the self test: what PS Settings shows. status is one of
  /// "off", "starting", "needsAccess", "standalone" (the PSMiddleClicker app is doing it), "on".
  static func status(on: Bool, stateJSON: String?, helperAlive: Bool, standalone: Bool) -> [String: Any] {
    let s = stateJSON.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
    let reported = (s["running"] as? Bool) == true && helperAlive
    let trusted = (s["trusted"] as? Bool) == true
    let tap = (s["tap"] as? Bool) == true
    let yielding = (s["yielding"] as? Bool) == true || standalone
    let status: String
    if !on { status = standalone ? "standalone" : "off" }
    else if !reported { status = "starting" }
    else if yielding { status = "standalone" }
    else if !trusted { status = "needsAccess" }
    else if tap { status = "on" }
    else { status = "starting" }
    return ["on": on, "status": status, "trusted": trusted, "build": s["build"] as? String ?? ""]
  }

  /// Self test line (native only, no helper is started): the helper is inside this PS, signed as
  /// itself, in embedded mode; and the status logic maps each helper report right.
  static func selfCheck() -> String {
    var r: [(String, Bool)] = []
    let url = Bundle.main.bundleURL.appendingPathComponent("Contents/Library/LoginItems/PS Middle Click.app")
    let info = Bundle(url: url)?.infoDictionary ?? [:]
    r.append(("present", FileManager.default.fileExists(atPath: url.path)))
    r.append(("id", info["CFBundleIdentifier"] as? String == helperID))
    r.append(("embedded", info["PSMCEmbedded"] as? Bool == true))
    r.append(("noMenuIcon", info["LSUIElement"] as? Bool == true))
    var code: SecStaticCode?
    let signed = SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess && code != nil
      && SecStaticCodeCheckValidity(code!, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess
    r.append(("signed", signed))
    func st(_ on: Bool, _ j: String?, _ alive: Bool, _ sa: Bool) -> String { status(on: on, stateJSON: j, helperAlive: alive, standalone: sa)["status"] as? String ?? "" }
    let good = #"{"running":true,"trusted":true,"tap":true,"yielding":false,"build":"1","pid":1}"#
    r.append(("statusOff", st(false, nil, false, false) == "off"))
    r.append(("statusStarting", st(true, nil, false, false) == "starting"))
    r.append(("statusStale", st(true, good, false, false) == "starting"))   // the file says running, the process is gone
    r.append(("statusOn", st(true, good, true, false) == "on"))
    r.append(("statusNeedsAccess", st(true, #"{"running":true,"trusted":false,"tap":false,"yielding":false}"#, true, false) == "needsAccess"))
    r.append(("statusStandalone", st(true, #"{"running":true,"trusted":true,"tap":false,"yielding":true}"#, true, true) == "standalone"))
    r.append(("statusOffStandalone", st(false, nil, false, true) == "standalone"))
    return "MIDDLECLICK CHECK: " + r.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " ")
  }
}
