import Foundation
// Run: bash tests/voice-test.sh. Voice capture's rules (Sources/VoiceCaptureCore.swift) with a fake recogniser, a fake clock and
// a fake model. No microphone, no speech framework, no window, no sound, no network.
setvbuf(stdout, nil, _IONBF, 0)
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }

// ---- permissions
ok("both allowed: ready", VoiceRules.perm(mic: .authorized, speech: .authorized) == .ready)
ok("never asked: ask", VoiceRules.perm(mic: .notDetermined, speech: .authorized) == .ask && VoiceRules.perm(mic: .authorized, speech: .notDetermined) == .ask)
ok("one said no: denied, even if the other was never asked", VoiceRules.perm(mic: .denied, speech: .notDetermined) == .denied && VoiceRules.perm(mic: .authorized, speech: .denied) == .denied)
ok("restricted wins", VoiceRules.perm(mic: .denied, speech: .restricted) == .restricted && VoiceRules.perm(mic: .restricted, speech: .authorized) == .restricted)
ok("the System Settings page: the microphone first", VoiceRules.settingsPane(mic: .denied, speech: .denied).hasSuffix("Privacy_Microphone"))
ok("the System Settings page: then speech", VoiceRules.settingsPane(mic: .authorized, speech: .denied).hasSuffix("Privacy_SpeechRecognition"))

// ---- may it listen
ok("1Password or Signal in front: never, whatever else", VoiceRules.block(featureOn: true, perm: .ready, onDevice: true, protectedFront: true, test: false) == .protected)
ok("switch off: no", VoiceRules.block(featureOn: false, perm: .ready, onDevice: true, protectedFront: false, test: false) == .off)
ok("a test copy: never", VoiceRules.block(featureOn: true, perm: .ready, onDevice: true, protectedFront: false, test: true) == .off)
ok("not allowed: no", VoiceRules.block(featureOn: true, perm: .ask, onDevice: true, protectedFront: false, test: false) == .perm)
ok("no on device speech for the language: no", VoiceRules.block(featureOn: true, perm: .ready, onDevice: false, protectedFront: false, test: false) == .onDevice)
ok("all good: yes", VoiceRules.block(featureOn: true, perm: .ready, onDevice: true, protectedFront: false, test: false) == nil)

// ---- the level meter
func rms(_ a: [Float]) -> Float { a.withUnsafeBufferPointer { VoiceLevel.rms($0) } }
ok("silence is 0", VoiceLevel.level(rms: rms([0, 0, 0, 0])) == 0 && rms([]) == 0)
ok("loud is 1, never more", VoiceLevel.level(rms: rms([1, -1, 1, -1])) == 1)
ok("a bad sample is skipped", rms([Float.nan, 0.5, -0.5, 0.5]).isFinite)
let mid = VoiceLevel.level(rms: 0.01)
ok("normal speech sits in the middle", mid > 0.2 && mid < 0.8)
ok("calm: rises fast, falls slow", VoiceLevel.smooth(0, 1) == 0.5 && VoiceLevel.smooth(1, 0) > 0.8)

// ---- the session with a fake recogniser
final class FakeRec: VoiceRecognizer {
  var text: ((String, Bool) -> Void)?
  var level: ((Float) -> Void)?
  var failed: (() -> Void)?
  var started = false, finished = false, cancelled = false
  var throwOnStart = false
  func start(text: @escaping (String, Bool) -> Void, level: @escaping (Float) -> Void, failed: @escaping () -> Void) throws {
    if throwOnStart { throw NSError(domain: "fake", code: 1) }
    self.text = text; self.level = level; self.failed = failed; started = true
  }
  func finish() { finished = true }
  func cancel() { cancelled = true }
}
final class Rig {
  var sent: [[String: Any]] = []
  var timers: [(TimeInterval, () -> Void)] = []
  var clock: TimeInterval = 0
  var recs: [FakeRec] = []
  var listening: [Bool] = []
  var throwNext = false
  lazy var core: VoiceSessionCore = {
    let c = VoiceSessionCore(make: { [unowned self] in let r = FakeRec(); r.throwOnStart = throwNext; recs.append(r); return r },
                             send: { [unowned self] in sent.append($0) }, now: { [unowned self] in clock },
                             after: { [unowned self] s, f in timers.append((s, f)) }, hop: { $0() })
    c.onListening = { [unowned self] in listening.append($0) }
    return c
  }()
  var rec: FakeRec { recs.last! }
  func types() -> [String] { sent.map { $0["type"] as? String ?? "" } }
  func last() -> [String: Any] { sent.last ?? [:] }
  /// Runs the timers set for `seconds` (the two minute limit, the grace after Stop).
  func fire(_ seconds: TimeInterval) { let due = timers.filter { $0.0 == seconds }; timers.removeAll { $0.0 == seconds }; due.forEach { $0.1() } }
}

