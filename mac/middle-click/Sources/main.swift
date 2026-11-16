import Cocoa
import ServiceManagement

// PSMiddleClicker: a firm Force Touch press on the trackpad becomes a middle click at the cursor
// (in a browser: open a link in a new background tab, or close a tab). Menu bar only.
// No network code at all. Settings live in UserDefaults (com.cincee.psmiddleclicker).

enum Settings {
  static let d = UserDefaults.standard
  static func register() { d.register(defaults: ["enabled": true, "firmness": Firmness.normal.rawValue]) }
  static var enabled: Bool {
    get { d.bool(forKey: "enabled") }
    set { d.set(newValue, forKey: "enabled") }
  }
  /// The Privacy & Security row it needs. macOS 27 renamed Accessibility to "Device Control and
  /// Data Access" (checked in System Settings' own strings, 31 Oct 2026).
  static let paneName = ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 27, minorVersion: 0, patchVersion: 0))
    ? "Device Control and Data Access" : "Accessibility"
  static var firmness: Firmness {
    get { Firmness(rawValue: d.string(forKey: "firmness") ?? "") ?? .normal }
    set { d.set(newValue.rawValue, forKey: "firmness") }
  }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  private var item: NSStatusItem!
  private let menu = NSMenu()
  private let pad = TestPad()
  private var protectedFront = false
  private var trusted = AXIsProcessTrusted()

  func applicationDidFinishLaunching(_ n: Notification) {
    Settings.register()
    Log.write("started (build \(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"), pid \(getpid()))"
              + (replaces.map { ", replacing pid \($0)" } ?? ""))
    // A fresh copy (Recovery.swift): the old one is quitting; start once it is gone, never both.
    if let pid = replaces, let old = NSRunningApplication(processIdentifier: pid), old.bundleIdentifier == me, !old.isTerminated {
      SelfRestart.whenGone(old) { [weak self] in self?.begin() }
    } else {
      begin()
    }
  }

  private func begin() {

    // Embedded in PS (Helper.swift): no menu bar icon, PS Settings is the switch.
    if !Helper.embedded {
      item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
      menu.delegate = self
      item.menu = menu
      pad.onFirmness = { [weak self] f in self?.setFirmness(f) }
    }

    let tap = Tap.shared
    tap.setFirmness(Settings.firmness)
    if Helper.embedded {
      Helper.start { [weak self] in self?.applyEmbedded() }
      applyEmbedded()
    } else {
      tap.setEnabled(Settings.enabled)
    }

    // The tap's watchdog: main says it is alive every 0.4 s (the tap steps aside after 1.5 s).
    let beat = Timer(timeInterval: 0.4, repeats: true) { _ in Tap.shared.heartbeat() }
    beat.tolerance = 0.1
    RunLoop.main.add(beat, forMode: .common)
    // Install once allowed, switch back on if macOS turned it off, keep the icon right.
    let check = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
      Tap.shared.check()
      Windows.shared.refresh(minAge: 2)
      self?.refreshPermission()
      self?.publish()
    }
    check.tolerance = 0.5
    RunLoop.main.add(check, forMode: .common)

    // Golden rule: step aside while 1Password or Signal is in front.
    setFront(NSWorkspace.shared.frontmostApplication?.bundleIdentifier)
    NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
      self?.setFront((n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier)
    }
    // Which windows are browser windows: known before the first click, kept fresh on each switch.
    Windows.shared.refresh()
    for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
      NSWorkspace.shared.notificationCenter.addObserver(forName: name, object: nil, queue: nil) { _ in Windows.shared.refresh() }
    }
    NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in Tap.shared.setSelfFront(true) }
    NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { _ in Tap.shared.setSelfFront(false) }

    // The taps cannot be made for 30 s, or keep timing out: a fresh copy starts, this one quits.
    tap.lastRelaunch = { SelfRestart.last }
    tap.onRelaunch = { why in SelfRestart.now(why) { Tap.shared.relaunchFailed() } }

    if trusted {
      tap.install()
    } else if Helper.embedded {
      // The PS helper never asks by itself (16 Nov 2026: on by default for everyone, so no surprise
      // prompt). It waits quietly; PS Settings explains and asks with one click (askNotice).
      Log.write("waiting quietly for \(Settings.paneName) permission (PS Settings asks for it)")
    } else {
      askAccessibility()
    }
    if Helper.embedded {
      DistributedNotificationCenter.default().addObserver(forName: Helper.askNotice, object: nil, queue: .main) { [weak self] _ in
        self?.askedByPS()
      }
    }
    refreshIcon()
    publish(force: true)
  }

  /// Embedded: the tap is on unless the standalone PSMiddleClicker is running (never both).
  /// It never asks for permission here: only when PS asks (askedByPS).
  private func applyEmbedded() {
    Tap.shared.setEnabled(!Helper.yielding)
    publish()
  }
  /// Embedded: the person clicked the button in PS Settings. macOS adds "PS Middle Click" to the
  /// list with its own prompt (PS opens the page next to it). Nothing if already allowed.
  private func askedByPS() {
    guard !AXIsProcessTrusted() else { return }
    Log.write("PS asked for \(Settings.paneName) permission")
    asked = false
    askAccessibility()
  }
  private var asked = false
  /// macOS shows its own "... would like to control this computer" prompt (once per run).
  private func askAccessibility() {
    guard !asked else { return }
    asked = true
    let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(opts)
    Log.write("waiting for Accessibility permission")
  }
  /// Embedded: tells PS how the helper is doing.
  private func publish(force: Bool = false) {
    guard Helper.embedded else { return }
    Helper.publish(trusted: trusted, tap: Tap.shared.installed && !Helper.yielding, force: force)
  }

  func applicationWillTerminate(_ n: Notification) {
    Tap.shared.setEnabled(false)   // give back anything held, before the process goes
    Tap.shared.drain()             // and wait until it has been posted
    if Helper.embedded { Helper.publish(trusted: trusted, tap: false, running: false, force: true) }
    Log.write("quit")
    Log.flush()
  }

  private func setFront(_ id: String?) {
    let p = Protected.matches(id)
    guard p != protectedFront else { return }
    protectedFront = p
    Tap.shared.setProtectedFront(p)
    refreshIcon()
  }

  private func refreshPermission() {
    let t = AXIsProcessTrusted()
    guard t != trusted else { return }
    trusted = t
    Log.write(t ? "Accessibility permission granted" : "Accessibility permission removed")
    publish()
    refreshIcon()
  }

  private func refreshIcon() {
    guard let b = item?.button else { return }
    let name: String, tip: String
    if !trusted { name = "exclamationmark.triangle"; tip = "PSMiddleClicker needs \(Settings.paneName) permission" }
    else if !Settings.enabled { name = "computermouse"; tip = "PSMiddleClicker is off" }
    else { name = "computermouse.fill"; tip = "PSMiddleClicker is on" }
    let img = NSImage(systemSymbolName: name, accessibilityDescription: tip)
    img?.isTemplate = true
    b.image = img
    b.appearsDisabled = trusted && (!Settings.enabled || protectedFront)
    b.toolTip = tip
  }

  // MARK: Menu (rebuilt each time it opens, so it always shows the current state)

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let status: String
    if !trusted { status = "Allow it in Privacy & Security › \(Settings.paneName)" }
    else if !Settings.enabled { status = "Off" }
    else if protectedFront { status = "Paused while 1Password or Signal is in front" }
    else if !Tap.shared.installed { status = "Starting…" }
    else { status = "On: a firm press is a middle click" }
    let head = NSMenuItem(title: "PSMiddleClicker", action: nil, keyEquivalent: "")
    head.isEnabled = false
    if #available(macOS 14.4, *) { head.subtitle = status } else { head.title = "PSMiddleClicker: \(status)" }
    menu.addItem(head)
    if !trusted {
      menu.addItem(action("Allow in System Settings…", #selector(openAccessibility)))
    }
    menu.addItem(.separator())

    let on = action("On", #selector(toggleEnabled))
    on.state = Settings.enabled ? .on : .off
    menu.addItem(on)
    menu.addItem(.separator())

    menu.addItem(.sectionHeader(title: "How firm to press"))
    for f in Firmness.allCases {
      let i = action(f.title, #selector(pickFirmness(_:)))
      i.representedObject = f.rawValue
      i.state = Settings.firmness == f ? .on : .off
      if #available(macOS 14.4, *) { i.subtitle = f.detail }
      menu.addItem(i)
    }
    menu.addItem(action("Open Test Pad…", #selector(openPad)))
    menu.addItem(.separator())

    let login = action("Launch at Login", #selector(toggleLogin))
    login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    menu.addItem(login)
    menu.addItem(action("Quit PSMiddleClicker", #selector(quit), key: "q"))
  }

  private func action(_ title: String, _ sel: Selector, key: String = "") -> NSMenuItem {
    let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
    i.target = self
    return i
  }

  @objc private func toggleEnabled() {
    Settings.enabled.toggle()
    Tap.shared.setEnabled(Settings.enabled)
    Log.write(Settings.enabled ? "switched on" : "switched off")
    refreshIcon()
  }
  @objc private func pickFirmness(_ sender: NSMenuItem) {
    guard let raw = sender.representedObject as? String, let f = Firmness(rawValue: raw) else { return }
    setFirmness(f)
    pad.setFirmness(f)
  }
  private func setFirmness(_ f: Firmness) {
    Settings.firmness = f
    Tap.shared.setFirmness(f)
    Log.write("firmness \(f.rawValue)")
  }
  @objc private func openPad() { pad.show(firmness: Settings.firmness) }
  @objc private func openAccessibility() {
    // Only opens the right page; the developer flips the switch himself.
    NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
  }
  @objc private func toggleLogin() {
    let s = SMAppService.mainApp
    do {
      if s.status == .enabled { try s.unregister(); Log.write("launch at login off") }
      else { try s.register(); Log.write("launch at login on") }
    } catch {
      Log.write("launch at login failed: \(error.localizedDescription)")
      if s.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() }
      else {
        let a = NSAlert()
        a.messageText = "Could not change Launch at Login"
        a.informativeText = error.localizedDescription
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
      }
    }
  }
  @objc private func quit() { NSApp.terminate(nil) }
}

// One PSMiddleClicker at a time: a second copy quits at once. Only a fresh copy opened by the app
// itself ("--replaces <pid>", Recovery.swift) may start while that old copy is still quitting.
let me = Bundle.main.bundleIdentifier ?? "com.cincee.psmiddleclicker"
let replaces = Replaces.pid(CommandLine.arguments)
let others = NSRunningApplication.runningApplications(withBundleIdentifier: me)
  .filter { $0.processIdentifier != getpid() && !$0.isTerminated }.map(\.processIdentifier)
if Replaces.mustQuit(others: others, replaces: replaces) {
  exit(0)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
