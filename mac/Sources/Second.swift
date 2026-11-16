import AppKit
import CryptoKit
import Foundation
import SystemConfiguration
import UniformTypeIdentifiers

// PS Second Computer, the native side (the developer, 31 Oct 2026; protocol v1 in the lead's notes). The developer's spare
// Mac (the M1, "Secondary") runs allowlisted jobs his travelling Mac (the M4, "Primary") sends through
// his end to end encrypted vault: the PS self test, builds, a project's tests, headless Claude tasks,
// files and messages. The page does the vault (records, crypto, upload, download); native holds the
// device key, the trust store, the pairing alerts, signing and every check before anything runs, the
// runner (SecondProc.swift), file landing, git bundles, the heartbeat and staying awake (SecondHost.swift),
// and the CLI folder Claude sessions on the M4 use (scripts/second.ts in web).
// Bridge messages (main window only) and what each answers are listed in the lead's runner-done.md.
// Rules: nothing heavy on the main thread; alerts only after the developer's own click and never over 1Password or
// Signal; the heartbeat sends only on a change or every 5 minutes; no system, network or VPN setting is
// ever changed; a test copy never touches the Keychain, a real power assertion or ~/Downloads.

final class Second {
  static let shared = Second()
  let work = DispatchQueue(label: "ps.second", qos: .utility)
  private let test = IS_TEST_COPY
  private(set) var places: SecondPlaces
  private(set) var downloads: String
  private var cliDir: String
  private var id: SecondIdentity?
  private var pending: [() -> Void] = []        // page messages that came before the key was loaded
  private(set) var role = "none"
  private var name = "Mac", model = "Mac"
  /// This Mac's chip (eg "Apple M4") and whether the developer picked the role (false while it is the chip's starting role).
  /// Both go to the page, so the Second Computer window can say what this Mac is (1 Nov 2026, the developer could not pair).
  private(set) var chipName = ""
  private(set) var roleChosen = false
  /// One click pairing (V1.26): the "looking for my other Mac" records this Mac signed, by id, with their time
  /// (epoch ms). Kept on disk so a Mac that starts later still finds this one; each lasts 24 hours.
  private var seeks: [String: Double] = [:]
  /// Why Second Computer is off on this Mac (no device key), told to the page so the other Mac can say so.
  private var offReason: String?
  /// What this Mac's own page shows while it is off (4 Nov 2026: on the M4 a click on "This is my main Mac" did
  /// nothing at all): the plain reason and whether the developer's Allow was already tried.
  private var offHere: String?
  private var offRetried = false
  /// The developer clicked Allow and the read is running: a second click waits for it.
  private var allowing = false
  /// A short notice after a pairing this Mac did by itself (one click on the main Mac). Test copies replace it.
  var notice: (_ title: String, _ text: String) -> Void = { SecondConfirm.shared.notice($0, $1) }
  private var runner: SecondRunner?
  private var landing: SecondLanding?
  let awake = SecondAwake()
  private var have: [String: String] = [:]
  private var statTimer: Timer?
  private var tailTimer: DispatchSourceTimer?
  private var lastSent: [String: (String, Date)] = [:]   // job id -> the state last sent and when
  private var jobFrom: [String: String] = [:]   // job id -> the primary it came from
  private var cliSource: DispatchSourceFileSystemObject?
  private var cliTimer: Timer?
  private var peerStat: [String: Any]?           // the secondary's newest stat, as the primary heard it
  private var peerStatAt: Date?
  private var unlocked = false
  /// PS 1.65: Second Computer is everyone's, behind its switch (Settings, Second Computer; feature "second-computer").
  /// start() runs only through setOn(true) (main.swift); until then nothing here answers the page, opens a window, writes
  /// a file or asks for a key. The developer's alone V1.42 to V1.64 (Owner.whenRed).
  private(set) var started = false
  /// Switched off after it started (setOn(false)): no work, no heartbeat, nothing to or from the page.
  private(set) var off = false
  /// Started and not switched off.
  var isOn: Bool { started && !off }
  private var watchTimer: DispatchSourceTimer?
  private var frontBefore: NSRunningApplication?

  private var shares: [SecondShare.Root] = []
  private var shareWatch: SecondShareWatch?
  private var idxSent: [String: String] = [:]    // root id -> hash of the listing last sent
  /// Remote restart, shut down and lock (protocol section 13): the reboot session's RemoteCommand plugs in
  /// here when its branch is merged (main.swift). Until then a command gets a signed "Not set up on this Mac".
  /// `at`: the command's own time (epoch ms), so a command signed before this Mac last started is dropped there.
  var cmdRunner: ((_ action: String, _ id: String, _ from: String, _ at: Double, _ done: @escaping (Bool, String?) -> Void) -> Void)?
  /// The stat's `machine` (AutoReboot.shared.machine(), main thread).
  var machine: (() -> [String: Any])?
  /// Opens or raises the Second Computer window (main.swift, SecondWindow.swift).
  var openWindow: (String?) -> Void = { _ in }
  /// Runs before PS's own Open panel shows (main.swift puts the Tab list away, which floats above it).
  var beforePanel: () -> Void = {}
  /// What this Mac's PS can do with files (drag and drop, protocol v1.2): the page reads it from second, and the
  /// hello carries the file part (ncaps) so the other Mac knows what it may send here.
  static let caps = ["outbox", "stream", "pack", "drop", "outsource"]
  /// Outsourcing (protocol v1.3, SecondSeal.swift, SecondOutsource.swift): this Mac's sealing and job keys, the
  /// second Mac's runner, and the jobs this Mac sent or runs (their titles and reports stay on the Macs).
  private(set) var okeys: SecondKeys?
  private var orunner: SecondOutsourceRunner?
  private var ojobs: [String: [String: Any]] = [:]
  /// Self test: the Allow card's text while it shows (test copies never show a real card).
  var keyCardShown: String?
  /// Self test: the next read fails like a Keychain Deny (then Allow reads normally).
  var testDenyNextRead = false
  /// Self test: the next read after Allow fails too (the developer closed the Keychain question with Deny).
  var testDenyAllowedRead = false
  func testReload() { guard test else { return }; work.async { [weak self] in self?.load(allowUI: false) } }
  /// The card when an outsourced task ends ("Your other Mac finished: <task>"). The self test records it instead.
  var oCard: (_ title: String, _ sub: String?, _ body: String?) -> Void = { Toast.shared.show(title: $0, sub: $1, body: $2) }
  /// What the main page said it can do (second:hello caps). "outbox": it streams staged files, so a shared file
  /// the other Mac asks for may be big or a folder.
  private var pageCaps: Set<String> = []
  /// Files the developer dragged out to Finder: request id (or the page's req until it names one) to where Finder wants it.
  private let dests = SecondDests()
  private let promiseQ: OperationQueue = { let q = OperationQueue(); q.name = "ps.second.promises"; q.qualityOfService = .userInitiated; return q }()

  /// Native to page (main thread). main.swift sends it to the main window while the vault is open.
  var toPage: (String) -> Void = { _ in }
  /// A native alert after the developer's own click. Test copies replace it (no alert ever shows there).
  var confirm: (_ title: String, _ text: String, _ ok: String, _ done: @escaping (Bool) -> Void) -> Void = Second.alert

  private init() {
    let env = ProcessInfo.processInfo.environment
    if let dir = env["PS_SELFTEST"] {
      places = SecondPlaces(home: FileManager.default.homeDirectoryForCurrentUser.path, root: dir + "/Second", projects: env["PS_SELFTEST_SECOND_PROJECTS"] ?? dir + "/Projects", shared: dir + "/PS Shared")
      if let t = env["PS_SELFTEST_SECOND_TOOLS"] { places.tools = [t] + places.tools }   // a fictional `claude` for the research check
      downloads = dir + "/Downloads/From PS"
    } else {
      places = .live()
      downloads = places.home + "/Downloads/From PS"
    }
    cliDir = places.root + "/cli"
  }

