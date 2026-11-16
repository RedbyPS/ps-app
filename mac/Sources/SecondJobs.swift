import Foundation

// Second Computer (the developer, 31 Oct 2026; protocol v1 in the lead's notes, section 5): the jobs a Mac set to
// Secondary may run, and nothing else. A job is a verified, signed body {type, args, bundles}; args has a
// fixed set of keys per type with checked values. Anything else (a "cmd", "shell" or "env" key, an
// unknown type, a short or upper case sha, a project name with a slash) is refused before anything runs.
// Each type turns into a fixed list of steps here, so the unit tests (tests/second-test.swift) check
// every plan without running it. Code comes only from the bare mirrors that sealed git bundles fill
// (Second/repos/<project>.git); each job works in its own throwaway copy (Second/work/<job>).
// Types: selftest, build, tests (a preset's fixed commands), claude (`claude -p`, prompt on stdin),
// cancel (handled by Second.swift). "probe" is for test copies only (fixed harmless commands).

struct SecondJob: Equatable {
  enum Kind: String { case selftest, build, tests, claude, research, cancel, probe }
  var id: String
  var kind: Kind
  var project: String?      // tests, claude
  var head: String?         // tests, claude: sha40
  var mac: String?          // selftest, build: ps-mac sha40
  var web: String?          // selftest, build: web sha40
  var only: String?         // selftest: one PS_SELFTEST_ONLY area
  var send = false          // build: zip PS.app and send it back
  var preset: String?       // tests
  var prompt: String?       // claude, research: sent on stdin
  var title: String?        // research: names its folder in PS Shared/Outsource
  var model: String?        // claude: opus or sonnet
  var cancelJob: String?    // cancel
  var probe: String?        // probe: echo, spam, sleep, tree
  var timeout: TimeInterval
}

struct SecondRefusal: Error, Equatable { let why: String }

/// Where things are on this Mac. Tests pass their own folders.
struct SecondPlaces {
  var home: String
  var root: String              // ~/Library/Application Support/PS/Second
  var projects: String          // ~/Projects (the primary's second:projects and second:bundle)
  var shared: String            // ~/PS Shared: the default shared folder; research and Claude output go to its Outsource
  var git = "/usr/bin/git"
  var bash = "/bin/bash"
  var make = "/usr/bin/make"
  var tools: [String] = ["/opt/homebrew/bin", "/usr/local/bin"]   // node, npm, npx, claude, python3

  static func live() -> SecondPlaces {
    let h = FileManager.default.homeDirectoryForCurrentUser.path
    return SecondPlaces(home: h, root: h + "/Library/Application Support/PS/Second", projects: h + "/Projects", shared: h + "/PS Shared")
  }
  var outsource: String { shared + "/Outsource" }
  func mirror(_ project: String) -> String { root + "/repos/" + project + ".git" }
  func work(_ job: String) -> String { root + "/work/" + job }
  var modules: String { root + "/modules" }
  var logs: String { root + "/logs" }
  func tool(_ name: String) -> String? {
    tools.map { $0 + "/" + name }.first { FileManager.default.isExecutableFile(atPath: $0) }
  }
  var claude: String? {
    (tools.map { $0 + "/claude" } + [home + "/.local/bin/claude", home + "/.claude/local/claude"]).first { FileManager.default.isExecutableFile(atPath: $0) }
  }
}

/// One thing a job does: a child process with a fixed program and arguments, or a small native step.
struct SecondStep: Equatable {
  enum Native: Equatable {
    case modules(String)            // node_modules for a copy: cached per package-lock.json, `npm ci` when new
    case autoTests(String)          // tests preset "auto": picks the preset from the files in the copy
    case nodeTests(String)          // one step per tests/*.test.ts (not integration*)
    case mkdir(String)
    case patch(work: String, head: String)   // claude: git add -A, the diff against head, the changed paths
    case report(String)                      // research: report.md (or Claude's last message) back as the result
    case outsource(String)                   // claude: the patch and Claude's answer copied into PS Shared/Outsource
    case selftest(mac: String, web: String, out: String, only: String?)   // tests/selftest.sh when the commit has it
    case zip(app: String, to: String)        // build send:true
  }
  var label: String
  var exe = ""
  var args: [String] = []
  var cwd = "/"
  var env: [String: String] = [:]
  var stdin: String?
  var native: Native?
  var mayFail = false
  var failWhy: String?
}

