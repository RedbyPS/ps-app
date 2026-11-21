// tests/audio-queue-test.sh: PS's audio queue (Sources/AudioQueueCore.swift, AudioQueue.swift), after the freeze of
// 21 Nov 2026. A FAKE microphone reader that can hang like the audio server did; no real microphone is read or changed,
// no sound plays. Safe while someone uses the Mac.
import Foundation

func psLog(_ s: String) {}
var pass = 0, fail = 0
func check(_ name: String, _ ok: Bool) { if ok { pass += 1 } else { fail += 1; print("FAIL: \(name)") } }
func pump(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
func timed(_ f: () -> Void) -> Double { let t = Date(); f(); return Date().timeIntervalSince(t) }

// ---------- MicCore: the page sees the same JSON as before ----------
let usbMic = MicDevice(uid: "usbMic-uid", name: "USB Mic"), mac = MicDevice(uid: "BuiltInMicrophoneDevice", name: "MacBook Air Microphone")
func parse(_ j: String) -> [String: Any] { (try? JSONSerialization.jsonObject(with: Data(j.utf8))) as? [String: Any] ?? [:] }
let j1 = parse(MicCore.json(MicSnapshot(devices: [usbMic, mac], current: "usbMic-uid", running: false)))
check("json: type mic", j1["type"] as? String == "mic")
check("json: current is the default input's uid", j1["current"] as? String == "usbMic-uid")
check("json: every device with uid and name, in order", (j1["devices"] as? [[String: String]]) == [["uid": "usbMic-uid", "name": "USB Mic"], ["uid": "BuiltInMicrophoneDevice", "name": "MacBook Air Microphone"]])
check("json: a default input that is not listed reads as none", parse(MicCore.json(MicSnapshot(devices: [mac], current: "gone"))) ["current"] as? String == "")
check("json: nothing read yet is the old empty answer", parse(MicCore.json(MicSnapshot()))["devices"] as? [Any] != nil && parse(MicCore.empty)["current"] as? String == "")
check("json: quotes in a name survive", (parse(MicCore.json(MicSnapshot(devices: [MicDevice(uid: "a", name: "The developer's \"mic\"")], current: "a")))["devices"] as? [[String: String]])?.first?["name"] == "The developer's \"mic\"")
check("deliver: when asked", MicCore.shouldDeliver(asked: true, json: "x", lastSent: "x"))
check("deliver: when it changed", MicCore.shouldDeliver(asked: false, json: "y", lastSent: "x"))
check("deliver: not when nothing changed and nobody asked", !MicCore.shouldDeliver(asked: false, json: "x", lastSent: "x"))
check("json: the same state is the same text every time (keys sorted), so an unchanged state is never sent again", (0..<50).allSatisfy { _ in MicCore.json(MicSnapshot(devices: [usbMic, mac], current: "usbMic-uid")) == MicCore.json(MicSnapshot(devices: [usbMic, mac], current: "usbMic-uid")) })

// ---------- AudioGate ----------
var g = AudioGate()
check("gate: first ask of a kind runs", g.ask("mic"))
check("gate: a second ask while one waits is merged", !g.ask("mic"))
check("gate: another kind is its own", g.ask("other"))
check("gate: a change (nil key) is never merged", g.ask(nil) && g.ask(nil))
var id = g.start("mic", now: 100)
check("gate: once started, a new ask queues one more (the retry)", g.ask("mic") && !g.ask("mic"))
check("gate: no line before the limit", g.look(id, now: 101.5) == nil && !g.stuck)
let slow = g.look(id, now: 102)
check("gate: a line at the limit", slow?.contains("did not answer in 2.0 s (mic)") == true && g.stuck)
check("gate: the line is said once", g.look(id, now: 103) == nil)
check("gate: a look for an older job says nothing", g.look(id - 1, now: 500) == nil)
let back = g.finish(id, now: 336)
check("gate: answered again, with how long", back == "PS audio: the audio server answered again after 236 s" && !g.stuck)
check("gate: a quick job finishing says nothing", { var h = AudioGate(); let i = h.start("mic", now: 0); return h.look(i, now: 1) == nil && h.finish(i, now: 1) == nil }())
// The audio daemons crashed every 30 s on 21 Nov: a slow spell every 30 s for an hour stays at a handful of lines.
var lines: [String] = [], slowAt: [Double] = []
var g2 = AudioGate()
for k in 0..<120 {
  let t = Double(k) * 30
  let i = g2.start("mic", now: t)
  if let l = g2.look(i, now: t + 2) { lines.append(l); slowAt.append(t + 2) }
  if let l = g2.finish(i, now: t + 5) { lines.append(l) }
}
check("gate: an hour of a slow spell every 30 s is under 30 lines (was a freeze)", lines.count <= 30 && lines.count >= 2)
check("gate: later lines count the quiet spells", lines.contains { $0.contains("more times since the last line") })
check("gate: never two slow lines within 5 minutes", zip(slowAt, slowAt.dropFirst()).allSatisfy { $1 - $0 >= 300 })
// 236 s stuck, listeners firing 60 times a second: never more than one job of the kind waits.
var g3 = AudioGate(); let stuckID = g3.start("mic", now: 0); var queued = 0
for _ in 0..<(236 * 60) { if g3.ask("mic") { queued += 1 } }
check("gate: 14,160 listener calls while stuck queue exactly one read", queued == 1)
_ = g3.look(stuckID, now: 2); _ = g3.finish(stuckID, now: 236)
check("gate: that one read runs after the stuck one (the retry)", g3.waiting.contains("mic"))

// ---------- PSAudio with a fake reader that can hang ----------
final class FakeMic: MicReader {
  let lock = NSLock()
  var snap = MicSnapshot(devices: [usbMic, mac], current: "usbMic-uid", running: false)
  var hang = DispatchSemaphore(value: 0)
  var hanging = false
  var reads = 0
  var changed: (() -> Void)?
  var listenQueue: DispatchQueue?
  func read() -> MicSnapshot {
    lock.lock(); reads += 1; let h = hanging; lock.unlock()
    if h { hang.wait() }              // the audio server does not answer
    lock.lock(); defer { lock.unlock() }; return snap
  }
  func setDefault(uid: String) -> Bool {
    lock.lock(); defer { lock.unlock() }
    guard snap.devices.contains(where: { $0.uid == uid }) else { return false }
    snap.current = uid; return true
  }
  func listen(on queue: DispatchQueue, _ changed: @escaping () -> Void) { listenQueue = queue; self.changed = changed }
  /// A Core Audio listener firing, on the queue it was given.
  func fire() { listenQueue?.async { self.changed?() } }
}

let audio = PSAudio()
var logs: [String] = []
let logLock = NSLock()
audio.log = { s in logLock.lock(); logs.append(s); logLock.unlock() }
audio.setLimit(0.3)
var got: [String] = []
var onMain = true
audio.onMic = { j in got.append(j); if !Thread.isMainThread { onMain = false } }
let fake = FakeMic()
let tStart = timed { audio.start(fake) }
check("start returns at once", tStart < 0.05)
pump(0.3)
check("the page hears the microphones after start", got.last.map { parse($0)["current"] as? String == "usbMic-uid" } == true)
check("listeners are registered on the audio queue, not main", fake.listenQueue === audio.queue)
check("Mic state is cached for any thread", audio.mic.devices == [usbMic, mac] && !audio.mic.running)

got = []
check("ask while all is well: no cached answer, the fresh one follows", audio.ask() == nil)
pump(0.3)
check("an ask is answered even when nothing changed", got.count == 1)

got = []
fake.snap.running = true; fake.fire(); pump(0.3)
check("a call starts: inUse follows", audio.mic.running)
check("a call starts: the page is not bothered, its JSON did not change (\(got))", got.isEmpty)

// The freeze of 21 Nov: the audio server stops answering.
fake.lock.lock(); fake.hanging = true; fake.lock.unlock()
fake.fire()
pump(0.1)
var worst = 0.0
for _ in 0..<200 {
  worst = max(worst, timed { _ = audio.ask(); _ = audio.micJSON; _ = audio.mic.running; fake.fire() })
}
worst = max(worst, timed { audio.setDefault(uid: "BuiltInMicrophoneDevice") { _ in } })
check("while the audio server hangs, nothing on the main thread waits (worst \(Int(worst * 1000)) ms)", worst < 0.05)
pump(0.5)
check("the watchdog logs once that the audio server did not answer", logs.filter { $0.contains("did not answer") }.count == 1)
check("stuck shows", audio.stuck)
let cached = audio.ask()
check("while stuck, the page gets the last known state at once", cached.map { parse($0)["current"] as? String == "usbMic-uid" } == true)
pump(0.5)
check("still one line after a second more", logs.filter { $0.contains("did not answer") }.count == 1)

// The audio server answers again.
got = []
fake.lock.lock(); fake.hanging = false; fake.lock.unlock()
fake.hang.signal()                      // the stuck read returns
pump(0.6)
check("answered again is logged once", logs.filter { $0.contains("answered again") }.count == 1)
check("not stuck any more", !audio.stuck)
check("the 400 asks and listener calls while stuck became one read, plus one after the pick (\(fake.reads) reads in all)", fake.reads == 6)
check("the person's pick waited for the server, then took", fake.snap.current == "BuiltInMicrophoneDevice")
check("the page hears the new default after the server answered", got.last.map { parse($0)["current"] as? String == "BuiltInMicrophoneDevice" } == true)
check("every answer reached the page on the main thread", onMain)

// setDefault, normal case
var done: Bool?
got = []
audio.setDefault(uid: "usbMic-uid") { ok in done = ok }
pump(0.3)
check("setDefault: done on main with ok", done == true && fake.snap.current == "usbMic-uid")
check("setDefault: the page gets the new state", got.last.map { parse($0)["current"] as? String == "usbMic-uid" } == true)
done = nil
audio.setDefault(uid: "nope") { ok in done = ok }
pump(0.3)
check("setDefault: an unknown microphone is refused", done == false && fake.snap.current == "usbMic-uid")

print("audio-queue: \(pass) passed, \(fail) failed")
exit(fail == 0 ? 0 : 1)
