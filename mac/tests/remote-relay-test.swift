// Unit and end to end tests for Remote screen from anywhere (PS 1.77): Sources/RemoteScreenRelayCore.swift and
// RemoteScreenRelay.swift, with the real link (RemoteScreenNet.swift), encoder and decoder.
// The relay is a STAND-IN made here (a small TURN server on 127.0.0.1 with the same long term passwords, permissions,
// channels and indications as RFC 8656); Cloudflare is never contacted, nothing is signed up for, no key is used.
// The two Macs' room is an in memory pair. No screen is captured, no input is posted, no window opens, nothing is played.
// Identities are FICTIONAL, made in a temporary folder, never the Keychain.
//   tests/remote-relay-test.sh
import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import Network

func psLog(_ s: String) {}
setvbuf(stdout, nil, _IONBF, 0)
var fails = 0
func check(_ name: String, _ ok: Bool) { print("\(name)=\(ok ? "ok" : "FAIL")"); if !ok { fails += 1 } }
func refused<T>(_ r: Result<T, SecondRefusal>) -> String? { if case .failure(let w) = r { return w.why }; return nil }
final class Box<T> { var v: T; init(_ v: T) { self.v = v } }
func waitFor(_ s: Double, _ cond: () -> Bool) -> Bool { let end = Date().addingTimeInterval(s); while Date() < end { if cond() { return true }; usleep(5_000) }; return cond() }

let fm = FileManager.default
let root = NSTemporaryDirectory() + "ps-relay-test-\(getpid())"
try? fm.removeItem(atPath: root)
try! fm.createDirectory(atPath: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(atPath: root) }
func ident(_ name: String) -> SecondIdentity { SecondIdentity(store: SecondFileStore(dir: root + "/" + name), seenPath: root + "/\(name)-seen.json") }
let m4 = ident("m4"), m1 = ident("m1"), stranger = ident("stranger")
let now = Date().timeIntervalSince1970 * 1000
m1.trust(SecondPeer(device: m4.device, name: "Test M4", pub: m4.pub, role: "primary", at: now))
m4.trust(SecondPeer(device: m1.device, name: "Test M1", pub: m1.pub, role: "secondary", at: now))
stranger.trust(SecondPeer(device: m1.device, name: "Test M1", pub: m1.pub, role: "secondary", at: now))
let m1AsPeer = m4.peer(m1.device)!, strangerSees = stranger.peer(m1.device)!

