import AppKit
import SwiftUI

// V1.59 on screen: the timer bubble beside the island in its own window (so it is never cut), and the first stand-up's
// question that comes out of the island just below it. The rules and numbers are IslandBubbleCore.swift; IslandTimers
// drives both (syncBubble, the stand-up's ask).

// ---------- the bubble ----------
final class BubbleModel: ObservableObject {
  @Published var b: TBubble = .none
  @Published var size = BubbleFit.Size(width: 0)
  /// PS 1.60: the meeting as a small blob on the island's end (IslandBlobCore.swift BlobFit); nil: the long pill.
  @Published var blob: BlobFit.Layout?
  @Published var side: BubbleFit.Side = .right
  @Published var shown = false
  @Published var opacity: Double = 1
}

/// The bubble beside the island: the last 15 seconds before a stand-up, or the next meeting. White words on a black
/// capsule (the same whatever the island's look, so it always reads).
struct BubbleView: View {
  @ObservedObject var m: BubbleModel
  var tap: (TBubble) -> Void
  private let green = Color(red: 0.2, green: 0.83, blue: 0.6), blue = Color(red: 0.38, green: 0.65, blue: 0.98)
  static let margin: CGFloat = 2

  var body: some View {
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let anchor: UnitPoint = m.side == .right ? .leading : m.side == .left ? .trailing : .top
    ZStack {
      if m.shown, !m.b.isNone {
        Button(action: { tap(m.b) }) {
          content
            .frame(width: m.size.width, height: bubbleH)
            .background(blobShape)
            .overlay(blobEdge)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .id(key)
        // It splits off the island's side: from small at the island's edge, with a little overshoot.
        .transition(calm ? .opacity : .scale(scale: 0.2, anchor: anchor).combined(with: .opacity).combined(with: m.side == .below ? .offset(y: -10) : .offset(x: m.side == .right ? -14 : 14)))
      }
    }
    .frame(width: m.size.width + 2 * BubbleView.margin, height: bubbleH + 2 * BubbleView.margin, alignment: m.side == .right ? .leading : .trailing)
    .padding(0)
    .opacity(m.opacity)
    .environment(\.colorScheme, .dark)
  }
  private var bubbleH: CGFloat { m.blob?.height ?? BubbleFit.h }
  /// The blob is the island's own black with no edge (blended in); the pill keeps its faint white edge.
  @ViewBuilder private var blobShape: some View {
    if let b = m.blob { RoundedRectangle(cornerRadius: b.radius, style: .continuous).fill(Color.black) } else { Capsule().fill(Color.black) }
  }
  @ViewBuilder private var blobEdge: some View {
    if m.blob == nil { Capsule().stroke(Color.white.opacity(0.14), lineWidth: 0.8) }
  }
  private var key: String {
    switch m.b { case .none: return "none"; case .standSoon: return "stand"; case .meet(let mode, let mt): return "meet-\(mt.id)-\(mode)" }
  }
  /// The blob (PS 1.61): the blue camera on the left, the meeting's name over the time, big and bold, on its right.
  @ViewBuilder private func blobContent(_ l: BlobFit.Layout, _ mode: String, _ mt: TMeet) -> some View {
    HStack(spacing: BlobFit.iconGap) {
      Image(systemName: "video.fill").font(.system(size: l.sizes.icon, weight: .bold)).foregroundColor(blue)
        .frame(width: BlobFit.iconW(l.sizes))
      VStack(alignment: .leading, spacing: BlobFit.spacing) {
        if mode == "join" {
          Text(TimersCore.wJoin).font(.system(size: l.sizes.title, weight: .heavy)).foregroundColor(blue).lineLimit(1).fixedSize()
        } else if let w = l.titleW {
          Text(mt.title).font(.system(size: l.sizes.title, weight: .semibold)).foregroundColor(Color.white.opacity(0.85)).lineLimit(1).truncationMode(.tail).frame(width: w, alignment: .leading)
        } else {
          Text(mt.title).font(.system(size: l.sizes.title, weight: .semibold)).foregroundColor(Color.white.opacity(0.85)).lineLimit(1).fixedSize()
        }
        if mode == "now" {
          HStack(alignment: .firstTextBaseline, spacing: 3) {
            IslandCountdown(endsAt: mt.end, short: true, size: l.sizes.time, color: .white)
            Text(BubbleFit.wLeftWord).font(.system(size: l.sizes.time - 2, weight: .semibold)).foregroundColor(Color.white.opacity(0.7)).fixedSize()
          }
        } else {
          IslandCountdown(endsAt: mt.start, short: true, size: l.sizes.time, color: .white)
        }
      }
      .frame(maxWidth: BlobFit.textRoom(l), alignment: .leading)
    }
    .padding(.horizontal, BlobFit.padX)
    .padding(.vertical, BlobFit.padY)
    .frame(width: l.width, height: l.height, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Text("\(mt.title) \(mode == "now" ? "on now" : "starting soon")"))
  }
  @ViewBuilder private var content: some View {
    if case .meet(let mode, let mt) = m.b, let l = m.blob { blobContent(l, mode, mt) } else { pillContent }
  }
  @ViewBuilder private var pillContent: some View {
    switch m.b {
    case .standSoon(let at):
      HStack(spacing: BubbleFit.spacing) {
        Image(systemName: "figure.stand").font(.system(size: 11, weight: .bold)).foregroundColor(green).frame(width: BubbleFit.iconW)
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
          Text("\(max(0, Int(((at - ctx.date.timeIntervalSince1970 * 1000) / 1000).rounded(.up))))")
            .font(.system(size: 12, weight: .heavy)).monospacedDigit().foregroundColor(.white).fixedSize()
        }
      }
    case .meet(let mode, let mt):
      HStack(spacing: BubbleFit.spacing) {
        Image(systemName: "video.fill").font(.system(size: 10, weight: .bold)).foregroundColor(blue).frame(width: BubbleFit.iconW)
        if mode == "join" {
          Text(TimersCore.wJoin).font(.system(size: 11.5, weight: .heavy)).foregroundColor(blue).fixedSize()
          IslandCountdown(endsAt: mt.start, short: true, size: 11, color: Color.white.opacity(0.7))
        } else if mode == "now" {
          IslandCountdown(endsAt: mt.end, short: true, size: 11.5, color: .white)
          Text(BubbleFit.wLeftWord).font(.system(size: 11, weight: .semibold)).foregroundColor(Color.white.opacity(0.7)).fixedSize()
        } else {
          if !m.size.noName {
            name(mt.title)
          }
          Text(BubbleFit.wInWord).font(.system(size: 11, weight: .semibold)).foregroundColor(Color.white.opacity(0.8)).fixedSize()
          IslandCountdown(endsAt: mt.start, short: true, size: 11.5, color: .white)
        }
      }
    case .none: EmptyView()
    }
  }
  @ViewBuilder private func name(_ t: String) -> some View {
    let txt = Text(t).font(.system(size: 11, weight: .semibold)).foregroundColor(Color.white.opacity(0.8)).lineLimit(1)
    if let w = m.size.nameW { txt.truncationMode(.tail).frame(width: w, alignment: .leading) } else { txt.fixedSize() }
  }
}

