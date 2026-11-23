import Darwin
import Foundation

// Remote screen from anywhere (PS 1.77), the network half. The rules and the bytes are in RemoteScreenRelayCore.swift.
//
//   main Mac (primary)                     Cloudflare TURN                       second Mac (secondary)
//   asks the Worker for a short lived  ->  Allocate: relay address R
//   relay password (never the key)
//   signed offer "send to R"  ---------- the Worker's room (text only) ---------->  checks the signature (its paired primary)
//                                                                                   asks Cloudflare's STUN for its own address P
//                              <--------- signed answer "I am P" ----------------  starts sending to R (opens its NAT)
//   CreatePermission(P's address)  ->   R lets P in, and only P
//   the screen's signed hello, keys, input   <== sealed packets through R ==>       the picture, sealed
//
// The main Mac holds the one allocation and the second Mac sends straight to it, so the picture is billed once. Both Macs
// only dial out. Nothing here changes a network, firewall or VPN setting, and the VPN app is left as it is.

/// The relay's datagram side, for RSLink: sealed packets out, sealed packets in.
protocol RSDatagramOut: AnyObject {
  func sendDatagrams(_ packets: [Data])
  var onDatagram: (Data) -> Void { get set }
  func closeRelay()
}

// MARK: a plain UDP socket (IPv4, any destination: the TURN server and the relay address from the same port)

final class RSUdpSocket {
  private let fd: Int32
  private let src: DispatchSourceRead
  private var closed = false
  /// Every datagram, on the socket's queue.
  var onReceive: (Data, RSAddr) -> Void = { _, _ in }
  private(set) var received = 0, sent = 0

  /// `loopback`: bound to 127.0.0.1 (the test). Otherwise any address, a port macOS picks.
  init?(q: DispatchQueue, loopback: Bool = false) {
    let s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
    guard s >= 0 else { return nil }
    var big: Int32 = 4 * 1024 * 1024
    setsockopt(s, SOL_SOCKET, SO_RCVBUF, &big, socklen_t(MemoryLayout<Int32>.size))
    var out: Int32 = 1024 * 1024
    setsockopt(s, SOL_SOCKET, SO_SNDBUF, &out, socklen_t(MemoryLayout<Int32>.size))
    _ = fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK)
    var a = sockaddr_in()
    a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); a.sin_family = sa_family_t(AF_INET); a.sin_port = 0
    a.sin_addr.s_addr = loopback ? inet_addr("127.0.0.1") : INADDR_ANY
    let ok = withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    guard ok == 0 else { Darwin.close(s); return nil }
    fd = s
    src = DispatchSource.makeReadSource(fileDescriptor: s, queue: q)
    src.setEventHandler { [weak self] in self?.drain() }
    src.setCancelHandler { Darwin.close(s) }
    src.resume()
  }

  var port: UInt16 {
    var a = sockaddr_in(); var l = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &l) } }
    return UInt16(bigEndian: a.sin_port)
  }

  private func drain() {
    var buf = [UInt8](repeating: 0, count: 65_536)
    while !closed {
      var from = sockaddr_in(); var l = socklen_t(MemoryLayout<sockaddr_in>.size)
      let n = buf.withUnsafeMutableBytes { b in
        withUnsafeMutablePointer(to: &from) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { recvfrom(fd, b.baseAddress, b.count, 0, $0, &l) } }
      }
      guard n > 0 else { return }
      let ip = withUnsafeBytes(of: from.sin_addr.s_addr) { [UInt8]($0) }
      guard let addr = RSAddr(ip: ip, port: UInt16(bigEndian: from.sin_port)) else { continue }
      received += 1
      onReceive(Data(buf[0..<n]), addr)
    }
  }

  @discardableResult
  func send(_ d: Data, to: RSAddr) -> Bool {
    guard !closed else { return false }
    var a = sockaddr_in()
    a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size); a.sin_family = sa_family_t(AF_INET); a.sin_port = to.port.bigEndian
    a.sin_addr.s_addr = to.ip.withUnsafeBytes { $0.load(as: UInt32.self) }
    let n = d.withUnsafeBytes { b in withUnsafePointer(to: &a) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { sendto(fd, b.baseAddress, b.count, 0, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } } }
    if n == d.count { sent += 1 }
    return n == d.count
  }

  func close() { guard !closed else { return }; closed = true; src.cancel() }
}

