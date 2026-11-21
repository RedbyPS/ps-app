// The update flow (the plain parts are in UpdateCore.swift, the hand over in UpdateHandoff.swift).
// Since 27 Oct 2026 the manifest and files come from the channel (UpdateChannel: since V1.57 the public PS repo's newest GitHub release), which
// downloads them into PS's own mirror folder; everything below reads that folder like it read the
// synced Drive folder before.
// PS looks at the manifest 45 s after launch, every 5 minutes (V1.54, the developer: "can you not change it to every five
// minutes the update instead of every 30 minutes?"; UpdateCadence in UpdateLatest.swift: 30 s of leeway, a look
// is skipped while another still runs, and after a failed look the wait doubles, 5, 10, 20, 30 minutes) and after the Mac wakes. When
// something newer is there a card offers "Update now"; nothing happens until the developer clicks.
// Then: the files are read out of the Drive folder with real progress (bytes read; if Drive still
// has to fetch them from the cloud the card says so instead of guessing a number), the signature
// and every hash are checked, and the update goes in. A web-only update reloads the pages and is
// done (no restart, no new sign in, no Little Snitch prompt). An app update swaps the app in one
// step, hands the sign in to the new build and restarts PS; a build that does not start is rolled
// back by the helper. Everything runs off the main thread except the card itself.
// Since 31 Oct 2026 (the developer: "the same kind of update feature as I have on mobile") the update lives in the
// Tab list's gear menu like the phone's settings: the gear gets a dot, "Update available · V1.23" opens
// the version and its notes, Update runs Download, Verify, Install (prepare: every check, the new build
// staged beside the old one), then "Relaunch to finish" swaps it in (finish: the same checks again, the
// same swap, hand over and roll back). The pop-up card above is now only the quiet fallback for a Mac
// whose Tab list page never said hello (missing or broken web files), and PS > Check for Updates.
// Since V1.40 (the developer, 7 Nov 2026: "make sure it actually pops up for him, saying hey, update's available, so you
// don't have to go into the settings to look for it") the card pops up by itself once for every new update,
// signed in or not: the version, its approved notes, Update now and Later (a day of quiet, then once more; the
// gear's dot stays). Never during Do Not Disturb, never over 1Password or Signal, never while an install runs:
// it waits for those to end. The rules are in UpdateNudge.swift. After an update, the first launch also offers
// the new setup menu ("See what's new and set it up") once the Tab list page says it has one.
import AppKit
import Foundation

final class Updater {
  static let shared = Updater()
  weak var app: App?
  private let q = DispatchQueue(label: "PS updater", qos: .utility)
  private var timer: DispatchSourceTimer?
  /// The 5 minute rhythm: one look at a time, a longer wait after failures (UpdateLatest.swift).
  private let cadence = UpdateCadence()
  private static let everyKey = "update.everyMin"
  private(set) var ui: UpdateUI?
  private(set) var plan: UpdatePlan = .none
  private var manifest: UpdateManifest?
  private var driveDir: URL?
  private(set) var busy = false
  private var poll: Timer?
  private var hideWork: DispatchWorkItem?
  /// The update pop-up's record (UpdateNudge.swift) and the setup offer's, kept in the update folder.
  private static var nudgeFile: URL { UpdatePaths.work.appendingPathComponent("nudge.json") }
  private static var setupFile: URL { UpdatePaths.work.appendingPathComponent("setup-offer.json") }
  private lazy var nudgeState = UpdateNudge.load(Updater.nudgeFile)
  private lazy var setupState = SetupOffer.load(Updater.setupFile)
  /// What the card shows: "" (nothing yet), "offer", "progress", "done", "error", "setup". The self test reads it.
  private(set) var cardMode = ""
  /// The card stepped aside for 1Password or Signal and comes back when they go.
  private var hiddenForProtected = false
  private var lastWait = ""
  /// The Tab list page's setup menu generation ({type:"setup:can"}, web src/setuphook.ts), 0 = none.
  private(set) var setupGen = 0
  /// This run follows an update: an app swap, or web files put in (the setup offer only comes after one).
  private(set) var updatedThisRun = false
  /// The self test reads these.
  private(set) var lastCheck = "", lastError = "", log: [String] = []
  var testHold = false                         // a test copy does not quit after an app update

  // MARK: the gear menu (web src/macupdate.ts, views/MacUpdate.tsx)

  /// The Tab list page said hello (macUpdate:get): updates show in its gear menu, the card stays away.
  private(set) var pageOn = false
  var forcePanel = false                       // self test of the fallback card
  private var viaPanel = false                 // this run was started from the card
  /// What the gear menu shows now (sent again whenever the page asks).
  private(set) var page: [String: Any] = ["state": "idle"]
  /// The update made ready by prepare, waiting for "Relaunch to finish".
  private struct Staged { let plan: UpdatePlan; let key: String; let webDir: URL; let webRoot: URL; let app: URL? }
  private var staged: Staged?
  private var lastPagePush = Date.distantPast

  /// The gear menu only while it can be seen: signed in and unlocked (or the developer's own PS). Signed out, the Tab list
  /// shows no gear, so the update card offers it instead (the developer, 7 Nov 2026: "if you're not signed in you can
  /// update anyway"; a friend who could not sign in had to download PS again from the website).
  private var usePage: Bool { pageOn && !forcePanel && (app?.vaultUnlocked == true || Owner.red) }

