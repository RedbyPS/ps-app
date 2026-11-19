// Offline test for where PS asks for updates (V1.57, the developer, 13 Nov 2026: "Remove the IP address part so I can't see
// their IP address when [PS] asks Cincee for updates"). The channel is the public PS repo's newest GitHub release,
// never cincee.com, and moving it changed nothing about the checks: a note must still carry the developer's signature, and a
// changed or wrongly signed note is refused wherever it came from. Throwaway keys made here, nothing online.
// Run: bash tests/update-channel-test.sh
import CryptoKit
import Foundation

var fails = 0
func check(_ name: String, _ ok: Bool, _ info: String = "") { print("\(name)=\(ok ? "ok" : "FAIL")\(info.isEmpty ? "" : " (\(info))")"); if !ok { fails += 1 } }

// 1. The address.
let gh = URL(string: UPDATE_CHANNEL)!
check("channel-is-github", gh.scheme == "https" && gh.host == "github.com" && gh.path == "/RedbyPS/ps/releases/latest/download", gh.absoluteString)
check("channel-is-not-cincee", !UPDATE_CHANNEL.contains("cincee"))

// 2. A GitHub release holds its files side by side: the note's "updates/" folder is not asked for there.
check("app-file-on-github", UpdateChannel.remote("updates/PS-app-2611130427.zip", base: gh).absoluteString
      == "https://github.com/RedbyPS/ps/releases/latest/download/PS-app-2611130427.zip")
check("web-file-on-github", UpdateChannel.remote("updates/PS-web-20261113042427274.zip", base: gh).absoluteString
      == "https://github.com/RedbyPS/ps/releases/latest/download/PS-web-20261113042427274.zip")
let folder = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("ps-channel-\(UUID().uuidString)", isDirectory: true)
check("test-folder-keeps-updates", UpdateChannel.remote("updates/PS-app-1.zip", base: folder).path == folder.appendingPathComponent("updates/PS-app-1.zip").path)
// V1.69: a person's own channel on their own web server keeps the updates/ folder publish.sh made.
let ownBase = URL(string: "https://example.invalid/ps/own-0000/")!
check("own-channel-keeps-updates", UpdateChannel.remote("updates/PS-app-1.zip", base: ownBase).absoluteString == "https://example.invalid/ps/own-0000/updates/PS-app-1.zip")
// V1.69 hotfix: a web page answer (a site's page fallback for a file that is not live yet) is never an update file.
check("web-page-is-not-a-note", UpdateChannel.isWebPage("text/html; charset=UTF-8") && UpdateChannel.isWebPage("TEXT/HTML"))
check("json-and-zip-are-files", !UpdateChannel.isWebPage("application/json") && !UpdateChannel.isWebPage("application/zip")
      && !UpdateChannel.isWebPage(nil) && !UpdateChannel.isWebPage("text/plain"))

// 3. The signature check is the same as before: only the developer's key opens a note.
func hex(_ d: Data) -> String { SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined() }
let red = Curve25519.Signing.PrivateKey(), other = Curve25519.Signing.PrivateKey()
let bytes = Data("app".utf8)
let payload: [String: Any] = ["format": 1, "kind": "app", "made": "2026-11-13T04:27:40Z", "name": "V1.57", "keyword": "Test",
  "app": ["build": 2611130427, "file": "updates/PS-app-2611130427.zip", "size": bytes.count, "sha256": hex(bytes)],
  "web": ["src": "abcdef0123456789", "built": "2026-11-13T04:24:27.274Z", "file": "updates/PS-web-20261113042427274.zip", "size": bytes.count, "sha256": hex(bytes)]]
let signed = try! JSONSerialization.data(withJSONObject: payload)
func note(_ body: Data, _ k: Curve25519.Signing.PrivateKey) -> Data {
  try! JSONSerialization.data(withJSONObject: ["key": "ps-update-1", "signed": body.base64EncodedString(), "sig": try! k.signature(for: body).base64EncodedString()])
}
let redPub = red.publicKey.rawRepresentation.base64EncodedString()
check("red-signed-opens", (try? UpdateManifest.open(note(signed, red), publicKey: redPub))?.app?.build == 2611130427)
check("other-key-refused", (try? UpdateManifest.open(note(signed, other), publicKey: redPub)) == nil)
var changed = payload; changed["app"] = ["build": 2611130427, "file": "updates/PS-app-2611130427.zip", "size": bytes.count, "sha256": hex(Data("evil".utf8))]
let changedBody = try! JSONSerialization.data(withJSONObject: changed)
let swapped = try! JSONSerialization.data(withJSONObject: ["signed": changedBody.base64EncodedString(), "sig": try! red.signature(for: signed).base64EncodedString()])
check("changed-note-refused", (try? UpdateManifest.open(swapped, publicKey: redPub)) == nil)
check("unsigned-refused", (try? UpdateManifest.open(try! JSONSerialization.data(withJSONObject: ["signed": signed.base64EncodedString()]), publicKey: redPub)) == nil)
check("real-key-built-in", UPDATE_PUBLIC_KEY == "Pc6Z49PnFmrf7frRS7d+W2RzpI/bR756v10J8b44/eU=")

print(fails == 0 ? "ALL OK" : "\(fails) FAILED")
exit(fails == 0 ? 0 : 1)
