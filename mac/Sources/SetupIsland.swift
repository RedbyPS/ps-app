// The island as a live guide through first time setup (V1.58), the part on screen. The rules are in
// SetupIslandCore.swift; this draws them, plays the sounds and listens to the setup screens.
//
// Its own small window at the island's spot, so it can show before PS's page has loaded (the real island needs the
// page) and never changes how the real island works. It is born out of the install screen: big, a green tick on the
// left and "I'm here to help" with a chime, then it travels up to the top, squashes a little and springs back, and
// shows the first step. Each step: a short hint with a bounce and a soft blip; a blip again only after a quiet pause.
// Done right: a green tick and a chime. All done: a happy moment, then it shrinks into the island's normal look and
// the real island (with the first task) takes over. While something loads (setup or start up) it morphs into a
// rounded square with a spinner and a small label, and back.
//
// Never in the way: no window of its own takes focus, clicks pass through except on its buttons, Esc hides the hint,
// Skip and Close are on it, it stands aside while 1Password or Signal is in front, Reduce Motion gets fades instead of
// travel and wiggles, and if the island is switched off (or this window cannot show) setup works exactly as before.
//
// Sounds: original short tones made here (SetupIslandSound). The Pomodoro chat's shared green tick and chime were not
// on its branch when this was built: swap them in at SetupIslandSound.chime and SetupTickMark if they land.
import AppKit
import AVFoundation
import SwiftUI

// MARK: - sounds

enum SetupIslandSound {
  typealias Tone = Sfx.Tone
  /// Attention: a soft "bleep bloop" (up, then down).
  static let blip: [Tone] = [Tone(f: 988, to: 1245, dur: 0.07, peak: 0.15, wave: 0, at: 0),
                             Tone(f: 784, to: 587, dur: 0.1, peak: 0.13, wave: 0, at: 0.09)]
  /// Done right: a bright two note chime with a little shimmer. SWAP POINT for the shared Pomodoro chime.
  static let chime: [Tone] = [Tone(f: 1046.5, to: nil, dur: 0.2, peak: 0.16, wave: 0, at: 0),
                              Tone(f: 1568, to: nil, dur: 0.5, peak: 0.14, wave: 0, at: 0.09),
                              Tone(f: 3136, to: nil, dur: 0.25, peak: 0.03, wave: 0, at: 0.09)]
  /// The happy moment: four notes rising.
  static let finale: [Tone] = [Tone(f: 784, to: nil, dur: 0.18, peak: 0.13, wave: 0, at: 0),
                               Tone(f: 988, to: nil, dur: 0.18, peak: 0.13, wave: 0, at: 0.08),
                               Tone(f: 1175, to: nil, dur: 0.2, peak: 0.13, wave: 0, at: 0.16),
                               Tone(f: 1568, to: nil, dur: 0.7, peak: 0.14, wave: 0, at: 0.24),
                               Tone(f: 2349, to: nil, dur: 0.4, peak: 0.03, wave: 0, at: 0.24)]
}

// MARK: - the model and the view

final class SetupIslandModel: ObservableObject {
  enum Look: Equatable { case hidden, born, travel, hint, tick, loading, finale, handoff, whatsNew }
  @Published var look: Look = .hidden
  @Published var title = ""
  @Published var sub = ""
  @Published var praise = ""
  @Published var loadLabel = ""
  @Published var tickDraw: CGFloat = 0
  @Published var sx: CGFloat = 1
  @Published var sy: CGFloat = 1
  @Published var shake: CGFloat = 0
  @Published var ring: CGFloat = 0
  @Published var sparkle: CGFloat = 0
  @Published var soundOn = true
  @Published var handoffSize = CGSize(width: 330, height: 34)
  @Published var hover: String?            // the button under the pointer (no @State: built without SwiftUI's macros)
  var reduce: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  var skip: () -> Void = {}
  var close: () -> Void = {}
  var toggleSound: () -> Void = {}

  /// Slightly bigger than the island's usual 330 by 34 while it guides, so the hint reads at a glance.
  var size: CGSize {
    switch look {
    case .hidden: return CGSize(width: 330, height: 34)
    case .born, .finale: return CGSize(width: 420, height: 104)
    case .travel, .hint: return CGSize(width: 452, height: 58)
    case .tick, .whatsNew: return CGSize(width: 300, height: 52)
    case .loading: return CGSize(width: 132, height: 132)
    case .handoff: return handoffSize
    }
  }
  var radius: CGFloat { look == .loading ? 38 : size.height / 2 }
}

/// The green tick: a green disc and a white check that draws itself. SWAP POINT for the shared Pomodoro tick.
struct SetupTickMark: View {
  var size: CGFloat
  var draw: CGFloat
  var body: some View {
    ZStack {
      Circle().fill(LinearGradient(colors: [Color(red: 0.30, green: 0.86, blue: 0.45), Color(red: 0.13, green: 0.68, blue: 0.32)],
                                   startPoint: .top, endPoint: .bottom))
        .shadow(color: Color.green.opacity(0.45), radius: size * 0.18)
      Path { p in
        p.move(to: CGPoint(x: size * 0.28, y: size * 0.52))
        p.addLine(to: CGPoint(x: size * 0.44, y: size * 0.67))
        p.addLine(to: CGPoint(x: size * 0.73, y: size * 0.36))
      }
      .trim(from: 0, to: draw)
      .stroke(Color.white, style: StrokeStyle(lineWidth: max(2.5, size * 0.1), lineCap: .round, lineJoin: .round))
    }
    .frame(width: size, height: size)
    .scaleEffect(0.6 + 0.4 * min(1, draw * 1.6))
  }
}

