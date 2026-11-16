import CryptoKit
import Darwin
import Foundation
import IOKit.ps
import IOKit.pwr_mgt

// Second Computer, the pieces around the runner (protocol v1 sections 6 to 8):
// - SecondLanding: file chunks from the vault, in order, into ~/Downloads/From PS (or a code bundle
//   into this Mac's bare mirror), size and SHA-256 checked, macOS's quarantine mark set like any download.
// - SecondGit: git bundles in and out. Out (the primary): a temporary ref refs/ps-second/<req> at head
//   (`git stash create` when there are uncommitted changes, so the working tree is never touched), the
//   bundle of that ref, the ref deleted at once. In (the secondary): verify, fetch into
//   Second/repos/<project>.git as refs/second/*.
// - SecondStat: CPU, memory, battery, power, free disk. Cheap reads, no polling of its own.
// - SecondAwake: an IOPM "prevent idle sleep" assertion, only while this Mac is Secondary AND on power.
//   It never changes a system setting (the developer sets "Prevent automatic sleeping" himself).
// Everything here runs off the main thread.

enum SecondGit {
  /// Runs git (or another fixed tool) and returns the exit code and stdout. Never through a shell.
  @discardableResult
  static func run(_ exe: String, _ args: [String], cwd: String? = nil, env: [String: String]? = nil) -> (Int32, Data) {
    let p = Process(), o = Pipe()
    p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
    if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
    p.environment = env ?? ["PATH": "/usr/bin:/bin", "HOME": FileManager.default.homeDirectoryForCurrentUser.path, "GIT_TERMINAL_PROMPT": "0", "LANG": "en_US.UTF-8"]
    p.standardOutput = o; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return (-1, Data()) }
    let d = o.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
    return (p.terminationStatus, d)
  }
  static func text(_ d: Data) -> String { String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines) }

  struct Bundle { var head: String; var base: String?; var dirty: Bool; var files: [String]; var data: Data }

  /// The primary: a bundle of `repo` at its current state (protocol section 10, second:bundle).
  static func make(repo: String, base: String?, req: String, git: String = "/usr/bin/git", maxBytes: Int = 25 << 20) -> Result<Bundle, SecondRefusal> {
    func no(_ w: String) -> Result<Bundle, SecondRefusal> { .failure(SecondRefusal(why: w)) }
    guard SecondJobs.isId(req) else { return no("bad request") }
    let stash = text(run(git, ["-C", repo, "stash", "create"]).1)
    let head: String
    if SecondJobs.isSha(stash) { head = stash } else {
      let (c, h) = run(git, ["-C", repo, "rev-parse", "HEAD"])
      guard c == 0, SecondJobs.isSha(text(h)) else { return no("not a git checkout with a commit") }
      head = text(h)
    }
    var useBase: String?
    if let b = base, SecondJobs.isSha(b), run(git, ["-C", repo, "merge-base", "--is-ancestor", b, head]).0 == 0 {
      // The secondary has head already: one commit travels again (a bundle may not be empty).
      if b == head { let p = text(run(git, ["-C", repo, "rev-parse", head + "^"]).1); useBase = SecondJobs.isSha(p) ? p : nil } else { useBase = b }
    }
    let ref = "refs/ps-second/" + req
    let tmp = NSTemporaryDirectory() + "ps-second-\(req).bundle"
    try? FileManager.default.removeItem(atPath: tmp)
    guard run(git, ["-C", repo, "update-ref", ref, head]).0 == 0 else { return no("could not mark the commit") }
    var made = run(git, ["-C", repo, "bundle", "create", "-q", tmp, ref] + (useBase.map { ["^" + $0] } ?? [])).0
    if made != 0 && useBase != nil { useBase = nil; made = run(git, ["-C", repo, "bundle", "create", "-q", tmp, ref]).0 }   // git refused the small one: a full one
    run(git, ["-C", repo, "update-ref", "-d", ref])
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    guard made == 0, let data = FileManager.default.contents(atPath: tmp) else { return no("git could not make the bundle") }
    guard data.count <= maxBytes else { return no("the bundle is over 25 MB") }
    let files = text(run(git, ["-C", repo, "ls-tree", "-r", "--name-only", head]).1).split(separator: "\n").map(String.init)
    return .success(Bundle(head: head, base: useBase, dirty: head == stash, files: files, data: data))
  }

  /// The secondary: a landed bundle into its project's bare mirror. Returns the head it brought.
  static func fetch(bundle path: String, project: String, places: SecondPlaces) -> Result<String, SecondRefusal> {
    func no(_ w: String) -> Result<String, SecondRefusal> { .failure(SecondRefusal(why: w)) }
    guard SecondJobs.isProject(project) else { return no("Bad arguments") }
    let m = places.mirror(project), git = places.git
    if !FileManager.default.fileExists(atPath: m) {
      try? FileManager.default.createDirectory(atPath: places.root + "/repos", withIntermediateDirectories: true)
      guard run(git, ["init", "-q", "--bare", m]).0 == 0 else { return no("could not make the mirror") }
    }
    guard run(git, ["--git-dir=" + m, "bundle", "verify", "-q", path]).0 == 0 else { return no("Code bundle missing: it needs code this Mac does not have yet") }
    let heads = text(run(git, ["--git-dir=" + m, "bundle", "list-heads", path]).1).split(separator: "\n")
    guard let first = heads.first, let sha = first.split(separator: " ").first.map(String.init), SecondJobs.isSha(sha),
          heads.allSatisfy({ $0.contains(" refs/ps-second/") }) else { return no("Bad arguments") }
    guard run(git, ["--git-dir=" + m, "fetch", "-q", "--no-tags", path, "+refs/ps-second/*:refs/second/*"]).0 == 0 else { return no("git could not read the bundle") }
    return .success(sha)
  }
}

