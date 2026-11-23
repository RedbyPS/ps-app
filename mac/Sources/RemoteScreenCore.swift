import CoreGraphics
import CryptoKit
import Foundation

// Second Computer remote screen, the plain rules (PS 1.69: full control of the second Mac, like
// TeamViewer, with the lowest delay possible). Values and bytes only, no window, no screen, no network, so tests/remote-screen-test.swift
// checks every rule here without macOS asking anything.
//
// The link is direct, Mac to Mac on the same network or a Thunderbolt or USB-C cable (PS 1.77: or, when that cannot be made,
// through a relay both Macs dial out to, which only ever passes on these sealed packets: RemoteScreenRelayCore.swift):
//  - TCP (no delay) carries the handshake, then input, cursor, pings and commands, encrypted.
//  - UDP carries the video, encrypted per packet, with a replay window. If UDP cannot get through, the video rides on TCP.
// Who may connect: ONLY the paired primary, proved by the same device keys Second Computer already pairs with the six digit
// code (SecondCrypto.swift). The secondary checks the signed hello before it sends a single byte back; anything else is
// closed without an answer. Each session has fresh X25519 keys (forward secrecy) and four keys made with HKDF from them and
// the signed hello and answer, one per direction and channel. Nothing is ever recorded or saved.

// MARK: bytes

struct RSWriter {
  private(set) var data = Data()
  init(capacity: Int = 64) { data.reserveCapacity(capacity) }
  mutating func u8(_ v: UInt8) { data.append(v) }
  mutating func u16(_ v: UInt16) { var b = v.bigEndian; withUnsafeBytes(of: &b) { data.append(contentsOf: $0) } }
  mutating func u32(_ v: UInt32) { var b = v.bigEndian; withUnsafeBytes(of: &b) { data.append(contentsOf: $0) } }
  mutating func u64(_ v: UInt64) { var b = v.bigEndian; withUnsafeBytes(of: &b) { data.append(contentsOf: $0) } }
  mutating func f32(_ v: Float) { u32(v.bitPattern) }
  mutating func bytes(_ d: Data) { data.append(d) }
}

struct RSReader {
  let data: Data
  private(set) var at: Int
  init(_ d: Data) { data = d; at = d.startIndex }
  var left: Int { data.endIndex - at }
  mutating func u8() -> UInt8? { guard left >= 1 else { return nil }; defer { at += 1 }; return data[at] }
  mutating func u16() -> UInt16? { guard left >= 2 else { return nil }; var v: UInt16 = 0; for i in 0..<2 { v = v << 8 | UInt16(data[at + i]) }; at += 2; return v }
  mutating func u32() -> UInt32? { guard left >= 4 else { return nil }; var v: UInt32 = 0; for i in 0..<4 { v = v << 8 | UInt32(data[at + i]) }; at += 4; return v }
  mutating func u64() -> UInt64? { guard left >= 8 else { return nil }; var v: UInt64 = 0; for i in 0..<8 { v = v << 8 | UInt64(data[at + i]) }; at += 8; return v }
  mutating func f32() -> Float? { u32().map { Float(bitPattern: $0) } }
  mutating func bytes(_ n: Int) -> Data? { guard n >= 0, left >= n else { return nil }; defer { at += n }; return data.subdata(in: at..<(at + n)) }
  mutating func rest() -> Data { defer { at = data.endIndex }; return data.subdata(in: at..<data.endIndex) }
}

// MARK: discovery

enum RSName {
  /// Bonjour service type. The name never says whose Mac it is: it is a hash of the secondary's device id, which only a
  /// paired primary knows (from the pairing), so the network sees a meaningless "ps-1a2b..." and nothing else.
  static let type = "_psscreen._tcp"
  static func service(device: String) -> String {
    let h = SHA256.hash(data: Data("ps-screen-name-v1\n\(device)".utf8))
    return "ps-" + h.prefix(8).map { String(format: "%02x", $0) }.joined()
  }
}

// MARK: the handshake (signed with the paired device keys)

struct RSKeys {
  let p2sTcp: SymmetricKey, s2pTcp: SymmetricKey, p2sUdp: SymmetricKey, s2pUdp: SymmetricKey
  /// The session's id, the first 8 bytes of every UDP packet (so a packet from an old session is dropped before any work).
  let sid: Data
}

enum RSHandshake {
  static let hiType = "scr-hi", okType = "scr-ok"
  /// The hello and its answer must be this fresh (both Macs keep network time; a minute covers any drift).
  static let maxSkewMs: Double = 60_000
  /// Bytes the secondary reads from an unproven connection before it gives up on it.
  static let maxHelloBytes = 8 * 1024
  static let hiKeys: Set<String> = ["v", "t", "id", "from", "to", "at", "eph", "app"]
  static let okKeys: Set<String> = ["v", "t", "id", "from", "to", "at", "eph", "re", "app"]

  static func ephPub(_ k: Curve25519.KeyAgreement.PrivateKey) -> String { k.publicKey.rawRepresentation.base64EncodedString() }
  static func digest(_ s: String) -> String { Data(SHA256.hash(data: Data(s.utf8))).base64EncodedString() }