/// A side to side wiggle that always ends where it started (one unit of `amount` = two quick swings).
struct SetupShake: GeometryEffect {
  var amount: CGFloat
  var animatableData: CGFloat { get { amount } set { amount = newValue } }
  func effectValue(size: CGSize) -> ProjectionTransform {
    let x = sin(amount * .pi * 4) * 7
    return ProjectionTransform(CGAffineTransform(translationX: x, y: 0))
  }
}

/// Turns by the clock (no @State: built without SwiftUI's macros). Reduce Motion: slower.
struct SetupSpinner: View {
  var slow: Bool
  var body: some View {
    TimelineView(.animation) { t in
      let turn = t.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: slow ? 1.6 : 0.9) / (slow ? 1.6 : 0.9)
      Circle().trim(from: 0.08, to: 0.78)
        .stroke(AngularGradient(colors: [Color.white.opacity(0.05), Color.white], center: .center),
                style: StrokeStyle(lineWidth: 4, lineCap: .round))
        .frame(width: 38, height: 38)
        .rotationEffect(.degrees(turn * 360))
    }
  }
}

struct SetupIslandView: View {
  @ObservedObject var m: SetupIslandModel
  static let inset: CGFloat = 6

  var body: some View {
    VStack(spacing: 0) {
      ZStack {
        RoundedRectangle(cornerRadius: m.radius, style: .continuous)
          .fill(Color.black)
          .overlay(RoundedRectangle(cornerRadius: m.radius, style: .continuous).stroke(Color.white.opacity(0.1), lineWidth: 1))
          .shadow(color: Color.black.opacity(m.look == .hidden ? 0 : 0.35), radius: 14, y: 6)
        // The attention ring: a soft pink outline that grows and fades.
        RoundedRectangle(cornerRadius: m.radius, style: .continuous)
          .stroke(Color(red: 0.93, green: 0.31, blue: 0.53), lineWidth: 2)
          .scaleEffect(1 + m.ring * (m.reduce ? 0 : 0.14))
          .opacity(m.ring > 0 && m.ring < 1 ? Double(1 - m.ring) * 0.9 : 0)
        content.transition(.opacity).id(m.look)
      }
      .frame(width: m.size.width, height: m.size.height)
      .scaleEffect(x: m.sx, y: m.sy, anchor: .top)
      .modifier(SetupShake(amount: m.shake))
      .opacity(m.look == .hidden ? 0 : 1)
      Spacer(minLength: 0)
    }
    .padding(.top, SetupIslandView.inset)
    .frame(width: SetupIsland.panelW, height: SetupIsland.panelH)
    .environment(\.colorScheme, .dark)
  }

  @ViewBuilder var content: some View {
    switch m.look {
    case .born, .finale:
      HStack(spacing: 16) {
        SetupTickMark(size: 56, draw: m.tickDraw)
        VStack(alignment: .leading, spacing: 3) {
          Text(m.title).font(.system(size: 23, weight: .semibold, design: .rounded)).foregroundColor(.white).lineLimit(1).minimumScaleFactor(0.8)
          if !m.sub.isEmpty { Text(m.sub).font(.system(size: 12.5, weight: .medium)).foregroundColor(Color.white.opacity(0.62)).lineLimit(1).minimumScaleFactor(0.8) }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 24)
      .overlay(sparkles)
    case .hint:
      HStack(spacing: 12) {
        Circle().fill(Color(red: 0.93, green: 0.31, blue: 0.53)).frame(width: 8, height: 8)
          .shadow(color: Color(red: 0.93, green: 0.31, blue: 0.53).opacity(0.8), radius: 4)
        VStack(alignment: .leading, spacing: 1) {
          Text(m.title).font(.system(size: 14.5, weight: .semibold, design: .rounded)).foregroundColor(.white).lineLimit(1).minimumScaleFactor(0.85)
          Text(m.sub).font(.system(size: 11.5)).foregroundColor(Color.white.opacity(0.6)).lineLimit(1).minimumScaleFactor(0.8)
        }
        Spacer(minLength: 4)
        HStack(spacing: 2) {
          SetupIslandButton(m: m, id: "skip", label: "Skip", help: "Skip this step") { m.skip() }
          SetupIslandButton(m: m, id: "sound", icon: m.soundOn ? "speaker.wave.2.fill" : "speaker.slash.fill", help: m.soundOn ? "Sounds off" : "Sounds on") { m.toggleSound() }
          SetupIslandButton(m: m, id: "close", icon: "xmark", help: "Close the setup guide") { m.close() }
        }
      }
      .padding(.leading, 20).padding(.trailing, 10)
    case .tick:
      HStack(spacing: 10) {
        SetupTickMark(size: 28, draw: m.tickDraw)
        Text(m.praise).font(.system(size: 14.5, weight: .semibold, design: .rounded)).foregroundColor(.white).lineLimit(1).minimumScaleFactor(0.8)
      }
      .padding(.horizontal, 16)
    case .loading:
      VStack(spacing: 0) {
        Text(m.loadLabel).font(.system(size: 10.5, weight: .semibold)).foregroundColor(Color.white.opacity(0.7))
          .lineLimit(2).multilineTextAlignment(.center).minimumScaleFactor(0.8).padding(.top, 16).padding(.horizontal, 12)
        Spacer(minLength: 0)
        SetupSpinner(slow: m.reduce)
        Spacer(minLength: 0)
      }
      .padding(.bottom, 10)
    case .whatsNew:
      // PS 1.60: the island says "What's new" before the panel comes out of it (the same black, no new colour).
      HStack(spacing: 10) {
        Image(systemName: "sparkles").font(.system(size: 18, weight: .semibold)).foregroundColor(Color(red: 1.0, green: 0.62, blue: 0.75))
          .scaleEffect(0.7 + 0.3 * min(1, m.tickDraw * 1.6))
        Text(m.praise).font(.system(size: 14.5, weight: .semibold, design: .rounded)).foregroundColor(.white).lineLimit(1).minimumScaleFactor(0.8)
      }
      .padding(.horizontal, 16)
    case .hidden, .travel, .handoff:
      Color.clear
    }
  }

  /// A few small dots bursting out at the happy moment (none under Reduce Motion).
  @ViewBuilder var sparkles: some View {
    if !m.reduce && m.sparkle > 0 {
      ZStack {
        ForEach(0..<10, id: \.self) { i in
          let a = Double(i) / 10 * 2 * .pi
          Circle().fill([Color.green, Color.white, Color(red: 0.93, green: 0.31, blue: 0.53)][i % 3])
            .frame(width: 5, height: 5)
            .offset(x: cos(a) * 46 * m.sparkle, y: sin(a) * 46 * m.sparkle)
            .opacity(Double(1 - m.sparkle))
        }
      }
      .frame(width: 56, height: 56)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.leading, 24)
      .allowsHitTesting(false)
    }
  }
}

