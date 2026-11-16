package com.cincee.ps.gos

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.UUID

/**
 * The phone's key for remote restart, shut down and lock of the developer's Macs (Second Computer protocol
 * section 13, role "phone"). A P-256 signing key in the Keystore (StrongBox when there is one) that
 * needs the FINGERPRINT for every single signature (no time window, no PIN), and is destroyed when a
 * new fingerprint is enrolled. So a command from this phone is only ever signed after the developer's finger,
 * whatever the page asks. The Macs check the signature against the key the developer trusted on each Mac.
 *
 * It only signs a `cmd` body (restart, shutdown, lock, cancel) from this phone, good for at most
 * 2 minutes and dated now. Anything else is refused before the fingerprint prompt.
 */
object CmdKey {
    private const val ALIAS = "ps_gos_cmd"
    val ACTIONS = setOf("restart", "shutdown", "lock", "cancel")
    // Every Keystore call here goes through Keys.gate: one at a time, never on the main thread.
    private fun ks() = Keys.ks()

    private fun make() {
        fun spec(strong: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)   // every signature, fingerprint only
            .setInvalidatedByBiometricEnrollment(true)
            .setIsStrongBoxBacked(strong)
            .build()
        val g = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        try { g.initialize(spec(true)); g.generateKeyPair() } catch (_: StrongBoxUnavailableException) { g.initialize(spec(false)); g.generateKeyPair() }
    }

    /** This phone's device id (made once) and public key, x963 (0x04 || X || Y), base64. */
    fun info(c: Context): JSONObject {
        val pub = Keys.gate.run("cmd key") {
            val ks = ks()
            if (!ks.containsAlias(ALIAS)) make()
            ks.getCertificate(ALIAS).publicKey as ECPublicKey
        }
        return JSONObject().put("device", device(c)).put("pub", java.util.Base64.getEncoder().encodeToString(x963(pub)))
    }

    fun device(c: Context): String =
        Keys.read(c, "cmd-device") ?: UUID.randomUUID().toString().lowercase().also { Keys.write(c, "cmd-device", it) }

    /** Why this body must not be signed, or null when it is a proper command from `device` dated `now`. */
    fun check(body: String, device: String, now: Long): String? {
        val b = runCatching { JSONObject(body) }.getOrNull() ?: return "Not a command"
        val keys = b.keys().asSequence().toSet()
        if (keys != setOf("v", "t", "id", "from", "to", "at", "exp", "action")) return "Not a command"
        if (b.optInt("v") != 1 || b.optString("t") != "cmd" || b.optString("action") !in ACTIONS) return "Not a command"
        if (b.optString("from") != device) return "Not from this phone"
        val id = b.optString("id"); val to = b.optString("to")
        if (id.isEmpty() || id.length > 64 || to.isEmpty() || to.length > 64 || to == "all") return "Bad command"
        val at = b.optLong("at"); val exp = b.optLong("exp")
        if (kotlin.math.abs(at - now) > 60_000 || exp <= at || exp - at > 120_000) return "Bad time"
        return null
    }

    /** A Signature ready for the fingerprint prompt, or a plain reason it will not sign this body. */
    fun prepare(c: Context, body: String, now: Long = System.currentTimeMillis()): Pair<Signature?, String?> {
        check(body, device(c), now)?.let { return null to it }
        return Keys.gate.run("cmd prepare") {
            val key = runCatching { ks().getKey(ALIAS, null) as PrivateKey? }.getOrNull()
            if (key == null) null to "No key"
            else try {
                Signature.getInstance("SHA256withECDSA").apply { initSign(key) } to null
            } catch (e: android.security.keystore.KeyPermanentlyInvalidatedException) {
                // A new fingerprint was enrolled: the key is gone on purpose. The Macs must trust a new one.
                runCatching { ks().deleteEntry(ALIAS) }
                null to "New fingerprint on this phone: trust the phone again on each Mac"
            } catch (e: Exception) { null to "Key error (${e.javaClass.simpleName})" }
        }
    }

    /** After the fingerprint: the raw r || s signature (64 bytes) base64, the same format the Macs use. */
    fun finish(sig: Signature, body: String): String = java.util.Base64.getEncoder().encodeToString(Keys.gate.run("cmd sign") { signRaw(sig, body) })
    /** Signs the UTF-8 bytes of the body exactly as sent; raw r || s (64 bytes). */
    fun signRaw(sig: Signature, body: String): ByteArray { sig.update(body.toByteArray(Charsets.UTF_8)); return derToRaw(sig.sign()) }

    private fun fixed32(n: BigInteger): ByteArray {
        val b = n.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
        require(b.size <= 32)
        return ByteArray(32 - b.size) + b
    }
    fun x963(k: ECPublicKey): ByteArray = byteArrayOf(4) + fixed32(k.w.affineX) + fixed32(k.w.affineY)

    /** ECDSA DER (SEQUENCE { INTEGER r, INTEGER s }) to raw r || s. */
    fun derToRaw(der: ByteArray): ByteArray {
        var i = 0
        fun len(): Int { var l = der[i++].toInt() and 0xff; if (l and 0x80 != 0) { val n = l and 0x7f; l = 0; repeat(n) { l = (l shl 8) or (der[i++].toInt() and 0xff) } }; return l }
        require(der[i++] == 0x30.toByte()); len()
        require(der[i++] == 0x02.toByte()); val rl = len(); val r = BigInteger(1, der.copyOfRange(i, i + rl)); i += rl
        require(der[i++] == 0x02.toByte()); val sl = len(); val s = BigInteger(1, der.copyOfRange(i, i + sl))
        return fixed32(r) + fixed32(s)
    }
}
