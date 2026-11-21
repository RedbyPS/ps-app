// The Posture reminder's card on a Mac (PS 1.65). The page (web src/posturewatch.ts, rules in core/posture.ts) decides WHEN:
// this file only (1) reads how long the keyboard and mouse have been still and whether Sleep mode, Sentry mode or Do Not
// Disturb covers the screen, and tells the page, and (2) draws the card the page asks for and tells the page when it was
// answered. The card has the look of the Annoying 15 min reminder (Reminders.swift): dark glass, the pink accent, a pill,
// a title, and here a stick figure that slouches and sits up straight (the picture comes from the page: web
// core/posturefigure.ts, set as plain markup of our own, never anything typed), then one button, "Sitting straight".
// Rules:
// - The sensor runs only while the page says the reminder is on ({type:"posture:plan", on}); off, nothing is read.
// - It reads only the time since the last input and whether the screen is locked, never a key, never an app's content.
// - A card is never shown over 1Password or Signal (golden rule: only whether one of them is in front is checked): it is
//   hidden there and comes back after. It never takes the keyboard unless it is clicked; then Esc closes it.
// - Sleep mode, Sentry mode or Do Not Disturb: no card opens and one that is up steps aside.
// - Esc (when the card has the keyboard, after a click) or the button ends it; both tell the page.
import AppKit
import WebKit

final class PosturePanel: NSPanel {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }
}
/// The card's page. The panel is non activating and not key while it waits, so a plain WKWebView spent the first click on
/// making the card key and dropped it; OK then needed more clicks (the developer, 21 Nov 2026). The first click now presses the button.
final class PostureWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }   // the first click on a button counts
}

