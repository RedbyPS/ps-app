// The Tab blocked alert (PS 1.70; the rules and the words are in TabBlockedCore.swift). The developer holds Tab, the list cannot
// open because macOS hides his keys from PS, and the island pops out a card that says which app took the Tab key and
// how to fix it. Every build (Settings, Keyboard and Tab: "Tell me when Tab is blocked", on unless switched off).
//
// Seeing a hold when macOS hides the keys (researched 19 Nov 2026):
//  - The keyboard tap and IOHID keyboard clients get nothing under Secure Input (Apple TN2150: every "keyboard intercept
//    process" is cut off while any app has it on; GetKeys, the old key map, is one of the techniques it names).
//  - A Carbon hotkey is matched by the window server itself before any app gets the key, needs no permission, and is
//    what SafePeek already uses for plain Tab over 1Password and Signal. So it is the first signal: SafePeek arms it
//    while the app in front holds Secure Input (SafePeekCore .secureFront), a quick tap goes on to the app, a hold of
//    TabBlockedCore.holdFor calls sawHold(signal: "hotkey").
//  - The fallback is macOS's record of which keys are down (CGEventSource.keyState on the HID state), polled only while
//    PS is blind. It is the only way in when PS lost its keyboard permission (a hotkey there could not pass a quick tap
//    on: that needs the permission too, so Tab would be lost in every app). macOS may hide it under Secure Input as well.
//  - Each signal says in the log the first time it sees Tab while PS is blind, so the developer's first real case shows which
//    ones work on his Mac (no self test can hold a real key).
//
// The card: PS's own panel, out of the Dynamic Island when it is there for cards (IslandColumn, it slides from behind
// the island while the island swells), else in the middle of the screen with the pointer. It never activates PS and
// never takes the keyboard. Esc closes it: through the keyboard tap when it hears keys, or a Carbon Esc hotkey of its
// own while it is up (the tap is deaf exactly when this card shows). Gone at once when 1Password or Signal comes to the
// front, the list opens, or Sleep mode or Sentry mode comes up. When the cause goes away it says "Tab works again".
// PS never quits, clicks or reads the other app: it only asks macOS which process holds Secure Input and that app's
// name and icon, and for 1Password or Signal not even that (SecureInputWatch.holders drops the name at the first read).
import AppKit
import Carbon.HIToolbox
import SwiftUI

final class TabBlockedPanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}
final class TabBlockedHost<C: View>: NSHostingView<C> {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }   // the first click on a button counts
}

final class TabBlockedModel: ObservableObject {
  enum Phase: Equatable { case blocked, fixed }
  @Published var phase = Phase.blocked
  @Published var visible = false
  @Published var text = TabBlockedCore.text(.secureInput, holder: .unknown, appName: "PS", pane: "Accessibility")
  @Published var holder: TabBlockedHolder? = nil
  @Published var cause = TabBlockedCause.secureInput
  @Published var icon: NSImage?
  @Published var hover: String?
  @Published var press = false       // the Tab key cap goes down and up
  @Published var stepsIn = 0         // how many steps have faded in
  @Published var shake: CGFloat = 0  // held again while it is up: a little shake
  @Published var glow = false
  var act: (String) -> Void = { _ in }
}

private let tbPink = Color(red: 0.93, green: 0.31, blue: 0.53)
private let tbPinkLight = Color(red: 0.96, green: 0.45, blue: 0.66)
private let tbViolet = Color(red: 0.55, green: 0.36, blue: 0.96)
private let tbAmber = Color(red: 0.96, green: 0.68, blue: 0.30)
private let tbGreen = Color(red: 0.36, green: 0.80, blue: 0.60)

/// A horizontal shake: `amount` goes up by one per shake.
struct TabBlockedShake: GeometryEffect {
  var amount: CGFloat
  var animatableData: CGFloat { get { amount } set { amount = newValue } }
  func effectValue(size: CGSize) -> ProjectionTransform {
    ProjectionTransform(CGAffineTransform(translationX: 7 * sin(amount * .pi * 4), y: 0))
  }
}

