import Darwin
import Foundation
import Network

// The paired Macs exchange signed, encrypted offers over Second Computer.
// Both dial out to TURN, using TLS on 443 first. Media and input remain sealed by RSLink.

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
  private let send: (Data) -> Void
  private let q: DispatchQueue
  private var waiting: [Data: (raw: Data, tries: Int, done: (RSStun.Msg?, Data?) -> Void)] = [:]
  var maxTries = 7

  init(q: DispatchQueue, send: @escaping (Data) -> Void) { self.q = q; self.send = send }

  func request(_ m: RSStun.Msg, key: Data?, done: @escaping (RSStun.Msg?, _ raw: Data?) -> Void) {
    let raw = m.encode(key: key)
    waiting[m.tid] = (raw, 1, done)
    send(raw)
    retry(m.tid, after: maxTries == 1 ? 4 : 0.25)
  }
  private func retry(_ tid: Data, after s: Double) {
    q.asyncAfter(deadline: .now() + s) { [weak self] in
      guard let self, var w = self.waiting[tid] else { return }
      if w.tries >= self.maxTries { self.waiting[tid] = nil; w.done(nil, nil); return }
      w.tries += 1; self.waiting[tid] = w
      self.send(w.raw)
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

/// A TURN client (RFC 8656) on one socket: one allocation, permissions for one peer's address, an optional channel, and the
/// refreshes that keep them. Short-lived TURN credentials from the vault. All on `q`.
final class RSTurnClient {
  private let sendPacket: (Data) -> Void
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

  convenience init(server: RSAddr, username: String, password: String, sock: RSUdpSocket, q: DispatchQueue) {
    self.init(username: username, password: password, q: q, stream: false) { sock.send($0, to: server) }
  }

  init(username: String, password: String, q: DispatchQueue, stream: Bool, send: @escaping (Data) -> Void) {
    self.username = username; self.password = password; self.q = q; sendPacket = send
    tx = RSStunTransport(q: q, send: send)
    if stream { tx.maxTries = 1 }
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
    if let ch = channels[peer] { sendPacket(RSStun.channelData(ch, d)); return }
    var m = RSStun.Msg(RSStun.send, .indication)
    m.add(RSStun.aPeer, RSStun.xorAddr(peer)); m.add(RSStun.aData, d)
    sendPacket(m.encode(fingerprint: false))
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
      sendPacket(m.encode(key: key))
    }
    closed = true
    timers.forEach { $0.cancel() }; timers = []
    tx.cancelAll()
  }
}

// MARK: the relay pipe: the link's stream and datagrams on one relayed path

/// One relayed session's path, for RSLink: an RSStream (the reliable segments, kind 0x01 and 0x03) and an RSDatagramOut (the
/// sealed UDP packets, kind 0x02), both on the same datagrams. `raw` sends one datagram towards the other Mac (through the TURN
/// allocation on each Mac).
final class RSRelayPipe: RSStream, RSDatagramOut {
  private let q: DispatchQueue
  fileprivate let raw: (Data) -> Void
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

// MARK: finding each other over the private vault channel

/// The two Macs' meeting point. `send` and `onMessage` carry {"to": "primary" | "secondary", "env": signed envelope}.
protocol RSRelaySignal: AnyObject {
  func send(_ o: [String: Any])
  var onMessage: ([String: Any]) -> Void { get set }
}

/// WebView bridge to the private Second Computer channel. Native code still validates device signatures.
final class RSVaultRelaySignal: RSRelaySignal {
  private let emit: ([String: Any]) -> Void
  var onMessage: ([String: Any]) -> Void = { _ in }

  init(send: @escaping ([String: Any]) -> Void) { emit = send }
  func send(_ message: [String: Any]) { emit(message) }
}

enum RSRelayCredentialsError: String, Error { case setup, network, signIn = "sign-in" }
typealias RSRelayCredentials = (@escaping (Result<RSTurnCreds, RSRelayCredentialsError>) -> Void) -> Void

/// RFC 8656 framing for STUN and ChannelData on a TCP/TLS stream.
struct RSTurnFramer {
  private var buffered = Data()

  mutating func append(_ data: Data) -> [Data]? {
    buffered.append(data)
    var messages: [Data] = []
    while buffered.count >= 4 {
      let start = buffered.startIndex
      let kind = buffered[start] & 0xC0
      let payload = Int(buffered[start + 2]) * 256 + Int(buffered[start + 3])
      let size: Int, consumed: Int
      switch kind {
      case 0:
        guard payload % 4 == 0 else { return nil }
        size = 20 + payload
        consumed = size
      case 0x40:
        size = 4 + payload
        consumed = (size + 3) & ~3
      default: return nil
      }
      guard buffered.count >= consumed else { break }
      messages.append(Data(buffered.prefix(size)))
      buffered.removeFirst(consumed)
    }
    return messages
  }

  static func frame(_ data: Data) -> Data {
    guard let first = data.first, first & 0xC0 == 0x40 else { return data }
    let pad = (4 - data.count % 4) % 4
    return data + Data(repeating: 0, count: pad)
  }
}

private final class RSTurnTLS {
  private let connection: NWConnection
  private let q: DispatchQueue
  private var framer = RSTurnFramer()
  var packet: (Data) -> Void = { _ in }
  var lost: () -> Void = {}
  private var pendingBytes = 0
  private var ended = false

  init(host: String, port: NWEndpoint.Port, q: DispatchQueue) {
    self.q = q
    connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tls)
  }

  func start(ready: @escaping () -> Void) {
    connection.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready: self.receive(); ready()
      case .failed, .cancelled: self.fail()
      default: break
      }
    }
    connection.start(queue: q)
  }

  private func receive() {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, end, error in
      guard let self, !self.ended else { return }
      if let data {
        guard let packets = self.framer.append(data) else { self.fail(); return }
        for packet in packets { self.packet(packet) }
      }
      if end || error != nil { self.fail() } else { self.receive() }
    }
  }

  func send(_ data: Data) {
    // A stalled TCP relay must not queue old video without bound. Reliable control retries independently.
    guard !ended, pendingBytes < 256 * 1024 else { return }
    let frame = RSTurnFramer.frame(data)
    let count = frame.count
    pendingBytes += count
    connection.send(content: frame, completion: .contentProcessed { [weak self] error in
      guard let self else { return }
      self.pendingBytes -= count
      if error != nil { self.fail() }
    })
  }

  private func fail() {
    guard !ended else { return }
    close()
    lost()
  }

  func close() {
    ended = true
    connection.stateUpdateHandler = nil
    connection.cancel()
  }
}

