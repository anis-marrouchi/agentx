package dev.agentx.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.telecom.CallAudioState
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.math.abs

// Talk to AgentX (#1636, step 2): talk to an agent through a Bluetooth
// watch or headset, with no phone number.
//
// The phone rings the watch with a self-managed call (Telecom), the way a
// WhatsApp call does; step 1 found that only the incoming direction puts
// the watch's microphone on the call on every phone tried. Once answered,
// each turn is: a beep, the owner speaks, POST /api/app/voice/transcribe,
// POST /api/app/chat (the phone app's own Chat, so the conversation shows
// there too), then the answer in the agent's voice (POST
// /api/app/voice/speak) or the phone's own voice. Hanging up on the watch
// ends the call. TalkService holds the microphone while the call lasts.

/** What the call is doing, for the Talk screen and the notification. */
object TalkState {
    private const val TAG = "AgentXTalk"
    private val main = Handler(Looper.getMainLooper())
    @Volatile var text: String = ""; private set
    @Volatile var active: Boolean = false; private set
    var listener: (() -> Unit)? = null

    fun set(line: String, ctx: Context? = null, active: Boolean = this.active) {
        Log.i(TAG, line)
        text = line
        this.active = active
        if (ctx != null && active) TalkService.notify(ctx, line)
        main.post { listener?.invoke() }
    }
}

/** The app's phone account: self-managed, so it needs no SIM and no number. */
object TalkAccount {
    fun handle(ctx: Context) = PhoneAccountHandle(ComponentName(ctx, TalkConnectionService::class.java), "agentx-talk")

    fun register(ctx: Context) {
        val extras = Bundle()
        // As in the spike that passed: lets the phone's in-call services,
        // Bluetooth's among them on some phones, see the call.
        if (Build.VERSION.SDK_INT >= 29) extras.putBoolean(PhoneAccount.EXTRA_ADD_SELF_MANAGED_CALLS_TO_INCALLSERVICE, true)
        val account = PhoneAccount.builder(handle(ctx), ctx.getString(R.string.app_name))
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
            .setSupportedUriSchemes(listOf(PhoneAccount.SCHEME_SIP))
            .setExtras(extras)
            .build()
        ctx.getSystemService(TelecomManager::class.java).registerPhoneAccount(account)
    }

    val address: Uri = Uri.fromParts(PhoneAccount.SCHEME_SIP, "agentx", null)
}

