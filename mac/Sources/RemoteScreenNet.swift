import CryptoKit
import Darwin
import Foundation
import Network

// Second Computer remote screen: the direct link (Network.framework). Same Wi-Fi, Ethernet or a Thunderbolt or USB-C cable
// (Thunderbolt Bridge); the direct listener never takes a call from the internet. (PS 1.77: when the direct link cannot be made,
// the same link runs through a relay both Macs dial out to, RemoteScreenRelay.swift; the listener here stays local only.) The secondary listens only while it is a secondary
// with a paired primary and the feature is on; it advertises a name only a paired primary can recognise (RSName), accepts only
// local addresses, and answers nothing until a signed hello from its paired primary checks out (RSHandshake). The primary looks
// for exactly that name, tries the cable first when there is one, then any local path.

enum RSNet {
  /// Local addresses only: the link is Mac to Mac on this network (or the cable), never from the internet.
  static func isLocal(_ e: NWEndpoint) -> Bool {
    guard case let .hostPort(host, _) = e else { return false }
    switch host {
    case .ipv4(let a):
      let b = [UInt8](a.rawValue)
      guard b.count == 4 else { return false }
      return b[0] == 10 || b[0] == 127 || (b[0] == 172 && (16...31).contains(b[1])) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254)
    case .ipv6(let a):
      if a.isLoopback || a.isLinkLocal { return true }
      let b = [UInt8](a.rawValue)
      if b.count == 16, b[0] & 0xfe == 0xfc { return true }   // fc00::/7 unique local
      if let v4 = a.asIPv4 { return isLocal(.hostPort(host: .ipv4(v4), port: 1)) }
      return false
    case .name: return false
    @unknown default: return false
    }
  }

  static func tcpParams(loopback: Bool, avoidWifi: Bool = false) -> NWParameters {
    let t = NWProtocolTCP.Options()
    t.noDelay = true                // every input event goes at once
    t.connectionTimeout = 3
    t.enableKeepalive = true; t.keepaliveIdle = 2; t.keepaliveInterval = 1; t.keepaliveCount = 3
    let p = NWParameters(tls: nil, tcp: t)
    p.serviceClass = .responsiveData
    p.includePeerToPeer = false
    if loopback { p.requiredInterfaceType = .loopback }
    if avoidWifi { p.prohibitedInterfaceTypes = [.wifi, .cellular] }
    return p
  }
  static func udpParams(loopback: Bool) -> NWParameters {
    let p = NWParameters.udp
    p.serviceClass = .interactiveVideo   // Wi-Fi's video queue (WMM): ahead of downloads
    p.includePeerToPeer = false
    if loopback { p.requiredInterfaceType = .loopback }
    return p
  }

  /// Reads whole frames from a connection into `buf` until `want` frames are there or the time is up.
  static func readFrames(_ c: RSStream, buf: Data, max: Int, timeout: Double, q: DispatchQueue, done: @escaping (Data?, Data) -> Void) {
    var b = buf, finished = false
    let deadline = DispatchWorkItem { if !finished { finished = true; done(nil, b) } }
    q.asyncAfter(deadline: .now() + timeout, execute: deadline)
    func more() {
      c.receive { data, end, err in
        guard !finished else { return }
        if let data { b.append(data) }
        guard let frames = RSFrame.take(&b, max: max) else { finished = true; deadline.cancel(); done(nil, b); return }
        if let f = frames.first {
          // Put back any frames after the first (none expected before the handshake ends).
          var rest = Data(); for x in frames.dropFirst() { rest.append(RSFrame.frame(x)) }; rest.append(b)
          finished = true; deadline.cancel(); done(f, rest); return
        }
        if end || err || b.count > max + 4 { finished = true; deadline.cancel(); done(nil, b); return }
        more()
      }
    }
    more()
  }
}

