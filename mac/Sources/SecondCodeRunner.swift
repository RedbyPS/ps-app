// Second Computer, Outsource: the code job runner on the second Mac (PS 1.65). Foundation only (no app, no page):
// mac/tests/secondcode-test.sh runs it with a fake `claude` and `codex` and temp git repos.
// One code job at a time on its own serial queue (nothing on the main thread), a queue of 5. Every child process starts in
// its own session, so a timeout or a cancel ends the whole tree. The AI works in its own copy for the job (a shared clone
// of Second Computer's own cached clone, never the person's own repository), on a fresh branch at the base commit, with
// .git inside the job folder so the tool's sandbox still lets it commit. Walls against pushing: SecondCodeCore.swift OutPolicy.
// The code comes from, in order: Second Computer's own mirror (Second/repos/<name>.git, which the owner's bundles fill),
// a folder of that name in the Projects folder (or the other usual code folders), or a git link without credentials.
import Foundation

struct SecondCodeDone {
  var id: String
  var state: String                 // done, failed, cancelled, timeout
  var report: SecondCodeReport
  var bundlePath: String?
  var bundleSha: String?
  var bundleSize: Int
  var shots: [(String, Data)]
}

struct OutTools {
  var claude: String?
  var codex: String?
  var git: String
  var perl = "/usr/bin/perl"

  /// Looks for the tools. `override` is for tests (a fake script standing in for each).
  static func find(home: String, extra: [String] = [], override: [String: String] = [:], fm: FileManager = .default) -> OutTools {
    func look(_ name: String) -> String? {
      if let o = override[name] { return fm.isExecutableFile(atPath: o) ? o : nil }
      let dirs = extra + [home + "/.local/bin", home + "/.claude/local", "/opt/homebrew/bin", "/usr/local/bin", home + "/.npm-global/bin"]
      return dirs.map { $0 + "/" + name }.first { fm.isExecutableFile(atPath: $0) }
    }
    return OutTools(claude: look("claude"), codex: look("codex"), git: override["git"] ?? "/usr/bin/git")
  }
}

/// One child process in its own session, output to a file (never a pipe that could fill and stall), killed on a timeout or a cancel.
final class OutProc {
  struct Result { var exit: Int32; var timedOut: Bool; var cancelled: Bool }
  private let lock = NSLock()
  private var pid: pid_t = 0
  private(set) var cancelled = false

  func cancel() {
    lock.lock(); cancelled = true; let p = pid; lock.unlock()
    if p > 0 { OutProc.killGroup(p) }
  }
  static func killGroup(_ p: pid_t) {
    kill(-p, SIGTERM)
    DispatchQueue.global().asyncAfter(deadline: .now() + 3) { kill(-p, SIGKILL) }
    usleep(300_000)
    kill(-p, SIGKILL)   // the tree is gone before we go on; a second kill of nothing is harmless
  }

  func run(perl: String, exe: String, args: [String], cwd: String, env: [String: String], timeout: TimeInterval, out: String, stdin: String? = nil) -> Result {
    lock.lock(); if cancelled { lock.unlock(); return Result(exit: -1, timedOut: false, cancelled: true) }; lock.unlock()
    FileManager.default.createFile(atPath: out, contents: nil, attributes: [.posixPermissions: 0o600])
    guard let fh = FileHandle(forWritingAtPath: out) else { return Result(exit: -1, timedOut: false, cancelled: false) }
    defer { try? fh.close() }
    let inp = stdin.flatMap { FileHandle(forReadingAtPath: $0) }
    defer { try? inp?.close() }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: perl)
    // setsid makes the child its own session and group leader: its pid is the group id we kill.
    p.arguments = ["-e", "use POSIX qw(setsid); setsid(); exec { $ARGV[0] } @ARGV or exit 127;", "--", exe] + args
    p.currentDirectoryURL = URL(fileURLWithPath: cwd)
    p.environment = env
    p.standardOutput = fh; p.standardError = fh; p.standardInput = inp ?? FileHandle.nullDevice
    do { try p.run() } catch { return Result(exit: -1, timedOut: false, cancelled: false) }
    lock.lock(); pid = p.processIdentifier; let wasCancelled = cancelled; lock.unlock()
    if wasCancelled { OutProc.killGroup(p.processIdentifier) }
    var timedOut = false
    let t0 = Date()
    while p.isRunning {
      if Date().timeIntervalSince(t0) > timeout { timedOut = true; OutProc.killGroup(p.processIdentifier); break }
      usleep(100_000)
    }
    p.waitUntilExit()
    lock.lock(); let c = cancelled; pid = 0; lock.unlock()
    return Result(exit: p.terminationStatus, timedOut: timedOut, cancelled: c)
  }
}

