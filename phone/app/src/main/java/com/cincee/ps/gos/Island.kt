package com.cincee.ps.gos

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.app.Service
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.os.SystemClock
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.TextPaint
import android.text.TextUtils
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

/**
 * The phone's Dynamic Island (V1.59, the developer: "Can you add a dynamic island to the GOS app? ... To have the dynamic island
 * follow me everywhere?"). A black pill around the camera hole, over every app, drawn by LiveService below with Display
 * over other apps (GrapheneOS allows it like any Android). When something is live it drops from the pill to just below
 * the status bar: Android keeps an app's overlay under the status bar, which takes every touch in its strip, so the
 * words and the taps live in that lower part (an accessibility service could draw over the bar, but asks far more). What it shows: IslandShow.kt. Its data: the page's island
 * state (the same message the Mac's island gets) and the phone's own reminders (Remind.kt).
 *
 * Tap: PS opens on the right screen. Hold: Hide for 30 minutes and Settings (Back or a tap outside closes them).
 * Never over the lock screen, hidden while an app is full screen, and on a build whose profile says so (the developer's private
 * build: islandOverProtectedApps false) never over 1Password or Signal. Battery: no polling of its own; it redraws once a
 * second only while a countdown shows, otherwise it sleeps until the next change it knows of (IslandShow.wakeAt). The one
 * exception is the 1Password and Signal check on the developer's build (a usage read once a second while the screen is on, the
 * same as the floating bubble's).
 */
object Island {
    private val main = Handler(Looper.getMainLooper())
    // Main thread only.
    var page: IslandShow.Page = IslandShow.OFF; private set
    val pops = ArrayList<IslandShow.Pop>()
    val seenBack = HashMap<String, Long>()
    private val seenEvents = LinkedHashSet<String>()
    private var lastJson = ""
    private var lastFit = ""

    private fun sp(c: Context) = c.getSharedPreferences("island", Context.MODE_PRIVATE)
    fun hideUntil(c: Context) = sp(c).getLong("hideUntil", 0)
    fun hideFor(c: Context, ms: Long) { sp(c).edit().putLong("hideUntil", System.currentTimeMillis() + ms).apply() }
    /** From the page: is this the developer's own account (the per account answer of islandOverProtectedApps is no for the developer). */
    fun setRed(c: Context, red: Boolean) { if (!sp(c).contains("red") || sp(c).getBoolean("red", true) != red) { sp(c).edit().putBoolean("red", red).apply(); main.post { LiveService.refresh() } } }
    /** May the island show over 1Password and Signal? The profile narrows the account's answer (Profile.allows). Until the
     *  page has said whose account it is, no (the golden rule's side). */
    fun over(c: Context): Boolean {
        val red = if (sp(c).contains("red")) sp(c).getBoolean("red", true) else return false
        return Profile.allows("islandOverProtectedApps", !red, Profile.load(c))
    }
    /** This build must know the app in front (to stay away from 1Password and Signal), so it needs Usage access. */
    fun needsUsage(c: Context) = Prefs.island(c) && !over(c)

    /** The page's {type:"island", state} (bridge thread). */
    fun fromPage(c: Context, st: JSONObject?) {
        val now = System.currentTimeMillis()
        val raw = st?.toString() ?: ""
        val p = IslandShow.page(st, now)
        main.post {
            // A repeated message (the page resends every minute) keeps an event's own few seconds; an old one never pops again.
            val ev = p.event
            val next = if (ev == null) p
                else if (ev.id == page.event?.id) p.copy(event = page.event)
                else if (ev.id in seenEvents) p.copy(event = null)
                else { seenEvents.add(ev.id); while (seenEvents.size > 200) seenEvents.remove(seenEvents.first()); p }
            val changed = raw != lastJson
            lastJson = raw
            // V1.60 Fitness: a NEW moment (and a fresh one: the page resends every minute) plays its own sound, if its switch is on.
            val fit = next.fit
            if (fit != null && fit.id != lastFit) {
                lastFit = fit.id
                if (next.on && fit.sound && now - fit.at < 4_000 && now < fit.until && Prefs.island(c)) FitTones.play(c, fit.kind)
            }
            page = next
            if (changed || ev != null) LiveService.refresh()
            if (next.on) WebHost.activity?.askIsland()
        }
    }
    /** A reminder rang (Remind.kt): its pill and words pop for a few seconds. A tap opens PS on the island's card with the
     *  reminder's own buttons (PS 1.72, IslandShow.remOpen); its Open task is there for a reminder on a task. */
    fun reminder(c: Context, id: String, title: String, text: String) {
        if (!Prefs.island(c)) return
        main.post {
            pops.removeAll { it.id == "rem:$id" || it.until < System.currentTimeMillis() }
            pops.add(IslandShow.Pop("rem:$id", IslandShow.Tone.AMBER, title.take(80), text.take(200), IslandShow.remOpen(id), System.currentTimeMillis() + IslandShow.REMINDER_MS))
            LiveService.refresh()
        }
    }
}

