import CryptoKit
import Darwin
import Foundation

// Second Computer outsourcing (the developer, 2 Nov 2026: "outsource these to the M1" from any Claude chat on the M4; protocol
// v1.3, section 19). The main Mac seals a research task to the second Mac (SecondSeal.swift) and signs it; the second
// Mac checks it (accept), runs up to 3 at once, each in its own throwaway folder with headless Claude Code limited to
// web search, web pages and that folder (SecondOutsourceRunner), and seals every status and the report back. The
// vault only ever carries the sealed envelopes (records sojob, sores). Kinds: research, and since PS 1.65 code (a code
// job: SecondCodeCore.swift checks it, SecondCodeRunner.swift runs it one at a time, its git bundle comes back sealed
// through the file stream). Code jobs run only where the person switched them on (Second Computer, Outsource).

/// A sealed, signed envelope: the body JSON (header plus the sealed part) and a signature by the sender's job key.
enum SecondOEnv {
  static let jobLife: Double = 10 * 60_000           // a job must be opened within 10 minutes of being signed
  static let resultLife: Double = 7 * 86_400_000     // a result may wait a week for the main Mac to come back
  static let skew: Double = 5 * 60_000

  /// The AAD: every header field, in a fixed order (the sealed part can never be moved to another header).
  static func aad(_ b: [String: Any]) -> Data {
    let keys = (b["t"] as? String) == "ores" ? ["t", "id", "job", "from", "to", "at", "nonce"] : ["t", "id", "from", "to", "at", "exp", "nonce"]
    return Data(keys.map { k in (b[k] as? NSNumber).map { String(Int64($0.doubleValue)) } ?? (b[k] as? String ?? "") }.joined(separator: "|").utf8)
  }

  /// Seals `plain` for `to`, signs the whole body. t: "ojob" (main Mac to second Mac) or "ores" (back).
  static func make(t: String, from: String, to: String, job: String? = nil, plain: [String: Any], peer: SecondKeys.Public, keys: SecondKeys, now: Date = Date()) -> (SecondEnv, String)? {
    let at = (now.timeIntervalSince1970 * 1000).rounded()
    var nonce = Data(count: 16)
    guard nonce.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }) == errSecSuccess else { return nil }
    var b: [String: Any] = ["v": 1, "t": t, "id": UUID().uuidString.lowercased(), "from": from, "to": to, "at": at, "nonce": nonce.base64EncodedString()]
    if t == "ojob" { b["exp"] = at + jobLife } else { b["job"] = job ?? "" }
    guard let pt = try? JSONSerialization.data(withJSONObject: plain, options: [.sortedKeys]),
          let sealed = try? SecondSeal.seal(pt, aad: aad(b), to: peer) else { return nil }
    b["sealed"] = sealed.json
    guard let body = try? JSONSerialization.data(withJSONObject: b, options: [.sortedKeys]), let sig = keys.sign(body), let text = String(data: body, encoding: .utf8) else { return nil }
    return (SecondEnv(body: text, sig: sig.base64EncodedString(), by: from), sealed.suite)
  }

  struct Opened { var body: [String: Any]; var plain: [String: Any]; var suite: String }

  /// The checks on receipt, in order; the plain reason when one fails. `once`: remembers an id and says whether it is
  /// new (SecondIdentity's seen set, 30 days). `role`: the role the sender must have in this Mac's trust store.
  static func open(_ env: SecondEnv, t: String, me: String, role: String, identity: SecondIdentity, keys: SecondKeys, now: Date = Date()) -> Result<Opened, SecondRefusal> {
    func no(_ w: String) -> Result<Opened, SecondRefusal> { .failure(SecondRefusal(why: w)) }
    guard let peer = identity.peer(env.by), peer.role == role else { return no(role == "primary" ? "Not from your main Mac" : "Not from your second Mac") }
    guard let pk = keys.peer(env.by) else { return no("This Mac has not seen that Mac's keys yet") }
    guard let sig = Data(base64Encoded: env.sig), SecondKeys.verify(sig, Data(env.body.utf8), key: pk.sign) else { return no("Signature does not match") }
    guard let b = try? JSONSerialization.jsonObject(with: Data(env.body.utf8)) as? [String: Any] else { return no("Unreadable") }
    let want: Set<String> = t == "ojob" ? ["v", "t", "id", "from", "to", "at", "exp", "nonce", "sealed"] : ["v", "t", "id", "job", "from", "to", "at", "nonce", "sealed"]
    guard Set(b.keys) == want, (b["v"] as? NSNumber)?.intValue == 1, b["t"] as? String == t else { return no("Bad arguments") }
    guard b["from"] as? String == env.by else { return no("Sender does not match the signature") }
    guard b["to"] as? String == me else { return no("Meant for another Mac") }
    guard let id = b["id"] as? String, SecondJobs.isUUID(id), let nonce = b["nonce"] as? String, Data(base64Encoded: nonce)?.count == 16 else { return no("Bad arguments") }
    let nowMs = now.timeIntervalSince1970 * 1000
    guard let at = (b["at"] as? NSNumber)?.doubleValue, at <= nowMs + skew else { return no("Clock is off") }
    if t == "ojob" {
      guard let exp = (b["exp"] as? NSNumber)?.doubleValue, nowMs - at <= jobLife, exp >= nowMs, exp - at <= jobLife + 1000 else { return no("Too old (over 10 minutes)") }
    } else {
      guard nowMs - at <= resultLife, let j = b["job"] as? String, SecondJobs.isUUID(j) else { return no("Too old") }
    }
    guard let sealed = SecondSeal.Sealed(b["sealed"]) else { return no("Bad arguments") }
    guard let mine = keys.privateFor(sealed.kid) else { return no("Sealed for a key this Mac no longer has") }
    guard let pt = try? SecondSeal.open(sealed, aad: aad(b), with: mine), let plain = try? JSONSerialization.jsonObject(with: pt) as? [String: Any] else { return no("Could not open it (tampered, or the wrong key)") }
    // Replays: the id and the nonce, each once (checked last, so a refused copy cannot block the real one).
    guard identity.once(t + ":" + id), identity.once("nonce:" + nonce) else { return no("Seen before") }
    return .success(Opened(body: b, plain: plain, suite: sealed.suite))
  }
}