final class SecondCodeRunner {
  let root: String          // Second/code: repos/, jobs/, ran/, hooks/, shims/
  let home: String
  var tools: OutTools
  /// The folders a repo given by name is looked up in (Projects first), after the owner's mirrors.
  var searchDirs: [String]
  /// The owner's bare mirrors (Second/repos), filled by the code bundles the main Mac sends.
  var mirrors: String?
  var baseEnv: [String: String]
  /// Seconds in a job's "minute" (60). Only tests change it, so a timeout test does not take a minute.
  var secondsPerMinute: TimeInterval = 60
  static let maxQueue = 5
  private let q = DispatchQueue(label: "ps.second.code", qos: .utility)
  private let mu = NSLock()
  private var waiting: [String] = []
  private var running: String?
  private var cancelledIds = Set<String>()
  private var current: OutProc?
  private var cancelFlag = false
  private var flags: [String: Set<String>] = [:]
  private let fm = FileManager.default

  init(root: String, home: String, tools: OutTools, searchDirs: [String], mirrors: String? = nil, baseEnv: [String: String] = ProcessInfo.processInfo.environment) {
    self.root = root; self.home = home; self.tools = tools; self.searchDirs = searchDirs; self.mirrors = mirrors; self.baseEnv = baseEnv
  }

  var busy: Bool { mu.lock(); defer { mu.unlock() }; return running != nil }
  var queueLength: Int { mu.lock(); defer { mu.unlock() }; return waiting.count }
  func has(_ id: String) -> Bool { mu.lock(); defer { mu.unlock() }; return running == id || waiting.contains(id) }

  /// Queues a checked job. False when 5 are queued or running already. `progress` (state, step) and `done` come from the runner's queue.
  func submit(_ job: SecondCodeJob, progress: @escaping (String, String) -> Void, done: @escaping (SecondCodeDone) -> Void) -> Bool {
    mu.lock()
    if waiting.count + (running == nil ? 0 : 1) >= SecondCodeRunner.maxQueue || running == job.id || waiting.contains(job.id) { mu.unlock(); return false }
    waiting.append(job.id); mu.unlock()
    progress("queued", "")
    q.async { [self] in
      mu.lock(); waiting.removeAll { $0 == job.id }; running = job.id; cancelFlag = false; let skip = cancelledIds.remove(job.id) != nil; mu.unlock()
      let r = skip ? finish(job, state: "cancelled", note: "Cancelled before it started.", started: Date()) : execute(job, progress: progress)
      mu.lock(); running = nil; current = nil; mu.unlock()
      done(r)
    }
    return true
  }

  func cancel(_ id: String) {
    mu.lock()
    if running == id { cancelFlag = true; let c = current; mu.unlock(); c?.cancel() } else { if waiting.contains(id) { cancelledIds.insert(id) }; mu.unlock() }
  }
  func cancelAll() {
    mu.lock(); for w in waiting { cancelledIds.insert(w) }; let r = running; mu.unlock()
    if let r { cancel(r) }
  }
  /// The main Mac has the result: the job's folder goes (the marker that it ran stays 30 days).
  func forget(_ id: String) {
    guard OutSafe.idOk(id) else { return }
    q.async { [self] in try? fm.removeItem(atPath: jobDir(id)) }
  }

