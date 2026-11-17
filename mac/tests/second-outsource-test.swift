// Offline unit tests for Second Computer outsourcing (Sources/SecondSeal.swift, SecondOutsource.swift, protocol v1.3):
// sealing and opening (X-Wing where this Mac has it, the P-256 fallback), tampering, the wrong key, expiry, replays,
// key rotation, the job allowlist and secret check, and the runner (3 at once, the sandbox flags, timeout, cancel,
// its folder gone after the ack) with a FICTIONAL `claude` script. Keys live in a temporary folder; one check makes a
// real Secure Enclave key there. Never the Keychain, never the network, never the developer's files.
//   mkdir -p build/outsource && cp tests/second-outsource-test.swift build/outsource/main.swift && swiftc build/outsource/main.swift Sources/SecondSeal.swift Sources/SecondOutsource.swift Sources/SecondJobs.swift Sources/SecondProc.swift Sources/SecondCrypto.swift Sources/SecondHost.swift Sources/SecondShare.swift Sources/SecondFiles.swift Sources/SafeSignal.swift Sources/SecondCodeCore.swift Sources/SecondCodeRunner.swift -o build/outsource/test && build/outsource/test
import CryptoKit
import Foundation

func psLog(_ s: String) {}
var fails = 0
func check(_ name: String, _ ok: Bool) { print("\(name)=\(ok ? "ok" : "FAIL")"); if !ok { fails += 1 } }
func why<T>(_ r: Result<T, SecondRefusal>) -> String { if case .failure(let w) = r { return w.why }; return "opened" }

let fm = FileManager.default
let root = SafePath.real(NSTemporaryDirectory()) + "/ps-outsource-test-\(getpid())"
try? fm.removeItem(atPath: root)
try! fm.createDirectory(atPath: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(atPath: root) }

// Two Macs, paired: the M4 (primary) and the M1 (secondary).
func mac(_ name: String, secure: Bool = false, noXWing: Bool = false) -> (SecondIdentity, SecondKeys) {
  let st = SecondFileStore(dir: root + "/" + name)
  return (SecondIdentity(store: st, seenPath: root + "/" + name + "/seen.json"), SecondKeys(store: st, secure: secure, noXWing: noXWing))
}
let (i4, k4) = mac("m4"), (i1, k1) = mac("m1")
i4.trust(SecondPeer(device: i1.device, name: "Home M1", pub: i1.pub, role: "secondary", at: 0))
i1.trust(SecondPeer(device: i4.device, name: "MacBook Air M4", pub: i4.pub, role: "primary", at: 0))
k4.setPeer(i1.device, k1.pub); k1.setPeer(i4.device, k4.pub)
let research: [String: Any] = ["kind": "research", "title": "Compare three note apps", "prompt": "Compare Bear, Craft and Apple Notes for a Mac user: price, sync, privacy.", "minutes": 10]

func job(_ plain: [String: Any] = research, from: (SecondIdentity, SecondKeys) = (i4, k4), to: (SecondIdentity, SecondKeys) = (i1, k1), now: Date = Date()) -> (SecondEnv, String)? {
  SecondOEnv.make(t: "ojob", from: from.0.device, to: to.0.device, plain: plain, peer: from.1.peer(to.0.device)!, keys: from.1, now: now)
}
func openJob(_ e: SecondEnv, now: Date = Date(), on: (SecondIdentity, SecondKeys) = (i1, k1)) -> Result<SecondOEnv.Opened, SecondRefusal> {
  SecondOEnv.open(e, t: "ojob", me: on.0.device, role: "primary", identity: on.0, keys: on.1, now: now)
}
/** The same envelope with its body changed and signed again by `signer` (as if that key's owner sent it). */
func resign(_ e: SecondEnv, _ keys: SecondKeys, _ change: (inout [String: Any]) -> Void) -> SecondEnv {
  var b = try! JSONSerialization.jsonObject(with: Data(e.body.utf8)) as! [String: Any]
  change(&b)
  let d = try! JSONSerialization.data(withJSONObject: b, options: [.sortedKeys])
  return SecondEnv(body: String(data: d, encoding: .utf8)!, sig: keys.sign(d)!.base64EncodedString(), by: e.by)
}

// ---------- sealing ----------
let xwingHere = SecondSeal.xwingHere
let (e1, suite1) = job()!
let o1 = openJob(e1)
check("seal-opens", (try? o1.get())?.plain["title"] as? String == "Compare three note apps")
check("seal-suite-" + (xwingHere ? "xwing" : "p256"), suite1 == (xwingHere ? "xwing" : "p256") && (try? o1.get())?.suite == suite1)
check("seal-no-plaintext-in-the-record", !e1.body.contains("note apps") && !e1.body.contains("Bear"))
check("seal-replay-refused", why(openJob(e1)) == "Seen before")
// Each job has its own one-time key: the same task twice never seals the same.
let (e2, _) = job()!
let enc = { (e: SecondEnv) in ((try! JSONSerialization.jsonObject(with: Data(e.body.utf8)) as! [String: Any])["sealed"] as! [String: Any])["enc"] as! String }
check("seal-fresh-key-each-job", enc(e1) != enc(e2))