// ---------- STUN and TURN bytes ----------
do {
  check("stun-types", RSStun.type(RSStun.binding, .request) == 0x0001 && RSStun.type(RSStun.allocate, .success) == 0x0103
        && RSStun.type(RSStun.allocate, .error) == 0x0113 && RSStun.type(RSStun.send, .indication) == 0x0016 && RSStun.type(RSStun.data, .indication) == 0x0017
        && RSStun.type(RSStun.channelBind, .request) == 0x0009 && RSStun.method(of: 0x0113) == RSStun.allocate && RSStun.kind(of: 0x0113) == .error)
  check("crc32-known-value", RSStun.crc32(Data("123456789".utf8)) == 0xCBF4_3926)
  let a = RSAddr("203.0.113.7:3478")!
  check("xor-address-roundtrip", RSStun.unXorAddr(RSStun.xorAddr(a)) == a && RSStun.xorAddr(a) != Data([0, 1, 0x0d, 0x96, 203, 0, 113, 7]))
  var m = RSStun.Msg(RSStun.allocate, .request)
  m.add(RSStun.aUsername, Data("user".utf8)); m.add(RSStun.aRealm, Data("realm".utf8)); m.add(RSStun.aPeer, RSStun.xorAddr(a)); m.add(RSStun.aData, Data([1, 2, 3]))
  let key = RSStun.longTermKey(username: "user", realm: "realm", password: "pw")
  let raw = m.encode(key: key)
  let back = RSStun.decode(raw)
  check("stun-roundtrip", back?.type == m.type && back?.tid == m.tid && back?.attr(RSStun.aData) == Data([1, 2, 3]) && back?.attr(RSStun.aUsername) == Data("user".utf8) && raw.count % 4 == 0)
  check("stun-integrity-ok", RSStun.integrityOK(raw, key: key))
  var bad = raw; bad[bad.count - 30] ^= 1
  check("stun-integrity-tampered", !RSStun.integrityOK(bad, key: key) && !RSStun.integrityOK(raw, key: RSStun.longTermKey(username: "user", realm: "realm", password: "PW")))
  // The fingerprint: CRC-32 of everything before it, xor "STUN".
  let fp = back!.attr(RSStun.aFingerprint)!
  var r = RSReader(fp)
  var head = raw.prefix(raw.count - 8)
  let len = raw.count - 20; head[2] = UInt8(len >> 8); head[3] = UInt8(len & 0xff)
  check("stun-fingerprint", r.u32() == RSStun.crc32(Data(head)) ^ 0x5354_554E)
  var short = raw; short.removeLast(4)
  check("stun-refuses-bad", RSStun.decode(short) == nil && RSStun.decode(Data(repeating: 0, count: 19)) == nil && RSStun.decode(Data([0x40, 0, 0, 1, 9])) == nil)
  let cd = RSStun.channelData(0x4001, Data([9, 8, 7]))
  check("channeldata", RSStun.parseChannelData(cd).map { $0.0 == 0x4001 && $0.1 == Data([9, 8, 7]) } == true && RSStun.parseChannelData(RSStun.channelData(0x3000, Data())) == nil)
  check("addresses", RSAddr("1.2.3.4:5")?.description == "1.2.3.4:5" && RSAddr("1.2.3:5") == nil && RSAddr("1.2.3.4:0") == nil && RSAddr("256.1.1.1:1") == nil
        && RSAddr("8.8.8.8:1")!.isPublic && !RSAddr("10.0.0.1:1")!.isPublic && !RSAddr("192.168.1.2:1")!.isPublic && !RSAddr("127.0.0.1:1")!.isPublic
        && !RSAddr("100.64.0.1:1")!.isPublic && !RSAddr("172.20.0.1:1")!.isPublic && !RSAddr("169.254.1.1:1")!.isPublic)
}

// ---------- the reliable stream over a lossy, reordering, duplicating fake network ----------
do {
  let clock = Box(0.0)
  let a = RSReliable(), b = RSReliable()
  for x in [a, b] { x.now = { clock.v } ; x.begin() }
  var wire: [(at: Double, to: RSReliable, d: Data)] = []
  var rng = SystemRandomNumberGenerator()
  func net(_ to: RSReliable) -> (Data) -> Void {
    { d in
      if Double.random(in: 0..<1, using: &rng) < 0.2 { return }                       // 20% lost
      let delay = Double.random(in: 5...60, using: &rng)                                // reordered
      wire.append((clock.v + delay, to, d))
      if Double.random(in: 0..<1, using: &rng) < 0.05 { wire.append((clock.v + delay + 7, to, d)) }   // 5% twice
    }
  }
  a.output = net(b); b.output = net(a)
  var got = Data(); b.deliver = { got.append($0) }
  var back = Data(); a.deliver = { back.append($0) }
  var sent = Data(), done = 0, writes = 0
  for i in 0..<120 {
    let n = [1, 40, 1_100, 1_101, 5_000][i % 5]
    let d = Data((0..<n).map { _ in UInt8.random(in: 0...255) })
    sent.append(d); writes += 1
    a.write(d) { done += 1 }
  }
  b.write(Data("pong".utf8))
  while clock.v < 60_000 && (got.count < sent.count || done < writes) {
    clock.v += 5
    wire.sort { $0.at < $1.at }
    while let f = wire.first, f.at <= clock.v { wire.removeFirst(); f.to.input(f.d) }
    a.tick(); b.tick()
  }
  check("reliable-in-order-despite-loss", got == sent && back == Data("pong".utf8))
  check("reliable-done-callbacks", done == writes)
  check("reliable-resent-some", a.resent > 0 && !a.failed && !b.failed)
  print("reliable: \(sent.count) bytes in \(Int(clock.v)) simulated ms, \(a.segmentsOut) segments, \(a.resent) resent, rto \(Int(a.rto)) ms")
  // The other side goes quiet: the link is lost (never a hang).
  let why = Box<String?>(nil)
  a.onFail = { why.v = $0 }
  a.output = { _ in }; b.output = { _ in }
  a.write(Data([1]))
  for _ in 0..<4_000 { clock.v += 5; a.tick() }
  check("reliable-fails-when-quiet", a.failed && why.v != nil)
}

