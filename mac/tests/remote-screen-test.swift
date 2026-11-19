// Unit and loopback tests for the Second Computer remote screen engine (PS 1.69): Sources/RemoteScreenCore.swift,
// RemoteScreenCodec.swift, RemoteScreenNet.swift, RemoteScreenPipe.swift.
// No screen is captured, no input is posted, no window opens, nothing is played. Pictures are made up in memory; the network
// is 127.0.0.1 only (the listener is held to the loopback interface and nothing is advertised). Identities are FICTIONAL,
// made in a temporary folder, never the Keychain.
//   tests/remote-screen-test.sh
import CoreMedia
import CoreVideo
import CryptoKit
import Foundation
import Metal
import Network
import QuartzCore

func psLog(_ s: String) {}
setvbuf(stdout, nil, _IONBF, 0)
var fails = 0
func check(_ name: String, _ ok: Bool) { print("\(name)=\(ok ? "ok" : "FAIL")"); if !ok { fails += 1 } }
func refused<T>(_ r: Result<T, SecondRefusal>) -> String? { if case .failure(let w) = r { return w.why }; return nil }

let fm = FileManager.default
let root = NSTemporaryDirectory() + "ps-screen-test-\(getpid())"
try? fm.removeItem(atPath: root)
try! fm.createDirectory(atPath: root, withIntermediateDirectories: true)
defer { try? fm.removeItem(atPath: root) }

func ident(_ name: String) -> SecondIdentity { SecondIdentity(store: SecondFileStore(dir: root + "/" + name), seenPath: root + "/\(name)-seen.json") }
let m4 = ident("m4"), m1 = ident("m1"), stranger = ident("stranger"), phone = ident("phone"), other = ident("other")
let now = Date().timeIntervalSince1970 * 1000
m1.trust(SecondPeer(device: m4.device, name: "Test M4", pub: m4.pub, role: "primary", at: now))
m1.trust(SecondPeer(device: phone.device, name: "Test phone", pub: phone.pub, role: "phone", at: now))
m1.trust(SecondPeer(device: other.device, name: "Other secondary", pub: other.pub, role: "secondary", at: now))
m4.trust(SecondPeer(device: m1.device, name: "Test M1", pub: m1.pub, role: "secondary", at: now))
stranger.trust(SecondPeer(device: m1.device, name: "Test M1", pub: m1.pub, role: "secondary", at: now))
let m1AsPeer = m4.peer(m1.device)!

// ---------- bytes ----------
do {
  var w = RSWriter(); w.u8(7); w.u16(0xBEEF); w.u32(0xDEAD_BEEF); w.u64(0x0102_0304_0506_0708); w.f32(1.5); w.bytes(Data([9, 9]))
  var r = RSReader(w.data)
  check("bytes-roundtrip", r.u8() == 7 && r.u16() == 0xBEEF && r.u32() == 0xDEAD_BEEF && r.u64() == 0x0102_0304_0506_0708 && r.f32() == 1.5 && r.bytes(2) == Data([9, 9]) && r.left == 0 && r.u8() == nil)
}

// ---------- input ----------
do {
  let all: [RSInput] = [.move(x: 0.25, y: 0.75, buttons: 1), .down(x: 0, y: 1, button: 0, clicks: 2, flags: 0x100000), .up(x: 1, y: 0, button: 1, clicks: 1, flags: 0),
                        .scroll(x: 0.5, y: 0.5, dx: -3.5, dy: 12, continuous: true, phase: 4, momentum: 0, flags: 0), .key(code: 0x24, down: true, flags: 0x20000, repeating: false),
                        .flags(code: 0x38, flags: 0x20000), .releaseAll]
  check("input-roundtrip", all.allSatisfy { RSInput.decode($0.encode()) == $0 })
  var nan = RSWriter(); nan.u8(1); nan.f32(.nan); nan.f32(0.5); nan.u8(0)
  var far = RSWriter(); far.u8(1); far.f32(5); far.f32(0.5); far.u8(0)
  var bigKey = RSWriter(); bigKey.u8(5); bigKey.u16(0x400); bigKey.u8(1); bigKey.u64(0); bigKey.u8(0)
  var extra = RSInput.releaseAll.encode(); extra.append(1)
  check("input-refuses-bad", RSInput.decode(nan.data) == nil && RSInput.decode(far.data) == nil && RSInput.decode(bigKey.data) == nil
        && RSInput.decode(extra) == nil && RSInput.decode(Data([99])) == nil && RSInput.decode(Data()) == nil && RSInput.decode(Data([2, 0, 0])) == nil)
  let edge = RSInput.decode(RSInput.move(x: 1.005, y: -0.005, buttons: 0).encode())
  check("input-clamps-edges", edge == .move(x: 1, y: 0, buttons: 0))
  if case .down(_, _, _, let c, _)? = RSInput.decode(RSInput.down(x: 0, y: 0, button: 0, clicks: 9, flags: 0).encode()) { check("input-click-count-capped", c == 3) } else { check("input-click-count-capped", false) }
}