enum RSResolve {
  /// A host name's first IPv4 address (the relay addresses are IPv4, so both Macs talk IPv4 to Cloudflare). Blocking: never
  /// on the main thread.
  static func ipv4(_ host: String, port: UInt16) -> RSAddr? {
    if let a = RSAddr("\(host):\(port)") { return a }
    var hints = addrinfo(); hints.ai_family = AF_INET; hints.ai_socktype = SOCK_DGRAM
    var res: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, nil, &hints, &res) == 0, let first = res else { return nil }
    defer { freeaddrinfo(res) }
    for p in sequence(first: first, next: { $0.pointee.ai_next }) {
      guard let sa = p.pointee.ai_addr, sa.pointee.sa_family == sa_family_t(AF_INET) else { continue }
      let ip = sa.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { s in withUnsafeBytes(of: s.pointee.sin_addr.s_addr) { [UInt8]($0) } }
      return RSAddr(ip: ip, port: port)
    }
    return nil
  }
}

// MARK: STUN and TURN requests over a socket

/// A plain reason (for the log only).
struct RSWhy: Error, CustomStringConvertible { let description: String; init(_ s: String) { description = s } }

/// Requests with retries (RFC 8489: 250 ms, doubling), matched by transaction id.
final class RSStunTransport {
  let server: RSAddr
  let sock: RSUdpSocket
  private let q: DispatchQueue
  private var waiting: [Data: (raw: Data, tries: Int, done: (RSStun.Msg?, Data?) -> Void)] = [:]
  var maxTries = 7

  init(server: RSAddr, sock: RSUdpSocket, q: DispatchQueue) { self.server = server; self.sock = sock; self.q = q }

  func request(_ m: RSStun.Msg, key: Data?, done: @escaping (RSStun.Msg?, _ raw: Data?) -> Void) {
    let raw = m.encode(key: key)
    waiting[m.tid] = (raw, 1, done)
    sock.send(raw, to: server)
    retry(m.tid, after: 0.25)
  }
  private func retry(_ tid: Data, after s: Double) {
    q.asyncAfter(deadline: .now() + s) { [weak self] in
      guard let self, var w = self.waiting[tid] else { return }
      if w.tries >= self.maxTries { self.waiting[tid] = nil; w.done(nil, nil); return }
      w.tries += 1; self.waiting[tid] = w
      self.sock.send(w.raw, to: self.server)
      self.retry(tid, after: min(s * 2, 1.6))
    }
  }
  /// A response (true when it was one of ours).
  func response(_ m: RSStun.Msg, raw: Data) -> Bool {
    guard let w = waiting.removeValue(forKey: m.tid) else { return false }
    w.done(m, raw); return true
  }
  func cancelAll() { waiting = [:] }
}

enum RSStunProbe {
  /// This socket's address as the STUN server sees it (Cloudflare's STUN is free and needs no password).
  static func request() -> RSStun.Msg { RSStun.Msg(RSStun.binding, .request) }
  static func mapped(_ m: RSStun.Msg?) -> RSAddr? {
    guard let m, m.kind == .success, m.method == RSStun.binding else { return nil }
    return m.attr(RSStun.aMapped).flatMap(RSStun.unXorAddr)
  }
}

/// A TURN client (RFC 8656) on one socket: one allocation, permissions for one peer's address, an optional channel, and the
/// refreshes that keep them. Long term credentials from the Worker (a user name and a password that expire). All on `q`.
final class RSTurnClient {
  let server: RSAddr
  let sock: RSUdpSocket
  private let q: DispatchQueue
  private let username: String, password: String
  private let tx: RSStunTransport
  private var realm: String?, nonce: Data?, key: Data?
  private(set) var relayed: RSAddr?, mapped: RSAddr?
  private var permitted: [[UInt8]: RSAddr] = [:]
  private var channels: [RSAddr: UInt16] = [:], byChannel: [UInt16: RSAddr] = [:]
  private var nextChannel: UInt16 = 0x4000
  private var timers: [DispatchSourceTimer] = []
  private var closed = false
  /// Data from a permitted peer (through the relay), on `q`.
  var onData: (RSAddr, Data) -> Void = { _, _ in }
  /// A refresh failed (the relay is gone).
  var onLost: (String) -> Void = { _ in }
  var log: (String) -> Void = { _ in }
  private(set) var bytesIn = 0