/// Owns the allocation and its socket. Both Macs try the HTTPS port first, then TURN over UDP.
private final class RSTurnAllocation {
  private let q: DispatchQueue
  private var transportEnd: () -> Void = {}
  private var generation = 0
  private var ended = false
  private(set) var client: RSTurnClient?
  var log: (String) -> Void = { _ in }
  var lost: () -> Void = {}

  init(q: DispatchQueue) { self.q = q }

  func start(_ creds: RSTurnCreds, loopback: Bool, done: @escaping (RSAddr?) -> Void) {
    let tls = loopback ? nil : creds.tls443
    if let tls {
      tryTLS(host: tls, creds: creds) { [weak self] addr in
        if let addr { done(addr) } else { self?.tryUDP(creds, servers: creds.udpServers, loopback: loopback, done: done) }
      }
    } else {
      tryUDP(creds, servers: creds.udpServers, loopback: loopback, done: done)
    }
  }

  private func tryTLS(host: String, creds: RSTurnCreds, done: @escaping (RSAddr?) -> Void) {
    guard !ended else { return }
    generation += 1
    let attempt = generation
    let stream = RSTurnTLS(host: host, port: 443, q: q)
    let turn = RSTurnClient(username: creds.username, password: creds.credential, q: q, stream: true, send: stream.send)
    client = turn
    transportEnd = stream.close
    stream.packet = { [weak turn] in turn?.input($0) }
    turn.log = log
    turn.onLost = { [weak self] _ in self?.lost() }
    var allocated = false
    let failed: () -> Void = { [weak self] in
      guard let self, !self.ended, self.generation == attempt else { return }
      if allocated { self.lost(); return }
      self.reset()
      done(nil)
    }
    stream.lost = failed
    stream.start { [weak turn] in
      turn?.allocate { result in
        if case .success(let addr) = result { allocated = true; done(addr) } else { failed() }
      }
    }
    q.asyncAfter(deadline: .now() + 6) { if !allocated { failed() } }
  }

  private func tryUDP(_ creds: RSTurnCreds, servers: [(String, UInt16)], loopback: Bool, done: @escaping (RSAddr?) -> Void) {
    guard !ended else { return }
    guard let (host, port) = servers.first else { done(nil); return }
    generation += 1
    let attempt = generation
    let remaining = Array(servers.dropFirst())
    let next: () -> Void = { [weak self] in self?.tryUDP(creds, servers: remaining, loopback: loopback, done: done) }
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      let server = RSResolve.ipv4(host, port: port)
      self.q.async {
        guard !self.ended, self.generation == attempt else { return }
        guard let server, let socket = RSUdpSocket(q: self.q, loopback: loopback) else { next(); return }
        let turn = RSTurnClient(server: server, username: creds.username, password: creds.credential, sock: socket, q: self.q)
        socket.onReceive = { [weak turn] data, from in if from == server { turn?.input(data) } }
        self.client = turn
        self.transportEnd = socket.close
        turn.log = self.log
        turn.onLost = { [weak self] _ in self?.lost() }
        turn.allocate { [weak self] result in
          guard let self, !self.ended, self.generation == attempt else { return }
          if case .success(let addr) = result { done(addr) } else { self.reset(); next() }
        }
      }
    }
  }

  private func reset() {
    generation += 1
    client?.close()
    client = nil
    transportEnd()
    transportEnd = {}
  }

  func close() {
    guard !ended else { return }
    ended = true
    reset()
  }
}