struct SecondPlan {
  var prep: [SecondStep]
  var run: [SecondStep]
  var cleanup: [SecondStep]    // always runs, also after a cancel or a timeout
  var copies: [String]         // folders removed at the end
}

enum SecondJobs {
  static let argKeys: [String: Set<String>] = [
    "selftest": ["mac", "web", "only"], "build": ["mac", "web", "send"], "tests": ["project", "head", "preset"],
    "claude": ["project", "head", "prompt", "model", "minutes"], "research": ["prompt", "title", "model", "minutes"], "cancel": ["job"], "probe": ["probe", "seconds"],
  ]
  /// Default and longest time per type (seconds).
  static let limits: [SecondJob.Kind: (TimeInterval, TimeInterval)] = [
    .selftest: (40 * 60, 40 * 60), .build: (25 * 60, 25 * 60), .tests: (30 * 60, 30 * 60), .claude: (60 * 60, 60 * 60), .research: (60 * 60, 60 * 60), .cancel: (10, 10), .probe: (30, 120),
  ]
  static let presets: Set<String> = ["auto", "node-tests", "npm-test", "swift-test", "pytest", "make-test"]
  static let probes: Set<String> = ["echo", "spam", "sleep", "tree"]
  static let maxPrompt = 8000
  /// What the Claude task may use (protocol section 5), never more.
  static let researchTools = "Read,Write,Edit,Glob,Grep,WebSearch,WebFetch"   // no Bash
  static let claudeTools = "Read,Edit,Write,Glob,Grep,Bash(npm test:*),Bash(npm run:*),Bash(npx tsc:*),Bash(node --experimental-strip-types:*),Bash(git diff:*),Bash(git status:*),Bash(swift build:*),Bash(swift test:*)"

