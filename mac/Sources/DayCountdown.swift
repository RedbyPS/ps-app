import AppKit
import SwiftUI

// The day countdown on the Mac (PS 1.70; the rules are DayCountdownCore.swift and web src/core/daycount.ts):
//  - DayClocks: inside the island's task area, right of the task name: the task's own Priority 1 timer on the left, the day countdown on
//    the right. Each ticks by itself once a second (no loop of ours). Lively near zero: a glow, then warmer, then a small rumble in the
//    last 3 minutes, a slow heartbeat at zero. Reduce Motion: colours only.
//  - DayCardWindow: "End day now?" (Yes, Give me 15 more mins) and "You have 4h 12m left" (Acknowledged) come out of the island. With
//    the island off or not on screen, a stand-in island grows at the top, the card drops out of it, and the stand-in goes straight
//    after. Esc is 15 more mins on the first and Acknowledged on the second. Held while Sentry mode or the Sleep mode screen is up.
//    The answer goes to the page, which saves it in the vault, so the card goes on every device (and a card answered on the phone or
//    the website closes here when the page sends no card).
// PS never looks at 1Password or Signal: the Esc watch drops every key at once while either is in front (Protected.front), and no
// window here ever takes focus.

// ---------- in the island ----------
struct DayClocks: View {
  @ObservedObject var m: IslandModel
  var color: Color
  var size: CGFloat = 11
  var body: some View {
    if Features.on(DayCore.feature), let d = m.st.day, m.ticked == nil, !m.privateShown {
      HStack(spacing: 6) {
        if let p = d.p1 { DayP1Tick(deadline: p, size: size, color: color) }
        if let e = d.end { DayTick(d: d, end: e, size: size, base: islandHex(d.color) ?? color) }
      }
      .fixedSize()
      .transition(.opacity)
    }
  }
}

private let dayWarm = Color(red: 1.0, green: 0.66, blue: 0.32), dayHot = Color(red: 1.0, green: 0.42, blue: 0.38)
private func dayRoll(_ t: Text) -> some View {
  Group { if #available(macOS 14.0, *) { t.contentTransition(.numericText(countsDown: true)) } else { t } }
}

/// The shown task's own Priority 1 timer: 24 hours from when it became Priority 1, then Missed (nothing else changes on the task).
struct DayP1Tick: View {
  var deadline: Double
  var size: CGFloat
  var color: Color
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      let left = deadline - ctx.date.timeIntervalSince1970 * 1000
      dayRoll(Text(left > 0 ? TimersCore.clock(left) : DayCore.wMissed))
        .font(.system(size: size, weight: .bold)).monospacedDigit()
        .foregroundColor(left > 0 ? (left < 2 * 3_600_000 ? dayWarm : color) : dayHot)
        .padding(.horizontal, 5).padding(.vertical, 1)
        .background(Capsule().fill(color.opacity(0.13)))
        .lineLimit(1).fixedSize()
    }
    .accessibilityLabel("Priority 1 time left")
  }
}

/// The day countdown.
struct DayTick: View {
  var d: DayIn
  var end: Double
  var size: CGFloat
  var base: Color
  var body: some View {
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      let left = d.zero ? 0 : max(0, end - ctx.date.timeIntervalSince1970 * 1000)
      let st = d.lively ? DayCore.stage(left, zero: d.zero) : 0
      let c = st >= 3 ? dayHot : st == 2 ? dayWarm : base
      dayRoll(Text(TimersCore.clock(left)))
        .font(.system(size: size, weight: .bold, design: .rounded)).monospacedDigit()
        .foregroundColor(c)
        .shadow(color: st >= 1 ? c.opacity(st >= 2 ? 0.85 : 0.55) : .clear, radius: st >= 1 ? 4 : 0)
        .modifier(DayMotion(rumble: st == 3 && !d.zero && !calm, beat: d.zero && !calm))
        .lineLimit(1).fixedSize()
        .animation(.easeInOut(duration: 0.8), value: st)
    }
    .accessibilityLabel("Time left today")
  }
}
/// The rumble (a small shake, transform only) and the heartbeat at zero. Paused (no frames at all) while neither is on.
struct DayMotion: ViewModifier {
  var rumble: Bool
  var beat: Bool
  func body(content: Content) -> some View {
    TimelineView(.animation(minimumInterval: 1 / 30, paused: !rumble && !beat)) { ctx in
      let t = ctx.date.timeIntervalSinceReferenceDate
      let x = rumble ? sin(t * 53) * 0.9 + sin(t * 31) * 0.4 : 0, y = rumble ? cos(t * 47) * 0.6 : 0
      let k = beat ? DayMotion.beat(t) : 1
      content.offset(x: x, y: y).scaleEffect(k)
    }
  }
  /// Two quick beats every 1.4 s.
  static func beat(_ t: Double) -> CGFloat {
    let p = t.truncatingRemainder(dividingBy: 1.4) / 1.4
    if p < 0.12 { return 1 + 0.07 * sin(p / 0.12 * .pi) }
    if p > 0.24 && p < 0.36 { return 1 + 0.04 * sin((p - 0.24) / 0.12 * .pi) }
    return 1
  }
}

