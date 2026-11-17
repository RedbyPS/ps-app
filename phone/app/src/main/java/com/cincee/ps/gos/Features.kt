package com.cincee.ps.gos

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Is a feature on in this build? (V1.58, multiple developers; design: ps-handover-notes/v158-multidev-design.md section 3.)
 * The one question native code asks: Features.on(ctx, <the feature id, written out in quotes>).
 * The page works out every feature's answer (web core/features.ts) and hands it over as
 * {"<id>": true | false} (the bridge calls [receive]); that answer wins and is kept on this phone. Before the page has
 * said anything: made by core or this build's own person, its default; made by someone else, on only when the bundled
 * profile's othersShared is on (and the default is on) or the profile switches it on. No profile, or an id nobody
 * knows: off. The registry entries come with the page's answers, so the phone keeps no registry of its own.
 * Pure parts ([decide], [bundled], [clean], [registry]) are checked by FeaturesTest on the JVM.
 */
object Features {
    data class Entry(val id: String, val owner: String, val shared: Boolean, val defaultOn: Boolean)

    /** Registry entries from JSON (one file {schema, features}, a list of entries, or a list of files). A repeated id keeps the first. */
    fun registry(any: Any?): List<Entry> {
        val out = mutableListOf<Entry>(); val seen = mutableSetOf<String>()
        fun add(x: Any?) {
            when (x) {
                is JSONArray -> for (i in 0 until x.length()) add(x.opt(i))
                is JSONObject -> {
                    val list = x.optJSONArray("features")
                    if (list != null) { if (x.opt("schema") == 1) add(list); return }
                    val id = x.opt("id") as? String ?: return
                    val owner = x.opt("owner") as? String ?: return
                    val scope = x.opt("scope") as? String ?: return
                    val def = x.opt("default") as? String ?: return
                    if (!Profile.isFeatureId(id) || !Profile.isName(owner) || id in seen) return
                    if (scope != "shared" && scope != "private") return
                    if (def != "on" && def != "off") return
                    seen += id; out += Entry(id, owner, scope == "shared", def == "on")
                }
            }
        }
        add(any)
        return out
    }

    fun bundled(id: String, registry: List<Entry>, profile: Profile?): Boolean {
        val e = registry.firstOrNull { it.id == id } ?: return false
        if (e.owner == "core" || e.owner == profile?.name) return profile?.features?.get(id) ?: e.defaultOn
        if (!e.shared || profile == null) return false
        return profile.features[id] ?: (profile.othersShared && e.defaultOn)
    }

    fun decide(id: String, told: Map<String, Boolean>?, registry: List<Entry>, profile: Profile?): Boolean =
        told?.get(id) ?: bundled(id, registry, profile)

    /** The page's answers: only feature ids and real true or false, at most 200. */
    fun clean(o: JSONObject?): Map<String, Boolean>? {
        o ?: return null
        val m = linkedMapOf<String, Boolean>()
        for (k in o.keys()) { if (m.size >= 200) break; val v = o.opt(k); if (Profile.isFeatureId(k) && v is Boolean) m[k] = v }
        return m
    }

    private fun sp(c: Context) = c.getSharedPreferences("ps", Context.MODE_PRIVATE)
    private const val KEY = "features.on"

    fun told(c: Context): Map<String, Boolean>? {
        val s = sp(c).getString(KEY, null) ?: return null
        return try { clean(JSONObject(s)) } catch (e: Exception) { null }
    }

    /** Is this feature on here? */
    fun on(c: Context, id: String): Boolean = decide(id, told(c), emptyList(), Profile.load(c))

    /** From the page: the answers object. Kept only when it changed. */
    fun receive(c: Context, on: JSONObject?) {
        val v = clean(on) ?: return
        if (v == told(c)) return
        sp(c).edit().putString(KEY, JSONObject(v as Map<*, *>).toString()).apply()
    }
}