// ---------- names ----------
do {
  let n = RSName.service(device: m1.device)
  check("name-stable-and-private", n == RSName.service(device: m1.device) && n != RSName.service(device: m4.device) && !n.contains(m1.device.prefix(8)) && n.hasPrefix("ps-") && n.count == 19)
}

// ---------- handshake ----------
func hello(_ who: SecondIdentity, to: String = m1.device, at: Double = Date().timeIntervalSince1970 * 1000) -> (SecondEnv, Curve25519.KeyAgreement.PrivateKey) {
  let k = Curve25519.KeyAgreement.PrivateKey(); return (RSHandshake.hello(identity: who, to: to, eph: k, nowMs: at)!, k)
}
do {
  let t = Date().timeIntervalSince1970 * 1000
  let (h, pk) = hello(m4)
  guard case .success(let (peer, ppub)) = RSHandshake.checkHello(h, identity: m1, nowMs: t) else { check("hello-from-primary", false); exit(1) }
  check("hello-from-primary", peer.device == m4.device && peer.role == "primary")
  check("hello-replay-refused", refused(RSHandshake.checkHello(h, identity: m1, nowMs: t)) == "Seen before")
  check("hello-stranger-refused", refused(RSHandshake.checkHello(hello(stranger).0, identity: m1, nowMs: t)) == "Not your primary")
  check("hello-phone-refused", refused(RSHandshake.checkHello(hello(phone).0, identity: m1, nowMs: t)) == "Not your primary")
  check("hello-other-secondary-refused", refused(RSHandshake.checkHello(hello(other).0, identity: m1, nowMs: t)) == "Not your primary")
  check("hello-old-refused", refused(RSHandshake.checkHello(hello(m4, at: t - 120_000).0, identity: m1, nowMs: t)) == "Too old")
  check("hello-future-refused", refused(RSHandshake.checkHello(hello(m4, at: t + 120_000).0, identity: m1, nowMs: t)) != nil)
  check("hello-other-mac-refused", refused(RSHandshake.checkHello(hello(m4, to: other.device).0, identity: m1, nowMs: t)) == "Not for this Mac")
  var tam = hello(m4).0; tam = SecondEnv(body: tam.body.replacingOccurrences(of: "\"v\":1", with: "\"v\":1,\"x\":1"), sig: tam.sig, by: tam.by)
  check("hello-tampered-refused", refused(RSHandshake.checkHello(tam, identity: m1, nowMs: t)) != nil)
  let extra = m4.sign(["v": 1, "t": RSHandshake.hiType, "id": UUID().uuidString, "from": m4.device, "to": m1.device, "at": t, "eph": RSHandshake.ephPub(pk), "evil": 1])!
  check("hello-extra-key-refused", refused(RSHandshake.checkHello(extra, identity: m1, nowMs: t)) == "Bad arguments")
  let forged = SecondEnv(body: h.body, sig: hello(stranger).0.sig, by: m4.device)
  check("hello-forged-signature-refused", refused(RSHandshake.checkHello(forged, identity: m1, nowMs: t)) != nil)

  let sk = Curve25519.KeyAgreement.PrivateKey()
  let a = RSHandshake.answer(identity: m1, hello: h, eph: sk, nowMs: t)!
  guard case .success(let spub) = RSHandshake.checkAnswer(a, identity: m4, expected: m1.device, hello: h, nowMs: t) else { check("answer-ok", false); exit(1) }
  check("answer-ok", true)
  let (h2, _) = hello(m4)
  let a2 = RSHandshake.answer(identity: m1, hello: h2, eph: sk, nowMs: t)!
  check("answer-for-other-hello-refused", refused(RSHandshake.checkAnswer(a2, identity: m4, expected: m1.device, hello: h, nowMs: t)) == "Not an answer to this hello")
  check("answer-from-wrong-mac-refused", refused(RSHandshake.checkAnswer(RSHandshake.answer(identity: other, hello: h, eph: sk, nowMs: t)!, identity: m4, expected: m1.device, hello: h, nowMs: t)) == "Not your second Mac")
  check("answer-old-refused", refused(RSHandshake.checkAnswer(RSHandshake.answer(identity: m1, hello: h, eph: sk, nowMs: t - 100_000)!, identity: m4, expected: m1.device, hello: h, nowMs: t)) == "Too old")
  let kp = RSHandshake.keys(mine: pk, theirs: spub, hello: h, answer: a)!, ks = RSHandshake.keys(mine: sk, theirs: ppub, hello: h, answer: a)!
  func raw(_ k: SymmetricKey) -> Data { k.withUnsafeBytes { Data($0) } }
  check("keys-match-both-sides", raw(kp.p2sTcp) == raw(ks.p2sTcp) && raw(kp.s2pUdp) == raw(ks.s2pUdp) && kp.sid == ks.sid && kp.sid.count == 8)
  check("keys-differ-per-direction", Set([raw(kp.p2sTcp), raw(kp.s2pTcp), raw(kp.p2sUdp), raw(kp.s2pUdp)]).count == 4)
  let k3 = RSHandshake.keys(mine: Curve25519.KeyAgreement.PrivateKey(), theirs: spub, hello: h, answer: a)!
  check("keys-fresh-per-session", raw(k3.p2sTcp) != raw(kp.p2sTcp))
}