  /// At launch (main.swift). Loads the key off the main thread; reads the role the developer last chose.
  func start() {
    guard !started else { return }
    started = true
    if !test {
      let d = UserDefaults.standard
      // The starting role from the chip (M1 secondary, M4 primary) is the developer's own two Macs (Owner.red): anyone
      // else's Mac starts as neither and they pick (PS 1.65), so no friend's Mac stays awake or runs work by surprise.
      let r = Second.startRole(stored: d.string(forKey: "second.role"), chosen: d.bool(forKey: "second.roleChosen"), chip: Owner.red ? Second.chip() : "")
      role = r.role; roleChosen = r.chosen; chipName = Second.chip()
      if !r.chosen && r.role != "none" { psLog("PS second: no role chosen yet, \(r.role) from this Mac's chip") }
    }
    if test {   // a made up chip and saved choice (the self test plays an M4 and an M1 with a stale saved role)
      let e = ProcessInfo.processInfo.environment
      if let r = e["PS_SELFTEST_SECOND_ROLE"], ["primary", "secondary"].contains(r) { role = r }
      chipName = e["PS_SELFTEST_SECOND_CHIP"] ?? "Apple M4"
      roleChosen = e["PS_SELFTEST_SECOND_CHOSEN"] == "1"
    }
    if test {
      // Never a real assertion or the real power source in a test copy.
      awake.create = { 1 }; awake.release = { _ in }; awake.read = { [weak self] in self?.testPower ?? .init(ac: true, charging: false, battery: nil) }
    }
    awake.onPower = { [weak self] _ in self?.sendStat(force: true) }
    // After sleep this Mac says hello again (the page re-announces it), so the other Mac sees it is back.
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.sendState(wake: true) }
    awake.watch()
    work.async { [weak self] in
      // Right after an update the previous build is still handing over the Second Computer items (UpdateHandoff):
      // read them only once they are saved as this build's own, so no Keychain question ever comes up.
      if UpdateHandoff.pending { UpdateHandoff.waitDone(30) }
      self?.load(allowUI: false)
    }
  }

  /// Reads the device key, id and pairing list (work queue). `allowUI`: the developer clicked Allow, so the Keychain may ask him.
  private func load(allowUI: Bool) {
    let places = self.places, test = self.test
    do {
      let store: SecondStore
      var keychain: SecondKeychain?
      if test { let f = SecondFileStore(dir: places.root + "/keys"); f.failing = keychainDenyForTest(allowUI); store = f }
      else { let k = SecondKeychain(); k.allowUI = allowUI; store = k; keychain = k }
      try? FileManager.default.createDirectory(atPath: places.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let ident = SecondIdentity(store: store, seenPath: places.root + "/seen.json")
      let okeys = SecondKeys(store: store, secure: !test)   // the job key in the Secure Enclave where there is one
      let ojobs = (FileManager.default.contents(atPath: places.root + "/ojobs.json")).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: [String: Any]] } ?? [:]
      let have = (FileManager.default.contents(atPath: places.root + "/have.json")).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
      let idx = (FileManager.default.contents(atPath: places.root + "/idx.json")).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
      // The developer allowed the read: the items an older build saved become this build's own, so the next launch reads them
      // without a question and the next update hands them all over (4 Nov 2026: on the M4 the key, id and pairing
      // list had been saved by a build of 1 Nov, so every update since handed over only 2 of 6 and came up off).
      if allowUI && ident.ready, let k = keychain {
        let (moved, of) = k.reownAllowed()
        if of > 0 { psLog("PS second: \(moved) of \(of) Second Computer items saved as this build's own (one Keychain item)") }
      }
      let (n, m) = test ? (ProcessInfo.processInfo.environment["PS_SELFTEST_SECOND_NAME"] ?? "Test Mac", "TestMac1,1") : (Second.computerName(), Second.hwModel())
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.name = n; self.model = m
        self.allowing = false
        guard ident.ready else {
          if let b = ident.blocked { self.keyBlocked(b, retried: allowUI); return }
          psLog("PS second: no device key (Keychain), Second Computer is off")
          self.offReason = "its Second Computer key could not be saved in the Keychain"
          self.offHere = "PS app could not save its Second Computer key in the Keychain. Click Try again; if it keeps failing, quit PS app and open it again."
          self.offRetried = allowUI
          self.sendState()
          self.answerPending()
          return
        }
        if self.offReason != nil { psLog("PS second: the Second Computer key is readable again (still paired)") }
        if let k = keychain { psLog("PS second: Keychain read once (\(k.source == SecondKeychain.bundle ? "one item" : k.source == "items" ? "one by one, now one item" : k.source))") }
        self.offReason = nil; self.offHere = nil; self.offRetried = false
        self.keyCard(nil)
        self.id = ident; self.have = have; self.idxSent = idx
        if okeys.ready { self.okeys = okeys; self.ojobs = ojobs; psLog("PS second: outsourcing keys ready (\(SecondSeal.xwingHere ? "X-Wing" : "P-256"), job key in \(okeys.signStore))") }
        self.seeks = Second.loadSeeks(places.root)
        self.shares = self.loadShares()
        self.apply(role: self.role)
        let p = self.pending; self.pending = []; p.forEach { $0() }
        self.sendStat(force: true)
        self.publish()   // a shared folder that changed while PS was closed
        psLog("PS second: ready, this Mac is \(self.role)")
      }
    }
  }
  var testPower = SecondAwake.Power(ac: true, charging: false, battery: nil)

  /// The role PS starts in (the developer, 1 Nov 2026: "set the Second Computer role from the chip by default", he has
  /// two Macs). A role the developer picked always wins: primary or secondary as saved, or none once he chose it (V1.23
  /// saved "none" by itself at every launch, so a bare "none" is not a choice). Otherwise an Apple M1 starts as
  /// the secondary (the AFK timer off there, as before) and an Apple M4 as the primary; any other chip stays
  /// "none" and asks. The chip only picks the starting role: trust still needs the signed pairing with the code.
  static func startRole(stored: String?, chosen: Bool, chip: String) -> (role: String, chosen: Bool) {
    if let r = stored, r == "primary" || r == "secondary" { return (r, true) }
    if stored == "none" && chosen { return ("none", true) }
    let c = chip.trimmingCharacters(in: .whitespaces)
    func family(_ f: String) -> Bool { c == f || c.hasPrefix(f + " ") }
    if family("Apple M1") { return ("secondary", false) }
    if family("Apple M4") { return ("primary", false) }
    return ("none", false)
  }
  /// This Mac's chip, eg "Apple M4" (sysctl machdep.cpu.brand_string).
  static func chip() -> String {
    var size = 0
    guard sysctlbyname("machdep.cpu.brand_string", nil, &size, nil, 0) == 0, size > 0 else { return "" }
    var buf = [CChar](repeating: 0, count: size)
    guard sysctlbyname("machdep.cpu.brand_string", &buf, &size, nil, 0) == 0 else { return "" }
    return String(cString: buf)
  }

  /// Is the switch on? The page's answer for "second-computer" (Features.swift). Self test copies keep the rule they were
  /// written for (Owner.red: the developer's account in a test copy), so the self test area "second" runs as before.
  static var switchedOn: Bool { IS_TEST_COPY ? Owner.red : Features.on("second-computer") }

  /// Settings, Second Computer On or Off (PS 1.65, main.swift calls it at launch and on every change of the answer).
  /// On: starts it the first time, or picks up again with the role it had. Off: the running work stops, this Mac may sleep
  /// again, the heartbeat and the CLI folder stop, and nothing goes to or comes from the page until it is on again. The
  /// role, keys and pairing are kept, so On again is exactly where it was. Main thread.
  func setOn(_ on: Bool) {
    if on {
      if !started { off = false; start(); return }
      guard off else { return }
      off = false
      psLog("PS second: switched on")
      if id != nil { apply(role: role) }   // the same role again: runner, heartbeat, CLI folder and stay awake as it says
      sendState(); sendStat(force: true)
      return
    }
    guard started, !off else { return }
    off = true
    psLog("PS second: switched off")
    runner?.stopAll("Second Computer was switched off"); orunner?.stopAll()
    awake.set(secondary: false)
    statTimer?.invalidate(); statTimer = nil
    cliSource?.cancel(); cliSource = nil; cliTimer?.invalidate(); cliTimer = nil
    if !test { try? FileManager.default.removeItem(atPath: cliDir + "/state.json") }   // the CLI then says PS cannot take it
  }

  /// PS is quitting (main thread, applicationWillTerminate): the running job is stopped first.
  func quit() {
    runner?.quit()
    awake.set(secondary: false)
  }

  /// The page says the vault is open or locked (main.swift).
  func setUnlocked(_ on: Bool) {
    guard on != unlocked else { return }
    unlocked = on
    guard started else { return }
    writeCliState()
    if on { sendStat(force: true); publish() }
  }

  // MARK: the bridge

  /// A message from the main window page (main thread).
  func handle(_ type: String, _ msg: [String: Any]) {
    guard started, !off else { return }   // not switched on here (PS 1.65): Second Computer does not exist
    if offReason != nil { handleOff(type, msg); return }
    guard let id else { if pending.count < 50 { pending.append { [weak self] in self?.handle(type, msg) } }; return }
    switch type {
    case "second:allow": sendState()   // already readable
    case "second:hello":
      if let c = msg["caps"] as? [String] { pageCaps = Set(c.prefix(20)) }
      sendState(); postOutbox(); postOJobs()
    case "second:role":
      guard let r = msg["role"] as? String, ["primary", "secondary", "none"].contains(r) else { return }
      if r == "secondary" && role != "secondary" {
        confirm("Let your primary Mac run jobs here?", "Your primary Mac will be able to run the PS app self test, builds, project tests and Claude tasks on this Mac, only from its allowlist and only once you trust it. This Mac stays awake while it is plugged in.", "Allow") { [weak self] yes in
          if yes { self?.apply(role: r, chosen: true) } else { self?.post(["type": "second:cancelled", "req": "role"]) }
          self?.sendState()
        }
      } else { apply(role: r, chosen: true); sendState() }
    case "second:seek": seek(msg, id)
    case "second:autotrust": autoTrust(msg, id)
    case "second:autopair": autoPair(msg, id)
    case "second:pair": pair(msg, id)
    case "second:trustPhone": trustPhone(msg, id)
    case "second:trust": trust(msg, id)
    case "second:unpair":
      guard let d = msg["device"] as? String, let p = id.peer(d) else { sendState(); return }
      let what = p.role == "phone" ? "\(p.name) will no longer be able to restart, shut down or lock this Mac." : "\(p.name) will no longer be able to send jobs or files to this Mac, or take them from it."
      confirm("Unpair \(p.name)?", what, "Unpair") { [weak self] yes in
        if yes { self?.work.async { id.untrust(d); DispatchQueue.main.async { self?.sendState() } } } else { self?.sendState() }
      }
    case "second:sign": sign(msg, id)
    case "second:run": run(msg, id)
    case "second:chunk": chunk(msg, id)
    case "second:seen": seen(msg, id)
    case "second:projects":
      let places = self.places
      work.async { [weak self] in
        let list = SecondJobs.projects(places)
        DispatchQueue.main.async { self?.post(["type": "second:projects", "list": list]) }
      }
    case "second:reveal":   // The developer's click: Downloads/From PS in Finder (never in a test copy)
      guard !test else { return }
      try? FileManager.default.createDirectory(atPath: downloads, withIntermediateDirectories: true)
      NSWorkspace.shared.open(URL(fileURLWithPath: downloads, isDirectory: true))
    case "second:bundle": bundle(msg)
    case "second:window": openWindow((msg["tab"] as? String).flatMap { ["files", "messages", "outsource", "machine"].contains($0) ? $0 : nil })
    case "second:get": get(msg, id)
    case "second:cmd": cmd(msg, id)
    case "second:cli:update": cliUpdate(msg)
    case "second:outbox": postOutbox()
    case "second:read": readOut(msg)
    case "second:outboxDone", "second:outboxDrop":
      guard let oid = msg["id"] as? String, SecondJobs.isId(oid) else { return }
      if type == "second:outboxDrop", let why = msg["why"] as? String { psLog("PS second: a file did not go (\(String(why.prefix(80))))") }
      let places = self.places
      work.async { [weak self] in SecondOutbox.remove(places, oid); DispatchQueue.main.async { self?.postOutbox() } }
    case "second:outboxRetry":
      guard let oid = msg["id"] as? String, SecondJobs.isId(oid) else { return }
      let places = self.places
      work.async { [weak self] in _ = SecondOutbox.retry(places, oid); DispatchQueue.main.async { self?.postOutbox() } }
    case "second:outboxRelease":   // a note was sent: its attachments go now
      let ids = Set(((msg["ids"] as? [String]) ?? []).filter(SecondJobs.isId).prefix(50))
      let places = self.places
      work.async { [weak self] in
        for var m in SecondOutbox.list(places) where ids.contains(m["id"] as? String ?? "") { m["hold"] = nil; SecondOutbox.write(m, places) }
        DispatchQueue.main.async { self?.postOutbox() }
      }
    case "second:landAt": landAt(msg, id)
    case "second:fetching": fetching(msg)
    case "second:pick": if let t = msg["target"] as? [String: Any] { pick(t) }
    case "second:peerHello": peerHello(msg, id)
    case "second:ojob": ojobIn(msg, id)
    case "second:ores": oresIn(msg, id)
    case "second:oacked": oacked(msg, id)
    case "second:outsource":   // the window's Research form (the developer's click): sealed like a chat's
      outsource(rid: nil, ["kind": "research", "title": msg["title"] ?? "", "prompt": msg["prompt"] ?? "", "model": msg["model"] ?? NSNull(), "minutes": msg["minutes"] ?? NSNull()])
    default: break
    }
  }

  /// chosen: the developer picked it (saved, and it then always wins over the chip); false for the role PS started in.
  private func apply(role r: String, chosen: Bool = false) {
    let was = role
    role = r
    if chosen { roleChosen = true }
    if !test && chosen { UserDefaults.standard.set(r, forKey: "second.role"); UserDefaults.standard.set(true, forKey: "second.roleChosen") }
    awake.set(secondary: r == "secondary")
    Afk.shared.roleChanged(r)   // once per change of role: the AFK timer off on the second computer, on on the primary
    if r == "secondary" {
      if runner == nil {
        var e = SecondRunner.Env(places: places, allowProbe: test)
        // A test copy's parent test holds /tmp/ps-selftest.lock; the wait itself is proven in tests/second-test.swift.
        if test { e.lockPath = places.root + "/selftest.lock" }
        let rn = SecondRunner(env: e)
        rn.onStatus = { [weak self] s in DispatchQueue.main.async { self?.status(s) } }
        runner = rn
        let l = SecondLanding(places: places, downloads: downloads)
        l.onHave = { [weak self] p, h in DispatchQueue.main.async { self?.noteHave(p, h) } }
        l.shareDir = { [roots = shares] r, d in SecondShare.landingDir(roots, root: r, dir: d) }
        hookDests(l)
        landing = l
      }
      if orunner == nil {
        let o = SecondOutsourceRunner(places: places)
        o.claudePath = { [places] in places.claude }
        o.onStatus = { [weak self] st in DispatchQueue.main.async { self?.ostatus(st) } }
        orunner = o
      }
    } else if was == "secondary" { runner?.stopAll("Secondary mode was turned off"); orunner?.stopAll() }
    if landing == nil && r == "primary" {   // results and files from the secondary
      let l = SecondLanding(places: places, downloads: downloads)
      l.shareDir = { [roots = shares] r, d in SecondShare.landingDir(roots, root: r, dir: d) }
      hookDests(l)
      landing = l
    }
    // The heartbeat: every 5 minutes (the protocol's rule), and at once on a change.
    statTimer?.invalidate(); statTimer = nil
    if r != "none" {
      let t = Timer(timeInterval: test ? (Double(ProcessInfo.processInfo.environment["PS_SELFTEST_SECOND_STATEVERY"] ?? "") ?? 300) : 300, repeats: true) { [weak self] _ in self?.sendStat(force: true) }
      t.tolerance = test ? 0.5 : 30
      RunLoop.main.add(t, forMode: .common)
      statTimer = t
    }
    startCli()
    watchShares()
    if was != r { psLog("PS second: this Mac is now \(r)"); sendStat(force: true); publish() }
  }

  private func post(_ d: [String: Any]) {
    guard !off, let data = try? JSONSerialization.data(withJSONObject: d), let s = String(data: data, encoding: .utf8) else { return }
    toPage(s)
  }

  static let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
  /// wake: the Mac just woke (the page then announces this Mac again).
  func sendState(wake: Bool = false) {
    if let why = offReason {
      post(["type": "second", "me": NSNull(), "trusted": [], "off": ["why": why, "name": name, "model": model, "chip": chipName, "app": Second.appVersion,
                                                                       "here": offHere ?? why, "retried": offRetried, "allowing": allowing]])
      return
    }
    guard let id else { return }
    writeCliState()   // the trusted list may have changed (pair, trust, unpair)
    if okeys?.rotateIfDue() == true { psLog("PS second: new outsourcing keys (weekly)") }
    var me: [String: Any] = ["device": id.device, "name": name, "model": model, "pub": id.pub, "role": role, "chip": chipName, "chosen": roleChosen, "app": Second.appVersion]
    if let k = okeys?.pub?.kid { me["okid"] = k }
    var m: [String: Any] = ["type": "second", "me": me, "trusted": id.peers.map { $0.json }, "seeks": Array(freshSeeks().keys),
                            "caps": okeys == nil ? Second.caps.filter { $0 != "outsource" } : Second.caps]
    if wake { m["wake"] = true }
    post(m)
  }

  private func nowMs() -> Double { (Date().timeIntervalSince1970 * 1000).rounded() }
  private func base(_ t: String, to: String) -> [String: Any] { ["v": 1, "t": t, "id": UUID().uuidString.lowercased(), "from": id?.device ?? "", "to": to, "at": nowMs()] }

  /// Signs off the main thread, then answers on main.
  private func signed(_ body: [String: Any], req: String, extra: [String: Any] = [:], type: String = "second:signed") {
    guard let id else { return }
    work.async { [weak self] in
      guard let env = id.sign(body) else { return }
      var m: [String: Any] = ["type": type, "env": env.json]
      if type == "second:signed" { m["req"] = req }
      for (k, v) in extra { m[k] = v }
      DispatchQueue.main.async { self?.post(m) }
    }
  }

  // MARK: one click pairing (V1.26)
  // The developer, 1 Nov 2026: "I just click pair, it scans to see if my M1 is online and connects for me." The main Mac
  // signs a "looking for my other Mac" record (seek) into the vault. Any other Mac of the developer's with PS running and
  // signed in answers it by itself: it becomes the second Mac if it was not, trusts the main Mac's key from that
  // record and signs its answer (pairok, naming the seek). The main Mac then checks that answer against its own
  // seek and trusts that Mac. Only someone holding the developer's vault key can put either record there, and each is
  // signed by its Mac's own key, so no code and no Trust click: the second Mac shows one notice, nothing to do.

  static func loadSeeks(_ root: String) -> [String: Double] {
    (FileManager.default.contents(atPath: root + "/seeks.json")).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Double] } ?? [:]
  }
  private func saveSeeks() {
    seeks = freshSeeks()
    if let d = try? JSONSerialization.data(withJSONObject: seeks) { Second.atomicWrite(d, places.root + "/seeks.json") }
  }
  private func freshSeeks() -> [String: Double] { let cut = nowMs() - 86_400_000; return seeks.filter { $0.value > cut } }

  /// The developer clicked Pair on this Mac: it is the main Mac from now on, and it looks for the other one.
  private func seek(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let req = msg["req"] as? String, req.count <= 80 else { return }
    if role != "primary" { apply(role: "primary", chosen: true) }
    var b = base("seek", to: "all")
    b["primary"] = id.device; b["primaryPub"] = id.pub; b["names"] = ["p": name]
    seeks[b["id"] as? String ?? ""] = b["at"] as? Double ?? nowMs()
    saveSeeks()
    signed(b, req: req)
    sendState()
    psLog("PS second: looking for your other Mac (Pair clicked)")
  }

  /// The second Mac's half: a seek from the developer's main Mac, answered without a question.
  private func autoTrust(_ msg: [String: Any], _ id: SecondIdentity) {
    func no(_ why: String) { psLog("PS second: did not answer a Pair from another Mac (\(why))"); post(["type": "second:cancelled", "req": "pairok:auto", "why": why]) }
    guard let env = SecondEnv(msg["env"]), env.by != id.device,
          let peek = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any], peek["t"] as? String == "seek", let ppub = peek["primaryPub"] as? String else { no("Bad arguments"); return }
    guard freshSeeks().isEmpty else { no("this Mac is looking for its other Mac itself"); return }
    work.async { [weak self] in
      guard let self else { return }
      let r = id.open(env, expect: ["seek"], pub: ppub)
      DispatchQueue.main.async {
        guard case .success(let b) = r else { if case .failure(let w) = r { no(w.why) }; return }
        guard b["primary"] as? String == env.by, b["primaryPub"] as? String == ppub, id.peer(env.by)?.role != "phone",
              ((b["at"] as? NSNumber)?.doubleValue ?? 0) > self.nowMs() - 86_400_000 else { no("Not signed by your primary"); return }
        let pname = String((((b["names"] as? [String: Any])?["p"] as? String) ?? "your main Mac").prefix(60))
        if self.role != "secondary" { self.apply(role: "secondary", chosen: true) }
        self.work.async {
          id.trust(SecondPeer(device: env.by, name: pname, pub: ppub, role: "primary", at: self.nowMs()))
          DispatchQueue.main.async {
            var ok = self.base("pairok", to: env.by)
            ok["primary"] = env.by; ok["primaryPub"] = ppub; ok["secondary"] = id.device; ok["secondaryPub"] = id.pub
            ok["names"] = ["p": pname, "s": self.name]; ok["seek"] = b["id"] ?? ""; ok["auto"] = true
            self.signed(ok, req: "pairok:auto")
            self.sendState()
            psLog("PS second: paired with the main Mac by itself (Pair was clicked there)")
            self.notice("Paired with \(pname)", "This Mac is now your second Mac. \(pname) can send it files, notes and work.")
          }
        }
      }
    }
  }

  /// The main Mac's half: the other Mac's answer to one of this Mac's own seeks.
  private func autoPair(_ msg: [String: Any], _ id: SecondIdentity) {
    func no(_ why: String) { psLog("PS second: an answer to Pair did not check out (\(why))") }
    guard role == "primary", let env = SecondEnv(msg["env"]), env.by != id.device,
          let peek = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any], peek["t"] as? String == "pairok", let spub = peek["secondaryPub"] as? String else { no("Bad arguments"); return }
    work.async { [weak self] in
      guard let self else { return }
      let r = id.open(env, expect: ["pairok"], pub: spub)
      DispatchQueue.main.async {
        guard case .success(let b) = r else { if case .failure(let w) = r { no(w.why) }; return }
        guard b["primary"] as? String == id.device, b["primaryPub"] as? String == id.pub, b["secondary"] as? String == env.by,
              let sk = b["seek"] as? String, self.freshSeeks()[sk] != nil, id.peer(env.by)?.role != "phone" else { no("not an answer to this Mac's Pair"); return }
        let sname = String((((b["names"] as? [String: Any])?["s"] as? String) ?? "your second Mac").prefix(60))
        self.work.async {
          id.trust(SecondPeer(device: env.by, name: sname, pub: spub, role: "secondary", at: self.nowMs()))
          DispatchQueue.main.async {
            self.seeks[sk] = nil; self.saveSeeks()
            self.sendState()
            psLog("PS second: paired with the other Mac (one click)")
          }
        }
      }
    }
  }

  // MARK: pairing with the code (V1.25 and before; still answered for an older Mac)

  private func pair(_ msg: [String: Any], _ id: SecondIdentity) {
    guard role == "primary", let p = msg["peer"] as? [String: Any], let dev = p["device"] as? String, !dev.isEmpty, dev.count <= 64, dev != id.device, id.peer(dev)?.role != "phone",
          let pub = p["pub"] as? String, Data(base64Encoded: pub).flatMap({ try? P256.Signing.PublicKey(x963Representation: $0) }) != nil else {
      post(["type": "second:cancelled", "req": "pair"]); return
    }
    let peerName = String(((p["name"] as? String) ?? "your other Mac").prefix(60))
    let code = SecondIdentity.pairCode(primaryPub: id.pub, secondaryPub: pub)
    confirm("Pair with \(peerName)?", "Check that \(peerName) shows the same code:\n\n\(code)\n\nOnly pair if the codes match. \(peerName) can then run jobs this Mac sends it.", "Pair") { [weak self] yes in
      guard let self else { return }
      guard yes else { self.post(["type": "second:cancelled", "req": "pair"]); return }
      self.work.async {
        id.trust(SecondPeer(device: dev, name: peerName, pub: pub, role: "secondary", at: self.nowMs()))
        DispatchQueue.main.async {
          var b = self.base("pair", to: dev)
          b["primary"] = id.device; b["primaryPub"] = id.pub; b["secondary"] = dev; b["secondaryPub"] = pub; b["names"] = ["p": self.name, "s": peerName]
          self.signed(b, req: "pair")
          self.sendState()
        }
      }
    }
  }

  private func trust(_ msg: [String: Any], _ id: SecondIdentity) {
    guard role == "secondary", let env = SecondEnv(msg["env"]),
          let peek = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any], let ppub = peek["primaryPub"] as? String else {
      post(["type": "second:cancelled", "req": "pairok"]); return
    }
    work.async { [weak self] in
      guard let self else { return }
      let r = id.open(env, expect: ["pair"], pub: ppub)
      DispatchQueue.main.async {
        guard case .success(let b) = r, b["secondary"] as? String == id.device, b["secondaryPub"] as? String == id.pub,
              let pdev = b["primary"] as? String, pdev == env.by, id.peer(pdev)?.role != "phone" else {   // a phone never pairs
          psLog("PS second: a pairing request did not check out"); self.post(["type": "second:cancelled", "req": "pairok"]); return
        }
        let pname = String((((b["names"] as? [String: Any])?["p"] as? String) ?? "your primary Mac").prefix(60))
        let code = SecondIdentity.pairCode(primaryPub: ppub, secondaryPub: id.pub)
        self.confirm("Trust \(pname)?", "Check that \(pname) shows the same code:\n\n\(code)\n\nOnly trust it if the codes match. \(pname) can then run allowlisted jobs on this Mac.", "Trust") { yes in
          guard yes else { self.post(["type": "second:cancelled", "req": "pairok"]); return }
          self.work.async {
            id.trust(SecondPeer(device: pdev, name: pname, pub: ppub, role: "primary", at: self.nowMs()))
            DispatchQueue.main.async {
              var ok = self.base("pairok", to: pdev)
              ok["primary"] = pdev; ok["primaryPub"] = ppub; ok["secondary"] = id.device; ok["secondaryPub"] = id.pub; ok["names"] = ["p": pname, "s": self.name]
              self.signed(ok, req: "pairok")
              self.sendState()
            }
          }
        }
      }
    }
  }

  /// The developer's phone (protocol section 13): after the same six digit code on both, it may restart, shut down and lock
  /// this Mac and nothing else (SecondIdentity.open refuses a phone key for anything but a cmd).
  private func trustPhone(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let dev = msg["device"] as? String, !dev.isEmpty, dev.count <= 64, dev != id.device,
          let pub = msg["pub"] as? String, Data(base64Encoded: pub).flatMap({ try? P256.Signing.PublicKey(x963Representation: $0) }) != nil,
          id.peer(dev).map({ $0.role == "phone" }) ?? true else {
      post(["type": "second:cancelled", "req": "trustPhone"]); return
    }
    let phoneName = String(((msg["name"] as? String) ?? "your phone").prefix(60))
    let code = SecondIdentity.pairCode(primaryPub: id.pub, secondaryPub: pub)
    confirm("Trust this phone to restart, shut down and lock this Mac?", "Check that \(phoneName) shows the same code:\n\n\(code)\n\nOnly trust it if the codes match. The phone can do nothing else on this Mac.", "Trust") { [weak self] yes in
      guard let self else { return }
      guard yes else { self.post(["type": "second:cancelled", "req": "trustPhone"]); return }
      self.work.async {
        id.trust(SecondPeer(device: dev, name: phoneName, pub: pub, role: "phone", at: self.nowMs()))
        DispatchQueue.main.async { psLog("PS second: a phone is trusted for restart, shut down and lock"); self.sendState() }
      }
    }
  }

  // MARK: signing for the page

  private func sign(_ msg: [String: Any], _ id: SecondIdentity) {
    // The body as an object, or as JSON text (pages before 1 Nov 2026 sent text, and this used to drop it without a
    // word: no hello, note, file or job they signed ever reached the other Mac). Anything else is refused out loud.
    let raw = msg["body"]
    let parsed = raw as? [String: Any] ?? (raw as? String).flatMap { $0.count <= 64_000 ? (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] : nil }
    guard let req = msg["req"] as? String, req.count <= 80 else { return }
    guard var b = parsed, let t = b["t"] as? String else { psLog("PS second: did not sign a record (Bad arguments)"); post(["type": "second:cancelled", "req": req, "why": "Bad arguments"]); return }
    var allowed: Set<String> = ["msg", "file", "ack", "dev", "stat", "get"]
    if role == "primary" { allowed.formUnion(["job", "cmd"]) }
    guard allowed.contains(t) else { post(["type": "second:cancelled", "req": req, "why": "not signed: \(t)"]); return }
    b["v"] = 1; b["from"] = id.device
    if (b["at"] as? NSNumber) == nil { b["at"] = nowMs() }
    if (b["id"] as? String).map(t == "job" ? SecondJobs.isUUID : SecondJobs.isId) != true { b["id"] = UUID().uuidString.lowercased() }
    if t == "dev" { b["pub"] = id.pub; b["role"] = role; b["to"] = "all"; b["chip"] = String(chipName.prefix(40)); b["app"] = Second.appVersion; b["ncaps"] = ["stream", "pack"]; if let k = okeys?.pub { b["okeys"] = k.json } }
    if t == "job" {
      // Only to a trusted secondary, and only a job this Mac's own runner would accept.
      b["exp"] = ((b["at"] as? NSNumber)?.doubleValue ?? nowMs()) + 86_400_000
      guard let to = b["to"] as? String, id.peer(to)?.role == "secondary" else { post(["type": "second:cancelled", "req": req, "why": "Not paired"]); return }
      if case .failure(let w) = SecondJobs.parse(b, allowProbe: test) { post(["type": "second:cancelled", "req": req, "why": w.why]); return }
    }
    if t == "msg", let text = b["text"] as? String { b["text"] = String(text.prefix(4000)) }
    if t == "cmd" {
      guard let to = b["to"] as? String, id.peer(to) != nil, let a = b["action"] as? String, SecondIdentity.cmdAction(a) else {
        post(["type": "second:cancelled", "req": req, "why": "Bad arguments"]); return
      }
      b["exp"] = ((b["at"] as? NSNumber)?.doubleValue ?? nowMs()) + 120_000
    }
    if t == "get" { guard let to = b["to"] as? String, id.peer(to) != nil, SecondShare.check(b, roots: [.init(id: (b["root"] as? String) ?? "", name: "", path: "/")]) != nil else {
      post(["type": "second:cancelled", "req": req, "why": "Bad arguments"]); return
    } }
    signed(b, req: req)
  }

  // MARK: jobs (the secondary)

  private func run(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]) else { return }
    guard role == "secondary", let runner else { refuse(env, "Not set as a secondary"); return }
    let places = self.places
    work.async { [weak self] in
      let r = id.open(env, expect: ["job"])
      DispatchQueue.main.async {
        guard let self else { return }
        switch r {
        case .failure(let why): self.refuse(env, why.why)
        case .success(let b):
          guard id.peer(env.by)?.role == "primary" else { self.refuse(env, "Not signed by your primary"); return }
          let jid = b["id"] as? String ?? ""
          self.jobFrom[jid] = env.by
          self.work.async {
            // Every bundle the job names must already be in this Mac's mirrors.
            let missing = (b["bundles"] as? [[String: Any]] ?? []).contains { x in
              guard let p = x["project"] as? String, let h = x["head"] as? String, SecondJobs.isProject(p), SecondJobs.isSha(h) else { return true }
              return SecondGit.run(places.git, ["--git-dir=" + places.mirror(p), "cat-file", "-e", h + "^{commit}"]).0 != 0
            }
            DispatchQueue.main.async {
              if missing { self.status(.init(job: jid, state: "refused", reason: "Code bundle missing", endedAt: Date())); return }
              runner.submit(b)
            }
          }
        }
      }
    }
  }

  private func refuse(_ env: SecondEnv, _ why: String) {
    let b = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any]
    let jid = (b?["id"] as? String).map { String($0.prefix(64)) } ?? ""
    jobFrom[jid] = (b?["from"] as? String) ?? env.by
    psLog("PS second: refused a job (\(why))")
    status(.init(job: jid, state: "refused", reason: why, endedAt: Date()))
  }

  /// A runner status: signed and sent at once when its state changes, the running tail at most every 15 s.
  private func status(_ s: SecondRunner.Status) {
    let final = ["done", "failed", "cancelled", "timeout", "refused"].contains(s.state)
    let last = lastSent[s.job]
    if !final, let last, last.0 == s.state, Date().timeIntervalSince(last.1) < 15 { scheduleTail(); return }
    if s.state == "running" && last?.0 != "running" { sendStat(force: true); startWatch() }   // a job started
    sendJobst(s, final: final)
    if final { lastSent[s.job] = nil; jobFrom[s.job] = nil; sendStat(force: true); stopWatch() } else { lastSent[s.job] = (s.state, Date()) }
  }

  /// While a job runs: one look every 15 s, sending the newest tail only if something changed.
  private func scheduleTail() {
    guard tailTimer == nil else { return }
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + 15, repeating: 15, leeway: .seconds(2))
    t.setEventHandler { [weak self] in
      guard let self, let r = self.runner, let s = r.runningStatus, s.state == "running" else { self?.tailTimer?.cancel(); self?.tailTimer = nil; return }
      if Date().timeIntervalSince(self.lastSent[s.job]?.1 ?? .distantPast) >= 14 { self.sendJobst(s, final: false); self.lastSent[s.job] = (s.state, Date()) }
    }
    t.resume()
    tailTimer = t
  }

  private func sendJobst(_ s: SecondRunner.Status, final: Bool) {
    guard let id else { return }
    let to = jobFrom[s.job] ?? id.peers.first { $0.role == "primary" }?.device ?? "all"
    var b = base("jobst", to: to)
    b["job"] = s.job; b["state"] = s.state
    if let r = s.reason { b["reason"] = r }
    if let d = s.startedAt { b["startedAt"] = (d.timeIntervalSince1970 * 1000).rounded() }
    if let d = s.endedAt { b["endedAt"] = (d.timeIntervalSince1970 * 1000).rounded() }
    if let e = s.exit { b["exit"] = Int(e) }
    if let st = s.step { b["step"] = st }
    if let x = s.summary { b["summary"] = x }
    if let f = s.files { b["files"] = Array(f.prefix(500)) }
    let runner = self.runner
    work.async { [weak self] in
      guard let self else { return }
      if let (jid, tail) = runner?.runningTail(final ? 48 * 1024 : 4096), jid == s.job { b["tail"] = tail }
      else { b["tail"] = (try? String(contentsOfFile: self.places.logs + "/" + s.job + ".log", encoding: .utf8)).map { String(decoding: Array($0.utf8.suffix(48 * 1024)), as: UTF8.self) } ?? "" }
      // A result file (Claude's patch, the zipped app) goes up first, under an id chosen here.
      if final, let r = s.result, let data = FileManager.default.contents(atPath: r.path), data.count <= SecondLanding.maxFile {
        let fid = UUID().uuidString.lowercased()
        b["result"] = fid
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let up: [String: Any] = ["type": "second:upload", "file": fid, "purpose": "result", "job": s.job, "to": to, "name": r.name, "mime": r.mime,
                                 "size": data.count, "sha256": sha, "b64": data.base64EncodedString()]
        try? FileManager.default.removeItem(atPath: r.path)
        DispatchQueue.main.async { self.post(up) }
      }
      guard let env = self.id?.sign(b) else { return }
      DispatchQueue.main.async { self.post(["type": "second:jobst", "env": env.json]) }
    }
  }

  // MARK: files

  private func chunk(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]), let i = (msg["i"] as? NSNumber)?.intValue, let n = (msg["n"] as? NSNumber)?.intValue,
          let b64 = msg["b64"] as? String, let data = Data(base64Encoded: b64), let landing else { return }
    let downloads = self.downloads
    // v1.2: a page that streams names each chunk (req) and waits for second:chunkOk before it deletes that chunk
    // from the vault. Older pages send them all and wait only for the ack.
    let req = (msg["req"] as? String).flatMap { $0.count <= 120 ? $0 : nil }
    work.async { [weak self] in
      // The first chunk is checked in full (and remembered); later ones carry the same signed body. A landing
      // picked up after a restart checks it in full again, without remembering it twice.
      let r = id.open(env, expect: ["file"], remember: i == 0)
      guard case .success(let b) = r else {
        if case .failure(let w) = r, i == 0 { DispatchQueue.main.async { self?.ack(env, ref: (try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any])?["id"] as? String ?? "", ok: false, reason: w.why, path: nil) } }
        if let req { DispatchQueue.main.async { self?.post(["type": "second:chunkOk", "req": req, "error": "Not verified"]) } }
        return
      }
      guard let done = landing.chunk(b, i: i, n: n, data: data) else {
        if let req { DispatchQueue.main.async { self?.post(["type": "second:chunkOk", "req": req, "i": i]) } }
        return
      }
      DispatchQueue.main.async {
        guard let self else { return }
        if let req, !done.ok || i < n - 1 { self.post(["type": "second:chunkOk", "req": req, "error": done.reason ?? "Refused"]) }
        self.ack(env, ref: done.ref, ok: done.ok, reason: done.reason, path: done.path.map { $0.hasPrefix(downloads) ? "Downloads/From PS/" + ($0 as NSString).lastPathComponent : $0 })
        if let g = done.get, self.dests.finish(g, done.ok ? nil : SecondDragOut.err(done.reason ?? "Did not arrive")) {
          psLog(done.ok ? "PS second: a file dragged out of the window landed where it was dropped" : "PS second: a file dragged out of the window did not arrive")
          return
        }
        if done.ok && done.purpose != "bundle" {
          let from = id.peer(env.by)?.name ?? "your other Mac"
          let inDownloads = done.path?.hasPrefix(downloads) ?? true
          Toast.shared.show(title: "\(from) sent you a file", sub: done.name, body: inDownloads ? "In Downloads, From PS" : "In your shared folder")
          psLog(inDownloads ? "PS second: a file landed in Downloads/From PS" : "PS second: a file landed in a shared folder")
        }
      }
    }
  }

  private func ack(_ env: SecondEnv, ref: String, ok: Bool, reason: String?, path: String?) {
    var b = base("ack", to: env.by)
    b["ref"] = ref; b["ok"] = ok
    if let reason { b["reason"] = reason }
    if let path { b["path"] = path }
    signed(b, req: "ack:" + ref)
  }

  private func noteHave(_ project: String, _ head: String) {
    have[project] = head
    let h = have, path = places.root + "/have.json"
    work.async { if let d = try? JSONSerialization.data(withJSONObject: h) { try? d.write(to: URL(fileURLWithPath: path), options: .atomic) } }
    sendStat(force: true)
  }

  // MARK: the heartbeat

  private var lastStatKey = ""
  /// A stat when something changed (or the 5 minute beat): power, busy, queue, have.
  func sendStat(force: Bool) {
    guard let id, role != "none", unlocked || test else { return }
    var b = base("stat", to: "all")
    for (k, v) in SecondStat.sample(home: places.home, power: awake.power) { b[k] = v }
    b["busy"] = runner?.currentJob ?? NSNull()
    b["queue"] = runner?.queued ?? 0
    b["have"] = have
    b["app"] = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    if let m = machine?() { b["machine"] = m }
    let key = "\(b["power"]!) \(b["busy"]!) \(b["queue"]!) \(have) \(b["machine"].map { "\($0)" } ?? "")"
    guard force || key != lastStatKey else { return }
    lastStatKey = key
    work.async { [weak self] in
      guard let env = id.sign(b) else { return }
      DispatchQueue.main.async { self?.post(["type": "second:stat", "env": env.json]) }
    }
  }

  /// The primary's page hands over a stat it heard from the secondary (for the CLI's state.json).
  private func seen(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]) else { return }
    work.async { [weak self] in
      guard case .success(let b) = id.open(env, expect: ["stat"], remember: false), id.peer(env.by)?.role == "secondary" else { return }
      DispatchQueue.main.async { self?.peerStat = b; self?.peerStatAt = Date(); self?.writeCliState() }
    }
  }

  // MARK: never a window or focus from a job

  /// While a job runs: every 5 s, does a process of the job own a window on screen, or did one come to
  /// the front? Only owner pids are compared (no window names are read). Focus goes back to the app
  /// that had it, never to 1Password or Signal.
  private func startWatch() {
    guard watchTimer == nil, let runner else { return }
    frontBefore = NSWorkspace.shared.frontmostApplication
    let t = DispatchSource.makeTimerSource(queue: work)
    t.schedule(deadline: .now() + 5, repeating: 5, leeway: .seconds(1))
    t.setEventHandler { [weak self] in
      let pids = Set(runner.pids)
      guard !pids.isEmpty else { return }
      let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
      let shown = list.contains { w in
        guard let pid = w[kCGWindowOwnerPID as String] as? Int32, pids.contains(pid), (w[kCGWindowLayer as String] as? Int) == 0,
              (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.01, let b = w[kCGWindowBounds as String] as? [String: Double] else { return false }
        let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
        return r.width > 2 && r.height > 2 && NSScreen.screens.contains { $0.frame.intersects(r) }
      }
      if shown { psLog("PS second: a window from a job showed on screen") }
      DispatchQueue.main.async {
        guard let self, let front = NSWorkspace.shared.frontmostApplication else { return }
        if pids.contains(front.processIdentifier) {
          psLog("PS second: a job took the focus, handing it back")
          if let b = self.frontBefore, !Protected.matches(b), !b.isTerminated { b.activate() }
        } else if !Protected.matches(front) { self.frontBefore = front }
      }
    }
    t.resume()
    watchTimer = t
  }
  private func stopWatch() { watchTimer?.cancel(); watchTimer = nil; tailTimer?.cancel(); tailTimer = nil }

  /// One plain line for the "PS is active" pop-up (main thread, no I/O): what this Mac is and how its partner is.
  var statusLine: String {
    guard started, unlocked else { return "" }
    switch role {
    case "secondary": return "This Mac is the second computer"
    case "primary":
      guard let p = id?.peers.first(where: { $0.role == "secondary" }) else { return "Not paired yet" }
      guard let at = (peerStat?["at"] as? NSNumber)?.doubleValue else { return "\(p.name), not seen yet" }
      let seen = Date(timeIntervalSince1970: at / 1000)
      if Date().timeIntervalSince(seen) < 7 * 60 { return "\(p.name), online" }
      let f = DateFormatter()
      f.dateFormat = Calendar.current.isDateInToday(seen) ? "HH:mm" : "d MMM HH:mm"
      return "\(p.name), offline since \(f.string(from: seen))"
    default: return "Not set up"
    }
  }

  /// The reboot session's AutoReboot changed (timer, helper, lock): a fresh stat.
  func machineChanged() { if started { sendStat(force: false) } }

  // MARK: shared folders (protocol section 15)

  /// This Mac's shared roots: its own setting, else ~/PS Shared (made on first run).
  private func loadShares() -> [SecondShare.Root] {
    var list: [SecondShare.Root] = []
    if !test, let a = UserDefaults.standard.array(forKey: "second.shares") as? [[String: String]] {
      list = a.compactMap { d in
        guard let i = d["id"], SecondShare.rootIdOk(i), let p = d["path"], p.hasPrefix("/") else { return nil }
        return .init(id: i, name: d["name"] ?? (p as NSString).lastPathComponent, path: p)
      }
    }
    if list.isEmpty {
      try? FileManager.default.createDirectory(atPath: places.outsource, withIntermediateDirectories: true)
      list = [.init(id: "ps-shared", name: "PS Shared", path: places.shared)]
    }
    return list
  }

  private func watchShares() {
    guard role != "none" else { shareWatch?.stop(); shareWatch = nil; return }
    guard shareWatch == nil else { return }
    let quiet = test ? (Double(ProcessInfo.processInfo.environment["PS_SELFTEST_SECOND_QUIET"] ?? "") ?? 10) : 10
    let w = SecondShareWatch(queue: work, quiet: quiet)
    w.onChange = { [weak self] in DispatchQueue.main.async { self?.publish() } }
    w.watch(shares.map { $0.path })
    shareWatch = w
  }

  /// Sends each root's signed index, only when its listing differs from the one sent last.
  func publish() {
    guard let id, role != "none", unlocked || test else { return }
    let roots = shares, sent = idxSent, path = places.root + "/idx.json"
    work.async { [weak self] in
      guard let self else { return }
      var changed = sent
      for r in roots {
        let entries = SecondShare.index(r)
        let data = (try? JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys])) ?? Data()
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard sent[r.id] != hash else { continue }
        var b: [String: Any] = ["v": 1, "t": "idx", "id": UUID().uuidString.lowercased(), "from": id.device, "to": "all", "at": (Date().timeIntervalSince1970 * 1000).rounded()]
        b["root"] = r.id; b["name"] = r.name; b["entries"] = entries
        guard let env = id.sign(b) else { continue }
        changed[r.id] = hash
        DispatchQueue.main.async { self.post(["type": "second:idx", "env": env.json]) }
      }
      if changed != sent {
        if let d = try? JSONSerialization.data(withJSONObject: changed) { try? d.write(to: URL(fileURLWithPath: path), options: .atomic) }
        DispatchQueue.main.async { self.idxSent = changed }
      }
    }
  }

  /// A signed request for a file in one of THIS Mac's shared folders.
  private func get(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]) else { return }
    let roots = shares, streams = pageCaps.contains("outbox"), places = self.places
    work.async { [weak self] in
      guard let self else { return }
      let r = id.open(env, expect: ["get"])
      var reason: String?, up: [String: Any]?
      switch r {
      case .failure(let w): reason = w.why
      case .success(let b):
        if let (root, path) = SecondShare.check(b, roots: roots) {
          switch SecondShare.file(root, path, max: streams ? SecondLanding.maxStream : SecondLanding.maxFile, folders: streams) {
          case .failure(let w): reason = w.why
          case .success(let p) where streams:
            // v1.2: staged in the outbox (a folder packed), then streamed by the page like a dropped file.
            let st = SecondOutbox.stage([URL(fileURLWithPath: p)], target: ["kind": "get", "get": b["id"] ?? "", "to": env.by], places: places)
            if st.items.isEmpty { reason = st.problems.first ?? "Could not read it" }
            else { up = ["type": "second:outbox", "list": SecondOutbox.list(places)] }
          case .success(let p):
            if let data = FileManager.default.contents(atPath: p) {
              let name = (p as NSString).lastPathComponent
              up = ["type": "second:upload", "file": UUID().uuidString.lowercased(), "purpose": "share", "get": b["id"] ?? "", "to": env.by, "name": name,
                    "mime": UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream",
                    "size": data.count, "sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), "b64": data.base64EncodedString()]
            } else { reason = "No such file" }
          }
        } else { reason = "Bad arguments" }
      }
      let ref = (try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any])?["id"] as? String ?? ""
      DispatchQueue.main.async {
        if let up { self.post(up); psLog("PS second: served a shared file") }
        else { psLog("PS second: refused a shared file request (\(reason ?? "?"))"); self.ack(env, ref: ref, ok: false, reason: reason, path: nil) }
      }
    }
  }

  // MARK: machine commands (protocol section 13)

  /// Lock, restart, shut down or cancel, signed by a trusted primary (or an enrolled phone), good for 2 minutes.
  private func cmd(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]) else { return }
    work.async { [weak self] in
      guard let self else { return }
      let r = id.open(env, expect: ["cmd"])
      DispatchQueue.main.async {
        let ref = (try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any])?["id"] as? String ?? ""
        guard case .success(let b) = r else { if case .failure(let w) = r { self.ack(env, ref: ref, ok: false, reason: w.why, path: nil) }; return }
        let signer = id.peer(env.by)
        if let why = SecondIdentity.checkCmd(b, signerRole: signer?.role) { self.ack(env, ref: ref, ok: false, reason: why, path: nil); return }
        guard let signer, let a = b["action"] as? String, let at = (b["at"] as? NSNumber)?.doubleValue else { return }
        guard let run = self.cmdRunner else { self.ack(env, ref: ref, ok: false, reason: "Not set up on this Mac", path: nil); return }
        psLog("PS second: a \(a) command from \(signer.role == "phone" ? "the phone" : "the primary")")
        run(a, ref, signer.name, at) { ok, why in self.ack(env, ref: ref, ok: ok, reason: why, path: nil) }
      }
    }
  }

  // MARK: git bundles (the primary)

  private func bundle(_ msg: [String: Any]) {
    guard let req = msg["req"] as? String, SecondJobs.isId(req), let project = msg["project"] as? String, SecondJobs.isProject(project) else { return }
    let base = (msg["base"] as? String).flatMap { SecondJobs.isSha($0) ? $0 : nil }
    let places = self.places
    work.async { [weak self] in
      guard let repo = SecondJobs.projects(places).first(where: { $0["name"] == project })?["path"] else {
        DispatchQueue.main.async { self?.post(["type": "second:bundled", "req": req, "error": "No such project in ~/Projects"]) }; return
      }
      let r = SecondGit.make(repo: repo, base: base, req: req, git: places.git)
      var m: [String: Any] = ["type": "second:bundled", "req": req, "project": project]
      switch r {
      case .success(let b):
        m["head"] = b.head; m["dirty"] = b.dirty; m["files"] = b.files; m["b64"] = b.data.base64EncodedString()
        if let x = b.base { m["base"] = x }
      case .failure(let w): m["error"] = w.why
      }
      DispatchQueue.main.async { self?.post(m) }
    }
  }

  // MARK: the CLI folder (the primary; protocol section 11)

  private func startCli() {
    guard role == "primary" else { cliSource?.cancel(); cliSource = nil; cliTimer?.invalidate(); cliTimer = nil; writeCliState(); return }
    guard cliSource == nil else { return }
    try? FileManager.default.createDirectory(atPath: cliDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    chmod(cliDir, 0o700)
    let fd = open(cliDir, O_EVTONLY)
    if fd >= 0 {
      let s = DispatchSource.makeFileSystemObjectSource(fileDescriptor: fd, eventMask: .write, queue: work)
      s.setEventHandler { [weak self] in self?.readRequests() }
      s.setCancelHandler { close(fd) }
      s.resume()
      cliSource = s
    }
    // state.json stays fresh (the CLI falls back when it is over 2 minutes old).
    let t = Timer(timeInterval: 60, repeats: true) { [weak self] _ in self?.writeCliState() }
    t.tolerance = 5
    RunLoop.main.add(t, forMode: .common)
    cliTimer = t
    writeCliState()
    work.async { [weak self] in self?.readRequests() }
  }

  private func writeCliState() {
    guard role == "primary" || FileManager.default.fileExists(atPath: cliDir) else { return }
    var sec: Any = NSNull()
    if let p = id?.peers.first(where: { $0.role == "secondary" }) {
      let s = peerStat ?? [:]
      let at = (s["at"] as? NSNumber)?.doubleValue
      let online = at.map { Date().timeIntervalSince1970 * 1000 - $0 < 7 * 60_000 } ?? false
      let pk = okeys?.peer(p.device)
      sec = ["device": p.device, "name": p.name, "online": online, "lastSeen": at.map { $0 as Any } ?? NSNull(), "have": s["have"] ?? [:], "busy": s["busy"] ?? NSNull(),
             "outsource": pk != nil, "suite": pk?.xwing != nil && SecondSeal.xwingHere ? "xwing" : "p256"]
    }
    let st: [String: Any] = ["ps": true, "unlocked": unlocked, "role": role, "secondary": sec, "at": nowMs()]
    let path = cliDir + "/state.json"
    work.async { if let d = try? JSONSerialization.data(withJSONObject: st) { Second.atomicWrite(d, path) } }
  }

  /// req-<id>.json from scripts/second.ts: read, removed, handed to the page with its bundles.
  private func readRequests() {
    let fm = FileManager.default
    for f in ((try? fm.contentsOfDirectory(atPath: cliDir)) ?? []).sorted() where f.hasPrefix("req-") && f.hasSuffix(".json") {
      let path = cliDir + "/" + f
      let data = fm.contents(atPath: path)
      try? fm.removeItem(atPath: path)
      guard let data, data.count < 1 << 20, let r = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let rid = r["id"] as? String, SecondJobs.isId(rid), let type = r["type"] as? String else { continue }
      if type == "outsource" || type == "ocancel" {   // sealed here, never through the page in the clear
        let a = r["args"] as? [String: Any] ?? [:]
        DispatchQueue.main.async { [weak self] in
          if type == "ocancel" { self?.outsource(rid: rid, ["kind": "cancel", "job": a["job"] ?? ""]) }
          else { self?.outsource(rid: rid, ["kind": "research", "title": a["title"] ?? "", "prompt": a["prompt"] ?? "", "model": a["model"] ?? NSNull(), "minutes": a["minutes"] ?? NSNull()]) }
        }
        continue
      }
      var bundles: [[String: Any]] = [], bad: String?
      for b in (r["bundles"] as? [[String: Any]]) ?? [] {
        // A bundle file must be in the CLI folder itself (never any other file on this Mac).
        guard let p = b["path"] as? String, let project = b["project"] as? String, SecondJobs.isProject(project), let head = b["head"] as? String, SecondJobs.isSha(head) else { bad = "Bad arguments"; break }
        let real = SafePath.real(p)
        guard (real as NSString).deletingLastPathComponent == SafePath.real(cliDir), let d = fm.contents(atPath: real), d.count <= SecondLanding.maxFile else { bad = "Code bundle missing"; break }
        try? fm.removeItem(atPath: real)
        var o: [String: Any] = ["project": project, "head": head, "b64": d.base64EncodedString()]
        if let base = b["base"] as? String, SecondJobs.isSha(base) { o["base"] = base }
        bundles.append(o)
      }
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        if let bad { self.cliResult(rid, ["id": rid, "state": "failed", "status": ["reason": bad]]); return }
        if !self.unlocked { self.cliResult(rid, ["id": rid, "state": "failed", "status": ["reason": "PS app is locked"]]); return }
        self.post(["type": "second:cli", "req": ["id": rid, "type": type, "args": r["args"] ?? [:]], "bundles": bundles])
      }
    }
  }

  private func cliUpdate(_ msg: [String: Any]) {
    guard let rid = msg["id"] as? String, SecondJobs.isId(rid), let state = msg["state"] as? String else { return }
    var r: [String: Any] = ["id": rid, "state": state, "at": nowMs()]
    if let j = msg["job"] { r["job"] = j }
    if let s = msg["status"] { r["status"] = s }
    cliResult(rid, r)
  }
  private func cliResult(_ rid: String, _ r: [String: Any]) {
    var r = r; r["at"] = r["at"] ?? nowMs()
    let path = cliDir + "/res-" + rid + ".json"
    work.async { if let d = try? JSONSerialization.data(withJSONObject: r) { Second.atomicWrite(d, path) } }
  }

  static func atomicWrite(_ d: Data, _ path: String) {
    let tmp = path + ".tmp"
    FileManager.default.createFile(atPath: tmp, contents: d, attributes: [.posixPermissions: 0o600])
    _ = rename(tmp, path)
  }

  // MARK: self test only (SecondSelfTest.swift)

  func testSign(_ body: [String: Any]) -> SecondEnv? { IS_TEST_COPY ? id?.sign(body) : nil }
  func testOpen(_ env: SecondEnv, _ t: Set<String>) -> [String: Any]? {
    guard IS_TEST_COPY, let id, case .success(let b) = id.open(env, expect: t, remember: false) else { return nil }
    return b
  }
  var testDevice: String { IS_TEST_COPY ? id?.device ?? "" : "" }
  var testPub: String { IS_TEST_COPY ? id?.pub ?? "" : "" }
  var testPeers: [String] { IS_TEST_COPY ? (id?.peers.map { $0.device } ?? []) : [] }
  var testTrustedCount: Int { IS_TEST_COPY ? id?.peers.count ?? -1 : -1 }
  var testCliDir: String { cliDir }

  // MARK: Mac facts and the alert

  static func computerName() -> String { (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? "Mac" }
  static func hwModel() -> String {
    var size = 0
    sysctlbyname("hw.model", nil, &size, nil, 0)
    var buf = [CChar](repeating: 0, count: max(size, 1))
    sysctlbyname("hw.model", &buf, &size, nil, 0)
    return String(cString: buf)
  }

  /// PS's own question (SecondConfirm.swift), never while 1Password or Signal is in front (it waits until
  /// they are not). Not an app modal NSAlert: that opened hidden under the Tab list and froze PS (1 Nov).
  static func alert(_ title: String, _ text: String, _ ok: String, _ done: @escaping (Bool) -> Void) {
    if Protected.front { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { alert(title, text, ok, done) }; return }
    DispatchQueue.main.async { SecondConfirm.shared.ask(title, text, ok, done) }
  }
}