struct SetupIslandButton: View {
  @ObservedObject var m: SetupIslandModel
  var id: String
  var label: String? = nil
  var icon: String? = nil
  var help: String
  var action: () -> Void
  var over: Bool { m.hover == id }
  var body: some View {
    Button(action: action) {
      Group {
        if let label { Text(label).font(.system(size: 11.5, weight: .semibold)) }
        else if let icon { Image(systemName: icon).font(.system(size: 10.5, weight: .semibold)) }
      }
      .foregroundColor(Color.white.opacity(over ? 0.95 : 0.55))
      .padding(.horizontal, label == nil ? 7 : 9).frame(height: 26)
      .background(Capsule().fill(Color.white.opacity(over ? 0.14 : 0.0)))
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .help(help)
    .accessibilityLabel(help)
    .onHover { on in if on { m.hover = id } else if m.hover == id { m.hover = nil } }
  }
}

final class SetupIslandPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

// MARK: - the controller

final class SetupIsland {
  static let shared = SetupIsland()
  static let panelW: CGFloat = 560, panelH: CGFloat = 176
  static let savedKey = "setupIsland.saved"
  /// The island's on or off, as the page last said (so the next start up knows before the page loads).
  static let modeKey = "setupIsland.islandMode"

  let model = SetupIslandModel()
  private let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  private var guide: SetupIslandGuide
  private var facts = SetupIslandFacts()
  private var loads = SetupIslandLoading()
  private var loadLabel: String?
  /// The "Loading database" square really showed this run (so Database loaded gets its tick).
  private var dbShown = false
  /// Settings, Dynamic Island, "Island sounds" (the page's island state, "sounds"): the chime of the big moments.
  private var settingSounds = true
  private var panel: SetupIslandPanel?
  private var app = "PS app"
  private weak var anchor: NSWindow?
  private var queue: [SetupIslandGuide.Effect] = []
  /// A moment that owns the island for a while (birth, tick, nudge, finale): the queue waits for it.
  private var busyUntil = Date.distantPast
  private var transient: SetupIslandModel.Look?
  private var timer: Timer?
  private var loadCheck: DispatchWorkItem?
  private var pumpLater: DispatchWorkItem?
  private var monitors: [Any] = []
  private var players: [String: AVAudioPlayer] = [:]
  private var protectedHidden = false
  /// Self test and log: what it did, in order.
  private(set) var log: [String] = []

  private init() {
    guide = SetupIslandGuide(saved: SetupIslandSaved.decode(UserDefaults.standard.data(forKey: SetupIsland.savedKey)))
    facts.islandOff = UserDefaults.standard.string(forKey: SetupIsland.modeKey) == "off"
    model.soundOn = !guide.saved.soundOff
    model.skip = { [weak self] in self?.skip() }
    model.close = { [weak self] in self?.close() }
    model.toggleSound = { [weak self] in self?.toggleSound() }
  }

  private var enabled: Bool { !test }

  // MARK: hooks from the install screen (Installer.swift)