/// The bubble's own small window, at the island's level, as wide as its words (BubbleFit). It takes its own clicks, so
/// the island's window no longer has to.
final class BubbleWindow {
  static let shared = BubbleWindow()
  let m = BubbleModel()
  private var win: IslandPanel?
  private var hideWork: DispatchWorkItem?
  private let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  /// Where it is on screen now (the self test and the notes read it).
  private(set) var frame: CGRect = .zero

  private func setUp(level: NSWindow.Level) -> IslandPanel {
    if let w = win { if w.level != level { w.level = level }; return w }
    let p = IslandPanel(contentRect: NSRect(x: 0, y: 0, width: 80, height: 28), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false
    p.level = level
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = IslandPlace.spaces
    p.ignoresMouseEvents = false
    p.contentView = IslandHost(rootView: BubbleView(m: m, tap: { IslandTimers.shared.tapBubble($0) }))
    // PS 1.66: a right click on the meeting gives "Hide this meeting" (that meeting only; the next one shows as usual).
    p.dragHook = { [weak self] e in
      guard e.type == .rightMouseDown, let self else { return false }
      return self.rightClick(e)
    }
    if test { p.alphaValue = 0 }
    win = p
    return p
  }

  /// Show it beside the island, or put it away (it shrinks back into the island first).
  func sync(_ b: TBubble, want: Bool, anchor: (shape: NSRect, bubbleY: CGFloat, screen: CGRect, panel: NSWindow)?, opacity: Double) {
    let nowMs = Date().timeIntervalSince1970 * 1000
    // PS 1.60: a meeting is a small blob, exactly the island's height, on its end (Settings can bring the long pill back).
    let blobFit = anchor.flatMap { want && !b.isNone ? BlobFit.fit(b, now: nowMs, island: $0.shape, screen: $0.screen, measure: BlobFit.measure) : nil }
    guard want, !b.isNone, let a = anchor,
          let fit = blobFit.map({ (BubbleFit.Size(width: $0.0.width), BubbleFit.Spot(frame: $0.1.frame, side: $0.1.side)) })
            ?? BubbleFit.fit(b, now: nowMs, island: a.shape, y: a.bubbleY, screen: a.screen, measure: BubbleFit.measure)
    else { hide(); return }
    let (size, spot) = fit
    if m.blob != blobFit?.0 { m.blob = blobFit?.0 }
    hideWork?.cancel(); hideWork = nil
    let w = setUp(level: a.panel.level)
    let f = spot.frame.insetBy(dx: -BubbleView.margin, dy: -BubbleView.margin).integral
    frame = spot.frame
    if w.frame != f { w.setFrame(f, display: true) }
    if m.side != spot.side { m.side = spot.side }
    if m.size != size { m.size = size }
    if m.opacity != opacity { m.opacity = opacity }
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    let anim: Animation = calm ? .easeInOut(duration: 0.2) : .spring(response: 0.42, dampingFraction: 0.62)
    if !w.isVisible {
      m.shown = false
      m.b = b
      w.orderFrontRegardless()
      DispatchQueue.main.async { [weak self] in withAnimation(anim) { self?.m.shown = true } }
    } else if m.b != b || !m.shown {
      withAnimation(anim) { m.b = b; m.shown = true }
    }
  }
  private var menuTarget: IslandMenuTarget?
  private func rightClick(_ e: NSEvent) -> Bool {
    guard m.shown, case .meet(_, let mt) = m.b, let view = win?.contentView else { return false }
    let t = IslandMenuTarget()
    menuTarget = t
    let menu = NSMenu()
    menu.autoenablesItems = false
    let it = NSMenuItem(title: BubbleFit.wHide, action: #selector(IslandMenuTarget.run(_:)), keyEquivalent: "")
    it.target = t
    t.actions[it] = { IslandTimers.shared.hideMeeting(mt) }
    menu.addItem(it)
    NSMenu.popUpContextMenu(menu, with: e, for: view)
    menuTarget = nil
    return true
  }
  func hide() {
    guard let w = win, w.isVisible, hideWork == nil else { return }
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    withAnimation(calm ? .easeOut(duration: 0.18) : .spring(response: 0.3, dampingFraction: 0.86)) { m.shown = false }
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.hideWork = nil
      if !self.m.shown { self.win?.orderOut(nil); self.m.b = .none; self.frame = .zero }
    }
    hideWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.32, execute: work)
  }
}

