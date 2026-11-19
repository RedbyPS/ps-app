import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

// Second Computer remote screen: the hardware video encoder (on the secondary) and decoder (on the primary).
// Tuned for the lowest delay, like a game stream: real time, no B frames (no reordering, so every frame goes out the moment
// it is encoded), no frame delay, low latency rate control, a keyframe at least every 2 seconds and at once when the
// primary lost a packet. Frames live in memory only; nothing is ever written anywhere.

enum RSCodec: String { case h264, hevc }

final class RSEncoder {
  let width: Int, height: Int, fps: Int
  private(set) var codec: RSCodec
  private var session: VTCompressionSession?
  private var number: UInt32 = 0
  private var forceKey = true
  private let lock = NSLock()
  /// Each encoded frame, on VideoToolbox's own thread.
  var onFrame: (RSVideoFrame) -> Void = { _ in }
  private(set) var kbps: Int
  /// Whether macOS gave the low latency rate control (H.264 on Apple silicon does).
  private(set) var lowLatency = false

  init?(width: Int, height: Int, fps: Int = 60, codec: RSCodec = .h264, kbps: Int = 20_000) {
    self.width = width; self.height = height; self.fps = fps; self.codec = codec; self.kbps = kbps
    if !make(codec, lowLatency: true) && !make(codec, lowLatency: false) {
      // HEVC not there: H.264 always is on Apple silicon.
      guard codec != .h264, make(.h264, lowLatency: true) || make(.h264, lowLatency: false) else { return nil }
      self.codec = .h264
    }
  }

  private func make(_ c: RSCodec, lowLatency ll: Bool) -> Bool {
    var spec: [CFString: Any] = [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder: true]
    if ll { spec[kVTVideoEncoderSpecification_EnableLowLatencyRateControl] = true }
    var s: VTCompressionSession?
    let st = VTCompressionSessionCreate(allocator: nil, width: Int32(width), height: Int32(height),
                                        codecType: c == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
                                        encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
                                        outputCallback: nil, refcon: nil, compressionSessionOut: &s)
    guard st == noErr, let s else { return false }
    func set(_ k: CFString, _ v: Any) { VTSessionSetProperty(s, key: k, value: v as CFTypeRef) }
    set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue!)
    set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse!)   // no B frames
    set(kVTCompressionPropertyKey_MaxFrameDelayCount, 0 as CFNumber)
    set(kVTCompressionPropertyKey_ExpectedFrameRate, fps as CFNumber)
    set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (fps * 2) as CFNumber)
    set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 2 as CFNumber)
    set(kVTCompressionPropertyKey_AverageBitRate, (kbps * 1000) as CFNumber)
    if c == .h264 {
      set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
      set(kVTCompressionPropertyKey_H264EntropyMode, kVTH264EntropyMode_CABAC)
    } else {
      set(kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_HEVC_Main_AutoLevel)
    }
    if #available(macOS 12.0, *) { set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue!) }
    if !ll { set(kVTCompressionPropertyKey_DataRateLimits, [kbps * 1000 / 8 * 2, 1] as CFArray) }   // a cap of 2x average per second
    VTCompressionSessionPrepareToEncodeFrames(s)
    if let old = session { VTCompressionSessionInvalidate(old) }
    session = s; codec = c; lowLatency = ll
    return true
  }

  /// The bitrate from RSRate (the primary's feedback).
  func setBitrate(_ k: Int) {
    lock.lock(); defer { lock.unlock() }
    guard let s = session, k != kbps else { return }
    kbps = k
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: (k * 1000) as CFNumber)
    if !lowLatency { VTSessionSetProperty(s, key: kVTCompressionPropertyKey_DataRateLimits, value: [k * 1000 / 8 * 2, 1] as CFArray) }
  }

  func requestKeyframe() { lock.lock(); forceKey = true; lock.unlock() }

  /// One captured frame. `captureNs`: when it was captured (RSTime clock). Returns false if the encoder refused it.
  @discardableResult
  func encode(_ pb: CVPixelBuffer, pts: CMTime, captureNs: UInt64) -> Bool {
    lock.lock()
    guard let s = session else { lock.unlock(); return false }
    let key = forceKey; forceKey = false
    lock.unlock()
    let props: CFDictionary? = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let codec = self.codec
    let st = VTCompressionSessionEncodeFrame(s, imageBuffer: pb, presentationTimeStamp: pts, duration: .invalid, frameProperties: props, infoFlagsOut: nil) { [weak self] status, _, sb in
      guard let self, status == noErr, let sb, let f = RSEncoder.frame(sb, codec: codec, captureNs: captureNs, number: self.next()) else { return }
      self.onFrame(f)
    }
    if st != noErr { lock.lock(); forceKey = true; lock.unlock() }
    return st == noErr
  }

  private func next() -> UInt32 { lock.lock(); defer { lock.unlock() }; number &+= 1; return number }

  func invalidate() {
    lock.lock(); let s = session; session = nil; lock.unlock()
    if let s { VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid); VTCompressionSessionInvalidate(s) }
  }
  deinit { invalidate() }

  /// An encoded sample as an RSVideoFrame: its NAL units (4 byte lengths, as VideoToolbox gives them) and, on a keyframe,
  /// the parameter sets.
  static func frame(_ sb: CMSampleBuffer, codec: RSCodec, captureNs: UInt64, number: UInt32) -> RSVideoFrame? {
    guard let bb = CMSampleBufferGetDataBuffer(sb) else { return nil }
    var key = true
    if let a = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]], let first = a.first,
       let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool, notSync { key = false }
    // On a keyframe, the codec's own configuration (the avcC or hvcC atom, as an MP4 file keeps it): the decoder builds its
    // format from it. Ends with the picture size, so the decoder needs nothing else.
    var params: [Data] = []
    if key, let fd = CMSampleBufferGetFormatDescription(sb),
       let atoms = CMFormatDescriptionGetExtension(fd, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any],
       let atom = atoms[codec == .h264 ? "avcC" : "hvcC"] as? Data {
      let dim = CMVideoFormatDescriptionGetDimensions(fd)
      var w = RSWriter(); w.u32(UInt32(max(0, dim.width))); w.u32(UInt32(max(0, dim.height)))
      params = [atom, w.data]
    }
    let len = CMBlockBufferGetDataLength(bb)
    var data = Data(count: len)
    let ok = data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: $0.baseAddress!) } == kCMBlockBufferNoErr
    guard ok else { return nil }
    let enc = UInt32(min(UInt64(UInt32.max), (RSTime.nowNs &- captureNs) / 1000))
    return RSVideoFrame(number: number, keyframe: key, captureNs: captureNs, encodeUs: enc, params: params, data: data)
  }
}