  /// The install screen is up. `fresh`: a Mac that never had PS; only then does a guided setup start.
  func installerOpened(fresh: Bool, window: NSWindow?, app name: String) {
    guard enabled else { return }
    app = name
    anchor = window
    facts.installer = true
    if fresh && SetupIslandCore.shouldStart(psAlreadyInstalled: false, neverChoseStore: true, test: test, islandOff: facts.islandOff) {
      guide = SetupIslandGuide.begin(now: Date(), soundOff: guide.saved.soundOff)
      psLog("PS setup island: guided setup started")
    }
    facts.page = "welcome"
    changed()
  }
  func installerName(_ name: String) { app = name }
  func installerPage(_ page: String) {
    guard enabled, facts.installer else { return }
    if page == "steps" { startLoad(.install) }
    if page != "steps" { endLoad(.install) }
    facts.page = page
    changed()
  }
  func installerClick(_ id: String) {
    guard enabled, facts.installer else { return }
    guide.activity(now: Date())
    if id == "storePage" { installerPage("store") }
  }
  func installerPerms(ax: Bool, audio: Bool) {
    guard enabled, facts.installer, facts.ax != ax || facts.audio != audio else { return }
    facts.ax = ax; facts.audio = audio
    changed()
  }
  /// The copy stopped with an error: the guide steps aside (the screen says what went wrong).
  func installerStopped() {
    guard enabled else { return }
    endLoad(.install)
    queue.removeAll(); transient = nil
    hideNow()
  }

  // MARK: hooks from the installed app (main.swift, ProjectSetup.swift)

  func appLaunched(app name: String) {
    guard enabled else { return }
    app = name
    facts.installer = false
    if !facts.islandOff { startLoad(.page) }
    if guide.running { psLog("PS setup island: guided setup goes on (\(guide.saved.done.count) steps done)") }
    changed()
  }
  func pageReady(remembered: Bool, unlocked: Bool) {
    guard enabled else { return }
    endLoad(.page)
    if remembered && !unlocked && !facts.islandOff { startLoad(.database) }
  }
  func vault(unlocked: Bool) {
    guard enabled else { return }
    if unlocked {
      // PS 1.60: after quitting and opening PS again, "Loading database" ends with a green tick, a chime and
      // "Database loaded". Only when the loading square really showed (a quick load gets no praise for nothing).
      let wasShown = dbShown
      dbShown = false
      endLoad(.database)
      if IslandMotionCore.showDbLoaded(loadingWasShown: wasShown, islandOff: facts.islandOff, featureOn: Features.on("island-moments")) {
        say(IslandMotionCore.dbLoadedWords, moment: .dbLoaded)
      }
    }
    guard facts.signedIn != unlocked else { return }
    facts.signedIn = unlocked
    changed()
  }
  func listShown() {
    guard enabled, !facts.listShown else { return }
    facts.listShown = true
    changed()
  }
  /// The setup menu (web views/Welcome.tsx) opened or closed.
  func menu(open: Bool) {
    guard enabled, facts.menuOpen != open else { return }
    if !open && facts.menuOpen { facts.menuClosed = true }
    facts.menuOpen = open
    changed()
  }
  func supabase(open: Bool) {
    guard enabled, facts.supabaseOpen != open else { return }
    facts.supabaseOpen = open
    changed()
  }
  func supabaseLinked() {
    guard enabled else { return }
    facts.supabaseDone = true
    changed()
  }
  func supabaseWorking(_ on: Bool) {
    guard enabled else { return }
    if on { startLoad(.supabase) } else { endLoad(.supabase) }
  }
  /// The island's state from the page ({type:"island"}): only whether it is switched off matters here. Signed out, the
  /// page sends "off" with none of the person's island settings (web src/island.ts): that is not a choice,
  /// so only a state carrying the settings (its "hide" time) counts.
  func islandState(_ st: [String: Any]) {
    guard enabled, st["hide"] != nil, let mode = st["mode"] as? String else { return }
    let off = mode == "off"
    settingSounds = (st["sounds"] as? Bool) != false
    if UserDefaults.standard.string(forKey: SetupIsland.modeKey) != mode { UserDefaults.standard.set(mode, forKey: SetupIsland.modeKey) }
    guard off != facts.islandOff else { return }
    facts.islandOff = off
    if off { loads = SetupIslandLoading(); loadLabel = nil }
    changed()
  }

  // MARK: the guide

  private func changed() {
    let before = guide.saved
    let fx = guide.update(facts, now: Date())
    if guide.saved != before { save() }
    if !fx.isEmpty { log.append(contentsOf: fx.map { "\($0)" }); run(fx) }
    watch()
  }
  private func save() {
    if let d = guide.saved.encoded() { UserDefaults.standard.set(d, forKey: SetupIsland.savedKey) }
  }
  private func skip() {
    psLog("PS setup island: skipped \(guide.current?.rawValue ?? "nothing")")
    let fx = guide.skip(facts, now: Date())
    save(); run(fx)
  }
  private func close() {
    psLog("PS setup island: closed for good")
    let fx = guide.close()
    save(); run(fx)
  }
  private func escape() {
    // Esc ends a short moment (the database tick, "Updated", "What's new") at once.
    if transient == .tick || transient == .whatsNew { transient = nil; render(); return }
    let fx = guide.escape()
    if !fx.isEmpty { run(fx) }
  }
  private func toggleSound() {
    guide.saved.soundOff.toggle()
    model.soundOn = !guide.saved.soundOff
    save()
    if model.soundOn { play("blip", SetupIslandSound.blip, 0.3) }
  }

