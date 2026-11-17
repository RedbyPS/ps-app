// The update card (top centre since V1.49, the developer: "at the top centre of the screen"; slides down from there) and the install screen. Both show the page
// ui/update.html that is built into the app (Contents/Resources/update.html), so they work even when
// the web files are missing or broken. The card never takes the keyboard and never activates PS;
// its buttons answer a real click only (nothing happens on hover).
import AppKit
import WebKit

final class UpdatePanel: NSPanel {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

final class UpdateUI: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  private(set) var web: ClickThroughWebView!
  private(set) var window: NSWindow!
  private var ready = false
  private var waiting: [String] = []
  var onClick: ((String) -> Void)?
  /// The last click's whole message (V1.36: the Install click also carries the name typed on the welcome page).
  private(set) var clicked: [String: Any] = [:]
  let install: Bool
  static let cardSize = NSSize(width: 400, height: 150)
  static let installSize = NSSize(width: 600, height: 440)

  init(install: Bool) {
    self.install = install
    super.init()
    // V1.57: private mode coming on puts an update card that is up behind a pill (PrivateHold.swift).
    if !install { PrivateHold.shared.watch { [weak self] in if let self, self.window.isVisible { self.present() } } }
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()                       // it holds nothing
    if IS_TEST_COPY, let list = testBlockList { c.userContentController.add(list) }
    c.preferences.isFraudulentWebsiteWarningEnabled = false
    c.userContentController.add(self, name: "up")
    let size = install ? UpdateUI.installSize : UpdateUI.cardSize
    web = ClickThroughWebView(frame: NSRect(origin: .zero, size: size), configuration: c)
    web.setValue(false, forKey: "drawsBackground")
    web.navigationDelegate = self
    if IS_TEST_COPY {
      // Its window is parked off screen: WebKit must keep drawing anyway (test only, WebKit SPI, as the Tab list does).
      let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
      if web.responds(to: sel) {
        typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
        unsafeBitCast(web.method(for: sel), to: SetBool.self)(web, sel, false)
      }
    }
    if install {
      let w = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
      w.titlebarAppearsTransparent = true
      w.titleVisibility = .hidden
      w.isMovableByWindowBackground = true
      w.backgroundColor = NSColor(red: 0.078, green: 0.067, blue: 0.086, alpha: 1)
      w.appearance = NSAppearance(named: .darkAqua)
      w.isReleasedWhenClosed = false
      w.title = "Install"
      w.contentView = web
      w.center()
      window = w
    } else {
      let p = UpdatePanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
      p.isOpaque = false
      p.backgroundColor = .clear
      p.hasShadow = false                    // the card draws its own
      p.level = .statusBar
      p.hidesOnDeactivate = false
      p.isReleasedWhenClosed = false
      p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
      p.contentView = web
      window = p
    }
    if IS_TEST_COPY { window.alphaValue = 0; window.ignoresMouseEvents = true }   // never on the developer's screen
    let file = Bundle.main.resourceURL!.appendingPathComponent("update.html")
    web.loadFileURL(file, allowingReadAccessTo: file)
  }

  /// Shows the window: the card top centre on the screen with the mouse, just below the menu bar, the notch and the
  /// Dynamic Island's closed pill, the installer centred.
  func present() {
    if install {
      if IS_TEST_COPY { window.orderFrontRegardless(); return }
      window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
      return
    }
    // V1.57 private mode: the update card waits behind a pill (PrivateHold.swift); the installer never does.
    if !IS_TEST_COPY && PrivateHold.shared.waits("update", show: { [weak self] in self?.present() }) {
      window.orderOut(nil); IslandColumn.shared.leave("update"); return
    }
    // V1.55: out of the Dynamic Island while it is there and the developer left the update card on Island (IslandColumn.swift).
    if let f = IslandColumn.shared.frame(id: "update", kind: "update", size: window.frame.size, window: window,
                                         replace: { [weak self] in if self?.window.isVisible == true { self?.present() } }) {
      IslandColumn.shared.put(window, f, alpha: IS_TEST_COPY ? 0 : 1)
      return
    }
    let screen = NSScreen.screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? NSScreen.main
    if let sc = screen {
      // Below the menu bar (visibleFrame) and, when the menu bar is hidden, below the camera notch; 8 pt clear of the island.
      let top = min(sc.visibleFrame.maxY, sc.frame.maxY - sc.safeAreaInsets.top) - 8
      window.setFrameOrigin(NSPoint(x: (sc.frame.midX - window.frame.width / 2).rounded(), y: top - window.frame.height))
    }
    window.orderFrontRegardless()
  }
  func close() {
    PrivateHold.shared.gone("update")
    // PS 1.60: the update card shrinks back into the island, then the window goes (its alpha is set again on the next put).
    let w: NSWindow = window
    if IslandColumn.shared.retire(w, id: "update", completion: { w.orderOut(nil); w.alphaValue = 1 }) { return }
    window.orderOut(nil); IslandColumn.shared.leave("update")
  }

  /// Calls window.__up.<fn>(...args) once the page is ready (queued before that).
  func call(_ fn: String, _ args: Any...) {
    let parts = args.map { a -> String in
      if a is NSNull { return "null" }
      if let s = a as? String, let d = try? JSONSerialization.data(withJSONObject: [s]), let j = String(data: d, encoding: .utf8) { return String(j.dropFirst().dropLast()) }
      if let d = try? JSONSerialization.data(withJSONObject: a, options: [.fragmentsAllowed]), let j = String(data: d, encoding: .utf8) { return j }
      return "null"
    }
    let js = "window.__up.\(fn)(\(parts.joined(separator: ",")))"
    if ready { web.evaluateJavaScript(js, completionHandler: nil) } else { waiting.append(js) }
  }

  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let s = message.body as? String, let o = try? JSONSerialization.jsonObject(with: Data(s.utf8)) as? [String: Any], let t = o["type"] as? String else { return }
    if t == "ready" {
      ready = true
      if install { web.evaluateJavaScript("window.__up.install()", completionHandler: nil) }
      for js in waiting { web.evaluateJavaScript(js, completionHandler: nil) }
      waiting = []
    } else if t == "size", !install, let h = o["h"] as? Double {
      // The card grew or shrank with the update's notes (V1.40): the window follows, its top edge stays put.
      let want = max(UpdateUI.cardSize.height, min(CGFloat(h.rounded()), 640))
      var f = window.frame
      if abs(f.height - want) > 0.5 { f.origin.y += f.height - want; f.size.height = want; window.setFrame(f, display: true) }
      if IslandColumn.shared.ids.contains("update") { present() }   // under the island: the windows after it make room
    } else if t == "site", install {
      // PS 1.66 "Developed by Cincee" on the install screen: cincee.com in the default browser (never inside PS). Test copies open nothing.
      if !IS_TEST_COPY, let u = URL(string: "https://cincee.com") { NSWorkspace.shared.open(u) }
    } else if t == "click", let id = o["id"] as? String {
      clicked = o                                     // the Install click carries the typed name (Installer.swift)
      onClick?(id)
    }
  }
  // The page is local; it may never navigate anywhere else.
  func webView(_ webView: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(a.request.url?.isFileURL == true ? .allow : .cancel)
  }
}

/// "12.4 of 24.0 MB"
func mb(_ b: Int64) -> String { String(format: b < 10_000_000 ? "%.1f" : "%.0f", Double(b) / 1_000_000) }
