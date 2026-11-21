package com.cincee.ps.gos

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.provider.Settings

/**
 * PS 1.72 (the developer, 21 Nov 2026: "when I do actually get the calls as well, it doesn't always actually go on my like lock
 * screen at first ... I've had to literally go ... onto the notification that is like ringing me and then somehow stop
 * it"). Every PS ring that rings like a call (the gym ring and the alarms in Gym.kt, the Annoying 15 min reminder ring in
 * RemRing.kt, the Sleep mode alarm in Sleep.kt) comes to the screen the same way, here:
 *
 *  1. The ring's own notification carries a full screen intent on a HIGH channel with CATEGORY_ALARM (as before). Android
 *     launches the ring card from it when the screen is off or the lock screen shows, but ONLY when the special access
 *     "Full screen notifications" (USE_FULL_SCREEN_INTENT, Android 14 and later) is on. With it off, or while the phone
 *     is unlocked and in use, Android shows only a heads up instead: that is what the developer had to dig into.
 *  2. So the ring card is ALSO started straight away, over other apps: Android lets an app that may draw over other apps
 *     ("Display over other apps", which the PS island already has) start its screen from the background. The card has
 *     showWhenLocked and turnScreenOn, so it comes up over the lock screen too. Where Android refuses the start anyway
 *     (Android 15 and later only allow it while one of the app's overlay windows shows, so while the island is up) the
 *     full screen intent above still covers the lock screen.
 *  3. The heads up is never a dead end: each ring's notification keeps its one tap stop buttons (Yes, I'm going / Later,
 *     the alarm's own button, Stop alarm, the reminder's snooze and its one tap confirm).
 *  4. With the full screen access off, PS tells the developer ONCE, with a notification (the words of the permission row in the
 *     phone's Settings, nothing new) that opens Android's page for it. Told again only after it was on and went off.
 *
 * The choices are pure (way, tellNow) and unit tested in src/test; nothing here plays a sound.
 */
object RingScreen {
    /** How a ring can reach the screen now. BOTH: started straight away and by the full screen intent. */
    enum class Way { BOTH, FULL_SCREEN, DIRECT, HEADS_UP }
    fun way(fullScreen: Boolean, overlay: Boolean): Way = when {
        fullScreen && overlay -> Way.BOTH
        fullScreen -> Way.FULL_SCREEN
        overlay -> Way.DIRECT
        else -> Way.HEADS_UP
    }
    /** Tell the developer about the full screen access now? Once while it is off; again only after it was on in between. */
    fun tellNow(fullScreen: Boolean, told: Boolean): Boolean = !fullScreen && !told
    /** Is the told flag still right? Cleared once the access is on again, so a later switch off is told again. */
    fun toldAfter(fullScreen: Boolean, told: Boolean): Boolean = if (fullScreen) false else told
    /** A ring channel below HIGH never shows full screen (the developer may have changed it in Android's settings). */
    fun channelOk(importance: Int?): Boolean = importance == null || importance >= NotificationManager.IMPORTANCE_HIGH

    // The words of the permission row in the phone's Settings (web src/gos/PhoneRows.tsx), reused as they are.
    internal const val TELL_TITLE = "Gym alarm on the lock screen"
    internal const val TELL_TEXT = "The gym ring and your alarms show their big card over the lock screen. Without it, they still ring, as a notification."
    private const val TELL_ID = 7201

    fun fullScreenOk(c: Context): Boolean = runCatching { c.getSystemService(NotificationManager::class.java).canUseFullScreenIntent() }.getOrDefault(true)
    fun overlayOk(c: Context): Boolean = runCatching { Settings.canDrawOverlays(c) }.getOrDefault(false)
    private fun sp(c: Context) = c.getSharedPreferences("ringscreen", Context.MODE_PRIVATE)

    /** A ring starts: its card on screen now, over other apps and the lock screen, by every way Android allows. */
    fun bring(c: Context, card: Class<*>, channel: String, who: String) {
        val fs = fullScreenOk(c)
        val way = way(fs, overlayOk(c))
        val nm = c.getSystemService(NotificationManager::class.java)
        val imp = runCatching { nm.getNotificationChannel(channel)?.importance }.getOrNull()
        if (way == Way.BOTH || way == Way.DIRECT) runCatching {
            c.startActivity(Intent(c, card).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION))
        }.onFailure { Plog.i("$who: ring card not started (${it.javaClass.simpleName}), the full screen notification shows it") }
        Plog.i("$who: ring card ${way.name.lowercase()}${if (channelOk(imp)) "" else ", channel below high"}")
        tellOnce(c, fs)
    }

    /** Settles the told flag, and tells once while the full screen access is off. Also on PS coming to the front. */
    fun tellOnce(c: Context, fs: Boolean = fullScreenOk(c)) {
        val told = sp(c).getBoolean("told", false)
        if (tellNow(fs, told)) {
            if (c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            val open = PendingIntent.getActivity(c, 7202,
                Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + c.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            c.getSystemService(NotificationManager::class.java).notify(TELL_ID, Notification.Builder(c, Gym.NOTE)
                .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor("#F5C542"))
                .setContentTitle(TELL_TITLE).setContentText(TELL_TEXT).setStyle(Notification.BigTextStyle().bigText(TELL_TEXT))
                .setCategory(Notification.CATEGORY_REMINDER).setVisibility(Notification.VISIBILITY_PUBLIC)
                .setAutoCancel(true).setContentIntent(open).build())
            sp(c).edit().putBoolean("told", true).apply()
            Plog.i("ring: full screen access is off, told once")
        } else {
            val keep = toldAfter(fs, told)
            if (keep != told) sp(c).edit().putBoolean("told", keep).apply()
        }
    }
}