  /// Once a second while the guide runs: nudges, the wait for the setup menu, 1Password or Signal in front.
  private func watch() {
    let need = guide.running || panel?.isVisible == true
    if need && timer == nil {
      let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.second() }
      t.tolerance = 0.25
      RunLoop.main.add(t, forMode: .common)
      timer = t
      startMonitors()
    } else if !need, let t = timer {
      t.invalidate(); timer = nil
      stopMonitors()
    }
  }
  private func second() {
    if Protected.front != protectedHidden {
      protectedHidden = Protected.front
      if protectedHidden { panel?.orderOut(nil) } else if model.look != .hidden { panel?.orderFrontRegardless() }
    }
    changed()
  }

  // MARK: the moments, one at a time

  private func run(_ fx: [SetupIslandGuide.Effect]) {
    for e in fx {
      if e == .stop { queue.removeAll(); transient = nil; hideNow(); continue }
      if e == .nudge && !queue.isEmpty { continue }
      queue.append(e)
    }
    pump()
  }
  private func pump() {
    pumpLater?.cancel()
    let now = Date()
    let wait = max(busyUntil.timeIntervalSince(now), 0)
    // A load that may show in a moment holds the queue too, so a hint never flashes up just before the loading square.
    if wait > 0 || loadLabel != nil || loads.pending {
      let w = DispatchWorkItem { [weak self] in self?.pump() }
      pumpLater = w
      DispatchQueue.main.asyncAfter(deadline: .now() + (wait > 0 ? wait : 0.3), execute: w)
      return
    }
    guard !queue.isEmpty else { return }
    let e = queue.removeFirst()
    perform(e)
    if !queue.isEmpty { pump() }
  }
  private func busy(_ s: Double) { busyUntil = Date().addingTimeInterval(s) }

  private func perform(_ e: SetupIslandGuide.Effect) {
    switch e {
    case .birth: birth()
    case .hint(let s): hint(s)
    case .tick(let s): tick(s)
    case .nudge: nudge()
    case .hideHint: transient = nil; render()
    case .finale: finale()
    case .stop: hideNow()
    }
  }

  private var spring: Animation { model.reduce ? .easeInOut(duration: 0.22) : .spring(response: 0.42, dampingFraction: 0.74) }

  private func birth() {
    guard ensurePanel() else { return }
    psLog("PS setup island: born")
    model.title = SetupIslandCore.birthWords; model.sub = ""
    model.tickDraw = 0; model.sparkle = 0
    transient = .born
    let reduce = model.reduce
    // Out of the setup screen: centred on it (or the middle of the screen), small, then big with a bloop.
    let top = topFrame()
    if reduce { place(top) } else { place(bornFrame() ?? top) }
    model.look = .hidden
    model.sx = reduce ? 1 : 0.35; model.sy = reduce ? 1 : 0.35
    show()
    play("blip", SetupIslandSound.blip, 0.32)
    withAnimation(reduce ? .easeOut(duration: 0.3) : .spring(response: 0.5, dampingFraction: 0.58)) {
      model.look = .born; model.sx = 1; model.sy = 1
    }
    after(0.35) { [self] in
      withAnimation(.easeOut(duration: reduce ? 0.2 : 0.42)) { model.tickDraw = 1 }
      play("chime", SetupIslandSound.chime, 0.45)
    }
    if reduce {
      busy(2.2)
      after(2.0) { [self] in transient = nil; render() }
      return
    }
    // Then up to the island's place: it slims down on the way, squashes a little at the top and springs back.
    after(1.9) { [self] in
      withAnimation(.easeInOut(duration: 0.55)) { model.look = .travel }
      NSAnimationContext.runAnimationGroup { c in
        c.duration = 0.75
        c.timingFunction = CAMediaTimingFunction(controlPoints: 0.45, 0, 0.2, 1)
        panel?.animator().setFrame(top, display: true)
      }
    }
    after(2.68) { [self] in
      withAnimation(.easeOut(duration: 0.11)) { model.sx = 0.9; model.sy = 0.74 }
    }
    after(2.8) { [self] in
      withAnimation(.spring(response: 0.42, dampingFraction: 0.42)) { model.sx = 1; model.sy = 1 }
    }
    busy(3.2)
    after(3.15) { [self] in transient = nil; if loadLabel == nil && queue.isEmpty { render() } }
  }

  private func hint(_ s: SetupIslandStep) {
    let h = SetupIslandCore.hint(s, app: app, axPane: Installer.axPane, audioPane: Installer.audioPane)
    model.title = h.title; model.sub = h.sub
    transient = nil
    guard render() else { return }
    psLog("PS setup island: hint \(s.rawValue)")
    attention(volume: 0.3)
    busy(0.45)
  }
  /// A bounce and the pink ring, with the soft blip. Reduce Motion: only the ring's glow and the blip.
  private func attention(volume: Double) {
    play("blip", SetupIslandSound.blip, volume)
    model.ring = 0
    withAnimation(.easeOut(duration: 0.9)) { model.ring = 1 }
    after(0.95) { [self] in model.ring = 0 }
    guard !model.reduce else { return }
    withAnimation(.spring(response: 0.18, dampingFraction: 0.5)) { model.sx = 1.06; model.sy = 1.1 }
    after(0.14) { [self] in withAnimation(.spring(response: 0.36, dampingFraction: 0.42)) { model.sx = 1; model.sy = 1 } }
  }

