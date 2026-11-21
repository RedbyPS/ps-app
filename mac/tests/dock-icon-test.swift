import Foundation
// Run: bash tests/dock-icon-test.sh
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
typealias C = DockIconCore
func st(_ phase: String?, to: Int? = 7, mine: Int = 7, done: Int = 0, busy: Bool = false, test: Bool = false) -> C.Step { C.step(phase: phase, to: to, mine: mine, doneFor: done, busy: busy, test: test) }

// ---------- when ----------
ok("the update finished for this build: refresh", st("ok") == .refresh)
ok("still starting (helper not done): wait", st("swapped") == .wait && st("healthy") == .wait)
ok("finished but another update is busy: wait, never during an update", st("ok", busy: true) == .wait)
ok("done once for this build: never again", st("ok", done: 7) == .skip)
ok("a newer build after an older refresh: refresh again", st("ok", to: 8, mine: 8, done: 7) == .refresh)
ok("the journal is about another build: nothing", st("ok", to: 6) == .skip)
ok("rolled back or failed: nothing", st("rolledBack") == .skip && st("failed") == .skip)
ok("no journal (fresh install, web only updates): nothing", st(nil, to: nil) == .skip)
ok("a test copy never touches the Dock", st("ok", test: true) == .skip && st("swapped", test: true) == .skip)

// ---------- did the icon change ----------
let a = Data([1, 2, 3]), b = Data([1, 2, 4])
ok("same icon: the Dock is left alone", !C.iconChanged(new: a, old: a))
ok("a different icon: the Dock restarts", C.iconChanged(new: b, old: a))
ok("unknown (a file is missing or empty): the Dock is left alone", !C.iconChanged(new: a, old: nil) && !C.iconChanged(new: nil, old: a) && !C.iconChanged(new: Data(), old: a))

// ---------- what runs ----------
let app = "/Applications/PS.app"
let quiet = C.commands(app: app, dock: false), loud = C.commands(app: app, dock: true)
ok("always: register the app again with Launch Services (force)", quiet.count == 1 && quiet[0].0 == C.lsregister && quiet[0].1 == ["-f", app])
ok("the Dock only restarts when asked, last, by name only", loud.count == 2 && loud[0] == quiet[0] && loud[1].0 == "/usr/bin/killall" && loud[1].1 == ["Dock"])
ok("lsregister is the system's own", C.lsregister.hasPrefix("/System/Library/Frameworks/CoreServices.framework/") && FileManager.default.isExecutableFile(atPath: C.lsregister))
ok("nothing else is ever run", !(quiet + loud).contains { $0.0.contains("defaults") || $0.0.contains("sudo") || $0.1.contains("-kill") || $0.1.contains("-delete") })
ok("the icon file is the one Info.plist names (1.72: AppIcon-<hash>)", C.icon(of: URL(fileURLWithPath: app), named: "AppIcon-0123abcdef").path == "/Applications/PS.app/Contents/Resources/AppIcon-0123abcdef.icns")
ok("a build before 1.72 (AppIcon) and a name with .icns already", C.iconFile(named: "AppIcon") == "AppIcon.icns" && C.iconFile(named: "X.icns") == "X.icns")
ok("no name, an empty one or one with a path or a leading dot: AppIcon.icns", [nil, "", "  ", "../x", "a/b", ".hidden"].allSatisfy { C.iconFile(named: $0) == "AppIcon.icns" })
let plist = try! PropertyListSerialization.data(fromPropertyList: ["CFBundleIconFile": "AppIcon-0123abcdef", "CFBundleName": "PS"], format: .xml, options: 0)
ok("the name is read from Info.plist's bytes; none for no or broken bytes", C.iconName(infoPlist: plist) == "AppIcon-0123abcdef" && C.iconName(infoPlist: nil) == nil && C.iconName(infoPlist: Data("x".utf8)) == nil)
ok("watches long enough for the helper's 90 seconds, then stops", C.every * Double(C.maxLooks) >= 300 && C.every >= 1)

// ---------- wired ----------
let here = URL(fileURLWithPath: CommandLine.arguments[1])
let updater = (try? String(contentsOf: here.appendingPathComponent("Sources/Updater.swift"), encoding: .utf8)) ?? ""
let io = (try? String(contentsOf: here.appendingPathComponent("Sources/DockIcon.swift"), encoding: .utf8)) ?? ""
ok("the updater starts it at launch", updater.contains("DockIcon.shared.start()"))
let build = (try? String(contentsOf: here.appendingPathComponent("build.sh"), encoding: .utf8)) ?? ""
ok("build.sh names the icns after its content and Info.plist names it", build.contains("ICON_NAME=\"AppIcon-$(shasum -a 256") && build.contains("-o \"$APP/Contents/Resources/$ICON_NAME.icns\"") && build.contains("Set :CFBundleIconFile $ICON_NAME"))
ok("the refresh compares each build's own named icon", io.contains("DockIconCore.iconName(infoPlist:") && io.contains("Contents/Info.plist"))
ok("the files and commands run off the main thread, each with a time limit", io.contains("DispatchQueue.global(qos: .utility).async { DockIcon.refresh") && io.contains("done.wait(timeout: .now() + 20)"))
ok("the touch is a new modification date on the app", io.contains("setAttributes([.modificationDate: Date()]"))
print(bad == 0 ? "ALL \(n) PASSED" : "\(bad) of \(n) FAILED")
exit(bad == 0 ? 0 : 1)