/// What a sealed job may ask for (research only for now) and the plain words when it may not.
enum SecondOJob {
  struct Job { var kind: String; var title: String; var prompt: String; var model: String?; var minutes: Int; var cancel: String?; var code: SecondCodeJob? = nil }
  /// Code jobs are switched on on this Mac (the page tells PS: Second Computer, Outsource, Code jobs). Off by default.
  static var codeOn: () -> Bool = { false }
  static let codeOff = "Code jobs are off on this Mac. Switch them on in Second Computer, Outsource."
  static let maxPrompt = 8000, defaultMinutes = 20, maxMinutes = 30, maxRunning = 3, maxWaiting = 20

  static func check(_ p: [String: Any]) -> Result<Job, SecondRefusal> {
    func no(_ w: String) -> Result<Job, SecondRefusal> { .failure(SecondRefusal(why: w)) }
    switch p["kind"] as? String {
    case "research":
      guard Set(p.keys).isSubset(of: ["kind", "title", "prompt", "model", "minutes"]) else { return no("Bad arguments") }
      guard let pr = p["prompt"] as? String, !pr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, pr.count <= maxPrompt else { return no("Bad arguments") }
      guard let t = p["title"] as? String, SecondJobs.isTitle(t) else { return no("Bad arguments") }
      var model: String?
      if let m = p["model"] { guard let m = m as? String, ["opus", "sonnet"].contains(m) else { return no("Bad arguments") }; model = m }
      var minutes = defaultMinutes
      if let m = p["minutes"] { guard let n = m as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == n.doubleValue.rounded(), n.intValue >= 5, n.intValue <= maxMinutes else { return no("Bad arguments") }; minutes = n.intValue }
      if let s = secret(pr + "\n" + t) { return no("It looks like it holds a secret (\(s)). Nothing secret may go to the other Mac.") }
      return .success(Job(kind: "research", title: t, prompt: pr, model: model, minutes: minutes, cancel: nil))
    case "code":
      guard codeOn() else { return no(codeOff) }
      if let s = secret((p["prompt"] as? String ?? "") + "\n" + (p["title"] as? String ?? "")) { return no("It looks like it holds a secret (\(s)). Nothing secret may go to the other Mac.") }
      let (c, why) = SecondCodeJob.check(p, id: "pending")   // the envelope's own id goes in when it runs
      guard let c else { return no(why ?? "Bad arguments") }
      return .success(Job(kind: "code", title: c.title, prompt: c.prompt, model: c.model, minutes: c.minutes, cancel: nil, code: c))
    case "cancel":
      guard Set(p.keys) == ["kind", "job"], let j = p["job"] as? String, SecondJobs.isUUID(j) else { return no("Bad arguments") }
      return .success(Job(kind: "cancel", title: "", prompt: "", model: nil, minutes: 0, cancel: j))
    default:
      return no("Not allowed: only research and code jobs run on the second Mac")
    }
  }

