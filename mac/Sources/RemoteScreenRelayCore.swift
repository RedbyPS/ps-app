import CryptoKit
import Foundation

// Remote screen from anywhere (PS 1.77), the plain rules: values and bytes only, no network, so tests/remote-screen-test.swift
// checks every rule here. The network half is RemoteScreenRelay.swift.
//
// The developer's two Macs never share a network and both run the VPN app, so a direct link cannot be made between them. PS then goes
// through a relay (Cloudflare Realtime TURN, RFC 8656): the main Mac asks Cloudflare for a relay address (an "allocation"),
// lets ONLY the second Mac's internet address in (a "permission"), and the second Mac sends straight to that address. Both Macs
// dial out; nothing listens on the internet. The relay passes on packets that PS already sealed (AES-256-GCM, keys from the
// pairing and a fresh X25519 per session, RemoteScreenCore.swift): it never sees the picture, the keys or a key press.
// One Mac holds the allocation and the other sends to it, so the picture is billed once (Cloudflare bills only what it sends
// to a TURN client).
// Never Supabase: the two Macs find each other through the small relay Worker's room (workers/turn-creds in web),
// with offers and answers signed by the paired device keys. Nothing here changes a network, firewall or VPN setting.

// MARK: addresses

/// An IPv4 address and port (Cloudflare's relay addresses are IPv4 only).
struct RSAddr: Hashable, CustomStringConvertible {
  var ip: [UInt8]
  var port: UInt16
  init?(ip: [UInt8], port: UInt16) { guard ip.count == 4 else { return nil }; self.ip = ip; self.port = port }
  /// "a.b.c.d:port"
  init?(_ s: String) {
    let parts = s.split(separator: ":", omittingEmptySubsequences: false)
    guard parts.count == 2, let p = UInt16(parts[1]), p > 0 else { return nil }
    let o = parts[0].split(separator: ".", omittingEmptySubsequences: false)
    guard o.count == 4 else { return nil }
    var b: [UInt8] = []
    for x in o { guard x.count <= 3, x.allSatisfy({ $0.isASCII && $0.isNumber }), let v = UInt8(x) else { return nil }; b.append(v) }
    ip = b; port = p
  }
  var host: String { ip.map(String.init).joined(separator: ".") }
  var description: String { "\(host):\(port)" }
  /// An address the internet can reach: not private, loopback, link local, CGNAT, multicast or reserved.
  var isPublic: Bool {
    let a = ip[0], b = ip[1]
    if a == 0 || a == 10 || a == 127 || a >= 224 { return false }
    if a == 169 && b == 254 { return false }
    if a == 172 && (16...31).contains(b) { return false }
    if a == 192 && b == 168 { return false }
    if a == 100 && (64...127).contains(b) { return false }
    return true
  }
}

// MARK: STUN and TURN messages (RFC 8489, RFC 8656)

enum RSStun {
  static let cookie: UInt32 = 0x2112_A442
  // Methods.
  static let binding: UInt16 = 0x001, allocate: UInt16 = 0x003, refresh: UInt16 = 0x004, send: UInt16 = 0x006, data: UInt16 = 0x007
  static let createPermission: UInt16 = 0x008, channelBind: UInt16 = 0x009
  // Classes.
  enum Kind: UInt16 { case request = 0x000, indication = 0x010, success = 0x100, error = 0x110 }
  static func type(_ method: UInt16, _ k: Kind) -> UInt16 {
    (method & 0x000F) | ((method & 0x0070) << 1) | ((method & 0x0F80) << 2) | k.rawValue
  }
  static func method(of t: UInt16) -> UInt16 { (t & 0x000F) | ((t & 0x00E0) >> 1) | ((t & 0x3E00) >> 2) }
  static func kind(of t: UInt16) -> Kind { Kind(rawValue: t & 0x0110) ?? .request }
  // Attributes.
  static let aUsername: UInt16 = 0x0006, aIntegrity: UInt16 = 0x0008, aError: UInt16 = 0x0009, aChannel: UInt16 = 0x000C
  static let aLifetime: UInt16 = 0x000D, aPeer: UInt16 = 0x0012, aData: UInt16 = 0x0013, aRealm: UInt16 = 0x0014, aNonce: UInt16 = 0x0015
  static let aRelayed: UInt16 = 0x0016, aTransport: UInt16 = 0x0019, aMapped: UInt16 = 0x0020, aSoftware: UInt16 = 0x8022, aFingerprint: UInt16 = 0x8028