final class SecondLanding {
  struct Done { var ref: String; var ok: Bool; var reason: String?; var path: String?; var purpose: String; var name: String; var project: String?; var head: String?; var get: String? = nil }
  /// protocol v1.1: 50 MB a file sent whole (code bundles 25 MB). v1.2 (drag and drop, 2 Nov 2026): 1 GB a file or
  /// packed folder, streamed, each chunk written to disk as it comes so the vault holds only what is in flight.
  static let maxFile = 50 << 20, maxStream = SecondOutbox.maxFile
  private struct Partial { var body: [String: Any]; var tmp: String; var handle: FileHandle; var next: Int; var n: Int; var got: Int; var hash: SHA256 }
  private let lock = NSLock()
  private var files: [String: Partial] = [:]
  let places: SecondPlaces
  let downloads: String
  var onHave: (String, String) -> Void = { _, _ in }
  /// purpose "share": the shared folder a file is sent into (root id, dir), or nil for Downloads.
  var shareDir: (String?, String?) -> String? = { _, _ in nil }
  /// A file the developer dragged out to Finder (by its request id): the exact path Finder promised, or nil.
  var exactDest: (String?) -> String? = { _ in nil }
  /// Bytes landed so far for a requested file (request id, bytes), for Finder's progress on a dragged out file.
  var onBytes: (String, Int) -> Void = { _, _ in }