// ---------- the first stand-up's question ----------
final class StandAskModel: ObservableObject {
  @Published var open = false
  /// The words and buttons come a moment after the card (they settle in as it lands).
  @Published var inside = false
  /// The button the pointer is on (a lighter fill).
  @Published var over: String?
}

/// "Do you want to turn stand-up reminders off?" with Turn off, See settings, and a quiet Keep them on. In the look of
/// the V1.58 setup island guide: black, continuous corners, a faint white edge, rounded type.
struct StandAskView: View {
  @ObservedObject var m: StandAskModel
  var answer: (StandAsk.Answer) -> Void
  static let w: CGFloat = 320, h: CGFloat = 150, pad: CGFloat = 18     // pad: room round the card for its shadow
  private let green = Color(red: 0.2, green: 0.83, blue: 0.6)

  var body: some View {
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    ZStack(alignment: .top) {
      Color.clear
      if m.open {
        card
          .transition(calm ? .opacity : .asymmetric(
            insertion: .scale(scale: 0.18, anchor: .top).combined(with: .offset(y: -26)).combined(with: .opacity),
            removal: .scale(scale: 0.3, anchor: .top).combined(with: .offset(y: -20)).combined(with: .opacity)))
      }
    }
    .frame(width: StandAskView.w + 2 * StandAskView.pad, height: StandAskView.h + 2 * StandAskView.pad, alignment: .top)
    .environment(\.colorScheme, .dark)
  }

