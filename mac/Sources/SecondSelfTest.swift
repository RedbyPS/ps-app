import AppKit
import CryptoKit
import Foundation

// Self test for Second Computer (Second.swift, SecondProc.swift, SecondHost.swift, SecondCrypto.swift):
// a full round trip between TWO PS test copies on this Mac. This test copy is the Primary; it starts the
// Secondary as its own child (PS_SELFTEST_PEER, the same PS binary, no windows, no lock of its own: the
// parent holds it) and plays both pages, carrying every message through a folder in the test folder
// instead of the vault. FICTIONAL data: a tiny git repo in <dir>/Projects, files in <dir>/peer/Downloads.
// Zero network (each copy reports its own NETWORK CHECK), every window off screen, no alert ever shown,
// never the Keychain or a real power assertion. The Secondary is stopped through its own Process handle.
// Checks: pairing with the same code on both Macs, a forged pairing refused, a git bundle of uncommitted
// work into the Secondary's mirror, a project's tests on that code, a secret hidden in the tail, a
// timeout, a cancel (the whole tree gone), refusals (not trusted, seen before, unknown type, bad arguments,
// code missing), a file landing with its notice, the heartbeat quiet while idle and at once on power
// changes, staying awake only on power, the CLI folder; v1.1: a shared folder's signed index (hidden files and
// links out left out, a new file sent again, nothing when nothing changed), a shared file served and one out of
// bounds refused, a file sent into a shared folder, a research job with a FICTIONAL `claude` stand-in (no Bash,
// report.md back, its folder kept in Outsource), machine commands (lock run, too old and extra keys refused),
// the stat's machine field, and the Second Computer window (its size, invisible and parked here, fed once its
// page is ready when the web build has /second-window); a phone trusted with the code, its lock command run,
// its job, file and file request refused; the status line on both Macs; the AFK timer switch with its role
// defaults (Secondary off, Primary on, the developer's switch kept after that), with a FAKE idle clock. PS_SELFTEST_ONLY=second.
enum SecondSelfTest {
  static var peer: Bool { IS_TEST_COPY && ProcessInfo.processInfo.environment["PS_SELFTEST_PEER"] != nil }

