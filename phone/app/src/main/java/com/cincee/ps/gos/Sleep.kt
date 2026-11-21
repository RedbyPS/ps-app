package com.cincee.ps.gos

import android.app.AlarmManager
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Bundle
import android.util.Base64
import java.io.File
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import androidx.activity.OnBackPressedCallback
import org.json.JSONObject

/**
 * Sleep mode on the phone (V1.40; the rules are in web src/core/sleepmode.ts, the timing in SleepClock.kt).
 * the developer, 7 Nov 2026: "implement it for any device that you have connected to the PS app".
 *  - The Sleep button in the list sends a plan ({type:"sleep:start"}). The shell keeps it here, starts a quiet
 *    foreground service for the night and shows SleepActivity: a near black, warm, dim clock with "Asleep for X",
 *    the alarm line and, near the wake time, a panel with today's tasks (a count unless "Show full details" is on)
 *    and how many people in the G Squad are working (the line is hidden while there is no squad).
 *  - It shows over the lock screen like an alarm clock (showWhenLocked), so the phone stays locked underneath. Press
 *    the power button once: the phone locks and the clock comes back over the lock screen a moment later. Press it
 *    again within 20 s: the screen stays dark until an alarm or the next press.
 *  - Alarms are real alarm clocks (setAlarmClock: exact through Doze, the alarm icon in the status bar). They ring
 *    on the alarm volume with a buzz, through PS Do Not Disturb (nothing here asks Dnd), and stop by themselves
 *    after 10 minutes. Stop alarm silences it; only Wake up ends Sleep mode.
 *  - Wake up asks for the phone's own unlock first when it is locked (requestDismissKeyguard), then ends Sleep mode,
 *    opens PS and tells the page the wake time ({type:"sleep:woke", at}); the page shows the sleep to confirm before
 *    anything goes into the Sleep log. The wake time is kept here until the page says it has it (sleep:wokeSaved).
 * Only times, counts and the words the page sent are kept here, never more than the plan allows.
 */
object Sleep {
    const val ON = "sleep_on"
    const val RING = "sleep_ring"
    const val BACK = "sleep_back"
    const val BRK = "sleep_break"
    internal const val BRK_ID = 44
    internal const val ON_ID = 41
    internal const val RING_ID = 42
    internal const val BACK_ID = 43
    internal const val DAWN_ID = 45   // V1.43: Sunrise's light before the alarm (a silent full screen notice)
    private val main = Handler(Looper.getMainLooper())

    private fun sp(c: Context) = c.getSharedPreferences("sleep", Context.MODE_PRIVATE)
    fun plan(c: Context): SleepPlan? = SleepClock.parse(sp(c).getString("plan", null))
    fun running(c: Context) = sp(c).getBoolean("running", false) && plan(c) != null
    private fun fired(c: Context): Set<String> = sp(c).getStringSet("fired", emptySet())!!.toSet()
    fun ringStart(c: Context) = sp(c).getLong("ringStart", 0)
    fun ringing(c: Context) = SleepClock.ringing(ringStart(c), System.currentTimeMillis(), ringLen(c))
    /** V1.47: this ring's length (a playlist's whole file rings until it ends), and its playlist file, if any. */
    /** V1.47: FOREVER for a custom sound that loops until Stop (the developer's friend). */
    fun ringLen(c: Context) = sp(c).getLong("ringLen", SleepClock.RING_FOR).let { if (it >= SleepClock.FOREVER) SleepClock.FOREVER else it.coerceIn(SleepClock.RING_FOR, ListClock.WHOLE_MAX) }
    /** This ring's playlist or library file, whether it loops, its fade in, and whether it plays your own sound. */
    fun ringTrack(c: Context): File? { val id = sp(c).getString("ringTrack", null) ?: return null; return AlarmListStore.listFile(c, id) }
    fun ringLoop(c: Context) = sp(c).getBoolean("ringLoop", true)
    fun ringFade(c: Context) = sp(c).getInt("ringFade", 0)
    fun ringOwn(c: Context) = sp(c).getBoolean("ringOwn", true)

