package com.cincee.ps.gos

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** PS 1.72: after an update every PS notification still showing is posted again by the new build (RepostCore.kt). */
class RepostCoreTest {
    private fun live(id: Int, tag: String? = null, fg: Boolean = false, fs: Boolean = false) = RepostCore.Live(id, tag, fg, fs)

    @Test fun plainOnesArePostedAgain() {
        val l = listOf(live(1, "mail"), live(2), live(3, "card"))
        assertEquals(l, RepostCore.pick(l, emptySet()))
    }

    @Test fun foregroundRingingAndJustPostedOnesAreLeft() {
        val l = listOf(live(1, "mail"), live(9, fg = true), live(4, "ring", fs = true), live(8, "updated"), live(5, "updated2"))
        assertEquals(listOf(live(1, "mail"), live(5, "updated2")), RepostCore.pick(l, setOf("updated")))
    }

    @Test fun eachIdAndTagOnce() {
        assertEquals(listOf(live(1, "a"), live(1, "b"), live(1)), RepostCore.pick(listOf(live(1, "a"), live(1, "a"), live(1, "b"), live(1), live(1)), emptySet()))
    }

    @Test fun spacedOut() {
        assertEquals(listOf(300L, 600L, 900L), (0..2).map { RepostCore.delay(it) })
        assertTrue(RepostCore.GAP_MS >= 250)   // under five a second
    }

    private fun src(f: String) = File("src/main/$f").readText()

    @Test fun wiredOnUpdate() {
        val boot = src("java/com/cincee/ps/gos/Receivers.kt")
        assertTrue(boot.contains("Notifier.repostAfterUpdate(app)"))
        assertTrue(boot.contains("TileService.requestListeningState(c, ComponentName(c, PsTileService::class.java))"))
        assertTrue(boot.contains("if (Prefs.widget(c)) PsWidget.render(c)"))
        val n = src("java/com/cincee/ps/gos/Notifier.kt")
        assertTrue("posted again silently, with this build's icon", n.contains(".setSmallIcon(R.drawable.ic_stat_ps).setOnlyAlertOnce(true)"))
        assertTrue(src("java/com/cincee/ps/gos/PsTileService.kt").contains("icon = Icon.createWithResource(this@PsTileService, R.drawable.ic_ps_tile)"))
    }

    @Test fun theLauncherIconHasItsOwnNames() {
        val m = src("AndroidManifest.xml")
        assertTrue(m.contains("android:icon=\"@mipmap/ic_cake\"") && m.contains("android:roundIcon=\"@mipmap/ic_cake\""))
        assertTrue(src("res/values/themes.xml").contains("@mipmap/ic_cake_front"))
        val a = src("res/mipmap-anydpi/ic_cake.xml")
        assertTrue(a.contains("@color/ic_cake_back") && a.contains("@mipmap/ic_cake_front") && a.contains("@mipmap/ic_cake_mono"))
        for (d in listOf("mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi")) for (k in listOf("front", "mono"))
            assertTrue("$d $k", File("src/main/res/mipmap-$d/ic_cake_$k.png").isFile)
        assertTrue("the old layers are gone", File("src/main/res").walkTopDown().none { it.name.startsWith("ic_launcher") })
    }
}
