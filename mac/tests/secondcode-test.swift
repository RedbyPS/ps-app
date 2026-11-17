// Unit tests for Second Computer code jobs (see secondcode-test.sh). Fake CLI, temp git repo, temp PS folder.
import Foundation

var fails = 0, checks = 0
func check(_ ok: Bool, _ what: String, line: Int = #line) { checks += 1; if !ok { fails += 1; print("FAIL (line \(line)): \(what)") } }
func sh(_ cmd: String, cwd: String? = nil) -> (Int32, String) {
  let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh"); p.arguments = ["-c", cmd]
  if let c = cwd { p.currentDirectoryURL = URL(fileURLWithPath: c) }
  let pipe = Pipe(); p.standardOutput = pipe; p.standardError = pipe
  try! p.run(); let d = pipe.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
  return (p.terminationStatus, (String(data: d, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines))
}
let fm = FileManager.default
let tmp = (NSTemporaryDirectory() as NSString).resolvingSymlinksInPath + "/ps-secondcode-test-\(getpid())"
try? fm.removeItem(atPath: tmp)
try! fm.createDirectory(atPath: tmp, withIntermediateDirectories: true)
defer { try? fm.removeItem(atPath: tmp) }
let home = tmp + "/home", root = tmp + "/ps/outsource", srcDir = root + "/sources"
try! fm.createDirectory(atPath: home, withIntermediateDirectories: true)
try! fm.createDirectory(atPath: srcDir, withIntermediateDirectories: true)

// ---- the pure rules: the sealed body's "code" kind
func jobDict(_ over: [String: Any] = [:]) -> [String: Any] {
  var d: [String: Any] = ["kind": "code", "id": "job-0001", "title": "Fix the thing", "repo": "demo", "base": "main", "prompt": "Do the work", "tool": "claude", "minutes": 5]
  for (k, v) in over { d[k] = v }
  return d
}
func parse(_ d: [String: Any]) -> (SecondCodeJob?, String?) { var b = d; let id = b.removeValue(forKey: "id") as? String ?? ""; return SecondCodeJob.check(b, id: id) }
check(parse(jobDict()).0 != nil, "a good job parses")
check(parse(jobDict()).0?.minutes == 5 && parse(jobDict(["minutes": NSNull()].filter { _ in false })).0?.shots == false, "minutes and shots read")
var noMin = jobDict(); noMin.removeValue(forKey: "minutes")
check(parse(noMin).0?.minutes == 30, "30 minutes when none is given")
check(parse(jobDict(["id": "../x"])).1 == "Bad arguments", "a path as id refused")
check(parse(jobDict(["tool": "bash"])).1 == "Bad arguments", "an unknown tool refused")
check(parse(jobDict(["minutes": 9999])).1 == "Bad arguments" && parse(jobDict(["minutes": 4])).1 == "Bad arguments" && parse(jobDict(["minutes": 240])).0 != nil, "minutes 5 to 240")
check(parse(jobDict(["minutes": true])).1 == "Bad arguments" && parse(jobDict(["minutes": 7.5])).1 == "Bad arguments", "minutes a whole number, not a switch")
check(parse(jobDict(["shots": 1])).1 == "Bad arguments" && parse(jobDict(["shots": true])).0?.shots == true, "shots is a switch")
check(parse(jobDict(["model": "opus"])).0?.model == "opus" && parse(jobDict(["model": "gpt"])).1 == "Bad arguments" && parse(jobDict(["model": "opus", "tool": "codex"])).1 == "Bad arguments", "model: opus or sonnet, Claude only")
check(parse(jobDict(["prompt": "use sk-abcdefghijklmnopqrstuvwx to call"])).1?.contains("secret") == true, "a key in the prompt refused")
check(parse(jobDict(["title": "tok" + "en=" + "abcdefgh12345"])).1?.contains("secret") == true, "a secret in the title refused")
check(parse(jobDict(["prompt": ""])).1 == "Bad arguments" && parse(jobDict(["prompt": String(repeating: "x", count: 20_001)])).1 == "Bad arguments", "empty or huge prompt refused")
check(parse(jobDict(["cmd": "rm -rf /"])).1 == "Bad arguments" && parse(jobDict(["env": "X=1"])).1 == "Bad arguments", "an unknown key is refused (no cmd, no env)")
check(parse(jobDict(["kind": "research"])).1 == "Bad arguments", "only the code kind here")
check(parse(jobDict(["repo": "https://u:p@example.com/a.git"])).1?.contains("password") == true, "a repo link with a password refused")
for bad in ["https://user:pw@example.com/a.git", "https://x@example.com/a.git", "file:///tmp/x", "ext::sh -c id", "/etc", "../x", "a b", "-oProxy=x", "git@host:a@b", "http://example.com/a.git", "..", ".hidden"] {
  check(!OutSafe.repoOk(bad), "repo refused: \(bad)")
}
for good in ["demo", "my-app.v2", "https://example.com/team/app.git", "git@example.com:team/app.git", "ssh://git@example.com/team/app.git"] {
  check(OutSafe.repoOk(good), "repo ok: \(good)")
}
check(!OutSafe.baseOk("--upload-pack=x") && !OutSafe.baseOk("a..b") && OutSafe.baseOk("main") && OutSafe.baseOk("feature/x-1") && OutSafe.baseOk("abc1234"), "base rules")
check(OutSafe.cloneName("https://example.com/a/app.git") != OutSafe.cloneName("https://example.org/b/app.git"), "two repos with one last name stay apart")

// Secrets
let secrets = ["sk-abcdefghijklmnopqrstuvwx", "ghp_abcdefghijklmnopqrstuvwxyz0123", "github_pat_abcdefghijklmnopqrstu", "AKIAABCDEFGHIJKLMNOP",
               "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdef123456", "Authorization: Bearer abcdefghijklmnop1234", "API_KEY=supersecretvalue1",
               "password: hunter2hunter2", "https://bob:pw1234@example.com/x", "-----BEGIN PRIVATE KEY-----\nabcdef\n-----END PRIVATE KEY-----", "sb_" + "secret_" + "abcdefgh12345"]
for s in secrets {
  check(OutSecrets.looksSecret(s), "detected: \(s.prefix(14))")
  check(OutSecrets.strip("before " + s + " after", home: home).contains("[removed]"), "stripped: \(s.prefix(14))")
}
check(!OutSecrets.looksSecret("Please fix the login page and run npm test"), "plain text is not a secret")
check(OutSecrets.strip("ls \(home)/work", home: home) == "ls ~/work", "home folder name hidden")
check(OutSecrets.tail(String(repeating: "line\n", count: 5000), 100).count <= 100, "tail is short")

// Policy
let allFlags = Set(OutPolicy.flagNames)
let ca = OutPolicy.claudeArgs(flags: allFlags, model: "sonnet")!
check(ca.contains("--disallowedTools") && ca.contains("Bash(git push:*)") && ca.contains("Bash(gh:*)") && ca.contains("WebSearch"), "claude deny flags")
check(ca.contains("--strict-mcp-config") && ca.contains("--safe-mode") && ca.contains("--settings") && !ca.contains("--setting-sources"), "no MCP servers, safe mode, our settings")
check(ca.contains("--model") && ca[ca.firstIndex(of: "--model")! + 1] == "sonnet", "the model asked for")
check(OutPolicy.claudeArgs(flags: allFlags.subtracting(["--safe-mode"]), model: nil)?.contains("--setting-sources") == true, "no safe mode: none of the person's own settings instead")
check(OutPolicy.claudeArgs(flags: allFlags.subtracting(["--strict-mcp-config"]), model: nil) == nil, "a Claude Code without --strict-mcp-config is not used")
let cs = (try? JSONSerialization.jsonObject(with: Data(OutPolicy.claudeSettings().utf8))) as? [String: Any] ?? [:]
let sbx = cs["sandbox"] as? [String: Any] ?? [:]
check(sbx["enabled"] as? Bool == true && sbx["allowUnsandboxedCommands"] as? Bool == false, "claude runs its commands in its sandbox, no way out")
check(cs["disableAllHooks"] as? Bool == true, "no hooks run")
let deny = (cs["permissions"] as? [String: Any])?["deny"] as? [String] ?? []
check(deny.contains("Read(~/.ssh/**)") && deny.contains("Bash(git push:*)") && deny.contains("Bash(curl:*)"), "deny rules in the settings too")
check(!ca.contains("--dangerously-skip-permissions") && !ca.contains("bypassPermissions"), "never skips permissions")
check(ca.first == "-p" && !ca.contains("Do the work"), "claude headless, the prompt on stdin (never on the command line)")
let xa = OutPolicy.codexArgs(prompt: "P", dir: "/d", lastMessage: "/m")
check(xa.contains("workspace-write") && !xa.contains("danger-full-access") && !xa.contains("--dangerously-bypass-approvals-and-sandbox"), "codex stays in the workspace sandbox")
check(xa.contains("sandbox_workspace_write.network_access=false") && xa.contains("mcp_servers={}"), "codex: network off, no MCP servers")
let env = OutPolicy.env(base: ["PATH": "/usr/bin", "GH_TOKEN": "x", "GITHUB_TOKEN": "y", "SSH_AUTH_SOCK": "z", "GIT_DIR": "/q", "FOO": "bar"], shimDir: "/s", hooksDir: "/h", home: "/home/x")
check(env["GH_TOKEN"] == nil && env["GITHUB_TOKEN"] == nil && env["SSH_AUTH_SOCK"] == nil && env["GIT_DIR"] == nil && env["FOO"] == "bar", "tokens dropped from the env")
check(env["PATH"]!.hasPrefix("/s:"), "stand ins first on PATH")
check(env["GIT_ALLOW_PROTOCOL"] == "ps-none" && env["GIT_CONFIG_NOSYSTEM"] == "1" && env["GIT_CONFIG_GLOBAL"] == "/dev/null" && env["GIT_SSH_COMMAND"] == "/s/ssh", "git: no transport, no saved passwords, ssh refused")
check(OutPolicy.env(base: ["MY_SERVICE_TOKEN": "x", "DB_PASSWORD": "y", "PATH": "/b"], shimDir: "/s", hooksDir: "/h", home: "/x")["MY_SERVICE_TOKEN"] == nil, "any *_TOKEN or *_PASSWORD dropped")

// The sealed bundle's file format and the fetch line
let packed = SecondCodeBundle.pack(suite: "p256", kid: "k1", enc: Data([1, 2, 3]), ct: Data([9, 8, 7, 0x0A, 6]))
let un = SecondCodeBundle.unpack(packed)
check(un?.suite == "p256" && un?.kid == "k1" && un?.enc == Data([1, 2, 3]) && un?.ct == Data([9, 8, 7, 0x0A, 6]), "bundle file packs and unpacks (a newline inside the sealed bytes is fine)")
check(SecondCodeBundle.unpack(Data("PACK\n".utf8)) == nil && SecondCodeBundle.unpack(Data("PSCODE1 rot13 k1 AQID\nx".utf8)) == nil, "not ours: refused")
check(SecondCodeBundle.aad(job: "a", file: "b") != SecondCodeBundle.aad(job: "a", file: "c"), "the seal is tied to its file id")
check(SecondCodeBundle.fetchLine(bundle: "/x/it's here/result.bundle", branch: "outsource/job-1", job: "job-1234567") == "git fetch '/x/it'\\''s here/result.bundle' outsource/job-1:review/job-1234", "fetch line quotes the path")
let rep = SecondCodeReport(state: "done", tool: "claude", repo: "demo", branch: "outsource/j", base: "b", head: "h", commits: 2, files: ["a.txt | 2 +-"], summary: "Fixed it", log: "", exit: 0, seconds: 9, note: "")
check(rep.markdown(title: "T").contains("Commits: 2") && rep.markdown(title: "T").contains("Fixed it") && (rep.json["commits"] as? Int) == 2, "report text and fields")

// ---- fake CLI and temp repo
let fake = tmp + "/bin/claude"
try! fm.createDirectory(atPath: tmp + "/bin", withIntermediateDirectories: true)
let fakeScript = #"""
#!/bin/sh
# Stands in for claude and codex. Mode comes from words in the prompt.
case "$1" in --help) echo "Usage: --allowedTools --disallowedTools --strict-mcp-config --safe-mode --settings --permission-mode --output-format --model"; exit 0;; esac
prompt=""
for a in "$@"; do prompt="$a"; done
case "$1" in -p) prompt="$(cat)";; esac
echo "$@" > .ps-outsource/args.txt
case "$prompt" in
  *SLEEP*) sleep 127; exit 0;;
  *PUSH*)
    git push origin HEAD:refs/heads/pushed > push-result.txt 2>&1; echo "push exit $?" >> push-result.txt
    gh pr create > gh-result.txt 2>&1; echo "gh exit $?" >> gh-result.txt
    echo "tok=$GH_TOKEN$GITHUB_TOKEN" > env-result.txt
    git push --no-verify origin HEAD:refs/heads/pushed2 > push2-result.txt 2>&1; echo "push2 exit $?" >> push2-result.txt
    git push --no-verify "$(cat "$HOME/src-path")" HEAD:refs/heads/pushed3 > push3-result.txt 2>&1; echo "push3 exit $?" >> push3-result.txt
    env -u GIT_CONFIG_COUNT git -c core.hooksPath=/dev/null push --no-verify "$(cat "$HOME/src-path")" HEAD:refs/heads/pushed4 > push4-result.txt 2>&1; echo "push4 exit $?" >> push4-result.txt
    ;;
  *FAIL*) echo "boom"; exit 3;;
  *SHOT*) printf '\211PNG\r\n\032\nDATA' > .ps-outsource/shots/a.png; printf 'not a png' > .ps-outsource/shots/b.png;;
