package com.cincee.ps.gos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/**
 * The phone's remote restart signing, off the phone (plain JVM keys instead of the Keystore; the
 * format code is the same). Writes app/build/cmd-vector.json, which ps-mac's
 * tests/phone-cmd-vector-test.sh verifies with CryptoKit exactly as the Macs do.
 */
class CmdKeyTest {
    private val dev = "11111111-2222-4333-8444-555555555555"
    private val now = 1_793_448_000_000L
    private fun body(vararg kv: Pair<String, Any>): String {
        val m = linkedMapOf<String, Any>("v" to 1, "t" to "cmd", "id" to "c0ffee00-0000-4000-8000-000000000001", "from" to dev,
            "to" to "m4-device", "at" to now, "exp" to now + 120_000, "action" to "restart")
        kv.forEach { (k, v) -> if (v == Unit) m.remove(k) else m[k] = v }
        return org.json.JSONObject(m as Map<*, *>).toString()
    }

    @Test fun acceptsAProperCommand() {
        for (a in listOf("restart", "shutdown", "lock", "cancel")) assertNull(CmdKey.check(body("action" to a), dev, now))
    }

    @Test fun refusesAnythingElse() {
        assertEquals("Not a command", CmdKey.check("not json", dev, now))
        assertEquals("Not a command", CmdKey.check(body("action" to "wipe"), dev, now))
        assertEquals("Not a command", CmdKey.check(body("t" to "job"), dev, now))
        assertEquals("Not a command", CmdKey.check(body("extra" to "x"), dev, now))
        assertEquals("Not a command", CmdKey.check(body("exp" to Unit), dev, now))
        assertEquals("Not a command", CmdKey.check(body("v" to 2), dev, now))
        assertEquals("Not from this phone", CmdKey.check(body("from" to "someone-else"), dev, now))
        assertEquals("Bad command", CmdKey.check(body("to" to "all"), dev, now))
        assertEquals("Bad command", CmdKey.check(body("id" to ""), dev, now))
        assertEquals("Bad time", CmdKey.check(body("at" to now - 61_000, "exp" to now + 59_000), dev, now))   // old
        assertEquals("Bad time", CmdKey.check(body("at" to now + 61_000, "exp" to now + 181_000), dev, now))  // future
        assertEquals("Bad time", CmdKey.check(body("exp" to now + 120_001), dev, now))                        // too long
        assertEquals("Bad time", CmdKey.check(body("exp" to now), dev, now))                                  // no window
    }

    @Test fun derToRawPadsAndStrips() {
        // r with a leading 0x00 (high bit set) and a short s.
        val r = ByteArray(32) { 0x80.toByte() }; val s = byteArrayOf(1, 2, 3)
        val der = byteArrayOf(0x30, (2 + 33 + 2 + 3).toByte(), 0x02, 33, 0) + r + byteArrayOf(0x02, 3) + s
        val raw = CmdKey.derToRaw(der)
        assertEquals(64, raw.size)
        assertTrue(raw.copyOfRange(0, 32).contentEquals(r))
        assertTrue(raw.copyOfRange(32, 64).contentEquals(ByteArray(29) + s))
    }

    @Test fun writesAVectorTheMacsVerify() {
        val g = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }
        val out = StringBuilder("[")
        repeat(20) { i ->
            val kp = g.generateKeyPair()
            val b = body("id" to "c0ffee00-0000-4000-8000-%012d".format(i), "action" to listOf("restart", "shutdown", "lock", "cancel")[i % 4])
            assertNull(CmdKey.check(b, dev, now))
            val raw = CmdKey.signRaw(Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private) }, b)
            val pub = CmdKey.x963(kp.public as ECPublicKey)
            assertEquals(65, pub.size); assertEquals(4.toByte(), pub[0])
            val e = Base64.getEncoder()
            if (i > 0) out.append(',')
            out.append(org.json.JSONObject().put("pub", e.encodeToString(pub)).put("body", b).put("sig", e.encodeToString(raw)).put("by", dev).toString())
        }
        File("build").mkdirs(); File("build/cmd-vector.json").writeText(out.append("]").toString())
    }
}
