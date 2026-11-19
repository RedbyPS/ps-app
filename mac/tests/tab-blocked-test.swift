// Offline test for Sources/TabBlockedCore.swift (PS 1.70, the Tab blocked card): when PS counts as blind to Tab, the
// half second hold, the rate limit, who is named (1Password and Signal never), the words (no em or en dashes) and the
// log lines. Also SecureInputCore.frontHolder and SafePeekCore's new .secureFront case. Asks macOS nothing, registers no
// hotkey, sends no key, opens no window. Run: tests/tab-blocked-test.sh (safe while someone uses the Mac).
import Foundation

var fails = 0
func check(_ name: String, _ ok: Bool) { print("\(name)=\(ok ? "ok" : "FAIL")"); if !ok { fails += 1 } }
typealias T = TabBlockedCore
func blind(_ f: (inout TabBlockedFacts) -> Void) -> TabBlockedCause? { var x = TabBlockedFacts(); f(&x); return T.blind(x) }

// ---------- When PS is blind to Tab ----------
check("nothing-wrong", blind { _ in } == nil)
check("secure-input", blind { $0.secureOn = true } == .secureInput)
check("no-permission", blind { $0.trusted = false } == .permission)
check("deaf-is-permission", blind { $0.deaf = true } == .permission)
check("permission-before-secure", blind { $0.trusted = false; $0.secureOn = true } == .permission)
check("ps-own-passphrase-box", blind { $0.secureOn = true; $0.holderIsMe = true } == nil)
// Golden rule: never anything while 1Password or Signal is in front, whatever else is wrong.
check("protected-front-secure", blind { $0.secureOn = true; $0.protectedFront = true } == nil)
check("protected-front-permission", blind { $0.trusted = false; $0.protectedFront = true } == nil)
// Never while the list is up or kept, Sleep or Sentry mode, PS's own window, an ignored app.
check("list-up", blind { $0.secureOn = true; $0.shown = true } == nil)
check("kept", blind { $0.secureOn = true; $0.kept = true } == nil)
check("sleep-or-sentry", blind { $0.secureOn = true; $0.sleepUp = true } == nil)
check("ps-window-in-front", blind { $0.secureOn = true; $0.appActive = true } == nil)
check("ignored-app", blind { $0.secureOn = true; $0.frontIgnored = true } == nil)
// Switches.
check("switch-off", blind { $0.secureOn = true; $0.on = false } == nil)
check("tab-overlay-off", blind { $0.trusted = false; $0.enabled = false } == nil)
check("tab-not-a-hold-key", blind { $0.secureOn = true; $0.holdsTab = false } == nil)
check("test-copy", blind { $0.secureOn = true; $0.testCopy = true } == nil)

// ---------- The half second hold ----------
var c = TabHoldClock()
check("hold-up-nothing", !c.step(down: false, now: 0))
check("hold-starts", !c.step(down: true, now: 1.0))
check("hold-0.4-not-yet", !c.step(down: true, now: 1.4))
check("hold-0.5-fires", c.step(down: true, now: 1.5))
check("hold-fires-once", !c.step(down: true, now: 1.6) && !c.step(down: true, now: 3.0))
check("hold-let-go", !c.step(down: false, now: 3.1))
check("hold-again-fires-again", !c.step(down: true, now: 4.0) && c.step(down: true, now: 4.55))
var q = TabHoldClock()
check("quick-taps-never", !q.step(down: true, now: 0) && !q.step(down: true, now: 0.3) && !q.step(down: false, now: 0.35)
      && !q.step(down: true, now: 0.4) && !q.step(down: true, now: 0.8) && !q.step(down: false, now: 0.85))
check("hold-is-half-a-second", T.holdFor == 0.5)
check("poll-is-light", T.pollEvery >= 0.04 && T.pollEvery <= 0.1)

// ---------- Rate limit ----------
var m = TabBlockedMemo()
check("first-allowed", T.allow(key: "secure:DuckDuckGo", now: 100, memo: m, up: false))
check("never-while-up", !T.allow(key: "secure:DuckDuckGo", now: 100, memo: m, up: true))
m = T.shown(m, now: 100)
check("gap", !T.allow(key: "secure:Safari", now: 100 + T.gap - 0.1, memo: m, up: false))
check("after-gap", T.allow(key: "secure:Safari", now: 100 + T.gap, memo: m, up: false))
m = T.closed(m, key: "secure:DuckDuckGo", now: 110)
check("closed-quiet", !T.allow(key: "secure:DuckDuckGo", now: 110 + T.quietAfterClose - 1, memo: m, up: false))
check("closed-other-app-ok", T.allow(key: "secure:Safari", now: 120, memo: m, up: false))
check("closed-quiet-ends", T.allow(key: "secure:DuckDuckGo", now: 110 + T.quietAfterClose, memo: m, up: false))

