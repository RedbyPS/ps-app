// The Soundboard on a Mac (V1.47). The developer, 10 Nov 2026: "on the bottom right of the GOS app add a Soundboard button ...
// It pops up full screen with all your audio and video files ... set it to play at a time of day, say 7:07am. Very
// easily add new files: right click anywhere, Add new audio file, and Add folder ... Stored locally, and you can change
// the storage location." The page (web src/soundboard/) draws everything and plays the files; this file keeps
// them, serves them, imports, moves the storage folder and rings the timed plays. The contract with the page is
// v147-soundboard-contract.md (message names and shapes fixed there); the pure rules are in SoundboardMath.swift.
//
// - Files: `~/Music/PS Soundboard` by default, or a folder picked with PS's Open panel (kept in this Mac's defaults,
//   "sb.folder"; PS is not sandboxed, so no security scoped bookmark is needed). Readable layout `<root>/<folder>/<name>`,
//   the index in `<root>/.ps-soundboard.json`. Files copied in with Finder are picked up on the next `sb:get`; index
//   entries whose file is gone are dropped then. Imports are copies: a file is never changed where it came from.
// - Safety rule: PS only ever deletes files PS itself put there (index `own`: imports, drops, squad sounds, copies
//   made while moving). Files found in the folder (someone may pick their own Music folder) are adopted: Remove only
//   takes them off the list (`ignored` in the index, so they do not come back) and a move leaves them where they were.
// - Copies arrive in `<root>/.ps-incoming` (hidden, so a look at the folder never sees a half copied file) and are
//   moved into place under a free name once whole.
// - Moving the storage: every file copied to the new folder and its size checked, the index written there, and only
//   then are the old copies deleted. Any failure deletes the partial new copies and keeps the old folder.
// - Serving: ps://app/client/media/<id>.<ext> (main.swift AppFiles), byte ranges for seeking, never outside the folder.
// - Native file drops on the Tab list (SecondDrop.swift's web view): while the page says `sb:open` on, audio, video and
//   folders dropped there come here instead of the page or Second Computer.
// - Timed plays (`sb:plan`): kept in Application Support/PS/soundboard-plan.json, one timer for the next due time,
//   re-armed after wake and clock or time zone changes. A ring plays the file with AVPlayer (a video plays its sound)
//   with this Mac's volume set to the alarm level and put back after (as SleepSound and Sleep mode's alarms do), and
//   shows a small card with Stop. Esc stops it (main.swift escKey and the keyboard tap). Do Not Disturb: it rings
//   through, the same rule as Sleep mode's alarms (SleepScreen.swift), which are PS's own alarms on this Mac.
// - Golden rule: the card steps aside while 1Password or Signal is in front (only whether one is in front is read).
// Nothing on the main thread blocks: the index and small work on `ioQ`, copies on `jobQ`, serving on `serveQ`, the
// volume on `volQ`. A self test copy (PS_SELFTEST) keeps its own folder under its test dir, never opens a panel, never
// plays a sound and never touches the volume.
import AppKit
import AVFoundation
import UniformTypeIdentifiers
import WebKit