// ---------- encryption ----------
do {
  let k = SymmetricKey(size: .bits256), sid = Data([1, 2, 3, 4, 5, 6, 7, 8])
  let s = RSSealer(k), o = RSOpener(k)
  let a = s.seal(Data("one".utf8))!.1, b = s.seal(Data("two".utf8))!.1
  check("tcp-in-order", o.openTCP(a) == Data("one".utf8) && o.openTCP(b) == Data("two".utf8))
  let s2 = RSSealer(k), o2 = RSOpener(k)
  let c = s2.seal(Data("x".utf8))!.1, d = s2.seal(Data("y".utf8))!.1
  check("tcp-reorder-refused", o2.openTCP(d) == nil)
  var bad = c; bad[bad.startIndex] ^= 1
  check("tcp-tamper-refused", RSOpener(k).openTCP(bad) == nil && RSOpener(SymmetricKey(size: .bits256)).openTCP(c) == nil)
  let us = RSSealer(k), uo = RSOpener(k)
  let p = (0..<100).map { us.sealUDP(Data([UInt8($0)]), sid: sid)! }
  check("udp-open", uo.openUDP(p[0], sid: sid) == Data([0]))
  check("udp-replay-refused", uo.openUDP(p[0], sid: sid) == nil)
  check("udp-reorder-ok", uo.openUDP(p[5], sid: sid) == Data([5]) && uo.openUDP(p[3], sid: sid) == Data([3]))
  _ = uo.openUDP(p[90], sid: sid)
  check("udp-too-old-refused", uo.openUDP(p[10], sid: sid) == nil && uo.openUDP(p[30], sid: sid) == Data([30]))
  check("udp-wrong-session-refused", RSOpener(k).openUDP(p[1], sid: Data(repeating: 0, count: 8)) == nil)
  var bp = p[2]; bp[bp.count - 1] ^= 1
  check("udp-tamper-refused", RSOpener(k).openUDP(bp, sid: sid) == nil)
  var hdr = p[4]; hdr[15] ^= 1   // the counter is authenticated (AAD)
  check("udp-counter-tamper-refused", RSOpener(k).openUDP(hdr, sid: sid) == nil)
}

// ---------- TCP framing ----------
do {
  var buf = RSFrame.frame(Data("a".utf8)) + RSFrame.frame(Data("bc".utf8)); buf.append(RSFrame.frame(Data("def".utf8)).prefix(5))
  let f = RSFrame.take(&buf, max: 100)!
  check("frames-split", f == [Data("a".utf8), Data("bc".utf8)] && buf.count == 5)
  var huge = RSWriter(); huge.u32(1_000_000); var hb = huge.data
  check("frames-too-big", RSFrame.take(&hb, max: 1000) == nil)
}

// ---------- fragments and reassembly ----------
func vf(_ n: UInt32, key: Bool, size: Int = 5000) -> Data { RSVideoFrame(number: n, keyframe: key, captureNs: 1, encodeUs: 2, params: key ? [Data([1, 2])] : [], data: Data(repeating: UInt8(n & 0xff), count: size)).encode() }
do {
  let r = RSReassembler()
  var out: [Data] = []
  for n: UInt32 in 1...3 { for p in RSPacket.fragments(of: vf(n, key: n == 1), number: n) { out += r.add(p, nowMs: 0).frames } }
  check("reasm-in-order", out == [vf(1, key: true), vf(2, key: false), vf(3, key: false)])
  let r2 = RSReassembler(); var o2: [Data] = []
  for p in RSPacket.fragments(of: vf(1, key: true), number: 1).reversed() { o2 += r2.add(p, nowMs: 0).frames }
  check("reasm-reordered-pieces", o2 == [vf(1, key: true)])
  // A lost piece of frame 2: frame 2 never shows, 3 and 4 (P frames) are held back, keyframe 5 shows.
  let r3 = RSReassembler(); var o3: [Data] = []; var asked = false
  for n: UInt32 in 1...5 {
    var ps = RSPacket.fragments(of: vf(n, key: n == 1 || n == 5), number: n)
    if n == 2 { ps.remove(at: 1) }
    for p in ps { let o = r3.add(p, nowMs: Double(n)); o3 += o.frames; asked = asked || o.needKeyframe }
  }
  check("reasm-loss-holds-until-keyframe", o3 == [vf(1, key: true), vf(5, key: true)] && asked && r3.lostTotal >= 1 && !r3.broken)
  // The last frame before the screen goes still loses a piece: the timer gives it up and asks for a keyframe.
  let r4 = RSReassembler()
  var ps4 = RSPacket.fragments(of: vf(7, key: false), number: 7); ps4.removeLast()
  for p in ps4 { _ = r4.add(p, nowMs: 0) }
  check("reasm-timeout-asks-keyframe", r4.tick(nowMs: 50).needKeyframe == false && r4.tick(nowMs: 200).needKeyframe)
  // Numbers wrap at 2^32.
  let r5 = RSReassembler(); var o5: [Data] = []
  for n: UInt32 in [UInt32.max - 1, UInt32.max, 0, 1] { for p in RSPacket.fragments(of: vf(n, key: n == UInt32.max - 1, size: 100), number: n) { o5 += r5.add(p, nowMs: 0).frames } }
  check("reasm-wraps", o5.count == 4 && RSReassembler.newer(0, than: UInt32.max))
  let late = RSPacket.fragments(of: vf(UInt32.max, key: false, size: 100), number: UInt32.max)[0]
  check("reasm-old-frame-ignored", r5.add(late, nowMs: 0).frames.isEmpty)
  var junk = RSWriter(); junk.u8(1); junk.u32(1); junk.u16(5); junk.u16(2)
  check("reasm-bad-index-ignored", RSReassembler().add(junk.data, nowMs: 0).frames.isEmpty)
  check("fragment-size", RSPacket.fragments(of: Data(count: 100_000), number: 1).allSatisfy { $0.count <= RSPacket.chunk + 9 } && 16 + 16 + RSPacket.chunk + 9 < 1400)
  let f = RSVideoFrame(number: 9, keyframe: true, captureNs: 123, encodeUs: 456, params: [Data([1]), Data([2, 3])], data: Data([4, 5, 6]))
  check("video-frame-roundtrip", RSVideoFrame.decode(f.encode()) == f && RSVideoFrame.isKeyframe(f.encode()))
}

