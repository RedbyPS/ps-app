import Foundation
// Run: bash tests/hatch-test.sh. The rules of the Hatch update and start scenes (Sources/HatchCore.swift).
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }
func near(_ a: Double, _ b: Double) -> Bool { abs(a - b) < 0.0001 }
func built(_ s: HatchCore.Step) -> Double? { if case .build(let f) = s { return f }; return nil }

// the icon builds in step with the real progress, and never past 90 % before the relaunch
ok("download start builds a little", near(built(HatchCore.step("downloading", frac: 0))!, 0.04))
ok("half downloaded is further on", built(HatchCore.step("downloading", frac: 0.5))! > built(HatchCore.step("downloading", frac: 0.1))!)
ok("download done is 70 %", near(built(HatchCore.step("downloading", frac: 1))!, 0.70))
ok("a wild progress is clamped", near(built(HatchCore.step("downloading", frac: 7))!, 0.70) && near(built(HatchCore.step("downloading", frac: -3))!, 0.04))
ok("no progress yet counts as 0", near(built(HatchCore.step("downloading", frac: nil))!, 0.04))
ok("not a number counts as 0", near(built(HatchCore.step("downloading", frac: .nan))!, 0.04))
ok("verify, install, relaunch go up in order", built(HatchCore.step("verifying", frac: nil))! < built(HatchCore.step("installing", frac: nil))!
   && built(HatchCore.step("installing", frac: nil))! < built(HatchCore.step("relaunching", frac: nil))!)
ok("the relaunch stops at 90 %", near(built(HatchCore.step("relaunching", frac: 1))!, HatchCore.preRelaunchMax))
ok("every step stays under the new build's part", ["downloading", "verifying", "installing", "relaunching"].allSatisfy { built(HatchCore.step($0, frac: 1))! <= 0.9 })
ok("waiting for Relaunch to finish rests", HatchCore.step("ready", frac: nil) == .rest(0.84))
ok("an error ends the scene", HatchCore.step("error", frac: nil) == .end)
ok("nothing newer ends the scene", HatchCore.step("none", frac: nil) == .end)
ok("done and checking change nothing here", HatchCore.step("done", frac: nil) == .none && HatchCore.step("checking", frac: nil) == .none && HatchCore.step("available", frac: nil) == .none)

// across the relaunch
let T = 1_763_500_000.0
let c = HatchCarry(to: 2611181200, version: "1.67", built: 0.9, at: T)
ok("the new build picks up where the old one stopped", near(HatchCore.resume(c, mine: 2611181200, now: T + 3), 0.9))
ok("a carry for another build is ignored", HatchCore.resume(c, mine: 2611181300, now: T + 3) == 0)
ok("a stale carry is ignored", HatchCore.resume(c, mine: 2611181200, now: T + 601) == 0)
ok("a carry from the future is ignored", HatchCore.resume(c, mine: 2611181200, now: T - 60) == 0)
ok("no carry (updated from a build without the scene): from nothing", HatchCore.resume(nil, mine: 2611181200, now: T) == 0)
ok("a carry never claims more than 90 %", near(HatchCore.resume(HatchCarry(to: 1, version: "1.67", built: 5, at: T), mine: 1, now: T), 0.9))
ok("the carry survives encode and decode", HatchCore.decode(HatchCore.encode(c)) == c)
ok("a broken carry file is nothing", HatchCore.decode(Data("{oops".utf8)) == nil && HatchCore.decode(nil) == nil)