/// The link's ordered, reliable part: a TCP connection on a direct link (RSTCPStream), or RSRelayPipe through the relay.
protocol RSStream: AnyObject {
  /// The next bytes there are (any amount), or the end, or an error. One call at a time.
  func receive(_ f: @escaping (Data?, _ end: Bool, _ err: Bool) -> Void)
  /// Bytes out, in order; `done` once they left (TCP) or arrived (the relay).
  func send(_ d: Data, done: @escaping () -> Void)
  func cancel()
  /// The stream failed or closed (once).
  var onDown: ((String) -> Void)? { get set }
  /// How it goes, in plain words, for the state and the log: "Wi-Fi", "Ethernet", "cable", "this Mac", "relay".
  var kindName: String { get }
}

final class RSTCPStream: RSStream {
  let c: NWConnection
  init(_ c: NWConnection) { self.c = c }
  func receive(_ f: @escaping (Data?, Bool, Bool) -> Void) {
    c.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { data, _, end, err in f(data, end, err != nil) }
  }
  func send(_ d: Data, done: @escaping () -> Void) { c.send(content: d, completion: .contentProcessed { _ in done() }) }
  func cancel() { c.cancel() }
  var onDown: ((String) -> Void)? {
    didSet {
      let f = onDown
      c.stateUpdateHandler = { st in
        switch st {
        case .failed(let e): f?("link failed (\(RSLink.code(e)))")
        case .cancelled: f?("link closed")
        default: break
        }
      }
    }
  }
  var kindName: String { RSLinkKind.of(c) }
}

/// One live session, on either Mac. Everything after the handshake is encrypted: TCP frames with an implicit counter, UDP packets
/// with the session id and counter in front (a replay window drops repeats).
final class RSLink {
  enum Side { case primary, secondary }
  let side: Side
  let peer: SecondPeer
  let keys: RSKeys
  /// The ordered part (handshake, input, commands): TCP on a direct link, the relay's reliable stream through the relay.
  let stream: RSStream
  /// The direct link's TCP connection (nil through the relay).
  var tcp: NWConnection? { (stream as? RSTCPStream)?.c }
  private(set) var udp: NWConnection?
  /// PS 1.77: through the relay, the sealed UDP packets go out here (the relay pipe), not on a UDP connection of their own.
  private(set) var relayOut: RSDatagramOut?
  /// True when the link goes through the relay (the 8 Mbps cap and the 1920 picture then apply).
  var relayed: Bool { relayOut != nil }
  /// Video bytes per UDP packet: 1300 direct, 1100 through the relay.
  private(set) var chunk = RSPacket.chunk
  /// "Wi-Fi", "Ethernet", "cable", "this Mac" or "relay".
  var kindName: String { stream.kindName }
  private let q: DispatchQueue
  private let lock = NSLock()
  private let tcpOut: RSSealer, tcpIn: RSOpener, udpOut: RSSealer, udpIn: RSOpener
  private var buf: Data
  private var closed = false
  /// Bytes handed to TCP and not yet sent (video over TCP skips frames while this is high).
  private var tcpQueued = 0
  /// Video goes over UDP once the other side proved its UDP path.
  private(set) var udpReady = false

  var onCtl: (RSCtl, Data) -> Void = { _, _ in }
  /// Opened UDP bodies (video fragments on the primary, hellos on the secondary).
  var onUdp: (Data) -> Void = { _ in }
  var onClose: (String) -> Void = { _ in }
  /// Counters for the log and the feedback.
  private(set) var udpIn_ = 0, udpBad = 0, sentPackets = 0, sentBytes = 0

  init(side: Side, peer: SecondPeer, keys: RSKeys, stream: RSStream, leftover: Data, q: DispatchQueue) {
    self.side = side; self.peer = peer; self.keys = keys; self.stream = stream; self.q = q; buf = leftover
    let mine = side == .primary
    tcpOut = RSSealer(mine ? keys.p2sTcp : keys.s2pTcp); tcpIn = RSOpener(mine ? keys.s2pTcp : keys.p2sTcp)
    udpOut = RSSealer(mine ? keys.p2sUdp : keys.s2pUdp); udpIn = RSOpener(mine ? keys.s2pUdp : keys.p2sUdp)
  }