  init(places: SecondPlaces, downloads: String) {
    self.places = places; self.downloads = downloads
    // Half files nobody came back for in 3 days.
    let dir = places.root + "/incoming", fm = FileManager.default
    for f in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] {
      let p = dir + "/" + f
      if let d = (try? fm.attributesOfItem(atPath: p))?[.modificationDate] as? Date, Date().timeIntervalSince(d) > 3 * 86_400 { try? fm.removeItem(atPath: p) }
    }
  }

  private var dir: String { places.root + "/incoming" }

  /// How many chunks of `body` this Mac already holds on disk (a landing cut off by sleep or a restart resumes there).
  func have(_ body: [String: Any]) -> Int {
    guard let id = body["id"] as? String, SecondJobs.isId(id) else { return 0 }
    lock.lock(); defer { lock.unlock() }
    if let p = files[id] { return p.next }
    let chunk = (body["chunk"] as? NSNumber)?.intValue ?? 0, fm = FileManager.default
    guard chunk > 0, let saved = fm.contents(atPath: dir + "/" + id + ".json"), let sb = try? JSONSerialization.jsonObject(with: saved) as? [String: Any],
          (sb["sha256"] as? String) == (body["sha256"] as? String), let size = (try? fm.attributesOfItem(atPath: dir + "/" + id + ".part"))?[.size] as? Int else { return 0 }
    let k = size / chunk
    if size != k * chunk, let h = FileHandle(forWritingAtPath: dir + "/" + id + ".part") { try? h.truncate(atOffset: UInt64(k * chunk)); try? h.close() }
    return k
  }

  /// One chunk, in order. nil: more to come. A Done: the file is complete (or refused).
  func chunk(_ body: [String: Any], i: Int, n: Int, data: Data) -> Done? {
    guard let id = body["id"] as? String, SecondJobs.isId(id) else { return nil }
    let name = (body["name"] as? String) ?? "file", purpose = (body["purpose"] as? String) ?? "user", get = body["get"] as? String
    func refuse(_ w: String) -> Done { drop(id); return Done(ref: id, ok: false, reason: w, path: nil, purpose: purpose, name: name, project: nil, head: nil, get: get) }
    guard ["user", "bundle", "result", "share"].contains(purpose) else { return refuse("Bad arguments") }
    let size = (body["size"] as? NSNumber)?.intValue ?? -1, chunk = (body["chunk"] as? NSNumber)?.intValue ?? 0, bn = (body["n"] as? NSNumber)?.intValue ?? 0
    guard size >= 0, size <= (purpose == "bundle" ? 25 << 20 : SecondLanding.maxStream) else { return refuse(purpose == "bundle" ? "Over 25 MB" : "Over 1 GB") }
    guard chunk > 0, chunk <= 8 << 20, bn == n, n == max(1, (size + chunk - 1) / chunk), i >= 0, i < n, data.count <= chunk else { return refuse("Bad arguments") }
    if let pack = body["pack"] { guard pack as? String == "zip", purpose != "bundle" else { return refuse("Bad arguments") } }
    lock.lock()
    var p: Partial
    if let have = files[id] { p = have } else {
      try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
      let tmp = dir + "/" + id + ".part", fm = FileManager.default
      if i == 0 {
        guard SecondOutbox.freeBytes(dir) > Int64(size) * (body["pack"] == nil ? 1 : 2) + (1 << 30) else { lock.unlock(); return refuse("Not enough free space on this Mac") }
        fm.createFile(atPath: tmp, contents: nil, attributes: [.posixPermissions: 0o600])
        if let j = try? JSONSerialization.data(withJSONObject: body) { try? j.write(to: URL(fileURLWithPath: dir + "/" + id + ".json")) }
        guard let h = FileHandle(forWritingAtPath: tmp) else { lock.unlock(); return refuse("Could not write the file") }
        p = Partial(body: body, tmp: tmp, handle: h, next: 0, n: n, got: 0, hash: SHA256())
      } else {
        // Picking up after sleep or a restart: the half file on disk, read again for the running hash.
        lock.unlock()
        let k = have(body)
        lock.lock()
        guard k == i, let r = FileHandle(forReadingAtPath: tmp), let h = FileHandle(forWritingAtPath: tmp) else { lock.unlock(); return refuse("A chunk came out of order") }
        var hash = SHA256(), got = 0
        while let d = try? r.read(upToCount: 1 << 22), !d.isEmpty { hash.update(data: d); got += d.count }
        try? r.close()
        _ = try? h.seekToEnd()
        p = Partial(body: body, tmp: tmp, handle: h, next: k, n: n, got: got, hash: hash)
      }
    }
    guard i == p.next else { lock.unlock(); return refuse("A chunk came out of order") }
    p.handle.write(data); p.hash.update(data: data); p.got += data.count; p.next += 1
    files[id] = p
    lock.unlock()
    if let get { onBytes(get, p.got) }
    guard p.next == p.n else { return nil }
    lock.lock(); files[id] = nil; lock.unlock()
    try? p.handle.close()
    try? FileManager.default.removeItem(atPath: dir + "/" + id + ".json")
    let hex = p.hash.finalize().map { String(format: "%02x", $0) }.joined()
    let want = ((body["sha256"] as? String) ?? "").lowercased()
    let wantHex = want.count == 64 ? want : (Data(base64Encoded: (body["sha256"] as? String) ?? "").map { $0.map { String(format: "%02x", $0) }.joined() } ?? "")
    guard p.got == size, hex == wantHex else { try? FileManager.default.removeItem(atPath: p.tmp); return refuse("The file did not arrive whole") }
    if purpose == "bundle" {
      // "<project>.bundle" (or "<project>@<head>.bundle"): straight into the mirror.
      let project = String(name.dropLast(name.hasSuffix(".bundle") ? 7 : 0).split(separator: "@").first ?? "")
      defer { try? FileManager.default.removeItem(atPath: p.tmp) }
      switch SecondGit.fetch(bundle: p.tmp, project: project, places: places) {
      case .success(let head): onHave(project, head); return Done(ref: id, ok: true, reason: nil, path: nil, purpose: purpose, name: name, project: project, head: head)
      case .failure(let r): return Done(ref: id, ok: false, reason: r.why, path: nil, purpose: purpose, name: name, project: project, head: nil)
      }
    }
    let exact = exactDest(get)
    let folder = exact.map { ($0 as NSString).deletingLastPathComponent } ?? (purpose == "share" ? shareDir(body["root"] as? String, body["dir"] as? String) : nil) ?? downloads
    try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    if body["pack"] as? String == "zip" {
      // A folder or a package, packed by the other Mac's PS: checked name by name, then unpacked with its dates.
      defer { try? FileManager.default.removeItem(atPath: p.tmp) }
      switch SecondZip.unpack(p.tmp, into: folder, name: name, exact: exact) {
      case .failure(let w): return Done(ref: id, ok: false, reason: w.why, path: nil, purpose: purpose, name: name, project: nil, head: nil, get: get)
      case .success(let dest): return Done(ref: id, ok: true, reason: nil, path: dest, purpose: purpose, name: (dest as NSString).lastPathComponent, project: nil, head: nil, get: get)
      }
    }
    let dest = exact ?? SecondLanding.free(folder, SecondLanding.clean(name))
    guard (try? FileManager.default.moveItem(atPath: p.tmp, toPath: dest)) != nil else { try? FileManager.default.removeItem(atPath: p.tmp); return refuse("Could not write the file") }
    // The sender's modified date, so a file keeps its date across Macs as a folder does.
    if let m = (body["m"] as? NSNumber)?.doubleValue, m > 0, m < Date().timeIntervalSince1970 * 1000 + 86_400_000 {
      try? FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: m / 1000)], ofItemAtPath: dest)
    }
    SecondLanding.quarantine(dest)
    return Done(ref: id, ok: true, reason: nil, path: dest, purpose: purpose, name: (dest as NSString).lastPathComponent, project: nil, head: nil, get: get)
  }

  func drop(_ id: String) {
    lock.lock(); let p = files.removeValue(forKey: id); lock.unlock()
    if let p { try? p.handle.close() }
    try? FileManager.default.removeItem(atPath: dir + "/" + id + ".part")
    try? FileManager.default.removeItem(atPath: dir + "/" + id + ".json")
  }

  /// A safe file name: no folders, no dot files, no control characters, at most 200 characters.
  static func clean(_ raw: String) -> String {
    var s = raw.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: "\\", with: "-")
    s = String(s.unicodeScalars.filter { $0.value >= 32 && $0.value != 127 }.map(Character.init))
    while s.hasPrefix(".") || s.hasPrefix(" ") || s.hasPrefix("-") { s.removeFirst() }
    s = s.trimmingCharacters(in: .whitespaces)
    if s.count > 200 {
      let ext = (s as NSString).pathExtension
      s = String(s.prefix(ext.isEmpty || ext.count > 10 ? 200 : 199 - ext.count)) + (ext.isEmpty || ext.count > 10 ? "" : "." + ext)
    }
    return s.isEmpty ? "file" : s
  }
  /// "name.txt", then "name 2.txt", "name 3.txt" ...
  static func free(_ dir: String, _ name: String) -> String {
    let fm = FileManager.default
    if !fm.fileExists(atPath: dir + "/" + name) { return dir + "/" + name }
    let ext = (name as NSString).pathExtension, stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
    for k in 2...9999 {
      let c = dir + "/" + stem + " \(k)" + (ext.isEmpty ? "" : "." + ext)
      if !fm.fileExists(atPath: c) { return c }
    }
    return dir + "/" + UUID().uuidString + (ext.isEmpty ? "" : "." + ext)
  }
  /// The mark macOS puts on downloads, so Gatekeeper checks anything that might run.
  static func quarantine(_ path: String) {
    let v = String(format: "0083;%08x;PS;", Int(Date().timeIntervalSince1970))
    _ = v.withCString { setxattr(path, "com.apple.quarantine", $0, strlen($0), 0, 0) }
  }
}