// MARK: the main Mac: connect through the relay

final class RSRelayDial {
  private let identity: SecondIdentity
  private let secondary: SecondPeer
  private let q: DispatchQueue
  private let signal: RSRelaySignal
  private let getCreds: RSRelayCredentials
  var loopback = false
  var timeout = 35.0
  var log: (String) -> Void = { _ in }
  var app = ""
  var now: () -> Double = { RSTime.nowMs }
  private var allocation: RSTurnAllocation?
  private var pipe: RSRelayPipe?
  private var client: RSClient?
  private var offer: SecondEnv?
  private var finished = false
  private var done: (Result<RSLink, RSClient.Fail>) -> Void = { _ in }

  init(identity: SecondIdentity, secondary: SecondPeer, q: DispatchQueue, signal: RSRelaySignal, credentials: @escaping RSRelayCredentials) {
    self.identity = identity; self.secondary = secondary; self.q = q; self.signal = signal; getCreds = credentials
  }

  func start(completion: @escaping (Result<RSLink, RSClient.Fail>) -> Void) {
    q.async { [self] in
      guard !finished else { return }
      done = completion
      q.asyncAfter(deadline: .now() + timeout) { [weak self] in self?.fail(.notFound, "no answer through the relay in time") }
      getCreds { [weak self] result in
        self?.q.async { [weak self] in
          guard let self, !self.finished else { return }
          switch result {
          case .success(let creds): self.allocate(creds)
          case .failure(let error): self.fail(.network(error.rawValue), "could not get relay credentials")
          }
        }
      }
    }
  }

  private func allocate(_ creds: RSTurnCreds) {
    let allocation = RSTurnAllocation(q: q)
    self.allocation = allocation
    allocation.log = log
    allocation.lost = { [weak self] in self?.fail(.network("network"), "relay allocation ended") }
    allocation.start(creds, loopback: loopback) { [weak self] relay in
      guard let self, !self.finished else { return }
      guard let relay, self.loopback || relay.isPublic else { self.fail(.network("network"), "could not open a relay allocation"); return }
      guard let offer = RSRelayRules.offer(identity: self.identity, to: self.secondary.device, relay: relay, nowMs: self.now()) else {
        self.fail(.refused("no key"), "could not sign the offer"); return
      }
      self.offer = offer
      self.signal.onMessage = { [weak self] message in
        guard let queue = self?.q else { return }
        queue.async { [weak self] in self?.heard(message) }
      }
      self.sendOffer()
    }
  }

  private func sendOffer() {
    guard !finished, pipe == nil, let offer else { return }
    signal.send(["to": "secondary", "env": offer.json])
    q.asyncAfter(deadline: .now() + 2) { [weak self] in self?.sendOffer() }
  }

  private func heard(_ m: [String: Any]) {
    guard !finished, pipe == nil, let offer, let allocation, let turn = allocation.client, let env = SecondEnv(m["env"]) else { return }
    switch RSRelayRules.checkAnswer(env, identity: identity, expected: secondary.device, offer: offer, nowMs: now(), allowLocal: loopback) {
    case .failure(let w): log("PS screen: an answer through the relay did not check out (\(w.why))")
    case .success(let peer):
      let p = RSRelayPipe(q: q) { [weak turn] data in turn?.send(data, to: peer) }
      pipe = p
      turn.onData = { [weak p] from, data in if from == peer { p?.input(data) } }
      allocation.lost = { [weak p] in p?.closeRelay() }
      p.onClosed = { allocation.close() }
      turn.permit(peer) { [weak self] ok in
        guard let self, !self.finished else { return }
        guard ok else { self.fail(.network("network"), "the relay refused the peer address"); return }
        turn.bind(peer)
      }
      p.onFirst = { [weak self, weak p] in
        guard let self, let p, !self.finished else { return }
        let client = RSClient(identity: self.identity, secondary: self.secondary, q: self.q, loopback: self.loopback)
        client.now = self.now; client.app = self.app; client.log = self.log
        self.client = client
        client.handshake(p, relay: p) { [weak self] result in
          guard let self else { if case .success(let link) = result { link.close("cancelled") }; return }
          switch result {
          case .success(let link):
            guard !self.finished else { link.close("cancelled"); return }
            self.finished = true
            self.done(.success(link))
          case .failure(let error): self.fail(error, "the handshake through the relay failed")
          }
        }
      }
    }
  }