  init(server: RSAddr, username: String, password: String, sock: RSUdpSocket, q: DispatchQueue) {
    self.server = server; self.username = username; self.password = password; self.sock = sock; self.q = q
    tx = RSStunTransport(server: server, sock: sock, q: q)
  }

  /// Every datagram from the TURN server.
  func input(_ d: Data) {
    guard !closed else { return }
    bytesIn += d.count
    if let first = d.first, (0x40...0x4F).contains(first) {
      if let (ch, body) = RSStun.parseChannelData(d), let peer = byChannel[ch] { onData(peer, body) }
      return
    }
    guard let m = RSStun.decode(d) else { return }
    if m.kind == .indication && m.method == RSStun.data {
      guard let pa = m.attr(RSStun.aPeer).flatMap(RSStun.unXorAddr), let body = m.attr(RSStun.aData), permitted[pa.ip] != nil else { return }
      onData(pa, body)
      return
    }
    if m.kind == .success || m.kind == .error { _ = tx.response(m, raw: d) }
  }

  /// One authenticated request: the first 401 gives the realm and nonce, a 438 a fresh nonce; each is tried once more.
  private func request(_ method: UInt16, _ attrs: [(UInt16, Data)], again: Int = 2, done: @escaping (Result<RSStun.Msg, RSWhy>) -> Void) {
    var m = RSStun.Msg(method, .request)
    for (t, v) in attrs { m.add(t, v) }
    if let realm, let nonce {
      m.add(RSStun.aUsername, Data(username.utf8)); m.add(RSStun.aRealm, Data(realm.utf8)); m.add(RSStun.aNonce, nonce)
    }
    tx.request(m, key: realm == nil ? nil : key) { [weak self] r, raw in
      guard let self, !self.closed else { return }
      guard let r, let raw else { done(.failure(RSWhy("the relay did not answer"))); return }
      if r.kind == .error {
        let code = r.errorCode ?? 0
        if (code == 401 || code == 438), again > 0, let n = r.attr(RSStun.aNonce) {
          if let rl = r.attr(RSStun.aRealm).flatMap({ String(data: $0, encoding: .utf8) }) { self.realm = rl }
          guard let rl = self.realm else { done(.failure(RSWhy("the relay sent no realm"))); return }
          if code == 401 && self.key != nil && self.nonce == n { done(.failure(RSWhy("the relay refused the password"))); return }
          self.nonce = n
          self.key = RSStun.longTermKey(username: self.username, realm: rl, password: self.password)
          self.request(method, attrs, again: again - 1, done: done)
          return
        }
        done(.failure(RSWhy("the relay said \(code)"))); return
      }
      // A success to a signed request must be signed with the same key when it carries a signature at all.
      if let k = self.key, r.attr(RSStun.aIntegrity) != nil, !RSStun.integrityOK(raw, key: k) { done(.failure(RSWhy("the relay's answer did not check out"))); return }
      done(.success(r))
    }
  }

  /// Asks for the relay address (UDP, 10 minutes, kept by refreshes).
  func allocate(done: @escaping (Result<RSAddr, RSWhy>) -> Void) {
    var tr = RSWriter(); tr.u32(17 << 24)   // REQUESTED-TRANSPORT: UDP
    var lt = RSWriter(); lt.u32(600)
    request(RSStun.allocate, [(RSStun.aTransport, tr.data), (RSStun.aLifetime, lt.data)]) { [weak self] r in
      guard let self else { return }
      switch r {
      case .failure(let w): done(.failure(w))
      case .success(let m):
        guard let rel = m.attr(RSStun.aRelayed).flatMap(RSStun.unXorAddr) else { done(.failure(RSWhy("the relay gave no address"))); return }
        self.relayed = rel
        self.mapped = m.attr(RSStun.aMapped).flatMap(RSStun.unXorAddr)
        let life = Double(m.lifetime ?? 600)
        self.every(max(30, life / 2)) { [weak self] in self?.refresh(600) }
        self.every(120) { [weak self] in self?.renewPermissions() }   // permissions last 5 minutes
        done(.success(rel))
      }
    }
  }

  private func refresh(_ seconds: UInt32) {
    var lt = RSWriter(); lt.u32(seconds)
    request(RSStun.refresh, [(RSStun.aLifetime, lt.data)]) { [weak self] r in
      if case .failure(let w) = r, seconds > 0 { self?.log("PS screen: the relay refresh failed (\(w))"); self?.onLost(w.description) }
    }
  }

