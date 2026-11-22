import AppKit

// PS 1.61: after an app update, the Dock shows the new logo (rules and reasons: DockIconCore.swift). Started once at
// launch by the updater (Updater.afterLaunch). Off the main thread for every file and command; each command is
// stopped if it takes over 20 seconds. Logs one line, never anything personal.
final class DockIcon {
  static let shared = DockIcon()
  static let doneKey = "dock.iconRefreshedFor"
  private var timer: Timer?
  private var looks = 0

  /// Main thread. Watches the journal until this build's update has finished, then refreshes once.
  func start() {
    guard timer == nil else { return }
    looks = 0
    if look() { return }
    timer = Timer.scheduledTimer(withTimeInterval: DockIconCore.every, repeats: true) { [weak self] t in
      if self?.look() ?? true { t.invalidate(); self?.timer = nil }
    }
    timer?.tolerance = 1
  }
  /// True when done watching.
  private func look() -> Bool {
    looks += 1
    let j = UpdateJournal.read()
    let test = UpdatePaths.test || ProcessInfo.processInfo.environment["PS_SELFTEST"] != nil
    switch DockIconCore.step(phase: j?.phase, to: j?.to, mine: PSVersion.mine, doneFor: UserDefaults.standard.integer(forKey: DockIcon.doneKey), busy: Updater.shared.busy, test: test) {
    case .skip: return true
    case .wait:
      if looks >= DockIconCore.maxLooks { psLog("PS update: Dock icon refresh skipped (the update never finished here)"); return true }
      return false
    case .refresh:
      guard let j else { return true }
      UserDefaults.standard.set(PSVersion.mine, forKey: DockIcon.doneKey)   // once per build, even if a command fails
      DispatchQueue.global(qos: .utility).async { DockIcon.refresh(app: URL(fileURLWithPath: j.target), previous: URL(fileURLWithPath: j.previous)) }
      return true
    }
  }

  private static func refresh(app: URL, previous: URL) {
    let fm = FileManager.default
    guard fm.fileExists(atPath: app.path) else { return }
    // Each build's own icon file, as its own Info.plist names it (PS 1.72: the name changes with the picture).
    let name = { (a: URL) in DockIconCore.iconName(infoPlist: fm.contents(atPath: a.appendingPathComponent("Contents/Info.plist").path)) }
    let icon = { (a: URL) in DockIconCore.icon(of: a, named: name(a)) }
    let changed = DockIconCore.iconChanged(new: fm.contents(atPath: icon(app).path), old: fm.contents(atPath: icon(previous).path),
                                           newName: name(app), oldName: name(previous))   // PS 1.74: another icon name is another picture
    try? fm.setAttributes([.modificationDate: Date()], ofItemAtPath: app.path)   // touch
    var ok = true
    for (tool, args) in DockIconCore.commands(app: app.path, dock: changed) where !run(tool, args) { ok = false }
    DispatchQueue.main.async { NSWorkspace.shared.noteFileSystemChanged(app.path) }
    psLog("PS update: app registered again for its icon\(changed ? ", new icon, Dock restarted" : ", same icon, Dock left alone")\(ok ? "" : " (a step did not finish)")")
  }
  private static func run(_ tool: String, _ args: [String]) -> Bool {
    guard FileManager.default.isExecutableFile(atPath: tool) else { return false }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: tool)
    p.arguments = args
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    let done = DispatchSemaphore(value: 0)
    p.terminationHandler = { _ in done.signal() }
    do { try p.run() } catch { return false }
    if done.wait(timeout: .now() + 20) == .timedOut { p.terminate(); return false }
    return p.terminationStatus == 0
  }
}