  /// The Secondary copy runs without the lock only when its parent is a PS test copy of this same
  /// build that holds the lock right now.
  static func peerAllowed(lockFD: Int32) -> Bool {
    guard peer, lockFD >= 0 else { return false }
    let holder = (try? String(contentsOfFile: "/tmp/ps-selftest.lock", encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    guard holder == getppid(), let mine = SafeSignal.executable(of: getpid()), SafeSignal.executable(of: getppid()) == mine else { return false }
    if flock(lockFD, LOCK_SH | LOCK_NB) == 0 { flock(lockFD, LOCK_UN); return false }   // nobody holds it: not a peer of a running test
    return true
  }

  // MARK: the folder relay (test only; the real messages go through the vault)

  final class Relay {
    let inbox: String, outbox: String
    private var n = 0
    init(_ dir: String, inbox: String, outbox: String) {
      self.inbox = dir + "/" + inbox; self.outbox = dir + "/" + outbox
      for d in [self.inbox, self.outbox] { try? FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
    }
    func send(_ json: String) {
      n += 1
      let name = String(format: "%08d-%d", n, getpid())
      Second.atomicWrite(Data(json.utf8), outbox + "/" + name + ".json")
    }
    func send(_ d: [String: Any]) { if let data = try? JSONSerialization.data(withJSONObject: d), let s = String(data: data, encoding: .utf8) { send(s) } }
    func read() -> [[String: Any]] {
      let fm = FileManager.default
      return ((try? fm.contentsOfDirectory(atPath: inbox)) ?? []).filter { $0.hasSuffix(".json") }.sorted().compactMap { f in
        let p = inbox + "/" + f
        defer { try? fm.removeItem(atPath: p) }
        return fm.contents(atPath: p).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      }
    }
  }

  /// The Secondary half: its "page" is the relay folder.
  static func runPeer() {
    let relay = Relay(ProcessInfo.processInfo.environment["PS_SELFTEST_PEER"] ?? "/nonexistent", inbox: "to-peer", outbox: "to-primary")
    let s = Second.shared
    s.confirm = { title, text, _, done in relay.send(["type": "test:alert", "title": title, "text": text]); done(true) }
    s.notice = { title, text in relay.send(["type": "test:notice", "title": title, "text": text]) }
    s.toPage = { relay.send($0) }
    // The reboot session's RemoteCommand and AutoReboot are not in a test copy: fictional stand-ins.
    s.cmdRunner = { action, id, _, at, done in relay.send(["type": "test:cmd", "action": action, "id": id, "at": at]); done(true, nil) }
    s.machine = { ["awake": true, "locked": false, "fileVault": "unknown", "passwordImmediately": NSNull(), "timer": ["on": false], "helper": "missing"] }
    s.start()
    s.setUnlocked(true)
    print("PEER: started pid \(getpid())")
    let t = Timer(timeInterval: 0.2, repeats: true) { _ in
      for m in relay.read() {
        guard let type = m["type"] as? String else { continue }
        switch type {
        case "test:power":
          s.testPower = .init(ac: (m["ac"] as? Bool) == true, charging: false, battery: 50)
          s.awake.changed()
          relay.send(["type": "test:awake", "held": s.awake.held])
        case "test:awake": relay.send(["type": "test:awake", "held": s.awake.held])
        case "test:status": relay.send(["type": "test:status", "line": s.statusLine])
        case "test:quit":
          print("PEER " + ScreenGuard.report()); print("PEER " + NetGuard.report())
          s.quit()
          relay.send(["type": "test:bye"])
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { exit(0) }
        default: s.handle(type, m)
        }
      }
    }
    RunLoop.main.add(t, forMode: .common)
  }
}

extension SelfTest {
  static func secondCheck(_ a: App, _ dir: String, _ done: @escaping () -> Void) {
    let fm = FileManager.default
    let s = Second.shared
    var r: [(String, Bool)] = []
    func ok(_ n: String, _ v: Bool) { r.append((n, v)) }
    var uids: [String: String] = [:]
    func U(_ tag: String) -> String { if let u = uids[tag] { return u }; let u = UUID().uuidString.lowercased(); uids[tag] = u; return u }
    func later(_ t: Double, _ f: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + t, execute: f) }
    var pOut: [[String: Any]] = [], sOut: [[String: Any]] = []
    let keepPage = s.toPage, keepConfirm = s.confirm
    var pAlerts: [String] = []
    s.toPage = { j in if let d = try? JSONSerialization.jsonObject(with: Data(j.utf8)) as? [String: Any] { pOut.append(d) } }
    s.confirm = { title, text, _, d in pAlerts.append(title + "\n" + text); d(true) }

    // A fictional project with uncommitted work.
    let projects = dir + "/Projects", demo = projects + "/demo", relayDir = dir + "/second-relay"
    try? fm.removeItem(atPath: relayDir)
    try? fm.createDirectory(atPath: demo, withIntermediateDirectories: true)
    let genv = ["PATH": "/usr/bin:/bin", "HOME": dir, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "t@example.invalid"]
    func git(_ args: String...) { SecondGit.run("/usr/bin/git", ["-C", demo] + args, env: genv) }
    if !fm.fileExists(atPath: demo + "/.git") {
      git("init", "-q", "-b", "main")
      try? "test:\n\t@echo committed only\n".write(toFile: demo + "/Makefile", atomically: true, encoding: .utf8)
      git("add", "."); git("commit", "-q", "-m", "fictional")
    }
    try? "test:\n\t@echo second round trip ok\n".write(toFile: demo + "/Makefile", atomically: true, encoding: .utf8)
    let relay = SecondSelfTest.Relay(relayDir, inbox: "to-primary", outbox: "to-peer")
    // The Secondary's shared folder (FICTIONAL files), a secret outside it and a link pointing there.
    let share = dir + "/peer/PS Shared"
    try? fm.removeItem(atPath: share)
    try? fm.createDirectory(atPath: share + "/pics", withIntermediateDirectories: true)
    try? Data("Fictional shared note.\n".utf8).write(to: URL(fileURLWithPath: share + "/notes.txt"))
    try? Data([0x89, 0x50, 0x4e, 0x47]).write(to: URL(fileURLWithPath: share + "/pics/a.png"))
    try? Data("hidden".utf8).write(to: URL(fileURLWithPath: share + "/.hidden"))
    try? Data("fictional secret outside the share".utf8).write(to: URL(fileURLWithPath: dir + "/outside-secret.txt"))
    try? fm.createSymbolicLink(atPath: share + "/link-out.txt", withDestinationPath: dir + "/outside-secret.txt")
    try? fm.createSymbolicLink(atPath: share + "/link-in.txt", withDestinationPath: share + "/notes.txt")
    // A FICTIONAL stand-in for `claude`: writes report.md, answers JSON, keeps its arguments for the check.
    let fakebin = dir + "/fakebin"
    try? fm.createDirectory(atPath: fakebin, withIntermediateDirectories: true)
    try? "#!/bin/bash\nif [ \"$1\" = --help ]; then echo '--tools --allowedTools --disallowedTools --strict-mcp-config --safe-mode dontAsk --output-format --model'; exit 0; fi\nprintf '%s\\n' \"$@\" > ../research-args.txt\nprompt=\"$(cat)\"\nprintf '# Fictional report\\n\\n%s\\n' \"$prompt\" > report.md\nprintf '%s' '{\"result\":\"Fictional research done\"}'\n".write(toFile: fakebin + "/claude", atomically: true, encoding: .utf8)
    chmod(fakebin + "/claude", 0o755)

    // The Secondary: this same build, its own test folder, started and stopped through its handle.
    let peer = Process(), out = Pipe()
    var peerLines: [String] = []
    peer.executableURL = URL(fileURLWithPath: Bundle.main.executablePath ?? "/nonexistent")
    var penv = ProcessInfo.processInfo.environment
    for k in penv.keys where k.hasPrefix("PS_SELFTEST") { penv[k] = nil }
    penv["PS_SELFTEST"] = dir + "/peer"; penv["PS_SELFTEST_PEER"] = relayDir; penv["PS_SELFTEST_SECOND_ROLE"] = "primary"
    // The other Mac is an M1 that kept "main Mac" from an older choice (1 Nov 2026): both Macs are main at first.
    penv["PS_SELFTEST_SECOND_CHIP"] = "Apple M1"; penv["PS_SELFTEST_SECOND_CHOSEN"] = "1"
    penv["PS_SELFTEST_SECOND_NAME"] = "Test Secondary"; penv["PS_SELFTEST_SECOND_STATEVERY"] = "3600"
    penv["PS_SELFTEST_SECOND_QUIET"] = "1"; penv["PS_SELFTEST_SECOND_TOOLS"] = fakebin
    try? fm.createDirectory(atPath: dir + "/peer", withIntermediateDirectories: true)
    peer.environment = penv
    peer.standardOutput = out; peer.standardError = FileHandle.nullDevice; peer.standardInput = FileHandle.nullDevice
    out.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      guard !d.isEmpty else { h.readabilityHandler = nil; return }
      let lines = String(decoding: d, as: UTF8.self).split(separator: "\n").map(String.init)
      DispatchQueue.main.async { peerLines += lines }
    }
    let pump = Timer(timeInterval: 0.1, repeats: true) { _ in sOut += relay.read() }
    RunLoop.main.add(pump, forMode: .common)

    func wait(_ what: String, _ secs: Double, _ cond: @escaping () -> Bool, _ then: @escaping (Bool) -> Void) {
      let until = Date().addingTimeInterval(secs)
      func tick() { if cond() { then(true) } else if Date() > until { print("SECOND: waited for \(what), gave up"); then(false) } else { later(0.1, tick) } }
      tick()
    }
    func first(_ list: [[String: Any]], _ type: String, _ match: ([String: Any]) -> Bool = { _ in true }) -> [String: Any]? { list.first { $0["type"] as? String == type && match($0) } }
    func env(_ m: [String: Any]?) -> SecondEnv? { SecondEnv(m?["env"]) }
    var peerMe: [String: Any] = [:], primaryMe: [String: Any] = [:]
    var peerDev: String { peerMe["device"] as? String ?? "" }
    var peerPub: String { peerMe["pub"] as? String ?? "" }
    /// The Secondary's signed job statuses for one job, checked against its key.
    func jobst(_ job: String) -> [[String: Any]] {
      sOut.filter { $0["type"] as? String == "second:jobst" }.compactMap { m -> [String: Any]? in
        guard let e = env(m), SecondIdentity.verify(e, pub: peerPub), let b = try? JSONSerialization.jsonObject(with: Data(e.body.utf8)) as? [String: Any], b["job"] as? String == job else { return nil }
        return b
      }
    }
    func finalOf(_ job: String) -> [String: Any]? { jobst(job).last { ["done", "failed", "cancelled", "timeout", "refused"].contains($0["state"] as? String ?? "") } }
    let now = { (Date().timeIntervalSince1970 * 1000).rounded() }
    /// Signs a job as the Primary (through the bridge, like the page) and hands it to the Secondary.
    func sendJob(_ id: String, _ type: String, _ args: [String: Any], bundles: [[String: Any]] = [], raw: Bool = false, next: @escaping (SecondEnv?) -> Void) {
      let body: [String: Any] = ["t": "job", "id": id, "to": peerDev, "type": type, "args": args, "bundles": bundles]
      if raw {
        var b = body; b["v"] = 1; b["from"] = s.testDevice; b["at"] = now(); b["exp"] = now() + 86_400_000
        let e = s.testSign(b); if let e { relay.send(["type": "second:run", "env": e.json, "bundles": []]) }; next(e); return
      }
      s.handle("second:sign", ["req": "job:" + id, "body": body])
      wait("job \(id) signed", 5, { first(pOut, "second:signed") { $0["req"] as? String == "job:" + id } != nil || first(pOut, "second:cancelled") { $0["req"] as? String == "job:" + id } != nil }) { _ in
        let e = env(first(pOut, "second:signed") { $0["req"] as? String == "job:" + id })
        if let e { relay.send(["type": "second:run", "env": e.json, "bundles": bundles.map { ["file": $0["file"] ?? "", "ready": true] }]) }
        next(e)
      }
    }
    /// Sends a file the way the page does: one signed body, then its chunks in order.
    func sendFile(_ fid: String, _ name: String, _ data: Data, purpose: String, chunk: Int, extra: [String: Any] = [:], next: @escaping ([String: Any]?) -> Void) {
      let n = max(1, (data.count + chunk - 1) / chunk)
      let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      var fb: [String: Any] = ["t": "file", "id": fid, "to": peerDev, "name": name, "size": data.count, "sha256": sha, "mime": "application/octet-stream", "purpose": purpose, "chunk": chunk, "n": n]
      for (k, v) in extra { fb[k] = v }
      s.handle("second:sign", ["req": "file:" + fid, "body": fb])
      wait("file \(fid) signed", 5, { first(pOut, "second:signed") { $0["req"] as? String == "file:" + fid } != nil }) { _ in
        guard let e = env(first(pOut, "second:signed") { $0["req"] as? String == "file:" + fid }) else { next(nil); return }
        for i in 0..<n { relay.send(["type": "second:chunk", "env": e.json, "i": i, "n": n, "b64": data.subdata(in: (i * chunk)..<min(data.count, (i + 1) * chunk)).base64EncodedString()]) }
        wait("ack of \(fid)", 20, { first(sOut, "second:signed") { $0["req"] as? String == "ack:" + fid } != nil }) { _ in
          let a = env(first(sOut, "second:signed") { $0["req"] as? String == "ack:" + fid })
          next(a.flatMap { SecondIdentity.verify($0, pub: peerPub) ? (try? JSONSerialization.jsonObject(with: Data($0.body.utf8)) as? [String: Any]) ?? nil : nil })
        }
      }
    }
    func stats() -> [[String: Any]] {
      sOut.filter { $0["type"] as? String == "second:stat" }.compactMap { m in
        env(m).flatMap { e in SecondIdentity.verify(e, pub: peerPub) ? (try? JSONSerialization.jsonObject(with: Data(e.body.utf8)) as? [String: Any]) ?? nil : nil }
      }
    }

    // 20. Drag and drop (protocol v1.2): the outbox stages files and folders (names, dates), the page reads them
    // 4 MB at a time, a packed folder is checked name by name and unpacks with its dates, a landing cut off by a
    // restart carries on from the disk, a dragged out file lands exactly where Finder wanted it. Files only, here.
    func drops() {
      let places = s.places, base = dir + "/drop-src"
      try? fm.removeItem(atPath: base); try? fm.removeItem(atPath: SecondOutbox.dir(places))
      let folder = base + "/Фото ✓ 2026", sub = folder + "/日本 trip", old = Date(timeIntervalSince1970: 1_700_000_000)
      try? fm.createDirectory(atPath: sub, withIntermediateDirectories: true)
      try? fm.createDirectory(atPath: base + "/Fake.app/Contents", withIntermediateDirectories: true)
      try? Data("<plist/>".utf8).write(to: URL(fileURLWithPath: base + "/Fake.app/Contents/Info.plist"))
      let photo = Data((0..<300_000).map { UInt8(truncatingIfNeeded: $0 &* 31) })
      try? photo.write(to: URL(fileURLWithPath: sub + "/kyōto 🌸.jpg"))
      try? Data("fictional notes\n".utf8).write(to: URL(fileURLWithPath: folder + "/notes with spaces.txt"))
      try? fm.setAttributes([.modificationDate: old], ofItemAtPath: sub + "/kyōto 🌸.jpg")
      let single = base + "/Report Q4 é.pdf"
      try? photo.write(to: URL(fileURLWithPath: single)); try? fm.setAttributes([.modificationDate: old], ofItemAtPath: single)
      try? Data().write(to: URL(fileURLWithPath: base + "/empty.txt"))
      DispatchQueue.global(qos: .utility).async {
        // The outbox: a file (cloned, its hash and date), a folder and a package (packed), an empty file refused.
        let st = SecondOutbox.stage([URL(fileURLWithPath: single), URL(fileURLWithPath: folder), URL(fileURLWithPath: base + "/Fake.app"), URL(fileURLWithPath: base + "/empty.txt")],
                                    target: ["kind": "files", "root": "ps-shared", "dir": "Inbox"], places: places)
        let f = st.items.first { $0["name"] as? String == "Report Q4 é.pdf" }, d = st.items.first { $0["name"] as? String == "Фото ✓ 2026" }
        let app = st.items.first { $0["name"] as? String == "Fake.app" }
        let sum = SHA256.hash(data: photo).map { String(format: "%02x", $0) }.joined()
        let fid = f?["id"] as? String ?? "", did = d?["id"] as? String ?? ""
        let stagedOk = st.items.count == 3 && f?["sha256"] as? String == sum && (f?["m"] as? NSNumber)?.doubleValue == 1_700_000_000_000 && f?["pack"] == nil
          && d?["pack"] as? String == "zip" && app?["pack"] as? String == "zip" && st.problems.count == 1 && st.problems[0].contains("empty")
        var back = Data(), i = 0
        while let c = SecondOutbox.read(places, fid, i), !c.isEmpty { back.append(c); i += 1 }
        let zipPath = SecondOutbox.dir(places) + "/" + did + "/data"
        let check = SecondZip.check(zipPath)
        var tops: Set<String> = []
        if case .success(let info) = check { tops = info.tops }
        // Crafted zips: a ".." name, an absolute name, and a file written through a link the zip itself makes.
        func zip(_ entries: [(String, UInt32)]) -> String {
          var local = Data(), cd = Data()
          func le16(_ v: Int) -> Data { Data([UInt8(v & 0xff), UInt8(v >> 8 & 0xff)]) }
          func le32(_ v: Int) -> Data { le16(v & 0xffff) + le16(v >> 16 & 0xffff) }
          for (name, mode) in entries {
            let n = Data(name.utf8), off = local.count
            // local header: signature, version, flags, method, time, date, crc, sizes, name length, extra length, name
            for part in [le32(0x0403_4b50), le16(20), le16(0), le16(0), le16(0), le16(0), le32(0), le32(0), le32(0), le16(n.count), le16(0), n] { local.append(part) }
            // central header: the same, plus comment length, disk, internal and external attributes (the mode), offset
            for part in [le32(0x0201_4b50), le16(0x031e), le16(20), le16(0), le16(0), le16(0), le16(0), le32(0), le32(0), le32(0)] { cd.append(part) }
            for part in [le16(n.count), le16(0), le16(0), le16(0), le16(0), le32(Int(mode) << 16), le32(off), n] { cd.append(part) }
          }
          var end = Data()
          for part in [le32(0x0605_4b50), le16(0), le16(0), le16(entries.count), le16(entries.count), le32(cd.count), le32(local.count), le16(0)] { end.append(part) }
          let p = base + "/crafted-\(UUID().uuidString).zip"
          var all = local; all.append(cd); all.append(end)
          try? all.write(to: URL(fileURLWithPath: p))
          return p
        }
        func refused(_ p: String) -> Bool { if case .failure = SecondZip.check(p) { return true }; return false }
        let dotdot = refused(zip([("../evil.txt", 0o100644)])), absolute = refused(zip([("/etc/evil", 0o100644)]))
        let through = refused(zip([("a/link", 0o120777), ("a/link/evil.txt", 0o100644)])), plain = !refused(zip([("ok/a.txt", 0o100644), ("ok/b/", 0o040755)]))
        // Landing the packed folder in 64 KB chunks; PS "restarts" halfway (a new landing) and carries on from its disk.
        let zdata = (try? Data(contentsOf: URL(fileURLWithPath: zipPath))) ?? Data()
        let chunk = 64 * 1024, n = max(1, (zdata.count + chunk - 1) / chunk)
        let lid = UUID().uuidString.lowercased(), into = dir + "/drop-land"
        try? fm.removeItem(atPath: into)
        let body: [String: Any] = ["id": lid, "name": "Фото ✓ 2026", "size": zdata.count, "sha256": SHA256.hash(data: zdata).map { String(format: "%02x", $0) }.joined(),
                                   "purpose": "user", "chunk": chunk, "n": n, "pack": "zip"]
        let l1 = SecondLanding(places: places, downloads: into)
        let half = n / 2
        for k in 0..<half { _ = l1.chunk(body, i: k, n: n, data: zdata.subdata(in: (k * chunk)..<min(zdata.count, (k + 1) * chunk))) }
        let l2 = SecondLanding(places: places, downloads: into)
        let have = l2.have(body)
        var done: SecondLanding.Done?
        for k in have..<n { done = l2.chunk(body, i: k, n: n, data: zdata.subdata(in: (k * chunk)..<min(zdata.count, (k + 1) * chunk))) }
        let landedDir = done?.path ?? ""
        let photoBack = fm.contents(atPath: landedDir + "/日本 trip/kyōto 🌸.jpg")
        let photoDate = (try? fm.attributesOfItem(atPath: landedDir + "/日本 trip/kyōto 🌸.jpg"))?[.modificationDate] as? Date
        // A file dragged out to Finder lands exactly at the promised path, keeping the sender's date.
        let gid = UUID().uuidString.lowercased(), exact = dir + "/drop-finder/Report Q4 é.pdf"
        try? fm.createDirectory(atPath: dir + "/drop-finder", withIntermediateDirectories: true)
        let l3 = SecondLanding(places: places, downloads: into)
        l3.exactDest = { $0 == gid ? exact : nil }
        var bytesSeen = 0
        l3.onBytes = { g, b in if g == gid { bytesSeen = b } }
        let fbody: [String: Any] = ["id": UUID().uuidString.lowercased(), "name": "Report Q4 é.pdf", "size": photo.count, "sha256": sum, "purpose": "share", "get": gid, "chunk": 4 << 20, "n": 1, "m": 1_700_000_000_000]
        let fdone = l3.chunk(fbody, i: 0, n: 1, data: photo)
        let exactDate = (try? fm.attributesOfItem(atPath: exact))?[.modificationDate] as? Date
        DispatchQueue.main.async {
          ok("drop-stage", stagedOk)
          ok("drop-read-chunks", back == photo)
          ok("drop-folder-packed", tops == ["Фото ✓ 2026"])
          ok("drop-zip-dotdot-refused", dotdot); ok("drop-zip-absolute-refused", absolute); ok("drop-zip-link-through-refused", through); ok("drop-zip-plain-ok", plain)
          ok("drop-land-resumes", have == half && done?.ok == true)
          ok("drop-folder-unpacked", (landedDir as NSString).lastPathComponent == "Фото ✓ 2026" && photoBack == photo
             && fm.contents(atPath: landedDir + "/notes with spaces.txt") == Data("fictional notes\n".utf8))
          ok("drop-folder-dates", photoDate.map { abs($0.timeIntervalSince(old)) < 2 } ?? false)
          ok("drop-folder-quarantined", getxattr(landedDir + "/日本 trip/kyōto 🌸.jpg", "com.apple.quarantine", nil, 0, 0, 0) > 0)
          ok("drop-finder-exact", fdone?.ok == true && fdone?.path == exact && fm.contents(atPath: exact) == photo && bytesSeen == photo.count
             && exactDate.map { abs($0.timeIntervalSince(old)) < 2 } ?? false)
          ok("drop-targets", SecondDropZone.targetOk(["kind": "files"]) && SecondDropZone.targetOk(["kind": "msg"]) && SecondDropZone.targetOk(["kind": "files", "root": "ps-shared", "dir": "A/B"])
             && !SecondDropZone.targetOk(["kind": "files", "dir": "../x"]) && !SecondDropZone.targetOk(["kind": "get"]) && !SecondDropZone.targetOk(["kind": "msg", "dir": "x"]))
          let wv = SecondDropWebView(frame: .zero)
          wv.takeSecondDrops()
          let types = Set(wv.registeredDraggedTypes)
          ok("drop-view-takes-promises", types.contains(.fileURL) && NSFilePromiseReceiver.readableDraggedTypes.allSatisfy { types.contains(NSPasteboard.PasteboardType($0)) })
          ok("drop-link-name", SecondDragLoad.name(for: URL(string: "https://example.com/a/b/photo.png"), title: nil, ext: "png", fallback: "Picture") == "photo.png"
             && SecondDragLoad.name(for: URL(string: "https://example.com/"), title: "Fictional page: notes", ext: "webloc", fallback: "Link") == "Fictional page- notes.webloc")
          // second:read over the bridge, as the page asks for it.
          pOut.removeAll()
          s.handle("second:read", ["req": "read-t1", "id": fid, "i": 0])
          wait("second:read", 5, { first(pOut, "second:readOk") != nil }) { _ in
            ok("drop-bridge-read", Data(base64Encoded: first(pOut, "second:readOk")?["b64"] as? String ?? "") == photo)
            for x in st.items { if let id = x["id"] as? String { SecondOutbox.remove(places, id) } }
            outsourceCheck()
          }
        }
      }
    }

    // 21. Outsourcing from a chat (protocol v1.3): each Mac learns the other's keys from its signed hello; a task sealed
    // here (X-Wing on this macOS) opens on the peer (the second Mac), runs in its sandbox with the fictional claude,
    // and comes back sealed: the chat's result file, the copy in Downloads, From your other Mac, the ack that deletes the
    // folder there. A replayed job and a tampered one are refused.
    func outsourceCheck() {
      let peerRoot = dir + "/peer/Second"
      var cards: [String] = []
      let keepCard = s.oCard
      s.oCard = { t, _, _ in cards.append(t) }   // never a real card from a test copy (the notes check counts them)
      pOut.removeAll()
      s.handle("second:sign", ["req": "o-hello-p", "body": ["t": "dev", "to": "all", "name": "Test Mac"]])
      relay.send(["type": "second:sign", "req": "o-hello-s", "body": ["t": "dev", "to": "all", "name": "Peer"]])
      wait("both hellos", 10, { first(pOut, "second:signed") { $0["req"] as? String == "o-hello-p" } != nil && first(sOut, "second:signed") { $0["req"] as? String == "o-hello-s" } != nil }) { _ in
        let hp = first(pOut, "second:signed") { $0["req"] as? String == "o-hello-p" }?["env"], hs = first(sOut, "second:signed") { $0["req"] as? String == "o-hello-s" }?["env"]
        ok("outsource-hello-has-keys", (env(["env": hp as Any])?.body ?? "").contains("\"okeys\"") && (env(["env": hs as Any])?.body ?? "").contains("\"xwing\""))
        s.handle("second:peerHello", ["env": hs as Any])
        relay.send(["type": "second:peerHello", "env": hp as Any])
        wait("the peer's keys", 10, { s.okeys?.peer(peerDev) != nil }) { _ in
          // As `second.ts outsource` does it: a request file in the CLI folder.
          let rid = "o-cli-0001"
          let req: [String: Any] = ["id": rid, "type": "outsource", "args": ["title": "Fictional note apps", "prompt": "Compare three fictional note apps."]]
          try? JSONSerialization.data(withJSONObject: req).write(to: URL(fileURLWithPath: s.places.root + "/cli/req-" + rid + ".json"))
          func res() -> [String: Any]? { (fm.contents(atPath: s.places.root + "/cli/res-" + rid + ".json")).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } }
          wait("sealed and sent", 10, { first(pOut, "second:ojobOut") != nil && res()?["state"] as? String == "sent" }) { _ in
            let out = first(pOut, "second:ojobOut")!, job = out["job"] as? String ?? ""
            let jenv = out["env"] as? [String: Any] ?? [:]
            ok("outsource-sealed-xwing", res()?["suite"] as? String == "xwing" && !((jenv["body"] as? String) ?? "").contains("note apps"))
            relay.send(["type": "second:ojob", "env": jenv])
            // The peer's sealed statuses come back through its page: handed to this Mac's PS as the page would.
            var handed = Set<String>()
            let fwd = Timer(timeInterval: 0.2, repeats: true) { _ in
              for m in sOut where m["type"] as? String == "second:oresOut" {
                guard let e = m["env"] as? [String: Any], let sig = e["sig"] as? String, !handed.contains(sig) else { continue }
                handed.insert(sig); s.handle("second:ores", ["env": e])
              }
            }
            RunLoop.main.add(fwd, forMode: .common)
            wait("the result", 30, { ["done", "failed", "refused", "timeout"].contains(res()?["state"] as? String ?? "") }) { _ in
              let r = res() ?? [:]
              let report = (r["report"] as? String).flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } ?? ""
              ok("outsource-done", r["state"] as? String == "done" && r["summary"] as? String == "Fictional research done")
              ok("outsource-report-copy", report.contains("Compare three fictional note apps") && (r["folder"] as? String ?? "").contains("/Downloads/From your other Mac/") && (r["folder"] as? String ?? "").hasSuffix("Fictional note apps"))
              let args = (try? String(contentsOfFile: peerRoot + "/outsource/research-args.txt", encoding: .utf8)) ?? ""
              ok("outsource-sandbox", args.contains("WebSearch,WebFetch,Read,Write,Edit") && args.contains("--strict-mcp-config") && args.contains("dontAsk") && !args.contains("Bash("))
              ok("outsource-ack-asked", first(pOut, "second:oack") { $0["job"] as? String == job } != nil)
              ok("outsource-folder-made", fm.fileExists(atPath: peerRoot + "/outsource/" + job))
              s.handle("second:sign", ["req": "ack:" + job, "body": ["t": "ack", "to": peerDev, "ref": job, "ok": true]])
              wait("the ack", 5, { first(pOut, "second:signed") { $0["req"] as? String == "ack:" + job } != nil }) { _ in
                relay.send(["type": "second:oacked", "env": first(pOut, "second:signed") { $0["req"] as? String == "ack:" + job }?["env"] as Any])
                // A replay of the same sealed job, and a tampered copy.
                let before = sOut.filter { $0["type"] as? String == "second:oresOut" }.count
                relay.send(["type": "second:ojob", "env": jenv])
                var t = jenv; t["body"] = ((jenv["body"] as? String) ?? "").replacingOccurrences(of: "\"ojob\"", with: "\"ojob\" ")
                relay.send(["type": "second:ojob", "env": t])
                wait("the folder gone", 8, { !fm.fileExists(atPath: peerRoot + "/outsource/" + job) }) { gone in
                  ok("outsource-folder-gone-after-ack", gone)
                  later(1.5) {
                    // The replay is dropped without a word (seen before); the tampered copy gets one sealed refusal,
                    // which never overwrites the finished job.
                    let after = sOut.filter { $0["type"] as? String == "second:oresOut" }
                    ok("outsource-replay-and-tamper-refused", after.count == before + 1)
                    ok("outsource-finished-job-kept", res()?["state"] as? String == "done")
                    ok("outsource-card", cards == ["Your other Mac finished: Fictional note apps"])
                    s.oCard = keepCard
                    fwd.invalidate()
                    keychainCheck()
                  }
                }
              }
            }
          }
        }
      }
    }