// ---------- the P-256 fallback (a second Mac on macOS before 26 publishes no X-Wing key) ----------
let old1 = mac("m1-old", noXWing: true)
old1.0.trust(SecondPeer(device: i4.device, name: "MacBook Air M4", pub: i4.pub, role: "primary", at: 0))
i4.trust(SecondPeer(device: old1.0.device, name: "Old M1", pub: old1.0.pub, role: "secondary", at: 0))
k4.setPeer(old1.0.device, old1.1.pub); old1.1.setPeer(i4.device, k4.pub)
let (ef, sf) = job(to: old1)!
check("fallback-p256", sf == "p256" && old1.1.pub?.xwing == nil && (try? openJob(ef, on: old1).get())?.suite == "p256")

// ---------- tampering, wrong keys, strangers ----------
let (e3, _) = job()!
var bad = e3; bad.sig = Data(repeating: 1, count: 64).base64EncodedString()
check("tamper-signature", why(openJob(bad)) == "Signature does not match")
var flipped = e3; flipped.body = flipped.body.replacingOccurrences(of: "\"ojob\"", with: "\"ojob\" ")
check("tamper-body", why(openJob(flipped)) == "Signature does not match")
// Even signed by the M4's own key: a changed header no longer matches what was sealed (the header is the AAD).
check("tamper-header-aad", why(openJob(resign(e3, k4) { $0["at"] = (($0["at"] as! NSNumber).doubleValue - 1000) as Any })) == "Could not open it (tampered, or the wrong key)")
check("tamper-ciphertext", why(openJob(resign(e3, k4) { b in var s = b["sealed"] as! [String: Any]; var c = Data(base64Encoded: s["ct"] as! String)!; c[c.count - 1] ^= 1; s["ct"] = c.base64EncodedString(); b["sealed"] = s })) == "Could not open it (tampered, or the wrong key)")
let stranger = mac("stranger")
var forged = resign(e3, stranger.1) { _ in }
check("stranger-key-refused", why(openJob(forged)) == "Signature does not match")
forged.by = stranger.0.device
check("untrusted-mac-refused", why(openJob(forged)) == "Not from your main Mac")
// Sealed for another Mac's key: it cannot be opened here even if everything else is right.
let other = mac("other")
k4.setPeer("fake-m1", other.1.pub)
let wrong = SecondOEnv.make(t: "ojob", from: i4.device, to: i1.device, plain: research, peer: other.1.pub!, keys: k4)!.0
check("wrong-key-refused", why(openJob(wrong)) == "Sealed for a key this Mac no longer has")
check("not-for-this-mac", why(openJob(job(to: old1)!.0)) == "Meant for another Mac")

// ---------- expiry and the clock ----------
check("expired-after-10-minutes", why(openJob(job()!.0, now: Date().addingTimeInterval(11 * 60))) == "Too old (over 10 minutes)")
check("fresh-within-10-minutes", why(openJob(job()!.0, now: Date().addingTimeInterval(9 * 60))) == "opened")
check("future-refused", why(openJob(job(now: Date().addingTimeInterval(20 * 60))!.0)) == "Clock is off")

// ---------- key rotation: a job sealed to last week's key still opens; then the new key is used ----------
let before = k1.pub!.kid
let (er, _) = job()!
k1.rotateIfDue(force: true)
check("rotation-new-kid", k1.pub!.kid != before)
check("rotation-old-key-still-opens", why(openJob(er)) == "opened")
k4.setPeer(i1.device, k1.pub)
let (en, _) = job()!
check("rotation-new-key-used", ((try? openJob(en).get())?.body["sealed"] as? [String: Any])?["kid"] as? String == k1.pub!.kid)
k1.rotateIfDue(force: true); k1.rotateIfDue(force: true)
check("rotation-two-back-refused", why(openJob(resign(en, k4) { $0["id"] = UUID().uuidString.lowercased(); $0["nonce"] = Data(repeating: 7, count: 16).base64EncodedString() })) != "opened")
k4.setPeer(i1.device, k1.pub)

