package com.cincee.ps.gos

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.MutableContextWrapper
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * The one WebView PS GOS runs (the same web app as the website and PS on the Mac). It lives for the
 * process: the screen borrows it while open, and a background check uses it headless when the
 * screen is closed, so there is never a second copy of the vault in memory.
 *
 * The page is served from https://appassets.androidplatform.net/client/ out of the APK's own
 * assets (WebViewAssetLoader): a secure origin, so WebCrypto works, and every response carries the
 * same strict Content-Security-Policy as cincee.com/client.
 */
@SuppressLint("StaticFieldLeak")
object WebHost {
    const val ORIGIN = "https://appassets.androidplatform.net"
    const val HOME = "$ORIGIN/client/"
    /** The one site the page may show inside a frame: the privacy friendly YouTube host, for the Goals
     *  "How it works" video. It loads only once that pop-up opens; never as the page itself. */
    const val VIDEO_FRAME_HOST = "www.youtube-nocookie.com"
    private val main = Handler(Looper.getMainLooper())
    private var ctxWrap: MutableContextWrapper? = null
    var view: WebView? = null; private set
    private var proxy: JavaScriptReplyProxy? = null
    private var ready = false
    private val queue = ArrayList<String>()
    // Read from the bridge thread and workers too.
    @Volatile var activity: MainActivity? = null; private set
    @Volatile var unlocked = false; private set
    @Volatile private var pulseDone: CompletableDeferred<Boolean>? = null
    private lateinit var app: Context

    private val SQUAD_HUB = "https://zxhvchchfrkfqxuyorqo.supabase.co"

    private fun csp(): String {
        val sb = BuildConfig.SUPABASE_URL
        return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob: https://*.giphy.com; " +
            // plus the G Squad hub (V1.40): its one edge function over https, never the vault (web src/squad/hub.ts)
            "media-src 'self' blob:; connect-src 'self' $sb ${sb.replace("https", "wss")} $SQUAD_HUB; worker-src 'self'; frame-src blob: https://$VIDEO_FRAME_HOST; " +
            "frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'"
    }

    private val headers get() = mapOf(
        "Content-Security-Policy" to csp(),
        "X-Content-Type-Options" to "nosniff",
        "Referrer-Policy" to "no-referrer",
        "Cross-Origin-Opener-Policy" to "same-origin",
        "Permissions-Policy" to CameraPolicy.header(),   // PS 1.60: camera=(self), the microphone and location stay off
        "Cache-Control" to "no-cache",
    )

    private fun mime(p: String) = when (p.substringAfterLast('.').lowercase()) {
        "html" -> "text/html"; "js", "mjs" -> "text/javascript"; "css" -> "text/css"; "json" -> "application/json"
        "svg" -> "image/svg+xml"; "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"; "webp" -> "image/webp"; "ico" -> "image/x-icon"
        "woff2" -> "font/woff2"; "woff" -> "font/woff"; "mp3" -> "audio/mpeg"; "wav" -> "audio/wav"; "mp4" -> "video/mp4"; "webmanifest" -> "application/manifest+json"
        else -> "application/octet-stream"
    }

