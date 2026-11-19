// Offline unit tests for Second Computer's runner (Sources/SecondJobs.swift, SecondProc.swift):
// job parsing, the allowlist, plans, secret hiding, the tail, timeouts and cancel. FICTIONAL data in a
// temporary folder (its own Second folder with a bare mirror of a tiny git repo); real child processes,
// only ones this test starts. Never ~/Projects, never ~/Library, never the network.
//   mkdir -p build/second && cp tests/second-test.swift build/second/main.swift && swiftc build/second/main.swift Sources/SecondJobs.swift Sources/SecondProc.swift Sources/SecondCrypto.swift Sources/SecondHost.swift Sources/SecondShare.swift Sources/SecondFiles.swift Sources/SecondSeal.swift Sources/SafeSignal.swift Sources/KeychainQuiet.swift -o build/second/test && build/second/test
import CryptoKit
import Darwin
import Foundation

func psLog(_ s: String) {}
var fails = 0
func check(_ name: String, _ ok: Bool) { print("\(name)=\(ok ? "ok" : "FAIL")"); if !ok { fails += 1 } }

// Every signal sent is recorded; none may go to pid -1, 0, 1 or this test.
var signals: [(pid_t, Int32)] = []
let realSend = SafeSignal.send
SafeSignal.send = { p, s in signals.append((p, s)); return p > 1 && p != getpid() ? realSend(p, s) : -1 }

let fm = FileManager.default
let root = SafePath.real(NSTemporaryDirectory()) + "/ps-second-test-\(getpid())"
try? fm.removeItem(atPath: root)
for d in [root + "/Projects", root + "/Second/repos"] { try! fm.createDirectory(atPath: d, withIntermediateDirectories: true) }
let places = SecondPlaces(home: root, root: root + "/Second", projects: root + "/Projects", shared: root + "/PS Shared")

@discardableResult
func sh(_ cwd: String, _ args: String...) -> String {
  let p = Process(), o = Pipe()
  p.executableURL = URL(fileURLWithPath: "/usr/bin/env"); p.arguments = args; p.currentDirectoryURL = URL(fileURLWithPath: cwd)
  p.environment = ["PATH": "/usr/bin:/bin", "HOME": root, "GIT_CONFIG_NOSYSTEM": "1", "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                   "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "t@example.invalid"]
  p.standardOutput = o; p.standardError = FileHandle.nullDevice
  try! p.run(); let d = o.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
  return String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}
// A fictional project with two commits, mirrored the way bundles fill a mirror.
let demo = root + "/Projects/demo"
try! fm.createDirectory(atPath: demo, withIntermediateDirectories: true)
sh(demo, "git", "init", "-q", "-b", "main")
try! "test:\n\t@echo commit one\n".write(toFile: demo + "/Makefile", atomically: true, encoding: .utf8)
sh(demo, "git", "add", "."); sh(demo, "git", "commit", "-q", "-m", "one")
let c1 = sh(demo, "git", "rev-parse", "HEAD")
try! "test:\n\t@echo commit two\n\t@exit 3\n".write(toFile: demo + "/Makefile", atomically: true, encoding: .utf8)
sh(demo, "git", "commit", "-q", "-am", "two")
let c2 = sh(demo, "git", "rev-parse", "HEAD")
sh(root, "git", "clone", "-q", "--bare", demo, places.mirror("demo"))

// ---------- parsing and the allowlist ----------
let sha = String(repeating: "a", count: 40), sha2 = String(repeating: "b", count: 40)
var uids: [String: String] = [:]
/// A fixed uuid per name, so the runner tests read like "run-echo".
func U(_ tag: String) -> String { if let u = uids[tag] { return u }; let u = UUID().uuidString.lowercased(); uids[tag] = u; return u }
let nowMs0 = Date().timeIntervalSince1970 * 1000
/// A job body as the primary signs it: bundles for the code it names (unless given), good for 24 h.
func job(_ type: String, _ args: [String: Any], id: String? = nil, bundles: [[String: Any]]? = nil) -> [String: Any] {
  var auto: [[String: Any]] = []
  if let p = args["project"] as? String, let h = args["head"] { auto.append(["project": p, "file": U("file-" + p), "head": h]) }
  if let m = args["mac"] { auto.append(["project": "ps-mac", "file": U("file-mac"), "head": m]) }
  if let w = args["web"] { auto.append(["project": "web", "file": U("file-web"), "head": w]) }
  return ["id": id ?? UUID().uuidString.lowercased(), "type": type, "args": args, "at": nowMs0, "exp": nowMs0 + 86_400_000, "bundles": bundles ?? auto]
}
func parse(_ d: [String: Any], probe: Bool = false) -> SecondJob? { if case .success(let j) = SecondJobs.parse(d, allowProbe: probe) { return j }; return nil }
func why(_ d: [String: Any], probe: Bool = false) -> String? { if case .failure(let r) = SecondJobs.parse(d, allowProbe: probe) { return r.why }; return nil }

check("parse-selftest", parse(job("selftest", ["mac": sha, "web": sha2, "only": "dnd"]))?.only == "dnd")
check("parse-build", parse(job("build", ["mac": sha, "web": sha2, "send": true]))?.send == true)
check("parse-tests", parse(job("tests", ["project": "demo", "head": c1, "preset": "auto"]))?.head == c1)
check("parse-claude", parse(job("claude", ["project": "ps-mac", "head": sha, "prompt": "Fix the typo", "model": "sonnet", "minutes": 10]))?.timeout == 600)
check("parse-cancel", parse(job("cancel", ["job": U("some-job")]))?.cancelJob == U("some-job"))
check("parse-research", parse(job("research", ["prompt": "Find three fictional suppliers", "title": "Suppliers (fictional)", "model": "opus", "minutes": 20]))?.timeout == 1200)
check("limits", parse(job("selftest", ["mac": sha, "web": sha2]))?.timeout == 2400 && parse(job("tests", ["project": "demo", "head": sha, "preset": "auto"]))?.timeout == 1800)

