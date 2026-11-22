package com.cincee.ps.gos

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.service.quicksettings.TileService
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object Receivers {
    fun alarm(c: Context, id: String): PendingIntent = PendingIntent.getBroadcast(c, Notifier.nid("alarm$id"),
        Intent(c, Alarm::class.java).putExtra("id", id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    fun cardAction(c: Context, id: String, action: String): PendingIntent = PendingIntent.getBroadcast(c, Notifier.nid("$action$id"),
        Intent(c, CardAction::class.java).putExtra("id", id).putExtra("action", action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    /** A Dismiss or Remind tapped while the page was asleep waits here and goes over when it wakes
     *  (the page keeps it until the vault is open). A remind travels as the time it ends, "id|ms". */
    fun flushPending(c: Context) {
        val sp = c.getSharedPreferences("pending", Context.MODE_PRIVATE)
        val ids = sp.getStringSet("dismiss", emptySet())!!
        val reminds = sp.getStringSet("remind", emptySet())!!
        // A gym Acknowledge tapped while the page slept (Gym.kt): the page saves it once the vault is open.
        val gym = sp.getStringSet("gym", emptySet())!!
        gym.forEach { WebHost.post(JSONObject().put("type", "gymAck").put("day", it)) }
        if (gym.isNotEmpty()) sp.edit().remove("gym").apply()
        // An Annoying reminder answered while the page slept (Remind.kt): {type:"remAct"} as it was, the newest per reminder.
        val rem = sp.getStringSet("rem", emptySet())!!
        rem.forEach { s -> runCatching { JSONObject(s) }.getOrNull()?.takeIf { it.optString("type") == "remAct" }?.let { WebHost.post(it) } }
        if (rem.isNotEmpty()) sp.edit().remove("rem").apply()
        // PS 1.70 the day countdown answered on a notification while the page slept (DayEnd.kt): {type:"dayAct"} as it was.
        val day = sp.getStringSet("day", emptySet())!!
        day.forEach { s -> runCatching { JSONObject(s) }.getOrNull()?.takeIf { it.optString("type") == "dayAct" }?.let { WebHost.post(it) } }
        if (day.isNotEmpty()) sp.edit().remove("day").apply()
        // PS 1.74 Mark done on an AI message tapped while the page slept (MarkDone.kt): the page checks it again, then ticks.
        val done = sp.getStringSet("done", emptySet())!!
        done.forEach { WebHost.post(JSONObject().put("type", "cardAction").put("id", it).put("action", MarkDone.ACTION)) }
        if (done.isNotEmpty()) sp.edit().remove("done").apply()
        if (ids.isEmpty() && reminds.isEmpty()) return
        ids.forEach { WebHost.post(JSONObject().put("type", "cardAction").put("id", it).put("action", "dismiss")) }
        reminds.forEach { r ->
            val id = r.substringBeforeLast('|'); val until = r.substringAfterLast('|').toLongOrNull() ?: return@forEach
            if (id !in ids) WebHost.post(JSONObject().put("type", "cardAction").put("id", id).put("action", "remindUntil:$until"))
        }
        sp.edit().remove("dismiss").remove("remind").apply()
    }

    /** 10 minutes before a call. The schedule is sealed (Keystore), so it is read on the work thread, never the main one. */
    class Alarm : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val id = i.getStringExtra("id") ?: return
            val app = c.applicationContext
            val done = goAsync()
            Work.post { try { Alarms.fire(app, id) } finally { done.finish() } }
        }
    }

    /** A reminded email card is due (Reminds.next). */
    class RemindAlarm : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) { Reminds.fire(c) }
    }

    class CardAction : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            val id = i.getStringExtra("id") ?: return
            Notifier.cancelCard(c, id)
            val sp = c.getSharedPreferences("pending", Context.MODE_PRIVATE)
            when (i.getStringExtra("action")) {
                // Dismissed here = dismissed everywhere (the vault keeps it), once the page can save it.
                "dismiss" ->
                    if (WebHost.unlocked) WebHost.post(JSONObject().put("type", "cardAction").put("id", id).put("action", "dismiss"))
                    else sp.edit().putStringSet("dismiss", sp.getStringSet("dismiss", emptySet())!! + id).apply()
                // PS 1.74 Mark done on an AI message (MarkDone.kt): the page ticks the task and dismisses the message everywhere.
                MarkDone.ACTION ->
                    if (WebHost.unlocked) WebHost.post(JSONObject().put("type", "cardAction").put("id", id).put("action", MarkDone.ACTION))
                    else sp.edit().putStringSet("done", MarkDone.keep(sp.getStringSet("done", emptySet())!!, id)).apply()
                // Remind me in 15 mins: saved in the vault (so the Mac hides it too) and back here on time.
                "remind" -> {
                    val until = System.currentTimeMillis() + Reminds.NOTIFICATION_MINS * 60_000
                    if (WebHost.unlocked) WebHost.post(JSONObject().put("type", "cardAction").put("id", id).put("action", "remind:${Reminds.NOTIFICATION_MINS}"))
                    else {
                        val kept = sp.getStringSet("remind", emptySet())!!.filterNot { it.substringBeforeLast('|') == id }.toSet()
                        sp.edit().putStringSet("remind", kept + "$id|$until").apply()
                        Reminds.saveSoon(c)
                    }
                    Reminds.wakeBy(c, until)
                }
            }
        }
    }

    /** The system installer's answer for an update. */
    class Installed : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                    @Suppress("DEPRECATION") val confirm = i.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    runCatching { (WebHost.activity ?: c).startActivity(confirm) }
                    Updater.set("ready", JSONObject())
                }
                PackageInstaller.STATUS_SUCCESS -> Updater.set("none", JSONObject())
                else -> Updater.set("error", JSONObject().put("error", "GrapheneOS did not install it: ${i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "cancelled"}. Nothing changed."))
            }
        }
    }

    class Boot : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            // The sealed call schedule (Keystore) and the old update file (disk): on the work thread.
            val app = c.applicationContext
            val updated = i.action == Intent.ACTION_MY_PACKAGE_REPLACED
            val done = goAsync()
            Work.post { try { Alarms.restore(app); if (updated) Updater.cleanup(app) } finally { done.finish() } }
            Pulse.schedule(c); Quiet.sync(c); WatchService.sync(c); LiveService.sync(c); Reminds.restore(c); Fitness.restore(c); Gym.restore(c); Sleep.restore(c); Remind.restore(c); Soundboard.restore(c); DayEnd.restore(c)
            if (updated) {
                Notifier.updated(c, BuildConfig.VERSION_NAME)
                // PS 1.72 (the developer: a new icon must show everywhere at once): the notifications still showing, the Quick
                // Settings tile and the home screen widget are all drawn again by this build (RepostCore.kt).
                Notifier.repostAfterUpdate(app)
                runCatching { TileService.requestListeningState(c, ComponentName(c, PsTileService::class.java)) }
                if (Prefs.widget(c)) PsWidget.render(c)
                // Back on screen by itself where GrapheneOS allows it (it does with Display over other apps).
                runCatching { c.startActivity(Intent(c, MainActivity::class.java).putExtra("open", "settings").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
        }
    }
}