    /** /client/... from the bundled web build; routes without a file name get index.html (one page app). */
    private fun clientFiles(c: Context) = WebViewAssetLoader.PathHandler { path ->
        // The developer's videos and the Soundboard's files are served in shouldInterceptRequest below (they need the Range header); never from here.
        if (path.startsWith("bg/") || path.startsWith("media/")) return@PathHandler WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        val p = if (path.isEmpty() || !path.substringAfterLast('/').contains('.')) "index.html" else path
        if (p.contains("..")) return@PathHandler null
        val stream = runCatching { c.assets.open("client/$p") }.getOrNull()
            ?: return@PathHandler WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))
        val m = mime(p)
        WebResourceResponse(m, if (m.startsWith("text/") || m.endsWith("json") || m.endsWith("xml")) "utf-8" else null, 200, "OK", headers, stream)
    }

    @SuppressLint("SetJavaScriptEnabled")
    fun obtain(c: Context): WebView {
        app = c.applicationContext
        view?.let { return it }
        val wrap = MutableContextWrapper(app)
        ctxWrap = wrap
        val loader = WebViewAssetLoader.Builder().addPathHandler("/client/", clientFiles(app)).build()
        val w = WebView(wrap)
        w.setBackgroundColor(Color.parseColor("#120B10"))
        w.isVerticalScrollBarEnabled = false
        w.isHorizontalScrollBarEnabled = false
        w.overScrollMode = WebView.OVER_SCROLL_NEVER
        with(w.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false   // background videos are muted loops
            setSupportMultipleWindows(false)           // window.open lands in shouldOverrideUrlLoading
            setGeolocationEnabled(false)
            safeBrowsingEnabled = false                // nothing goes to Google; Vanadium does not use it anyway
            textZoom = 100
            // V1.47 (the developer: the app "a bit laggy", Fitness opening and closing "very laggy"): PS is the whole screen and
            // moves a lot (panes slide sideways, Fitness grows out of its button, sheets rise), so the WebView draws
            // a margin just beyond the screen ahead of time instead of while the motion runs.
            offscreenPreRaster = true
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(w, "gosNative", setOf(ORIGIN)) { _, message: WebMessageCompat, origin: Uri, isMainFrame, reply ->
                if (!isMainFrame || origin.toString().trimEnd('/') != ORIGIN) return@addWebMessageListener
                proxy = reply
                // The main thread only hands the message over and returns (2 Nov 2026 freeze: the token was
                // sealed with the Keystore right here while keystore2 was busy). A video piece is a 2 MB
                // message and goes to the video thread; everything else to the bridge thread (Bridge.kt).
                // A Soundboard squad piece (up to 1 MB as base64) goes straight to the Soundboard's own thread (Soundboard.kt).
                message.data?.let { if (it.startsWith(BG_PUT)) disk.execute { bgPut(it) } else if (it.startsWith(SB_PUT)) Soundboard.onRaw(app, it) else dispatcher.onRaw(it) }
            }
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, r: WebResourceRequest): WebResourceResponse? {
                // The developer's background videos, with byte ranges (BgStore.serve). The asset loader drops request headers.
                val p = r.url.path
                if (r.url.scheme == "https" && r.url.host == "appassets.androidplatform.net" && p != null && p.startsWith(BG_PATH)) {
                    val range = r.requestHeaders?.entries?.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
                    return BgStore.serve(app, p.removePrefix(BG_PATH), range, headers)
                }
                // The Soundboard's files (V1.47), with byte ranges, from PS's own folder or the folder the developer picked (Soundboard.serve).
                if (r.url.scheme == "https" && r.url.host == "appassets.androidplatform.net" && p != null && p.startsWith(MEDIA_PATH)) {
                    val range = r.requestHeaders?.entries?.firstOrNull { it.key.equals("Range", ignoreCase = true) }?.value
                    return Soundboard.serve(app, p.removePrefix(MEDIA_PATH), range, headers)
                }
                return loader.shouldInterceptRequest(r.url)
            }
            override fun shouldOverrideUrlLoading(v: WebView, r: WebResourceRequest): Boolean {
                if (r.url.host == "appassets.androidplatform.net") return false
                // The Goals video plays inside its frame; a tap on a link inside the player still opens outside below.
                if (!r.isForMainFrame && !r.hasGesture() && r.url.scheme == "https" && r.url.host == VIDEO_FRAME_HOST) return false
                // Links out (Gmail threads, call links, previews) open in their own app; opening is not sending.
                if (r.url.scheme == "https" || r.url.scheme == "mailto") runCatching {
                    val i = Intent(Intent.ACTION_VIEW, r.url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    (activity ?: app).startActivity(i)
                }
                return true
            }
            // No reset on page start: the system can report it after the new page already said "ready".
            // A reloaded page says "ready" again, which replaces the proxy and resends everything.
            override fun onRenderProcessGone(v: WebView, d: RenderProcessGoneDetail): Boolean {
                Plog.i("web renderer gone (crash=${d.didCrash()}): rebuilding")
                rebuild()
                return true
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(v: WebView, cb: ValueCallback<Array<Uri>>, p: FileChooserParams): Boolean {
                val a = activity ?: run { cb.onReceiveValue(null); return true }
                a.chooseFile(cb, p.acceptTypes)
                return true
            }
            // V1.55: the camera for the page's own QR scanner, and nothing else: only PS's own page (the asset host), only
            // video (never the microphone), and only while the screen is up. Everything else is refused.
            override fun onPermissionRequest(r: android.webkit.PermissionRequest) {
                val a = activity
                if (a == null || !CameraPolicy.allow(r.origin?.scheme, r.origin?.host, r.resources.toList(), a.isShown)) { r.deny(); return }
                a.runOnUiThread { a.cameraFor(r) }
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        view = w
        w.loadUrl(HOME)
        return w
    }

    private fun rebuild() {
        val a = activity
        view?.let { (it.parent as? android.view.ViewGroup)?.removeView(it); it.destroy() }
        view = null; ready = false; proxy = null
        if (a != null) a.mountWeb() else pulseDone?.complete(false)
    }

    // ---------- the screen borrows the WebView ----------
    /** PS 1.65 Low power mode: Android Battery Saver on or off (PowerManager), for the page's own switch. */
    private fun lowPowerOs(c: Context): JSONObject {
        val pm = c.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
        return JSONObject().put("type", "lowpowerOs").put("on", pm?.isPowerSaveMode == true)
    }
    private var saverWatch = false
    /** Battery Saver changes while PS runs: the page hears it at once (registered once, on the app context). */
    private fun watchSaver(c: Context) {
        if (saverWatch) return
        saverWatch = true
        c.registerReceiver(object : android.content.BroadcastReceiver() {
            override fun onReceive(x: Context, i: Intent) { post(lowPowerOs(x.applicationContext)) }
        }, android.content.IntentFilter(android.os.PowerManager.ACTION_POWER_SAVE_MODE_CHANGED))
    }
    fun attach(a: MainActivity): WebView {
        activity = a
        watchSaver(a.applicationContext)
        val w = obtain(a)
        ctxWrap?.baseContext = a      // pop-ups, selects and the file chooser need a real activity
        w.onResume(); w.resumeTimers()
        return w
    }
    /** PS 1.70: PS is on screen now (the page draws the day countdown's card itself then, DayEnd.kt). */
    @Volatile var shownNow = false; private set
    fun visible(on: Boolean) {
        shownNow = on
        if (!on && ::app.isInitialized) DayEnd.pageHidden(app)
        post(JSONObject().put("type", "visible").put("on", on))
        if (on) { view?.onResume(); view?.resumeTimers(); sendPerms() } else { view?.onPause() }
    }
    fun detach(a: MainActivity) {
        if (activity !== a) return
        activity = null
        ctxWrap?.baseContext = app
        (view?.parent as? android.view.ViewGroup)?.removeView(view)
    }

    // ---------- the threads ----------
    /** Background videos: their disk and Keystore work, one at a time, never on the main thread. */
    private val disk = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "ps-video") }
    /**
     * The bridge thread: every message from the page is read and handled here, in order, and so is the
     * Keystore and file work of the fingerprint steps (bg). Its own thread, so a token or a schedule never
     * waits behind a queue of video pieces (the Keystore gate still takes them one at a time).
     */
    private val bridge = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "ps-bridge") }
    private val dispatcher = BridgeDispatcher(java.util.concurrent.Executor { main.post(it) }, bridge, ::onMessage) { type, e ->
        Plog.i("bridge: $type failed (${e.javaClass.simpleName})")
    }
    /** Runs `f` on the bridge thread, after the page messages already waiting there. For Keystore, files and system calls. */
    fun bg(f: () -> Unit) { bridge.execute { runCatching(f).onFailure { Plog.i("bridge work failed: ${it.javaClass.simpleName}") } } }
    private fun onMain(f: () -> Unit) { main.post(f) }

    // ---------- messages to the page (always answered from the main thread, never waited on) ----------
    fun post(o: JSONObject) { val s = o.toString(); main.post { if (ready && proxy != null) proxy?.postMessage(s) else queue.add(s) } }
    /** The page is up and takes messages now (main thread). V1.65 Just tomorrow keeps a choice for a later page only when not. */
    fun pageUp(): Boolean = ready && proxy != null
    fun sendPrefs() = post(JSONObject().put("type", "prefs").put("prefs", Prefs.json(app)))
    fun sendPerms() { if (::app.isInitialized) { val c = app; Work.post { post(JSONObject().put("type", "perms").put("perms", Prefs.perms(c))) } } }

    /** The page said "ready" (bridge thread): the file, prefs and system reads here, the sending on the main thread. */
    private fun hello() {
        val c = app
        val hello = JSONObject().put("type", "hello").put("version", BuildConfig.VERSION_NAME).put("keyword", BuildConfig.KEYWORD).put("build", BuildConfig.VERSION_CODE)
            .put("remembered", Remember.exists(c)).put("prefs", Prefs.json(c)).put("perms", Prefs.perms(c)).put("visible", activity?.isShown == true)
            .put("device", DeviceName.of(android.os.Build.MANUFACTURER, android.os.Build.MODEL)).toString()   // V1.56: the Mac's phone picker
        val net = JSONObject().put("type", "net").put("online", Net.online(c)).toString()
        val update = JSONObject().put("type", "update").put("update", Updater.state).toString()
        val saver = lowPowerOs(c).toString()   // PS 1.65 Low power mode: Android Battery Saver now (web src/lowpower.ts)
        onMain {
            ready = true
            val q = queue.toList(); queue.clear()
            q.forEach { s -> proxy?.postMessage(s) }
            proxy?.postMessage(hello)
            activity?.sendInsets()
            proxy?.postMessage(net)
            proxy?.postMessage(update)
            proxy?.postMessage(saver)
        }
        Receivers.flushPending(c)
    }

    // ---------- messages from the page ----------
    /** On the bridge thread, except the BridgeRoutes.MAIN types (the screen, Fitness, Gym), which never touch the Keystore or a file. */
    private fun onMessage(type: String, m: JSONObject) {
        val c = app
        if (type.startsWith("sleep:")) Plog.i("sleep: got $type (running=${Sleep.running(c)})")   // V1.41: each Sleep mode message in the log
        if (TgBot.handle(c, type, m, ::post)) return   // tg:* Add Telegram Bot (TgBot.kt, V1.47): the key in the Keystore, the relay on its own threads
        if (GymScan.handle(c, type, m, ::post)) return   // gymscan:* Gym scan (GymScan.kt, V1.59): reads a label on its own thread
        if (ReceiptScan.handle(c, type, m, ::post)) return   // receiptscan:* Receipt scan (ReceiptScan.kt, PS 1.65): reads a receipt on its own thread
        when (type) {
            "ready" -> hello()
            "log" -> Plog.i("web: " + m.optString("text"))
            "haptic" -> activity?.haptic(m.optString("kind"))
            "ringer:get" -> post(Ringer.answer(c))   // V1.56 the Edit mode sounds follow silent mode (Ringer.kt)
            "kb:show" -> activity?.showKeyboard()   // Add task from the widget or a notification (src/gos/keyboard.ts)
            "remember:save" -> activity?.rememberSave(m.optString("username"), m.optString("auth"), m.optString("kek"))
            "remember:unlock" -> activity?.rememberUnlock()
            "remember:forget" -> { Remember.forget(c); post(JSONObject().put("type", "rememberStatus").put("exists", false)) }
            // Local first (LocalKey.kt, V1.44): the local vault's key, a Keystore call, so the bridge thread only.
            "localkey:get", "localkey:create", "localkey:allow", "localkey:forget" -> {
                val req = m.optString("req")
                if (Regex("^[A-Za-z0-9_-]{4,40}$").matches(req)) post(LocalKey.answer(c, type.removePrefix("localkey:")).put("type", "localkey").put("req", req))
            }
            "file:save" -> post(BackupSave.save(c, m.optString("name"), m.optString("text")))   // Export my data (LocalKey.kt)
            // The access token, sealed by the device key: a Keystore call, so the bridge thread only.
            "session" -> Session.save(c, m.optString("access").takeIf { it.isNotEmpty() && it != "null" }, m.optLong("exp"))
            "status" -> {
                unlocked = m.optBoolean("unlocked")
                if (!unlocked && !m.optBoolean("busy")) Quiet.locked(c)
            }
            "tasks" -> { Quiet.tasks(c, m); PsWidget.update(c, m) }
            "schedule" -> Alarms.set(c, m.optJSONArray("meetings") ?: JSONArray())
            "meetCard" -> m.optJSONObject("card")?.let { Notifier.card(c, it) }
            "dnd" -> Dnd.set(c, m.optJSONObject("state"))
            "features" -> Features.receive(c, m.optJSONObject("on"))   // V1.61: every feature's answer from the page (web src/featuresync.ts), kept for Remind.kt
            "cardHide" -> Notifier.cancelCard(c, m.optString("id"))
            "remindNext" -> Reminds.next(c, m.optLong("at"))
            "gymPlan" -> m.optJSONObject("plan")?.let { Gym.setPlan(c, it) }   // the gym reminder (Gym.kt, web src/gymwatch.ts)
            "dayPlan" -> m.optJSONObject("plan")?.let { DayEnd.setPlan(c, it) }   // PS 1.70 the day countdown while PS is closed (DayEnd.kt, web src/daycount.ts)
            // Sleep mode (Sleep.kt, web src/sleepmode/engine.ts): the clock over the lock screen and its alarms.
            "sleep:start" -> m.optJSONObject("plan")?.let { Sleep.start(c, it) }
            "sleep:plan" -> m.optJSONObject("plan")?.let { Sleep.setPlan(c, it) }
            "sleep:stop" -> Sleep.stop(c, "page")
            "sleep:get" -> Sleep.onGet(c)
            "sleep:wokeSaved" -> Sleep.wokeSaved(c)
            "sleep:customiseSeen" -> Sleep.customiseSeen(c)
            "sleep:settingsSeen" -> Sleep.settingsSeen(c)                                      // V1.47 the gear on the clock
            "sleep:alarms" -> Sleep.setAlarms(c, m.optJSONObject("plan"))                       // V1.47 alarms with Sleep mode off
            "sleep:break" -> Sleep.startBreak(c, m.optLong("until"), m.optJSONObject("plan"))
            "sleep:breakEnd" -> Sleep.endBreak(c, "page")
            "sleep:breakSeen" -> Sleep.breakSeen(c)
            "sleep:sound:get" -> Sleep.postSound(c)                  // V1.44 your own sound and Test (Sleep.kt)
            "sleep:sound:save" -> Sleep.saveOwn(c, m.optString("name"), m.optDouble("secs", 0.0), m.optString("b64"))
            "sleep:sound:remove" -> Sleep.removeOwn(c)
            "sleep:test" -> Sleep.startTest(c, m.optString("style"), SleepClock.okLevel(m.opt("level")), m.optLong("ms", 10_000), m.optString("track").takeIf { ListClock.okId(it) })
            // V1.47 alarm playlists (AlarmList.kt): the files' work on the bridge thread, never the main one.
            "sleep:list:get" -> AlarmListStore.post(c)
            "sleep:list:put" -> AlarmListStore.put(c, m.optString("id"), m.optString("ext").lowercase(), m.optInt("i", -1), m.optInt("n", 0), m.optString("b64"))
            "sleep:list:remove" -> AlarmListStore.remove(c, m.optString("id"))
            "sleep:list:read" -> AlarmListStore.read(c, m.optString("id"), m.optLong("off", 0), m.optInt("len", 1 shl 20))
            "sleep:list:keep" -> AlarmListStore.keep(c, (0 until (m.optJSONArray("ids")?.length() ?: 0)).mapNotNull { i -> m.optJSONArray("ids")?.optString(i)?.takeIf { ListClock.okId(it) } }.toSet())
            "sleep:testStop" -> Sleep.stopTest(c)
            "sleep:auth" -> SleepOwner.fromPage(activity, m)   // V1.65 the owner check for Settings in the app
            "sleep:wakeInSeen" -> Sleep.wakeInSeen(c)   // V1.43 "Wake me up in" set on the clock reached the page
            // The Annoying 15 min reminder (Remind.kt, web src/core/remind.ts): its own thread, never the main one.
            "remPlan" -> m.optJSONObject("plan")?.let { Remind.setPlan(c, it) }
            "rem:test" -> Remind.test(c, m.optJSONObject("item"))
            "rem:testStop" -> Remind.testStop(c)
            "rem:sound:get" -> Remind.soundGet(c)
            "rem:sound:save" -> Remind.soundSave(c, m.optString("id"), m.optString("name"), m.optDouble("secs", 0.0), m.optString("b64"))
            "rem:sound:remove" -> Remind.soundRemove(c, m.optString("id"))
            "aysMeeting" -> Ays.inMeeting = m.optBoolean("on")
            // V1.59 the Dynamic island (Island.kt): the same state the Mac's island gets (web src/island.ts).
            "island" -> Island.fromPage(c, m.optJSONObject("state"))
            "islandRule" -> Island.setRed(c, m.optBoolean("red", true))
            // The Soundboard (Soundboard.kt, V1.47): handed to its own threads at once, never the main thread.
            in Soundboard.TYPES -> Soundboard.onMessage(c, type, m)
            // Screen time now (V1.31): the page asks once its vault is open, so the count sent 1.5 s after
            // opening PS is not lost while the page is still signing in. Read on the work thread.
            "screentime:get" -> Work.post { ScreenTime.today(c)?.let { post(it) } }
            "prefs:set" -> { m.optJSONObject("prefs")?.let { Prefs.set(c, it); applyPrefs(it) }; sendPrefs() }
            "perm" -> activity?.openPermission(m.optString("which"))
            "update:check" -> Updater.check(c, manual = true)
            "update:every" -> Updater.setEvery(c, m.optInt("min", 5))
            "update:install" -> Updater.install(c)
            "back:none" -> activity?.moveTaskToBack(true)
            "edgeGuard" -> activity?.setEdgeGuard(m.optDouble("top", 0.0), m.optDouble("bottom", 0.0))   // PS 1.73 swipe leak (EdgeGuard.kt)
            "lock" -> { Quiet.locked(c); if (m.optBoolean("byHand")) Prefs.setHandLocked(c, true) }
            "nuke" -> {   // the rule book (Nuke.kt): the flag, the keys and the files here, the Gone screen on the main thread
                Nuke.run(c); post(JSONObject().put("type", "rememberStatus").put("exists", false))
                onMain { Nuke.gone(c, activity) }
            }
            "bg:list" -> { val keep = m.optJSONArray("keep")
                disk.execute { val ids = runCatching { BgStore.keep(c, keep) }.getOrDefault(emptyList())
                    val partial = runCatching { BgStore.partial(c, keep) }.getOrDefault(JSONObject())
                    post(JSONObject().put("type", "bg:have").put("ids", JSONArray(ids)).put("partial", partial)) } }
            "pulse:done" -> pulseDone?.complete(m.optBoolean("ok"))
            // The Fitness tab: rest timer and screen wake (Fitness.kt, contract in fitness/android-bridge.md).
            "fitness:start", "fitness:add", "fitness:skip", "fitness:cancel", "fitness:awake", "fitness:get" -> Fitness.onMessage(c, m)
            // Remote restart, shut down and lock of the developer's Macs (CmdKey.kt): the key, and a fingerprint per command.
            "cmdKey:get" -> { val r = runCatching { CmdKey.info(c) }.getOrNull()
                post(JSONObject().put("type", "cmdKey").apply { if (r != null) put("device", r.getString("device")).put("pub", r.getString("pub")) else put("error", "No key") }) }
            "cmd:sign" -> activity?.signCmd(m.optString("req"), m.optString("body"), m.optString("toName"))
                ?: post(JSONObject().put("type", "cmd:signed").put("req", m.optString("req")).put("error", "Open PS app first"))
        }
    }

    // Video pieces are read, sealed and written on their own thread, in order: on the main thread a 1.5 MB
    // piece at a time froze PS ("not responding", 28 Oct 2026, the first time the phone downloaded videos).
    // The page's JSON.stringify always puts "type" first, so the prefix tells them apart unread.
    private const val BG_PUT = "{\"type\":\"bg:put\""
    private const val BG_PATH = "/client/bg/"
    private const val SB_PUT = "{\"type\":\"sb:put\""
    private const val MEDIA_PATH = "/client/media/"
    private fun bgPut(raw: String) {
        val m = runCatching { JSONObject(raw) }.getOrNull() ?: return
        runCatching { BgStore.put(app, m.optString("id"), m.optInt("index"), m.optInt("total"), m.optString("data")) }
            .onFailure { Plog.i("bg put failed: ${it.javaClass.simpleName}") }
    }

    private fun applyPrefs(p: JSONObject) {
        val c = app
        if (p.has("background")) { Pulse.schedule(c); if (!Prefs.background(c)) Remember.dropBackground(c) }
        if (p.has("stay") && !Prefs.stay(c)) Remember.dropStay(c)
        if (p.has("notification") || p.has("bubble") || p.has("ays")) { Quiet.sync(c); WatchService.sync(c) }
        if (p.has("island") || p.has("live") || p.has("background")) { LiveService.sync(c); Quiet.sync(c) }
        if (p.optBoolean("island") && !android.provider.Settings.canDrawOverlays(c)) onMain { activity?.askIsland(force = true) }
        if (p.optBoolean("tile")) onMain { activity?.offerTile() }
        if (p.optBoolean("widget")) onMain { activity?.offerWidget() }
        if (p.optBoolean("bubble") && !android.provider.Settings.canDrawOverlays(c)) onMain { activity?.askIsland(force = true) }
    }

    // ---------- background check ----------
    /** Wakes the page (headless if the screen is closed), lets it sync once and report, then lets go. */
    suspend fun pulse(c: Context, keys: JSONObject?): Boolean = withContext(Dispatchers.Main) {
        app = c.applicationContext
        val headless = view == null
        obtain(app)
        view?.resumeTimers()
        val done = CompletableDeferred<Boolean>()
        pulseDone = done
        val msg = JSONObject().put("type", "pulse").put("keep", Prefs.stay(c) && !Prefs.handLocked(c))
        keys?.let { k -> for (n in listOf("username", "auth", "kek")) msg.put(n, k.optString(n)) }
        post(msg)
        val ok = withTimeoutOrNull(90_000) { done.await() } ?: false
        pulseDone = null
        if (activity == null) {
            if (headless) { view?.destroy(); view = null; ready = false; proxy = null; queue.clear() }
            else view?.pauseTimers()
        }
        ok
    }
}

/** Network state, as GrapheneOS reports it (with PS's Network permission off it says "down"). */
object Net {
    fun online(c: Context): Boolean {
        val cm = c.getSystemService(android.net.ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
