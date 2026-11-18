import AVFoundation

// The Tab list's small game sounds, played by the app itself. The floating window never takes
// focus, which is exactly where browser audio refuses to start, so the page asks for a sound by
// name ({"type":"sfx","name":"hover","vol":0.4}) and this plays it. The sounds are made here as
// tiny WAVs (same recipe as the website's src/ui/sfx.ts), three players each so fast hovers overlap.
final class Sfx {
  static let shared = Sfx()
  private var players: [String: [AVAudioPlayer]] = [:]
  private var next: [String: Int] = [:]

  struct Tone { let f: Double; let to: Double?; let dur: Double; let peak: Double; let wave: Int; let at: Double }  // wave: 0 sine, 1 triangle, 2 square
  static let specs: [String: [Tone]] = [
    "hover": [Tone(f: 2400, to: 1700, dur: 0.028, peak: 0.10, wave: 1, at: 0)],
    "click": [Tone(f: 1300, to: 700, dur: 0.04, peak: 0.22, wave: 2, at: 0), Tone(f: 160, to: nil, dur: 0.05, peak: 0.25, wave: 0, at: 0)],
    "done": [Tone(f: 880, to: nil, dur: 0.09, peak: 0.18, wave: 1, at: 0), Tone(f: 1320, to: nil, dur: 0.14, peak: 0.18, wave: 1, at: 0.07)],
    "drop": [Tone(f: 520, to: 780, dur: 0.06, peak: 0.2, wave: 1, at: 0)],
    // The tick sounds the developer can pick (V1.34, Settings, To do list; web src/core/ticksound.ts, the same tones). "done" is Classic.
    "done-pop": [Tone(f: 520, to: 1250, dur: 0.06, peak: 0.32, wave: 0, at: 0), Tone(f: 1900, to: 1500, dur: 0.025, peak: 0.08, wave: 1, at: 0.045)],
    "done-sparkle": [Tone(f: 1568, to: nil, dur: 0.08, peak: 0.12, wave: 0, at: 0), Tone(f: 2093, to: nil, dur: 0.09, peak: 0.12, wave: 0, at: 0.05),
                     Tone(f: 2637, to: nil, dur: 0.22, peak: 0.12, wave: 0, at: 0.1)],
    "done-marimba": [Tone(f: 523.25, to: nil, dur: 0.28, peak: 0.3, wave: 0, at: 0), Tone(f: 2093, to: nil, dur: 0.05, peak: 0.07, wave: 0, at: 0),
                     Tone(f: 784, to: nil, dur: 0.3, peak: 0.24, wave: 0, at: 0.09)],
    "done-rise": [Tone(f: 330, to: 990, dur: 0.12, peak: 0.16, wave: 1, at: 0), Tone(f: 1480, to: nil, dur: 0.16, peak: 0.12, wave: 0, at: 0.11)],
    "done-bell": [Tone(f: 1760, to: nil, dur: 0.7, peak: 0.12, wave: 0, at: 0), Tone(f: 2640, to: nil, dur: 0.45, peak: 0.05, wave: 0, at: 0),
                  Tone(f: 880, to: nil, dur: 0.6, peak: 0.06, wave: 0, at: 0)],
    // Meeting alerts: a bright two note rise (booked), an urgent double knock (a lead wrote before a call), a soft bell (10 minutes).
    "meet-booked": [Tone(f: 660, to: nil, dur: 0.12, peak: 0.2, wave: 1, at: 0), Tone(f: 990, to: nil, dur: 0.2, peak: 0.2, wave: 1, at: 0.1)],
    "meet-alert": [Tone(f: 740, to: 700, dur: 0.12, peak: 0.3, wave: 1, at: 0), Tone(f: 740, to: 700, dur: 0.12, peak: 0.3, wave: 1, at: 0.18), Tone(f: 180, to: nil, dur: 0.1, peak: 0.25, wave: 0, at: 0)],
    "meet-soon": [Tone(f: 1180, to: nil, dur: 0.35, peak: 0.12, wave: 0, at: 0)],
    // A notification card from Claude (a chat finished, or came back from Remind me in): a soft glass chime, three rising notes.
    "chime": [Tone(f: 1318.5, to: nil, dur: 0.55, peak: 0.13, wave: 0, at: 0), Tone(f: 1661.2, to: nil, dur: 0.6, peak: 0.11, wave: 0, at: 0.075),
              Tone(f: 1975.5, to: nil, dur: 0.9, peak: 0.12, wave: 0, at: 0.15), Tone(f: 659.3, to: nil, dur: 0.5, peak: 0.05, wave: 0, at: 0)],
    // Notification sounds the developer can pick per kind of card (V1.36, Settings, Notifications; web src/core/notelook.ts,
    // the same tones). "chime" above is Glass, and the three meeting sounds can be picked too.
    "note-harp": [Tone(f: 1046.5, to: nil, dur: 0.5, peak: 0.12, wave: 0, at: 0), Tone(f: 1318.5, to: nil, dur: 0.5, peak: 0.11, wave: 0, at: 0.06),
                  Tone(f: 1568, to: nil, dur: 0.55, peak: 0.1, wave: 0, at: 0.12), Tone(f: 2093, to: nil, dur: 0.8, peak: 0.1, wave: 0, at: 0.18)],
    "note-ding": [Tone(f: 1568, to: nil, dur: 1.1, peak: 0.13, wave: 0, at: 0), Tone(f: 4327.7, to: nil, dur: 0.35, peak: 0.03, wave: 0, at: 0),
                  Tone(f: 784, to: nil, dur: 0.8, peak: 0.05, wave: 0, at: 0)],
    "note-marimba": [Tone(f: 783.99, to: nil, dur: 0.3, peak: 0.26, wave: 0, at: 0), Tone(f: 3136, to: nil, dur: 0.04, peak: 0.05, wave: 0, at: 0),
                     Tone(f: 1046.5, to: nil, dur: 0.38, peak: 0.24, wave: 0, at: 0.12), Tone(f: 4186, to: nil, dur: 0.04, peak: 0.04, wave: 0, at: 0.12)],
    "note-drop": [Tone(f: 900, to: 1900, dur: 0.09, peak: 0.2, wave: 0, at: 0), Tone(f: 1400, to: 2500, dur: 0.08, peak: 0.12, wave: 0, at: 0.14)],
    "note-twinkle": [Tone(f: 2637, to: nil, dur: 0.16, peak: 0.08, wave: 0, at: 0), Tone(f: 3136, to: nil, dur: 0.16, peak: 0.08, wave: 0, at: 0.07),
                     Tone(f: 3951, to: nil, dur: 0.18, peak: 0.07, wave: 0, at: 0.14), Tone(f: 3520, to: nil, dur: 0.4, peak: 0.07, wave: 0, at: 0.21)],
    // PS 1.67 Hatch (Hatch.swift, ui/hatch.html, the demo the developer picked): short and quiet, played at HatchCore.volume and only when
    // the island's sound switch, Do Not Disturb and private mode allow. wave 3 is the soft noise (a crack, a whoosh, a thud's body).
    "hatch-tick0": [Tone(f: 523.25, to: nil, dur: 0.14, peak: 0.05, wave: 1, at: 0), Tone(f: 1046.5, to: nil, dur: 0.08, peak: 0.012, wave: 0, at: 0)],
    "hatch-tick1": [Tone(f: 659.25, to: nil, dur: 0.14, peak: 0.05, wave: 1, at: 0), Tone(f: 1318.5, to: nil, dur: 0.08, peak: 0.012, wave: 0, at: 0)],
    "hatch-tick2": [Tone(f: 783.99, to: nil, dur: 0.14, peak: 0.05, wave: 1, at: 0), Tone(f: 1568, to: nil, dur: 0.08, peak: 0.012, wave: 0, at: 0)],
    "hatch-tick3": [Tone(f: 1046.5, to: nil, dur: 0.14, peak: 0.05, wave: 1, at: 0), Tone(f: 2093, to: nil, dur: 0.08, peak: 0.012, wave: 0, at: 0)],
    "hatch-tick4": [Tone(f: 1318.5, to: nil, dur: 0.14, peak: 0.05, wave: 1, at: 0), Tone(f: 2637, to: nil, dur: 0.08, peak: 0.012, wave: 0, at: 0)],
    "hatch-chime": [Tone(f: 523.25, to: nil, dur: 1.0, peak: 0.08, wave: 0, at: 0), Tone(f: 659.25, to: nil, dur: 1.0, peak: 0.08, wave: 0, at: 0.075),
                    Tone(f: 783.99, to: nil, dur: 1.0, peak: 0.08, wave: 0, at: 0.15), Tone(f: 1046.5, to: nil, dur: 1.0, peak: 0.07, wave: 0, at: 0.225),
                    Tone(f: 1318.5, to: nil, dur: 1.1, peak: 0.06, wave: 0, at: 0.3)],
    "hatch-crack": [Tone(f: 3200, to: 3000, dur: 0.05, peak: 0.14, wave: 3, at: 0), Tone(f: 2700, to: 1700, dur: 0.06, peak: 0.05, wave: 1, at: 0),
                    Tone(f: 4100, to: 3900, dur: 0.05, peak: 0.14, wave: 3, at: 0.21), Tone(f: 2350, to: 1700, dur: 0.06, peak: 0.05, wave: 1, at: 0.21),
                    Tone(f: 5000, to: 4800, dur: 0.05, peak: 0.14, wave: 3, at: 0.47), Tone(f: 2000, to: 1700, dur: 0.06, peak: 0.05, wave: 1, at: 0.47)],
    "hatch-whistle": [Tone(f: 1150, to: 280, dur: 0.5, peak: 0.05, wave: 0, at: 0)],
    "hatch-thud": [Tone(f: 150, to: 42, dur: 0.38, peak: 0.45, wave: 0, at: 0), Tone(f: 520, to: 120, dur: 0.2, peak: 0.22, wave: 3, at: 0)],
    "hatch-bloop": [Tone(f: 230, to: 920, dur: 0.2, peak: 0.16, wave: 0, at: 0), Tone(f: 1250, to: 1650, dur: 0.06, peak: 0.04, wave: 1, at: 0.16)],
    "hatch-gulp": [Tone(f: 720, to: 210, dur: 0.16, peak: 0.14, wave: 0, at: 0), Tone(f: 330, to: 680, dur: 0.14, peak: 0.09, wave: 0, at: 0.12),
                   Tone(f: 1318.5, to: nil, dur: 0.6, peak: 0.045, wave: 0, at: 0.22), Tone(f: 1975.5, to: nil, dur: 0.7, peak: 0.03, wave: 0, at: 0.3)],
    "hatch-burst": [Tone(f: 95, to: 38, dur: 0.55, peak: 0.3, wave: 0, at: 0), Tone(f: 1900, to: 280, dur: 0.45, peak: 0.1, wave: 3, at: 0),
                    Tone(f: 1568, to: nil, dur: 0.28, peak: 0.03, wave: 0, at: 0.05), Tone(f: 2093, to: nil, dur: 0.28, peak: 0.03, wave: 0, at: 0.1),
                    Tone(f: 2637, to: nil, dur: 0.28, peak: 0.03, wave: 0, at: 0.15), Tone(f: 3136, to: nil, dur: 0.28, peak: 0.025, wave: 0, at: 0.2)],
    "hatch-digits": [Tone(f: 1700, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 0), Tone(f: 1760, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 0.06),
                     Tone(f: 1820, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 0.13), Tone(f: 1880, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 0.21),
                     Tone(f: 1940, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 0.31), Tone(f: 2000, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 0.43),
                     Tone(f: 2060, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 0.58), Tone(f: 2120, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 0.78),
                     Tone(f: 2180, to: nil, dur: 0.02, peak: 0.02, wave: 2, at: 1.05)],
    "hatch-land": [Tone(f: 1568, to: nil, dur: 0.7, peak: 0.06, wave: 0, at: 0), Tone(f: 2093, to: nil, dur: 0.9, peak: 0.05, wave: 0, at: 0.08)],
    "hatch-shrink": [Tone(f: 620, to: 1500, dur: 0.14, peak: 0.07, wave: 0, at: 0)],
    "hatch-drop": [Tone(f: 900, to: 320, dur: 0.35, peak: 0.06, wave: 0, at: 0)],
    "hatch-whoosh": [Tone(f: 280, to: 2600, dur: 0.6, peak: 0.08, wave: 3, at: 0)],
    "plop": [Tone(f: 420, to: 140, dur: 0.11, peak: 0.32, wave: 0, at: 0), Tone(f: 900, to: 600, dur: 0.03, peak: 0.08, wave: 1, at: 0.005)],
    // V1.56 the Edit overview's sounds (web src/core/editsounds.ts, the same numbers; the page only asks for
    // one when "Edit mode sounds" is on, the volume is up, Do Not Disturb lets sounds through and no meeting is on).
    // wave 3: soft noise, a band sliding from f to `to` (a whoosh), swelling in over its first third.
    "edit-in": [Tone(f: 1800, to: 520, dur: 0.32, peak: 0.07, wave: 3, at: 0), Tone(f: 520, to: 340, dur: 0.22, peak: 0.05, wave: 0, at: 0.04)],
    "edit-out": [Tone(f: 520, to: 1900, dur: 0.3, peak: 0.07, wave: 3, at: 0), Tone(f: 340, to: 560, dur: 0.2, peak: 0.05, wave: 0, at: 0.06)],
    "edit-fly": [Tone(f: 420, to: 2600, dur: 0.34, peak: 0.08, wave: 3, at: 0), Tone(f: 660, to: 990, dur: 0.14, peak: 0.05, wave: 1, at: 0.2)],
    "edit-tick": [Tone(f: 1900, to: 1500, dur: 0.018, peak: 0.045, wave: 1, at: 0)],
    "edit-drop": [Tone(f: 300, to: 180, dur: 0.09, peak: 0.16, wave: 0, at: 0), Tone(f: 1200, to: 900, dur: 0.03, peak: 0.04, wave: 1, at: 0)],
    "edit-page-add": [Tone(f: 520, to: 880, dur: 0.12, peak: 0.12, wave: 0, at: 0), Tone(f: 1320, to: nil, dur: 0.14, peak: 0.06, wave: 0, at: 0.08)],
    "edit-page-remove": [Tone(f: 700, to: 300, dur: 0.16, peak: 0.1, wave: 0, at: 0), Tone(f: 1200, to: 400, dur: 0.14, peak: 0.03, wave: 3, at: 0)],
    "edit-save": [Tone(f: 784, to: nil, dur: 0.18, peak: 0.09, wave: 0, at: 0), Tone(f: 1175, to: nil, dur: 0.22, peak: 0.08, wave: 0, at: 0.07)],
    "edit-switch": [Tone(f: 900, to: 1600, dur: 0.25, peak: 0.05, wave: 3, at: 0), Tone(f: 660, to: nil, dur: 0.16, peak: 0.07, wave: 0, at: 0.1), Tone(f: 990, to: nil, dur: 0.2, peak: 0.06, wave: 0, at: 0.16)],
    // V1.58 the island's timers (IslandTimers.swift IslandChime; web src/core/islandtimers.ts ISLAND_TONES, the
    // same numbers): "done" with the green tick (a quick bright rise into a soft bell), "start" as a break or stand-up begins.
    "island-done": [Tone(f: 783.99, to: nil, dur: 0.16, peak: 0.09, wave: 1, at: 0), Tone(f: 987.77, to: nil, dur: 0.16, peak: 0.09, wave: 1, at: 0.08),
                    Tone(f: 1174.66, to: nil, dur: 0.18, peak: 0.09, wave: 1, at: 0.16), Tone(f: 1567.98, to: nil, dur: 0.95, peak: 0.1, wave: 0, at: 0.24),
                    Tone(f: 3135.96, to: nil, dur: 0.3, peak: 0.025, wave: 0, at: 0.25), Tone(f: 392, to: nil, dur: 0.7, peak: 0.04, wave: 0, at: 0.24)],
    "island-start": [Tone(f: 1174.66, to: 1108.73, dur: 0.38, peak: 0.08, wave: 0, at: 0), Tone(f: 880, to: 830.61, dur: 0.55, peak: 0.08, wave: 0, at: 0.13),
                     Tone(f: 440, to: nil, dur: 0.5, peak: 0.03, wave: 0, at: 0.13)],
    // V1.65 Time zones (web src/core/tzfocus.ts TZ_TONES, the same numbers): a zone opened tall, back to the list, the 30 minute arrows.
    "tz-open": [Tone(f: 880, to: nil, dur: 0.32, peak: 0.07, wave: 0, at: 0), Tone(f: 1318.51, to: nil, dur: 0.5, peak: 0.06, wave: 0, at: 0.07),
                Tone(f: 2637.02, to: nil, dur: 0.35, peak: 0.015, wave: 0, at: 0.08)],
    "tz-back": [Tone(f: 1046.5, to: 784, dur: 0.22, peak: 0.05, wave: 0, at: 0)],
    "tz-up": [Tone(f: 2200, to: 2600, dur: 0.022, peak: 0.05, wave: 1, at: 0)],
    "tz-down": [Tone(f: 1900, to: 1500, dur: 0.022, peak: 0.05, wave: 1, at: 0)],
    // PS 1.65 Audio priority (web src/core/audiopriority.ts AP_TONES, the same numbers): a device row picked up, passing a
    // place, settling, used now, forgotten.
    "ap-lift": [Tone(f: 520, to: 660, dur: 0.07, peak: 0.05, wave: 0, at: 0)],
    "ap-slot": [Tone(f: 1760, to: 1600, dur: 0.018, peak: 0.025, wave: 1, at: 0)],
    "ap-drop": [Tone(f: 660, to: 440, dur: 0.09, peak: 0.06, wave: 0, at: 0), Tone(f: 1320, to: nil, dur: 0.05, peak: 0.015, wave: 0, at: 0.01)],
    "ap-use": [Tone(f: 784, to: nil, dur: 0.18, peak: 0.05, wave: 0, at: 0), Tone(f: 1174.66, to: nil, dur: 0.3, peak: 0.045, wave: 0, at: 0.06)],
    "ap-forget": [Tone(f: 880, to: 520, dur: 0.16, peak: 0.04, wave: 0, at: 0)],
    // PS 1.65 the Activity monitor (web src/core/activitymon.ts AM_SOUNDS, the same numbers): opening (a rising whoosh with a soft
    // two note lift), closing (it falls back), a tab (a tiny tick) and End task (a low soft thud). Short and quiet on purpose.
    "am-open": [Tone(f: 900, to: 2400, dur: 0.26, peak: 0.05, wave: 3, at: 0), Tone(f: 523.25, to: 784, dur: 0.16, peak: 0.06, wave: 0, at: 0.05), Tone(f: 1568, to: nil, dur: 0.22, peak: 0.035, wave: 0, at: 0.17)],
    "am-close": [Tone(f: 2200, to: 700, dur: 0.24, peak: 0.045, wave: 3, at: 0), Tone(f: 784, to: 440, dur: 0.18, peak: 0.05, wave: 0, at: 0.04)],
    "am-tab": [Tone(f: 1760, to: 1480, dur: 0.03, peak: 0.04, wave: 1, at: 0)],
    "am-end": [Tone(f: 330, to: 140, dur: 0.16, peak: 0.12, wave: 0, at: 0), Tone(f: 1200, to: 600, dur: 0.06, peak: 0.03, wave: 1, at: 0.01)],
    // PS 1.65 voice capture (web src/core/voicecapture.ts VOICE_TONES, the same numbers): starts listening, stops.
    "voice-start": [Tone(f: 660, to: nil, dur: 0.12, peak: 0.06, wave: 0, at: 0), Tone(f: 990, to: nil, dur: 0.18, peak: 0.055, wave: 0, at: 0.07)],
    "voice-stop": [Tone(f: 990, to: nil, dur: 0.12, peak: 0.05, wave: 0, at: 0), Tone(f: 660, to: nil, dur: 0.2, peak: 0.05, wave: 0, at: 0.07)],
    "edit-reset": [Tone(f: 880, to: 440, dur: 0.3, peak: 0.08, wave: 0, at: 0), Tone(f: 1500, to: 300, dur: 0.28, peak: 0.04, wave: 3, at: 0)],
  ]