struct TabBlockedButton: View {
  @ObservedObject var m: TabBlockedModel
  let title: String
  let id: String
  var primary = false
  var body: some View {
    let hot = m.hover == id
    Button { m.act(id) } label: {
      Text(title)
        .font(.system(size: 13.5, weight: .semibold)).lineLimit(1).fixedSize()
        .foregroundColor(.white.opacity(primary ? 1 : 0.9))
        .padding(.horizontal, 16).frame(height: 32)
        .background(
          ZStack {
            Capsule().fill(Color.white.opacity(primary ? 0.3 : 0.16))
            Capsule().fill(primary ? AnyShapeStyle(LinearGradient(colors: [tbPinkLight, tbPink], startPoint: .top, endPoint: .bottom))
                           : AnyShapeStyle(Color(red: 0.2, green: 0.13, blue: 0.24).opacity(hot ? 0.7 : 1)))
              .padding(1)
          }
        )
        .contentShape(Capsule())
        .shadow(color: primary ? tbPink.opacity(0.45) : .clear, radius: primary ? 10 : 0, y: primary ? 4 : 0)
        .scaleEffect(hot ? 1.03 : 1)
        .animation(.spring(response: 0.25, dampingFraction: 0.7), value: hot)
    }
    .buttonStyle(.plain)
    .focusable(false)
    .onHover { on in if on { m.hover = id } else if m.hover == id { m.hover = nil } }
  }
}

struct TabBlockedView: View {
  @ObservedObject var m: TabBlockedModel
  static let width: CGFloat = 400

  var body: some View {
    Group {
      switch m.phase {
      case .blocked: blocked
      case .fixed: fixed
      }
    }
    .padding(24)   // room for the shadow
    .fixedSize()
  }