enum SecondStat {
  /// What the stat body carries besides ids (protocol section 7).
  static func sample(home: String, power: SecondAwake.Power) -> [String: Any] {
    var load = [Double](repeating: 0, count: 3)
    let cpus = max(1, ProcessInfo.processInfo.activeProcessorCount)
    let cpu = getloadavg(&load, 3) > 0 ? min(100, Int((load[0] / Double(cpus) * 100).rounded())) : 0
    var out: [String: Any] = ["cpu": cpu, "mem": memory(), "power": power.ac ? "ac" : "battery", "charging": power.charging,
                              "battery": power.battery.map { $0 as Any } ?? NSNull(), "disk": freeGB(home)]
    if !power.ac, let b = power.battery, b <= 15 { out["sleepSoon"] = true }
    return out
  }
  static func memory() -> Int {
    var s = vm_statistics64(), n = mach_msg_type_number_t(MemoryLayout<vm_statistics64>.size / MemoryLayout<integer_t>.size)
    let r = withUnsafeMutablePointer(to: &s) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(n)) { host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &n) } }
    guard r == KERN_SUCCESS else { return 0 }
    let page = Double(vm_kernel_page_size), total = Double(ProcessInfo.processInfo.physicalMemory)
    let used = Double(UInt64(s.active_count) + UInt64(s.wire_count) + UInt64(s.compressor_page_count)) * page
    return total > 0 ? min(100, Int((used / total * 100).rounded())) : 0
  }
  static func freeGB(_ path: String) -> Int {
    let v = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    return Int((v?.volumeAvailableCapacityForImportantUsage ?? 0) / 1_000_000_000)
  }
}