    // 22. A Keychain that will not give the key (2 Nov 2026: the M1 came up unpaired after an update): Second
    // Computer goes off with a card, makes nothing new and drops no pairing; Allow reads again, same Mac, still paired.
    func keychainCheck() {
      let dev = s.testDevice, peers = s.testPeers, keyFiles = (try? fm.contentsOfDirectory(atPath: s.places.root + "/keys")) ?? []
      let keyBytes = fm.contents(atPath: s.places.root + "/keys/key")
      s.testDenyNextRead = true
      pOut.removeAll()
      s.testReload()
      wait("the Allow card", 10, { s.keyCardShown != nil }) { _ in
        let off = first(pOut, "second")
        ok("keychain-blocked-off-not-unpaired", off?["me"] is NSNull && ((off?["off"] as? [String: Any])?["why"] as? String ?? "").contains("needs your OK"))
        ok("keychain-blocked-card", (s.keyCardShown ?? "").contains("Your Macs stay paired"))
        ok("keychain-blocked-nothing-new", fm.contents(atPath: s.places.root + "/keys/key") == keyBytes && ((try? fm.contentsOfDirectory(atPath: s.places.root + "/keys")) ?? []) == keyFiles)
        ok("keychain-blocked-page-says-allow", ((off?["off"] as? [String: Any])?["here"] as? String ?? "").contains("Click Allow"))
        // 4 Nov 2026: on the M4 "This is my main Mac" did nothing at all while the key was blocked. Every click
        // now gets an answer, the window still opens, and nothing changes until the key is readable.
        let roleBefore = s.role, keepOpen = s.openWindow
        var opened = 0
        s.openWindow = { _ in opened += 1 }
        pOut.removeAll()
        s.handle("second:role", ["role": "secondary"])
        s.handle("second:window", [:])
        let said = first(pOut, "second:off")
        ok("keychain-blocked-click-answered", said?["op"] as? String == "role" && (said?["why"] as? String ?? "").contains("Allow") && s.role == roleBefore)
        ok("keychain-blocked-window-opens", opened == 1)
        s.openWindow = keepOpen
        // Allow from the page, and the developer closes the Keychain question: still off, nothing lost, the page says so.
        s.testDenyAllowedRead = true
        pOut.removeAll()
        s.handle("second:allow", [:])
        wait("the second Allow card", 10, { (s.keyCardShown ?? "").contains("Not allowed yet") }) { _ in
          let again = pOut.last { $0["type"] as? String == "second" }
          let o = again?["off"] as? [String: Any]
          ok("keychain-allow-denied-says-so", o?["retried"] as? Bool == true && (o?["here"] as? String ?? "").contains("Not allowed yet") && o?["allowing"] as? Bool == false)
          ok("keychain-allow-denied-nothing-new", fm.contents(atPath: s.places.root + "/keys/key") == keyBytes)
          pOut.removeAll()
          s.keyAction("sk:allow", "allow")
          // On again only once PS tells the page so (its old identity stays in memory while off, so the device alone proves nothing).
          let onAgain = { pOut.contains { $0["type"] as? String == "second" && $0["me"] is [String: Any] } }
          wait("allowed", 10, { s.keyCardShown == nil && onAgain() }) { _ in
            ok("keychain-allow-same-mac-still-paired", s.testDevice == dev && s.testPeers == peers && !peers.isEmpty)
            pOut.removeAll()
            s.handle("second:allow", [:])   // a late click once it is readable: just the state again
            ok("keychain-allow-late-click-harmless", first(pOut, "second:off") == nil && (first(pOut, "second")?["me"] as? [String: Any])?["device"] as? String == dev)
            finish()
          }
        }
      }
    }