esac
echo "changed" > work.txt
git add work.txt && git commit -q -m "Add work"
echo "Done. Used key sk-abcdefghijklmnopqrstuvwx and tests passed. Home is $HOME"
"""#
try! fakeScript.write(toFile: fake, atomically: true, encoding: .utf8); chmod(fake, 0o755)
let fakeCodex = tmp + "/bin/codex"
try! fm.copyItem(atPath: fake, toPath: fakeCodex)

let src = srcDir + "/demo"
try! fm.createDirectory(atPath: src, withIntermediateDirectories: true)
_ = sh("git init -q -b main . && git config user.email t@localhost && git config user.name t && echo one > a.txt && git add a.txt && git commit -q -m first && echo two >> a.txt && git commit -qam second", cwd: src)
let baseSha = sh("git rev-parse HEAD", cwd: src).1
try! src.write(toFile: home + "/src-path", atomically: true, encoding: .utf8)
let branchesBefore = sh("git branch -a", cwd: src).1

var benv = ProcessInfo.processInfo.environment
benv["HOME"] = home; benv["GH_TOKEN"] = "tok-should-not-leak"; benv["GITHUB_TOKEN"] = "tok2"
let tools = OutTools(claude: fake, codex: fakeCodex, git: "/usr/bin/git")
check(OutTools.find(home: home, override: ["claude": "/nope", "codex": "/nope"]).claude == nil, "missing tools not offered")
let runner = SecondCodeRunner(root: root, home: home, tools: tools, searchDirs: [srcDir], mirrors: tmp + "/mirrors", baseEnv: benv)

func runJob(_ over: [String: Any], wait: TimeInterval = 60) -> (SecondCodeDone?, [String]) {
  let pj = parse(jobDict(over))
  guard let job = pj.0 else { check(false, "job parses: \(pj.1 ?? "")"); return (nil, []) }
  let sem = DispatchSemaphore(value: 0)
  var res: SecondCodeDone?; var steps: [String] = []
  let lock = NSLock()
  let ok = runner.submit(job, progress: { s, t in lock.lock(); steps.append(s + ":" + t); lock.unlock() }, done: { res = $0; sem.signal() })
  if !ok { return (nil, ["refused"]) }
  _ = sem.wait(timeout: .now() + wait)
  return (res, steps)
}

// 1. A normal run
let (r1, steps1) = runJob(["id": "job-run1", "base": baseSha, "prompt": "Add work"])
check(r1?.state == "done", "run finishes done: \(r1?.state ?? "nil") \(r1?.report.note ?? "")")
check(r1?.report.commits == 1, "one commit counted")
check(r1?.report.branch == "outsource/job-run1" && r1?.report.base == baseSha, "branch and base")
check(r1?.report.files.contains(where: { $0.contains("work.txt") }) == true, "changed files listed")
check(steps1.first == "queued:" && steps1.contains(where: { $0.hasPrefix("running:") }), "progress steps")
check(r1?.report.summary.contains("tests passed") == true, "the AI's own summary kept")
check(r1?.report.summary.contains("sk-abc") == false && r1?.report.log.contains("sk-abc") == false, "secret stripped from summary and log")
check(r1?.report.summary.contains(home) == false, "home path hidden")
// the bundle
if let b = r1?.bundlePath {
  check(sh("git bundle verify \(b)", cwd: tmp).0 == 0 || sh("git -C \(src) bundle verify \(b)").0 == 0, "bundle verifies")
  let (c, o) = sh("git -C \(src) bundle list-heads \(b)")
  check(c == 0 && o.contains("refs/heads/outsource/job-run1"), "bundle holds the branch")
  check(r1?.bundleSize == ((try? fm.attributesOfItem(atPath: b))?[.size] as? Int) && r1?.bundleSha?.count == 64, "bundle size and sha")
  // Fetch it into a throwaway clone: the new commit arrives, the source repo stays untouched.
  _ = sh("git clone -q \(src) \(tmp)/review")
  let (fc, _) = sh("git fetch -q \(b) outsource/job-run1:review/x", cwd: tmp + "/review")
  check(fc == 0 && sh("git log -1 --format=%s review/x", cwd: tmp + "/review").1 == "Add work", "bundle fetches into a review branch")
} else { check(false, "bundle made") }
check(sh("git branch -a", cwd: src).1 == branchesBefore, "the person's own repo is untouched")
check(!fm.fileExists(atPath: root + "/jobs/job-run1/work"), "working folder cleaned up")
let (rDup, _) = runJob(["id": "job-run1", "base": baseSha, "prompt": "Add work"])
check(rDup?.state == "failed" && rDup?.report.note.contains("already ran") == true, "the same job id never runs twice here")
check(sh("git config core.hooksPath", cwd: root + "/repos/demo").1 == root + "/hooks", "hooks path points at the refusing hook")

// 2. Push refusal (hook, no-verify, push URL, gh stand in, token drop)
let (r2, _) = runJob(["id": "job-push", "base": baseSha, "prompt": "PUSH please"])
check(r2?.state == "done", "push job still ends")
let pdir = root + "/repos/demo"
let pushed = sh("git ls-remote --heads \(src)").1
check(!pushed.contains("pushed"), "nothing was pushed to the source, not even straight to its folder: \(pushed)")
check(sh("git for-each-ref refs/heads/pushed refs/heads/pushed2", cwd: pdir).1.isEmpty, "no pushed ref in the clone")
let jobDirPush = root + "/jobs/job-push"
check(r2?.report.log.contains("sk-") == false, "no secret in push log")
// The fake wrote its own files into .ps-outsource (excluded); read them from the report log via a rerun with a visible file.
let hookOut = sh("cd \(pdir) && git -c core.hooksPath=\(root)/hooks push --dry-run origin HEAD:refs/heads/zzz 2>&1; echo exit $?").1
check(hookOut.contains("refused") || hookOut.contains("exit 1") || hookOut.contains("exit 128"), "a direct push in the clone fails: \(hookOut.prefix(80))")
check(sh("\(root)/shims/gh pr create 2>&1; echo $?").1.contains("refused") , "gh stand in refuses")
check(sh("cat \(root)/hooks/pre-push").1.contains("exit 1"), "pre-push hook always fails")
check((try? fm.attributesOfItem(atPath: root + "/hooks/pre-push"))?[.posixPermissions] as? Int == 0o755, "hook is executable")
_ = jobDirPush
if let b = r2?.bundlePath {
  _ = sh("git clone -q \(src) \(tmp)/review3"); _ = sh("git fetch -q \(b) outsource/job-push:review/p", cwd: tmp + "/review3")
  func show(_ f: String) -> String { sh("git show review/p:\(f)", cwd: tmp + "/review3").1 }
  check(show("push-result.txt").contains("refused") && !show("push-result.txt").contains("push exit 0"), "the AI's git push was refused: \(show("push-result.txt").prefix(90))")
  check(!show("push2-result.txt").contains("push2 exit 0"), "git push --no-verify still goes nowhere: \(show("push2-result.txt").prefix(90))")
  check(!show("push3-result.txt").contains("push3 exit 0") && !show("push4-result.txt").contains("push4 exit 0"), "a push straight to a folder, hooks off, is refused too: \(show("push4-result.txt").prefix(90))")
  check(show("gh-result.txt").contains("gh exit 126") && show("gh-result.txt").contains("refused"), "gh refused for the AI")
  check(show("env-result.txt") == "tok=", "tokens not in the AI's env")
} else { check(false, "push job bundle") }

// 3. The tool gets the deny flags and the env without tokens: use a job whose fake writes args to a committed file.
let argScript = tmp + "/bin/claude2"
try! (fakeScript + "\n").write(toFile: argScript, atomically: true, encoding: .utf8)
let spy = #"""
#!/bin/sh
case "$1" in --help) echo "--allowedTools --disallowedTools --strict-mcp-config --safe-mode --settings"; exit 0;; esac
cat > spy-stdin.txt
cp .ps-outsource/args.txt /dev/null 2>/dev/null
echo "$@" > spy-args.txt
echo "GH=${GH_TOKEN:-none} GITHUB=${GITHUB_TOKEN:-none} PATHFIRST=$(echo $PATH | cut -d: -f1)" > spy-env.txt
git add -A && git commit -q -m spy
echo ok
"""#
let spyPath = tmp + "/bin/claude-spy"
try! spy.write(toFile: spyPath, atomically: true, encoding: .utf8); chmod(spyPath, 0o755)
runner.tools = OutTools(claude: spyPath, codex: fakeCodex, git: "/usr/bin/git")
let (r3, _) = runJob(["id": "job-spy1", "base": baseSha, "prompt": "inspect"])
check(r3?.state == "done", "spy run done")
if let b = r3?.bundlePath {
  _ = sh("git clone -q \(src) \(tmp)/review2"); _ = sh("git fetch -q \(b) outsource/job-spy1:review/y", cwd: tmp + "/review2")
  let args = sh("git show review/y:spy-args.txt", cwd: tmp + "/review2").1
  let e = sh("git show review/y:spy-env.txt", cwd: tmp + "/review2").1
  check(args.contains("--disallowedTools") && args.contains("Bash(git push:*)") && args.contains("--permission-mode acceptEdits"), "tool ran with the deny flags")
  check(args.contains("--strict-mcp-config") && args.contains("--safe-mode") && args.contains("--settings"), "tool ran with --strict-mcp-config and --safe-mode")
  let stdin = sh("git show review/y:spy-stdin.txt", cwd: tmp + "/review2").1
  check(stdin.contains("inspect") && stdin.contains("never push") && !args.contains("inspect"), "the prompt came on stdin with the house rules, not on the command line")
  check(e.contains("GH=none") && e.contains("GITHUB=none"), "tokens not in the AI's env: \(e)")
  check(e.contains(root + "/shims") || e.contains("PATHFIRST=\(root)/shims"), "stand in directory first on PATH: \(e)")
} else { check(false, "spy bundle") }
runner.tools = tools

// 4. Codex
let (r4, _) = runJob(["id": "job-cdx1", "base": baseSha, "tool": "codex", "prompt": "Add work"])
check(r4?.state == "done" && r4?.report.tool == "codex", "codex run")

// 5. Failure, no changes
let (r5, _) = runJob(["id": "job-fail", "base": baseSha, "prompt": "FAIL"])
check(r5?.state == "failed" && r5?.bundlePath == nil && r5?.report.commits == 0, "a failing tool: failed, no bundle")
check(r5?.report.log.contains("boom") == true, "log kept")

// 6. Refusals before running
let (r6, _) = runJob(["id": "job-nobase", "base": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "prompt": "x"])
check(r6?.state == "failed" && r6?.report.note.contains("base commit") == true, "unknown base refused")
let (r7, _) = runJob(["id": "job-norepo", "repo": "no-such-folder", "base": baseSha, "prompt": "x"])
check(r7?.state == "failed" && r7?.report.note.contains("no folder") == true, "unknown folder refused")

// 7. Screenshots
let (r8, _) = runJob(["id": "job-shot", "base": baseSha, "prompt": "SHOT", "shots": true])
check(r8?.shots.count == 1 && r8?.shots.first?.0 == "a.png", "a real PNG handed back, a file that only says .png is not")

// 8. Timeout kills the whole tree, quickly (a "minute" is 0.4 seconds here)
runner.secondsPerMinute = 0.4
let t0 = Date()
let (r9, _) = runJob(["id": "job-slow", "base": baseSha, "prompt": "SLEEP", "minutes": 5], wait: 40)
check(r9?.state == "timeout", "timeout state: \(r9?.state ?? "nil")")
check(Date().timeIntervalSince(t0) < 15, "timeout ends fast")
usleep(500_000)
check(sh("pgrep -fx 'sleep 127'").1.isEmpty, "the child tree is gone after a timeout")
check(r9?.report.note.contains("Stopped after") == true, "timeout note")

// 9. Cancel from the main computer, and the queue
runner.secondsPerMinute = 60
let cancelJob = parse(jobDict(["id": "job-cancel", "base": baseSha, "prompt": "SLEEP", "minutes": 5])).0!
let semC = DispatchSemaphore(value: 0)
var rc: SecondCodeDone?; var order: [String] = []; let ol = NSLock()
_ = runner.submit(cancelJob, progress: { s, t in ol.lock(); order.append("c:" + s); ol.unlock() }, done: { rc = $0; semC.signal() })
let nextJob = parse(jobDict(["id": "job-next1", "base": baseSha, "prompt": "Add work"])).0!
let semN = DispatchSemaphore(value: 0)
var rn: SecondCodeDone?
_ = runner.submit(nextJob, progress: { s, t in ol.lock(); order.append("n:" + s); ol.unlock() }, done: { rn = $0; semN.signal() })
check(runner.queueLength >= 1 || runner.busy, "second job waits behind the first")
usleep(2_500_000)
let tc = Date()
runner.cancel("job-cancel")
_ = semC.wait(timeout: .now() + 20)
check(rc?.state == "cancelled", "cancel: \(rc?.state ?? "nil") \(rc?.report.note ?? "")")
check(Date().timeIntervalSince(tc) < 10, "cancel ends fast")
usleep(500_000)
check(sh("pgrep -fx 'sleep 127'").1.isEmpty, "the child tree is gone after a cancel")
_ = semN.wait(timeout: .now() + 60)
check(rn?.state == "done", "the next job runs after the cancel")
ol.lock()
let firstNRun = order.firstIndex(of: "n:running"), cDoneIdx = order.lastIndex(where: { $0.hasPrefix("c:") })
ol.unlock()
check(firstNRun != nil && cDoneIdx != nil && firstNRun! > cDoneIdx!, "one job at a time")
// A queued job cancelled before it starts
let q1 = parse(jobDict(["id": "job-q001", "base": baseSha, "prompt": "SLEEP", "minutes": 5])).0!
let q2 = parse(jobDict(["id": "job-q002", "base": baseSha, "prompt": "Add work"])).0!
let sq1 = DispatchSemaphore(value: 0), sq2 = DispatchSemaphore(value: 0)
var rq2: SecondCodeDone?
_ = runner.submit(q1, progress: { _, _ in }, done: { _ in sq1.signal() })
_ = runner.submit(q2, progress: { _, _ in }, done: { rq2 = $0; sq2.signal() })
runner.cancel("job-q002"); usleep(1_500_000); runner.cancel("job-q001")
_ = sq1.wait(timeout: .now() + 20); _ = sq2.wait(timeout: .now() + 20)
check(rq2?.state == "cancelled", "a queued job cancelled before it starts")
// Queue limit
var accepted = 0
var sems: [DispatchSemaphore] = []
for i in 0..<8 {
  let j = parse(jobDict(["id": "job-lim\(i)x", "base": baseSha, "prompt": "SLEEP", "minutes": 5])).0!
  let s = DispatchSemaphore(value: 0)
  if runner.submit(j, progress: { _, _ in }, done: { _ in s.signal() }) { accepted += 1; sems.append(s) }
}
check(accepted == SecondCodeRunner.maxQueue, "queue holds \(SecondCodeRunner.maxQueue): \(accepted)")
for i in 0..<8 { runner.cancel("job-lim\(i)x"); usleep(300_000) }
for s in sems { _ = s.wait(timeout: .now() + 30) }

// 10. Old results are pruned
let oldDir = root + "/jobs/job-old1"
try! fm.createDirectory(atPath: oldDir, withIntermediateDirectories: true)
try! fm.setAttributes([.modificationDate: Date().addingTimeInterval(-96 * 3600)], ofItemAtPath: oldDir)
runner.prune()
check(!fm.fileExists(atPath: oldDir), "a three day old result is pruned")

// 11. A commit that touches a secret looking file is not sent back
let secretFake = tmp + "/bin/claude-secret"
try! "#!/bin/sh\n[ \"$1\" = --help ] && echo --allowedTools --disallowedTools --strict-mcp-config --settings && exit 0\necho 'X=1' > .env.local\ngit add -f .env.local && git commit -q -m env\necho done\n".write(toFile: secretFake, atomically: true, encoding: .utf8); chmod(secretFake, 0o755)
runner.tools = OutTools(claude: secretFake, codex: fakeCodex, git: "/usr/bin/git")
let (rs, _) = runJob(["id": "job-secret1", "base": baseSha, "prompt": "x"])
check(rs?.bundlePath == nil && rs?.state == "failed" && rs?.report.note.contains("secrets") == true, "a result with a secret looking file stays here: \(rs?.report.note ?? "")")
runner.tools = tools
let keyFake = tmp + "/bin/claude-key"
try! "#!/bin/sh\n[ \"$1\" = --help ] && echo --allowedTools --disallowedTools --strict-mcp-config --settings && exit 0\necho 'const k = \"ghp_abcdefghijklmnopqrstuvwxyz0123\"' > leak.ts\ngit add leak.ts && git commit -q -m leak\necho done\n".write(toFile: keyFake, atomically: true, encoding: .utf8); chmod(keyFake, 0o755)
runner.tools = OutTools(claude: keyFake, codex: fakeCodex, git: "/usr/bin/git")
let (rk, _) = runJob(["id": "job-keyleak", "base": baseSha, "prompt": "x"])
check(rk?.bundlePath == nil && rk?.state == "failed", "a token written into any file keeps the bundle here: \(rk?.report.note ?? "")")
runner.tools = tools
check(!OutSecrets.looksStrongSecret("password: hunter2hunter2 in a test fixture") && OutSecrets.looksStrongSecret("AKIAABCDEFGHIJKLMNOP"), "the diff check only stops unmistakable keys")
check(OutSecretPaths.isSecret(".env") && OutSecretPaths.isSecret("a/b/id_ed25519") && OutSecretPaths.isSecret("k.pem") && !OutSecretPaths.isSecret("src/environment.ts"), "secret paths")


// 12. A Claude Code too old for the locked down mode is not used
let oldFake = tmp + "/bin/claude-old"
try! "#!/bin/sh\n[ \"$1\" = --help ] && echo --allowedTools && exit 0\necho ran > ran.txt\n".write(toFile: oldFake, atomically: true, encoding: .utf8); chmod(oldFake, 0o755)
runner.tools = OutTools(claude: oldFake, codex: fakeCodex, git: "/usr/bin/git")
let (ro, _) = runJob(["id": "job-old2", "base": baseSha, "prompt": "x"])
check(ro?.state == "failed" && ro?.report.note.contains("too old") == true, "an old Claude Code is refused: \(ro?.report.note ?? "")")
runner.tools = OutTools(claude: nil, codex: fakeCodex, git: "/usr/bin/git")
let (rn2, _) = runJob(["id": "job-noclaude", "base": baseSha, "prompt": "x"])
check(rn2?.state == "failed" && rn2?.report.note.contains("not installed") == true, "no Claude Code: says so")
runner.tools = tools

// 13. The code from Second Computer's own mirror (the owner's bundles fill it), before any Projects folder
try! fm.createDirectory(atPath: tmp + "/mirrors", withIntermediateDirectories: true)
_ = sh("git clone -q --bare \(src) \(tmp)/mirrors/mirrored.git")
let (rm1, _) = runJob(["id": "job-mirror", "repo": "mirrored", "base": baseSha, "prompt": "Add work"])
check(rm1?.state == "done" && rm1?.bundlePath != nil, "a repo found in the mirrors runs: \(rm1?.report.note ?? "")")
check(runner.has("job-mirror") == false, "nothing left running")
runner.forget("job-mirror"); usleep(300_000)
check(!fm.fileExists(atPath: root + "/jobs/job-mirror") && fm.fileExists(atPath: root + "/ran/job-mirror"), "forget: the folder goes, the marker that it ran stays")
let (rm2, _) = runJob(["id": "job-mirror", "repo": "mirrored", "base": baseSha, "prompt": "Add work"])
check(rm2?.state == "failed" && rm2?.report.note.contains("already ran") == true, "after forget the same id still never runs again")
if let b = r1?.bundlePath, let d = fm.contents(atPath: b) { check(OutHash.sha256(d) == r1?.bundleSha, "sha of bytes and of the file agree") }

print("secondcode: \(checks) checks, \(fails) failed")
exit(fails == 0 ? 0 : 1)
