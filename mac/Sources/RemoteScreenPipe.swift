import CoreMedia
import CoreVideo
import Foundation

// Second Computer remote screen: the two ends of the video pipe, without any screen or window, so the loopback test runs
// them exactly as PS does. RSSender (the secondary): encoded frames out, the bitrate from the primary's feedback, keyframes on
// request, pings answered. RSReceiver (the primary): fragments in, whole frames decoded at once, the other Mac's clock learnt
// from pings, latency measured capture to display, feedback twice a second. All on the link's own queue.

final class RSSender {
  let link: RSLink
  private(set) var encoder: RSEncoder?
  private(set) var rate = RSRate()
  private let lock = NSLock()
  private var last: (CVPixelBuffer, CMTime, Double)?
  private(set) var framesOut = 0, skipped = 0
  var log: (String) -> Void = { _ in }

  /// PS 1.77: through the relay the bitrate is held to 8 Mbps at most (RSRelayRules.rate), so a month stays inside the free
  /// 1,000 GB; a direct link keeps the home network's own range.
  init(link: RSLink) { self.link = link; rate = RSRelayRules.rate(relayed: link.relayed) }

  /// Makes the encoder for this picture size. Returns what the primary needs to know (sent by the caller with the UDP port).
  func configure(width: Int, height: Int, points: CGSize, fps: Int = 60, codec: RSCodec = .h264) -> RSScreenInfo? {
    encoder?.invalidate()
    guard let e = RSEncoder(width: width, height: height, fps: fps, codec: codec, kbps: rate.kbps) else { log("PS screen: no hardware encoder"); return nil }
    e.onFrame = { [weak self] f in
      guard let self else { return }
      if self.link.sendVideo(f) { self.lock.lock(); self.framesOut += 1; self.lock.unlock() } else { self.lock.lock(); self.skipped += 1; self.lock.unlock(); e.requestKeyframe() }
    }
    encoder = e
    log("PS screen: encoder \(e.codec.rawValue) \(width)x\(height) at \(fps) fps, low latency \(e.lowLatency ? "on" : "off")")
    return RSScreenInfo(w: width, h: height, pw: Double(points.width), ph: Double(points.height), codec: e.codec.rawValue, fps: fps)
  }

  /// One captured picture (any thread).
  func frame(_ pb: CVPixelBuffer, pts: CMTime, captureNs: UInt64) {
    lock.lock(); last = (pb, pts, RSTime.nowMs); lock.unlock()
    encoder?.encode(pb, pts: pts, captureNs: captureNs)
  }

  /// The control messages that are about the video. True when handled here.
  func handle(_ t: RSCtl, _ d: Data) -> Bool {
    switch t {
    case .ping:
      var r = RSReader(d)
      guard let t1 = r.u64() else { return true }
      var w = RSWriter(); w.u64(t1); w.u64(RSTime.nowNs)
      link.send(.pong, w.data)
      return true
    case .keyframe:
      encoder?.requestKeyframe()
      // The screen may be still (ScreenCaptureKit sends nothing then): the last picture again, as a keyframe.
      lock.lock(); let l = last; lock.unlock()
      if let (pb, pts, at) = l, RSTime.nowMs - at > 30 {
        encoder?.encode(pb, pts: CMTimeAdd(pts, CMTime(value: Int64(max(1, (RSTime.nowMs - at) * 1000)), timescale: 1_000_000)), captureNs: RSTime.nowNs)
      }
      return true
    case .feedback:
      guard let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return true }
      let loss = (o["loss"] as? NSNumber)?.doubleValue ?? 0, lat = (o["lat"] as? NSNumber)?.doubleValue
      let k = rate.feedback(loss: min(max(loss, 0), 1), latencyMs: lat)
      encoder?.setBitrate(k)
      return true
    default: return false
    }
  }

  func stop() { encoder?.invalidate(); encoder = nil; lock.lock(); last = nil; lock.unlock() }
}

final class RSReceiver {
  let link: RSLink
  private let q: DispatchQueue
  private(set) var info: RSScreenInfo?
  private var decoder: RSDecoder?
  private let reasm = RSReassembler()
  private(set) var clock = RSClock()
  /// Capture on the secondary to the picture shown here, and its parts (ms).
  private(set) var total = RSStats(), encode = RSStats(), network = RSStats(), decode = RSStats()
  private var lastKeyAsk = 0.0
  private var timers: [DispatchSourceTimer] = []
  private var lostAtFeedback = 0, framesAtFeedback = 0
  private(set) var framesShown = 0
  private var bytesIn = 0, bytesAtFeedback = 0
  private var firstPacket: [UInt32: UInt64] = [:]
  /// Each decoded picture, on the link's queue. The caller shows it and then calls `shown(frame:)`.
  var onImage: (CVPixelBuffer, RSVideoFrame) -> Void = { _, _ in }
  var log: (String) -> Void = { _ in }
  /// Called after each feedback with the log line's numbers (the window's small status line uses it).
  var onNumbers: (String) -> Void = { _ in }
  private var logEvery = 0

  /// The decoder's output: the encoder's own 4:2:0 by default (about 2.5 ms less than BGRA at 2560x1600, tests); BGRA if a Mac
  /// ever shows wrong colours with it.
  var decoderFormat: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