final class SbCardPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class Soundboard: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = Soundboard()

  /// Both pages (main.swift): `lib`, `ring` and `ringEnd` go to each.
  var pages: () -> [WKWebView] = { [] }
  /// The Tab list steps aside for an Open panel (main.swift).
  var beforePanel: () -> Void = {}
  var volumeGet: () -> (volume: Float, muted: Bool)? = { SleepHW.volume() }
  var volumeSet: (Float, Bool) -> Void = { SleepHW.setVolume($0, muted: $1) }

  private let testDir = ProcessInfo.processInfo.environment["PS_SELFTEST"]
  private var test: Bool { testDir != nil }
  private let fm = FileManager.default

  private let ioQ = DispatchQueue(label: "ps.soundboard.io", qos: .userInitiated)
  private let jobQ = DispatchQueue(label: "ps.soundboard.job", qos: .userInitiated)
  private let serveQ = DispatchQueue(label: "ps.soundboard.serve", qos: .userInitiated, attributes: .concurrent)
  private let volQ = DispatchQueue(label: "ps.soundboard.volume", qos: .userInitiated)

  // ---------- on ioQ ----------
  private var root: URL
  private var custom: Bool
  private var index: [SbMath.Item] = []
  private var ignored: [String] = []     // adopted files taken off the list: they stay on disk, never added back
  private var indexFor = ""          // the folder the index in memory was read from
  private var sizes: [String: Int64] = [:]
  private var moving = false
  private var missing = false        // the chosen folder is not there (a drive unplugged)
  private struct Put { var name: String; var ext: String; var size: Int64; var at: Date }
  private var puts: [String: Put] = [:]

  // ---------- read anywhere (lock) ----------
  private let lock = NSLock()
  private var filesById: [String: URL] = [:]
  private var rootPath = ""
  private static let ringLock = NSLock()
  private static var ringFlag = false
  /// A timed play is playing now (the keyboard tap reads it for Esc, from its own thread).
  static var ringingNow: Bool { ringLock.lock(); defer { ringLock.unlock() }; return ringFlag }
  private static func setRinging(_ v: Bool) { ringLock.lock(); ringFlag = v; ringLock.unlock() }

  // ---------- main thread ----------
  private var openPages = Set<ObjectIdentifier>()
  private var plan: [SbMath.Plan] = []
  private var timer: Timer?
  private var lastCheck = Date()
  private var started = false

  private final class Ring {
    let plan: SbMath.Plan
    var player: AVPlayer?
    var fallback: AVAudioPlayer?
    var observers: [NSObjectProtocol] = []
    var status: NSKeyValueObservation?
    var end: DispatchWorkItem?
    var savedVolume: (volume: Float, muted: Bool)?
    var panel: SbCardPanel?
    var web: WKWebView?
    var ready = false
    let at: Date
    init(plan: SbMath.Plan, at: Date) { self.plan = plan; self.at = at }
  }
  private var ring: Ring?
  private var ringGen = 0

  private override init() {
    let d = Soundboard.defaultRoot()
    if ProcessInfo.processInfo.environment["PS_SELFTEST"] == nil, let s = UserDefaults.standard.string(forKey: "sb.folder"), s.hasPrefix("/") {
      root = URL(fileURLWithPath: s, isDirectory: true); custom = root.standardizedFileURL.path != d.standardizedFileURL.path
    } else { root = d; custom = false }
    super.init()
  }

  /// `~/Music/PS Soundboard`, or a test copy's own folder under its test dir (never ~/Music).
  static func defaultRoot() -> URL {
    if let t = ProcessInfo.processInfo.environment["PS_SELFTEST"] { return URL(fileURLWithPath: t, isDirectory: true).appendingPathComponent("soundboard", isDirectory: true) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Music/PS Soundboard", isDirectory: true)
  }
  private var planFile: URL {
    if let t = testDir { return URL(fileURLWithPath: t, isDirectory: true).appendingPathComponent("soundboard-plan.json") }
    return fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PS/soundboard-plan.json")
  }

  // MARK: start

  /// At launch (main thread): the index read so files can be served and rung before the page asks, the plan re-armed.
  func start() {
    guard !started else { return }
    started = true
    ioQ.async { [self] in
      _ = refresh()
      let pf = planFile
      let saved = (try? Data(contentsOf: pf)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
      DispatchQueue.main.async { [self] in
        plan = SbMath.plan(saved)
        lastCheck = Date()
        if !plan.isEmpty { psLog("PS soundboard: \(plan.count) timed plays armed") }
        arm()
      }
    }
    let ws = NSWorkspace.shared.notificationCenter
    ws.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.arm() }
    for n in [Notification.Name.NSSystemClockDidChange, .NSSystemTimeZoneDidChange] {
      NotificationCenter.default.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in NSTimeZone.resetSystemTimeZone(); self?.arm() }
    }
  }

  // MARK: the bridge (main thread)

  /// Every `sb:*` message from the Tab list page or the main page. True: it was this one's.
  @discardableResult func handle(_ type: String, _ msg: [String: Any], from web: WKWebView?) -> Bool {
    guard type.hasPrefix("sb:") else { return false }
    let page = web.map { Weak($0) }
    switch type {
    case "sb:get":
      ioQ.async { [self] in
        let l = refresh(), gone = missing
        sendAll(l)
        if gone { error("The Soundboard folder is not there. Plug its drive in or choose another folder.", to: page) }
      }
    case "sb:add": pickFiles(folder: msg["what"] as? String == "folder", page: page)
    case "sb:remove": remove(((msg["ids"] as? [Any]) ?? []).compactMap { $0 as? String }.filter(SbMath.isId), page: page)
    case "sb:rename": rename(msg["id"] as? String ?? "", msg["name"] as? String, page: page)
    case "sb:location": location(msg["act"] as? String ?? "", page: page)
    case "sb:plan": setPlan(msg["items"])
    case "sb:stop": stopRing("stop")
    case "sb:open":
      guard let web else { break }
      if (msg["on"] as? Bool) == true { openPages.insert(ObjectIdentifier(web)) } else { openPages.remove(ObjectIdentifier(web)) }
    case "sb:read": read(msg, page: page)
    case "sb:put": put(msg, page: page)
    default: break
    }
    return true
  }
  /// The page in this web view said the Soundboard is open (file drops on it come here).
  func isOpen(_ web: WKWebView) -> Bool { openPages.contains(ObjectIdentifier(web)) }

  private final class Weak { weak var web: WKWebView?; init(_ w: WKWebView) { web = w } }
  /// One event to one page (main thread). Values go in as an argument, never as code.
  private func send(_ m: [String: Any], to page: Weak?) {
    let go: () -> Void = { page?.web?.callAsyncJavaScript("window.__psSb && window.__psSb(m)", arguments: ["m": m], in: nil, in: .page, completionHandler: nil) }
    if Thread.isMainThread { go() } else { DispatchQueue.main.async(execute: go) }
  }
  private func sendAll(_ m: [String: Any]) {
    let go = { for w in self.pages() { w.callAsyncJavaScript("window.__psSb && window.__psSb(m)", arguments: ["m": m], in: nil, in: .page, completionHandler: nil) } }
    if Thread.isMainThread { go() } else { DispatchQueue.main.async(execute: go) }
  }
  private func error(_ text: String, to page: Weak?) { send(["ev": "error", "text": text], to: page) }

  // MARK: the index (ioQ)

  private var indexFile: URL { root.appendingPathComponent(".ps-soundboard.json") }
  private var incoming: URL { root.appendingPathComponent(".ps-incoming", isDirectory: true) }
  private func rootExists() -> Bool { var d: ObjCBool = false; return fm.fileExists(atPath: root.path, isDirectory: &d) && d.boolValue }

  /// The index in `dir`: its entries (an old entry without `own` is PS's only in the default folder) and ignored paths.
  private static func readIndex(_ dir: URL) -> (items: [SbMath.Item], ignored: [String]) {
    guard let d = try? Data(contentsOf: dir.appendingPathComponent(".ps-soundboard.json")), let j = try? JSONSerialization.jsonObject(with: d) else { return ([], []) }
    let inDefault = dir.resolvingSymlinksInPath().standardizedFileURL.path == defaultRoot().resolvingSymlinksInPath().standardizedFileURL.path
    return (SbMath.items(j, inDefault: inDefault), SbMath.ignored(j))
  }
  private func loadIndex() { let r = Soundboard.readIndex(root); index = r.items; ignored = r.ignored; indexFor = root.path }
  private func saveIndex() {
    guard let d = try? JSONSerialization.data(withJSONObject: SbMath.indexJSON(index, ignored: ignored), options: [.sortedKeys]) else { return }
    do { try d.write(to: indexFile, options: .atomic) } catch { psLog("PS soundboard: the index could not be written") }
  }
  /// Every audio and video file under `dir` (relative paths and sizes), hidden ones and packages skipped, at most
  /// SbMath.maxDepth folders down. Symbolic links are not followed.
  static func scan(_ dir: URL) -> [(path: String, size: Int64)] {
    let base = dir.resolvingSymlinksInPath()
    let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .isSymbolicLinkKey, .fileSizeKey]
    guard let e = FileManager.default.enumerator(at: base, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
    let prefix = base.path.hasSuffix("/") ? base.path : base.path + "/"
    var out: [(String, Int64)] = []
    for case let u as URL in e {
      guard u.path.hasPrefix(prefix) else { continue }
      let rel = String(u.path.dropFirst(prefix.count))
      let v = try? u.resourceValues(forKeys: Set(keys))
      if v?.isDirectory == true {
        if rel.split(separator: "/").count > SbMath.maxDepth { e.skipDescendants() }
        continue
      }
      guard v?.isRegularFile == true, v?.isSymbolicLink != true, SbMath.pathOk(rel) else { continue }
      out.append((rel, Int64(v?.fileSize ?? 0)))
    }
    return out
  }
  /// The index against the folder: read (when the folder changed), merged with what is on disk, saved when changed,
  /// the served files updated. Returns the `lib` event.
  private func refresh() -> [String: Any] {
    missing = false
    if !rootExists() {
      index = []; ignored = []; sizes = [:]; indexFor = ""
      missing = custom
    } else {
      if indexFor != root.path { loadIndex() }
      let found = Soundboard.scan(root)
      sizes = Dictionary(found.map { ($0.path, $0.size) }, uniquingKeysWith: { a, _ in a })
      let m = SbMath.merge(index, files: found.map(\.path), ignored: ignored, now: (Date().timeIntervalSince1970 * 1000).rounded())
      index = m.items; ignored = m.ignored
      if m.changed { saveIndex(); psLog("PS soundboard: index of \(index.count)") }
    }
    publish()
    return lib()
  }
  /// The served files (lock): id to file.
  private func publish() {
    var m: [String: URL] = [:]
    for i in index { m[i.id] = root.appendingPathComponent(i.path) }
    let rp = root.resolvingSymlinksInPath().standardizedFileURL.path
    lock.lock(); filesById = m; rootPath = rp; lock.unlock()
  }
  private func lib() -> [String: Any] {
    let items: [[String: Any]] = index.map { i in
      let e = SbMath.ext(i.path)
      return ["id": i.id, "name": i.name, "ext": e, "kind": SbMath.kind(e) ?? "audio", "size": sizes[i.path] ?? 0, "folder": SbMath.folder(i.path), "added": i.added]
    }
    let label = SbMath.label(root.standardizedFileURL.path, home: fm.homeDirectoryForCurrentUser.standardizedFileURL.path)
    return ["ev": "lib", "items": items, "loc": ["label": label, "custom": custom]]
  }
  /// Makes the folder when it is the default one (created on first add). A chosen folder that is gone is not made.
  private func ensureRoot() -> String? {
    if rootExists() { return nil }
    if custom { return "The Soundboard folder is not there. Plug its drive in or choose another folder." }
    do { try fm.createDirectory(at: root, withIntermediateDirectories: true) } catch { return "PS app could not make the Soundboard folder." }
    indexFor = root.path; index = []; ignored = []
    return nil
  }
  /// A whole copy in `.ps-incoming` goes to its place: a free name in `dir` (relative), the index told. ioQ.
  private func land(_ tmp: URL, dir: String, name: String) -> Bool {
    if indexFor != root.path { loadIndex() }
    let d = dir.isEmpty ? root : root.appendingPathComponent(dir, isDirectory: true)
    do {
      try fm.createDirectory(at: d, withIntermediateDirectories: true)
      let there = Set((try? fm.contentsOfDirectory(atPath: d.path)) ?? []).union(index.filter { SbMath.folder($0.path) == dir }.map { ($0.path as NSString).lastPathComponent })
      let n = SbMath.uniqueName(name, taken: there)
      let rel = dir.isEmpty ? n : dir + "/" + n
      guard SbMath.pathOk(rel) else { try? fm.removeItem(at: tmp); return false }
      try fm.moveItem(at: tmp, to: root.appendingPathComponent(rel))
      var id = SbMath.newId()
      while index.contains(where: { $0.id == id }) { id = SbMath.newId() }
      index.append(SbMath.Item(id: id, path: rel, name: SbMath.displayName(n), added: (Date().timeIntervalSince1970 * 1000).rounded(), own: true))   // PS wrote it: PS's own
      sizes[rel] = ((try? fm.attributesOfItem(atPath: root.appendingPathComponent(rel).path)[.size]) as? NSNumber)?.int64Value ?? 0
      return true
    } catch {
      try? fm.removeItem(at: tmp)
      return false
    }
  }

  // MARK: import

  private static let pickTypes: [UTType] = [.audio, .movie, .audiovisualContent]
    + (SbMath.audio.union(SbMath.video)).sorted().compactMap { UTType(filenameExtension: $0) }

  private func pickFiles(folder: Bool, page: Weak?) {
    guard !test else { ioQ.async { [self] in let l = refresh(); sendAll(l) }; return }
    beforePanel()
    let p = NSOpenPanel()
    if folder {
      p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
      p.prompt = "Add folder"; p.message = "Pick a folder. PS app copies its audio and video files into your Soundboard."
    } else {
      p.canChooseDirectories = false; p.canChooseFiles = true; p.allowsMultipleSelection = true
      p.allowedContentTypes = Soundboard.pickTypes
      p.prompt = "Add"; p.message = "Pick audio or video files. PS app copies them into your Soundboard."
    }
    if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    p.begin { [weak self] r in
      guard r == .OK, !p.urls.isEmpty else { return }
      self?.importURLs(p.urls, page: page)
    }
  }
  /// Files dropped on the Tab list while the Soundboard is open (SecondDrop.swift).
  func dropped(_ urls: [URL], from web: WKWebView) {
    guard !urls.isEmpty else { return }
    psLog("PS soundboard: \(urls.count) dropped")
    importURLs(urls, page: Weak(web))
  }
  /// The drag hovering over the Tab list (on) or gone (off).
  func dragging(_ on: Bool, web: WKWebView) { send(["ev": "drag", "on": on], to: Weak(web)) }
  /// Whether a drag carries files the Soundboard may take: audio or video files, or folders (cheap, names only).
  static func canTake(_ pb: NSPasteboard) -> Bool {
    guard pb.availableType(from: [.fileURL]) != nil,
          let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] else { return false }
    return urls.contains { $0.hasDirectoryPath || $0.pathExtension.isEmpty || SbMath.kind($0.pathExtension) != nil }
  }
  static func dropURLs(_ pb: NSPasteboard) -> [URL] {
    (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
  }

  private struct Entry { let src: URL; let dir: String; let name: String; let size: Int64 }
  /// What a pick or a drop brings: each file at the top, each folder under its own name with its subfolders (at most
  /// SbMath.maxDepth folders), hidden ones left out. `skipped`: files that are not audio or video, empty or too big.
  private func entries(_ urls: [URL], rootReal: String) -> (list: [Entry], skipped: Int) {
    var list: [Entry] = [], skipped = 0
    let keys: [URLResourceKey] = [.isRegularFileKey, .isDirectoryKey, .fileSizeKey, .isPackageKey]
    func inRoot(_ u: URL) -> Bool { let p = u.path; return p == rootReal || p.hasPrefix(rootReal + "/") }
    func file(_ u: URL, dir: String) {
      let v = try? u.resourceValues(forKeys: Set(keys)), size = Int64(v?.fileSize ?? 0)
      guard v?.isRegularFile == true, SbMath.kind(u.pathExtension) != nil, size > 0, size <= SbMath.maxFile, !inRoot(u) else { skipped += 1; return }
      list.append(Entry(src: u, dir: dir, name: SbMath.safeFileName(u.lastPathComponent, fallback: "Sound." + u.pathExtension.lowercased()), size: size))
    }
    for raw in urls {
      let u = raw.resolvingSymlinksInPath()
      if u.lastPathComponent.hasPrefix(".") { continue }
      let v = try? u.resourceValues(forKeys: Set(keys))
      guard v?.isDirectory == true, v?.isPackage != true else { file(u, dir: ""); continue }
      if inRoot(u) { continue }
      let top = SbMath.safeFileName(u.lastPathComponent, fallback: "Folder")
      let base = u.path.hasSuffix("/") ? u.path : u.path + "/"
      guard let e = fm.enumerator(at: u, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
      for case let c as URL in e {
        guard c.path.hasPrefix(base) else { continue }
        let rel = String(c.path.dropFirst(base.count)), parts = rel.split(separator: "/").map(String.init)
        if (try? c.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true {
          if 1 + parts.count > SbMath.maxDepth { e.skipDescendants() }
          continue
        }
        file(c, dir: ([top] + parts.dropLast()).joined(separator: "/"))
      }
    }
    return (list, skipped)
  }

  /// Copies picked or dropped files in, one job at a time, with progress; then `added` and `lib`.
  private func importURLs(_ urls: [URL], page: Weak?) {
    jobQ.async { [self] in
      var scoped: [URL] = []
      for u in urls where u.startAccessingSecurityScopedResource() { scoped.append(u) }
      defer { scoped.forEach { $0.stopAccessingSecurityScopedResource() } }
      var rootReal = "", why: String?
      ioQ.sync { why = ensureRoot(); rootReal = root.resolvingSymlinksInPath().standardizedFileURL.path }
      if let why { error(why, to: page); return }
      let (list, skippedFirst) = entries(urls, rootReal: rootReal)
      var skipped = skippedFirst, n = 0
      let total = list.count
      if total > 0 { send(["ev": "progress", "done": 0, "total": total, "name": SbMath.displayName(list[0].name)], to: page) }
      for (k, e) in list.enumerated() {
        var tmpDir: URL!
        ioQ.sync { tmpDir = incoming }
        let tmp = tmpDir.appendingPathComponent(UUID().uuidString.lowercased() + "." + e.src.pathExtension.lowercased())
        var ok = false
        do {
          try fm.createDirectory(at: tmpDir, withIntermediateDirectories: true)
          try fm.copyItem(at: e.src, to: tmp)   // a stream copy (an APFS clone on the same volume): never the whole file in memory
          let got = ((try? fm.attributesOfItem(atPath: tmp.path)[.size]) as? NSNumber)?.int64Value ?? -1
          if got == e.size { ioQ.sync { ok = land(tmp, dir: e.dir, name: e.name) } } else { try? fm.removeItem(at: tmp) }
        } catch { try? fm.removeItem(at: tmp) }
        if ok { n += 1 } else { skipped += 1 }
        if n > 0 && n % 25 == 0 { ioQ.sync { saveIndex(); publish() } }
        send(["ev": "progress", "done": k + 1, "total": total, "name": SbMath.displayName(k + 1 < total ? list[k + 1].name : e.name)], to: page)
      }
      var l: [String: Any] = [:]
      ioQ.sync {
        if n > 0 { saveIndex() }
        if (try? fm.contentsOfDirectory(atPath: incoming.path))?.isEmpty == true { try? fm.removeItem(at: incoming) }   // a squad sound may be arriving
        l = refresh()
      }
      DispatchQueue.main.async { psLog("PS soundboard: \(n) added, \(skipped) skipped") }
      send(["ev": "added", "n": n, "skipped": skipped], to: page)
      sendAll(l)
    }
  }

  // MARK: remove, rename

  private func remove(_ ids: [String], page: Weak?) {
    ioQ.async { [self] in
      if moving { error("Wait for the Soundboard to finish moving, then try again.", to: page); return }
      if indexFor != root.path { _ = refresh() }
      let rp = root.resolvingSymlinksInPath().standardizedFileURL.path
      var gone = 0
      for id in Set(ids) {
        guard let i = index.first(where: { $0.id == id }) else { continue }
        let what = SbMath.removal(i)
        if let p = what.ignore {   // adopted: off the list only, the file is never touched
          index.removeAll { $0.id == id }; if !ignored.contains(p) { ignored.append(p) }; gone += 1
          continue
        }
        let f = root.appendingPathComponent(i.path)
        let real = f.resolvingSymlinksInPath().standardizedFileURL.path
        guard real.hasPrefix(rp + "/") else { continue }
        // PS's own copy only: to the Bin (the user can still get it back), or deleted when the Bin cannot take it.
        if (try? fm.trashItem(at: f, resultingItemURL: nil)) == nil { try? fm.removeItem(at: f) }
        if !fm.fileExists(atPath: f.path) {
          index.removeAll { $0.id == id }; gone += 1
          pruneEmpty(SbMath.folder(i.path), under: root)
        }
      }
      if gone > 0 { saveIndex() }
      let l = refresh()
      DispatchQueue.main.async { psLog("PS soundboard: \(gone) removed") }
      sendAll(l)
    }
  }
  /// Empty folders left behind go, up to (never including) the storage folder. Only ones with nothing in them at all.
  private func pruneEmpty(_ dir: String, under base: URL) {
    var d = dir
    while !d.isEmpty {
      let u = base.appendingPathComponent(d, isDirectory: true)
      guard let c = try? fm.contentsOfDirectory(atPath: u.path), c.allSatisfy({ $0 == ".DS_Store" }) else { return }
      try? fm.removeItem(at: u)
      d = SbMath.folder(d)
    }
  }
  private func rename(_ id: String, _ name: String?, page: Weak?) {
    guard SbMath.isId(id), let n = SbMath.cleanName(name) else { error("A name needs 1 to 120 characters.", to: page); return }
    ioQ.async { [self] in
      if moving { error("Wait for the Soundboard to finish moving, then try again.", to: page); return }
      if indexFor != root.path { _ = refresh() }
      guard let k = index.firstIndex(where: { $0.id == id }) else { sendAll(lib()); return }
      index[k].name = n
      saveIndex()
      sendAll(lib())
    }
  }

  // MARK: moving the storage

  private func location(_ act: String, page: Weak?) {
    switch act {
    case "default": move(to: Soundboard.defaultRoot(), isDefault: true, page: page)
    case "choose":
      guard !test else { ioQ.async { [self] in let l = refresh(); sendAll(l) }; return }
      beforePanel()
      let p = NSOpenPanel()
      p.canChooseDirectories = true; p.canChooseFiles = false; p.canCreateDirectories = true; p.allowsMultipleSelection = false
      p.prompt = "Use this folder"; p.message = "Pick where your Soundboard files live. PS app moves them there."
      if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
      p.begin { [weak self] r in
        guard r == .OK, let u = p.url else { return }
        let isDefault = u.standardizedFileURL.path == Soundboard.defaultRoot().standardizedFileURL.path
        self?.move(to: u, isDefault: isDefault, page: page)
      }
    default: break
    }
  }

  /// Copy everything to `to` (same relative paths, a clash renamed), check each size, write the index there (merged
  /// with one already there), and only then delete the old copies. Any failure: the new copies go, the old folder stays.
  private func move(to newRoot: URL, isDefault: Bool, page: Weak?) {
    jobQ.async { [self] in
      var old = URL(fileURLWithPath: "/"), items: [SbMath.Item] = [], oldExists = false
      ioQ.sync { _ = refresh(); old = root; items = index; oldExists = rootExists(); moving = true }
      let finish: (String?) -> Void = { why in
        var l: [String: Any] = [:]
        self.ioQ.sync { self.moving = false; l = self.refresh() }
        if let why { self.error(why, to: page) }
        self.sendAll(l)
      }
      let from = old.resolvingSymlinksInPath().standardizedFileURL.path
      let dest = newRoot.resolvingSymlinksInPath().standardizedFileURL
      if dest.path == from { ioQ.sync { custom = !isDefault; saveFolder(dest, isDefault: isDefault) }; finish(nil); return }
      guard SbMath.moveOk(from: from, to: dest.path) else { finish("Pick a folder outside the Soundboard folder."); return }
      do { try fm.createDirectory(at: dest, withIntermediateDirectories: true) } catch { finish("PS app could not use that folder. Pick another one."); return }
      guard fm.isWritableFile(atPath: dest.path) else { finish("PS app cannot write in that folder. Pick another one."); return }
      let there = Soundboard.readIndex(dest), theirs = there.items
      let existing = Set(Soundboard.scan(dest).map(\.path)).union(theirs.map(\.path)).union(there.ignored)
      let plan = oldExists ? SbMath.movePlan(items.map(\.path), existing: existing) : []
      var made: [URL] = [], madeDirs: [URL] = [], failed: String?, copied = Set<String>()
      for (k, step) in plan.enumerated() {
        send(["ev": "progress", "done": k, "total": plan.count, "name": SbMath.displayName((step.from as NSString).lastPathComponent)], to: page)
        let src = old.appendingPathComponent(step.from), dst = dest.appendingPathComponent(step.to)
        let srcSize = ((try? fm.attributesOfItem(atPath: src.path)[.size]) as? NSNumber)?.int64Value ?? -1
        if srcSize < 0 { continue }   // gone since the look a moment ago: nothing to copy
        do {
          var parents: [URL] = [], p = dst.deletingLastPathComponent()
          while p.path.count > dest.path.count && !fm.fileExists(atPath: p.path) { parents.append(p); p = p.deletingLastPathComponent() }
          try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
          madeDirs.append(contentsOf: parents)
          if fm.fileExists(atPath: dst.path) { failed = "A file is already there."; break }
          try fm.copyItem(at: src, to: dst)
          made.append(dst); copied.insert(step.from)
          let got = ((try? fm.attributesOfItem(atPath: dst.path)[.size]) as? NSNumber)?.int64Value ?? -2
          if got != srcSize { failed = "A copy came out the wrong size."; break }
        } catch { failed = "A file could not be copied (is there space on that drive?)."; break }
      }
      let moved = Dictionary(plan.filter { copied.contains($0.from) }.map { ($0.from, $0.to) }, uniquingKeysWith: { a, _ in a })
      let ours = items.compactMap { i -> SbMath.Item? in guard let to = moved[i.path] else { return nil }; var j = i; j.path = to; return j }
      let all = SbMath.mergeIndexes(theirs: theirs, ours: ours)
      if failed == nil {
        do {
          let d = try JSONSerialization.data(withJSONObject: SbMath.indexJSON(all, ignored: there.ignored), options: [.sortedKeys])
          try d.write(to: dest.appendingPathComponent(".ps-soundboard.json"), options: .atomic)
        } catch { failed = "The Soundboard list could not be written there." }
      }
      if let failed {
        for f in made { try? fm.removeItem(at: f) }
        for d in madeDirs.sorted(by: { $0.path.count > $1.path.count }) { if (try? fm.contentsOfDirectory(atPath: d.path))?.isEmpty == true { try? fm.removeItem(at: d) } }
        DispatchQueue.main.async { psLog("PS soundboard: move failed, the old folder is kept") }
        finish("PS app could not move the Soundboard. \(failed) Nothing was changed.")
        return
      }
      send(["ev": "progress", "done": plan.count, "total": plan.count, "name": ""], to: page)
      // The new folder is the one now; then the old copies go (only the files PS had, the old list, empty folders).
      ioQ.sync {
        root = dest; custom = !isDefault; index = all; ignored = there.ignored; indexFor = dest.path
        saveFolder(dest, isDefault: isDefault)
        publish()
      }
      // Only PS's own files leave the old folder; adopted ones (found there, not put there by PS) stay where they were.
      let gone = oldExists ? SbMath.oldToDelete(items, copied: copied) : []
      if oldExists {
        for p in gone { try? fm.removeItem(at: old.appendingPathComponent(p)) }
        try? fm.removeItem(at: old.appendingPathComponent(".ps-soundboard.json"))
        try? fm.removeItem(at: old.appendingPathComponent(".ps-incoming", isDirectory: true))
        for dir in Set(gone.map { SbMath.folder($0) }).sorted(by: { $0.count > $1.count }) { pruneEmpty(dir, under: old) }
      }
      DispatchQueue.main.async { psLog("PS soundboard: copied \(copied.count) files (\(gone.count) old copies deleted) to the \(isDefault ? "default" : "chosen") folder") }
      finish(nil)
    }
  }
  private func saveFolder(_ u: URL, isDefault: Bool) {
    guard !test else { return }
    if isDefault { UserDefaults.standard.removeObject(forKey: "sb.folder") } else { UserDefaults.standard.set(u.path, forKey: "sb.folder") }
  }

  // MARK: sharing in the G Squad: read and put

  private func read(_ msg: [String: Any], page: Weak?) {
    guard let id = msg["id"] as? String, SbMath.isId(id), let off = (msg["off"] as? NSNumber)?.int64Value, off >= 0,
          let len = (msg["len"] as? NSNumber)?.intValue, len > 0, len <= SbMath.maxPiece else { return }
    lock.lock(); let f = filesById[id]; lock.unlock()
    guard let f, SbMath.kind(f.pathExtension) == "audio" else { error("Only sounds can be shared.", to: page); return }
    serveQ.async { [self] in
      let size = ((try? fm.attributesOfItem(atPath: f.path)[.size]) as? NSNumber)?.int64Value ?? 0
      guard size > 0, size <= SbMath.maxShare else { error("That sound is too big to share. Sounds of 10 MB or less can be shared.", to: page); return }
      guard off < size, let h = try? FileHandle(forReadingFrom: f) else { return }
      defer { try? h.close() }
      try? h.seek(toOffset: UInt64(off))
      let d = h.readData(ofLength: len)
      send(["ev": "chunk", "id": id, "off": off, "size": size, "b64": d.base64EncodedString()], to: page)
    }
  }
  private func put(_ msg: [String: Any], page: Weak?) {
    guard let tmp = msg["tmp"] as? String, SbMath.isId(tmp), let ext = (msg["ext"] as? String)?.lowercased(), SbMath.audio.contains(ext),
          let off = (msg["off"] as? NSNumber)?.int64Value, off >= 0, let b64 = msg["b64"] as? String, b64.count <= SbMath.maxPiece * 4 / 3 + 8,
          let data = Data(base64Encoded: b64), data.count <= SbMath.maxPiece else { error("That sound could not be saved.", to: page); return }
    let last = (msg["last"] as? Bool) == true, name = SbMath.safeFileName(msg["name"] as? String ?? "", fallback: "Squad sound")
    ioQ.async { [self] in
      let now = Date()
      for (k, p) in puts where now.timeIntervalSince(p.at) > 600 { puts[k] = nil; try? fm.removeItem(at: incoming.appendingPathComponent("put-\(k).part")) }
      let part = incoming.appendingPathComponent("put-\(tmp).part")
      let fail: (String) -> Void = { why in self.puts[tmp] = nil; try? self.fm.removeItem(at: part); self.error(why, to: page) }
      if moving { fail("Wait for the Soundboard to finish moving, then try again."); return }
      if off == 0 {
        if let why = ensureRoot() { fail(why); return }
        try? fm.createDirectory(at: incoming, withIntermediateDirectories: true)
        guard fm.createFile(atPath: part.path, contents: nil) else { fail("That sound could not be saved."); return }
        puts[tmp] = Put(name: name, ext: ext, size: 0, at: now)
      }
      guard var p = puts[tmp], p.size == off, p.ext == ext else { fail("That sound came in out of order. Try again."); return }
      guard p.size + Int64(data.count) <= SbMath.maxShare else { fail("That sound is over 10 MB."); return }
      guard let h = try? FileHandle(forWritingTo: part) else { fail("That sound could not be saved."); return }
      h.seekToEndOfFile(); h.write(data); try? h.close()
      p.size += Int64(data.count); p.at = now; puts[tmp] = p
      guard last else { return }
      puts[tmp] = nil
      guard p.size > 0, land(part, dir: SbMath.squadFolder, name: p.name + "." + p.ext) else { fail("That sound could not be saved."); return }
      saveIndex()
      let l = refresh()
      DispatchQueue.main.async { psLog("PS soundboard: a sound from the squad was saved") }
      sendAll(l)
    }
  }

  // MARK: serving ps://app/client/media/<id>.<ext> (main.swift AppFiles)

  static let servingChunk: Int64 = 4 << 20
  /// Answers the request itself (on `serveQ`, then the main thread). False: not a Soundboard file (the caller 404s).
  func serve(_ file: String, _ task: WKURLSchemeTask, _ url: URL, alive: @escaping () -> Bool) -> Bool {
    let id = (file as NSString).deletingPathExtension, ext = (file as NSString).pathExtension.lowercased()
    guard SbMath.isId(id), SbMath.kind(ext) != nil else { return false }
    lock.lock(); let f = filesById[id], rp = rootPath; lock.unlock()
    guard let f, SbMath.ext(f.lastPathComponent) == ext else { return false }
    let header = task.request.value(forHTTPHeaderField: "Range")
    serveQ.async {
      let real = f.resolvingSymlinksInPath().standardizedFileURL.path
      let size = ((try? FileManager.default.attributesOfItem(atPath: real)[.size]) as? NSNumber)?.int64Value ?? 0
      let inside = !rp.isEmpty && real.hasPrefix(rp + "/")
      var data = Data(), r: (start: Int64, end: Int64, partial: Bool)?
      if inside && size > 0 {
        r = SbMath.range(header, size: size, cap: Soundboard.servingChunk)
        if let r, let h = try? FileHandle(forReadingFrom: URL(fileURLWithPath: real)) {
          try? h.seek(toOffset: UInt64(r.start))
          data = h.readData(ofLength: Int(r.end - r.start + 1))
          try? h.close()
        }
      }
      DispatchQueue.main.async {
        guard alive() else { return }
        let resp: HTTPURLResponse
        if !inside || size == 0 {
          resp = HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/plain"])!
          task.didReceive(resp); task.didReceive(Data("Not found".utf8)); task.didFinish(); return
        }
        guard let r, !data.isEmpty else {
          resp = HTTPURLResponse(url: url, statusCode: 416, httpVersion: "HTTP/1.1", headerFields: ["Content-Range": "bytes */\(size)", "Accept-Ranges": "bytes"])!
          task.didReceive(resp); task.didFinish(); return
        }
        var h = ["Content-Type": SbMath.contentType(ext), "Content-Length": "\(data.count)", "Accept-Ranges": "bytes", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"]
        let partial = r.partial || Int64(data.count) < size
        if partial { h["Content-Range"] = "bytes \(r.start)-\(r.start + Int64(data.count) - 1)/\(size)" }
        resp = HTTPURLResponse(url: url, statusCode: partial ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: h)!
        task.didReceive(resp); task.didReceive(data); task.didFinish()
      }
    }
    return true
  }

  // MARK: timed plays (main thread)

  private func setPlan(_ v: Any?) {
    let next = SbMath.plan(v)
    if next != plan { psLog("PS soundboard: \(next.count) timed plays") }
    plan = next
    let json = next.map(\.json), pf = planFile
    ioQ.async {
      guard let d = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys]) else { return }
      try? FileManager.default.createDirectory(at: pf.deletingLastPathComponent(), withIntermediateDirectories: true)
      try? d.write(to: pf, options: .atomic)
    }
    if let r = ring, !next.contains(where: { $0.id == r.plan.id }) { stopRing("plan") }   // taken out of the plan while ringing
    arm()
  }
  private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone.current; return c }
  /// Rings what is due since the last look, then one timer for the next due time (no polling). Also after wake and
  /// clock or time zone changes (the timer's clock stops while the Mac sleeps).
  private func arm() {
    timer?.invalidate(); timer = nil
    let now = Date(), c = cal
    if let d = SbMath.due(plan, since: lastCheck, now: now, cal: c) { ringDue(d.0) }
    lastCheck = now
    guard let next = SbMath.nextWake(plan, after: now, cal: c) else { return }
    let t = Timer(fire: next.addingTimeInterval(0.05), interval: 0, repeats: false) { [weak self] _ in self?.arm() }
    t.tolerance = 0.5
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  /// A plan item is due: its file is looked for off the main thread (a drive can be slow), then it rings.
  private func ringDue(_ p: SbMath.Plan) {
    lock.lock(); let f = filesById[p.media]; lock.unlock()
    guard let f else { psLog("PS soundboard: a timed play was skipped, its file is gone"); return }
    serveQ.async { [weak self] in
      let there = FileManager.default.fileExists(atPath: f.path)
      DispatchQueue.main.async { [weak self] in
        if there { self?.startRing(p, f) } else { psLog("PS soundboard: a timed play was skipped, its file is gone") }
      }
    }
  }
  private func startRing(_ p: SbMath.Plan, _ f: URL) {
    if ring != nil { stopRing("replaced") }   // never two at once
    SleepSound.shared.stopTest()
    ringGen += 1
    let gen = ringGen, r = Ring(plan: p, at: Date())
    ring = r
    Soundboard.setRinging(true)
    psLog("PS soundboard: timed play\(p.loop ? " (repeat)" : "")")
    sendAll(["ev": "ring", "plan": p.id, "media": p.media, "name": p.name])
    showCard(r)
    let end = DispatchWorkItem { [weak self] in if self?.ringGen == gen { self?.stopRing("time") } }
    r.end = end
    if test {   // a test copy: no sound and no volume; a once play ends a moment later
      DispatchQueue.main.asyncAfter(deadline: .now() + (p.loop ? SbMath.loopMax : 3), execute: end)
      return
    }
    if p.loop { DispatchQueue.main.asyncAfter(deadline: .now() + SbMath.loopMax, execute: end) }
    holdVolume(Float(p.vol), gen: gen)
    let item = AVPlayerItem(url: f), player = AVPlayer(playerItem: item)
    player.volume = 1
    player.preventsDisplaySleepDuringVideoPlayback = false
    r.player = player
    let nc = NotificationCenter.default
    r.observers.append(nc.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
      guard let self, self.ringGen == gen, let pl = self.ring?.player else { return }
      if p.loop { pl.seek(to: .zero); pl.play() } else { self.stopRing("end") }
    })
    r.observers.append(nc.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) { [weak self] _ in
      if self?.ringGen == gen { self?.fallback(gen) }
    })
    r.status = item.observe(\.status) { [weak self] it, _ in
      guard it.status == .failed else { return }
      DispatchQueue.main.async { if self?.ringGen == gen { self?.fallback(gen) } }
    }
    player.play()
  }
  /// The file will not play here (AVFoundation reads no webm, mkv or ogg): the built in alarm sound rings instead, so a
  /// timed play is never silent. Once: 30 seconds; repeat: until Stop or the 10 minutes.
  private func fallback(_ gen: Int) {
    guard let r = ring, ringGen == gen, r.fallback == nil else { return }
    psLog("PS soundboard: the file cannot play on this Mac, the alarm sound rings instead")
    r.player?.pause(); r.player = nil
    let a = try? AVAudioPlayer(data: SleepSound.shared.ringData("alarm", own: false))
    a?.numberOfLoops = -1; a?.volume = 1; a?.play()
    r.fallback = a
    if !r.plan.loop {
      let end = DispatchWorkItem { [weak self] in if self?.ringGen == gen { self?.stopRing("end") } }
      r.end?.cancel(); r.end = end
      DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: end)
    }
  }
  /// This Mac's volume to the alarm level (unmuted) while it rings; the old level kept to put back (as SleepSound).
  private func holdVolume(_ to: Float, gen: Int) {
    volQ.async { [weak self] in
      guard let self else { return }
      let old = self.volumeGet()
      DispatchQueue.main.async {
        guard let r = self.ring, self.ringGen == gen, r.savedVolume == nil, let old else { return }
        r.savedVolume = old
        self.volQ.async { self.volumeSet(to, false) }
      }
    }
  }
  /// Stop (the card, the page's sb:stop, Esc), the end of the file, the 10 minutes, a new ring: quiet, volume back.
  func stopRing(_ why: String) {
    guard let r = ring else { return }
    ring = nil; ringGen += 1
    Soundboard.setRinging(false)
    r.end?.cancel()
    r.status?.invalidate()
    r.observers.forEach { NotificationCenter.default.removeObserver($0) }
    r.player?.pause(); r.player = nil
    r.fallback?.stop(); r.fallback = nil
    if let v = r.savedVolume { volQ.async { [self] in volumeSet(v.volume, v.muted) } }
    closeCard(r)
    psLog("PS soundboard: timed play stopped (\(why))")
    sendAll(["ev": "ringEnd", "plan": r.plan.id])
  }
  /// Esc (main.swift): stops a ring. True when there was one.
  func escape() -> Bool {
    guard ring != nil else { return false }
    stopRing("esc")
    return true
  }

  // MARK: the card

  private static let cardW: CGFloat = 340, cardH: CGFloat = 108
  private func showCard(_ r: Ring) {
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.userContentController.add(self, name: "sbcard")
    // The panel never becomes key: a plain WKWebView dropped the first click on the card (main.swift).
    let w = ClickThroughWebView(frame: NSRect(x: 0, y: 0, width: Soundboard.cardW, height: Soundboard.cardH), configuration: c)
    w.setValue(false, forKey: "drawsBackground")
    w.navigationDelegate = self
    let p = SbCardPanel(contentRect: w.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.contentView = w
    if test { p.alphaValue = 0; p.ignoresMouseEvents = true }   // a test copy never shows anything or catches a click
    r.panel = p; r.web = w
    w.loadHTMLString(Soundboard.cardPage, baseURL: nil)
    place()
  }
  /// Top right of the main screen, except over 1Password or Signal (then out of sight until they leave).
  private func place() {
    guard let r = ring, let p = r.panel else { return }
    if Protected.front { if p.isVisible { p.orderOut(nil) }; IslandColumn.shared.leave("sound"); return }
    // V1.55: out of the Dynamic Island while it is there and the developer left the Soundboard card on Island (IslandColumn.swift).
    if let f = IslandColumn.shared.frame(id: "sound", kind: "sound", size: NSSize(width: Soundboard.cardW, height: Soundboard.cardH), window: p,
                                         replace: { [weak self] in self?.place() }) {
      IslandColumn.shared.put(p, f, alpha: test ? 0 : 1)
      return
    }
    let vf = (NSScreen.main ?? NSScreen.screens.first)?.visibleFrame ?? .zero
    p.setFrame(NSRect(x: vf.maxX - Soundboard.cardW - 12, y: vf.maxY - Soundboard.cardH - 10, width: Soundboard.cardW, height: Soundboard.cardH), display: true)
    if !p.isVisible { p.orderFrontRegardless() }
  }
  func protectedChanged() { place() }
  private func closeCard(_ r: Ring) {
    IslandColumn.shared.leave("sound")
    guard let p = r.panel, let w = r.web else { return }
    r.panel = nil; r.web = nil
    p.orderOut(nil)
    w.configuration.userContentController.removeScriptMessageHandler(forName: "sbcard")
  }
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let r = ring, r.web === webView else { return }
    r.ready = true
    let f = DateFormatter()
    f.dateStyle = .none; f.timeStyle = .short
    webView.callAsyncJavaScript("window.__sb && window.__sb.set(o)", arguments: ["o": ["name": r.plan.name, "time": f.string(from: r.at), "loop": r.plan.loop]], in: nil, in: .page, completionHandler: nil)
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.navigationType == .other ? .allow : .cancel)   // nothing in the card navigates anywhere
  }
  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let r = ring, r.web === message.webView, (message.body as? String) == "stop" else { return }
    stopRing("stop")
  }

  // The card: dark glass like the other PS cards, the file's name as plain text (textContent), one Stop button.
  private static let cardPage = #"""
  <!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:transparent;overflow:hidden;color:#fff;font:14px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;cursor:default}
  #c{margin:8px;height:92px;box-sizing:border-box;border-radius:20px;padding:14px 16px;display:flex;align-items:center;gap:14px;
    background:linear-gradient(165deg,#2a1f3a,#15111d 70%);border:1.5px solid rgba(167,139,250,.55);box-shadow:0 14px 36px rgba(0,0,0,.45);animation:pop .45s cubic-bezier(.22,1,.36,1) both}
  @keyframes pop{from{transform:translateY(-8px) scale(.97);opacity:.2}}
  .eq{display:flex;gap:3px;align-items:flex-end;height:26px;flex:none}
  .eq i{width:4px;border-radius:2px;background:#a78bfa;animation:b 1s ease-in-out infinite}
  .eq i:nth-child(2){animation-delay:.2s}.eq i:nth-child(3){animation-delay:.4s}
  @keyframes b{0%,100%{height:6px}50%{height:26px}}
  .t{flex:1;min-width:0}
  .p{font-size:10.5px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#c4b5fd}
  #n{font-size:16px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  button{border:0;border-radius:99px;padding:9px 18px;font:700 13px -apple-system,sans-serif;color:#fff;background:linear-gradient(180deg,#a78bfa,#7c3aed);cursor:pointer;flex:none}
  button:active{transform:scale(.97)}
  @media (prefers-reduced-motion:reduce){#c,.eq i{animation:none}}
  </style></head><body>
  <div id="c"><div class="eq"><i></i><i></i><i></i></div><div class="t"><div class="p">Soundboard <span id="tm"></span></div><div id="n"></div></div><button id="s" type="button">Stop</button></div>
  <script>
  window.__sb = { set(o) { document.getElementById('n').textContent = o.name; document.getElementById('tm').textContent = o.time + (o.loop ? ', repeat' : ''); } };
  document.getElementById('s').addEventListener('click', () => { try { window.webkit.messageHandlers.sbcard.postMessage('stop'); } catch (e) {} });
  </script></body></html>
  """#
}
