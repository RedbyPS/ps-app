import CoreAudio
import Foundation

// The Mac's default microphone (System Settings > Sound > Input): every app that uses "the
// default input" follows it. PS > Tab list > Settings lists the inputs and switches it when the developer
// picks one. Nothing changes unless he picks a microphone himself.
//
// After PS 1.71 (the freeze of 21 Nov 2026): every Core Audio call here runs on PS's one audio queue (AudioQueue.swift),
// and so do the listeners. Everything below `Mic` returns at once with the last known state; it never waits on Core
// Audio, so it is safe on the main thread.
enum Mic {
  typealias Device = MicDevice

  /// Start reading and listening (main.swift at launch). `changed` gets {"type":"mic",...} on the main thread when the
  /// microphones change, and after `ask()` and `setDefault`.
  static func watch(_ changed: @escaping (String) -> Void) {
    PSAudio.shared.onMic = changed
    PSAudio.shared.start(CoreAudioMic())
  }
  /// The page asks. The answer comes through `watch`'s block; while the audio server does not answer, the last known
  /// state is returned here at once instead.
  static func ask() -> String? { PSAudio.shared.ask() }
  /// The last known state as the page reads it, never waits.
  static func stateJSON() -> String { PSAudio.shared.micJSON }
  /// Every microphone PS last saw, never waits.
  static func inputs() -> [Device] { PSAudio.shared.mic.devices }
  /// Is an app using the default microphone (a call)? The last known state, kept fresh by a listener. Never waits.
  static var inUse: Bool { PSAudio.shared.mic.running }
  /// Make this microphone the Mac's default input. Only from the developer's own pick in Settings. Returns at once; `done` on main.
  static func setDefault(uid: String, _ done: @escaping (Bool) -> Void = { _ in }) { PSAudio.shared.setDefault(uid: uid, done) }
}

// ---------- the real Mac: Core Audio, on the audio queue only ----------
final class CoreAudioMic: MicReader {
  private static let sys = AudioObjectID(kAudioObjectSystemObject)
  private var queue: DispatchQueue?
  private var changed: (() -> Void)?
  private var runWatched = AudioObjectID(kAudioObjectUnknown)
  private var runListened: Set<AudioObjectID> = []    // one running listener per device, ever (as AudioPriority's watchMic)

  private func addr(_ sel: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: sel, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  }
  private func string(_ id: AudioObjectID, _ sel: AudioObjectPropertySelector) -> String? {
    var a = addr(sel)
    var value: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, &value) == noErr, let v = value else { return nil }
    return v.takeRetainedValue() as String
  }
  private func hasInput(_ id: AudioDeviceID) -> Bool {
    var a = addr(kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyScopeInput)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &a, 0, nil, &size) == noErr, size > 0 else { return false }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &a, 0, nil, &size, raw) == noErr else { return false }
    let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
    return list.reduce(0) { $0 + Int($1.mNumberChannels) } > 0
  }
  private func inputs() -> [(id: AudioDeviceID, dev: MicDevice)] {
    var a = addr(kAudioHardwarePropertyDevices)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(Self.sys, &a, 0, nil, &size) == noErr else { return [] }
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(Self.sys, &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.compactMap { id in
      guard hasInput(id), let uid = string(id, kAudioDevicePropertyDeviceUID), let name = string(id, kAudioObjectPropertyName) else { return nil }
      return (id, MicDevice(uid: uid, name: name))
    }
  }
  private func currentID() -> AudioDeviceID {
    var a = addr(kAudioHardwarePropertyDefaultInputDevice)
    var id = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    return AudioObjectGetPropertyData(Self.sys, &a, 0, nil, &size, &id) == noErr ? id : 0
  }
  /// The default microphone is running for some app (the same read AreYouSure and the recorder's meeting look made).
  private func running(_ id: AudioDeviceID) -> Bool {
    guard id != 0 else { return false }
    var a = addr(kAudioDevicePropertyDeviceIsRunningSomewhere)
    var run: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    return AudioObjectGetPropertyData(id, &a, 0, nil, &size, &run) == noErr && run != 0
  }

  func read() -> MicSnapshot {
    let list = inputs()
    let cur = currentID()
    watchRunning(cur)
    return MicSnapshot(devices: list.map(\.dev), current: list.first { $0.id == cur }?.dev.uid ?? "", running: running(cur))
  }
  func setDefault(uid: String) -> Bool {
    guard let d = inputs().first(where: { $0.dev.uid == uid }) else { return false }
    var a = addr(kAudioHardwarePropertyDefaultInputDevice)
    var id = d.id
    return AudioObjectSetPropertyData(Self.sys, &a, 0, nil, UInt32(MemoryLayout<AudioDeviceID>.size), &id) == noErr
  }
  func listen(on queue: DispatchQueue, _ changed: @escaping () -> Void) {
    self.queue = queue
    self.changed = changed
    for sel in [kAudioHardwarePropertyDevices, kAudioHardwarePropertyDefaultInputDevice] {
      var a = addr(sel)
      AudioObjectAddPropertyListenerBlock(Self.sys, &a, queue) { [weak self] _, _ in self?.changed?() }
    }
  }
  /// The default microphone says when an app starts or stops using it, so `Mic.inUse` stays fresh without polling.
  private func watchRunning(_ id: AudioDeviceID) {
    guard let queue, id != 0, id != runWatched else { return }
    runWatched = id
    guard runListened.insert(id).inserted else { return }
    var a = addr(kAudioDevicePropertyDeviceIsRunningSomewhere)
    AudioObjectAddPropertyListenerBlock(id, &a, queue) { [weak self] _, _ in
      guard let self, self.runWatched == id else { return }
      self.changed?()
    }
  }
}
