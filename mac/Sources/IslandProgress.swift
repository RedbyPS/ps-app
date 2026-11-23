import AppKit
import SwiftUI

// PS 1.77 progress check-ins and task timers on screen. The rules, numbers and words are IslandProgressCore.swift (tested);
// this draws them. NO sound anywhere here: the buzz is only seen.
//
// The buzz: ONE small window that starts exactly on the island, the same black and the same size, while the real island hides
// (IslandModel.buzzOut), so it reads as the island itself. It shakes, flies to the middle of the screen, opens into the card
// (the task as the headline, a line under it, how long, the time left or Time's up), waits, shrinks back to the island's size,
// flies home, and the real island is there again with a small landing bulge. Reduce motion: no shake and no flight, the card fades
// in just under the island and out again. Esc closes it at once (in PS's windows and, with Accessibility on, in any app), a click
// on the card closes it, and it never takes the keyboard or the focus. It asks the shared island queue (IslandQueue) first, so
// it is never on top of another card.
//
// The timer looks: ProgressMark beside the task's name (the ring, the sand timer, the time left) and ProgressLine under it (the
// line), on the closed island and the open one, only for the island's task while its expected time runs.

// MARK: - the timer looks beside the task

/** Ring, sand timer or the time left, beside the task's name (the line look is ProgressLine, under it). */
struct ProgressMark: View {
  @ObservedObject var m: IslandModel
  var color: Color
  var size: CGFloat
  var body: some View {
    if let p = m.st.progress, ProgressMark.shows(m, p), p.look != "line" {
      TimelineView(.periodic(from: .now, by: 1)) { ctx in
        let now = ctx.date.timeIntervalSince1970
        if IslandProgressCore.timerShows(p, now: now) {
          let f = IslandProgressCore.frac(p, now: now), d = max(10, size - 0.5)
          switch p.look {
          case "sand": SandTimer(frac: f, turn: IslandProgressCore.turnsOver(p, now: now), color: color).frame(width: d * 0.78, height: d)
          case "text": Text(IslandProgressCore.leftShort(IslandProgressCore.left(p, now: now) ?? 0))
            .font(.system(size: max(9.5, size - 1.5), weight: .bold).monospacedDigit()).foregroundColor(color).fixedSize()
          default: ProgressRing(frac: f, color: color, line: max(1.6, d / 6.5)).frame(width: d, height: d)
          }
        }
      }
      .accessibilityLabel("Time left on this task")
      .transition(.opacity)
    }
  }
  /** Only for the island's own task while it is being worked on (not a dimmed next up task, not right after a tick). */
  static func shows(_ m: IslandModel, _ p: ProgressIn) -> Bool {
    guard let t = m.st.task, t.id == p.id, !t.dim, m.ticked == nil, p.on, p.est > 0 else { return false }
    return true
  }
}

/** The line look: under the task's name, from full width to nothing (it shrinks to its left end). */
struct ProgressLine: View {
  @ObservedObject var m: IslandModel
  var color: Color
  var body: some View {
    if let p = m.st.progress, p.look == "line", ProgressMark.shows(m, p) {
      TimelineView(.periodic(from: .now, by: 1)) { ctx in
        let now = ctx.date.timeIntervalSince1970
        GeometryReader { g in
          if IslandProgressCore.timerShows(p, now: now) {
            Capsule().fill(color).frame(width: max(0, g.size.width * CGFloat(IslandProgressCore.frac(p, now: now))), height: 2)
              .animation(.linear(duration: 1), value: IslandProgressCore.frac(p, now: now))
          }
        }
        .frame(height: 2)
      }
      .allowsHitTesting(false)
    }
  }
}

/** A ring that empties anticlockwise: the arc runs clockwise from the top, so its end goes back towards the top as time passes. */
struct ProgressRing: View {
  var frac: Double
  var color: Color
  var line: CGFloat
  var body: some View {
    ZStack {
      Circle().stroke(color.opacity(0.22), lineWidth: line)
      Circle().trim(from: 0, to: CGFloat(frac)).stroke(color, style: StrokeStyle(lineWidth: line, lineCap: .round))
        .rotationEffect(.degrees(-90))
        .animation(.linear(duration: 1), value: frac)
    }
  }
}