  /// Lets one peer's address in (permissions are per IP address, any port).
  func permit(_ peer: RSAddr, done: @escaping (Bool) -> Void) {
    request(RSStun.createPermission, [(RSStun.aPeer, RSStun.xorAddr(peer))]) { [weak self] r in
      guard let self else { return }
      if case .success = r { self.permitted[peer.ip] = peer; done(true) } else { done(false) }
    }
  }
  private func renewPermissions() {
    for p in permitted.values { request(RSStun.createPermission, [(RSStun.aPeer, RSStun.xorAddr(p))]) { _ in } }
    for (p, ch) in channels { bindRequest(p, ch) { _ in } }   // channels last 10 minutes
  }

  /// A channel for one peer: 4 bytes of overhead per packet instead of 36. Best effort: without it the indications work.
  func bind(_ peer: RSAddr, done: @escaping (Bool) -> Void = { _ in }) {
    guard channels[peer] == nil, nextChannel <= 0x4FFF else { done(channels[peer] != nil); return }
    let ch = nextChannel; nextChannel += 1
    byChannel[ch] = peer   // the relay may use the channel the moment it is bound: packets on it are taken from now on
    bindRequest(peer, ch) { [weak self] ok in
      guard let self else { return }
      if ok { self.channels[peer] = ch } else { self.byChannel[ch] = nil }
      done(ok)
    }
  }
  private func bindRequest(_ peer: RSAddr, _ ch: UInt16, done: @escaping (Bool) -> Void) {
    var c = RSWriter(); c.u16(ch); c.u16(0)
    request(RSStun.channelBind, [(RSStun.aChannel, c.data), (RSStun.aPeer, RSStun.xorAddr(peer))]) { r in if case .success = r { done(true) } else { done(false) } }
  }

  /// One datagram to a permitted peer, through the relay.
  func send(_ d: Data, to peer: RSAddr) {
    guard !closed else { return }
    if let ch = channels[peer] { sock.send(RSStun.channelData(ch, d), to: server); return }
    var m = RSStun.Msg(RSStun.send, .indication)
    m.add(RSStun.aPeer, RSStun.xorAddr(peer)); m.add(RSStun.aData, d)
    sock.send(m.encode(fingerprint: false), to: server)
  }

  private func every(_ s: Double, _ f: @escaping () -> Void) {
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + s, repeating: s, leeway: .seconds(1))
    t.setEventHandler(handler: f); t.resume(); timers.append(t)
  }

  /// Gives the allocation back at once (a lifetime of 0), so nothing more can arrive or be billed.
  func close() {
    guard !closed else { return }
    if relayed != nil, realm != nil {
      var lt = RSWriter(); lt.u32(0)
      var m = RSStun.Msg(RSStun.refresh, .request)
      m.add(RSStun.aLifetime, lt.data)
      if let realm, let nonce { m.add(RSStun.aUsername, Data(username.utf8)); m.add(RSStun.aRealm, Data(realm.utf8)); m.add(RSStun.aNonce, nonce) }
      sock.send(m.encode(key: key), to: server)
    }
    closed = true
    timers.forEach { $0.cancel() }; timers = []
    tx.cancelAll()
  }
}

// MARK: the relay pipe: the link's stream and datagrams on one relayed path

/// One relayed session's path, for RSLink: an RSStream (the reliable segments, kind 0x01 and 0x03) and an RSDatagramOut (the
/// sealed UDP packets, kind 0x02), both on the same datagrams. `raw` sends one datagram towards the other Mac (through the TURN
/// client on the main Mac, straight to the relay address on the second Mac).
final class RSRelayPipe: RSStream, RSDatagramOut {
  private let q: DispatchQueue
  private let raw: (Data) -> Void
  let rel = RSReliable()
  private var timer: DispatchSourceTimer?
  private var inbox = Data()
  private var waiting: ((Data?, Bool, Bool) -> Void)?
  private var down = false
  private(set) var heard = false
  var onDown: ((String) -> Void)?
  var onDatagram: (Data) -> Void = { _ in }
  /// The first datagram of any kind from the other Mac (the main Mac starts the screen's hello then).
  var onFirst: () -> Void = {}
  /// Runs once when the pipe closes (the TURN client gives back its allocation, the socket closes).
  var onClosed: () -> Void = {}
  let kindName = "relay"