  struct Msg {
    var type: UInt16
    var tid: Data
    var attrs: [(UInt16, Data)] = []
    init(_ method: UInt16, _ k: Kind, tid: Data = RSStun.newTid()) { type = RSStun.type(method, k); self.tid = tid }
    init(type: UInt16, tid: Data, attrs: [(UInt16, Data)]) { self.type = type; self.tid = tid; self.attrs = attrs }
    var method: UInt16 { RSStun.method(of: type) }
    var kind: Kind { RSStun.kind(of: type) }
    func attr(_ t: UInt16) -> Data? { attrs.first { $0.0 == t }?.1 }
    mutating func add(_ t: UInt16, _ v: Data) { attrs.append((t, v)) }
    mutating func add(_ t: UInt16, u32 v: UInt32) { var w = RSWriter(); w.u32(v); attrs.append((t, w.data)) }
    /// The error code (e.g. 401, 438), if any.
    var errorCode: Int? {
      guard let e = attr(RSStun.aError), e.count >= 4 else { return nil }
      return Int(e[e.startIndex + 2] & 0x7) * 100 + Int(e[e.startIndex + 3])
    }
    var lifetime: UInt32? { attr(RSStun.aLifetime).flatMap { var r = RSReader($0); return r.u32() } }

    /// Bytes on the wire. With `key`: MESSAGE-INTEGRITY (HMAC-SHA1 over the message so far, with the length already counting
    /// it), then FINGERPRINT (CRC-32 xor "STUN").
    func encode(key: Data? = nil, fingerprint: Bool = true) -> Data {
      var body = Data()
      for (t, v) in attrs { body.append(RSStun.attr(t, v)) }
      func head(_ len: Int) -> Data { var w = RSWriter(capacity: 20); w.u16(type); w.u16(UInt16(len)); w.u32(RSStun.cookie); w.bytes(tid); return w.data }
      var out = head(body.count) + body
      if let key {
        let lenWith = body.count + 24
        let mac = RSStun.hmacSHA1(key: key, head(lenWith) + body)
        body.append(RSStun.attr(RSStun.aIntegrity, mac))
        out = head(body.count) + body
      }
      if fingerprint {
        let lenWith = body.count + 8
        let crc = RSStun.crc32(head(lenWith) + body) ^ 0x5354_554E
        var w = RSWriter(); w.u32(crc)
        body.append(RSStun.attr(RSStun.aFingerprint, w.data))
        out = head(body.count) + body
      }
      return out
    }
  }

  static func attr(_ t: UInt16, _ v: Data) -> Data {
    var w = RSWriter(capacity: v.count + 8); w.u16(t); w.u16(UInt16(v.count)); w.bytes(v)
    let pad = (4 - v.count % 4) % 4
    for _ in 0..<pad { w.u8(0) }
    return w.data
  }

  static func newTid() -> Data { var b = [UInt8](repeating: 0, count: 12); for i in 0..<12 { b[i] = UInt8.random(in: 0...255) }; return Data(b) }

  /// A first byte of 0 or 1 (the two top bits zero) means STUN; 0x40 to 0x4F means ChannelData (RFC 8656 section 12).
  static func looksLikeStun(_ d: Data) -> Bool { d.count >= 20 && d[d.startIndex] & 0xC0 == 0 }

  /// Strict: the cookie, a length that fits and is a multiple of 4, attributes that fit. nil for anything else.
  static func decode(_ d: Data) -> Msg? {
    guard looksLikeStun(d) else { return nil }
    var r = RSReader(d)
    guard let t = r.u16(), let len = r.u16(), r.u32() == cookie, let tid = r.bytes(12) else { return nil }
    guard Int(len) % 4 == 0, Int(len) == d.count - 20 else { return nil }
    var attrs: [(UInt16, Data)] = []
    while r.left >= 4 {
      guard let at = r.u16(), let al = r.u16(), let v = r.bytes(Int(al)) else { return nil }
      attrs.append((at, v))
      let pad = (4 - Int(al) % 4) % 4
      guard r.bytes(pad) != nil else { return nil }
    }
    guard r.left == 0 else { return nil }
    return Msg(type: t, tid: tid, attrs: attrs)
  }