/** An hourglass: upside down for its first moments (the page's start), then it turns over on a spring and the top runs into the
 *  bottom. Driven by the clock (IslandProgressCore.turnsOver), so a redraw never turns it again. */
struct SandTimer: View {
  var frac: Double
  var turn: Bool
  var color: Color
  var body: some View {
    ZStack {
      SandGlass().stroke(color, style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
      SandFill(top: true, amount: CGFloat(turn ? 1 - frac : frac)).fill(color)
      SandFill(top: false, amount: CGFloat(turn ? frac : 1 - frac)).fill(color)
    }
    .rotationEffect(.degrees(turn ? 180 : 0))
    .animation(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? nil : .spring(response: 0.6, dampingFraction: 0.6), value: turn)
  }
}
struct SandGlass: Shape {
  func path(in r: CGRect) -> Path {
    var p = Path()
    let x0 = r.minX, x1 = r.maxX, y0 = r.minY, y1 = r.maxY, mx = r.midX, my = r.midY
    p.move(to: CGPoint(x: x0, y: y0)); p.addLine(to: CGPoint(x: x1, y: y0))
    p.move(to: CGPoint(x: x0, y: y1)); p.addLine(to: CGPoint(x: x1, y: y1))
    p.move(to: CGPoint(x: x0 + r.width * 0.12, y: y0))
    p.addQuadCurve(to: CGPoint(x: mx - r.width * 0.06, y: my), control: CGPoint(x: x0 + r.width * 0.12, y: my - r.height * 0.12))
    p.addQuadCurve(to: CGPoint(x: x0 + r.width * 0.12, y: y1), control: CGPoint(x: x0 + r.width * 0.12, y: my + r.height * 0.12))
    p.move(to: CGPoint(x: x1 - r.width * 0.12, y: y0))
    p.addQuadCurve(to: CGPoint(x: mx + r.width * 0.06, y: my), control: CGPoint(x: x1 - r.width * 0.12, y: my - r.height * 0.12))
    p.addQuadCurve(to: CGPoint(x: x1 - r.width * 0.12, y: y1), control: CGPoint(x: x1 - r.width * 0.12, y: my + r.height * 0.12))
    return p
  }
}
/** The sand in one bulb: a triangle to the neck, as deep as `amount` (0 to 1). The top drains from its surface, the bottom fills up. */
struct SandFill: Shape {
  var top: Bool
  var amount: CGFloat
  var animatableData: CGFloat { get { amount } set { amount = newValue } }
  func path(in r: CGRect) -> Path {
    let a = max(0, min(1, amount)), half = r.height / 2 - 1.5, w = r.width * 0.62
    var p = Path()
    guard a > 0.01 else { return p }
    if top {
      let neck = CGPoint(x: r.midX, y: r.midY - 0.5), h = half * a, y = neck.y - h, hw = w / 2 * a
      p.move(to: CGPoint(x: r.midX - hw, y: y)); p.addLine(to: CGPoint(x: r.midX + hw, y: y)); p.addLine(to: neck); p.closeSubpath()
    } else {
      let base = r.maxY - 1.5, h = half * a, hw = w / 2
      p.move(to: CGPoint(x: r.midX - hw, y: base)); p.addLine(to: CGPoint(x: r.midX + hw, y: base))
      p.addLine(to: CGPoint(x: r.midX + hw * (1 - a), y: base - h)); p.addLine(to: CGPoint(x: r.midX - hw * (1 - a), y: base - h)); p.closeSubpath()
    }
    return p
  }
}

// MARK: - the buzz: model and view

final class BuzzModel: ObservableObject {
  /// The black shape's size now: the island's while it shakes and flies, the card's once open.
  @Published var size = CGSize(width: 200, height: 34)
  @Published var radius: CGFloat = 17
  @Published var shake: Double = 0
  @Published var inside = false
  @Published var shown = 0.0
  var islandSize = CGSize(width: 200, height: 34)
  var title = "", lines = IslandProgressCore.Lines(main: "", sub: nil, ask: nil)
  var kind = IslandProgressCore.Kind.check
  var words = ProgressWords()
  var accent = Color(red: 0.93, green: 0.31, blue: 0.53)
  var progress: ProgressIn?
  var reduce = false
  var answer: (String) -> Void = { _ in }
  var close: () -> Void = {}
}

/** The shake: a sideways wobble that dies away (IslandProgressCore.shakeX). */
struct ShakeEffect: GeometryEffect {
  var t: Double
  var animatableData: Double { get { t } set { t = newValue } }
  func effectValue(size: CGSize) -> ProjectionTransform { ProjectionTransform(CGAffineTransform(translationX: IslandProgressCore.shakeX(t), y: 0)) }
}

struct BuzzView: View {
  @ObservedObject var m: BuzzModel
  var body: some View {
    let card = IslandProgressCore.cardSize(kind: m.kind)
    ZStack {
      Color.clear
      ZStack(alignment: .topLeading) {
        RoundedRectangle(cornerRadius: m.radius, style: .continuous).fill(Color.black)
        RoundedRectangle(cornerRadius: m.radius, style: .continuous).stroke(Color.white.opacity(0.1), lineWidth: 1)
        if m.inside { content.frame(width: card.width, height: card.height, alignment: .topLeading).transition(.opacity) }
      }
      .frame(width: m.size.width, height: m.size.height)
      .clipShape(RoundedRectangle(cornerRadius: m.radius, style: .continuous))
      .shadow(color: .black.opacity(m.inside ? 0.45 : 0), radius: 24, y: 10)
      .modifier(ShakeEffect(t: m.shake))
      .opacity(m.shown)
      .contentShape(Rectangle())
      .onTapGesture { m.close() }
    }
    .frame(width: card.width + 48, height: card.height + 48)
    .environment(\.colorScheme, .dark)
  }