do {
  let r = Rig()
  r.core.start(block: .protected)
  ok("blocked: the page is told why, no recogniser is made", r.types() == ["voice:blocked"] && (r.last()["why"] as? String) == "protected" && r.recs.isEmpty)
}
do {
  let r = Rig()
  r.core.start(block: nil)
  ok("start: listening, the page is told", r.types() == ["voice:started"] && r.rec.started && r.core.state == .recording && r.listening == [true])
  r.core.start(block: nil)
  ok("a second start while listening keeps the one recording and says it is listening", r.recs.count == 1 && r.types() == ["voice:started", "voice:started"] && r.listening == [true])
  r.rec.text?("call the bank", false)
  ok("words so far go to the page", (r.last()["text"] as? String) == "call the bank" && r.types().last == "voice:partial")
  r.rec.level?(1); r.clock = 0.01; r.rec.level?(1); r.clock = 0.2; r.rec.level?(1)
  ok("the level is sent at most 15 times a second", r.types().filter { $0 == "voice:level" }.count == 2)
  r.core.stop()
  ok("stop: the microphone stops at once, the watch on the app in front ends", r.rec.finished && r.core.state == .finishing && r.listening == [true, false])
  r.rec.text?("Call the bank.", true)
  ok("the last words end it, with the words", r.core.state == .idle && (r.last()["reason"] as? String) == "user" && (r.last()["text"] as? String) == "Call the bank.")
  let before = r.sent.count
  r.fire(VoiceRules.finishGrace); r.fire(VoiceRules.maxSeconds)
  ok("late timers of an ended recording do nothing", r.sent.count == before)
}
do {
  let r = Rig()
  r.core.start(block: nil)
  r.rec.text?("call the bank", false)
  r.core.stop()
  r.fire(VoiceRules.finishGrace)
  ok("no last words in time: the words so far are used", (r.last()["reason"] as? String) == "user" && (r.last()["text"] as? String) == "call the bank" && r.rec.cancelled)
}
do {
  let r = Rig()
  r.core.start(block: nil)
  r.rec.text?("call the bank and", false)
  r.core.protectedFront()
  ok("1Password or Signal comes to the front: stopped at once, the words before it kept", r.rec.cancelled && r.core.state == .idle && (r.last()["reason"] as? String) == "protected" && (r.last()["text"] as? String) == "call the bank and")
  let before = r.sent.count
  r.rec.text?("words after the switch", true); r.rec.level?(1); r.rec.failed?()
  ok("nothing heard after the switch reaches the page", r.sent.count == before)
  ok("the watch on the app in front ended", r.listening.last == false)
}
do {
  let r = Rig()
  r.core.start(block: nil)
  r.core.stop()
  r.core.protectedFront()
  ok("it also comes to the front while the last words are awaited: stopped at once", r.rec.cancelled && (r.last()["reason"] as? String) == "protected")
}
do {
  let r = Rig()
  r.core.start(block: nil)
  r.core.stop()
  let before = r.sent.count
  r.core.start(block: nil)
  ok("a start while the last words are awaited: nothing new, the stop that follows tells the page", r.sent.count == before && r.recs.count == 1)
}
do {
  let r = Rig()
  r.core.protectedFront()
  ok("the app in front changes while not listening: nothing", r.sent.isEmpty)
}
do {
  let r = Rig()
  r.core.start(block: nil)
  r.rec.text?("one", false)
  r.core.cancel()
  ok("cancel (Esc, the window closed): stopped, nothing kept", r.rec.cancelled && (r.last()["reason"] as? String) == "cancel" && (r.last()["text"] as? String) == "")
}
do {
  let r = Rig()
  r.core.start(block: nil)
  r.rec.text?("a very long ramble", false)
  r.fire(VoiceRules.maxSeconds)
  ok("the two minute limit stops the microphone", r.rec.finished && r.core.state == .finishing)
  r.rec.text?("A very long ramble.", true)
  ok("and says it was the limit, with the words", (r.last()["reason"] as? String) == "limit" && (r.last()["text"] as? String) == "A very long ramble.")
}
do {
  let r = Rig()
  r.core.start(block: nil)
  r.rec.failed?()
  ok("the recogniser fails with nothing heard: an error", (r.last()["reason"] as? String) == "error" && r.core.state == .idle)
  r.core.start(block: nil)
  r.rec.text?("call", false)
  r.rec.failed?()
  ok("it fails after some words: the words are kept", (r.last()["reason"] as? String) == "user" && (r.last()["text"] as? String) == "call")
}
do {
  let r = Rig()
  r.throwNext = true
  r.core.start(block: nil)
  ok("the microphone cannot start: an error, not listening", (r.last()["reason"] as? String) == "error" && r.core.state == .idle && r.listening.isEmpty)
}
do {
  let r = Rig()
  r.core.start(block: nil)
  r.rec.text?(String(repeating: "a", count: 9000), false)
  ok("the words are capped", ((r.last()["text"] as? String) ?? "").count == 4000)
}