  // MARK: the job

  private func jobDir(_ id: String) -> String { root + "/jobs/" + id }
  private func git(_ args: [String], cwd: String, timeout: TimeInterval = 120, env: [String: String]? = nil) -> (Int32, String) {
    let o = root + "/jobs/.git-\(getpid())-\(UInt32.random(in: 0...UInt32.max)).log"
    let r = newProc().run(perl: tools.perl, exe: tools.git, args: args, cwd: cwd, env: env ?? gitEnv(), timeout: timeout, out: o)
    let text = (try? String(contentsOfFile: o, encoding: .utf8)) ?? ""
    try? fm.removeItem(atPath: o)
    return (r.exit, text.trimmingCharacters(in: .whitespacesAndNewlines))
  }
  private func gitEnv() -> [String: String] {
    var e = baseEnv
    for k in OutPolicy.envDrop where k != "SSH_AUTH_SOCK" { e.removeValue(forKey: k) }
    e["GIT_TERMINAL_PROMPT"] = "0"; e["GIT_ASKPASS"] = "/usr/bin/true"
    e["HOME"] = home
    e["GIT_AUTHOR_NAME"] = OutPolicy.author; e["GIT_COMMITTER_NAME"] = OutPolicy.author
    e["GIT_AUTHOR_EMAIL"] = OutPolicy.authorEmail; e["GIT_COMMITTER_EMAIL"] = OutPolicy.authorEmail
    return e
  }

  /// The flags this Claude Code knows (read once from its help, 15 seconds at most).
  private func knownFlags(_ exe: String) -> Set<String> {
    if let f = flags[exe] { return f }
    let o = root + "/jobs/.help-\(getpid()).txt"
    _ = OutProc().run(perl: tools.perl, exe: exe, args: ["--help"], cwd: root, env: ["PATH": "/usr/bin:/bin:" + (exe as NSString).deletingLastPathComponent, "HOME": home], timeout: 15, out: o)
    let text = (try? String(contentsOfFile: o, encoding: .utf8)) ?? ""
    try? fm.removeItem(atPath: o)
    let f = Set(OutPolicy.flagNames.filter { text.contains($0) })
    flags[exe] = f
    return f
  }

  /// Where the code for a repo name comes from on this Mac, or nil.
  private func source(_ repo: String) -> String? {
    guard OutSafe.folderName(repo) else { return repo }
    if let m = mirrors {
      let p = m + "/" + repo + ".git"
      if fm.fileExists(atPath: p + "/HEAD") { return p }
    }
    return searchDirs.map { $0 + "/" + repo }.first { fm.fileExists(atPath: $0 + "/.git") }
  }