  /// MESSAGE-INTEGRITY checks out for `key` (the attribute's place found in the raw bytes, the length set as the sender had it).
  static func integrityOK(_ raw: Data, key: Data) -> Bool {
    guard raw.count >= 20 else { return false }
    var at = 20
    let b = [UInt8](raw)
    while at + 4 <= b.count {
      let t = UInt16(b[at]) << 8 | UInt16(b[at + 1]), l = Int(UInt16(b[at + 2]) << 8 | UInt16(b[at + 3]))
      if t == aIntegrity {
        guard l == 20, at + 24 <= b.count else { return false }
        var m = Data(b[0..<at])
        let lenWith = at - 20 + 24
        m[2] = UInt8(lenWith >> 8); m[3] = UInt8(lenWith & 0xff)
        let want = hmacSHA1(key: key, m)
        return constantTimeEqual(want, Data(b[(at + 4)..<(at + 24)]))
      }
      at += 4 + l + (4 - l % 4) % 4
    }
    return false
  }

  static func constantTimeEqual(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var x: UInt8 = 0
    for (p, q) in zip(a, b) { x |= p ^ q }
    return x == 0
  }

  /// The long term credential key (RFC 8489 section 9.2.2): MD5 of "username:realm:password".
  static func longTermKey(username: String, realm: String, password: String) -> Data {
    Data(Insecure.MD5.hash(data: Data("\(username):\(realm):\(password)".utf8)))
  }
  static func hmacSHA1(key: Data, _ m: Data) -> Data { Data(HMAC<Insecure.SHA1>.authenticationCode(for: m, using: SymmetricKey(data: key))) }

  private static let crcTable: [UInt32] = (0..<256).map { i -> UInt32 in
    var c = UInt32(i)
    for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
    return c
  }
  static func crc32(_ d: Data) -> UInt32 {
    var c: UInt32 = 0xFFFF_FFFF
    for b in d { c = crcTable[Int((c ^ UInt32(b)) & 0xff)] ^ (c >> 8) }
    return c ^ 0xFFFF_FFFF
  }

  /// XOR-MAPPED-ADDRESS, XOR-RELAYED-ADDRESS and XOR-PEER-ADDRESS, IPv4.
  static func xorAddr(_ a: RSAddr) -> Data {
    var w = RSWriter(capacity: 8); w.u8(0); w.u8(1)
    w.u16(a.port ^ UInt16(cookie >> 16))
    let c = [UInt8(cookie >> 24), UInt8(cookie >> 16 & 0xff), UInt8(cookie >> 8 & 0xff), UInt8(cookie & 0xff)]
    for i in 0..<4 { w.u8(a.ip[i] ^ c[i]) }
    return w.data
  }
  static func unXorAddr(_ d: Data) -> RSAddr? {
    var r = RSReader(d)
    guard r.u8() != nil, r.u8() == 1, let xp = r.u16(), let xa = r.bytes(4), r.left == 0 else { return nil }   // IPv4 only
    let c = [UInt8(cookie >> 24), UInt8(cookie >> 16 & 0xff), UInt8(cookie >> 8 & 0xff), UInt8(cookie & 0xff)]
    return RSAddr(ip: (0..<4).map { xa[xa.startIndex + $0] ^ c[$0] }, port: xp ^ UInt16(cookie >> 16))
  }

  /// ChannelData: [u16 channel 0x4000 to 0x4FFF][u16 length][data] (UDP: no padding).
  static func channelData(_ ch: UInt16, _ d: Data) -> Data { var w = RSWriter(capacity: d.count + 4); w.u16(ch); w.u16(UInt16(d.count)); w.bytes(d); return w.data }
  static func parseChannelData(_ d: Data) -> (UInt16, Data)? {
    var r = RSReader(d)
    guard let ch = r.u16(), (0x4000...0x4FFF).contains(ch), let len = r.u16(), let body = r.bytes(Int(len)) else { return nil }
    return (ch, body)
  }
}

