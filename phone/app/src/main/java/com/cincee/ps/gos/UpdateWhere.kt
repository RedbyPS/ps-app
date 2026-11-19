package com.cincee.ps.gos

/**
 * Where the phone asks for updates (V1.57, the developer, 13 Nov 2026: "Remove the IP address part so I can't see their IP
 * address when [PS] asks Cincee for updates"). The public PS repo's newest GitHub release holds the note
 * (gos-version.json) and the APK side by side; GitHub sends each request on to its file host. No fallback to
 * cincee.com. Where the files come from changes nothing about the checks: the APK must still match the note's
 * SHA-256 and be signed with PS's own pinned certificate (Updater.verifySigner). Unit tested in UpdateWhereTest.
 */
/**
 * Which update channel this build follows (V1.58, multiple developers): from the build's own profile
 * (assets/profile.json, put there by the build from the G Squad profile or the person's layer), nothing else.
 *   {"name": "gsquad", "channel": {"kind": "gsquad"}}                  the G Squad channel (BuildConfig.UPDATE_BASE)
 *   {"name": "jan", "channel": {"kind": "url", "url": "https://.../"}}   that person's own channel
 *   {"name": "jan", "channel": {"kind": "local"}}                        no channel (they install their own builds)
 * No profile (every build before V1.58) or anything not understood: the G Squad channel, today's, so nothing changes.
 * V1.71: a private build made the old way gets its maker's whole layer profile (Gradle -PpsProfile, ps-gos release.sh
 * from web ps-layer/profile.json), so it asks the same unlisted folder as that person's Macs, never GitHub.
 * Every note says which channel it is for ("channel"); a note for another channel is refused. Notes from before V1.58
 * say nothing and are taken as before. The APK must still be signed with this app's own key (Updater.verifySigner).
 */
data class UpdateRoute(val kind: String, val id: String, val base: String?) {
    /** May a note made for `channel` be taken here? No channel (a note from before V1.58): yes. */
    fun takes(channel: String?): Boolean = channel == null || channel == id
}

object UpdateWhere {
    private val NAME = Regex("^[a-z][a-z0-9-]{0,30}$")
    val GSQUAD = UpdateRoute("gsquad", "gsquad", null)

    /** The route a profile gives (null: no profile). */
    fun route(profile: String?): UpdateRoute {
        val o = try { org.json.JSONObject(profile ?: return GSQUAD) } catch (e: Exception) { return GSQUAD }
        val ch = o.optJSONObject("channel") ?: return GSQUAD
        val name = o.optString("name")
        when (ch.optString("kind")) {
            "url" -> {
                if (!NAME.matches(name) || name == "gsquad") return GSQUAD
                val u = ch.optString("url")
                return if (u.startsWith("https://") && u.length > 9 && u.endsWith("/") && !u.substring(8).startsWith("/")) UpdateRoute("url", name, u) else GSQUAD
            }
            "local" -> return if (NAME.matches(name) && name != "gsquad") UpdateRoute("local", name, null) else GSQUAD
            else -> return GSQUAD
        }
    }

    /** The note's channel as written, or null when it names none. A channel that is not a plain name is "?", which no
     *  build takes (never read as "no channel"). */
    fun noteChannel(note: org.json.JSONObject): String? {
        if (!note.has("channel")) return null
        val c = note.opt("channel")
        return if (c is String && NAME.matches(c)) c else "?"
    }

    /** "by Jan", "by the G Squad"; null for a release from before V1.58 or anything that is not a profile name. */
    fun byLine(by: String?): String? {
        if (by == null || !NAME.matches(by)) return null
        if (by == "gsquad") return "by the G Squad"
        return "by " + by.split("-").joinToString("-") { it.replaceFirstChar { c -> c.uppercaseChar() } }
    }

    private val APK = Regex("^[A-Za-z0-9._-]+\\.apk$")
    fun base(b: String = BuildConfig.UPDATE_BASE) = b.trimEnd('/') + "/"
    fun note(b: String = BuildConfig.UPDATE_BASE, name: String = BuildConfig.UPDATE_NOTE) = base(b) + name
    /** The APK the note names, or null for a name that is not a plain file name (no folders, no other host). */
    fun apk(name: String, b: String = BuildConfig.UPDATE_BASE): String? = if (APK.matches(name) && !name.startsWith(".")) base(b) + name else null
}