  init(link: RSLink, q: DispatchQueue) { self.link = link; self.q = q }

  func configure(_ i: RSScreenInfo) {
    info = i
    decoder?.invalidate()
    let d = RSDecoder(codec: RSCodec(rawValue: i.codec) ?? .h264, pixelFormat: decoderFormat)
    d.onImage = { [weak self] img, f in self?.onImage(img, f) }
    decoder = d
    reasm.reset()
    askKeyframe(force: true)
  }

  func start() {
    func every(_ s: Double, _ f: @escaping () -> Void) {
      let t = DispatchSource.makeTimerSource(queue: q)
      t.schedule(deadline: .now() + s, repeating: s, leeway: .milliseconds(5))
      t.setEventHandler(handler: f)
      t.resume(); timers.append(t)
    }
    ping()
    every(1) { [weak self] in self?.ping() }
    every(0.05) { [weak self] in
      guard let self else { return }
      let o = self.reasm.tick(nowMs: RSTime.nowMs)
      if o.needKeyframe { self.askKeyframe() }
    }
    every(0.5) { [weak self] in self?.feedback() }
  }

  /// Any thread: the timers and the decoder stop on the link's queue (never in the middle of a decode).
  func stop() { q.async { [self] in timers.forEach { $0.cancel() }; timers = []; decoder?.invalidate(); decoder = nil } }

  private func ping() { var w = RSWriter(); w.u64(RSTime.nowNs); link.send(.ping, w.data) }

  private func askKeyframe(force: Bool = false) {
    let now = RSTime.nowMs
    guard force || now - lastKeyAsk > 150 else { return }   // never a flood: one ask per 150 ms
    lastKeyAsk = now
    link.send(.keyframe)
  }

  /// Control messages about the video. True when handled here.
  func handle(_ t: RSCtl, _ d: Data) -> Bool {
    switch t {
    case .pong:
      var r = RSReader(d)
      if let t1 = r.u64(), let t2 = r.u64() { clock.pong(sent: t1, remote: t2, received: RSTime.nowNs) }
      return true
    case .video:   // a whole frame over TCP (UDP did not get through)
      bytesIn += d.count
      take(d, arrived: RSTime.nowNs)
      return true
    case .udpOK: link.setUdpReady(true); log("PS screen: video over UDP"); return true
    default: return false
    }
  }

  /// A UDP body (on the link's queue).
  func udp(_ body: Data) {
    bytesIn += body.count
    var r = RSReader(body)
    if r.u8() == RSPacket.kindVideo, let n = r.u32(), firstPacket[n] == nil { firstPacket[n] = RSTime.nowNs; if firstPacket.count > 128 { firstPacket.removeAll() } }
    let o = reasm.add(body, nowMs: RSTime.nowMs)
    for f in o.frames { take(f, arrived: RSTime.nowNs) }
    if o.needKeyframe { askKeyframe() }
  }

  private func take(_ bytes: Data, arrived: UInt64) {
    guard let f = RSVideoFrame.decode(bytes), let d = decoder else { return }
    firstPacket[f.number] = nil
    if let c = clock.local(f.captureNs) {
      encode.add(Double(f.encodeUs) / 1000)
      let sentAt = c &+ UInt64(f.encodeUs) * 1000   // encoded = sent (the send is immediate)
      if arrived > sentAt { network.add(Double(arrived - sentAt) / 1e6) }
    }
    let t0 = RSTime.nowNs
    if !d.decode(f) { askKeyframe() }
    decode.add(Double(RSTime.nowNs - t0) / 1e6)
  }

  /// After the picture is on screen (or, in the loopback test, decoded): capture to now.
  func shown(_ f: RSVideoFrame) {
    framesShown += 1
    guard let c = clock.local(f.captureNs) else { return }
    let now = RSTime.nowNs
    if now > c { total.add(Double(now - c) / 1e6) }
  }

  private func feedback() {
    let lost = reasm.lostTotal - lostAtFeedback, ok = reasm.framesTotal - framesAtFeedback
    lostAtFeedback = reasm.lostTotal; framesAtFeedback = reasm.framesTotal
    let kbps = (bytesIn - bytesAtFeedback) * 8 / 500
    bytesAtFeedback = bytesIn
    let loss = lost + ok > 0 ? Double(lost) / Double(lost + ok) : 0
    var o: [String: Any] = ["loss": loss, "kbps": kbps]
    if let p = total.p50 { o["lat"] = p }
    if let d = try? JSONSerialization.data(withJSONObject: o) { link.send(.feedback, d) }
    logEvery += 1
    let line = "capture to display \(total.line); encode \(encode.p50.map { String(format: "%.1f", $0) } ?? "-") network \(network.p50.map { String(format: "%.1f", $0) } ?? "-") decode \(decode.p50.map { String(format: "%.1f", $0) } ?? "-") ms; \(kbps / 1000) Mbps; lost \(reasm.lostTotal) of \(reasm.framesTotal + reasm.lostTotal) frames; rtt \(clock.rttNs.map { String(format: "%.1f", Double($0) / 1e6) } ?? "-") ms"
    onNumbers(line)
    if logEvery % 20 == 0 { log("PS screen: \(line)"); total.reset(); encode.reset(); network.reset(); decode.reset() }   // every 10 s, numbers only
  }
}