  func start() {
    stream.onDown = { [weak self] why in self?.close(why) }
    q.async { [weak self] in self?.drain(); self?.receive() }
  }

  /// Through the relay: the sealed packets go out through the pipe and come in from it, and the video goes that way from the
  /// start (it is the same path as the controls, so there is nothing to prove first). Before start().
  func useRelay(_ out: RSDatagramOut) {
    lock.lock(); relayOut = out; udpReady = true; chunk = RSRelayRules.chunk; lock.unlock()
  }

  private func receive() {
    stream.receive { [weak self] data, end, err in
      guard let self else { return }
      if let data { self.buf.append(data); self.drain() }
      if end || err { self.close(end ? "the other Mac closed the link" : "link error"); return }
      if !self.isClosed { self.receive() }
    }
  }

  private func drain() {
    guard let frames = RSFrame.take(&buf, max: RSFrame.maxSealed + 16) else { close("frame too big"); return }
    for f in frames {
      guard let plain = tcpIn.openTCP(f), let t = plain.first.flatMap(RSCtl.init(rawValue:)) else { close("a frame did not check out"); return }
      onCtl(t, plain.dropFirst().isEmpty ? Data() : Data(plain.dropFirst()))
    }
  }

  var isClosed: Bool { lock.lock(); defer { lock.unlock() }; return closed }

  func send(_ t: RSCtl, _ body: Data = Data()) {
    var p = Data([t.rawValue]); p.append(body)
    lock.lock()
    guard !closed, let (_, ct) = tcpOut.seal(p) else { lock.unlock(); return }
    let f = RSFrame.frame(ct)
    tcpQueued += f.count
    // Sent while the lock is held, so the frames go out in counter order.
    stream.send(f) { [weak self] in
      guard let self else { return }
      self.lock.lock(); self.tcpQueued -= f.count; self.lock.unlock()
    }
    lock.unlock()
  }
  func sendJSON<T: Encodable>(_ t: RSCtl, _ v: T) { if let d = try? JSONEncoder().encode(v) { send(t, d) } }

  /// The secondary's UDP path to the primary (from the primary's first good UDP hello), or the primary's to the secondary.
  func attachUDP(_ c: NWConnection, receive: Bool) {
    lock.lock(); let old = udp; udp = c; lock.unlock()
    if old !== c { old?.cancel() }
    if receive { receiveUDP(c) }
  }
  func setUdpReady(_ on: Bool) { lock.lock(); udpReady = on; lock.unlock() }

  private func receiveUDP(_ c: NWConnection) {
    c.receiveMessage { [weak self] data, _, _, err in
      guard let self, !self.isClosed else { return }
      if let data { _ = self.openUDP(data) }
      if err == nil { self.receiveUDP(c) }
    }
  }

  /// A datagram for this session: opened and handed on. Returns false when it is not (another session, forged, replayed).
  @discardableResult
  func openUDP(_ d: Data) -> Bool {
    lock.lock()
    let p = udpIn.openUDP(d, sid: keys.sid)
    if p == nil { udpBad += 1 } else { udpIn_ += 1 }
    lock.unlock()
    guard let p else { return false }
    onUdp(p)
    return true
  }

  func sendUDP(_ bodies: [Data]) {
    lock.lock()
    guard !closed, udp != nil || relayOut != nil else { lock.unlock(); return }
    let u = udp, r = relayOut
    var out: [Data] = []; out.reserveCapacity(bodies.count)
    for b in bodies { if let p = udpOut.sealUDP(b, sid: keys.sid) { out.append(p) } }
    sentPackets += out.count; sentBytes += out.reduce(0) { $0 + $1.count }
    lock.unlock()
    if let r { r.sendDatagrams(out); return }
    if let u { u.batch { for p in out { u.send(content: p, completion: .idempotent) } } }
  }