  init(q: DispatchQueue, raw: @escaping (Data) -> Void) {
    self.q = q; self.raw = raw
    rel.output = { d in raw(d) }
    rel.deliver = { [weak self] d in self?.got(d) }
    rel.onFail = { [weak self] why in self?.q.async { self?.finish(why) } }
    rel.begin()
    let t = DispatchSource.makeTimerSource(queue: q)
    t.schedule(deadline: .now() + 0.02, repeating: 0.02, leeway: .milliseconds(5))
    t.setEventHandler { [weak self] in self?.rel.tick() }
    t.resume(); timer = t
  }

  /// A datagram from the other Mac, on `q`.
  func input(_ d: Data) {
    guard !down, let k = d.first else { return }
    if !heard { heard = true; onFirst() }
    switch k {
    case RSReliable.kindData, RSReliable.kindAck: rel.input(d)
    case RSRelayRules.kindVideo: onDatagram(d.count > 1 ? Data(d.dropFirst()) : Data())
    case RSRelayRules.kindBye: finish("the other Mac closed the link", tell: false)
    default: break   // the second Mac's punches
    }
  }

  private func got(_ d: Data) {
    if let w = waiting { waiting = nil; w(d, false, false) } else { inbox.append(d) }
  }
  func receive(_ f: @escaping (Data?, Bool, Bool) -> Void) {
    q.async { [self] in
      if !inbox.isEmpty { let d = inbox; inbox = Data(); f(d, false, false); return }
      if down { f(nil, true, false); return }
      waiting = f
    }
  }
  func send(_ d: Data, done: @escaping () -> Void) { q.async { [self] in rel.write(d, done: done) } }
  /// Any thread (the encoder's): onto the pipe's queue, so the TURN client is only ever touched there.
  func sendDatagrams(_ packets: [Data]) {
    q.async { [self] in
      guard !down else { return }
      for p in packets { var d = Data([RSRelayRules.kindVideo]); d.append(p); raw(d) }
    }
  }
  func cancel() { q.async { [self] in finish("link closed") } }
  func closeRelay() { cancel() }

  private func finish(_ why: String, tell: Bool = true) {
    guard !down else { return }
    if tell && heard { raw(Data([RSRelayRules.kindBye])); raw(Data([RSRelayRules.kindBye])) }
    down = true
    timer?.cancel(); timer = nil
    if !rel.failed { rel.fail(why) }
    if let w = waiting { waiting = nil; w(nil, true, false) }
    onClosed(); onClosed = {}
    onDown?(why)
  }
}

// MARK: finding each other: the Worker's room (text only, signed by the device keys)

/// The two Macs' meeting point. `send` and `onMessage` carry {"to": "primary" | "secondary", "env": signed envelope}.
protocol RSRelaySignal: AnyObject {
  func send(_ o: [String: Any])
  var onMessage: ([String: Any]) -> Void { get set }
}

/// The relay settings (Settings, Second Computer, Remote screen, From anywhere): the switch, the Worker's address and the
/// relay key. The address and the switch in UserDefaults, the key with Second Computer's own keys (never in the page, never
/// in a file, never printed, handed over at each update with them).
struct RSRelayConfig {
  var url: URL
  var key: String
  static let onKey = "screen.anywhere", urlKey = "screen.relayUrl"
  static var on: Bool { UserDefaults.standard.bool(forKey: onKey) }
  static func load(_ id: SecondIdentity?) -> RSRelayConfig? {
    guard on, let s = UserDefaults.standard.string(forKey: urlKey), let u = RSRelayRules.workerURL(s),
          let k = id?.relaySecret, RSRelayRules.keyOK(k) else { return nil }
    return RSRelayConfig(url: u, key: k)
  }