// ---------- the card out of the island ----------
final class DayCardModel: ObservableObject {
  @Published var card: DayCard?
  @Published var open = false
  /// The stand-in island (the real one is not on screen) and whether it shows.
  @Published var standIn = false
  @Published var standInShown = false
}

struct DayCardView: View {
  @ObservedObject var m: DayCardModel
  var answer: (String) -> Void
  static let w: CGFloat = 300, h: CGFloat = 108, pad: CGFloat = 24, gap: CGFloat = 8
  private let accent = Color(red: 0.93, green: 0.31, blue: 0.53)
  var body: some View {
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    VStack(spacing: DayCardView.gap) {
      if m.standIn {
        Capsule().fill(Color.black)
          .overlay(Circle().fill(accent).frame(width: 7, height: 7).shadow(color: accent, radius: 5))
          .frame(width: CGFloat(DayCore.standInW), height: CGFloat(DayCore.standInH))
          .scaleEffect(x: m.standInShown ? 1 : 0.3, y: m.standInShown ? 1 : 0.5, anchor: .top)
          .opacity(m.standInShown ? 1 : 0)
          .shadow(color: .black.opacity(0.5), radius: 10, y: 4)
      }
      if let c = m.card {
        card(c)
          .scaleEffect(x: m.open ? 1 : (calm ? 1 : 0.55), y: m.open ? 1 : (calm ? 1 : 0.2), anchor: .top)
          .offset(y: m.open || calm ? 0 : -30)
          .opacity(m.open ? 1 : 0)
          .blur(radius: m.open || calm ? 0 : 5)
      }
      Spacer(minLength: 0)
    }
    .padding(DayCardView.pad)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }
  private func card(_ c: DayCard) -> some View {
    VStack(spacing: 12) {
      Group {
        if c.kind == .rem, let end = c.end {
          TimelineView(.periodic(from: .now, by: 15)) { ctx in
            Text(DayCore.remindTitle(end - ctx.date.timeIntervalSince1970 * 1000))
          }
        } else { Text(c.title) }
      }
      .font(.system(size: 16, weight: .bold)).monospacedDigit().foregroundColor(.white).lineLimit(1).minimumScaleFactor(0.8)
      HStack(spacing: 8) {
        if c.kind == .end {
          button(c.yes, main: true) { answer("yes") }
          button(c.snooze, main: false) { answer("snooze") }
        } else {
          button(c.ack, main: true) { answer("ack") }
        }
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 15)
    .frame(width: DayCardView.w)
    .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color(white: 0.055)))
    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(Color.white.opacity(0.1), lineWidth: 1))
    .shadow(color: .black.opacity(0.55), radius: 18, y: 8)
  }
  private func button(_ t: String, main: Bool, _ f: @escaping () -> Void) -> some View {
    Button(action: f) {
      Text(t).font(.system(size: 13, weight: .bold)).lineLimit(1).fixedSize()
        .padding(.horizontal, 15).padding(.vertical, 8)
        .background(Capsule().fill(main ? accent : Color.white.opacity(0.12)))
        .foregroundColor(.white)
    }
    .buttonStyle(.plain)
  }
}

final class DayCardWindow {
  static let shared = DayCardWindow()
  let m = DayCardModel()
  private var win: IslandPanel?
  private var monitors: [Any] = []
  private var closing: DispatchWorkItem?
  private var standInAway: DispatchWorkItem?
  private var waiting: DispatchWorkItem?
  /// The card the page wants up now (nil: none). Shown at once, or as soon as Sentry mode or the Sleep mode screen ends.
  private var want: DayCard?
  /// Answered here: never put up again from a re-send that left the page before the answer was saved.
  private var answered: [String: Date] = [:]
  private let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  var isOpen: Bool { m.open }

  /// From the page ({type:"dayCard", card}). The page sends it again each minute; the same card changes nothing.
  func fromPage(_ v: Any?) {
    guard Features.on(DayCore.feature) else { want = nil; close(); return }
    let c = DayCard.from(v)
    answered = answered.filter { Date().timeIntervalSince($0.value) < 120 }
    if let c, answered[c.key] != nil { return }
    want = c
    guard let c else { close(); return }
    if m.open, c.same(m.card) {
      if m.card != c { m.card = c }   // new words for the same card
      return
    }
    tryShow()
  }

  private func tryShow() {
    waiting?.cancel(); waiting = nil
    guard let c = want else { return }
    if DayCore.held(sentry: Sentry.shared.engaged, sleepScreen: SleepScreen.shared.isUp) {
      let w = DispatchWorkItem { [weak self] in self?.tryShow() }
      waiting = w
      DispatchQueue.main.asyncAfter(deadline: .now() + 20, execute: w)
      return
    }
    show(c)
  }