// ---------- the relay's rules ----------
do {
  var rr = RSRelayRules.rate(relayed: true)
  for _ in 0..<300 { _ = rr.feedback(loss: 0, latencyMs: 20) }
  var rd = RSRelayRules.rate(relayed: false)
  for _ in 0..<300 { _ = rd.feedback(loss: 0, latencyMs: 20) }
  check("relay-rate-capped-at-8mbps", rr.kbps == 8_000 && rr.maxKbps == 8_000 && RSRelayRules.rate(relayed: true).kbps <= 8_000)
  check("direct-rate-unchanged", rd.kbps == 60_000 && RSRate().kbps == 20_000)
  check("relay-picture-1920", RSRelayRules.width(2560, relayed: true) == 1920 && RSRelayRules.width(1280, relayed: true) == 1280 && RSRelayRules.width(2560, relayed: false) == 2560)
  // 8 Mbps all day, every day: inside the free 1,000 GB (Cloudflare bills what it sends to the main Mac, once).
  let gbMonth = Double(RSRelayRules.maxKbps) * 1000 / 8 * 3600 * 8 * 30 / 1e9
  check("relay-cap-fits-free-month", gbMonth < 1_000)
  // A relayed video packet with every header stays under 1280 bytes (no splitting inside the VPN app's tunnel).
  let frame = Data(repeating: 7, count: 50_000)
  let biggest = RSPacket.fragments(of: frame, number: 1, chunk: RSRelayRules.chunk).map(\.count).max()!
  let wire = 1 + biggest + 16 + 16 + 36 + 28   // kind, body, sid and counter, tag, TURN data indication, IP and UDP
  check("relay-packet-under-1280", wire < 1280)
  check("room-name", RSRelayRules.room(primary: m4.device, secondary: m1.device).count == 32 && RSRelayRules.room(primary: m4.device, secondary: m1.device) != RSRelayRules.room(primary: m1.device, secondary: m4.device)
        && !RSRelayRules.room(primary: m4.device, secondary: m1.device).contains(m1.device.prefix(8)))
  // The same signature as the Worker (workers/turn-creds/test: the same two vectors).
  let k = "test-relay-key-0123456789abcdefghijklmnop"
  check("worker-signature-vector", RSRelayRules.requestSignature(key: k, time: 1_764_000_000, method: "POST", path: "/creds", body: Data("{}".utf8)) == "ygD2z_GEt6sFQPCz3KKzW8A5xYwM_r3i8n2EUgWvy5c"
        && RSRelayRules.requestSignature(key: k, time: 1_764_000_000, method: "get", path: "/room/0123456789abcdef0123456789abcdef?role=secondary", body: Data()) == "AO6INzRCLfKsWMFDzP7R7matIuSH0d2FodqQ-DGGT5s")
  check("relay-key-and-url-rules", RSRelayRules.keyOK(k) && !RSRelayRules.keyOK("short") && !RSRelayRules.keyOK(k + " x")
        && RSRelayRules.workerURL("https://ps-relay.example.workers.dev") != nil && RSRelayRules.workerURL("http://ps-relay.example.workers.dev") == nil
        && RSRelayRules.workerURL("https://u:p@example.com") == nil && RSRelayRules.workerURL("https://example.com/?a=1") == nil)
  let cj = #"{"username":"u1","credential":"c1","ttl":86400,"urls":["stun:stun.cloudflare.com:3478","turn:turn.cloudflare.com:3478?transport=udp","turn:turn.cloudflare.com:3478?transport=tcp","turns:turn.cloudflare.com:5349?transport=tcp","turn:turn.cloudflare.com:53?transport=udp"]}"#
  let c = RSTurnCreds.parse(Data(cj.utf8))
  check("creds-parse", c?.username == "u1" && c?.credential == "c1" && c?.ttl == 86400 && c?.udpServers.map { "\($0.0):\($0.1)" } == ["turn.cloudflare.com:3478", "turn.cloudflare.com:53"]
        && RSTurnCreds.parse(Data(#"{"username":"","credential":"c","urls":["turn:x:1"]}"#.utf8)) == nil)
}

// ---------- signed offers and answers ----------
do {
  let t = Date().timeIntervalSince1970 * 1000
  let rel = RSAddr("198.51.100.20:50000")!
  let o = RSRelayRules.offer(identity: m4, to: m1.device, relay: rel, nowMs: t)!
  if case .success(let (p, a)) = RSRelayRules.checkOffer(o, identity: m1, nowMs: t) { check("offer-from-primary", p.device == m4.device && a == rel) } else { check("offer-from-primary", false) }
  check("offer-replay-refused", refused(RSRelayRules.checkOffer(o, identity: m1, nowMs: t)) == "Seen before")
  check("offer-stranger-refused", refused(RSRelayRules.checkOffer(RSRelayRules.offer(identity: stranger, to: m1.device, relay: rel, nowMs: t)!, identity: m1, nowMs: t)) == "Not your primary")
  check("offer-old-refused", refused(RSRelayRules.checkOffer(RSRelayRules.offer(identity: m4, to: m1.device, relay: rel, nowMs: t - 120_000)!, identity: m1, nowMs: t)) == "Too old")
  check("offer-wrong-mac-refused", refused(RSRelayRules.checkOffer(RSRelayRules.offer(identity: m4, to: stranger.device, relay: rel, nowMs: t)!, identity: m1, nowMs: t)) == "Not for this Mac")
  check("offer-private-relay-refused", refused(RSRelayRules.checkOffer(RSRelayRules.offer(identity: m4, to: m1.device, relay: RSAddr("192.168.1.9:4000")!, nowMs: t)!, identity: m1, nowMs: t)) == "Bad arguments")
  let pub = RSAddr("203.0.113.50:61000")!
  let o2 = RSRelayRules.offer(identity: m4, to: m1.device, relay: rel, nowMs: t)!
  _ = RSRelayRules.checkOffer(o2, identity: m1, nowMs: t)
  let ans = RSRelayRules.answer(identity: m1, offer: o2, pub: pub, nowMs: t)!
  check("answer-wrong-offer-refused", refused(RSRelayRules.checkAnswer(ans, identity: m4, expected: m1.device, offer: o, nowMs: t)) == "Not an answer to this offer")
  if case .success(let a) = RSRelayRules.checkAnswer(ans, identity: m4, expected: m1.device, offer: o2, nowMs: t) { check("answer-checks-out", a == pub) } else { check("answer-checks-out", false) }
  check("answer-replay-refused", refused(RSRelayRules.checkAnswer(ans, identity: m4, expected: m1.device, offer: o2, nowMs: t)) == "Seen before")
}

// ---------- the stand-in relay (a tiny TURN server on 127.0.0.1) ----------
final class StandInTurn {
  let q = DispatchQueue(label: "test.standin")
  let sock: RSUdpSocket
  let user: String, pass: String
  let realm = "stand-in.example", nonce = Data("nonce-0001".utf8)
  private struct Alloc { var relay: RSUdpSocket; var client: RSAddr; var key: Data; var perms: Set<[UInt8]> = []; var ch: [UInt16: RSAddr] = [:]; var byPeer: [RSAddr: UInt16] = [:] }
  private var allocs: [RSAddr: Alloc] = [:]
  private let lock = NSLock()
  /// What Cloudflare would bill: bytes the relay sent to TURN clients. And bytes it passed on to peers (not billed).
  private(set) var billed = 0, toPeers = 0, allocations = 0, dropped = 0, channelsBound = 0, permissions: [[UInt8]] = []
  var addr: RSAddr { RSAddr(ip: [127, 0, 0, 1], port: sock.port)! }
  var live: Int { lock.lock(); defer { lock.unlock() }; return allocs.count }

  init(user: String, pass: String) {
    self.user = user; self.pass = pass
    sock = RSUdpSocket(q: q, loopback: true)!
    sock.onReceive = { [weak self] d, from in self?.handle(d, from) }
  }
  private func out(_ d: Data, _ to: RSAddr) { billed += d.count; sock.send(d, to: to) }
  private func reply(_ req: RSStun.Msg, _ k: RSStun.Kind, _ attrs: [(UInt16, Data)], key: Data?, to: RSAddr) {
    var m = RSStun.Msg(req.method, k, tid: req.tid)
    for (t, v) in attrs { m.add(t, v) }
    out(m.encode(key: key), to)
  }
  private func err(_ req: RSStun.Msg, _ code: Int, to: RSAddr) {
    var e = RSWriter(); e.u16(0); e.u8(UInt8(code / 100)); e.u8(UInt8(code % 100)); e.bytes(Data("no".utf8))
    reply(req, .error, [(RSStun.aError, e.data), (RSStun.aRealm, Data(realm.utf8)), (RSStun.aNonce, nonce)], key: nil, to: to)
  }
  private func authed(_ m: RSStun.Msg, _ raw: Data) -> Data? {
    guard m.attr(RSStun.aUsername) == Data(user.utf8), m.attr(RSStun.aNonce) == nonce, m.attr(RSStun.aRealm) == Data(realm.utf8) else { return nil }
    let k = RSStun.longTermKey(username: user, realm: realm, password: pass)
    return RSStun.integrityOK(raw, key: k) ? k : nil
  }
  private func handle(_ d: Data, _ from: RSAddr) {
    lock.lock(); defer { lock.unlock() }
    if let f = d.first, (0x40...0x4F).contains(f) {
      guard let (ch, body) = RSStun.parseChannelData(d), let a = allocs[from], let peer = a.ch[ch], a.perms.contains(peer.ip) else { dropped += 1; return }
      toPeers += body.count; a.relay.send(body, to: peer); return
    }
    guard let m = RSStun.decode(d) else { dropped += 1; return }
    if m.kind == .indication && m.method == RSStun.send {
      guard let a = allocs[from], let peer = m.attr(RSStun.aPeer).flatMap(RSStun.unXorAddr), let body = m.attr(RSStun.aData), a.perms.contains(peer.ip) else { dropped += 1; return }
      toPeers += body.count; a.relay.send(body, to: peer); return
    }
    guard m.kind == .request else { return }
    if m.method == RSStun.binding { reply(m, .success, [(RSStun.aMapped, RSStun.xorAddr(from))], key: nil, to: from); return }
    guard let key = authed(m, d) else { err(m, 401, to: from); return }
    switch m.method {
    case RSStun.allocate:
      if allocs[from] != nil { err(m, 437, to: from); return }
      let relay = RSUdpSocket(q: q, loopback: true)!
      allocs[from] = Alloc(relay: relay, client: from, key: key)
      allocations += 1
      relay.onReceive = { [weak self] body, peer in
        guard let self else { return }
        self.lock.lock(); defer { self.lock.unlock() }
        guard let a = self.allocs[from], a.perms.contains(peer.ip) else { self.dropped += 1; return }   // only permitted peers
        if let ch = a.byPeer[peer] { self.out(RSStun.channelData(ch, body), from) }
        else { var i = RSStun.Msg(RSStun.data, .indication); i.add(RSStun.aPeer, RSStun.xorAddr(peer)); i.add(RSStun.aData, body); self.out(i.encode(), from) }
      }
      var lt = RSWriter(); lt.u32(600)
      reply(m, .success, [(RSStun.aRelayed, RSStun.xorAddr(RSAddr(ip: [127, 0, 0, 1], port: relay.port)!)), (RSStun.aMapped, RSStun.xorAddr(from)), (RSStun.aLifetime, lt.data)], key: key, to: from)
    case RSStun.refresh:
      guard allocs[from] != nil else { err(m, 437, to: from); return }
      if m.lifetime == 0 { allocs[from]?.relay.close(); allocs[from] = nil }
      var lt = RSWriter(); lt.u32(m.lifetime ?? 600)
      reply(m, .success, [(RSStun.aLifetime, lt.data)], key: key, to: from)
    case RSStun.createPermission:
      guard allocs[from] != nil, let peer = m.attr(RSStun.aPeer).flatMap(RSStun.unXorAddr) else { err(m, 400, to: from); return }
      allocs[from]!.perms.insert(peer.ip); permissions.append(peer.ip)
      reply(m, .success, [], key: key, to: from)
    case RSStun.channelBind:
      guard allocs[from] != nil, let peer = m.attr(RSStun.aPeer).flatMap(RSStun.unXorAddr), let c = m.attr(RSStun.aChannel), c.count == 4 else { err(m, 400, to: from); return }
      let ch = UInt16(c[c.startIndex]) << 8 | UInt16(c[c.startIndex + 1])
      allocs[from]!.ch[ch] = peer; allocs[from]!.byPeer[peer] = ch; allocs[from]!.perms.insert(peer.ip); channelsBound += 1
      reply(m, .success, [], key: key, to: from)
    default: err(m, 400, to: from)
    }
  }
  func stop() { lock.lock(); for a in allocs.values { a.relay.close() }; allocs = [:]; lock.unlock(); sock.close() }
}

/// The room, in memory: what one side sends, the other hears (as the Worker's room passes text on).
final class FakeRoom: RSRelaySignal {
  weak var other: FakeRoom?
  var onMessage: ([String: Any]) -> Void = { _ in }
  var sent = 0
  var mute = false
  func send(_ o: [String: Any]) {
    sent += 1
    guard !mute, let d = try? JSONSerialization.data(withJSONObject: o), let back = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }
    let o2 = other
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.02) { o2?.onMessage(back) }   // a little like the network
  }
  static func pair() -> (FakeRoom, FakeRoom) { let a = FakeRoom(), b = FakeRoom(); a.other = b; b.other = a; return (a, b) }
}

// ---------- end to end through the stand-in relay ----------
let q = DispatchQueue(label: "test.relay")
let turn = StandInTurn(user: "1700000000:test", pass: "fictional-test-password")
let creds = RSTurnCreds(username: turn.user, credential: turn.pass, urls: ["turn:\(turn.addr.host):\(turn.addr.port)?transport=udp"], ttl: 600)

// The TURN client alone: the 401 then the signed Allocate, and a wrong password refused.
do {
  let s = RSUdpSocket(q: q, loopback: true)!
  let t = RSTurnClient(server: turn.addr, username: turn.user, password: "wrong", sock: s, q: q)
  s.onReceive = { d, from in if from == turn.addr { t.input(d) } }
  let r = Box<Result<RSAddr, RSWhy>?>(nil)
  q.async { t.allocate { r.v = $0 } }
  _ = waitFor(5) { r.v != nil }
  if case .failure(let w)? = r.v { check("turn-wrong-password-refused", w.description == "the relay refused the password" && turn.live == 0) } else { check("turn-wrong-password-refused", false) }
  q.sync { t.close(); s.close() }
}

let server = RSServer(identity: m1, q: q, loopback: true)   // its direct listener is never started here: only the relay
let serverLink = Box<RSLink?>(nil), sender = Box<RSSender?>(nil), inputs = Box<[RSInput]>([])
server.onSession = { l in
  serverLink.v = l
  let s = RSSender(link: l); sender.v = s
  l.onCtl = { t, d in if s.handle(t, d) { return }; if t == .input, let i = RSInput.decode(d) { inputs.v.append(i) } }
}
let (roomPrimary, roomSecondary) = FakeRoom.pair()
let answer = RSRelayAnswer(identity: m1, server: server, signal: roomSecondary, q: q)
answer.loopback = true
answer.stun = { turn.addr }   // the stand-in answers STUN too (Cloudflare's STUN in real use)

// A stranger's offer through the room gets nothing back.
do {
  let (rs, rm) = FakeRoom.pair()
  let lonely = RSRelayAnswer(identity: m1, server: server, signal: rm, q: q)
  lonely.loopback = true; lonely.stun = { turn.addr }
  let d = RSRelayDial(identity: stranger, secondary: strangerSees, q: q, signal: rs) { $0(creds) }
  d.loopback = true; d.timeout = 3
  let r = Box<Result<RSLink, RSClient.Fail>?>(nil)
  d.start { r.v = $0 }
  _ = waitFor(6) { r.v != nil }
  if case .failure(.notFound)? = r.v { check("relay-stranger-gets-no-answer", rm.sent == 0 && serverLink.v == nil) } else { check("relay-stranger-gets-no-answer", false) }
  _ = waitFor(2) { turn.live == 0 }
  check("relay-given-back-after-failure", turn.live == 0)
  _ = lonely
}

// The paired main Mac, through the relay.
let clientLink = Box<RSLink?>(nil), receiver = Box<RSReceiver?>(nil)
let t0 = RSTime.nowNs
do {
  let d = RSRelayDial(identity: m4, secondary: m1AsPeer, q: q, signal: roomPrimary) { $0(creds) }
  d.loopback = true
  let r = Box<Result<RSLink, RSClient.Fail>?>(nil)
  d.start { r.v = $0 }
  _ = waitFor(10) { r.v != nil }
  guard case .success(let l)? = r.v else { check("relay-handshake", false); print("FAILED \(fails + 1)"); exit(1) }
  check("relay-handshake", waitFor(3) { serverLink.v != nil })
  print("relay: connected in \(String(format: "%.0f", Double(RSTime.nowNs - t0) / 1e6)) ms (Allocate, signed offer and answer, STUN, permission, signed hello and answer)")
  clientLink.v = l
  let rc = RSReceiver(link: l, q: q); receiver.v = rc
  rc.onImage = { _, f in rc.shown(f) }
  l.onCtl = { t, d in if rc.handle(t, d) { return }; if t == .screen, let i = try? JSONDecoder().decode(RSScreenInfo.self, from: d) { rc.configure(i) } }
  l.onUdp = { b in rc.udp(b) }
  q.async { l.start(); rc.start() }
  _ = d
}
check("relay-link-kind", clientLink.v?.kindName == "relay" && serverLink.v?.kindName == "relay" && clientLink.v?.relayed == true && serverLink.v?.relayed == true && clientLink.v?.tcp == nil)
check("relay-one-allocation-one-permission", turn.allocations == 2 && turn.live == 1 && turn.permissions.allSatisfy { $0 == [127, 0, 0, 1] })   // 2: the stranger's try, given back
check("relay-sender-capped", sender.v?.rate.maxKbps == 8_000 && (sender.v?.rate.kbps ?? 99_999) <= 8_000)

func makePool(_ w: Int, _ h: Int) -> CVPixelBufferPool {
  var p: CVPixelBufferPool?
  let attrs: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h,
                              kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
  CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &p)
  return p!
}
/// A made up picture that changes every frame (a moving band and noise, so the encoder has real work).
func picture(_ pool: CVPixelBufferPool, _ i: Int) -> CVPixelBuffer {
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
  let b = pb!
  CVPixelBufferLockBaseAddress(b, [])
  let h = CVPixelBufferGetHeightOfPlane(b, 0), bpr = CVPixelBufferGetBytesPerRowOfPlane(b, 0)
  let y = CVPixelBufferGetBaseAddressOfPlane(b, 0)!.assumingMemoryBound(to: UInt8.self)
  for row in 0..<h { let v = UInt8((row + i * 8) & 0xff); memset(y + row * bpr, Int32(v), bpr) }
  for k in 0..<2_000 { y[(k * 7919 + i * 104_729) % (h * bpr)] = UInt8.random(in: 0...255) }
  let ch = CVPixelBufferGetHeightOfPlane(b, 1), cbpr = CVPixelBufferGetBytesPerRowOfPlane(b, 1)
  memset(CVPixelBufferGetBaseAddressOfPlane(b, 1)!, 128, ch * cbpr)
  CVPixelBufferUnlockBaseAddress(b, [])
  return b
}