  private var card: some View {
    let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
    return VStack(spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        ZStack { Circle().fill(green.opacity(0.18)); Image(systemName: "figure.stand").font(.system(size: 15, weight: .bold)).foregroundColor(green) }
          .frame(width: 34, height: 34)
        Text(StandAsk.title).font(.system(size: 14.5, weight: .semibold, design: .rounded)).foregroundColor(.white)
          .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }
      HStack(spacing: 8) {
        AskButton(m: m, label: StandAsk.turnOff, strong: true) { answer(.off) }
        AskButton(m: m, label: StandAsk.seeSettings, strong: false) { answer(.settings) }
      }
      Button(action: { answer(.keep) }) {
        Text(StandAsk.keep).font(.system(size: 12, weight: .medium)).foregroundColor(Color.white.opacity(0.55))
          .padding(.horizontal, 10).padding(.vertical, 2).contentShape(Rectangle())
      }.buttonStyle(.plain)
    }
    .opacity(m.inside ? 1 : 0)
    .offset(y: m.inside ? 0 : -6)
    .padding(.horizontal, 18).padding(.top, 16).padding(.bottom, 10)
    .frame(width: StandAskView.w, height: StandAskView.h, alignment: .top)
    .background(shape.fill(Color.black))
    .overlay(shape.stroke(Color.white.opacity(0.1), lineWidth: 1))
    .shadow(color: Color.black.opacity(0.45), radius: 14, y: 6)
    .padding(StandAskView.pad)
    .accessibilityElement(children: .contain)
  }
}
private struct AskButton: View {
  @ObservedObject var m: StandAskModel
  var label: String
  var strong: Bool
  var tap: () -> Void
  var body: some View {
    let over = m.over == label
    Button(action: tap) {
      Text(label).font(.system(size: 12.5, weight: .semibold, design: .rounded))
        .foregroundColor(strong ? .black : .white)
        .frame(maxWidth: .infinity).frame(height: 30)
        .background(Capsule().fill(strong ? Color.white.opacity(over ? 0.88 : 1) : Color.white.opacity(over ? 0.2 : 0.12)))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .onHover { h in withAnimation(.easeOut(duration: 0.12)) { if h { m.over = label } else if m.over == label { m.over = nil } } }
  }
}

/// The question's window, just below the island, centred on it (kept on the screen). Esc closes it, in PS's own windows
/// at once and in any app once Accessibility is on (like the setup island's hints).
final class StandAskWindow {
  static let shared = StandAskWindow()
  let m = StandAskModel()
  private var win: IslandPanel?
  private var monitors: [Any] = []
  private var closing: DispatchWorkItem?
  /// What the person chose (IslandTimers sends it on to the page).
  var onAnswer: ((StandAsk.Answer) -> Void)?
  private let test = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  var isOpen: Bool { m.open }
  static let below: CGFloat = 8          // the card's top this far below the island

