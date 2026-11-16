// The phone's signatures (ps-gos CmdKey.kt, written by its CmdKeyTest into tests/fixtures/phone-cmd-vector.json)
// checked the way the Macs check them (Second Computer: P-256, x963 public key, raw r || s over SHA-256 of the
// body's UTF-8 bytes). Also: one changed byte in the body, the signature or the key must fail.
import CryptoKit
import Foundation

func verify(_ pub: String, _ body: String, _ sig: String) -> Bool {
  guard let kd = Data(base64Encoded: pub), let k = try? P256.Signing.PublicKey(x963Representation: kd),
        let sd = Data(base64Encoded: sig), let s = try? P256.Signing.ECDSASignature(rawRepresentation: sd) else { return false }
  return k.isValidSignature(s, for: Data(body.utf8))
}
let path = CommandLine.arguments[1]
let list = try! JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [[String: String]]
var good = 0, tamperCaught = 0
for v in list {
  if verify(v["pub"]!, v["body"]!, v["sig"]!) { good += 1 }
  let badBody = v["body"]!.replacingOccurrences(of: "\"restart\"", with: "\"shutdown\"").replacingOccurrences(of: "\"lock\"", with: "\"restart\"")
  var sig = Data(base64Encoded: v["sig"]!)!; sig[10] ^= 1
  let other = list.first { $0["pub"] != v["pub"] }!["pub"]!
  if !verify(v["pub"]!, badBody + (badBody == v["body"]! ? " " : ""), v["sig"]!) && !verify(v["pub"]!, v["body"]!, sig.base64EncodedString()) && !verify(other, v["body"]!, v["sig"]!) { tamperCaught += 1 }
}
let ok = good == list.count && tamperCaught == list.count && list.count >= 20
print(ok ? "PHONE VECTOR: \(good) of \(list.count) phone signatures verify on the Mac, every changed body, signature or key refused" : "PHONE VECTOR: FAIL good=\(good) tamper=\(tamperCaught) of \(list.count)")
exit(ok ? 0 : 1)
