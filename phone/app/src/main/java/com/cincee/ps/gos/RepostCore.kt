package com.cincee.ps.gos

/**
 * PS 1.72 (the developer, 21 Nov 2026: "make sure it actually updates completely this time": after an update the old app icon
 * stayed on PS's notifications for a while). A notification keeps what the build that posted it gave it, its icon by
 * the old APK's resource number, so right after an update the new build posts each PS notification still showing again
 * (Notifier.repostAfterUpdate). These are the rules, pure, for RepostCoreTest.
 */
object RepostCore {
    /** One PS notification still showing: its id and tag, whether a foreground service shows it, whether it rings full screen. */
    data class Live(val id: Int, val tag: String?, val foreground: Boolean, val fullScreen: Boolean)

    /** Android drops a burst of updates from one app (about five a second), so they go one at a time. */
    const val GAP_MS = 300L

    /** Which to post again: not one a foreground service shows (the service posts it again itself as it restarts, from
     *  the new build), not a ringing one (its own restore brings it back; posting it again must never ring again), not
     *  the ones this update just posted itself (`skipTags`), and each id and tag once. */
    fun pick(live: List<Live>, skipTags: Set<String>): List<Live> =
        live.filter { !it.foreground && !it.fullScreen && (it.tag == null || it.tag !in skipTags) }.distinctBy { it.tag to it.id }

    /** When the i-th (from 0) goes out, after the update. */
    fun delay(i: Int): Long = GAP_MS * (i + 1)
}
