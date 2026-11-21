// PS's one audio queue (after PS 1.71, the freeze of 21 Nov 2026; the why is at the top of AudioQueueCore.swift).
//
// The rule: nothing in PS waits on Core Audio on the main thread. Every Core Audio read or change that used to run on
// the main thread runs here instead, one at a time, and its listeners call in on this queue, never on main. The main
// thread only ever reads the last known state (under a lock, no Core Audio) and gets news with DispatchQueue.main.async.
// When the audio server does not answer for `limit` seconds (it hung on 21 Nov while coreaudiod's helpers crashed),
// the watchdog logs it once, callers keep the last known state, and at most one job of each kind waits behind the stuck
// one, so the retry happens by itself the moment the server answers. Nothing here ever waits with sync.
//
// Audio priority (AudioPriority.swift), AirPods AutoRoute (AutoRoute.swift) and the mixer (Mixer.swift) were already off
// the main thread on their own serial queues, with their listeners on their own queues; they stay so (moving them here
// would change their timing and put their q.sync helpers behind each other). The source check
// (tests/audio-queue-source-test.sh) keeps every Core Audio call inside these files.
// A test copy swaps in a fake reader (tests/audio-queue-test.swift) and never reads or changes a real microphone.
import Foundation

/// What the audio queue needs from the Mac (Mic.swift has the real one). Every call runs on the audio queue.
protocol MicReader: AnyObject {
  /// Every microphone, the default input and whether it runs. Also keeps the running listener on the default input.
  func read() -> MicSnapshot
  func setDefault(uid: String) -> Bool
  /// Listen for microphones plugged in or out and the default changing; the blocks run on `queue`.
  func listen(on queue: DispatchQueue, _ changed: @escaping () -> Void)
}

final class PSAudio {
  static let shared = PSAudio()
  /// The one serial audio queue.
  let queue = DispatchQueue(label: "PS audio", qos: .userInitiated)
  private let watchQ = DispatchQueue(label: "PS audio watch", qos: .utility)
  private let lock = NSLock()
  private var gate = AudioGate()                // under lock
  private var snap = MicSnapshot()              // under lock: the last known state
  private var loaded = false                    // under lock: read at least once
  private var asked = false                     // under lock: the page asked and waits for an answer
  private var lastSent: String?                 // the audio queue only
  private var reader: MicReader?                // the audio queue only
  private var listening = false                 // the audio queue only
  /// Gets {"type":"mic",...} on the main thread: when the page asked, or when the microphones changed.
  var onMic: ((String) -> Void)?
  var now: () -> Double = { Date().timeIntervalSince1970 }
  var log: (String) -> Void = { psLog($0) }

  /// Tests: a shorter watchdog.
  func setLimit(_ s: Double) { lock.lock(); gate.limit = s; lock.unlock() }

  // ---------- the queue ----------
  /// Runs `work` on the audio queue. A job of the same kind already waiting reads fresh state, so this one is dropped.
  func run(_ key: String?, _ work: @escaping () -> Void) {
    lock.lock(); let go = gate.ask(key); lock.unlock()
    guard go else { return }
    queue.async { [self] in
      lock.lock(); let id = gate.start(key, now: now()); let limit = gate.limit; lock.unlock()
      watchQ.asyncAfter(deadline: .now() + limit) { [weak self] in
        guard let self else { return }
        self.lock.lock(); let line = self.gate.look(id, now: self.now()); self.lock.unlock()
        if let line { self.log(line) }
      }
      work()
      lock.lock(); let line = gate.finish(id, now: now()); lock.unlock()
      if let line { log(line) }
    }
  }
  /// The audio server is not answering right now (a job has run longer than the limit).
  var stuck: Bool { lock.lock(); defer { lock.unlock() }; return gate.stuck }

  // ---------- the microphones ----------
  /// Starts reading and listening (main.swift at launch). Returns at once.
  func start(_ r: MicReader) {
    run("mic.start") { [self] in
      guard reader == nil else { return }
      reader = r
      if !listening { listening = true; r.listen(on: queue) { [weak self] in self?.refresh(asked: false) } }
    }
    refresh(asked: false)
  }
  /// A fresh read on the audio queue; the page hears it when it asked or when something changed.
  func refresh(asked ask: Bool) {
    if ask { lock.lock(); asked = true; lock.unlock() }
    run("mic") { [self] in
      guard let r = reader else { return }
      let s = r.read()
      lock.lock(); snap = s; loaded = true; let wanted = asked; asked = false; lock.unlock()
      let j = MicCore.json(s)
      guard MicCore.shouldDeliver(asked: wanted, json: j, lastSent: lastSent) else { return }
      lastSent = j
      DispatchQueue.main.async { [weak self] in self?.onMic?(j) }
    }
  }
  /// The page asks for the microphones. While the audio server is not answering, the last known state comes back at
  /// once (already read once); the fresh read follows when it answers.
  func ask() -> String? {
    refresh(asked: true)
    lock.lock(); defer { lock.unlock() }
    return gate.stuck && loaded ? MicCore.json(snap) : nil
  }
  /// The developer picked a microphone in Settings: make it the default on the audio queue, then a fresh read for the page.
  /// `done` gets whether macOS took it, on the main thread.
  func setDefault(uid: String, _ done: @escaping (Bool) -> Void) {
    run(nil) { [self] in
      let ok = reader?.setDefault(uid: uid) ?? false
      DispatchQueue.main.async { done(ok) }
      refresh(asked: true)                      // queued behind the change, so it reads what the change did
    }
  }
  /// The last known state, any thread, never waits.
  var mic: MicSnapshot { lock.lock(); defer { lock.unlock() }; return snap }
  var micJSON: String { lock.lock(); defer { lock.unlock() }; return MicCore.json(snap) }
  /// Tests only: wait for the queue (never from the main thread of PS).
  func drainForTest() { queue.sync {} }
}
