import AppKit
import Darwin
import Network

// Second Computer remote screen (PS 1.69, part 1): full control of the second Mac from the main Mac, like TeamViewer, directly
// over the home network or a cable, with the lowest delay possible (the developer's ask, 19 Nov 2026).
//
// The coordinator and the API part 2 builds on (the hold key, the Tab overlay switch, the Dock app with auto connect, the right
// click menu and the link animations):
//   RemoteScreen.shared.connect()            // main Mac: find the second Mac, prove who we are, start the picture
//   RemoteScreen.shared.disconnect()
//   RemoteScreen.shared.state                // .off, .idle, .searching, .connecting, .notOnNetwork, .refused, .needsPermission, .live, .ended
//   RemoteScreen.shared.observe { state in } // every change, main thread
//   RemoteScreen.shared.window               // RSWindowController: show(), hide(), toggleFullScreen(), view.keyHook, view.inputOn
//   RemoteScreen.shared.command("lock") { ok, why in }   // lock, restart, shutdown over the live link (Sentry mode: part 2 adds it)
//   RemoteScreen.shared.numbers              // the last latency line (numbers only)
// On the second Mac it runs by itself: it listens while it is the secondary with a paired primary and the feature is on.
//
// Who may use it: everyone with Second Computer on AND the remote screen's own switch on (Settings, Second Computer, Remote
// screen: feature "remote-screen" in core's features.json, off by default like Second Computer itself). Its settings (Picture,
// Delay numbers) come from the page (screenPrefs, src/screenprefs.ts). Nothing here changes any network, firewall or VPN setting.
//
// The relay is attempted automatically if the direct link fails.

final class RemoteScreen {
  static let shared = RemoteScreen()

  enum State: Equatable {
    case off                     // not allowed here, or Second Computer is off
    case idle                    // ready (main Mac: not connected; second Mac: listening)
    case searching               // looking for the second Mac on this network
    case connecting              // found it, proving who we are
    case notOnNetwork(String)     // both paths failed; show the reason the user can act on
    case refused(String)         // it answered nothing (not paired with this Mac any more) or did not check out
    case needsPermission(screen: Bool, access: Bool)   // what the second Mac still needs allowed (true = allowed)
    case live(link: String)      // picture and control; link: "cable", "Wi-Fi", "Ethernet", "this Mac", "relay"
    case ended(String)
  }

  /// The state in plain words (the CLI's `second.ts screen status`, the log).
  var stateName: String {
    switch state {
    case .off: return "off"
    case .idle: return Second.shared.role == "secondary" ? "ready, waiting for the main Mac" : "not connected"
    case .searching: return "looking for the second Mac"
    case .connecting: return "connecting through the relay"
    case .notOnNetwork(let reason): return reason
    case .refused(let w): return "refused (\(w))"
    case .needsPermission(let s, let a): return "needs \(s ? "" : "Screen Recording")\(!s && !a ? " and " : "")\(a ? "" : "Accessibility") allowed on the second Mac"
    case .live(let k): return "live over \(k)"
    case .ended(let w): return "ended (\(w))"
    }
  }

  private(set) var state: State = .off { didSet { if state != oldValue { for o in observers { o(state) }; sendState() } } }

  /// The pages (main.swift): window.__psRemoteScreen({on, live, open, state}) for the Tab list's Remote screen switch.
  var deliver: ((String) -> Void)?
  func sendState() {
    var live = false; if case .live = state { live = true }
    let o: [String: Any] = ["on": allowed && Second.shared.role == "primary", "live": live, "open": window.isVisible, "state": stateName]
    guard let d = try? JSONSerialization.data(withJSONObject: o), let j = String(data: d, encoding: .utf8) else { return }
    deliver?("window.__psRemoteScreen && window.__psRemoteScreen(\(j))")
  }

  /// The Tab list's switch: open (and connect) when it is not showing, close it when it is.
  func toggle() {
    if window.isVisible { window.window?.performClose(nil) } else { connect() }
  }
  private var observers: [(State) -> Void] = []
  /// Every change of state, on the main thread (part 2's animations and the Dock app).
  func observe(_ f: @escaping (State) -> Void) { observers.append(f) }

