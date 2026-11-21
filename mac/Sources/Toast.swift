import AppKit
import WebKit

// Notification pop-ups at the top right of the screen: a client's email ("Alex just sent an
// email", her subject, the first sentences of Gmail's preview) or what just changed in the vault
// ("Calendar refreshed"). The developer can switch them off in the Tab list's gear.
// Every card shows at once, newest at the top (the developer, 30 Oct 2026: no more stack to click open), in a
// list capped at 45% of the screen that scrolls inside itself (the developer, 31 Oct 2026: "make it so they don't
// take up the whole screen"). The window is never taller than what shows, so clicks below it reach the
// apps underneath. A drag or a two finger swipe to the right dismisses a card. A click on an email
// opens it in Gmail.
// V1.55 (the developer, 12 Nov 2026: "if my dynamic island is on ... I want them to come out of the dynamic island instead with a
// nice animation"): while the Dynamic Island is on screen and Settings' "Notifications come from the Dynamic Island" is
// on, this same window hangs centred under the island instead (NoteDropCore.swift has the rule): each new card drops out
// of the island as it swells, a dismissed one shrinks back up into it, and the stack follows the island wherever it is
// moved. Same window, level, page and buttons as the corner, so Do Not Disturb, Sentry, Sleep mode, full screen apps,
// 1Password and Signal all work exactly as they always did. Island off, hidden, or the setting off: the corner.
// The panel never activates PS. It takes the keyboard only while the developer types a time into a card's
// Remind me in (never over 1Password or Signal, never in a test copy), then hands it back. Its page
// is built in here: no network, no vault, it only ever holds the cards it was handed.
final class NotePanel: NSPanel {
  var keyable = false
  override var canBecomeKey: Bool { keyable }
  override var canBecomeMain: Bool { false }
}

/// Holds the cards' page and tells it where the pointer is, even while PS is not the front app (the page
/// gets no hover then): "Remind me in" lights up while it would take the wheel. One call to the page at
/// a time, the last position never lost (as the Tab list's MouseFeed).
final class NoteView: NSView {
  weak var web: WKWebView?
  private var pending = false, latest: (Int, Int)?
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero, options: [.activeAlways, .mouseMoved, .mouseEnteredAndExited, .inVisibleRect], owner: self))
    super.updateTrackingAreas()
  }
  override func mouseMoved(with event: NSEvent) { if !Toast.testCopy { at(event) } }
  override func mouseEntered(with event: NSEvent) { if !Toast.testCopy { at(event) } }
  override func mouseExited(with event: NSEvent) { if !Toast.testCopy { latest = (-1, -1); flush() } }
  private func at(_ event: NSEvent) {
    guard let web else { return }
    let p = web.convert(event.locationInWindow, from: nil)
    latest = (Int(p.x), Int(web.isFlipped ? p.y : web.bounds.height - p.y))
    flush()
  }
  /// Self test: the pointer at a page point (-1, -1 is gone).
  func testPointer(_ x: Int, _ y: Int) { latest = (x, y); flush() }
  private func flush() {
    guard let web, !pending, let (x, y) = latest else { return }
    latest = nil; pending = true
    web.evaluateJavaScript("window.__note&&window.__note.ptr(\(x),\(y))") { [weak self] _, _ in self?.pending = false; self?.flush() }
  }
}