  @ViewBuilder var content: some View {
    VStack(alignment: .leading, spacing: 9) {
      HStack(alignment: .center, spacing: 10) {
        Text(m.title).font(.system(size: 16, weight: .bold)).foregroundColor(.white).lineLimit(2).fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 4)
        if let p = m.progress, p.on, p.est > 0 {
          TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let now = ctx.date.timeIntervalSince1970
            if p.look == "sand" { SandTimer(frac: IslandProgressCore.frac(p, now: now), turn: false, color: m.accent).frame(width: 17, height: 22) }
            else if p.look == "text" { Text(IslandProgressCore.leftShort(IslandProgressCore.left(p, now: now) ?? 0)).font(.system(size: 15, weight: .bold).monospacedDigit()).foregroundColor(m.accent) }
            else if p.look == "line" { EmptyView() }
            else { ProgressRing(frac: IslandProgressCore.frac(p, now: now), color: m.accent, line: 3).frame(width: 22, height: 22) }
          }
        }
      }
      // "a line under it": a hairline under the headline
      Rectangle().fill(Color.white.opacity(0.16)).frame(height: 1)
      Text(m.lines.main).font(.system(size: 13.5, weight: .medium)).foregroundColor(Color(white: 0.88)).lineLimit(2)
      if let s = m.lines.sub { Text(s).font(.system(size: 13, weight: .bold)).foregroundColor(m.accent).lineLimit(1) }
      if let a = m.lines.ask {
        Text(a).font(.system(size: 13.5, weight: .semibold)).foregroundColor(.white).lineLimit(2).padding(.top, 2)
        HStack(spacing: 8) {
          Button(action: { m.answer("on") }) {
            Text(m.words.turnOn).font(.system(size: 12.5, weight: .bold)).foregroundColor(.black)
              .padding(.horizontal, 14).padding(.vertical, 6).background(Capsule().fill(Color.white))
          }.buttonStyle(.plain)
          Button(action: { m.answer("off") }) {
            Text(m.words.notNow).font(.system(size: 12.5, weight: .bold)).foregroundColor(.white)
              .padding(.horizontal, 14).padding(.vertical, 6).background(Capsule().stroke(Color.white.opacity(0.35), lineWidth: 1))
          }.buttonStyle(.plain)
        }
        Text(m.words.askNote).font(.system(size: 11, weight: .medium)).foregroundColor(Color(white: 0.55)).lineLimit(1)
      }
    }
    .padding(.horizontal, 20).padding(.vertical, 16)
  }
}

