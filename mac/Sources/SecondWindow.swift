import AppKit
import WebKit

// The Second Computer window (protocol v1.1 sections 14 and 17): its own titled, resizable window with the
// same web build at /second-window#<tab> (Files, Messages, Outsource, Machine). Like the Tab list it holds
// NO keys: native feeds it the main page's state JSON through window.__psSecondWin.load(state) once it
// says second:winReady, and on every change while it is open; its actions ("looks" with a secondOp) go to
// the main page, exactly like the overlay's. It opens only on the developer's click (second:window from a page),
// never over 1Password or Signal, never because of a job. A test copy's window is invisible and parked.
/// The first click counts even while PS is not the active app (macOS may decline to bring PS forward).
final class SecondWebView: SecondDropWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class SecondWindow: NSObject, NSWindowDelegate {
  private weak var app: App?
  private(set) var window: NSWindow?
  private(set) var web: WKWebView?
  private(set) var ready = false
  private var pendingTab: String?
  private let test = IS_TEST_COPY
  /// Self test: every message the window page sent, by type, and how many state loads it got.
  private(set) var seen: [String] = []
  private(set) var loads = 0
  /// Self test: takes the window's clicks ("looks" with a secondOp) instead of the main page, so a click made
  /// while the test plays the OTHER Mac's view never changes this copy's own role.
  var testLooks: ((String) -> Void)?
  /// When the page last said it was ready / asked for PS settings. A page that asks again within a moment is
  /// ignored: V1.23's window page asked on every redraw and each answer redrew it, which froze PS (1 Nov).
  private var readyAt = Date.distantPast, settingsAt = Date.distantPast
  private var loopLogged = false
  /// Self test only: PS_SELFTEST_SECOND_NOGUARD=1 turns this guard off, to show a page's own behaviour.
  private let noGuard = IS_TEST_COPY && ProcessInfo.processInfo.environment["PS_SELFTEST_SECOND_NOGUARD"] == "1"
  private func tooSoon(_ last: inout Date, _ gap: TimeInterval) -> Bool {
    if noGuard { return false }
    let now = Date()
    if now.timeIntervalSince(last) < gap {
      if !loopLogged { loopLogged = true; psLog("PS second: the window page asked again at once, ignored (no reload loop)") }
      return true
    }
    last = now
    return false
  }

  init(app: App) { self.app = app }

  func isWeb(_ v: WKWebView?) -> Bool { v != nil && v === web }

  /// Messages the window may send that are handled as if the main page sent them (main.swift).
  static func asMain(_ type: String) -> Bool { type == "second:window" || type == "psSettings:get" || type.hasPrefix("reboot:") }