  private func tick(_ s: SetupIslandStep) {
    guard ensurePanel() else { return }
    psLog("PS setup island: done \(s.rawValue)")
    model.praise = SetupIslandCore.praise(s)
    model.tickDraw = 0
    transient = .tick
    render()
    after(0.12) { [self] in
      withAnimation(.easeOut(duration: model.reduce ? 0.15 : 0.38)) { model.tickDraw = 1 }
      play("chime", SetupIslandSound.chime, 0.45)
      if !model.reduce {
        withAnimation(.spring(response: 0.2, dampingFraction: 0.5)) { model.sx = 1.07; model.sy = 1.07 }
        after(0.16) { [self] in withAnimation(.spring(response: 0.4, dampingFraction: 0.45)) { model.sx = 1; model.sy = 1 } }
      }
    }
    busy(1.45)
    after(1.4) { [self] in if transient == .tick { transient = nil; render() } }
  }

  /// A short moment of the island's own (PS 1.60): a green tick and a few words ("Database loaded", "Updated to V1.60"),
  /// with a chime at the big ones (the sound switch in Settings and Do Not Disturb silence it), then the island is itself.
  func say(_ words: String, moment: IslandMoment) {
    guard enabled, !facts.islandOff, Features.on("island-moments"), ensurePanel() else { return }
    psLog("PS island moment: \(moment.rawValue)")
    log.append("moment:\(moment.rawValue)")
    model.praise = words
    model.tickDraw = 0
    transient = .tick
    render()
    after(0.12) { [self] in
      withAnimation(.easeOut(duration: model.reduce ? 0.15 : 0.38)) { model.tickDraw = 1 }
      if IslandMotionCore.chimes(moment, soundOn: settingSounds, dndMutesSounds: false) { play("chime", SetupIslandSound.chime, 0.45) }
      if !model.reduce {
        withAnimation(.spring(response: 0.2, dampingFraction: 0.5)) { model.sx = 1.07; model.sy = 1.07 }
        after(0.16) { [self] in withAnimation(.spring(response: 0.4, dampingFraction: 0.45)) { model.sx = 1; model.sy = 1 } }
      }
    }
    busy(IslandMotionCore.tickHold + 0.05)
    after(IslandMotionCore.tickHold) { [self] in if transient == .tick { transient = nil; render() } }
  }

  /// PS 1.69: the island (bottom left origin) is in the lower half of its screen: What's new and the feature intro card hang from its
  /// lower edge, so they open in the middle instead (HatchCore.inLowerHalf).
  static func inLowerHalf(_ r: NSRect) -> Bool {
    guard let sc = NSScreen.screens.first(where: { $0.frame.intersects(r) }) else { return false }
    return HatchCore.inLowerHalf(r, screen: sc.frame)
  }

  /// What's new from the island (PS 1.60): the island squeezes, bounces and says "What's new" with a chime. `ready` is called
  /// when the island has said it, and gives the island's place in the page (x centre, y of its bottom edge, width, all in the
  /// Tab list window's points), so the panel can come out attached to it. `ready(nil)` when the island cannot do it
  /// (island off, moments off, Reduce Motion, not on screen): the panel then opens as it always did.
  func whatsNew(overlay: NSWindow?, ready: @escaping ([String: Double]?) -> Void) {
    guard enabled, !facts.islandOff, Features.on("island-moments"), !model.reduce,
          let o = overlay, let r = Island.shared.shapeOnScreen(), ensurePanel() else { ready(nil); return }
    // PS 1.69: the panel hangs from the island's lower edge, so an island kept in the lower half of the screen (V1.58) cannot
    // hold it (it would open off the bottom): it opens in the middle then, as it always did without the island.
    if Self.inLowerHalf(r) { ready(nil); return }
    psLog("PS island moment: whatsNew")
    log.append("moment:whatsNew")
    Island.shared.moment(.whatsNew)
    model.praise = IslandMotionCore.whatsNewWords
    model.tickDraw = 0
    transient = .whatsNew
    render()
    after(0.12) { [self] in
      withAnimation(.easeOut(duration: 0.38)) { model.tickDraw = 1 }
      if IslandMotionCore.chimes(.whatsNew, soundOn: settingSounds, dndMutesSounds: false) { play("chime", SetupIslandSound.chime, 0.4) }
    }
    busy(IslandMotionCore.whatsNewLead + 0.2)
    after(IslandMotionCore.whatsNewLead) { [self] in
      // The island's real shape sits right where this one hands over; the panel hangs from the real island's edge.
      ready(["x": Double(r.midX - o.frame.minX), "bottom": Double(o.frame.maxY - r.minY), "w": Double(r.width)])
      // The words fade away behind the panel as it comes out.
      after(0.35) { [self] in if transient == .whatsNew { transient = nil; render() } }
    }
  }

