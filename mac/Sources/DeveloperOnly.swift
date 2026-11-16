import AppKit

// Left out of the public source: AirPods and microphone auto routing (sending email replies came into core in 1.60:
// MailSend.swift, MailSendCore.swift, ReplyWindow.swift; Second Computer came into core in 1.65: Second*.swift, behind its
// own switch in Settings). It only runs on the developer's own account (Owner.red). This placeholder keeps the names the
// rest of the app uses and does nothing. See README.md, "What is left out". (scripts in the private tree: open-source.mjs)

/// AirPods and microphone auto routing (left out).
final class AutoRoute {
  static let shared = AutoRoute()
  var isOn: Bool { false }
  func start(testDir: String?) {}
  func setOn(_ b: Bool) {}
  func action(_ id: String, _ act: String) {}
  func noteOwnInput(_ uid: String) {}
  func restoreOutput() -> String? { nil }
  func restoreHomeMic() -> String? { nil }
}

/// The self tests of the left out features: nothing to check here, they finish at once.
extension SelfTest {
  static func numCheck(_ a: App, _ dir: String, _ done: @escaping () -> Void) { done() }
  static func routeCheck(_ a: App, _ dir: String, _ done: @escaping () -> Void) { done() }
}