  /// The primary's hello to one secondary (its device id from the pairing).
  static func hello(identity: SecondIdentity, to secondary: String, eph: Curve25519.KeyAgreement.PrivateKey, nowMs: Double, app: String = "") -> SecondEnv? {
    identity.sign(["v": 1, "t": hiType, "id": UUID().uuidString.lowercased(), "from": identity.device, "to": secondary, "at": nowMs.rounded(), "eph": ephPub(eph), "app": app])
  }

  /// The secondary checks a hello: signed by a TRUSTED PRIMARY (never a phone, never another secondary), meant for this Mac,
  /// fresh, never seen before, nothing extra. Returns who it is and their one time key, or the plain reason (logged, never
  /// sent back: an unproven caller gets no answer at all).
  static func checkHello(_ env: SecondEnv, identity: SecondIdentity, nowMs: Double) -> Result<(SecondPeer, Curve25519.KeyAgreement.PublicKey), SecondRefusal> {
    func no(_ w: String) -> Result<(SecondPeer, Curve25519.KeyAgreement.PublicKey), SecondRefusal> { .failure(SecondRefusal(why: w)) }
    guard let peer = identity.peer(env.by), peer.role == "primary" else { return no("Not your primary") }
    // Signature, from, version and type first, without remembering (an unsigned flood must not grow the seen list).
    let first = identity.open(env, expect: [hiType], remember: false)
    if case .failure(let w) = first { return no(w.why == "Not for this Mac" ? w.why : "Not your primary") }
    guard case .success(let b) = first else { return no("Not your primary") }
    guard b["to"] as? String == identity.device else { return no("Not for this Mac") }
    guard Set(b.keys).isSubset(of: hiKeys) else { return no("Bad arguments") }
    guard let at = (b["at"] as? NSNumber)?.doubleValue, abs(nowMs - at) <= maxSkewMs else { return no("Too old") }
    guard let e = b["eph"] as? String, let ed = Data(base64Encoded: e), let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: ed) else { return no("Bad arguments") }
    // Only now, signed and fresh: remembered, so the same hello can never open a second session.
    guard case .success = identity.open(env, expect: [hiType], remember: true) else { return no("Seen before") }
    return .success((peer, pub))
  }

  /// The secondary's signed answer, bound to the exact hello (its digest).
  static func answer(identity: SecondIdentity, hello: SecondEnv, eph: Curve25519.KeyAgreement.PrivateKey, nowMs: Double, app: String = "") -> SecondEnv? {
    identity.sign(["v": 1, "t": okType, "id": UUID().uuidString.lowercased(), "from": identity.device, "to": hello.by, "at": nowMs.rounded(),
                   "eph": ephPub(eph), "re": digest(hello.body), "app": app])
  }

  /// The primary checks the answer: from the secondary it called (trusted as secondary), to this Mac, fresh, for this hello.
  static func checkAnswer(_ env: SecondEnv, identity: SecondIdentity, expected: String, hello: SecondEnv, nowMs: Double) -> Result<Curve25519.KeyAgreement.PublicKey, SecondRefusal> {
    func no(_ w: String) -> Result<Curve25519.KeyAgreement.PublicKey, SecondRefusal> { .failure(SecondRefusal(why: w)) }
    guard env.by == expected, let peer = identity.peer(env.by), peer.role == "secondary" else { return no("Not your second Mac") }
    guard case .success(let b) = identity.open(env, expect: [okType], remember: true) else { return no("Not your second Mac") }
    guard b["to"] as? String == identity.device, Set(b.keys).isSubset(of: okKeys) else { return no("Bad arguments") }
    guard let at = (b["at"] as? NSNumber)?.doubleValue, abs(nowMs - at) <= maxSkewMs else { return no("Too old") }
    guard b["re"] as? String == digest(hello.body) else { return no("Not an answer to this hello") }
    guard let e = b["eph"] as? String, let ed = Data(base64Encoded: e), let pub = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: ed) else { return no("Bad arguments") }
    return .success(pub)
  }

  /// The session keys, the same on both Macs: X25519 of the one time keys, HKDF-SHA256 salted with both signed bodies.
  static func keys(mine: Curve25519.KeyAgreement.PrivateKey, theirs: Curve25519.KeyAgreement.PublicKey, hello: SecondEnv, answer: SecondEnv) -> RSKeys? {
    guard let shared = try? mine.sharedSecretFromKeyAgreement(with: theirs) else { return nil }
    var t = Data(hello.body.utf8); t.append(0); t.append(Data(answer.body.utf8))
    let salt = Data(SHA256.hash(data: t))
    func k(_ label: String, _ n: Int = 32) -> SymmetricKey { shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: salt, sharedInfo: Data("ps-screen-v1/\(label)".utf8), outputByteCount: n) }
    let sid = k("sid", 8).withUnsafeBytes { Data($0) }
    return RSKeys(p2sTcp: k("p2s-tcp"), s2pTcp: k("s2p-tcp"), p2sUdp: k("p2s-udp"), s2pUdp: k("s2p-udp"), sid: sid)
  }
}