// MARK: a reliable, in order byte stream over datagrams (the controls and the handshake through the relay)

/// TURN relays datagrams only (Cloudflare has no TCP allocations), so the link's TCP part (the signed handshake, input, the
/// pointer's shape, pings, commands) rides on this over the relay: numbered segments, a cumulative ack with a 64 segment
/// selective ack, resends on a timer from the measured round trip, delivery strictly in order. The bytes it carries are the
/// same sealed TCP frames as on a direct link (RSLink), so a lost, repeated or reordered segment never reaches the opener.
/// No network and no clock of its own: `now`, `output` and `tick` come from outside, so the test drives it with a lossy fake.
final class RSReliable {
  static let kindData: UInt8 = 0x01, kindAck: UInt8 = 0x03
  static let headerBytes = 17
  /// Payload per segment: with the header, the relay's overhead and the seal it stays well under the VPN app's 1380 byte MTU.
  static let mss = 1_100
  let window: Int
  /// Unacked this long, or nothing heard this long: the link is lost (ms).
  var failAfterMs: Double = 10_000, silenceMs: Double = 8_000
  var now: () -> Double = { RSTime.nowMs }
  /// One datagram out (already starts with the kind byte).
  var output: (Data) -> Void = { _ in }
  /// Bytes in order.
  var deliver: (Data) -> Void = { _ in }
  var onFail: (String) -> Void = { _ in }

  private struct Seg { var data: Data; var sentAt: Double; var first: Double; var tries: Int; var sacked = false; var end: UInt64 }
  private var nextSeq: UInt32 = 0
  private var sndUna: UInt32 = 0
  private var inflight: [UInt32: Seg] = [:]
  private var pending = Data()
  private var queuedBytes: UInt64 = 0, ackedBytes: UInt64 = 0
  private var dones: [(UInt64, () -> Void)] = []
  private var srtt: Double?, rttvar = 0.0
  private(set) var rto = 200.0
  private var rcvNext: UInt32 = 0
  private var ooo: [UInt32: Data] = [:]
  private var lastHeard: Double = 0, lastSent: Double = 0
  private(set) var failed = false
  private(set) var resent = 0, segmentsOut = 0

  init(window: Int = 256) { self.window = window; lastHeard = RSTime.nowMs; lastSent = lastHeard }
  /// Starts the silence clock from the injected `now` (call once after setting it).
  func begin() { lastHeard = now(); lastSent = lastHeard }

  static func before(_ a: UInt32, _ b: UInt32) -> Bool { a != b && (b &- a) < 0x8000_0000 }

  var inFlight: Int { inflight.count }
  var backlog: Int { pending.count + inflight.values.reduce(0) { $0 + $1.data.count } }

  /// Queues bytes; `done` runs once the other side has them all.
  func write(_ d: Data, done: @escaping () -> Void = {}) {
    guard !failed else { return }
    pending.append(d)
    queuedBytes += UInt64(d.count)
    dones.append((queuedBytes, done))
    pump()
  }

  private func pump() {
    while inflight.count < window && !pending.isEmpty {
      let n = min(RSReliable.mss, pending.count)
      let piece = pending.prefix(n)
      pending = pending.count == n ? Data() : pending.subdata(in: (pending.startIndex + n)..<pending.endIndex)
      let s = nextSeq; nextSeq &+= 1
      let t = now()
      madeEnd += UInt64(n)
      inflight[s] = Seg(data: Data(piece), sentAt: t, first: t, tries: 1, end: madeEnd)
      emit(s)
    }
  }
  /// The stream offset at the end of the newest segment made so far.
  private var madeEnd: UInt64 = 0

  private func header(_ kind: UInt8, seq: UInt32) -> Data {
    var w = RSWriter(capacity: RSReliable.headerBytes + RSReliable.mss)
    w.u8(kind); w.u32(seq); w.u32(rcvNext)
    var sack: UInt64 = 0
    for (k, _) in ooo { let d = k &- rcvNext; if d >= 1 && d <= 64 { sack |= 1 << (d - 1) } }
    w.u64(sack)
    return w.data
  }