  private func card<C: View>(_ width: CGFloat?, tint: Color, @ViewBuilder _ content: () -> C) -> some View {
    content()
      .frame(width: width, alignment: .leading)
      .background(
        ZStack {
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(LinearGradient(colors: [Color(red: 0.15, green: 0.07, blue: 0.20), Color(red: 0.08, green: 0.04, blue: 0.10)], startPoint: .top, endPoint: .bottom))
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(RadialGradient(colors: [tint.opacity(0.26), .clear], center: .topLeading, startRadius: 0, endRadius: 240))
          RoundedRectangle(cornerRadius: 22, style: .continuous)
            .fill(RadialGradient(colors: [tbViolet.opacity(0.18), .clear], center: .topTrailing, startRadius: 0, endRadius: 220))
        }
      )
      .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(tint.opacity(0.4), lineWidth: 1))
      .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
      .shadow(color: .black.opacity(0.55), radius: 22, y: 12)
      .shadow(color: tint.opacity(0.22), radius: 30)
      // In: grows from a little smaller and drops into place with a soft bounce. Out: shrinks a touch and fades.
      .opacity(m.visible ? 1 : 0)
      .scaleEffect(m.visible ? 1 : 0.9, anchor: .top)
      .offset(y: m.visible ? 0 : -14)
      .blur(radius: m.visible ? 0 : 4)
      .modifier(TabBlockedShake(amount: m.shake))
  }

  private var closeButton: some View {
    Button { m.act("close") } label: {
      Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundColor(.white.opacity(m.hover == "close" ? 0.9 : 0.6))
        .frame(width: 22, height: 22).background(Circle().fill(Color.white.opacity(m.hover == "close" ? 0.16 : 0.08)))
    }
    .buttonStyle(.plain).focusable(false).help(TabBlockedCore.closeHelp)
    .onHover { on in if on { m.hover = "close" } else if m.hover == "close" { m.hover = nil } }
  }

  /// The badge: the holder's icon (or a symbol) with a small Tab key cap that keeps pressing and a lock on it.
  private var badge: some View {
    ZStack(alignment: .bottomTrailing) {
      ZStack {
        Circle().fill(tbAmber.opacity(0.14)).frame(width: 52, height: 52)
        Circle().stroke(tbAmber.opacity(0.6), lineWidth: 2).frame(width: 52, height: 52)
          .scaleEffect(m.glow ? 1.4 : 1).opacity(m.glow ? 0 : 0.8)
        if let icon = m.icon {
          Image(nsImage: icon).resizable().interpolation(.high).frame(width: 38, height: 38)
        } else {
          Image(systemName: symbol).font(.system(size: 22, weight: .semibold)).foregroundColor(tbAmber)
        }
      }
      .frame(width: 52, height: 52)
      keyCap.offset(x: 10, y: 8)
    }
    .frame(width: 62, height: 60, alignment: .topLeading)
  }

  private var symbol: String {
    if m.cause == .permission { return "hand.raised.fill" }
    switch m.holder {
    case .lockScreen?: return "lock.fill"
    case .passwordApp?: return "key.fill"
    default: return "keyboard"
    }
  }

  private var keyCap: some View {
    ZStack(alignment: .topTrailing) {
      Text("tab").font(.system(size: 10, weight: .bold, design: .rounded)).foregroundColor(.white.opacity(0.92))
        .frame(width: 34, height: 20)
        .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color(red: 0.24, green: 0.16, blue: 0.30)))
        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(Color.white.opacity(0.25), lineWidth: 1))
        .shadow(color: .black.opacity(0.5), radius: m.press ? 0.5 : 2, y: m.press ? 0.5 : 2.5)
        .offset(y: m.press ? 1.5 : 0)
      Image(systemName: "lock.fill").font(.system(size: 7.5, weight: .bold)).foregroundColor(.white)
        .frame(width: 13, height: 13).background(Circle().fill(tbPink))
        .offset(x: 5, y: -5)
    }
  }

  private var blocked: some View {
    card(TabBlockedView.width, tint: tbAmber) {
      VStack(alignment: .leading, spacing: 14) {
        HStack(alignment: .top, spacing: 12) {
          badge
          VStack(alignment: .leading, spacing: 4) {
            Text(m.text.title).font(.system(size: 18, weight: .bold)).foregroundColor(.white)
              .fixedSize(horizontal: false, vertical: true)
            Text(m.text.line).font(.system(size: 13, weight: .medium)).foregroundColor(.white.opacity(0.78))
              .fixedSize(horizontal: false, vertical: true)
          }
          Spacer(minLength: 2)
          closeButton
        }
        VStack(alignment: .leading, spacing: 8) {
          ForEach(Array(m.text.steps.enumerated()), id: \.offset) { i, s in
            HStack(alignment: .firstTextBaseline, spacing: 10) {
              Text("\(i + 1)").font(.system(size: 11.5, weight: .bold)).foregroundColor(.white)
                .frame(width: 20, height: 20).background(Circle().fill(tbPink.opacity(0.55)))
              Text(s).font(.system(size: 13, weight: .medium)).foregroundColor(.white.opacity(0.88))
                .fixedSize(horizontal: false, vertical: true)
            }
            .opacity(i < m.stepsIn ? 1 : 0)
            .offset(x: i < m.stepsIn ? 0 : -8)
          }
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.white.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.white.opacity(0.08), lineWidth: 1))
        HStack(spacing: 10) {
          if let b = m.text.button { TabBlockedButton(m: m, title: b, id: "settings", primary: true) }
          TabBlockedButton(m: m, title: TabBlockedCore.ok, id: "close", primary: m.text.button == nil)
          Spacer(minLength: 0)
        }
      }
      .padding(18)
    }
  }

  private var fixed: some View {
    card(nil, tint: tbGreen) {
      HStack(spacing: 12) {
        Image(systemName: "checkmark.circle.fill").font(.system(size: 22, weight: .semibold)).foregroundColor(tbGreen)
          .shadow(color: tbGreen.opacity(0.7), radius: 8)
        Text(TabBlockedCore.fixed).font(.system(size: 14.5, weight: .bold)).foregroundColor(.white)
      }
      .padding(.horizontal, 18).padding(.vertical, 13)
      .contentShape(Rectangle())
      .onTapGesture { m.act("close") }
    }
  }
}

