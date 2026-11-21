import CoreGraphics

// A browser window that only holds one of Apple's own panels: its presses pass straight through.
//
// 21 Nov 2026, the developer (Brave, macOS 27.2.1): every download opens the save box, and in it only the
// sidebar (the colour tags at the bottom left) took clicks. Save, Cancel and the rest never did;
// Return and Esc still worked.
// Why: Brave shows the save box as a sheet, and a sheet is a Brave window at the normal level, so
// the click tap held every press there for a possible middle click and gave it back as a posted
// copy. The box itself is drawn by Apple's Open and Save Panel Service, in its own process, and the
// posted copies reached it as sidebar clicks (the service's own log at 09:18 on 21 Nov: one
// "userDidClickItem row 16 to 20", the Tags rows, or "row -1", for each held press, never a button
// press). The same service's standalone panels (window level 8, as in DaVinci Resolve) were never
// held, and their buttons worked.
// How it is seen: while the sheet is up the service has a window of exactly the sheet's frame
// (measured: Brave 1279 and the service's 1280, both 169,126 1372x830). So a browser window with
// the same frame as a window of one of AppKit's out of process services hosts a system panel.
// Only the bundle id is used, which is read for every window owner anyway. Never a name or a path.
enum PanelHost {
  /// AppKit's out of process UI services (the Open and Save Panel Service, TrustedUIService and the
  /// like). Not every Apple service: the Dock and the wallpaper have full screen windows that a full
  /// screen browser window would match.
  static func isPanelService(_ bundleId: String?) -> Bool {
    guard let id = bundleId?.lowercased() else { return false }
    return id.hasPrefix("com.apple.appkit.xpc.")
  }

  /// A panel is never smaller than this (the services also keep tiny windows such as 1x1 at 0,0).
  static let minWidth: CGFloat = 100, minHeight: CGFloat = 60

  /// The same frame within a point.
  static func sameFrame(_ a: CGRect, _ b: CGRect, slack: CGFloat = 1) -> Bool {
    abs(a.minX - b.minX) <= slack && abs(a.minY - b.minY) <= slack
      && abs(a.width - b.width) <= slack && abs(a.height - b.height) <= slack
  }

  /// The browser windows that host a system panel. browser: the browser windows at the normal level
  /// with their frames. panels: the frames of the panel services' windows at the normal level, on
  /// screen or not (the service's window need not be on screen itself while the sheet shows it).
  static func hosts(_ browser: [(id: UInt32, frame: CGRect)], panels: [CGRect]) -> Set<UInt32> {
    let big = panels.filter { $0.width >= minWidth && $0.height >= minHeight }
    guard !big.isEmpty else { return [] }
    var out = Set<UInt32>()
    for b in browser where big.contains(where: { sameFrame($0, b.frame) }) { out.insert(b.id) }
    return out
  }
}