/** Holds the microphone (a foreground service) and rings the watch. */
class TalkService : Service() {
    companion object {
        const val ACTION_START = "dev.agentx.phone.talk.START"
        const val ACTION_ANSWER = "dev.agentx.phone.talk.ANSWER"
        const val ACTION_HANG_UP = "dev.agentx.phone.talk.HANG_UP"
        private const val CHANNEL = "talk"
        private const val ID = 1636
        private const val RING_MS = 45_000L

        fun start(ctx: Context) {
            val i = Intent(ctx, TalkService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun hangUp(ctx: Context) {
            TalkConnection.current?.end(DisconnectCause.LOCAL) ?: ctx.stopService(Intent(ctx, TalkService::class.java))
        }

        fun notify(ctx: Context, text: String) {
            try { ctx.getSystemService(NotificationManager::class.java).notify(ID, build(ctx, text)) } catch (_: Exception) {}
        }

        private fun build(ctx: Context, text: String): Notification {
            val nm = ctx.getSystemService(NotificationManager::class.java)
            if (nm.getNotificationChannel(CHANNEL) == null) {
                nm.createNotificationChannel(NotificationChannel(CHANNEL, ctx.getString(R.string.talk_title), NotificationManager.IMPORTANCE_LOW))
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            fun action(a: String, req: Int) = PendingIntent.getService(ctx, req, Intent(ctx, TalkService::class.java).setAction(a), flags)
            val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, TalkActivity::class.java).setAction(Intent.ACTION_VIEW), flags)
            val b = Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_talk)
                .setContentTitle(ctx.getString(R.string.talk_title))
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_CALL)
            if (TalkConnection.current?.ringing == true) {
                b.addAction(Notification.Action.Builder(null, ctx.getString(R.string.talk_answer_here), action(ACTION_ANSWER, 1)).build())
            }
            b.addAction(Notification.Action.Builder(null, ctx.getString(R.string.talk_hang_up), action(ACTION_HANG_UP, 2)).build())
            return b.build()
        }
    }

    private val main = Handler(Looper.getMainLooper())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_ANSWER -> { TalkConnection.current?.answerHere(); return START_NOT_STICKY }
            ACTION_HANG_UP -> { hangUp(this); stopSelf(); return START_NOT_STICKY }
        }
        val n = build(this, getString(R.string.talk_ringing))
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) else startForeground(ID, n)
        if (TalkConnection.current != null) return START_NOT_STICKY
        val target = Prefs(this).talkTarget
        if (target == null) { TalkState.set(getString(R.string.talk_pick_first), active = false); stopSelf(); return START_NOT_STICKY }
        ring(target)
        return START_NOT_STICKY
    }

    private fun ring(target: TalkTarget) {
        val telecom = getSystemService(TelecomManager::class.java)
        try {
            TalkAccount.register(this)
            val handle = TalkAccount.handle(this)
            if (Build.VERSION.SDK_INT >= 28 && !telecom.isIncomingCallPermitted(handle)) {
                TalkState.set(getString(R.string.talk_busy), active = false)
                stopSelf()
                return
            }
            TalkState.set(getString(R.string.talk_ringing), this, active = true)
            telecom.addNewIncomingCall(handle, Bundle().apply { putString(TalkConnectionService.EXTRA_TARGET, target.toJson()) })
        } catch (e: SecurityException) {
            TalkState.set(getString(R.string.talk_no_calls), active = false)
            stopSelf()
            return
        }
        main.postDelayed({
            val c = TalkConnection.current
            if (c != null && c.ringing) {
                TalkState.set(getString(R.string.talk_missed), active = false)
                c.end(DisconnectCause.MISSED)
            }
        }, RING_MS)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        TalkConnection.current?.end(DisconnectCause.LOCAL)
        if (TalkState.active) TalkState.set(getString(R.string.talk_ended), active = false)
        super.onDestroy()
    }
}

class TalkConnectionService : ConnectionService() {
    companion object { const val EXTRA_TARGET = "dev.agentx.phone.talk.TARGET" }

    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        val target = TalkTarget.fromJson(request?.extras?.getString(EXTRA_TARGET)) ?: Prefs(this).talkTarget
        if (target == null) return Connection.createFailedConnection(DisconnectCause(DisconnectCause.ERROR))
        return TalkConnection(applicationContext, target).apply { setRinging() }
    }

    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        TalkState.set(getString(R.string.talk_busy), active = false)
        stopService(Intent(this, TalkService::class.java))
    }
}

/** One call with the agent. */
class TalkConnection(private val ctx: Context, private val target: TalkTarget) : Connection() {
    companion object {
        /** The call in progress, for the screen and the notification. */
        @Volatile var current: TalkConnection? = null
    }

    @Volatile private var ended = false
    @Volatile var ringing = true; private set
    private var session: TalkSession? = null

    init {
        current = this
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
        setAddress(TalkAccount.address, TelecomManager.PRESENTATION_ALLOWED)
        setCallerDisplayName(target.name, TelecomManager.PRESENTATION_ALLOWED)
    }

    override fun onShowIncomingCallUi() {
        TalkState.set(ctx.getString(R.string.talk_ringing), ctx, active = true)
    }

    // The watch's answer button, or the phone's own call screen.
    override fun onAnswer() = begin()

    /** Answer on the Talk screen or from the notification. */
    fun answerHere() = begin()

    override fun onReject() = end(DisconnectCause.REJECTED)
    override fun onDisconnect() = end(DisconnectCause.LOCAL)
    override fun onAbort() = end(DisconnectCause.CANCELED)