final class TabBlocked {
  static let shared = TabBlocked()
  weak var app: App?
  let model = TabBlockedModel()
  private var panel: TabBlockedPanel?
  private var host: TabBlockedHost<TabBlockedView>?
  private var started = false
  private var timer: Timer?
  private var memo = TabBlockedMemo()
  /// The cause and holder on screen now (nil: hidden or hiding), and the rate limit's key for them.
  private var upCause: TabBlockedCause?
  private var upKey = ""
  /// Every show and hide takes a new number: a late timer or cross fade from an older one does nothing.
  private var gen = 0
  private var pressTimer: Timer?
  private static let defaultsKey = "tabBlocked.on"
  private static let column = "tabblocked"

  // The key state poll (its own queue). `blindNow` is set on main and read by the poll under the lock.
  private let q = DispatchQueue(label: "ps.tabblocked", qos: .userInitiated)
  private var poll: DispatchSourceTimer?   // main thread only
  private let mu = NSLock()
  private var blindNow = false             // under mu
  private var clock = TabHoldClock()       // q only
  private var keyStateSaw = false          // q only: logged once per blind spell
  private var hotkeySaw = false            // main only: logged once per blind spell

  // Trust read every 2 s (cheap, but not on every look).
  private var trusted = true
  private var trustedAt = 0.0

  // Esc from the keyboard tap's thread (TabWatch.handleLocked): true while the card is on screen.
  private static let upLock = NSLock()
  private static var upFlag = false
  static var upNow: Bool { upLock.lock(); defer { upLock.unlock() }; return upFlag }
  private static func markUp(_ v: Bool) { upLock.lock(); upFlag = v; upLock.unlock() }

  // Its own Esc hotkey while it is up (the tap is deaf exactly when this card shows).
  private var escRef: EventHotKeyRef?
  private var escHandler: EventHandlerRef?
  private static let sig: OSType = 0x5053_5442   // "PSTB"

  /// Settings, Keyboard and Tab: "Tell me when Tab is blocked". On unless switched off (this Mac).
  var on: Bool { UserDefaults.standard.object(forKey: TabBlocked.defaultsKey) as? Bool ?? true }
  func setOn(_ v: Bool) {
    guard v != on || UserDefaults.standard.object(forKey: TabBlocked.defaultsKey) == nil else { return }
    UserDefaults.standard.set(v, forKey: TabBlocked.defaultsKey)
    psLog("PS tab blocked: Tell me when Tab is blocked is \(v ? "On" : "Off")")
    if !v { hide() }
    SafePeek.shared.refresh()
    evaluate()
  }