  /// One encoded frame: over UDP in fragments when the primary proved its UDP path, else whole over TCP (skipped when TCP has
  /// a backlog, except keyframes: the next frame is fresher anyway). Returns false if it was skipped.
  @discardableResult
  func sendVideo(_ f: RSVideoFrame) -> Bool {
    let bytes = f.encode()
    lock.lock(); let viaUdp = udpReady && (udp != nil || relayOut != nil); let backlog = tcpQueued; let size = chunk; lock.unlock()
    if viaUdp { sendUDP(RSPacket.fragments(of: bytes, number: f.number, chunk: size)); return true }
    if backlog > 2 * 1024 * 1024 && !f.keyframe { return false }
    send(.video, bytes)
    return true
  }

  func close(_ why: String) {
    lock.lock()
    guard !closed else { lock.unlock(); return }
    closed = true
    let u = udp; udp = nil
    let r = relayOut
    lock.unlock()
    stream.cancel(); u?.cancel(); r?.closeRelay()
    onClose(why)
  }

  /// Says goodbye (so the other Mac ends at once instead of waiting for a timeout), then closes.
  func bye() { send(.bye); q.asyncAfter(deadline: .now() + 0.2) { [weak self] in self?.close("ended") } }

  var counts: (sent: Int, bytes: Int, udpIn: Int, udpBad: Int) { lock.lock(); defer { lock.unlock() }; return (sentPackets, sentBytes, udpIn_, udpBad) }

  static func code(_ e: NWError) -> String {
    switch e { case .posix(let p): return "posix \(p.rawValue)"; case .dns(let d): return "dns \(d)"; case .tls(let t): return "tls \(t)"; default: return "other" }
  }
}

/// The secondary's listener. Starts only when the secondary has a paired primary; one session at a time (a new proven hello from
/// the primary ends the old session: the primary reconnected).
final class RSServer {
  let identity: SecondIdentity
  let q: DispatchQueue
  let loopback: Bool
  private var tcpL: NWListener?
  private var udpL: NWListener?
  private(set) var link: RSLink?
  private var udpConns: [ObjectIdentifier: NWConnection] = [:]
  /// Called on `q` with each proven session.
  var onSession: (RSLink) -> Void = { _ in }
  var log: (String) -> Void = { _ in }
  var now: () -> Double = { RSTime.nowMs }
  var app = ""

  init(identity: SecondIdentity, q: DispatchQueue, loopback: Bool = false) { self.identity = identity; self.q = q; self.loopback = loopback }

  var tcpPort: UInt16? { tcpL?.port?.rawValue }
  var udpPort: UInt16? { udpL?.port?.rawValue }

  /// `advertise`: publish the Bonjour name (off in the loopback test).
  func start(advertise: Bool = true, ready: @escaping (Bool) -> Void = { _ in }) {
    guard tcpL == nil else { ready(true); return }
    do {
      let t = try NWListener(using: RSNet.tcpParams(loopback: loopback))
      if advertise { t.service = NWListener.Service(name: RSName.service(device: identity.device), type: RSName.type) }
      t.newConnectionHandler = { [weak self] c in self?.accept(c) }
      let u = try NWListener(using: RSNet.udpParams(loopback: loopback))
      u.newConnectionHandler = { [weak self] c in self?.acceptUDP(c) }
      var up = 0
      func st(_ s: NWListener.State) {
        switch s {
        case .ready: up += 1; if up == 2 { ready(true) }
        case .failed(let e): log("PS screen: the listener failed (\(RSLink.code(e)))"); ready(false)
        default: break
        }
      }
      t.stateUpdateHandler = st; u.stateUpdateHandler = st
      tcpL = t; udpL = u
      t.start(queue: q); u.start(queue: q)
    } catch { log("PS screen: could not listen"); ready(false) }
  }

  func stop() {
    tcpL?.cancel(); udpL?.cancel(); tcpL = nil; udpL = nil
    for c in udpConns.values { c.cancel() }; udpConns = [:]
    link?.close("listener stopped"); link = nil
  }

  private func accept(_ c: NWConnection) {
    guard RSNet.isLocal(c.endpoint) else { c.cancel(); return }   // never from outside this network
    c.start(queue: q)
    accept(stream: RSTCPStream(c))
  }