  private func emit(_ s: UInt32) {
    guard var g = inflight[s] else { return }
    var d = header(RSReliable.kindData, seq: s); d.append(g.data)
    g.sentAt = now(); inflight[s] = g
    lastSent = g.sentAt; segmentsOut += 1
    output(d)
  }

  private func sendAck() { lastSent = now(); output(header(RSReliable.kindAck, seq: 0)) }

  /// One datagram from the other side (starting with the kind byte). False: not a segment.
  @discardableResult
  func input(_ d: Data) -> Bool {
    guard !failed else { return true }
    var r = RSReader(d)
    guard let k = r.u8(), k == RSReliable.kindData || k == RSReliable.kindAck, let seq = r.u32(), let ack = r.u32(), let sack = r.u64() else { return false }
    let t = now()
    lastHeard = t
    // Their acks: everything before `ack`, and the ones marked after it.
    for (s, g) in inflight where RSReliable.before(s, ack) {
      // A round trip only from the segment this ack is for (a segment acked in bulk, after a lost one before it was resent,
      // waited for that resend and would make the round trip look far longer than it is). Never from a resent one (Karn).
      if g.tries == 1 && s == ack &- 1 && !g.sacked { sample(t - g.sentAt) }
      inflight[s] = nil
    }
    if RSReliable.before(sndUna, ack) || sndUna == ack { sndUna = ack }
    if sack != 0 {
      for i in 0..<64 where sack & (1 << UInt64(i)) != 0 {
        let s = ack &+ UInt32(i) &+ 1
        if var g = inflight[s], !g.sacked { if g.tries == 1 { sample(t - g.sentAt) }; g.sacked = true; inflight[s] = g }
      }
    }
    // Bytes the other side has in order: every segment before the oldest still in flight.
    let upTo = inflight.values.map { $0.end - UInt64($0.data.count) }.min() ?? madeEnd
    if upTo > ackedBytes { ackedBytes = upTo }
    while let f = dones.first, f.0 <= ackedBytes { dones.removeFirst(); f.1() }
    if k == RSReliable.kindData {
      let body = r.rest()
      if seq == rcvNext {
        rcvNext &+= 1
        deliver(body)
        while let next = ooo.removeValue(forKey: rcvNext) { rcvNext &+= 1; deliver(next) }
      } else if RSReliable.before(rcvNext, seq) && (seq &- rcvNext) <= UInt32(window * 2) {
        if ooo[seq] == nil { ooo[seq] = body }
      }
      sendAck()
    }
    pump()
    return true
  }

  private func sample(_ ms: Double) {
    guard ms >= 0 else { return }
    if let s = srtt { rttvar = 0.75 * rttvar + 0.25 * abs(s - ms); srtt = 0.875 * s + 0.125 * ms } else { srtt = ms; rttvar = ms / 2 }
    rto = min(max(srtt! + 4 * rttvar + 10, 40), 1_000)
  }

  /// Call every 20 ms or so: resends, the keepalive, and the lost link check.
  func tick() {
    guard !failed else { return }
    let t = now()
    for (s, g) in inflight.sorted(by: { RSReliable.before($0.key, $1.key) }) where !g.sacked {
      if t - g.first > failAfterMs { fail("the relay stopped answering"); return }
      let wait = min(rto * pow(2, Double(min(g.tries - 1, 4))), 2_000)
      if t - g.sentAt >= wait { var x = g; x.tries += 1; inflight[s] = x; resent += 1; emit(s) }
    }
    if t - lastHeard > silenceMs { fail("nothing from the other Mac through the relay"); return }
    if t - lastSent > 1_000 { sendAck() }   // keepalive (also keeps the second Mac's NAT open)
  }

  func fail(_ why: String) { guard !failed else { return }; failed = true; inflight = [:]; pending = Data(); onFail(why) }
}

// MARK: the rules for a relayed link