// ---------- mapping ----------
do {
  let pic = RSFit.rect(content: CGSize(width: 2560, height: 1600), in: CGRect(x: 0, y: 0, width: 1000, height: 1000))
  check("fit-letterbox", abs(pic.width - 1000) < 0.01 && abs(pic.height - 625) < 0.01 && abs(pic.minY - 187.5) < 0.01)
  let tl = RSFit.normalize(CGPoint(x: pic.minX, y: pic.maxY), picture: pic), br = RSFit.normalize(CGPoint(x: pic.maxX, y: pic.minY), picture: pic)
  check("fit-corners", tl == (0, 0) && br == (1, 1))
  check("fit-clamps", RSFit.normalize(CGPoint(x: -50, y: 2000), picture: pic) == (0, 0))
  let d = CGRect(x: 0, y: 0, width: 1470, height: 956)
  check("to-display", RSFit.toDisplay(0, 0, bounds: d) == .zero && RSFit.toDisplay(1, 1, bounds: CGRect(x: 100, y: 0, width: 1470, height: 956)) == CGPoint(x: 1569, y: 955))
  check("encode-size", RSFit.encodeSize(pixels: CGSize(width: 2560, height: 1600), maxW: 2560) == (2560, 1600) && RSFit.encodeSize(pixels: CGSize(width: 3456, height: 2234), maxW: 2560) == (2560, 1654))
}

// ---------- bitrate, clock, numbers, scroll, Esc ----------
do {
  var r = RSRate(startKbps: 20_000)
  let down = r.feedback(loss: 0.05, latencyMs: 20)
  var up = down; for _ in 0..<3 { up = r.feedback(loss: 0, latencyMs: 20) }
  check("rate-down-on-loss-up-slowly", down == 14_000 && up == 20_000)
  for _ in 0..<50 { _ = r.feedback(loss: 0.5, latencyMs: nil) }
  check("rate-floor", r.kbps == r.minKbps)
  var r2 = RSRate(startKbps: 20_000); _ = r2.feedback(loss: 0, latencyMs: 15)
  check("rate-down-on-delay", r2.feedback(loss: 0, latencyMs: 80) < 22_000)
  var c = RSClock()
  c.pong(sent: 1_000_000, remote: 50_000_000_000, received: 3_000_000)    // rtt 2 ms
  c.pong(sent: 10_000_000, remote: 50_000_000_000 + 9_500_000, received: 20_000_000)  // rtt 10 ms, worse
  check("clock-best-sample", c.rttNs == 2_000_000 && c.offset == 50_000_000_000 - 2_000_000 && c.local(50_000_000_000) == 2_000_000)
  var s = RSStats(size: 100); for i in 1...100 { s.add(Double(i)) }
  check("stats-percentiles", s.p50 == 51 && s.p95 == 95 && s.maximum == 100 && s.line.hasPrefix("p50 51.0"))
  check("scroll-phases", RSScroll.cgPhase(1) == 1 && RSScroll.cgPhase(4) == 2 && RSScroll.cgPhase(8) == 4 && RSScroll.cgPhase(0) == 0 && RSScroll.cgMomentum(4) == 2 && RSScroll.cgMomentum(8) == 3 && RSScroll.lines(0.2) == 1 && RSScroll.lines(-0.2) == -1)
  check("flags-mask", RSFlags.clean(0x0012_0100) == 0x0012_0000)
  var e = RSEscape()
  check("escape-twice-closes", e.press(at: 0) == false && e.press(at: 0.3) == true && e.press(at: 1) == false && e.press(at: 2) == false)
  check("local-addresses", RSNet.isLocal(.hostPort(host: "192.168.1.5", port: 1)) && RSNet.isLocal(.hostPort(host: "169.254.3.2", port: 1)) && RSNet.isLocal(.hostPort(host: "fe80::1", port: 1))
        && !RSNet.isLocal(.hostPort(host: "8.8.8.8", port: 1)) && !RSNet.isLocal(.hostPort(host: "172.32.0.1", port: 1)) && !RSNet.isLocal(.hostPort(host: "2001:db8::1", port: 1)))
}

