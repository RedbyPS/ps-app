import CryptoKit
import Darwin
import Foundation

// Second Computer: the job runner on the Secondary Mac (plans come from SecondJobs.swift). One job at a
// time, first in first out, on its own queue, never the main thread. Each step is a child process
// started through /usr/bin/nice (niceness 10; the same pid execs the real program) with a clean
// environment, its own pipes and no terminal. A job has one deadline; a cancel or the deadline stops
// the step: SIGTERM through the child's own Process handle and to its descendants (found by parent pid
// from that handle, never by name, each checked against the program it ran when listed), SIGKILL after
// the grace time (10 s) through SafeSignal. Never kill(-1), kill(0), a negative pid or a process group.
// Output is kept as a tail (protocol: the last 4 KB while running, 48 KB at the end), every line passed
// through SecondRedact first, and written to Second/logs/<job>.log on this Mac (kept 7 days).

final class SecondOutput {
  static let tailMax = 48 * 1024
  private let lock = NSLock()
  private var partial: [String: Data] = [:]
  private var lines: [String] = []
  private var size = 0
  private(set) var failLines = 0
  private(set) var last = ""
  private var capture: Data?
  private let file: FileHandle?

  init(logPath: String?) {
    if let p = logPath {
      FileManager.default.createFile(atPath: p, contents: nil, attributes: [.posixPermissions: 0o600])
      file = FileHandle(forWritingAtPath: p)
    } else { file = nil }
  }
  deinit { try? file?.close() }

  /// Keep the whole stdout of the next step too (claude's JSON answer), up to 1 MB.
  func startCapture() { lock.lock(); capture = Data(); lock.unlock() }
  func endCapture() -> Data { lock.lock(); defer { capture = nil; lock.unlock() }; return capture ?? Data() }

  func add(_ stream: String, _ d: Data) {
    lock.lock()
    if stream == "out", capture != nil, capture!.count < 1 << 20 { capture!.append(d.prefix((1 << 20) - capture!.count)) }
    var buf = partial[stream, default: Data()] + d
    while let nl = buf.firstIndex(of: 0x0A) {
      line(String(decoding: buf[buf.startIndex..<nl], as: UTF8.self), err: stream == "err")
      buf = Data(buf[(nl + 1)...])
    }
    if buf.count > 4096 { line(String(decoding: buf, as: UTF8.self), err: stream == "err"); buf = Data() }
    partial[stream] = buf
    lock.unlock()
  }
  /// A line of the runner's own (step names, results).
  func note(_ s: String) { lock.lock(); line("== " + s, err: false); lock.unlock() }
  func finish() {
    lock.lock()
    for (s, d) in partial where !d.isEmpty { line(String(decoding: d, as: UTF8.self), err: s == "err") }
    partial = [:]
    lock.unlock()
  }

  private func line(_ raw: String, err: Bool) {
    let l = SecondRedact.text(raw)
    if l.contains("FAIL") { failLines += 1 }
    let t = l.trimmingCharacters(in: .whitespaces)
    if !err && !t.isEmpty && !l.hasPrefix("== ") { last = String(t.prefix(200)) }   // the summary comes from stdout
    lines.append(l); size += l.utf8.count + 1
    while size > SecondOutput.tailMax + 8192, !lines.isEmpty { size -= lines.removeFirst().utf8.count + 1 }
    file?.write(Data((l + "\n").utf8))
  }

  /// The last `max` bytes, starting at a line.
  func tail(_ max: Int) -> String {
    lock.lock(); defer { lock.unlock() }
    var out: [String] = [], n = 0
    for l in lines.reversed() {
      let c = l.utf8.count + 1
      if n + c > max { if out.isEmpty { out.append(String(decoding: Array(l.utf8.suffix(max - 1)), as: UTF8.self)) }; break }
      out.append(l); n += c
    }
    return out.reversed().joined(separator: "\n")
  }
}