  private func screenFrame() -> CGRect { (NSScreen.main ?? NSScreen.screens.first)?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900) }

  /// Where the window goes: hanging below the island (or above it when it sits low), or from the stand-in at the top of the screen.
  private func frame(standIn: Bool) -> NSRect {
    let extra = standIn ? CGFloat(DayCore.standInH) + DayCardView.gap : 0
    let W = DayCardView.w + 2 * DayCardView.pad, H = DayCardView.h + extra + 2 * DayCardView.pad
    if !standIn, let a = Island.shared.timerAnchor() {
      var x = a.shape.midX - W / 2
      x = max(a.screen.minX, min(x, a.screen.maxX - W))
      var y = a.shape.minY - 8 + DayCardView.pad - H
      if y < a.screen.minY { y = a.shape.maxY + 8 - DayCardView.pad }
      return NSRect(x: x, y: y, width: W, height: H).integral
    }
    let s = screenFrame()
    return NSRect(x: s.midX - W / 2, y: s.maxY - 3 + DayCardView.pad - H, width: W, height: H).integral   // the stand-in's top 3 pt below the top of the screen
  }

  private func show(_ c: DayCard) {
    closing?.cancel(); closing = nil
    standInAway?.cancel(); standInAway = nil
    let real = Island.shared.timerAnchor() != nil
    let standIn = DayCore.needsStandIn(islandOnScreen: real)
    if win == nil {
      let p = IslandPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isOpaque = false
      p.backgroundColor = .clear
      p.hasShadow = false
      p.hidesOnDeactivate = false
      p.isReleasedWhenClosed = false
      p.collectionBehavior = IslandPlace.spaces
      p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 2)
      p.contentView = IslandHost(rootView: DayCardView(m: m, answer: { [weak self] in self?.answer($0) }))
      if test { p.alphaValue = 0 }
      win = p
    }
    guard let w = win else { return }
    if let a = Island.shared.timerAnchor() { w.level = a.panel.level }
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let wasOpen = m.open
    m.card = c
    m.standIn = standIn
    if !wasOpen { m.open = false; m.standInShown = false }
    w.setFrame(frame(standIn: standIn), display: true)
    w.orderFrontRegardless()
    psLog("PS day countdown: card \(c.kind.rawValue)\(standIn ? " (stand-in island)" : "")")
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      if standIn {
        withAnimation(calm ? .easeOut(duration: 0.2) : .spring(response: 0.45, dampingFraction: 0.62)) { self.m.standInShown = true }
      } else {
        Island.shared.swell(true)   // the island lets the card drop out of it
      }
      withAnimation(calm ? .easeOut(duration: 0.25) : .spring(response: 0.55, dampingFraction: 0.66).delay(standIn ? 0.22 : 0.08)) { self.m.open = true }
      // Island switched off (or not on screen): the stand-in goes straight after the card is out.
      if standIn {
        let away = DispatchWorkItem { [weak self] in
          withAnimation(calm ? .easeOut(duration: 0.2) : .spring(response: 0.38, dampingFraction: 0.85)) { self?.m.standInShown = false }
        }
        self.standInAway = away
        DispatchQueue.main.asyncAfter(deadline: .now() + DayCore.standInStays + (calm ? 0 : 0.22), execute: away)
      }
    }
    startEsc()
  }

  /// The island moved or changed size: the card stays just below it.
  func follow() {
    guard m.open, !m.standIn, let w = win, Island.shared.timerAnchor() != nil else { return }
    let f = frame(standIn: false)
    if w.frame != f { w.setFrame(f, display: true) }
  }

  private func answer(_ act: String) {
    guard m.open, let c = m.card, let a = DayCore.answer(c, act) else { return }
    answered[c.key] = Date()
    Island.shared.onAction?(a.action, a.id)
    psLog("PS day countdown: \(a.action) \(act)")
    want = nil
    close()
  }

  /// Back up into the island and gone.
  func close() {
    waiting?.cancel(); waiting = nil
    guard m.open || win?.isVisible == true, closing == nil else { return }
    stopEsc()
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let real = !m.standIn
    withAnimation(calm ? .easeOut(duration: 0.18) : .spring(response: 0.36, dampingFraction: 0.86)) { m.open = false; m.standInShown = false }
    if real { DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { Island.shared.swell(false) } }
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.closing = nil
      if !self.m.open { self.win?.orderOut(nil); self.m.card = nil }
    }
    closing = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.45, execute: work)
  }

  private func startEsc() {
    guard monitors.isEmpty else { return }
    if let l = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if !Protected.front, e.keyCode == 53, self?.m.open == true { self?.answer("esc") }
      return e   // never swallowed: the same Esc still backs out of the Tab list (EscAlways.swift)
    }) { monitors.append(l) }
    if let g = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      guard !Protected.front else { return }   // 1Password or Signal in front: dropped at once, never read
      if e.keyCode == 53 { DispatchQueue.main.async { self?.answer("esc") } }
    }) { monitors.append(g) }
  }
  private func stopEsc() { monitors.forEach { NSEvent.removeMonitor($0) }; monitors = [] }
}