final class Box<T> { var v: T; init(_ v: T) { self.v = v } }

// ---------- part 2: the hold key (RSHold), its key choices, the Dock app's words ----------
do {
  typealias E = RSHold.Out.Event
  func k(_ h: inout RSHold, _ c: Int64, _ down: Bool, rep: Bool = false, mods: Bool = false, armed: Bool = true, up: Bool = false) -> RSHold.Out {
    h.key(code: c, down: down, repeating: rep, modifiers: mods, armed: armed, up: up)
  }
  // Held: shown after the hold time, repeats and the key up swallowed (never typed here or on the other Mac), let go hides.
  var h = RSHold(); h.code = 10
  let d1 = k(&h, 10, true)
  let r1 = k(&h, 10, true, rep: true)
  let f1 = h.fire()
  let r2 = k(&h, 10, true, rep: true)
  let other = k(&h, 0, true)   // typing while it is up goes to the window (the other Mac)
  let u1 = k(&h, 10, false)
  check("hold-shows-and-swallows", d1 == RSHold.Out(event: .swallow, startTimer: true) && r1.event == .swallow && f1 == .show && r2.event == .swallow
        && other.event == .notMine && u1 == RSHold.Out(event: .swallow, release: true) && h.state == .idle)
  // A quick press: a normal key, sent on (down and up) in order, nothing shown.
  var q = RSHold(); q.code = 10
  _ = k(&q, 10, true)
  let qu = k(&q, 10, false)
  check("hold-quick-press-is-a-key", qu.event == .repostHeldThenThis && q.fire() == nil && q.state == .idle)
  // Another key before the hold time: the held key first, then that key; the hold key's own up then passes.
  var o = RSHold(); o.code = 10
  _ = k(&o, 10, true)
  let ok1 = k(&o, 0, true)
  let ok2 = k(&o, 10, false)
  check("hold-typing-stays-in-order", ok1.event == .repostHeldThenThis && ok2.event == .pass && o.fire() == nil && o.state == .idle)
  // Not armed (switched off, not paired, 1Password or Signal in front, the Tab hold busy), with a modifier, or a repeat: not ours.
  var n = RSHold(); n.code = 10
  check("hold-not-armed", k(&n, 10, true, armed: false).event == .notMine && k(&n, 10, true, mods: true).event == .notMine && k(&n, 10, true, rep: true).event == .notMine && n.state == .idle)
  // Held while the screen is up and has the keyboard: it goes away (and the key up is swallowed).
  var u = RSHold(); u.code = 10
  _ = k(&u, 10, true, up: true)
  let uf = u.fire()
  check("hold-while-up-hides", uf == .hide && k(&u, 10, true, rep: true).event == .swallow && k(&u, 10, false).event == .swallow && u.state == .idle)
  // The watchdog: a held key is sent on, nothing left waiting.
  var w = RSHold(); w.code = 10
  _ = k(&w, 10, true)
  check("hold-watchdog-reset", w.reset() && w.state == .idle && !w.reset())
  check("hold-key-choices", RSHoldKeys.code(nil) == 10 && RSHoldKeys.code("section") == 10 && RSHoldKeys.code("grave") == 50 && RSHoldKeys.code("f13") == 105
        && RSHoldKeys.code("off") == nil && RSHoldKeys.code("nonsense") == 10)
  check("dock-words", RSDockRules.verb(Data("open\n".utf8)) == "open" && RSDockRules.verb(Data("sentry".utf8)) == "sentry"
        && RSDockRules.verb(Data("rm -rf\n".utf8)) == nil && RSDockRules.verb(Data(repeating: 0x61, count: 40)) == nil && RSDockRules.verb(Data([0xff, 0xfe])) == nil
        && RSDockRules.verbs == ["open", "lock", "sentry", "shutdown", "restart"])
}