  static func isSha(_ s: String) -> Bool { s.count == 40 && s.allSatisfy { $0.isHexDigit && !$0.isUppercase } }
  static func isProject(_ s: String) -> Bool {
    guard let f = s.first, s.count <= 41, f.isASCII, f.isLowercase || f.isNumber else { return false }
    return s.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || "._-".contains($0)) } && !s.contains("..")
  }
  static let jobMaxAge: Double = 24 * 3_600_000
  /// A uuid as WebCrypto's crypto.randomUUID() writes it (core/second.ts UUID).
  static func isUUID(_ s: String) -> Bool {
    let parts = s.split(separator: "-", omittingEmptySubsequences: false)
    return parts.map(\.count) == [8, 4, 4, 4, 12] && parts.allSatisfy { $0.allSatisfy { $0.isHexDigit && !$0.isUppercase } }
  }
  /// A research title (core/second.ts TITLE): letters and digits first, then a few plain signs, 80 at most.
  static func isTitle(_ s: String) -> Bool {
    guard let f = s.first, s.count <= 80, f.isASCII, f.isLetter || f.isNumber else { return false }
    return s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || " ,'()&+_-".contains($0)) }
  }
  static func isId(_ s: String) -> Bool { s.count >= 6 && s.count <= 64 && s.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || $0 == "-") } }
  static func isArea(_ s: String) -> Bool { !s.isEmpty && s.count <= 20 && s.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber) } }

  /// Reads a verified job body, with exactly the rules of core/second.ts checkJob (same order, same words).
  static func parse(_ body: [String: Any], allowProbe: Bool, now: Date = Date()) -> Result<SecondJob, SecondRefusal> {
    func no(_ why: String) -> Result<SecondJob, SecondRefusal> { .failure(SecondRefusal(why: why)) }
    func num(_ v: Any?) -> Double? { guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }; return n.doubleValue }
    guard let id = body["id"] as? String, isUUID(id) else { return no("Bad id") }
    let nowMs = now.timeIntervalSince1970 * 1000
    guard let exp = num(body["exp"]), exp.isFinite, exp >= nowMs else { return no("Too old") }
    if let at = num(body["at"]), exp - at > jobMaxAge + 60_000 { return no("Bad arguments") }
    guard let args = body["args"] as? [String: Any] else { return no("Bad arguments") }
    let bundles: [[String: Any]]
    if body["bundles"] == nil || body["bundles"] is NSNull { bundles = [] } else {
      guard let b = body["bundles"] as? [[String: Any]], b.count <= 3 else { return no("Bad arguments") }
      bundles = b
    }
    for x in bundles {
      guard let p = x["project"] as? String, isProject(p), let f = x["file"] as? String, isUUID(f), let h = x["head"] as? String, isSha(h) else { return no("Bad arguments") }
      if let base = x["base"] { guard let bs = base as? String, isSha(bs) else { return no("Bad arguments") } }
    }
    func needs(_ project: String, _ head: String?) -> Bool { head != nil && bundles.contains { $0["project"] as? String == project && $0["head"] as? String == head } }
    func has(_ keys: [String]) -> Bool { Set(args.keys).isSubset(of: Set(keys)) }
    func minutes(_ j: inout SecondJob) -> Bool {
      guard let m = args["minutes"] else { return true }
      guard let n = num(m), n == n.rounded(), n >= 5, n <= 60 else { return false }
      j.timeout = n * 60; return true
    }
    func prompt() -> String? {
      guard let p = args["prompt"] as? String, !p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, p.utf16.count <= maxPrompt else { return nil }
      return p
    }
    func model() -> String?? {
      guard let m = args["model"] else { return .some(nil) }
      guard let s = m as? String, s == "opus" || s == "sonnet" else { return nil }
      return .some(s)
    }
    guard let ts = body["type"] as? String, let kind = SecondJob.Kind(rawValue: ts), kind != .probe || allowProbe else { return no("Unknown job type") }
    var j = SecondJob(id: id, kind: kind, timeout: limits[kind]!.0)
    switch kind {
    case .selftest, .build:
      guard has(argKeys[ts]!.sorted()), let mac = args["mac"] as? String, isSha(mac), let web = args["web"] as? String, isSha(web) else { return no("Bad arguments") }
      j.mac = mac; j.web = web
      if kind == .selftest, let o = args["only"] { guard let a = o as? String, isArea(a) else { return no("Bad arguments") }; j.only = a }
      if kind == .build, let sd = args["send"] { guard let b = sd as? Bool, CFGetTypeID(sd as CFTypeRef) == CFBooleanGetTypeID() else { return no("Bad arguments") }; j.send = b }
      if !needs("ps-mac", mac) || !needs("web", web) { return no("Code bundle missing") }
    case .tests:
      guard has(["project", "head", "preset"]), let p = args["project"] as? String, isProject(p), let h = args["head"] as? String, isSha(h),
            let pr = args["preset"] as? String, presets.contains(pr) else { return no("Bad arguments") }
      j.project = p; j.head = h; j.preset = pr
      if !needs(p, h) { return no("Code bundle missing") }
    case .claude:
      guard has(["project", "head", "prompt", "model", "minutes"]), let p = args["project"] as? String, isProject(p), let h = args["head"] as? String, isSha(h) else { return no("Bad arguments") }
      guard let pr = prompt(), let m = model(), minutes(&j) else { return no("Bad arguments") }
      j.project = p; j.head = h; j.prompt = pr; j.model = m
      if !needs(p, h) { return no("Code bundle missing") }
    case .research:
      guard has(["prompt", "title", "model", "minutes"]), bundles.isEmpty, let pr = prompt(), let t = args["title"] as? String, isTitle(t), let m = model(), minutes(&j) else { return no("Bad arguments") }
      j.prompt = pr; j.title = t; j.model = m
    case .cancel:
      guard has(["job"]), let c = args["job"] as? String, isUUID(c), bundles.isEmpty else { return no("Bad arguments") }
      j.cancelJob = c
    case .probe:
      guard has(["probe", "seconds"]), let p = args["probe"] as? String, probes.contains(p) else { return no("Bad arguments") }
      j.probe = p
      if let sv = args["seconds"] { guard let n = num(sv), n >= 1, n <= limits[.probe]!.1 else { return no("Bad arguments") }; j.timeout = n }
    }
    return .success(j)
  }

  /// The projects (and their commits) a job needs in this Mac's mirrors.
  static func needs(_ j: SecondJob) -> [(String, String)] {
    switch j.kind {
    case .selftest, .build: return [("ps-mac", j.mac ?? ""), ("web", j.web ?? "")]
    case .tests, .claude: return [(j.project ?? "", j.head ?? "")]
    default: return []
    }
  }

  /// The environment every child gets: nothing of PS's own and nothing from the primary.
  static func baseEnv(_ places: SecondPlaces) -> [String: String] {
    let e = ProcessInfo.processInfo.environment
    var out: [String: String] = [
      "HOME": places.home, "PATH": (places.tools + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).joined(separator: ":"),
      "LANG": "en_US.UTF-8", "CI": "1", "NPM_CONFIG_UPDATE_NOTIFIER": "false", "NO_UPDATE_NOTIFIER": "1", "GIT_TERMINAL_PROMPT": "0",
    ]
    if let t = e["TMPDIR"] { out["TMPDIR"] = t }
    if let u = e["USER"] { out["USER"] = u; out["LOGNAME"] = u }
    return out
  }

  /// The steps for a job.
  static func plan(_ j: SecondJob, places: SecondPlaces) -> SecondPlan {
    let env = baseEnv(places), git = places.git
    let work = places.work(j.id)
    var prep: [SecondStep] = [], run: [SecondStep] = [], clean: [SecondStep] = [], copies: [String] = []
    /// A clean, detached copy of `project` at `sha` from its mirror.
    func copy(_ project: String, _ sha: String, _ dest: String) {
      let m = places.mirror(project)
      prep.append(SecondStep(label: "find \(project) \(sha.prefix(8))", exe: git, args: ["--git-dir=" + m, "cat-file", "-e", sha + "^{commit}"], cwd: places.root, env: env, failWhy: "Code bundle missing"))
      prep.append(SecondStep(label: "copy \(project) \(sha.prefix(8))", exe: git, args: ["--git-dir=" + m, "worktree", "add", "--force", "--detach", dest, sha], cwd: places.root, env: env))
      clean.append(SecondStep(label: "remove the copy of \(project)", exe: git, args: ["--git-dir=" + m, "worktree", "remove", "--force", dest], cwd: places.root, env: env, mayFail: true))
      clean.append(SecondStep(label: "tidy \(project)", exe: git, args: ["--git-dir=" + m, "worktree", "prune"], cwd: places.root, env: env, mayFail: true))
      copies.append(dest)
    }
    let npm = places.tool("npm") ?? "npm"
    switch j.kind {
    case .cancel: break
    case .probe:
      let script: String
      switch j.probe ?? "" {
      case "echo": script = "echo \"probe start $$\"; echo 'token: sb_secret_FAKEFAKEFAKEFAKE1234'; echo 'to stderr' >&2; echo 'probe done'"
      case "spam": script = "i=0; while [ $i -lt 2000 ]; do echo \"line $i of fictional output, padded to about sixty bytes\"; i=$((i+1)); done"
      case "sleep": script = "echo \"probe sleeping $$\"; /bin/sleep 600"
      default: script = "/bin/sleep 600 & echo \"PIDS $$ $!\"; wait"
      }
      prep.append(SecondStep(label: "folder", native: .mkdir(work)))
      run.append(SecondStep(label: "probe \(j.probe ?? "")", exe: places.bash, args: ["-c", script], cwd: work, env: env))
      copies.append(work)
    case .selftest, .build:
      let mac = work + "/ps-mac", web = work + "/web"
      copy("ps-mac", j.mac ?? "", mac)
      copy("web", j.web ?? "", web)
      prep.append(SecondStep(label: "npm ci", native: .modules(web)))
      run.append(SecondStep(label: "web build", exe: npm, args: ["run", "build:ps"], cwd: web, env: env))
      var b = env
      b["SKIP_WEB"] = "1"; b["PS_WEB_DIR"] = web; b["PS_APP_OUT"] = mac + "/build/PS.app"; b["NO_INSTALL"] = "1"
      run.append(SecondStep(label: "build PS", exe: places.bash, args: [mac + "/build.sh"], cwd: mac, env: b))
      if j.kind == .selftest {
        // The commit's own tests/selftest.sh (build, lock, test copy, verdict); older commits: the same by hand.
        run.removeLast()
        run.append(SecondStep(label: "self test" + (j.only.map { ": " + $0 } ?? ""), native: .selftest(mac: mac, web: web, out: work + "/selftest", only: j.only)))
      } else if j.send {
        run.append(SecondStep(label: "zip PS.app", native: .zip(app: mac + "/build/PS.app", to: work + "/PS.zip")))
      }
      copies.append(work)
    case .tests:
      let p = j.project ?? "", copyDir = work + "/" + p
      copy(p, j.head ?? "", copyDir)
      run += presetSteps(j.preset ?? "auto", copyDir, places)
      copies.append(work)
    case .claude:
      let p = j.project ?? "", copyDir = work + "/" + p
      copy(p, j.head ?? "", copyDir)
      prep.append(SecondStep(label: "npm ci", native: .modules(copyDir)))
      var args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", claudeTools]
      if let m = j.model { args += ["--model", m] }
      run.append(SecondStep(label: "claude", exe: places.claude ?? "claude", args: args, cwd: copyDir, env: env, stdin: j.prompt))
      run.append(SecondStep(label: "patch", native: .patch(work: copyDir, head: j.head ?? "")))
      run.append(SecondStep(label: "copy to Outsource", native: .outsource(outsourceFolder(places, "Claude " + String(j.id.prefix(8))))))
      copies.append(work)
    case .research:
      // Its own folder in PS Shared/Outsource, kept: what Claude writes there shows in Files.
      let folder = outsourceFolder(places, j.title ?? "Research")
      prep.append(SecondStep(label: "Outsource folder", native: .mkdir(folder)))
      var args = ["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "--allowedTools", researchTools]
      if let m = j.model { args += ["--model", m] }
      run.append(SecondStep(label: "claude", exe: places.claude ?? "claude", args: args, cwd: folder, env: env, stdin: j.prompt))
      run.append(SecondStep(label: "report", native: .report(folder)))
    }
    return SecondPlan(prep: prep, run: run, cleanup: clean, copies: copies)
  }

  /// "PS Shared/Outsource/2026-10-31 16.40 <title>" (a " 2" when that exists already).
  static func outsourceFolder(_ places: SecondPlaces, _ title: String, now: Date = Date()) -> String {
    let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyy-MM-dd HH.mm"
    let base = places.outsource + "/" + f.string(from: now) + " " + title
    var p = base, k = 2
    while FileManager.default.fileExists(atPath: p) { p = base + " \(k)"; k += 1 }
    return p
  }

  /// The self test steps for a checked out ps-mac: its tests/selftest.sh, or build.sh and the test copy.
  static func selftestSteps(mac: String, web: String, out: String, only: String?, places: SecondPlaces) -> [SecondStep] {
    let env = baseEnv(places)
    var b = env
    b["SKIP_WEB"] = "1"; b["PS_WEB_DIR"] = web; b["PS_APP_OUT"] = mac + "/build/PS.app"; b["NO_INSTALL"] = "1"; b["PS_SELFTEST_WEB"] = web + "/dist-ps"
    let label = "self test" + (only.map { ": " + $0 } ?? "")
    if FileManager.default.fileExists(atPath: mac + "/tests/selftest.sh") {
      return [SecondStep(label: label, exe: places.bash, args: [mac + "/tests/selftest.sh", out] + (only.map { [$0] } ?? []), cwd: mac, env: b)]
    }
    var t = env
    t["PS_SELFTEST"] = out; t["PS_SELFTEST_WEB"] = web + "/dist-ps"
    if let o = only { t["PS_SELFTEST_ONLY"] = o }
    return [SecondStep(label: "build PS", exe: places.bash, args: [mac + "/build.sh"], cwd: mac, env: b),
            SecondStep(label: "test folder", native: .mkdir(out)),
            SecondStep(label: label, exe: mac + "/build/PS.app/Contents/MacOS/PS", cwd: out, env: t)]
  }

  /// A tests preset's fixed commands, in the copy `dir`. "auto" is decided once the copy exists.
  static func presetSteps(_ preset: String, _ dir: String, _ places: SecondPlaces) -> [SecondStep] {
    let env = baseEnv(places)
    let npm = places.tool("npm") ?? "npm"
    switch preset {
    case "npm-test": return [SecondStep(label: "npm ci", native: .modules(dir)), SecondStep(label: "npm test", exe: npm, args: ["test"], cwd: dir, env: env)]
    case "node-tests": return [SecondStep(label: "npm ci", native: .modules(dir)), SecondStep(label: "node tests", exe: places.tool("node") ?? "node", native: .nodeTests(dir))]
    case "swift-test": return [SecondStep(label: "swift test", exe: "/usr/bin/swift", args: ["test"], cwd: dir, env: env)]
    case "pytest": return [SecondStep(label: "pytest", exe: places.tool("python3") ?? "/usr/bin/python3", args: ["-m", "pytest", "-q"], cwd: dir, env: env)]
    case "make-test": return [SecondStep(label: "make test", exe: places.make, args: ["test"], cwd: dir, env: env)]
    default: return [SecondStep(label: "pick the tests", native: .autoTests(dir))]
    }
  }

  /// "auto": package.json test script > tests/*.test.ts > Package.swift > pytest > Makefile test.
  static func autoPreset(_ dir: String) -> String? {
    let fm = FileManager.default
    if let d = fm.contents(atPath: dir + "/package.json"), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
       let s = j["scripts"] as? [String: Any], s["test"] is String { return "npm-test" }
    if !nodeTestFiles(dir).isEmpty { return "node-tests" }
    if fm.fileExists(atPath: dir + "/Package.swift") { return "swift-test" }
    if fm.fileExists(atPath: dir + "/pytest.ini") || fm.fileExists(atPath: dir + "/conftest.py")
      || ((try? fm.contentsOfDirectory(atPath: dir + "/tests")) ?? []).contains(where: { $0.hasPrefix("test_") && $0.hasSuffix(".py") }) { return "pytest" }
    if let m = fm.contents(atPath: dir + "/Makefile").flatMap({ String(data: $0, encoding: .utf8) }),
       m.split(separator: "\n").contains(where: { $0.hasPrefix("test:") }) { return "make-test" }
    return nil
  }
  static func nodeTestFiles(_ dir: String) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: dir + "/tests")) ?? []).filter { $0.hasSuffix(".test.ts") && !$0.hasPrefix("integration") }.sorted()
  }

  /// Git repos directly under ~/Projects, for the primary's job form (name = folder name lower cased).
  static func projects(_ places: SecondPlaces) -> [[String: String]] {
    let fm = FileManager.default
    return ((try? fm.contentsOfDirectory(atPath: places.projects)) ?? []).sorted().compactMap { n in
      let path = places.projects + "/" + n
      guard isProject(n.lowercased()), fm.fileExists(atPath: path + "/.git") else { return nil }
      return ["name": n.lowercased(), "path": path]
    }
  }
}

enum SafePath {
  static func real(_ p: String) -> String { URL(fileURLWithPath: p).standardizedFileURL.resolvingSymlinksInPath().path }
}
