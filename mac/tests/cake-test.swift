import Foundation
// Run: bash tests/cake-test.sh. The rules of the Cake boot animation and logo reveal (Sources/CakeCore.swift).
var n = 0, bad = 0
func ok(_ name: String, _ c: Bool) { n += 1; if c { print("ok - \(name)") } else { bad += 1; print("FAIL - \(name)") } }

// 1. random, never the same one twice in a row
for last in 1...3 {
  var seen = Set<Int>()
  for i in 0..<100 { let s = CakeCore.pick(last: last, roll: Double(i) / 100); seen.insert(s.rawValue) }
  ok("after scene \(last) never scene \(last) again", !seen.contains(last))
  ok("after scene \(last) both others can come", seen.count == 2)
}
var first = Set<Int>()
for i in 0..<100 { first.insert(CakeCore.pick(last: nil, roll: Double(i) / 100).rawValue) }
ok("the first start can be any of the three", first == [1, 2, 3])
ok("an unknown last one (0, 7) leaves all three", Set((0..<30).map { CakeCore.pick(last: 7, roll: Double($0) / 30).rawValue }) == [1, 2, 3]
   && Set((0..<30).map { CakeCore.pick(last: 0, roll: Double($0) / 30).rawValue }) == [1, 2, 3])
ok("a roll of 1 or more stays in range", CakeCore.pick(last: 1, roll: 1).rawValue == 3 && CakeCore.pick(last: nil, roll: 5).rawValue == 3)
ok("a broken roll stays in range", CakeCore.pick(last: 2, roll: .nan).rawValue == 1 && CakeCore.pick(last: 2, roll: -4).rawValue == 1)
// a long run of starts with the system random: no repeat ever, and every scene shows up
var last: Int? = nil, repeats = 0, count = [0, 0, 0, 0]
for _ in 0..<3000 { let s = CakeCore.pick(last: last, roll: Double.random(in: 0..<1)).rawValue; if s == last { repeats += 1 }; count[s] += 1; last = s }
ok("3000 starts: never the same twice in a row", repeats == 0)
ok("3000 starts: each scene plays roughly a third", count[1...3].allSatisfy { $0 > 800 && $0 < 1200 })
ok("the names", CakeScene.nightDrive.name == "Night drive" && CakeScene.harborLights.name == "Harbor lights" && CakeScene.citySwarm.name == "City swarm")

// 2. fixed speed: each scene's own length, the same every time
ok("Night drive is 6.0 s", CakeCore.seconds(.nightDrive) == 6.0)
ok("Harbor lights and City swarm are 5.4 s", CakeCore.seconds(.harborLights) == 5.4 && CakeCore.seconds(.citySwarm) == 5.4)
ok("the logo reveal is 6.4 s", CakeCore.revealSeconds == 6.4)
ok("the safety end leaves room for the whole hold", CakeScene.allCases.allSatisfy { CakeCore.maxSeconds(.boot($0)) > CakeCore.seconds($0) + CakeCore.holdMax + CakeCore.fadeSeconds })
ok("the reveal's safety end is short", CakeCore.maxSeconds(.reveal(replay: false)) < 12)

// 3. the end: signed in, signed out, still loading (the calm loop holds)
ok("signed in and the island knows its task: the island", CakeCore.ending(signedIn: true, islandKnown: true, signedOut: false, locked: false, held: 0) == .island)
ok("signed in but the island not told yet: hold", CakeCore.ending(signedIn: true, islandKnown: false, signedOut: false, locked: false, held: 1) == .hold)
ok("signed out: the Sign in window", CakeCore.ending(signedIn: false, islandKnown: false, signedOut: true, locked: false, held: 0) == .signIn)
ok("signed out with the island told: still the Sign in window", CakeCore.ending(signedIn: false, islandKnown: true, signedOut: true, locked: false, held: 0) == .signIn)
ok("Remember me still opening: hold", CakeCore.ending(signedIn: false, islandKnown: true, signedOut: false, locked: false, held: 3) == .hold)
ok("Touch ID locked: the island, no Sign in window", CakeCore.ending(signedIn: false, islandKnown: true, signedOut: false, locked: true, held: 0) == .island)
ok("held too long: it ends anyway with the island", CakeCore.ending(signedIn: false, islandKnown: false, signedOut: false, locked: false, held: CakeCore.holdMax) == .island)
ok("just under the longest hold: still holds", CakeCore.ending(signedIn: false, islandKnown: false, signedOut: false, locked: false, held: CakeCore.holdMax - 0.1) == .hold)

// 4. Esc skips both
ok("Esc skips every boot animation", CakeScene.allCases.allSatisfy { CakeCore.skippable(.boot($0)) })
ok("Esc skips the logo reveal, once and replayed", CakeCore.skippable(.reveal(replay: false)) && CakeCore.skippable(.reveal(replay: true)))

// 5. when it plays: every start, not after an update, never in a test or the install screen
ok("plays at a start with the switch on", CakeCore.playBoot(on: true, afterUpdate: false, test: false, install: false))
ok("the Start animation switch off: no boot animation", !CakeCore.playBoot(on: false, afterUpdate: false, test: false, install: false))
ok("a start after an update plays the update scene only", !CakeCore.playBoot(on: true, afterUpdate: true, test: false, install: false))
ok("never in a test copy or the install screen", !CakeCore.playBoot(on: true, afterUpdate: false, test: true, install: false) && !CakeCore.playBoot(on: true, afterUpdate: false, test: false, install: true))
ok("the logo reveal comes by itself once", CakeCore.revealDue(seen: false, test: false, install: false) && !CakeCore.revealDue(seen: true, test: false, install: false))
ok("the logo reveal never in a test copy or the install screen", !CakeCore.revealDue(seen: false, test: true, install: false) && !CakeCore.revealDue(seen: false, test: false, install: true))
ok("the keys are their own (never Hatch's)", CakeCore.lastKey != HatchCore.playedKey && CakeCore.revealKey != HatchCore.playedKey && CakeCore.lastKey != CakeCore.revealKey)

// 6. the words: CAKE, and the running version under it
ok("the headline is CAKE", CakeCore.headline == "CAKE")
ok("the version line reads the running version", CakeCore.versionLine("V1.73 · Something") == "PS 1.73" && CakeCore.versionLine("1.80") == "PS 1.80")
ok("no version known: just PS", CakeCore.versionLine("") == "PS")
ok("the notch shape at the top edge, a pill lower down", CakeCore.notchShaped(["x": 757, "y": 0, "w": 196, "h": 34]) && !CakeCore.notchShaped(["x": 40, "y": 900, "w": 270, "h": 30]) && CakeCore.notchShaped(nil))

print("\n\(n - bad)/\(n) passed")
exit(bad == 0 ? 0 : 1)
