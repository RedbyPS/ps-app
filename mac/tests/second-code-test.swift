// Offline unit tests for Second Computer code jobs on the owner's protocol (PS 1.65): kind "code" in the sealed outsource
// body (SecondOEnv, SecondOJob.check), off until switched on, the round trip through a fake second Mac, the bundle sealed for
// the main Mac and tied to its job and file id, and the code runner inside SecondOutsourceRunner with a FICTIONAL claude
// (statuses, the bundle and its SHA-256, push refused, a secret result kept back, timeout, cancel). Keys in a temp folder,
// never the Keychain, never the network. Run with tests/second-code-test.sh.
import CryptoKit
import Foundation

func psLog(_ s: String) {}
var fails = 0
func check(_ name: String, _ ok: Bool) { print("\(name)=\(ok ? "ok" : "FAIL")"); if !ok { fails += 1 } }
func why<T>(_ r: Result<T, SecondRefusal>) -> String { if case .failure(let w) = r { return w.why }; return "ok" }
func sh(_ cmd: String) -> (Int32, String) {
  let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/sh"); p.arguments = ["-c", cmd]
  let o = Pipe(); p.standardOutput = o; p.standardError = o
  try! p.run(); let d = o.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
  return (p.terminationStatus, String(decoding: d, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
}

let fm = FileManager.default
let root = SafePath.real(NSTemporaryDirectory()) + "/ps-second-code-test-\(getpid())"
try? fm.removeItem(atPath: root)
try! fm.createDirectory(atPath: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(atPath: root) }

// Two Macs, paired, the owner's way: the main Mac (primary) and the second Mac (secondary).
func mac(_ name: String) -> (SecondIdentity, SecondKeys) {
  let st = SecondFileStore(dir: root + "/" + name)
  return (SecondIdentity(store: st, seenPath: root + "/" + name + "/seen.json"), SecondKeys(store: st, secure: false, noXWing: false))
}
let (i4, k4) = mac("main"), (i1, k1) = mac("second")
i4.trust(SecondPeer(device: i1.device, name: "Second Mac", pub: i1.pub, role: "secondary", at: 0))
i1.trust(SecondPeer(device: i4.device, name: "Main Mac", pub: i4.pub, role: "primary", at: 0))
k4.setPeer(i1.device, k1.pub); k1.setPeer(i4.device, k4.pub)

// A repo the second Mac has, in its Projects folder.
let projects = root + "/Projects", src = projects + "/demo"
try! fm.createDirectory(atPath: src, withIntermediateDirectories: true)
_ = sh("cd '\(src)' && git init -q -b main . && git config user.email t@localhost && git config user.name t && echo one > a.txt && git add a.txt && git commit -q -m first")
let base = sh("git -C '\(src)' rev-parse HEAD").1
let code: [String: Any] = ["kind": "code", "title": "Add a line", "prompt": "Add a line to a.txt and commit it.", "repo": "demo", "base": base, "tool": "claude", "minutes": 5]

// ---------- the switch and the checks ----------
SecondOJob.codeOn = { false }
check("code-off-by-default", why(SecondOJob.check(code)) == SecondOJob.codeOff)
check("research-works-with-code-off", why(SecondOJob.check(["kind": "research", "title": "Compare apps", "prompt": "Compare three note apps."])) == "ok")
SecondOJob.codeOn = { true }
if case .success(let j) = SecondOJob.check(code) { check("code-on-checks", j.kind == "code" && j.code?.repo == "demo" && j.code?.base == base && j.minutes == 5) } else { check("code-on-checks", false) }
var bad = code; bad["cmd"] = "rm -rf /"
check("code-unknown-key-refused", why(SecondOJob.check(bad)) == "Bad arguments")
var sec = code; sec["prompt"] = "Use ghp_abcdefghijklmnopqrstuvwxyz0123456789 to push"
check("code-secret-refused", why(SecondOJob.check(sec)).contains("secret"))
var cred = code; cred["repo"] = "https://user:pw@example.com/a.git"
check("code-repo-with-password-refused", why(SecondOJob.check(cred)).contains("password"))
var tooLong = code; tooLong["minutes"] = 241
check("code-minutes-range", why(SecondOJob.check(tooLong)) == "Bad arguments")

// ---------- the round trip on the owner's sealed body ----------
let (env, suite) = SecondOEnv.make(t: "ojob", from: i4.device, to: i1.device, plain: code, peer: k4.peer(i1.device)!, keys: k4)!
check("code-envelope-sealed", !env.body.contains("Add a line") && !env.body.contains("demo") && ["xwing", "p256"].contains(suite))
let opened = SecondOEnv.open(env, t: "ojob", me: i1.device, role: "primary", identity: i1, keys: k1)
if case .success(let o) = opened {
  check("code-kind-round-trip", o.plain["kind"] as? String == "code" && o.plain["base"] as? String == base && why(SecondOJob.check(o.plain)) == "ok")
} else { check("code-kind-round-trip", false) }
check("code-replay-refused", why(SecondOEnv.open(env, t: "ojob", me: i1.device, role: "primary", identity: i1, keys: k1)) == "Seen before")
var tb = try! JSONSerialization.jsonObject(with: Data(env.body.utf8)) as! [String: Any]
tb["to"] = i4.device
let tampered = SecondEnv(body: String(data: try! JSONSerialization.data(withJSONObject: tb, options: [.sortedKeys]), encoding: .utf8)!, sig: env.sig, by: env.by)
check("code-tampered-refused", why(SecondOEnv.open(tampered, t: "ojob", me: i1.device, role: "primary", identity: i1, keys: k1)) != "ok")
let stranger = mac("stranger")
let fromStranger = SecondOEnv.make(t: "ojob", from: stranger.0.device, to: i1.device, plain: code, peer: k1.pub!, keys: stranger.1)!.0
check("code-from-a-stranger-refused", why(SecondOEnv.open(fromStranger, t: "ojob", me: i1.device, role: "primary", identity: i1, keys: k1)) == "Not from your main Mac")

// ---------- the bundle, sealed for the main Mac ----------
let job = UUID().uuidString.lowercased(), fid = UUID().uuidString.lowercased()
let bundleBytes = Data((0..<300_000).map { UInt8(($0 * 7) % 256) })
let s = try! SecondSeal.seal(bundleBytes, aad: SecondCodeBundle.aad(job: job, file: fid), to: k4.peer(i1.device) == nil ? k4.pub! : k4.pub!)
let fileBytes = SecondCodeBundle.pack(suite: s.suite, kid: s.kid, enc: s.enc, ct: s.ct)
func openBundle(_ d: Data, job: String, file: String) -> Data? {
  guard let u = SecondCodeBundle.unpack(d), let mine = k4.privateFor(u.kid) else { return nil }
  return try? SecondSeal.open(SecondSeal.Sealed(suite: u.suite, kid: u.kid, enc: u.enc, ct: u.ct), aad: SecondCodeBundle.aad(job: job, file: file), with: mine)
}
check("bundle-opens-on-the-main-mac", openBundle(fileBytes, job: job, file: fid) == bundleBytes)
check("bundle-sha-matches", OutHash.sha256(openBundle(fileBytes, job: job, file: fid) ?? Data()) == OutHash.sha256(bundleBytes))
check("bundle-for-another-job-refused", openBundle(fileBytes, job: UUID().uuidString.lowercased(), file: fid) == nil)
check("bundle-under-another-file-id-refused", openBundle(fileBytes, job: job, file: UUID().uuidString.lowercased()) == nil)
var flipped = fileBytes; flipped[flipped.count - 10] ^= 0xFF
check("bundle-changed-bytes-refused", openBundle(flipped, job: job, file: fid) == nil)
check("bundle-not-plain-in-the-vault", fileBytes.range(of: bundleBytes.prefix(64)) == nil)
check("bundle-second-mac-cannot-open-its-own-seal", { guard let u = SecondCodeBundle.unpack(fileBytes), let m = k1.privateFor(u.kid) else { return true }
  return (try? SecondSeal.open(SecondSeal.Sealed(suite: u.suite, kid: u.kid, enc: u.enc, ct: u.ct), aad: SecondCodeBundle.aad(job: job, file: fid), with: m)) == nil }())

// ---------- the code runner inside the owner's runner, with a fictional claude ----------
let places = SecondPlaces(home: root + "/home", root: root + "/Second", projects: projects, shared: root + "/PS Shared")
try! fm.createDirectory(atPath: places.home, withIntermediateDirectories: true)
let fake = root + "/claude"
try! """
#!/bin/sh
if [ "$1" = "--help" ]; then echo "--allowedTools --disallowedTools --strict-mcp-config --safe-mode --settings --permission-mode --output-format --model"; exit 0; fi
p=$(cat)
case "$p" in *SLEEP*) sleep 131; exit 0;; esac
case "$p" in *PUSH*) git push origin HEAD:refs/heads/pushed > push.txt 2>&1; echo "exit $?" >> push.txt;; esac
case "$p" in *LEAK*) echo 'k = "ghp_abcdefghijklmnopqrstuvwxyz0123"' > leak.ts;; esac
echo two >> a.txt
git add -A && git commit -q -m "Add a line"
echo "Added a line. Tests passed."
""".write(toFile: fake, atomically: true, encoding: .utf8)
chmod(fake, 0o755)
let r = SecondOutsourceRunner(places: places)
r.claudePath = { fake }
var statuses: [SecondOutsourceRunner.Status] = []
let sl = NSLock()
r.onStatus = { st in sl.lock(); statuses.append(st); sl.unlock() }
func runCode(_ over: [String: Any], wait: Double = 60) -> SecondOutsourceRunner.Status? {
  var p = code; for (k, v) in over { p[k] = v }
  guard case .success(let j) = SecondOJob.check(p) else { return nil }
  let id = UUID().uuidString.lowercased()
  r.submit(j, id: id, from: i4.device, suite: "p256")
  let t0 = Date()
  while Date().timeIntervalSince(t0) < wait {
    sl.lock(); let f = statuses.last { $0.job == id && ["done", "failed", "cancelled", "timeout", "refused"].contains($0.state) }; sl.unlock()
    if let f { return f }
    Thread.sleep(forTimeInterval: 0.1)
  }
  return nil
}
let d1 = runCode([:])
check("runner-code-done", d1?.state == "done")
check("runner-code-fields", (d1?.code?["commits"] as? Int) == 1 && (d1?.code?["branch"] as? String)?.hasPrefix("outsource/") == true && d1?.code?["base"] as? String == base)
check("runner-bundle-and-sha", d1?.bundle.map { fm.fileExists(atPath: $0) } == true && d1?.bundleSha == d1?.bundle.flatMap { OutHash.sha256($0) })
check("runner-report-text", d1?.report?.contains("Commits: 1") == true && d1?.summary?.contains("Tests passed") == true)
sl.lock(); let steps = statuses.filter { $0.job == d1?.job }.map { $0.state }; sl.unlock()
check("runner-statuses-told", steps.first == "queued" && steps.contains("running") && steps.last == "done")
if let b = d1?.bundle {
  _ = sh("git clone -q '\(src)' '\(root)/review' && git -C '\(root)/review' fetch -q '\(b)' '\(d1!.code!["branch"] as! String):review/x'")
  check("runner-bundle-fetches-for-review", sh("git -C '\(root)/review' log -1 --format=%s review/x").1 == "Add a line")
}
check("runner-person-repo-untouched", sh("git -C '\(src)' rev-parse HEAD").1 == base && sh("git -C '\(src)' branch").1 == "* main")
let d2 = runCode(["prompt": "PUSH it"])
check("runner-push-refused", d2?.state == "done" && !sh("git -C '\(src)' branch -a").1.contains("pushed"))
let d3 = runCode(["prompt": "LEAK a key"])
check("runner-secret-result-kept-back", d3?.state == "failed" && d3?.bundle == nil && (d3?.reason ?? "").contains("secrets"))
r.secondsPerMinute = 0.2
let t0 = Date()
let d4 = runCode(["prompt": "SLEEP now"], wait: 30)
check("runner-timeout-kills \(d4?.state ?? "nil") \(d4?.reason ?? "") \(Int(Date().timeIntervalSince(t0)))s", d4?.state == "timeout" && Date().timeIntervalSince(t0) < 30)
Thread.sleep(forTimeInterval: 0.5)
check("runner-timeout-tree-gone", sh("pgrep -fx 'sleep 131'").1.isEmpty)
r.secondsPerMinute = 60
// Cancel from the main Mac (the owner's cancel kind goes through the same runner).
var cp = code; cp["prompt"] = "SLEEP again"
if case .success(let j) = SecondOJob.check(cp) {
  let id = UUID().uuidString.lowercased()
  r.submit(j, id: id, from: i4.device, suite: "p256")
  Thread.sleep(forTimeInterval: 3)
  r.submit(SecondOJob.Job(kind: "cancel", title: "", prompt: "", model: nil, minutes: 0, cancel: id), id: UUID().uuidString.lowercased(), from: i4.device, suite: "p256")
  let tc = Date()
  var f: SecondOutsourceRunner.Status?
  while f == nil && Date().timeIntervalSince(tc) < 20 { sl.lock(); f = statuses.last { $0.job == id && $0.state == "cancelled" }; sl.unlock(); Thread.sleep(forTimeInterval: 0.1) }
  check("runner-cancel", f != nil && Date().timeIntervalSince(tc) < 10)
} else { check("runner-cancel", false) }
// Switched off: the code runner stops what waits and runs.
SecondOJob.codeOn = { false }
check("code-off-again-refused", why(SecondOJob.check(code)) == SecondOJob.codeOff)

print("SECOND CODE: \(fails) FAIL")
exit(fails == 0 ? 0 : 1)