final class Toast: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  /// The top right stack, and the one every caller talks to: it routes each card (V1.55, see "two stacks" below).
  static let shared = Toast(role: .corner)
  private(set) var panel: NotePanel!
  private(set) var web: ClickThroughWebView!       // read by the meeting cards self test
  private var ready = false
  private var waiting: [String] = []
  private static let width: CGFloat = 392
  static let testCopy = ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
  /// The tallest the stack may be (cards plus the "N notifications" bar): 45% of the screen, so on the
  /// 13 inch Air about two and a half cards show and the rest scroll.
  static func cap() -> Int { Int(((NSScreen.main?.visibleFrame.height ?? 800) * 0.45).rounded()) }
  private(set) var host: NoteView!
  /// Self test: how often the window really changed size (it must not while the stack stays capped).
  private(set) var resizes = 0
  /// The app the developer was in when he started typing a remind time: the keyboard goes back to it.
  private var returnTo: pid_t = 0
  /// A card button was clicked (or a card with an id was closed: action "dismiss").
  var onAction: ((String, String) -> Void)?
  /// V1.60 G Squad message card: the words typed in its Reply box, after the Undo ran out (SquadMessageCard.swift). Id and text only.
  var onSquadReply: ((String, String) -> Void)?
  /// A screen recorder card (id starts with sr:) left for good without a button: the x, a timeout, a swipe, Clear all.
  static var onCardGone: ((String) -> Void)?
  /// V1.55: the Tab list's window while it is up (main.swift): a stack under the island that comes up then stays
  /// behind it, so it never covers the list's buttons that island clearance keeps clear.
  var listWindow: () -> NSWindow? = { nil }
  /// PS 1.73 swipe leak (SwipeLeakCore.swift): hands one scroll event to the Tab list's page (main.swift handToList).
  static var handToList: ((NSEvent) -> Void)?
  /// While the Tab list is up, a sideways two finger swipe that lands on a card goes to the list (its page moves) and
  /// no longer dismisses the card. Up or down first stays with the cards. The list hidden: the cards keep every gesture.
  private var cardRoute = SwipeLeakCore.CardRoute()
  private var routeMonitor: Any?
  private func watchSwipes() {
    guard routeMonitor == nil, !Toast.testCopy else { return }
    routeMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
      guard let self, let p = self.panel, e.window === p else { return e }
      let listUp = Toast.shared.listWindow() != nil && Toast.handToList != nil
      switch self.cardRoute.route(SwipeLeak.wheel(e), listUp: listUp) {
      case .cards: return e
      case .both: Toast.handToList?(e); return e
      case .list: Toast.handToList?(e); return nil
      }
    }
  }

  // ---------- two stacks: the corner and the Dynamic Island (V1.55, NoteDropCore.swift) ----------
  // Two card windows made from this same class: `shared`, always in the top right corner as it always was, and
  // `island`, always hanging from the Dynamic Island. The developer (12 Nov 2026): "add it customizable in settings so you can
  // decide which notifications actually pop out the dynamic island and which notifications go on the top". `shared`
  // routes every card (NoteDrop.route: its kind, the developer's Island or Top right choice for that kind, and whether the island
  // is there right now) and moves cards across when that changes: the island hides (grab line, 1Password or Signal, a
  // full screen app) and its cards go to the corner; it comes back and they drop out of it again.
  enum Role { case corner, island }
  let role: Role
  private init(role: Role) { self.role = role; super.init() }
  private var islandMade = false
  private lazy var islandStack: Toast = {
    let t = Toast(role: .island)
    t.onAction = { [weak self] id, a in self?.onAction?(id, a) }
    islandMade = true
    return t
  }()
  /// Every card with an id now on a stack: its card, kind, order and which stack has it (routing and moves).
  private struct Kept { var json: String; var kind: String; var seq: Int; var inIsland: Bool; var key: String }
  private var kept: [String: Kept] = [:]
  private var seq = 0
  /// Cards that ran out their own time (an AI chat card's line, V1.55): id and when it finished. The same card sent
  /// again (a sync, a restart) stays away; a new finish of that chat has a new time and shows. Kept 4 hours (a chat
  /// card lives 3), in this Mac's PS settings so a restart does not bring them back (never in a test copy).
  private var expired: [String: Double] = [:]
  private static let expiredKey = "notes.expired"
  private var expiredLoaded = false

  /// Where the cards are now: the corner, or hanging from the island (the island stack only).
  private(set) var home: NoteDrop.Home = .corner
  /// The height the page last asked for (0: nothing showing).
  private var lastH: CGFloat = 0
  /// A self test copy keeps every card in the corner unless a test asks for the island.
  var testIslandHome = false
  private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
  /// The tallest the stack may be where it is now.
  private func capNow() -> Int {
    if case .island(let sp) = home { return Int(sp.room) }
    if stackOn { return Int(NoteStackCore.cap(visibleHeight: NSScreen.main?.visibleFrame.height ?? 800, on: true)) }
    return Toast.cap()
  }
  // ---------- stacked notifications (PS 1.65, NoteStackCore.swift) ----------
  // Switch on (Settings, From the squad, "Stacked notifications", on by default): with more than one card waiting the page shows
  // only the newest with a "+N" badge, the list opens on hover and may use the whole screen height. Switch off: today's list.
  private var stackOn: Bool { Features.on(NoteStackCore.feature) }
  /// A click is keeping the opened list open (the page says; Esc then closes it).
  private var stackPinned = false
  /// The list is open (a click or the pointer keeps it so): Esc closes it, from the global key handler (TabWatch).
  private var stackOpen = false
  /// Read from the keyboard tap's thread.
  static var stackOpenNow: Bool { NoteStackCore.watch.anyOpen }
  private static var stackWatching = false
  /// The switch changed (Settings): both stacks hear it, and the island stack's room follows the new cap.
  fileprivate func stackSwitched() {
    guard role == .corner else { return }
    if islandMade { islandStack.refreshHome(); islandStack.pageMode() }
    pageMode()
  }
  /// Esc: an open list closes, however it was opened. True when it did (the Esc is used up).
  func escapeStack() -> Bool {
    var used = false
    if role == .corner, islandMade, islandStack.escapeStack() { used = true }
    guard panel != nil, ready, stackOpen || stackPinned else { return used }
    stackPinned = false; stackOpen = false
    NoteStackCore.watch.set(ObjectIdentifier(self), false)
    web.evaluateJavaScript("window.__note&&window.__note.esc()", completionHandler: nil)
    return true
  }
  private func frame(_ h: CGFloat) -> NSRect? {
    switch home {
    case .corner: guard let vf = NSScreen.main?.visibleFrame else { return nil }; return NoteDrop.corner(visible: vf, height: h)
    case .island(let sp): return NoteDrop.frame(sp, height: h)
    }
  }
  /// Is the island there for cards right now (on screen, the setting on, not hidden by its own rules)?
  private func islandThere() -> Bool {
    if Toast.testCopy && !testIslandHome { return false }
    return Island.shared.noteAnchor() != nil
  }
  private func stack(_ island: Bool) -> Toast { island ? islandStack : self }

  // The router (shared only).
  private func deliver(_ json: String, id: String?, kind: String, at: String?) {
    loadExpired()
    let there = islandThere(), top = Island.shared.model.st.cardsTop
    let toIsland = NoteDrop.route(kind: kind, island: there, top: top)
    guard let id else { stack(toIsland).enqueue(json); return }
    let key = "\(id)|\(at ?? "")"
    if expired[key] != nil { return }
    seq += 1
    if let k = kept[id], k.inIsland != toIsland { stack(k.inIsland).take(id) }
    kept[id] = Kept(json: json, kind: kind, seq: seq, inIsland: toIsland, key: key)
    stack(toIsland).enqueue(json)
  }
  /// A card left its stack for good (dismissed, answered, timed out, Clear all): the page said so.
  fileprivate func gone(_ id: String, timedOut: Bool) {
    guard role == .corner else { Toast.shared.gone(id, timedOut: timedOut); return }
    if id.hasPrefix("sr:") { Toast.onCardGone?(id) }   // 12b fix: the screen recorder's cards finish in the island queue when they close
    if timedOut, let k = kept[id] {
      expired[k.key] = Date().timeIntervalSince1970
      saveExpired()
    }
    kept[id] = nil
  }
  private func loadExpired() {
    guard !expiredLoaded else { return }
    expiredLoaded = true
    guard !Toast.testCopy, let d = UserDefaults.standard.dictionary(forKey: Toast.expiredKey) as? [String: Double] else { return }
    expired = d
    pruneExpired()
  }
  private func pruneExpired() {
    let now = Date().timeIntervalSince1970
    expired = expired.filter { now - $0.value < 4 * 3600 }
    if expired.count > 200 { expired = Dictionary(uniqueKeysWithValues: expired.sorted { $0.value > $1.value }.prefix(200).map { ($0.key, $0.value) }) }
  }
  private func saveExpired() {
    pruneExpired()
    if !Toast.testCopy { UserDefaults.standard.set(expired, forKey: Toast.expiredKey) }
  }

  /// The island moved, grew, shrank, hid or came back, or a setting changed (Island.swift): the island stack follows
  /// it, and cards whose place changed move across (oldest first, so the newest ends on top).
  func islandChanged() {
    guard role == .corner else { return }
    IslandColumn.shared.islandChanged()      // the pop ups with windows of their own follow too
    if islandMade { islandStack.refreshHome() }
    guard !kept.isEmpty else { return }
    let there = islandThere(), top = Island.shared.model.st.cardsTop
    let moves = kept.filter { NoteDrop.route(kind: $0.value.kind, island: there, top: top) != $0.value.inIsland }.sorted { $0.value.seq < $1.value.seq }
    for (id, k) in moves {
      stack(k.inIsland).take(id)
      kept[id]?.inIsland = !k.inIsland
      stack(!k.inIsland).enqueue(k.json)
    }
  }
  /// Which stack has this card now (self test and the note's checks): "island", "corner" or nil.
  /// Takes a card down quietly (no answer, no gulp): private mode went on and the card must not stay on screen. The screen recorder (12b) uses it.
  func retractCard(_ id: String) {
    guard let k = kept[id] else { return }
    kept[id] = nil
    stack(k.inIsland).take(id)
  }
  func stackOf(_ id: String) -> String? { kept[id].map { $0.inIsland ? "island" : "corner" } }

  /// The island stack: follows the island's spot. Gone (hidden, off), it stays where it was: the router has moved its
  /// cards to the corner, so its window is empty and hidden by then.
  fileprivate func refreshHome() {
    guard role == .island else { return }
    let a = Island.shared.noteAnchor()
    var want = NoteDrop.home(a, cap: NoteStackCore.cap(visibleHeight: a?.visible.height ?? 800, on: stackOn))
    // Pop ups with windows of their own may already hang under the island (IslandColumn.swift): the stack starts past them.
    if case .island(let sp) = want { want = .island(NoteDrop.shifted(sp, by: IslandColumn.shared.height)) }
    guard case .island = want, want != home else { return }
    let old = home
    home = want
    guard panel != nil else { return }
    let up: Bool
    if case .island(let sp) = want { up = sp.side == .above } else { up = false }
    let showing = panel.isVisible && lastH > 0
    // Above the island the web view keeps one height (the room) and the window shows its bottom part, so growing the
    // window upwards never makes the page lay itself out again (that would make the cards jump for a frame).
    func geometry() {
      if up, case .island(let sp) = want {
        web.autoresizingMask = [.width]
        web.frame = NSRect(x: 0, y: 0, width: Toast.width, height: max(sp.room, 10))
      } else {
        web.autoresizingMask = [.width, .height]
        web.frame = host.bounds
      }
      pageMode()
      if lastH > 0, let f = frame(lastH) { panel.setFrame(f, display: true) }
    }
    guard showing else { geometry(); return }
    if NoteDrop.jump(old, want) {
      // Below the island to above it, or a long way: a quick fade, never a slide across the screen.
      let alpha: CGFloat = Toast.testCopy ? 0 : 1
      NSAnimationContext.runAnimationGroup({ ctx in
        ctx.duration = 0.12
        panel.animator().alphaValue = 0
      }, completionHandler: { [weak self] in
        guard let self else { return }
        geometry()
        NSAnimationContext.runAnimationGroup { ctx in
          ctx.duration = 0.22
          self.panel.animator().alphaValue = alpha
        }
      })
    } else {
      pageMode()
      guard let f = frame(lastH) else { return }
      if case .island(let sp) = want, sp.side == .above { web.frame = NSRect(x: 0, y: 0, width: Toast.width, height: max(sp.room, 10)) }
      NSAnimationContext.runAnimationGroup { ctx in
        ctx.duration = reduceMotion ? 0 : 0.3
        ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.3, 1)
        panel.animator().setFrame(f, display: true)
      }
    }
  }
  /// The page hears where the cards hang from: off (the corner), or the island's centre and width over the window,
  /// and whether the stack is above it (the page mirrors itself then).
  private func pageMode() {
    guard ready else { return }
    var js = "window.__note.mode({on:false,up:false,ix:196,iw:330})"
    if case .island(let sp) = home {
      js = String(format: "window.__note.mode({on:true,up:%@,ix:%.1f,iw:%.1f})", sp.side == .above ? "true" : "false", sp.islandX, sp.islandW)
    }
    web.evaluateJavaScript("\(js);window.__note.stack(\(stackOn));window.__note.max(\(capNow()))", completionHandler: nil)
  }
  /// Self test: where the cards are, as words.
  var homeText: String {
    switch home { case .corner: return "corner"; case .island(let sp): return sp.side == .above ? "island-above" : "island-below" }
  }

  private func setUp() {
    guard panel == nil else { return }
    if !Toast.stackWatching { Toast.stackWatching = true; Features.observers.append { Toast.shared.stackSwitched() } }
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.userContentController.add(self, name: "note")
    web = ClickThroughWebView(frame: NSRect(x: 0, y: 0, width: Toast.width, height: 10), configuration: c)
    web.setValue(false, forKey: "drawsBackground")
    web.navigationDelegate = self
    panel = NotePanel(contentRect: NSRect(x: 0, y: 0, width: Toast.width, height: 10), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false             // the cards draw their own soft shadows
    panel.level = .statusBar
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.acceptsMouseMovedEvents = true
    host = NoteView(frame: web.frame)
    host.web = web
    web.autoresizingMask = [.width, .height]
    host.addSubview(web)
    panel.contentView = host
    // A self test copy never shows anything on the developer's screen and never catches his clicks
    // (the pictures still render from the invisible panel, like the Tab list's).
    if ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil { panel.alphaValue = 0; panel.ignoresMouseEvents = true }
    watchSwipes()   // PS 1.73 swipe leak
    web.loadHTMLString(Toast.page, baseURL: nil)
  }

  /// V1.57 private mode: the pill a pop up with a window of its own waits behind (PrivateHold.swift). Only the two lines.
  func showPill(_ key: String) {
    setUp()
    let id = PrivateCore.cardId(key)
    let card: [String: Any] = ["id": id, "title": PrivateCore.title, "sub": PrivateCore.sub, "pill": true, "sticky": true]
    guard let data = try? JSONSerialization.data(withJSONObject: card), let json = String(data: data, encoding: .utf8) else { return }
    deliver(json, id: id, kind: NoteDrop.kind(id: id, tone: nil), at: nil)
  }

  /// Plain one-liners keep working: the line becomes the headline.
  func show(_ text: String) { show(title: text) }

  func show(title: String, sub: String? = nil, body: String? = nil, url: String? = nil) {
    setUp()
    var card: [String: Any] = ["title": String(title.prefix(160))]
    if let sub, !sub.isEmpty { card["sub"] = String(sub.prefix(200)) }
    if let body, !body.isEmpty { card["body"] = String(body.prefix(600)) }
    if let url, url.hasPrefix("https://mail.google.com/") { card["url"] = url }   // Gmail links only
    guard let data = try? JSONSerialization.data(withJSONObject: card), let json = String(data: data, encoding: .utf8) else { return }
    deliver(json, id: nil, kind: NoteDrop.kind(id: nil, tone: nil), at: nil)
    chimeOther("p:" + String(title.prefix(160)))
  }

  /// One stack: its window and page are made on first use; the card goes up once the page is ready.
  fileprivate func enqueue(_ json: String) {
    setUp()
    if ready { push(json) } else { waiting.append(json) }
  }
  private func push(_ json: String) {
    if role == .island { refreshHome() }      // a new card comes from where the island is right now
    web.evaluateJavaScript("window.__note.max(\(capNow()));window.__note.add(\(json))", completionHandler: nil)
  }
  /// One stack: the card leaves quietly because it moves to the other stack (no answer, no gulp).
  fileprivate func take(_ id: String) {
    guard panel != nil else { return }
    if !ready { waiting.removeAll { $0.contains("\"id\":\"\(id)\"") }; return }
    guard let data = try? JSONSerialization.data(withJSONObject: [id]), let json = String(data: data, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.__note.take(\(json)[0])", completionHandler: nil)
  }

  /// A card with an id and up to three buttons (eg "Shall I end my day now?"). The same id replaces
  /// the card already showing, so there is never more than one. Sticky cards stay until answered.
  func showCard(_ c: [String: Any]) {
    guard let id = c["id"] as? String, !id.isEmpty, id.count <= 40, let title = c["title"] as? String, !title.isEmpty else { return }
    if hold(c, meet: false) { return }
    setUp()
    var card: [String: Any] = ["id": id, "title": String(title.prefix(160)), "sticky": (c["sticky"] as? Bool) == true]
    if let sub = c["sub"] as? String, !sub.isEmpty { card["sub"] = String(sub.prefix(200)) }
    if let body = c["body"] as? String, !body.isEmpty { card["body"] = String(body.prefix(600)) }
    if let acts = c["actions"] as? [[String: Any]] {
      card["actions"] = acts.prefix(3).compactMap { a -> [String: String]? in
        guard let i = a["id"] as? String, let l = a["label"] as? String, !i.isEmpty, !l.isEmpty else { return nil }
        return ["id": String(i.prefix(20)), "label": String(l.prefix(24))]
      }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: card), let json = String(data: data, encoding: .utf8) else { return }
    deliver(json, id: id, kind: NoteDrop.kind(id: id, tone: nil), at: nil)
    if !["gym", "f-rest"].contains(id) && !id.hasPrefix("sr:") { chimeOther("c:" + id) }   // the screen recorder's cards (12b) make their own sound, and none in private mode   // the gym and rest cards have their own sounds
  }

  /// Links a card may open: the thread (Gmail or Instantly) or the call itself. Nothing else.
  static func openable(_ s: String?) -> String? {
    guard let s, let u = URL(string: s), u.scheme == "https", let h = u.host?.lowercased() else { return nil }
    let ok = ["mail.google.com", "app.instantly.ai", "meet.google.com", "zoom.us", "teams.microsoft.com", "teams.live.com"]
    return ok.contains(h) || h.hasSuffix(".zoom.us") ? s : nil
  }

  /// A meeting alert (src/core/meetalerts.ts): its own look per tone (green booked, amber message,
  /// red cancel, quiet reminder), a countdown to the call, Open thread and Join call buttons. While
  /// private mode is on it arrives "discreet": one plain line, no names or text, until clicked or
  /// until the developer holds Tab.
  func showMeet(_ c: [String: Any]) {
    if (c["tone"] as? String) == "notes" { NotesCard.shared.show(c); return }   // the meeting notes card has its own window (NotesCard.swift)
    // Meeting tones, then the network monitor's (ok green, warn amber, bad red, info purple).
    // Meeting tones, the network monitor's (ok, warn, bad, info) and "mail": a client email that
    // stays until the developer clicks its Dismiss button, or Remind me in (src/mailcards.ts brings it back then).
    // "done": a Claude Code chat finished (src/core/chatdone.ts); stays until its X, or the page drops it after a few hours.
    // "lead": a lead replied in Instantly (src/mailcards.ts), Instantly blue, kept like a client email.
    // "ai": a message an AI sent through the Task API (V1.58, AiMessageCard.swift), kept like an AI chat card.
    let tones = ["booked", "declined", "msg", "cancel", "soon", "soon-warn", "ok", "warn", "bad", "info", "mail", "done", "lead", AiMessageCard.tone, SquadMessageCard.tone]
    guard let id = c["id"] as? String, !id.isEmpty, id.count <= 40, let title = c["title"] as? String, !title.isEmpty,
          let tone = c["tone"] as? String, tones.contains(tone) else { return }
    // V1.60 G Squad message card (SquadMessageCard.swift): not while Sentry mode or Sleep mode covers the screen.
    if tone == SquadMessageCard.tone, SquadMessageCore.held(sentry: Sentry.shared.isUp, sleep: SleepScreen.shared.isUp) { return }
    if hold(c, meet: true) { return }   // Do Not Disturb holds it (for the island card too)
    // PS 1.63 (SquadIsland.swift): with the island on and the person's switch on, the message comes out of the island instead.
    if tone == SquadMessageCard.tone, SquadIsland.shared.take(c) { return }
    setUp()
    var card: [String: Any] = ["id": id, "kind": "meet", "tone": tone, "title": String(title.prefix(160)),
                               "sticky": ["msg", "cancel", "declined", "soon-warn", "warn", "bad", "mail", "done", "lead", AiMessageCard.tone, SquadMessageCard.tone].contains(tone), "dismiss": ["mail", "done", "lead", AiMessageCard.tone, SquadMessageCard.tone].contains(tone), "discreet": (c["discreet"] as? Bool) == true,
                               "discreetText": String(((c["discreetText"] as? String) ?? "A meeting alert").prefix(80))]
    if let sub = c["sub"] as? String, !sub.isEmpty { card["sub"] = String(sub.prefix(200)) }
    if let body = c["body"] as? String, !body.isEmpty { card["body"] = String(body.prefix(tone == AiMessageCard.tone ? AiMessageCard.detailMax : 600)) }
    if let at = c["callAt"] as? String, ISO8601DateFormatter().date(from: at) != nil || at.count < 40 { card["callAt"] = at }
    if let icon = c["icon"] as? String, ["shield", "globe", "wifi", "plug", "swap", "mail", "done", "reply", "whatsapp", AiMessageCard.icon, SquadMessageCard.icon].contains(icon) { card["icon"] = icon }
    if let at = c["at"] as? String, at.count < 40 { card["at"] = at }
    if let u = Toast.openable(c["url"] as? String) { card["url"] = u }
    if let j = Toast.openable(c["join"] as? String) { card["join"] = j }
    // V1.55: a card that goes by itself after this many seconds (AI chat cards, Settings), with a line that runs down.
    if let l = NoteDrop.life(c["life"]) { card["life"] = l }
    // Reply from PS (V1.44, MailSend.swift): a client email or a lead's reply can be answered from its card.
    if (c["reply"] as? Bool) == true && (tone == "mail" || tone == "lead" || tone == SquadMessageCard.tone) { card["reply"] = true }   // a WhatsApp card (icon whatsapp, tone mail) too: its Reply opens the Tab list's reply box
    // Remind me in: where it starts and how far one wheel step moves it (chat cards 2 and 1, emails 15 and 5).
    if let r = c["remind"] as? [String: Any], let st = r["start"] as? Int, let sp = r["step"] as? Int, let lo = r["min"] as? Int, let hi = r["max"] as? Int {
      let f = { (v: Int) in max(1, min(240, v)) }
      let mn = f(lo), mx = max(mn, f(hi))
      card["remind"] = ["start": max(mn, min(mx, f(st))), "step": f(sp), "min": mn, "max": mx]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: card), let json = String(data: data, encoding: .utf8) else { return }
    deliver(json, id: id, kind: NoteDrop.kind(id: id, tone: tone), at: card["at"] as? String)
    if ["ok", "warn", "bad", "info"].contains(tone) { chimeOther("m:\(id)|\(tone)") }
  }

  // ---------- colours and sounds per kind (V1.36, the developer 5 Nov 2026; web src/core/notelook.ts) ----------
  // The main window sends {type:"noteLook"}: for each kind the developer gave a colour (done, mail, lead, meet, other) the card's
  // tones, worked out and checked for readability there, and the Other alerts sound. Unset kinds keep the look above.
  // Every value is checked again here (a #RRGGBB, nothing else) and once more by the page before it becomes CSS.
  static let lookKinds = ["done", "mail", "lead", "meet", "other"]
  static let lookTones = ["c", "top", "bot", "icBg", "ic", "sub", "rem", "remHi", "line", "btn", "ink"]
  private var lookJSON = "{}"
  /// The Other alerts sound (cards made on the Mac: network, vault updates, the rest), nil = none (the default).
  private(set) var otherSound: String?
  /// When each Other alert last chimed: the same card shown again (a count going up, a sync) stays quiet for 10 minutes.
  private var chimed: [String: Date] = [:]
  static func hex(_ v: Any?) -> String? {
    guard let s = v as? String, s.count == 7, s.hasPrefix("#"), s.dropFirst().allSatisfy({ $0.isHexDigit }) else { return nil }
    return s
  }
  func setLook(_ l: [String: Any]) {
    var out: [String: Any] = [:]
    for k in Toast.lookKinds {
      guard let t = l[k] as? [String: Any] else { continue }
      var ok: [String: String] = [:]
      for key in Toast.lookTones { if let h = Toast.hex(t[key]) { ok[key] = h } }
      if ok.count == Toast.lookTones.count { out[k] = ok }
    }
    if let s = l["otherSound"] as? String, DND.cardSounds.contains(s), Sfx.specs[s] != nil { otherSound = s } else { otherSound = nil }
    guard let d = try? JSONSerialization.data(withJSONObject: out), let json = String(data: d, encoding: .utf8) else { return }
    applyLook(json)
    if islandMade { islandStack.applyLook(json) }   // V1.55: both stacks wear the same colours
  }
  fileprivate func applyLook(_ json: String) {
    if json == lookJSON { return }
    lookJSON = json
    if ready { web.evaluateJavaScript("window.__note.look(\(json))", completionHandler: nil) }
  }
  private func chimeOther(_ key: String) {
    guard let name = otherSound, PrivateCore.cardSound(privateOn: PrivateHold.shared.on) else { return }   // V1.57: silent in private mode
    let now = Date()
    chimed = chimed.filter { now.timeIntervalSince($0.value) < 600 }
    if chimed[key] != nil { return }
    chimed[key] = now
    Sfx.shared.play(name, volume: 0.55)   // quiet under Do Not Disturb's card sounds (Sfx.play)
  }
  /// Private mode on or off (settings.privateMode, the mask on the Tab list's Meetings panel; the developer,
  /// 29 Oct 2026): cards already showing hide or show their details, new ones arrive to match.
  func meetPrivacy(_ on: Bool) {
    privacyNow = on
    SquadIsland.shared.privacy = on   // PS 1.63: a meeting's privacy: G Squad messages use the corner card, which knows how to be discreet
    if role == .corner { PrivateHold.shared.set(on) }   // V1.57: pop ups with windows of their own wait behind pills
    if ready { web.evaluateJavaScript("window.__note.privacy(\(on))", completionHandler: nil) }
    if role == .corner, islandMade { islandStack.meetPrivacy(on) }
  }
  /// What a page that opens later must start with (the island stack's, made on its first card).
  private var privacyNow = false, revealNow = false
  /// The developer is holding Tab (the list is up): discreet cards show their details while it is.
  func reveal(_ on: Bool) {
    revealNow = on
    if ready { web.evaluateJavaScript("window.__note.reveal(\(on))", completionHandler: nil) }
    if role == .corner, islandMade { islandStack.reveal(on) }
  }

  /// The developer clicked a card's remind time to type one: the keyboard comes to the panel for it (never in
  /// a test copy, never over 1Password or Signal), and the box is focused either way.
  private func startTyping() {
    guard panel != nil else { return }
    if !Toast.testCopy && !Protected.front {
      returnTo = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
      panel.keyable = true
      panel.makeKey()
      panel.makeFirstResponder(web)
    }
    web.evaluateJavaScript("window.__note.focusEdit()", completionHandler: nil)
  }
  /// V1.41 Esc always backs out (EscAlways.swift): Esc while typing a remind time ends the typing and gives the keyboard back.
  func escape() {
    if role == .corner, islandMade { islandStack.escape() }
    guard panel != nil else { return }
    if ready { web.evaluateJavaScript("window.__note && window.__note.endEdit()", completionHandler: nil) }
    stopTyping()
  }
  private func stopTyping() {
    guard panel != nil else { return }
    let wasKey = panel.isKeyWindow
    panel.keyable = false
    if wasKey { panel.resignKey(); handBack() } else { returnTo = 0 }
  }
  /// The keyboard goes back to the app he was in (never 1Password or Signal, never in a test copy).
  private func handBack() {
    defer { returnTo = 0 }
    guard !Toast.testCopy, returnTo > 0, let app = NSRunningApplication(processIdentifier: returnTo), !Protected.matches(app) else { return }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == returnTo { app.activate(options: []) }
  }
  /// 1Password or Signal came to the front: any typing ends and the panel lets go of the keyboard.
  func protectedChanged() {
    if role == .corner, islandMade { islandStack.protectedChanged() }
    guard Protected.front, panel != nil, ready else { return }
    web.evaluateJavaScript("window.__note.endEdit()", completionHandler: nil)
    if panel.keyable || panel.isKeyWindow { panel.keyable = false; if panel.isKeyWindow { panel.resignKey() }; returnTo = 0 }
  }

  /// Self test: links a card asked to open (never opened in a test copy).
  private(set) var testOpened: [String] = []
  /// Self test: a fresh page, as after a PS restart (every card gone until the main window sends them again).
  func reloadForTest(_ done: @escaping () -> Void) {
    guard panel != nil else { return done() }
    ready = false; waiting = []
    web.loadHTMLString(Toast.page, baseURL: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { done() }
  }

  // ---------- Do Not Disturb (DND.swift, the developer 30 Oct 2026) ----------
  // A card whose kind is muted waits here (the same id replaces it, newest last) instead of showing, and
  // comes up the moment DND ends or that kind is let through. Never dropped: only its own cardHide (a
  // Dismiss on the phone, say) takes it away.
  private var held: [(id: String, card: [String: Any], meet: Bool)] = []
  var heldIds: [String] { held.map { $0.id } }   // self test
  private func muted(_ c: [String: Any]) -> Bool {
    // V1.43 focus modes: the page lets a sender on the mode's "always gets through" list through (src/mailcards.ts).
    if c["dndPass"] as? Bool == true { return false }
    guard let id = c["id"] as? String, let k = DND.kind(id: id, tone: c["tone"] as? String) else { return false }
    return DND.shared.mutes(k)
  }
  private func hold(_ c: [String: Any], meet: Bool) -> Bool {
    guard muted(c), let id = c["id"] as? String else { return false }
    hideCard(id)                                   // already on the stack: it steps back too
    held.append((id, c, meet))
    if held.count > 40 { held.removeFirst(held.count - 40) }
    return true
  }
  /// DND changed: whatever is no longer muted comes up, oldest first.
  func dndChanged() {
    let out = held.filter { !muted($0.card) }
    guard !out.isEmpty else { return }
    held.removeAll { e in out.contains { $0.id == e.id } }
    for e in out { if e.meet { showMeet(e.card) } else { showCard(e.card) } }
  }

  /// Takes a card away without an answer (eg the developer pressed Reset somewhere else).
  func hideCard(_ id: String) {
    held.removeAll { $0.id == id }
    if id.hasPrefix(SquadMessageCore.prefix) { SquadIsland.shared.retract(id) }   // PS 1.63: the island's card for it goes too (a reply being sent keeps it)
    if id.hasPrefix("nc:") { NotesCard.shared.hide(id); return }
    if role == .corner { kept[id] = nil; if islandMade { islandStack.hideCard(id) } }
    guard panel != nil else { return }
    if !ready { waiting.removeAll { $0.contains("\"id\":\"\(id)\"") }; return }
    guard let data = try? JSONSerialization.data(withJSONObject: [id]), let json = String(data: data, encoding: .utf8) else { return }
    web.evaluateJavaScript("window.__note.drop(\(json)[0])", completionHandler: nil)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    ready = true
    pageMode()
    if role == .island {   // the island stack's page opens later: it starts with what the corner's already has
      let main = Toast.shared
      if main.privacyNow { web.evaluateJavaScript("window.__note.privacy(true)", completionHandler: nil) }
      if main.revealNow { web.evaluateJavaScript("window.__note.reveal(true)", completionHandler: nil) }
      applyLook(main.lookJSON)
    }
    if lookJSON != "{}" { web.evaluateJavaScript("window.__note.look(\(lookJSON))", completionHandler: nil) }
    waiting.forEach(push)
    waiting = []
  }

  // Only clicks the page itself handles: nothing in the page navigates anywhere.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.navigationType == .other ? .allow : .cancel)
  }

  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let text = message.body as? String, let d = text.data(using: .utf8),
          let msg = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let type = msg["type"] as? String else { return }
    switch type {
    case "size":   // the page grows the window before it animates out, and shrinks it after
      let h = CGFloat(msg["h"] as? Double ?? 0)
      lastH = max(0, h)
      if h <= 0 { panel.orderOut(nil); return }
      // The corner as always, or under (or above) the island (V1.55, NoteDropCore.swift).
      guard let f = frame(h) else { return }
      // Only a real change moves the window (the page also only asks when the height it shows changes).
      if abs(panel.frame.height - f.height) > 0.5 || abs(panel.frame.minX - f.minX) > 0.5 || abs(panel.frame.minY - f.minY) > 0.5 {
        panel.setFrame(f, display: true); resizes += 1
      }
      if !panel.isVisible {
        // Under the island, while the Tab list is up: behind the list, never over its buttons (island clearance).
        if role == .island, let list = Toast.shared.listWindow(), list.isVisible { panel.order(.below, relativeTo: list.windowNumber) }
        else { panel.orderFrontRegardless() }
      }
    case "gone":   // V1.55: a card left for good (timedOut: an AI chat card's line ran out)
      if let id = msg["id"] as? String { gone(String(id.prefix(40)), timedOut: (msg["timedOut"] as? Bool) == true) }
    case "stack":   // PS 1.65: a click is keeping the opened list open, or it is not any more
      stackPinned = NoteStackCore.pinned(from: msg)
      stackOpen = NoteStackCore.open(from: msg)
      NoteStackCore.watch.set(ObjectIdentifier(self), stackOpen)
    case "born":   // V1.55: a card just dropped out of the island, or went back into it: the island swells
      Island.shared.swell(true)
    case "gulp":
      Island.shared.swell(false)
    case "open":
      if let s = Toast.openable(msg["url"] as? String), let url = URL(string: s) {
        // A self test copy only writes the link down: it never opens the developer's browser.
        if ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil { testOpened.append(s) } else { NSWorkspace.shared.open(url) }
      }
    case "sqreply":   // a G Squad message card's Reply, its Undo over: the page sends it through the chat composer
      if let id = msg["id"] as? String, let text = msg["text"] as? String { onSquadReply?(String(id.prefix(40)), text) }
    case "typing":   // a remind time is being typed (on), or that ended (off)
      if (msg["on"] as? Bool) == true { startTyping() } else { stopTyping() }
    case "action":
      // V1.57: a waiting pop up's pill. Its click brings the pop up out; a swipe or Clear all only takes the pill away.
      if let id = msg["id"] as? String, let key = PrivateCore.key(ofCard: id) { if (msg["action"] as? String) == "show" { PrivateHold.shared.opened(key) }; return }
      if let id = msg["id"] as? String, let action = msg["action"] as? String { onAction?(String(id.prefix(40)), String(action.prefix(20))) }
    default: break
    }
  }

  /// Self test: three fictional pop-ups, all shown at once (none behind another), a short drag that
  /// springs back, a long one that dismisses, then Clear all. Saved as pictures.
  func selfTest(_ dir: String, _ done: @escaping () -> Void) {
    show(title: "Jane just sent an email", sub: "Northwind Silk · Homepage draft",
         body: "Hi Sam. Loved the draft! Can we move the banner up a little? Also the font feels small on phones.",
         url: "https://mail.google.com/mail/?authuser=test#all/abc")
    show(title: "Sam just sent an email", sub: "Example Co · Invoice 12", body: "Thanks, paid today.", url: "https://mail.google.com/mail/?authuser=test#all/def")
    show(title: "Calendar refreshed: 12 events")
    // Every card's box on the page, top to bottom: none may cover another.
    let boxes = "(function(){var r=[].map.call(document.querySelectorAll('.card'),function(c){var b=c.getBoundingClientRect();return [b.top,b.bottom]}).sort(function(a,b){return a[0]-b[0]});var ok=r.length>0;for(var i=1;i<r.length;i++)if(r[i][0]<r[i-1][1]+4)ok=false;return JSON.stringify({n:r.length,apart:ok,open:document.getElementById('wrap').classList.contains('open'),less:!!document.getElementById('less')})})()"
    // A drag on the second card (the middle one) by dx pixels over 120 ms, as pointer events (a short slow
    // one must spring back, so the moves are spread out like a hand's, never all in one instant).
    func drag(_ dx: Int) -> String {
      "(function(){var c=document.querySelectorAll('.card')[1];if(!c)return 0;var b=c.getBoundingClientRect(),x=b.left+40,y=b.top+20,o={bubbles:true,pointerId:7,button:0,isPrimary:true,pointerType:'mouse'};function ev(t,x){o.clientX=x;o.clientY=y;c.dispatchEvent(new PointerEvent(t,o))}ev('pointerdown',x);for(var i=1;i<=6;i++)(function(i){setTimeout(function(){ev('pointermove',x+\(dx)*i/6);if(i===6)ev('pointerup',x+\(dx))},i*20)})(i);return 1})()"
    }
    let count = "document.querySelectorAll('.card').length"
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
      SelfTest.snap(self.web, "\(dir)/notes-list.png") {
        // In a busy full run the cards can still be gliding at the first look: one more look once they have
        // settled (a real overlap stays an overlap and still fails; the log says when it took the second look).
        func measure(_ again: Bool, _ f: @escaping (String) -> Void) {
          self.web.evaluateJavaScript(boxes) { v, _ in
            let s = v as? String ?? ""
            if again && !s.contains("\"apart\":true") { print("NOTES CHECK: cards still moving at 1.6 s, looking again"); DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { measure(false, f) } } else { f(s) }
          }
        }
        measure(true) { s in
          let shown = s.contains("\"n\":3") && s.contains("\"apart\":true") && s.contains("\"open\":true") && s.contains("\"less\":false")
          self.web.evaluateJavaScript(drag(30)) { _, _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
              self.web.evaluateJavaScript(count) { n1, _ in
                self.web.evaluateJavaScript(drag(260)) { _, _ in
                  DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
                    self.web.evaluateJavaScript(count) { n2, _ in
                      print("NOTES CHECK: all-shown=\(shown ? "ok" : "FAIL") short-drag-springs-back=\((n1 as? Int) == 3 ? "ok" : "FAIL") swipe-dismisses=\((n2 as? Int) == 2 ? "ok" : "FAIL") counts=\(n1 ?? "?")/\(n2 ?? "?") boxes=\(s) height=\(Int(self.panel.frame.height)) visible=\(self.panel.isVisible) key=\(self.panel.isKeyWindow) activePS=\(NSApp.isActive)")
                      self.web.evaluateJavaScript("document.getElementById('clear').click()", completionHandler: nil)
                      DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { print("NOTES CLEARED: \(self.panel.isVisible ? "FAIL" : "ok") visible=\(self.panel.isVisible)"); self.cardTest(dir, done) }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  /// Self test: the end of day question (fictional): shown twice (still one card), stays past the
  /// auto clear, its first button answers "end", and the panel never takes the keyboard.
  private func cardTest(_ dir: String, _ done: @escaping () -> Void) {
    let keep = onAction
    var got: [String] = []
    onAction = { id, action in got.append("\(id):\(action)") }
    let card: [String: Any] = ["id": "eod", "sticky": true, "title": "Shall I end my day now?", "sub": "Friday is still open",
      "body": "End my day saves what you ticked and resets the list. You can undo it.",
      "actions": [["id": "end", "label": "End my day"], ["id": "snooze", "label": "Not yet"]]]
    show(title: "Calendar refreshed: 3 events")
    showCard(card); showCard(card)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
      SelfTest.snap(self.web, "\(dir)/eod-card.png") {
        self.web.evaluateJavaScript("document.querySelectorAll('.card').length") { n, _ in
          self.web.evaluateJavaScript("[].filter.call(document.querySelectorAll('.card'),function(c){return /end my day/i.test(c.textContent)}).length") { q, _ in
            self.web.evaluateJavaScript("document.querySelector('.card[data-id=eod]')?1:0") { tagged, _ in
              self.web.evaluateJavaScript("[].filter.call(document.querySelectorAll('.acts button'),function(b){return b.dataset.act==='end'})[0].click()") { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                  let ok = (n as? Int) == 2 && (q as? Int) == 1 && (tagged as? Int) == 1 && got == ["eod:end"] && !self.panel.isKeyWindow
                  print("CARD CHECK: \(ok ? "ok" : "FAIL") cards=\(n ?? "?") questions=\(q ?? "?") data-id=\(tagged ?? "?") answered=\(got.joined(separator: ",")) key=\(self.panel.isKeyWindow) activePS=\(NSApp.isActive)")
                  self.onAction = keep
                  self.web.evaluateJavaScript("document.getElementById('clear').click()", completionHandler: nil)
                  DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.leadTest(dir, done) }
                }
              }
            }
          }
        }
      }
    }
  }

  /// Self test: an Instantly lead reply card (fictional): blue, Open in Instantly, Remind me in 15 mins
  /// and Dismiss, no X, and private mode hides the name and words.
  private func leadTest(_ dir: String, _ done: @escaping () -> Void) {
    showMeet(["id": "n:test-thread", "tone": "lead", "icon": "reply", "title": "Lena replied in Instantly", "sub": "example.com · Quick question",
              "body": "Sounds interesting, can you send more details?", "url": "https://app.instantly.ai/app/unibox", "at": ISO8601DateFormatter().string(from: Date()),
              "discreetText": "New lead reply", "remind": ["start": 15, "step": 5, "min": 5, "max": 240]])
    let look = "(function(){var c=document.querySelector('.card.t-lead');if(!c)return 'none';var x=c.querySelector('.x');return JSON.stringify({id:c.dataset.id,rem:(c.querySelector('button.rem')||{}).textContent,dis:!!c.querySelector('button.dis'),open:[].some.call(c.querySelectorAll('.acts button'),function(b){return b.textContent==='Open in Instantly'}),xHidden:!x||getComputedStyle(x).display==='none',icon:!!c.querySelector('.ic svg path'),txt:c.innerText})})()"
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
      SelfTest.snap(self.web, "\(dir)/lead-card.png") {
        self.web.evaluateJavaScript(look) { v, _ in
          let s = v as? String ?? ""
          let shown = s.contains("\"id\":\"n:test-thread\"") && s.contains("Remind me in 15 mins") && s.contains("\"dis\":true") && s.contains("\"open\":true") && s.contains("\"xHidden\":true") && s.contains("Lena")
          self.meetPrivacy(true)
          DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            self.web.evaluateJavaScript(look) { p, _ in
              let ps = p as? String ?? ""
              print("LEAD CHECK: shown=\(shown ? "ok" : "FAIL") private-mode-hides=\(!ps.contains("Lena") && !ps.contains("example.com") && ps.contains("New notification") && ps.contains("Private mode is on") ? "ok" : "FAIL") key=\(self.panel.isKeyWindow)")
              self.meetPrivacy(false)
              self.web.evaluateJavaScript("document.getElementById('clear').click()", completionHandler: nil)
              DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.noteLookSelfTest(dir) { SelfTest.stackCheck(dir, done) } }
            }
          }
        }
      }
    }
  }

  // The page: every card at once, newest at the top, each at its own place in a list (the developer, 30 Oct
  // 2026). Every move is a transform, opacity or filter (on the GPU), eased by a real spring.
  private static let page = #"""
  <!doctype html><html><head><meta charset="utf-8"><style>
  :root{--ease:cubic-bezier(.22,1,.36,1);--spring:var(--ease);--drop:cubic-bezier(.3,1.25,.5,1);--dur:.62s}
  html,body{margin:0;background:transparent;overflow:hidden;color:#fff;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;cursor:default}
  #wrap{position:relative;padding:2px 14px 2px 14px}
  /* "N notifications · Clear all" sits at the TOP of the stack (the developer, 31 Oct 2026), pinned while the cards
     scroll beneath it (they fade out just under it). It comes in with 2 cards and leaves at 1, by opacity
     and transform only; the cards glide down to make room for it and back up after. */
  #bar{position:absolute;z-index:3001;top:10px;left:14px;right:14px;height:30px;display:flex;align-items:center;justify-content:flex-end;gap:6px;
    opacity:0;pointer-events:none;transform:translate3d(0,-10px,0) scale(.97);transition:opacity .3s var(--ease),transform .55s var(--spring)}
  .open #bar{opacity:1;pointer-events:auto;transform:none}
  #bar b{padding:6px 12px;border-radius:99px;background:rgba(24,16,21,.94);box-shadow:0 4px 14px rgba(0,0,0,.3);font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:rgba(255,255,255,.85)}
  #bar button{border:0;border-radius:99px;padding:6px 12px;font:650 12px -apple-system,sans-serif;color:#fff;background:rgba(24,16,21,.94);box-shadow:0 4px 14px rgba(0,0,0,.3);transition:background .2s,transform .2s var(--ease)}
  #bar button:hover{background:rgba(48,30,40,.96)}
  #bar button:active{background:#EC4E86;transform:scale(.96)}
  /* The stack is capped (Toast.cap) and scrolls inside, with the trackpad's own momentum. A soft fade at
     the bottom edge while more cards wait below, and under the bar once scrolled. Its strength follows the
     scroll itself (edges(): it eases away over the last few points), never a CSS transition: WebKit does not
     repaint a mask whose custom property animates. */
  #view{position:relative;margin:0 -14px;--ft:1;--fb:1;--bs:0px}
  #view.scroll{-webkit-mask-image:linear-gradient(to bottom,rgba(0,0,0,var(--ft)) 0,rgba(0,0,0,var(--ft)) var(--bs),#000 calc(var(--bs) + 34px),#000 calc(100% - 56px),rgba(0,0,0,var(--fb)) 100%)}
  #list{position:relative;height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain}
  #list::-webkit-scrollbar{width:0}
  #thumb{position:absolute;right:4px;top:0;width:3px;height:0;border-radius:3px;background:rgba(255,255,255,.42);opacity:0;pointer-events:none;transition:opacity .4s var(--ease);will-change:transform}
  #thumb.on{opacity:1;transition-duration:.12s}
  /* New cards came in above while the developer was scrolled down: a pill in the bar to go back up (the stack itself
     never moves under him). It sits in the bar's free middle, so nothing else shifts when it comes. */
  #bar #newer{flex:none;padding:6px 11px;font:750 11.5px -apple-system,sans-serif;background:#EC4E86;box-shadow:0 4px 14px rgba(0,0,0,.3);
    opacity:0;pointer-events:none;transform:scale(.8);transition:opacity .25s var(--ease),transform .5s var(--spring),background .2s}
  #bar #newer.on{opacity:1;pointer-events:auto;transform:none}
  #bar #newer:active{background:#C8366B}
  #clear{margin-left:auto}
  #fill{position:absolute;left:0;top:0;width:1px;pointer-events:none}
  .card{position:absolute;left:14px;right:14px;top:0;box-sizing:border-box;border-radius:18px;overflow:hidden;background:rgba(24,16,21,.95);border:1px solid rgba(236,78,134,.36);
    box-shadow:0 12px 30px rgba(0,0,0,.34),0 2px 8px rgba(0,0,0,.22);opacity:0;touch-action:none;
    transition:transform var(--dur) var(--spring),opacity .42s var(--ease),filter .5s var(--ease);will-change:transform,opacity}
  .card.drag{transition:none!important;cursor:grabbing}
  .card.fly{transition:transform .34s cubic-bezier(.25,.8,.35,1),opacity .3s ease!important}
  .card.still{transition-property:opacity,filter!important}
  /* a one time soft sheen across a card as it arrives, and its icon pops in */
  .card::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(105deg,transparent 30%,rgba(255,255,255,.13) 48%,rgba(255,255,255,.05) 56%,transparent 70%);transform:translateX(-130%)}
  .card.sheen::after{animation:sheen 1.15s .2s var(--ease) both}
  @keyframes sheen{to{transform:translateX(130%)}}
  .card.sheen .ic,.card.sheen .dot{animation:pop .6s .1s cubic-bezier(.34,1.56,.64,1) both}
  @keyframes pop{from{transform:scale(.35);opacity:0}}
  .in{padding:12px 14px 13px 14px}
  .h{display:flex;align-items:center;gap:9px}
  .dot{width:8px;height:8px;border-radius:50%;background:#EC4E86;flex:none;box-shadow:0 0 10px rgba(236,78,134,.8)}
  .t{flex:1;min-width:0;font-weight:700;font-size:14px;line-height:1.3}
  .when{font-size:11.5px;color:rgba(255,255,255,.5);flex:none}
  /* V1.47 (the developer: "we want it like native Mac notifications, where the X is on the top left"): the close X sits in the top
     left corner and shows while the pointer is over the card, like macOS. */
  .x{position:absolute;left:6px;top:6px;z-index:3;width:20px;height:20px;border:0;border-radius:50%;padding:0;background:rgba(58,52,56,.96);box-shadow:0 1px 4px rgba(0,0,0,.45),inset 0 0 0 .5px rgba(255,255,255,.22);color:rgba(255,255,255,.85);font:600 13px/20px -apple-system,sans-serif;text-align:center;opacity:0;transform:scale(.7);pointer-events:none;transition:opacity .15s ease,transform .18s var(--ease),background .2s}
  .card:hover .x,.x:focus-visible{opacity:1;transform:none;pointer-events:auto}
  .x:hover{background:rgba(88,80,86,.98);color:#fff}
  .x:active{background:#EC4E86;color:#fff}
  .sub{margin:3px 0 0 17px;font-size:12px;font-weight:650;color:#F49BBE;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .b{margin:6px 0 0 17px;font-size:13px;line-height:1.45;color:rgba(255,255,255,.86);overflow-wrap:anywhere}
  .go{margin:8px 0 0 17px;font-size:11.5px;font-weight:700;color:rgba(255,255,255,.5)}
  .acts{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0 17px}
  .acts button{border:0;border-radius:99px;padding:7px 14px;font:650 12.5px -apple-system,sans-serif;color:#fff;background:rgba(255,255,255,.12);transition:background .2s,transform .18s var(--ease)}
  .acts button:active{transform:scale(.96)}
  .acts button.main{background:#EC4E86}
  .acts button.main:active{background:#C8366B}
  /* meeting alerts: their own look, one colour per kind */
  .card.meet{border-width:1.5px}
  .meet .dot{display:none}
  .meet .ic{flex:none;width:26px;height:26px;border-radius:9px;display:grid;place-items:center;margin-left:-2px}
  .meet .ic svg{width:15px;height:15px}
  .meet .t{font-size:14.5px}
  .meet .sub,.meet .b,.meet .acts,.meet .go{margin-left:33px}
  .meet .cd{display:inline-block;margin:7px 0 0 33px;padding:3px 9px;border-radius:99px;font-size:11.5px;font-weight:800;letter-spacing:.02em}
  .t-mail{border-color:rgba(236,78,134,.55);background:linear-gradient(160deg,rgba(110,22,60,.96),rgba(26,14,20,.96) 60%)}
  .t-mail .ic{background:rgba(236,78,134,.24);color:#F9A8C9}.t-mail .sub{color:#F9A8C9}
  .t-mail .x,.t-done .x,.t-lead .x{display:none}
  .t-lead{border-color:rgba(96,165,250,.6);background:linear-gradient(160deg,rgba(29,58,138,.96),rgba(15,20,32,.96) 60%)}
  .t-lead .ic{background:rgba(96,165,250,.24);color:#93C5FD}.t-lead .sub{color:#BFDBFE}
  .card.t-lead .acts{gap:4px}.card.t-lead .acts button{padding:7px 8px;font-size:11.5px}
  .t-lead .acts button.rem{background:rgba(96,165,250,.28);border-color:rgba(147,197,253,.45)}.t-lead .acts button.rem:hover{background:rgba(96,165,250,.42)}
  .meet .acts button.dis{margin-left:auto;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.28)}
  /* Remind me in (client emails and finished chats): the wheel anywhere over the card changes the time, a click on
     the time lets the developer type one, a click on the rest sets it. One width for every time it can show (the two widest
     labels size it, plus the time's own padding), so nothing moves; only the time ticks. */
  .acts button.rem{display:inline-grid;justify-content:center;align-content:center;background:rgba(236,78,134,.3);border:1px solid rgba(249,168,201,.45);white-space:nowrap;font-variant-numeric:tabular-nums;
    transition:background .2s,box-shadow .2s var(--ease),filter .2s var(--ease),transform .18s var(--ease)}
  /* The pointer is on it: the wheel changes the time here (anywhere else it scrolls the stack). */
  .acts button.rem.hot{filter:brightness(1.3);box-shadow:0 0 0 1.5px rgba(255,255,255,.8),0 0 16px rgba(255,255,255,.22)}
  .rem.hot .rv{background:rgba(255,255,255,.3)}
  .acts button.rem:hover{background:rgba(236,78,134,.42)}
  .rem::before,.rem::after{grid-area:1/1;visibility:hidden;content:"Remind me in 55 mins";padding-right:9px}.rem::after{content:"Remind me in 3h 55m"}
  .rem .rin{grid-area:1/1;text-align:left;pointer-events:none}
  .rem .rv{display:inline-block;margin-left:1px;padding:0 4px;border-radius:6px;background:rgba(255,255,255,.15);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12);cursor:text;pointer-events:auto;transition:background .2s}
  .rem .rv:hover{background:rgba(255,255,255,.27)}
  .rv.up{animation:tku .22s var(--ease)}.rv.down{animation:tkd .22s var(--ease)}
  @keyframes tku{from{opacity:.25;transform:translateY(55%)}}@keyframes tkd{from{opacity:.25;transform:translateY(-55%)}}
  .rem input.rt{width:4.4em;box-sizing:border-box;margin:0 0 0 1px;padding:0 5px;border:0;outline:0;border-radius:6px;font:inherit;line-height:inherit;color:#fff;background:rgba(255,255,255,.24);box-shadow:0 0 0 1.5px rgba(255,255,255,.6);-webkit-user-select:text;cursor:text;pointer-events:auto;caret-color:#fff}
  .rem input.rt.bad{animation:shake .32s ease}
  @keyframes shake{25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
  .t-mail .acts,.t-done .acts,.t-lead .acts{margin-left:0;gap:5px}.t-mail .acts button,.t-done .acts button,.t-lead .acts button{padding:7px 9px;font-size:12px;white-space:nowrap;flex:none}
  .t-done{border-color:rgba(217,119,87,.6);background:linear-gradient(160deg,rgba(92,40,22,.96),rgba(26,18,15,.96) 60%)}
  .t-done .ic{background:rgba(217,119,87,.24);color:#F2B49B}.t-done .sub{color:#F2B49B}
  .t-done .acts button.rem{background:rgba(217,119,87,.3);border-color:rgba(242,180,155,.45)}.t-done .acts button.rem:hover{background:rgba(217,119,87,.44)}
  .t-ok{border-color:rgba(52,211,153,.6);background:linear-gradient(160deg,rgba(6,78,59,.96),rgba(18,24,22,.96) 60%)}
  .t-ok .ic{background:rgba(52,211,153,.22);color:#6EE7B7}.t-ok .sub{color:#A7F3D0}
  .t-info{border-color:rgba(167,139,250,.5);background:linear-gradient(160deg,rgba(46,27,84,.96),rgba(22,16,30,.96) 60%)}
  .t-info .ic{background:rgba(167,139,250,.22);color:#C4B5FD}.t-info .sub{color:#DDD6FE}
  .t-warn{border-color:rgba(251,191,36,.7);background:linear-gradient(160deg,rgba(120,72,6,.96),rgba(30,22,12,.96) 60%)}
  .t-warn .ic{background:rgba(251,191,36,.24);color:#FCD34D}.t-warn .sub{color:#FDE68A}
  .t-bad{border-color:#F87171;background:linear-gradient(160deg,rgba(153,27,27,.97),rgba(40,12,14,.97) 62%);animation:alarm 1.6s ease-in-out infinite}
  .t-bad .ic{background:#EF4444;color:#fff}.t-bad .sub{color:#FECACA}
  .t-booked{border-color:rgba(52,211,153,.6);background:linear-gradient(160deg,rgba(6,78,59,.96),rgba(18,24,22,.96) 60%)}
  .t-booked .ic{background:rgba(52,211,153,.22);color:#6EE7B7}.t-booked .sub{color:#A7F3D0}.t-booked .cd{background:rgba(52,211,153,.18);color:#A7F3D0}
  .t-soon{border-color:rgba(167,139,250,.5);background:linear-gradient(160deg,rgba(46,27,84,.96),rgba(22,16,30,.96) 60%)}
  .t-soon .ic{background:rgba(167,139,250,.22);color:#C4B5FD}.t-soon .sub{color:#DDD6FE}.t-soon .cd{background:rgba(167,139,250,.18);color:#DDD6FE}
  .t-msg,.t-soon-warn{border-color:rgba(251,191,36,.7);background:linear-gradient(160deg,rgba(120,72,6,.96),rgba(30,22,12,.96) 60%)}
  .t-msg .ic,.t-soon-warn .ic{background:rgba(251,191,36,.24);color:#FCD34D}.t-msg .sub,.t-soon-warn .sub{color:#FDE68A}.t-msg .cd,.t-soon-warn .cd{background:rgba(251,191,36,.2);color:#FDE68A}
  .t-cancel,.t-declined{border-color:#F87171;background:linear-gradient(160deg,rgba(153,27,27,.97),rgba(40,12,14,.97) 62%);animation:alarm 1.6s ease-in-out infinite}
  .t-cancel .ic,.t-declined .ic{background:#EF4444;color:#fff}.t-cancel .sub,.t-declined .sub{color:#FECACA}.t-cancel .cd,.t-declined .cd{background:#EF4444;color:#fff}
  .t-cancel .t{font-size:15.5px;font-weight:800}
  @keyframes alarm{50%{box-shadow:0 0 0 3px rgba(239,68,68,.25),0 0 26px rgba(239,68,68,.55),0 12px 30px rgba(0,0,0,.34)}}
  .meet .acts button.main{background:rgba(255,255,255,.92);color:#17121A}
  .t-cancel .acts button.main,.t-declined .acts button.main{background:#fff;color:#991B1B}
  .meet .hid{display:none}
  .meet.discreet .full{display:none}
  .meet.discreet .hid{display:block;margin:4px 0 0 33px;font-size:11.5px;font-weight:650;color:rgba(255,255,255,.55)}
  .meet.discreet{animation:none;background:rgba(24,16,21,.96);border-color:rgba(255,255,255,.22)}
  .meet.discreet .ic{background:rgba(255,255,255,.12);color:rgba(255,255,255,.8)}
  /* V1.57 private mode (a friend of the developer's: "In private mode, PS still shows the full cards with their sounds, covering the
     screen"): while it is on, EVERY card is a small pill that says only "New notification" and "Private mode is on",
     nothing of what it is about, until it is clicked (or private mode goes off, or Tab is held). */
  .pv{display:none}
  .card.pill{left:auto;right:14px;width:max-content;max-width:calc(100% - 28px);border-radius:99px;animation:none;
    background:rgba(24,20,24,.96);border-color:rgba(255,255,255,.2);cursor:pointer}
  body.isl .card.pill{left:0;right:0;margin:0 auto}
  .card.pill>.in,.card.pill>.x,.card.pill>.life{display:none}
  .card.pill .pv{display:flex;align-items:center;gap:8px;padding:7px 14px 7px 9px;white-space:nowrap}
  .pv .pi{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.12);color:rgba(255,255,255,.82)}
  .pv .pi svg{width:12px;height:12px}
  .pv b{font-size:13px;font-weight:700;color:#fff}
  .pv span{font-size:11.5px;font-weight:650;color:rgba(255,255,255,.55)}
  /* V1.55: out of the Dynamic Island (Toast.islandChanged). A new card is born as a sliver of the island's width at the
     top of the window, right under the island while it swells, and pours down into its place on a slightly springier
     spring; a dismissed one shrinks back up into the island, sliding behind the cards above it. Above the island
     (body.up) the whole stack is mirrored so the newest card is still the one next to it, and each card's content and
     the bar's words are mirrored back so they read the right way up. While a card pours out or goes back in, only its
     coloured shape moves: its words fade in as it lands and fade out as it leaves, so nothing squashed is ever read. */
  body.isl .card{transform-origin:50% 0}
  /* V1.55 (the developer: "a line below the notification that slides from the right to the left and by default it takes fifteen
     seconds before it disappears"): a card with its own time (AI chat cards, Settings) has a thin line along its foot
     that runs down from the right to the left; the pointer on the card (or a drag) pauses it; at the end it goes. */
  .life{position:absolute;left:16px;right:16px;bottom:5px;height:2.5px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden;pointer-events:none}
  .life i{display:block;height:100%;border-radius:inherit;background:rgba(255,255,255,.62);transform-origin:0 50%;animation:life var(--life,15s) linear forwards}
  .t-done .life i{background:#F2B49B}
  .card.held .life i,.card.drag .life i,.card.still .life i{animation-play-state:paused}
  @keyframes life{to{transform:scaleX(0)}}
  /* V1.56 (the developer, 13 Nov 2026: "group more than 1 notification into the same one notification. Do like bullet points using
     the headline white text ... and just increase the size of the notification bubble depending on how many chats have
     been completed"): every finished AI chat is a row of ONE bubble, newest at the top. A small circle, the chat's name in
     the headline's white, "X secs ago" counting up. The circle shrinks over that row's own time (Settings, AI chat cards
     disappear by themselves); at the end the row bloops out and the bubble shrinks to fit. The pointer on the bubble holds
     every row. A row's own x shows on hover, over its circle. "Claude finished" once, under the rows; mixed tools: each
     row says its tool in small letters and the line reads "AI chats finished". */
  .grp .h{align-items:flex-start}
  .grp .ic{margin-top:-1px}
  .gcol{flex:1;min-width:0}
  .grp .dt{display:none}
  .grp.discreet .dt{display:block}.grp.discreet .rows{display:none}
  .rows{display:flex;flex-direction:column;margin-top:-2px}
  .row{position:relative;overflow:hidden;transition:height .46s var(--spring)}
  .ri{display:flex;align-items:center;gap:8px;padding:2px 0 2px 4px;min-height:20px;transform-origin:8px 50%}
  .row .t{font-size:14.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .bul{flex:none;width:8px;height:8px;border-radius:50%;background:#F2B49B;box-shadow:0 0 8px rgba(242,180,155,.5);transition:transform .26s linear,opacity .16s ease}
  .row .ago{font-size:11.5px;color:rgba(255,255,255,.5);flex:none;font-variant-numeric:tabular-nums}
  .row .tool{display:none;flex:none;font-size:10.5px;font-weight:750;color:#F2B49B;opacity:.85}
  .grp.mixed .row .tool{display:inline}
  .rx{position:absolute;left:0;top:50%;width:16px;height:16px;margin-top:-8px;border:0;border-radius:50%;padding:0;background:rgba(58,52,56,.96);box-shadow:0 1px 4px rgba(0,0,0,.45),inset 0 0 0 .5px rgba(255,255,255,.22);color:rgba(255,255,255,.88);font:600 12px/16px -apple-system,sans-serif;text-align:center;opacity:0;transform:scale(.6);pointer-events:none;transition:opacity .15s ease,transform .18s var(--ease),background .2s}
  .row:hover .rx,.row.hov .rx{opacity:1;transform:none;pointer-events:auto}
  .row:hover .bul,.row.hov .bul{opacity:0}
  .rx:hover{background:rgba(88,80,86,.98);color:#fff}.rx:active{background:#D97757;color:#fff}
  .row.new .ri{animation:rowin .52s var(--drop) both}
  @keyframes rowin{from{opacity:0;transform:translate3d(0,-7px,0) scale(.9)}}
  .row.out .ri{animation:bloop .44s cubic-bezier(.5,0,.75,.3) forwards}
  @keyframes bloop{0%{transform:scale(1)}26%{transform:scale(1.06)}100%{transform:scale(.25);opacity:0;filter:blur(2px)}}
  .card.taken{transition:opacity .16s ease!important}
  .card.born{transition:transform .74s var(--drop) .04s,opacity .2s ease .04s,filter .45s var(--ease)!important}
  .card.born>.in{animation:bornin .42s .16s var(--ease) both}
  @keyframes bornin{from{opacity:0}}
  .card.gulp{transition:transform .44s cubic-bezier(.5,0,.75,.3),opacity .24s ease .18s,filter .3s ease!important}
  .card.gulp>.in{opacity:0;transition:opacity .16s ease}
  body.up #wrap{position:absolute;left:0;right:0;bottom:0;transform:scaleY(-1)}
  body.up .card>.in,body.up .x,body.up #bar b,body.up #bar button{scale:1 -1}
  body.up .x{top:auto;bottom:6px}
  body.up .card{box-shadow:0 -12px 30px rgba(0,0,0,.34),0 -2px 8px rgba(0,0,0,.22)}
  body.up #bar b,body.up #bar button{box-shadow:0 -4px 14px rgba(0,0,0,.3)}
  /* PS 1.65 stacked notifications: with more than one card waiting only the newest shows, and a small "+N" pill sits under
     it, the island's own black. The cards behind it wait right under the newest one (still, unseen, unclickable) and spring
     out from there when the pointer comes to the pill or the card. */
  #badge{position:absolute;z-index:3002;left:50%;top:0;height:26px;min-width:44px;padding:0 13px;box-sizing:border-box;border:1px solid rgba(255,255,255,.16);border-radius:99px;
    background:#000;color:#fff;font:700 12.5px/24px -apple-system,sans-serif;letter-spacing:.02em;font-variant-numeric:tabular-nums;text-align:center;cursor:default;
    opacity:0;pointer-events:none;transform:translate3d(-50%,-8px,0) scale(.8);transition:opacity .25s var(--ease),transform .55s var(--spring)}
  #badge.on{opacity:1;pointer-events:auto;transform:translate3d(-50%,0,0)}
  #badge:active{background:#1c1c1e}
  body.up #badge{scale:1 -1}
  .card.stk,#wrap.settle .card{pointer-events:none}
  .card.stk .life i{animation-play-state:paused}   /* waiting behind the newest card: its line holds with its time */
  @media (prefers-reduced-motion:reduce){
    .t-cancel,.t-declined,.t-bad{animation:none}
    .card{transition:opacity .2s ease}.card::after{display:none}
    .card.sheen .ic,.card.sheen .dot,.rv.up,.rv.down,.row.new .ri,.row.out .ri{animation:none}
    .row,.bul{transition:none}
    #newer,#bar{transition:none}
    #badge{transition:none}.card{transition:opacity .01s}
  }
  \#(AiMessageCard.css)
  \#(SquadMessageCard.css)
  </style></head><body><div id="wrap"><div id="bar"><b id="count"></b><button id="newer"></button><button id="clear">Clear all</button></div><div id="view"><div id="list"><div id="fill"></div></div><div id="thumb"></div><button id="badge" type="button"></button></div></div>
  <script>
  (function(){
    var post=function(m){try{webkit.messageHandlers.note.postMessage(JSON.stringify(m))}catch(e){}};
    var wrap=document.getElementById('wrap'),list=document.getElementById('list'),fill=document.getElementById('fill'),count=document.getElementById('count');
    var view=document.getElementById('view'),thumb=document.getElementById('thumb'),newer=document.getElementById('newer'),badge=document.getElementById('badge');
    var cards=[],maxH=700,posted=-1,shrink=0,listT=0,editing=null,fresh=0,thumbT=0,hot=null,ptrAt=null,relight=0;
    var GAP=10,TOP=8,BOT=20,BAR=38,PAD=4,STAY=14000,BGAP=6,BH=26,BEND=12;
    var revealAll=false,privacyOn=false;
    // V1.55: where the cards hang from (Toast.pageMode): off is the corner; on, the island's centre and width over this
    // window, and up when the stack is above the island (mirrored).
    var isl={on:false,up:false,ix:196,iw:330},still=window.matchMedia?matchMedia('(prefers-reduced-motion: reduce)'):null;
    function calm(){return !!(still&&still.matches)}
    // A real spring for every glide (damped, a touch of overshoot, settled in --dur), as CSS linear(). --drop is the
    // card dropping out of the island: a little longer and springier.
    (function(){
      function mk(T,z){
        var w=4.6/(z*T),wd=w*Math.sqrt(1-z*z),p=[];
        for(var i=0;i<=48;i++){var t=i/48*T;p.push((1-Math.exp(-z*w*t)*(Math.cos(wd*t)+z*w/wd*Math.sin(wd*t))).toFixed(4))}
        p[0]='0';p[48]='1';
        return 'linear('+p.join(',')+')';
      }
      var v=mk(0.62,0.76),d=mk(0.74,0.66);
      try{if(CSS.supports('transition-timing-function',v)){document.documentElement.style.setProperty('--spring',v);document.documentElement.style.setProperty('--drop',d)}}catch(e){}
    })();
    var ICON={booked:'<path d="M8 2v4M16 2v4M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/><path d="M9 15l2 2 4-4"/>',
      declined:'<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
      msg:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
      soon:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'};
    ICON.cancel=ICON.declined;ICON['soon-warn']=ICON.soon;
    // WhatsApp: a plain green speech bubble drawn here (Meta's brand rules do not let a lookalike of their logo or a changed copy of it be used), never their logo.
    ICON.whatsapp='<path fill="#25D366" stroke="none" d="M12 2.5c5.2 0 9.5 3.9 9.5 8.7s-4.3 8.7-9.5 8.7c-1.2 0-2.3-.2-3.4-.6L3.5 21l1.6-4.1C3.4 15.4 2.5 13.4 2.5 11.2 2.5 6.4 6.8 2.5 12 2.5z"/>';
    ICON.shield='<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>';
    ICON.globe='<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>';
    ICON.wifi='<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><path d="M12 19.5h.01"/>';
    ICON.plug='<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0zM12 17v5"/>';
    ICON.mail='<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M4 7.5l8 5.5 8-5.5"/>';
    ICON.done='<path d="M5 12.5l4.5 4.5L19 7.5"/>';
    ICON.reply='<path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 6 6v4"/>';
    ICON.swap='<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>';
    \#(AiMessageCard.js)
    \#(SquadMessageCard.js)
    function svg(k){var s=document.createElementNS('http://www.w3.org/2000/svg','svg');s.setAttribute('viewBox','0 0 24 24');s.setAttribute('fill','none');s.setAttribute('stroke','currentColor');s.setAttribute('stroke-width','2.3');s.setAttribute('stroke-linecap','round');s.setAttribute('stroke-linejoin','round');s.innerHTML=ICON[k]||ICON.soon;return s}
    function until(iso){var m=Math.round((Date.parse(iso)-Date.now())/60000);if(isNaN(m))return'';if(m<0)return'Started '+(-m)+' min ago';if(m<1)return'Starting now';if(m<60)return'In '+m+' min';if(m>=2880)return'In '+Math.round(m/1440)+' days';return'In '+Math.floor(m/60)+' h'+(m%60?' '+(m%60)+' min':'')}
    // >>> private pill model: pure, no page. tests/privatepill-test.mjs runs this block on its own.
    var Pill={
      t:'New notification',s:'Private mode is on',
      // Is this card a pill right now? A pop up with a window of its own waiting behind one always is (PrivateHold.swift);
      // any other card while private mode is on, until it is clicked open or Tab is held (and a meeting card sent discreet).
      shut:function(c,priv,reveal){return !!(c.data.pill||((priv||(c.data.kind==='meet'&&c.data.discreet))&&!c.shown&&!reveal))}
    };
    // <<< private pill model
    function shut(c){return Pill.shut(c,privacyOn,revealAll)}
    // The pill itself, on every card: a lock and the two lines, nothing else.
    function pillEl(c){
      if(c.pv)return;
      c.pv=el('div','pv');var pi=el('span','pi');pi.appendChild(svg('lock'));c.pv.appendChild(pi);
      c.pv.appendChild(el('b','',Pill.t));c.pv.appendChild(el('span','',Pill.s));c.el.appendChild(c.pv);
    }
    function paint(c){
      pillEl(c);c.el.classList.toggle('pill',shut(c));
      if(c.group){var g=shut(c);c.el.classList.toggle('discreet',g);c.ic.innerHTML='';c.ic.appendChild(svg(g?'lock':'done'));c.dt.textContent=ChatRows.discreet(c.m);return}
      if(c.data.kind!=='meet')return;var d=shut(c);c.el.classList.toggle('discreet',d);c.ic.innerHTML='';c.ic.appendChild(svg(d?'lock':(c.data.icon||c.data.tone)));c.t.textContent=d?(c.data.discreetText||'A meeting alert'):c.data.title}
    function ago(t){var m=Math.round((Date.now()-t)/60000);return m<1?'now':m<60?m+'m':Math.round(m/60)+'h'}
    function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}

    // ---------- AI chat finished rows (V1.56) ----------
    // >>> chat rows model: pure, no page. tests/chatgroup-test.mjs runs this block on its own.
    var ChatRows=(function(){
      function make(){return {rows:[],held:false,t:0}}
      // Every row keeps its own clock (how long it has been up). Time only counts while the bubble is not held.
      function step(g,now){var dt=g.t?Math.max(0,now-g.t):0;g.t=now;if(!g.held)for(var i=0;i<g.rows.length;i++)g.rows[i].used+=dt}
      function toolOf(d){var m=String(d.sub||'').match(/^(.+) finished$/);return m?m[1]:'Claude'}
      // A finished chat: a new row at the top. The same chat again replaces its row (a new finish starts a new clock).
      function add(g,d,now){
        step(g,now);
        var life=+d.life>0?Math.max(3,Math.min(600,+d.life))*1000:0;
        var r={id:String(d.id),title:String(d.title||''),tool:toolOf(d),at:Date.parse(d.at)||now,life:life,used:0,json:d.json||''};
        g.rows=[r].concat(g.rows.filter(function(x){return x.id!==r.id}));
        return r;
      }
      function hold(g,on,now){step(g,now);g.held=!!on}
      // The rows whose time ran out, taken off (0 is Off: a row then stays until dismissed).
      function tick(g,now){
        step(g,now);var out=[],keep=[];
        g.rows.forEach(function(x){(x.life>0&&x.used>=x.life?out:keep).push(x)});
        g.rows=keep;return out;
      }
      function drop(g,id){var r=null;g.rows=g.rows.filter(function(x){if(x.id===id){r=x;return false}return true});return r}
      function find(g,id){for(var i=0;i<g.rows.length;i++)if(g.rows[i].id===id)return g.rows[i];return null}
      // How much of a row's time is left (1 to 0), and its circle's size: it shrinks to a dot, never to nothing.
      function left(x){return x.life>0?Math.max(0,Math.min(1,1-x.used/x.life)):1}
      function size(x){return +(0.22+0.78*left(x)).toFixed(3)}
      function tools(g){var t=[];g.rows.forEach(function(x){if(t.indexOf(x.tool)<0)t.push(x.tool)});return t}
      function mixed(g){return tools(g).length>1}
      // The orange line, once for the whole bubble.
      function head(g){var t=tools(g);return t.length===1?t[0]+' finished':'AI chats finished'}
      // Private mode: no names, one plain line.
      function discreet(g){
        var n=g.rows.length,t=tools(g),w=t.length===1?t[0]+' chat':'AI chat';
        return n===1?'A '+w+' finished':n+' '+w+'s finished';
      }
      // "X secs ago" from when the chat finished, counting up.
      function ago(at,now){
        var s=Math.max(0,Math.floor((now-at)/1000));
        if(s<1)return 'just now';
        if(s<60)return s+(s===1?' sec ago':' secs ago');
        var m=Math.floor(s/60);if(m<60)return m+(m===1?' min ago':' mins ago');
        var h=Math.floor(m/60);return h+(h===1?' hr ago':' hrs ago');
      }
      return {make:make,add:add,hold:hold,tick:tick,drop:drop,find:find,left:left,size:size,mixed:mixed,head:head,discreet:discreet,ago:ago};
    })();
    // <<< chat rows model

    // ---------- Remind me in ----------
    // Chat cards start at 2 minutes and step 1, client emails 15 and 5 (the card says which), up to 4 hours:
    // "2 mins", "1 min", then hours and minutes past 60 ("1h 5m").
    function remText(m){return m<60?m+(m===1?' min':' mins'):Math.floor(m/60)+'h'+(m%60?' '+(m%60)+'m':'')}
    // What the developer types: "10", "10m", "10 mins", "1h", "1h30", "1h 30m", "1:30", "1.5h" (minutes, or NaN).
    function parseMins(s){
      s=String(s||'').toLowerCase().replace(/\s+/g,' ').trim();if(!s)return NaN;
      var k=s.match(/^(\d{1,2}):(\d{1,2})$/);if(k)return +k[1]*60+(+k[2]);
      if(!/^[\d.:hminutesor ]+$/.test(s))return NaN;
      var h=s.match(/(\d+(?:\.\d+)?)\s*h/),rest=h?s.slice(h.index+h[0].length).replace(/^[a-z]*/,''):s,mm=rest.match(/\d+(?:\.\d+)?/);
      if(!h&&!mm)return NaN;
      return Math.round((h?parseFloat(h[1])*60:0)+(mm?parseFloat(mm[0]):0));
    }
    function remind(c){
      var R=c.data.remind||{start:15,step:5,min:5,max:240};
      var b=el('button','rem'),inn=el('span','rin','Remind me in '),v=el('span','rv',remText(R.start));
      inn.appendChild(v);b.appendChild(inn);c.mins=R.start;
      var acc=0,last=0;
      var clamp=function(m){return Math.max(R.min,Math.min(R.max,m))};
      c.rem={b:b,inn:inn,R:R,clamp:clamp,input:null,
        chip:function(){return v},
        setChip:function(n){v=n},
        show:function(m,d){var nv=el('span','rv'+(d>0?' up':d<0?' down':''),remText(m));if(v.parentNode)inn.replaceChild(nv,v);v=nv},
        // The wheel steps it (one step per notch, a short pause between steps). WebKit says when the system
        // flips the wheel (natural scrolling).
        wheel:function(e){
          if(c.editing||shut(c))return;
          acc+=e.webkitDirectionInvertedFromDevice?-e.deltaY:e.deltaY;var now=Date.now();if(Math.abs(acc)<4||now-last<60)return;
          var d=acc<0?1:-1;acc=0;last=now;var m=clamp(c.mins+d*R.step);if(m===c.mins)return;
          c.mins=m;c.rem.show(m,d);
        }};
      return b;
    }
    // A click on the time: a box to type one into. The panel takes the keyboard for it (Swift), then gives it back.
    function edit(c){
      if(c.editing||!c.rem)return;
      if(editing&&editing!==c)endEdit(editing,true);
      var r=c.rem,inp=document.createElement('input');
      inp.className='rt';inp.type='text';inp.value=remText(c.mins);inp.spellcheck=false;inp.setAttribute('autocomplete','off');inp.setAttribute('aria-label','Remind me in how long');
      r.inn.replaceChild(inp,r.chip());r.input=inp;c.editing=true;editing=c;
      inp.addEventListener('keydown',function(e){
        e.stopPropagation();
        if(e.key==='Enter'){
          e.preventDefault();var m=parseMins(inp.value);
          if(isNaN(m)){inp.classList.remove('bad');void inp.offsetWidth;inp.classList.add('bad');return}
          m=r.clamp(m);endEdit(c,false);c.mins=m;r.show(m,0);answer(c,'remind:'+m);remove(c);
        }else if(e.key==='Escape'){e.preventDefault();endEdit(c,false)}
      });
      inp.addEventListener('blur',function(){if(c.editing)endEdit(c,true)});
      inp.addEventListener('pointerdown',function(e){e.stopPropagation()});
      inp.addEventListener('click',function(e){e.stopPropagation()});
      post({type:'typing',on:true});
    }
    // keep: a valid time typed so far stays (without sending it); otherwise the old time comes back.
    function endEdit(c,keep){
      if(!c.editing)return;
      c.editing=false;if(editing===c)editing=null;
      var r=c.rem,inp=r.input;r.input=null;
      var m=keep&&inp?parseMins(inp.value):NaN;if(!isNaN(m))c.mins=r.clamp(m);
      var chip=el('span','rv',remText(c.mins));
      if(inp&&inp.parentNode)inp.parentNode.replaceChild(chip,inp);r.setChip(chip);
      post({type:'typing',on:false});
    }

    // ---------- stacked notifications (PS 1.65) ----------
    // >>> stack model: pure, no page. tests/notestack-test.mjs runs this block on its own, with the same cases as
    // tests/notestack-test.swift runs on NoteStackCore. Time is always passed in (ms), so a test never waits.
    // With the switch on and 2 or more cards: shut (the newest card and a "+N" badge, N = the others) or open (every card).
    // Open while the pointer is on the stack, for a short grace after it leaves, and while a click keeps it open. A click
    // keeps it open until Esc (or 10 s with the pointer away). Esc that closes it holds it shut until the pointer leaves.
    var Stack=(function(){
      var GRACE=450,AWAY=10000;
      function make(){return {on:false,n:0,hover:false,pinned:false,quiet:false,leaveAt:0,awayAt:0}}
      function reset(s){s.hover=false;s.pinned=false;s.quiet=false;s.leaveAt=0;s.awayAt=0}
      function count(s,n){s.n=n>0?Math.floor(n):0;if(s.n<2)reset(s)}
      function setOn(s,on){s.on=!!on;if(!s.on)reset(s)}
      function more(n){return n>1?n-1:0}
      function text(n){var m=more(n);return m>0?'+'+m:''}
      function grouped(s){return s.on&&s.n>1}
      function open(s,now){
        if(!grouped(s))return false;
        if(s.hover)return true;
        if(s.pinned&&(!s.awayAt||now<s.awayAt))return true;
        return s.leaveAt>0&&now<s.leaveAt;
      }
      function shut(s,now){return grouped(s)&&!open(s,now)}
      function enter(s){if(!grouped(s)||s.quiet)return;s.hover=true;s.leaveAt=0;s.awayAt=0}
      function leave(s,now){
        s.quiet=false;
        if(!s.hover)return;
        s.hover=false;s.leaveAt=now+GRACE;
        if(s.pinned)s.awayAt=now+AWAY;
      }
      function pin(s){if(!grouped(s))return;s.pinned=true;s.awayAt=0}
      // Esc closes a list that is open, whether a click keeps it open or only the pointer does (the key comes from the global
      // key handler, never from focus: the panel takes none). Quiet holds it shut until the pointer leaves.
      function esc(s,now){
        tick(s,now);
        if(!open(s,now))return false;
        s.pinned=false;s.hover=false;s.leaveAt=0;s.awayAt=0;s.quiet=true;
        return true;
      }
      function tick(s,now){
        if(s.leaveAt&&now>=s.leaveAt)s.leaveAt=0;
        if(s.awayAt&&now>=s.awayAt){s.awayAt=0;s.pinned=false}
      }
      // The next moment the answer changes by itself (0: never), so the page sets one timer and no polling.
      function due(s,now){
        var d=0;
        if(s.leaveAt>now)d=s.leaveAt;
        if(s.awayAt>now&&(!d||s.awayAt<d))d=s.awayAt;
        return d;
      }
      return {GRACE:GRACE,AWAY:AWAY,make:make,count:count,setOn:setOn,more:more,text:text,grouped:grouped,open:open,shut:shut,
        enter:enter,leave:leave,pin:pin,esc:esc,tick:tick,due:due};
    })();
    // <<< stack model
    // >>> card clock
    // How long each plain card has left. A card's time only runs while it is on screen: it is the newest card (list shut), or the
    // list is open, and the pointer is not on it. A card hidden behind the newest keeps what it had left and runs again when it
    // shows. Pure: tests/notestack-test.mjs runs this block with a fake clock.
    var Clock=(function(){
      var MIN=2500;
      // cs: the cards, newest first ({sticky,held,run,left,t0}). hidden(i): is card i out of sight. Returns who stops and who starts.
      function sync(cs,hidden,now){
        var start=[],stop=[];
        cs.forEach(function(c,i){
          if(c.sticky)return;
          if(hidden(i)||c.held){if(c.run){c.left-=now-c.t0;c.run=false;stop.push(c)}}
          else if(!c.run){c.t0=now;c.run=true;start.push(c)}
        });
        return {start:start,stop:stop};
      }
      function due(c){return Math.max(c.left,MIN)}
      return {MIN:MIN,sync:sync,due:due};
    })();
    // <<< card clock
    var stk=Stack.make(),stkT=0,stkCol=false,stkPin=false,stkOpen=false;
    // Tell Swift when a click keeps the list open and when the list is open at all (the global key handler passes Esc on for it).
    function stkPost(){
      var o=Stack.grouped(stk)&&!stkCol;
      if(stk.pinned===stkPin&&o===stkOpen)return;
      stkPin=stk.pinned;stkOpen=o;post({type:'stack',pinned:stkPin,open:stkOpen});
    }
    function stkNow(){return performance.now()}
    // Where the pointer counts as "on the stack": shut, the newest card and the badge; open, the whole list.
    function stkInside(x,y){
      if(x<0||!Stack.grouped(stk))return false;
      var rs=[];
      if(stkCol)rs.push(badge.getBoundingClientRect());   // shut: only the "+N" badge opens it, so nothing moves under the pointer
      else rs.push(list.getBoundingClientRect(),document.getElementById('bar').getBoundingClientRect());
      return rs.some(function(r){return r.width>0&&x>=r.left-2&&x<=r.right+2&&y>=r.top-2&&y<=r.bottom+2});
    }
    // Something about the open state moved: lay out again if it flipped, and set the one timer for the next change.
    function stkSync(){
      var now=stkNow();Stack.tick(stk,now);
      if(Stack.shut(stk,now)!==stkCol)layout();
      stkPost();
      clearTimeout(stkT);
      var d=Stack.due(stk,now);
      if(d)stkT=setTimeout(stkSync,Math.max(0,d-now)+8);
    }
    function stkPtr(x,y){
      if(!stk.on)return;
      var now=stkNow();
      if(x>=0&&stkInside(x,y))Stack.enter(stk);else Stack.leave(stk,now);
      stkSync();
    }
    // A click on the stack keeps it open (Esc then closes it); it never blocks the click's own job.
    // Only the badge, the list's own background or the bar keep it open: a card's x or button just does its own job.
    wrap.addEventListener('click',function(e){
      if(!Stack.grouped(stk))return;
      var t=e.target;if(t&&t.closest&&t.closest('.card'))return;
      Stack.pin(stk);setTimeout(stkSync,0);
    },true);
    wrap.addEventListener('mousemove',function(e){stkPtr(e.clientX,e.clientY)});
    document.documentElement.addEventListener('mouseleave',function(){stkPtr(-1,-1)});

    // ---------- the list ----------
    function size(h,wait){
      // Grow the window at once (the new space is see-through), shrink only once the move is over. Nothing
      // is sent while the height stays the same (a capped stack never resizes as cards come and go).
      clearTimeout(shrink);
      if(h===posted)return;
      if(h>posted){posted=h;post({type:'size',h:h})}
      else shrink=setTimeout(function(){posted=h;post({type:'size',h:h})},wait||620);
    }
    // ---------- scrolling ----------
    // The fades at the edges, the thin bar while it moves, and the "new above" pill once the developer is back at the top.
    var fadeT=-1,fadeB=-1;
    function edges(){
      var st=list.scrollTop,mx=list.scrollHeight-list.clientHeight,sc=mx>2;
      view.classList.toggle('scroll',sc);view.classList.toggle('up',sc&&st>2);view.classList.toggle('down',sc&&st<mx-2);
      // 1 is no fade, 0 full: the fade grows over the first 40 points scrolled and goes over the last 56.
      var t=sc?+(1-Math.min(1,Math.max(0,st)/40)).toFixed(3):1,b=sc?+(1-Math.min(1,Math.max(0,mx-st)/56)).toFixed(3):1;
      if(t!==fadeT){fadeT=t;view.style.setProperty('--ft',String(t))}
      if(b!==fadeB){fadeB=b;view.style.setProperty('--fb',String(b))}
      if(st<=2&&fresh){fresh=0;newer.classList.remove('on')}
    }
    function thumbAt(){
      var h=list.clientHeight,H=list.scrollHeight;if(H<=h+2)return;
      var th=Math.max(26,h*h/H);thumb.style.height=th+'px';thumb.style.transform='translate3d(0,'+((h-th)*list.scrollTop/(H-h)).toFixed(1)+'px,0)';
      thumb.classList.add('on');clearTimeout(thumbT);thumbT=setTimeout(function(){thumb.classList.remove('on')},700);
    }
    list.addEventListener('scroll',function(){edges();thumbAt();if(ptrAt)light(ptrAt[0],ptrAt[1])},{passive:true});
    newer.onclick=function(){list.scrollTo({top:0,behavior:'smooth'})};
    // Moves the scroll from `from` to `top` without anything on screen jumping: each card's current place shifts
    // by the same amount the other way, then it glides on to where it belongs (its transition starts again from there).
    function rebase(from,top){
      var d=top-from,els=[].slice.call(list.querySelectorAll('.card'));
      if(Math.abs(d)<0.5||!els.length){list.scrollTop=top;return}
      var goal=els.map(function(e){return e.style.transform});
      var now=els.map(function(e){return new WebKitCSSMatrix(getComputedStyle(e).transform)});
      els.forEach(function(e,i){var m=now[i];e.classList.add('still');e.style.transform='translate3d('+m.m41+'px,'+(m.m42+d)+'px,0)'+(Math.abs(m.a-1)>0.001?' scale('+m.a+')':'')});
      list.scrollTop=top;void list.offsetHeight;
      els.forEach(function(e,i){e.classList.remove('still');e.style.transform=goal[i]});
    }
    function moving(c){return c.el.classList.contains('drag')}
    function layout(wait){
      Stack.count(stk,cards.length);
      var was=stkCol,col=Stack.shut(stk,stkNow());stkCol=col;
      // Room for the bar at the top, kept while the list is shut too, so the newest card never moves when the list opens.
      var off=cards.length>1?BAR:0,y=TOP+off,from=list.scrollTop;
      if(was&&!col)settle();
      view.style.setProperty('--bs',off+'px');
      cards.forEach(function(c,i){
        var s=c.el.style,hide=col&&i>0;s.zIndex=String(1000-i);
        c.el.classList.toggle('stk',hide);
        c.y=hide?TOP+off:y;
        // Shut: the cards behind the newest wait right under it, unseen; opening springs them out from there.
        if(!moving(c)){s.transform='translate3d(0,'+c.y+'px,0)'+(hide?' scale(.94)':'');s.opacity=hide?'0':'1';s.filter='none'}
        if(!hide)y+=(c.group?groupH(c):c.el.offsetHeight)+GAP;
      });
      var many=cards.length>1,content=cards.length?y-GAP+BOT:0;
      if(col){
        content=y-GAP+BGAP+BH+BEND;
        badge.style.top=(y-GAP+BGAP)+'px';
        badge.textContent=Stack.text(cards.length);
        badge.setAttribute('aria-label',Stack.more(cards.length)+' more notifications');
      }
      badge.classList.toggle('on',col);
      var listH=Math.min(content,Math.max(160,maxH-PAD));
      var nowH=list.offsetHeight;
      fill.style.height=content+'px';
      // The list shrinks only after the cards have moved (a card flying out is never cut off).
      clearTimeout(listT);
      if(listH>=nowH)list.style.height=listH+'px';
      else listT=setTimeout(function(){list.style.height=listH+'px';edges()},wait||420);
      // Less to scroll than where the developer was (a card went near the bottom): glide there instead of jumping.
      var top=Math.max(0,Math.min(from,content-Math.max(listH,nowH)));
      if(top<from-0.5)rebase(from,top);
      edges();
      count.textContent=cards.length+(cards.length===1?' notification':' notifications');
      wrap.classList.toggle('open',many&&!col);
      size(cards.length?listH+PAD:0,(wait||420)+200);
      stkPost();
      clock();
    }
    // The list just opened under a resting pointer: for a moment the cards ignore it, so a card that springs out under the pointer
    // is never clicked by accident.
    var settleT=0;
    function settle(){wrap.classList.add('settle');clearTimeout(settleT);settleT=setTimeout(function(){wrap.classList.remove('settle')},450)}
    // Plain cards go after a while (each on its own). A card's time only runs while it shows: not while it waits behind the newest
    // one, not while the pointer is on it (core: the "card clock" block above).
    function clock(){
      var r=Clock.sync(cards,function(i){return stkCol&&i>0},Date.now());
      r.stop.forEach(function(c){clearTimeout(c.timer);c.timer=0});
      r.start.forEach(function(c){clearTimeout(c.timer);c.timer=setTimeout(function(){remove(c)},Clock.due(c))});
    }
    function answer(c,action){
      if(c.group){c.m.rows.forEach(function(r){post({type:'action',id:r.id,action:action})});return}   // the bubble's buttons: every chat in it
      if(c.data.id)post({type:'action',id:c.data.id,action:action});
    }
    // Out to the right (from wherever a drag left it), then the rest glide into its place.
    // Under the island (V1.55) anything but a swipe takes it back up into the island instead: it shrinks to a sliver of
    // the island's width at the top edge, behind the cards above it, and fades as it gets there.
    function into(c){return isl.on&&!((c.dx||0)>8)}
    function fly(c,delay){
      clearTimeout(c.timer);clearTimeout(c.wt);
      if(c.editing)endEdit(c,false);
      SquadMsg.gone(c);
      var s=c.el.style;c.el.style.pointerEvents='none';
      c.el.classList.remove('drag');
      if(into(c)){
        c.el.classList.remove('born');s.zIndex='1';
        if(delay)s.transitionDelay=delay+'s';
        if(!calm()){
          var cw=c.el.offsetWidth||364,k=Math.min(1,isl.iw/cw)*0.9;
          c.el.classList.add('gulp');
          s.transform='translate3d('+Math.round(isl.ix-(14+cw/2))+'px,'+Math.round(list.scrollTop-6)+'px,0) scale('+k.toFixed(3)+',.1)';
          s.filter='blur(2px)';
        }
        s.opacity='0';
        setTimeout(function(){c.el.remove()},520+(delay||0)*1000);
        return;
      }
      c.el.classList.add('fly');
      if(delay)s.transitionDelay=delay+'s';
      s.transform='translate3d('+Math.round(Math.max(c.dx||0,0)+c.el.offsetWidth*1.15)+'px,'+(c.y||0)+'px,0)';
      s.opacity='0';
      setTimeout(function(){c.el.remove()},420+(delay||0)*1000);
    }
    function remove(c){
      var i=cards.indexOf(c);if(i<0)return;
      if(SquadMsg.hold(c))return;   // a G Squad reply waiting out its Undo keeps its card until it is sent (SquadMessageCard.swift)
      if(c.group)groupEnd(c,true);
      var back=into(c)&&!calm();
      cards.splice(i,1);fly(c);layout();
      if(back)setTimeout(function(){post({type:'gulp'})},300);   // the island takes it in with a small swell
      // Gone for good (V1.55): Swift stops routing it. Not when the same card is replaced, nor moved to the other stack.
      if(c.data.id&&!c.swap)post({type:'gone',id:c.data.id,timedOut:!!c.timedOut});
    }
    // Moved to the other stack (the island hid or came back, or the developer's choice for its kind changed): it just fades here.
    function take(c){
      var i=cards.indexOf(c);if(i<0)return;
      if(c.group)groupEnd(c,false);
      cards.splice(i,1);clearTimeout(c.timer);clearTimeout(c.wt);if(c.editing)endEdit(c,false);SquadMsg.gone(c);
      c.el.style.pointerEvents='none';c.el.classList.add('taken');c.el.style.opacity='0';
      setTimeout(function(){c.el.remove()},200);
      layout();
    }
    function clearAll(){
      var gone=cards;cards=[];
      gone.forEach(function(c,i){answer(c,'dismiss');if(c.group)groupEnd(c,true);fly(c,i*0.035);if(c.data.id)post({type:'gone',id:c.data.id,timedOut:false})});
      layout(420+gone.length*35);
      if(isl.on&&gone.length&&!calm())setTimeout(function(){post({type:'gulp'})},300+gone.length*35);
    }

    // ---------- swipe right to dismiss (a drag, or two fingers on the trackpad) ----------
    function follow(c,dx){
      var x=dx>0?dx:dx/4;c.dx=x;
      var s=c.el.style;s.transform='translate3d('+x+'px,'+(c.y||0)+'px,0)';
      s.opacity=String(Math.max(0.12,1-Math.max(0,x)/(c.el.offsetWidth*1.05)));
      var now=performance.now();c.samples.push([now,x]);while(c.samples.length>8)c.samples.shift();
    }
    function speed(c){
      var s=c.samples;if(s.length<2)return 0;var last=s[s.length-1],first=s[0];
      for(var i=s.length-2;i>=0;i--){if(last[0]-s[i][0]>100)break;first=s[i]}
      return (last[1]-first[1])/Math.max(1,last[0]-first[0]);
    }
    function decide(c){
      var v=speed(c);c.samples=[];
      if(cards.indexOf(c)<0)return;
      if((c.dx||0)>c.el.offsetWidth*0.35||v>0.5){answer(c,'dismiss');remove(c);return}
      c.dx=0;c.el.classList.remove('drag');layout();   // not far enough: springs back
    }
    function swipe(c){
      c.samples=[];
      c.el.addEventListener('pointerdown',function(e){
        if(e.button!==0||c.editing||c.sqOpen)return;
        c.swallow=false;c.down={x:e.clientX,y:e.clientY,id:e.pointerId};
      });
      c.el.addEventListener('pointermove',function(e){
        var d=c.down;if(!d)return;
        var dx=e.clientX-d.x,dy=e.clientY-d.y;
        if(!moving(c)){
          if(Math.abs(dx)>6&&Math.abs(dx)>Math.abs(dy)){c.el.classList.add('drag');c.swallow=true;c.samples=[];try{c.el.setPointerCapture(d.id)}catch(x){}}
          else{if(Math.abs(dy)>6)c.down=null;return}
        }
        follow(c,dx);
      });
      function up(){if(!c.down)return;c.down=null;if(moving(c))decide(c)}
      c.el.addEventListener('pointerup',up);c.el.addEventListener('pointercancel',up);
    }
    // Two fingers sideways: right (in the fingers' own direction) moves it toward dismissed. Decided when the
    // fingers stop; the trackpad's coasting after a decision is ignored.
    function sideways(c,e){
      if(Date.now()<(c.block||0)||c.down||cards.indexOf(c)<0)return;
      if(!moving(c)){c.el.classList.add('drag');c.wx=0;c.samples=[]}
      c.wx+=e.webkitDirectionInvertedFromDevice?-e.deltaX:e.deltaX;
      follow(c,c.wx);
      clearTimeout(c.wt);c.wt=setTimeout(function(){c.block=Date.now()+400;c.wx=0;decide(c)},150);
    }
    // One gesture, one job, decided by its first move and kept until the wheel rests (180 ms, so the
    // trackpad's coasting stays with it): sideways swipes that card; up or down on "Remind me in" changes
    // the time; up or down anywhere else scrolls the stack (the browser's own scrolling, with momentum).
    // The first event decides because WebKit only lets that one be stopped.
    var gest=null;
    function cardOf(t){var e=t&&t.closest&&t.closest('.card');for(var i=0;i<cards.length;i++)if(cards[i].el===e)return cards[i];return null}
    list.addEventListener('wheel',function(e){
      var now=performance.now(),ax=Math.abs(e.deltaX),ay=Math.abs(e.deltaY);
      if(!gest||now-gest.t>180){
        if(!ax&&!ay)return;
        var c=cardOf(e.target),onRem=!!(c&&c.rem&&!moving(c)&&e.target.closest('button.rem'));
        gest={axis:ax>ay?'x':'y',c:c,rem:onRem,t:now};
      }
      gest.t=now;
      clearTimeout(relight);relight=setTimeout(function(){if(ptrAt)light(ptrAt[0],ptrAt[1])},200);   // once it rests, light what is under the pointer
      if(gest.axis==='x'){e.preventDefault();if(gest.c)sideways(gest.c,e);return}
      if(gest.rem){e.preventDefault();gest.c.rem.wheel(e);return}
      // Above the island the stack is mirrored (V1.55): the scroll is turned round so it still follows the fingers.
      if(isl.up){e.preventDefault();list.scrollTop-=e.deltaY}
    },{passive:false});
    // Where the pointer is (Swift sends it, the page gets no hover while PS is in the back): "Remind me in"
    // lights up while it is the one that would take the wheel.
    function light(x,y){
      var t=x<0?null:document.elementFromPoint(x,y),b=t&&t.closest?t.closest('button.rem'):null;
      if(b&&(b.closest('.discreet')||(gest&&gest.axis==='y'&&!gest.rem&&performance.now()-gest.t<180)))b=null;   // mid scroll: it scrolls on
      if(b!==hot){if(hot)hot.classList.remove('hot');hot=b;if(b)b.classList.add('hot')}
    }

    function click(c,e){
      if(c.swallow){c.swallow=false;return}   // that was a drag
      var t=e.target;
      if(t.tagName==='INPUT'||t.tagName==='TEXTAREA')return;
      // V1.57 private mode: a pop up waiting behind a pill comes out (Swift shows its own window); any other pill shows its card.
      if(c.data.pill){post({type:'action',id:c.data.id,action:'show'});remove(c);return}
      if(shut(c)){c.shown=true;paint(c);if(c.group)groupHead(c);layout();return}
      if(t.classList.contains('x')){answer(c,'dismiss');remove(c);return}
      if(c.group&&t.closest&&t.closest('.rx')){                      // one chat's own x: only that row goes
        var row=t.closest('.row'),r=row&&ChatRows.drop(c.m,row.dataset.id);
        if(r){post({type:'action',id:r.id,action:'dismiss'});rowGone(c,r,'dismiss')}
        return;
      }
      if(c.data.kind==='meet'){
        if(t.classList.contains('rv')){edit(c);return}               // the time: type one
        if(t.closest&&t.closest('.rem')){if(!c.editing){answer(c,'remind:'+c.mins);remove(c)}return}
        if(c.data.tone==='squad'&&SquadMsg.click(c,t)){layout();return}   // a G Squad message: Open, Reply box, Send, Undo, Dismiss (SquadMessageCard.swift)
        if(t.dataset&&t.dataset.reply){answer(c,'reply');return}
        if(c.data.tone==='ai'&&AiMsg.click(c,t)){layout();return}      // a message from an AI: the words open and fold (AiMessageCard.swift)       // Reply: the compose window opens; the card stays until it is sent
        var act=t.dataset&&t.dataset.act;
        if(act){answer(c,act);remove(c);return}                      // Dismiss (or a swipe, or Clear all): the only ways a client email card goes
        var link=t.dataset&&t.dataset.link;
        if(link)post({type:'open',url:link==='join'?c.data.join:c.data.url});   // opening never dismisses
        return;
      }
      if(t.dataset&&t.dataset.act){answer(c,t.dataset.act);remove(c);return}
      if(c.data.actions)return;           // a question: only its buttons answer it
      if(c.data.url)post({type:'open',url:c.data.url});
      remove(c);
    }
    document.getElementById('clear').onclick=function(){clearAll()};
    // Colours per kind (Toast.setLook, V1.36): one style sheet after the built in one, so a kind the developer gave a colour wins
    // and every other kind keeps its look. Discreet and alarm cards keep theirs (their rules are more specific).
    var LOOKSEL={done:['.t-done','.t-ai'],mail:['.t-mail'],lead:['.t-lead'],meet:['.t-booked','.t-soon'],other:['.t-ok','.t-info']};
    var LOOKKEYS=['c','top','bot','icBg','ic','sub','rem','remHi','line','btn','ink'];
    function look(L){
      var st=document.getElementById('look');if(!st){st=document.createElement('style');st.id='look';document.head.appendChild(st)}
      var hx=function(v){return typeof v==='string'&&/^#[0-9a-fA-F]{6}$/.test(v)},css='';
      Object.keys(LOOKSEL).forEach(function(k){
        var t=L&&L[k];if(!t||!LOOKKEYS.every(function(x){return hx(t[x])}))return;
        var at=function(suf){return LOOKSEL[k].map(function(s){return s+suf}).join(',')};
        css+=at('')+'{border-color:'+t.c+'99;background:linear-gradient(160deg,'+t.top+'f5,'+t.bot+'f5 60%)}';
        css+=at(' .ic')+'{background:'+t.icBg+';color:'+t.ic+'}'+at(' .sub')+'{color:'+t.sub+'}'+at(' .cd')+'{background:'+t.icBg+';color:'+t.sub+'}';
        css+=at(' .bul')+'{background:'+t.sub+';box-shadow:0 0 8px '+t.sub+'80}'+at(' .row .tool')+'{color:'+t.sub+'}';
        css+=at(' .acts button.rem')+'{background:'+t.rem+';border-color:'+t.line+'73}'+at(' .acts button.rem:hover')+'{background:'+t.remHi+'}';
        if(k==='other')css+='.card:not(.meet){border-color:'+t.c+'5c;background:linear-gradient(160deg,'+t.top+'f2,'+t.bot+'f2 60%)}'+
          '.card:not(.meet) .dot{background:'+t.c+';box-shadow:0 0 10px '+t.c+'cc}.card:not(.meet) .sub{color:'+t.sub+'}'+
          '.card:not(.meet) .acts button.main{background:'+t.btn+';color:'+t.ink+'}';
      });
      st.textContent=css;
      return css.length;
    }
    window.__note={
      look:look,
      // V1.57: every card, not only meeting ones: on, each becomes a pill again; off, each shows as itself.
      privacy:function(on){privacyOn=!!on;if(on)SquadMsg.esc();cards.forEach(function(c){if(c.data.kind==='meet'||c.group)c.data.discreet=!!on;if(on){c.shown=false;if(c.editing)endEdit(c,false)}paint(c)});layout()},
      reveal:function(on){revealAll=!!on;cards.forEach(paint);layout()},
      max:function(h){if((h||700)!==maxH){maxH=h||700;layout()}},
      // PS 1.65: the switch (Toast.pageMode), and Esc closing a list a click is keeping open. Checks: what the stack shows.
      stack:function(on){if(!!on===stk.on)return;Stack.setOn(stk,on);stkSync();layout()},
      esc:function(){var r=Stack.esc(stk,stkNow());stkSync();return r},
      stk:function(){return {on:stk.on,n:cards.length,shut:stkCol,badge:badge.classList.contains('on')?badge.textContent:'',pinned:stk.pinned,hover:stk.hover,
        visible:cards.filter(function(c){return !c.el.classList.contains('stk')}).length,badgeTop:Math.round(badge.getBoundingClientRect().top),badgeBottom:Math.round(badge.getBoundingClientRect().bottom)}},
      mode:function(m){
        var on=!!(m&&m.on),up=on&&!!m.up;
        isl={on:on,up:up,ix:on&&isFinite(+m.ix)?+m.ix:196,iw:on&&+m.iw>0?+m.iw:330};
        document.body.classList.toggle('isl',on);document.body.classList.toggle('up',up);
        if(cards.length)layout();
      },
      ptr:function(x,y){
        ptrAt=x<0?null:[x,y];light(x,y);stkPtr(x,y);
        // V1.55: the card under the pointer holds its line (Swift sends the pointer even while PS is in the back).
        var on=x<0?null:cardOf(document.elementFromPoint(x,y));
        cards.forEach(function(c){c.el.classList.toggle('held',c===on)});
        var t=x<0?null:document.elementFromPoint(x,y),row=t&&t.closest?t.closest('.row'):null;
        [].forEach.call(document.querySelectorAll('.row.hov'),function(e){if(e!==row)e.classList.remove('hov')});
        if(row)row.classList.add('hov');
      },
      take:function(id){
        if(G){var r=ChatRows.drop(G.m,id);if(r)rowGone(G,r,'take')}
        cards.filter(function(c){return c.data.id===id}).forEach(take);
      },
      // Checks: the bubble's rows as they are now.
      rows:function(){var now=Date.now();return G?{n:G.m.rows.length,held:G.m.held,head:G.sub.textContent,mixed:G.el.classList.contains('mixed'),
        rows:G.m.rows.map(function(r){return {id:r.id,title:r.title,tool:r.tool,ago:ChatRows.ago(r.at,now),left:+ChatRows.left(r).toFixed(3),size:ChatRows.size(r)}})}:null},
      // Self test and the note's checks: each card's line, as how far it has run (0 to 1) and whether it is held.
      lives:function(){return cards.filter(function(c){return c.life}).map(function(c){var m=new WebKitCSSMatrix(getComputedStyle(c.life).transform);return {id:c.data.id,left:+m.a.toFixed(3),held:c.el.classList.contains('held'),secs:parseFloat(c.el.style.getPropertyValue('--life'))}})},
      // Self test: what the stack shows and how it is scrolled.
      geom:function(){var fb=getComputedStyle(view).getPropertyValue('--fb');return {n:cards.length,listH:list.offsetHeight,content:list.scrollHeight,top:Math.round(list.scrollTop),
        max:list.scrollHeight-list.clientHeight,posted:posted,cap:maxH,open:wrap.classList.contains('open'),scroll:view.classList.contains('scroll'),down:view.classList.contains('down'),
        up:view.classList.contains('up'),isl:isl.on,mirrored:isl.up,fade:parseFloat(fb),newer:newer.classList.contains('on')?newer.textContent:'',hot:hot?1:0,count:count.textContent,
        bar:Math.round(document.getElementById('bar').getBoundingClientRect().bottom),barTop:Math.round(document.getElementById('bar').getBoundingClientRect().top),
        first:cards.length?Math.round(cards[0].el.getBoundingClientRect().top):-1,page:Math.round(wrap.getBoundingClientRect().bottom)}},
      rem:function(sel){var c=cards[0],b=c&&c.el.querySelector(sel||'button.rem'),r=b&&b.getBoundingClientRect(),rb=c&&c.el.querySelector('button.rem');return b?{mins:c.mins,label:rb?rb.textContent:'',top:list.scrollTop,w:rb?rb.offsetWidth:0,x:r.left+r.width/2,y:r.top+r.height/2}:null},
      focusEdit:function(){var i=editing&&editing.rem.input;if(i){i.focus();i.select()}else SquadMsg.focus()},
      endEdit:function(){if(editing)endEdit(editing,false);SquadMsg.esc()},
      drop:function(id){
        if(G){var r=ChatRows.drop(G.m,id);if(r)rowGone(G,r,'drop')}
        cards.filter(function(c){return c.data.id===id}).forEach(function(c){remove(c)});
      },
      add:function(d){
        if(d.kind==='meet'&&d.tone==='done'){addChat(d);return}   // V1.56: a finished AI chat is a row of the one bubble
        // The same card sent again (PS restarted, a sync) changes nothing on screen.
        if(d.id&&cards.some(function(c){return c.data.id===d.id&&c.json===JSON.stringify(d)}))return;
        var json=JSON.stringify(d);
        if(d.id)cards.filter(function(c){return c.data.id===d.id}).forEach(function(c){c.swap=true;remove(c)});   // one card per id
        var c={data:d,at:(d.at&&Date.parse(d.at))||Date.now(),json:json,left:STAY,dx:0,y:TOP};
        if(d.kind==='meet'&&privacyOn)d.discreet=true;
        c.el=el('div','card sheen'+(d.kind==='meet'?' meet t-'+d.tone:''));c.inner=el('div','in');
        if(d.id)c.el.dataset.id=d.id;
        var h=el('div','h');
        if(d.kind==='meet'){c.ic=el('span','ic');h.appendChild(c.ic)}else h.appendChild(el('span','dot'));
        c.t=el('span','t',d.title||'');h.appendChild(c.t);
        c.when=el('span','when',ago(c.at));h.appendChild(c.when);
        var xb=el('button','x','×');xb.title='Close';xb.setAttribute('aria-label','Close');c.el.appendChild(xb);   // top left, on hover (V1.47)
        c.inner.appendChild(h);
        if(d.kind==='meet'){
          // Everything with names or words goes in .full, hidden while the card is discreet.
          var full=el('div','full');
          if(d.sub)full.appendChild(el('div','sub',d.sub));
          if(d.body)full.appendChild(el('div','b',d.body));
          if(d.callAt){c.cd=el('span','cd',until(d.callAt));full.appendChild(c.cd)}
          var ma=[];if(d.url)ma.push({id:'open',label:d.url.indexOf('instantly')>0?'Open in Instantly':(d.url.indexOf('wa.me')>0||d.url.indexOf('whatsapp.com')>0)?'Open in WhatsApp':'Open in Gmail'});if(d.join)ma.push({id:'join',label:'Join call'});
          if(ma.length||d.dismiss||d.reply){var mb=el('div','acts');ma.forEach(function(a,i){var b=el('button',i===0?'main':'',a.label);b.dataset.link=a.id;mb.appendChild(b)});
            if(d.tone==='squad')SquadMsg.buttons(c,mb);
            else{
            if(d.reply){var rp=el('button','rep','Reply');rp.dataset.reply='1';mb.appendChild(rp)}
            if(d.dismiss){mb.appendChild(remind(c));var db=el('button','dis','Dismiss');db.dataset.act='dismiss';mb.appendChild(db)}}
            full.appendChild(mb)}
          c.inner.appendChild(full);
          c.inner.appendChild(el('div','hid','Private mode is on. Click to show.'));
          paint(c);
        }else{
          if(d.sub)c.inner.appendChild(el('div','sub',d.sub));
          if(d.body)c.inner.appendChild(el('div','b',d.body));
          if(d.url)c.inner.appendChild(el('div','go','Click to open in Gmail'));
          paint(c);   // V1.57: a pill while private mode is on
        }
        if(d.actions&&d.actions.length){
          var acts=el('div','acts');
          d.actions.forEach(function(a,i){var b=el('button',i===0?'main':'',a.label);b.dataset.act=a.id;acts.appendChild(b)});
          c.inner.appendChild(acts);
        }
        c.el.appendChild(c.inner);
        if(d.tone==='ai')AiMsg.made(c);
        // V1.55: its own time on screen (AI chat cards): the line runs down, paused while the pointer is on the card.
        if(d.life>0){
          var lf=el('div','life'),li=el('i');lf.appendChild(li);c.el.appendChild(lf);c.life=li;
          c.el.style.setProperty('--life',Math.max(3,Math.min(600,+d.life))+'s');
          li.addEventListener('animationend',function(){if(cards.indexOf(c)>=0){c.timedOut=true;remove(c)}});
        }
        enter(c);
      }
    };
    // A new card onto the stack: its clicks, hover and swipe, then it springs (or pours out of the island) into the top place.
    // Where a new card starts from: under the bar once a list shows, at the very top while only the newest shows.
    function startY(){var n=cards.length+1;return TOP+(n>1?BAR:0)}
    function enter(c){
        var d=c.data;
        c.el.addEventListener('click',function(e){click(c,e)});
        c.el.addEventListener('mouseenter',function(){c.el.classList.add('held');c.held=true;clock()});
        c.el.addEventListener('mouseleave',function(){c.el.classList.remove('held');c.held=false;if(cards.indexOf(c)>=0)clock()});
        swipe(c);
        // At the top (or close): the new card springs in there. Scrolled down: the stack stays exactly where the developer
        // left it (the new card arrives above, out of sight) and a pill says so.
        var from=list.scrollTop,atTop=from<=2,born=isl.on&&atTop&&!calm();
        if(born){
          // V1.55: out of the island. A sliver of the island's width at the very top, right under it as it swells,
          // that pours down into the top place while the rest glide down to make room.
          var cw=(list.clientWidth||392)-28,k=Math.min(1,isl.iw/cw);
          c.el.classList.add('born');
          c.el.style.transform='translate3d('+Math.round(isl.ix-(14+cw/2))+'px,'+Math.round(from-2)+'px,0) scale('+k.toFixed(3)+',.14)';c.el.style.opacity='0';c.el.style.filter='blur(3px)';
        }else if(isl.on){
          // Reduced motion (or scrolled away): it fades in where it belongs.
          c.el.style.transform='translate3d(0,'+startY()+'px,0)';c.el.style.opacity='0';
        }else{
          // Starts off to the right, a little small and soft, then springs into the top place while the rest glide down.
          c.el.style.transform='translate3d(60px,'+startY()+'px,0) scale(.94)';c.el.style.opacity='0';c.el.style.filter='blur(6px)';
        }
        list.appendChild(c.el);
        cards.unshift(c);
        // Read a size first so the start position is applied, then move: the move is a transition.
        // (Never wait for a frame: a hidden window gets none, and the panel is hidden until now.)
        void c.el.offsetHeight;
        layout();clock();
        if(atTop)list.scrollTop=0;
        else{
          rebase(from,from+c.el.offsetHeight+GAP);fresh++;
          newer.textContent='\u2191 '+fresh+' new';newer.classList.add('on');edges();
        }
        // The island hears of every card that came from it (it then glows instead of opening; it swells unless motion is reduced).
        if(isl.on)post({type:'born'});
        if(born)setTimeout(function(){c.el.classList.remove('born')},900);
        setTimeout(function(){c.el.classList.remove('sheen')},1600);
    }

    // ---------- the AI chats bubble (V1.56) ----------
    // One card on the stack holds every finished chat as a row (ChatRows above keeps their clocks). To Swift each chat is
    // still its own card: routing, moving between the island and the corner, Do Not Disturb and the "ran out" memory all
    // stay per chat. A row that runs out posts gone with timedOut, exactly as a card's line did.
    var G=null;
    function groupMake(d){
      var c={group:true,m:ChatRows.make(),rowEls:{},at:Date.now(),json:'',left:STAY,dx:0,y:TOP,
        data:{kind:'meet',tone:'done',icon:'done',sticky:true,dismiss:true,remind:d.remind,discreet:privacyOn||!!d.discreet,discreetText:''}};
      c.el=el('div','card sheen meet t-done grp');c.inner=el('div','in');
      var h=el('div','h');c.ic=el('span','ic');h.appendChild(c.ic);
      var col=el('div','gcol');c.dt=el('div','t dt');c.rowsBox=el('div','rows');col.appendChild(c.dt);col.appendChild(c.rowsBox);h.appendChild(col);
      c.inner.appendChild(h);
      var full=el('div','full');c.sub=el('div','sub');full.appendChild(c.sub);
      var mb=el('div','acts');mb.appendChild(remind(c));var db=el('button','dis','Dismiss');db.dataset.act='dismiss';mb.appendChild(db);full.appendChild(mb);
      c.inner.appendChild(full);
      c.inner.appendChild(el('div','hid','Private mode is on. Click to show.'));
      c.el.appendChild(c.inner);
      return c;
    }
    // The bubble's height once its rows have finished growing or going (the stack lays out to that, never mid move).
    function groupH(c){
      var cur=0,fin=0;
      [].forEach.call(c.rowsBox.children,function(e){cur+=e.offsetHeight});
      if(!c.el.classList.contains('discreet'))c.m.rows.forEach(function(r){var re=c.rowEls[r.id];if(re)fin+=re.inn.offsetHeight});
      return c.el.offsetHeight-cur+fin;
    }
    function groupHead(c){c.sub.textContent=ChatRows.head(c.m);c.el.classList.toggle('mixed',ChatRows.mixed(c.m));paint(c)}
    function rowMake(r){
      var e=el('div','row'),inn=el('div','ri'),b=el('span','bul'),a=el('span','ago',''),x=el('button','rx','\u00d7');
      e.dataset.id=r.id;e.title=r.title;
      x.title='Dismiss this one';x.setAttribute('aria-label','Dismiss '+r.title);
      inn.appendChild(b);inn.appendChild(el('span','t',r.title));inn.appendChild(el('span','tool',r.tool));inn.appendChild(a);
      e.appendChild(inn);e.appendChild(x);
      return {el:e,inn:inn,b:b,a:a,said:''};
    }
    function rowPaint(re,r,now){
      var t=ChatRows.ago(r.at,now);if(t!==re.said){re.said=t;re.a.textContent=t}
      re.b.style.transform='scale('+ChatRows.size(r)+')';
    }
    // A finished chat: its row goes in at the top. The first one makes the bubble (out of the island as cards come today).
    function addChat(d){
      var json=JSON.stringify(d),now=Date.now();
      var had=G&&ChatRows.find(G.m,d.id);
      if(had&&had.json===json)return;                       // the same card sent again changes nothing
      var first=!G;
      if(first)G=groupMake(d);
      var c=G;
      if(had){var old=c.rowEls[had.id];if(old)old.el.remove();delete c.rowEls[had.id]}
      var r=ChatRows.add(c.m,{id:d.id,title:d.title,sub:d.sub,at:d.at,life:d.life,json:json},now);
      var re=rowMake(r);c.rowEls[r.id]=re;rowPaint(re,r,now);
      c.rowsBox.insertBefore(re.el,c.rowsBox.firstChild);
      if(d.remind)c.data.remind=d.remind;
      groupHead(c);
      if(first){enter(c);return}
      // One more chat: the bubble grows to fit it (the row unfolds at the top) and comes to the top of the stack.
      if(!calm()){
        re.el.style.height='0px';re.el.classList.add('new');void re.el.offsetHeight;
        re.el.style.height=re.inn.offsetHeight+'px';
        setTimeout(function(){re.el.style.height='';re.el.classList.remove('new')},560);
      }
      var i=cards.indexOf(c);if(i>0){cards.splice(i,1);cards.unshift(c)}
      layout();
      if(isl.on)post({type:'born'});                         // the island swells for it, and does not open its own news
    }
    // A row leaves: it bloops out and the bubble shrinks to fit. how: time (ran out), dismiss, drop (gone elsewhere),
    // take (moved to the other stack: no answer). The last row takes the bubble with it, the way a card leaves.
    function rowGone(c,r,how){
      var re=c.rowEls[r.id];delete c.rowEls[r.id];
      if(how!=='take')post({type:'gone',id:r.id,timedOut:how==='time'});
      if(!c.m.rows.length){if(re)re.el.remove();if(how==='take')take(c);else remove(c);return}
      if(re){
        if(calm())re.el.remove();
        else{
          re.el.style.height=re.el.offsetHeight+'px';re.el.classList.add('out');void re.el.offsetHeight;
          re.el.style.height='0px';setTimeout(function(){re.el.remove()},480);
        }
      }
      groupHead(c);layout(520);
    }
    // The bubble itself went (Dismiss, Remind me in, a swipe, Clear all, its last row): every chat still in it is gone too.
    function groupEnd(c,answered){
      if(answered)c.m.rows.forEach(function(r){post({type:'gone',id:r.id,timedOut:false})});
      c.m.rows=[];c.rowEls={};if(G===c)G=null;
    }
    // Every row's clock, circle and "X secs ago". Held while the pointer is on the bubble (or it is dragged, or a time is
    // being typed into its Remind me in).
    setInterval(function(){
      if(!G)return;
      var c=G,now=Date.now();
      ChatRows.hold(c.m,c.el.classList.contains('held')||moving(c)||!!c.editing,now);
      var out=ChatRows.tick(c.m,now);
      c.m.rows.forEach(function(r){var re=c.rowEls[r.id];if(re)rowPaint(re,r,now)});
      out.forEach(function(r){rowGone(c,r,'time')});         // every one says it ran out, even when the bubble went with the first
    },200);
    setInterval(function(){cards.forEach(function(c){if(c.when)c.when.textContent=ago(c.at)})},30000);
    setInterval(function(){cards.forEach(function(c){if(c.cd)c.cd.textContent=until(c.data.callAt)})},15000);
  })();
  </script></body></html>
  """#
}