  private func execute(_ job: SecondCodeJob, progress: @escaping (String, String) -> Void) -> SecondCodeDone {
    let t0 = Date()
    let dir = jobDir(job.id), work = dir + "/work", ran = root + "/ran/" + job.id
    prune()
    // A second wall against a replay (the owner's envelope keeps the first): a job id that already ran here never runs again.
    if fm.fileExists(atPath: ran) { return finish(job, state: "failed", note: "This job already ran on this Mac.", started: t0) }
    try? fm.createDirectory(atPath: root + "/ran", withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    fm.createFile(atPath: ran, contents: nil)
    try? fm.removeItem(atPath: dir)
    do { try fm.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) } catch { return finish(job, state: "failed", note: "Could not make the job folder.", started: t0) }
    // A step cut short by a cancel says cancelled, not failed.
    func fail(_ note: String) -> SecondCodeDone { cancelledNow() ? finish(job, state: "cancelled", note: "Cancelled from the main Mac.", started: t0) : finish(job, state: "failed", note: note, started: t0) }

    let name = job.tool == "claude" ? "Claude Code" : "Codex"
    guard let exe = (job.tool == "claude" ? tools.claude : tools.codex) else { return fail("\(name) is not installed on this Mac.") }
    guard fm.isExecutableFile(atPath: tools.git) else { return fail("git is missing on this Mac.") }
    var claudeArgs: [String] = []
    if job.tool == "claude" {
      guard let a = OutPolicy.claudeArgs(flags: knownFlags(exe), model: job.model) else { return fail("Claude Code on this Mac is too old for the locked down mode. Update it there (claude update).") }
      claudeArgs = a
    }

    // 1. Second Computer's own clone.
    progress("running", "Getting the code")
    let clone = root + "/repos/" + OutSafe.cloneName(job.repo)
    try? fm.createDirectory(atPath: root + "/repos", withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if !fm.fileExists(atPath: clone + "/.git") {
      guard let src = source(job.repo) else { return fail("This Mac has no folder called \(job.repo).") }
      let (c, text) = git(["-c", "protocol.ext.allow=never", "clone", "--no-recurse-submodules", "--", src, clone], cwd: root, timeout: 600)
      if c != 0 { try? fm.removeItem(atPath: clone); return fail("Could not copy the code: " + OutSecrets.tail(text, 300, home: home)) }
    } else {
      _ = git(["fetch", "--prune", "--no-recurse-submodules", "origin"], cwd: clone, timeout: 300)
    }
    if cancelledNow() { return finish(job, state: "cancelled", note: "Cancelled.", started: t0) }

    // 2. The walls.
    let hooks = root + "/hooks", shims = root + "/shims"
    setupWalls(hooks: hooks, shims: shims)
    for (k, v) in [("core.hooksPath", hooks), ("remote.origin.pushurl", OutPolicy.noPushURL), ("push.default", "nothing")] { _ = git(["config", k, v], cwd: clone) }

    // 3. The base commit and a fresh branch.
    var sha = ""
    for cand in [job.base, "origin/" + job.base] {
      let (c, o) = git(["rev-parse", "--verify", "--quiet", cand + "^{commit}"], cwd: clone)
      if c == 0, o.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil { sha = o; break }
    }
    if sha.isEmpty { return fail("The base commit \(job.base) is not in this Mac's copy of the code.") }
    let branch = "outsource/" + job.id
    let (cc, ct) = git(["-c", "protocol.ext.allow=never", "clone", "--shared", "--no-checkout", "--quiet", "--", clone, work], cwd: dir)
    if cc != 0 { return fail("Could not make the job's copy: " + OutSecrets.tail(ct, 300, home: home)) }
    let (wc, wt) = git(["checkout", "-q", "-b", branch, sha], cwd: work)
    if wc != 0 { return fail("Could not start a branch: " + OutSecrets.tail(wt, 300, home: home)) }
    for (k, v) in [("core.hooksPath", hooks), ("remote.origin.pushurl", OutPolicy.noPushURL), ("remote.origin.url", OutPolicy.noPushURL), ("push.default", "nothing"),
                   ("user.name", OutPolicy.author), ("user.email", OutPolicy.authorEmail)] { _ = git(["config", k, v], cwd: work) }
    try? fm.createDirectory(atPath: work + "/.git/info", withIntermediateDirectories: true)
    try? ".ps-outsource/\n".write(toFile: work + "/.git/info/exclude", atomically: true, encoding: .utf8)
    try? fm.createDirectory(atPath: work + "/.ps-outsource/shots", withIntermediateDirectories: true)
    try? fm.createDirectory(atPath: dir + "/tmp", withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])

    // 4. The AI, with a time limit.
    progress("running", "\(name) is working")
    let toolLog = dir + "/tool.log", lastMsg = dir + "/last-message.txt", promptFile = dir + "/prompt.txt"
    let prompt = OutPolicy.fullPrompt(job)
    try? prompt.write(toFile: promptFile, atomically: true, encoding: .utf8)
    let args = job.tool == "claude" ? claudeArgs : OutPolicy.codexArgs(prompt: prompt, dir: work, lastMessage: lastMsg)
    var env = OutPolicy.env(base: baseEnv, shimDir: shims, hooksDir: hooks, home: home)
    env["TMPDIR"] = dir + "/tmp"
    let res = newProc().run(perl: tools.perl, exe: exe, args: args, cwd: work, env: env, timeout: TimeInterval(job.minutes) * secondsPerMinute, out: toolLog,
                            stdin: job.tool == "claude" ? promptFile : nil)
    let logText = (try? String(contentsOfFile: toolLog, encoding: .utf8)) ?? ""
    var summary = logText
    if job.tool == "codex", let m = try? String(contentsOfFile: lastMsg, encoding: .utf8), !m.isEmpty { summary = m }

    // 5. What it made.
    progress("running", "Collecting the result")
    let (dc, dirty) = git(["status", "--porcelain"], cwd: work)
    if dc == 0, !dirty.isEmpty, !res.cancelled {
      _ = git(["add", "-A"], cwd: work)
      _ = git(["commit", "-q", "--no-verify", "-m", "Outsourced job: leftover changes"], cwd: work)
    }
    let (_, head) = git(["rev-parse", "HEAD"], cwd: work)
    let commits = Int(git(["rev-list", "--count", "\(sha)..HEAD"], cwd: work).1) ?? 0
    let stat = git(["diff", "--stat=100", "\(sha)..HEAD"], cwd: work).1.split(separator: "\n").prefix(30).map { String($0.prefix(120)) }
    let changed = git(["diff", "--name-only", "\(sha)..HEAD"], cwd: work).1.split(separator: "\n").map(String.init)
    var secretFiles = changed.filter(OutSecretPaths.isSecret)
    // The new lines themselves: a key or token written into any file keeps the bundle here too (an AI could be talked into it).
    let added = git(["diff", "--no-color", "-U0", "--no-ext-diff", "\(sha)..HEAD"], cwd: work, timeout: 60).1
    if secretFiles.isEmpty, OutSecrets.looksStrongSecret(String(added.prefix(8_000_000))) { secretFiles = ["a changed line"] }

    var state = res.cancelled ? "cancelled" : res.timedOut ? "timeout" : res.exit == 0 ? "done" : "failed"
    var note = ""
    if res.timedOut { note = "Stopped after \(job.minutes) minutes." } else if res.cancelled { note = "Cancelled from the main Mac." } else if res.exit != 0 { note = "\(name) ended with an error (exit \(res.exit))." }

    var bundlePath: String?, bundleSha: String?, bundleSize = 0
    if commits > 0, !secretFiles.isEmpty {
      note += " The result was not sent back: it changes files that look like they hold secrets (\(secretFiles.prefix(3).joined(separator: ", ")))."
      if state == "done" { state = "failed" }
    } else if commits > 0, !res.cancelled {
      let b = dir + "/result.bundle"
      let (bc, bt) = git(["bundle", "create", b, branch, "^" + sha], cwd: work)
      if bc == 0, git(["bundle", "verify", b], cwd: work).0 == 0, let size = (try? fm.attributesOfItem(atPath: b))?[.size] as? Int {
        if size <= SecondCodeBundle.maxBundle { bundlePath = b; bundleSize = size; bundleSha = OutHash.sha256(b) }
        else { note += " The result is too big to send back (\(size / 1_000_000) MB)."; if state == "done" { state = "failed" } }
      } else { note += " Could not pack the result: " + OutSecrets.tail(bt, 200, home: home); if state == "done" { state = "failed" } }
    }
    var shots: [(String, Data)] = []
    if job.shots {
      let sd = work + "/.ps-outsource/shots"
      for n in ((try? fm.contentsOfDirectory(atPath: sd)) ?? []).filter({ $0.lowercased().hasSuffix(".png") }).sorted().prefix(3) {
        let src = sd + "/" + n
        guard let a = try? fm.attributesOfItem(atPath: src), a[.type] as? FileAttributeType == .typeRegular, let s = a[.size] as? Int, s <= 400_000,
              let d = fm.contents(atPath: src), d.starts(with: [0x89, 0x50, 0x4E, 0x47]) else { continue }
        shots.append((SecondCodeRunner.cleanName(n), d))
      }
    }

    // 6. The job's copy goes; the bundle waits until the main Mac has it (or 3 days).
    try? fm.removeItem(atPath: work)
    try? fm.removeItem(atPath: promptFile)
    let report = SecondCodeReport(state: state, tool: job.tool, repo: job.repo, branch: bundlePath == nil ? "" : branch, base: sha, head: head, commits: commits,
                                  files: stat, summary: OutSecrets.tail(summary, 3000, home: home), log: OutSecrets.tail(logText, 6000, home: home), exit: res.exit,
                                  seconds: Int(Date().timeIntervalSince(t0)), note: note.trimmingCharacters(in: .whitespaces))
    return SecondCodeDone(id: job.id, state: state, report: report, bundlePath: bundlePath, bundleSha: bundleSha, bundleSize: bundleSize, shots: shots)
  }