  /// A session over any stream: the direct link's TCP connection, or the relay's pipe (PS 1.77: the second Mac dialled out to
  /// the relay address in a signed offer from its own main Mac). The same signed hello, the same checks, the same silence
  /// to anyone who does not prove they are the paired primary.
  func accept(stream c: RSStream, relay: RSDatagramOut? = nil) {
    RSNet.readFrames(c, buf: Data(), max: RSHandshake.maxHelloBytes, timeout: relay == nil ? 3 : 8, q: q) { [weak self] f, rest in
      guard let self else { c.cancel(); return }
      guard let f, let o = try? JSONSerialization.jsonObject(with: f), let env = SecondEnv(o) else { c.cancel(); return }
      switch RSHandshake.checkHello(env, identity: self.identity, nowMs: self.now()) {
      case .failure(let w):
        self.log("PS screen: refused a connection (\(w.why))")   // no answer at all to the caller
        c.cancel()
      case .success(let (peer, theirs)):
        let mine = Curve25519.KeyAgreement.PrivateKey()
        guard let ans = RSHandshake.answer(identity: self.identity, hello: env, eph: mine, nowMs: self.now(), app: self.app),
              let d = try? JSONSerialization.data(withJSONObject: ans.json),
              let keys = RSHandshake.keys(mine: mine, theirs: theirs, hello: env, answer: ans) else { c.cancel(); return }
        c.send(RSFrame.frame(d)) {}
        self.link?.close("replaced by a new session")
        let l = RSLink(side: .secondary, peer: peer, keys: keys, stream: c, leftover: rest, q: self.q)
        if let relay { l.useRelay(relay); relay.onDatagram = { [weak l] p in _ = l?.openUDP(p) } }
        self.link = l
        self.onSession(l)
        // After the caller's own close handler (chained, never replaced): the listener forgets the session.
        let theirs = l.onClose
        l.onClose = { [weak self, weak l] why in theirs(why); self?.q.async { if self?.link === l { self?.link = nil } } }
        l.start()
      }
    }
  }

  private func acceptUDP(_ c: NWConnection) {
    guard RSNet.isLocal(c.endpoint) else { c.cancel(); return }
    let key = ObjectIdentifier(c)
    udpConns[key] = c
    if udpConns.count > 8 { for (k, x) in udpConns where k != key { x.cancel(); udpConns[k] = nil; break } }
    c.start(queue: q)
    // A path that sends nothing good in 3 seconds is dropped.
    q.asyncAfter(deadline: .now() + 3) { [weak self] in
      guard let self, self.udpConns[key] != nil, self.link?.udp !== c else { return }
      c.cancel(); self.udpConns[key] = nil
    }
    func rx() {
      c.receiveMessage { [weak self] data, _, _, err in
        guard let self else { return }
        if let data, let l = self.link {
          if l.udp === c { _ = l.openUDP(data) }
          else if l.openUDP(data) {   // the first good packet from the primary: this is its UDP path
            l.attachUDP(c, receive: false)
            l.setUdpReady(true)
            l.send(.udpOK)
          }
        }
        if err == nil && self.udpConns[key] != nil { rx() }
      }
    }
    rx()
  }
}

/// The primary's side: find the secondary (Bonjour by its hidden name, or the addresses its heartbeat gave), connect, prove who
/// we are, check who answered.
final class RSClient {
  enum Fail: Error, Equatable { case notFound, refused(String), network(String) }
  let identity: SecondIdentity
  let secondary: SecondPeer
  let q: DispatchQueue
  let loopback: Bool
  var now: () -> Double = { RSTime.nowMs }
  var log: (String) -> Void = { _ in }
  var app = ""
  private var browser: NWBrowser?
  private var done = false

  init(identity: SecondIdentity, secondary: SecondPeer, q: DispatchQueue, loopback: Bool = false) {
    self.identity = identity; self.secondary = secondary; self.q = q; self.loopback = loopback
  }