// ---------- results back to the main Mac ----------
let res = SecondOEnv.make(t: "ores", from: i1.device, to: i4.device, job: UUID().uuidString.lowercased(), plain: ["state": "done", "report": "# Notes\nBear wins."], peer: k1.peer(i4.device)!, keys: k1)!.0
let ro = SecondOEnv.open(res, t: "ores", me: i4.device, role: "secondary", identity: i4, keys: k4)
check("result-opens", (try? ro.get())?.plain["report"] as? String == "# Notes\nBear wins.")
let resOld = SecondOEnv.make(t: "ores", from: i1.device, to: i4.device, job: UUID().uuidString.lowercased(), plain: ["state": "done"], peer: k1.peer(i4.device)!, keys: k1, now: Date().addingTimeInterval(-8 * 86_400))!.0
check("result-too-old", why(SecondOEnv.open(resOld, t: "ores", me: i4.device, role: "secondary", identity: i4, keys: k4)) == "Too old")
check("result-only-from-the-second-mac", why(SecondOEnv.open(job()!.0, t: "ores", me: i1.device, role: "secondary", identity: i1, keys: k1)) == "Not from your second Mac")

// ---------- the Secure Enclave ----------
let se = mac("m4-se", secure: true)
if SecureEnclave.isAvailable {
  let d = Data("hello".utf8)
  check("secure-enclave-key", se.1.signStore == "secure enclave" && SecondKeys.verify(se.1.sign(d)!, d, key: se.1.pub!.sign))
  let again = SecondKeys(store: SecondFileStore(dir: root + "/m4-se"), secure: true)
  check("secure-enclave-key-kept", again.pub?.sign == se.1.pub?.sign && again.signStore == "secure enclave")
} else { check("secure-enclave-absent-keychain", se.1.signStore == "keychain") }

// ---------- what a job may ask for ----------
func jobWhy(_ p: [String: Any]) -> String { why(SecondOJob.check(p)) }
check("job-research-ok", jobWhy(research) == "opened")
check("job-only-research", jobWhy(["kind": "claude", "prompt": "x", "title": "x"]) == "Not allowed: only research and code jobs run on the second Mac")
check("job-no-extra-scope", jobWhy(research.merging(["scope": "bash"]) { a, _ in a }) == "Bad arguments")
check("job-minutes-limit", jobWhy(research.merging(["minutes": 31]) { _, b in b }) == "Bad arguments")
check("job-secret-refused", jobWhy(research.merging(["prompt": "Use my key sk-ant-api03-abcdefghijklmnopqrstuv to check"]) { _, b in b }).hasPrefix("It looks like it holds a secret (an API key)"))
check("job-password-refused", jobWhy(research.merging(["prompt": "Log in with password: hunter2xyz"]) { _, b in b }).contains("a password"))
check("job-cancel-ok", jobWhy(["kind": "cancel", "job": UUID().uuidString.lowercased()]) == "opened")
check("job-title", SecondOJob.title("Compare the top 3 note apps for Mac, price, sync & privacy?") == "Compare the top 3 note apps for Mac, price")   // nine words, no sign left at the end

// ---------- the sandbox flags ----------
let full: Set<String> = ["--tools", "--allowedTools", "--disallowedTools", "--strict-mcp-config", "--safe-mode", "dontAsk", "--output-format", "--model"]
let a = SecondOutsourceRunner.sandboxArgs(full, model: "sonnet") ?? []
check("sandbox-flags", a.contains("--tools") && a[a.firstIndex(of: "--tools")! + 1] == "WebSearch,WebFetch,Read,Write,Edit" && a.contains("Read(./**)") && a.contains("--strict-mcp-config")
      && a.contains("--safe-mode") && a.contains("dontAsk") && !a.contains("bypassPermissions") && !a.joined(separator: " ").contains("Bash(") && a.contains("sonnet"))
check("sandbox-too-old-claude", SecondOutsourceRunner.sandboxArgs(["--output-format", "--allowedTools"], model: nil) == nil)