  init() {
    for (name, tones) in Sfx.specs {
      let data = Sfx.wav(tones)
      players[name] = (0..<3).compactMap { _ in
        let p = try? AVAudioPlayer(data: data)
        p?.prepareToPlay()
        return p
      }
    }
  }

  func play(_ name: String, volume: Double) {
    guard volume > 0, let list = players[name], !list.isEmpty else { return }
    if DND.cardSounds.contains(name) && DND.shared.mutes("sounds") { return }   // Do Not Disturb (DND.swift): card sounds only
    if testOnly { playLog.append(name); return }   // a self test copy never makes a sound (it only writes the name down)
    let i = (next[name] ?? 0) % list.count
    next[name] = i + 1
    let p = list[i]
    p.volume = Float(max(0, min(1, volume)))
    p.currentTime = 0
    p.play()
  }

  // ---------- thunder for the Tab list's lightning backgrounds (the developer, 18 Oct 2026) ----------
  // Filtered noise made once on first use: "thunder-crack" (close), "thunder-roll", "thunder-far".
  // At most one at a time (a new one waits its turn by being skipped), swells in, never above 60%.
  private var thunderPlayers: [String: AVAudioPlayer] = [:]
  private var thunderUntil = Date.distantPast
  /// Self test: thunder is only written down (name and volume), never played out loud.
  var testOnly = false
  /// Self test: the sounds that would have played, in order (card sounds and the rest).
  private(set) var playLog: [String] = []
  func clearPlayLog() { playLog = [] }
  private(set) var thunderLog: [String] = []
  func clearThunderLog() { thunderLog = [] }
  func thunder(_ name: String, volume: Double) {
    guard volume > 0, Date() >= thunderUntil else { return }
    let spec: (dur: Double, attack: Double, smooth: Double, crack: Bool)
    switch name {
    case "thunder-crack": spec = (2.6, 0.03, 0.08, true)
    case "thunder-far": spec = (3.6, 0.5, 0.015, false)
    case "thunder-roll": spec = (3.0, 0.25, 0.03, false)
    default: return
    }
    if testOnly {
      thunderLog.append(String(format: "%@@%.2f", name, Float(min(0.6, max(0, volume)) * 0.7)))
      thunderUntil = Date().addingTimeInterval(spec.dur)
      return
    }
    if thunderPlayers[name] == nil, let p = try? AVAudioPlayer(data: Sfx.noiseWav(dur: spec.dur, attack: spec.attack, smooth: spec.smooth, crack: spec.crack)) {
      p.prepareToPlay(); thunderPlayers[name] = p
    }
    guard let p = thunderPlayers[name] else { return }
    p.volume = Float(min(0.6, max(0, volume)) * 0.7)
    p.currentTime = 0
    p.play()
    thunderUntil = Date().addingTimeInterval(spec.dur)
  }
  /// Low-passed noise with a slow swell and a long fade (plus a short bright crackle for "crack").
  static func noiseWav(dur: Double, attack: Double, smooth: Double, crack: Bool) -> Data {
    let sr = 44100.0, n = Int(dur * sr)
    var buf = [Double](repeating: 0, count: n)
    var b = 0.0, peak = 0.0
    for i in 0..<n {
      let x = Double(i) / sr
      b = (1 - smooth) * b + smooth * Double.random(in: -1...1)
      let env = x < attack ? x / attack : exp(-3.2 * (x - attack) / max(0.01, dur - attack))
      var v = b * env * (1 + 0.5 * sin(x * 9))
      if crack && x < 0.25 { v += Double.random(in: -1...1) * exp(-x / 0.05) * 0.35 }
      buf[i] = v; peak = max(peak, abs(v))
    }
    let k = peak > 0 ? 0.9 / peak : 1
    var d = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + n * 2)); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(44100); u32(88200); u16(2); u16(16)
    d.append(contentsOf: Array("data".utf8)); u32(UInt32(n * 2))
    for v in buf { u16(UInt16(bitPattern: Int16(max(-1, min(1, v * k)) * 32767))) }
    return d
  }

  static func wav(_ tones: [Tone]) -> Data {
    let sr = 44100.0
    let total = (tones.map { $0.at + $0.dur }.max() ?? 0.05) + 0.02
    let n = Int(total * sr)
    var buf = [Double](repeating: 0, count: n)
    for t in tones {
      var phase = 0.0
      var low = 0.0, band = 0.0                                    // wave 3: a state variable band pass over noise
      let start = Int(t.at * sr), len = Int(t.dur * sr)
      for i in 0..<len where start + i < n {
        let x = Double(i) / sr
        let f = t.to.map { t.f * pow($0 / t.f, x / t.dur) } ?? t.f   // smooth slide, like exponentialRamp
        phase += f / sr
        let p = phase - floor(phase)
        let w: Double
        if t.wave == 3 {
          let k = 2 * sin(.pi * min(f, sr / 6) / sr)
          low += k * band
          let high = Double.random(in: -1...1) - low - 1.1 * band
          band += k * high
          w = band * 2.2
        } else {
          w = t.wave == 0 ? sin(2 * .pi * p) : t.wave == 1 ? 4 * abs(p - 0.5) - 1 : (p < 0.5 ? 1.0 : -1.0)
        }
        let attack = t.wave == 3 ? t.dur * 0.35 : 0.004
        let env = x < attack ? x / attack : exp(-6.9 * (x - attack) / max(0.001, t.dur - attack))
        buf[start + i] += w * env * t.peak
      }
    }
    var d = Data()
    func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + n * 2)); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(44100); u32(88200); u16(2); u16(16)
    d.append(contentsOf: Array("data".utf8)); u32(UInt32(n * 2))
    for v in buf { u16(UInt16(bitPattern: Int16(max(-1, min(1, v)) * 32767))) }
    return d
  }
}