// MARK: encryption per message

/// AES-256-GCM with a counter nonce. One sealer per direction and channel (each has its own key), so a nonce never repeats.
final class RSSealer {
  private let key: SymmetricKey
  private(set) var counter: UInt64 = 0
  init(_ k: SymmetricKey) { key = k }
  static func nonce(_ c: UInt64) -> AES.GCM.Nonce {
    var w = RSWriter(capacity: 12); w.u32(0x5053_5343); w.u64(c)   // "PSSC" + counter
    return try! AES.GCM.Nonce(data: w.data)
  }
  /// Returns the counter used and ciphertext + tag.
  func seal(_ plain: Data, aad: Data = Data()) -> (UInt64, Data)? {
    let c = counter; counter &+= 1
    guard let box = try? AES.GCM.seal(plain, using: key, nonce: RSSealer.nonce(c), authenticating: aad) else { return nil }
    var out = Data(box.ciphertext); out.append(box.tag); return (c, out)
  }
  /// Seals with a counter chosen by the caller (UDP packets carry it in their header).
  func sealUDP(_ plain: Data, sid: Data) -> Data? {
    let c = counter; counter &+= 1
    var head = RSWriter(capacity: 16); head.bytes(sid); head.u64(c)
    guard let box = try? AES.GCM.seal(plain, using: key, nonce: RSSealer.nonce(c), authenticating: head.data) else { return nil }
    var out = head.data; out.append(box.ciphertext); out.append(box.tag); return out
  }
}

final class RSOpener {
  private let key: SymmetricKey
  private var next: UInt64 = 0          // TCP: in order
  private var window = RSReplayWindow()  // UDP: any order, never twice
  init(_ k: SymmetricKey) { key = k }
  static func open(_ ct: Data, key: SymmetricKey, counter: UInt64, aad: Data) -> Data? {
    guard ct.count >= 16 else { return nil }
    let body = ct.prefix(ct.count - 16), tag = ct.suffix(16)
    guard let box = try? AES.GCM.SealedBox(nonce: RSSealer.nonce(counter), ciphertext: body, tag: tag) else { return nil }
    return try? AES.GCM.open(box, using: key, authenticating: aad)
  }
  /// TCP frames: the next counter only (a dropped, replayed or reordered frame ends the session).
  func openTCP(_ ct: Data) -> Data? {
    guard let p = RSOpener.open(ct, key: key, counter: next, aad: Data()) else { return nil }
    next &+= 1; return p
  }
  /// UDP packets: the right session, a good tag, and a counter never accepted before (64 packet window).
  func openUDP(_ packet: Data, sid: Data) -> Data? {
    var r = RSReader(packet)
    guard let s = r.bytes(8), s == sid, let c = r.u64() else { return nil }
    guard window.mayAccept(c) else { return nil }
    let head = packet.prefix(16)
    guard let p = RSOpener.open(r.rest(), key: key, counter: c, aad: Data(head)) else { return nil }
    window.accept(c)
    return p
  }
}

/// The usual sliding replay window (as in IPsec and WireGuard): the highest counter seen and a bitmap of the 64 before it.
struct RSReplayWindow {
  private(set) var top: UInt64 = 0
  private var bits: UInt64 = 0
  private var any = false
  func mayAccept(_ c: UInt64) -> Bool {
    guard any else { return true }
    if c > top { return true }
    let d = top - c
    if d >= 64 { return false }
    return bits & (1 << d) == 0
  }
  mutating func accept(_ c: UInt64) {
    guard any else { any = true; top = c; bits = 1; return }
    if c > top {
      let d = c - top
      bits = d >= 64 ? 1 : (bits << d) | 1
      top = c
    } else { bits |= 1 << (top - c) }
  }
}

// MARK: TCP framing

enum RSFrame {
  /// A frame before the handshake (the signed hello or answer) may be this big; after it, 4 MB (a keyframe over TCP).
  static let maxPlain = 8 * 1024, maxSealed = 4 * 1024 * 1024
  static func frame(_ d: Data) -> Data { var w = RSWriter(capacity: d.count + 4); w.u32(UInt32(d.count)); w.bytes(d); return w.data }
  /// Takes whole frames off the front of a buffer. nil: a frame says it is bigger than `max` (the caller closes).
  static func take(_ buf: inout Data, max: Int) -> [Data]? {
    var out: [Data] = []
    while buf.count >= 4 {
      var r = RSReader(buf)
      let n = Int(r.u32()!)
      guard n <= max else { return nil }
      guard buf.count >= 4 + n else { break }
      out.append(buf.subdata(in: (buf.startIndex + 4)..<(buf.startIndex + 4 + n)))
      buf = buf.subdata(in: (buf.startIndex + 4 + n)..<buf.endIndex)
    }
    return out
  }
}

// MARK: control messages (inside the encrypted TCP frames)