  let q = DispatchQueue(label: "ps.screen.net", qos: .userInteractive)
  private(set) lazy var window: RSWindowController = {
    let w = RSWindowController()
    w.onClose = { [weak self] in self?.disconnect() }
    w.view.send = { [weak self] i in self?.link?.send(.input, i.encode()) }
    w.view.onPress = { [weak self] in if self?.peeking == true { self?.pinned = true } }   // clicked while held: it stays
    w.onKeyChange = { [weak self] in self?.armHold(); self?.sendState() }
    w.onCommand = { [weak self] a in self?.menuCommand(a) }
    w.onDockApp = { RSDockApp.shared.install() }
    return w
  }()

  static let feature = "remote-screen"
  // Its settings, from the page (Settings, Second Computer, Remote screen), kept here so they hold before the vault opens.
  private let d = UserDefaults.standard
  /// The widest picture in pixels. Picture: Sharp 2560 (the second Mac's own pixels), Faster 1920 (about 5 ms quicker in the
  /// tests), Fastest 1280 (soft text).
  var maxWidth: Int { RemoteScreen.width(d.string(forKey: "screen.picture")) }
  static func width(_ picture: String?) -> Int { picture == "fastest" ? 1280 : picture == "faster" ? 1920 : 2560 }
  /// H.264: about the same delay as HEVC in the tests and a little quicker at small sizes.
  let codec: RSCodec = .h264
  /// Delay numbers: the small numbers line in the window's corner.
  var showNumbers: Bool { d.bool(forKey: "screen.numbers") }

  /// Hold key: "section" (§, the default), "grave", "f13" to "f16", or "off" (RSHoldKeys).
  var holdKey: String { d.string(forKey: "screen.hold") ?? RSHoldKeys.defaultId }

  /// The page's settings ({type: "screenPrefs", picture: "sharp" | "faster" | "fastest", numbers: bool, hold: key id}). Main thread.
  func setPrefs(_ msg: [String: Any]) {
    if let p = msg["picture"] as? String, ["sharp", "faster", "fastest"].contains(p) { d.set(p, forKey: "screen.picture") }
    if let n = msg["numbers"] as? Bool { d.set(n, forKey: "screen.numbers"); window.showsNumbers = n }
    if let h = msg["hold"] as? String, h == "off" || RSHoldKeys.all.contains(where: { $0.id == h }) { d.set(h, forKey: "screen.hold") }
    armHold()
  }

  private var relayCredentialRequests: [String: (Result<RSTurnCreds, RSRelayCredentialsError>) -> Void] = [:]

  private func newSignal() -> RSVaultRelaySignal {
    RSVaultRelaySignal { message in
      DispatchQueue.main.async { Second.shared.sendScreenRelay(["type": "screenRelay:send", "signal": message]) }
    }
  }

