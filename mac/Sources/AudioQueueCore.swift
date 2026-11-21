// The pure part of PS's audio queue (AudioQueue.swift, after PS 1.71). No Core Audio, no clock, no queues: values in,
// decisions out, so tests/audio-queue-test.sh checks it on its own.
//
// Why (the developer, 21 Nov 2026, 08:38 Dubai): PS froze for 236 s and had to be force quit. macOS's audio daemons were
// crashing every 30 s, and a microphone listener on the MAIN queue asked Core Audio for the default input
// (Mic.stateJSON). Core Audio waited for the audio server, and the main thread waited with it, forever.
// Now every Core Audio read and change runs on one serial audio queue. The page and the UI get the last known state at
// once, and the queue hands them news with async only. AudioGate decides what runs, what waits and what to log.
import Foundation

/// One microphone the Mac can see (Core Audio's UID and name).
struct MicDevice: Equatable { let uid: String; let name: String }

/// What PS last read about the microphones: every input, the Mac's default input, and whether an app uses it (a call).
struct MicSnapshot: Equatable {
  var devices: [MicDevice] = []
  var current = ""            // the default input's UID, "" when none or not known
  var running = false         // "running somewhere": an app listens to the default input (never what it hears)
}

enum MicCore {
  /// {"type":"mic","current":"<uid>","devices":[{"uid":..,"name":..}]}, the same as before PS 1.71's fix.
  /// `current` is "" unless the default input is one of the listed microphones.
  static func json(_ s: MicSnapshot) -> String {
    let cur = s.devices.contains { $0.uid == s.current } ? s.current : ""
    let obj: [String: Any] = ["type": "mic", "current": cur, "devices": s.devices.map { ["uid": $0.uid, "name": $0.name] }]
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let j = String(data: data, encoding: .utf8) else { return empty }
    return j
  }
  static let empty = #"{"type":"mic","current":"","devices":[]}"#
  /// The page hears from a read when it asked, or when what it shows changed.
  static func shouldDeliver(asked: Bool, json: String, lastSent: String?) -> Bool { asked || json != lastSent }
}

/// The audio queue's gate: one job per kind waits at a time (a Bluetooth connect fires many changes, and while the
/// audio server does not answer they must not pile up), a job that takes longer than `limit` marks the server as not
/// answering (logged once, then at most once every `quietLog` seconds), and the first job that finishes after that says
/// it answered again. A job asked for while one of its kind runs waits behind it, which is the retry.
struct AudioGate {
  var limit: Double = 2                     // seconds before PS stops waiting for news and uses the last known state
  var quietLog: Double = 300                // at most one "did not answer" line this often
  private(set) var waiting: Set<String> = []
  private(set) var running: (key: String, since: Double, id: Int)?
  /// The audio server is not answering right now: callers use the last known state.
  private(set) var stuck = false
  private var stuckSince: Double = 0
  private var lastSlowLog: Double = -1e9
  private var quietSpells = 0
  private var nextID = 0

  /// Asked for a job of this kind. True: put it on the queue now. False: one is already waiting and will read fresh.
  /// A nil key never merges (a change the person asked for, like picking a microphone).
  mutating func ask(_ key: String?) -> Bool {
    guard let key else { return true }
    return waiting.insert(key).inserted
  }
  /// The queue starts a job. Its id goes to the watchdog.
  mutating func start(_ key: String?, now: Double) -> Int {
    if let key { waiting.remove(key) }
    nextID += 1
    running = (key ?? "change", now, nextID)
    return nextID
  }
  /// The watchdog's look, `limit` seconds after a job started. A line for ps.log, or nil.
  mutating func look(_ id: Int, now: Double) -> String? {
    guard let r = running, r.id == id, !stuck, now - r.since >= limit - 0.001 else { return nil }
    stuck = true; stuckSince = r.since
    if now - lastSlowLog < quietLog { quietSpells += 1; return nil }
    lastSlowLog = now
    let more = quietSpells > 0 ? " (\(quietSpells) more times since the last line)" : ""
    quietSpells = 0
    return "PS audio: the audio server did not answer in \(Self.secs(limit)) (\(r.key)), PS uses the last known state and asks again when it answers" + more
  }
  /// The job finished. A line for ps.log when the server had been marked as not answering, or nil.
  mutating func finish(_ id: Int, now: Double) -> String? {
    guard let r = running, r.id == id else { return nil }
    running = nil
    guard stuck else { return nil }
    stuck = false
    if quietSpells > 0 { return nil }          // a spell that was not logged is not logged as over either
    return "PS audio: the audio server answered again after \(Self.secs(now - stuckSince))"
  }
  static func secs(_ s: Double) -> String { s < 10 ? String(format: "%.1f s", s) : "\(Int(s.rounded())) s" }
}