enum RSCtl: UInt8 {
  case input = 1        // primary to secondary: one RSInput
  case ping = 2         // u64 sender's clock (ns)
  case pong = 3         // u64 the ping's clock, u64 the answerer's clock
  case keyframe = 4     // primary asks for a fresh keyframe (a frame was lost)
  case feedback = 5     // primary: JSON {loss, kbps, lat} for the bitrate
  case screen = 6       // secondary: JSON RSScreenInfo
  case cursor = 7       // secondary: f32 hot x, f32 hot y, f32 width pt, f32 height pt, PNG
  case cursorHidden = 8
  case state = 9        // secondary: JSON {screen, access, guarded}
  case command = 10     // primary: JSON {id, action}
  case commandDone = 11 // secondary: JSON {id, ok, why}
  case bye = 12
  case video = 13       // secondary: one whole encoded frame (RSVideoFrame) when UDP cannot get through
  case udpOK = 14       // secondary: the primary's UDP hello arrived, video goes over UDP
  case openSettings = 15 // primary: JSON {pane}: open System Settings on the secondary (Screen Recording or Accessibility)
}

struct RSScreenInfo: Codable, Equatable {
  /// Pixels encoded, and the secondary's main display in points (input lands there).
  var w: Int, h: Int, pw: Double, ph: Double
  var codec: String   // "h264" or "hevc"
  var fps: Int
  /// The secondary's UDP port for the video (nil: video stays on TCP).
  var udp: Int? = nil
}

struct RSState: Codable, Equatable {
  /// Screen Recording and Accessibility allowed on the secondary.
  var screen: Bool, access: Bool
  /// 1Password or Signal is in front on the secondary: its keys are not replayed (Protected.swift's rule), and PS says so
  /// without naming the app.
  var guarded: Bool
}

// MARK: input

enum RSButton: UInt8 { case left = 0, right = 1, other = 2 }

enum RSInput: Equatable {
  /// x and y run 0 to 1 across the secondary's main display, top left origin.
  case move(x: Float, y: Float, buttons: UInt8)
  case down(x: Float, y: Float, button: UInt8, clicks: UInt8, flags: UInt64)
  case up(x: Float, y: Float, button: UInt8, clicks: UInt8, flags: UInt64)
  case scroll(x: Float, y: Float, dx: Float, dy: Float, continuous: Bool, phase: UInt8, momentum: UInt8, flags: UInt64)
  case key(code: UInt16, down: Bool, flags: UInt64, repeating: Bool)
  case flags(code: UInt16, flags: UInt64)
  /// Every key and button up (the window lost focus or the link ends): never a stuck key on the secondary.
  case releaseAll

  func encode() -> Data {
    var w = RSWriter(capacity: 32)
    switch self {
    case let .move(x, y, b): w.u8(1); w.f32(x); w.f32(y); w.u8(b)
    case let .down(x, y, b, c, f): w.u8(2); w.f32(x); w.f32(y); w.u8(b); w.u8(c); w.u64(f)
    case let .up(x, y, b, c, f): w.u8(3); w.f32(x); w.f32(y); w.u8(b); w.u8(c); w.u64(f)
    case let .scroll(x, y, dx, dy, cont, ph, mo, f): w.u8(4); w.f32(x); w.f32(y); w.f32(dx); w.f32(dy); w.u8(cont ? 1 : 0); w.u8(ph); w.u8(mo); w.u64(f)
    case let .key(code, down, f, rep): w.u8(5); w.u16(code); w.u8(down ? 1 : 0); w.u64(f); w.u8(rep ? 1 : 0)
    case let .flags(code, f): w.u8(6); w.u16(code); w.u64(f)
    case .releaseAll: w.u8(7)
    }
    return w.data
  }

  /// Strict: unknown kinds, short or long data, numbers that are not finite or outside the screen are refused.
  static func decode(_ d: Data) -> RSInput? {
    var r = RSReader(d)
    guard let k = r.u8() else { return nil }
    func pos() -> (Float, Float)? {
      guard let x = r.f32(), let y = r.f32(), x.isFinite, y.isFinite, (-0.01...1.01).contains(x), (-0.01...1.01).contains(y) else { return nil }
      return (min(max(x, 0), 1), min(max(y, 0), 1))
    }
    let out: RSInput?
    switch k {
    case 1: guard let (x, y) = pos(), let b = r.u8() else { return nil }; out = .move(x: x, y: y, buttons: b & 0x7)
    case 2, 3:
      guard let (x, y) = pos(), let b = r.u8(), b <= 31, let c = r.u8(), let f = r.u64() else { return nil }
      let cl = min(max(c, 1), 3)
      out = k == 2 ? .down(x: x, y: y, button: b, clicks: cl, flags: f) : .up(x: x, y: y, button: b, clicks: cl, flags: f)
    case 4:
      guard let (x, y) = pos(), let dx = r.f32(), let dy = r.f32(), dx.isFinite, dy.isFinite, abs(dx) < 100_000, abs(dy) < 100_000,
            let c = r.u8(), let ph = r.u8(), let mo = r.u8(), let f = r.u64() else { return nil }
      out = .scroll(x: x, y: y, dx: dx, dy: dy, continuous: c == 1, phase: ph, momentum: mo, flags: f)
    case 5: guard let c = r.u16(), c < 0x200, let d = r.u8(), let f = r.u64(), let rep = r.u8() else { return nil }; out = .key(code: c, down: d == 1, flags: f, repeating: rep == 1)
    case 6: guard let c = r.u16(), c < 0x200, let f = r.u64() else { return nil }; out = .flags(code: c, flags: f)
    case 7: out = .releaseAll
    default: return nil
    }
    return r.left == 0 ? out : nil
  }