// The picture through the relay: 1920 wide (the relay's size), 60 fps, sealed packets only.
do {
  guard let s = sender.v, let rc = receiver.v, let sl = serverLink.v else { exit(1) }
  let (w, h) = (1920, 1200)
  let info = s.configure(width: w, height: h, points: CGSize(width: 1440, height: 900))!
  sl.sendJSON(.screen, info)
  _ = waitFor(3) { rc.clock.offset != nil && rc.info != nil }
  let pool = makePool(w, h)
  let billedBefore = turn.billed, sentBefore = sl.counts.bytes
  let n = 4 * 60
  let start = Date()
  for i in 0..<n {
    s.frame(picture(pool, i), pts: CMTime(value: Int64(i), timescale: 60), captureNs: RSTime.nowNs)
    let wait = start.addingTimeInterval(Double(i + 1) / 60).timeIntervalSinceNow; if wait > 0 { usleep(useconds_t(wait * 1e6)) }
  }
  _ = waitFor(2) { rc.framesShown >= n - 2 }
  let st = Box(RSStats()); q.sync { st.v = rc.total }
  check("relay-frames", rc.framesShown >= n * 95 / 100)
  check("relay-latency-under-80ms", (st.v.p95 ?? 999) < 80)
  check("relay-bitrate-held-to-8mbps", s.rate.kbps <= 8_000 && (s.encoder?.kbps ?? 99_999) <= 8_000)
  let video = sl.counts.bytes - sentBefore, billed = turn.billed - billedBefore
  // Billed once: what the relay sends to the main Mac is the video plus the relay's own small header, never twice.
  check("relay-billed-once", video > 100_000 && Double(billed) < Double(video) * 1.10 && Double(billed) > Double(video) * 0.95)
  check("relay-uses-a-channel", turn.channelsBound >= 1)
  print("relay-video: \(rc.framesShown) of \(n) frames; capture to decoded \(st.v.line) ms; \(video / 1000) kB sealed video, \(billed / 1000) kB a real relay would bill, \(turn.toPeers / 1000) kB to the second Mac (not billed); bitrate \(s.rate.kbps / 1000) Mbps")
}