enum RSRelayRules {
  /// Video bytes per packet through the relay (1300 direct): sealed, with the relay's own header, the datagram stays under
  /// 1280 bytes, so the VPN app's tunnel never has to split it.
  static let chunk = 1_100
  /// Through the relay the picture is at most 1920 wide and the bitrate at most 8 Mbps, so even a month of busy screens
  /// stays inside Cloudflare's free 1,000 GB (remote-anywhere-cost-177.md: 8 h a day, 30 days, 864 GB).
  static let maxWidth = 1_920
  static let maxKbps = 8_000
  static func width(_ chosen: Int, relayed: Bool) -> Int { relayed ? min(chosen, maxWidth) : chosen }
  static func rate(relayed: Bool) -> RSRate {
    guard relayed else { return RSRate() }
    var r = RSRate(startKbps: 6_000); r.minKbps = 2_000; r.maxKbps = maxKbps; return r
  }

  /// The datagram kinds on a relayed path (the first byte): a reliable segment (RSReliable), a sealed video or hello packet
  /// (RSLink's UDP), and the second Mac's "here I am" that opens the path through its NAT.
  static let kindVideo: UInt8 = 0x02, kindPunch: UInt8 = 0x04
  /// The relayed link ends (like TCP's close): sent twice, so the other Mac ends at once instead of after the silence.
  static let kindBye: UInt8 = 0x05

  /// The room both Macs meet in, at the relay Worker. A hash of the two device ids: the Worker never learns whose Macs they are.
  static func room(primary: String, secondary: String) -> String {
    let h = SHA256.hash(data: Data("ps-relay-room-v1\n\(primary)\n\(secondary)".utf8))
    return h.prefix(16).map { String(format: "%02x", $0) }.joined()
  }

  // The offer and the answer, signed with the paired device keys exactly like the screen's own hello (RSHandshake).
  static let offerType = "scr-rly", answerType = "scr-rok"
  static let offerKeys: Set<String> = ["v", "t", "id", "from", "to", "at", "relay"]
  static let answerKeys: Set<String> = ["v", "t", "id", "from", "to", "at", "re", "pub"]

  /// The main Mac's offer: "send to this relay address".
  static func offer(identity: SecondIdentity, to secondary: String, relay: RSAddr, nowMs: Double) -> SecondEnv? {
    identity.sign(["v": 1, "t": offerType, "id": UUID().uuidString.lowercased(), "from": identity.device, "to": secondary, "at": nowMs.rounded(), "relay": relay.description])
  }
  /// The second Mac checks an offer: signed by its trusted primary, for this Mac, fresh, never seen, nothing extra, a public
  /// relay address (`allowLocal` only in the test, where the stand-in relay is on 127.0.0.1).
  static func checkOffer(_ env: SecondEnv, identity: SecondIdentity, nowMs: Double, allowLocal: Bool = false) -> Result<(SecondPeer, RSAddr), SecondRefusal> {
    func no(_ w: String) -> Result<(SecondPeer, RSAddr), SecondRefusal> { .failure(SecondRefusal(why: w)) }
    guard let peer = identity.peer(env.by), peer.role == "primary" else { return no("Not your primary") }
    let first = identity.open(env, expect: [offerType], remember: false)
    if case .failure(let w) = first { return no(w.why == "Not for this Mac" ? w.why : "Not your primary") }
    guard case .success(let b) = first else { return no("Not your primary") }
    guard b["to"] as? String == identity.device else { return no("Not for this Mac") }
    guard Set(b.keys).isSubset(of: offerKeys) else { return no("Bad arguments") }
    guard let at = (b["at"] as? NSNumber)?.doubleValue, abs(nowMs - at) <= RSHandshake.maxSkewMs else { return no("Too old") }
    guard let s = b["relay"] as? String, let a = RSAddr(s), a.isPublic || allowLocal else { return no("Bad arguments") }
    guard case .success = identity.open(env, expect: [offerType], remember: true) else { return no("Seen before") }
    return .success((peer, a))
  }
  /// The second Mac's answer: its own TURN allocation address, bound to the exact offer.
  static func answer(identity: SecondIdentity, offer: SecondEnv, pub: RSAddr, nowMs: Double) -> SecondEnv? {
    identity.sign(["v": 1, "t": answerType, "id": UUID().uuidString.lowercased(), "from": identity.device, "to": offer.by, "at": nowMs.rounded(),
                   "re": RSHandshake.digest(offer.body), "pub": pub.description])
  }
  static func checkAnswer(_ env: SecondEnv, identity: SecondIdentity, expected: String, offer: SecondEnv, nowMs: Double, allowLocal: Bool = false) -> Result<RSAddr, SecondRefusal> {
    func no(_ w: String) -> Result<RSAddr, SecondRefusal> { .failure(SecondRefusal(why: w)) }
    guard env.by == expected, let peer = identity.peer(env.by), peer.role == "secondary" else { return no("Not your second Mac") }
    guard case .success(let b) = identity.open(env, expect: [answerType], remember: false) else { return no("Not your second Mac") }
    guard b["to"] as? String == identity.device, Set(b.keys).isSubset(of: answerKeys) else { return no("Bad arguments") }
    guard let at = (b["at"] as? NSNumber)?.doubleValue, abs(nowMs - at) <= RSHandshake.maxSkewMs else { return no("Too old") }
    guard b["re"] as? String == RSHandshake.digest(offer.body) else { return no("Not an answer to this offer") }
    guard let s = b["pub"] as? String, let a = RSAddr(s), a.isPublic || allowLocal else { return no("Bad arguments") }
    // Only now, signed, fresh and for this offer: remembered, so it can never be used twice.
    guard case .success = identity.open(env, expect: [answerType], remember: true) else { return no("Seen before") }
    return .success(a)
  }