// one play per update; the start scene
ok("plays once for a new version", HatchCore.playUpdate(played: nil, version: "V1.67 · Hatch") && HatchCore.playUpdate(played: "V1.66 · Optimism", version: "V1.67 · Hatch"))
ok("never twice for the same version", !HatchCore.playUpdate(played: "V1.67 · Hatch", version: "V1.67 · Hatch"))
ok("never for an unknown version", !HatchCore.playUpdate(played: nil, version: ""))
ok("the start switch is on by default", HatchCore.launchOn(nil) && HatchCore.launchOn(true) && HatchCore.launchOn("x"))
ok("the start switch off is off", !HatchCore.launchOn(false))
ok("start scene on a normal start", HatchCore.playLaunch(on: true, afterUpdate: false, test: false, install: false))
ok("not after an update (the update scene plays, never both)", !HatchCore.playLaunch(on: true, afterUpdate: true, test: false, install: false))
ok("not when switched off", !HatchCore.playLaunch(on: false, afterUpdate: false, test: false, install: false))
ok("never in a test copy or the install screen", !HatchCore.playLaunch(on: true, afterUpdate: false, test: true, install: false) && !HatchCore.playLaunch(on: true, afterUpdate: false, test: false, install: true))

// the number
ok("V1.67 · Hatch reads 1.67", HatchCore.versionText("V1.67 · Hatch") == "1.67")
ok("1.67 stays 1.67", HatchCore.versionText("1.67") == "1.67")
ok("a maker's name is left out", HatchCore.versionText("V1.59 by Jan · Harmony") == "1.59")
ok("only digits and dots", HatchCore.versionText("V1.6<7>x") == "1.67")
ok("never long", HatchCore.versionText("V12345.678901").count <= 8)

// sounds follow the settings, and only known ones
ok("sounds on", HatchCore.sounds(islandSounds: true, dndMutes: false, privateOn: false))
ok("the island's sound switch off silences it", !HatchCore.sounds(islandSounds: false, dndMutes: false, privateOn: false))
ok("Do Not Disturb silences it", !HatchCore.sounds(islandSounds: true, dndMutes: true, privateOn: false))
ok("private mode silences it", !HatchCore.sounds(islandSounds: true, dndMutes: false, privateOn: true))
ok("a known sound", HatchCore.sound("hatch-thud") == "hatch-thud")
ok("an unknown sound is refused", HatchCore.sound("thunder-crack") == nil && HatchCore.sound(3) == nil && HatchCore.sound(nil) == nil)
ok("quiet", HatchCore.volume <= 0.4)

// never over 1Password or Signal
ok("waits while 1Password or Signal is in front", !HatchCore.mayShow(protectedFront: true) && HatchCore.mayShow(protectedFront: false))
ok("a start scene is not played late", HatchCore.giveUp(.launch, waited: 21) && !HatchCore.giveUp(.launch, waited: 5))
ok("an update scene waits much longer", !HatchCore.giveUp(.update, waited: 300) && HatchCore.giveUp(.update, waited: 1801))

// The developer, 18 Nov 2026: the update animation must be watched; the start scene can be skipped
ok("the update scene cannot be skipped", !HatchCore.skippable(.update))
ok("the start scene can be skipped", HatchCore.skippable(.launch))
ok("the update scene always ends within 15 s", HatchCore.maxSeconds(.update) <= 15)
ok("the start scene ends sooner", HatchCore.maxSeconds(.launch) < HatchCore.maxSeconds(.update))

// the island's place on the scene page
let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
let r = HatchCore.pageRect(CGRect(x: 591, y: 944, width: 330, height: 38), screen: screen)
ok("bottom left points become top left page points", r?["x"] == 591 && r?["y"] == 0 && r?["w"] == 330 && r?["h"] == 38)
let second = CGRect(x: 1512, y: -200, width: 1920, height: 1080)
let r2 = HatchCore.pageRect(CGRect(x: 2307, y: 840, width: 330, height: 34), screen: second)
ok("a second screen is its own page", r2?["x"] == 795 && r2?["y"] == 6)
ok("no island: nil (the blob goes to the top centre)", HatchCore.pageRect(nil, screen: screen) == nil)
ok("an island on another screen: nil", HatchCore.pageRect(CGRect(x: 2307, y: 840, width: 330, height: 34), screen: screen) == nil)
ok("an empty shape: nil", HatchCore.pageRect(CGRect(x: 10, y: 10, width: 0, height: 0), screen: screen) == nil)

print("\n\(n - bad) of \(n) passed")
exit(bad == 0 ? 0 : 1)