  var isKey: Bool { if case .key = self { return true }; if case .flags = self { return true }; return false }
}

// MARK: mapping the picture and the pointer

enum RSFit {
  /// The picture scaled to fit, centred (black bars where the shapes differ).
  static func rect(content: CGSize, in bounds: CGRect) -> CGRect {
    guard content.width > 0, content.height > 0, bounds.width > 0, bounds.height > 0 else { return bounds }
    let k = min(bounds.width / content.width, bounds.height / content.height)
    let w = content.width * k, h = content.height * k
    return CGRect(x: bounds.minX + (bounds.width - w) / 2, y: bounds.minY + (bounds.height - h) / 2, width: w, height: h)
  }
  /// A point in the view (y up, as AppKit gives it) to 0...1 across the picture, top left origin, clamped to the edges.
  static func normalize(_ p: CGPoint, picture: CGRect) -> (Float, Float) {
    guard picture.width > 0, picture.height > 0 else { return (0, 0) }
    let x = (p.x - picture.minX) / picture.width
    let y = 1 - (p.y - picture.minY) / picture.height
    return (Float(min(max(x, 0), 1)), Float(min(max(y, 0), 1)))
  }
  /// Whether the pointer is over the picture (not the black bars).
  static func inside(_ p: CGPoint, picture: CGRect) -> Bool { picture.contains(p) }
  /// 0...1 to the secondary's display in global points (CGEvent's top left space).
  static func toDisplay(_ x: Float, _ y: Float, bounds: CGRect) -> CGPoint {
    // The last point is width - 1 (a point AT the right edge is off the display).
    CGPoint(x: bounds.minX + CGFloat(x) * max(bounds.width - 1, 0), y: bounds.minY + CGFloat(y) * max(bounds.height - 1, 0))
  }
  /// The size to encode: the display's pixels, no wider than `maxW` (even numbers, the encoder needs them).
  static func encodeSize(pixels: CGSize, maxW: Int) -> (Int, Int) {
    var w = Double(pixels.width), h = Double(pixels.height)
    if w > Double(maxW) { h = h * Double(maxW) / w; w = Double(maxW) }
    func even(_ v: Double) -> Int { max(2, Int(v.rounded()) & ~1) }
    return (even(w), even(h))
  }
}

// MARK: video over UDP: fragments and putting them back together

struct RSVideoFrame: Equatable {
  var number: UInt32
  var keyframe: Bool
  /// When the secondary captured it (its own clock, ns) and how long capture to encoded took (µs).
  var captureNs: UInt64
  var encodeUs: UInt32
  /// Parameter sets (SPS, PPS, VPS) on keyframes, and the length prefixed NAL units.
  var params: [Data]
  var data: Data

  /// One frame as bytes: [u32 number][u8 flags][u64 capture][u32 encode][u8 n params, each u16 len + bytes][data].
  func encode() -> Data {
    var w = RSWriter(capacity: data.count + 64)
    w.u32(number); w.u8((keyframe ? 1 : 0)); w.u64(captureNs); w.u32(encodeUs)
    w.u8(UInt8(min(params.count, 8)))
    for p in params.prefix(8) { w.u16(UInt16(min(p.count, 65_535))); w.bytes(p.prefix(65_535)) }
    w.bytes(data)
    return w.data
  }
  static func decode(_ d: Data) -> RSVideoFrame? {
    var r = RSReader(d)
    guard let n = r.u32(), let f = r.u8(), let c = r.u64(), let e = r.u32(), let pc = r.u8(), pc <= 8 else { return nil }
    var ps: [Data] = []
    for _ in 0..<pc { guard let l = r.u16(), let p = r.bytes(Int(l)) else { return nil }; ps.append(p) }
    return RSVideoFrame(number: n, keyframe: f & 1 == 1, captureNs: c, encodeUs: e, params: ps, data: r.rest())
  }
}

enum RSPacket {
  /// Plain bytes per UDP packet: the datagram stays under 1400 bytes with the header and tag (no IP fragments on Wi-Fi).
  static let chunk = 1300
  static let kindVideo: UInt8 = 1, kindHello: UInt8 = 2
  static let maxFragments = 4096   // ~5 MB, far more than any keyframe