// MARK: - the buzz: window and controller

final class IslandProgress {
  static let shared = IslandProgress()
  let m = BuzzModel()
  private var win: IslandPanel?
  private var p: ProgressIn?
  private var timer: Timer?
  private var monitors: [Any] = []
  private var work: [DispatchWorkItem] = []
  private var queueId: String?
  private var home = NSRect.zero
  private(set) var isOpen = false
  private var closing = false
  /// The buzzes already shown or skipped (kept for a restart, so the same check-in never comes twice).
  private var done = Set<String>(UserDefaults.standard.stringArray(forKey: "island.progress.done") ?? [])
  private let offerKey = "island.progress.askedAt"

  /** The page's part of the island state (nil: nothing to count). */
  func update(_ next: ProgressIn?) {
    p = next
    if next == nil { timer?.invalidate(); timer = nil; return }
    if timer == nil {
      timer = Timer.scheduledTimer(withTimeInterval: IslandProgressCore.poll, repeats: true) { [weak self] _ in self?.check() }
    }
    check()
  }

  private func mark(_ keys: [String]) {
    for k in keys { done.insert(k) }
    if done.count > 96 { done = Set(done.sorted().suffix(64)) }
    UserDefaults.standard.set(Array(done), forKey: "island.progress.done")
  }

  /** Is a buzz due, and may it show now? Not shown: tried again at the next look, until the grace has passed. */
  private func check() {
    guard let p, !isOpen, ProcessInfo.processInfo.environment["PS_SELFTEST"] == nil else { return }
    let now = Date().timeIntervalSince1970
    guard let b = IslandProgressCore.due(p, now: now, done: done) else { return }
    if b.kind == .offer && !IslandProgressCore.askAgain(lastShown: UserDefaults.standard.object(forKey: offerKey) as? Double, now: now) { mark(b.keys); return }
    if IslandProgressCore.blocked(blockNow(p, now: now)) != nil { return }
    let id = "progress:\(b.keys[0])"
    let o = IslandQueue.shared.enqueue(id: id, kind: "progress", priority: .normal, ttl: 60,
                                       show: { [weak self] in self?.show(p, b, queue: id) },
                                       visible: { [weak self] in self?.isOpen == true },
                                       close: { [weak self] in self?.close(fast: true) },
                                       dropped: nil)
    mark(b.keys)
    if o == .showNow { show(p, b, queue: id) }
  }

  private func blockNow(_ p: ProgressIn, now: Double) -> IslandProgressCore.Block {
    let isl = Island.shared, st = isl.model.st
    return IslandProgressCore.Block(
      islandOff: st.mode == "off",
      away: isl.awayNow,
      hidden: isl.shapeOnScreen() == nil,
      meeting: IslandAwayCore.current(st.meets, now: now)?.real == true,
      quiet: p.quiet || DND.shared.mutes("island"),
      idle: MacState.idle() >= IslandProgressCore.idle || MacState.locked(),
      takeover: isl.model.timerOn || isl.model.popping != nil || isl.model.dragging || isl.model.editing || BigIslandWindow.shared.isOpen,
      busy: IslandQueue.shared.activeId != nil)
  }