// MARK: drag and drop (protocol v1.2, SecondDrop.swift)

extension Second {
  /// The staged files, for the main page (which streams them up) and through it the window and the Tab list.
  func postOutbox() {
    let places = self.places
    work.async { [weak self] in
      let list = SecondOutbox.list(places)
      DispatchQueue.main.async { self?.post(["type": "second:outbox", "list": list]) }
    }
  }

  /// The page asks for chunk i of a staged file (base64, 4 MB at most).
  fileprivate func readOut(_ msg: [String: Any]) {
    guard let req = msg["req"] as? String, req.count <= 120, let oid = msg["id"] as? String, SecondJobs.isId(oid), let i = (msg["i"] as? NSNumber)?.intValue else { return }
    let places = self.places
    work.async { [weak self] in
      let d = SecondOutbox.read(places, oid, i)
      DispatchQueue.main.async { self?.post(d.map { ["type": "second:readOk", "req": req, "b64": $0.base64EncodedString()] } ?? ["type": "second:readOk", "req": req, "error": "Gone"]) }
    }
  }

  /// Where a landing cut off by sleep or a restart picks up: the chunks already on this Mac's disk.
  fileprivate func landAt(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let req = msg["req"] as? String, req.count <= 120, let env = SecondEnv(msg["env"]), let landing else { return }
    work.async { [weak self] in
      // Read for its numbers only: the chunks themselves are checked against the signature as they come.
      let b = (try? JSONSerialization.jsonObject(with: Data(env.body.utf8))) as? [String: Any] ?? [:]
      let k = id.peer(env.by) != nil ? landing.have(b) : 0
      DispatchQueue.main.async { self?.post(["type": "second:landAt", "req": req, "have": k]) }
    }
  }