// ---------- codec: made up pictures through the real hardware encoder and decoder ----------
func makePool(_ w: Int, _ h: Int) -> CVPixelBufferPool {
  var pool: CVPixelBufferPool?
  let attrs: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, kCVPixelBufferWidthKey: w, kCVPixelBufferHeightKey: h,
                                kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
  CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &pool)
  return pool!
}
/// A made up screen: grey with a moving bright bar and a few "text" stripes (fills the luma plane; chroma neutral).
func picture(_ pool: CVPixelBufferPool, _ i: Int) -> CVPixelBuffer {
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
  let b = pb!
  CVPixelBufferLockBaseAddress(b, [])
  let w = CVPixelBufferGetWidthOfPlane(b, 0), h = CVPixelBufferGetHeightOfPlane(b, 0), stride = CVPixelBufferGetBytesPerRowOfPlane(b, 0)
  let y = CVPixelBufferGetBaseAddressOfPlane(b, 0)!.assumingMemoryBound(to: UInt8.self)
  let bar = (i * 23) % max(1, h - 40)
  for row in 0..<h {
    let v: UInt8 = (row >= bar && row < bar + 40) ? 235 : (row % 24 < 2 ? 40 : 128)
    memset(y + row * stride, Int32(v), w)
  }
  let ch = CVPixelBufferGetHeightOfPlane(b, 1), cs = CVPixelBufferGetBytesPerRowOfPlane(b, 1)
  memset(CVPixelBufferGetBaseAddressOfPlane(b, 1)!, 128, ch * cs)
  CVPixelBufferUnlockBaseAddress(b, [])
  return b
}

// Encode then decode at once on the encoder's own thread: the codec's share of the delay, per size, codec and decoder output.
for codec in [RSCodec.h264, .hevc] {
  for (w, h) in [(2560, 1600), (1920, 1200), (1280, 800)] {
    for fmt in [kCVPixelFormatType_32BGRA, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange] {
      guard let enc = RSEncoder(width: w, height: h, fps: 60, codec: codec, kbps: 20_000) else { check("codec-\(codec.rawValue)-encoder", false); continue }
      let dec = RSDecoder(codec: enc.codec, pixelFormat: fmt)
      let pool = makePool(w, h)
      let lat = Box(RSStats()), enc_ = Box(RSStats()), images = Box(0), bytes = Box(0)
      dec.onImage = { img, f in images.v += 1; if CVPixelBufferGetWidth(img) == w { lat.v.add(Double(RSTime.nowNs - f.captureNs) / 1e6) } }
      enc.onFrame = { f in enc_.v.add(Double(f.encodeUs) / 1000); bytes.v += f.data.count; dec.decode(RSVideoFrame.decode(f.encode())!) }
      for i in 0..<90 { enc.encode(picture(pool, i), pts: CMTime(value: Int64(i), timescale: 60), captureNs: RSTime.nowNs); usleep(16_600) }
      usleep(100_000)
      let name = "codec-\(enc.codec.rawValue)-\(w)x\(h)-\(fmt == kCVPixelFormatType_32BGRA ? "bgra" : "420v")"
      check(name + "-decodes", images.v >= 85)
      print("\(name): encode p50 \(String(format: "%.1f", enc_.v.p50 ?? -1)) ms, capture to decoded \(lat.v.line) ms, \(bytes.v * 8 / 1500) kbps")
      enc.invalidate()
    }
  }
}