/// Hides what looks like a key, token or password before any output leaves the runner.
enum SecondRedact {
  private static let patterns: [NSRegularExpression] = [
    #"sb_secret_[A-Za-z0-9_\-]{8,}"#, #"sb_publishable_[A-Za-z0-9_\-]{8,}"#, #"sk-ant-[A-Za-z0-9_\-]{8,}"#, #"\bsk-[A-Za-z0-9]{20,}"#,
    #"\bgh[pousr]_[A-Za-z0-9]{20,}"#, #"github_pat_[A-Za-z0-9_]{20,}"#, #"\bxox[abprs]-[A-Za-z0-9\-]{10,}"#, #"\bAKIA[0-9A-Z]{16}\b"#,
    #"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"#, #"\b[0-9]{8,10}:AA[A-Za-z0-9_\-]{30,}"#,
    #"-----BEGIN [A-Z ]*PRIVATE KEY-----.*"#,
  ].compactMap { try? NSRegularExpression(pattern: $0) }
  private static let assign = try! NSRegularExpression(pattern: #"(?i)\b(password|passphrase|passwd|secret|token|api[_\-]?key|authorization|bearer)(\s*[:=]\s*|\s+)("[^"]+"|'[^']+'|[^\s,;]+)"#)

  static func text(_ s: String) -> String {
    var t = s
    for p in patterns { t = p.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "[hidden]") }
    return assign.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: "$1$2[hidden]")
  }
}

/// The process tree under one child we started (deepest first), with the program each one runs.
enum SecondTree {
  static func children(_ pid: pid_t) -> [pid_t] {
    guard pid > 1 else { return [] }
    var buf = [pid_t](repeating: 0, count: 256)
    let n = proc_listchildpids(pid, &buf, Int32(buf.count * MemoryLayout<pid_t>.size))
    guard n > 0 else { return [] }
    return Array(buf.prefix(min(Int(n), buf.count))).filter { $0 > 1 && $0 != getpid() }
  }
  static func below(_ root: pid_t) -> [(pid_t, String)] {
    var out: [(pid_t, String)] = [], todo = children(root), seen = Set<pid_t>()
    while let p = todo.popLast(), out.count < 512 {
      guard seen.insert(p).inserted, let exe = SafeSignal.executable(of: p) else { continue }
      out.append((p, exe))
      todo += children(p)
    }
    return out.reversed()
  }
}

final class SecondRunner {
  struct Env {
    var places: SecondPlaces
    var allowProbe: Bool
    var grace: Double = 10
    var lockPath = "/tmp/ps-selftest.lock"
  }
  /// What the coordinator turns into a signed jobst body.
  struct Status {
    var job: String
    var state: String              // queued, running, done, failed, cancelled, timeout, refused
    var reason: String?
    var startedAt: Date?
    var endedAt: Date?
    var exit: Int32?
    var step: String?
    var summary: String?
    var files: [String]?
    var result: (path: String, name: String, mime: String)?
  }
  private let q = DispatchQueue(label: "ps.second.runner", qos: .utility)
  private let lock = NSLock()
  private var queue: [SecondJob] = []
  private var running: SecondJob?
  private var cancelled = Set<String>()
  private var child: Process?
  private var childExe: String?
  private var busy = false
  private var out: SecondOutput?
  private var stat: Status?
  private var stopping = false
  let env: Env
  /// A job's status changed (state or step), from the runner's queue. Running jobs report steps often;
  /// the coordinator decides how often it is sent (protocol: at most every 15 s while running).
  var onStatus: (Status) -> Void = { _ in }
  var log: (String) -> Void = { psLog($0) }

  init(env: Env) {
    self.env = env
    q.async { [env] in SecondRunner.prune(env.places) }
  }

  var currentJob: String? { lock.lock(); defer { lock.unlock() }; return running?.id }
  var queued: Int { lock.lock(); defer { lock.unlock() }; return queue.count }
  /// The last 4 KB of the running job's output (with the job id).
  func runningTail(_ max: Int = 4096) -> (String, String)? {
    lock.lock(); let id = running?.id; let o = out; lock.unlock()
    guard let id, let o else { return nil }
    return (id, o.tail(max))
  }
  var runningStatus: Status? { lock.lock(); defer { lock.unlock() }; return stat }
  /// The pids of the step running now (the child and everything under it), for the screen watch.
  var pids: [pid_t] {
    lock.lock(); let p = child; lock.unlock()
    guard let p, p.isRunning else { return [] }
    let root = p.processIdentifier
    return [root] + SecondTree.below(root).map { $0.0 }
  }