  /// The developer's own click on Send files (or Attach): PS's Open panel, files and folders.
  func pick(_ target: [String: Any]) {
    guard isOn, !test, id != nil, SecondDropZone.targetOk(target) else { return }
    guard !Protected.front else { return }
    beforePanel()
    let p = NSOpenPanel()
    p.canChooseFiles = true; p.canChooseDirectories = true; p.allowsMultipleSelection = true; p.treatsFilePackagesAsDirectories = false
    p.prompt = "Send"; p.message = "Pick files or folders to send to your other Mac."
    if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    p.begin { [weak self] r in
      guard r == .OK, let self else { return }
      let urls = p.urls, places = self.places
      self.work.async { let st = SecondOutbox.stage(urls, target: target, places: places); DispatchQueue.main.async { self.staged(st) } }
    }
  }

  /// Something was dropped on a Second Computer place (SecondDropZone). Staged off the main thread.
  func dropped(_ l: SecondDragLoad, target: [String: Any]) {
    guard !off, id != nil, unlocked || test, SecondDropZone.targetOk(target) else { return }
    let places = self.places
    if !l.promises.isEmpty {
      // Mail attachments, Photos, a browser's picture: the app writes them into a folder of ours first.
      let tmp = URL(fileURLWithPath: places.root + "/drop-tmp/" + UUID().uuidString.lowercased(), isDirectory: true)
      try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let g = DispatchGroup(), lock = NSLock()
      var urls: [URL] = [], fails = 0, finished = false
      let finish = { [weak self] in
        lock.lock(); if finished { lock.unlock(); return }; finished = true; let got = urls, bad = fails; lock.unlock()
        self?.work.async {
          var st = SecondOutbox.stage(got, target: target, places: places)
          if bad > 0 { st.problems.append(bad == 1 ? "One item could not be read from the app it came from." : "\(bad) items could not be read from the app they came from.") }
          try? FileManager.default.removeItem(at: tmp)
          DispatchQueue.main.async { self?.staged(st) }
        }
      }
      for r in l.promises {
        let count = max(1, r.fileNames.count)
        for _ in 0..<count { g.enter() }
        var left = count
        r.receivePromisedFiles(atDestination: tmp, options: [:], operationQueue: promiseQ) { u, e in
          lock.lock()
          if e == nil { urls.append(u) } else { fails += 1 }
          let leave = left > 0
          left -= 1
          lock.unlock()
          if leave { g.leave() }
        }
      }
      g.notify(queue: work) { finish() }
      work.asyncAfter(deadline: .now() + 300) { finish() }   // an app that never writes its file
      return
    }
    work.async { [weak self] in
      let st: SecondOutbox.Staged
      if !l.files.isEmpty { st = SecondOutbox.stage(l.files, target: target, places: places) }
      else if let img = l.image { st = SecondOutbox.stage(data: img, name: SecondDragLoad.name(for: l.link, title: l.linkName, ext: "png", fallback: "Picture"), target: target, places: places) }
      else if let u = l.link, let d = SecondDragLoad.webloc(u) { st = SecondOutbox.stage(data: d, name: SecondDragLoad.name(for: u, title: l.linkName, ext: "webloc", fallback: "Link"), target: target, places: places) }
      else if let t = l.text, !t.isEmpty {
        let first = t.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Text"
        st = SecondOutbox.stage(data: Data(t.utf8), name: SecondDragLoad.name(for: nil, title: String(first.prefix(40)), ext: "txt", fallback: "Text"), target: target, places: places)
      } else { return }
      DispatchQueue.main.async { self?.staged(st) }
    }
  }