  /// A request to the Worker with the time and its signature (the key never travels).
  func request(_ path: String, method: String, body: Data = Data(), websocket: Bool = false) -> URLRequest? {
    var base = url.absoluteString
    while base.hasSuffix("/") { base.removeLast() }
    let prefix = URL(string: base)?.path ?? ""
    guard var u = URL(string: base + path) else { return nil }
    if websocket, var c = URLComponents(url: u, resolvingAgainstBaseURL: false) { c.scheme = "wss"; if let x = c.url { u = x } }
    var r = URLRequest(url: u, timeoutInterval: 10)
    r.httpMethod = method
    let t = Int(Date().timeIntervalSince1970)
    r.setValue(String(t), forHTTPHeaderField: "X-PS-Time")
    r.setValue(RSRelayRules.requestSignature(key: key, time: t, method: method, path: prefix + path, body: body), forHTTPHeaderField: "X-PS-Sign")
    if !body.isEmpty { r.httpBody = body; r.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    return r
  }

  /// Short lived TURN credentials (a few bytes of text; the TURN key itself stays in the Worker).
  func creds(done: @escaping (RSTurnCreds?) -> Void) {
    guard let r = request("/creds", method: "POST", body: Data("{}".utf8)) else { done(nil); return }
    URLSession.shared.dataTask(with: r) { d, resp, _ in
      guard (resp as? HTTPURLResponse)?.statusCode == 200, let d, d.count < 16 * 1024 else { done(nil); return }
      done(RSTurnCreds.parse(d))
    }.resume()
  }
}

/// The room over a WebSocket to the Worker. The second Mac keeps it open while From anywhere is on (Cloudflare holds an idle
/// socket without waking anything); the main Mac opens it to connect.
final class RSRelayRoom: NSObject, RSRelaySignal, URLSessionWebSocketDelegate {
  let config: RSRelayConfig, room: String, role: String
  private let q: DispatchQueue
  private var task: URLSessionWebSocketTask?
  private var session: URLSession?
  private var stopped = false
  private var backoff = 2.0
  private var ping: DispatchSourceTimer?
  private var queued: [(Data, Double)] = []
  private var open = false
  var onMessage: ([String: Any]) -> Void = { _ in }
  var log: (String) -> Void = { _ in }

  init(config: RSRelayConfig, room: String, role: String, q: DispatchQueue) { self.config = config; self.room = room; self.role = role; self.q = q }

  func start() {
    q.async { [self] in
      guard !stopped, task == nil, let r = config.request("/room/\(room)?role=\(role)", method: "GET", websocket: true) else { return }
      let s = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
      let t = s.webSocketTask(with: r)
      t.maximumMessageSize = 16 * 1024
      session = s; task = t
      t.resume()
      receive(t)
      let p = DispatchSource.makeTimerSource(queue: q)
      p.schedule(deadline: .now() + 30, repeating: 30, leeway: .seconds(2))
      p.setEventHandler { [weak self] in self?.task?.send(.string("ping")) { _ in } }
      p.resume(); ping = p
    }
  }

  func urlSession(_ s: URLSession, webSocketTask t: URLSessionWebSocketTask, didOpenWithProtocol p: String?) {
    q.async { [self] in
      guard t === task else { return }
      open = true; backoff = 2
      let now = RSTime.nowMs
      for (d, at) in queued where now - at < 15_000 { t.send(.data(d)) { _ in } }
      queued = []
    }
  }

  private func receive(_ t: URLSessionWebSocketTask) {
    t.receive { [weak self] r in
      guard let self else { return }
      self.q.async {
        guard t === self.task else { return }
        switch r {
        case .failure: self.lost()
        case .success(let m):
          var d: Data?
          switch m { case .string(let s): d = s == "pong" ? nil : Data(s.utf8); case .data(let x): d = x; @unknown default: d = nil }
          if let d, d.count < 16 * 1024, let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] { self.onMessage(o) }
          self.receive(t)
        }
      }
    }
  }

  private func lost() {
    task?.cancel(with: .goingAway, reason: nil); task = nil; session?.invalidateAndCancel(); session = nil
    ping?.cancel(); ping = nil; open = false
    guard !stopped else { return }
    let wait = backoff; backoff = min(backoff * 2, 60)
    q.asyncAfter(deadline: .now() + wait) { [weak self] in self?.start() }
  }

  func send(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o), d.count < 12 * 1024 else { return }
    q.async { [self] in
      if open, let t = task { t.send(.string(String(decoding: d, as: UTF8.self))) { _ in } }
      else { queued.append((d, RSTime.nowMs)); if queued.count > 4 { queued.removeFirst() } }
    }
  }

  func stop() { q.async { [self] in stopped = true; lost() } }
}

// MARK: the main Mac: connect through the relay