// Input through the relay, in order.
do {
  guard let cl = clientLink.v else { exit(1) }
  let evs: [RSInput] = (0..<200).map { .move(x: Float($0) / 200, y: 0.5, buttons: 0) } + [.down(x: 0.5, y: 0.5, button: 0, clicks: 1, flags: 0), .up(x: 0.5, y: 0.5, button: 0, clicks: 1, flags: 0), .key(code: 0, down: true, flags: 0, repeating: false), .releaseAll]
  for e in evs { cl.send(.input, e.encode()); usleep(500) }
  check("relay-input-in-order", waitFor(3) { inputs.v.count == evs.count } && inputs.v == evs)
}

// A forged packet (right session id, wrong key) is dropped; a stranger sending to the relay address is never let through.
do {
  guard let sl = serverLink.v else { exit(1) }
  let before = sl.counts.udpBad
  let forged = RSSealer(SymmetricKey(size: .bits256)).sealUDP(RSPacket.hello(clockNs: 1), sid: sl.keys.sid)!
  check("relay-forged-dropped", !sl.openUDP(forged) && sl.counts.udpBad == before + 1)
}

// bye ends both sides and gives the relay address back at once (nothing more can be billed).
do {
  guard let l = clientLink.v else { exit(1) }
  let closed = Box(false)
  serverLink.v?.onClose = { _ in closed.v = true }
  receiver.v?.stop()
  l.bye()
  check("relay-bye-closes-both", waitFor(3) { closed.v && l.isClosed })
  check("relay-allocation-given-back", waitFor(3) { turn.live == 0 })
}
answer.stop()
turn.stop()

print(fails == 0 ? "ALL OK" : "FAILED \(fails)")
exit(fails == 0 ? 0 : 1)