    @Synchronized private fun begin() {
        if (ended || session != null) return
        ringing = false
        setActive()
        session = TalkSession(ctx, target, this).also { it.start() }
    }

    /** Ends the call from any thread; runs once. */
    @Synchronized fun end(cause: Int) {
        if (ended) return
        ended = true
        ringing = false
        session?.stop()
        setDisconnected(DisconnectCause(cause))
        destroy()
        if (current === this) current = null
        TalkState.set(ctx.getString(R.string.talk_ended), active = false)
        ctx.stopService(Intent(ctx, TalkService::class.java))
    }

    /** Telecom's own route first (meant for a self-managed call), then
     *  AudioManager. Returns false when no Bluetooth headset took it. */
    @Suppress("DEPRECATION")
    fun routeToWatch(audio: AudioManager): Boolean {
        val state = callAudioState
        if (state != null && state.supportedRouteMask and CallAudioState.ROUTE_BLUETOOTH != 0) {
            setAudioRoute(CallAudioState.ROUTE_BLUETOOTH)
            for (i in 0 until 30) {
                if (callAudioState?.route == CallAudioState.ROUTE_BLUETOOTH) break
                Thread.sleep(100)
            }
        }
        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= 31) {
            // Also set on the Telecom route: step 1 found the recording can
            // stay on the phone's own microphone otherwise.
            val sco = audio.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            if (sco != null && audio.setCommunicationDevice(sco)) return true
            if (callAudioState?.route == CallAudioState.ROUTE_BLUETOOTH) return true
            setAudioRoute(CallAudioState.ROUTE_SPEAKER)
            return false
        }
        if (callAudioState?.route == CallAudioState.ROUTE_BLUETOOTH) return true
        audio.startBluetoothSco()
        audio.isBluetoothScoOn = true
        for (i in 0 until 40) {
            if (audio.isBluetoothScoOn) return true
            Thread.sleep(100)
        }
        setAudioRoute(CallAudioState.ROUTE_SPEAKER)
        return false
    }
}

/** The turns of one call, on their own thread. */
class TalkSession(private val ctx: Context, private val target: TalkTarget, private val call: TalkConnection) {
    private class Stopped : Exception()

    companion object {
        private const val RATE = 16000
        private const val FRAME = RATE / 50
        private const val MAX_SECONDS = 45
        private const val SILENT_TURNS = 2
        private const val FAILED_TURNS = 2
    }

    @Volatile private var stopped = false
    @Volatile private var http: HttpURLConnection? = null
    @Volatile private var tts: TextToSpeech? = null
    private val audio = ctx.getSystemService(AudioManager::class.java)
    private val prefs = Prefs(ctx)
    private var conversationId: String? = null
    private var tones: ToneGenerator? = null

    private val voiceAttrs: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    fun start() {
        thread(name = "agentx-talk") {
            try {
                run()
            } catch (_: Stopped) {
            } catch (e: Exception) {
                Log.w("AgentXTalk", "talk failed", e)
                // IllegalStateException carries words meant to be said.
                if (!stopped) sayQuietly((e as? IllegalStateException)?.message ?: ctx.getString(R.string.talk_say_failed))
            } finally {
                cleanUp()
                call.end(DisconnectCause.LOCAL)
            }
        }
    }

    /** From any thread: the call ended. A running answer goes on on the
     *  computer and lands in Chat. */
    fun stop() {
        stopped = true
        val h = http
        if (h != null) thread { try { h.disconnect() } catch (_: Exception) {} }
        try { tts?.stop() } catch (_: Exception) {}
    }

    private fun check() { if (stopped) throw Stopped() }

    private fun run() {
        Thread.sleep(600)
        check()
        val onWatch = call.routeToWatch(audio)
        tones = try { ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80) } catch (_: Exception) { null }
        openTts()
        check()
        TalkState.set(ctx.getString(if (onWatch) R.string.talk_on_watch else R.string.talk_on_phone, target.name), ctx)
        say(ctx.getString(R.string.talk_say_hello, target.name))