  /// main.swift: the vault was opened or locked. An update the card offered moves to the gear once it can be seen.
  func lockChanged() {
    offerSetup()   // signed in after an update: the setup offer that waited for it
    guard usePage, !busy, staged == nil, plan != .none, ui?.window.isVisible == true else { return }
    ui?.close()
    pageSet("available")
  }
  /// "V1.22 · Mastery" as ("V1.22", "Mastery").
  private static func parts(_ name: String) -> (String, String?) {
    let p = name.components(separatedBy: " · ")
    return (p[0], p.count > 1 ? p[1] : nil)
  }
  /// Sets the menu's state (on main) and sends it to the Tab list page.
  func pageSet(_ state: String, _ extra: [String: Any] = [:], unseen: Bool = false) {
    Hatch.shared.updaterStep(state, frac: extra["progress"] as? Double)   // PS 1.67: the icon builds with every step (Hatch.swift)
    var o: [String: Any] = ["state": state]
    let cur = Updater.parts(PSVersion.name)
    o["current"] = cur.0; if let k = cur.1 { o["currentKeyword"] = k }
    if plan != .none || staged != nil {
      let p = staged?.plan ?? plan
      if let v = manifest?.version { o["version"] = v }
      if let k = manifest?.keyword { o["keyword"] = k }
      if let b = manifest?.by { o["by"] = b }   // V1.58: who made it (the page shows "V1.59 by Jan")
      if let n = manifest?.notes, !n.isEmpty { o["notes"] = n }
      // V1.52: every earlier version's approved notes (the page picks the ones newer than the version it runs).
      if let h = manifest?.history, !h.isEmpty { o["history"] = h.map { b -> [String: Any] in var x: [String: Any] = ["version": b.version, "keyword": b.keyword, "notes": b.notes]; if let by = b.by { x["by"] = by }; return x } }
      if case .app = p { o["kind"] = "app" } else { o["kind"] = "web" }
      o["size"] = p.bytes
    }
    for (k, v) in extra { o[k] = v }
    o["unseen"] = unseen
    page = o
    pagePush()
  }
  private func pagePush() {
    lastPagePush = Date()
    log.append("page:\(page["state"] as? String ?? "?")")
    app?.overlay?.callAsyncJavaScript("window.__psMacUpdate && window.__psMacUpdate(s)", arguments: ["s": page], in: nil, in: .page, completionHandler: nil)
  }
  /// Self test pictures only: a made up state in the gear menu.
  func testPage(_ o: [String: Any]) { guard UpdatePaths.test else { return }; page = o; pagePush() }
  /// Self test only: the pop-up's record as if time had passed (UpdateNudge.swift), and "this run follows an update".
  func testNudge(_ n: UpdateNudge) { guard UpdatePaths.test else { return }; nudgeState = n; nudgeState.save(Updater.nudgeFile) }
  var testNudgeState: UpdateNudge { nudgeState }
  func testUpdated() { guard UpdatePaths.test else { return }; updatedThisRun = true }
  /// From the Tab list page (main.swift bridge). Each one is a real click there, except get and seen.
  func fromPage(_ type: String) {
    switch type {
    case "macUpdate:get":
      if !pageOn { psLog("PS update: the Tab list page shows updates (gear menu)") }
      pageOn = true
      pagePush()
    case "macUpdate:check":
      log.append("page:check")
      if !busy && staged == nil { pageSet("checking"); checkNow(manual: true, fromPage: true) }
    case "macUpdate:start":
      log.append("page:start")
      if !busy && staged == nil && plan != .none {
        // Started from the gear: the pop-up has done its job and goes (it never comes back for this update).
        nudgeState.updateNow(key: key(plan)); nudgeState.save(Updater.nudgeFile)
        if cardMode == "offer" { ui?.close(); hiddenForProtected = false }
        viaPanel = false; installLatest(auto: false)
        Hatch.shared.updateStarted()   // PS 1.67: the island leaves and the icon starts to build (Hatch.swift)
      }
    case "macUpdate:finish":
      log.append("page:finish")
      if !busy && staged != nil { finishLatest() }
    case "macUpdate:seen":
      if page["unseen"] as? Bool == true { page["unseen"] = false; pagePush() }
    default: break
    }
  }

  var enabled: Bool { UpdatePaths.apps != nil }
  /// "Check for updates every" is Off: PS never looks by itself (main.swift's website hint asks too).
  var autoOff: Bool { cadence.isOff }