// ---------- the picture in a layer: a 4:2:0 IOSurface (the decoder's default output) shows the right colours ----------
// Rendered offscreen with CARenderer into a Metal texture: nothing appears on any screen.
func layerColour(_ pb: CVPixelBuffer) -> (Int, Int, Int)? {
  guard let dev = MTLCreateSystemDefaultDevice(), let cq = dev.makeCommandQueue() else { return nil }
  let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 64, height: 64, mipmapped: false)
  td.usage = [.renderTarget, .shaderRead]; td.storageMode = .shared
  guard let tex = dev.makeTexture(descriptor: td) else { return nil }
  let r = CARenderer(mtlTexture: tex, options: [kCARendererMetalCommandQueue as String: cq])
  let root = CALayer(); root.frame = CGRect(x: 0, y: 0, width: 64, height: 64); root.backgroundColor = CGColor(gray: 0.5, alpha: 1)
  let pic = CALayer(); pic.frame = root.bounds; pic.contentsGravity = .resizeAspect
  pic.contents = CVPixelBufferGetIOSurface(pb)!.takeUnretainedValue()
  root.addSublayer(pic)
  r.layer = root; r.bounds = root.bounds
  CATransaction.flush()
  for _ in 0..<3 {
    r.beginFrame(atTime: CACurrentMediaTime(), timeStamp: nil); r.addUpdate(r.bounds); r.render(); r.endFrame()
    let cb = cq.makeCommandBuffer()!; cb.commit(); cb.waitUntilCompleted()
    usleep(30_000)
  }
  var px = [UInt8](repeating: 0, count: 4)
  tex.getBytes(&px, bytesPerRow: 64 * 4, from: MTLRegionMake2D(32, 32, 1, 1), mipmapLevel: 0)
  return (Int(px[2]), Int(px[1]), Int(px[0]))
}
func solid(_ fmt: OSType) -> CVPixelBuffer {
  var pb: CVPixelBuffer?
  CVPixelBufferCreate(nil, 64, 64, fmt, [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary, &pb)
  let b = pb!
  CVPixelBufferLockBaseAddress(b, [])
  if fmt == kCVPixelFormatType_32BGRA {
    let p = CVPixelBufferGetBaseAddress(b)!.assumingMemoryBound(to: UInt8.self), st = CVPixelBufferGetBytesPerRow(b)
    for y in 0..<64 { for x in 0..<64 { let o = y * st + x * 4; p[o] = 0; p[o + 1] = 0; p[o + 2] = 255; p[o + 3] = 255 } }
  } else {   // pure red in BT.709 video range: Y 63, Cb 102, Cr 240
    memset(CVPixelBufferGetBaseAddressOfPlane(b, 0)!, 63, CVPixelBufferGetBytesPerRowOfPlane(b, 0) * 64)
    let c = CVPixelBufferGetBaseAddressOfPlane(b, 1)!.assumingMemoryBound(to: UInt8.self), cs = CVPixelBufferGetBytesPerRowOfPlane(b, 1)
    for y in 0..<32 { for x in 0..<32 { c[y * cs + x * 2] = 102; c[y * cs + x * 2 + 1] = 240 } }
    CVBufferSetAttachment(b, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(b, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
    CVBufferSetAttachment(b, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
  }
  CVPixelBufferUnlockBaseAddress(b, [])
  return b
}
for (name, fmt) in [("bgra", kCVPixelFormatType_32BGRA), ("420v", kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)] {
  let c = layerColour(solid(fmt))
  print("layer-\(name): centre pixel \(c.map { "\($0.0),\($0.1),\($0.2)" } ?? "none")")
  check("layer-shows-\(name)-in-colour", c.map { $0.0 > 200 && $0.1 < 70 && $0.2 < 70 } ?? false)
}

// ---------- loopback: the real listener, client, handshake, link, encoder and decoder over 127.0.0.1 ----------
let q = DispatchQueue(label: "test.screen")
func waitFor(_ s: Double, _ cond: () -> Bool) -> Bool { let end = Date().addingTimeInterval(s); while Date() < end { if cond() { return true }; usleep(5_000) }; return cond() }


let server = RSServer(identity: m1, q: q, loopback: true)
let serverLink = Box<RSLink?>(nil), inputs = Box<[RSInput]>([]), inputLat = Box(RSStats())
let sender = Box<RSSender?>(nil)
let started = Box(false)
server.onSession = { l in
  serverLink.v = l
  let s = RSSender(link: l); sender.v = s
  l.onCtl = { t, d in
    if s.handle(t, d) { return }
    if t == .input, d.count > 8 {   // the test prefixes each input with the primary's clock to time it
      var r = RSReader(d); let sent = r.u64()!
      inputLat.v.add(Double(RSTime.nowNs - sent) / 1e6)
      if let i = RSInput.decode(r.rest()) { inputs.v.append(i) }
    }
  }
  l.onUdp = { _ in }
}
server.start(advertise: false) { ok in started.v = ok }
check("loopback-listener", waitFor(3) { started.v } && server.tcpPort != nil && server.udpPort != nil)
let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: server.tcpPort!)!)

// An unpaired Mac gets no answer at all.
do {
  let r = Box<Result<RSLink, RSClient.Fail>?>(nil)
  let c = RSClient(identity: stranger, secondary: m1AsPeer, q: q, loopback: true)
  q.async { c.connect(hints: [endpoint], browse: false, timeout: 2) { r.v = $0 } }
  _ = waitFor(8) { r.v != nil }
  if case .failure(.refused(let w))? = r.v { check("loopback-stranger-gets-no-answer", w == "no answer" && serverLink.v == nil) } else { check("loopback-stranger-gets-no-answer", false) }
}

// The paired primary.
let clientLink = Box<RSLink?>(nil)
let receiver = Box<RSReceiver?>(nil)
let shownLat = Box(RSStats())
let t0 = RSTime.nowNs
let handshakeMs = Box(0.0)
do {
  let r = Box<Result<RSLink, RSClient.Fail>?>(nil)
  let c = RSClient(identity: m4, secondary: m1AsPeer, q: q, loopback: true)
  q.async { c.connect(hints: [endpoint], browse: false, timeout: 3) { r.v = $0 } }
  _ = waitFor(8) { r.v != nil }
  handshakeMs.v = Double(RSTime.nowNs - t0) / 1e6
  guard case .success(let l)? = r.v else { check("loopback-handshake", false); print("FAILED \(fails)"); exit(1) }
  check("loopback-handshake", waitFor(2) { serverLink.v != nil })
  clientLink.v = l
  let rc = RSReceiver(link: l, q: q); receiver.v = rc
  rc.onImage = { img, f in rc.shown(f) }   // "shown" = decoded here (no window in a test)
  l.onCtl = { t, d in
    if rc.handle(t, d) { return }
    if t == .screen, let i = try? JSONDecoder().decode(RSScreenInfo.self, from: d) { rc.configure(i) }
  }
  l.onUdp = { b in rc.udp(b) }
  q.async { l.start(); rc.start() }
}
print("loopback: handshake \(String(format: "%.1f", handshakeMs.v)) ms (TCP connect, signed hello, signed answer, keys)")

/// Streams `seconds` of made up 60 fps pictures; returns capture to decoded numbers.
func stream(seconds: Double, udp: Bool, label: String) -> RSStats {
  guard let s = sender.v, let rc = receiver.v, let sl = serverLink.v, let cl = clientLink.v else { return RSStats() }
  let (w, h) = (2560, 1600)
  let info = s.configure(width: w, height: h, points: CGSize(width: 1280, height: 800))!
  sl.sendJSON(.screen, info)
  if udp { q.async { RSClient.openUDP(for: cl, port: server.udpPort!, q: q, loopback: true) }; _ = waitFor(3) { sl.udpReady && cl.udpReady } }
  _ = waitFor(2) { rc.clock.offset != nil && rc.info != nil }
  let pool = makePool(w, h)
  let before = rc.framesShown
  let n = Int(seconds * 60)
  let start = Date()
  for i in 0..<n {
    s.frame(picture(pool, i), pts: CMTime(value: Int64(i), timescale: 60), captureNs: RSTime.nowNs)
    let next = start.addingTimeInterval(Double(i + 1) / 60)
    let wait = next.timeIntervalSinceNow; if wait > 0 { usleep(useconds_t(wait * 1e6)) }
  }
  _ = waitFor(1) { rc.framesShown - before >= n - 2 }
  let shown = rc.framesShown - before
  check("loopback-\(label)-frames", shown >= n * 95 / 100)
  let st = Box(RSStats()); q.sync { st.v = rc.total }
  print("loopback-\(label): \(shown) of \(n) frames shown; capture to decoded \(st.v.line) ms; encode p50 \(String(format: "%.1f", rc.encode.p50 ?? -1)) network p50 \(String(format: "%.1f", rc.network.p50 ?? -1)) decode p50 \(String(format: "%.1f", rc.decode.p50 ?? -1)) ms; bitrate \(s.rate.kbps / 1000) Mbps")
  return st.v
}

let udpStats = stream(seconds: 5, udp: true, label: "udp")
check("loopback-udp-path", serverLink.v?.udpReady == true)
check("loopback-udp-latency-under-50ms", (udpStats.p95 ?? 999) < 50)

// Input: the primary's events reach the secondary decoded and in order.
do {
  guard let cl = clientLink.v else { exit(1) }
  let evs: [RSInput] = (0..<200).map { .move(x: Float($0) / 200, y: 0.5, buttons: 0) } + [.down(x: 0.5, y: 0.5, button: 0, clicks: 1, flags: 0), .up(x: 0.5, y: 0.5, button: 0, clicks: 1, flags: 0), .key(code: 0, down: true, flags: 0, repeating: false)]
  for e in evs { var w = RSWriter(); w.u64(RSTime.nowNs); w.bytes(e.encode()); cl.send(.input, w.data); usleep(1000) }
  check("loopback-input-in-order", waitFor(3) { inputs.v.count == evs.count } && inputs.v == evs)
  print("loopback-input: \(inputs.v.count) events, primary to secondary \(inputLat.v.line) ms")
}

// A forged UDP packet (right session id, wrong key) and a replayed one are dropped.
do {
  guard let sl = serverLink.v else { exit(1) }
  let before = sl.counts.udpBad
  let forged = RSSealer(SymmetricKey(size: .bits256)).sealUDP(RSPacket.hello(clockNs: 1), sid: sl.keys.sid)!
  check("loopback-forged-udp-dropped", !sl.openUDP(forged) && sl.counts.udpBad == before + 1)
}

// Video over TCP when UDP cannot get through (a fresh session without the UDP hello).
do {
  receiver.v?.stop(); clientLink.v?.close("test"); serverLink.v = nil
  let r = Box<Result<RSLink, RSClient.Fail>?>(nil)
  let c = RSClient(identity: m4, secondary: m1AsPeer, q: q, loopback: true)
  q.async { c.connect(hints: [endpoint], browse: false, timeout: 3) { r.v = $0 } }
  _ = waitFor(8) { r.v != nil && serverLink.v != nil }
  guard case .success(let l)? = r.v else { check("loopback-tcp-session", false); exit(1) }
  clientLink.v = l
  let rc = RSReceiver(link: l, q: q); receiver.v = rc
  rc.onImage = { _, f in rc.shown(f) }
  l.onCtl = { t, d in if rc.handle(t, d) { return }; if t == .screen, let i = try? JSONDecoder().decode(RSScreenInfo.self, from: d) { rc.configure(i) } }
  q.async { l.start(); rc.start() }
  let tcpStats = stream(seconds: 3, udp: false, label: "tcp")
  check("loopback-tcp-latency-under-50ms", (tcpStats.p95 ?? 999) < 50)
  // The old session's link is gone and the new one is the only one.
  check("loopback-one-session", server.link === serverLink.v)
  // bye ends both sides.
  let closed = Box(false)
  serverLink.v?.onClose = { _ in closed.v = true }
  l.bye()
  check("loopback-bye-closes-both", waitFor(3) { closed.v && l.isClosed })
}
server.stop()

print(fails == 0 ? "ALL OK" : "FAILED \(fails)")
exit(fails == 0 ? 0 : 1)