final class Posture: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  static let shared = Posture()
  static let width: CGFloat = 460
  static let id = "posture"

  /// A message for the page (main.swift sends it to the main page, retried while that page loads).
  var onMessage: ((String) -> Void)?
  var coveredNow: () -> Bool = { SleepScreen.shared.isUp || Sentry.shared.isUp || DND.shared.mutes("followup") }
  var shieldNow: () -> Bool = { Protected.front }

  private var timer: Timer?
  private var panel: PosturePanel?
  private var web: PostureWebView?
  private var ready = false
  private var height: CGFloat = 330
  private var pending: [String: Any]?
  private(set) var up = false

  // ---------- from the page ----------
  @discardableResult func handle(_ type: String, _ msg: [String: Any]) -> Bool {
    switch type {
    case "posture:plan": setSensor(on: (msg["on"] as? Bool) == true)
    case "posture:show": show(msg)
    case "posture:hide": close(tell: false)
    default: return false
    }
    return true
  }

  // ---------- the sensor ----------
  private func setSensor(on: Bool) {
    if !on { timer?.invalidate(); timer = nil; close(tell: false); return }
    guard timer == nil else { return }
    let t = Timer(timeInterval: 10, repeats: true) { [weak self] _ in if !LowPower.shared.asleep("alarms") { self?.tick() } }   // PS 1.65 Low power mode
    t.tolerance = 2
    RunLoop.main.add(t, forMode: .common)
    timer = t
    tick()
  }
  private func tick() {
    let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let locked = session?["CGSSessionScreenIsLocked"] as? Bool ?? false
    let onConsole = session?["kCGSSessionOnConsoleKey"] as? Bool ?? true
    let away = locked || !onConsole
    let m: [String: Any] = ["type": "postureEnv", "idle": away ? 1_000_000.0 : max(0, idle.rounded()), "covered": coveredNow()]
    if let d = try? JSONSerialization.data(withJSONObject: m), let s = String(data: d, encoding: .utf8) { onMessage?(s) }
    place()
  }

  // ---------- the card (main thread) ----------
  private func make() {
    let c = WKWebViewConfiguration()
    c.websiteDataStore = .nonPersistent()
    c.userContentController.add(self, name: "pf")
    let w = PostureWebView(frame: NSRect(x: 0, y: 0, width: Posture.width, height: height), configuration: c)
    w.setValue(false, forKey: "drawsBackground")
    w.navigationDelegate = self
    let p = PosturePanel(contentRect: NSRect(x: 0, y: 0, width: Posture.width, height: height), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
    p.level = .statusBar
    p.hidesOnDeactivate = false
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.contentView = w
    panel = p; web = w; ready = false
    w.loadHTMLString(Posture.page, baseURL: nil)
  }
  private func show(_ msg: [String: Any]) {
    // Never over Sleep mode, Sentry mode or Do Not Disturb (the page checks too). Say so, or the page waits for an answer that never comes.
    guard !coveredNow() else { onMessage?("{\"type\":\"postureAct\",\"act\":\"skipped\"}"); return }
    func s(_ k: String, _ max: Int) -> String { String(((msg[k] as? String) ?? "").prefix(max)) }
    var o: [String: Any] = ["svg": s("svg", 4000), "css": s("css", 4000), "pill": s("pill", 40), "title": s("title", 60), "button": s("button", 40), "test": (msg["test"] as? Bool) == true,
                          "wait": min(10_000, max(0, (msg["wait"] as? NSNumber)?.intValue ?? 3500))]
    // The first pop-up's one-time question (words come from the page, plain text only).
    if let a = msg["ask"] as? [String: Any] {
      func t(_ k: String) -> String { String(((a[k] as? String) ?? "").prefix(60)) }
      o["ask"] = ["title": t("title"), "off": t("off"), "keep": t("keep")]
    }
    pending = o
    if panel == nil { make() }
    up = true
    if ready { push() }
    place()
  }
  private func push() {
    guard ready, let o = pending else { return }
    web?.callAsyncJavaScript("window.__pf && window.__pf.set(o)", arguments: ["o": o], in: nil, in: .page, completionHandler: nil)
  }
  /// Tells the page (when the person answered), then closes.
  private func close(tell: Bool, act: String = "done") {
    let was = up
    up = false
    IslandColumn.shared.leave(Posture.id)
    if let p = panel {
      // Let go of this card at once and fade it out on its own: a card asked for during the fade (Try it now while one is up,
      // or the next slot) is always a fresh one, never this one taken away a moment later with the page still waiting on it.
      let w = web
      panel = nil; web = nil; ready = false; pending = nil
      w?.evaluateJavaScript("window.__pf && window.__pf.out()", completionHandler: nil)
      if p.isKeyWindow { p.resignKey() }
      NSAnimationContext.runAnimationGroup({ ctx in ctx.duration = 0.18; p.animator().alphaValue = 0 }, completionHandler: {
        p.orderOut(nil)
        w?.configuration.userContentController.removeScriptMessageHandler(forName: "pf")
      })
    }
    if tell && was { onMessage?("{\"type\":\"postureAct\",\"act\":\"\(act)\"}") }
    psLog("PS posture: \(tell ? act : "closed")")
  }
  /// Shown while up, except over 1Password or Signal (then hidden, and never holding the keyboard) or under a cover.
  func place() {
    guard up, let p = panel else { return }
    if shieldNow() || coveredNow() {
      if p.isKeyWindow { p.resignKey() }
      if p.isVisible { p.orderOut(nil) }
      IslandColumn.shared.leave(Posture.id)
      return
    }
    if let f = IslandColumn.shared.frame(id: Posture.id, kind: "reminders", size: NSSize(width: Posture.width, height: height), window: p, replace: { [weak self] in self?.place() }) {
      IslandColumn.shared.put(p, f, alpha: 1)
      return
    }
    let vf = (NSScreen.main ?? NSScreen.screens.first!).visibleFrame
    // Under any Annoying reminder cards that are up (about 180 points each), never on top of them.
    let y = vf.maxY - 10 - CGFloat(Reminders.shared.up.count) * 180 - height
    p.setFrame(NSRect(x: vf.midX - Posture.width / 2, y: y, width: Posture.width, height: height), display: true)
    if !p.isVisible { p.alphaValue = 1; p.orderFrontRegardless() }
  }
  /// Esc (EscAlways.swift): only reaches the card after a click gave it the keyboard. It ends the reminder for this time.
  func escape() { guard up else { return }; close(tell: true, act: "esc") }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { guard webView === web else { return }; ready = true; push() }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    decisionHandler(action.navigationType == .other ? .allow : .cancel)
  }
  func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.webView === web, let text = message.body as? String, let d = text.data(using: .utf8),
          let msg = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let type = msg["type"] as? String else { return }
    switch type {
    case "size":
      if let h = msg["h"] as? Double, h > 100, h < 700 { height = CGFloat(h.rounded(.up)); place() }
    case "ask":
      // The question's answer goes to the page, which saves it. Turn off makes the page close the card; Keep it on leaves it up.
      if let a = msg["a"] as? String, a == "off" || a == "keep" { onMessage?("{\"type\":\"postureAsk\",\"answer\":\"\(a)\"}") }
    case "done": close(tell: true, act: "done")
    case "esc": close(tell: true, act: "esc")
    default: break
    }
  }

  // The card: the same family as the reminder card (dark glass, pink accent). Its words and picture come in as arguments:
  // words as plain text (textContent), the picture is the page's own constant markup. Motion is transform and opacity only.
  private static let page = #"""
  <!doctype html><html><head><meta charset="utf-8"><style>
  :root{--bg:#28121e;--acc:#ec4e86;--ink:#fff;--sub:#e8dde3;--glow:22%;--pill:#f5a2c0}
  html,body{margin:0;background:transparent;overflow:hidden;color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Inter",sans-serif;-webkit-font-smoothing:antialiased;-webkit-user-select:none;cursor:default}
  #card{margin:8px;border-radius:22px;padding:18px 20px 20px;box-sizing:border-box;position:relative;overflow:hidden;text-align:center;
    background:radial-gradient(120% 90% at 50% 0%,color-mix(in srgb,var(--acc) var(--glow),transparent),transparent 60%),linear-gradient(165deg,color-mix(in srgb,var(--bg) 92%,#fff 8%),var(--bg) 70%);
    border:1.5px solid color-mix(in srgb,var(--acc) 60%,transparent);box-shadow:0 18px 44px rgba(0,0,0,.45),0 0 0 1px rgba(0,0,0,.25);transition:opacity .18s ease,transform .18s ease}
  body.in #card{animation:pop .5s cubic-bezier(.22,1,.36,1) both}
  body.out #card{opacity:0;transform:translateY(-8px) scale(.98)}
  @keyframes pop{from{transform:translateY(-10px) scale(.97);opacity:.2}}
  #card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--acc),color-mix(in srgb,var(--acc) 50%,#fff),var(--acc));background-size:200% 100%;animation:stripe 4s linear infinite}
  @keyframes stripe{to{background-position:-200% 0}}
  .pill{display:inline-flex;align-items:center;gap:7px;padding:3px 10px;border-radius:99px;font-size:10.5px;font-weight:850;letter-spacing:.14em;text-transform:uppercase;background:color-mix(in srgb,var(--acc) 18%,transparent);color:var(--pill)}
  .pill i{width:7px;height:7px;border-radius:50%;background:var(--acc);box-shadow:0 0 8px var(--acc);animation:pulse 1.4s ease-in-out infinite}
  .pill em{font-style:normal;opacity:.7}
  @keyframes pulse{50%{opacity:.3}}
  h1{margin:10px 0 4px;font-size:21px;font-weight:850;letter-spacing:.01em;line-height:1.2}
  #fig{margin:4px 0 8px}
  #b:not(.rdy){pointer-events:none}
  button{border:0;border-radius:99px;padding:9px 22px;font:700 13px -apple-system,sans-serif;color:#fff;cursor:pointer;transition:transform .1s;
    background:linear-gradient(180deg,color-mix(in srgb,var(--acc) 80%,#fff),color-mix(in srgb,var(--acc) 85%,#000));box-shadow:0 8px 20px color-mix(in srgb,var(--acc) 35%,transparent);animation:btnin .45s ease var(--w,3500ms) both}
  button:active{transform:scale(.97)}
  @keyframes btnin{from{opacity:0;transform:translateY(4px)}}
  #ask{display:none;margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.14);animation:btnin .45s ease var(--w,3500ms) both}
  #ask.on{display:block}
  #ask p{margin:0 0 8px;font-size:12.5px;color:var(--sub)}
  #ask span{display:inline-flex;gap:8px}
  #ask button{background:transparent;box-shadow:none;border:1px solid rgba(255,255,255,.25);padding:6px 14px;font:600 12px -apple-system,sans-serif;animation:none}
  #ask:not(.rdy){pointer-events:none}
  @media (prefers-reduced-motion:reduce){body.in #card,#card::before,.pill i,button,#ask{animation:none}}
  </style><style id="figcss"></style></head><body>
  <div id="card">
    <span class="pill"><i></i><span id="p"></span><em id="tt"></em></span>
    <h1 id="q"></h1>
    <div id="fig"></div>
    <button id="b" type="button"></button>
    <div id="ask"><p id="aq"></p><span><button id="ao" type="button"></button><button id="ak" type="button"></button></span></div>
  </div>
  <script>
  const post = (m) => { try { window.webkit.messageHandlers.pf.postMessage(JSON.stringify(m)); } catch (e) {} };
  const $ = (id) => document.getElementById(id);
  const size = () => post({ type: 'size', h: $('card').offsetHeight + 16 });
  window.__pf = {
    set(o) {
      $('p').textContent = o.pill; $('tt').textContent = o.test ? ' · test' : '';
      $('q').textContent = o.title; $('b').textContent = o.button;
      $('figcss').textContent = o.css; $('fig').innerHTML = o.svg;   // our own constant picture from the page, restarted each time
      const a = o.ask, ask = $('ask');
      ask.classList.toggle('on', !!a); ask.classList.remove('rdy');
      if (a) { $('aq').textContent = a.title; $('ao').textContent = a.off; $('ak').textContent = a.keep; }
      const b = $('b'); b.classList.remove('rdy'); ask.classList.remove('rdy');
      clearTimeout(window.__rt);
      const go = () => { b.classList.add('rdy'); ask.classList.add('rdy'); };
      const wait = typeof o.wait === 'number' ? o.wait : 3500;   // the figure's animation (web core/posturefigure.ts FIGURE_TOTAL_MS)
      document.documentElement.style.setProperty('--w', wait + 'ms');
      if (matchMedia('(prefers-reduced-motion:reduce)').matches) go(); else window.__rt = setTimeout(go, wait);
      document.body.classList.remove('in', 'out'); void document.body.offsetWidth; document.body.classList.add('in');
      size();
    },
    out() { document.body.classList.add('out'); },
  };
  $('b').addEventListener('click', () => post({ type: 'done' }));
  $('ao').addEventListener('click', () => post({ type: 'ask', a: 'off' }));
  $('ak').addEventListener('click', () => { post({ type: 'ask', a: 'keep' }); $('ask').classList.remove('on'); size(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); post({ type: 'esc' }); } });
  </script></body></html>
  """#
}
