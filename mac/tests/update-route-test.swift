// Offline test for which update channel a PS build follows (V1.58, multiple developers): the channel comes from the
// build's own profile (Resources/profile.json); no profile is today's channel, so nothing changes until a build says
// otherwise. A note made for another channel is refused, a G Squad note may be signed by the developer's key or the G Squad key
// once there is one, and a person's private channel trusts only its own key. Who made a release shows as "by Jan".
// Throwaway keys made here, FICTIONAL names, nothing online, no app launched.
// Run: bash tests/update-route-test.sh
import CryptoKit
import Foundation

var fails = 0
func check(_ name: String, _ ok: Bool, _ info: String = "") { print("\(name)=\(ok ? "ok" : "FAIL")\(info.isEmpty ? "" : " (\(info))")"); if !ok { fails += 1 } }
func profile(_ o: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: o) }

// 1. No profile, or one not understood: today's channel, with exactly today's key and certificate.
let none = UpdateRoute.from(profile: nil)
check("no-profile-is-gsquad", none.kind == .gsquad && none.id == "gsquad" && none.base?.absoluteString == UPDATE_CHANNEL)
check("no-profile-keys-as-v157", none.keys == [UPDATE_PUBLIC_KEY] || none.keys == [UPDATE_PUBLIC_KEY, UPDATE_GSQUAD_PUBLIC_KEY])
check("requirement-as-v157", UPDATE_GSQUAD_PUBLIC_KEY.isEmpty && PS_CERT_ROOT_GSQUAD.isEmpty
      ? none.requirement == #"identifier "com.cincee.ps" and certificate root = H"b278d9d09dfed336675cfb367b2f8a3b51896689""# : true, none.requirement)
check("this-test-has-no-profile", UpdateRoute.current == UpdateRoute.gsquad && PS_REQUIREMENT == UpdateRoute.gsquad.requirement)
for bad in [profile(["name": "jan"]), profile(["name": "jan", "channel": ["kind": "ftp"]]), Data("not json".utf8),
            profile(["name": "Jan Smith", "channel": ["kind": "url", "url": "https://example.invalid/ps/"]]),
            profile(["name": "jan", "channel": ["kind": "url", "url": "http://example.invalid/ps/"]]),
            profile(["name": "jan", "channel": ["kind": "url", "url": "https://example.invalid/ps"]]),
            profile(["name": "gsquad", "channel": ["kind": "url", "url": "https://example.invalid/ps/"]])] {
  check("not-understood-is-gsquad", UpdateRoute.from(profile: bad) == UpdateRoute.gsquad, String(data: bad, encoding: .utf8) ?? "")
}
check("gsquad-profile", UpdateRoute.from(profile: profile(["name": "gsquad", "channel": ["kind": "gsquad"]])) == UpdateRoute.gsquad)

// 2. A person's own channel: their address, their key and certificate when the profile names them, else the developer's.
let janKey = Curve25519.Signing.PrivateKey()
let jan = UpdateRoute.from(profile: profile(["name": "jan", "channel": ["kind": "url", "url": "https://example.invalid/jan/ps/",
  "key": janKey.publicKey.rawRepresentation.base64EncodedString(), "certRoot": String(repeating: "a", count: 40)]]))
check("private-url", jan.kind == .url && jan.id == "jan" && jan.base?.absoluteString == "https://example.invalid/jan/ps/")
check("private-own-key-only", jan.keys == [janKey.publicKey.rawRepresentation.base64EncodedString()])
check("private-own-cert", jan.requirement == #"identifier "com.cincee.ps" and certificate root = H""# + String(repeating: "a", count: 40) + #"""#)
let redOwn = UpdateRoute.from(profile: profile(["name": "red", "channel": ["kind": "url", "url": "https://example.invalid/r/"]]))
check("red-private-red-key-only", redOwn.keys == [UPDATE_PUBLIC_KEY] && redOwn.requirement.contains(PS_CERT_ROOT_RED) && !redOwn.requirement.contains(" or "))
let local = UpdateRoute.from(profile: profile(["name": "mia", "channel": ["kind": "local"]]))
check("local-has-no-channel", local.kind == .local && local.base == nil && local.id == "mia")
let badKey = UpdateRoute.from(profile: profile(["name": "jan", "channel": ["kind": "url", "url": "https://example.invalid/j/", "key": "nonsense", "certRoot": "XYZ"]]))
check("bad-key-falls-back-to-red", badKey.keys == [UPDATE_PUBLIC_KEY] && badKey.requirement.contains(PS_CERT_ROOT_RED))

// 3. Which notes a channel takes.
check("old-note-taken-everywhere", UpdateRoute.gsquad.takes(nil) && jan.takes(nil))
check("gsquad-note-on-gsquad", UpdateRoute.gsquad.takes("gsquad") && !UpdateRoute.gsquad.takes("jan"))
check("jan-note-only-on-jan", jan.takes("jan") && !jan.takes("gsquad") && !jan.takes("red"))

// 3b. V1.69 (the developer, 18 Nov 2026, after the G Squad's V1.68 reached his Mac): his private build carries its own channel
// in Resources/channel.json and takes only his own releases; a PS signed with his certificate never trusts anything else.
let ownFile = profile(["name": "red", "channel": ["kind": "url", "url": "https://example.invalid/ps/own-0000/"]])
let squadFile = profile(["name": "gsquad", "channel": ["kind": "gsquad"]])
let own = UpdateRoute.resolve(profile: nil, channel: ownFile, signedByRed: true)
check("own-channel-file-used", own.kind == .url && own.id == "red" && own.base?.absoluteString == "https://example.invalid/ps/own-0000/")
check("own-red-key-only", own.keys == [UPDATE_PUBLIC_KEY] && !own.keys.contains(UPDATE_GSQUAD_PUBLIC_KEY))
check("own-red-cert-only", own.requirement == #"identifier "com.cincee.ps" and certificate root = H""# + PS_CERT_ROOT_RED + #"""#, own.requirement)
check("own-takes-only-own-notes", own.takes("red") && !own.takes("gsquad") && !own.takes("jan"))
check("own-file-without-signature-same", UpdateRoute.resolve(profile: nil, channel: ownFile, signedByRed: false) == own)
check("profile-wins-over-channel-file", UpdateRoute.resolve(profile: squadFile, channel: ownFile, signedByRed: false) == UpdateRoute.gsquad)
// The developer's certificate pins the developer's key and certificate even with no channel file (a broken build of his): a G Squad note
// or a G Squad signed app is never taken.
let lost = UpdateRoute.resolve(profile: nil, channel: nil, signedByRed: true)
check("red-signed-no-file-red-only", lost.keys == [UPDATE_PUBLIC_KEY] && lost.requirement == own.requirement && lost.base?.absoluteString == UPDATE_CHANNEL)
check("red-signed-gsquad-profile-red-only", UpdateRoute.resolve(profile: squadFile, channel: nil, signedByRed: true).keys == [UPDATE_PUBLIC_KEY])
// G Squad builds (signed with the G Squad certificate) and friends' own builds: exactly as before.
check("gsquad-build-unchanged", UpdateRoute.resolve(profile: squadFile, channel: nil, signedByRed: false) == UpdateRoute.gsquad
      && UpdateRoute.gsquad.keys == [UPDATE_PUBLIC_KEY, UPDATE_GSQUAD_PUBLIC_KEY].filter { !$0.isEmpty }
      && UpdateRoute.gsquad.requirement.contains(PS_CERT_ROOT_GSQUAD) && UpdateRoute.gsquad.requirement.contains(PS_CERT_ROOT_RED))
check("no-files-unsigned-unchanged", UpdateRoute.resolve(profile: nil, channel: nil, signedByRed: false) == UpdateRoute.gsquad)
check("bad-channel-file-unsigned-is-gsquad", UpdateRoute.resolve(profile: nil, channel: Data("{".utf8), signedByRed: false) == UpdateRoute.gsquad)
check("this-test-is-not-red-signed", !UpdateRoute.selfSignedByRed)

// 4. The note: signed by any one of the channel's keys, with who made it and its channel.
func hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
let red = Curve25519.Signing.PrivateKey(), squad = Curve25519.Signing.PrivateKey(), other = Curve25519.Signing.PrivateKey()
let bytes = Data("web".utf8)
func payload(_ extra: [String: Any]) -> Data {
  var p: [String: Any] = ["format": 1, "kind": "web", "made": "2026-11-13T04:27:40Z", "name": "V1.59", "keyword": "Harmony",
    "web": ["src": "abcdef0123456789", "built": "2026-11-13T04:24:27.274Z", "file": "updates/PS-web-1.zip", "size": bytes.count, "sha256": hex(bytes)]]
  for (k, v) in extra { p[k] = v }
  return try! JSONSerialization.data(withJSONObject: p)
}
func note(_ body: Data, _ k: Curve25519.Signing.PrivateKey) -> Data {
  try! JSONSerialization.data(withJSONObject: ["key": "ps-update-1", "signed": body.base64EncodedString(), "sig": try! k.signature(for: body).base64EncodedString()])
}
let pk = { (k: Curve25519.Signing.PrivateKey) in k.publicKey.rawRepresentation.base64EncodedString() }
let both = [pk(red), pk(squad)]
let squadNote = payload(["by": "gsquad", "shared": true, "channel": "gsquad"])
check("red-signed-opens-on-both", (try? UpdateManifest.open(note(squadNote, red), publicKeys: both)) != nil)
check("squad-signed-opens-on-both", (try? UpdateManifest.open(note(squadNote, squad), publicKeys: both)) != nil)
check("squad-signed-refused-on-red-only", (try? UpdateManifest.open(note(squadNote, squad), publicKeys: [pk(red)])) == nil)
check("other-key-refused", (try? UpdateManifest.open(note(squadNote, other), publicKeys: both)) == nil)
check("single-key-open-unchanged", (try? UpdateManifest.open(note(squadNote, red), publicKey: pk(red))) != nil)
let m = try! UpdateManifest.open(note(squadNote, red), publicKeys: both)
check("by-read", m.by == "gsquad" && m.shared == true && m.channel == "gsquad")
check("name-says-by", m.name == "V1.59 by the G Squad · Harmony", m.name ?? "nil")
let janNote = try! UpdateManifest.open(note(payload(["by": "jan", "shared": false, "channel": "jan",
  "history": [["version": "1.58", "keyword": "Mid", "notes": ["One."], "by": "mary-jane"], ["version": "1.57", "keyword": "Old", "notes": ["Two."]]]]), red), publicKeys: [pk(red)])
check("jan-title", janNote.name == "V1.59 by Jan · Harmony" && janNote.shared == false, janNote.name ?? "nil")
check("history-by", janNote.history.map { $0.title } == ["V1.58 by Mary-Jane · Mid", "V1.57 · Old"], janNote.history.map { $0.title }.joined(separator: " | "))
let old = try! UpdateManifest.open(note(payload([:]), red), publicKeys: [pk(red)])
check("old-note-as-before", old.by == nil && old.shared == nil && old.channel == nil && old.name == "V1.59 · Harmony")
check("weird-by-ignored", (try! UpdateManifest.open(note(payload(["by": "<b>Jan</b>"]), red), publicKeys: [pk(red)])).by == nil)
check("weird-channel-refused", (try? UpdateManifest.open(note(payload(["channel": 7]), red), publicKeys: [pk(red)])) == nil)
check("show-plain", PSVersion.show("1.57", "Momentum") == "V1.57 · Momentum" && PSVersion.show("V1.57", nil) == "V1.57")
// V1.69: on the developer's own channel a G Squad note never opens, even a correctly signed one, and a note for his channel does.
let ownNote = note(payload(["by": "red", "shared": true, "channel": "red"]), red)
check("own-note-opens-with-red-key", (try? UpdateManifest.open(ownNote, publicKeys: [pk(red)])).map { own.takes($0.channel) } == true)
check("squad-note-refused-on-own", (try? UpdateManifest.open(note(squadNote, squad), publicKeys: [pk(red)])) == nil)
check("red-signed-squad-note-not-taken-on-own", (try? UpdateManifest.open(note(squadNote, red), publicKeys: [pk(red)])).map { own.takes($0.channel) } == false)

print(fails == 0 ? "update-route: all ok" : "update-route: \(fails) FAILED")
exit(fails == 0 ? 0 : 1)
