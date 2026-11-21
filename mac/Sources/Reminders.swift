// The Annoying 15 min reminders on a Mac (the developer, 10 Nov 2026: "Make it so you can add multiple throughout the day, edit
// the notifications, change the colour of the pop up, even play a sound you select from audio files too"). The list
// lives in the vault (web src/core/remind.ts, Settings > Annoying 15 min reminder); the page hands this Mac
// the plan ("rem:plan", every reminder with its words worked out) and this file shows the cards. The rules are in
// RemMath.swift. It grew out of the daily reminder card (FollowUp.swift, 24 Oct to 9 Nov 2026), which is reminder one
// gone since 1.60 (its built in "fu" reminder is removed for everyone). Every rule of that card holds for
// each reminder:
// - A card only OPENS inside its window, on its days. Away, locked, asleep or in a meeting for the whole window means
//   that window is skipped, with no catch up; a snooze that ends after the window does not come back; a card already
//   up when the window ends stays until answered.
// - Only while you are at the Mac (Here.swift). Once up, it stays up while you are away: never on a timer.
// - Never during a calendar meeting or under PS Do Not Disturb (it waits, and a card already up steps aside).
// - Never over 1Password or Signal (golden rule): only whether one of them is in front is checked.
// - Never while Sleep mode or the Sentry mode cover is up (V1.55): it waits, and a card already up steps aside.
// - A reminder on a task (V1.55, core/remind.ts) says the task's name and has a third button, Open task: the Tab list
//   opens with that task glowing; the card stays until Done or Remind me in. Done ticks the task (the page does that).
// - Its snooze button ("Remind me in 15 mins", the length and the words are the reminder's) puts it away for its
//   snooze. Its confirm button ("Yes", or its own words) either clears it at once (one click) or opens a box, and the
//   card goes only when its word is typed (any case) and Enter or Done is pressed.
// - An answer here closes this card at once, is kept in this Mac's PS settings (so it survives a restart, sleep and
//   lock) and goes to the page ({type:"remAct"}), which saves it in the vault: the phone's notification goes too. An
//   answer on the phone comes back in the next plan and closes the card here.
// - Several cards at once stack down from the top centre, in the list's order. Each has its own colours and plays
//   its sound once when it comes up (none, a built in one, or this Mac's own file for that reminder, at its loudness
//   share of this Mac's volume; the volume itself is never changed).
// - The card takes the keyboard only while its box is open, then hands it back. Esc closes the box (the card stays).
// - Test (Settings) shows a reminder right now with its sound; its buttons and Esc close it; nothing is saved.
// - PS 1.73 (web core/duealerts.ts): the nags for tasks due today come as ordinary cards on their tasks. The Priority 1 alarm
//   is a card with `one` (only "I acknowledge", no snooze button; it opens the box and only "yes" typed clears it, the usual
//   typed confirm, the developer 21 Nov 2026: a click alone must not do it) and `ring`: its sound loops while it is up, for at most
//   ringFor, and stops when it is answered, closed or answered on another device. Another card's chime never cuts it off.
// Everything here is a few comparisons every 5 seconds on the main thread; file reading is on its own queue.
import AppKit
import WebKit
import AVFoundation
import UniformTypeIdentifiers

final class FuPanel: NSPanel {
  var keyable = false
  var remId = ""
  override var canBecomeKey: Bool { keyable }
  override var canBecomeMain: Bool { false }
}