// ---------- Who is named ----------
let me: Int32 = 500
func holder(_ h: SecureHolder?) -> TabBlockedHolder { T.holder(label: SecureInputCore.label(h, me: me, appName: "PS"), appName: "PS") }
let ddg = SecureHolder(pid: 801, bundleId: "com.duckduckgo.macos.browser", name: "DuckDuckGo")
let onePw = SecureHolder(pid: 700, bundleId: "com.1password.1password", name: nil)
let onePwNamed = SecureHolder(pid: 701, bundleId: nil, name: "1Password Browser Helper")
let signal = SecureHolder(pid: 702, bundleId: "org.whispersystems.signal-desktop", name: nil)
let lock = SecureHolder(pid: 416, bundleId: "com.apple.loginwindow", name: "loginwindow")
check("names-duckduckgo", holder(ddg) == .app("DuckDuckGo"))
check("1password-neutral", holder(onePw) == .passwordApp)
check("1password-helper-neutral", holder(onePwNamed) == .passwordApp)
check("signal-neutral", holder(signal) == .passwordApp)
check("lock-screen", holder(lock) == .lockScreen)
check("unknown", holder(nil) == .unknown)
check("terminal-secure-entry", T.holder(label: "Terminal", appName: "PS", bundleId: "com.apple.Terminal") == .secureEntry("Terminal"))
check("iterm-secure-entry", T.holder(label: "iTerm2", appName: "PS", bundleId: "com.googlecode.iterm2") == .secureEntry("iTerm2"))
check("browser-not-secure-entry", T.holder(label: "DuckDuckGo", appName: "PS", bundleId: "com.duckduckgo.macos.browser") == .app("DuckDuckGo"))
check("ps-itself-unknown", holder(SecureHolder(pid: me, bundleId: "com.cincee.ps", name: "PS")) == .unknown)

// ---------- The words ----------
let pane27 = T.paneName(macOSMajor: 27), pane26 = T.paneName(macOSMajor: 26)
check("pane-macos-27", pane27 == "Device Control and Data Access")
check("pane-older", pane26 == "Accessibility")
let all: [TabBlockedText] = [
  T.text(.secureInput, holder: .app("DuckDuckGo"), appName: "PS", pane: pane27),
  T.text(.secureInput, holder: .passwordApp, appName: "PS", pane: pane27),
  T.text(.secureInput, holder: .lockScreen, appName: "PS", pane: pane27),
  T.text(.secureInput, holder: .unknown, appName: "PS", pane: pane27),
  T.text(.secureInput, holder: nil, appName: "PS app", pane: pane27),
  T.text(.permission, holder: nil, appName: "PS", pane: pane27),
  T.text(.permission, holder: nil, appName: "PS", pane: pane26),
  T.text(.secureInput, holder: .secureEntry("Terminal"), appName: "PS", pane: pane27),
]
let ddgText = all[0]
check("ddg-title", ddgText.title == "DuckDuckGo is blocking Tab")
check("ddg-steps", ddgText.steps == ["Click outside the password box in DuckDuckGo.", "Or quit DuckDuckGo.", "Then hold Tab again."])
check("ddg-no-settings-button", ddgText.button == nil)
check("permission-button", all[5].button == "Open Settings")
check("terminal-steps", all[7].steps == ["Click the Terminal menu at the top of the screen.", "Turn off Secure Keyboard Entry.", "Then hold Tab again."])
check("permission-pane-27", all[5].steps.contains("Find PS in Device Control and Data Access."))
check("permission-pane-older", all[6].steps.contains("Find PS in Accessibility."))
check("permission-off-on", all[5].steps.last == "Turn it off, then on again.")
check("unknown-default", all[4] == all[3].with(app: "PS app"))
var words = all.flatMap { [$0.title, $0.line] + $0.steps + [$0.button ?? ""] } + [T.ok, T.fixed, T.closeHelp]
for cause in [TabBlockedCause.secureInput, .permission] {
  for h in [TabBlockedHolder.app("DuckDuckGo"), .secureEntry("Terminal"), .passwordApp, .lockScreen, .unknown] {
    words.append(T.logShow(cause, holder: h, signal: "hotkey"))
  }
  words.append(T.logShow(cause, holder: nil, signal: "key state"))
}
let dashes = words.filter { $0.contains("\u{2014}") || $0.contains("\u{2013}") || $0.contains(" - ") }
check("no-em-or-en-dashes", dashes.isEmpty)
let secret = words.filter { let l = $0.lowercased(); return l.contains("1password") || l.contains("signal") || l.contains("agilebits") || l.contains("whispersystems") }
check("never-names-1password-or-signal", secret.isEmpty)
check("short-steps", all.allSatisfy { $0.steps.count == 3 && $0.steps.allSatisfy { $0.count <= 60 } })
check("short-titles", all.allSatisfy { $0.title.count <= 40 })
check("ends-with-a-full-stop", all.allSatisfy { $0.line.hasSuffix(".") && $0.steps.allSatisfy { $0.hasSuffix(".") } })