  /// A verified job body: refused at once if it is not allowed, otherwise queued. A cancel job cancels.
  @discardableResult
  func submit(_ body: [String: Any]) -> Bool {
    let id = (body["id"] as? String).map { String($0.prefix(64)) } ?? ""
    switch SecondJobs.parse(body, allowProbe: env.allowProbe) {
    case .failure(let r):
      log("PS second: refused a job (\(r.why))")
      onStatus(Status(job: id, state: "refused", reason: r.why, endedAt: Date()))
      return false
    case .success(let j):
      if j.kind == .cancel {
        let found = cancel(j.cancelJob ?? "")
        onStatus(Status(job: j.id, state: found ? "done" : "failed", reason: found ? nil : "No such job here", endedAt: Date()))
        return found
      }
      lock.lock()
      let dup = running?.id == j.id || queue.contains { $0.id == j.id }
      let full = queue.count >= 20
      if !dup && !full { queue.append(j) }
      lock.unlock()
      if dup || full { onStatus(Status(job: j.id, state: "refused", reason: dup ? "Seen before" : "20 jobs are waiting already", endedAt: Date())); return false }
      onStatus(Status(job: j.id, state: "queued"))
      q.async { [weak self] in self?.next() }
      return true
    }
  }

  @discardableResult
  func cancel(_ id: String) -> Bool {
    lock.lock()
    if let i = queue.firstIndex(where: { $0.id == id }) {
      queue.remove(at: i); lock.unlock()
      onStatus(Status(job: id, state: "cancelled", reason: "Cancelled before it started", endedAt: Date()))
      return true
    }
    // The running step sees it within a quarter of a second and stops its child (step()).
    let found = running?.id == id
    if found { cancelled.insert(id) }
    lock.unlock()
    return found
  }

  /// Secondary mode off or PS quitting: nothing waits, the running job is stopped.
  func stopAll(_ why: String) {
    lock.lock(); let ids = queue.map { $0.id }; queue.removeAll(); if let r = running?.id { cancelled.insert(r) }; lock.unlock()
    ids.forEach { onStatus(Status(job: $0, state: "cancelled", reason: why, endedAt: Date())) }
  }

  /// PS is quitting: nothing waits and the running step is stopped now (2 s grace), so no job outlives PS.
  func quit() {
    stopAll("PS app quit")
    stopChild(why: "PS app quit", grace: 2)
  }

  /// Another process holds the self test lock (a test copy the user or another session started).
  private func lockHeld() -> Bool {
    let fd = open(env.lockPath, O_RDONLY)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    if flock(fd, LOCK_SH | LOCK_NB) == 0 { flock(fd, LOCK_UN); return false }
    return true
  }

  private func next() {
    lock.lock()
    guard !busy, !queue.isEmpty else { lock.unlock(); return }
    busy = true
    let j = queue.removeFirst()
    running = j
    lock.unlock()
    // Never next to someone else's self test copy: wait (a cancel still works).
    var told = false
    while lockHeld() && !isCancelled(j.id) {
      if !told { told = true; report(Status(job: j.id, state: "queued", reason: "Waiting: a PS app self test is running on this Mac")) }
      Thread.sleep(forTimeInterval: 2)
    }
    run(j)
    lock.lock(); running = nil; out = nil; stat = nil; busy = false; cancelled.remove(j.id); lock.unlock()
    next()
  }

  private func isCancelled(_ id: String) -> Bool { lock.lock(); defer { lock.unlock() }; return cancelled.contains(id) }
  private func report(_ s: Status) { lock.lock(); stat = s; lock.unlock(); onStatus(s) }

  enum End { case ok, failed(String), cancelled, timeout }