final class RSRelayDial {
  let identity: SecondIdentity
  let secondary: SecondPeer
  private let q: DispatchQueue
  let signal: RSRelaySignal
  /// Short lived TURN credentials (from the Worker).
  var getCreds: (@escaping (RSTurnCreds?) -> Void) -> Void
  /// The test: sockets on 127.0.0.1 and local relay addresses allowed (the stand-in relay).
  var loopback = false
  var timeout = 15.0
  var log: (String) -> Void = { _ in }
  var app = ""
  var now: () -> Double = { RSTime.nowMs }
  private var sock: RSUdpSocket?
  private var turn: RSTurnClient?
  private var pipe: RSRelayPipe?
  private var client: RSClient?
  private var offer: SecondEnv?
  private var finished = false
  private var done: (Result<RSLink, RSClient.Fail>) -> Void = { _ in }

  init(identity: SecondIdentity, secondary: SecondPeer, q: DispatchQueue, signal: RSRelaySignal, getCreds: @escaping (@escaping (RSTurnCreds?) -> Void) -> Void) {
    self.identity = identity; self.secondary = secondary; self.q = q; self.signal = signal; self.getCreds = getCreds
  }

  func start(completion: @escaping (Result<RSLink, RSClient.Fail>) -> Void) {
    done = completion
    q.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.fail(.notFound, "no answer through the relay in time") }
    getCreds { [weak self] creds in
      guard let self else { return }
      guard let creds, let first = creds.udpServers.first else { self.q.async { self.fail(.network("no relay password"), "the relay Worker gave no password") }; return }
      DispatchQueue.global(qos: .userInitiated).async {
        let server = RSResolve.ipv4(first.0, port: first.1)
        self.q.async { self.allocate(server, creds) }
      }
    }
  }

  private func allocate(_ server: RSAddr?, _ creds: RSTurnCreds) {
    guard !finished else { return }
    guard let server, let s = RSUdpSocket(q: q, loopback: loopback) else { fail(.network("relay address"), "the relay's address did not resolve"); return }
    let t = RSTurnClient(server: server, username: creds.username, password: creds.credential, sock: s, q: q)
    t.log = log
    s.onReceive = { [weak t] d, from in if from == server { t?.input(d) } }
    sock = s; turn = t
    t.allocate { [weak self] r in
      guard let self, !self.finished else { return }
      switch r {
      case .failure(let w): self.fail(.network("relay"), "the relay said no (\(w))")
      case .success(let rel):
        guard let o = RSRelayRules.offer(identity: self.identity, to: self.secondary.device, relay: rel, nowMs: self.now()) else { self.fail(.refused("no key"), "could not sign the offer"); return }
        self.offer = o
        self.signal.onMessage = { [weak self] m in self?.q.async { self?.heard(m) } }
        self.signal.send(["to": "secondary", "env": o.json])
        self.log("PS screen: relay ready, asked the second Mac to come")
        // The same signed offer again every 3 seconds until it answers (its room socket may have been reconnecting). The
        // second Mac takes an offer once ("Seen before" after that), so a repeat never starts a second session.
        func again() {
          self.q.asyncAfter(deadline: .now() + 3) { [weak self] in
            guard let self, !self.finished, self.pipe == nil else { return }
            self.signal.send(["to": "secondary", "env": o.json]); again()
          }
        }
        again()
      }
    }
  }

  private func heard(_ m: [String: Any]) {
    guard !finished, pipe == nil, let offer, let turn, let env = SecondEnv(m["env"]) else { return }
    switch RSRelayRules.checkAnswer(env, identity: identity, expected: secondary.device, offer: offer, nowMs: now(), allowLocal: loopback) {
    case .failure(let w): log("PS screen: an answer through the relay did not check out (\(w.why))")
    case .success(let pub):
      var peer = pub
      let p = RSRelayPipe(q: q) { [weak turn] d in turn?.send(d, to: peer) }
      pipe = p
      turn.onData = { [weak p, weak turn] from, d in
        guard from.ip == pub.ip else { return }
        if from != peer { peer = from; turn?.bind(from) }   // its NAT picked another port for the relay: that one
        p?.input(d)
      }
      turn.onLost = { [weak p] w in p?.closeRelay(); _ = w }
      let keep = (turn, sock)
      p.onClosed = { keep.0.close(); keep.1?.close() }
      turn.permit(pub) { [weak self] ok in
        guard let self, !self.finished else { return }
        guard ok else { self.fail(.network("relay"), "the relay would not let the second Mac in"); return }
        turn.bind(peer)
      }
      // The second Mac sends to the relay address until it hears back: its first packet starts the screen's own hello.
      p.onFirst = { [weak self, weak p] in
        guard let self, let p, !self.finished else { return }
        let c = RSClient(identity: self.identity, secondary: self.secondary, q: self.q, loopback: self.loopback)
        c.now = self.now; c.app = self.app; c.log = self.log
        self.client = c
        c.handshake(p, relay: p) { [weak self] r in
          guard let self else { return }
          switch r {
          case .success(let l):
            guard !self.finished else { l.close("not needed"); return }
            self.finished = true
            self.done(.success(l))
          case .failure(let f): self.fail(f, "the handshake through the relay failed")
          }
        }
      }
    }
  }

  func cancel() { q.async { [weak self] in self?.fail(.notFound, "cancelled") } }

  private func fail(_ f: RSClient.Fail, _ why: String) {
    guard !finished else { return }
    finished = true
    log("PS screen: \(why)")
    if let p = pipe { p.closeRelay() } else { turn?.close(); sock?.close() }
    done(.failure(f))
  }
}