  /// A feature intro from the island (PS 1.60, "WhatsApp messages now supported"): the island squeezes in a little and bounces out, with a
  /// soft chime (the Island sounds switch and Reduce Motion are respected), then `ready` gives the island's place in the Tab list window
  /// (x centre, y of its bottom edge, width) so the page can hang its card from it. `ready(nil)` when the island cannot do it (off, moments
  /// off, Reduce Motion, not on screen): the page draws the same card plainly. The words and the mark are the page's (core/featureintro.ts).
  func featureIntro(overlay: NSWindow?, ready: @escaping ([String: Double]?) -> Void) {
    guard enabled, IslandIntroCore.hangsFromIsland(islandOff: facts.islandOff, reduceMotion: model.reduce, momentsOn: Features.on("island-moments"),
                                                   islandOnScreen: Island.shared.shapeOnScreen() != nil,
                                                   islandLow: Island.shared.shapeOnScreen().map(Self.inLowerHalf) ?? false), let o = overlay, let r = Island.shared.shapeOnScreen() else {
      ready(nil); return
    }
    psLog("PS island moment: featureIntro")
    log.append("moment:featureIntro")
    Island.shared.moment(.featureIntro)
    // The chime lands as the mark swoops in (the page starts the swoop when it gets the place, a beat after the squeeze).
    after(IslandMotionCore.introLead) { [self] in
      if IslandMotionCore.chimes(.featureIntro, soundOn: settingSounds, dndMutesSounds: false) { play("chime", SetupIslandSound.chime, 0.3) }
      ready(["x": Double(r.midX - o.frame.minX), "bottom": Double(o.frame.maxY - r.minY), "w": Double(r.width)])
    }
  }

  private func nudge() {
    guard model.look == .hint, panel?.isVisible == true else { return }
    psLog("PS setup island: nudge")
    play("blip", SetupIslandSound.blip, 0.18)
    model.ring = 0
    withAnimation(.easeOut(duration: 0.9)) { model.ring = 1 }
    after(0.95) { [self] in model.ring = 0 }
    if !model.reduce { withAnimation(.linear(duration: 0.6)) { model.shake += 1 } }
    busy(0.7)
  }

  private func finale() {
    guard ensurePanel() else { return }
    psLog("PS setup island: all done")
    model.title = SetupIslandCore.finaleWords.title; model.sub = SetupIslandCore.finaleWords.sub
    model.tickDraw = 0; model.sparkle = 0
    transient = .finale
    render()
    after(0.25) { [self] in
      withAnimation(.easeOut(duration: 0.42)) { model.tickDraw = 1 }
      withAnimation(.easeOut(duration: 0.9)) { model.sparkle = 1 }
      play("finale", SetupIslandSound.finale, 0.45)
    }
    // Then it settles into the island's normal look, where the real island (with the first task) takes over.
    after(3.0) { [self] in
      let real = Island.shared.shapeOnScreen()
      if let r = real { model.handoffSize = r.size }
      withAnimation(model.reduce ? .easeInOut(duration: 0.25) : .spring(response: 0.5, dampingFraction: 0.8)) { model.look = .handoff }
      if let r = real, let p = panel, !model.reduce {
        let f = NSRect(x: r.midX - SetupIsland.panelW / 2, y: r.maxY + SetupIslandView.inset - SetupIsland.panelH,
                       width: SetupIsland.panelW, height: SetupIsland.panelH)
        NSAnimationContext.runAnimationGroup { c in c.duration = 0.45; p.animator().setFrame(f, display: true) }
      }
      after(0.55) { [self] in
        NSAnimationContext.runAnimationGroup({ c in c.duration = 0.3; panel?.animator().alphaValue = 0 },
                                             completionHandler: { [weak self] in self?.transient = nil; self?.hideNow() })
      }
    }
    busy(4.2)
  }

  // MARK: loading

  private func startLoad(_ l: SetupIslandCore.Load) {
    guard enabled else { return }
    loads.begin(l.rawValue, SetupIslandCore.loadLabel(l, app: app), now: Date())
    refreshLoad()
  }
  private func endLoad(_ l: SetupIslandCore.Load) {
    guard enabled else { return }
    loads.end(l.rawValue)
    refreshLoad()
  }
  private func refreshLoad() {
    loadCheck?.cancel()
    let st = loads.state(now: Date())
    if facts.islandOff { loadLabel = nil } else if st.label != loadLabel {
      let was = loadLabel
      loadLabel = st.label
      if let l = st.label {
        model.loadLabel = l; psLog("PS setup island: loading (\(l))")
        if l == SetupIslandCore.loadLabel(.database, app: app) { dbShown = true }
      }
      if was != nil && st.label == nil { psLog("PS setup island: loaded") }
      render()
      if st.label == nil { pump() }
    }
    if let r = st.recheck {
      let w = DispatchWorkItem { [weak self] in self?.refreshLoad() }
      loadCheck = w
      DispatchQueue.main.asyncAfter(deadline: .now() + r, execute: w)
    }
    if loadLabel == nil && !loads.pending { pump() }
    watch()
  }

  // MARK: on screen

  /// Shows what should show now. False when nothing shows.
  @discardableResult private func render() -> Bool {
    let want: SetupIslandModel.Look
    // PS 1.67 Hatch: no island of any kind while the update or start scene plays (it gives birth to the island).
    if Island.shared.hatchHeld { want = .hidden }
    else if loadLabel != nil { want = .loading }
    else if let t = transient { want = t }
    else if guide.running, guide.current != nil, !guide.quiet, !guide.hidden { want = .hint }
    else { want = .hidden }
    if want == .hidden {
      guard let p = panel, p.isVisible, model.look != .hidden else { return false }
      withAnimation(model.reduce ? .easeOut(duration: 0.2) : .spring(response: 0.36, dampingFraction: 0.85)) { model.look = .hidden; model.sx = 1; model.sy = 1 }
      after(0.4) { [weak self] in if self?.model.look == .hidden { self?.panel?.orderOut(nil); self?.watch() } }
      return false
    }
    guard ensurePanel() else { return false }
    let fromHidden = model.look == .hidden || panel?.isVisible != true
    if fromHidden {
      if transient != .born { place(topFrame()) }
      model.look = .hidden
      if !model.reduce { model.sx = 0.6; model.sy = 0.5 }
      show()
    }
    if model.look != want || fromHidden {
      withAnimation(fromHidden && !model.reduce ? .spring(response: 0.46, dampingFraction: 0.62) : spring) {
        model.look = want; model.sx = 1; model.sy = 1
      }
    }
    return true
  }