  private func run(_ j: SecondJob) {
    let start = Date(), deadline = start.addingTimeInterval(j.timeout)
    let fm = FileManager.default
    try? fm.createDirectory(atPath: env.places.logs, withIntermediateDirectories: true)
    try? fm.createDirectory(atPath: env.places.root + "/work", withIntermediateDirectories: true)
    let o = SecondOutput(logPath: env.places.logs + "/" + j.id + ".log")
    lock.lock(); out = o; lock.unlock()
    var st = Status(job: j.id, state: "running", startedAt: start)
    if isCancelled(j.id) { st.state = "cancelled"; st.endedAt = Date(); report(st); return }
    report(st)
    log("PS second: job \(j.id) (\(j.kind.rawValue)) started")
    let plan = SecondJobs.plan(j, places: env.places)
    var end = End.ok, code: Int32?
    var steps = plan.prep + plan.run
    var i = 0
    var claudeJSON: Data?
    while i < steps.count {
      if isCancelled(j.id) { end = .cancelled; break }
      if Date() >= deadline { end = .timeout; break }
      let s = steps[i]
      // Steps decided once the copy exists.
      if case .autoTests(let dir)? = s.native {
        guard let p = SecondJobs.autoPreset(dir) else { end = .failed("No test command found in this project"); break }
        o.note("tests preset: \(p)")
        steps.replaceSubrange(i...i, with: SecondJobs.presetSteps(p, dir, env.places)); continue
      }
      if case .nodeTests(let dir)? = s.native {
        let files = SecondJobs.nodeTestFiles(dir)
        if files.isEmpty { end = .failed("No tests/*.test.ts files"); break }
        steps.replaceSubrange(i...i, with: files.map { SecondStep(label: "test " + $0, exe: s.exe, args: ["--experimental-strip-types", "tests/" + $0], cwd: dir, env: SecondJobs.baseEnv(env.places)) }); continue
      }
      if case .selftest(let mac, let web, let out, let only)? = s.native {
        steps.replaceSubrange(i...i, with: SecondJobs.selftestSteps(mac: mac, web: web, out: out, only: only, places: env.places)); continue
      }
      // Steps that need Claude's answer.
      if case .report(let folder)? = s.native {
        st.result = researchReport(folder, claudeJSON)
        i += 1; continue
      }
      if case .outsource(let folder)? = s.native {
        outsourceCopy(folder, claudeJSON, st.result, o)
        i += 1; continue
      }
      st.step = s.label; report(st)
      o.note(s.label)
      if s.label == "claude" { o.startCapture() }
      let r = step(s, j, o, deadline, &st)
      if s.label == "claude" { claudeJSON = o.endCapture() }
      switch r {
      case .ok: break
      case .failed(let why): if !s.mayFail { end = .failed(s.failWhy ?? why); code = lastCode }
      case .cancelled: end = .cancelled
      case .timeout: end = .timeout
      }
      if case .ok = end { i += 1 } else { break }
    }
    for s in plan.cleanup { _ = step(s, j, nil, Date().addingTimeInterval(60), &st) }
    for d in plan.copies where fm.fileExists(atPath: d) {
      // A result file waiting to be sent moves out of the copy first.
      if let r = st.result, r.path.hasPrefix(d + "/") {
        let keep = env.places.root + "/results/" + j.id + "-" + r.name
        try? fm.createDirectory(atPath: env.places.root + "/results", withIntermediateDirectories: true)
        try? fm.removeItem(atPath: keep)
        if (try? fm.moveItem(atPath: r.path, toPath: keep)) != nil { st.result = (keep, r.name, r.mime) } else { st.result = nil }
      }
      try? fm.removeItem(atPath: d)
    }
    o.finish()
    st.endedAt = Date(); st.exit = code
    switch end {
    case .ok: st.state = "done"; st.exit = 0
    case .failed(let why): st.state = "failed"; st.reason = why
    case .cancelled: st.state = "cancelled"
    case .timeout: st.state = "timeout"; st.reason = "It ran past \(Int(j.timeout / 60)) minutes"
    }
    st.step = nil
    st.summary = summary(j, o, claudeJSON, st)
    o.note("\(st.state) in \(Int(Date().timeIntervalSince(start))) s")
    report(st)
    log("PS second: job \(j.id) \(st.state) in \(Int(Date().timeIntervalSince(start))) s")
  }