  /// A thing that looks like a password, key or token (core/second.ts looksSecret has the same patterns).
  static func secret(_ s: String) -> String? {
    let pats: [(String, String)] = [
      ("-----BEGIN [A-Z ]*PRIVATE KEY-----", "a private key"), ("\\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}", "an API key"), ("\\bAKIA[0-9A-Z]{16}\\b", "an AWS key"),
      ("\\bgh[pousr]_[A-Za-z0-9]{30,}", "a GitHub token"), ("\\bxox[abposr]-[A-Za-z0-9-]{10,}", "a Slack token"), ("\\bAIza[0-9A-Za-z_-]{35}\\b", "a Google key"),
      ("\\beyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}", "a login token"), ("\\bsb_secret_[A-Za-z0-9_-]{10,}", "a Supabase secret"),
      ("(?i)\\b(password|passphrase|passwd)\\s*[:=]\\s*\\S{4,}", "a password"),
    ]
    for (p, what) in pats where s.range(of: p, options: .regularExpression) != nil { return what }
    return nil
  }

  /// "Compare the top 3 note apps" from the first words of a task (core/second.ts outsourceTitle does the same).
  static func title(_ prompt: String) -> String {
    let words = prompt.replacingOccurrences(of: "[^A-Za-z0-9 ,'()&+_-]", with: " ", options: .regularExpression).split(separator: " ").prefix(9).joined(separator: " ")
    var t = String(words.prefix(60)).trimmingCharacters(in: .whitespaces)
    while let f = t.first, !(f.isASCII && (f.isLetter || f.isNumber)) { t.removeFirst() }
    while let l = t.last, " ,'(&+_-".contains(l) { t.removeLast() }
    return t.isEmpty ? "Research" : t
  }
}

/// The second Mac's side: up to 3 research jobs at once, each in its own folder, sandboxed, timed and size limited.
final class SecondOutsourceRunner {
  struct Status {
    var job: String; var title: String; var state: String; var reason: String?; var step: String?; var summary: String?
    var startedAt: Date?; var endedAt: Date?; var report: String?; var files: [(String, Data)] = []; var suite: String; var from: String
    /// Code jobs: the result's fields (tool, branch, base, head, commits, files changed) and the bundle on disk with its SHA-256.
    var code: [String: Any]? = nil; var bundle: String? = nil; var bundleSha: String? = nil
  }
  private struct Running { var job: SecondOJob.Job; var id: String; var from: String; var suite: String; var proc: Process?; var cancelled: Bool; var started: Date }
  private let q = DispatchQueue(label: "ps.second.outsource", qos: .utility)
  private let lock = NSLock()
  private var waiting: [(SecondOJob.Job, String, String, String)] = []   // job, id, from, suite
  private var running: [String: Running] = [:]
  let places: SecondPlaces
  /// A status changed (state or step): sealed and sent by the coordinator.
  var onStatus: (Status) -> Void = { _ in }
  var log: (String) -> Void = { psLog($0) }
  /// Tests replace Claude with a fictional stand-in, and make a minute short.
  var claudePath: () -> String? = { nil }
  var secondsPerMinute: Double = 60 { didSet { code.secondsPerMinute = secondsPerMinute } }
  /// Code jobs, one at a time with a queue of 5, in Second/code (SecondCodeRunner.swift).
  private(set) lazy var code: SecondCodeRunner = {
    let r = SecondCodeRunner(root: places.root + "/code", home: places.home, tools: OutTools.find(home: places.home, extra: places.tools), searchDirs:
      [places.projects] + ["Developer", "Code", "Documents/GitHub", "src", "dev"].map { places.home + "/" + $0 }, mirrors: places.root + "/repos")
    r.tools.git = places.git
    return r
  }()
  private var flags: Set<String>?

  init(places: SecondPlaces) {
    self.places = places
    q.async { [weak self] in self?.prune() }
  }

  var dir: String { places.root + "/outsource" }
  var count: (running: Int, waiting: Int) { lock.lock(); defer { lock.unlock() }; return (running.count, waiting.count) }