  /// Its own messages; true when handled here.
  func handle(_ type: String, _ text: String) -> Bool {
    if test { seen.append(type) }
    switch type {
    case "second:winReady":
      if tooSoon(&readyAt, 2) { return true }
      ready = true
      if let s = app?.lastState { load(s) }
      if let t = pendingTab { pendingTab = nil; tab(t) }
      return true
    case "psSettings:get":   // answered as the main page's (main.swift), at most once a second
      return tooSoon(&settingsAt, 1)
    case "second:dragArm":   // the page's mouse down on a file: dragging it out of the window gives Finder that file
      let m = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
      (web as? SecondDropWebView)?.dragItem = (m?["item"] as? [String: Any]).flatMap { SecondDragOut.itemOk($0) ? $0 : nil }
      return true
    case "second:pick":      // Send files or Attach: PS's Open panel (the developer's click)
      if let m = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any], let t = m["target"] as? [String: Any] { Second.shared.pick(t) }
      return true
    case "looks":            // a secondOp (or a look change): the main page does it, as for the overlay
      if test, let f = testLooks { f(text); return true }
      app?.sendToMain(text)
      return true
    default: return false
    }
  }

  /// Opens or raises the window, on a tab ("files", "messages", "outsource", "machine").
  func open(_ tab: String?, tries: Int = 0) {
    if !test && Protected.front {
      if tries < 30 { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.open(tab, tries: tries + 1) } }
      return
    }
    guard let app else { return }
    // Opened from the Tab list: the list floats above every normal window, so it goes away first,
    // or the window opened underneath it and could not be clicked (1 Nov).
    if app.shown { app.hideOverlay(force: true, giveBack: false) }
    if window == nil {
      let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 660), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
      w.title = "Second Computer"
      w.minSize = NSSize(width: 720, height: 480)
      w.isReleasedWhenClosed = false
      w.delegate = self
      if test { w.animationBehavior = .none }   // macOS drew the opening animation small, on screen, for a moment
      let c = app.config()
      // A test copy's window is invisible and off screen, which WebKit treats as hidden and pauses (test only).
      if test, #available(macOS 14.0, *) { c.preferences.inactiveSchedulingPolicy = .none }
      if test {   // the self test reads any page error from here
        c.userContentController.addUserScript(WKUserScript(source: "window.__errs=[];addEventListener('error',function(e){__errs.push(String(e.message||e.type)+' '+(e.filename||(e.target&&e.target.src)||''))},true);addEventListener('unhandledrejection',function(e){__errs.push('rejection '+String(e.reason))})", injectionTime: .atDocumentStart, forMainFrameOnly: true))
      }
      let v = SecondWebView(frame: w.contentView?.bounds ?? .zero, configuration: c)
      if test {
        let sel = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if v.responds(to: sel) {
          typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
          unsafeBitCast(v.method(for: sel), to: SetBool.self)(v, sel, false)
        }
      }
      v.autoresizingMask = [.width, .height]
      v.takeSecondDrops()   // drag and drop in and out (SecondDrop.swift)
      v.uiDelegate = app
      v.navigationDelegate = app
      w.contentView = v
      if test { w.center() } else if !w.setFrameUsingName("PSSecondWin") { w.center() }
      if !test { w.setFrameAutosaveName("PSSecondWin") }
      window = w; web = v
      ready = false
      v.load(URLRequest(url: URL(string: "ps://app/client/second-window" + (tab.map { "#" + $0 } ?? ""))!))
    } else if let tab {
      if ready { self.tab(tab) } else { pendingTab = tab }
    }
    guard let w = window else { return }
    if test {
      w.alphaValue = 0; w.ignoresMouseEvents = true; w.orderFrontRegardless()   // parked off screen by ScreenGuard
    } else {
      w.makeKeyAndOrderFront(nil)
      if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }
    if ready, let s = app.lastState { load(s) }
  }

  /// The main page loads again (a newer web build, or the refresh button): the window's page loads again too, on
  /// the tab it showed. Closing the window only hides it, so on 1 Nov 2026 the main page ran V1.27 while the
  /// window the developer had open since the morning still ran V1.26 and showed "Still looking" all day.
  func reloadPage() {
    guard let v = web else { return }
    ready = false; readyAt = .distantPast; settingsAt = .distantPast; loopLogged = false
    let tab = pendingTab ?? v.url?.fragment
    pendingTab = nil
    v.load(URLRequest(url: URL(string: "ps://app/client/second-window" + (tab.map { "#" + $0 } ?? ""))!))
  }

  private func tab(_ t: String) {
    web?.callAsyncJavaScript("window.__psSecondWin && window.__psSecondWin.tab(t)", arguments: ["t": t], in: nil, in: .page, completionHandler: nil)
  }

  /// The main page's state (the same JSON the overlay gets), while the window is open.
  func load(_ s: String) {
    guard ready, let w = window, w.isVisible || test else { return }
    if test { loads += 1 }
    web?.callAsyncJavaScript("window.__psSecondWin && window.__psSecondWin.load(JSON.parse(s))", arguments: ["s": s], in: nil, in: .page, completionHandler: nil)
  }

  /// PS settings (the reboot card reads settings.reboot), the same message the main page gets.
  func send(_ json: String) {
    guard ready, window?.isVisible == true || test else { return }
    web?.callAsyncJavaScript("window.__ps && window.__ps.apply(JSON.parse(m))", arguments: ["m": json], in: nil, in: .page, completionHandler: nil)
  }

  /// Self test only: the window and its page gone again, so the checks after it run as before.
  func testTearDown() {
    guard test else { return }
    web?.stopLoading(); web?.removeFromSuperview()
    window?.orderOut(nil); window?.contentView = nil
    web = nil; window = nil; ready = false; pendingTab = nil
    readyAt = .distantPast; settingsAt = .distantPast; seen = []; loads = 0; testLooks = nil
  }

  /// Closing only hides it; the page stays loaded so it opens at once next time.
  func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
}