/**
 * "Remind me in N mins" on a client email card. The page keeps the time in the vault and tells the
 * shell when the next reminded card is due; WorkManager wakes the background check then (no exact
 * alarm), and the page brings the card back as a notification. A remind tapped on a notification
 * while the page sleeps also asks for one check right away, so it is saved and the Mac hides the card.
 */
object Reminds {
    const val NOTIFICATION_MINS = 15
    private const val WAKE = "ps-remind"
    private const val NOW = "ps-remind-now"
    private fun sp(c: Context) = c.getSharedPreferences("remind", Context.MODE_PRIVATE)
    // No network rule: a reminded card is already in the phone's encrypted copy, so it comes back
    // even offline (or with PS's Network permission off); the sync in the check just waits for later.
    private fun work(delay: Long) = OneTimeWorkRequestBuilder<PulseWorker>()
        .setInitialDelay(delay.coerceAtLeast(0), TimeUnit.MILLISECONDS).setInputData(workDataOf("force" to true)).build()

    /** From the page: the next reminded card is due at `at` (ms), 0 = none waiting. The check is
     *  started on time by the same kind of alarm as the 10 minute call alerts (WorkManager alone can
     *  wait a long while when the phone dozes); the delayed WorkManager job stays as a fallback. */
    fun next(c: Context, at: Long) {
        sp(c).edit().putLong("next", at).apply()
        val wm = WorkManager.getInstance(c)
        val am = c.getSystemService(android.app.AlarmManager::class.java)
        val pi = android.app.PendingIntent.getBroadcast(c, 4242, android.content.Intent(c, Receivers.RemindAlarm::class.java),
            android.app.PendingIntent.FLAG_IMMUTABLE or android.app.PendingIntent.FLAG_UPDATE_CURRENT)
        if (at <= 0L) { wm.cancelUniqueWork(WAKE); am.cancel(pi); return }
        wm.enqueueUniqueWork(WAKE, ExistingWorkPolicy.REPLACE, work(at - System.currentTimeMillis() + 5_000))
        val t = at.coerceAtLeast(System.currentTimeMillis() + 1000)
        if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, t, pi)
        else am.setWindow(android.app.AlarmManager.RTC_WAKEUP, t, 60_000, pi)
    }
    /** After a reboot or an update: arm the next reminded card again. */
    fun restore(c: Context) { val n = sp(c).getLong("next", 0); if (n > 0) next(c, n) }
    /** The alarm: one background check now (the page then shows the card again). */
    fun fire(c: Context) { if (Prefs.background(c)) Pulse.now(c, force = true, why = "remind") else WorkManager.getInstance(c).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, work(0)) }
    /** A remind tapped here: make sure a check runs by then, even before the page has saved it. */
    fun wakeBy(c: Context, at: Long) {
        val n = sp(c).getLong("next", 0)
        if (n in 1..at && n > System.currentTimeMillis()) return
        next(c, at)
    }
    // V1.59: at once rather than a WorkManager job, which may wait while the phone dozes (the job stays as the fallback).
    fun saveSoon(c: Context) { if (Prefs.background(c)) { Pulse.now(c, force = true, why = "remind tapped"); WorkManager.getInstance(c).enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, work(60_000)) } }
    /** A reminded card is due now (the periodic check looks even when nothing changed in the vault). */
    fun due(c: Context): Boolean = sp(c).getLong("next", 0) in 1..System.currentTimeMillis()
}