// ---- the split with a fake model
func wait(_ f: (@escaping (String?) -> Void) -> Void) -> (String?, Int) {
  let sem = DispatchSemaphore(value: 0)
  var out: String?, calls = 0
  let lock = NSLock()
  f { s in lock.lock(); out = s; calls += 1; lock.unlock(); sem.signal() }
  _ = sem.wait(timeout: .now() + 5)
  Thread.sleep(forTimeInterval: 0.3)   // a second call would land here
  lock.lock(); defer { lock.unlock() }
  return (out, calls)
}
var seen: (String, String)?
let good = wait { done in VoiceSplit.run(text: "call Alex tomorrow at 10, send the invoice", model: { i, p, _ in seen = (i, p); return "{\"tasks\": [\"Call Alex tomorrow at 10\", \"Send the invoice\"]}" }, done: done) }
ok("the model's text is handed to the page, once", good.0?.contains("Send the invoice") == true && good.1 == 1)
ok("the model gets the rules and only the words", seen?.0 == VoiceSplit.instructions && seen?.1 == "What the person said:\ncall Alex tomorrow at 10, send the invoice")
ok("the rules ask for JSON and the words as said", VoiceSplit.instructions.contains("{\"tasks\":") && VoiceSplit.instructions.contains("exactly as said"))
let none = wait { done in VoiceSplit.run(text: "call Alex", model: nil, done: done) }
ok("no model (Apple Intelligence off, an older Mac): nil, the page splits", none.0 == nil && none.1 == 1)
let empty = wait { done in VoiceSplit.run(text: "  \u{0007} ", model: { _, _, _ in "x" }, done: done) }
ok("no words: the model is not asked", empty.0 == nil)
let fails = wait { done in VoiceSplit.run(text: "call Alex", model: { _, _, _ in throw AssistFailure.failed }, done: done) }
ok("the model fails: nil", fails.0 == nil && fails.1 == 1)
var cancelledLate = false
let slow = wait { done in VoiceSplit.run(text: "call Alex", model: { _, _, c in Thread.sleep(forTimeInterval: 1.0); cancelledLate = c.isCancelled; return "late" }, timeout: 0.2, done: done) }
Thread.sleep(forTimeInterval: 1.0)
ok("too slow: nil at the time limit, the late answer is dropped and told to stop", slow.0 == nil && slow.1 == 1 && cancelledLate)
ok("control characters are taken out, the length capped", VoiceSplit.clean("a\u{0000}b\u{001B}c") == "abc" && VoiceSplit.clean(String(repeating: "x", count: 5000)).count == 4000)

print("\(n - bad) of \(n) passed")
exit(bad == 0 ? 0 : 1)