        var silent = 0
        var failed = 0
        while (true) {
            check()
            beep(ToneGenerator.TONE_PROP_BEEP)
            TalkState.set(ctx.getString(R.string.talk_listening), ctx)
            val take = listen()
            check()
            if (take == null) {
                if (++silent >= SILENT_TURNS) { say(ctx.getString(R.string.talk_say_bye)); return }
                say(ctx.getString(R.string.talk_say_nothing))
                continue
            }
            silent = 0
            try {
                turn(take)
                failed = 0
            } catch (e: Api.HttpError) {
                check()
                if (e.status == 401) { say(ctx.getString(R.string.talk_say_unpaired)); return }
                say(e.message ?: ctx.getString(R.string.talk_say_failed))
                if (++failed >= FAILED_TURNS) return
            } catch (e: IOException) {
                check()
                say(ctx.getString(R.string.talk_say_offline))
                if (++failed >= FAILED_TURNS) return
            }
        }
    }

    /** One turn: words, the agent's answer, the answer said. */
    private fun turn(take: ShortArray) {
        val base = prefs.baseUrl ?: throw Api.HttpError(401, "not paired")
        val token = prefs.token ?: throw Api.HttpError(401, "not paired")
        TalkState.set(ctx.getString(R.string.talk_writing), ctx)
        val words = Api.transcribe(base, token, Wav.encode(take, RATE), take.size * 1000L / RATE)
        check()
        if (words.isEmpty()) { say(ctx.getString(R.string.talk_say_again)); return }

        TalkState.set(ctx.getString(R.string.talk_thinking, words), ctx)
        val body = JSONObject().put("message", words.take(8000)).put("spoken", true)
        val id = conversationId
        if (id != null) body.put("conversationId", id) else body.put("node", target.node).put("agent", target.agent)
        val waiting = AtomicBoolean(true)
        val ticker = thread(name = "agentx-talk-tick") {
            try {
                while (waiting.get() && !stopped) { Thread.sleep(4000); if (waiting.get() && !stopped) beep(ToneGenerator.TONE_PROP_ACK) }
            } catch (_: InterruptedException) {}
        }
        val reply = try {
            Api.chat(base, token, body) { http = it }
        } catch (e: IOException) {
            check()
            throw e
        } finally {
            waiting.set(false)
            ticker.interrupt()
            http = null
        }
        check()
        if (reply.conversationId != null) conversationId = reply.conversationId
        when {
            reply.status == "done" && reply.content.isNotBlank() -> answer(base, token, reply.content)
            reply.error != null -> say(ctx.getString(R.string.talk_say_error, reply.error))
            else -> say(ctx.getString(R.string.talk_say_empty))
        }
    }

    /** The answer in the agent's voice when the computer has one, else the phone's. */
    private fun answer(base: String, token: String, content: String) {
        TalkState.set(ctx.getString(R.string.talk_speaking, target.name), ctx)
        val id = conversationId
        val voiced = if (id == null) null else try { Api.speak(base, token, id, content.take(8000)) } catch (_: IOException) { null }
        check()
        if (voiced != null && play(voiced.first, voiced.second)) return
        say(Speech.plain(content))
    }

    // --- Audio ---

    /** Records until the owner stops speaking. Null when nothing was said. */
    @Suppress("MissingPermission")
    private fun listen(): ShortArray? {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE))
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            throw IllegalStateException(ctx.getString(R.string.talk_say_no_mic))
        }
        val pcm = ShortArray(RATE * MAX_SECONDS)
        val ep = Endpointer(frameMs = 1000 * FRAME / RATE, maxMs = MAX_SECONDS * 1000)
        var n = 0
        try {
            rec.startRecording()
            // Skip the beep's own echo.
            val skip = ShortArray(RATE / 4)
            rec.read(skip, 0, skip.size)
            while (n < pcm.size && !stopped) {
                val got = rec.read(pcm, n, minOf(FRAME, pcm.size - n))
                if (got <= 0) break
                var peak = 0
                for (i in n until n + got) peak = maxOf(peak, abs(pcm[i].toInt()))
                n += got
                val s = ep.frame(peak)
                if (s == Endpointer.State.DONE || s == Endpointer.State.SILENT || s == Endpointer.State.FULL) break
            }
            val from = rec.routedDevice
            Log.i("AgentXTalk", "microphone: ${from?.productName} (type ${from?.type}), ${ep.state}")
            rec.stop()
        } finally {
            rec.release()
        }
        return if (ep.state == Endpointer.State.SILENT || ep.state == Endpointer.State.WAITING) null else pcm.copyOf(n)
    }

    private fun beep(tone: Int) {
        try { tones?.startTone(tone, 150) } catch (_: Exception) {}
        try { Thread.sleep(200) } catch (_: InterruptedException) {}
    }

    /** Plays the agent's voice on the call. False when the phone can't. */
    private fun play(type: String, bytes: ByteArray): Boolean {
        val ext = when {
            type.contains("mpeg") || type.contains("mp3") -> "mp3"
            type.contains("wav") -> "wav"
            type.contains("ogg") -> "ogg"
            else -> "audio"
        }
        val file = File(ctx.cacheDir, "talk-answer.$ext")
        val done = CountDownLatch(1)
        var player: MediaPlayer? = null
        return try {
            file.writeBytes(bytes)
            player = MediaPlayer().apply {
                setAudioAttributes(voiceAttrs)
                setDataSource(file.path)
                setOnCompletionListener { done.countDown() }
                setOnErrorListener { _, _, _ -> done.countDown(); true }
                prepare()
                start()
            }
            while (!done.await(200, TimeUnit.MILLISECONDS)) check()
            true
        } catch (e: Stopped) {
            throw e
        } catch (e: Exception) {
            Log.w("AgentXTalk", "could not play the answer", e)
            false
        } finally {
            try { player?.release() } catch (_: Exception) {}
            file.delete()
        }
    }

    private fun openTts() {
        val ready = CountDownLatch(1)
        val ok = AtomicBoolean(false)
        val made = AtomicReference<TextToSpeech?>()
        Handler(Looper.getMainLooper()).post {
            made.set(TextToSpeech(ctx) { status -> ok.set(status == TextToSpeech.SUCCESS); ready.countDown() })
        }
        if (!ready.await(10, TimeUnit.SECONDS) || !ok.get()) { made.get()?.shutdown(); return }
        tts = made.get()?.apply { setAudioAttributes(voiceAttrs) }
    }

    /** Says [text] in the phone's own voice and waits until it is said. */
    private fun say(text: String) {
        check()
        val t = tts ?: return
        val pieces = Speech.chunks(text, minOf(TextToSpeech.getMaxSpeechInputLength() - 1, 3000))
        val left = CountDownLatch(pieces.size)
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) { left.countDown() }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) { left.countDown() }
            override fun onStop(id: String?, interrupted: Boolean) { while (left.count > 0) left.countDown() }
        })
        pieces.forEachIndexed { i, p -> t.speak(p, TextToSpeech.QUEUE_ADD, null, "talk-$i") }
        var waited = 0
        while (!left.await(200, TimeUnit.MILLISECONDS)) {
            check()
            waited += 200
            if (waited > 10 * 60_000) return
        }
    }

    private fun sayQuietly(text: String) = try { say(text) } catch (_: Exception) {}

    @Suppress("DEPRECATION")
    private fun cleanUp() {
        try { tts?.shutdown() } catch (_: Exception) {}
        tts = null
        try { tones?.release() } catch (_: Exception) {}
        try {
            if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice() else audio.stopBluetoothSco()
            audio.mode = AudioManager.MODE_NORMAL
        } catch (_: Exception) {}
    }
}