    func finish() {
      print("SECOND CHECK:", r.map { "\($0.0)=\($0.1 ? "ok" : "FAIL")" }.joined(separator: " "))
      relay.send(["type": "test:quit"])
      wait("the Secondary to quit", 10, { !peer.isRunning }) { gone in
        if !gone { peer.terminate() }   // its own handle, never by name
        later(0.5) {
          pump.invalidate()
          for l in peerLines where l.hasPrefix("PEER ") { print(l) }
          print("SECOND PEER:", gone ? "quit by itself" : "stopped through its handle", "exit=\(peer.isRunning ? -1 : peer.terminationStatus)")
          s.handle("second:role", ["role": "none"])
          s.setUnlocked(a.vaultUnlocked)   // as it was: the checks after this one see the same PS
          s.toPage = keepPage; s.confirm = keepConfirm
          done()
        }
      }
    }

    s.handle("second:role", ["role": "primary"])
    s.setUnlocked(true)
    let lineUnpaired = s.statusLine
    s.handle("second:hello", [:])
    // 1. One click pairing (V1.26, the developer: "I just click pair, it scans to see if my M1 is online and connects for
    // me"). Pair is clicked on this copy BEFORE the other copy even runs; its signed "looking" record waits.
    s.handle("second:seek", ["req": "seek-1"])
    wait("the seek", 5, { first(pOut, "second:signed") { $0["req"] as? String == "seek-1" } != nil }) { _ in
    let seekEnv = env(first(pOut, "second:signed") { $0["req"] as? String == "seek-1" })
    let seekBody = seekEnv.flatMap { try? JSONSerialization.jsonObject(with: Data($0.body.utf8)) as? [String: Any] } ?? [:]
    ok("seek-signed", seekEnv.map { SecondIdentity.verify($0, pub: s.testPub) } == true && seekBody["t"] as? String == "seek" && seekBody["primaryPub"] as? String == s.testPub)
    ok("seek-kept", ((pOut.last { $0["type"] as? String == "second" }?["seeks"] as? [String]) ?? []) == [seekBody["id"] as? String ?? "?"])
    // The other copy starts now, after the click.
    do { try peer.run() } catch { ok("peer-started", false); finish(); return }
    relay.send(["type": "second:hello"])
    wait("both Macs ready", 15, { first(pOut, "second") != nil && first(sOut, "second") != nil }) { ready in
      ok("two-test-copies", ready && peer.isRunning)
      primaryMe = (pOut.last { $0["type"] as? String == "second" }?["me"] as? [String: Any]) ?? [:]
      peerMe = (first(sOut, "second")?["me"] as? [String: Any]) ?? [:]
      ok("stale-role-both-main", primaryMe["role"] as? String == "primary" && peerMe["role"] as? String == "primary"
         && primaryMe["chip"] as? String == "Apple M4" && peerMe["chip"] as? String == "Apple M1" && peerMe["chosen"] as? Bool == true && peerMe["app"] as? String == Second.appVersion)
      // The starting role from the chip (1 Nov): only while the developer has not chosen one; it never grants trust.
      let R = Second.startRole
      ok("chip-m1-secondary", R(nil, false, "Apple M1") == ("secondary", false) && R("none", false, "Apple M1") == ("secondary", false) && R(nil, false, "Apple M1 Pro").role == "secondary")
      ok("chip-m4-primary", R(nil, false, "Apple M4") == ("primary", false) && R("none", false, "Apple M4").role == "primary")
      ok("chip-unknown-none", R(nil, false, "Apple M3") == ("none", false) && R(nil, false, "Intel(R) Core(TM) i7") == ("none", false) && R(nil, false, "") == ("none", false) && R(nil, false, "Apple M10").role == "none")
      ok("chip-chosen-role-wins", R("primary", true, "Apple M1") == ("primary", true) && R("secondary", false, "Apple M4") == ("secondary", true) && R("none", true, "Apple M1") == ("none", true) && R("none", true, "Apple M4") == ("none", true))
      ok("chip-is-read", !Second.chip().isEmpty)
      ok("chip-grants-no-trust", s.testTrustedCount == 0)   // a role alone trusts nobody: pairing has not run yet
      ok("status-not-paired", lineUnpaired == "Not paired yet")
      pairWindow(seekEnv) {
      // What the other Mac's page does when the record reaches it: hand it to its PS. Nothing is asked there.
      relay.send(["type": "second:autotrust", "env": seekEnv?.json ?? [:]])
      wait("the other copy's answer", 10, { first(sOut, "second:signed") { $0["req"] as? String == "pairok:auto" } != nil }) { _ in
        let okEnv = env(first(sOut, "second:signed") { $0["req"] as? String == "pairok:auto" })
        let okBody = okEnv.flatMap { try? JSONSerialization.jsonObject(with: Data($0.body.utf8)) as? [String: Any] } ?? [:]
        peerMe = (sOut.last { $0["type"] as? String == "second" }?["me"] as? [String: Any]) ?? peerMe
        let peerAsked = sOut.filter { $0["type"] as? String == "test:alert" }.count
        let notices = sOut.filter { $0["type"] as? String == "test:notice" }.compactMap { $0["title"] as? String }
        ok("oneclick-answer-signed", okEnv.map { SecondIdentity.verify($0, pub: peerPub) } == true && okBody["seek"] as? String == seekBody["id"] as? String && okBody["primaryPub"] as? String == s.testPub)
        ok("oneclick-old-role-left", peerMe["role"] as? String == "secondary" && peerMe["chosen"] as? Bool == true)
        ok("oneclick-nothing-asked", peerAsked == 0 && pAlerts.isEmpty)
        ok("oneclick-one-notice", notices == ["Paired with Test Mac"])
        // This copy checks the answer against its own seek and trusts the other copy back.
        s.handle("second:autopair", ["env": okEnv?.json ?? [:]])
        wait("trusted back", 5, { s.testTrustedCount == 1 }) { back in
          let last = pOut.last { $0["type"] as? String == "second" } ?? [:]
          ok("oneclick-paired-both", back && (((last["trusted"] as? [[String: Any]]) ?? []).first?["device"] as? String) == peerDev
             && ((sOut.last { $0["type"] as? String == "second" }?["trusted"] as? [[String: Any]]) ?? []).contains { $0["role"] as? String == "primary" && $0["pub"] as? String == s.testPub })
          ok("oneclick-seek-closed", ((last["seeks"] as? [String]) ?? ["?"]).isEmpty)
          ok("roles", primaryMe["role"] as? String == "primary" && peerMe["role"] as? String == "secondary")
          // Refusals: the same record again, a stranger's record in the main Mac's name, a day old record, and an
          // answer to a seek this copy never made.
          let stranger = SecondIdentity(store: SecondFileStore(dir: dir + "/stranger"), seenPath: dir + "/stranger/seen.json")
          var forgedSeek = stranger.sign(["v": 1, "t": "seek", "id": "forged-seek-1", "from": s.testDevice, "to": "all", "at": now(), "primary": s.testDevice, "primaryPub": s.testPub, "names": ["p": "Evil"]])!
          forgedSeek.by = s.testDevice
          let oldSeek: [String: Any] = ["v": 1, "t": "seek", "id": "old-seek-1", "from": s.testDevice, "to": "all", "at": now() - 25 * 3_600_000, "primary": s.testDevice, "primaryPub": s.testPub, "names": ["p": "Test Mac"]]
          let oldEnv = s.testSign(oldSeek)
          let cancelled0 = sOut.filter { $0["type"] as? String == "second:cancelled" && $0["req"] as? String == "pairok:auto" }.count
          relay.send(["type": "second:autotrust", "env": seekEnv?.json ?? [:]])
          relay.send(["type": "second:autotrust", "env": forgedSeek.json])
          relay.send(["type": "second:autotrust", "env": oldEnv?.json ?? [:]])
          var strangerOk = stranger.sign(["v": 1, "t": "pairok", "id": "forged-ok-1", "from": stranger.device, "to": s.testDevice, "at": now(), "primary": s.testDevice, "primaryPub": s.testPub,
                                          "secondary": stranger.device, "secondaryPub": stranger.pub, "seek": "never-asked", "names": ["s": "Evil"]])!
          strangerOk.by = stranger.device
          s.handle("second:autopair", ["env": strangerOk.json])
          // A forged pairing in the old (V1.25) way is still refused too.
          let fake = stranger.sign(["v": 1, "t": "pair", "id": "forged-pair-1", "from": s.testDevice, "to": peerDev, "at": now(), "primary": s.testDevice,
                                    "primaryPub": primaryMe["pub"] ?? "", "secondary": peerDev, "secondaryPub": peerPub, "names": ["p": "Evil", "s": "x"]])!
          var forged = fake; forged.by = s.testDevice
          relay.send(["type": "second:trust", "env": forged.json])
          // 2. Code: a bundle of the uncommitted work, sent as a file into the Secondary's mirror.
          s.handle("second:bundle", ["req": "bundle-0001", "project": "demo"])
          wait("bundle and the refusals", 15, { first(pOut, "second:bundled") != nil && first(sOut, "second:cancelled") { $0["req"] as? String == "pairok" } != nil
                 && sOut.filter { $0["type"] as? String == "second:cancelled" && $0["req"] as? String == "pairok:auto" }.count >= cancelled0 + 3 }) { _ in
            let bm = first(pOut, "second:bundled") ?? [:]
            let head = bm["head"] as? String ?? ""
            // The forged pairing (a stranger's signature, by = the primary, the primary's real pub in the body): refused
            // in so many words, it never reached an alert, no second pairok was signed, and the Secondary still
            // trusts exactly one primary key, the real one.
            let refusedForged = first(sOut, "second:cancelled") { $0["req"] as? String == "pairok" } != nil
            let pairoks = sOut.filter { $0["type"] as? String == "second:signed" && ($0["req"] as? String ?? "").hasPrefix("pairok") }.count
            let trustAlerts = sOut.filter { $0["type"] as? String == "test:alert" }.count
            let primaries = ((sOut.last { $0["type"] as? String == "second" }?["trusted"] as? [[String: Any]]) ?? []).filter { $0["role"] as? String == "primary" }
            ok("forged-pair-refused", refusedForged)
            ok("oneclick-refusals", sOut.filter { $0["type"] as? String == "second:cancelled" && $0["req"] as? String == "pairok:auto" }.count == cancelled0 + 3 && s.testTrustedCount == 1)
            ok("forged-pair-nothing-trusted", pairoks == 1 && trustAlerts == 0 && primaries.count == 1 && primaries.first?["pub"] as? String == primaryMe["pub"] as? String)
            ok("bundle-dirty-work", bm["dirty"] as? Bool == true && SecondJobs.isSha(head) && (bm["files"] as? [String]) == ["Makefile"])
            let bundle = Data(base64Encoded: bm["b64"] as? String ?? "") ?? Data()
            sendFile(U("bundle-file"), "demo.bundle", bundle, purpose: "bundle", chunk: 64 * 1024) { ack in
              ok("bundle-acked", ack?["ok"] as? Bool == true && ack?["ref"] as? String == U("bundle-file"))
              // 3. A project's tests on that code.
              sendJob(U("job-tests-0001"), "tests", ["project": "demo", "head": head, "preset": "auto"], bundles: [["project": "demo", "file": U("bundle-file"), "head": head]]) { e in
                ok("job-signed", e != nil)
                wait("tests job", 40, { finalOf(U("job-tests-0001")) != nil }) { _ in
                  let f = finalOf(U("job-tests-0001")) ?? [:]
                  ok("job-round-trip", f["state"] as? String == "done" && f["summary"] as? String == "second round trip ok" && (f["tail"] as? String ?? "").contains("second round trip ok"))
                  ok("job-states", jobst(U("job-tests-0001")).compactMap { $0["state"] as? String }.starts(with: ["queued", "running"]))
                  ok("jobst-to-primary", f["to"] as? String == s.testDevice && f["from"] as? String == peerDev)
                  ok("stat-has-code", stats().last.flatMap { $0["have"] as? [String: String] }?["demo"] == head)
                  // 4. A secret in the output never leaves the Secondary.
                  sendJob(U("job-echo-0001"), "probe", ["probe": "echo"]) { _ in
                    wait("echo", 15, { finalOf(U("job-echo-0001")) != nil }) { _ in
                      let t = finalOf(U("job-echo-0001"))?["tail"] as? String ?? ""
                      ok("secret-hidden", t.contains("probe done") && !t.contains("FAKEFAKE") && t.contains("[hidden]"))
                      // 5. A timeout.
                      sendJob(U("job-sleep-0001"), "probe", ["probe": "sleep", "seconds": 2]) { _ in
                        wait("timeout", 20, { finalOf(U("job-sleep-0001")) != nil }) { _ in
                          ok("timeout", finalOf(U("job-sleep-0001"))?["state"] as? String == "timeout")
                          // 6. A cancel: the job and the process it started are both gone.
                          sendJob(U("job-tree-0001"), "probe", ["probe": "tree"]) { _ in
                            wait("tree running", 10, { jobst(U("job-tree-0001")).contains { $0["state"] as? String == "running" } }) { _ in
                              later(1.0) {
                                sendJob(U("job-cancel-001"), "cancel", ["job": U("job-tree-0001")]) { _ in
                                  wait("cancelled", 25, { finalOf(U("job-tree-0001")) != nil }) { _ in
                                    let f = finalOf(U("job-tree-0001")) ?? [:]
                                    let pids = (f["tail"] as? String ?? "").split(separator: "\n").first { $0.hasPrefix("PIDS ") }.map { $0.split(separator: " ").dropFirst().compactMap { Int32($0) } } ?? []
                                    ok("cancel", f["state"] as? String == "cancelled" && finalOf(U("job-cancel-001"))?["state"] as? String == "done")
                                    ok("cancel-tree-gone", pids.count == 2 && !pids.contains { SafeSignal.exists($0) })
                                    refusals(head)
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

    // 0. The Second Computer window, one click (V1.26): with the real window page (PS_SELFTEST_WEB = this release's
    // dist-ps) fed the two copies' signed records. Before: This Mac, Your other Mac and ONE button, no code and no
    // Seen, Pair, Trust steps; its click sends Pair (taken here by testLooks, as the main page would get it). While
    // looking: "Looking for your other Mac..."; after 30 s: no spinner, "has not answered" and the exact reason.
    // After: paired, Set up gone. Clicks are DOM clicks in the invisible, parked window.
    // The real bridge first (1 Nov 2026: on the developer's Macs no hello was ever signed, because the page sent the body as
    // text and PS dropped it; the checks below hand the body straight to handle and never saw it). The real page's
    // web view posts JSON text that main.swift parses, the body once as an object (pages from 1 Nov) and once as
    // text (older pages): both must come back signed.
    func pairWindow(_ seekEnv: SecondEnv?, _ next: @escaping () -> Void) {
      func got(_ req: String) -> [String: Any] {
        ((first(pOut, "second:signed") { $0["req"] as? String == req }?["env"] as? [String: Any])?["body"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
      }
      a.main.evaluateJavaScript("['obj','text'].forEach(function(k){var b={t:'dev',name:'Test Mac'};window.webkit.messageHandlers.ps.postMessage(JSON.stringify({type:'second:sign',req:'bridge-'+k,body:k==='obj'?b:JSON.stringify(b)}))});true", completionHandler: nil)
      wait("hellos signed through the bridge", 8, { got("bridge-obj")["t"] != nil && got("bridge-text")["t"] != nil }) { _ in
        ok("bridge-hello-signed", got("bridge-obj")["t"] as? String == "dev" && got("bridge-obj")["pub"] as? String != nil)
        ok("bridge-hello-signed-old-page", got("bridge-text")["t"] as? String == "dev")
        pairWindowRest(seekEnv, next)
      }
    }
    func pairWindowRest(_ seekEnv: SecondEnv?, _ next: @escaping () -> Void) {
      let keepState = a.lastState
      var looks: [String] = []
      func signedEnv(_ out: [[String: Any]], _ req: String) -> [String: Any]? { first(out, "second:signed") { $0["req"] as? String == req }?["env"] as? [String: Any] }
      func body(_ e: [String: Any]?) -> [String: Any] { ((e?["body"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }) ?? [:] }
      func doc(_ id: String, _ kind: String, _ e: [String: Any]?, device: Bool = true) -> [String: Any] {
        var d: [String: Any] = ["env": e ?? [:]]; if device { d["device"] = body(e)["from"] ?? "" }
        return ["id": id, "ws": NSNull(), "kind": kind, "data": d, "author": "t", "updatedAt": "2026-11-01T00:00:00Z"]
      }
      func show(_ me: [String: Any], _ docs: [[String: Any]], seeks: [String] = [], trusted: [[String: Any]] = [], then: @escaping (String, Int) -> Void) {
        let st: [String: Any] = ["unlocked": true, "docs": docs, "lastSync": NSNull(), "red": true,
          "second": ["native": true, "me": me, "trusted": trusted, "verified": [], "progress": [], "projects": [], "pairing": NSNull(), "waitingSince": NSNull(), "note": NSNull(), "seeks": seeks]]
        a.lastState = (try? JSONSerialization.data(withJSONObject: st)).flatMap { String(data: $0, encoding: .utf8) }
        if let st = a.lastState { a.secondWin.load(st) }
        later(0.8) {
          a.secondWin.web?.evaluateJavaScript("JSON.stringify({t: document.body ? document.body.innerText : '', big: document.querySelectorAll('button.sw-primary').length})") { v, _ in
            let j = ((v as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }) ?? [:]
            then(j["t"] as? String ?? "", j["big"] as? Int ?? -1)
          }
        }
      }
      func click(_ label: String, then: @escaping (Bool) -> Void) {
        a.secondWin.web?.evaluateJavaScript("(function(){var b=[...document.querySelectorAll('button')].find(function(x){return x.innerText.trim()==='\(label)'});if(!b)return false;b.click();return true})()") { v, _ in then((v as? Bool) == true) }
      }
      func done() { a.secondWin.testTearDown(); a.lastState = keepState; next() }
      let dev: [String: Any] = ["t": "dev", "name": "Test Mac", "model": "TestMac1,1"]
      var ds = dev; ds["name"] = "Test Secondary"
      s.handle("second:sign", ["req": "dev-p", "body": dev])
      relay.send(["type": "second:sign", "req": "dev-s", "body": ds])
      wait("both announcements", 8, { signedEnv(pOut, "dev-p") != nil && signedEnv(sOut, "dev-s") != nil }) { _ in
        let ep = signedEnv(pOut, "dev-p"), es = signedEnv(sOut, "dev-s")
        ok("announce-says-chip-and-app", body(ep)["chip"] as? String == "Apple M4" && body(es)["chip"] as? String == "Apple M1" && body(es)["app"] as? String == Second.appVersion && body(es)["role"] as? String == "primary")
        a.secondWin.testLooks = { looks.append($0) }
        s.handle("second:window", [:])
        wait("the window page", 10, { a.secondWin.ready }) { ready in
          guard ready else { ok("pair-window-page", false); done(); return }
          let devs = [doc("d1", "sdev", ep), doc("d2", "sdev", es)]
          // Before: one button, no stepper, no code.
          show(primaryMe, devs) { t, big in
            let low = t.lowercased()   // the card labels are drawn in capitals
            ok("pair-window-one-button", big == 1 && low.contains("this mac") && low.contains("your other mac") && t.contains("Test Secondary") && t.contains("Pair with my other Mac"))
            if big != 1 || !low.contains("your other mac") { print("SECOND: one button view: big=\(big) text=\(t.prefix(300).replacingOccurrences(of: "\n", with: " | "))") }
            ok("pair-window-no-stepper", !t.contains("\nSeen\n") && !t.contains("\nTrust\n") && !t.contains("Code on both Macs") && !t.contains("six digit"))
            click("Pair with my other Mac") { clicked in
              wait("the Pair click", 3, { looks.contains { $0.contains("\"pair\"") } }) { sent in
                ok("pair-window-click-sends-pair", clicked && sent)
                // Looking, just clicked.
                let seekDoc = doc("p1", "spair", seekEnv?.json, device: false)
                let seekId = body(seekEnv?.json)["id"] as? String ?? ""
                show(primaryMe, devs + [seekDoc], seeks: [seekId]) { t, _ in
                  ok("pair-window-looking", t.contains("Looking for your other Mac...") && !t.contains("Pair with my other Mac"))
                  // Looking for over 30 s, the other Mac on an older PS: the reason in plain words.
                  let old: [String: Any] = ["v": 1, "t": "seek", "id": "seek-old-view", "from": s.testDevice, "to": "all", "at": now() - 60_000, "primary": s.testDevice, "primaryPub": s.testPub]
                  var oldDev = body(es); oldDev["app"] = "1.24"
                  let oldDevEnv: [String: Any] = ["body": String(data: try! JSONSerialization.data(withJSONObject: oldDev), encoding: .utf8)!, "sig": "display only", "by": peerDev]
                  show(primaryMe, [doc("d1", "sdev", ep), doc("d2", "sdev", oldDevEnv), doc("p2", "spair", s.testSign(old)?.json, device: false)], seeks: ["seek-old-view"]) { t, _ in
                    ok("pair-window-reason", t.contains("Test Secondary is on V1.24. Update PS there first: it pairs by itself after.") && t.contains("keeps looking"))
                    // Nobody answered in 30 s and no other Mac ever said hello: said plainly, the spinner stops.
                    show(primaryMe, [doc("d1", "sdev", ep), doc("p2", "spair", s.testSign(old)?.json, device: false)], seeks: ["seek-old-view"]) { t, _ in
                      ok("pair-window-not-answered", t.contains("Your other Mac has not answered") && t.contains("Is PS V1.26 or newer open and signed in on it?") && !t.contains("Looking for your other Mac..."))
                      done()
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 7. Refusals, each with its plain reason.
    func refusals(_ head: String) {
      let stranger = SecondIdentity(store: SecondFileStore(dir: dir + "/stranger"), seenPath: dir + "/stranger/seen.json")
      var b: [String: Any] = ["v": 1, "t": "job", "id": U("job-strange-01"), "from": stranger.device, "to": peerDev, "at": now(), "exp": now() + 86_400_000, "type": "probe", "args": ["probe": "echo"]]
      if let e = stranger.sign(b) { relay.send(["type": "second:run", "env": e.json, "bundles": []]) }
      b["id"] = U("job-lying-001"); b["from"] = s.testDevice
      if var e = stranger.sign(b) { e.by = s.testDevice; relay.send(["type": "second:run", "env": e.json, "bundles": []]) }
      let replay = env(first(pOut, "second:signed") { $0["req"] as? String == "job:" + U("job-echo-0001") })
      if let replay { relay.send(["type": "second:run", "env": replay.json, "bundles": []]) }
      sendJob(U("job-shell-001"), "shell", ["cmd": "id"], raw: true) { _ in }
      sendJob(U("job-badarg-01"), "tests", ["project": "../etc", "head": head, "preset": "auto"], raw: true) { _ in }
      sendJob(U("job-nocode-01"), "tests", ["project": "demo", "head": String(repeating: "e", count: 40), "preset": "auto"], bundles: [["project": "demo", "file": U("x-file"), "head": String(repeating: "e", count: 40)]], raw: true) { _ in }
      sendJob(U("job-notsig-01"), "shell", ["cmd": "id"]) { e in ok("primary-will-not-sign-shell", e == nil) }
      wait("refusals", 15, { [U("job-strange-01"), U("job-lying-001"), U("job-shell-001"), U("job-badarg-01"), U("job-nocode-01")].allSatisfy { finalOf($0) != nil } && jobst(U("job-echo-0001")).contains { $0["state"] as? String == "refused" } }) { _ in
        func why(_ j: String) -> String { finalOf(j)?["reason"] as? String ?? "" }
        ok("refuse-untrusted", why(U("job-strange-01")) == "Not signed by your primary")
        ok("refuse-forged-by", why(U("job-lying-001")) == "Not signed by your primary")
        ok("refuse-replay", jobst(U("job-echo-0001")).last?["reason"] as? String == "Seen before")
        ok("refuse-unknown-type", why(U("job-shell-001")) == "Unknown job type")
        ok("refuse-bad-arguments", why(U("job-badarg-01")) == "Bad arguments")
        ok("refuse-code-missing", why(U("job-nocode-01")) == "Code bundle missing")
        files()
      }
    }

    // 8. A file the developer drops on the Primary lands in the Secondary's Downloads/From PS, with a notice.
    func files() {
      let data = Data("A fictional note from the test Primary.\n".utf8)
      sendFile("user-file-01", "../../hello.txt", data, purpose: "user", chunk: 16) { ack in
        let path = dir + "/peer/Downloads/From PS/hello.txt"
        ok("file-landed", ack?["ok"] as? Bool == true && ack?["path"] as? String == "Downloads/From PS/hello.txt" && fm.contents(atPath: path) == data)
        ok("file-quarantined", getxattr(path, "com.apple.quarantine", nil, 0, 0, 0) > 0)
        ok("real-downloads-untouched", !fm.fileExists(atPath: fm.homeDirectoryForCurrentUser.path + "/Downloads/From PS/hello.txt"))
        heartbeat()
      }
    }

    // 9. The heartbeat is quiet while idle and comes at once on a power change; awake only on power.
    func heartbeat() {
      let before = stats().count
      later(6) {
        ok("heartbeat-quiet-when-idle", stats().count == before)
        let last = stats().last ?? [:]
        ok("stat-fields", last["busy"] is NSNull && (last["power"] as? String) == "ac" && last["to"] as? String == "all" && (last["cpu"] as? Int) != nil && (last["disk"] as? Int) != nil)
        relay.send(["type": "test:power", "ac": false])
        wait("battery stat", 5, { stats().count > before && sOut.contains { $0["type"] as? String == "test:awake" } }) { _ in
          ok("stat-on-power-change", stats().last?["power"] as? String == "battery")
          ok("awake-released-on-battery", sOut.last { $0["type"] as? String == "test:awake" }?["held"] as? Bool == false)
          let n = sOut.filter { $0["type"] as? String == "test:awake" }.count
          relay.send(["type": "test:power", "ac": true])
          wait("ac again", 5, { sOut.filter { $0["type"] as? String == "test:awake" }.count > n }) { _ in
            ok("awake-on-power", sOut.last { $0["type"] as? String == "test:awake" }?["held"] as? Bool == true)
            cli()
          }
        }
      }
    }

    // 10. The CLI folder on the Primary: a request with a bundle becomes second:cli; updates become res files.
    func cli() {
      let c = s.testCliDir
      s.handle("second:projects", [:])
      let bundlePath = c + "/b-cli-0001.bundle", outside = dir + "/outside.bundle"
      try? Data("fictional bundle".utf8).write(to: URL(fileURLWithPath: bundlePath))
      try? Data("fictional bundle".utf8).write(to: URL(fileURLWithPath: outside))
      let head = String(repeating: "c", count: 40)
      func req(_ id: String, _ path: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["id": id, "type": "tests", "args": ["project": "demo", "head": head, "preset": "auto"], "bundles": [["project": "demo", "path": path, "head": head]]])) ?? Data()
      }
      a.vaultUnlocked = true
      Second.atomicWrite(req("cli-ok-0001", bundlePath), c + "/req-cli-ok-0001.json")
      Second.atomicWrite(req("cli-out-0001", outside), c + "/req-cli-out-0001.json")
      wait("cli", 10, { first(pOut, "second:cli") != nil && fm.fileExists(atPath: c + "/res-cli-out-0001.json") }) { _ in
        let m = first(pOut, "second:cli") ?? [:]
        let b = (m["bundles"] as? [[String: Any]])?.first
        ok("cli-request", (m["req"] as? [String: Any])?["id"] as? String == "cli-ok-0001" && b?["b64"] as? String == Data("fictional bundle".utf8).base64EncodedString())
        ok("cli-request-removed", !fm.fileExists(atPath: c + "/req-cli-ok-0001.json") && !fm.fileExists(atPath: bundlePath))
        let outRes = fm.contents(atPath: c + "/res-cli-out-0001.json").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        ok("cli-outside-file-refused", outRes?["state"] as? String == "failed" && fm.fileExists(atPath: outside))
        s.handle("second:cli:update", ["id": "cli-ok-0001", "state": "done", "job": U("job-x"), "status": ["summary": "fictional"]])
        let st = fm.contents(atPath: c + "/state.json").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        ok("cli-state", st?["ps"] as? Bool == true && st?["role"] as? String == "primary" && ((st?["secondary"] as? [String: Any])?["device"] as? String) == peerDev)
        ok("projects-list", (first(pOut, "second:projects")?["list"] as? [[String: String]])?.contains { $0["name"] == "demo" } == true)
        wait("res", 5, { fm.fileExists(atPath: c + "/res-cli-ok-0001.json") }) { got in
          let res = fm.contents(atPath: c + "/res-cli-ok-0001.json").flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
          ok("cli-result", got && res?["state"] as? String == "done" && res?["job"] as? String == U("job-x"))
          let perms = (try? fm.attributesOfItem(atPath: c)[.posixPermissions] as? Int) ?? 0
          ok("cli-folder-private", perms == 0o700)
          a.vaultUnlocked = false
          shares()
        }
      }
    }

    func idxs() -> [[String: Any]] {
      sOut.filter { $0["type"] as? String == "second:idx" }.compactMap { m in
        env(m).flatMap { e in SecondIdentity.verify(e, pub: peerPub) ? (try? JSONSerialization.jsonObject(with: Data(e.body.utf8)) as? [String: Any]) ?? nil : nil }
      }
    }
    func paths(_ b: [String: Any]?) -> Set<String> { Set(((b?["entries"] as? [[String: Any]]) ?? []).compactMap { $0["p"] as? String }) }

    // 11. Shared folders: the signed index, change only; a shared file served; one out of bounds refused; a file sent in.
    func shares() {
      wait("the first index", 10, { !idxs().isEmpty }) { _ in
        let i0 = idxs().last
        let p = paths(i0)
        ok("share-index-signed", i0?["root"] as? String == "ps-shared" && i0?["to"] as? String == "all" && i0?["t"] as? String == "idx")
        ok("share-index-entries", p.isSuperset(of: ["notes.txt", "pics", "pics/a.png", "link-in.txt"]))
        ok("share-index-skips", !p.contains(".hidden") && !p.contains("link-out.txt"))
        ok("share-index-kinds", ((i0?["entries"] as? [[String: Any]]) ?? []).contains { $0["p"] as? String == "pics/a.png" && $0["k"] as? String == "image" })
        let n = idxs().count
        try? Data("A second fictional note.\n".utf8).write(to: URL(fileURLWithPath: share + "/new.txt"))
        wait("the changed index", 12, { idxs().count > n }) { _ in
          ok("share-index-on-change", paths(idxs().last).contains("new.txt"))
          let m = idxs().count
          later(5) {
            ok("share-index-quiet", idxs().count == m)
            func getReq(_ tag: String, _ path: String, raw: Bool, next: @escaping (String) -> Void) {
              let gid = U(tag)
              if raw {
                let b: [String: Any] = ["v": 1, "t": "get", "id": gid, "from": s.testDevice, "to": peerDev, "at": now(), "root": "ps-shared", "path": path, "as": "download"]
                if let e = s.testSign(b) { relay.send(["type": "second:get", "env": e.json]) }
                next(gid); return
              }
              s.handle("second:sign", ["req": "get:" + gid, "body": ["t": "get", "id": gid, "to": peerDev, "root": "ps-shared", "path": path, "as": "download"]])
              wait("get signed", 5, { first(pOut, "second:signed") { $0["req"] as? String == "get:" + gid } != nil }) { _ in
                if let e = env(first(pOut, "second:signed") { $0["req"] as? String == "get:" + gid }) { relay.send(["type": "second:get", "env": e.json]) }
                next(gid)
              }
            }
            func ackFor(_ ref: String) -> [String: Any]? {
              env(first(sOut, "second:signed") { $0["req"] as? String == "ack:" + ref }).flatMap { (try? JSONSerialization.jsonObject(with: Data($0.body.utf8)) as? [String: Any]) ?? nil }
            }
            getReq("get-notes", "notes.txt", raw: false) { g1 in
              getReq("get-linkout", "link-out.txt", raw: false) { g2 in
                getReq("get-dotdot", "../outside-secret.txt", raw: true) { g3 in
                  wait("gets", 10, { first(sOut, "second:upload") { $0["get"] as? String == g1 } != nil && ackFor(g2) != nil && ackFor(g3) != nil }) { _ in
                    let up = first(sOut, "second:upload") { $0["get"] as? String == g1 }
                    ok("share-get-served", up?["purpose"] as? String == "share" && up?["name"] as? String == "notes.txt" && up?["to"] as? String == s.testDevice
                       && Data(base64Encoded: up?["b64"] as? String ?? "") == Data("Fictional shared note.\n".utf8))
                    ok("share-get-link-out-refused", ackFor(g2)?["ok"] as? Bool == false && !sOut.contains { $0["type"] as? String == "second:upload" && $0["get"] as? String == g2 })
                    ok("share-get-dotdot-refused", ackFor(g3)?["ok"] as? Bool == false && ackFor(g3)?["reason"] as? String == "Bad arguments")
                    s.handle("second:sign", ["req": "get:" + U("get-bad"), "body": ["t": "get", "id": U("get-bad"), "to": peerDev, "root": "ps-shared", "path": "../x", "as": "download"]])
                    ok("share-primary-will-not-sign-dotdot", first(pOut, "second:cancelled") { $0["req"] as? String == "get:" + U("get-bad") } != nil)
                    let data = Data("Sent into the shared folder (fictional).\n".utf8)
                    sendFile("share-file-01", "drop.txt", data, purpose: "share", chunk: 16, extra: ["root": "ps-shared", "dir": "Inbox"]) { ack in
                      ok("share-file-landed", ack?["ok"] as? Bool == true && fm.contents(atPath: share + "/Inbox/drop.txt") == data)
                      research()
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // 12. A research job: the fictional stand-in, no Bash, report.md back as the result, its folder kept.
    func research() {
      sendJob(U("job-research-1"), "research", ["prompt": "Fictional market question", "title": "Fictional market"]) { e in
        ok("research-signed", e != nil)
        wait("research", 20, { finalOf(U("job-research-1")) != nil }) { _ in
          let f = finalOf(U("job-research-1")) ?? [:]
          let up = first(sOut, "second:upload") { $0["job"] as? String == U("job-research-1") }
          ok("research-done", f["state"] as? String == "done" && f["summary"] as? String == "Fictional research done")
          ok("research-report-back", up?["purpose"] as? String == "result" && up?["name"] as? String == "report.md" && f["result"] as? String == up?["file"] as? String
             && String(decoding: Data(base64Encoded: up?["b64"] as? String ?? "") ?? Data(), as: UTF8.self).contains("Fictional market question"))
          let folders = (try? fm.contentsOfDirectory(atPath: share + "/Outsource")) ?? []
          ok("research-folder-kept", folders.contains { $0.hasSuffix(" Fictional market") && fm.fileExists(atPath: share + "/Outsource/" + $0 + "/report.md") })
          let args = (try? String(contentsOfFile: share + "/Outsource/research-args.txt", encoding: .utf8)) ?? ""
          ok("research-no-bash", args.contains(SecondJobs.researchTools) && !args.contains("Bash"))
          cmds()
        }
      }
    }

    // 13. Machine commands: lock runs (the reboot session's runner is a stand-in here), too old and extra keys refused.
    func cmds() {
      func ackFor(_ ref: String) -> [String: Any]? {
        env(first(sOut, "second:signed") { $0["req"] as? String == "ack:" + ref }).flatMap { (try? JSONSerialization.jsonObject(with: Data($0.body.utf8)) as? [String: Any]) ?? nil }
      }
      func acksFor(_ ref: String) -> [[String: Any]] {
        sOut.filter { $0["type"] as? String == "second:signed" && $0["req"] as? String == "ack:" + ref }.compactMap { m in
          env(m).flatMap { (try? JSONSerialization.jsonObject(with: Data($0.body.utf8)) as? [String: Any]) ?? nil }
        }
      }
      let c1 = U("cmd-lock"), c2 = U("cmd-old"), c3 = U("cmd-extra"), c4 = U("cmd-tampered"), c5 = U("cmd-stranger")
      s.handle("second:sign", ["req": "cmd:" + c1, "body": ["t": "cmd", "id": c1, "to": peerDev, "action": "lock"]])
      wait("cmd signed", 5, { first(pOut, "second:signed") { $0["req"] as? String == "cmd:" + c1 } != nil }) { _ in
        if let e = env(first(pOut, "second:signed") { $0["req"] as? String == "cmd:" + c1 }) { relay.send(["type": "second:cmd", "env": e.json]) }
        let t = now()
        if let e = s.testSign(["v": 1, "t": "cmd", "id": c2, "from": s.testDevice, "to": peerDev, "at": t - 600_000, "exp": t - 480_000, "action": "restart"]) { relay.send(["type": "second:cmd", "env": e.json]) }
        if let e = s.testSign(["v": 1, "t": "cmd", "id": c3, "from": s.testDevice, "to": peerDev, "at": t, "exp": t + 120_000, "action": "shutdown", "script": "rm -rf ~"]) { relay.send(["type": "second:cmd", "env": e.json]) }
        // Bad signature: a lock signed by the primary, then changed into a restart after signing.
        if var e = s.testSign(["v": 1, "t": "cmd", "id": c4, "from": s.testDevice, "to": peerDev, "at": t, "exp": t + 120_000, "action": "lock"]) {
          e.body = e.body.replacingOccurrences(of: "\"lock\"", with: "\"restart\""); relay.send(["type": "second:cmd", "env": e.json])
        }
        // Unknown device: a key this Mac never trusted.
        let stranger = SecondIdentity(store: SecondFileStore(dir: dir + "/stranger"), seenPath: dir + "/stranger/seen.json")
        if let e = stranger.sign(["v": 1, "t": "cmd", "id": c5, "from": stranger.device, "to": peerDev, "at": t, "exp": t + 120_000, "action": "restart"]) { relay.send(["type": "second:cmd", "env": e.json]) }
        // Replay: the same signed lock again.
        if let e = env(first(pOut, "second:signed") { $0["req"] as? String == "cmd:" + c1 }) { relay.send(["type": "second:cmd", "env": e.json]) }
        wait("cmd acks", 10, { acksFor(c1).count >= 2 && ackFor(c2) != nil && ackFor(c3) != nil && ackFor(c4) != nil && ackFor(c5) != nil }) { _ in
          ok("cmd-lock-ran", ackFor(c1)?["ok"] as? Bool == true && sOut.contains { $0["type"] as? String == "test:cmd" && $0["action"] as? String == "lock" && $0["id"] as? String == c1 && (($0["at"] as? NSNumber)?.doubleValue ?? 0) > 0 })
          ok("cmd-too-old", ackFor(c2)?["ok"] as? Bool == false && ackFor(c2)?["reason"] as? String == "Too old")
          ok("cmd-extra-key", ackFor(c3)?["ok"] as? Bool == false && ackFor(c3)?["reason"] as? String == "Bad arguments")
          ok("cmd-bad-signature", ackFor(c4)?["ok"] as? Bool == false && ackFor(c4)?["reason"] as? String == "Not signed by your primary")
          ok("cmd-unknown-device", ackFor(c5)?["ok"] as? Bool == false && ackFor(c5)?["reason"] as? String == "Not signed by your primary")
          let a1 = acksFor(c1)
          ok("cmd-replay-refused", a1.count == 2 && a1.contains { $0["ok"] as? Bool == true } && a1.contains { $0["ok"] as? Bool == false && $0["reason"] as? String == "Seen before" })
          ok("cmd-only-the-lock-ran", sOut.filter { $0["type"] as? String == "test:cmd" }.count == 1)
          ok("stat-machine", ((stats().last?["machine"] as? [String: Any])?["helper"] as? String) == "missing")
          window()
        }
      }
    }

    // 14. The Second Computer window (the Primary's): 980 x 660, invisible and parked in a test copy, fed once ready.
    func window() {
      a.showOverlay()   // the Tab list is up when the developer clicks Open Second Computer in it
      s.handle("second:window", ["tab": "files"])
      ok("window-puts-the-list-away", !a.shown)
      let w = a.secondWin.window
      ok("window-made", w != nil && w?.title == "Second Computer" && Int(w?.frame.width ?? 0) == 980 && Int(w?.minSize.width ?? 0) == 720 && (w?.alphaValue ?? 1) == 0)
      wait("the window page", 10, { a.secondWin.ready }) { ready in
        if !ready {
          a.secondWin.web?.evaluateJavaScript("JSON.stringify({href: location.href, win: typeof window.__psSecondWin, state: document.readyState, scripts: document.scripts.length, errs: window.__errs, text: (document.body ? document.body.innerText : '').slice(0, 80)})") { v, e in
            print("SECOND: the window page never said it was ready: \(v ?? e?.localizedDescription ?? "?") seen=\(a.secondWin.seen)")
            print("SECOND: this web build may have no /second-window page (PS_SELFTEST_WEB=<the lead's dist-ps> to check it)")
            ok("window-url", a.secondWin.web?.url?.absoluteString.hasPrefix("ps://app/client/second-window") == true)
            a.secondWin.testTearDown()
            question()
          }
          return
        }
        a.secondWin.web?.evaluateJavaScript("typeof window.__psSecondWin") { v, _ in
          ok("window-page-ready", (v as? String) == "object")
          // 1 Nov: with the window open on the Primary, V1.23's page asked for the state and the settings on
          // every redraw and each answer redrew it, about 40 times a second with the developer's vault, until PS's main
          // thread choked. For 4 s: the page asks once, PS loads it once, and the main thread stays free.
          let seen0 = a.secondWin.seen, loads0 = a.secondWin.loads
          var last = CACurrentMediaTime(), worst = 0.0, beats = 0
          let t = Timer(timeInterval: 0.05, repeats: true) { _ in let n = CACurrentMediaTime(); worst = max(worst, n - last); last = n; beats += 1 }
          RunLoop.main.add(t, forMode: .common)
          later(4) {
            t.invalidate()
            let asked = a.secondWin.seen.count - seen0.count, loads = a.secondWin.loads - loads0
            let ready = a.secondWin.seen.filter { $0 == "second:winReady" }.count, settings = a.secondWin.seen.filter { $0 == "psSettings:get" }.count
            print("SECOND: window quiet check: page messages in 4 s \(asked), state loads \(loads), ready \(ready), settings asks \(settings), longest main thread gap \(Int(worst * 1000)) ms, beats \(beats)")
            ok("window-asks-once", asked == 0 && ready <= 2 && settings <= 2)   // nothing more once it is loaded and idle
            ok("window-no-reload-loop", loads <= 1)
            ok("window-main-thread-free", worst < 0.25 && beats >= 50)
            s.handle("second:window", ["tab": "machine"])
            later(0.5) {
              ok("window-not-twice", a.secondWin.window === w)
              // A newer web build reloads the main page (App.loadMain), and the window's page with it: on 1 Nov the
              // window kept V1.26 all day while the main page ran V1.27.
              let readies = a.secondWin.seen.filter { $0 == "second:winReady" }.count
              a.secondWin.reloadPage()
              ok("window-reload-resets", !a.secondWin.ready)
              wait("the window page again", 10, { a.secondWin.ready }) { again in
                ok("window-reloads-with-main", again && a.secondWin.seen.filter { $0 == "second:winReady" }.count == readies + 1 && a.secondWin.window === w)
                a.secondWin.testTearDown()   // gone again: the checks after this one run as before
                question()
              }
            }
          }
        }
      }
    }

    // 14b. A question with the Tab list up (1 Nov: "This is my second Mac" froze the M1). The real question
    // panel (SecondConfirm.swift, invisible and parked here), never an app modal alert: the list is put away,
    // the question floats above it, PS keeps running while it is up, and Cancel changes nothing.
    func question() {
      let c = SecondConfirm.shared
      s.confirm = Second.alert
      a.showOverlay()
      let before = pOut.count, roleBefore = s.role
      var beats = 0
      let t = Timer(timeInterval: 0.1, repeats: true) { _ in beats += 1 }
      RunLoop.main.add(t, forMode: .default)   // a default mode timer stops in a modal loop
      s.handle("second:role", ["role": "secondary"])
      // It rightly waits while 1Password or Signal is in front (a test copy sees this Mac's real front app).
      if Protected.front { print("SECOND: 1Password or Signal is in front, the question waits for it to go") }
      wait("the question", 60, { c.showing }) { up in
        ok("question-shown", up && c.showingTitle == "Let your primary Mac run jobs here?")
        ok("question-not-modal", NSApp.modalWindow == nil)
        ok("question-list-put-away", !a.shown)
        ok("question-above-the-list", (c.panel?.level.rawValue ?? 0) > a.panel.level.rawValue)
        ok("question-invisible-in-test", (c.panel?.alphaValue ?? 1) == 0 && (c.panel?.ignoresMouseEvents ?? false))
        let b0 = beats
        later(0.6) {
          ok("question-ps-keeps-running", beats - b0 >= 3)
          t.invalidate()
          c.press(false)
          later(0.3) {
            ok("question-cancel-changes-nothing", !c.showing && s.role == roleBefore && pOut[before...].contains { $0["type"] as? String == "second:cancelled" && $0["req"] as? String == "role" })
            s.confirm = { title, text, _, d in pAlerts.append(title + "\n" + text); d(true) }
            phone()
          }
        }
      }
    }

    // 15. The developer's phone: trusted with the same code, its lock runs, a job, a file and a file request from it are refused.
    func phone() {
      let ph = SecondIdentity(store: SecondFileStore(dir: dir + "/phone"), seenPath: dir + "/phone/seen.json")
      let alerts0 = sOut.filter { $0["type"] as? String == "test:alert" }.count
      relay.send(["type": "second:trustPhone", "device": ph.device, "pub": ph.pub, "name": "Test Phone"])
      wait("phone trusted", 8, { sOut.contains { m in m["type"] as? String == "second" && ((m["trusted"] as? [[String: Any]]) ?? []).contains { $0["device"] as? String == ph.device && $0["role"] as? String == "phone" } } }) { trusted in
        let code = SecondIdentity.pairCode(primaryPub: peerPub, secondaryPub: ph.pub)
        let alert = sOut.filter { $0["type"] as? String == "test:alert" }.dropFirst(alerts0).compactMap { $0["text"] as? String }.first ?? ""
        ok("phone-trusted-with-code", trusted && alert.contains(code))
        func ackFor(_ ref: String) -> [String: Any]? {
          env(first(sOut, "second:signed") { $0["req"] as? String == "ack:" + ref }).flatMap { (try? JSONSerialization.jsonObject(with: Data($0.body.utf8)) as? [String: Any]) ?? nil }
        }
        let t = now(), cid = U("phone-cmd"), jid = U("phone-job"), fid = "phone-file-01", gid = U("phone-get")
        if let e = ph.sign(["v": 1, "t": "cmd", "id": cid, "from": ph.device, "to": peerDev, "at": t, "exp": t + 120_000, "action": "lock"]) { relay.send(["type": "second:cmd", "env": e.json]) }
        if let e = ph.sign(["v": 1, "t": "job", "id": jid, "from": ph.device, "to": peerDev, "at": t, "exp": t + 86_400_000, "type": "probe", "args": ["probe": "echo"]]) { relay.send(["type": "second:run", "env": e.json, "bundles": []]) }
        let data = Data("from the fictional phone".utf8)
        let sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        if let e = ph.sign(["v": 1, "t": "file", "id": fid, "from": ph.device, "to": peerDev, "at": t, "name": "phone.txt", "size": data.count, "sha256": sha, "mime": "text/plain", "purpose": "user", "chunk": 64, "n": 1]) {
          relay.send(["type": "second:chunk", "env": e.json, "i": 0, "n": 1, "b64": data.base64EncodedString()])
        }
        if let e = ph.sign(["v": 1, "t": "get", "id": gid, "from": ph.device, "to": peerDev, "at": t, "root": "ps-shared", "path": "notes.txt", "as": "download"]) { relay.send(["type": "second:get", "env": e.json]) }
        wait("phone answers", 10, { ackFor(cid) != nil && finalOf(jid) != nil && ackFor(fid) != nil && ackFor(gid) != nil }) { _ in
          ok("phone-lock-runs", ackFor(cid)?["ok"] as? Bool == true && sOut.contains { $0["type"] as? String == "test:cmd" && $0["id"] as? String == cid })
          ok("phone-job-refused", finalOf(jid)?["state"] as? String == "refused" && finalOf(jid)?["reason"] as? String == "Not signed by your primary")
          ok("phone-file-refused", ackFor(fid)?["ok"] as? Bool == false && !fm.fileExists(atPath: dir + "/peer/Downloads/From PS/phone.txt"))
          ok("phone-get-refused", ackFor(gid)?["ok"] as? Bool == false && !sOut.contains { $0["type"] as? String == "second:upload" && $0["get"] as? String == gid })
          status()
        }
      }
    }

    // 16. The status line for the "PS is active" pop-up, on both Macs.
    func status() {
      s.setUnlocked(true)   // the CLI check locked it again
      if let st = sOut.last(where: { $0["type"] as? String == "second:stat" }), let e = env(st) { s.handle("second:seen", ["env": e.json]) }
      relay.send(["type": "test:status"])
      wait("status lines", 6, { first(sOut, "test:status") != nil && s.statusLine.hasSuffix("online") }) { _ in
        ok("status-online", s.statusLine == "Test Secondary, online")
        ok("status-secondary", first(sOut, "test:status")?["line"] as? String == "This Mac is the second computer")
        s.setUnlocked(false)
        ok("status-locked-empty", s.statusLine == "")
        s.setUnlocked(true)
        afkSwitch()
      }
    }

    // 17. The AFK timer switch (Afk.swift) with a FAKE idle clock: Secondary turns it off by default, Primary on,
    // The developer's switch after that stands; Off shows nothing and records nothing.
    func afkSwitch() {
      let k = Afk.shared
      let keep = (k.idleNow, k.frontNow, k.videoNow, k.deliver, k.onStatus, k.prefs)
      var lastInput = Date(), got: [String] = [], statuses: [String] = []
      k.idleNow = { Date().timeIntervalSince(lastInput) }; k.frontNow = { "com.example.editor" }; k.videoNow = { false }
      k.deliver = { j in got.append(j); return true }
      k.onStatus = { j in statuses.append(j) }
      var p = Afk.Prefs(); p.threshold = 30
      k.resetForTest(); k.setPrefsForTest(p); k.resetRoleForTest(); k.testRoleDefaults = true
      func away() { lastInput = Date().addingTimeInterval(-40); k.tickForTest() }
      func lastOn() -> Bool? { statuses.last.flatMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any])?["on"] as? Bool } }
      k.roleChanged("secondary")
      later(0.5) {
        ok("afk-secondary-default-off", k.prefs.on == false && lastOn() == false)
        away()
        later(0.6) {
          ok("afk-off-shows-nothing", !k.showing && k.stretch == nil && !statuses.contains { $0.contains("\"afk\":{") })
          k.roleChanged("primary")
          later(0.5) {
            ok("afk-primary-default-on", k.prefs.on == true && lastOn() == true)
            lastInput = Date(); k.tickForTest(); away()
            later(0.8) {
              ok("afk-on-shows-card", k.showing && k.stretch != nil && statuses.contains { $0.contains("\"afk\":{") })
              k.handle(["on": false])   // The developer's switch in the Tab list
              later(0.8) {
                ok("afk-off-hides-at-once", !k.cardVisible && k.stretch == nil && k.pendingCount == 0 && got.isEmpty && lastOn() == false)
                k.roleChanged("primary")   // the same role again: his switch stands
                later(0.5) {
                  away()
                  later(0.5) {
                    ok("afk-switch-kept", k.prefs.on == false && !k.showing)
                    k.testRoleDefaults = false
                    k.resetForTest(); k.setPrefsForTest(keep.5)
                    k.idleNow = keep.0; k.frontNow = keep.1; k.videoNow = keep.2; k.deliver = keep.3; k.onStatus = keep.4
                    drops()
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