  /// A whole encoded frame cut into packet bodies: [kind][u32 frame][u16 index][u16 count][piece].
  static func fragments(of frame: Data, number: UInt32, chunk: Int = RSPacket.chunk) -> [Data] {
    let count = max(1, (frame.count + chunk - 1) / chunk)
    guard count <= maxFragments else { return [] }
    var out: [Data] = []; out.reserveCapacity(count)
    for i in 0..<count {
      var w = RSWriter(capacity: chunk + 9)
      w.u8(kindVideo); w.u32(number); w.u16(UInt16(i)); w.u16(UInt16(count))
      let s = frame.startIndex + i * chunk
      w.bytes(frame.subdata(in: s..<min(s + chunk, frame.endIndex)))
      out.append(w.data)
    }
    return out
  }
  static func hello(clockNs: UInt64) -> Data { var w = RSWriter(); w.u8(kindHello); w.u64(clockNs); return w.data }
}

/// Puts fragments back together. Frames come out whole, oldest first; one that cannot be completed (a lost packet) is dropped
/// and every frame after it is held back until a keyframe (a P frame without its reference would show garbage), and the
/// caller is told to ask for one.
final class RSReassembler {
  struct Out { var frames: [Data] = []; var lost = 0; var needKeyframe = false }
  private struct Part { var count: Int; var pieces: [Data?]; var got: Int; var first: Double }
  private var parts: [UInt32: Part] = [:]
  private var last: UInt32?
  private(set) var broken = false
  private(set) var lostTotal = 0, framesTotal = 0
  /// A frame still missing pieces after this long (ms) is given up.
  var timeoutMs: Double = 120

  func add(_ body: Data, nowMs: Double) -> Out {
    var o = Out()
    var r = RSReader(body)
    guard r.u8() == RSPacket.kindVideo, let n = r.u32(), let i16 = r.u16(), let c16 = r.u16() else { return o }
    let i = Int(i16), c = Int(c16)
    guard c >= 1, c <= RSPacket.maxFragments, i < c else { return o }
    if let l = last, !RSReassembler.newer(n, than: l) { return o }   // already shown or given up
    var p = parts[n] ?? Part(count: c, pieces: Array(repeating: nil, count: c), got: 0, first: nowMs)
    guard p.count == c else { return o }
    if p.pieces[i] == nil { p.pieces[i] = r.rest(); p.got += 1 }
    parts[n] = p
    if parts.count > 64 {   // memory bound: everything but this frame is given up
      for k in parts.keys where k != n { parts[k] = nil; o.lost += 1; broken = true; if last.map({ RSReassembler.newer(k, than: $0) }) ?? true { last = k } }
    }
    if p.got == p.count {
      parts[n] = nil
      // Older frames still waiting can never come out in order now; every number between the last one out and this one is lost.
      for k in parts.keys where RSReassembler.newer(n, than: k) { parts[k] = nil }
      let gap = last.map { Int(n &- $0) - 1 } ?? 0
      if gap > 0 { o.lost += gap; broken = true }
      last = n
      var whole = Data(); whole.reserveCapacity(p.pieces.reduce(0) { $0 + ($1?.count ?? 0) })
      for x in p.pieces { whole.append(x!) }
      if RSVideoFrame.isKeyframe(whole) { broken = false }
      if !broken { o.frames.append(whole); framesTotal += 1 }
    }
    expire(nowMs: nowMs, out: &o)
    lostTotal += o.lost
    if broken { o.needKeyframe = true }
    return o
  }

  /// A frame still missing pieces after `timeoutMs` is given up (the screen may not change again for a while, so this is
  /// what notices a lost last frame and asks for a keyframe). Call it from a timer too.
  func tick(nowMs: Double) -> Out { var o = Out(); expire(nowMs: nowMs, out: &o); lostTotal += o.lost; if broken { o.needKeyframe = true }; return o }

  private func expire(nowMs: Double, out o: inout Out) {
    for (k, v) in parts where nowMs - v.first > timeoutMs {
      parts[k] = nil; o.lost += 1; broken = true
      if last.map({ RSReassembler.newer(k, than: $0) }) ?? true { last = k }
    }
  }

  /// A new decoder starts clean (after a reconnect).
  func reset() { parts = [:]; last = nil; broken = false }

  /// Frame numbers wrap at 2^32: "newer" within half the range.
  static func newer(_ a: UInt32, than b: UInt32) -> Bool { a != b && (a &- b) < 0x8000_0000 }
}

extension RSVideoFrame {
  /// The keyframe flag without decoding the rest (byte 4, after the u32 number).
  static func isKeyframe(_ d: Data) -> Bool { d.count > 4 && d[d.startIndex + 4] & 1 == 1 }
}

// MARK: bitrate, clocks and numbers