  /// A checked job. Refused at once when 20 are waiting already.
  func submit(_ j: SecondOJob.Job, id: String, from: String, suite: String) {
    if j.kind == "cancel" { cancel(j.cancel ?? ""); return }
    if j.kind == "code", var c = j.code { c.id = id; submitCode(c, title: j.title, from: from, suite: suite); return }
    lock.lock()
    let dup = running[id] != nil || waiting.contains { $0.1 == id }, full = waiting.count >= SecondOJob.maxWaiting
    if !dup && !full { waiting.append((j, id, from, suite)) }
    lock.unlock()
    if full { onStatus(Status(job: id, title: j.title, state: "refused", reason: "20 tasks are waiting already", endedAt: Date(), suite: suite, from: from)); return }
    if dup { return }
    onStatus(Status(job: id, title: j.title, state: "queued", suite: suite, from: from))
    q.async { [weak self] in self?.next() }
  }

  func cancel(_ id: String) {
    if code.has(id) { code.cancel(id); return }
    lock.lock()
    if let i = waiting.firstIndex(where: { $0.1 == id }) {
      let w = waiting.remove(at: i); lock.unlock()
      onStatus(Status(job: id, title: w.0.title, state: "cancelled", reason: "Cancelled before it started", endedAt: Date(), suite: w.3, from: w.2))
      return
    }
    running[id]?.cancelled = true
    let p = running[id]?.proc
    lock.unlock()
    if let p, p.isRunning { stop(p) }
  }

  func stopAll() {
    lock.lock(); let w = waiting; waiting.removeAll(); let r = running.values.compactMap { $0.proc }; for k in running.keys { running[k]?.cancelled = true }; lock.unlock()
    for x in w { onStatus(Status(job: x.1, title: x.0.title, state: "cancelled", reason: "PS app stopped", endedAt: Date(), suite: x.3, from: x.2)) }
    r.forEach(stop)
    code.cancelAll()
  }

  /// The main Mac has the result: its folder goes (a folder nobody acknowledged goes after 3 days anyway).
  func done(_ id: String) {
    guard SecondJobs.isUUID(id) else { return }
    q.async { [dir] in try? FileManager.default.removeItem(atPath: dir + "/" + id) }
    code.forget(id)
  }

  /// A code job: queued in the code runner, each step and the end told back like research (sealed by the coordinator).
  private func submitCode(_ c: SecondCodeJob, title: String, from: String, suite: String) {
    if let cp = claudePath() { code.tools.claude = cp }
    var st = Status(job: c.id, title: title, state: "queued", suite: suite, from: from)
    let started = Date()
    let ok = code.submit(c, progress: { [weak self] state, step in
      st.state = state; st.step = step.isEmpty ? nil : step
      if state == "running", st.startedAt == nil { st.startedAt = Date() }
      self?.onStatus(st)
    }, done: { [weak self] d in
      var f = Status(job: c.id, title: title, state: d.state, reason: d.report.note.isEmpty ? nil : d.report.note, startedAt: st.startedAt ?? started, endedAt: Date(),
                     report: d.report.markdown(title: title), files: d.shots, suite: suite, from: from)
      f.summary = d.report.summary.isEmpty ? nil : String(d.report.summary.suffix(300))
      var fields = d.report.json
      fields["note"] = d.report.note
      f.code = fields; f.bundle = d.bundlePath; f.bundleSha = d.bundleSha
      self?.onStatus(f)
      self?.log("PS second: code job \(c.id.prefix(8)) \(d.state) in \(d.report.seconds) s")
    })
    if !ok { onStatus(Status(job: c.id, title: title, state: "refused", reason: code.has(c.id) ? "This job is already here" : "5 code jobs are waiting already", endedAt: Date(), suite: suite, from: from)) }
  }

  private func prune() {
    let fm = FileManager.default
    for f in (try? fm.contentsOfDirectory(atPath: dir)) ?? [] {
      let p = dir + "/" + f
      if let d = (try? fm.attributesOfItem(atPath: p))?[.modificationDate] as? Date, Date().timeIntervalSince(d) > 3 * 86_400 { try? fm.removeItem(atPath: p) }
    }
  }

  private func next() {
    lock.lock()
    guard running.count < SecondOJob.maxRunning, !waiting.isEmpty else { lock.unlock(); return }
    let (j, id, from, suite) = waiting.removeFirst()
    running[id] = Running(job: j, id: id, from: from, suite: suite, proc: nil, cancelled: false, started: Date())
    lock.unlock()
    Thread.detachNewThread { [weak self] in self?.run(j, id: id, from: from, suite: suite) }
    q.async { [weak self] in self?.next() }
  }