final class SecondAwake {
  struct Power: Equatable { var ac: Bool; var charging: Bool; var battery: Int? }
  private var assertion: IOPMAssertionID = 0
  private(set) var held = false
  private var secondary = false
  private var source: CFRunLoopSource?
  /// Swapped in test copies (never a real assertion there, and a fake power source).
  var create: () -> IOPMAssertionID? = {
    var id: IOPMAssertionID = 0
    let ok = IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn),
                                         "PS Second Computer: ready for jobs from your primary Mac" as CFString, &id)
    return ok == kIOReturnSuccess ? id : nil
  }
  var release: (IOPMAssertionID) -> Void = { IOPMAssertionRelease($0) }
  var read: () -> Power = SecondAwake.readPower
  var onPower: (Power) -> Void = { _ in }
  private(set) var power = Power(ac: true, charging: false, battery: nil)

  /// Listen for power changes (main run loop; the callback only reads and hands over).
  func watch() {
    power = read()
    let ctx = Unmanaged.passUnretained(self).toOpaque()
    if let s = IOPSNotificationCreateRunLoopSource({ c in
      guard let c else { return }
      Unmanaged<SecondAwake>.fromOpaque(c).takeUnretainedValue().changed()
    }, ctx)?.takeRetainedValue() {
      CFRunLoopAddSource(CFRunLoopGetMain(), s, .defaultMode)
      source = s
    }
  }
  func changed() {
    let p = read()
    guard p != power else { return }
    power = p
    update()
    onPower(p)
  }
  func set(secondary on: Bool) { secondary = on; update() }

  private func update() {
    let want = secondary && power.ac
    if want && !held, let id = create() { assertion = id; held = true; psLog("PS second: staying awake while plugged in") }
    else if !want && held { release(assertion); held = false; assertion = 0; psLog("PS second: no longer keeping the Mac awake") }
  }

  static func readPower() -> Power {
    guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else { return Power(ac: true, charging: false, battery: nil) }
    let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?
    var battery: Int?, charging = false
    if let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] {
      for s in list {
        guard let d = IOPSGetPowerSourceDescription(info, s)?.takeUnretainedValue() as? [String: Any], d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType else { continue }
        if let c = d[kIOPSCurrentCapacityKey] as? Int, let m = d[kIOPSMaxCapacityKey] as? Int, m > 0 { battery = c * 100 / m }
        charging = d[kIOPSIsChargingKey] as? Bool ?? false
      }
    }
    return Power(ac: type != kIOPSBatteryPowerValue, charging: charging, battery: battery)
  }
}