  /// Claude's final message from its JSON answer, secrets hidden.
  static func answer(_ d: Data?) -> String? {
    guard let d, let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let r = obj["result"] as? String else { return nil }
    return SecondRedact.text(r)
  }

  /// research: report.md in its folder, or Claude's last message written there as report.md.
  private func researchReport(_ folder: String, _ claude: Data?) -> (path: String, name: String, mime: String)? {
    let fm = FileManager.default, p = folder + "/report.md"
    if !fm.fileExists(atPath: p), let a = SecondRunner.answer(claude) { try? Data(a.utf8).write(to: URL(fileURLWithPath: p)) }
    guard fm.fileExists(atPath: p) else { return nil }
    // The upload takes its own copy, so the report stays in Outsource for Files.
    let up = env.places.root + "/results/" + UUID().uuidString.lowercased() + ".md"
    try? fm.createDirectory(atPath: env.places.root + "/results", withIntermediateDirectories: true)
    guard (try? fm.copyItem(atPath: p, toPath: up)) != nil else { return nil }
    return (up, "report.md", "text/markdown")
  }

  /// claude: the patch and Claude's answer also go to PS Shared/Outsource on this Mac.
  private func outsourceCopy(_ folder: String, _ claude: Data?, _ result: (path: String, name: String, mime: String)?, _ o: SecondOutput) {
    let fm = FileManager.default
    try? fm.createDirectory(atPath: folder, withIntermediateDirectories: true)
    if let a = SecondRunner.answer(claude) { try? Data(a.utf8).write(to: URL(fileURLWithPath: folder + "/answer.md")) }
    if let r = result { try? fm.copyItem(atPath: r.path, toPath: folder + "/" + r.name) }
    o.note("copied to \((folder as NSString).lastPathComponent) in PS Shared, Outsource")
  }

  /// One line for the panel, eg "self test passed" or Claude's first line.
  private func summary(_ j: SecondJob, _ o: SecondOutput, _ claude: Data?, _ st: Status) -> String? {
    if j.kind == .claude || j.kind == .research, let r = SecondRunner.answer(claude) {
      let first = r.split(separator: "\n").first.map(String.init) ?? ""
      return String(first.prefix(200)) + (j.kind == .claude ? ((st.files?.count).map { $0 > 0 ? " (\($0) files changed)" : " (no changes)" } ?? "") : "")
    }
    if j.kind == .selftest { return st.state == "done" && o.failLines == 0 ? "Self test passed" : "\(o.failLines) lines with FAIL" }
    return o.last.isEmpty ? nil : o.last
  }

  private var lastCode: Int32 = 0