  /// The flags this Mac's Claude Code knows (read once from its help).
  private func knownFlags(_ exe: String) -> Set<String> {
    if let f = flags { return f }
    let p = Process(), o = Pipe()
    p.executableURL = URL(fileURLWithPath: exe); p.arguments = ["--help"]; p.standardOutput = o; p.standardError = FileHandle.nullDevice
    p.environment = ["PATH": "/usr/bin:/bin:" + (exe as NSString).deletingLastPathComponent, "HOME": places.home]
    var text = ""
    if (try? p.run()) != nil { text = String(decoding: o.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self); p.waitUntilExit() }
    var f = Set<String>()
    for k in ["--tools", "--allowedTools", "--disallowedTools", "--strict-mcp-config", "--safe-mode", "--setting-sources", "dontAsk", "--output-format", "--model"] where text.contains(k) { f.insert(k) }
    flags = f
    return f
  }

  /// The sandbox, from what this Claude Code knows: only web search, web pages, and reading and writing inside the
  /// job's folder; no Bash, no MCP servers (no mail, calendar or anything that sends), no hooks, skills or CLAUDE.md
  /// from the developer's setup, nothing it was not given. nil: this Claude Code is too old to be held that tightly.
  static func sandboxArgs(_ f: Set<String>, model: String?) -> [String]? {
    guard f.contains("--tools"), f.contains("--allowedTools"), f.contains("--strict-mcp-config"), f.contains("--output-format") else { return nil }
    var a = ["-p", "--output-format", "json",
             "--tools", "WebSearch,WebFetch,Read,Write,Edit",
             "--allowedTools", "WebSearch", "WebFetch", "Read(./**)", "Write(./**)", "Edit(./**)",
             "--permission-mode", f.contains("dontAsk") ? "dontAsk" : "default",
             "--strict-mcp-config"]
    if f.contains("--disallowedTools") { a += ["--disallowedTools", "Bash", "NotebookEdit", "Task", "Agent"] }
    if f.contains("--safe-mode") { a.append("--safe-mode") } else if f.contains("--setting-sources") { a += ["--setting-sources", "project"] }
    if let model, f.contains("--model") { a += ["--model", model] }
    return a
  }

  static func preface(_ j: SecondOJob.Job) -> String {
    """
    You are running a research task on a separate Mac, in an empty working folder. You may search the web, read web \
    pages, and read and write files in this folder only. Write your full answer as Markdown to report.md in this \
    folder (sources as links), then reply with a summary of two sentences.

    Task: \(j.title)

    \(j.prompt)
    """
  }