  /// Looks for the secondary for up to `timeout` seconds, then connects. `hints`: direct addresses to try as well (the
  /// heartbeat's, or the loopback test's).
  func connect(hints: [NWEndpoint] = [], browse: Bool = true, timeout: Double = 4, completion: @escaping (Result<RSLink, Fail>) -> Void) {
    done = false
    var tried = Set<String>()
    var failures: [Fail] = []
    var pending = 0
    let finish: (Result<RSLink, Fail>) -> Void = { [weak self] r in
      guard let self, !self.done else { if case .success(let l) = r { l.close("not needed") }; return }
      self.done = true; self.browser?.cancel(); self.browser = nil
      completion(r)
    }
    func attempt(_ e: NWEndpoint, wired: Bool) {
      let key = "\(e)"
      guard !tried.contains(key), !done else { return }
      tried.insert(key)
      pending += 1
      let go: (Bool) -> Void = { avoidWifi in
        self.dial(e, avoidWifi: avoidWifi) { r in
          switch r {
          case .success(let l): finish(.success(l))
          case .failure(let f):
            if avoidWifi, case .network = f { self.dial(e, avoidWifi: false) { r2 in pending -= 1; if case .success(let l) = r2 { finish(.success(l)) } else if case .failure(let f2) = r2 { failures.append(f2) } }; return }
            pending -= 1; failures.append(f)
          }
        }
      }
      go(wired && !loopback)   // the cable first when the secondary was seen on one
    }
    for h in hints { attempt(h, wired: false) }
    if browse && !loopback {
      let want = RSName.service(device: secondary.device)
      let b = NWBrowser(for: .bonjour(type: RSName.type, domain: nil), using: NWParameters())
      b.browseResultsChangedHandler = { results, _ in
        for r in results {
          guard case let .service(name, _, _, _) = r.endpoint, name == want else { continue }
          let wired = r.interfaces.contains { $0.type == .wiredEthernet || $0.name.hasPrefix("bridge") }
          attempt(r.endpoint, wired: wired)
        }
      }
      b.stateUpdateHandler = { [weak self] st in if case .failed = st { self?.log("PS screen: looking for the other Mac failed") } }
      browser = b
      b.start(queue: q)
    }
    q.asyncAfter(deadline: .now() + timeout) {
      guard !self.done, pending == 0 else {
        // Still dialling: give it the handshake's own time, then stop.
        self.q.asyncAfter(deadline: .now() + 4) { if !self.done { finish(.failure(failures.first { if case .refused = $0 { return true }; return false } ?? .notFound)) } }
        return
      }
      finish(.failure(failures.first { if case .refused = $0 { return true }; return false } ?? (tried.isEmpty ? .notFound : failures.first ?? .notFound)))
    }
  }

  func cancel() { done = true; browser?.cancel(); browser = nil }

  private func dial(_ e: NWEndpoint, avoidWifi: Bool, done: @escaping (Result<RSLink, Fail>) -> Void) {
    let c = NWConnection(to: e, using: RSNet.tcpParams(loopback: loopback, avoidWifi: avoidWifi))
    var started = false
    c.stateUpdateHandler = { [weak self] st in
      guard let self else { return }
      switch st {
      case .ready:
        guard !started else { return }
        started = true
        if let r = c.currentPath?.remoteEndpoint, !RSNet.isLocal(r) { c.cancel(); done(.failure(.network("not a local address"))); return }
        self.handshake(RSTCPStream(c), done: done)
      case .failed(let err): if !started { started = true; c.cancel(); done(.failure(.network(RSLink.code(err)))) }
      case .waiting(let err): if !started { started = true; c.cancel(); done(.failure(.network(RSLink.code(err)))) }
      default: break
      }
    }
    c.start(queue: q)
    q.asyncAfter(deadline: .now() + (avoidWifi ? 1.2 : 3)) { if !started { started = true; c.cancel(); done(.failure(.network("timeout"))) } }
  }