  /// Runs one step to its end, the deadline or a cancel. `o` nil: quiet (cleanup).
  private func step(_ s: SecondStep, _ j: SecondJob, _ o: SecondOutput?, _ deadline: Date, _ st: inout Status) -> End {
    let fm = FileManager.default
    if let n = s.native {
      switch n {
      case .mkdir(let d): try? fm.createDirectory(atPath: d, withIntermediateDirectories: true); return .ok
      case .modules(let dir): return modules(dir, j, o, deadline, &st)
      case .patch(let w, let head):
        let e = SecondJobs.baseEnv(env.places)
        guard case .ok = step(SecondStep(label: "git add", exe: env.places.git, args: ["-C", w, "add", "-A"], cwd: w, env: e), j, nil, deadline, &st) else { return .failed("git add failed") }
        let names = capture(env.places.git, ["-C", w, "diff", "--cached", "--name-only", head])
        st.files = String(decoding: names, as: UTF8.self).split(separator: "\n").map(String.init).filter { $0 != "node_modules" }
        let diff = capture(env.places.git, ["-C", w, "diff", "--cached", "--binary", head, "--", ".", ":(exclude)node_modules"])
        o?.note("\(st.files?.count ?? 0) files changed, patch \(diff.count) bytes")
        if !diff.isEmpty && diff.count <= 25 << 20 {
          let p = w + "/../claude.patch"
          if (try? diff.write(to: URL(fileURLWithPath: p))) != nil { st.result = (SafePath.real(p), "claude-\(j.id.prefix(8)).patch", "text/x-diff") }
        } else if diff.count > 25 << 20 { o?.note("the patch is over 25 MB, not sent") }
        return .ok
      case .zip(let app, let to):
        let e = SecondJobs.baseEnv(env.places)
        let r = step(SecondStep(label: "zip", exe: "/usr/bin/ditto", args: ["-c", "-k", "--keepParent", app, to], cwd: env.places.root, env: e), j, o, deadline, &st)
        guard case .ok = r else { return r }
        let size = (try? fm.attributesOfItem(atPath: to)[.size] as? Int) ?? 0
        if size > 25 << 20 { o?.note("PS.zip is \(size >> 20) MB, over the 25 MB a file may be: not sent") }
        else { st.result = (to, "PS-\(j.mac?.prefix(8) ?? "build").zip", "application/zip") }
        return .ok
      case .autoTests, .nodeTests, .report, .outsource, .selftest: return .ok
      }
    }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/nice")
    p.arguments = ["-n", "10", s.exe] + s.args
    p.currentDirectoryURL = URL(fileURLWithPath: s.cwd)
    p.environment = s.env
    let po = Pipe(), pe = Pipe()
    p.standardOutput = po; p.standardError = pe
    var inPipe: Pipe?
    if s.stdin != nil { inPipe = Pipe(); p.standardInput = inPipe } else { p.standardInput = FileHandle.nullDevice }
    let doneSem = DispatchSemaphore(value: 0)
    let eof = DispatchGroup()
    for (h, name) in [(po, "out"), (pe, "err")] {
      eof.enter()
      var ended = false
      h.fileHandleForReading.readabilityHandler = { fh in
        let d = fh.availableData
        if d.isEmpty { if !ended { ended = true; fh.readabilityHandler = nil; eof.leave() }; return }
        o?.add(name, d)
      }
    }
    p.terminationHandler = { _ in doneSem.signal() }
    do { try p.run() } catch {
      po.fileHandleForReading.readabilityHandler = nil; pe.fileHandleForReading.readabilityHandler = nil
      o?.note("could not start \(s.label): \(error.localizedDescription)")
      return .failed("Could not start \(s.label)")
    }
    lock.lock(); child = p; childExe = nil; lock.unlock()
    if let inPipe, let text = s.stdin {
      DispatchQueue.global(qos: .utility).async {
        try? inPipe.fileHandleForWriting.write(contentsOf: Data(text.utf8))
        try? inPipe.fileHandleForWriting.close()
      }
    }
    // The program nice became (the same pid), for the SIGKILL check.
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.3) { [weak self] in
      guard let self, p.isRunning, let exe = SafeSignal.executable(of: p.processIdentifier) else { return }
      self.lock.lock(); if self.child === p { self.childExe = exe }; self.lock.unlock()
    }
    var end = End.ok
    while doneSem.wait(timeout: .now() + 0.25) == .timedOut {
      let c = isCancelled(j.id), t = Date() >= deadline
      if c || t { end = c ? .cancelled : .timeout; stopChild(why: c ? "cancel" : "timeout"); _ = doneSem.wait(timeout: .now() + 5); break }
    }
    // Output still in the pipes; a grandchild that kept them open is not waited for.
    _ = eof.wait(timeout: .now() + 1)
    po.fileHandleForReading.readabilityHandler = nil; pe.fileHandleForReading.readabilityHandler = nil
    lock.lock(); child = nil; childExe = nil; lock.unlock()
    if case .ok = end {
      lastCode = p.terminationStatus
      if p.terminationReason == .uncaughtSignal { return .failed("\(s.label) stopped by signal \(p.terminationStatus)") }
      if p.terminationStatus != 0 { if !s.mayFail { o?.note("\(s.label) exited with \(p.terminationStatus)") }; return .failed("\(s.label) failed (exit \(p.terminationStatus))") }
    }
    return end
  }

  /// A quick git read (names, the patch), off the main thread like everything here.
  private func capture(_ exe: String, _ args: [String]) -> Data {
    let p = Process(), po = Pipe()
    p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
    p.environment = SecondJobs.baseEnv(env.places)
    p.standardOutput = po; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return Data() }
    let d = po.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
    return p.terminationStatus == 0 ? d : Data()
  }

  /// node_modules for a copy: the cached folder for this exact package-lock.json, else `npm ci` once
  /// and keep it in the cache (Second/modules/<sha>, the newest 4 kept).
  private func modules(_ dir: String, _ j: SecondJob, _ o: SecondOutput?, _ deadline: Date, _ st: inout Status) -> End {
    let fm = FileManager.default
    guard let lockData = fm.contents(atPath: dir + "/package-lock.json") else { return .ok }   // nothing to install
    let key = SHA256.hash(data: lockData).map { String(format: "%02x", $0) }.joined().prefix(24)
    let cached = env.places.modules + "/" + key + "/node_modules"
    if !fm.fileExists(atPath: cached) {
      let r = step(SecondStep(label: "npm ci", exe: env.places.tool("npm") ?? "npm", args: ["ci", "--no-audit", "--no-fund"], cwd: dir, env: SecondJobs.baseEnv(env.places)), j, o, deadline, &st)
      guard case .ok = r else { return r }
      try? fm.createDirectory(atPath: env.places.modules + "/" + key, withIntermediateDirectories: true)
      guard (try? fm.moveItem(atPath: dir + "/node_modules", toPath: cached)) != nil else { return .ok }   // left in the copy
      o?.note("node modules kept for next time")
    }
    try? fm.removeItem(atPath: dir + "/node_modules")
    try? fm.createSymbolicLink(atPath: dir + "/node_modules", withDestinationPath: cached)
    try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: env.places.modules + "/" + key)
    return .ok
  }

  /// Old logs (7 days), results (2 days) and node_modules caches (the newest 4) go.
  static func prune(_ places: SecondPlaces) {
    let fm = FileManager.default
    func age(_ p: String) -> TimeInterval { -(((try? fm.attributesOfItem(atPath: p))?[.modificationDate] as? Date) ?? Date()).timeIntervalSinceNow }
    for (dir, days) in [(places.logs, 7.0), (places.root + "/results", 2.0)] {
      for f in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] where age(dir + "/" + f) > days * 86400 { try? fm.removeItem(atPath: dir + "/" + f) }
    }
    let mods = ((try? fm.contentsOfDirectory(atPath: places.modules)) ?? []).sorted { age(places.modules + "/" + $0) < age(places.modules + "/" + $1) }
    for m in mods.dropFirst(4) { try? fm.removeItem(atPath: places.modules + "/" + m) }
  }

  /// Stops the step running now: SIGTERM through its handle and to its tree; SIGKILL what is left.
  private func stopChild(why: String, grace: Double? = nil) {
    lock.lock(); let p = child; let exe = childExe; lock.unlock()
    guard let p, p.isRunning else { return }
    let root = p.processIdentifier
    let tree = SecondTree.below(root)
    let rootExe = exe ?? SafeSignal.executable(of: root)
    p.terminate()
    for (pid, e) in tree { SafeSignal.signal(pid, SIGTERM, expected: [e], why: "second job \(why)") }
    let until = Date().addingTimeInterval(grace ?? env.grace)
    while Date() < until && (p.isRunning || tree.contains { SafeSignal.runs($0.0, $0.1) }) { usleep(50_000) }
    // Anything the child started after the first look is listed again before the hard stop.
    let late = SecondTree.below(root).filter { l in !tree.contains { $0.0 == l.0 } }
    for (pid, e) in tree + late where SafeSignal.runs(pid, e) { SafeSignal.signal(pid, SIGKILL, expected: [e], why: "second job \(why), past the grace time") }
    if p.isRunning, let rootExe { SafeSignal.signal(root, SIGKILL, expected: [rootExe], why: "second job \(why), past the grace time") }
  }
}