  // The relay Worker's door (workers/turn-creds/src/index.js, the same rule): each request carries the time and an
  // HMAC-SHA256 of the time, method, path and body's SHA-256, made with the relay key. The key itself never travels.
  static func requestSignature(key: String, time: Int, method: String, path: String, body: Data) -> String {
    let bodyHash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
    let msg = "ps-relay-v1\n\(time)\n\(method.uppercased())\n\(path)\n\(bodyHash)"
    let mac = HMAC<SHA256>.authenticationCode(for: Data(msg.utf8), using: SymmetricKey(data: Data(key.utf8)))
    return Data(mac).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
  /// A relay key the developer can paste: 32 to 256 plain characters.
  static func keyOK(_ k: String) -> Bool { (32...256).contains(k.count) && k.allSatisfy { $0.isASCII && !$0.isWhitespace } }
  /// The Worker's address: https only, no user name or password in it, nothing after the host but an optional path.
  static func workerURL(_ s: String) -> URL? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let u = URL(string: t), u.scheme == "https", let h = u.host, !h.isEmpty, u.user == nil, u.password == nil, u.query == nil, u.fragment == nil else { return nil }
    return u
  }
}

/// Short-lived TURN credentials from the vault: {username, credential, urls, ttl}.
struct RSTurnCreds: Equatable {
  var username: String, credential: String, urls: [String], ttl: Int
  static func parse(_ d: Data) -> RSTurnCreds? {
    guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let u = o["username"] as? String, let c = o["credential"] as? String,
          !u.isEmpty, !c.isEmpty, u.count < 512, c.count < 512, let urls = o["urls"] as? [String], !urls.isEmpty else { return nil }
    return RSTurnCreds(username: u, credential: c, urls: urls.filter { $0.count < 256 }, ttl: (o["ttl"] as? NSNumber)?.intValue ?? 0)
  }
  /// TURN client to Cloudflare over TLS/443. Allocated relay addresses still carry UDP datagrams.
  var tls443: String? {
    urls.contains("turns:turn.cloudflare.com:443?transport=tcp") ? "turn.cloudflare.com" : nil
  }

  /// TURN UDP endpoints, used if the TLS allocation fails.
  var udpServers: [(String, UInt16)] {
    var out: [(String, UInt16)] = []
    for s in urls {
      guard s.hasPrefix("turn:") else { continue }
      let rest = s.dropFirst(5)
      let parts = rest.split(separator: "?", maxSplits: 1)
      let hp = String(parts[0])
      let q = parts.count > 1 ? String(parts[1]) : ""
      guard q.isEmpty || q == "transport=udp" else { continue }
      let bits = hp.split(separator: ":")
      guard bits.count == 2, let p = UInt16(bits[1]), !bits[0].isEmpty else { continue }
      out.append((String(bits[0]), p))
    }
    return out
  }
}