final class Reminders: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = Reminders()
  static let width: CGFloat = 460
  static let testId = "__test"
  /// PS 1.65 Checklist reminder (web core/chkremind.ts): the page hands over ONE card with three choices ("rem:chk"); it comes up like a
  /// reminder (only while you are at the Mac, never in a meeting, Do Not Disturb, Sleep mode, Sentry mode or over 1Password or Signal),
  /// stays until a choice, the typed yes or its close button, and tells the page which one it was (onChk).
  static let chkId = "chk"

  /// This Mac's own answer to one reminder, kept until a plan carries one as new (stateAt).
  struct Local: Codable, Equatable { var done = ""; var snoozeUntil = 0.0; var at = 0.0; var sent = 0.0 }

  // ---------- state ----------
  private(set) var items: [RemMath.Item] = []
  private(set) var local: [String: Local] = [:]
  private var meeting = false
  private var store: UserDefaults = .standard
  private var testDir: String?
  /// Settings changed: PS > Settings redraws.
  var onSettings: (() -> Void)?
  /// An answer for the page (main.swift sends it to the main page, retried while that page loads).
  var onAnswer: ((String) -> Void)?
  /// Hands a JS line to both pages (own sounds, the end of a Test).
  var deliver: ((String) -> Void)?
  // What it looks at, swapped for fakes by the self test.
  var clock: () -> Date = { Date() }
  var hereNow: () -> Bool = { Here.now() }
  var shieldNow: () -> Bool = { Protected.front }
  /// Sleep mode or the Sentry mode cover is up: no card opens, and one up steps aside (it comes back after).
  var coveredNow: () -> Bool = { SleepScreen.shared.isUp || Sentry.shared.isUp }
  /// Open task on a card (V1.55): the task's id, checked (main.swift opens the Tab list at it).
  var onOpenTask: ((String) -> Void)?

  private final class Card {
    let id: String
    var item: RemMath.Item
    let panel: FuPanel
    let web: WKWebView
    var ready = false
    var boxOpen = false
    var height: CGFloat = 170
    var returnTo: pid_t = 0
    init(id: String, item: RemMath.Item, panel: FuPanel, web: WKWebView) { self.id = id; self.item = item; self.panel = panel; self.web = web }
  }
  private var cards: [String: Card] = [:]
  private(set) var up: [String] = []              // the reminders whose card is meant to be up, in the list's order
  private var testItem: RemMath.Item?
  private var chkItem: RemMath.Item?
  /// A choice was made on the checklist card: "rethink", "forgot", "sure" (the typed yes) or "esc" (closed). main.swift opens the list and
  /// tells the page.
  var onChk: ((String) -> Void)?
  private var timer: Timer?
  private var player: AVAudioPlayer?
  private let q = DispatchQueue(label: "ps.reminders.sound", qos: .utility)

  // ---------- life ----------
  func start(testDir: String? = nil) {
    if testDir == nil { PrivateHold.shared.watch { [weak self] in self?.place() } }   // V1.57: private mode on hides the ones up
    self.testDir = testDir
    // A test copy keeps its own throwaway settings: it never reads or writes the developer's real ones.
    if testDir != nil, let t = UserDefaults(suiteName: "com.cincee.ps.fu-selftest") {
      t.removePersistentDomain(forName: "com.cincee.ps.fu-selftest"); store = t
    }
    load()
    if testDir != nil { items = [] }     // a test copy stays quiet until its self test hands it a plan
    let t = Timer(timeInterval: 5, repeats: true) { [weak self] _ in if !LowPower.shared.asleep("alarms") { self?.check() } }   // PS 1.65: rings in Low power mode while Keep reminders ringing is on
    t.tolerance = 1
    RunLoop.main.add(t, forMode: .common)
    timer = t
    check()
  }
  func dndChanged() { if timer != nil { check() } }

  private func load() {
    if let d = store.data(forKey: "rem.items"), let a = try? JSONSerialization.jsonObject(with: d) { items = RemMath.items(["items": a]) } else { items = [] }
    if let d = store.data(forKey: "rem.local"), let l = try? JSONDecoder().decode([String: Local].self, from: d) { local = l } else { local = [:] }
    // 1.60: the built in daily reminder ("fu") is gone for everyone. A stored answer for it, and the old card's own
    // settings, are cleaned out (a card for it never comes back; ones people made themselves keep their ids).
    local[RemMath.retiredId] = nil
    for k in ["fu.prefs", "fu.doneFor", "fu.snoozeUntil", "rem.legacyDone"] { store.removeObject(forKey: k) }
  }
  private func save() {
    if let d = try? JSONSerialization.data(withJSONObject: items.map { $0.json }) { store.set(d, forKey: "rem.items") }
    if let d = try? JSONEncoder().encode(local) { store.set(d, forKey: "rem.local") }
  }

  /// The state that counts for one reminder: this Mac's own answer when it is newer than the plan's.
  func state(_ i: RemMath.Item) -> (done: String, snoozeUntil: Double) {
    if let l = local[i.id], l.at > i.stateAt { return (l.done, l.snoozeUntil) }
    return (i.done, i.snoozeUntil)
  }

  /// Every 5 seconds, and whenever the plan, a meeting, Do Not Disturb or the app in front changes.
  func check() {
    let now = clock(), here = hereNow(), quiet = meeting || DND.shared.mutes("followup") || coveredNow()
    var want: [String] = []
    for i in items {
      let s = state(i)
      let st = RemMath.status(i, done: s.done, snoozeUntil: s.snoozeUntil, now: now)
      let isUp = up.contains(i.id)
      switch st {
      case .show: if !quiet && (here || isUp) { want.append(i.id) }
      case .closed: if isUp && !quiet { want.append(i.id) }   // up stays up past the window; not up waits for the next one
      case .done, .snoozed, .off: break
      }
    }
    // A checklist card that is not up yet is never held for later: the person is away or a meeting, Sleep mode or Do Not Disturb is on.
    // It is dropped and the page starts its count again (any quiet spell restarts it), so it never lands the moment they come back.
    if chkItem != nil, !up.contains(Reminders.chkId), quiet || !here {
      chkItem = nil
      if testDir == nil { onChk?("away") }
    }
    if chkItem != nil, !quiet, here || up.contains(Reminders.chkId) { want.append(Reminders.chkId) }
    for id in up where !want.contains(id) { close(id) }
    for id in want where !up.contains(id) { open(id) }
    up = items.map(\.id).filter { want.contains($0) } + (want.contains(Reminders.chkId) ? [Reminders.chkId] : [])
    place()
  }

  // ---------- from the page ----------
  func setMeeting(_ on: Bool) { if meeting != on { meeting = on; check() } }
  /// The plan: replaces the list. Answers this Mac made that the plan does not carry yet are sent again.
  func setPlan(_ plan: Any?) {
    let next = RemMath.items(plan)
    let now = clock().timeIntervalSince1970 * 1000
    for i in next { if let l = local[i.id], l.at <= i.stateAt { local[i.id] = nil } }
    local = local.filter { id, _ in next.contains { $0.id == id } }
    if next != items {
      items = next
      psLog("PS reminders: plan of \(items.count)")   // never the words
    }
    save()
    for (id, l) in local where now - l.sent > 30_000 { send(id, l) }
    // Words or colours changed for a card that is up: it shows the new ones at once.
    for (id, c) in cards where id != Reminders.testId { if let i = items.first(where: { $0.id == id }), i != c.item { c.item = i; show(c) } }
    check()
  }
  func settingsJSON() -> [String: Any] {
    ["count": items.count, "up": up.count]
  }

  // ---------- answers ----------
  private func answer(_ id: String, done: Bool) {
    guard let i = items.first(where: { $0.id == id }) else { return }
    let now = clock()
    var l = Local(at: (now.timeIntervalSince1970 * 1000).rounded())
    if done { l.done = RemMath.cycleDay(i, now: now) } else {
      l.done = state(i).done
      l.snoozeUntil = l.at + Double(i.snooze) * 60_000
    }
    local[id] = l
    save()
    psLog("PS reminders: \(done ? "done" : "remind in \(i.snooze) min")")
    send(id, l)
    close(id)
    up.removeAll { $0 == id }
    place()
  }
  private func send(_ id: String, _ l: Local) {
    var m: [String: Any] = ["type": "remAct", "id": id, "at": l.at, "by": "mac"]
    if l.snoozeUntil > l.at { m["act"] = "snooze"; m["until"] = l.snoozeUntil } else { m["act"] = "done"; m["day"] = l.done }
    guard let d = try? JSONSerialization.data(withJSONObject: m), let s = String(data: d, encoding: .utf8) else { return }
    local[id]?.sent = clock().timeIntervalSince1970 * 1000
    if testDir == nil { onAnswer?(s) }
  }

  // ---------- the cards (main thread) ----------
  private func item(_ id: String) -> RemMath.Item? { id == Reminders.testId ? testItem : id == Reminders.chkId ? chkItem : items.first { $0.id == id } }
  private func card(_ id: String) -> Card? {
    if let c = cards[id] { return c }
    guard let i = item(id) else { return nil }
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.userContentController.add(self, name: "fu")
    // The panel is non activating and not key while it waits: a plain WKWebView dropped the first click (main.swift).
    let w = ClickThroughWebView(frame: NSRect(x: 0, y: 0, width: Reminders.width, height: 170), configuration: c)
    w.setValue(false, forKey: "drawsBackground")
    w.navigationDelegate = self
    let p = FuPanel(contentRect: NSRect(x: 0, y: 0, width: Reminders.width, height: 170), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.remId = id
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.contentView = w
    // A self test copy never shows anything on the developer's screen and never catches his clicks.
    if testDir != nil { p.alphaValue = 0; p.ignoresMouseEvents = true }
    let card = Card(id: id, item: i, panel: p, web: w)
    cards[id] = card
    w.loadHTMLString(Reminders.page, baseURL: nil)
    return card
  }
  private func open(_ id: String) {
    guard let c = card(id) else { return }
    if let i = item(id) { c.item = i }
    c.boxOpen = false
    psLog("PS reminders: card")
    if c.ready { show(c, fresh: true) }
    if PrivateCore.cardSound(privateOn: PrivateHold.shared.on) { play(c.item) }   // V1.57: no sound in private mode
  }
  /// Words and colours go in as arguments, never as code, and the card sets them as plain text (textContent).
  private func show(_ c: Card, fresh: Bool = false) {
    guard c.ready else { return }
    let i = c.item
    c.web.callAsyncJavaScript("window.__fu && window.__fu.set(o, f)", arguments: ["o": ["pill": i.pill, "text": i.text, "later": i.later, "yes": i.yes, "word": i.word, "click": i.click, "open": i.open, "one": i.one,
      "bg": i.bg, "accent": i.accent, "ink": i.ink, "test": c.id == Reminders.testId, "choices": i.choices, "sure": i.sure, "ask": i.ask], "f": fresh], in: nil, in: .page, completionHandler: nil)
  }
  private func close(_ id: String) {
    PrivateHold.shared.gone("rem:" + id)   // V1.57: its pill goes with it
    guard let c = cards.removeValue(forKey: id) else { return }
    let wasKey = c.panel.isKeyWindow
    c.panel.keyable = false
    if wasKey { c.panel.resignKey(); handBack(c) }
    // PS 1.60: out of the island, a dismissed reminder shrinks back into it (IslandColumn.retire), and the next pop up
    // comes after. Anywhere else (or with the moments off): the short fade as before, a new card is a new panel.
    let gone = {
      c.panel.orderOut(nil)
      c.web.configuration.userContentController.removeScriptMessageHandler(forName: "fu")
    }
    if IslandColumn.shared.retire(c.panel, id: "rem:" + id, completion: gone) {
      c.web.evaluateJavaScript("window.__fu && window.__fu.out()", completionHandler: nil)
    } else {
      IslandColumn.shared.leave("rem:" + id)   // V1.55: the windows under it move up into its place
      c.web.evaluateJavaScript("window.__fu && window.__fu.out()", completionHandler: nil)
      NSAnimationContext.runAnimationGroup({ ctx in ctx.duration = 0.18; c.panel.animator().alphaValue = 0 }, completionHandler: gone)
    }
    if ringId == id || (!cards.keys.contains(where: { $0 != Reminders.testId }) && testItem == nil) { stopSound() }   // PS 1.73: a ringing card's sound goes with it
  }
  /// Shown while up, except over 1Password or Signal (then hidden, and never holding the keyboard). Stacked from the
  /// top centre: the test card first, then the list's order.
  private func place() {
    let shield = shieldNow() || coveredNow()
    let order = (testItem != nil ? [Reminders.testId] : []) + up
    let vf = (NSScreen.main ?? NSScreen.screens.first!).visibleFrame
    var y = vf.maxY - 10
    for id in order {
      guard let c = cards[id] else { continue }
      // V1.57 private mode: out of sight behind a pill on the card stack until that is clicked or private mode ends.
      if shield || (testDir == nil && PrivateHold.shared.waits("rem:" + id, show: { [weak self] in self?.place() })) {
        if c.panel.isKeyWindow { c.panel.keyable = false; c.panel.resignKey() }
        if c.panel.isVisible { c.panel.orderOut(nil) }
        IslandColumn.shared.leave("rem:" + id)
        continue
      }
      // V1.55: out of the Dynamic Island while it is there and the developer left reminders on Island (IslandColumn.swift). The
      // card keeps its size, buttons, sound and rules (it still stays until answered); only its place differs.
      if let f = IslandColumn.shared.frame(id: "rem:" + id, kind: "reminders", size: NSSize(width: Reminders.width, height: c.height),
                                           window: c.panel, replace: { [weak self] in self?.place() }) {
        IslandColumn.shared.put(c.panel, f, alpha: testDir == nil ? 1 : 0)
        continue
      }
      y -= c.height
      c.panel.setFrame(NSRect(x: vf.midX - Reminders.width / 2, y: y, width: Reminders.width, height: c.height), display: true)
      y += 4   // the cards' own 8 px margins keep them apart
      if !c.panel.isVisible { if testDir == nil { c.panel.alphaValue = 1 }; c.panel.orderFrontRegardless() }
    }
  }
  /// The confirm box: the keyboard comes to the card for it (never in a test copy, never over 1Password or Signal).
  private func openBox(_ c: Card) {
    c.boxOpen = true
    guard testDir == nil, !shieldNow() else { return }
    c.returnTo = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
    c.panel.keyable = true
    c.panel.makeKey()
    c.web.evaluateJavaScript("window.__fu.focus()", completionHandler: nil)
  }
  private func closeBox(_ c: Card) {
    c.boxOpen = false
    let wasKey = c.panel.isKeyWindow
    c.panel.keyable = false
    if wasKey { c.panel.resignKey(); handBack(c) }
  }
  /// V1.41 Esc always backs out (EscAlways.swift): Esc in a card's box gives the keyboard back (the card stays until
  /// answered); Esc on the Test card closes it.
  func escape(_ w: NSWindow? = nil) {
    let id = (w as? FuPanel)?.remId ?? cards.values.first(where: { $0.panel.isKeyWindow })?.id ?? ""
    if id == Reminders.testId { stopTest(); return }
    if let c = cards[id] {
      // The checklist card: Esc backs out of the typed yes first, and then closes the card (PS rule: Esc closes everything).
      if id == Reminders.chkId, !c.boxOpen { finishChk("esc"); return }
      closeBox(c); c.web.evaluateJavaScript("window.__fu && window.__fu.unbox()", completionHandler: nil)
    }
  }
  /// The keyboard goes back to the app he was in (never 1Password or Signal, never in a test copy).
  private func handBack(_ c: Card) {
    guard testDir == nil, c.returnTo > 0, let app = NSRunningApplication(processIdentifier: c.returnTo), !Protected.matches(app) else { return }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == c.returnTo { app.activate(options: []) }
    c.returnTo = 0
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let c = cards.values.first(where: { $0.web === webView }) else { return }
    c.ready = true
    show(c, fresh: true)
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.navigationType == .other ? .allow : .cancel)    // nothing in the card navigates anywhere
  }
  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let c = cards.values.first(where: { $0.web === message.webView }), let text = message.body as? String, let d = text.data(using: .utf8),
          let msg = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let type = msg["type"] as? String else { return }
    let test = c.id == Reminders.testId
    switch type {
    case "size":
      if let h = msg["h"] as? Double, h > 40, h < 600 { c.height = CGFloat(h.rounded(.up)); place() }
    case "snooze": if test { stopTest() } else { answer(c.id, done: false) }
    case "open":   // Open task (a reminder on a task): the list opens at it; the card stays until answered
      if test { stopTest() } else if c.item.task.range(of: RemMath.taskPattern, options: .regularExpression) != nil, testDir == nil {
        psLog("PS reminders: open task")
        onOpenTask?(c.item.task)
      }
    case "box": if (msg["open"] as? Bool) == true { openBox(c) } else { closeBox(c) }
    case "choice":   // a choice on the checklist card (0 Rethink, 2 I forgot; the typed one opens the box instead)
      guard c.id == Reminders.chkId || test, let n = (msg["i"] as? NSNumber)?.intValue, (0..<c.item.choices.count).contains(n) else { return }
      if test { stopTest() } else { finishChk(n == 0 ? "rethink" : "forgot") }
    case "close":    // the checklist card's close button
      if test { stopTest() } else if c.id == Reminders.chkId { finishChk("esc") }
    case "confirm":
      let typed = String((msg["text"] as? String ?? "").prefix(60))
      if c.id == Reminders.chkId { if RemMath.confirms(c.item, typed) { finishChk("sure") } else { c.web.evaluateJavaScript("window.__fu && window.__fu.wrong()", completionHandler: nil) }; return }
      if RemMath.confirms(c.item, typed) { if test { stopTest() } else { answer(c.id, done: true) } }
      else { c.web.evaluateJavaScript("window.__fu && window.__fu.wrong()", completionHandler: nil) }
    default: break
    }
  }

  // ---------- the checklist card (PS 1.65) ----------
  private func showChk(_ v: Any?) {
    guard var i = RemMath.item(v), i.choices.count == 3 else { return }
    i.id = Reminders.chkId
    if chkItem == i { return }
    chkItem = i
    if let c = cards[Reminders.chkId] { c.item = i; show(c) }
    check()
  }
  /// The page took the card away (it was answered somewhere else, or the switch went off).
  private func stopChk() {
    guard chkItem != nil else { return }
    chkItem = nil
    check()
  }
  private func finishChk(_ outcome: String) {
    chkItem = nil
    up.removeAll { $0 == Reminders.chkId }
    close(Reminders.chkId)
    place()
    psLog("PS checklist reminder: \(outcome)")   // never the words
    if testDir == nil { onChk?(outcome) }
  }

  // ---------- sound ----------
  var soundDir: URL {
    testDir != nil ? FileManager.default.temporaryDirectory.appendingPathComponent("ps-test-rem-sounds", isDirectory: true)
      : FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PS/reminder-sounds", isDirectory: true)
  }
  private func ownURL(_ id: String) -> URL { soundDir.appendingPathComponent("\(id).wav") }
  private func metaURL(_ id: String) -> URL { soundDir.appendingPathComponent("\(id).json") }
  /// PS 1.73: how long a `ring` card's sound loops at most (the phone's ring, web core/remind.ts ALARM_RING_MIN).
  static let ringFor: TimeInterval = 10 * 60
  /// The card whose sound is ringing now (a `ring` card), nil when none.
  private var ringId: String?
  private var ringEnd: DispatchWorkItem?
  /// Its sound once, at its loudness share of this Mac's volume (the volume itself is never touched). A `ring` card loops it.
  private func play(_ i: RemMath.Item) {
    guard testDir == nil, i.sound != "none" else { return }
    if ringId != nil && !i.ring && i.id != Reminders.testId { return }   // a ringing alarm is never cut off by another card's chime
    let ringing = i.ring && i.id != Reminders.testId
    let id = i.id == Reminders.testId ? (testSoundId ?? i.id) : i.id
    q.async { [self] in
      var data: Data?
      if i.sound == "own", let d = try? Data(contentsOf: ownURL(id)), d.count > 44 { data = d }
      if data == nil { data = SleepSound.shared.ringData(i.sound == "alarm" ? "alarm" : "soft", own: false) }
      DispatchQueue.main.async { [self] in
        player?.stop()
        player = data.flatMap { try? AVAudioPlayer(data: $0) }
        player?.volume = Float(i.vol)
        ringEnd?.cancel(); ringEnd = nil; ringId = nil
        if ringing, player != nil {
          player?.numberOfLoops = -1
          ringId = i.id
          let end = DispatchWorkItem { [weak self] in
            guard let self, self.ringId == i.id else { return }
            psLog("PS reminders: ring stopped after \(Int(Reminders.ringFor / 60)) min")
            self.stopSound()
          }
          ringEnd = end
          DispatchQueue.main.asyncAfter(deadline: .now() + Reminders.ringFor, execute: end)
        }
        player?.play()
      }
    }
  }
  private func stopSound() { ringEnd?.cancel(); ringEnd = nil; ringId = nil; player?.stop(); player = nil }

  // ---------- Test (Settings) ----------
  private var testSoundId: String?
  private var testEnd: DispatchWorkItem?
  func test(_ v: Any?) {
    guard var i = RemMath.item(v) else { return }
    stopTest(silent: true)
    testSoundId = i.id
    i.id = Reminders.testId
    testItem = i
    let end = DispatchWorkItem { [weak self] in self?.stopTest() }
    testEnd = end
    DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: end)
    open(Reminders.testId)
    place()
  }
  func stopTest(silent: Bool = false) {
    testEnd?.cancel(); testEnd = nil
    guard testItem != nil else { return }
    testItem = nil
    close(Reminders.testId)
    stopSound()
    place()
    if !silent { deliver?("window.__psRemTestEnd && window.__psRemTestEnd()") }
  }

  // ---------- your own sound per reminder (stays on this Mac) ----------
  @discardableResult func handle(_ type: String, _ msg: [String: Any]) -> Bool {
    let id = (msg["id"] as? String).flatMap { $0.range(of: "^[a-z0-9]{1,16}$", options: .regularExpression) != nil ? $0 : nil }
    switch type {
    case "rem:sound:get": sendOwn()
    case "rem:sound:pick": if let id { pick(id) }
    case "rem:sound:remove":
      if let id { try? FileManager.default.removeItem(at: ownURL(id)); try? FileManager.default.removeItem(at: metaURL(id)); psLog("PS reminders: own sound removed") }
      sendOwn()
    case "rem:test": test(msg["item"])
    case "rem:chk": showChk(msg["item"])
    case "rem:chkStop": stopChk()
    case "rem:testStop": stopTest(silent: true)
    default: return false
    }
    return true
  }
  private func sendOwn(error: String? = nil, id: String? = nil) {
    var own: [String: Any] = [:]
    for f in (try? FileManager.default.contentsOfDirectory(at: soundDir, includingPropertiesForKeys: nil)) ?? [] where f.pathExtension == "json" {
      let rid = f.deletingPathExtension().lastPathComponent
      guard FileManager.default.fileExists(atPath: ownURL(rid).path), let d = try? Data(contentsOf: f),
            let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let n = o["name"] as? String else { continue }
      own[rid] = ["name": String(n.prefix(40)), "secs": (o["secs"] as? NSNumber)?.doubleValue ?? 0]
    }
    var m: [String: Any] = ["own": own]
    if let error { m["error"] = error; m["id"] = id ?? "" }
    let data = (try? JSONSerialization.data(withJSONObject: m, options: [.sortedKeys])) ?? Data("{}".utf8)
    deliver?("window.__psRemSound && window.__psRemSound(\(String(data: data, encoding: .utf8) ?? "{}"))")
  }
  private func pick(_ id: String) {
    guard testDir == nil else { sendOwn(); return }
    SleepSound.shared.beforePanel()
    let p = NSOpenPanel()
    p.allowedContentTypes = [UTType.mp3, .mpeg4Audio, .wav, .aiff] + [UTType(filenameExtension: "m4a"), UTType(filenameExtension: "aif")].compactMap { $0 }
    p.allowsMultipleSelection = false; p.canChooseDirectories = false
    p.prompt = "Use this sound"; p.message = "Pick a sound for this reminder. It stays on this Mac."
    if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    p.begin { [weak self] r in
      guard let self else { return }
      guard r == .OK, let url = p.url else { self.sendOwn(); return }
      let dir = self.soundDir, wav = self.ownURL(id), meta = self.metaURL(id)
      self.q.async {
        let why = SleepSound.makeSound(from: url, dir: dir, wav: wav, meta: meta)
        psLog(why == nil ? "PS reminders: own sound kept" : "PS reminders: own sound not taken (\(why!))")
        DispatchQueue.main.async { self.sendOwn(error: why, id: id) }
      }
    }
  }

  // ---------- self test helpers ----------
  func cardVisible(_ id: String) -> Bool { cards[id]?.panel.isVisible == true }
  func keyRequested(_ id: String) -> Bool { cards[id]?.panel.keyable == true }
  func boxOpen(_ id: String) -> Bool { cards[id]?.boxOpen == true }
  func web(_ id: String) -> WKWebView? { cards[id]?.web }
  func setMeetingForTest(_ on: Bool) { meeting = on }
  /// As after a restart: forget the cards in memory and read everything back from the store.
  func reloadForTest() { for id in Array(cards.keys) { cards[id]?.panel.orderOut(nil); cards[id] = nil }; up = []; load() }

  // The card: the same family as the other PS cards (dark glass, its accent), its words as plain text. Colours come
  // in as CSS custom properties; motion is transform and opacity only.
  private static let page = #"""
  <!doctype html><html><head><meta charset="utf-8"><style>
  :root{--bg:#28121e;--acc:#ec4e86;--ink:#fff;--sub:#e8dde3;--lift:#fff;--glow:22%;--pill:#f5a2c0;--btn:13%;--on:#fff;--field:rgba(0,0,0,.28);--ph:#c9bcc3;--hint:#fca5a5}
  html,body{margin:0;background:transparent;overflow:hidden;color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;cursor:default}
  #card{margin:8px;border-radius:22px;padding:18px 20px 18px;box-sizing:border-box;position:relative;overflow:hidden;
    background:radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--acc) var(--glow),transparent),transparent 60%),linear-gradient(165deg,color-mix(in srgb,var(--bg) 92%,var(--lift) 8%),var(--bg) 70%);
    border:1.5px solid color-mix(in srgb,var(--acc) 60%,transparent);box-shadow:0 18px 44px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.25);transition:opacity .18s ease,transform .18s ease}
  body.in #card{animation:pop .5s cubic-bezier(.22,1,.36,1) both}
  body.out #card{opacity:0;transform:translateY(-8px) scale(.98)}
  @keyframes pop{from{transform:translateY(-10px) scale(.97);opacity:.2}}
  #card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--acc),color-mix(in srgb,var(--acc) 50%,#fff),var(--acc));background-size:200% 100%;animation:stripe 4s linear infinite}
  @keyframes stripe{to{background-position:-200% 0}}
  .pill{display:inline-flex;align-items:center;gap:7px;padding:3px 10px;border-radius:99px;font-size:10.5px;font-weight:850;letter-spacing:.14em;text-transform:uppercase;background:color-mix(in srgb,var(--acc) 18%,transparent);color:var(--pill)}
  .pill i{width:7px;height:7px;border-radius:50%;background:var(--acc);box-shadow:0 0 8px var(--acc);animation:pulse 1.4s ease-in-out infinite}
  .pill em{font-style:normal;opacity:.7}
  @keyframes pulse{50%{opacity:.3}}
  h1{margin:10px 0 14px;font-size:21px;font-weight:850;letter-spacing:.01em;line-height:1.2;overflow-wrap:anywhere}
  .row{display:flex;gap:9px;flex-wrap:wrap}
  button{border:0;border-radius:99px;padding:9px 16px;font:700 13px -apple-system,sans-serif;color:var(--ink);background:color-mix(in srgb,var(--ink) var(--btn),transparent);cursor:pointer;transition:background .2s,transform .1s}
  button:active{transform:scale(.97)}
  button.main{color:var(--on);background:linear-gradient(180deg,color-mix(in srgb,var(--acc) 80%,#fff),color-mix(in srgb,var(--acc) 85%,#000));box-shadow:0 8px 20px color-mix(in srgb,var(--acc) 35%,transparent)}
  #ch{display:none;flex-direction:column;gap:8px}
  body.multi #ch{display:flex}
  body.multi #later,body.multi #open,body.multi #yes,body.multi .row{display:none}
  body.multi.box #ch{display:none}
  #ch button{width:100%;text-align:left;border-radius:14px;padding:11px 16px}
  #ch button.first{color:var(--on);background:linear-gradient(180deg,color-mix(in srgb,var(--acc) 80%,#fff),color-mix(in srgb,var(--acc) 85%,#000));box-shadow:0 8px 20px color-mix(in srgb,var(--acc) 35%,transparent)}
  #x{display:none;position:absolute;top:12px;right:12px;width:26px;height:26px;padding:0;border-radius:50%;font-size:15px;line-height:26px;text-align:center}
  body.multi #x{display:block}
  #box{display:none;margin-top:14px}
  body.box #box{display:block;animation:fade .25s ease both}
  body.box #yes{display:none}
  @keyframes fade{from{opacity:0}}
  #box label{display:block;font-size:12px;color:var(--sub);margin-bottom:7px}
  .in2{display:flex;gap:8px}
  #t{flex:1;min-width:0;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--acc) 45%,transparent);background:var(--field);color:var(--ink);border-radius:12px;padding:9px 12px;font:600 14px -apple-system,sans-serif;outline:none;-webkit-user-select:text;cursor:text}
  #t:focus{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 22%,transparent)}
  #t::placeholder{color:var(--ph)}
  #hint{min-height:16px;margin:6px 0 0;font-size:12px;color:var(--hint);opacity:0;transition:opacity .2s}
  body.wrong #hint{opacity:1}
  body.wrong #t{animation:shake .35s}
  @keyframes shake{25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}
  @media (prefers-reduced-motion:reduce){body.in #card,#card::before,.pill i,body.wrong #t{animation:none}}
  </style></head><body>
  <div id="card">
    <span class="pill"><i></i><span id="p"></span><em id="tt"></em></span>
    <button id="x" type="button" aria-label="Close (Esc)">&times;</button>
    <h1 id="q"></h1>
    <div id="ch"></div>
    <div class="row"><button id="later" type="button"></button><button id="open" type="button" hidden></button><button id="yes" class="main" type="button"></button></div>
    <div id="box">
      <label id="lb"></label>
      <div class="in2"><input id="t" type="text" autocomplete="off" spellcheck="false"><button id="done" class="main" type="button">Done</button></div>
      <p id="hint"></p>
    </div>
  </div>
  <script>
  const post = (m) => { try { window.webkit.messageHandlers.fu.postMessage(JSON.stringify(m)); } catch (e) {} };
  const $ = (id) => document.getElementById(id);
  const size = () => post({ type: 'size', h: $('card').offsetHeight + 16 });
  // >>> rem look
  // V1.58 (the developer: "when you choose the white coloured theme ... the text almost becomes invisible"): every colour on the
  // card is worked out here from its background and accent, at the moment it is drawn, with the same numbers as
  // web core/remind.ts remLook. The words read at 4.5 to 1 on any background (tests/remind-look-test.mjs).
  const Look = (() => {
    const W = '#ffffff', D = '#17121a', K = '#000000', AA = 4.5, BTN = 3;
    const ok = (h, d) => (typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h) ? h.toLowerCase() : d);
    const rgb = (h) => { const n = parseInt(ok(h, K).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    const luma = (h) => {
      const f = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      const [r, g, b] = rgb(h); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const con = (a, b) => { const x = luma(a), y = luma(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const mix = (a, b, t) => { const p = rgb(a), q = rgb(b); return '#' + p.map((v, i) => Math.round(v * t + q[i] * (1 - t)).toString(16).padStart(2, '0')).join(''); };
    const ink = (bg) => {
      const w = con(W, bg), d = con(D, bg);
      if (Math.max(w, d) >= AA) return w > d ? W : D;
      return con(K, bg) > w ? K : W;
    };
    const minC = (c, tones) => Math.min(...tones.map((t) => con(c, t)));
    const soft = (c, base, tones, from) => {
      for (let i = Math.round(from * 100); i < 100; i += 5) { const x = mix(c, base, i / 100); if (minC(x, tones) >= AA) return x; }
      return c;
    };
    const onAcc = (tone, acc, first, min) => {
      if (con(first, tone) >= min) return first;
      for (const s of [0.4, 0.3, 0.2, 0.1]) { const x = mix(acc, K, s); if (con(x, tone) >= AA) return x; }
      return con(K, tone) >= con(W, tone) ? K : W;
    };
    const look = (bgIn, accIn) => {
      const bg = ok(bgIn, '#28121e'), acc = ok(accIn, '#ec4e86');
      const i = ink(bg);
      const lift = i === W && con(W, mix(W, bg, 0.08)) < AA ? bg : W;
      const top = mix(lift, bg, 0.08);
      const glow = [22, 14, 8, 0].find((g) => con(i, mix(acc, top, g / 100)) >= AA) ?? 0;
      const pillBg = mix(acc, mix(acc, top, glow / 100), 0.18);
      const pillA = [55, 45, 35, 25, 15, 0].find((a) => con(mix(acc, i, a / 100), pillBg) >= AA) ?? 0;
      const btn = [13, 10, 7, 4, 0].find((p) => minC(i, [mix(i, bg, p / 100), mix(i, top, p / 100)]) >= AA) ?? 0;
      const mainTone = mix(mix(acc, W, 0.8), mix(acc, K, 0.85), 0.5);
      const dark = i !== W;
      const fieldTone = dark ? mix(W, bg, 0.5) : mix(K, bg, 0.28);
      const red = dark ? '#b42318' : '#fca5a5';
      return { bg, acc, ink: i, sub: soft(i, bg, [bg, top], 0.7), lift, top, glow, pill: mix(acc, i, pillA / 100), pillBg, btn,
        on: onAcc(mainTone, acc, W, BTN), mainTone, field: dark ? 'rgba(255,255,255,.5)' : 'rgba(0,0,0,.28)', fieldTone,
        ph: soft(i, fieldTone, [fieldTone], 0.6), hint: minC(red, [bg, top]) >= AA ? red : i };
    };
    return { look, con, mix, ink };
  })();
  // <<< rem look
  let click = false;
  window.__fu = {
    set(o, fresh) {
      const r = document.documentElement.style;
      const L = Look.look(o.bg, o.accent);
      const v = { '--bg': L.bg, '--acc': L.acc, '--ink': L.ink, '--sub': L.sub, '--lift': L.lift, '--glow': L.glow + '%', '--pill': L.pill,
        '--btn': L.btn + '%', '--on': L.on, '--field': L.field, '--ph': L.ph, '--hint': L.hint };
      for (const k in v) r.setProperty(k, v[k]);
      $('p').textContent = o.pill; $('tt').textContent = o.test ? ' · test' : '';
      $('q').textContent = o.text; $('later').textContent = o.later; $('yes').textContent = o.yes;
      $('open').textContent = o.open || ''; $('open').hidden = !o.open;
      $('later').hidden = !!o.one;   // PS 1.73: the Priority 1 alarm has one button
      $('done').textContent = o.one ? o.yes : 'Done';   // and its box's confirm button keeps its words (I acknowledge): it works only with the word typed
      const many = Array.isArray(o.choices) && o.choices.length > 0;
      document.body.classList.toggle('multi', many);
      const ch = $('ch'); ch.textContent = '';
      if (many) o.choices.forEach((w, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = w; if (i === 0) b.className = 'first';
        b.addEventListener('click', () => {
          if (i === o.sure) { document.body.classList.add('box'); size(); post({ type: 'box', open: true }); } else post({ type: 'choice', i });
        });
        ch.appendChild(b);
      });
      $('lb').textContent = o.ask || ('Type ' + o.word + ' and press Enter to confirm');
      $('t').placeholder = 'Type ' + o.word; $('hint').textContent = 'Only ' + o.word + ' closes this.';
      click = !!o.click;
      if (fresh) { document.body.classList.remove('box', 'wrong', 'in', 'out'); $('t').value = ''; void document.body.offsetWidth; document.body.classList.add('in'); }
      size();
    },
    focus() { setTimeout(() => $('t').focus(), 40); },
    wrong() { document.body.classList.remove('wrong'); void document.body.offsetWidth; document.body.classList.add('wrong'); $('t').select(); },
    unbox() { document.body.classList.remove('box', 'wrong'); $('t').value = ''; size(); },
    out() { document.body.classList.add('out'); },
  };
  $('x').addEventListener('click', () => post({ type: 'close' }));
  $('later').addEventListener('click', () => post({ type: 'snooze' }));
  $('open').addEventListener('click', () => post({ type: 'open' }));
  $('yes').addEventListener('click', () => {
    if (click) { post({ type: 'confirm', text: '' }); return; }
    document.body.classList.add('box'); size(); post({ type: 'box', open: true });
  });
  $('done').addEventListener('click', () => post({ type: 'confirm', text: $('t').value }));
  $('t').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); post({ type: 'confirm', text: $('t').value }); }
    else if (e.key === 'Escape') { window.__fu.unbox(); post({ type: 'box', open: false }); }
  });
  </script></body></html>
  """#
}
