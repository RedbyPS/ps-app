import Foundation

// PS 1.61 (the developer, after updating to 1.60: the new logo was in the app but the Dock kept showing the old one). The Dock
// and Launch Services keep their own copy of an app's icon and do not always notice a new one after an update swaps
// the app in place. The developer fixed it by hand: touch the app, lsregister -f, killall Dock. The updater now does the same by
// itself, gently, once per update (DockIcon.swift):
//  - only after an app update has fully finished: the journal says "ok" (the helper saw the new build start healthy)
//    for this very build, and no other update is busy;
//  - always: touch the app and register it again with Launch Services (nothing on screen changes);
//  - restart the Dock ONLY when the icon file really differs from the build it replaced (an unchanged or unknown icon
//    leaves the Dock alone). The icon build is byte for byte the same each time (build.sh), so an update with the same
//    logo never restarts the Dock;
//  - never in a test copy.
// Pure rules, no files: tests/dock-icon-test.sh checks them.
enum DockIconCore {
  enum Step: Equatable {
    /// The update is still finishing (or another is busy): look again in a moment.
    case wait
    /// Nothing to do for this launch (not an update to this build, done already, or a test copy).
    case skip
    /// Touch and register now.
    case refresh
  }
  static func step(phase: String?, to: Int?, mine: Int, doneFor: Int, busy: Bool, test: Bool) -> Step {
    if test { return .skip }
    guard let phase, let to, to == mine, doneFor != mine else { return .skip }
    switch phase {
    case "ok": return busy ? .wait : .refresh
    case "swapped", "healthy": return .wait
    default: return .skip   // rolled back or failed: this build is not the one staying
    }
  }
  /// Did the icon really change? Only when both files are there and differ.
  /// PS 1.74 (no old icon may linger after an update): also when both Info.plists name their icon file and the names
  /// differ. Since 1.72 the name is the picture's own hash (build.sh), so another name is another picture, even when the
  /// replaced build's icon file cannot be read any more; a build before 1.72 says AppIcon, the old white icon's name.
  /// Unknown names (a missing Info.plist) never restart the Dock by themselves.
  static func iconChanged(new: Data?, old: Data?, newName: String? = nil, oldName: String? = nil) -> Bool {
    if let a = newName, let b = oldName, iconFile(named: a) != iconFile(named: b) { return true }
    guard let n = new, let o = old, !n.isEmpty, !o.isEmpty else { return false }
    return n != o
  }
  /// PS 1.72: the bundle's icon file is what its Info.plist names (CFBundleIconFile). build.sh names it after its own
  /// content (AppIcon-<hash>), so a new picture is a file Finder and the Dock have never cached; builds before 1.72 have
  /// AppIcon. ".icns" is added when the name has none; a missing or odd name means AppIcon.icns.
  static func iconFile(named name: String?) -> String {
    let n = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !n.isEmpty, !n.contains("/"), !n.hasPrefix(".") else { return "AppIcon.icns" }
    return n.hasSuffix(".icns") ? n : n + ".icns"
  }
  /// The name in an Info.plist's bytes (read from the file each time: Bundle would cache it by path).
  static func iconName(infoPlist: Data?) -> String? {
    guard let d = infoPlist, let p = try? PropertyListSerialization.propertyList(from: d, format: nil) as? [String: Any] else { return nil }
    return p["CFBundleIconFile"] as? String
  }
  static func icon(of app: URL, named name: String?) -> URL { app.appendingPathComponent("Contents/Resources/" + iconFile(named: name)) }
  static let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  /// How often to look while the update finishes, and for how long at most (the helper gives a new build 90 seconds).
  static let every: TimeInterval = 3, maxLooks = 200
  /// What runs, in order: the touch is done in code (a new modification date on the app), then these.
  static func commands(app: String, dock: Bool) -> [(String, [String])] {
    var c: [(String, [String])] = [(lsregister, ["-f", app])]
    if dock { c.append(("/usr/bin/killall", ["Dock"])) }
    return c
  }
}