  /// The signed hello and the check of the answer, over any stream (the direct link's TCP, or the relay's pipe).
  func handshake(_ c: RSStream, relay: RSDatagramOut? = nil, done: @escaping (Result<RSLink, Fail>) -> Void) {
    let mine = Curve25519.KeyAgreement.PrivateKey()
    guard let hello = RSHandshake.hello(identity: identity, to: secondary.device, eph: mine, nowMs: now(), app: app),
          let d = try? JSONSerialization.data(withJSONObject: hello.json) else { c.cancel(); done(.failure(.refused("no key"))); return }
    c.send(RSFrame.frame(d)) {}
    RSNet.readFrames(c, buf: Data(), max: RSHandshake.maxHelloBytes, timeout: relay == nil ? 3 : 8, q: q) { [weak self] f, rest in
      guard let self else { c.cancel(); return }
      // No answer: the secondary refused us (it never says why) or it is not PS.
      guard let f, let o = try? JSONSerialization.jsonObject(with: f), let env = SecondEnv(o) else { c.cancel(); done(.failure(.refused("no answer"))); return }
      switch RSHandshake.checkAnswer(env, identity: self.identity, expected: self.secondary.device, hello: hello, nowMs: self.now()) {
      case .failure(let w): c.cancel(); done(.failure(.refused(w.why)))
      case .success(let theirs):
        guard let keys = RSHandshake.keys(mine: mine, theirs: theirs, hello: hello, answer: env) else { c.cancel(); done(.failure(.refused("keys"))); return }
        let l = RSLink(side: .primary, peer: self.secondary, keys: keys, stream: c, leftover: rest, q: self.q)
        if let relay { l.useRelay(relay); relay.onDatagram = { [weak l] p in _ = l?.openUDP(p) } }
        done(.success(l))
      }
    }
  }

  /// The primary's UDP path to the secondary: the same address the TCP link reached, the secondary's UDP port. Sends hellos
  /// (encrypted, so only the session can open them) until the secondary says udpOK.
  static func openUDP(for l: RSLink, port: UInt16, q: DispatchQueue, loopback: Bool) {
    guard let remote = l.tcp?.currentPath?.remoteEndpoint, case let .hostPort(host, _) = remote, let p = NWEndpoint.Port(rawValue: port) else { return }
    let u = NWConnection(host: host, port: p, using: RSNet.udpParams(loopback: loopback))
    u.start(queue: q)
    l.attachUDP(u, receive: true)
    var n = 0
    func hello() {
      guard !l.isClosed, !l.udpReady, n < 20 else { return }
      n += 1
      l.sendUDP([RSPacket.hello(clockNs: RSTime.nowNs)])
      q.asyncAfter(deadline: .now() + 0.1, execute: hello)
    }
    hello()
  }
}

/// How the link goes, for the state and the log (no names, no addresses). (Moved here from RemoteScreen.swift in PS 1.77,
/// so the tests build with the link alone.)
enum RSLinkKind {
  static func of(_ c: NWConnection) -> String {
    guard let p = c.currentPath else { return "unknown" }
    if p.usesInterfaceType(.loopback) { return "this Mac" }
    if p.availableInterfaces.first.map({ $0.name.hasPrefix("bridge") }) == true { return "cable" }
    if p.usesInterfaceType(.wiredEthernet) { return "Ethernet" }
    if p.usesInterfaceType(.wifi) { return "Wi-Fi" }
    return "local network"
  }

  /// This Mac's private IPv4 addresses on Wi-Fi, Ethernet and Thunderbolt Bridge (for the heartbeat hint).
  static func localAddresses() -> [String] {
    var out: [String] = []
    var ifa: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifa) == 0, let first = ifa else { return [] }
    defer { freeifaddrs(ifa) }
    for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let i = p.pointee
      guard let a = i.ifa_addr, a.pointee.sa_family == UInt8(AF_INET), i.ifa_flags & UInt32(IFF_UP) != 0, i.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
      let name = String(cString: i.ifa_name)
      guard name.hasPrefix("en") || name.hasPrefix("bridge") else { continue }
      var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      guard getnameinfo(a, socklen_t(a.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
      let ip = String(cString: host)
      if RSNet.isLocal(.hostPort(host: NWEndpoint.Host(ip), port: 1)) { out.append(ip) }
    }
    return Array(out.prefix(6))
  }
}
