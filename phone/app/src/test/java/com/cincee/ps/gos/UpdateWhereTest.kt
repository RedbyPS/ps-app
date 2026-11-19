package com.cincee.ps.gos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.json.JSONObject
import org.junit.Test

/** V1.57: the phone asks the public PS repo's GitHub release for updates, never cincee.com. */
class UpdateWhereTest {
    private val gh = "https://github.com/RedbyPS/ps/releases/latest/download/"

    @Test fun theReleaseBuildAsksGitHub() {
        assertEquals(gh, UpdateWhere.base())
        assertEquals(gh + "gos-version.json", UpdateWhere.note())
        assertFalse(BuildConfig.UPDATE_BASE.contains("cincee"))
    }

    @Test fun theApkIsBesideTheNote() {
        assertEquals(gh + "ps-gos-1.57.apk", UpdateWhere.apk("ps-gos-1.57.apk"))
        assertEquals(gh + "ps-gos-1.57-b62.apk", UpdateWhere.apk("ps-gos-1.57-b62.apk"))
    }

    @Test fun oddNamesAreRefused() {
        assertNull(UpdateWhere.apk("../ps-gos.apk"))
        assertNull(UpdateWhere.apk("https://cincee.com/client/gos/ps-gos-1.57.apk"))
        assertNull(UpdateWhere.apk("sub/ps-gos.apk"))
        assertNull(UpdateWhere.apk("ps-gos.zip"))
        assertNull(UpdateWhere.apk(".apk"))
        assertNull(UpdateWhere.apk(""))
    }

    @Test fun aTestServerKeepsItsOwnPlace() {
        assertEquals("https://10.0.2.2:8443/gos/gos-version.json", UpdateWhere.note("https://10.0.2.2:8443/gos", "gos-version.json"))
    }

    // V1.58: the channel comes from the build's own profile; no profile is today's channel.
    @Test fun noProfileIsTheGSquadChannel() {
        assertEquals(UpdateWhere.GSQUAD, UpdateWhere.route(null))
        assertEquals(UpdateWhere.GSQUAD, UpdateWhere.route("not json"))
        assertEquals(UpdateWhere.GSQUAD, UpdateWhere.route("""{"name":"gsquad","channel":{"kind":"gsquad"}}"""))
        assertEquals(UpdateWhere.GSQUAD, UpdateWhere.route("""{"name":"jan"}"""))
        assertEquals(UpdateWhere.GSQUAD, UpdateWhere.route("""{"name":"jan","channel":{"kind":"ftp"}}"""))
        assertNull(UpdateWhere.GSQUAD.base)   // BuildConfig.UPDATE_BASE, exactly as in V1.57
    }

    @Test fun aPersonsOwnChannel() {
        val jan = UpdateWhere.route("""{"name":"jan","channel":{"kind":"url","url":"https://example.invalid/jan/gos/"}}""")
        assertEquals(UpdateRoute("url", "jan", "https://example.invalid/jan/gos/"), jan)
        assertEquals("https://example.invalid/jan/gos/gos-version.json", UpdateWhere.note(jan.base!!, "gos-version.json"))
        assertEquals("https://example.invalid/jan/gos/ps-gos-1.59.apk", UpdateWhere.apk("ps-gos-1.59.apk", jan.base!!))
        assertEquals(UpdateRoute("local", "mia", null), UpdateWhere.route("""{"name":"mia","channel":{"kind":"local"}}"""))
    }

    // V1.71: the private build carries its maker's whole layer profile (web ps-layer/profile.json, unchanged),
    // so the phone asks the same unlisted folder as that person's Macs. Fictional folder here.
    private val own = "https://example.invalid/client/ps/own-0123456789abcdef/"
    private val layer = """{
      "schema": 1, "name": "red", "display": "Me",
      "channel": { "kind": "url", "url": "$own" },
      "othersShared": "on",
      "features": { "client-emails": true, "whatsapp": false, "remote-screen": true },
      "rules": { "tabOverProtectedApps": false, "islandOverProtectedApps": false }
    }"""