/// The bitrate the encoder aims for, from the primary's feedback twice a second: down fast when packets are lost or the
/// delay grows (Wi-Fi is full), up slowly when all is well (additive increase, multiplicative decrease).
struct RSRate {
  var minKbps = 3_000, maxKbps = 60_000
  private(set) var kbps: Int
  private var baseLatency: Double?
  init(startKbps: Int = 20_000) { kbps = startKbps }
  /// loss: 0...1 of packets in the last interval; latencyMs: capture to display, p50 of the interval.
  mutating func feedback(loss: Double, latencyMs: Double?) -> Int {
    // The base delay is the lowest seen, creeping up slowly so a changed route (Wi-Fi to cable) is learnt.
    if let l = latencyMs, l > 0 { let b = min(baseLatency ?? l, l); baseLatency = b + (l - b) * 0.01 }
    let rising = latencyMs.map { l in baseLatency.map { l > $0 + 30 } ?? false } ?? false
    if loss > 0.02 || rising { kbps = Int(Double(kbps) * 0.7) }
    else if loss < 0.005 { kbps += 2_000 }
    kbps = min(max(kbps, minKbps), maxKbps)
    return kbps
  }
}

/// The secondary's clock against this Mac's (NTP style): the sample with the shortest round trip of the last 16 wins.
struct RSClock {
  private var samples: [(rtt: Int64, offset: Int64)] = []
  /// remote - local, in ns. nil until the first pong.
  var offset: Int64? { samples.min { $0.rtt < $1.rtt }?.offset }
  var rttNs: Int64? { samples.map(\.rtt).min() }
  mutating func pong(sent t1: UInt64, remote t2: UInt64, received t3: UInt64) {
    guard t3 >= t1 else { return }
    let rtt = Int64(t3 - t1)
    let off = Int64(bitPattern: t2) - (Int64(bitPattern: t1) + rtt / 2)
    samples.append((rtt, off))
    if samples.count > 16 { samples.removeFirst() }
  }
  /// The remote time in this Mac's clock.
  func local(_ remote: UInt64) -> UInt64? { offset.map { UInt64(max(0, Int64(bitPattern: remote) - $0)) } }
}

/// Rolling numbers for the log (milliseconds): p50, p95, max of the last `size`.
struct RSStats {
  private var v: [Double] = []
  let size: Int
  init(size: Int = 600) { self.size = size }
  mutating func add(_ x: Double) { guard x.isFinite, x >= 0 else { return }; v.append(x); if v.count > size { v.removeFirst(v.count - size) } }
  var count: Int { v.count }
  func pct(_ p: Double) -> Double? {
    guard !v.isEmpty else { return nil }
    let s = v.sorted()
    return s[Swift.min(s.count - 1, Swift.max(0, Int((p * Double(s.count - 1)).rounded())))]
  }
  var p50: Double? { pct(0.5) }
  var p95: Double? { pct(0.95) }
  var maximum: Double? { v.max() }
  mutating func reset() { v.removeAll() }
  /// "p50 12.3 p95 20.1 max 31.0" (numbers only, never anything from the screen).
  var line: String {
    guard let a = p50, let b = p95, let c = maximum else { return "none" }
    return String(format: "p50 %.1f p95 %.1f max %.1f n %d", a, b, c, v.count)
  }
}

/// Host clock in ns (mach_absolute_time scaled; the same clock ScreenCaptureKit stamps frames with).
enum RSTime {
  private static let tb: mach_timebase_info_data_t = { var t = mach_timebase_info_data_t(); mach_timebase_info(&t); return t }()
  static func ns(fromHost h: UInt64) -> UInt64 { h &* UInt64(tb.numer) / UInt64(tb.denom) }
  static var nowNs: UInt64 { ns(fromHost: mach_absolute_time()) }
  static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }
}

// MARK: scrolling: AppKit's phases to CGEvent's

enum RSScroll {
  /// NSEvent.Phase bits (began 1, stationary 2, changed 4, ended 8, cancelled 16, mayBegin 32) to CGScrollPhase
  /// (began 1, changed 2, ended 4, cancelled 8, mayBegin 128). 0: no phase (a mouse wheel).
  static func cgPhase(_ ns: UInt8) -> Int64 {
    if ns & 1 != 0 { return 1 }
    if ns & 4 != 0 || ns & 2 != 0 { return 2 }
    if ns & 8 != 0 { return 4 }
    if ns & 16 != 0 { return 8 }
    if ns & 32 != 0 { return 128 }
    return 0
  }
  /// NSEvent momentum phase (began 1, changed 4, ended 8) to CGMomentumScrollPhase (none 0, begin 1, continue 2, end 3).
  static func cgMomentum(_ ns: UInt8) -> Int64 {
    if ns & 1 != 0 { return 1 }
    if ns & 4 != 0 || ns & 2 != 0 { return 2 }
    if ns & 8 != 0 || ns & 16 != 0 { return 3 }
    return 0
  }
  /// A mouse wheel's lines (not a trackpad): at least one line in the right direction.
  static func lines(_ v: Float) -> Int32 { v == 0 ? 0 : v > 0 ? Int32(max(1, v.rounded())) : Int32(min(-1, v.rounded())) }
}

// MARK: modifier keys

enum RSFlags {
  /// The device independent modifier bits only (caps lock, shift, control, option, command, numeric pad, help, fn): the same
  /// values in NSEvent.ModifierFlags and CGEventFlags.
  static let mask: UInt64 = 0x00FF_0000
  static func clean(_ f: UInt64) -> UInt64 { f & mask }
}