  func start(app: App) {
    guard !IS_TEST_COPY, !started else { return }
    started = true
    self.app = app
    var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))]
    InstallEventHandler(GetEventDispatcherTarget(), { _, event, _ in
      guard let event else { return OSStatus(eventNotHandledErr) }
      var id = EventHotKeyID()
      GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                        MemoryLayout<EventHotKeyID>.size, nil, &id)
      guard id.signature == TabBlocked.sig else { return OSStatus(eventNotHandledErr) }
      DispatchQueue.main.async { _ = TabBlocked.shared.escape() }
      return noErr
    }, types.count, &types, nil, &escHandler)
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.evaluate() }
    timer?.tolerance = 0.2
    evaluate()
  }

  // MARK: what PS knows

  private func facts() -> TabBlockedFacts {
    let w = TabWatch.shared
    let now = CACurrentMediaTime()
    if now - trustedAt > 2 { trusted = AXIsProcessTrusted(); trustedAt = now }
    let me = ProcessInfo.processInfo.processIdentifier
    return TabBlockedFacts(on: on, enabled: w.enabled,
                           holdsTab: w.shortcutList.contains { $0.kind == .hold && $0.key == OpenKeysCore.TAB },
                           trusted: trusted, deaf: Popup.shared.model.st.deaf,
                           secureOn: SecureInputWatch.isOn(), holderIsMe: SecureInputWatch.shared.holder?.pid == me,
                           protectedFront: Protected.front, shown: app?.shown ?? false, kept: app?.kept ?? false,
                           sleepUp: app?.sleepUp ?? false, appActive: w.appActive, frontIgnored: w.frontIgnored,
                           testCopy: IS_TEST_COPY)
  }

  /// Every second, and at once on the changes that matter (1Password or Signal to the front, the list opening).
  func evaluate() {
    guard started else { return }
    let f = facts()
    let cause = TabBlockedCore.blind(f)
    setBlind(cause != nil)
    guard let up = upCause, model.phase == .blocked else { return }
    if f.protectedFront || f.shown || f.sleepUp || !f.on || !f.enabled {
      hide()   // out of the way at once (golden rule for 1Password and Signal: gone, never a word)
      return
    }
    let fixedNow: Bool
    switch up {
    case .permission: fixedNow = f.trusted && !f.deaf
    case .secureInput: fixedNow = !f.secureOn || (cause == nil && f.holderIsMe)
    }
    if fixedNow {
      psLog("PS tab blocked: \(up.rawValue) is gone, Tab works again")
      showFixed()
    } else if up == .secureInput, let c = cause, c == .secureInput {
      // Another app holds it now: the card follows (a new name, never a protected one).
      let h = currentHolder()
      if TabBlockedCore.key(.secureInput, h.holder) != upKey { fill(.secureInput, h) }
    }
  }

  func protectedChanged() { evaluate() }
  /// The list opened: the card has nothing more to say.
  func listShown() { if upCause != nil { hide() } }

  private func currentHolder() -> (holder: TabBlockedHolder?, icon: NSImage?) {
    let me = ProcessInfo.processInfo.processIdentifier
    let h = SecureInputWatch.shared.holder
    let label = SecureInputCore.label(h, me: me, appName: AppName.current)
    let kind = TabBlockedCore.holder(label: label, appName: AppName.current, bundleId: h?.bundleId)
    var icon: NSImage?
    // Golden rule: a password app gets no icon (and no name, above). Only a named app's icon is read.
    switch kind {
    case .app, .secureEntry:
      if let h, !Protected.matches(h.bundleId), !Protected.matches(h.name) { icon = NSRunningApplication(processIdentifier: h.pid)?.icon }
    default: break
    }
    return (kind, icon)
  }

  // MARK: the key state poll

  private func setBlind(_ b: Bool) {
    mu.lock(); let was = blindNow; blindNow = b; mu.unlock()
    guard b != was else { return }
    if b {
      hotkeySaw = false
      let t = DispatchSource.makeTimerSource(queue: q)
      t.schedule(deadline: .now() + TabBlockedCore.pollEvery, repeating: TabBlockedCore.pollEvery, leeway: .milliseconds(15))
      t.setEventHandler { [weak self] in self?.pollTick() }
      poll = t
      q.async { [weak self] in self?.clock.reset(); self?.keyStateSaw = false }
      t.resume()
    } else {
      poll?.cancel(); poll = nil
    }
  }

  /// One look at macOS's record of whether Tab is down. Never while 1Password or Signal is in front (checked here too,
  /// so a look can never land after one came forward and before main noticed).
  private func pollTick() {
    mu.lock(); let b = blindNow; mu.unlock()
    guard b, !Protected.front else { clock.reset(); return }
    let down = CGEventSource.keyState(.hidSystemState, key: CGKeyCode(OpenKeysCore.TAB))
    if down && !keyStateSaw {
      keyStateSaw = true
      psLog("PS tab blocked: macOS's key state shows Tab down while PS is blind (this signal works here)")
    }
    if clock.step(down: down, now: CACurrentMediaTime()) {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        if SafePeek.shared.isDown { return }   // the hotkey has this hold (it brings the card or the list itself)
        self.sawHold(signal: "key state")
      }
    }
  }

  // MARK: a hold

  /// Tab has been held for TabBlockedCore.holdFor and the list is not up. From SafePeek's hotkey or the key state poll.
  /// False: PS is not blind any more (Secure Input went off a moment ago), so the caller opens the list as for any hold.
  @discardableResult
  func sawHold(signal: String) -> Bool {
    guard started else { return false }
    if signal == "hotkey" && !hotkeySaw {
      hotkeySaw = true
      psLog("PS tab blocked: the Tab hotkey sees Tab while PS is blind (this signal works here)")
    }
    let f = facts()
    guard let cause = TabBlockedCore.blind(f) else { return false }
    let h: (holder: TabBlockedHolder?, icon: NSImage?) = cause == .secureInput ? currentHolder() : (nil, nil)
    let key = TabBlockedCore.key(cause, h.holder)
    let now = Date().timeIntervalSince1970
    if upCause != nil && model.phase == .blocked {
      if key != upKey { fill(cause, h) }
      withAnimation(.linear(duration: 0.45)) { model.shake += 1 }   // still blocked: a little shake
      pressKey()
      return true
    }
    guard TabBlockedCore.allow(key: key, now: now, memo: memo, up: false) else { return true }
    memo = TabBlockedCore.shown(memo, now: now)
    psLog(TabBlockedCore.logShow(cause, holder: h.holder, signal: signal))
    show(cause, h)
    return true
  }

  // MARK: buttons and Esc

  private func pressed(_ a: String) {
    switch a {
    case "settings":
      psLog("PS tab blocked: Open Settings")
      if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") { NSWorkspace.shared.open(u) }
      close()
    default:
      close()
    }
  }

  /// Esc, its x or OK: gone, and the same cause and app stay quiet for a while.
  private func close() {
    if model.phase == .blocked && upCause != nil {
      memo = TabBlockedCore.closed(memo, key: upKey, now: Date().timeIntervalSince1970)
      psLog("PS tab blocked: closed")
    }
    hide()
  }

  /// Esc (the keyboard tap, App.escKey, or its own hotkey). True when it was up.
  func escape() -> Bool {
    guard upCause != nil || model.visible || panel?.isVisible == true else { return false }
    close()
    return true
  }

  // MARK: the panel

  private func setUpPanel() {
    guard panel == nil else { return }
    model.act = { [weak self] a in self?.pressed(a) }
    let h = TabBlockedHost(rootView: TabBlockedView(m: model))
    let p = TabBlockedPanel(contentRect: NSRect(x: 0, y: 0, width: TabBlockedView.width + 48, height: 300), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false
    p.backgroundColor = .clear
    p.hasShadow = false                       // the card draws its own soft shadow
    p.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)   // above the Tab list (statusBar)
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    p.contentView = h
    panel = p; host = h
  }

  private func fill(_ cause: TabBlockedCause, _ h: (holder: TabBlockedHolder?, icon: NSImage?)) {
    let pane = TabBlockedCore.paneName(macOSMajor: ProcessInfo.processInfo.operatingSystemVersion.majorVersion)
    upCause = cause
    upKey = TabBlockedCore.key(cause, h.holder)
    model.cause = cause
    model.holder = h.holder
    model.icon = h.icon
    model.text = TabBlockedCore.text(cause, holder: h.holder, appName: AppName.current, pane: pane)
    place()
  }

  private func show(_ cause: TabBlockedCause, _ h: (holder: TabBlockedHolder?, icon: NSImage?)) {
    gen += 1
    let g = gen
    setUpPanel()
    guard let panel else { return }
    var still = Transaction(); still.disablesAnimations = true
    withTransaction(still) {
      model.phase = .blocked; model.visible = false; model.hover = nil; model.press = false
      model.stepsIn = 0; model.glow = false
    }
    fill(cause, h)
    Popup.shared.hide(giveBack: false)   // the "PS app is active" card would say the same thing behind it
    panel.orderFrontRegardless()
    TabBlocked.markUp(true)
    armEsc(true)
    withAnimation(.spring(response: 0.48, dampingFraction: 0.74)) { model.visible = true }
    withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { model.glow = true }
    // The steps come in one after another, and the Tab key cap starts pressing.
    for i in 1...max(1, model.text.steps.count) {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.18 + Double(i) * 0.08) { [weak self] in
        guard let self, g == self.gen else { return }
        withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { self.model.stepsIn = i }
      }
    }
    pressTimer?.invalidate()
    pressTimer = Timer.scheduledTimer(withTimeInterval: 1.4, repeats: true) { [weak self] _ in self?.pressKey() }
    pressKey()
  }

  /// The little Tab key cap goes down and comes back up.
  private func pressKey() {
    let g = gen
    withAnimation(.easeIn(duration: 0.09)) { model.press = true }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
      guard let self, g == self.gen else { return }
      withAnimation(.spring(response: 0.3, dampingFraction: 0.5)) { self.model.press = false }
    }
  }

  /// "Tab works again": the card turns into a short green line, then goes by itself.
  private func showFixed() {
    guard panel != nil else { hide(); return }
    upCause = nil
    gen += 1
    let g = gen
    pressTimer?.invalidate(); pressTimer = nil
    withAnimation(.easeIn(duration: 0.14)) { model.visible = false }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
      guard let self, g == self.gen else { return }
      var still = Transaction(); still.disablesAnimations = true
      withTransaction(still) { self.model.phase = .fixed; self.model.hover = nil }
      self.place()
      withAnimation(.spring(response: 0.42, dampingFraction: 0.78)) { self.model.visible = true }
      DispatchQueue.main.asyncAfter(deadline: .now() + TabBlockedCore.fixedFor) { [weak self] in
        guard let self, g == self.gen else { return }
        self.hide()
      }
    }
  }

  /// Fades out, then the window is removed (nothing invisible stays on screen). Safe at any time.
  func hide() {
    let wasShowing = upCause != nil || model.visible || panel?.isVisible == true
    gen += 1
    let g = gen
    upCause = nil
    TabBlocked.markUp(false)
    armEsc(false)
    pressTimer?.invalidate(); pressTimer = nil
    guard wasShowing else { return }
    withAnimation(.easeIn(duration: 0.2)) { model.visible = false }
    var still = Transaction(); still.disablesAnimations = true
    withTransaction(still) { model.hover = nil; model.glow = false }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.24) { [weak self] in
      guard let self, g == self.gen else { return }   // shown again meanwhile
      self.remove()
    }
  }

  private func remove() {
    IslandColumn.shared.leave(TabBlocked.column)   // the next pop up may come out of the island
    TabBlocked.markUp(false)
    var still = Transaction(); still.disablesAnimations = true
    withTransaction(still) { model.visible = false; model.hover = nil; model.glow = false; model.stepsIn = 0 }
    panel?.orderOut(nil)
    panel?.close()
    panel?.contentView = nil
    panel = nil; host = nil
  }

  /// Out of the island while it is there for cards and no other card is out of it now (the queue never puts one card
  /// over another, and this one cannot wait: the developer is holding Tab now); else the middle of the screen with the pointer.
  private func place() {
    guard let panel, let host else { return }
    host.layoutSubtreeIfNeeded()
    let size = host.fittingSize
    let free = IslandQueue.shared.activeId == nil || IslandQueue.shared.activeId == TabBlocked.column
    if free, let f = IslandColumn.shared.frame(id: TabBlocked.column, kind: TabBlocked.column, size: size, window: panel,
                                               replace: { [weak self] in if self?.panel?.isVisible == true { self?.place() } }) {
      IslandColumn.shared.put(panel, f)
      return
    }
    IslandColumn.shared.leave(TabBlocked.column)
    let mouse = NSEvent.mouseLocation
    guard let s = NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens.first else { return }
    let v = s.visibleFrame
    let y = v.minY + v.height * 0.6 - size.height / 2
    panel.setFrame(NSRect(x: (v.midX - size.width / 2).rounded(), y: max(v.minY, y.rounded()), width: size.width, height: size.height), display: true)
    panel.orderFrontRegardless()
  }

  /// Its own Esc while it is up. Never while 1Password or Signal is in front (it is never up then anyway).
  private func armEsc(_ want: Bool) {
    if want && escRef == nil && !Protected.front {
      let st = RegisterEventHotKey(UInt32(kVK_Escape), 0, EventHotKeyID(signature: TabBlocked.sig, id: 1), GetEventDispatcherTarget(), 0, &escRef)
      if st != noErr { escRef = nil }   // the list's own Esc may hold it; the keyboard tap and the buttons still close it
    } else if !want, let r = escRef {
      UnregisterEventHotKey(r)
      escRef = nil
    }
  }
}