  func cancel() { q.async { [self] in fail(.notFound, "cancelled") } }

  private func fail(_ f: RSClient.Fail, _ why: String) {
    guard !finished else { return }
    finished = true
    log("PS screen: \(why)")
    if let pipe { pipe.closeRelay() } else { allocation?.close() }
    done(.failure(f))
  }
}

// MARK: the second Mac

final class RSRelayAnswer {
  private let identity: SecondIdentity
  private let q: DispatchQueue
  private let server: RSServer
  private let signal: RSRelaySignal
  var credentials: RSRelayCredentials?
  var loopback = false
  var log: (String) -> Void = { _ in }
  var now: () -> Double = { RSTime.nowMs }
  private var current: RSRelayPipe?
  private var pending: RSTurnAllocation?
  private var activeOffer: SecondEnv?
  private var lastAnswer: (env: SecondEnv, deadline: Double)?
  private var stopped = false

  init(identity: SecondIdentity, server: RSServer, signal: RSRelaySignal, q: DispatchQueue) {
    self.identity = identity; self.server = server; self.signal = signal; self.q = q
    signal.onMessage = { [weak self] message in
      guard let queue = self?.q else { return }
      queue.async { [weak self] in self?.heard(message) }
    }
  }

  private func heard(_ message: [String: Any]) {
    guard !stopped, let env = SecondEnv(message["env"]) else { return }
    if let activeOffer, env.by == activeOffer.by && env.body == activeOffer.body && env.sig == activeOffer.sig {
      if let lastAnswer, now() < lastAnswer.deadline { send(lastAnswer.env) }
      return
    }
    switch RSRelayRules.checkOffer(env, identity: identity, nowMs: now(), allowLocal: loopback) {
    case .failure(let error): log("PS screen: refused an offer through the relay (\(error.why))")
    case .success(let (_, relay)):
      activeOffer = env
      lastAnswer = nil
      pending?.close(); pending = nil
      credentials? { [weak self] result in
        self?.q.async { [weak self] in
          guard let self, self.accepting(env) else { return }
          guard case .success(let creds) = result else { self.log("PS screen: could not get host relay credentials"); return }
          self.allocate(creds, offer: env, peer: relay)
        }
      }
    }
  }

  private func accepting(_ offer: SecondEnv) -> Bool { !stopped && activeOffer?.body == offer.body }

  private func allocate(_ creds: RSTurnCreds, offer: SecondEnv, peer: RSAddr) {
    let allocation = RSTurnAllocation(q: q)
    pending = allocation
    allocation.log = log
    allocation.start(creds, loopback: loopback) { [weak self, weak allocation] relayed in
      guard let self, let allocation, self.accepting(offer), self.pending === allocation else { return }
      guard let relayed, self.loopback || relayed.isPublic, let turn = allocation.client else { allocation.close(); self.pending = nil; return }
      turn.permit(peer) { [weak self, weak allocation, weak turn] ok in
        guard let self, let allocation, let turn, self.accepting(offer), self.pending === allocation else { return }
        self.pending = nil
        guard ok else { allocation.close(); return }
        turn.bind(peer)
        let p = RSRelayPipe(q: self.q) { [weak turn] in turn?.send($0, to: peer) }
        turn.onData = { [weak p] from, data in if from == peer { p?.input(data) } }
        allocation.lost = { [weak p] in p?.closeRelay() }
        p.onClosed = { allocation.close() }
        self.present(offer, address: relayed, pipe: p)
      }
    }
  }

  private func send(_ env: SecondEnv) { signal.send(["to": "primary", "env": env.json]) }

  private func present(_ offer: SecondEnv, address: RSAddr, pipe: RSRelayPipe) {
    guard accepting(offer), let answer = RSRelayRules.answer(identity: identity, offer: offer, pub: address, nowMs: now()) else {
      pipe.closeRelay(); return
    }
    current?.closeRelay()
    current = pipe
    lastAnswer = (answer, now() + 30_000)
    send(answer)
    punch(pipe, attempts: 100)
    server.accept(stream: pipe, relay: pipe)
  }

  private func punch(_ pipe: RSRelayPipe, attempts: Int) {
    guard !stopped, current === pipe, !pipe.heard, attempts > 0 else { return }
    pipe.raw(Data([RSRelayRules.kindPunch]))
    q.asyncAfter(deadline: .now() + 0.15) { [weak self, weak pipe] in
      if let pipe { self?.punch(pipe, attempts: attempts - 1) }
    }
  }

  func stop() {
    q.async { [self] in
      stopped = true
      pending?.close(); pending = nil
      current?.closeRelay(); current = nil
      lastAnswer = nil
    }
  }
}