// MARK: leaving the window with Esc (PS's rule: every PS screen closes on Esc)

/// On the remote screen a single Esc must reach the other Mac (dialogs, editors, full screen video there all need it), so PS's
/// own "close on Esc" is two Escs within `gap` seconds: the first goes to the other Mac as usual, the second closes the window
/// here (or leaves full screen first).
struct RSEscape {
  var gap: Double = 0.45
  private var last: Double?
  /// Call on every Esc key down (not repeats). True: this one closes.
  mutating func press(at t: Double) -> Bool {
    if let l = last, t - l <= gap { last = nil; return true }
    last = t; return false
  }
}

// MARK: the hold key (part 2): hold it to see the second Mac, let go to put it away

/// The keys the person can choose for the hold (Settings, Second Computer, Remote screen, Hold key), as macOS key codes.
/// § is the default: on Apple's British and European keyboards it is the key left of 1 and nearly never typed. The others are
/// for keyboards without it. "off": no hold key.
enum RSHoldKeys {
  static let all: [(id: String, code: Int64)] = [("section", 10), ("grave", 50), ("f13", 105), ("f14", 107), ("f15", 113), ("f16", 106)]
  static let defaultId = "section"
  /// The key code for a choice, nil for "off" or anything unknown (then the default).
  static func code(_ id: String?) -> Int64? {
    if id == "off" { return nil }
    return all.first { $0.id == id }?.code ?? 10
  }
}

/// The hold key's own small state machine, with the Tab hold's rules (main.swift TabWatch) for one key:
///  - Down (no modifier, not a repeat): held back. Let go before `HOLD_SECONDS`: it was a normal key press, sent on (down and
///    up) to wherever the keyboard is. Another key first: the held key is sent first, then that key, so typing stays in order.
///  - Held past the hold time: the second Mac's screen shows (or, when it is already up, it goes away). While held, the key's
///    repeats are swallowed, and its key up too: a HELD key is never typed anywhere, here or on the second Mac.
///  - Let go: the screen goes away again, unless it was clicked while held (then it stays, like a pinned Tab list).
struct RSHold {
  enum State: Equatable { case idle, pending, showing, swallowUp, passUp }
  enum Mode: Equatable { case show, hide }
  /// What the tap does with this event, and what PS does next.
  struct Out: Equatable {
    enum Event: Equatable { case notMine, pass, swallow, repostHeldThenThis }
    var event: Event
    var startTimer = false
    var release = false
  }
  private(set) var state: State = .idle
  private(set) var mode: Mode = .show
  var code: Int64 = 10

  /// One key event. `armed`: the hold may open now (on, paired, unlocked, nothing protected in front, the Tab hold idle).
  /// `up`: the remote screen is already showing and has the keyboard (a hold then puts it away).
  mutating func key(code c: Int64, down: Bool, repeating: Bool, modifiers: Bool, armed: Bool, up: Bool) -> Out {
    if c != code {
      if state == .pending && down { state = .passUp; return Out(event: .repostHeldThenThis) }
      return Out(event: .notMine)
    }
    if down {
      switch state {
      case .pending, .showing, .swallowUp: return Out(event: .swallow)   // held: the repeats never type
      case .passUp: return Out(event: .pass)
      case .idle:
        if repeating || modifiers || !armed { return Out(event: .notMine) }
        state = .pending; mode = up ? .hide : .show
        return Out(event: .swallow, startTimer: true)
      }
    }
    switch state {
    case .pending: state = .idle; return Out(event: .repostHeldThenThis)   // a quick press: a normal key
    case .showing: state = .idle; return Out(event: .swallow, release: true)
    case .swallowUp: state = .idle; return Out(event: .swallow)
    case .passUp: state = .idle; return Out(event: .pass)
    case .idle: return Out(event: .notMine)
    }
  }

  /// The hold time passed. Returns what to do: show, hide, or nothing (the key was let go first).
  mutating func fire() -> Mode? {
    guard state == .pending else { return nil }
    state = mode == .show ? .showing : .swallowUp
    return mode
  }

  /// The watchdog (main stuck): back to idle. True when a held key is waiting and must be sent on.
  mutating func reset() -> Bool { let held = state == .pending; state = .idle; return held }
}

// MARK: the Dock app's words (part 2, RemoteScreenDock.swift)

enum RSDockRules {
  static let verbs: Set<String> = ["open", "lock", "sentry", "shutdown", "restart"]
  /// One line from the Dock app: a known word, nothing else.
  static func verb(_ d: Data) -> String? {
    guard d.count <= 32, let s = String(data: d, encoding: .utf8) else { return nil }
    let w = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return verbs.contains(w) ? w : nil
  }
  static func sha(_ path: String) -> Data? {
    guard let d = FileManager.default.contents(atPath: path), !d.isEmpty, d.count < 64 * 1024 * 1024 else { return nil }
    return Data(SHA256.hash(data: d))
  }
}
