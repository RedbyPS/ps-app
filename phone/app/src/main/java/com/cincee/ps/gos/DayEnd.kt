package com.cincee.ps.gos

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The day countdown on the phone while PS is closed (PS 1.70; the rules are web src/core/daycount.ts, the plan
 * src/daycount.ts planOf). While PS is open and on screen the page draws the card itself, so nothing is posted then.
 *  - The page hands over a plan ({type:"dayPlan"}) only when it changed: times and keys only, never a task or a title.
 *  - ONE exact alarm at the next moment: the end of the day ("End day now?" with Yes and "Give me 15 more mins") or the next
 *    reminder ("You have 4h 12m left" with Acknowledged).
 *  - 15 more mins here puts the notification away for 15 minutes at once, then it comes back (the page saves the same snooze).
 *    Swiping it away counts as 15 more mins too, like Esc on the Mac.
 *  - An answer goes to the page as {type:"dayAct"} and is saved in the vault, so the Mac's card goes too. While the page is not
 *    running it waits in prefs (Receivers.flushPending sends it) and a background check carries it, exactly like the gym's Yes.
 * Everything runs on its own thread, never the main one.
 */
object DayEnd {
    const val CH = "day"
    private const val END_ID = 7101
    private const val REM_ID = 7102
    private const val SNOOZE_MS = 15 * 60_000L
    private val ex = Executors.newSingleThreadExecutor { r -> Thread(r, "ps-day") }
    fun work(done: (() -> Unit)? = null, f: () -> Unit) {
        ex.execute {
            try { runCatching(f).onFailure { Plog.i("day: failed (${it.javaClass.simpleName})") } }
            finally { done?.invoke() }
        }
    }
    private fun sp(c: Context) = c.getSharedPreferences("day", Context.MODE_PRIVATE)
    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)
    private fun can(c: Context) = c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    // ---------- from the page ----------
    fun setPlan(c: Context, j: JSONObject) = work {
        val p = DayPlan.from(j)
        sp(c).edit().putString("plan", DayPlan.toJson(p).toString()).apply()
        settle(c, "plan")
    }
    fun restore(c: Context, done: (() -> Unit)? = null) = work(done) { settle(c, "system") }
    fun alarm(c: Context, done: (() -> Unit)? = null) = work(done) { settle(c, "alarm") }
    /** PS went off screen: a card that is due now becomes a notification. */
    fun pageHidden(c: Context) = work { settle(c, "hidden") }

    private fun plan(c: Context): DayPlan = DayPlan.parse(sp(c).getString("plan", null))
    private fun answered(c: Context): Set<String> = sp(c).getStringSet("answered", emptySet())!!.toSet()
    private fun snoozedUntil(c: Context, key: String): Long = sp(c).getLong("snooze:$key", 0)

    /** Up what is due, away what was answered (here, on the Mac or in the page), the next alarm armed. */
    private fun settle(c: Context, from: String) {
        val now = System.currentTimeMillis()
        val p = plan(c)
        val done = answered(c)
        val pageShows = WebHost.shownNow && WebHost.unlocked
        if (!p.on) { cancel(c, END_ID, "upEnd"); cancel(c, REM_ID, "upRem"); disarm(c); return }
        val wakes = mutableListOf<Long>()
        // End day now?
        val a = p.ask
        val upEnd = sp(c).getString("upEnd", null)
        if (upEnd != null && (a == null || upEnd != a.key || a.key in done || p.yes == a.key)) cancel(c, END_ID, "upEnd")
        if (a != null && a.key !in done && p.yes != a.key) {
            val at = maxOf(a.at, snoozedUntil(c, a.key))
            if (now >= at) { if (!pageShows && sp(c).getString("upEnd", null) != a.key) postEnd(c, p, a.key, from) }
            else { if (sp(c).getString("upEnd", null) == a.key) cancel(c, END_ID, "upEnd"); wakes += at }
        }
        // You have X left
        val r = p.rem
        val upRem = sp(c).getString("upRem", null)
        val remDone = r != null && (r.key in done || (p.remDone ?: "") >= r.key)
        if (upRem != null && (r == null || upRem != r.key || remDone)) cancel(c, REM_ID, "upRem")
        if (r != null && !remDone) {
            if (now >= r.at) { if (!pageShows && sp(c).getString("upRem", null) != r.key) postRem(c, p, r, from) }
            else wakes += r.at
        }
        // Keys the page no longer asks about are not needed here any more.
        val keep = done.filter { it == a?.key || it == r?.key }.toSet()
        if (keep.size != done.size) sp(c).edit().putStringSet("answered", keep).apply()
        val next = wakes.minOrNull()
        if (next == null) disarm(c) else arm(c, next)
    }

    // ---------- the notifications ----------
    private fun postEnd(c: Context, p: DayPlan, key: String, from: String) {
        if (!can(c)) return
        val n = Notification.Builder(c, CH)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor("#EC4E86"))
            .setContentTitle(p.words.ask)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(Notifier.openIntent(c, "list", 7103))
            .setDeleteIntent(action(c, "snooze", key, 7104))
            .addAction(Notification.Action.Builder(null, p.words.yes, action(c, "yes", key, 7105)).build())
            .addAction(Notification.Action.Builder(null, p.words.snooze, action(c, "snooze", key, 7106)).build())
            .build()
        nm(c).notify(END_ID, n)
        sp(c).edit().putString("upEnd", key).apply()
        Plog.i("day: End day now? up ($from)")
    }
    private fun postRem(c: Context, p: DayPlan, r: DayPlan.Rem, from: String) {
        if (!can(c)) return
        val left = r.end - System.currentTimeMillis()
        val n = Notification.Builder(c, CH)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor("#EC4E86"))
            .setContentTitle(DayPlan.remindTitle(left))
            .setWhen(r.end).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(Notifier.openIntent(c, "list", 7107))
            .setDeleteIntent(action(c, "ack", r.key, 7108))
            .addAction(Notification.Action.Builder(null, p.words.ack, action(c, "ack", r.key, 7109)).build())
            .build()
        nm(c).notify(REM_ID, n)
        sp(c).edit().putString("upRem", r.key).apply()
        Plog.i("day: reminder up ($from)")
    }
    private fun cancel(c: Context, id: Int, k: String) { nm(c).cancel(id); sp(c).edit().remove(k).apply() }
    private fun action(c: Context, act: String, key: String, req: Int) = PendingIntent.getBroadcast(c, req,
        Intent(c, DayAction::class.java).putExtra("act", act).putExtra("key", key), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    // ---------- an answer on this phone ----------
    fun answer(c: Context, act: String, key: String, from: String) = work {
        if (act !in setOf("yes", "snooze", "ack") || !DayPlan.isKey(key)) return@work
        val e = sp(c).edit()
        when (act) {
            "yes", "ack" -> e.putStringSet("answered", answered(c) + key)
            "snooze" -> e.putLong("snooze:$key", System.currentTimeMillis() + SNOOZE_MS)
        }
        e.apply()
        if (act == "ack") cancel(c, REM_ID, "upRem") else cancel(c, END_ID, "upEnd")
        Plog.i("day: $act ($from)")
        val o = JSONObject().put("type", "dayAct").put("act", act).put("key", key)
        if (WebHost.unlocked) WebHost.post(o)
        else {
            val p = c.getSharedPreferences("pending", Context.MODE_PRIVATE)
            val kept = p.getStringSet("day", emptySet())!!.filterNot { s -> runCatching { JSONObject(s).optString("key") == key }.getOrDefault(true) }
            p.edit().putStringSet("day", (kept + o.toString()).toSet()).apply()
            Reminds.saveSoon(c)   // a background check soon carries it to the vault, so the Mac's card goes too
        }
        settle(c, "answer")
    }

    // ---------- the alarm ----------
    private fun alarmIntent(c: Context) = PendingIntent.getBroadcast(c, 7110, Intent(c, DayAlarm::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun arm(c: Context, at: Long) {
        val am = c.getSystemService(AlarmManager::class.java)
        val t = at.coerceAtLeast(System.currentTimeMillis() + 1000)
        if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, alarmIntent(c))
        else am.setWindow(AlarmManager.RTC_WAKEUP, t, 60_000, alarmIntent(c))
    }
    private fun disarm(c: Context) { c.getSystemService(AlarmManager::class.java).cancel(alarmIntent(c)) }
}

/** The next moment from the plan. */
class DayAlarm : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) { val p = goAsync(); DayEnd.alarm(c.applicationContext) { p.finish() } }
}
/** Yes, 15 more mins or Acknowledged on a notification (swiping one away counts as 15 more mins, or Acknowledged). */
class DayAction : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        DayEnd.answer(c.applicationContext, i.getStringExtra("act") ?: return, i.getStringExtra("key") ?: return, "notification")
    }
}