// ---------- The rate limit keys never carry a protected name ----------
check("key-password", T.key(.secureInput, .passwordApp) == "secure:password")
check("key-app", T.key(.secureInput, .app("DuckDuckGo")) == "secure:DuckDuckGo")
check("key-permission", T.key(.permission, .app("x")) == "permission")

// ---------- SecureInputCore.frontHolder (the 19 Nov case) ----------
let safari = SecureHolder(pid: 800, bundleId: "com.apple.Safari", name: "Safari")
check("front-holder-ddg", SecureInputCore.frontHolder(on: true, holders: [ddg], frontPid: 801, me: me, protectedFront: false) == ddg)
check("front-holder-off", SecureInputCore.frontHolder(on: false, holders: [ddg], frontPid: 801, me: me, protectedFront: false) == nil)
check("front-holder-background-only", SecureInputCore.frontHolder(on: true, holders: [ddg], frontPid: 800, me: me, protectedFront: false) == nil)
check("front-holder-picks-front", SecureInputCore.frontHolder(on: true, holders: [safari, ddg], frontPid: 801, me: me, protectedFront: false) == ddg)
check("front-holder-never-ps", SecureInputCore.frontHolder(on: true, holders: [SecureHolder(pid: me, bundleId: "com.cincee.ps", name: "PS")], frontPid: me, me: me, protectedFront: false) == nil)
check("front-holder-never-protected-front", SecureInputCore.frontHolder(on: true, holders: [onePw], frontPid: 700, me: me, protectedFront: true) == nil)
check("front-holder-never-protected-id", SecureInputCore.frontHolder(on: true, holders: [onePw], frontPid: 700, me: me, protectedFront: false) == nil)
check("front-holder-never-protected-name", SecureInputCore.frontHolder(on: true, holders: [onePwNamed], frontPid: 701, me: me, protectedFront: false) == nil)
check("front-holder-no-front", SecureInputCore.frontHolder(on: true, holders: [ddg], frontPid: nil, me: me, protectedFront: false) == nil)

// ---------- SafePeekCore .secureFront ----------
typealias S = SafePeekCore
func want(_ f: (inout S.Inputs) -> Void) -> Bool { var i = S.Inputs(); f(&i); return S.wantTab(i) }
check("sp-front-armed", want { $0.secureFront = true })
check("sp-front-why", { var i = S.Inputs(); i.secureFront = true; return S.blind(i) }() == .secureFront)
check("sp-front-card-not-list", S.holdShowsCard(.secureFront) && !S.holdShowsCard(.secureInput) && !S.holdShowsCard(.protected) && !S.holdShowsCard(nil))
check("sp-front-off-tab-off", !want { $0.secureFront = true; $0.enabled = false })
check("sp-front-off-kept", !want { $0.secureFront = true; $0.kept = true })
check("sp-front-off-ps-window", !want { $0.secureFront = true; $0.appActive = true })
check("sp-front-off-ignored", !want { $0.secureFront = true; $0.frontIgnored = true })
check("sp-front-off-passing-on", !want { $0.secureFront = true; $0.passingOn = true })
check("sp-front-off-typing-in-list", !want { $0.secureFront = true; $0.editing = true; $0.shown = true })
// Protected first: over 1Password or Signal the old rules decide (the developer: never armed), never the card.
check("sp-protected-wins", { var i = S.Inputs(); i.secureFront = true; i.protectedFront = true; return S.blind(i) }() == .protected)
check("sp-red-protected-front-never", !want { $0.secureFront = true; $0.protectedFront = true; $0.tabOverProtected = false })
check("sp-stuck-wins", { var i = S.Inputs(); i.secureFront = true; i.secureStuck = true; return S.blind(i) }() == .secureInput)
check("sp-quick-tap-goes-on", S.passOnTap(protectedFront: false))
check("sp-log-front", S.logLine(armed: true, why: .secureFront).contains("watching for a hold"))
check("sp-log-never-names", !S.logLine(armed: true, why: .secureFront).lowercased().contains("1password"))