let bad: [(String, [String: Any], String)] = [
  ("unknown-type", job("shell", ["cmd": "rm -rf ~"]), "Unknown job type"),
  ("cmd-key", job("tests", ["project": "demo", "head": sha, "preset": "auto", "cmd": "rm -rf ~"]), "Bad arguments"),
  ("env-key", job("build", ["mac": sha, "web": sha2, "env": ["PATH": "/tmp"]]), "Bad arguments"),
  ("args-missing", ["id": U("x1"), "type": "tests", "exp": nowMs0 + 1000], "Bad arguments"),
  ("args-not-object", ["id": U("x2"), "type": "tests", "args": "rm -rf ~", "exp": nowMs0 + 1000], "Bad arguments"),
  ("not-uuid", job("cancel", ["job": U("x3")], id: "job-1234"), "Bad id"),
  ("no-exp", ["id": U("x4"), "type": "cancel", "args": ["job": U("x3")]], "Too old"),
  ("expired", ["id": U("x5"), "type": "cancel", "args": ["job": U("x3")], "at": nowMs0 - 9e7, "exp": nowMs0 - 1000], "Too old"),
  ("exp-too-far", ["id": U("x6"), "type": "cancel", "args": ["job": U("x3")], "at": nowMs0, "exp": nowMs0 + 2 * 86_400_000], "Bad arguments"),
  ("bundle-not-named", job("tests", ["project": "demo", "head": sha, "preset": "auto"], bundles: []), "Code bundle missing"),
  ("bundle-other-head", job("tests", ["project": "demo", "head": sha, "preset": "auto"], bundles: [["project": "demo", "file": U("f"), "head": sha2]]), "Code bundle missing"),
  ("selftest-web-missing", job("selftest", ["mac": sha, "web": sha2], bundles: [["project": "ps-mac", "file": U("f"), "head": sha]]), "Code bundle missing"),
  ("bundle-bad-file", job("tests", ["project": "demo", "head": sha, "preset": "auto"], bundles: [["project": "demo", "file": "x", "head": sha]]), "Bad arguments"),
  ("four-bundles", job("tests", ["project": "demo", "head": sha, "preset": "auto"], bundles: Array(repeating: ["project": "demo", "file": U("f"), "head": sha], count: 4)), "Bad arguments"),
  ("research-bundle", job("research", ["prompt": "x", "title": "Ok"], bundles: [["project": "demo", "file": U("f"), "head": sha]]), "Bad arguments"),
  ("research-title", job("research", ["prompt": "x", "title": "../../etc"]), "Bad arguments"),
  ("research-bash", job("research", ["prompt": "x", "title": "Ok", "tools": "Bash"]), "Bad arguments"),
  ("minutes-float", job("claude", ["project": "demo", "head": sha, "prompt": "x", "minutes": 7.5]), "Bad arguments"),
  ("send-number", job("build", ["mac": sha, "web": sha2, "send": 1]), "Bad arguments"),
  ("short-sha", job("tests", ["project": "demo", "head": "abcdef1", "preset": "auto"]), "Bad arguments"),
  ("upper-sha", job("selftest", ["mac": sha.uppercased(), "web": sha2]), "Bad arguments"),
  ("sha-injection", job("selftest", ["mac": "HEAD;rm -rf ~ aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "web": sha2]), "Bad arguments"),
  ("sha-flag", job("tests", ["project": "demo", "head": "--output=/tmp/xxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "preset": "auto"]), "Bad arguments"),
  ("project-slash", job("tests", ["project": "../etc", "head": sha, "preset": "auto"]), "Bad arguments"),
  ("project-abs", job("tests", ["project": "/etc", "head": sha, "preset": "auto"]), "Bad arguments"),
  ("project-upper", job("tests", ["project": "Demo", "head": sha, "preset": "auto"]), "Bad arguments"),
  ("project-dot-first", job("tests", ["project": ".git", "head": sha, "preset": "auto"]), "Bad arguments"),
  ("preset-unknown", job("tests", ["project": "demo", "head": sha, "preset": "bash"]), "Bad arguments"),
  ("prompt-empty", job("claude", ["project": "demo", "head": sha, "prompt": "  "]), "Bad arguments"),
  ("prompt-long", job("claude", ["project": "demo", "head": sha, "prompt": String(repeating: "a", count: 8001)]), "Bad arguments"),
  ("model-haiku", job("claude", ["project": "demo", "head": sha, "prompt": "x", "model": "haiku"]), "Bad arguments"),
  ("minutes-low", job("claude", ["project": "demo", "head": sha, "prompt": "x", "minutes": 2]), "Bad arguments"),
  ("minutes-high", job("claude", ["project": "demo", "head": sha, "prompt": "x", "minutes": 61]), "Bad arguments"),
  ("permission-key", job("claude", ["project": "demo", "head": sha, "prompt": "x", "permission": "bypassPermissions"]), "Bad arguments"),
  ("area-bad", job("selftest", ["mac": sha, "web": sha2, "only": "all;rm"]), "Bad arguments"),
  ("send-string", job("build", ["mac": sha, "web": sha2, "send": "yes"]), "Bad arguments"),
  ("bad-id", ["id": "../x", "type": "cancel", "args": ["job": "abcdefg"], "exp": nowMs0 + 1000], "Bad id"),
  ("cancel-bad-id", job("cancel", ["job": "../../x"]), "Bad arguments"),
  ("probe-live", job("probe", ["probe": "echo"]), "Unknown job type"),
]
for (name, d, w) in bad { check("refuse-\(name)", why(d) == w) }
check("probe-ok-in-tests", parse(job("probe", ["probe": "echo"]), probe: true) != nil)

// ---------- plans: fixed programs only, nothing from the job is ever a command ----------
for d in [job("selftest", ["mac": sha, "web": sha2, "only": "dnd"]), job("build", ["mac": sha, "web": sha2, "send": true]),
          job("tests", ["project": "demo", "head": sha, "preset": "auto"]), job("claude", ["project": "demo", "head": sha, "prompt": "--dangerously-skip-permissions; rm -rf ~"]),
          job("research", ["prompt": "--dangerously-skip-permissions", "title": "Fictional market"])] {
  guard let j = parse(d) else { check("plan-parse", false); continue }
  let p = SecondJobs.plan(j, places: places)
  let steps = p.prep + p.run + p.cleanup
  let k = j.kind.rawValue
  check("plan-\(k)-no-shell-c", !steps.contains { $0.args.contains("-c") })
  check("plan-\(k)-only-in-second", steps.allSatisfy { $0.native != nil || $0.cwd.hasPrefix(places.root) || (j.kind == .research && $0.cwd.hasPrefix(places.outsource + "/")) })
  check("plan-\(k)-never-applications", !steps.contains { ($0.args + [$0.exe, $0.cwd]).contains { $0.hasPrefix("/Applications") } })
  check("plan-\(k)-code-from-mirror", steps.filter { $0.args.contains("worktree") && $0.args.contains("add") }.allSatisfy { $0.args[0].hasPrefix("--git-dir=" + places.root + "/repos/") })
  check("plan-\(k)-copies-removed", p.copies.allSatisfy { $0.hasPrefix(places.root + "/work/") })
  if j.kind == .claude {
    let c = p.run[0]
    check("plan-claude-prompt-on-stdin", c.stdin == j.prompt && !c.args.contains(j.prompt!))
    check("plan-claude-flags", c.args.contains("acceptEdits") && c.args.contains(SecondJobs.claudeTools) && !c.args.contains { $0.contains("dangerously") })
  }
  if j.kind == .research {
    let c = p.run.first { $0.label == "claude" }
    check("plan-research-no-bash", c?.args.contains(SecondJobs.researchTools) == true && !(c?.args.joined(separator: " ").contains("Bash") ?? true) && c?.stdin == j.prompt)
    check("plan-research-folder", (c?.cwd ?? "").hasPrefix(places.outsource + "/") && (c?.cwd ?? "").hasSuffix(" Fictional market") && p.copies.isEmpty)
  }
  if j.kind == .selftest {
    guard case .selftest(let mac, let web, let out, let only)? = p.run.last?.native else { check("plan-selftest-step", false); continue }
    let old = SecondJobs.selftestSteps(mac: mac, web: web, out: out, only: only, places: places)   // a commit without tests/selftest.sh
    let b = old.first { $0.label == "build PS" }
    check("plan-selftest-no-install", b?.env["NO_INSTALL"] == "1" && (b?.env["PS_APP_OUT"] ?? "").hasPrefix(places.root + "/work/"))
    check("plan-selftest-test-copy", old.contains { $0.env["PS_SELFTEST"] != nil && $0.env["PS_SELFTEST_ONLY"] == "dnd" && $0.env["PS_SELFTEST_WEB"] != nil })
    try? fm.createDirectory(atPath: mac + "/tests", withIntermediateDirectories: true)
    fm.createFile(atPath: mac + "/tests/selftest.sh", contents: Data())
    let new = SecondJobs.selftestSteps(mac: mac, web: web, out: out, only: only, places: places)
    check("plan-selftest-script", new.count == 1 && new[0].args == [mac + "/tests/selftest.sh", out, "dnd"] && new[0].env["PS_APP_OUT"] == mac + "/build/PS.app")
    try? fm.removeItem(atPath: places.work(j.id))
  }
}
check("env-clean", SecondJobs.baseEnv(places).keys.allSatisfy { !$0.hasPrefix("PS_") && !$0.contains("SUPABASE") && !$0.contains("KEY") })

// ---------- secrets ----------
let r1 = SecondRedact.text("key sb_secret_abcdefghijklmnop and sk-ant-api03-abcdefghijkl and password=hunter22 and ghp_abcdefghijklmnopqrstuvwxyz1234")
check("redact", !r1.contains("abcdefghijklmnop") && !r1.contains("hunter22") && !r1.contains("api03") && r1.contains("[hidden]") && r1.hasPrefix("key "))
check("redact-jwt", !SecondRedact.text("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop").contains("eyJzdWIi"))
check("redact-plain-left", SecondRedact.text("build ok in 12 s") == "build ok in 12 s")

// ---------- the runner, with real child processes ----------
let evLock = NSLock()
var events: [SecondRunner.Status] = []
let lockFile = root + "/selftest.lock"
var env = SecondRunner.Env(places: places, allowProbe: true)
env.grace = 1; env.lockPath = lockFile
let runner = SecondRunner(env: env)
runner.onStatus = { s in evLock.lock(); events.append(s); evLock.unlock() }
func evs(_ id: String) -> [SecondRunner.Status] { evLock.lock(); defer { evLock.unlock() }; return events.filter { $0.job == id } }
func final(_ id: String) -> SecondRunner.Status? { evs(id).last { ["done", "failed", "cancelled", "timeout", "refused"].contains($0.state) } }
func wait(_ id: String, _ s: Double) -> SecondRunner.Status? {
  let until = Date().addingTimeInterval(s)
  while Date() < until { if let f = final(id) { return f }; usleep(50_000) }
  return nil
}
func log(_ id: String) -> String { (try? String(contentsOfFile: places.logs + "/" + id + ".log", encoding: .utf8)) ?? "" }
func alive(_ pid: pid_t) -> Bool { pid > 1 && kill(pid, 0) == 0 }
func waitTail(_ id: String, _ needle: String, _ s: Double) -> String {
  let until = Date().addingTimeInterval(s)
  while Date() < until { if let (i, t) = runner.runningTail(), i == id, t.contains(needle) { return t }; usleep(50_000) }
  return ""
}

runner.submit(job("probe", ["probe": "echo"], id: U("run-echo")))
let fe = wait(U("run-echo"), 10)
check("echo-done", fe?.state == "done" && fe?.exit == 0 && fe?.startedAt != nil && fe?.endedAt != nil)
check("echo-summary", fe?.summary == "probe done")
check("echo-log-both-streams", log(U("run-echo")).contains("probe done") && log(U("run-echo")).contains("to stderr"))
check("echo-secret-hidden", !log(U("run-echo")).contains("FAKEFAKE") && log(U("run-echo")).contains("[hidden]"))
check("echo-copy-removed", !fm.fileExists(atPath: places.work(U("run-echo"))))

runner.submit(job("probe", ["probe": "spam"], id: U("run-spam")))
_ = wait(U("run-spam"), 15)
let spamLog = log(U("run-spam"))
check("spam-all-lines-logged", spamLog.contains("line 0 of") && spamLog.contains("line 1999 of"))
runner.submit(job("probe", ["probe": "sleep", "seconds": 3], id: U("run-tail")))
let tail = waitTail(U("run-tail"), "probe sleeping", 5)
check("tail-while-running", tail.contains("probe sleeping") && tail.utf8.count <= 4096)
_ = wait(U("run-tail"), 10)

// A deadline (the probe asks for 2 s): the child is stopped through its handle.
let t0 = Date()
runner.submit(job("probe", ["probe": "sleep", "seconds": 2], id: U("run-timeout")))
let sleepTail = waitTail(U("run-timeout"), "probe sleeping", 5)
let sleptPid = sleepTail.split(separator: "\n").first { $0.hasPrefix("probe sleeping") }.flatMap { $0.split(separator: " ").last }.flatMap { Int32($0) } ?? 0
let ft = wait(U("run-timeout"), 12)
check("timeout-state", ft?.state == "timeout")
check("timeout-fast", Date().timeIntervalSince(t0) < 7)
check("timeout-child-gone", sleptPid > 1 && !alive(sleptPid))

// A cancel: the child and the sleep it started are both gone.
runner.submit(job("probe", ["probe": "tree"], id: U("run-cancel")))
let treeTail = waitTail(U("run-cancel"), "PIDS ", 5)
let pids = treeTail.split(separator: "\n").first { $0.hasPrefix("PIDS ") }.map { $0.split(separator: " ").dropFirst().compactMap { Int32($0) } } ?? []
check("tree-running", pids.count == 2 && pids.allSatisfy(alive))
runner.submit(job("cancel", ["job": U("run-cancel")], id: U("run-cancel-job")))
let fc = wait(U("run-cancel"), 10)
check("cancel-state", fc?.state == "cancelled")
check("cancel-job-done", final(U("run-cancel-job"))?.state == "done")
check("cancel-tree-gone", pids.count == 2 && !pids.contains(where: alive))

// A queued job cancelled before it starts, the same id twice, an unknown job type.
runner.submit(job("probe", ["probe": "sleep", "seconds": 3], id: U("run-block")))
runner.submit(job("probe", ["probe": "echo"], id: U("run-queued")))
check("duplicate-refused", !runner.submit(job("probe", ["probe": "echo"], id: U("run-queued"))) && final(U("run-queued"))?.reason == "Seen before")
_ = runner.cancel(U("run-queued"))
check("queued-cancelled", evs(U("run-queued")).contains { $0.state == "cancelled" } && !evs(U("run-queued")).contains { $0.state == "running" })
_ = runner.cancel(U("run-block"))
_ = wait(U("run-block"), 8)
runner.submit(job("shell", ["cmd": "id"], id: U("run-bad")))
check("refused-status", final(U("run-bad"))?.state == "refused" && final(U("run-bad"))?.reason == "Unknown job type")

// Someone else's self test copy holds the lock: the job waits, then runs once it is let go.
let lfd = open(lockFile, O_CREAT | O_RDWR, 0o644)
_ = flock(lfd, LOCK_EX)
runner.submit(job("probe", ["probe": "echo"], id: U("run-lock")))
usleep(1_500_000)
check("waits-for-selftest-lock", final(U("run-lock")) == nil && evs(U("run-lock")).contains { ($0.reason ?? "").contains("self test") })
_ = flock(lfd, LOCK_UN); close(lfd)
check("runs-after-lock", wait(U("run-lock"), 10)?.state == "done")

// A real job: the project's own test command on an older commit, from the mirror, in a clean copy.
runner.submit(job("tests", ["project": "demo", "head": c1, "preset": "auto"], id: U("run-make")))
let fm1 = wait(U("run-make"), 30)
check("make-done", fm1?.state == "done" && fm1?.summary == "commit one")
check("make-auto-preset", log(U("run-make")).contains("tests preset: make-test"))
check("make-copy-removed", !fm.fileExists(atPath: places.work(U("run-make"))) && !sh(root, "git", "--git-dir=" + places.mirror("demo"), "worktree", "list").contains(U("run-make")))
runner.submit(job("tests", ["project": "demo", "head": c2, "preset": "make-test"], id: U("run-fail")))
let ff = wait(U("run-fail"), 30)
check("failing-test-failed", ff?.state == "failed" && ff?.exit == 2 && ff?.summary == "commit two")
runner.submit(job("tests", ["project": "demo", "head": String(repeating: "d", count: 40), "preset": "auto"], id: U("run-nocommit")))
check("missing-commit", wait(U("run-nocommit"), 15)?.reason == "Code bundle missing")
runner.submit(job("tests", ["project": "nothing", "head": c1, "preset": "auto"], id: U("run-nomirror")))
check("missing-mirror", wait(U("run-nomirror"), 15)?.reason == "Code bundle missing")

// Research and Claude jobs with a FICTIONAL stand-in for `claude` (a script in a test folder that
// records its arguments and stdin, writes a file, answers JSON). Never the real Claude, never the network.
let fake = root + "/fakebin"
try! fm.createDirectory(atPath: fake, withIntermediateDirectories: true)
try! """
#!/bin/bash
printf '%s\\n' "$@" > "$PWD/../args-$(basename "$PWD").txt" 2>/dev/null || printf '%s\\n' "$@" > /dev/null
prompt="$(cat)"
if [ -f Makefile ]; then echo "fixed by fictional claude" >> Makefile; printf '%s' '{"result":"Fixed the Makefile"}'
else printf '# Report\\n\\nThree fictional suppliers for: %s\\n' "$prompt" > report.md; printf '{"result":"Found three fictional suppliers"}'; fi
""".write(toFile: fake + "/claude", atomically: true, encoding: .utf8)
chmod(fake + "/claude", 0o755)
var p2 = places; p2.tools = [fake] + places.tools
let r2 = SecondRunner(env: .init(places: p2, allowProbe: true, grace: 1, lockPath: lockFile))
r2.onStatus = { s in evLock.lock(); events.append(s); evLock.unlock() }
r2.submit(job("research", ["prompt": "Fictional sourcing question", "title": "Suppliers"], id: U("run-research")))
let fr = wait(U("run-research"), 20)
let rfolder = ((try? fm.contentsOfDirectory(atPath: places.outsource)) ?? []).first { $0.hasSuffix(" Suppliers") }.map { places.outsource + "/" + $0 } ?? ""
check("research-done", fr?.state == "done" && fr?.summary == "Found three fictional suppliers")
check("research-folder-kept", fm.fileExists(atPath: rfolder + "/report.md"))
check("research-result-report", fr?.result?.name == "report.md" && (fr?.result.flatMap { try? String(contentsOfFile: $0.path, encoding: .utf8) } ?? "").contains("Fictional sourcing question"))
let rargs = (try? String(contentsOfFile: places.outsource + "/args-" + (rfolder as NSString).lastPathComponent + ".txt", encoding: .utf8)) ?? ""
check("research-tools-no-bash", rargs.contains(SecondJobs.researchTools) && !rargs.contains("Bash") && !rargs.contains("Fictional sourcing"))
r2.submit(job("claude", ["project": "demo", "head": c1, "prompt": "Fix the fictional Makefile"], id: U("run-claude")))
let fcl = wait(U("run-claude"), 30)
let patch = fcl?.result.flatMap { try? String(contentsOfFile: $0.path, encoding: .utf8) } ?? ""
check("claude-done", fcl?.state == "done" && fcl?.files == ["Makefile"] && fcl?.summary == "Fixed the Makefile (1 files changed)")
check("claude-patch", fcl?.result?.mime == "text/x-diff" && patch.contains("+fixed by fictional claude"))
let cfolder = ((try? fm.contentsOfDirectory(atPath: places.outsource)) ?? []).first { $0.contains(" Claude " + U("run-claude").prefix(8)) }.map { places.outsource + "/" + $0 } ?? ""
check("claude-outsource-copy", fm.fileExists(atPath: cfolder + "/answer.md") && ((try? fm.contentsOfDirectory(atPath: cfolder)) ?? []).contains { $0.hasSuffix(".patch") })
check("claude-copy-removed", !fm.fileExists(atPath: places.work(U("run-claude"))))

check("no-signal-to-bad-pids", !signals.contains { $0.0 <= 1 || $0.0 == getpid() })

// ---------- files and code bundles ----------
check("clean-name", SecondLanding.clean("../../etc/passwd") == "etc-passwd" && SecondLanding.clean(".hidden") == "hidden" && SecondLanding.clean("a\u{0}b\nc.txt") == "abc.txt" && SecondLanding.clean("") == "file")
let dl = root + "/Downloads/From PS"
let landing = SecondLanding(places: places, downloads: dl)
func send(_ name: String, _ data: Data, purpose: String = "user", chunk: Int = 4, id: String = "f-" + UUID().uuidString.lowercased().prefix(8), sha: String? = nil, order: [Int]? = nil) -> SecondLanding.Done? {
  let n = max(1, (data.count + chunk - 1) / chunk)
  let hex = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  let body: [String: Any] = ["id": id, "name": name, "size": data.count, "sha256": sha ?? hex, "purpose": purpose, "chunk": chunk, "n": n]
  var last: SecondLanding.Done?
  for i in order ?? Array(0..<n) {
    let part = data.subdata(in: (i * chunk)..<min(data.count, (i + 1) * chunk))
    if let d = landing.chunk(body, i: i, n: n, data: part) { last = d; break }
  }
  return last
}
let hello = Data("Hello from the fictional primary".utf8)
let d1 = send("note.txt", hello)
check("land-ok", d1?.ok == true && d1?.path == dl + "/note.txt" && fm.contents(atPath: dl + "/note.txt") == hello)
check("land-quarantined", getxattr(dl + "/note.txt", "com.apple.quarantine", nil, 0, 0, 0) > 0)
check("land-second-name", send("note.txt", hello)?.path == dl + "/note 2.txt")
check("land-traversal-cleaned", send("../../evil.sh", hello)?.path == dl + "/evil.sh")
check("land-bad-sha", send("x.txt", hello, sha: String(repeating: "0", count: 64))?.reason == "The file did not arrive whole" && !fm.fileExists(atPath: dl + "/x.txt"))
check("land-out-of-order", send("y.txt", hello, order: [1, 0])?.reason == "A chunk came out of order")
// v1.2 (drag and drop): a file streams, so the limit is 1 GB a file (it was 50 MB sent whole).
check("land-too-big", landing.chunk(["id": "f-big-0001", "name": "big", "size": (1 << 30) + 1, "sha256": "", "purpose": "user", "chunk": 4 << 20, "n": 257], i: 0, n: 257, data: Data())?.reason == "Over 1 GB")
check("land-bundle-too-big", landing.chunk(["id": "f-big-0002", "name": "x.bundle", "size": 26 << 20, "sha256": "", "purpose": "bundle", "chunk": 4 << 20, "n": 7], i: 0, n: 7, data: Data())?.reason == "Over 25 MB")
check("land-nothing-left", ((try? fm.contentsOfDirectory(atPath: places.root + "/incoming")) ?? []).isEmpty)

// A bundle of uncommitted work (git stash create: the working tree is not touched), into a new mirror.
try! "test:\n\t@echo uncommitted change\n".write(toFile: demo + "/Makefile", atomically: true, encoding: .utf8)
var got: SecondGit.Bundle?
if case .success(let b) = SecondGit.make(repo: demo, base: nil, req: "req-0001") { got = b }
check("bundle-made", got != nil && got!.dirty && got!.files == ["Makefile"] && got!.head != c2)
check("bundle-ref-gone", !sh(demo, "git", "for-each-ref").contains("ps-second"))
check("bundle-tree-untouched", (try? String(contentsOfFile: demo + "/Makefile", encoding: .utf8))?.contains("uncommitted") == true && sh(demo, "git", "stash", "list").isEmpty)
try? fm.removeItem(atPath: places.mirror("demo2"))
var haveSeen: (String, String)?
landing.onHave = { haveSeen = ($0, $1) }
let bd = send("demo2.bundle", got?.data ?? Data(), purpose: "bundle", chunk: 1 << 20)
check("bundle-landed", bd?.ok == true && bd?.head == got?.head && haveSeen?.0 == "demo2" && haveSeen?.1 == got?.head)
runner.submit(job("tests", ["project": "demo2", "head": got?.head ?? sha, "preset": "auto"], id: U("run-bundle")))
check("bundle-job", wait(U("run-bundle"), 30)?.summary == "uncommitted change")
// An incremental bundle on top of what the mirror has.
sh(demo, "git", "commit", "-q", "-am", "three")
var inc: SecondGit.Bundle?
if case .success(let b) = SecondGit.make(repo: demo, base: c2, req: "req-0002") { inc = b }
check("bundle-incremental", inc?.base == c2 && (inc?.data.count ?? 1 << 30) < (got?.data.count ?? 0) + 2000)
check("bundle-needs-base", send("demo3.bundle", inc?.data ?? Data(), purpose: "bundle")?.ok == false)
var same: SecondGit.Bundle?
if case .success(let b) = SecondGit.make(repo: demo, base: inc?.head, req: "req-0003") { same = b }
check("bundle-when-head-is-there", same != nil && same?.head == inc?.head && same?.base != nil)
check("bundle-into-mirror", send("demo2.bundle", inc?.data ?? Data(), purpose: "bundle", chunk: 1 << 20)?.ok == true)

// Staying awake: only while Secondary and on power, never a real assertion here.
let awake = SecondAwake()
var fakePower = SecondAwake.Power(ac: true, charging: true, battery: 80)
var made = 0, released = 0
awake.create = { made += 1; return 42 }
awake.release = { _ in released += 1 }
awake.read = { fakePower }
awake.changed()
check("awake-off-by-default", !awake.held && made == 0)
awake.set(secondary: true)
check("awake-secondary-on-power", awake.held && made == 1)
fakePower.ac = false; awake.changed()
check("awake-released-on-battery", !awake.held && released == 1)
fakePower.ac = true; awake.changed(); awake.set(secondary: false)
check("awake-released-when-off", !awake.held && made == 2 && released == 2)
let st = SecondStat.sample(home: root, power: .init(ac: false, charging: false, battery: 10))
check("stat-fields", st["power"] as? String == "battery" && st["sleepSoon"] as? Bool == true && (st["cpu"] as? Int).map { (0...100).contains($0) } == true && (st["disk"] as? Int ?? -1) >= 0)

// ---------- shared folders (protocol v1.1 section 15) ----------
let sroot = SecondShare.Root(id: "ps-shared", name: "PS Shared", path: root + "/Share")
try! fm.createDirectory(atPath: sroot.path + "/docs", withIntermediateDirectories: true)
try! Data("a".utf8).write(to: URL(fileURLWithPath: sroot.path + "/docs/a.md"))
try! Data("b".utf8).write(to: URL(fileURLWithPath: sroot.path + "/.secret"))
try! Data("outside".utf8).write(to: URL(fileURLWithPath: root + "/outside.txt"))
try! fm.createSymbolicLink(atPath: sroot.path + "/out.txt", withDestinationPath: root + "/outside.txt")
try! fm.createSymbolicLink(atPath: sroot.path + "/outdir", withDestinationPath: root)
let ix = SecondShare.index(sroot), ixp = Set(ix.compactMap { $0["p"] as? String })
check("share-index", ixp == ["docs", "docs/a.md"])
check("share-path-rules", SecondShare.pathOk("docs/a.md") && !SecondShare.pathOk("../x") && !SecondShare.pathOk("/etc/hosts") && !SecondShare.pathOk("docs/.git/x") && !SecondShare.pathOk("a//b") && !SecondShare.pathOk("a\\b") && !SecondShare.pathOk(""))
func getBody(_ path: String, _ extra: [String: Any] = [:]) -> [String: Any] { var b: [String: Any] = ["v": 1, "t": "get", "id": "g1", "from": "x", "to": "y", "at": 1, "root": "ps-shared", "path": path, "as": "download"]; for (k, v) in extra { b[k] = v }; return b }
check("share-get-ok", SecondShare.check(getBody("docs/a.md"), roots: [sroot]).map { (try? SecondShare.file($0.0, $0.1).get()) ?? nil } == SafePath.real(sroot.path + "/docs/a.md"))
check("share-get-extra-key", SecondShare.check(getBody("docs/a.md", ["cmd": "x"]), roots: [sroot]) == nil)
check("share-get-other-root", SecondShare.check(getBody("docs/a.md", ["root": "other"]), roots: [sroot]) == nil)
check("share-get-link-out", { if case .failure = SecondShare.file(sroot, "out.txt") { return true }; return false }())
check("share-get-folder", { if case .failure = SecondShare.file(sroot, "docs") { return true }; return false }())
check("share-land-dir", SecondShare.landingDir([sroot], root: "ps-shared", dir: "In/box") == SafePath.real(sroot.path) + "/In/box" && SecondShare.landingDir([sroot], root: "ps-shared", dir: "../x") == nil
      && SecondShare.landingDir([sroot], root: "ps-shared", dir: "outdir") == nil && SecondShare.landingDir([sroot], root: "nope", dir: nil) == nil)
check("research-title-rules", SecondJobs.isTitle("Suppliers (fictional), A&B") && !SecondJobs.isTitle(" lead") && !SecondJobs.isTitle("a/b") && !SecondJobs.isTitle(String(repeating: "a", count: 81)))

// ---------- keys, signatures, pairing code, envelope checks (protocol v1 sections 2 and 3) ----------
// The lead's test vector (WebCrypto made it): x963 public key, raw r||s signature over the UTF-8 body.
let vecPub = "BCwos9Zyh+7nloA0mZa0U0ODzXSfBtg29XTkppkPn5eYn37QRhrzWvSEfKunENwGKR5bykJIzkpff8Reia/EjDg="
let vecEnv = SecondEnv(body: #"{"v":1,"t":"job","id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","from":"m4-device","to":"m1-device","at":1793448000000,"exp":1793534400000,"type":"selftest","args":{"mac":"1111111111111111111111111111111111111111","web":"2222222222222222222222222222222222222222"},"bundles":[{"project":"ps-mac","file":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","head":"1111111111111111111111111111111111111111"},{"project":"web","file":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","head":"2222222222222222222222222222222222222222"}]}"#,
                       sig: "O6P4Uo57CksrdCs+Vma3kUdsfGBAExEKkS27o13UO04gDvJYN4ieYW0HY8D6nnPI5Q3E3pDNbn4gG0mD04Vi8g==", by: "m4-device")
check("vector-signature", SecondIdentity.verify(vecEnv, pub: vecPub))
var tampered = vecEnv; tampered.body = tampered.body.replacingOccurrences(of: "selftest", with: "claude")
check("vector-tampered-fails", !SecondIdentity.verify(tampered, pub: vecPub))
check("vector-pair-code", SecondIdentity.pairCode(primaryPub: "BPrimaryKeyForTheTestVectorOnly", secondaryPub: "BSecondaryKeyForTheTestVectorOnly") == "360 280")
check("vector-pair-code-real", SecondIdentity.pairCode(primaryPub: "BMTzy6/WYKbWwJNLI4sW/8ZFOpBYM72B5QWYgJTo25qF/+eEU+WkzuqST+A/O97RgEIj9GA13KJfCqDaGGC/phg=",
                                                       secondaryPub: "BEWdrrmMJK84hjiqmUmITx11v+oc5J/F2dxwxnIc3BdUasm10f+2qYh79/eXfkvl5aY1EU/G90lq1s8Aw0rceDU=") == "349 797")

let m4 = SecondIdentity(store: SecondFileStore(dir: root + "/m4"), seenPath: root + "/m4/seen.json")
let m1 = SecondIdentity(store: SecondFileStore(dir: root + "/m1"), seenPath: root + "/m1/seen.json")
let stranger = SecondIdentity(store: SecondFileStore(dir: root + "/x"), seenPath: root + "/x/seen.json")
check("keys-made", m4.ready && m1.ready && m4.device != m1.device && m4.pub.count == 88)
let m4Again = SecondIdentity(store: SecondFileStore(dir: root + "/m4"), seenPath: root + "/m4/seen.json")
check("key-kept", m4Again.device == m4.device && m4Again.pub == m4.pub)
m1.trust(SecondPeer(device: m4.device, name: "M4", pub: m4.pub, role: "primary", at: 0))
let nowMs = Date().timeIntervalSince1970 * 1000
func jobBody(_ id: String, from: SecondIdentity = m4, to: String? = nil, at: Double = nowMs) -> [String: Any] {
  ["v": 1, "t": "job", "id": id, "from": from.device, "to": to ?? m1.device, "at": at, "exp": at + 86_400_000, "type": "cancel", "args": ["job": "abcdefgh"]]
}
func opened(_ e: SecondEnv?) -> String { guard let e else { return "no env" }; switch m1.open(e, expect: ["job"]) { case .success: return "ok"; case .failure(let r): return r.why } }
check("env-ok", opened(m4.sign(jobBody("j-ok-0001"))) == "ok")
check("env-replay", opened(m4.sign(jobBody("j-ok-0001"))) == "Seen before")
check("env-untrusted", opened(stranger.sign(jobBody("j-st-0001", from: stranger))) == "Not signed by your primary")
var forged = m4.sign(jobBody("j-fg-0001"))!; forged.by = stranger.device
check("env-wrong-signer", opened(forged) == "Not signed by your primary")
var lying = stranger.sign(jobBody("j-ly-0001"))!; lying.by = m4.device   // claims the M4, signed by someone else
check("env-forged-by", opened(lying) == "Not signed by your primary")
check("env-other-mac", opened(m4.sign(jobBody("j-to-0001", to: stranger.device))) == "Not for this Mac")
check("env-job-to-all", opened(m4.sign(jobBody("j-al-0001", to: "all"))) == "Not for this Mac")
check("env-too-old", opened(m4.sign(jobBody("j-old-001", at: nowMs - 25 * 3_600_000))) == "Too old")
check("env-future", opened(m4.sign(jobBody("j-fut-001", at: nowMs + 10 * 60_000))) == "Too old")
let m1Again = SecondIdentity(store: SecondFileStore(dir: root + "/m1"), seenPath: root + "/m1/seen.json")
check("seen-kept", { switch m1Again.open(m4.sign(jobBody("j-ok-0001"))!, expect: ["job"]) { case .failure(let r): return r.why == "Seen before"; default: return false } }())

// A forged pairing: a stranger signs a pair body naming the real M4 as signer (by) with the M4's real public key in
// the body. trust() checks it against that key (open with pub:), so it must fail; the genuine one passes.
func pairBody(_ id: String) -> [String: Any] {
  ["v": 1, "t": "pair", "id": id, "from": m4.device, "to": m1.device, "at": nowMs, "primary": m4.device, "primaryPub": m4.pub,
   "secondary": m1.device, "secondaryPub": m1.pub, "names": ["p": "M4", "s": "M1"]]
}
var forgedPair = stranger.sign(pairBody("pair-forged-1"))!; forgedPair.by = m4.device
check("pair-forged-refused", { if case .failure(let r) = m1.open(forgedPair, expect: ["pair"], pub: m4.pub) { return r.why == "Not signed by your primary" }; return false }())
check("pair-genuine-ok", { if case .success = m1.open(m4.sign(pairBody("pair-real-01"))!, expect: ["pair"], pub: m4.pub) { return true }; return false }())
// ---------- machine commands (protocol section 13) and the phone's limits ----------
// What the reboot session asked for: bad signature, expired, replayed, unknown device, and a phone key used
// for anything but a command. checkCmd is the same function Second.swift runs after open().
let phone = SecondIdentity(store: SecondFileStore(dir: root + "/phone"), seenPath: root + "/phone/seen.json")
m1.trust(SecondPeer(device: phone.device, name: "Phone", pub: phone.pub, role: "phone", at: 0))
func cmdBody(_ id: String, from: SecondIdentity = m4, at: Double = nowMs, life: Double = 120_000, action: String = "lock", extra: [String: Any] = [:]) -> [String: Any] {
  var b: [String: Any] = ["v": 1, "t": "cmd", "id": id, "from": from.device, "to": m1.device, "at": at, "exp": at + life, "action": action]
  for (k, v) in extra { b[k] = v }
  return b
}
/// open() then checkCmd(), as Second.swift does: "ok" or the plain reason.
func cmdResult(_ e: SecondEnv?) -> String {
  guard let e else { return "no env" }
  switch m1.open(e, expect: ["cmd"]) {
  case .failure(let r): return r.why
  case .success(let b): return SecondIdentity.checkCmd(b, signerRole: m1.peer(e.by)?.role) ?? "ok"
  }
}
check("cmd-primary-lock-ok", cmdResult(m4.sign(cmdBody("c-ok-0001"))) == "ok")
var badSig = m4.sign(cmdBody("c-sig-0001"))!; badSig.body = badSig.body.replacingOccurrences(of: "\"lock\"", with: "\"restart\"")
check("cmd-bad-signature", cmdResult(badSig) == "Not signed by your primary")
check("cmd-expired", cmdResult(m4.sign(cmdBody("c-exp-0001", at: nowMs - 200_000))) == "Too old")
check("cmd-life-over-2-min", cmdResult(m4.sign(cmdBody("c-life-001", life: 600_000))) == "Too old")
check("cmd-replayed", cmdResult(m4.sign(cmdBody("c-ok-0001"))) == "Seen before")
check("cmd-unknown-device", cmdResult(stranger.sign(cmdBody("c-str-0001", from: stranger))) == "Not signed by your primary")
var claimsM4 = stranger.sign(cmdBody("c-fake-001"))!; claimsM4.by = m4.device
check("cmd-forged-signer", cmdResult(claimsM4) == "Not signed by your primary")
check("cmd-extra-key", cmdResult(m4.sign(cmdBody("c-key-0001", extra: ["script": "rm -rf ~"]))) == "Bad arguments")
check("cmd-unknown-action", cmdResult(m4.sign(cmdBody("c-act-0001", action: "format"))) == "Unknown command")
check("cmd-from-a-secondary", SecondIdentity.checkCmd(cmdBody("c-sec-0001"), signerRole: "secondary") == "Not signed by your primary")
check("phone-cmd-ok", cmdResult(phone.sign(cmdBody("c-ph-0001", from: phone, action: "restart"))) == "ok")
// V1.28: Postpone (one more hour on the other Mac's auto reboot countdown), from the primary or the phone, no arguments.
check("cmd-primary-postpone-ok", cmdResult(m4.sign(cmdBody("c-pp-0001", action: "postpone"))) == "ok")
check("phone-cmd-postpone-ok", cmdResult(phone.sign(cmdBody("c-pp-0002", from: phone, action: "postpone"))) == "ok")
check("cmd-postpone-no-arguments", cmdResult(m4.sign(cmdBody("c-pp-0003", action: "postpone", extra: ["minutes": 600]))) == "Bad arguments")
check("cmd-postpone-from-a-secondary", SecondIdentity.checkCmd(cmdBody("c-pp-0004", action: "postpone"), signerRole: "secondary") == "Not signed by your primary")
// V1.28: set:<mode>:<minutes>, the main Mac chooses this Mac's auto reboot (10 to 4320 minutes); never the phone.
check("cmd-primary-set-ok", cmdResult(m4.sign(cmdBody("c-set-0001", action: "set:active:1080"))) == "ok" && cmdResult(m4.sign(cmdBody("c-set-0003", action: "set:watch:10"))) == "ok")
check("cmd-phone-set-refused", cmdResult(phone.sign(cmdBody("c-set-0002", from: phone, action: "set:active:1080"))) == "Not signed by your primary")
check("cmd-set-format", ["set:active:9", "set:active:4321", "set:boom:600", "set:active:0600", "set:active:1:2", "set:active:", "set::600", "SET:active:600", "set:active:+600", "set:active:10000"]
  .enumerated().allSatisfy { i, a in cmdResult(m4.sign(cmdBody("c-setb-\(i)", action: a))) == "Unknown command" })
// PS 1.69: sentry starts Sentry mode on this Mac, from the main Mac only (never the phone or another secondary), no arguments.
check("cmd-primary-sentry-ok", cmdResult(m4.sign(cmdBody("c-sen-0001", action: "sentry"))) == "ok")
check("cmd-phone-sentry-refused", cmdResult(phone.sign(cmdBody("c-sen-0002", from: phone, action: "sentry"))) == "Not signed by your primary")
check("cmd-sentry-no-arguments", cmdResult(m4.sign(cmdBody("c-sen-0003", action: "sentry", extra: ["plan": "x"]))) == "Bad arguments")
check("cmd-set-parsed", SecondIdentity.autoRebootSet("set:watch:4320").map { $0.mode == "watch" && $0.minutes == 4320 } == true && SecondIdentity.autoRebootSet("set:watch:7.5") == nil)
func phoneOpen(_ t: String, _ extra: [String: Any]) -> String {
  var b: [String: Any] = ["v": 1, "t": t, "id": "p-\(t)-0001", "from": phone.device, "to": m1.device, "at": nowMs]
  for (k, v) in extra { b[k] = v }
  guard let e = phone.sign(b) else { return "no env" }
  if case .failure(let r) = m1.open(e, expect: [t]) { return r.why }
  return "ok"
}
check("phone-job-refused", phoneOpen("job", ["exp": nowMs + 86_400_000, "type": "probe", "args": ["probe": "echo"]]) == "Not signed by your primary")
check("phone-file-refused", phoneOpen("file", ["name": "x", "size": 1, "sha256": "", "purpose": "user", "chunk": 1, "n": 1]) == "Not signed by your primary")
check("phone-get-refused", phoneOpen("get", ["root": "ps-shared", "path": "a.txt", "as": "download"]) == "Not signed by your primary")
check("phone-msg-refused", phoneOpen("msg", ["text": "hi"]) == "Not signed by your primary")
m1.untrust(m4.device)
check("unpaired-refused", opened(m4.sign(jobBody("j-un-0001"))) == "Not signed by your primary")


// ---------- the Keychain after an update (2 Nov 2026: the M1 came up unpaired at 03:44) ----------
// A key, id or pairing list that exists but cannot be read (a Deny, a locked Mac, a new build not allowed yet) must
// never be taken for "never paired": no new key, no empty pairing list written over the real one.
func filesOf(_ d: String) -> [String: Data] { var o: [String: Data] = [:]; for a in SecondKeychain.accounts { o[a] = fm.contents(atPath: d + "/" + a) }; return o }
let kdir = root + "/keys-m1", kstore = SecondFileStore(dir: kdir)
let first = SecondIdentity(store: kstore, seenPath: kdir + "/seen.json")
first.trust(SecondPeer(device: "dev-m4", name: "MacBook Air M4", pub: m4.pub, role: "primary", at: 1))
_ = SecondKeys(store: kstore, secure: false)
let before = filesOf(kdir)
check("keys-first-time-made", first.ready && first.blocked == nil && before["key"] != nil && before["trust"] != nil && before["okeys"] != nil)
kstore.failing = errSecInteractionNotAllowed
let denied = SecondIdentity(store: kstore, seenPath: kdir + "/seen.json")
let deniedKeys = SecondKeys(store: kstore, secure: false)
check("keys-unreadable-blocked-not-new", !denied.ready && denied.blocked == errSecInteractionNotAllowed && denied.device == "" && denied.peers.isEmpty && !deniedKeys.ready && deniedKeys.blocked)
check("keys-unreadable-nothing-written", filesOf(kdir) == before)
kstore.failing = errSecUserCanceled
check("keys-deny-blocked", SecondIdentity(store: kstore, seenPath: kdir + "/seen.json").blocked == errSecUserCanceled && filesOf(kdir) == before)
kstore.failing = nil
let allowed = SecondIdentity(store: kstore, seenPath: kdir + "/seen.json")
check("keys-allowed-same-mac-still-paired", allowed.ready && allowed.device == first.device && allowed.pub == first.pub && allowed.peer("dev-m4")?.pub == m4.pub)
try? fm.removeItem(atPath: kdir + "/device")
let half = SecondIdentity(store: kstore, seenPath: kdir + "/seen.json")
check("keys-half-there-never-replaced", !half.ready && half.blocked != nil && fm.contents(atPath: kdir + "/key") == before["key"])
try? before["device"]!.write(to: URL(fileURLWithPath: kdir + "/device"))
// The hand over: the old build's items, saved as the new build's own; the new build is the same Mac, still paired.
let items = SecondHandoff.collect(kstore)
check("handoff-collects-every-item", Set(items.keys) == Set(["key", "device", "trust", "okeys", "osign"]))
let ndir = root + "/keys-m1-new", nstore = SecondFileStore(dir: ndir)
var withJunk = items; withJunk["../evil"] = "AAAA"; withJunk["trust"] = withJunk["trust"]; withJunk["opeers"] = "not base64 !!"
let saved = SecondHandoff.save(withJunk, into: nstore)
let after = SecondIdentity(store: nstore, seenPath: ndir + "/seen.json"), afterKeys = SecondKeys(store: nstore, secure: false), firstKeys = SecondKeys(store: kstore, secure: false)
check("handoff-saved", saved == 5 && !fm.fileExists(atPath: root + "/evil") && !fm.fileExists(atPath: ndir + "/opeers"))
check("handoff-same-mac-still-paired", after.ready && after.device == first.device && after.pub == first.pub && after.peer("dev-m4")?.pub == m4.pub)
check("handoff-same-outsourcing-keys", afterKeys.pub == firstKeys.pub && afterKeys.pub != nil)
check("handoff-nothing-from-an-empty-store", SecondHandoff.collect(SecondFileStore(dir: root + "/keys-empty")).isEmpty)

// ---------- V1.44: Second Computer's Keychain is the developer's only, and one item asks once (a FAKE Keychain, never the real one) ----------
// The developer: the macOS "PS wants to access key ... enter the login keychain password" screen "is confusing people".
final class FakeRaw: SecondRaw {
  var items: [String: Data] = [:]
  var older: Set<String> = []      // saved by an older build: a quiet read fails, a read after Allow asks once
  var deny = false                 // The developer closes macOS's question with Deny
  var asks = 0, touches = 0
  func get(_ a: String, ask: Bool) -> (Data?, OSStatus) {
    touches += 1
    guard let d = items[a] else { return (nil, errSecItemNotFound) }
    guard older.contains(a) else { return (d, errSecSuccess) }
    if !ask { return (nil, errSecInteractionNotAllowed) }
    asks += 1
    return deny ? (nil, errSecUserCanceled) : (d, errSecSuccess)
  }
  func put(_ a: String, _ d: Data) -> Bool { touches += 1; if older.contains(a) { return false }; items[a] = d; return true }
  func replace(_ a: String, _ d: Data) -> Bool { touches += 1; older.remove(a); items[a] = d; return true }
}
func kc(_ raw: FakeRaw, ui: Bool = false) -> SecondKeychain { let k = SecondKeychain(raw: raw); k.allowUI = ui; return k }
let kseen = root + "/kc-seen.json"

// Not the developer's PS (the public build): nothing is read, written or kcHanded over, ever. The gate is closed by default.
SecondKeychain.gate = { false }
let kcPubRaw = FakeRaw(); kcPubRaw.items = ["key": Data([1]), "device": Data("d".utf8), "all": Data("{}".utf8)]
let kcPubK = kc(kcPubRaw), kcPubId = SecondIdentity(store: kcPubK, seenPath: kseen), kcPubKeys = SecondKeys(store: kcPubK, secure: false)
check("public-never-reads-second-items", kcPubRaw.touches == 0 && !kcPubId.ready && !kcPubKeys.ready)
check("public-never-writes-second-items", !kcPubK.write("trust", Data([9])) && kcPubK.takeOver(["key": Data([2])]) == 0 && kcPubK.reownAllowed() == (0, 0) && kcPubRaw.touches == 0 && kcPubRaw.items["key"] == Data([1]))
check("public-hands-nothing-over", SecondHandoff.collect(kcPubK).isEmpty && SecondHandoff.save(["key": Data([3]).base64EncodedString()], into: kcPubK) == 0 && kcPubRaw.touches == 0)
let kcPubAsk = kc(kcPubRaw, ui: true); _ = kcPubAsk.read("key")
check("public-allow-never-asks", kcPubRaw.asks == 0 && kcPubRaw.touches == 0)

SecondKeychain.gate = { true }   // The developer's PS from here on
// A Mac whose items a build before V1.44 saved one by one: read once each, quietly, then kept as ONE item.
let kcR1 = FakeRaw()
let kcMade = SecondIdentity(store: kc(kcR1), seenPath: kseen)
kcMade.trust(SecondPeer(device: "dev-m4", name: "MacBook Air M4", pub: m4.pub, role: "primary", at: 1))
_ = SecondKeys(store: kc(kcR1), secure: false)
check("bundle-made-on-first-save", kcMade.ready && kcR1.items["all"] != nil && kcR1.items["key"] != nil && kcR1.items["trust"] != nil)
let kcLegacy = FakeRaw(); kcLegacy.items = kcR1.items; kcLegacy.items["all"] = nil
let kcLk = kc(kcLegacy), kcLid = SecondIdentity(store: kcLk, seenPath: kseen), kcLkeys = SecondKeys(store: kcLk, secure: false)
check("legacy-items-read-once-each", kcLid.ready && kcLid.device == kcMade.device && kcLid.peer("dev-m4") != nil && kcLkeys.ready && kcLk.source == "items" && kcLegacy.asks == 0)
check("legacy-moved-into-one-item", kcLegacy.items["all"] != nil && SecondKeychain.decode(kcLegacy.items["all"]!)?["key"] == kcR1.items["key"])
kcLegacy.touches = 0
let kcLk2 = kc(kcLegacy); _ = SecondIdentity(store: kcLk2, seenPath: kseen); _ = SecondKeys(store: kcLk2, secure: false)
check("one-keychain-read-per-launch", kcLegacy.touches == 1 && kcLk2.source == "all")

// After an update whose hand over failed: the one item was saved by the older build. Quietly: off, nothing new, nothing
// written, no question. After the developer's Allow: macOS asks ONCE for all six (it used to be once per item), still paired.
let kcUpd = FakeRaw(); kcUpd.items = kcR1.items; kcUpd.older = ["all", "key", "device", "trust", "okeys", "osign", "opeers"]
let kcQuietK = kc(kcUpd), kcQid = SecondIdentity(store: kcQuietK, seenPath: kseen), kcQkeys = SecondKeys(store: kcQuietK, secure: false)
check("older-item-quiet-read-blocked", !kcQid.ready && kcQid.blocked == errSecInteractionNotAllowed && kcQkeys.blocked && kcUpd.asks == 0)
check("older-item-nothing-written", kcUpd.items == kcR1.items && !kcQuietK.write("trust", Data("[]".utf8)))
kcUpd.deny = true
let kcDeniedK = kc(kcUpd, ui: true), kcDid = SecondIdentity(store: kcDeniedK, seenPath: kseen)
check("deny-stays-paired-and-retries", !kcDid.ready && kcDid.blocked == errSecUserCanceled && kcUpd.items == kcR1.items && kcDeniedK.reownAllowed() == (0, 0) && kcUpd.asks == 1)
kcUpd.deny = false; kcUpd.asks = 0
let kcAskK = kc(kcUpd, ui: true), kcAid = SecondIdentity(store: kcAskK, seenPath: kseen), kcAkeys = SecondKeys(store: kcAskK, secure: false)
check("allow-asks-once-for-all-six", kcAid.ready && kcAkeys.ready && kcUpd.asks == 1 && kcAid.device == kcMade.device && kcAid.peer("dev-m4") != nil)
let (kcMoved, kcTried) = kcAskK.reownAllowed()
check("allow-saves-as-this-build", kcMoved == kcTried && kcMoved >= 5 && !kcUpd.older.contains("all") && !kcUpd.older.contains("key"))
kcUpd.asks = 0
let kcNext = kc(kcUpd), kcNid = SecondIdentity(store: kcNext, seenPath: kseen)
check("next-launch-never-asks", kcNid.ready && kcNid.device == kcMade.device && kcUpd.asks == 0)

// The hand over: the previous build's items become this build's ONE item (and the one by one copies), never asking.
let kcFresh = FakeRaw(); kcFresh.items = ["all": Data("{}".utf8), "key": Data([7])]; kcFresh.older = ["all", "key"]
let kcHanded = SecondHandoff.save(SecondHandoff.collect(kc(kcR1)), into: kc(kcFresh))
let kcHid = SecondIdentity(store: kc(kcFresh), seenPath: kseen)
check("handoff-one-item-no-question", kcHanded >= 5 && kcFresh.asks == 0 && kcFresh.older.isEmpty && kcHid.ready && kcHid.device == kcMade.device && kcHid.peer("dev-m4") != nil)
// Writes keep the one item and the one by one copy in step (a roll back to a build before V1.44 stays paired).
let kcWk = kc(kcFresh)
check("write-updates-both", kcWk.write("trust", Data("[]".utf8)) && SecondKeychain.decode(kcFresh.items["all"]!)?["trust"] == Data("[]".utf8) && kcFresh.items["trust"] == Data("[]".utf8))
check("bundle-refuses-junk", SecondKeychain.decode(Data(#"{"key":"!!"}"#.utf8)) == nil && SecondKeychain.encode(["../x": Data([1]), "key": Data([2])]) == Data(#"{"key":"Ag=="}"#.utf8))

try? fm.removeItem(atPath: root)
print(fails == 0 ? "SECOND RUNNER: 0 FAIL" : "SECOND RUNNER: \(fails) FAIL")
exit(fails == 0 ? 0 : 1)