  private func staged(_ st: SecondOutbox.Staged) {
    if !st.items.isEmpty { psLog("PS second: \(st.items.count) dropped item(s) staged to send") }
    if !st.problems.isEmpty { post(["type": "second:dropProblems", "list": Array(st.problems.prefix(20))]) }
    postOutbox()
  }

  /// A file of THIS Mac's shared folder, for dragging it out as itself.
  func localShared(root: String, path: String) -> String? {
    guard let r = shares.first(where: { $0.id == root }), let p = SecondShare.inside(r, path), FileManager.default.fileExists(atPath: p) else { return nil }
    return p
  }

  /// Finder wants a file of the other Mac where the developer dropped it: the page signs the request, PS lands it there.
  func fetchTo(_ item: [String: Any], dest: URL, done: @escaping (Error?) -> Void) {
    guard !off, id != nil, unlocked || test, SecondDragOut.itemOk(item), let device = item["device"] as? String, let root = item["root"] as? String, let path = item["path"] as? String else {
      done(SecondDragOut.err("PS app is locked")); return
    }
    let req = "fetch-" + UUID().uuidString.lowercased()
    let size = (item["size"] as? NSNumber)?.int64Value ?? 0
    let prog = Progress(totalUnitCount: max(1, size))
    prog.kind = .file; prog.fileOperationKind = .downloading; prog.fileURL = dest; prog.isCancellable = false
    if !test { prog.publish() }
    dests.add(req, dest: dest.path, done: done, progress: prog)
    post(["type": "second:fetchTo", "req": req, "device": device, "root": root, "path": path])
    // The other Mac may be asleep: Finder is told it failed after an hour (the file still lands in Downloads, From PS).
    DispatchQueue.main.asyncAfter(deadline: .now() + 3600) { [weak self] in
      if self?.dests.finish(req, SecondDragOut.err("The other Mac did not send it in time")) == true { psLog("PS second: a dragged out file timed out") }
    }
  }