  /** Settings, Dynamic Island, Progress check-ins, Show me: one sample check-in now, on this Mac (never saved, nothing counted). */
  func test(look: String, title: String?) {
    guard !isOpen else { return }
    let now = Date().timeIntervalSince1970
    let t = title ?? Island.shared.model.st.task.map { $0.title } ?? "Your task"
    let p = ProgressIn(id: "test", title: t, since: now - 30 * 60, roundMs: now * 1000, every: 30, est: 45,
                       look: IslandProgressCore.looks.contains(look) ? look : "ring", on: true, ask: false, quiet: false)
    let b = IslandProgressCore.Buzz(kind: .check, keys: [], minutes: 30, left: 15 * 60)
    let id = "progress:test:\(Int(now))"
    let o = IslandQueue.shared.enqueue(id: id, kind: "progress", priority: .normal, ttl: 30, show: { [weak self] in self?.show(p, b, queue: id) },
                                       visible: { [weak self] in self?.isOpen == true }, close: { [weak self] in self?.close(fast: true) })
    if o == .showNow { show(p, b, queue: id) }
  }

  // ---------- on screen ----------
  private func after(_ s: Double, _ f: @escaping () -> Void) {
    let w = DispatchWorkItem(block: f); work.append(w)
    DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: w)
  }
  private func cancelAll() { work.forEach { $0.cancel() }; work = [] }

  private func ensure() -> IslandPanel {
    if let w = win { return w }
    let p = IslandPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
    p.level = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)   // just above the real island
    p.hidesOnDeactivate = false; p.isReleasedWhenClosed = false
    p.collectionBehavior = IslandPlace.spaces
    p.setAccessibilityLabel("Island check-in")
    p.contentView = IslandHost(rootView: BuzzView(m: m))
    win = p
    return p
  }
  /** The window (the card's size plus a margin) centred on a point. */
  private func frame(centredOn c: CGPoint) -> NSRect {
    let s = IslandProgressCore.cardSize(kind: m.kind)
    return NSRect(x: c.x - (s.width + 48) / 2, y: c.y - (s.height + 48) / 2, width: s.width + 48, height: s.height + 48).integral
  }
  private func glide(_ p: NSWindow, to f: NSRect, _ d: Double, curve: [Float]) {
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = d
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: curve[0], curve[1], curve[2], curve[3])
      p.animator().setFrame(f, display: true)
    }
  }

  private func show(_ p: ProgressIn, _ b: IslandProgressCore.Buzz, queue: String) {
    let isl = Island.shared
    guard let shape = isl.shapeOnScreen() else { IslandQueue.shared.finish(queue); return }
    cancelAll(); closing = false; isOpen = true; queueId = queue
    let reduce = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let plan = IslandProgressCore.plan(reduceMotion: reduce)
    m.reduce = reduce; m.kind = b.kind; m.title = p.title; m.lines = IslandProgressCore.lines(p, b); m.words = p.words; m.progress = p
    m.accent = isl.model.st.notchLook.tinted ? isl.model.st.notchLook.accent : Color(red: 0.93, green: 0.31, blue: 0.53)
    m.answer = { [weak self] a in
      Island.shared.onAction?("progressAsk", a)
      self?.close(fast: false)
    }
    m.close = { [weak self] in self?.close(fast: false) }
    if b.kind == .offer { UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: offerKey) }
    let card = IslandProgressCore.cardSize(kind: b.kind)
    let screen = isl.timerAnchor()?.screen ?? NSScreen.main?.frame ?? shape
    let w = ensure()
    m.inside = false; m.shake = 0
    if reduce {
      // Calm: the card fades in just under the island, nothing flies or shakes, and the real island stays where it is.
      let at = IslandProgressCore.under(shape, screen: screen, size: card)
      m.size = card; m.radius = 22; m.shown = 0
      w.setFrame(frame(centredOn: CGPoint(x: at.midX, y: at.midY)), display: true)
      w.ignoresMouseEvents = false
      w.orderFrontRegardless()
      withAnimation(.easeOut(duration: 0.22)) { m.shown = 1; m.inside = true }
    } else {
      home = frame(centredOn: CGPoint(x: shape.midX, y: shape.midY))
      m.islandSize = shape.size; m.size = shape.size; m.radius = shape.height / 2; m.shown = 1
      w.setFrame(home, display: true)
      w.ignoresMouseEvents = true
      w.orderFrontRegardless()
      withAnimation(.easeOut(duration: 0.08)) { isl.model.buzzOut = true }
      // 1. it shakes where it is
      withAnimation(.linear(duration: plan.shake)) { m.shake = 1 }
      // 2. it flies to the middle of the screen (a soft overshoot as it arrives)
      after(plan.shake) { [weak self] in
        guard let self, let w = self.win else { return }
        let mid = IslandProgressCore.middle(of: screen, size: card)
        self.glide(w, to: self.frame(centredOn: CGPoint(x: mid.midX, y: mid.midY)), plan.fly, curve: [0.3, 1.25, 0.4, 1])
        withAnimation(.easeInOut(duration: plan.fly)) { self.m.size = CGSize(width: shape.width * 1.15, height: shape.height * 1.15) }
      }
      // 3. it opens into the card, then the words come in
      after(plan.shake + plan.fly * 0.85) { [weak self] in
        guard let self else { return }
        withAnimation(.spring(response: plan.open, dampingFraction: 0.68)) { self.m.size = card; self.m.radius = 24 }
        self.win?.ignoresMouseEvents = false
      }
      after(plan.shake + plan.fly * 0.85 + plan.words) { [weak self] in withAnimation(.easeOut(duration: 0.25)) { self?.m.inside = true } }
    }
    startEsc()
    let hold = (b.kind == .offer ? IslandProgressCore.askShowFor : IslandProgressCore.showFor) + plan.shake + plan.fly + plan.open
    after(hold) { [weak self] in self?.close(fast: false) }
  }

  /** Back to the island. fast (Esc): at once, no flight home. */
  func close(fast: Bool) {
    guard isOpen, !closing, let w = win else { return }
    closing = true
    cancelAll(); stopEsc()
    w.ignoresMouseEvents = true
    let plan = IslandProgressCore.plan(reduceMotion: m.reduce)
    let end: () -> Void = { [weak self] in
      guard let self else { return }
      self.win?.orderOut(nil)
      self.isOpen = false; self.closing = false; self.m.inside = false; self.m.shake = 0
      withAnimation(.easeOut(duration: 0.12)) { Island.shared.model.buzzOut = false }
      if let q = self.queueId { self.queueId = nil; IslandQueue.shared.finish(q) }
    }
    if fast || m.reduce {
      withAnimation(.easeIn(duration: fast ? 0.12 : 0.2)) { m.shown = 0; m.inside = false }
      after(fast ? 0.13 : plan.land) { end() }
      return
    }
    // the words go, it shrinks to the island's size, flies home and lands with a small bulge
    withAnimation(.easeOut(duration: 0.15)) { m.inside = false }
    after(0.1) { [weak self] in
      guard let self else { return }
      withAnimation(.spring(response: plan.shrink + 0.1, dampingFraction: 0.8)) { self.m.size = self.m.islandSize; self.m.radius = self.m.islandSize.height / 2 }
    }
    after(0.1 + plan.shrink) { [weak self] in
      guard let self, let w = self.win else { return }
      self.glide(w, to: self.home, plan.home, curve: [0.5, 0, 0.2, 1])
    }
    after(0.1 + plan.shrink + plan.home) { end(); Island.shared.moment(.cardBack) }
  }

  private func startEsc() {
    guard monitors.isEmpty else { return }
    if let l = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if e.keyCode == 53, self?.isOpen == true { self?.close(fast: true) }
      return e   // never swallowed: the same Esc still backs out of the Tab list (EscAlways.swift)
    }) { monitors.append(l) }
    if let g = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if e.keyCode == 53 { DispatchQueue.main.async { if self?.isOpen == true { self?.close(fast: true) } } }
    }) { monitors.append(g) }
  }
  private func stopEsc() { monitors.forEach { NSEvent.removeMonitor($0) }; monitors = [] }
}