  func start(app: App) {
    self.app = app
    afterLaunch()
    guard enabled else { return }
    let t = DispatchSource.makeTimerSource(queue: q)
    if !UpdatePaths.test { cadence.setEvery(UpdateCadence.stored(UserDefaults.standard.object(forKey: Updater.everyKey))) }   // the last choice the page gave, until it says again
    t.schedule(deadline: cadence.isOff ? .distantFuture : .now() + (UpdatePaths.test ? 3600 : UpdateCadence.first), leeway: .seconds(30))   // one shot: every look sets the next (rearm)
    t.setEventHandler { [weak self] in self?.autoLook() }
    t.resume()
    timer = t
    if !UpdatePaths.test {
      NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
        self?.q.asyncAfter(deadline: .now() + 60) { self?.autoLook() }
      }
      // `npm run release -- --app` on this Mac asks the running PS to install the new build itself
      // (build.sh), so the sign in is handed over here too. Only a build signed by the developer's certificate,
      // newer than this one, from the request file in PS's own folder, is ever taken.
      DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.cincee.ps.installLocal"), object: nil, queue: .main) { [weak self] _ in
        self?.installLocalRequest()
      }
    }
  }

  // MARK: after a restart: "Updated", or "went back"

  private func afterLaunch() {
    DockIcon.shared.start()   // PS 1.61: once this build's update has finished, the Dock shows its icon (DockIconCore.swift)
    guard var j = UpdateJournal.read(), !j.shown else { return }
    let mine = PSVersion.mine
    if (j.phase == "swapped" || j.phase == "healthy" || j.phase == "ok") && j.to == mine {
      j.shown = true; j.write()
      updatedThisRun = true   // the setup offer may follow (offerSetup)
      // PS 1.67: the new build finishes the icon the old one built and plays the rest (Hatch.swift); its own 'Updated to'
      // takes the place of the island's short moment.
      let hatched = Hatch.shared.afterUpdate(sameRun: false)
      // PS Cake (the developer, 21 Nov 2026, the plan he approved): the logo reveal once, straight after the update scene and before
      // What's new (both wait in the island queue at high priority). Never at a fresh install; replay from Settings.
      if hatched { Cake.shared.revealOnce() }
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
        // The sign in may still be on its way from the old build (UpdateHandoff, its own thread).
        DispatchQueue.global(qos: .utility).async {
          UpdateHandoff.waitDone(30)
          DispatchQueue.main.async {
            let signed = UpdateHandoff.conn >= 0 || UpdatePaths.test
            self?.pageSet("done", ["kind": "app"] as [String: Any], unseen: true)
            if !hatched { Island.shared.updateDone(version: Updater.parts(PSVersion.name).0) }   // PS 1.60: the island's own short moment
            // The card only when the Tab list page never said hello (missing or broken web files).
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
              guard let self, !self.usePage else { return }
              self.showDone("\(AppName.current) updated", "Now on \(PSVersion.name). " + (signed ? "You are still signed in." : "Sign in once to finish."))
            }
          }
        }
      }
      // The helper stops watching once the page has loaded and the keyboard tap is up (pageReady).
    } else if j.phase == "rolledBack" && j.from == mine {
      j.shown = true; j.write()
      Updater.noteRolledBack(j.to)
      DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
        self?.pageSet("error", ["error": "The update did not start, so \(AppName.current) went back to \(PSVersion.appName)"], unseen: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) {
          guard let self, !self.usePage else { return }
          self.showError("The update did not start", "\(AppName.current) went back to \(PSVersion.appName). Nothing was lost.")
        }
      }
    }
  }

  // MARK: health after an update (page loaded and keyboard tap up)

  private var healthWatch: Timer?
  /// The main page finished loading. Healthy once the keyboard tap is up too (or cannot be: Tab
  /// turned off, or no Accessibility permission, which a roll back would not fix).
  func pageReady() {
    guard healthWatch == nil, let j = UpdateJournal.read(), j.phase == "swapped", j.to == PSVersion.mine else { return }
    var tries = 0
    healthWatch = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] t in
      tries += 1
      let w = TabWatch.shared
      guard w.tap != nil || !w.enabled || !AXIsProcessTrusted() || tries > 40 else { return }
      t.invalidate(); self?.healthWatch = nil
      psLog("PS update: new build healthy (page loaded, keyboard tap \(w.tap != nil ? "up" : "not on"))")
      DispatchQueue.global(qos: .utility).async { Updater.markHealthy(PSVersion.mine); UpdateHandoff.reportHealthy() }
    }
    healthWatch?.tolerance = 0.1
  }
  /// Writes "healthy" in the journal, which the helper reads (works without the hand over socket).
  static func markHealthy(_ build: Int) {
    guard var j = UpdateJournal.read(), j.phase == "swapped", j.to == build else { return }
    j.phase = "healthy"; j.write()
  }

  // MARK: builds that did not start here

  /// A build that was rolled back on this Mac is never offered again; a newer one waits for a
  /// quiet period after the roll back unless the developer asks (PS > Check for Updates).
  static let quietAfterRollBack: TimeInterval = 2 * 3600
  private static var badFile: URL { UpdatePaths.work.appendingPathComponent("rolled-back.json") }
  static func rolledBack() -> (builds: Set<Int>, last: Double) {
    var b = Set<Int>(), last = 0.0
    if let d = FileManager.default.contents(atPath: badFile.path), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
      b = Set((o["builds"] as? [Int]) ?? []); last = (o["last"] as? Double) ?? 0
    }
    if let j = UpdateJournal.read(), j.phase == "rolledBack" { b.insert(j.to); last = max(last, j.at) }
    return (b, last)
  }
  static func noteRolledBack(_ build: Int, refused: Bool = false) {
    if refused { psLog("PS update: build \(build) refused here, never offered again") }
    let r = rolledBack()
    let o: [String: Any] = ["builds": Array(r.builds.union([build])).sorted(), "last": max(r.last, Date().timeIntervalSince1970)]
    try? FileManager.default.createDirectory(at: UpdatePaths.work, withIntermediateDirectories: true)
    if let d = try? JSONSerialization.data(withJSONObject: o) { try? d.write(to: badFile, options: .atomic) }
  }
  /// The plan without any build that already failed here (and no new app during the quiet period).
  static func skipRolledBack(_ p: UpdatePlan, _ m: UpdateManifest, manual: Bool, why: inout String) -> UpdatePlan {
    guard case .app(let a, _) = p else { return p }
    let r = rolledBack()
    guard let worst = r.builds.max() else { return p }
    let webOnly = UpdatePlan.decide(UpdateManifest(kind: m.kind, made: m.made, app: nil, web: m.web, name: m.name, by: m.by, channel: m.channel), myBuild: PSVersion.mine, web: PSVersion.web())
    if a.build <= worst { why = "build \(a.build) did not start here before, not offered again"; return webOnly }
    if !manual && Date().timeIntervalSince1970 - r.last < quietAfterRollBack { why = "quiet after a roll back"; return webOnly }
    return p
  }

  // MARK: checking an update before the card shows

  private var verifiedKey = ""                 // the update whose files were all checked
  private var refusedHere = Set<String>()      // updates that failed a check: never offered again
  private var lastInstallEnd: Date?
  /// Reads every file the update needs from Drive (this is also what makes Drive download them),
  /// checks each hash, unpacks and checks the web version, the app build and its code signature,
  /// then throws it all away. Off the main thread. The install does the same checks again.
  static func verify(_ p: UpdatePlan, drive: URL) throws {
    let fm = FileManager.default
    let tmp = UpdatePaths.work.appendingPathComponent("verify", isDirectory: true)
    try? fm.removeItem(at: tmp)
    try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: tmp) }
    var web: UpdateManifest.Web, app: UpdateManifest.App?
    switch p { case .none: return; case .web(let w): web = w; case .app(let a, let w): web = w; app = a }
    if let a = app {
      let z = tmp.appendingPathComponent("app.zip")
      try UpdateFiles.fetch(drive.appendingPathComponent(a.file), to: z, size: a.size, sha256: a.sha256, progress: FetchProgress())
      let d = tmp.appendingPathComponent("app", isDirectory: true)
      try UpdateFiles.unzip(z, into: d)
      let c = d.appendingPathComponent("PS.app", isDirectory: true)
      guard PSVersion.build(of: c) == a.build else { throw UpdateError("the app is not the build the note names") }
      if let why = UpdateFiles.signatureProblem(c) { throw UpdateError("the new app failed the code signature check: \(why)") }
      guard UpdateFiles.quarantined(c) == 0 else { throw UpdateError("the new app still carries the quarantine flag") }
    }
    let z = tmp.appendingPathComponent("web.zip")
    try UpdateFiles.fetch(drive.appendingPathComponent(web.file), to: z, size: web.size, sha256: web.sha256, progress: FetchProgress())
    let d = tmp.appendingPathComponent("web", isDirectory: true)
    try UpdateFiles.unzip(z, into: d)
    let root = (try? fm.contentsOfDirectory(atPath: d.path))?.contains("index.html") == true ? d : d.appendingPathComponent("dist-ps", isDirectory: true)
    guard let v = PSVersion.web(at: root), v.src == web.src, v.built == web.built else { throw UpdateError("the web files are not the version the note names") }
  }

  // MARK: looking for an update

  /// Reads the manifest (off the main thread). `manual`: the developer asked (menu), so say "up to date" too.
  func checkNow(manual: Bool, fromPage: Bool = false, done: ((UpdatePlan) -> Void)? = nil) {
    // An automatic look never piles up behind one that is still running (a slow network): it is skipped.
    guard cadence.begin(manual: manual) else { DispatchQueue.main.async { done?(.none) }; return }
    q.async { [self] in
      var found = UpdatePlan.none, why = ""
      var source = UpdatePaths.drive(), channelWhy = "", failed = false
      if source == nil {
        do { source = try UpdateChannel.sync(myBuild: PSVersion.mine, web: PSVersion.web()) } catch { channelWhy = "\(error)"; failed = true }
      }
      if let dir = source {
        do {
          let raw = try Data(contentsOf: dir.appendingPathComponent("ps-update.json"))
          let m = try UpdateManifest.open(raw, publicKeys: UpdatePaths.publicKeys)
          guard UpdateRoute.current.takes(m.channel) else { throw UpdateError("the update note is for another PS build") }
          var skipped = ""
          let p = Updater.skipRolledBack(UpdatePlan.decide(m, myBuild: PSVersion.mine, web: PSVersion.web()), m, manual: manual, why: &skipped)
          if !skipped.isEmpty { why = skipped }
          let k = key(p)
          // Drive syncs the note and the files separately: offer it only once the files are there.
          let files: [(String, Int64)] = {
            switch p { case .none: return []; case .web(let w): return [(w.file, w.size)]; case .app(let a, let w): return [(a.file, a.size), (w.file, w.size)] }
          }()
          let missing = files.first { f in ((try? FileManager.default.attributesOfItem(atPath: dir.appendingPathComponent(f.0).path)[.size]) as? NSNumber)?.int64Value != f.1 }
          if let missing { why = "waiting for Drive to sync \(missing.0)"; q.asyncAfter(deadline: .now() + 120) { [weak self] in self?.checkNow(manual: false) } }
          else if p != .none, refusedHere.contains(k) { why = "\(k) was refused here before, not offered again" }
          else if p != .none, verifiedKey != k {
            // The card only ever offers what will install: every file read, hashed and checked now.
            do { try Updater.verify(p, drive: dir); verifiedKey = k; found = p; manifest = m; driveDir = dir }
            catch let e as UpdateError where e.description.contains("does not match") || e.description.contains("signature") || e.description.contains("not the") || e.description.contains("quarantine") {
              why = "refused: \(e)"; refusedHere.insert(k)
              if case .app(let a, _) = p { Updater.noteRolledBack(a.build, refused: true) }
            } catch { why = "not ready yet: \(error)"; q.asyncAfter(deadline: .now() + 120) { [weak self] in self?.checkNow(manual: false) } }
          }
          else { found = p; manifest = m; driveDir = dir }
        } catch { why = "\(error)" }
      } else { why = channelWhy.isEmpty ? "no update channel" : channelWhy }
      cadence.end(failed: failed)
      rearm()
      let summary = { () -> String in switch found { case .none: return "none" + (why.isEmpty ? "" : " (\(why))"); case .web(let w): return "web \(w.built)"; case .app(let a, _): return "app \(a.build)" } }()
      let foundNote = found == .none ? nil : manifest
      DispatchQueue.main.async { [self] in
        if summary != lastCheck { psLog("PS update: check: \(summary)") }
        lastCheck = summary; lastError = why
        // While Update now runs, a release that came out meanwhile becomes the newest (prepare refuses the older one).
        if let m = foundNote, let n = newest, UpdateLatest.newer(found, than: n.plan) { newest = (found, m) }
        // An update made ready waits for "Relaunch to finish"; a newer one replaces it.
        if let st = staged {
          if found == .none || key(found) == st.key { done?(found); return }
          dropStaged()
        }
        // No card while an install runs or for two minutes after one finished.
        let quiet = lastInstallEnd.map { Date().timeIntervalSince($0) < 120 } ?? false
        if !busy && (!quiet || fromPage) {
          if usePage && !(manual && !fromPage) {
            // The gear menu: change only. A done or stopped update stays until a newer one comes.
            let st = page["state"] as? String ?? "idle"
            if found != .none {
              if st != "available" || key(found) != key(plan) { plan = found; pageSet("available") }
              if !fromPage { nudge() }   // the pop-up, once per update (the developer was not looking at the gear menu)
            }
            else if fromPage { pageSet(why.isEmpty || why.contains("rolled back") || why.contains("quiet") || why.contains("not offered") ? "none" : "error", why.isEmpty ? [:] : ["error": "Could not look for updates: \(why)"]) }
            else if st == "available" || st == "checking" { plan = .none; pageSet("none") }
          } else {
            if found != .none { if manual { offer(found, manual: true) } else { plan = found; nudge() } }
            else if manual { showDone("\(AppName.current) is up to date", why.isEmpty ? "You have the newest version." : "Could not look: \(why).") }
          }
        }
        done?(found)
      }
    }
  }

  /// A look PS starts by itself (the timer, a wake): none while "Check for updates every" is Off.
  private func autoLook() {
    if !UpdatePaths.test && LowPower.shared.asleep("updates") { LowPower.shared.onWake("updates") { [weak self] in self?.q.async { self?.autoLook() } }; return }   // PS 1.65 Low power mode: one look on wake
    guard !cadence.isOff else { return }
    checkNow(manual: false)
  }

  /// The next automatic look: the chosen minutes (5 unless Settings says more) after this one ended, longer after failures
  /// (a test copy keeps its hour). Off: none (a click on Check now still looks).
  private func rearm() {
    guard !UpdatePaths.test, let t = timer else { return }
    t.schedule(deadline: cadence.isOff ? .distantFuture : .now() + cadence.delay, leeway: .seconds(30))
  }

  /// Settings, "Check for updates every" (the Tab list page says it when the vault opens and on every change, {type:"update:every"}):
  /// the new pace counts from the last look, so a shorter wait that is already over looks at once and a longer one waits, with no restart.
  func setEvery(_ minutes: Int) {
    let was = cadence.every, now = cadence.setEvery(minutes)
    if !UpdatePaths.test { UserDefaults.standard.set(now, forKey: Updater.everyKey) }
    guard now != was else { return }
    psLog(now == UpdateCadence.off ? "PS update: automatic looks off (Check now still looks)" : "PS update: looks every \(now) minutes now")
    guard !UpdatePaths.test, let t = timer, !cadence.running else { return }
    if now == UpdateCadence.off { t.schedule(deadline: .distantFuture, leeway: .seconds(5)); return }
    // Back on from Off before any look: the launch wait; otherwise the new pace counts from the last look.
    guard let since = cadence.sinceLastEnd else { if was == UpdateCadence.off { t.schedule(deadline: .now() + UpdateCadence.first, leeway: .seconds(5)) }; return }   // before the first look the launch timer stands
    t.schedule(deadline: .now() + max(1, cadence.delay - since), leeway: .seconds(5))
  }

  private func key(_ p: UpdatePlan) -> String {
    switch p { case .none: return ""; case .web(let w): return "w" + w.built; case .app(let a, _): return "a\(a.build)" }
  }

  private func card() -> UpdateUI {
    if let ui { return ui }
    let u = UpdateUI(install: false)
    u.onClick = { [weak self] id in self?.clicked(id) }
    ui = u
    return u
  }

  /// The update pop-up by itself (UpdateNudge.swift): once per update, Later for a day then once more, and it
  /// waits for Do Not Disturb, 1Password or Signal and any install to end. Main thread.
  func nudge() {
    guard plan != .none, staged == nil else { return }
    // The Tab list is up and shows the update card itself (web views/UpdateFace.tsx): no pop-up over it.
    if usePage && app?.shown == true { return }
    if cardMode == "offer", ui?.window.isVisible == true || hiddenForProtected { return }
    let k = key(plan)
    let quiet = lastInstallEnd.map { Date().timeIntervalSince($0) < 120 } ?? false
    switch nudgeState.step(key: k, now: Date(), dnd: DND.shared.active, protectedFront: Protected.front, busy: busy || quiet || cardMode == "setup") {
    case .show:
      lastWait = ""
      nudgeState.didShow(key: k)
      nudgeState.save(Updater.nudgeFile)
      offer(plan)
    case .wait(let why):
      if why != lastWait { lastWait = why; psLog("PS update: pop-up waits (\(why))") }
    case .quiet: break
    }
  }

  /// main.swift: the Tab list came up. Its page shows the update card in the list itself (V1.40, the developer: "make sure
  /// it comes up in the PS Tab overlay"), so the floating pop-up goes instead of sitting over it.
  func listShown() {
    guard usePage, cardMode == "offer", ui?.window.isVisible == true || hiddenForProtected else { return }
    ui?.close(); hiddenForProtected = false
    psLog("PS update: pop-up gave way to the Tab list's update card")
  }

  /// Do Not Disturb or the app in front changed (main.swift): the card steps aside for 1Password or Signal and
  /// comes back after; a pop-up or setup offer that waited shows now.
  func conditionsChanged() {
    if Protected.front {
      if let ui, ui.window.isVisible { ui.close(); hiddenForProtected = true }
      return
    }
    if hiddenForProtected, let ui {
      hiddenForProtected = false
      ui.present()
    }
    nudge()
    offerSetup()
  }

  /// From the Tab list page (main.swift): this build has the setup menu, generation `gen` (web src/setuphook.ts).
  func setupCan(_ gen: Int) {
    let g = max(0, min(gen, 999))
    if g != setupGen { psLog("PS update: the Tab list page has a setup menu (generation \(g))") }
    setupGen = g
    offerSetup()
  }

  /// After an update, the first launch offers the new setup menu once per generation (SetupOffer in
  /// UpdateNudge.swift): "See what's new and set it up" opens the Tab list and the menu, "Not now" lets it be.
  /// Signed in only (the menu lives in the Tab list), never during Do Not Disturb or over 1Password or Signal.
  func offerSetup() {
    let offering = cardMode == "offer" && (ui?.window.isVisible == true || hiddenForProtected)
    switch setupState.step(gen: setupGen, updated: updatedThisRun, signedIn: app?.vaultUnlocked == true,
                           dnd: DND.shared.active, protectedFront: Protected.front, busy: busy || staged != nil || offering) {
    case .show:
      setupState.didOffer(setupGen)
      setupState.save(Updater.setupFile)
      hideWork?.cancel()
      let u = card()
      u.call("setup", ["title": "Updated to \(PSVersion.name)", "sub": "A quick tour, then switch on what you like."])
      cardMode = "setup"
      u.present()
      psLog("PS update: setup offered (generation \(setupGen))")
    case .wait(let why):
      if why != lastWait { lastWait = why; psLog("PS update: setup offer waits (\(why))") }
    case .quiet: break
    }
  }

  private func offer(_ p: UpdatePlan, manual: Bool = false) {
    if plan == p, cardMode == "offer", ui?.window.isVisible == true { return }
    plan = p
    let size = "\(mb(p.bytes)) MB"
    let sub: String
    switch p {
    case .app(let a, _):
      // Plain words when the last update here did not start (it was rolled back).
      let r = Updater.rolledBack()
      if !r.builds.isEmpty && Date().timeIntervalSince1970 - r.last < 7 * 86400 { sub = "The last update did not start; this is a newer one · \(size)" }
      else { sub = "New app build · \(size)"; _ = a }
    case .web: sub = "Web update · \(size) · no restart"
    case .none: return
    }
    hideWork?.cancel()
    let u = card()
    // V1.40: "Update available", the version and its approved notes (the signed note's, the same for everyone).
    u.call("offer", ["title": manifest?.name.map { "Update available · \($0)" } ?? "Update available", "sub": sub, "notes": manifest?.notes ?? [],
                     // V1.52: one block per version newer than this Mac's, newest first ("V1.51 · Healing" and its lines).
                     "groups": (manifest?.catchUp(installed: PSVersion.name.components(separatedBy: " · ")[0]) ?? []).map { ["title": $0.title, "notes": $0.notes] as [String: Any] }] as [String: Any])
    cardMode = "offer"
    if Protected.front { hiddenForProtected = true } else { u.present() }   // Check for Updates over them: it waits
    psLog("PS update: card shown (\(key(p))\(manual ? ", asked" : ""))")
  }

  private func clicked(_ id: String) {
    log.append("click:\(id)")
    switch id {
    case "install":   // the card: one click does it all, as before
      if !busy, plan != .none { nudgeState.updateNow(key: key(plan)); nudgeState.save(Updater.nudgeFile); install(plan) }
    case "later":
      // No nagging: a day of quiet, then once more; Later again and only the gear's dot is left for this update
      // (UpdateNudge.swift). A newer one and PS > Check for Updates still show.
      if nudgeState.key != key(plan) { nudgeState = UpdateNudge(); nudgeState.didShow(key: key(plan)) }   // the Check for Updates card
      nudgeState.later(now: Date())
      nudgeState.save(Updater.nudgeFile)
      psLog("PS update: Later (\(key(plan)))")
      hide(after: 0)
    case "setup":   // "See what's new and set it up": the Tab list opens with the setup menu (web src/setuphook.ts)
      hide(after: 0)
      psLog("PS update: setup menu asked for\(app == nil ? " (no app yet)" : "")")
      app?.openList(then: "window.__psOpenSetup && window.__psOpenSetup('update')")
    case "notnow": hide(after: 0)
    case "ok": hide(after: 0)
    default: break
    }
  }

  func showDone(_ title: String, _ sub: String) {
    if cardMode == "setup", ui?.window.isVisible == true { return }   // the setup offer already says it updated
    let u = card()
    cardMode = "done"
    u.call("done", ["title": title, "sub": sub, "ok": false])
    u.present()
    hide(after: 3.4)
  }
  func showError(_ title: String, _ sub: String) {
    hideWork?.cancel()
    let u = card()
    cardMode = "error"
    u.call("error", ["title": title, "sub": sub])
    u.present()
  }
  private func hide(after s: Double) {
    hideWork?.cancel()
    let w = DispatchWorkItem { [weak self] in
      self?.ui?.call("hide")
      self?.hiddenForProtected = false
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { if self?.busy == false { self?.ui?.close() } }
    }
    hideWork = w
    DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: w)
  }

  // MARK: installing

  /// Stage folders on the same disk as Applications, so the swap is one rename.
  private func stageRoot() -> URL {
    guard let apps = UpdatePaths.apps else { return UpdatePaths.work }
    try? FileManager.default.createDirectory(at: UpdatePaths.work, withIntermediateDirectories: true)
    return UpdateFiles.sameVolume(UpdatePaths.work, apps) ? UpdatePaths.work : apps.appendingPathComponent(".PS-update", isDirectory: true)
  }

  /// The card's words (when it is the one showing) and the gear menu's state (`step`).
  private func progress(_ title: String, _ sub: String?, phase: String, frac: Double?, detail: String, step: String) {
    if viaPanel || !usePage { ui?.call("progress", ["title": title, "sub": sub as Any? ?? NSNull(), "phase": phase, "frac": frac as Any? ?? NSNull(), "detail": detail]); if ui != nil { cardMode = "progress" } }
    // The menu eases between reports, so 10 a second is plenty (every change of step goes at once).
    if step == "downloading", page["state"] as? String == "downloading", Date().timeIntervalSince(lastPagePush) < 0.1 { return }
    pageSet(step, frac.map { ["progress": $0] } ?? [:])
  }

  /// While an install runs (the developer clicked), App Nap must not slow the copy or the card's animation.
  private var activity: NSObjectProtocol?
  private func working(_ on: Bool) {
    if on, activity == nil { activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated], reason: "PS is installing an update") }
    else if !on, let a = activity { ProcessInfo.processInfo.endActivity(a); activity = nil }
  }

  /// The card's one click: prepare, then finish straight away (the flow before 31 Oct 2026).
  /// V1.51: through the fresh look like the gear (installLatest), so the click gets the newest release.
  func install(_ p: UpdatePlan) {
    viaPanel = true
    installLatest(auto: true)
    Hatch.shared.updateStarted()   // PS 1.67 (Hatch.swift)
  }

  // MARK: Update now installs the newest release (V1.51, UpdateLatest.swift)

  private let newestLock = NSLock()
  private var _newest: (plan: UpdatePlan, manifest: UpdateManifest)?
  /// The newest release the running click knows of: set by its fresh look, moved on by any look while it runs
  /// (checkNow), cleared when it ends. Read by prepare and finish on the updater queue, hence the lock.
  private var newest: (plan: UpdatePlan, manifest: UpdateManifest)? {
    get { newestLock.lock(); defer { newestLock.unlock() }; return _newest }
    set { newestLock.lock(); _newest = newValue; newestLock.unlock() }
  }

  /// The note read fresh from the channel (no ETag, no cache), its files in the mirror, and the plan it gives this
  /// Mac (a build that did not start here is still skipped). Updater queue only.
  private func freshLook() throws -> (UpdateManifest, URL, UpdatePlan) {
    var source = UpdatePaths.drive()
    if source == nil { source = try UpdateChannel.sync(myBuild: PSVersion.mine, web: PSVersion.web(), fresh: true) }
    guard let dir = source else { throw UpdateError("no update channel") }
    let m = try UpdateManifest.open(try Data(contentsOf: dir.appendingPathComponent("ps-update.json")), publicKeys: UpdatePaths.publicKeys)
    guard UpdateRoute.current.takes(m.channel) else { throw UpdateError("the update note is for another PS build") }
    var skipped = ""
    let p = Updater.skipRolledBack(UpdatePlan.decide(m, myBuild: PSVersion.mine, web: PSVersion.web()), m, manual: true, why: &skipped)
    if let f = UpdateChannel.files(p).first(where: { UpdateChannel.size(of: dir.appendingPathComponent($0.0)) != $0.1 }) { throw UpdateError("\(f.0) is not here yet") }
    return (m, dir, p)
  }

  /// "Downloading V1.50" (the card says the version that is really coming).
  private func downloadingTitle() -> String { "Downloading" + (manifest?.version.map { " " + $0 } ?? "") }

  /// Update now (the gear menu, the Tab list's card, the pop-up): the note is read fresh first and the click installs
  /// what THAT names, so a release that came out after the last look is the one that goes in, and the card's number
  /// moves on to it. Offline, the update on the card (already checked here) goes in. `auto`: the pop-up's one click.
  /// `retried`: the second round after a download turned out older than the newest release (prepare, finish).
  private func installLatest(auto: Bool, retried: Bool = false) {
    guard !busy, staged == nil, plan != .none else { return }
    busy = true; working(true); hideWork?.cancel()
    progress(downloadingTitle(), nil, phase: "read", frac: 0, detail: "", step: "downloading")
    let card = plan, cardKey = key(plan)
    q.async { [self] in
      var fresh: (UpdateManifest, URL, UpdatePlan)?, why = ""
      do { fresh = try freshLook() } catch { why = "\(error)" }
      DispatchQueue.main.async { [self] in
        busy = false; working(false)
        let p = UpdateLatest.choose(card: card, fresh: fresh?.2)
        if let f = fresh { manifest = f.0; driveDir = f.1 }
        else { psLog("PS update: could not read the newest note at the click (\(why)), installing the checked \(cardKey)") }
        if p == .none {
          plan = .none; newest = nil
          psLog("PS update: the click found nothing newer than this Mac has")
          pageSet("none")
          if viaPanel || !usePage { showDone("\(AppName.current) is up to date", "You have the newest version.") }
          return
        }
        if key(p) != cardKey { psLog("PS update: the click found a newer release (\(cardKey) to \(key(p))), installing that") }
        else if fresh != nil { psLog("PS update: the click confirmed \(cardKey) is the newest") }
        plan = p
        newest = manifest.map { (p, $0) }
        if refusedHere.contains(key(p)) { failed("the newest release did not pass its checks on this Mac before"); return }
        if key(p) != cardKey { nudgeState.updateNow(key: key(p)); nudgeState.save(Updater.nudgeFile) }
        prepare(p, auto: auto, retried: retried)
      }
    }
  }

  /// "Relaunch to finish": the newest note once more first. A release newer than the one staged replaces it
  /// (Download, Verify, Install again, then straight on); otherwise the staged one goes in.
  private func finishLatest() {
    guard !busy, let st = staged else { return }
    busy = true
    progress("Installing", st.app != nil ? "Swapping in the new app" : "Web files only, the app stays as it is", phase: "busy", frac: 1, detail: "", step: st.app != nil ? "relaunching" : "installing")
    q.async { [self] in
      var fresh: (UpdateManifest, URL, UpdatePlan)?, why = ""
      do { fresh = try freshLook() } catch { why = "\(error)" }
      DispatchQueue.main.async { [self] in
        busy = false
        guard let f = fresh else {
          psLog("PS update: could not read the newest note at Relaunch (\(why)), installing the staged \(st.key)")
          newest = manifest.map { (st.plan, $0) }
          finish(); return
        }
        if UpdateLatest.newer(f.2, than: st.plan) {
          psLog("PS update: a newer release came out while \(st.key) waited (\(key(f.2))), installing that")
          dropStaged()
          manifest = f.0; driveDir = f.1; plan = f.2; newest = (f.2, f.0)
          prepare(f.2, auto: true)
        } else {
          newest = (st.plan, f.0)
          finish()
        }
      }
    }
  }

  /// A check that means "this update is broken", never offered again here (the same words checkNow refuses on).
  static func isRefusal(_ why: String) -> Bool {
    !UpdateLatest.isStale(why) && (why.contains("does not match") || why.contains("signature") || why.contains("not the") || why.contains("quarantine"))
  }

  /// Download, Verify, Install: every file read out of the mirror with real progress and its hash
  /// checked, the web files unpacked and their version checked, the new app unpacked, its build, the developer's
  /// code signature and the missing quarantine flag checked, all staged beside the running build on the
  /// same disk. Nothing running is touched. `auto` (the card) goes straight on to finish.
  func prepare(_ p: UpdatePlan, auto: Bool, retried: Bool = false) {
    guard let dir = driveDir, UpdatePaths.target != nil else { return }
    let dl = downloadingTitle()
    busy = true
    working(true)
    hideWork?.cancel()
    let total = p.bytes
    let fp = FetchProgress()
    var lastFrac = -1.0
    // The card and the menu read the copy's progress 20 times a second, only while it runs.
    poll = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in
      let b = fp.bytes
      if fp.waitingOnDrive && b == 0 {
        self?.progress("Getting it from Google Drive", nil, phase: "drive", frac: nil, detail: "", step: "downloading")
      } else {
        let f = total > 0 ? Double(b) / Double(total) : 0
        if abs(f - lastFrac) > 0.0005 { lastFrac = f; self?.progress(dl, nil, phase: "read", frac: f, detail: "\(mb(b)) of \(mb(total)) MB", step: "downloading") }
      }
    }
    poll!.tolerance = 0.01
    RunLoop.main.add(poll!, forMode: .common)
    progress(dl, nil, phase: "read", frac: 0, detail: "0 of \(mb(total)) MB", step: "downloading")
    psLog("PS update: \(auto ? "install" : "prepare") started (\(key(p)))")
    let stage = stageRoot(), work = UpdatePaths.work, k = key(p)
    // Each step stays on screen long enough to be read (the files are local, so it can be very quick).
    let slow = !auto
    q.async { [self] in
      do {
        let fm = FileManager.default
        let incoming = work.appendingPathComponent("incoming", isDirectory: true)
        defer { try? fm.removeItem(at: incoming) }
        var webZip: URL, appZip: URL?
        var web: UpdateManifest.Web, appInfo: UpdateManifest.App?
        switch p {
        case .none: throw UpdateError("nothing to install")
        case .web(let w): web = w
        case .app(let a, let w): web = w; appInfo = a
        }
        let t0 = Date()
        var base: Int64 = 0
        if let a = appInfo {
          appZip = incoming.appendingPathComponent("app.zip")
          try UpdateFiles.fetch(dir.appendingPathComponent(a.file), to: appZip!, size: a.size, sha256: a.sha256, progress: fp, base: 0)
          base = a.size
        }
        webZip = incoming.appendingPathComponent("web.zip")
        try UpdateFiles.fetch(dir.appendingPathComponent(web.file), to: webZip, size: web.size, sha256: web.sha256, progress: fp, base: base)
        if slow { Updater.atLeast(1.4, since: t0) }
        DispatchQueue.main.async { self.stopPoll(); self.progress("Checking the signature", "Signed by you, every file matches", phase: "busy", frac: 1, detail: "", step: "verifying") }
        let t1 = Date()
        // The web files: their version must be the one the signed note names.
        let webDir = stage.appendingPathComponent("web", isDirectory: true)
        try UpdateFiles.unzip(webZip, into: webDir)
        let webRoot = (try? fm.contentsOfDirectory(atPath: webDir.path))?.contains("index.html") == true ? webDir : webDir.appendingPathComponent("dist-ps", isDirectory: true)
        guard let v = PSVersion.web(at: webRoot), v.src == web.src, v.built == web.built else { throw UpdateError("the web files are not the version the note names") }
        var newApp: URL?
        if let a = appInfo, let appZip {
          let appDir = stage.appendingPathComponent("app", isDirectory: true)
          try UpdateFiles.unzip(appZip, into: appDir)
          let candidate = appDir.appendingPathComponent("PS.app", isDirectory: true)
          try Updater.checkApp(candidate, build: a.build)
          newApp = candidate
        }
        // V1.51: never older than the newest release (a release may have come out while this downloaded).
        if let n = newest {
          if let why = UpdateLatest.staleProblem(installing: p, newest: n.plan) { throw UpdateError(why) }
          if let why = UpdateLatest.packageProblem(appBuild: newApp.flatMap { PSVersion.build(of: $0) }, appVersion: newApp.flatMap { PSVersion.short(of: $0)?.0 },
                                                   webVersion: PSVersion.webName(at: webRoot)?.0, newest: n.manifest, plan: p) { throw UpdateError(why) }
        }
        // Let the check be seen (it is very quick), then install.
        Updater.atLeast(slow ? 1.2 : 0.9, since: t1)
        if auto {
          DispatchQueue.main.async {
            self.staged = Staged(plan: p, key: k, webDir: webDir, webRoot: webRoot, app: newApp)
            self.finish(retried: retried)
          }
          return
        }
        DispatchQueue.main.async { self.progress("Installing", nil, phase: "busy", frac: 1, detail: "", step: "installing") }
        let t2 = Date()
        // The staged build once more, exactly as it will go in (also proves the stage folder holds it whole).
        if let newApp, let a = appInfo { try Updater.checkApp(newApp, build: a.build) }
        Updater.atLeast(1.0, since: t2)
        DispatchQueue.main.async {
          self.staged = Staged(plan: p, key: k, webDir: webDir, webRoot: webRoot, app: newApp)
          self.busy = false; self.working(false)
          psLog("PS update: \(k) ready, waiting for Relaunch to finish")
          self.pageSet("ready")
        }
      } catch {
        DispatchQueue.main.async { self.stoppedOrRetry("\(error)", plan: p, auto: auto, retried: retried) }
      }
    }
  }

  /// A download older than the newest release: thrown away, the newest fetched and installed instead (once).
  /// Any other failure stops as before; one that failed a check is never offered again here.
  private func stoppedOrRetry(_ why: String, plan p: UpdatePlan, auto: Bool, retried: Bool) {
    if UpdateLatest.isStale(why), !retried {
      stopPoll(); busy = false; working(false)
      psLog("PS update: refused: \(why); fetching the newest")
      plan = p   // installLatest reads the note again and moves on from here
      installLatest(auto: auto, retried: true)
      return
    }
    if Updater.isRefusal(why) {
      refusedHere.insert(key(p))
      if case .app(let a, _) = p { Updater.noteRolledBack(a.build, refused: true) }
    }
    failed(why)
  }

  /// Every check an app must pass before it may go in (prepare, and again in finish).
  static func checkApp(_ app: URL, build: Int) throws {
    guard PSVersion.build(of: app) == build else { throw UpdateError("the app is not the build the note names") }
    if let why = UpdateFiles.signatureProblem(app) { throw UpdateError("the new app failed the code signature check: \(why)") }
    guard UpdateFiles.quarantined(app) == 0 else { throw UpdateError("the new app still carries the quarantine flag") }
  }
  /// Off the main thread only: waits until `s` seconds have passed since `t`.
  static func atLeast(_ s: Double, since t: Date) {
    let spent = Date().timeIntervalSince(t)
    if spent < s { Thread.sleep(forTimeInterval: s - spent) }
  }

  /// "Relaunch to finish": the staged files are checked again (they waited on disk), then the web files
  /// go in and the app is swapped in exactly as before (helper, hand over, roll back). A web-only
  /// update reloads the pages instead.
  func finish(retried: Bool = false) {
    guard let st = staged, let target = UpdatePaths.target else { return }
    busy = true
    working(true)
    let appUpdate = st.app != nil
    progress("Installing", appUpdate ? "Swapping in the new app" : "Web files only, the app stays as it is", phase: "busy", frac: 1, detail: "", step: appUpdate ? "relaunching" : "installing")
    let stage = stageRoot()
    q.async { [self] in
      do {
        let fm = FileManager.default
        var web: UpdateManifest.Web, appInfo: UpdateManifest.App?
        switch st.plan {
        case .none: throw UpdateError("nothing to install")
        case .web(let w): web = w
        case .app(let a, let w): web = w; appInfo = a
        }
        guard let v = PSVersion.web(at: st.webRoot), v.src == web.src, v.built == web.built else { throw UpdateError("the web files changed while they waited") }
        if let n = newest, let why = UpdateLatest.staleProblem(installing: st.plan, newest: n.plan) { throw UpdateError(why) }
        if let newApp = st.app, let a = appInfo { try Updater.checkApp(newApp, build: a.build) }
        try UpdateFiles.installWeb(from: st.webRoot, to: UpdatePaths.web)
        if let newApp = st.app, let a = appInfo {
          try swapIn(newApp, target: target, stage: stage, to: a.build)
        } else {
          try? fm.removeItem(at: st.webDir)
          Thread.sleep(forTimeInterval: 0.5)
          DispatchQueue.main.async {
            psLog("PS update: web files \(web.built) installed")
            self.app?.checkLocalUpdate()          // reloads the pages as soon as that is safe
            self.busy = false; self.staged = nil; self.plan = .none; self.newest = nil; self.working(false); self.lastInstallEnd = Date()
            self.pageSet("done", ["kind": "web"], unseen: true)   // the Tab list's card says "Updated to" once
            // PS 1.67: no relaunch, so this same run finishes the icon and plays the rest (Hatch.swift).
            if !Hatch.shared.afterUpdate(sameRun: true) { Island.shared.updateDone(version: Updater.parts(PSVersion.name).0) }   // PS 1.60: the island's own short moment
            else { Cake.shared.revealOnce() }   // PS Cake: the logo reveal once, after the update scene (as after a relaunch)
            self.updatedThisRun = true   // the reloaded page may bring a setup menu (setup:can)
            if self.viaPanel || !self.usePage { self.showDone("\(AppName.current) updated", "Now on \(PSVersion.name). No restart needed.") }
          }
        }
      } catch {
        DispatchQueue.main.async { self.staged = nil; self.stoppedOrRetry("\(error)", plan: st.plan, auto: true, retried: retried) }
      }
    }
  }

  /// A newer update replaced the one waiting: its staged files go.
  private func dropStaged() {
    guard let st = staged else { return }
    staged = nil
    q.async {
      try? FileManager.default.removeItem(at: st.webDir)
      if let a = st.app { try? FileManager.default.removeItem(at: a.deletingLastPathComponent()) }
    }
  }

  private func stopPoll() { poll?.invalidate(); poll = nil }

  private func failed(_ why: String) {
    stopPoll()
    busy = false; lastInstallEnd = Date(); newest = nil
    working(false)
    lastError = why
    psLog("PS update: stopped: \(why)")
    let said = "\(why.prefix(1).uppercased())\(why.dropFirst())"
    pageSet("error", ["error": said], unseen: !(app?.shown ?? false))
    if viaPanel || !usePage { showError("Update stopped", "\(said). Nothing was changed.") }
  }

  /// The app swap (on the updater queue): one atomic rename, then the helper and a restart.
  private func swapIn(_ newApp: URL, target: URL, stage: URL, to: Int) throws {
    let fm = FileManager.default
    let from = PSVersion.mine
    let previous = stage.appendingPathComponent("previous/PS-\(from)", isDirectory: true)
    let failed = stage.appendingPathComponent("failed/PS-\(to)", isDirectory: true)
    try? fm.removeItem(at: stage.appendingPathComponent("previous"))     // only the newest previous build is kept
    try fm.createDirectory(at: previous.deletingLastPathComponent(), withIntermediateDirectories: true)
    let keys = UpdateHandoff.collect()
    try UpdateFiles.swap(newApp, target)                // newApp's folder now holds the old build
    try fm.moveItem(at: newApp, to: previous)
    try? fm.removeItem(at: newApp.deletingLastPathComponent())
    let j = UpdateJournal(phase: "swapped", from: from, to: to, target: target.path, previous: previous.path, failed: failed.path,
                          socket: UpdateHandoff.socketPath(in: UpdatePaths.work), attempts: 0, at: Date().timeIntervalSince1970, shown: false, test: UpdatePaths.test)
    j.write()
    // The helper is the OLD build's binary, which can still read nothing new: it only passes on what we hand it.
    let h = Process()
    h.executableURL = previous.appendingPathComponent("Contents/MacOS/PS")
    // The helper waits for this PS to quit first (a test copy that stays to check the result: 0).
    h.arguments = ["--ps-update-helper", UpdatePaths.journal.path, UpdatePaths.test && testHold ? "0" : String(getpid())]
    let pipe = Pipe()
    h.standardInput = pipe
    if UpdatePaths.test { h.standardOutput = FileHandle.standardOutput; h.standardError = FileHandle.standardError }
    else { h.standardOutput = FileHandle.nullDevice; h.standardError = FileHandle.nullDevice }
    try h.run()
    pipe.fileHandleForWriting.write(keys)
    try? pipe.fileHandleForWriting.close()
    helper = h
    psLog("PS update: app swapped (\(from) to \(to)), helper \(h.processIdentifier) takes over")
    DispatchQueue.main.async {
      self.progress("Restarting \(AppName.current)", "Back in a moment", phase: "busy", frac: 1, detail: "", step: "relaunching")
      Hatch.shared.relaunching(to: to, version: self.manifest?.version)   // PS 1.67: how far the icon got goes to the new build (Hatch.swift)
      if UpdatePaths.test && self.testHold { return }   // the test copy waits for the helper instead
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { NSApp.terminate(nil) }
    }
  }
  private(set) var helper: Process?

  // MARK: this Mac's own release (build.sh)

  private func installLocalRequest() {
    let reqURL = UpdatePaths.work.appendingPathComponent("local-request.json"), resURL = UpdatePaths.work.appendingPathComponent("local-result.json")
    func answer(_ ok: Bool, _ why: String) {
      if let d = try? JSONSerialization.data(withJSONObject: ["ok": ok, "why": why, "pid": getpid()]) { try? d.write(to: resURL, options: .atomic) }
    }
    guard !busy, let d = FileManager.default.contents(atPath: reqURL.path), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
          let appPath = o["app"] as? String, let webPath = o["web"] as? String, let target = UpdatePaths.target else { return }
    try? FileManager.default.removeItem(at: reqURL)
    let src = URL(fileURLWithPath: appPath), web = URL(fileURLWithPath: webPath)
    busy = true
    working(true)
    // Quiet: the gear menu shows it (the card only on a Mac whose Tab list page never said hello).
    viaPanel = !usePage
    pageSet("relaunching", ["kind": "app"])
    if viaPanel {
      let u = card()
      u.call("progress", ["title": "Installing your new build", "sub": "From this Mac's release", "phase": "busy", "frac": 1, "detail": ""])
      u.present()
    }
    let stage = stageRoot()
    q.async { [self] in
      do {
        guard let b = PSVersion.build(of: src), b > PSVersion.mine else { throw UpdateError("that build is not newer than this one") }
        if let why = UpdateFiles.signatureProblem(src) { throw UpdateError("the new build failed the code signature check: \(why)") }
        let copy = stage.appendingPathComponent("app/PS.app", isDirectory: true)
        try? FileManager.default.removeItem(at: copy.deletingLastPathComponent())
        try FileManager.default.createDirectory(at: copy.deletingLastPathComponent(), withIntermediateDirectories: true)
        try UpdateFiles.run("/usr/bin/ditto", ["--noqtn", src.path, copy.path])
        if let why = UpdateFiles.signatureProblem(copy) { throw UpdateError("the copy failed the code signature check: \(why)") }
        try UpdateFiles.installWeb(from: web, to: UpdatePaths.web)
        answer(true, "installing build \(b)")
        try swapIn(copy, target: target, stage: stage, to: b)
      } catch {
        answer(false, "\(error)")
        DispatchQueue.main.async { self.failed("\(error)") }
      }
    }
  }
}