  /// The page signed the request for a dragged out file: from now on it is known by that request id.
  fileprivate func fetching(_ msg: [String: Any]) {
    guard let req = msg["req"] as? String else { return }
    if let e = msg["error"] as? String { _ = dests.finish(req, SecondDragOut.err(e)); return }
    guard let g = msg["get"] as? String, SecondJobs.isId(g) else { return }
    dests.rename(req, to: g)
  }

  /// The landing hooks for drag out (set where the landing is made).
  func hookDests(_ l: SecondLanding) {
    let d = dests
    l.exactDest = { g in g.flatMap { d.path($0) } }
    l.onBytes = { g, n in d.bytes(g, n) }
  }
}

/// Dragged out files waiting for the other Mac, by request id. Read from the landing queue, so it has a lock.
final class SecondDests {
  private struct Dest { var path: String; var done: (Error?) -> Void; var progress: Progress }
  private var all: [String: Dest] = [:]
  private let lock = NSLock()
  func add(_ k: String, dest: String, done: @escaping (Error?) -> Void, progress: Progress) { lock.lock(); all[k] = Dest(path: dest, done: done, progress: progress); lock.unlock() }
  func rename(_ k: String, to n: String) { lock.lock(); if let d = all.removeValue(forKey: k) { all[n] = d }; lock.unlock() }
  func path(_ k: String) -> String? { lock.lock(); defer { lock.unlock() }; return all[k]?.path }
  func bytes(_ k: String, _ n: Int) { lock.lock(); let p = all[k]?.progress; lock.unlock(); p?.completedUnitCount = Int64(n) }
  /// True when `k` was waiting (Finder is told now).
  func finish(_ k: String, _ e: Error?) -> Bool {
    lock.lock(); let d = all.removeValue(forKey: k); lock.unlock()
    guard let d else { return false }
    if e == nil { d.progress.completedUnitCount = d.progress.totalUnitCount }
    d.progress.unpublish()
    d.done(e)
    return true
  }
}