/**
 * The service behind the island and the live link: one foreground service (its notification is the quiet PS line, the
 * same as the bubble's watcher) that runs while the island or Instant notifications is on. GrapheneOS keeps it and its
 * network while the phone dozes, which is what lets the live link hear signals within seconds.
 */
class LiveService : Service() {
    companion object {
        @Volatile var running = false
        @Volatile private var self: LiveService? = null
        fun wanted(c: Context) = !Nuke.done(c) && ((Prefs.island(c) && Settings.canDrawOverlays(c)) || (Prefs.live(c) && Prefs.background(c)))
        fun sync(c: Context) {
            val i = Intent(c, LiveService::class.java)
            val want = wanted(c)
            if (want && !running) runCatching { c.startForegroundService(i) }.onFailure { Plog.i("live service: not started (${it.javaClass.simpleName})") }
            else if (!want && running) c.stopService(i)
            else if (want) Handler(Looper.getMainLooper()).post { self?.settings() }
        }
        /** Main thread: the island's data or a setting changed. */
        fun refresh() { self?.let { it.update(); it.watch() } }
    }

    private val h = Handler(Looper.getMainLooper())
    private var view: IslandView? = null
    private var screenOn = true
    private var front: String? = null       // "protected" while 1Password or Signal is in front; never their names
    private var since = 0L
    private var reading = false
    private var full = false
    private val screen = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) {
            when (i.action) {
                Intent.ACTION_SCREEN_OFF -> { screenOn = false; update() }
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> { screenOn = true; update(); watch() }
            }
        }
    }

    override fun onBind(i: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        running = true
        self = this
        startForeground(Quiet.ID, Quiet.build(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        registerReceiver(screen, IntentFilter().apply { addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF); addAction(Intent.ACTION_USER_PRESENT) })
        screenOn = getSystemService(PowerManager::class.java).isInteractive
        since = System.currentTimeMillis() - 10_000
        settings()
    }
    override fun onStartCommand(i: Intent?, f: Int, id: Int): Int = START_STICKY
    override fun onDestroy() {
        running = false
        self = null
        h.removeCallbacksAndMessages(null)
        runCatching { unregisterReceiver(screen) }
        LiveLink.stop()
        view?.let { v -> view = null; v.leave() }
        Quiet.sync(this)
        super.onDestroy()
    }

    /** A setting changed: the live link on or off, then the island. */
    fun settings() {
        if (Prefs.live(this) && Prefs.background(this)) LiveLink.start(this) else LiveLink.stop()
        update(); watch()
    }

    // ---------- what to show ----------
    private val tickR = Runnable { update() }
    fun update() {
        h.removeCallbacks(tickR)
        val now = System.currentTimeMillis()
        val hide = Island.hideUntil(this)
        val km = getSystemService(KeyguardManager::class.java)
        val usageOk = !Island.needsUsage(this) || Prefs.hasUsage(this)
        val may = Prefs.island(this) && Settings.canDrawOverlays(this) && screenOn && !km.isKeyguardLocked && now >= hide && !full && usageOk &&
            (front != "protected" || Island.over(this))
        Island.pops.removeAll { it.until <= now }
        val look = IslandShow.look(Island.page, Island.pops, now, Island.seenBack)
        if (look is IslandShow.Look.Compact && look.backId != null && look.backId !in Island.seenBack) Island.seenBack[look.backId] = now
        if (Island.seenBack.size > 50) Island.seenBack.entries.removeAll { now - it.value > IslandShow.BACK_MS }
        if (!may) { view?.let { v -> view = null; v.leave() } }
        else {
            val v = view ?: IslandView(this, ::tapped, ::menu, ::onInsets).also { view = it; it.enter() }
            v.show(look)
        }
        // Sleep until the next change: each second only while a countdown is on screen.
        if (may) {
            val ticking = look is IslandShow.Look.Compact && look.tick
            val next = IslandShow.wakeAt(Island.page, Island.pops, now, hide)
            val wait = if (ticking) 1000 - (now % 1000) + 5 else next?.let { it - now + 20 }
            if (wait != null) h.postDelayed(tickR, wait.coerceIn(50L, 6 * 3600_000L))
        } else if (screenOn && now < hide) h.postDelayed(tickR, hide - now + 20)
    }

    private fun onInsets(fullScreen: Boolean) { if (fullScreen != full) { full = fullScreen; update() } }

    private fun tapped(open: String) {
        if (open.startsWith("url:")) {
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(open.removePrefix("url:"))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            return
        }
        startActivity(Intent(this, MainActivity::class.java).putExtra("open", open).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }
    private fun menu(which: String) {
        when (which) {
            "hide" -> { Island.hideFor(this, 30 * 60_000L); Plog.i("island: hidden for 30 minutes"); update() }
            "settings" -> tapped("island-settings")
        }
    }

    // ---------- 1Password and Signal (only on a build that keeps the island off them) ----------
    private val watchR = Runnable { watch() }
    private fun watch() {
        h.removeCallbacks(watchR)
        if (!screenOn || !Prefs.island(this) || !Island.needsUsage(this) || !Prefs.hasUsage(this)) { if (!Island.needsUsage(this)) front = null; return }
        if (reading) return
        reading = true
        Work.post {
            val latest = runCatching { frontApp() }.getOrNull()
            h.post {
                reading = false
                if (self !== this) return@post
                if (latest != null) {
                    // GOLDEN RULE: only "is it 1Password or Signal", nothing else kept.
                    val was = front
                    front = if (Protected.isProtected(latest)) "protected" else "other"
                    if (was != front) update()
                }
                if (screenOn) h.postDelayed(watchR, 1000)
            }
        }
    }
    private fun frontApp(): String? {
        val now = System.currentTimeMillis()
        val ev = getSystemService(UsageStatsManager::class.java).queryEvents(since, now)
        val e = UsageEvents.Event()
        var latest: String? = null
        while (ev.hasNextEvent()) { ev.getNextEvent(e); if (e.eventType == UsageEvents.Event.ACTIVITY_RESUMED) latest = e.packageName }
        since = now - 1500
        return latest
    }
}

/**
 * The island, drawn in code so it can morph: idle (just the black around the camera), compact (a short line with its
 * value, dropped just below the status bar and joined to the pill), big (a title and a line), and the hold menu. One
 * window that is resized at the start and the end of each morph only, never each frame.
 */
@SuppressLint("ViewConstructor")
class IslandView(private val svc: Context, private val onTap: (String) -> Unit, private val onMenu: (String) -> Unit, private val onFull: (Boolean) -> Unit) : View(svc) {
    private val wm = svc.getSystemService(WindowManager::class.java)
    private val d = resources.displayMetrics.density
    private val lp = WindowManager.LayoutParams(1, 1, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
        PixelFormat.TRANSLUCENT).apply {
        gravity = Gravity.TOP or Gravity.START
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        title = "PS island"
    }
    private var added = false
    private var look: IslandShow.Look = IslandShow.Look.Idle(false)
    private var menuOpen = false

    // Geometry, in screen pixels. Android draws an app's overlay UNDER the status bar, and the status bar takes every touch
    // in its strip (pulling the shade). So the island has two parts: the pill around the camera (inside the status bar,
    // looks only) and, when something is live, a body that drops from it to just below the status bar, joined by a neck.
    // The body carries the words and takes the taps. Idle, the body is the pill itself.
    private val cut = Rect()
    private var screenW = 0
    private var barBottom = 0f
    private val pill = RectF()       // around the camera
    private val cur = RectF()        // the body as drawn now
    private val from = RectF()
    private val to = RectF()
    private var radius = 0f
    private var fromR = 0f
    private var toR = 0f
    private var content = 1f         // the words' alpha
    private var alphaAll = 0f
    private var anim: ValueAnimator? = null
    private val win = Rect()          // the window, in screen pixels
    private val path = android.graphics.Path()

    private val bg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.BLACK }
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1f * resources.displayMetrics.density; color = Color.argb(46, 255, 255, 255) }
    private fun sp(v: Float) = android.util.TypedValue.applyDimension(android.util.TypedValue.COMPLEX_UNIT_SP, v, resources.displayMetrics)
    private val left = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = sp(14f); typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
    private val right = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { textSize = sp(14f); typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD); fontFeatureSettings = "tnum" }
    private val title = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = sp(15f); typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD) }
    private val sub = TextPaint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(190, 255, 255, 255); textSize = sp(13f) }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)

    private fun tone(t: IslandShow.Tone) = when (t) {
        IslandShow.Tone.PINK -> Color.parseColor("#EC4E86")
        IslandShow.Tone.GREEN -> Color.parseColor("#34C759")
        IslandShow.Tone.AMBER -> Color.parseColor("#F5C542")
        IslandShow.Tone.BLUE -> Color.parseColor("#6AAEFF")
        IslandShow.Tone.CORAL -> Color.parseColor("#E8875F")
    }

    init {
        setOnApplyWindowInsetsListener { _, ins ->
            // An app in full screen (a video) hides the status bar: the island steps aside too.
            onFull(!ins.isVisible(WindowInsets.Type.statusBars()))
            ins
        }
    }

    private fun measure() {
        val m = wm.currentWindowMetrics
        screenW = m.bounds.width()
        val r = m.windowInsets.displayCutout?.boundingRectTop
        if (r != null && !r.isEmpty && r.height() < 160 * d) cut.set(r)
        else { val c = screenW / 2; cut.set(c - (12 * d).toInt(), (8 * d).toInt(), c + (12 * d).toInt(), (32 * d).toInt()) }
        val h = max(cut.height() + 10 * d, 28 * d)
        val w = cut.width() + 2 * 20 * d
        pill.set(cut.exactCenterX() - w / 2, cut.exactCenterY() - h / 2, cut.exactCenterX() + w / 2, cut.exactCenterY() + h / 2)
        barBottom = max(m.windowInsets.getInsetsIgnoringVisibility(WindowInsets.Type.statusBars()).top.toFloat(), pill.bottom)
    }

    private val inset get() = 16 * d
    /** The body for a look (screen pixels) and its corner radius. */
    private fun target(l: IslandShow.Look, out: RectF): Float {
        val cx = cut.exactCenterX()
        val top = barBottom + 4 * d
        return when {
            menuOpen || l is IslandShow.Look.Big -> {
                val w = min(screenW - 24 * d, 380 * d)
                val body = if (menuOpen) 2 * 46 * d + 8 * d else bigBody(l as IslandShow.Look.Big, w)
                out.set(cx - w / 2, top, cx + w / 2, top + body); clampX(out); 24 * d
            }
            l is IslandShow.Look.Found -> {
                val w = min(screenW - 24 * d, 320 * d); val h = 76 * d
                out.set(cx - w / 2, top, cx + w / 2, top + h); clampX(out); 30 * d
            }
            l is IslandShow.Look.Added -> {
                val w = min(screenW - 24 * d, 176 * d)
                out.set(cx - w / 2, top, cx + w / 2, top + w); clampX(out); 38 * d
            }
            l is IslandShow.Look.Compact -> {
                val h = 36 * d
                val rw = if (l.spin) 16 * d else right.measureText(l.right)
                val w = (left.measureText(l.left) + rw + 2 * inset + 18 * d).coerceIn(150 * d, screenW - 16 * d)
                out.set(cx - w / 2, top, cx + w / 2, top + h); clampX(out); h / 2
            }
            else -> { out.set(pill); pill.height() / 2 }
        }
    }
    private fun clampX(r: RectF) { if (r.left < 8 * d) r.offset(8 * d - r.left, 0f); if (r.right > screenW - 8 * d) r.offset(screenW - 8 * d - r.right, 0f) }
    private fun bigBody(b: IslandShow.Look.Big, w: Float): Float {
        val inner = w - 2 * inset
        val subLines = if (b.sub.isBlank()) 0 else min(2, (sub.measureText(b.sub) / inner).toInt() + 1)
        return 12 * d + title.fontSpacing + (if (subLines > 0) 4 * d + subLines * sub.fontSpacing else 0f) + 14 * d
    }

    // ---------- the window ----------
    fun enter() {
        measure()
        cur.set(pill); radius = pill.height() / 2
        place(cur)
        runCatching { wm.addView(this, lp); added = true }.onFailure { Plog.i("island: ${it.javaClass.simpleName}") }
        alphaAll = 0f
        ValueAnimator.ofFloat(0f, 1f).apply { duration = 260; addUpdateListener { alphaAll = it.animatedValue as Float; invalidate() }; start() }
    }
    fun leave() {
        anim?.cancel()
        removeCallbacks(frame)
        ValueAnimator.ofFloat(alphaAll, 0f).apply {
            duration = 180
            addUpdateListener { alphaAll = it.animatedValue as Float; invalidate() }
            addListener(object : android.animation.AnimatorListenerAdapter() { override fun onAnimationEnd(a: android.animation.Animator) { if (added) { added = false; runCatching { wm.removeView(this@IslandView) } } } })
            start()
        }
    }

    /** The window covers the pill and [r] (screen pixels) plus a little room; touchable only when it has something to tap. */
    private fun place(r: RectF) {
        val u = RectF(pill); u.union(r)
        val m = (2 * d).toInt()
        win.set(u.left.toInt() - m, max(0, u.top.toInt() - m), u.right.toInt() + m, u.bottom.toInt() + m)
        lp.x = win.left; lp.y = win.top; lp.width = win.width(); lp.height = win.height()
        val touch = menuOpen || look !is IslandShow.Look.Idle
        lp.flags = if (touch) lp.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv() else lp.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        // The hold menu takes the Back key (every pop up closes on Back); otherwise the island never takes focus.
        lp.flags = if (menuOpen) lp.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() else lp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        if (added) runCatching { wm.updateViewLayout(this, lp) }
    }

    fun show(l: IslandShow.Look) {
        val was = look
        val wasSize = was.javaClass != l.javaClass || (was is IslandShow.Look.Compact && l is IslandShow.Look.Compact && (was.left != l.left || was.tone != l.tone || was.spin != l.spin)) ||
            (was is IslandShow.Look.Big && l is IslandShow.Look.Big && (was.title != l.title || was.sub != l.sub)) ||
            (was is IslandShow.Look.Found && l is IslandShow.Look.Found && was.id != l.id) || (was is IslandShow.Look.Added && l is IslandShow.Look.Added && was.id != l.id)
        look = l
        if (identity(was) != identity(l)) since = SystemClock.uptimeMillis()
        frames()
        if (menuOpen) { invalidate(); return }
        // The Fitness moments grow with a squeeze and a spring, and spring back the same way.
        val springy = fitMoment(l) || fitMoment(was)
        morph(if (springy && wasSize) 680 else if (wasSize) 460 else 200, wasSize, springy && wasSize)
    }
    private fun fitMoment(l: IslandShow.Look) = l is IslandShow.Look.Found || l is IslandShow.Look.Added
    /** What a look is, for the clock of its animation (the tick, the figure's rep, the spinner): a new one starts it again. */
    private fun identity(l: IslandShow.Look): String? = when (l) {
        is IslandShow.Look.Found -> "f:${l.id}"
        is IslandShow.Look.Added -> "a:${l.id}"
        is IslandShow.Look.Compact -> if (l.spin) "spin" else null
        else -> null
    }
    private var since = 0L
    /** Reduced motion (the phone's animation scale is off): no spring, no squeeze, a still figure and a finished tick. */
    private val reduced get() = runCatching { android.provider.Settings.Global.getFloat(svc.contentResolver, android.provider.Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)
    // A frame loop only while something moves (the spinner, a figure doing its rep, the tick drawing): never otherwise.
    private val frame = Runnable { frames(); }
    private fun moving() = added && (fitMoment(look) || (look as? IslandShow.Look.Compact)?.spin == true)
    private fun frames() { removeCallbacks(frame); if (moving()) { invalidate(); postOnAnimation(frame) } }

    private fun morph(ms: Long, fade: Boolean, spring: Boolean = false) {
        measure()
        val nt = RectF(); val nr = target(look, nt)
        if (anim?.isRunning != true && cur == nt) { invalidate(); return }
        anim?.cancel()
        // A new look grows out of the pill: from the body as it is now, or from the pill when it was idle.
        from.set(cur); fromR = radius; to.set(nt); toR = nr
        val u = RectF(from); u.union(to); place(u)
        val red = reduced
        anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = if (spring && red) 160 else ms
            interpolator = if (spring) android.view.animation.LinearInterpolator() else if (ms > 300) OvershootInterpolator(1.1f) else DecelerateInterpolator()
            addUpdateListener { va ->
                val f = if (spring) IslandSpring.grow(va.animatedValue as Float, red) else va.animatedValue as Float
                cur.set(lerp(from.left, to.left, f), lerp(from.top, to.top, f), lerp(from.right, to.right, f), lerp(from.bottom, to.bottom, f))
                if (spring) {
                    // The tiny squeeze first: the island shrinks about its own middle, still hanging from the pill.
                    val q = IslandSpring.squeeze(va.animatedValue as Float, red)
                    if (q != 1f) { val cx = cur.centerX(); val cy = cur.centerY(); val hw = cur.width() * q / 2; val hh = cur.height() * q / 2; cur.set(cx - hw, cy - hh, cx + hw, cy + hh) }
                }
                radius = lerp(fromR, toR, f.coerceIn(0f, 1f))
                content = if (fade) ((va.animatedFraction - 0.45f) / 0.55f).coerceIn(0f, 1f) else 1f
                invalidate()
            }
            addListener(object : android.animation.AnimatorListenerAdapter() {
                override fun onAnimationEnd(a: android.animation.Animator) { cur.set(to); radius = toR; content = 1f; place(to); invalidate() }
            })
            start()
        }
    }
    private fun lerp(a: Float, b: Float, f: Float) = a + (b - a) * f

    // ---------- drawing ----------
    override fun onDraw(c: Canvas) {
        if (alphaAll <= 0f) return
        val ox = -win.left.toFloat(); val oy = -win.top.toFloat()
        val p = RectF(pill); p.offset(ox, oy)
        val r = RectF(cur); r.offset(ox, oy)
        if (pressed) { val s = 0.03f; r.inset(r.width() * s / 2, r.height() * s / 2) }
        bg.alpha = (255 * alphaAll).toInt()
        // The pill, the neck down to the body, and the body: one black shape.
        path.reset()
        path.addRoundRect(p, p.height() / 2, p.height() / 2, android.graphics.Path.Direction.CW)
        if (r.top > p.bottom - 1) {
            val nw = min(p.width() * 0.62f, r.width())
            val cx = p.centerX().coerceIn(r.left + nw / 2, r.right - nw / 2)
            path.addRect(cx - nw / 2, p.centerY(), cx + nw / 2, r.top + min(radius, r.height() / 2), android.graphics.Path.Direction.CW)
        }
        path.addRoundRect(r, radius, radius, android.graphics.Path.Direction.CW)
        path.fillType = android.graphics.Path.FillType.WINDING
        c.drawPath(path, bg)
        val a = (255 * alphaAll * content).toInt()
        when {
            menuOpen -> drawMenu(c, r, a)
            look is IslandShow.Look.Idle -> if ((look as IslandShow.Look.Idle).dot) {
                dot.color = tone(IslandShow.Tone.PINK); dot.alpha = a
                c.drawCircle(p.right - 11 * d, p.centerY(), 3 * d, dot)
            }
            look is IslandShow.Look.Compact -> {
                val l = look as IslandShow.Look.Compact
                val base = r.centerY() - (left.descent() + left.ascent()) / 2
                right.color = tone(l.tone); right.alpha = a
                val rw = if (l.spin) 16 * d else right.measureText(l.right)
                if (l.spin) drawSpinner(c, r.right - inset - 7 * d, r.centerY(), 7 * d, tone(l.tone), a) else c.drawText(l.right, r.right - inset - rw, base, right)
                left.alpha = a
                val lt = TextUtils.ellipsize(l.left, left, max(0f, r.width() - 2 * inset - rw - 18 * d), TextUtils.TruncateAt.END).toString()
                c.drawText(lt, r.left + inset, base, left)
            }
            look is IslandShow.Look.Found -> drawFound(c, r, look as IslandShow.Look.Found, a)
            look is IslandShow.Look.Added -> drawAdded(c, r, look as IslandShow.Look.Added, a)
            look is IslandShow.Look.Big -> {
                val b = look as IslandShow.Look.Big
                val top = r.top + 12 * d
                val x = r.left + inset
                dot.color = tone(b.tone); dot.alpha = a
                c.drawCircle(x + 4 * d, top - title.ascent() * 0.62f, 4 * d, dot)
                title.alpha = a
                c.drawText(TextUtils.ellipsize(b.title, title, r.width() - 2 * inset - 16 * d, TextUtils.TruncateAt.END).toString(), x + 16 * d, top - title.ascent(), title)
                if (b.sub.isNotBlank()) {
                    sub.alpha = (190 * alphaAll * content).toInt()
                    val layout = android.text.StaticLayout.Builder.obtain(b.sub, 0, b.sub.length, sub, (r.width() - 2 * inset).toInt().coerceAtLeast(1))
                        .setMaxLines(2).setEllipsize(TextUtils.TruncateAt.END).build()
                    c.save(); c.translate(x, top + title.fontSpacing + 4 * d); layout.draw(c); c.restore()
                }
            }
        }
    }

    // ---------- the Fitness moments (V1.60) ----------
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    private val arcBox = RectF()
    /** A spinner: three quarters of a ring turning once a second. */
    private fun drawSpinner(c: Canvas, cx: Float, cy: Float, rad: Float, color: Int, a: Int) {
        stroke.color = color; stroke.alpha = a; stroke.strokeWidth = 2.2f * d
        arcBox.set(cx - rad, cy - rad, cx + rad, cy + rad)
        c.drawArc(arcBox, (SystemClock.uptimeMillis() % 900) / 900f * 360f, 270f, false, stroke)
    }
    /** The little stick figure doing its rep inside the square (x, y, size), white on the island's black. */
    private fun drawFig(c: Canvas, fig: IslandFig.Fig, x: Float, y: Float, size: Float, a: Int, age: Long) {
        val pose = IslandFig.blend(fig, IslandFig.repK(age, reduced))
        val k = size / 100f
        stroke.color = Color.WHITE; stroke.alpha = a; stroke.strokeWidth = max(1.6f * d, size * 0.045f)
        for (ln in IslandFig.lines(pose)) c.drawLine(x + ln[0] * k, y + ln[1] * k, x + ln[2] * k, y + ln[3] * k, stroke)
        c.drawCircle(x + pose[2 * IslandFig.HEAD] * k, y + pose[2 * IslandFig.HEAD + 1] * k, fig.hr * k, stroke)
    }
    /** A green ring that sweeps round, then a check that draws itself (reduced motion: finished). */
    private fun drawTick(c: Canvas, cx: Float, cy: Float, rad: Float, age: Long, a: Int) {
        val (ring, check) = IslandSpring.tick(age, reduced)
        val green = tone(IslandShow.Tone.GREEN)
        stroke.color = green; stroke.alpha = a; stroke.strokeWidth = max(2f * d, rad * 0.14f)
        arcBox.set(cx - rad, cy - rad, cx + rad, cy + rad)
        c.drawArc(arcBox, -90f, 360f * ring, false, stroke)
        if (check <= 0f) return
        val p0x = cx - rad * 0.42f; val p0y = cy + rad * 0.04f
        val p1x = cx - rad * 0.10f; val p1y = cy + rad * 0.36f
        val p2x = cx + rad * 0.46f; val p2y = cy - rad * 0.32f
        val first = (check / 0.4f).coerceIn(0f, 1f); val second = ((check - 0.4f) / 0.6f).coerceIn(0f, 1f)
        c.drawLine(p0x, p0y, lerp(p0x, p1x, first), lerp(p0y, p1y, first), stroke)
        if (second > 0f) c.drawLine(p1x, p1y, lerp(p1x, p2x, second), lerp(p1y, p2y, second), stroke)
    }
    private fun drawFound(c: Canvas, r: RectF, f: IslandShow.Look.Found, a: Int) {
        val age = SystemClock.uptimeMillis() - since
        val box = 52 * d
        val bx = r.left + 16 * d
        if (f.fig != null) drawFig(c, f.fig, bx, r.centerY() - box / 2, box, a, age)
        val tr = 13 * d
        val tx = r.right - inset - tr
        val textL = if (f.fig != null) bx + box + 12 * d else r.left + inset
        title.alpha = a
        val name = TextUtils.ellipsize(f.name, title, max(0f, tx - tr - 10 * d - textL), TextUtils.TruncateAt.END).toString()
        c.drawText(name, textL, r.centerY() - (title.descent() + title.ascent()) / 2, title)
        drawTick(c, tx, r.centerY(), tr, age, a)
    }
    private fun drawAdded(c: Canvas, r: RectF, f: IslandShow.Look.Added, a: Int) {
        val age = SystemClock.uptimeMillis() - since
        val cx = r.centerX()
        var y = r.top + 16 * d
        if (f.fig != null) { val box = 54 * d; drawFig(c, f.fig, cx - box / 2, y, box, a, age); y += box + 12 * d }
        else y += 14 * d
        val rad = if (f.fig != null) 25 * d else 34 * d
        drawTick(c, cx, y + rad, rad, age, a)
        title.alpha = a
        val words = TextUtils.ellipsize(f.title, title, r.width() - 2 * inset, TextUtils.TruncateAt.END).toString()
        c.drawText(words, cx - title.measureText(words) / 2, r.bottom - 18 * d, title)
    }

    private val rows = arrayOf("Hide for 30 minutes" to "hide", "Settings" to "settings")
    private fun rowRect(r: RectF, i: Int) = RectF(r.left + 6 * d, r.top + 4 * d + i * 46 * d, r.right - 6 * d, r.top + 4 * d + (i + 1) * 46 * d)
    private fun drawMenu(c: Canvas, r: RectF, a: Int) {
        title.alpha = a
        rows.forEachIndexed { i, (words, _) ->
            val rr = rowRect(r, i)
            if (i > 0) { ring.alpha = (46 * alphaAll).toInt(); c.drawLine(rr.left + 10 * d, rr.top, rr.right - 10 * d, rr.top, ring) }
            c.drawText(words, rr.left + 12 * d, rr.centerY() - (title.descent() + title.ascent()) / 2, title)
        }
    }

    // ---------- touch ----------
    private var pressed = false
    private var downAt = 0L
    private val holdR = Runnable { pressed = false; performHapticFeedback(HapticFeedbackConstants.LONG_PRESS); openMenu(true) }
    private val menuTimeout = Runnable { openMenu(false) }
    private fun openMenu(on: Boolean) {
        if (menuOpen == on) return
        menuOpen = on
        removeCallbacks(menuTimeout)
        if (on) { postDelayed(menuTimeout, 6_000); isFocusableInTouchMode = true }
        morph(380, true)
        if (on) post { requestFocus() }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_OUTSIDE -> { if (menuOpen) openMenu(false); return false }
            MotionEvent.ACTION_DOWN -> { pressed = true; downAt = e.eventTime; invalidate(); if (!menuOpen) postDelayed(holdR, 450) }
            MotionEvent.ACTION_CANCEL -> { pressed = false; removeCallbacks(holdR); invalidate() }
            MotionEvent.ACTION_UP -> {
                removeCallbacks(holdR)
                val was = pressed
                pressed = false; invalidate()
                if (menuOpen) {
                    val r = RectF(cur); r.offset(-win.left.toFloat(), -win.top.toFloat())
                    val hit = rows.indices.firstOrNull { rowRect(r, it).contains(e.x, e.y) }
                    if (hit != null && e.eventTime - downAt < 450) { performHapticFeedback(HapticFeedbackConstants.CONFIRM); openMenu(false); onMenu(rows[hit].second) }
                    else if (hit == null) openMenu(false)
                } else if (was) {
                    performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                    val open = when (val l = look) { is IslandShow.Look.Compact -> l.open; is IslandShow.Look.Big -> l.open; is IslandShow.Look.Found -> l.open; is IslandShow.Look.Added -> l.open; else -> "list" }
                    onTap(open)
                }
            }
        }
        return true
    }
    override fun dispatchKeyEvent(e: KeyEvent): Boolean {
        if (menuOpen && (e.keyCode == KeyEvent.KEYCODE_BACK || e.keyCode == KeyEvent.KEYCODE_ESCAPE)) { if (e.action == KeyEvent.ACTION_UP) openMenu(false); return true }
        return super.dispatchKeyEvent(e)
    }
}