// ---------- the runner, with a fictional claude ----------
let places = SecondPlaces(home: root, root: root + "/Second", projects: root + "/Projects", shared: root + "/PS Shared")
let fake = root + "/claude"
try! """
#!/bin/bash
if [ "$1" = "--help" ]; then echo "--tools --allowedTools --disallowedTools --strict-mcp-config --safe-mode dontAsk --output-format --model"; exit 0; fi
printf '%s\\n' "$@" > args.txt
p=$(cat)
case "$p" in *SLEEP*) sleep 30;; esac
case "$p" in *NAP*) sleep 1;; esac
case "$p" in *SIGNEDOUT*) echo '{"type":"result","is_error":true,"result":"Failed to authenticate: OAuth session expired and could not be refreshed"}'; exit 1;; esac
printf '# Report\\nFictional findings for: %s\\n' "$(echo "$p" | grep '^Task:' )" > report.md
echo "a note" > notes.txt
echo '{"type":"result","result":"Two fictional sentences."}'
""".write(toFile: fake, atomically: true, encoding: .utf8)
chmod(fake, 0o755)
let r = SecondOutsourceRunner(places: places)
r.claudePath = { fake }
r.secondsPerMinute = 0.2   // a "minute" is 0.2 s here: 5 minutes = 1 s
var statuses: [SecondOutsourceRunner.Status] = []
var maxRunning = 0
let sl = NSLock()
r.onStatus = { s in sl.lock(); statuses.append(s); maxRunning = max(maxRunning, r.count.running); sl.unlock() }
func j(_ title: String, _ prompt: String, minutes: Int = 30) -> SecondOJob.Job { try! SecondOJob.check(["kind": "research", "title": title, "prompt": prompt, "minutes": minutes]).get() }
var ids: [String] = []
for k in 0..<5 { let id = UUID().uuidString.lowercased(); ids.append(id); r.submit(j("Task \(k)", "NAP fictional question \(k)"), id: id, from: i4.device, suite: "xwing") }
let slow = UUID().uuidString.lowercased(), late = UUID().uuidString.lowercased(), gone = UUID().uuidString.lowercased()
r.submit(j("Slow", "SLEEP please", minutes: 5), id: slow, from: i4.device, suite: "xwing")
r.submit(j("Cancelled while waiting", "NAP x"), id: gone, from: i4.device, suite: "xwing")
r.cancel(gone)
func final(_ id: String) -> SecondOutsourceRunner.Status? { sl.lock(); defer { sl.unlock() }; return statuses.last { $0.job == id && ["done", "failed", "timeout", "cancelled", "refused"].contains($0.state) } }
let until = Date().addingTimeInterval(30)
while Date() < until && (ids + [slow]).contains(where: { final($0) == nil }) { Thread.sleep(forTimeInterval: 0.1) }
let d0 = final(ids[0])
check("runner-done-with-report", d0?.state == "done" && (d0?.report ?? "").contains("Fictional findings for: Task: Task 0") && d0?.summary == "Two fictional sentences.")
check("runner-other-files", d0?.files.map { $0.0 } == ["args.txt", "notes.txt"])
check("runner-all-done", ids.allSatisfy { final($0)?.state == "done" })
check("runner-three-at-once", maxRunning <= 3 && maxRunning >= 2)
check("runner-timeout", final(slow)?.state == "timeout" && final(slow)?.reason == "It ran past 5 minutes")
check("runner-cancel-waiting", final(gone)?.state == "cancelled")
let used = (try? String(contentsOfFile: places.root + "/outsource/" + ids[0] + "/args.txt", encoding: .utf8)) ?? ""
check("runner-sandbox-used", used.contains("WebSearch,WebFetch,Read,Write,Edit") && used.contains("--strict-mcp-config") && used.contains("dontAsk") && used.contains("--safe-mode"))
r.submit(j("Cancelled while running", "SLEEP"), id: late, from: i4.device, suite: "xwing")
Thread.sleep(forTimeInterval: 0.8); r.cancel(late)
let u2 = Date().addingTimeInterval(10)
while Date() < u2 && final(late) == nil { Thread.sleep(forTimeInterval: 0.1) }
check("runner-cancel-running", final(late)?.state == "cancelled")
r.done(ids[0]); Thread.sleep(forTimeInterval: 0.5)
check("runner-folder-gone-after-ack", !fm.fileExists(atPath: places.root + "/outsource/" + ids[0]) && fm.fileExists(atPath: places.root + "/outsource/" + ids[1]))
let so = UUID().uuidString.lowercased()
r.submit(j("Signed out", "SIGNEDOUT please"), id: so, from: i4.device, suite: "xwing")
let u3 = Date().addingTimeInterval(10)
while Date() < u3 && final(so) == nil { Thread.sleep(forTimeInterval: 0.1) }
check("runner-signed-out-plain-words", final(so)?.state == "failed" && final(so)?.reason == "Claude Code on this Mac is not signed in. Open Terminal there, run claude, and sign in." && final(so)?.report == nil)
let nr = SecondOutsourceRunner(places: places)
nr.claudePath = { nil }
var nrs: SecondOutsourceRunner.Status?
nr.onStatus = { if $0.state == "failed" { nrs = $0 } }
nr.submit(j("No claude", "x"), id: UUID().uuidString.lowercased(), from: i4.device, suite: "p256")
Thread.sleep(forTimeInterval: 0.5)
check("runner-no-claude-plain-words", nrs?.reason == "Claude Code is not installed on this Mac")

print("SECOND OUTSOURCE: \(fails) FAIL")
exit(fails == 0 ? 0 : 1)
