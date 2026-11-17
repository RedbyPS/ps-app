// Headphones mode (V1.40 to 1.64) is gone since PS 1.65: Audio priority (AudioPriority.swift, AudioPriorityCore.swift)
// does its job with one ordered list of speakers and one of microphones, the developer's friend, 17 Nov 2026: "I have no
// clue why these are there and what it does, and the auto switch on and off."
//
// What stays here, small:
// - HPRef and HPPrefs: how Headphones mode saved its lists on this Mac ("hpmode.prefs"), read once when Audio priority
//   starts for the first time, so the order the person had becomes the start of the new one (APCore.migrate).
// - HeadphonesMode.claims: the developer's own AirPods routing (AutoRoute.swift) asks it whether PS handles
//   these AirPods; with Audio priority on, it does (output and microphone), so the two never switch against each other.
import AppKit
import CoreAudio

struct HPRef: Codable, Equatable { var uid: String; var name: String }
struct HPPrefs: Codable, Equatable {
  var auto = false
  var spkOut: [HPRef] = []; var spkMic: [HPRef] = []
  var hpOut: [HPRef] = []; var hpMic: [HPRef] = []
  init() {}
  init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    auto = (try? c.decode(Bool.self, forKey: .auto)) ?? false
    func list(_ k: CodingKeys) -> [HPRef] { Array(((try? c.decode([HPRef].self, forKey: k)) ?? []).prefix(8)) }
    spkOut = list(.spkOut); spkMic = list(.spkMic); hpOut = list(.hpOut); hpMic = list(.hpMic)
  }
}
enum HPMode: String { case speakers, headphones }

final class HeadphonesMode {
  static let shared = HeadphonesMode()
  /// For AutoRoute (its own queue): does PS handle these AirPods? Yes for both while Audio priority is on.
  func claims(uid: String, name: String) -> (out: Bool, mic: Bool) {
    let on = AudioPriority.shared.isOnNow
    return (on, on)
  }
}