final class RSDecoder {
  let codec: RSCodec
  private var session: VTDecompressionSession?
  private var format: CMVideoFormatDescription?
  private var params: [Data] = []
  /// Each decoded picture (BGRA, IOSurface backed, ready to be a layer's contents) with the frame it came from.
  var onImage: (CVPixelBuffer, RSVideoFrame) -> Void = { _, _ in }

  /// What the decoder hands out: BGRA (any layer shows it) or the encoder's own 4:2:0 (no conversion step; a CALayer shows an
  /// IOSurface in this format too).
  let pixelFormat: OSType
  init(codec: RSCodec, pixelFormat: OSType = kCVPixelFormatType_32BGRA) { self.codec = codec; self.pixelFormat = pixelFormat }

  /// Decodes one whole frame, synchronously (the lowest delay: the picture is out when this returns). Returns false when it
  /// cannot (no keyframe seen yet, or a decode error): the caller asks the secondary for a keyframe.
  @discardableResult
  func decode(_ f: RSVideoFrame) -> Bool {
    if !f.params.isEmpty && f.params != params {
      guard let fd = RSDecoder.formatDescription(f.params, codec: codec) else { return false }
      params = f.params
      if let s = session, VTDecompressionSessionCanAcceptFormatDescription(s, formatDescription: fd) { format = fd }
      else { format = fd; makeSession() }
    }
    guard let s = session, let fd = format, let sb = RSDecoder.sample(f.data, format: fd) else { return false }
    var ok = true
    let st = VTDecompressionSessionDecodeFrame(s, sampleBuffer: sb, flags: [], infoFlagsOut: nil) { [weak self] status, _, image, _, _ in
      guard status == noErr, let image else { ok = false; return }
      self?.onImage(image, f)
    }
    if st != noErr { ok = false }
    if !ok && st == kVTInvalidSessionErr { makeSession() }
    return ok
  }

  private func makeSession() {
    if let s = session { VTDecompressionSessionInvalidate(s); session = nil }
    guard let fd = format else { return }
    let attrs: [CFString: Any] = [kCVPixelBufferPixelFormatTypeKey: pixelFormat, kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
                                  kCVPixelBufferMetalCompatibilityKey: true]
    let spec: [CFString: Any] = [kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder: true]
    var s: VTDecompressionSession?
    guard VTDecompressionSessionCreate(allocator: nil, formatDescription: fd, decoderSpecification: spec as CFDictionary, imageBufferAttributes: attrs as CFDictionary,
                                       outputCallback: nil, decompressionSessionOut: &s) == noErr, let s else { return }
    VTSessionSetProperty(s, key: kVTDecompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    session = s
  }

  func invalidate() { if let s = session { VTDecompressionSessionInvalidate(s) }; session = nil; format = nil; params = [] }
  deinit { invalidate() }

  /// The format from the encoder's configuration atom and the picture size (RSEncoder.frame's params).
  static func formatDescription(_ ps: [Data], codec: RSCodec) -> CMVideoFormatDescription? {
    guard ps.count == 2, !ps[0].isEmpty else { return nil }
    var r = RSReader(ps[1])
    guard let w = r.u32(), let h = r.u32(), (2...16_384).contains(w), (2...16_384).contains(h) else { return nil }
    let ext: [CFString: Any] = [kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms: [codec == .h264 ? "avcC" : "hvcC": ps[0]] as CFDictionary]
    var fd: CMFormatDescription?
    let st = CMVideoFormatDescriptionCreate(allocator: nil, codecType: codec == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264,
                                            width: Int32(w), height: Int32(h), extensions: ext as CFDictionary, formatDescriptionOut: &fd)
    return st == noErr ? fd : nil
  }

  static func sample(_ d: Data, format: CMVideoFormatDescription) -> CMSampleBuffer? {
    guard !d.isEmpty else { return nil }
    var bb: CMBlockBuffer?
    guard CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: d.count, blockAllocator: nil, customBlockSource: nil,
                                             offsetToData: 0, dataLength: d.count, flags: 0, blockBufferOut: &bb) == kCMBlockBufferNoErr, let bb else { return nil }
    let copied = d.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: bb, offsetIntoDestination: 0, dataLength: d.count) }
    guard copied == kCMBlockBufferNoErr else { return nil }
    var sb: CMSampleBuffer?
    var size = d.count
    guard CMSampleBufferCreateReady(allocator: nil, dataBuffer: bb, formatDescription: format, sampleCount: 1, sampleTimingEntryCount: 0, sampleTimingArray: nil,
                                    sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sb) == noErr else { return nil }
    return sb
  }
}