// MARK: outsourcing from a chat (protocol v1.3, SecondSeal.swift, SecondOutsource.swift)

extension Second {
  /// The other Mac's hello, from the page: checked with the paired device key, then its outsourcing keys are kept.
  fileprivate func peerHello(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]), let p = id.peer(env.by), let okeys else { return }
    work.async { [weak self] in
      guard SecondIdentity.verify(env, pub: p.pub), let b = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any],
            b["t"] as? String == "dev", b["from"] as? String == env.by else { return }
      let k = SecondKeys.Public(b["okeys"])
      if k != okeys.peer(env.by) {
        okeys.setPeer(env.by, k)
        psLog(k == nil ? "PS second: the other Mac has no outsourcing keys yet (older PS)" : "PS second: the other Mac's outsourcing keys (\(k!.xwing != nil ? "X-Wing" : "P-256"), its job key in \(k!.store))")
        DispatchQueue.main.async { self?.writeCliState() }
      }
    }
  }

  /// The main Mac: a task from a chat (`second.ts outsource`) or the window, sealed and signed here, and sent.
  func outsource(rid: String?, _ plain: [String: Any]) {
    func no(_ why: String) {
      psLog("PS second: did not send an outsourced task (\(why))")
      if let rid { cliResultO(rid, ["state": "refused", "reason": why]) } else { post(["type": "second:dropProblems", "list": [why]]) }
    }
    guard let id, let okeys, role == "primary" else { no("this Mac is not the main Mac"); return }
    guard unlocked else { no("PS app is locked"); return }
    guard let p = id.peers.first(where: { $0.role == "secondary" }) else { no("no second Mac is paired"); return }
    guard let pk = okeys.peer(p.device) else { no("PS app on \(p.name) needs the update that takes sealed research"); return }
    var clean = plain.filter { !($0.value is NSNull) }
    if clean["kind"] as? String == "research", (clean["title"] as? String).map(SecondJobs.isTitle) != true { clean["title"] = SecondOJob.title(clean["prompt"] as? String ?? "") }
    let j: SecondOJob.Job
    switch SecondOJob.check(clean) { case .failure(let w): no(w.why); return; case .success(let x): j = x }
    let me = id.device
    work.async { [weak self] in
      guard let (env, suite) = SecondOEnv.make(t: "ojob", from: me, to: p.device, plain: clean, peer: pk, keys: okeys),
            let b = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any], let job = b["id"] as? String else {
        DispatchQueue.main.async { no("could not seal it") }; return
      }
      DispatchQueue.main.async {
        guard let self else { return }
        self.post(["type": "second:ojobOut", "env": env.json, "job": job])
        if j.kind == "cancel" { if let rid { self.cliResultO(rid, ["state": "sent", "job": job, "suite": suite, "title": "Stop a task"]) }; return }
        self.ojobs[job] = ["job": job, "title": j.title, "state": "sent", "suite": suite, "at": self.nowMs(), "mine": true, "to": p.device, "rid": rid ?? ""]
        self.saveOJobs()
        if let rid { self.cliResultO(rid, ["state": "sent", "job": job, "suite": suite, "title": j.title]) }
        psLog("PS second: sent a sealed research task (\(suite == "xwing" ? "X-Wing" : "P-256"))")
        // Never a silent hang: nobody opened it in 10 minutes (offline, asleep, PS closed there) and the chat is told.
        DispatchQueue.main.asyncAfter(deadline: .now() + 11 * 60) { [weak self] in
          guard let self, self.ojobs[job]?["state"] as? String == "sent" else { return }
          self.oapply(job, ["state": "expired", "reason": "\(p.name) never opened it (offline, asleep or PS app closed there)"])
        }
      }
    }
  }

  /// The second Mac: a sealed job from the page, checked (SecondOEnv.open, SecondOJob.check), then run.
  fileprivate func ojobIn(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]), let okeys, let orunner, role == "secondary" else { return }
    let me = id.device
    work.async { [weak self] in
      let r = SecondOEnv.open(env, t: "ojob", me: me, role: "primary", identity: id, keys: okeys)
      DispatchQueue.main.async {
        guard let self else { return }
        switch r {
        case .failure(let w):
          psLog("PS second: refused a sealed task (\(w.why))")
          // Told back sealed when it can be (the job id from the header), so the chat hears it at once.
          if w.why != "Seen before", let b = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any], let job = b["id"] as? String, SecondJobs.isUUID(job) {
            self.ostatus(.init(job: job, title: "", state: "refused", reason: w.why, endedAt: Date(), suite: "", from: env.by))
          }
        case .success(let o):
          switch SecondOJob.check(o.plain) {
          case .failure(let w):
            psLog("PS second: refused a sealed task (\(w.why))")
            self.ostatus(.init(job: o.body["id"] as? String ?? "", title: o.plain["title"] as? String ?? "", state: "refused", reason: w.why, endedAt: Date(), suite: o.suite, from: env.by))
          case .success(let j):
            psLog("PS second: a sealed \(j.kind) task (\(o.suite == "xwing" ? "X-Wing" : "P-256"))")
            orunner.submit(j, id: o.body["id"] as! String, from: env.by, suite: o.suite)
          }
        }
      }
    }
  }

  /// The second Mac: a status or the result, sealed back to the main Mac.
  fileprivate func ostatus(_ st: SecondOutsourceRunner.Status) {
    guard let id, let okeys, SecondJobs.isUUID(st.job), let pk = okeys.peer(st.from) else { return }
    var plain: [String: Any] = ["state": st.state]
    for (k, v) in [("title", st.title), ("reason", st.reason), ("step", st.step), ("summary", st.summary), ("report", st.report), ("suite", st.suite)] { if let v, !v.isEmpty { plain[k] = v } }
    if let d = st.startedAt { plain["startedAt"] = (d.timeIntervalSince1970 * 1000).rounded() }
    if let d = st.endedAt { plain["endedAt"] = (d.timeIntervalSince1970 * 1000).rounded() }
    if !st.files.isEmpty { plain["files"] = st.files.map { ["name": $0.0, "b64": $0.1.base64EncodedString()] } }
    var row = ojobs[st.job] ?? ["job": st.job, "at": nowMs(), "mine": false]
    row["title"] = st.title.isEmpty ? row["title"] ?? "Research" : st.title; row["state"] = st.state; row["suite"] = st.suite
    row["step"] = st.step ?? NSNull(); row["reason"] = st.reason ?? NSNull(); row["summary"] = st.summary ?? NSNull()
    ojobs[st.job] = row; postOJobs()
    let me = id.device
    work.async { [weak self] in
      guard let (env, _) = SecondOEnv.make(t: "ores", from: me, to: st.from, job: st.job, plain: plain, peer: pk, keys: okeys) else { return }
      DispatchQueue.main.async { self?.post(["type": "second:oresOut", "env": env.json, "job": st.job]) }
    }
  }

  /// The main Mac: a sealed status or result from the second Mac.
  fileprivate func oresIn(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]), let okeys, role == "primary" else { return }
    let me = id.device
    work.async { [weak self] in
      let r = SecondOEnv.open(env, t: "ores", me: me, role: "secondary", identity: id, keys: okeys)
      DispatchQueue.main.async {
        guard let self else { return }
        switch r {
        case .failure(let w): if w.why != "Seen before" { psLog("PS second: refused a sealed result (\(w.why))") }
        case .success(let o):
          guard let job = o.body["job"] as? String, let at = (o.body["at"] as? NSNumber)?.doubleValue else { return }
          if let last = self.ojobs[job]?["resAt"] as? Double, last >= at { return }   // an older status after a newer one
          // A finished job stays finished (a refused copy of it, replayed or tampered, never undoes the result).
          if let st = self.ojobs[job]?["state"] as? String, ["done", "failed", "cancelled", "timeout"].contains(st) { return }
          var p = o.plain; p["resAt"] = at; p["from"] = env.by
          self.oapply(job, p)
        }
      }
    }
  }

  /// The main Mac records a job's news: the chat's result file, the window, and at the end the copy in
  /// Downloads, From your other Mac, a PS card and the ack that lets the second Mac delete the job's folder.
  fileprivate func oapply(_ job: String, _ p: [String: Any]) {
    var row = ojobs[job] ?? ["job": job, "at": nowMs(), "mine": true, "title": p["title"] ?? "Research"]
    let was = row["state"] as? String
    for k in ["state", "step", "reason", "summary", "startedAt", "endedAt", "resAt"] { row[k] = p[k] ?? (k == "state" ? row[k] : NSNull()) }
    if row["suite"] == nil, let s = p["suite"] { row["suite"] = s }
    if let t = p["title"] as? String, !t.isEmpty { row["title"] = t }
    let state = row["state"] as? String ?? "sent", final = ["done", "failed", "refused", "cancelled", "timeout", "expired"].contains(state)
    if final, was != state, let from = p["from"] as? String ?? row["to"] as? String {
      let title = row["title"] as? String ?? "Research"
      if state == "done" || p["report"] != nil {
        if let folder = saveCopy(title, p["report"] as? String ?? "", p["files"] as? [[String: Any]] ?? []) { row["folder"] = folder; row["report"] = folder + "/report.md" }
      }
      if state == "done" { oCard("Your other Mac finished: \(String(title.prefix(60)))", (p["summary"] as? String).map { String($0.prefix(140)) }, "In Downloads, From your other Mac") }
      else { oCard("Your other Mac could not finish: \(String(title.prefix(60)))", (row["reason"] as? String).map { String($0.prefix(140)) }, nil) }
      if state != "expired" { post(["type": "second:oack", "job": job, "to": from]) }
      psLog("PS second: an outsourced task \(state)")
    }
    ojobs[job] = row
    saveOJobs(); postOJobs()
    if let rid = row["rid"] as? String, SecondJobs.isId(rid) {
      var r: [String: Any] = ["job": job, "state": state, "title": row["title"] ?? "", "suite": row["suite"] ?? ""]
      for k in ["reason", "summary", "report", "folder"] { if let v = row[k] as? String { r[k] = v } }
      cliResultO(rid, r)
    }
  }

  /// ~/Downloads/From your other Mac/<date> <title>/report.md and the small files that came with it.
  private func saveCopy(_ title: String, _ report: String, _ files: [[String: Any]]) -> String? {
    let base = (test ? (downloads as NSString).deletingLastPathComponent : places.home + "/Downloads") + "/From your other Mac"
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH.mm"
    try? FileManager.default.createDirectory(atPath: base, withIntermediateDirectories: true)
    let dir = SecondLanding.free(base, SecondLanding.clean(f.string(from: Date()) + " " + title))
    guard (try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)) != nil else { return nil }
    try? Data(report.utf8).write(to: URL(fileURLWithPath: dir + "/report.md"))
    for x in files.prefix(20) {
      guard let n = x["name"] as? String, let d = (x["b64"] as? String).flatMap({ Data(base64Encoded: $0) }), d.count <= 2 << 20 else { continue }
      let name = SecondLanding.clean(n)
      guard name != "report.md" else { continue }
      try? d.write(to: URL(fileURLWithPath: dir + "/" + name))
      SecondLanding.quarantine(dir + "/" + name)
    }
    return dir
  }

  /// The second Mac: the main Mac has the result (its ack, signed with its paired device key): the folder goes.
  fileprivate func oacked(_ msg: [String: Any], _ id: SecondIdentity) {
    guard let env = SecondEnv(msg["env"]), let p = id.peer(env.by), p.role == "primary", SecondIdentity.verify(env, pub: p.pub),
          let b = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any], b["t"] as? String == "ack", let job = b["ref"] as? String else { return }
    orunner?.done(job)
  }

  private func cliResultO(_ rid: String, _ r: [String: Any]) {
    var r = r; r["id"] = rid; r["kind"] = "outsource"; r["at"] = r["at"] ?? nowMs()
    let path = cliDir + "/res-" + rid + ".json"
    work.async { if let d = try? JSONSerialization.data(withJSONObject: r) { Second.atomicWrite(d, path) } }
  }
  private func saveOJobs() {
    let cut = nowMs() - 7 * 86_400_000
    ojobs = ojobs.filter { (($0.value["at"] as? Double) ?? 0) > cut }
    let all = ojobs, path = places.root + "/ojobs.json"
    work.async { if let d = try? JSONSerialization.data(withJSONObject: all) { Second.atomicWrite(d, path) } }
  }
  /// The window's Outsource tab (through the main page): every job, newest first, with the start of its report.
  func postOJobs() {
    let rows = Array(ojobs.values.sorted { (($0["at"] as? Double) ?? 0) > (($1["at"] as? Double) ?? 0) }.prefix(100))
    work.async { [weak self] in   // the reports are read off the main thread
      let list = rows.map { r -> [String: Any] in
        var x = r.filter { !($0.value is NSNull) && $0.key != "rid" && $0.key != "to" && $0.key != "resAt" }
        if let path = r["report"] as? String { x["report"] = (try? String(contentsOfFile: path, encoding: .utf8)).map { String($0.prefix(48 * 1024)) } ?? NSNull() }
        if let f = r["folder"] as? String { x["folder"] = "Downloads/From your other Mac/" + (f as NSString).lastPathComponent }
        if x["state"] as? String == "expired" { x["state"] = "failed" }
        return x
      }
      DispatchQueue.main.async { self?.post(["type": "second:ojobs", "list": list]) }
    }
  }
}