// MARK: the second Mac: answer a signed offer

final class RSRelayAnswer {
  let identity: SecondIdentity
  private let q: DispatchQueue
  let server: RSServer
  let signal: RSRelaySignal
  /// Cloudflare's STUN (free, no password): this Mac's own internet address as the relay will see it.
  var stun: () -> RSAddr? = { RSResolve.ipv4("stun.cloudflare.com", port: 3478) }
  var loopback = false
  var log: (String) -> Void = { _ in }
  var now: () -> Double = { RSTime.nowMs }
  private var current: RSRelayPipe?

  init(identity: SecondIdentity, server: RSServer, signal: RSRelaySignal, q: DispatchQueue) {
    self.identity = identity; self.server = server; self.signal = signal; self.q = q
    signal.onMessage = { [weak self] m in self?.q.async { self?.heard(m) } }
  }

  private func heard(_ m: [String: Any]) {
    guard let env = SecondEnv(m["env"]) else { return }
    switch RSRelayRules.checkOffer(env, identity: identity, nowMs: now(), allowLocal: loopback) {
    case .failure(let w): log("PS screen: refused an offer through the relay (\(w.why))")   // never answered
    case .success(let (_, relay)):
      let stun = self.stun
      DispatchQueue.global(qos: .userInitiated).async { [weak self] in
        let s = stun()
        self?.q.async { self?.come(env, relay: relay, stun: s) }
      }
    }
  }

  private func come(_ offer: SecondEnv, relay: RSAddr, stun: RSAddr?) {
    guard let stun, let s = RSUdpSocket(q: q, loopback: loopback) else { log("PS screen: no STUN answer for the relay"); return }
    let tx = RSStunTransport(server: stun, sock: s, q: q)
    tx.maxTries = 5
    var pipe: RSRelayPipe?
    s.onReceive = { d, from in
      if from == relay { pipe?.input(d); return }
      if from == stun, let m = RSStun.decode(d) { _ = tx.response(m, raw: d) }
    }
    tx.request(RSStunProbe.request(), key: nil) { [weak self] m, _ in
      guard let self else { s.close(); return }
      guard let pub = RSStunProbe.mapped(m), let ans = RSRelayRules.answer(identity: self.identity, offer: offer, pub: pub, nowMs: self.now()) else {
        self.log("PS screen: could not learn this Mac's address for the relay"); s.close(); return
      }
      let p = RSRelayPipe(q: self.q) { d in s.send(d, to: relay) }
      p.onClosed = { s.onReceive = { _, _ in }; s.close() }
      pipe = p
      self.current?.closeRelay()
      self.current = p
      self.signal.send(["to": "primary", "env": ans.json])
      // Through its NAT: "here I am" to the relay address until the main Mac's hello comes back (10 s at most).
      var n = 0
      func punch() {
        guard !p.heard, n < 66 else { return }
        n += 1
        s.send(Data([RSRelayRules.kindPunch]), to: relay)
        self.q.asyncAfter(deadline: .now() + 0.15, execute: punch)
      }
      punch()
      self.server.accept(stream: p, relay: p)
      self.log("PS screen: answered the main Mac through the relay")
    }
  }

  func stop() { q.async { [weak self] in self?.current?.closeRelay(); self?.current = nil } }
}
