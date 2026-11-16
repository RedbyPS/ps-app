import Cocoa

// THE DEVELOPER'S GOLDEN RULE: PSMiddleClicker never looks at or touches 1Password or Signal. The only thing
// it checks is whether the app in front IS one of them (its bundle id, when it comes to the
// front), so it can step aside completely: while one is in front the mouse tap is switched off.
// Same list as PS (~/Projects/ps/mac/Sources/Protected.swift). Broad on purpose: any 1Password
// or Signal build or helper.
enum Protected {
  static func matches(_ bundleId: String?) -> Bool {
    guard let id = bundleId?.lowercased() else { return false }
    return id.contains("1password") || id.contains("agilebits") || id.contains("whispersystems") || id.contains("signal")
  }
}