// ---------- PS 1.71: per BUILD (Profile.allows, BuildRules.now) ----------
// The 1.70 changes against the developer's rule (Tab and the island over 1Password and Signal: on in the G Squad build, off in
// his own build, whoever is signed in). Over 1Password or Signal the Tab blocked card never shows on either build (the
// golden rule), Secure Input held by them never arms .secureFront, and the hold follows the build's rule to the list.
func pj(_ s: String) -> Any { try! JSONSerialization.jsonObject(with: s.data(using: .utf8)!) }
let gsqP = Profile.from(pj(#"{"schema":1,"name":"gsquad","channel":{"kind":"gsquad"},"othersShared":"on","rules":{"tabOverProtectedApps":true,"islandOverProtectedApps":true}}"#))
let redLayerR = Profile.rulesFrom(pj(#"{"tabOverProtectedApps":false,"islandOverProtectedApps":false}"#))
for (b, prof, layer, on) in [("gsquad-build", gsqP, nil, true), ("red-build", nil, redLayerR, false)] as [(String, Profile?, [String: Bool]?, Bool)] {
  for (a, isRed) in [("red-account", true), ("friend-account", false)] {
    let r = BuildRules.fromProfile(BuildRules.rules(red: isRed), profile: prof, layer: layer)
    let t = "1.71-\(b)-\(a)"
    for (n, h, pid) in [("1password", onePw, Int32(700)), ("1password-helper", onePwNamed, Int32(701)), ("signal", signal, Int32(702))] {
      // Secure Input held by them while they are in front: never the app in front for the card, never stuck.
      check("\(t)-\(n)-front-holder-never", SecureInputCore.frontHolder(on: true, holders: [h], frontPid: pid, me: me, protectedFront: true) == nil)
      check("\(t)-\(n)-not-stuck-in-front", !SecureInputCore.stuck(on: true, holders: [h], frontPid: pid).stuck)
    }
    // No card over them, whatever else is wrong.
    check("\(t)-no-card-secure", blind { $0.secureOn = true; $0.protectedFront = true } == nil)
    check("\(t)-no-card-permission", blind { $0.trusted = false; $0.protectedFront = true } == nil)
    check("\(t)-no-card-deaf", blind { $0.deaf = true; $0.protectedFront = true } == nil)
    // secureFront left over from the app before (DuckDuckGo) while 1Password or Signal is now in front: protected wins,
    // the build decides, a hold brings the list (never the card), Esc follows.
    var i = S.Inputs(); i.protectedFront = true; i.secureFront = true; i.tabOverProtected = r.tabOverProtected
    check("\(t)-secure-front-leftover-protected-wins", S.blind(i) == .protected)
    check("\(t)-secure-front-leftover-\(on ? "armed" : "never")", S.wantTab(i) == on)
    check("\(t)-secure-front-leftover-list-not-card", !S.holdShowsCard(S.blind(i)))
    check("\(t)-secure-front-leftover-esc", S.wantEsc(protectedFront: true, secureStuck: false, shown: true, tabOverProtected: r.tabOverProtected) == on)
    // Back in DuckDuckGo with its password box: the 1.70 card rule is the same on both builds and every account.
    var d = S.Inputs(); d.secureFront = true; d.tabOverProtected = r.tabOverProtected
    check("\(t)-duckduckgo-card-unchanged", S.wantTab(d) && S.holdShowsCard(S.blind(d)))
  }
}

print(fails == 0 ? "tab-blocked: all passed" : "tab-blocked: \(fails) FAILED")
exit(fails == 0 ? 0 : 1)

extension TabBlockedText {
  /// The same words with another app name (for the "nil holder is unknown" check).
  func with(app: String) -> TabBlockedText { TabBlockedCore.text(.secureInput, holder: .unknown, appName: app, pane: "x") }
}