    // ---------- from the page ----------
    fun start(c: Context, j: JSONObject) {
        val p = SleepClock.from(j) ?: return
        stopTest(c)     // V1.44: a Test still playing stops (and gives the volume back) before the night starts
        clearBreak(c)   // V1.43: back to sleep ends any break
        sp(c).edit().putString("plan", j.toString()).putBoolean("running", true).putStringSet("fired", SleepClock.prune(fired(c), p))
            .putLong("ringStart", 0).putLong("lastBack", 0).putBoolean("alarmOnly", false).apply()
        runCatching { c.startForegroundService(Intent(c, SleepService::class.java)) }.onFailure { Plog.i("sleep: no service (${it.javaClass.simpleName})") }
        arm(c)
        runCatching { c.startActivity(Intent(c, SleepActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        Plog.i("sleep: on (${p.rings.size} alarms, ${if (p.details) "full details" else "counts only"})")
        sendState(c, refused = if (p.rings.isNotEmpty() && !c.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()) "exactAlarm" else null)
    }
    fun setPlan(c: Context, j: JSONObject) {
        if (!running(c) || SleepClock.from(j) == null) return
        sp(c).edit().putString("plan", j.toString()).apply()
        arm(c)
        SleepActivity.refreshAll()
    }
    /** Ends Sleep mode on this phone (Wake up, or the page asked). */
    fun stop(c: Context, from: String) {
        val was = running(c)
        val only = alarmOnly(c)
        giveVolumeBack(c)
        sp(c).edit().putBoolean("running", false).remove("plan").putLong("ringStart", 0).putBoolean("alarmOnly", false).apply()
        c.getSystemService(AlarmManager::class.java).cancel(alarmIntent(c))
        c.stopService(Intent(c, SleepService::class.java))
        nm(c).cancel(ON_ID); nm(c).cancel(RING_ID); nm(c).cancel(BACK_ID); nm(c).cancel(DAWN_ID)
        SleepActivity.closeAll()
        if (was) Plog.i("sleep: off ($from)")
        sendState(c, alarmOnly = only)
        arm(c)   // V1.47: the alarms that ring with Sleep mode off, again
    }
    /** Wake up passed the phone's own unlock: Sleep mode ends, PS opens, the page gets the wake time. */
    fun woke(c: Context) {
        val at = System.currentTimeMillis()
        stop(c, "wake")
        sp(c).edit().putLong("pendingWoke", at).apply()
        WebHost.post(JSONObject().put("type", "sleep:woke").put("at", at))
        runCatching { c.startActivity(Intent(c, MainActivity::class.java).putExtra("open", "list").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
    }
    /** The page asked (it just loaded): where Sleep mode stands, and a wake time it may have missed. */
    fun onGet(c: Context) {
        sendState(c)
        sp(c).getLong("pendingWoke", 0).takeIf { it > 0 }?.let { WebHost.post(JSONObject().put("type", "sleep:woke").put("at", it)) }
        if (sp(c).getBoolean("pendingCust", false)) WebHost.post(JSONObject().put("type", "sleep:customise"))
        if (sp(c).getBoolean("pendingSet", false)) WebHost.post(JSONObject().put("type", "sleep:settings"))
        sp(c).getString("pendingBrk", null)?.let { runCatching { WebHost.post(JSONObject(it)) } }
        sp(c).getString("pendingWakeIn", null)?.let { runCatching { WebHost.post(JSONObject(it)) } }
        onceResend(c)
    }

    // ---------- V1.65 "Just tomorrow", chosen on the clock ----------
    /** A choice that passed the owner check goes to the page. The one latest choice is also kept here, so a page that is not up
     *  yet (the clock can show over the lock screen first) gets it when it asks (sleep:get). Kept only a few minutes. */
    fun sendOnce(c: Context, json: String) {
        val m = runCatching { JSONObject(json) }.getOrNull() ?: return
        if (m.optString("type") != "sleep:once") return
        // Kept for a page that is not up yet. A page that is up gets it now and never again: a copy kept anyway was sent
        // a second time when the page reloaded, after the person may have changed it again elsewhere (an Undo on the Mac
        // came undone, with no unlock asked).
        if (WebHost.pageUp()) sp(c).edit().remove("pendingOnce").remove("pendingOnceAt").apply()
        else sp(c).edit().putString("pendingOnce", json).putLong("pendingOnceAt", System.currentTimeMillis()).apply()
        WebHost.post(m)
        Plog.i("sleep: just tomorrow ${m.optString("act")}")
    }
    private fun onceResend(c: Context) {
        val json = sp(c).getString("pendingOnce", null) ?: return
        val fresh = System.currentTimeMillis() - sp(c).getLong("pendingOnceAt", 0) in 0..3 * 60_000L
        sp(c).edit().remove("pendingOnce").remove("pendingOnceAt").apply()
        if (fresh) runCatching { WebHost.post(JSONObject(json)) }
    }

    // ---------- V1.43 "Wake me up in", set on the clock ----------
    /** Rings here at once (the stored plan gets the timer ring and the alarm is armed), and the page keeps it on the
     *  open sleep for every device (kept until the page says it saw it, like Customise). 0: no timer. */
    fun setWakeIn(c: Context, mins: Int) {
        val raw = sp(c).getString("plan", null) ?: return
        val now = System.currentTimeMillis()
        val j = runCatching { SleepClock.withWakeIn(JSONObject(raw), mins, now) { at -> java.time.Instant.ofEpochMilli(at).atZone(java.time.ZoneId.systemDefault()).toLocalTime().format(java.time.format.DateTimeFormatter.ofPattern("HH:mm")) } }.getOrNull() ?: return
        sp(c).edit().putString("plan", j.toString()).apply()
        arm(c)
        val msg = JSONObject().put("type", "sleep:wakeIn").put("mins", maxOf(0, mins)).put("at", now)
        sp(c).edit().putString("pendingWakeIn", msg.toString()).apply()
        WebHost.post(msg)
        Plog.i("sleep: Wake me up in ${if (mins > 0) "$mins min" else "off"}")
        main.post { SleepActivity.refreshAll() }
    }
    fun wakeInSeen(c: Context) { sp(c).edit().remove("pendingWakeIn").apply() }
    fun wokeSaved(c: Context) { sp(c).edit().remove("pendingWoke").apply() }
    /** V1.42: Customise on the clock passed the phone's unlock: Sleep mode ends here but the sleep stays open, PS
     *  opens and the page opens Customise (with "Back to sleep"). Kept until the page says it saw it. */
    fun customise(c: Context) {
        stop(c, "customise")
        sp(c).edit().putBoolean("pendingCust", true).apply()
        WebHost.post(JSONObject().put("type", "sleep:customise"))
        runCatching { c.startActivity(Intent(c, MainActivity::class.java).putExtra("open", "list").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
    }
    fun customiseSeen(c: Context) { sp(c).edit().remove("pendingCust").apply() }
    /** V1.47 (the developer's friend: "a settings gear icon in a corner"): Settings on the clock passed the phone's unlock: like
     *  Customise, the sleep stays open, PS opens and the page opens Sleep settings (with Back to sleep). */
    fun settings(c: Context) {
        stop(c, "settings")
        sp(c).edit().putBoolean("pendingSet", true).apply()
        WebHost.post(JSONObject().put("type", "sleep:settings"))
        runCatching { c.startActivity(Intent(c, MainActivity::class.java).putExtra("open", "list").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
    }
    fun settingsSeen(c: Context) { sp(c).edit().remove("pendingSet").apply() }

    // ---------- V1.47 alarms ring even when Sleep mode is off (the developer's friend: "Have the alarm play even if I don't
    // turn on Sleep mode ... ringing no matter what should be the default") ----------
    // The page sends the next alarms (a plan from now, alarmOnly; null: off). With Sleep mode not running, an exact
    // alarm wakes the phone at the next one (its sunrise first); then the clock comes up over the lock screen just to
    // ring, with only Stop. Stop, Back or the ring ending closes it; nothing is logged.
    private fun alarmPlan(c: Context) = SleepClock.parse(sp(c).getString("alarmPlan", null))
    private fun alarmFired(c: Context): Set<String> = sp(c).getStringSet("alarmFired", emptySet())!!.toSet()
    fun alarmOnly(c: Context) = running(c) && sp(c).getBoolean("alarmOnly", false)
    fun setAlarms(c: Context, j: JSONObject?) {
        if (j == null || SleepClock.from(j) == null) sp(c).edit().remove("alarmPlan").apply()
        else sp(c).edit().putString("alarmPlan", j.toString()).putStringSet("alarmFired", SleepClock.prune(alarmFired(c), SleepClock.from(j))).apply()
        Plog.i("sleep: alarms with Sleep mode off ${alarmPlan(c)?.rings?.size ?: "off"}")
        arm(c)
    }
    private fun alarmCheck(c: Context, from: String) {
        val p = alarmPlan(c) ?: return
        val now = System.currentTimeMillis()
        val due = SleepClock.due(p, now, alarmFired(c)) ?: SleepClock.dawn(p, now, alarmFired(c))
        if (due == null) { arm(c); return }
        val raw = sp(c).getString("alarmPlan", null) ?: return
        val j = runCatching { JSONObject(raw).put("since", now - 60_000).put("alarmOnly", true) }.getOrNull() ?: return
        Plog.i("sleep: an alarm rings with Sleep mode off ($from)")
        sp(c).edit().putString("plan", j.toString()).putBoolean("running", true).putBoolean("alarmOnly", true)
            .putStringSet("fired", alarmFired(c)).putLong("ringStart", 0).putLong("lastBack", 0).apply()
        runCatching { c.startForegroundService(Intent(c, SleepService::class.java)) }
        runCatching { c.startActivity(Intent(c, SleepActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
        sendState(c)
        check(c, from)
    }

    // ---------- V1.43 short breaks: "Back to sleep in" a few minutes ----------
    // The page keeps the break in the synced open sleep; this phone keeps its end, so it can ask "Go back to sleep?"
    // on time even with PS closed: a notification with Back to sleep, 5 more minutes and I'm up now, asked again every
    // 5 minutes, then the sleep ends at the last moment the phone was seen in use (the screen on when it looked).
    private fun brkIntent(c: Context) = PendingIntent.getBroadcast(c, 4110, Intent(c, SleepAlarm::class.java).setAction("break"),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    fun startBreak(c: Context, until: Long, plan: JSONObject?) {
        if (until <= 0) return
        val now = System.currentTimeMillis()
        sp(c).edit().putLong("brkUntil", until).putLong("brkSeen", now).putString("brkPlan", plan?.toString()).apply()
        nm(c).cancel(BRK_ID)
        armBreak(c, until)
        Plog.i("sleep: a break until ${java.time.Instant.ofEpochMilli(until)}")
    }
    fun endBreak(c: Context, from: String) { if (sp(c).getLong("brkUntil", 0) > 0) Plog.i("sleep: break over ($from)"); clearBreak(c) }
    private fun clearBreak(c: Context) {
        sp(c).edit().remove("brkUntil").remove("brkSeen").remove("brkPlan").apply()
        c.getSystemService(AlarmManager::class.java).cancel(brkIntent(c))
        nm(c).cancel(BRK_ID)
    }
    private fun armBreak(c: Context, at: Long) {
        val am = c.getSystemService(AlarmManager::class.java)
        am.cancel(brkIntent(c))
        if (am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, brkIntent(c))
        else am.setWindow(AlarmManager.RTC_WAKEUP, at, 60_000, brkIntent(c))
    }
    /** The break's alarm: ask, ask again, or end it. */
    fun breakCheck(c: Context) {
        val until = sp(c).getLong("brkUntil", 0)
        if (until <= 0) return
        val now = System.currentTimeMillis()
        if (c.getSystemService(android.os.PowerManager::class.java).isInteractive) sp(c).edit().putLong("brkSeen", now).apply()
        val (stage, ask) = SleepClock.breakStage(until, now)
        when (stage) {
            "running" -> armBreak(c, until)
            "ask" -> { Plog.i("sleep: break over, asking ($ask)"); if (can(c)) nm(c).notify(BRK_ID, breakNotice(c, until)); armBreak(c, SleepClock.breakNext(until, now)) }
            "end" -> { val seen = sp(c).getLong("brkSeen", now); Plog.i("sleep: no answer to the break, ending"); clearBreak(c); breakAnswer(c, "timeout", seen) }
        }
    }
    /** An answer from the notification (or the end): Back to sleep puts the clock up again here, at once. */
    fun answerBreak(c: Context, op: String) {
        val now = System.currentTimeMillis()
        val plan = sp(c).getString("brkPlan", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        Plog.i("sleep: break answer $op")
        when (op) {
            "back" -> { clearBreak(c); if (plan != null) start(c, plan); breakAnswer(c, "back", now) }
            "more" -> { val u = now + SleepClock.BREAK_MORE; sp(c).edit().putLong("brkUntil", u).apply(); nm(c).cancel(BRK_ID); armBreak(c, u); breakAnswer(c, "more", now) }
            "up" -> { clearBreak(c); breakAnswer(c, "up", now) }
        }
    }
    private fun breakAnswer(c: Context, answer: String, at: Long) {
        val o = JSONObject().put("type", "sleep:breakAnswer").put("answer", answer).put("at", at)
        sp(c).edit().putString("pendingBrk", o.toString()).apply()
        WebHost.post(o)
    }
    fun breakSeen(c: Context) { sp(c).edit().remove("pendingBrk").apply() }
    private fun breakNotice(c: Context, until: Long): Notification {
        val p = sp(c).getString("brkPlan", null)?.let { SleepClock.parse(it) }
        fun act(op: String, word: String, fallback: String, req: Int) = Notification.Action.Builder(null, p?.word(word, fallback) ?: fallback,
            PendingIntent.getBroadcast(c, req, Intent(c, SleepAction::class.java).putExtra("op", op), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build()
        val at = java.time.Instant.ofEpochMilli(until).atZone(java.time.ZoneId.systemDefault()).toLocalTime().format(java.time.format.DateTimeFormatter.ofPattern("HH:mm"))
        return Notification.Builder(c, BRK)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor(AMBER))
            .setContentTitle(p?.word("breakAsk", "Go back to sleep?") ?: "Go back to sleep?")
            .setContentText("Your break ended at $at.")
            .setCategory(Notification.CATEGORY_REMINDER).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(PendingIntent.getActivity(c, 4111, Intent(c, MainActivity::class.java).putExtra("open", "list").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .addAction(act("back", "breakBack", "Back to sleep", 4112))
            .addAction(act("more", "breakMore", "5 more minutes", 4113))
            .addAction(act("up", "breakUp", "I'm up now", 4114))
            .build()
    }
    /** The stopwatch, kept in this phone's settings so the power button (a new clock screen) never loses it. */
    fun watch(c: Context) = SleepWatch(sp(c).getBoolean("swRun", false), sp(c).getLong("swFrom", 0), sp(c).getLong("swAcc", 0))
    fun setWatch(c: Context, w: SleepWatch) { sp(c).edit().putBoolean("swRun", w.run).putLong("swFrom", w.from).putLong("swAcc", w.acc).apply() }
    private fun sendState(c: Context, refused: String? = null, alarmOnly: Boolean = alarmOnly(c)) {
        val p = plan(c)
        val o = JSONObject().put("type", "sleep:state").put("running", running(c)).put("since", if (running(c) && p != null) p.since else JSONObject.NULL)
        if (refused != null) o.put("refused", refused)
        if (alarmOnly) o.put("alarmOnly", true)   // V1.47: an alarm with Sleep mode off (the page records nothing)
        WebHost.post(o)
    }

    // ---------- the alarms ----------
    private fun alarmIntent(c: Context) = PendingIntent.getBroadcast(c, 4101, Intent(c, SleepAlarm::class.java),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun showIntent(c: Context, req: Int) = PendingIntent.getActivity(c, req, Intent(c, SleepActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    private fun arm(c: Context) {
        val am = c.getSystemService(AlarmManager::class.java)
        am.cancel(alarmIntent(c))
        val now = System.currentTimeMillis()
        if (!running(c)) {   // V1.47: the next alarm that rings with Sleep mode off
            val at = SleepClock.nextWake(alarmPlan(c), now, alarmFired(c))?.coerceAtLeast(now + 1000) ?: return
            if (am.canScheduleExactAlarms()) am.setAlarmClock(AlarmManager.AlarmClockInfo(at, showIntent(c, 4102)), alarmIntent(c))
            else am.setWindow(AlarmManager.RTC_WAKEUP, at, 60_000, alarmIntent(c))
            return
        }
        val n = SleepClock.nextWake(plan(c), now, fired(c))?.coerceAtLeast(now + 1000)   // V1.43: a sunrise wakes the phone first
        val end = ringStart(c).takeIf { it > 0 && ringLen(c) < SleepClock.FOREVER }?.let { it + ringLen(c) }
        val at = listOfNotNull(n, end).minOrNull() ?: return
        if (am.canScheduleExactAlarms()) am.setAlarmClock(AlarmManager.AlarmClockInfo(at, showIntent(c, 4102)), alarmIntent(c))
        else am.setWindow(AlarmManager.RTC_WAKEUP, at, 60_000, alarmIntent(c))
    }
    /** The alarm, a reboot, the service: settle the ring, start what is due now (never late), arm the next. */
    fun check(c: Context, from: String) {
        if (!running(c)) { alarmCheck(c, from); return }   // V1.47
        val now = System.currentTimeMillis()
        if (ringStart(c) > 0 && !ringing(c)) { Plog.i("sleep: ring over after ${ringLen(c) / 60_000} minutes"); stopRing(c) }
        val due = SleepClock.due(plan(c), now, fired(c))
        if (due != null && !ringing(c)) {
            sp(c).edit().putStringSet("fired", fired(c) + due.key).apply()
            if (alarmOnly(c)) sp(c).edit().putStringSet("alarmFired", alarmFired(c) + due.key).apply()
            startRing(c, now, due.style, due.sound)
            Plog.i("sleep: alarm ${due.label} (${due.style}, $from)")
        }
        // V1.43 Sunrise: the clock comes up over the lock screen and its light warms before the alarm.
        val dw = if (ringing(c)) null else SleepClock.dawn(plan(c), now, fired(c))
        if (dw != null && sp(c).getString("dawn", null) != dw.key) {
            sp(c).edit().putString("dawn", dw.key).apply()
            Plog.i("sleep: sunrise starts (${dw.label})")
            if (can(c)) nm(c).notify(DAWN_ID, dawnNotice(c))
            main.post { SleepActivity.refreshAll() }
        }
        arm(c)
    }
    fun restore(c: Context) {
        sp(c).getLong("brkUntil", 0).takeIf { it > 0 }?.let { armBreak(c, maxOf(it, System.currentTimeMillis() + 1000)) }   // a break across a restart
        if (!running(c)) { arm(c); return }   // V1.47: the alarms with Sleep mode off, across a restart
        runCatching { c.startForegroundService(Intent(c, SleepService::class.java)) }
        check(c, "system")
    }
    fun ringStyle(c: Context) = sp(c).getString("ringStyle", "chime") ?: "chime"
    /** The ring whose sunrise is lighting up now (before its alarm), if any. */
    fun dawnRing(c: Context) = if (ringing(c)) null else SleepClock.dawn(plan(c), System.currentTimeMillis(), fired(c))
    private fun startRing(c: Context, now: Long, style: String = "chime", sound: String = "") {
        // V1.47: this alarm's own sound (SleepClock.ringPlay): built in, your own, the day's playlist file or one library
        // file. A custom sound that loops rings until Stop; a file this phone does not have rings the usual sound.
        val l = ListClock.parse(sp(c).getString("plan", null))
        var play = SleepClock.ringPlay(sound, l, ListClock.day(now), hasOwn(c))
        if (play.kind == "track" && AlarmListStore.listFile(c, play.id) == null) play = if (hasOwn(c)) SleepClock.Play("own", len = SleepClock.FOREVER) else SleepClock.Play("builtin", len = SleepClock.RING_FOR)
        if (SleepClock.spec(style).sound == "none") play = SleepClock.Play("builtin", len = SleepClock.RING_FOR)
        sp(c).edit().putLong("ringStart", now).putString("ringStyle", style).remove("dawn")
            .putLong("ringLen", play.len).putBoolean("ringLoop", play.loop).putInt("ringFade", play.fade).putBoolean("ringOwn", play.kind != "builtin")
            .apply { if (play.kind == "track") putString("ringTrack", play.id) else remove("ringTrack") }.apply()
        Plog.i("sleep: rings ${play.kind}${if (play.len >= SleepClock.FOREVER) ", until Stop" else ""}")
        nm(c).cancel(DAWN_ID)
        // V1.44: every style that makes a sound sets the alarm volume to the alarm loudness (Loud: the top) while it rings.
        val spec = SleepClock.spec(style)
        if (spec.sound != "none") { stopTest(c, quiet = true); holdVolume(c, spec.loud, plan(c)?.level ?: SleepClock.LEVEL_DEF) }
        runCatching { c.startForegroundService(Intent(c, SleepService::class.java).setAction("ring")) }
            .onFailure { Gym.Buzz.once(c) }
        if (can(c)) nm(c).notify(RING_ID, ringNotice(c))
        RingScreen.bring(c, SleepActivity::class.java, RING, "sleep")   // 1.72: the clock at once, over other apps and the lock screen
        main.post { SleepActivity.refreshAll() }
    }
    /** The alarm loudness (V1.44; V1.43: Loud only, to full): the alarm volume to its step for the alarm; what it was is
     *  kept to put back when it stops. */
    private fun holdVolume(c: Context, loud: Boolean, level: Double) {
        val am = c.getSystemService(AudioManager::class.java)
        if (sp(c).getInt("savedAlarmVol", -1) >= 0) return
        runCatching {
            val step = SleepClock.alarmStep(loud, level, am.getStreamMaxVolume(AudioManager.STREAM_ALARM))
            sp(c).edit().putInt("savedAlarmVol", am.getStreamVolume(AudioManager.STREAM_ALARM)).apply()
            am.setStreamVolume(AudioManager.STREAM_ALARM, step, 0)
            Plog.i("sleep: alarm volume to step $step for the alarm")
        }.onFailure { Plog.i("sleep: could not set the alarm volume (${it.javaClass.simpleName})") }
    }

    // ---------- V1.44 your own sound and Test (web src/sleepmode/sound.ts) ----------
    // The page reads the file, makes it one channel at the one level (core/alarmsound.ts) and hands over the WAV. It is
    // kept in PS's own app folder on this phone only: never in the vault, never uploaded, never synced. Test plays
    // exactly what an alarm plays at the alarm loudness, the alarm volume set like a real ring and put back after.
    fun ownFile(c: Context) = File(c.filesDir, "sleep-sound.wav")
    fun hasOwn(c: Context) = ownFile(c).isFile && sp(c).getString("ownName", null) != null
    @Volatile private var testing = false
    private var testPlayer: MediaPlayer? = null
    private var testCtx: Context? = null
    private val testEnd = Runnable { testCtx?.let { stopTest(it) } }
    /** {type:"sleep:sound", own: {name, secs} or null, testing, error?} to the page. */
    fun postSound(c: Context, error: String? = null) {
        val o = JSONObject().put("type", "sleep:sound").put("testing", testing)
        if (hasOwn(c)) o.put("own", JSONObject().put("name", sp(c).getString("ownName", "Your sound")).put("secs", sp(c).getFloat("ownSecs", 0f).toDouble()))
        else o.put("own", JSONObject.NULL)
        if (error != null) o.put("error", error)
        WebHost.post(o)
    }
    /** The bridge thread (file work never on the main thread). */
    fun saveOwn(c: Context, name: String, secs: Double, b64: String) {
        val bytes = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull()
        if (bytes == null || !SleepClock.okOwnWav(bytes)) { Plog.i("sleep: own sound refused"); postSound(c, "PS app could not keep that sound on this phone."); return }
        val ok = runCatching {
            val tmp = File(c.filesDir, "sleep-sound.tmp")
            tmp.writeBytes(bytes)
            check(tmp.renameTo(ownFile(c)))
        }.isSuccess
        if (!ok) { postSound(c, "PS app could not keep that sound on this phone."); return }
        sp(c).edit().putString("ownName", SleepClock.ownName(name) ?: "Your sound").putFloat("ownSecs", secs.coerceIn(0.0, 60.0).toFloat()).apply()
        Plog.i("sleep: own sound kept (${bytes.size / 1024} KB)")
        postSound(c)
    }
    fun removeOwn(c: Context) {
        main.post { stopTest(c, quiet = true) }
        ownFile(c).delete()
        sp(c).edit().remove("ownName").remove("ownSecs").apply()
        Plog.i("sleep: own sound removed")
        postSound(c)
    }
    /** What a ring plays: your own sound, else the phone's alarm sound, else PS's chime. */
    internal fun alarmPlayer(c: Context, own: Boolean = true): MediaPlayer? {
        val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        if (own && hasOwn(c)) runCatching { MediaPlayer().apply { setAudioAttributes(attrs); setDataSource(ownFile(c).path); isLooping = true; prepare() } }.getOrNull()?.let { return it }
        val uri = RingtoneManager.getActualDefaultRingtoneUri(c, RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        return runCatching { MediaPlayer().apply { setAudioAttributes(attrs); setDataSource(c, uri); isLooping = true; prepare() } }.getOrNull()
            ?: runCatching { MediaPlayer.create(c, R.raw.rest_over, attrs, 0)?.apply { isLooping = true } }.getOrNull()
    }
    /** V1.47: a playlist file, as an alarm (USAGE_ALARM, the alarm volume), looping or once. */
    internal fun listPlayer(f: File, loop: Boolean): MediaPlayer? {
        val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        return runCatching { MediaPlayer().apply { setAudioAttributes(attrs); setDataSource(f.path); isLooping = loop; prepare() } }.getOrNull()
    }
    /** Main thread. Not while an alarm rings (the ring holds the volume then). */
    fun startTest(c: Context, style: String, level: Double, ms: Long, track: String? = null) {
        stopTest(c, quiet = true)
        val spec = SleepClock.spec(SleepClock.style(style, true))
        if (spec.sound == "none" || ringing(c)) { postSound(c); return }
        val am = c.getSystemService(AudioManager::class.java)
        runCatching {
            if (sp(c).getInt("savedTestVol", -1) < 0) sp(c).edit().putInt("savedTestVol", am.getStreamVolume(AudioManager.STREAM_ALARM)).apply()
            am.setStreamVolume(AudioManager.STREAM_ALARM, SleepClock.alarmStep(spec.loud, level, am.getStreamMaxVolume(AudioManager.STREAM_ALARM)), 0)
        }
        // V1.47: `track` plays that playlist file from its start (Test with the playlist on, or one file's Preview).
        val f = AlarmListStore.listFile(c, track)
        testPlayer = (if (f != null) listPlayer(f, loop = false) else alarmPlayer(c))?.apply { setVolume(1f, 1f); start() }
        testing = true; testCtx = c.applicationContext
        main.removeCallbacks(testEnd)
        main.postDelayed(testEnd, ms.coerceIn(1000L, if (f != null) ListClock.PREVIEW_MAX else SleepClock.TEST_MAX))
        Plog.i("sleep: test $style at ${(level * 100).toInt()}%")
        postSound(c)
    }
    /** Stop, Esc, the time up, Sleep mode starting or an alarm ringing: quiet, and the alarm volume back. */
    fun stopTest(c: Context, quiet: Boolean = false) {
        main.removeCallbacks(testEnd)
        runCatching { testPlayer?.stop() }; runCatching { testPlayer?.release() }
        testPlayer = null
        val v = sp(c).getInt("savedTestVol", -1)
        if (v >= 0) { sp(c).edit().remove("savedTestVol").apply(); runCatching { c.getSystemService(AudioManager::class.java).setStreamVolume(AudioManager.STREAM_ALARM, v, 0) } }
        val was = testing
        testing = false
        if (was && !quiet) postSound(c)
    }
    private fun giveVolumeBack(c: Context) {
        val v = sp(c).getInt("savedAlarmVol", -1)
        if (v < 0) return
        sp(c).edit().remove("savedAlarmVol").apply()
        runCatching { c.getSystemService(AudioManager::class.java).setStreamVolume(AudioManager.STREAM_ALARM, v, 0); Plog.i("sleep: alarm volume back") }
    }
    /** Stop alarm (no unlock needed), the ring ending by itself, or Wake up: the sound, the light, the volume all back.
     *  Stop during a sunrise ends that sunrise and its alarm. */
    fun stopRing(c: Context) {
        dawnRing(c)?.let { sp(c).edit().putStringSet("fired", fired(c) + it.key).apply(); if (alarmOnly(c)) sp(c).edit().putStringSet("alarmFired", alarmFired(c) + it.key).apply(); Plog.i("sleep: sunrise stopped") }
        sp(c).edit().putLong("ringStart", 0).remove("dawn").remove("ringTrack").remove("ringLen").remove("ringLoop").remove("ringFade").remove("ringOwn").apply()
        nm(c).cancel(DAWN_ID)
        giveVolumeBack(c)
        runCatching { c.startService(Intent(c, SleepService::class.java).setAction("quiet")) }
        nm(c).cancel(RING_ID)
        // V1.47: an alarm with Sleep mode off: once it stops (Stop, Back, or by itself) the clock goes too.
        if (alarmOnly(c)) { stop(c, "alarmStop"); return }
        arm(c)
        main.post { SleepActivity.refreshAll() }
    }

    // ---------- the power button: the clock comes back over the lock screen ----------
    fun screenOff(c: Context) {
        if (!running(c)) return
        val now = System.currentTimeMillis()
        if (!SleepClock.relaunch(now, sp(c).getLong("lastBack", 0), ringing(c))) return
        sp(c).edit().putLong("lastBack", now).apply()
        main.postDelayed({
            if (!running(c) || !can(c)) return@postDelayed
            // A full screen notification on a silent channel: the system shows SleepActivity over the lock screen.
            nm(c).notify(BACK_ID, Notification.Builder(c, BACK)
                .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor(AMBER))
                .setContentTitle(plan(c)?.word("title", "Sleep mode") ?: "Sleep mode")
                .setCategory(Notification.CATEGORY_ALARM).setVisibility(Notification.VISIBILITY_PUBLIC)
                .setFullScreenIntent(showIntent(c, 4103), true).setContentIntent(showIntent(c, 4103))
                .setTimeoutAfter(30_000).build())
        }, 1500)
    }
    fun cancelBack(c: Context) = nm(c).cancel(BACK_ID)

    // ---------- notifications ----------
    internal const val AMBER = "#E7A35E"
    private fun nm(c: Context) = c.getSystemService(NotificationManager::class.java)
    private fun can(c: Context) = c.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    /** The quiet line while Sleep mode is on (needed by the night's service): the alarm line only, tap for the clock. */
    fun onNotice(c: Context): Notification {
        val p = plan(c)
        return Notification.Builder(c, ON)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor(AMBER))
            .setContentTitle(p?.word("title", "Sleep mode") ?: "Sleep mode")
            .setContentText(p?.word("alarm", "") ?: "")
            .setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
            .setCategory(Notification.CATEGORY_STATUS).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setContentIntent(showIntent(c, 4104))
            .build()
    }
    /** Sunrise's light before the alarm: silent, it only brings the clock up over the lock screen. */
    private fun dawnNotice(c: Context): Notification {
        val p = plan(c)
        return Notification.Builder(c, RING)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor(AMBER))
            .setContentTitle(p?.word("title", "Sleep mode") ?: "Sleep mode").setContentText(p?.word("alarm", "") ?: "")
            .setCategory(Notification.CATEGORY_ALARM).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)   // the alarm channel itself is silent: no sound, no buzz
            .setFullScreenIntent(showIntent(c, 4107), true).setContentIntent(showIntent(c, 4107))
            .addAction(Notification.Action.Builder(null, p?.word("stop", "Stop alarm") ?: "Stop alarm", PendingIntent.getBroadcast(c, 4108,
                Intent(c, SleepAction::class.java).putExtra("op", "stop"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build())
            .build()
    }
    private fun ringNotice(c: Context): Notification {
        val p = plan(c)
        return Notification.Builder(c, RING)
            .setSmallIcon(R.drawable.ic_stat_ps).setColor(Color.parseColor(AMBER))
            .setContentTitle(p?.word("ringing", "Good morning") ?: "Good morning")
            .setContentText(p?.word("alarm", "") ?: "")
            .setCategory(Notification.CATEGORY_ALARM).setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOngoing(true).setOnlyAlertOnce(true)
            .setFullScreenIntent(showIntent(c, 4105), true).setContentIntent(showIntent(c, 4105))
            .addAction(Notification.Action.Builder(null, p?.word("stop", "Stop alarm") ?: "Stop alarm", PendingIntent.getBroadcast(c, 4106,
                Intent(c, SleepAction::class.java).putExtra("op", "stop"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)).build())
            .build()
    }
}

/** The night's service: keeps the quiet line, hears the power button (screen off), plays the ring. */
class SleepService : Service() {
    private val h = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var off: BroadcastReceiver? = null
    private val end = Runnable { Sleep.check(this, "ring") }
    private var fade = 0
    private val buzzOff = Runnable { Gym.Buzz.stop(this) }

    override fun onBind(i: Intent?): IBinder? = null
    override fun onStartCommand(i: Intent?, flags: Int, id: Int): Int {
        if (!Sleep.running(this)) { stopSelf(); return START_NOT_STICKY }
        startForeground(Sleep.ON_ID, Sleep.onNotice(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        if (off == null) {
            off = object : BroadcastReceiver() { override fun onReceive(c: Context, x: Intent) { Sleep.screenOff(c.applicationContext) } }
            registerReceiver(off, IntentFilter(Intent.ACTION_SCREEN_OFF), Context.RECEIVER_NOT_EXPORTED)
        }
        when (i?.action) {
            "ring" -> if (player == null) play()
            "quiet" -> quiet()
        }
        h.removeCallbacks(end)
        if (Sleep.ringing(this) && Sleep.ringLen(this) < SleepClock.FOREVER) h.postDelayed(end, (Sleep.ringStart(this) + Sleep.ringLen(this) - System.currentTimeMillis()).coerceAtLeast(0) + 500)
        return START_STICKY
    }
    private val rise = object : Runnable {
        override fun run() {
            val p = player ?: return
            val style = Sleep.ringStyle(this@SleepService)
            val t = System.currentTimeMillis() - Sleep.ringStart(this@SleepService)
            val v = (SleepClock.volume(style, t) * (if (SleepClock.spec(style).loud) 1.0 else ListClock.fadeAt(t, fade))).toFloat()
            runCatching { p.setVolume(v, v) }
            h.postDelayed(this, 1000)
        }
    }
    private fun play() {
        // V1.43: the ring's wake style. Silent light makes no sound and no buzz; the rest rise unless Loud.
        val style = Sleep.ringStyle(this)
        if (SleepClock.spec(style).sound == "none") { Plog.i("sleep: silent light, no sound"); return }
        // V1.47: the day's playlist file (Sleep.ringTrack): looping, or once ("Play the whole file": the ring ends when it
        // does), fading in. Else V1.44: your own sound if this phone has one (Sleep.alarmPlayer), else the phone's alarm.
        val tr = Sleep.ringTrack(this)
        val loop = Sleep.ringLoop(this)
        fade = if (tr != null) Sleep.ringFade(this) else 0
        val v0 = (SleepClock.volume(style, 0) * (if (SleepClock.spec(style).loud) 1.0 else ListClock.fadeAt(0, fade))).toFloat()
        player = (tr?.let { f -> Sleep.listPlayer(f, loop = loop)?.apply {
            if (!loop) setOnCompletionListener { Plog.i("sleep: the playlist file ended"); Sleep.stopRing(applicationContext) }
        } } ?: Sleep.alarmPlayer(this, own = Sleep.ringOwn(this)))?.apply { runCatching { setVolume(v0, v0); start() } }
        if (player == null) Plog.i("sleep: no ring sound, buzz only")
        h.removeCallbacks(rise); h.post(rise)
        Gym.Buzz.loop(this)
        // A whole talk can ring for up to 3 hours: the buzz stops after the usual 10 minutes, the voice goes on.
        if (Sleep.ringLen(this) > SleepClock.RING_FOR) h.postDelayed(buzzOff, SleepClock.RING_FOR)
    }
    private fun quiet() {
        h.removeCallbacks(rise); h.removeCallbacks(buzzOff)
        runCatching { player?.stop(); player?.release() }
        player = null
        Gym.Buzz.stop(this)
    }
    override fun onDestroy() {
        h.removeCallbacks(end)
        quiet()
        off?.let { runCatching { unregisterReceiver(it) } }; off = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}

/** The exact alarm: whatever is due now. */
class SleepAlarm : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) { if (i.action == "break") Sleep.breakCheck(c.applicationContext) else Sleep.check(c.applicationContext, "alarm") }
}
/** Stop alarm on the ring's notification. */
class SleepAction : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        when (val op = i.getStringExtra("op")) {
            "stop" -> Sleep.stopRing(c.applicationContext)
            "back", "more", "up" -> Sleep.answerBreak(c.applicationContext, op)   // V1.43: "Go back to sleep?"
        }
    }
}

/** The clock over the lock screen: near black, warm, dim, drifting a few pixels against burn in. */
class SleepActivity : FragmentActivity() {
    companion object {
        private val open = HashSet<SleepActivity>()
        fun closeAll() { open.toList().forEach { it.finish() } }
        fun refreshAll() { open.toList().forEach { it.draw() } }
    }
    private val h = Handler(Looper.getMainLooper())
    private val tick = object : Runnable { override fun run() { draw(); h.postDelayed(this, 1000) } }
    private var peekUntil = 0L
    private lateinit var face: LinearLayout
    private lateinit var clock: TextView; private lateinit var sub: TextView; private lateinit var alarm: TextView
    private lateinit var panel: LinearLayout; private lateinit var pTasks: TextView; private lateinit var pList: TextView
    private lateinit var pSquad: TextView; private lateinit var pWake: TextView
    private lateinit var stop: Button; private lateinit var wake: Button; private lateinit var hint: TextView
    // V1.42 Customise: the date, the stopwatch, the Customise button, and the look last applied
    private lateinit var root: FrameLayout; private lateinit var dateV: TextView
    private lateinit var swRow: LinearLayout; private lateinit var swT: TextView; private lateinit var swGo: Button; private lateinit var swReset: Button
    private lateinit var cust: Button
    private lateinit var once: SleepOnceUi   // V1.65 Just tomorrow
    private lateinit var gear: Button   // V1.47: Settings in a corner
    // V1.43: the countdown, "Wake me up in", the wake styles' light
    private lateinit var countV: TextView; private lateinit var wiBtn: Button; private lateinit var lightV: View
    private lateinit var dialV: SleepDialView
    private var lightDark = false
    private val lightTick = object : Runnable { override fun run() { if (lightFrame()) h.postDelayed(this, 50) } }
    private var laid: SleepLook? = null
    private var clockSize = 0f
    private val fmt = java.time.format.DateTimeFormatter.ofPattern("HH:mm")
    private fun amber(a: Float) = Color.argb((a * 255).toInt(), 231, 163, 94)
    private fun glow(a: Float) = Color.argb((a * 255).toInt(), 255, 190, 120)

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        setShowWhenLocked(true); setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        open.add(this)
        val d = resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(5, 3, 2)); setOnClickListener { if (::once.isInitialized) once.close(); poke() } }
        lightV = View(this).apply { alpha = 0f; isClickable = false }
        root.addView(lightV, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        face = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL }
        clock = TextView(this).apply { textSize = 92f; typeface = Typeface.create("sans-serif-thin", Typeface.NORMAL); gravity = Gravity.CENTER; fontFeatureSettings = "tnum" }
        sub = TextView(this).apply { textSize = 21f; gravity = Gravity.CENTER; setPadding(0, dp(4), 0, 0) }
        alarm = TextView(this).apply { textSize = 14f; gravity = Gravity.CENTER; setPadding(0, dp(6), 0, 0) }
        dateV = TextView(this).apply { textSize = 17f; gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD; setPadding(0, dp(2), 0, 0) }
        countV = TextView(this).apply { textSize = 16f; gravity = Gravity.CENTER; typeface = Typeface.DEFAULT_BOLD; setPadding(0, dp(4), 0, 0) }
        fun pill() = Button(this).apply { isAllCaps = false; textSize = 13f; typeface = Typeface.DEFAULT_BOLD; stateListAnimator = null; minHeight = 0; minimumHeight = 0; setPadding(dp(14), dp(6), dp(14), dp(6)) }
        swT = TextView(this).apply { textSize = 22f; gravity = Gravity.CENTER; fontFeatureSettings = "tnum" }
        swGo = pill().apply { setOnClickListener { val now = System.currentTimeMillis(); val w = Sleep.watch(applicationContext).toggled(now); Sleep.setWatch(applicationContext, w); Plog.i("sleep: stopwatch ${if (w.run) "started" else "paused"}"); draw() } }
        swReset = pill().apply { setOnClickListener { Sleep.setWatch(applicationContext, SleepWatch()); Plog.i("sleep: stopwatch reset"); draw() } }
        swRow = LinearLayout(this).apply { gravity = Gravity.CENTER; setPadding(0, dp(12), 0, 0) }
        val swBtns = LinearLayout(this).apply { gravity = Gravity.CENTER }
        swBtns.addView(swGo, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(10) })
        swBtns.addView(swReset, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { marginStart = dp(8) })
        swRow.addView(swT); swRow.addView(swBtns)
        dialV = SleepDialView(this).apply { visibility = View.GONE }
        face.addView(dialV, LinearLayout.LayoutParams(dp(260), dp(260)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        once = SleepOnceUi(this, { json, reason -> chooseOnce(json, reason) }, { poke(SleepOnceCore.IDLE_MS) })
        listOf(clock, dateV, sub, alarm).forEach(face::addView)
        face.addView(once.line, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        face.addView(once.row, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        listOf(countV, swRow).forEach(face::addView)
        root.addView(face, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.CENTER).apply { bottomMargin = dp(120) })
        cust = pill().apply { setOnClickListener { performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM); unlockThen("Customise") { Sleep.customise(applicationContext) } } }
        root.addView(cust, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply { topMargin = dp(72); marginEnd = dp(18) })
        // V1.47 (the developer's friend: "a settings gear icon in a corner"): Sleep settings, past the phone's unlock like Customise.
        gear = pill().apply { setOnClickListener { performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM); unlockThen("Settings") { Sleep.settings(applicationContext) } } }
        root.addView(gear, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.END).apply { topMargin = dp(28); marginEnd = dp(18) })
        // V1.43 "Wake me up in": no unlock needed (it only sets an alarm), top left.
        wiBtn = pill().apply { setOnClickListener { performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM); wakeInPick() } }
        root.addView(wiBtn, FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.START).apply { topMargin = dp(28); marginStart = dp(18) })

        val bottom = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(22), 0, dp(22), dp(26)) }
        panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(14), dp(18), dp(14)); alpha = 0f
            background = GradientDrawable().apply { setColor(amber(.06f)); setStroke(dp(1), amber(.14f)); cornerRadius = 20 * d }
        }
        pTasks = TextView(this).apply { textSize = 17f; typeface = Typeface.DEFAULT_BOLD }
        pList = TextView(this).apply { textSize = 14f; setPadding(0, dp(4), 0, 0) }
        pSquad = TextView(this).apply { textSize = 14f; setPadding(0, dp(6), 0, 0) }
        pWake = TextView(this).apply { textSize = 12f; setPadding(0, dp(6), 0, 0) }
        listOf(pTasks, pList, pSquad, pWake).forEach(panel::addView)
        fun pill(fill: Int, ink: Int, edge: Int) = GradientDrawable().apply { setColor(fill); if (edge != 0) setStroke(dp(1), edge); cornerRadius = 99 * d }
        stop = Button(this).apply {
            isAllCaps = false; textSize = 24f; typeface = Typeface.create(Typeface.DEFAULT, 900, false); setTextColor(Color.rgb(26, 15, 6)); stateListAnimator = null
            background = pill(glow(.92f), 0, 0); visibility = View.GONE
            setOnClickListener { performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM); Sleep.stopRing(applicationContext); poke() }
        }
        wake = Button(this).apply {
            isAllCaps = false; textSize = 18f; typeface = Typeface.DEFAULT_BOLD; stateListAnimator = null
            setOnClickListener { performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM); unlockThen("Wake up") { Sleep.woke(applicationContext) } }
        }
        hint = TextView(this).apply { textSize = 12f; gravity = Gravity.CENTER; setPadding(0, dp(10), 0, 0) }
        bottom.addView(panel, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { bottomMargin = dp(14) })
        bottom.addView(stop, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(80)).apply { bottomMargin = dp(12) })   // V1.43: big and obvious
        bottom.addView(wake, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(58)))
        bottom.addView(hint)
        root.addView(bottom, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        setContentView(root)
        // Back does nothing here: only Wake up ends Sleep mode (the phone stays locked underneath).
        // V1.47: an alarm with Sleep mode off: Back stops it (it is not Sleep mode, there is nothing to unlock).
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) { override fun handleOnBackPressed() { if (once.isOpen) once.close() else if (Sleep.alarmOnly(applicationContext)) Sleep.stopRing(applicationContext) else poke() } })
        root.alpha = 0f; root.animate().alpha(1f).setDuration(1200).start()
        peekUntil = System.currentTimeMillis() + 8000
    }

    private fun poke(ms: Long = 8000) { peekUntil = System.currentTimeMillis() + ms; draw() }

    /** V1.65 "Just tomorrow": a choice first passes the phone's own check (the unlock when the phone is locked, the fingerprint
     *  or screen lock when it is already unlocked). Only then it goes to the page. Not passed: nothing is sent and the row stays.
     *  A phone with no screen lock at all has nothing to ask for, so the choice goes through. */
    private var asking = false
    private fun chooseOnce(json: String, reason: String) {
        if (asking) return
        asking = true
        val done = { passed: Boolean ->
            asking = false
            SleepOnceCore.gate(passed, json)?.let { out ->
                if (!isFinishing) {
                    root.performHapticFeedback(android.view.HapticFeedbackConstants.CONFIRM)
                    Sleep.sendOnce(applicationContext, out)
                    once.close()
                }
            }
            if (!passed) poke(SleepOnceCore.IDLE_MS)
        }
        val km = getSystemService(KeyguardManager::class.java)
        if (!km.isDeviceSecure) { done(true); return }
        if (km.isKeyguardLocked) {
            var answered = false
            fun end(ok: Boolean) { if (!answered) { answered = true; h.removeCallbacksAndMessages("onceGiveUp"); done(ok) } }
            h.postDelayed({ end(false) }, "onceGiveUp", SleepClock.UNLOCK_WAIT)
            runCatching {
                km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                    override fun onDismissSucceeded() { end(true) }
                    override fun onDismissCancelled() { end(false) }
                    override fun onDismissError() { end(false) }
                })
            }.onFailure { end(false) }
        } else SleepOwner.ask(this, reason) { ok, _ -> done(ok) }
    }

    /** V1.43 "Wake me up in": the page's sleep cycle suggestions (with the time each lands on), your own hours and
     *  minutes, or no timer. It rings on this phone at once; the page keeps it for every device. */
    private fun wakeInPick() {
        val p = Sleep.plan(applicationContext) ?: return
        poke()
        val now = System.currentTimeMillis()
        fun at(m: Int) = java.time.Instant.ofEpochMilli(SleepClock.wakeInAt(now, m)).atZone(java.time.ZoneId.systemDefault()).toLocalTime().format(fmt)
        val rows = p.wakeIn.map { "${SleepClock.durText(it.sleep)}, ${it.name}, rings at ${at(it.mins)}" } + listOf(p.word("wakeInCustom", "Your own"), p.word("wakeInClear", "No timer"))
        android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(p.word("wakeIn", "Wake me up in"))
            .setItems(rows.toTypedArray()) { _, i ->
                when {
                    i < p.wakeIn.size -> Sleep.setWakeIn(applicationContext, p.wakeIn[i].mins)
                    i == p.wakeIn.size -> wakeInOwn(p)
                    else -> Sleep.setWakeIn(applicationContext, 0)
                }
            }
            .setNegativeButton("Back", null)
            .show()
    }
    private fun wakeInOwn(p: SleepPlan) {
        val d = resources.displayMetrics.density
        val hp = android.widget.NumberPicker(this).apply { minValue = 0; maxValue = 16; value = (p.timer?.second ?: 465) / 60 }
        val mp = android.widget.NumberPicker(this).apply { minValue = 0; maxValue = 11; displayedValues = Array(12) { "%02d".format(it * 5) }; value = ((p.timer?.second ?: 465) % 60) / 5 }
        val row = LinearLayout(this).apply { gravity = Gravity.CENTER; setPadding((16 * d).toInt(), (8 * d).toInt(), (16 * d).toInt(), 0) }
        row.addView(hp); row.addView(TextView(this).apply { text = " h  " }); row.addView(mp); row.addView(TextView(this).apply { text = " min" })
        android.app.AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(p.word("wakeInCustom", "Your own")).setView(row)
            .setPositiveButton(p.word("wakeInSet", "Set")) { _, _ ->
                val m = hp.value * 60 + mp.value * 5
                if (SleepClock.okWakeIn(m) != null) Sleep.setWakeIn(applicationContext, m)
            }
            .setNegativeButton("Back", null).show()
    }

    /** One frame of the wake style's light; true while there is a light to keep drawing. */
    private fun lightFrame(): Boolean {
        val c = applicationContext
        val p = Sleep.plan(c) ?: return false
        val now = System.currentTimeMillis()
        val ringing = Sleep.ringing(c)
        val dw = Sleep.dawnRing(c)
        val style = if (ringing) Sleep.ringStyle(c) else if (dw != null) "sunrise" else null
        val t = if (ringing) now - Sleep.ringStart(c) else if (dw != null) now - dw.at else 0L
        val calm = runCatching { android.provider.Settings.Global.getFloat(contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)
        val l = style?.let { SleepClock.light(it, t, p.sunrise * 60_000L, p.wave, p.look.ink, calm) }
        if (l == null) { lightV.alpha = 0f } else { lightV.setBackgroundColor(Color.rgb((l.rgb shr 16) and 255, (l.rgb shr 8) and 255, l.rgb and 255)); lightV.alpha = l.a.toFloat() }
        val dark = SleepClock.darkOn(l)
        if (dark != lightDark) { lightDark = dark; draw() }
        return l != null
    }

    /** Wake up: the phone's own unlock first when it is locked, then Sleep mode ends and PS opens. */
    /** V1.41 (the developer, 7 Nov 2026: "The wake up button doesn't work"): every step is in the log, and Wake up is never
     *  dead. If the unlock prompt fails or never answers, Sleep mode still ends and the phone's own lock screen shows
     *  (the phone stays locked; PS opens after the unlock). Only "Cancel" on the prompt keeps the clock. */
    private var waking = false
    /** Wake up and Customise (V1.42) both pass the phone's own unlock first, the same way. */
    private fun unlockThen(name: String, then: () -> Unit) {
        val km = getSystemService(KeyguardManager::class.java)
        Plog.i("sleep: $name pressed (locked=${km.isKeyguardLocked}, waking=$waking)")
        if (waking) return
        val end = { why: String -> if (!isFinishing) { waking = false; Plog.i("sleep: $name, $why"); then(); finish() } }
        if (!km.isKeyguardLocked) { end("unlocked"); return }
        // V1.43: "Ask for Touch ID to leave Sleep mode" off: leave at once (the phone stays locked; PS opens after it).
        if (Sleep.plan(applicationContext)?.lock == false) { end("without the unlock (switched off)"); return }
        waking = true
        h.postDelayed({ if (waking && !isFinishing) { Plog.i("sleep: unlock prompt gave no answer, ending Sleep mode"); end("no answer") } }, SleepClock.UNLOCK_WAIT)
        runCatching {
            km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() { end("unlock passed") }
                override fun onDismissCancelled() { waking = false; Plog.i("sleep: unlock cancelled, the clock stays"); poke() }
                override fun onDismissError() { end("unlock prompt error") }
            })
        }.onFailure { end("unlock prompt failed (${it.javaClass.simpleName})") }
    }

    /** V1.42: the look (font, where the face sits, background, the stopwatch's size), only when it changed. */
    private fun applyLook(L: SleepLook) {
        if (L == laid) return
        laid = L
        val d = resources.displayMetrics.density
        fun dp(v: Int) = (v * d).toInt()
        // V1.43: twelve fonts. Digital, Pixel and Chalk are the page's own files (assets/fonts); the rest are the
        // phone's nearest ones. The weight (or the font's own) and the letter spacing follow Customise.
        val (w0, ls0) = SleepClock.fontBase(L.font)
        val base = when (L.font) {
            "mono" -> Typeface.MONOSPACE; "type" -> Typeface.create("serif-monospace", Typeface.NORMAL); "serif" -> Typeface.SERIF
            "hand" -> Typeface.create("cursive", Typeface.NORMAL); "marker" -> Typeface.create("casual", Typeface.NORMAL)
            "digital" -> asset("Silkscreen-Regular.ttf"); "pixel" -> asset("PixelifySans-Variable.ttf"); "chalk" -> asset("GochiHand-Regular.ttf")
            else -> Typeface.create("sans-serif", Typeface.NORMAL)
        }
        clock.typeface = Typeface.create(base, (if (L.weight > 0) L.weight else w0).coerceIn(100, 900), false)
        clock.letterSpacing = ls0 + (L.spacing / 100).toFloat()
        // V1.43: the analogue face, sized by the same slider; the digital time small under it (or hidden).
        val analogue = L.face == "analogue"
        dialV.visibility = if (analogue) View.VISIBLE else View.GONE
        if (analogue) {
            val dm = resources.displayMetrics
            val side = (SleepClock.dialDp(dm.widthPixels / dm.density, dm.heightPixels / dm.density, L.size) * dm.density).toInt()
            dialV.layoutParams = (dialV.layoutParams as LinearLayout.LayoutParams).apply { width = side; height = side }
            dialV.typeface = clock.typeface
        }
        clockSize = 0f
        val lp = face.layoutParams as FrameLayout.LayoutParams
        lp.gravity = when (L.pos) { "top" -> Gravity.TOP or Gravity.CENTER_HORIZONTAL; "bottom" -> Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL; else -> Gravity.CENTER }
        lp.topMargin = if (L.pos == "top") dp(70) else 0
        lp.bottomMargin = when (L.pos) { "bottom" -> dp(220); "top" -> 0; else -> dp(120) }
        face.layoutParams = lp
        root.setBackgroundColor(Color.rgb((L.bg shr 16) and 255, (L.bg shr 8) and 255, L.bg and 255))
        val big = L.watch == "big"
        swRow.orientation = if (big) LinearLayout.VERTICAL else LinearLayout.HORIZONTAL
        swT.textSize = if (big) 54f else 22f
        swT.typeface = Typeface.create(if (big) "sans-serif-light" else "sans-serif-medium", Typeface.NORMAL)
        swRow.visibility = if (L.watch == "off") View.GONE else View.VISIBLE
        Plog.i("sleep: look ${L.font} ${L.size.toInt()}%, ${L.pos}, stopwatch ${L.watch}")
    }

    private fun asset(name: String): Typeface = runCatching { Typeface.createFromAsset(assets, "fonts/$name") }.getOrDefault(Typeface.MONOSPACE)

    fun draw() {
        if (isFinishing) return
        val c = applicationContext
        val p = Sleep.plan(c) ?: run { finish(); return }
        val L = p.look
        applyLook(L)
        // V1.43: the other words have their own colour, and turn dark on a bright light.
        fun ink(a: Float) = if (lightDark) Color.argb((a.coerceIn(.5f, 1f) * 255).toInt(), 26, 15, 6) else Color.argb((a.coerceIn(0f, 1f) * 255).toInt(), (L.text shr 16) and 255, (L.text shr 8) and 255, L.text and 255)
        fun clockInk(a: Float) = if (lightDark) Color.rgb(26, 15, 6) else Color.argb((a.coerceIn(0f, 1f) * 255).toInt(), (L.ink shr 16) and 255, (L.ink shr 8) and 255, L.ink and 255)
        val b = L.bright
        val now = System.currentTimeMillis()
        val ringing = Sleep.ringing(c)
        val peek = now < peekUntil
        val dawn = Sleep.dawnRing(c)
        val lit = ringing || peek || dawn != null
        val t = java.time.LocalTime.now()
        val (time, ampm) = SleepClock.clockText(t.hour, t.minute, t.second, L.h12, L.secs)
        val widthDp = resources.displayMetrics.widthPixels / resources.displayMetrics.density
        val sz = SleepClock.clockSp(widthDp, L.size, time.length + (if (ampm != null) 2 else 0), L.spacing)
        val analogue = L.face == "analogue"
        val csz = if (analogue) (sz * 0.34f).coerceIn(22f, 40f) else sz
        if (csz != clockSize) { clockSize = csz; clock.textSize = csz }
        clock.visibility = if (analogue && !L.digi) View.GONE else View.VISIBLE
        if (analogue) { dialV.look = L; dialV.dark = lightDark; dialV.ringing = ringing; dialV.calm = runCatching { android.provider.Settings.Global.getFloat(contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false); dialV.invalidate() }
        clock.text = if (ampm == null) time else android.text.SpannableString("$time $ampm").apply {
            setSpan(android.text.style.RelativeSizeSpan(0.28f), time.length, length, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        clock.setTextColor(if (lightDark) clockInk(1f) else if (ringing) glow(.96f) else clockInk(b))
        sub.text = if (ringing) p.word("ringing", "Good morning") else SleepClock.asleepFor(p.since, now)
        sub.setTextColor(if (ringing) glow(.86f) else ink(b * .744f))
        sub.visibility = if (ringing || L.shows("asleep")) View.VISIBLE else View.GONE
        alarm.text = p.word("alarm", ""); alarm.setTextColor(ink(b * .46f))
        alarm.visibility = if (L.shows("alarm")) View.VISIBLE else View.GONE
        once.bind(p.once, !ringing && !p.alarmOnly, ::ink, b)
        dateV.text = java.time.LocalDate.now().format(java.time.format.DateTimeFormatter.ofPattern("EEEE d MMMM"))
        dateV.setTextColor(ink(b * .744f)); dateV.visibility = if (L.shows("date")) View.VISIBLE else View.GONE
        val next = p.rings.firstOrNull { it.at > now }
        countV.text = next?.let { SleepClock.countdown(it.at, now) } ?: ""
        countV.setTextColor(ink(b * .577f)); countV.visibility = if (L.shows("count") && next != null && !ringing) View.VISIBLE else View.GONE
        // The stopwatch.
        val w = Sleep.watch(c)
        swT.text = SleepClock.watchText(w.ms(now)); swT.setTextColor(ink(if (L.watch == "big") b else b * .9f))
        val dd = resources.displayMetrics.density
        for ((btn, label, on) in listOf(Triple(swGo, if (w.run) p.word("pause", "Pause") else p.word("start", "Start"), true), Triple(swReset, p.word("reset", "Reset"), w.run || w.acc > 0))) {
            btn.text = label; btn.isEnabled = on; btn.setTextColor(ink(if (on) b * 1.05f else b * .4f))
            btn.background = GradientDrawable().apply { setColor(ink(.08f)); setStroke((1 * dd).toInt(), ink(.22f)); cornerRadius = 99 * dd }
        }
        val (dx, dy) = SleepClock.drift(now)
        val d = resources.displayMetrics.density
        if (face.translationX != dx * d || face.translationY != dy * d) face.animate().translationX(dx * d).translationY(dy * d).setDuration(6000).start()
        val up = L.shows("panel") && SleepClock.panelUp(p, now, ringing, peek)
        pTasks.text = p.word("tasks", "${p.count} tasks for today"); pTasks.setTextColor(ink(b * 1.03f))
        pTasks.visibility = if (L.shows("tasks")) View.VISIBLE else View.GONE
        pList.text = if (p.details && L.shows("tasks")) p.titles.joinToString("\n") { "• $it" } else ""
        pList.visibility = if (pList.text.isEmpty()) View.GONE else View.VISIBLE; pList.setTextColor(ink(b * .846f))
        pSquad.text = if (L.shows("squad")) p.words["squad"] ?: "" else ""
        pSquad.visibility = if (pSquad.text.isEmpty()) View.GONE else View.VISIBLE; pSquad.setTextColor(ink(b * .9f))
        pWake.text = p.wake?.takeIf { now < it }?.let { "Wake time " + java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).toLocalTime().format(fmt) } ?: ""
        pWake.visibility = if (pWake.text.isEmpty()) View.GONE else View.VISIBLE; pWake.setTextColor(ink(b * .577f))
        if (laid != null) panel.background = GradientDrawable().apply { setColor(ink(.06f)); setStroke((1 * d).toInt(), ink(.14f)); cornerRadius = 20 * d }
        val target = if (up) 1f else 0f
        if (panel.alpha != target && panel.animation == null) panel.animate().alpha(target).translationY(if (up) 0f else 40 * d).setDuration(800).start()
        stop.visibility = if (ringing || dawn != null) View.VISIBLE else View.GONE
        stop.text = p.word("stop", "Stop alarm")
        wake.text = p.word("wakeUp", "Wake up")
        wake.setTextColor(ink(if (lit) .9f else .4f))
        wake.background = GradientDrawable().apply { setColor(ink(if (lit) .12f else .04f)); setStroke((1 * d).toInt(), ink(if (lit) .3f else .1f)); cornerRadius = 99 * d }
        // V1.47: an alarm with Sleep mode off has only Stop.
        val only = p.alarmOnly
        for (b in listOf(wake, cust, gear, wiBtn)) b.visibility = if (only) View.GONE else View.VISIBLE
        gear.text = p.word("settings", "Settings")
        gear.setTextColor(ink(if (lit) .9f else .22f))
        gear.background = GradientDrawable().apply { setColor(ink(if (lit) .12f else .03f)); setStroke((1 * d).toInt(), ink(if (lit) .3f else .08f)); cornerRadius = 99 * d }
        cust.text = p.word("customise", "Customise")
        cust.setTextColor(ink(if (lit) .9f else .22f))
        cust.background = GradientDrawable().apply { setColor(ink(if (lit) .12f else .03f)); setStroke((1 * d).toInt(), ink(if (lit) .3f else .08f)); cornerRadius = 99 * d }
        wiBtn.text = p.timer?.let { "${p.word("wakeIn", "Wake me up in")}: ${java.time.Instant.ofEpochMilli(it.first).atZone(java.time.ZoneId.systemDefault()).toLocalTime().format(fmt)}" } ?: p.word("wakeIn", "Wake me up in")
        wiBtn.setTextColor(ink(if (lit) .9f else .22f))
        wiBtn.background = GradientDrawable().apply { setColor(ink(if (lit) .12f else .03f)); setStroke((1 * d).toInt(), ink(if (lit) .3f else .08f)); cornerRadius = 99 * d }
        // The light: drawn 20 times a second while a ring or a sunrise has one.
        if ((ringing || dawn != null)) { h.removeCallbacks(lightTick); h.post(lightTick) } else if (lightV.alpha != 0f) { h.removeCallbacks(lightTick); lightV.alpha = 0f; lightDark = false }
        hint.text = if (lit) p.word("hint", "") else ""
        hint.setTextColor(ink(b * .436f))
        // The screen itself: as dark as it goes while asleep, brighter while ringing or tapped.
        val lp = window.attributes
        // V1.43: Bright white and Strobe flash take the screen to full brightness (only this window, back after).
        val bright = ringing && SleepClock.spec(Sleep.ringStyle(c)).bright
        val want = if (bright) 1f else if (ringing || dawn != null) 0.6f else if (peek) 0.25f else 0.02f
        if (lp.screenBrightness != want) { lp.screenBrightness = want; window.attributes = lp }
    }

    override fun onResume() {
        super.onResume()
        Sleep.cancelBack(applicationContext)
        if (!Sleep.running(applicationContext)) { finish(); return }
        h.removeCallbacks(tick); h.post(tick)
    }
    override fun onPause() { if (::once.isInitialized) once.close(false); h.removeCallbacks(tick); h.removeCallbacks(lightTick); super.onPause() }
    override fun onDestroy() { open.remove(this); h.removeCallbacks(tick); super.onDestroy() }
}

/** V1.43 (the developer: "the option to have a clock face as well"): the analogue face, drawn (no image files). Ticks, numbers
 *  or roman numerals; smooth hour and minute hands; a second hand that sweeps (redrawn about 30 times a second while
 *  on screen), ticks or is left out; face, hands and ticks in their own colours with a soft glow. */
class SleepDialView(c: Context) : View(c) {
    var look = SleepLook(); var dark = false; var ringing = false; var calm = false
    var typeface: Typeface = Typeface.DEFAULT
    private val p = Paint(Paint.ANTI_ALIAS_FLAG)
    private fun col(rgb: Int, a: Float) = if (dark) Color.argb((a.coerceIn(.5f, 1f) * 255).toInt(), 26, 15, 6)
        else Color.argb(((a * look.bright).coerceIn(0f, 1f) * 255).toInt(), (rgb shr 16) and 255, (rgb shr 8) and 255, rgb and 255)
    override fun onDraw(cv: Canvas) {
        val L = look; val r = minOf(width, height) / 2f; val cx = width / 2f; val cy = height / 2f; val u = r / 100f
        fun px(deg: Double, rad: Float) = cx + rad * Math.sin(Math.toRadians(deg)).toFloat()
        fun py(deg: Double, rad: Float) = cy - rad * Math.cos(Math.toRadians(deg)).toFloat()
        p.style = Paint.Style.FILL; p.color = Color.argb(12, (L.faceInk shr 16) and 255, (L.faceInk shr 8) and 255, L.faceInk and 255); p.clearShadowLayer()
        cv.drawCircle(cx, cy, 97 * u, p)
        p.style = Paint.Style.STROKE; p.strokeWidth = 1.4f * u; p.color = col(L.faceInk, .5f)
        if (!dark) p.setShadowLayer(10 * u * L.bright, 0f, 0f, col(L.faceInk, .45f))
        cv.drawCircle(cx, cy, 97 * u, p); p.clearShadowLayer()
        p.strokeCap = Paint.Cap.ROUND
        val labels = SleepClock.dialLabels(L.dial)
        for (i in 0 until 60) {
            val major = i % 5 == 0; val deg = i * 6.0
            if (labels.isNotEmpty()) {
                if (major) {
                    p.style = Paint.Style.FILL; p.color = col(L.tickInk, .95f); p.typeface = if (L.dial == "roman") Typeface.SERIF else typeface
                    p.textSize = (if (L.dial == "roman") 12.5f else 15f) * u; p.textAlign = Paint.Align.CENTER
                    cv.drawText(labels[i / 5], px(deg, 72 * u), py(deg, 72 * u) - (p.descent() + p.ascent()) / 2, p)
                } else { p.style = Paint.Style.FILL; p.color = col(L.tickInk, .55f); cv.drawCircle(px(deg, 90 * u), py(deg, 90 * u), 0.9f * u, p) }
                continue
            }
            p.style = Paint.Style.STROKE; p.strokeWidth = (if (major) 2.6f else 1f) * u; p.color = col(L.tickInk, if (major) .95f else .5f)
            cv.drawLine(px(deg, 92 * u), py(deg, 92 * u), px(deg, (if (major) 79 else 87) * u), py(deg, (if (major) 79 else 87) * u), p)
        }
        val t = java.time.LocalTime.now()
        val (ah, am, asec) = SleepClock.handAngles(t.hour, t.minute, t.second, t.nano / 1_000_000, L.hand == "sweep" && !calm)
        val hc = if (ringing && !dark) Color.argb(245, 255, 190, 120) else col(L.handInk, 1f)
        fun hand(deg: Double, back: Float, len: Float, w: Float, color: Int) { p.style = Paint.Style.STROKE; p.strokeWidth = w * u; p.color = color; cv.drawLine(px(deg + 180, back * u), py(deg + 180, back * u), px(deg, len * u), py(deg, len * u), p) }
        hand(ah, 8f, 48f, 6f, hc); hand(am, 10f, 74f, 3.6f, hc)
        if (L.hand != "none") hand(asec, 14f, 84f, 1.3f, if (ringing && !dark) Color.argb(204, 255, 190, 120) else col(L.handInk, .8f))
        p.style = Paint.Style.FILL; p.color = hc; cv.drawCircle(cx, cy, 3.6f * u, p)
        // The sweep: the next frame in about 33 ms, only while the face is on screen.
        if (L.hand == "sweep" && !calm && isShown) postInvalidateDelayed(33)
    }
}