  private func ensurePanel() -> Bool {
    if panel != nil { return true }
    guard enabled, NSScreen.main != nil else { return false }
    let p = SetupIslandPanel(contentRect: NSRect(x: 0, y: 0, width: SetupIsland.panelW, height: SetupIsland.panelH),
                             styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)   // just above the real island
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = IslandPlace.spaces
    p.ignoresMouseEvents = true
    p.setAccessibilityLabel("Setup guide")
    let host = IslandHost(rootView: SetupIslandView(m: model))
    host.frame = NSRect(x: 0, y: 0, width: SetupIsland.panelW, height: SetupIsland.panelH)
    p.contentView = host
    panel = p
    return true
  }
  private func show() {
    guard let p = panel, !protectedHidden else { return }
    p.alphaValue = 1
    if !p.isVisible { p.orderFrontRegardless() }
    watch()
  }
  private func hideNow() {
    model.look = .hidden; model.sx = 1; model.sy = 1
    panel?.orderOut(nil)
    panel?.alphaValue = 1
    watch()
  }
  private func place(_ f: NSRect) { panel?.setFrame(f, display: true) }

  /// Where the island normally sits: the real island's spot when it shows (it may have been moved), else the top
  /// centre below the notch or the menu bar, like the island's pill.
  private func topFrame() -> NSRect {
    let W = SetupIsland.panelW, H = SetupIsland.panelH, inset = SetupIslandView.inset
    if let r = Island.shared.shapeOnScreen() {
      return NSRect(x: r.midX - W / 2, y: r.maxY + inset - H, width: W, height: H)
    }
    let (g, _) = IslandGeo.read()
    let top = g.frame.maxY - (g.notch ? g.notchH : g.menuH) - 6
    return NSRect(x: g.centerX - W / 2, y: top + inset - H, width: W, height: H)
  }
  /// Centred on the setup screen (the install window, or the window PS shows), else the middle of the screen.
  private func bornFrame() -> NSRect? {
    let W = SetupIsland.panelW, H = SetupIsland.panelH, bigH: CGFloat = 104
    let w = (anchor?.isVisible == true ? anchor : nil)
      ?? NSApp.windows.first { $0.isVisible && !($0 is NSPanel) && $0.frame.width > 200 }
    guard let c = w.map({ NSPoint(x: $0.frame.midX, y: $0.frame.midY) }) ?? NSScreen.main.map({ NSPoint(x: $0.visibleFrame.midX, y: $0.visibleFrame.midY) })
    else { return nil }
    return NSRect(x: c.x - W / 2, y: c.y + bigH / 2 + SetupIslandView.inset - H, width: W, height: H)
  }
  /// The shape's rectangle on screen (for clicks on its buttons).
  private func shapeOnScreen() -> NSRect? {
    guard let p = panel, p.isVisible, model.look != .hidden else { return nil }
    let s = model.size
    return NSRect(x: p.frame.midX - s.width / 2, y: p.frame.maxY - SetupIslandView.inset - s.height, width: s.width, height: s.height)
  }

  // MARK: pointer and keys

  private func startMonitors() {
    guard monitors.isEmpty else { return }
    let move: (NSEvent) -> Void = { [weak self] _ in self?.pointer() }
    if let m = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDragged], handler: move) { monitors.append(m) }
    if let m = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown, .keyDown], handler: { [weak self] e in
      if e.type == .keyDown && e.keyCode == 53 { self?.escape() }   // Esc hides the hint (and still reaches the screen under it)
      if e.type != .mouseMoved { self?.guide.activity(now: Date()) } else { self?.pointer() }
      return e
    }) { monitors.append(m) }
    // Esc in any app (works once Accessibility is on, like PS's own keys).
    if let m = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in if e.keyCode == 53 { self?.escape() } }) { monitors.append(m) }
  }
  private func stopMonitors() {
    monitors.forEach { NSEvent.removeMonitor($0) }
    monitors = []
  }
  /// Clicks pass through everywhere except on the guide's own shape while it shows a hint.
  private func pointer() {
    guard let p = panel else { return }
    let over = model.look == .hint && (shapeOnScreen()?.contains(NSEvent.mouseLocation) ?? false)
    if p.ignoresMouseEvents == over { p.ignoresMouseEvents = !over }
  }

  // MARK: sound

  private func play(_ name: String, _ tones: [Sfx.Tone], _ volume: Double) {
    guard model.soundOn, !test, !DND.shared.mutes("sounds") else { return }
    if players[name] == nil { players[name] = try? AVAudioPlayer(data: Sfx.wav(tones)); players[name]?.prepareToPlay() }
    guard let p = players[name] else { return }
    p.volume = Float(volume)
    p.currentTime = 0
    p.play()
  }

  private func after(_ s: Double, _ f: @escaping () -> Void) { DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: f) }
}