    @Test fun aWholeLayerProfileAsksItsOwnFolder() {
        val r = UpdateWhere.route(layer)
        assertEquals(UpdateRoute("url", "red", own), r)
        assertEquals(own + "gos-version.json", UpdateWhere.note(r.base!!, "gos-version.json"))
        // the APK sits beside the note, in the same folder as the Mac's ps-update.json
        assertEquals(own + "ps-gos-1.71.apk", UpdateWhere.apk("ps-gos-1.71.apk", r.base!!))
        assertNull(UpdateWhere.apk("../gos/ps-gos-1.71.apk", r.base!!))
        // the same file is a whole profile for the rest of the app too (Profile.kt)
        val p = Profile.from(layer)!!
        assertEquals("red", p.name)
        assertEquals(Profile.Channel.Url(own), p.channel)
    }

    @Test fun theOwnFolderTakesOnlyItsOwnNotes() {
        val r = UpdateWhere.route(layer)
        assertTrue(r.takes(UpdateWhere.noteChannel(JSONObject("""{"versionCode":76,"channel":"red"}"""))))
        assertTrue(r.takes(UpdateWhere.noteChannel(JSONObject("""{"versionCode":76}"""))))
        // a G Squad note never moves this build (its APK is signed with another key anyway)
        assertFalse(r.takes(UpdateWhere.noteChannel(JSONObject("""{"versionCode":76,"channel":"gsquad"}"""))))
        assertFalse(r.takes(UpdateWhere.noteChannel(JSONObject("""{"versionCode":76,"channel":"jan"}"""))))
    }

    @Test fun withoutTheProfileItWouldBeGitHub() {
        // What the V1.68 to V1.70 private APKs did: no assets/profile.json, so the G Squad channel on GitHub.
        assertEquals(UpdateWhere.GSQUAD, UpdateWhere.route(null))
        assertEquals(gh + "gos-version.json", UpdateWhere.note(UpdateWhere.GSQUAD.base ?: BuildConfig.UPDATE_BASE))
    }

    @Test fun aBadPrivateChannelIsNotUsed() {
        for (p in listOf("""{"name":"jan","channel":{"kind":"url","url":"http://example.invalid/gos/"}}""",
                         """{"name":"jan","channel":{"kind":"url","url":"https://example.invalid/gos"}}""",
                         """{"name":"jan","channel":{"kind":"url","url":"https:///gos/"}}""",
                         """{"name":"Jan Smith","channel":{"kind":"url","url":"https://example.invalid/gos/"}}""",
                         """{"name":"gsquad","channel":{"kind":"url","url":"https://example.invalid/gos/"}}""")) assertEquals(p, UpdateWhere.GSQUAD, UpdateWhere.route(p))
    }

    @Test fun onlyNotesForThisChannel() {
        val jan = UpdateRoute("url", "jan", "https://example.invalid/jan/gos/")
        val old = JSONObject("""{"versionCode":62}""")
        assertNull(UpdateWhere.noteChannel(old))
        assertTrue(UpdateWhere.GSQUAD.takes(UpdateWhere.noteChannel(old)))
        assertTrue(jan.takes(UpdateWhere.noteChannel(old)))
        val squad = JSONObject("""{"versionCode":63,"channel":"gsquad"}""")
        assertTrue(UpdateWhere.GSQUAD.takes(UpdateWhere.noteChannel(squad)))
        assertFalse(jan.takes(UpdateWhere.noteChannel(squad)))
        val janNote = JSONObject("""{"versionCode":64,"channel":"jan"}""")
        assertFalse(UpdateWhere.GSQUAD.takes(UpdateWhere.noteChannel(janNote)))
        assertTrue(jan.takes(UpdateWhere.noteChannel(janNote)))
        assertFalse(UpdateWhere.GSQUAD.takes(UpdateWhere.noteChannel(JSONObject("""{"channel":7}"""))))
    }

    @Test fun whoMadeIt() {
        assertEquals("by Jan", UpdateWhere.byLine("jan"))
        assertEquals("by the G Squad", UpdateWhere.byLine("gsquad"))
        assertEquals("by Mary-Jane", UpdateWhere.byLine("mary-jane"))
        assertNull(UpdateWhere.byLine(null))
        assertNull(UpdateWhere.byLine(""))
        assertNull(UpdateWhere.byLine("<b>Jan</b>"))
    }
}