  static func frame(shape: NSRect, screen: CGRect) -> NSRect {
    let W = StandAskView.w + 2 * StandAskView.pad, H = StandAskView.h + 2 * StandAskView.pad
    var x = shape.midX - W / 2
    x = max(screen.minX, min(x, screen.maxX - W))
    let top = shape.minY - StandAskWindow.below + StandAskView.pad
    var y = top - H
    if y < screen.minY { y = shape.maxY + StandAskWindow.below - StandAskView.pad }   // an island low on the screen: above it
    return NSRect(x: x, y: y, width: W, height: H).integral
  }

  func show(anchor a: (shape: NSRect, bubbleY: CGFloat, screen: CGRect, panel: NSWindow)) {
    closing?.cancel(); closing = nil
    if win == nil {
      let p = IslandPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isOpaque = false
      p.backgroundColor = .clear
      p.hasShadow = false
      p.hidesOnDeactivate = false
      p.isReleasedWhenClosed = false
      p.collectionBehavior = IslandPlace.spaces
      p.contentView = IslandHost(rootView: StandAskView(m: m, answer: { [weak self] in self?.answered($0) }))
      if test { p.alphaValue = 0 }
      win = p
    }
    guard let w = win else { return }
    w.level = a.panel.level
    w.setFrame(StandAskWindow.frame(shape: a.shape, screen: a.screen), display: true)
    w.orderFrontRegardless()
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      withAnimation(calm ? .easeOut(duration: 0.25) : .spring(response: 0.55, dampingFraction: 0.64)) { self.m.open = true }
      withAnimation(calm ? .easeOut(duration: 0.25) : .spring(response: 0.45, dampingFraction: 0.8).delay(0.16)) { self.m.inside = true }
    }
    startEsc()
  }
  /// The island moved or changed size: the question stays just below it.
  func follow(_ a: (shape: NSRect, bubbleY: CGFloat, screen: CGRect, panel: NSWindow)?) {
    guard m.open, let w = win else { return }
    guard let a else { close(); return }                 // the island went (hidden, switched off, 1Password in front)
    let f = StandAskWindow.frame(shape: a.shape, screen: a.screen)
    if w.frame != f { w.setFrame(f, display: true) }
  }
  private func answered(_ a: StandAsk.Answer) {
    guard m.open else { return }
    onAnswer?(a)
    close()
  }
  /// Back into the island and gone.
  func close() {
    guard m.open || win?.isVisible == true, closing == nil else { return }
    stopEsc()
    let calm = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    withAnimation(calm ? .easeOut(duration: 0.18) : .spring(response: 0.38, dampingFraction: 0.86)) { m.open = false; m.inside = false }
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.closing = nil
      if !self.m.open { self.win?.orderOut(nil) }
    }
    closing = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4, execute: work)
  }
  private func startEsc() {
    guard monitors.isEmpty else { return }
    if let l = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if e.keyCode == 53, self?.m.open == true { self?.answered(.keep) }
      return e   // never swallowed: the same Esc still backs out of the Tab list (EscAlways.swift)
    }) { monitors.append(l) }
    if let g = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] e in
      if e.keyCode == 53 { DispatchQueue.main.async { self?.answered(.keep) } }
    }) { monitors.append(g) }
  }
  private func stopEsc() { monitors.forEach { NSEvent.removeMonitor($0) }; monitors = [] }
}