  private func run(_ j: SecondOJob.Job, id: String, from: String, suite: String) {
    let fm = FileManager.default, folder = dir + "/" + id, start = Date()
    var st = Status(job: id, title: j.title, state: "running", step: "Starting", startedAt: start, suite: suite, from: from)
    defer {
      lock.lock(); running[id] = nil; lock.unlock()
      q.async { [weak self] in self?.next() }
    }
    func finish(_ state: String, _ reason: String? = nil) {
      st.state = state; st.reason = reason; st.step = nil; st.endedAt = Date()
      onStatus(st)
      log("PS second: outsourced job \(id.prefix(8)) \(state) in \(Int(Date().timeIntervalSince(start))) s")
    }
    try? fm.createDirectory(atPath: folder + "/tmp", withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    guard let exe = claudePath() else { finish("failed", "Claude Code is not installed on this Mac"); return }
    guard let args = SecondOutsourceRunner.sandboxArgs(knownFlags(exe), model: j.model) else { finish("failed", "Claude Code on this Mac is too old for the locked down mode. Update it there (claude update)."); return }
    onStatus(st)
    let p = Process(), out = Pipe(), inp = Pipe()
    p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
    p.currentDirectoryURL = URL(fileURLWithPath: folder)
    // A small, known environment: no tokens or keys from PS's own environment reach Claude.
    p.environment = ["PATH": (exe as NSString).deletingLastPathComponent + ":/usr/bin:/bin", "HOME": places.home, "LANG": "en_US.UTF-8", "USER": NSUserName(),
                     "TMPDIR": folder + "/tmp", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"]
    p.standardInput = inp; p.standardOutput = out; p.standardError = FileHandle.nullDevice
    var data = Data()
    let rd = DispatchQueue(label: "ps.second.outsource.read")
    out.fileHandleForReading.readabilityHandler = { h in
      let d = h.availableData
      rd.sync { if data.count < 2 << 20 { data.append(d) } }
    }
    lock.lock()
    let cancelledEarly = running[id]?.cancelled == true
    running[id]?.proc = p
    lock.unlock()
    if cancelledEarly { finish("cancelled"); return }
    do { try p.run() } catch { finish("failed", "Could not start Claude Code"); return }
    inp.fileHandleForWriting.write(Data(SecondOutsourceRunner.preface(j).utf8)); try? inp.fileHandleForWriting.close()
    st.step = "Researching"; onStatus(st)
    let deadline = start.addingTimeInterval(Double(j.minutes) * secondsPerMinute)
    var timedOut = false
    while p.isRunning {
      if Date() > deadline { timedOut = true; stop(p); break }
      if folderSize(folder) > 100 << 20 { stop(p); break }
      Thread.sleep(forTimeInterval: 0.5)
    }
    p.waitUntilExit()
    // What is left in the pipe comes through the handler; a child that outlived Claude cannot hold this up.
    Thread.sleep(forTimeInterval: 0.3)
    out.fileHandleForReading.readabilityHandler = nil
    try? out.fileHandleForReading.close()
    let answer: Data = rd.sync { data }
    lock.lock(); let cancelled = running[id]?.cancelled == true; lock.unlock()
    let json = (try? JSONSerialization.jsonObject(with: answer)) as? [String: Any]
    let reply = json?["result"] as? String
    // Claude Code's own failure (signed out, no credit, a refused model): never passed off as a report.
    if json?["is_error"] as? Bool == true {
      let r = reply ?? ""
      finish("failed", r.range(of: "authenticat|log ?in|sign ?in|OAuth", options: [.regularExpression, .caseInsensitive]) != nil
        ? "Claude Code on this Mac is not signed in. Open Terminal there, run claude, and sign in."
        : "Claude Code stopped: " + String(r.prefix(160)))
      return
    }
    // The report: report.md (200 KB at most), else Claude's last message; up to 20 other small files (2 MB in all).
    var report = (try? String(contentsOfFile: folder + "/report.md", encoding: .utf8)) ?? reply ?? ""
    if report.utf8.count > 200 * 1024 { report = String(decoding: Array(report.utf8.prefix(200 * 1024)), as: UTF8.self) + "\n\n(Cut at 200 KB. The rest stays on the second Mac for 3 days.)" }
    st.report = report.isEmpty ? nil : report
    st.summary = reply.map { String($0.prefix(300)) }
    var total = 0
    for f in ((try? fm.contentsOfDirectory(atPath: folder)) ?? []).sorted() where f != "report.md" && f != "tmp" && !f.hasPrefix(".") && st.files.count < 20 {
      guard let a = try? fm.attributesOfItem(atPath: folder + "/" + f), a[.type] as? FileAttributeType == .typeRegular, let size = a[.size] as? Int, total + size <= 2 << 20,
            let d = fm.contents(atPath: folder + "/" + f) else { continue }
      total += size; st.files.append((SecondLanding.clean(f), d))
    }
    if cancelled { finish("cancelled") }
    else if timedOut { finish("timeout", "It ran past \(j.minutes) minutes") }
    else if p.terminationStatus != 0 && st.report == nil { finish("failed", "Claude Code stopped (exit \(p.terminationStatus))") }
    else if st.report == nil { finish("failed", "No report came back") }
    else { finish("done") }
  }

  /// Claude and everything it started: asked to stop, then stopped 5 s later.
  private func stop(_ p: Process) {
    guard p.isRunning else { return }
    let pid = p.processIdentifier
    let tree = [pid] + SecondTree.below(pid).map { $0.0 }
    for x in tree.reversed() { _ = SafeSignal.send(x, SIGTERM) }
    DispatchQueue.global().asyncAfter(deadline: .now() + 5) { for x in tree where kill(x, 0) == 0 { _ = SafeSignal.send(x, SIGKILL) } }
  }

  private func folderSize(_ path: String) -> Int {
    guard let e = FileManager.default.enumerator(atPath: path) else { return 0 }
    var n = 0
    for case let f as String in e { n += ((try? FileManager.default.attributesOfItem(atPath: path + "/" + f))?[.size] as? Int) ?? 0 }
    return n
  }
}