// MARK: a Keychain that will not hand over the key (2 Nov 2026: the M1 came up unpaired after an update)

extension Second {
  /// The key, id or pairing list exist but could not be read: Second Computer stays OFF (the other Mac is told why),
  /// nothing is made new and nothing is unpaired, and a card asks the developer to Allow, which reads again on his click.
  fileprivate func keyBlocked(_ st: OSStatus, retried: Bool) {
    let why = Second.keyWhy(st, retried: retried)
    psLog("PS second: the Second Computer key could not be read (\(st)); off until it is allowed, nothing changed")
    offReason = "its Second Computer key needs your OK in PS app there"
    // PS's own card comes FIRST (V1.44, the developer: the macOS screen alone "is confusing people"): it says what macOS is about
    // to show and what to click. macOS asks only after the click on Allow, once (one Keychain item since V1.44).
    let sub = retried ? "Not allowed yet: \(why). Click Allow, type your Mac login password, then click Always Allow."
      : "Click Allow. macOS then asks for your Mac login password: type it and click Always Allow, so it does not ask again. Your Macs stay paired."
    offHere = retried ? "Not allowed yet: \(why). Click Allow again. When macOS asks, type your Mac login password and click Always Allow (not Allow or Deny)."
      : "After an update macOS wants your OK once before PS app can use its Second Computer key. Click Allow. macOS then asks for your Mac login password: type it and click Always Allow, so it does not ask again. Your Macs stay paired; nothing is lost."
    offRetried = retried
    sendState()
    answerPending()
    keyCard(sub)
  }

  /// The plain reason a Keychain read failed. A quiet read (no question allowed) of an item an older build saved
  /// fails with -25308 or -25293: that is macOS waiting for the developer's OK, not a Deny.
  static func keyWhy(_ st: OSStatus, retried: Bool) -> String {
    switch st {
    case errSecInteractionNotAllowed: return retried ? "the Mac was locked" : "the key was saved by an earlier PS app, or the Mac was locked"
    case errSecAuthFailed: return retried ? "the Keychain did not get its OK (wrong password or Deny)" : "the key was saved by an earlier PS app"
    case errSecUserCanceled: return "the Keychain question was closed with Deny or Cancel"
    case errSecDecode: return "the saved key is incomplete"
    default: return "the Keychain said \(st)"
    }
  }

  /// A message from the page while Second Computer is off here. Nothing is ever dropped without a word: the window
  /// still opens (it shows why, with Allow), Allow reads again, and anything else is answered with second:off.
  fileprivate func handleOff(_ type: String, _ msg: [String: Any]) {
    switch type {
    case "second:hello": sendState()
    case "second:window": sendState(); openWindow(nil)
    case "second:allow": allowKey()
    case "second:role", "second:pair", "second:seek", "second:run", "second:outsource", "second:cmd", "second:trustPhone",
         "second:unpair", "second:pick", "second:reveal", "second:projects", "second:get":
      psLog("PS second: \(type) while Second Computer is off here, told the page")
      post(["type": "second:off", "op": String(type.dropFirst(7).prefix(20)), "why": offHere ?? offReason ?? "Second Computer is off on this Mac"])
      sendState()
    default: break   // background traffic (signing, outbox, status): the page already shows the off state
    }
  }

  /// Messages that arrived while the key was still being read: answered now that it is off.
  fileprivate func answerPending() {
    let p = pending; pending = []
    p.forEach { $0() }
  }

  /// The developer clicked Allow (the card or the page): read again, and this time the Keychain may ask him.
  func allowKey() {
    guard offReason != nil else { sendState(); return }
    if allowing { sendState(); return }
    allowing = true
    keyCard(nil)
    sendState()
    psLog("PS second: Allow clicked, reading the Second Computer key again")
    work.async { [weak self] in self?.load(allowUI: true) }
  }

  /// The sticky card (nil hides it). Its Allow button comes back through Toast.onAction (main.swift, "sk:").
  func keyCard(_ sub: String?) {
    if test { keyCardShown = sub; return }
    if let sub {
      Toast.shared.showCard(["id": "sk:allow", "sticky": true, "title": "PS app needs your Mac password once", "sub": sub,
                             "actions": [["id": "allow", "label": "Allow"]]])
    } else { Toast.shared.hideCard("sk:allow") }
  }

  /// The developer clicked Allow: read again, and this time the Keychain may ask him (he answers Always Allow).
  func keyAction(_ id: String, _ action: String) {
    guard started, id == "sk:allow", action == "allow" else { return }
    allowKey()
  }

  /// Test copies: PS_SELFTEST_SECOND_KEYCHAIN_DENY=1 makes the first read fail like a Deny; Allow then works.
  fileprivate func keychainDenyForTest(_ allowUI: Bool) -> OSStatus? {
    if testDenyNextRead && !allowUI { testDenyNextRead = false; return errSecInteractionNotAllowed }
    if testDenyAllowedRead && allowUI { testDenyAllowedRead = false; return errSecUserCanceled }
    return ProcessInfo.processInfo.environment["PS_SELFTEST_SECOND_KEYCHAIN_DENY"] == "1" && !allowUI ? errSecInteractionNotAllowed : nil
  }
}