  static func cleanName(_ n: String) -> String {
    let s = String(n.unicodeScalars.filter { $0.value > 32 && $0.value < 127 && $0 != "/" && $0 != "\\" && $0 != ":" }.map(Character.init)).prefix(80)
    return s.isEmpty || s.hasPrefix(".") ? "shot.png" : String(s)
  }

  private func cancelledNow() -> Bool { mu.lock(); defer { mu.unlock() }; return cancelFlag }
  /// A process for the next step of the running job; born cancelled when the job was cancelled already.
  private func newProc() -> OutProc {
    let p = OutProc()
    mu.lock(); current = p; let c = cancelFlag; mu.unlock()
    if c { p.cancel() }
    return p
  }

  private func finish(_ job: SecondCodeJob, state: String, note: String, started: Date) -> SecondCodeDone {
    let r = SecondCodeReport(state: state, tool: job.tool, repo: job.repo, branch: "", base: "", head: "", commits: 0, files: [], summary: "", log: "",
                             exit: -1, seconds: Int(Date().timeIntervalSince(started)), note: note)
    return SecondCodeDone(id: job.id, state: state, report: r, bundlePath: nil, bundleSha: nil, bundleSize: 0, shots: [])
  }

  private func setupWalls(hooks: String, shims: String) {
    for d in [hooks, shims] { try? fm.createDirectory(atPath: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
    func put(_ path: String, _ text: String) {
      if (try? String(contentsOfFile: path, encoding: .utf8)) != text { try? text.write(toFile: path, atomically: true, encoding: .utf8) }
      chmod(path, 0o755)
    }
    put(hooks + "/pre-push", OutPolicy.prePushHook)
    for n in OutPolicy.shimmed { put(shims + "/" + n, OutPolicy.shim(n)) }
  }

  /// Job folders older than 3 days go (a result nobody came back for), and "it ran" markers after 30 days. The clones stay.
  func prune(now: Date = Date()) {
    for (base, age) in [(root + "/jobs", 3.0 * 86_400), (root + "/ran", 30.0 * 86_400)] {
      for n in (try? fm.contentsOfDirectory(atPath: base)) ?? [] where !n.hasPrefix(".") {
        let p = base + "/" + n
        if let m = (try? fm.attributesOfItem(atPath: p))?[.modificationDate] as? Date, now.timeIntervalSince(m) > age { try? fm.removeItem(atPath: p) }
      }
    }
  }
}