  private func credentials(done: @escaping (Result<RSTurnCreds, RSRelayCredentialsError>) -> Void) {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.allowed, Second.shared.vaultIsUnlocked else { done(.failure(.signIn)); return }
      let req = UUID().uuidString
      self.relayCredentialRequests[req] = done
      Second.shared.sendScreenRelay(["type": "screenRelay:creds", "req": req, "role": Second.shared.role])
      DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in
        self?.relayCredentialRequests.removeValue(forKey: req)?(.failure(.network))
      }
    }
  }

  func receiveRelay(_ message: [String: Any]) {
    guard allowed, Second.shared.vaultIsUnlocked else { return }
    switch message["type"] as? String {
    case "screenRelay:signal":
      guard let signal = message["signal"] as? [String: Any], SecondEnv(signal["env"]) != nil,
            signal["to"] as? String == Second.shared.role else { return }
      let receiver = Second.shared.role == "primary" ? relaySignal : answerSignal
      q.async { receiver?.onMessage(signal) }
    case "screenRelay:creds":
      guard let req = message["req"] as? String, let done = relayCredentialRequests.removeValue(forKey: req) else { return }
      if let creds = message["creds"], let data = try? JSONSerialization.data(withJSONObject: creds), let parsed = RSTurnCreds.parse(data) {
        done(.success(parsed))
      } else {
        done(.failure(RSRelayCredentialsError(rawValue: message["error"] as? String ?? "") ?? .network))
      }
    default: break
    }
  }

  // MARK: the hold key (part 2)

  private var peeking = false, pinned = false
  private var frontBefore: NSRunningApplication?
  private var idleOff: DispatchWorkItem?

  /// Tells the keyboard tap whether a hold may open the screen now (main thread; on every change that matters).
  func armHold() {
    let id = Second.shared.identity
    let ok = allowed && Second.shared.role == "primary" && id?.peers.contains(where: { $0.role == "secondary" }) == true
    RSHoldTap.shared.set(armed: ok, code: RSHoldKeys.code(holdKey), up: window.isVisible && window.window?.isKeyWindow == true)
    if ok { RSDockApp.shared.start() }   // the Dock app's socket: only on a main Mac with the remote screen on (it stays until PS quits)
  }

  /// Held past the hold time: the second Mac's screen comes up (connecting if it is not yet). Main thread.
  private func peekShow() {
    guard allowed else { return }
    idleOff?.cancel()
    let f = NSWorkspace.shared.frontmostApplication
    frontBefore = f?.processIdentifier == getpid() ? nil : f
    peeking = true; pinned = false
    connect()
  }
  /// Let go: away again (unless it was clicked while held), and the keyboard goes back to the app that had it (never to
  /// 1Password or Signal). The link stays a while, so the next hold is instant.
  private func peekRelease() {
    guard peeking else { return }
    peeking = false
    if pinned { return }
    window.view.releaseAll()
    window.hide()
    if let f = frontBefore, !f.isTerminated, !Protected.matches(f) { f.activate() }
    frontBefore = nil
    keepAWhile()
    armHold()
  }
  /// Held while the screen is up and has the keyboard: it goes away.
  private func peekHide() {
    window.view.releaseAll()
    window.hide()
    keepAWhile()
    armHold()
  }
  /// The link stays up 2 minutes after the window went away (a quick look again is instant), then ends.
  private func keepAWhile() {
    idleOff?.cancel()
    let w = DispatchWorkItem { [weak self] in if self?.window.isVisible == false { self?.disconnect() } }
    idleOff = w
    DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: w)
  }

  // MARK: the menu (window and Dock app): Lock, Sentry mode, Shut down, Restart

  /// One of RemoteScreen.menuActions. Shut down and Restart ask once first. Over the live link when it is up, else through
  /// the vault (Second Computer's own signed command, the same as its Lock and Restart buttons).
  func menuCommand(_ a: String) {
    guard RemoteScreen.menuActions.contains(a) else { return }
    let go = { [weak self] in
      guard let self else { return }
      if self.link != nil {
        self.command(a) { ok, why in if !ok { self.toast(a, why) } }
      } else if !Second.shared.machineCmd(a) {
        self.toast(a, "Second Computer cannot send it right now (is PS unlocked and paired?)")
      }
    }
    guard a == "shutdown" || a == "restart" else { go(); return }
    let name = peerOrDefault
    let verb = a == "shutdown" ? "Shut down" : "Restart"
    SecondConfirm.shared.ask("\(verb) \(name)?", a == "shutdown"
      ? "\(name) shuts down. It stays off until someone turns it on."
      : "\(name) restarts. Remote screen and Second Computer are back once someone logs in on it.", verb) { yes in if yes { go() } }
  }
  private var peerOrDefault: String {
    Second.shared.identity?.peers.first(where: { $0.role == "secondary" })?.name ?? "your second Mac"
  }
  private func toast(_ a: String, _ why: String?) {
    let words = ["lock": "Lock", "sentry": "Sentry mode", "shutdown": "Shut down", "restart": "Restart"][a] ?? a
    Toast.shared.show(title: "\(words) did not go through", sub: nil, body: why)
  }

  /// Second Computer is on and so is the remote screen's own switch.
  var allowed: Bool { Second.shared.isOn && Features.on(RemoteScreen.feature) }

  // primary
  private var client: RSClient?
  private var link: RSLink?
  private var receiver: RSReceiver?
  private var commands: [String: (Bool, String?) -> Void] = [:]
  private var retries = 0
  private var wanted = false
  private(set) var numbers = ""
  private var peerName = "your second Mac"
  // primary, through the relay (PS 1.77)
  private var relayDial: RSRelayDial?
  private var relaySignal: RSVaultRelaySignal?
  private var attempt = 0
  // secondary
  private var answerSignal: RSVaultRelaySignal?
  private var answer: RSRelayAnswer?
  private var answerKey = ""
  private var server: RSServer?
  private var host: RSHost?
  private var serverIdentity: ObjectIdentifier?
  private var timer: Timer?

  /// At launch (main.swift), main thread.
  func start() {
    NotificationCenter.default.addObserver(forName: Second.changed, object: nil, queue: .main) { [weak self] _ in self?.refresh() }
    Features.observers.append { [weak self] in self?.refresh() }   // the switch in Settings
    timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refresh() }   // pairing changes
    Second.shared.screenHint = { [weak self] in self?.hint() }
    RSHoldTap.shared.onShow = { [weak self] in self?.peekShow() }
    RSHoldTap.shared.onHide = { [weak self] in self?.peekHide() }
    RSHoldTap.shared.onRelease = { [weak self] in self?.peekRelease() }
    RSDockApp.shared.onVerb = { [weak self] v in self?.dockVerb(v) }
    refresh()
  }

  /// The Dock app asked (RemoteScreenDock.swift): open the screen and connect, or one of the four commands.
  private func dockVerb(_ v: String) {
    if v == "open" { connect(); return }
    menuCommand(v)
  }

  /// Starts or stops the second Mac's listener to match the role, the pairing and the switch. Main thread.
  func refresh() {
    defer { armHold(); sendState() }
    guard allowed, let id = Second.shared.identity else {
      stopServer()
      if wanted || link != nil { disconnect(); window.hide() }   // switched off while open: it ends at once
      state = .off
      return
    }
    if Second.shared.role == "secondary", let primary = id.peers.first(where: { $0.role == "primary" }) {
      if server == nil || serverIdentity != ObjectIdentifier(id) { startServer(id) }
      refreshAnswer(id, primary: primary)
    } else {
      stopServer()
      if case .off = state { state = .idle }
    }
  }

  // MARK: the second Mac

  /// Answer signed offers from the paired primary via the existing vault bridge.
  private func refreshAnswer(_ id: SecondIdentity, primary: SecondPeer) {
    let key = "\(primary.device) \(ObjectIdentifier(id).hashValue)"
    guard key != answerKey, let server else { return }
    answerKey = key
    answer?.stop()
    let signal = newSignal()
    let responder = RSRelayAnswer(identity: id, server: server, signal: signal, q: q)
    responder.credentials = { [weak self] done in
      guard let self else { done(.failure(.signIn)); return }
      self.credentials(done: done)
    }
    responder.log = { psLog($0) }
    answerSignal = signal
    answer = responder
  }

  private func startServer(_ id: SecondIdentity) {
    stopServer()
    let s = RSServer(identity: id, q: q)
    s.log = { psLog($0) }
    s.app = Second.appVersion
    s.onSession = { [weak self] l in
      // On the link's queue. A new session ends the old one (the primary reconnected).
      let h = RSHost(link: l, q: self?.q ?? DispatchQueue.main)
      // Through the relay: 1920 at most (and 8 Mbps, RSSender), so a busy month stays inside the relay's free data.
      h.maxWidth = RSRelayRules.width(self?.maxWidth ?? 2560, relayed: l.relayed); h.codec = self?.codec ?? .h264; h.udpPort = l.relayed ? nil : s.udpPort
      h.runCommand = { a, id, from, done in
        guard let run = Second.shared.cmdRunner else { done(false, "Not set up on this Mac"); return }
        run(a, id, from, RSTime.nowMs, done)
      }
      l.onClose = { [weak self, weak h] why in DispatchQueue.main.async { psLog("PS screen: the session ended (\(why))"); h?.stop(); if self?.host === h { self?.host = nil; self?.state = .idle } } }
      DispatchQueue.main.async {
        guard let self else { return }
        self.host?.stop()
        self.host = h
        psLog("PS screen: \(l.peer.role) connected over \(l.kindName), this Mac is being viewed")
        self.state = .live(link: l.kindName)
        h.start()
      }
    }
    server = s; serverIdentity = ObjectIdentifier(id)
    s.start { ok in DispatchQueue.main.async { psLog(ok ? "PS screen: ready for the main Mac" : "PS screen: could not get ready") } }
    state = .idle
  }

  private func stopServer() {
    answerSignal = nil; answer?.stop(); answer = nil; answerKey = ""
    guard server != nil || host != nil else { return }
    host?.stop(); host = nil
    let s = server; server = nil; serverIdentity = nil
    q.async { s?.stop() }
  }

  /// The secondary's addresses for the heartbeat (a second way to find it when Bonjour cannot get through).
  private func hint() -> [String: Any]? {
    guard let s = server, let port = s.tcpPort else { return nil }
    return ["port": Int(port), "ips": RSLinkKind.localAddresses()]
  }

  // MARK: the main Mac

  /// Finds the second Mac and starts the picture. Main thread. The window opens with "Looking for..." at once.
  func connect() {
    guard !Protected.front else { return }
    guard allowed, let id = Second.shared.identity else {
      state = .off
      window.say(Second.shared.isOn ? "Turn Remote screen on in Settings, Second Computer." : "Turn Second Computer on in Settings first.")
      window.show(); return
    }
    guard Second.shared.role == "primary", let peer = id.peers.first(where: { $0.role == "secondary" }) else {
      state = .off; window.say("Pair your second Mac first (Second Computer)."); window.show(); return
    }
    if link != nil || client != nil || relayDial != nil {
      if !window.isVisible { window.show() }
      return
    }
    wanted = true
    attempt += 1
    let current = attempt
    peerName = peer.name
    state = .searching
    window.say("Looking for \(peer.name)...", linking: true)
    window.window?.title = peer.name
    window.showsNumbers = showNumbers
    if !window.isVisible { window.show() }
    var hints: [NWEndpoint] = []
    if let h = Second.shared.peerScreen, let port = (h["port"] as? NSNumber)?.uint16Value, let p = NWEndpoint.Port(rawValue: port) {
      for ip in (h["ips"] as? [String] ?? []).prefix(6) { let e = NWEndpoint.hostPort(host: NWEndpoint.Host(ip), port: p); if RSNet.isLocal(e) { hints.append(e) } }
    }
    let direct = RSClient(identity: id, secondary: peer, q: q)
    direct.log = { psLog($0) }
    direct.app = Second.appVersion
    client = direct
    q.async { [weak self] in
      direct.connect(hints: hints, timeout: 2) { result in
        DispatchQueue.main.async {
          guard let self, self.attempt == current, self.wanted else {
            if case .success(let link) = result { link.close("not needed") }
            return
          }
          self.client = nil
          switch result {
          case .success: self.connected(result)
          case .failure: self.startRelay(id, peer, attempt: current)
          }
        }
      }
    }
  }

  private func startRelay(_ id: SecondIdentity, _ peer: SecondPeer, attempt current: Int) {
    guard current == attempt, wanted, link == nil, relayDial == nil else { return }
    state = .connecting
    window.say("Connecting to \(peerName) through the relay...", linking: true)
    let signal = newSignal()
    relaySignal = signal
    let dial = RSRelayDial(identity: id, secondary: peer, q: q, signal: signal, credentials: { [weak self] done in
      guard let self else { done(.failure(.signIn)); return }
      self.credentials(done: done)
    })
    dial.log = { psLog($0) }
    dial.app = Second.appVersion
    relayDial = dial
    dial.start { [weak self] result in
      DispatchQueue.main.async {
        guard let self, self.attempt == current, self.wanted else {
          if case .success(let link) = result { link.close("not needed") }
          return
        }
        self.relayDial = nil
        self.relaySignal = nil
        self.connected(result)
      }
    }
  }

  private func stopDialling() {
    attempt += 1
    if let direct = client { q.async { direct.cancel() } }
    client = nil
    relayDial?.cancel(); relayDial = nil
    relaySignal = nil
  }

  private func connected(_ r: Result<RSLink, RSClient.Fail>) {
    client = nil
    guard wanted else { if case .success(let l) = r { l.close("not wanted") }; return }
    switch r {
    case .failure(.notFound):
      cannotConnect("Could not reach \(peerName). Check that it is awake and signed in to PS.")
    case .failure(.network(let reason)):
      switch RSRelayCredentialsError(rawValue: reason) {
      case .setup: cannotConnect("The remote screen relay still needs to be set up.")
      case .signIn: cannotConnect("Unlock your PS vault on this Mac and try again.")
      default: cannotConnect("The remote screen relay is unavailable. Try again in a moment.")
      }
    case .failure(.refused(let why)):
      state = .refused(why)
      psLog("PS screen: the second Mac did not accept this Mac (\(why))")
      window.say("\(peerName) did not accept this Mac. Check that both Macs are still paired in Second Computer.", button: "Try again") { [weak self] in self?.connect() }
    case .success(let l):
      retries = 0
      link = l
      let rc = RSReceiver(link: l, q: q)
      rc.log = { psLog($0) }
      rc.onNumbers = { [weak self] s in DispatchQueue.main.async { self?.numbers = s; self?.window.setNumbers(s) } }
      let view = window.view
      var first = true
      rc.onImage = { [weak rc, weak self, weak l] pb, f in
        view.show(pb); rc?.shown(f)
        if first { first = false; DispatchQueue.main.async { if let self, let l, self.link === l {
            self.window.linked()
            if self.window.window?.subtitle.isEmpty == true { self.window.via = l.relayed ? .relay : .direct }
          } } }   // the connect moment: the link lights up, the picture shows
      }
      receiver = rc
      l.onUdp = { [weak rc] b in rc?.udp(b) }
      l.onCtl = { [weak self, weak rc] t, d in
        guard let self, let rc else { return }
        if rc.handle(t, d) { return }
        self.ctl(t, d, link: l, rc: rc)
      }
      l.onClose = { [weak self] why in DispatchQueue.main.async { self?.lost(l, why) } }
      state = .live(link: l.kindName)
      psLog("PS screen: connected over \(l.kindName)")
      window.say(l.relayed ? "Connecting to \(peerName) through the relay..." : "Connecting to \(peerName)...", linking: true)
      q.async { l.start(); rc.start() }
    }
  }

  private func cannotConnect(_ reason: String) {
    state = .notOnNetwork(reason)
    window.say(reason, button: "Try again") { [weak self] in self?.connect() }
  }

  /// Control messages from the second Mac (the link's queue).
  private func ctl(_ t: RSCtl, _ d: Data, link l: RSLink, rc: RSReceiver) {
    switch t {
    case .screen:
      guard let i = try? JSONDecoder().decode(RSScreenInfo.self, from: d), (2...8192).contains(i.w), (2...8192).contains(i.h) else { return }
      rc.configure(i)
      if let u = i.udp, let p = UInt16(exactly: u), !l.udpReady { RSClient.openUDP(for: l, port: p, q: q, loopback: false) }
      DispatchQueue.main.async { [weak self] in self?.window.say(nil, linking: self?.window.link.isHidden == false); self?.window.view.info = i }
    case .cursor:
      var r = RSReader(d)
      guard let hx = r.f32(), let hy = r.f32(), let w = r.f32(), let h = r.f32(), [hx, hy, w, h].allSatisfy({ $0.isFinite && $0 >= 0 && $0 < 1024 }) else { return }
      let png = r.rest()
      DispatchQueue.main.async { [weak self] in self?.window.view.setCursor(png: png, hot: CGPoint(x: CGFloat(hx), y: CGFloat(hy)), size: CGSize(width: CGFloat(w), height: CGFloat(h))) }
    case .state:
      guard let s = try? JSONDecoder().decode(RSState.self, from: d) else { return }
      DispatchQueue.main.async { [weak self] in self?.secondState(s, link: l) }
    case .commandDone:
      guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let id = o["id"] as? String else { return }
      let ok = o["ok"] as? Bool ?? false, why = o["why"] as? String
      DispatchQueue.main.async { [weak self] in self?.commands.removeValue(forKey: id)?(ok, why) }
    case .bye: l.close("the second Mac ended it")
    default: break
    }
  }

  private func secondState(_ s: RSState, link l: RSLink) {
    guard link === l else { return }
    if !s.screen {
      window.via = nil
      state = .needsPermission(screen: false, access: s.access)
      window.say("Allow PS on \(peerName) in System Settings, under Screen & System Audio Recording. It asks once, on \(peerName).", button: "Open it on \(peerName)") {
        l.send(.openSettings, Data("{\"pane\":\"screen\"}".utf8))
      }
      return
    }
    if case .needsPermission = state { state = .live(link: l.kindName); window.say(nil) }
    if !s.access {
      state = .needsPermission(screen: true, access: false)
      window.window?.subtitle = "Viewing only. Allow PS under Accessibility on \(peerName) to control it."
    } else if s.guarded {
      window.window?.subtitle = "Remote input paused while a protected app is in front."
    } else if window.view.info != nil, window.link.isHidden {
      window.via = l.relayed ? .relay : .direct
    }
  }

  private func lost(_ l: RSLink, _ why: String) {
    guard link === l else { return }
    link = nil; receiver?.stop(); receiver = nil
    window.via = nil
    for (_, f) in commands { f(false, "The link ended") }; commands = [:]
    psLog("PS screen: the link ended (\(why))")
    guard wanted else { state = .idle; return }
    // A short drop (Wi-Fi roaming, sleep): try again quietly a few times while the window is open.
    if retries < 3 && window.isVisible {
      retries += 1
      state = .searching
      window.say("Reconnecting to \(peerName)...", linking: true)
      DispatchQueue.main.asyncAfter(deadline: .now() + Double(retries)) { [weak self] in if self?.wanted == true && self?.link == nil { self?.connect() } }
      return
    }
    state = .ended(why)
    window.say("The link to \(peerName) ended.", button: "Connect again") { [weak self] in self?.retries = 0; self?.connect() }
  }

  /// Ends the session (the window closed, or part 2's switch). Main thread.
  func disconnect() {
    wanted = false
    stopDialling()
    window.via = nil
    let l = link; link = nil
    receiver?.stop(); receiver = nil
    window.view.releaseAll()
    q.async { l?.bye() }
    window.view.clear()
    for (_, f) in commands { f(false, "Disconnected") }; commands = [:]
    retries = 0
    state = allowed ? .idle : .off
  }

  /// A machine command over the live link: lock, sentry, restart or shutdown (the second Mac runs it through RemoteCommand, the same
  /// code as Second Computer's signed command). Not live: done(false, ...) at once; part 2 can fall back to the vault command.
  /// The four in the Dock app's menu and the window's menu, in this order (exactly these four, chosen 18 Nov 2026).
  static let menuActions = ["lock", "sentry", "shutdown", "restart"]

  func command(_ action: String, done: @escaping (Bool, String?) -> Void) {
    guard RemoteScreen.menuActions.contains(action) else { done(false, "Unknown command"); return }
    guard let l = link else { done(false, "Not connected"); return }
    let id = UUID().uuidString.lowercased()
    commands[id] = done
    if let d = try? JSONSerialization.data(withJSONObject: ["id": id, "action": action]) { l.send(.command, d) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in self?.commands.removeValue(forKey: id)?(false, "No answer") }
  }

  /// PS is quitting: the session ends cleanly (keys up on the second Mac).
  func quit() { if link != nil { disconnect() }; stopServer() }
}
