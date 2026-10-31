package dev.agentx.phone.watchspike

import android.content.ComponentName
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import kotlin.math.abs

// Watch call spike (#1636, step 1), debug builds only.
//
// Question: can a Bluetooth-calling watch that runs no apps be the mic and
// speaker for an agent, the way it is for a WhatsApp call? The phone opens
// a self-managed call (Telecom ConnectionService), routes it to the
// watch's hands-free link (SCO), says a test phrase, records 5 s and plays
// it back. Every step is written to the screen and to logcat (tag
// WatchSpike), so one run per device gives the result to report.

/** Lines for the screen and logcat. */
object SpikeLog {
    private const val TAG = "WatchSpike"
    private val main = Handler(Looper.getMainLooper())
    private val lines = mutableListOf<String>()
    var listener: ((String) -> Unit)? = null

    fun add(line: String) {
        Log.i(TAG, line)
        main.post {
            lines.add(line)
            listener?.invoke(text())
        }
    }

    fun text(): String = lines.joinToString("\n")
    fun clear() = main.post { lines.clear(); listener?.invoke("") }
}

/** The app's own phone account: self-managed, so it needs no SIM and no number. */
object SpikeAccount {
    fun handle(ctx: Context) = PhoneAccountHandle(ComponentName(ctx, WatchSpikeConnectionService::class.java), "agentx-watch-spike")

    fun register(ctx: Context) {
        val extras = Bundle()
        // Lets in-call services that ask for it, Bluetooth's among them on
        // some phones, see this call. Part of what the spike checks.
        if (Build.VERSION.SDK_INT >= 29) extras.putBoolean(PhoneAccount.EXTRA_ADD_SELF_MANAGED_CALLS_TO_INCALLSERVICE, true)
        val account = PhoneAccount.builder(handle(ctx), "AgentX")
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
            .setSupportedUriSchemes(listOf(PhoneAccount.SCHEME_SIP))
            .setExtras(extras)
            .build()
        ctx.getSystemService(TelecomManager::class.java).registerPhoneAccount(account)
    }

    val address: Uri = Uri.fromParts(PhoneAccount.SCHEME_SIP, "agentx", null)
}

class WatchSpikeConnectionService : ConnectionService() {
    override fun onCreateOutgoingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        SpikeLog.add("Telecom: outgoing call created")
        return SpikeConnection(applicationContext).apply { setDialing(); setActive() }
    }

    override fun onCreateIncomingConnection(account: PhoneAccountHandle?, request: ConnectionRequest?): Connection {
        val agent = request?.extras?.getBoolean(WatchStart.EXTRA_AGENT) == true
        if (agent && WatchStart.settings(this).autoAnswer) {
            SpikeLog.add("Telecom: agent call created, answering by itself (B without a tap)")
            return SpikeConnection(applicationContext, agent = true).apply { setActive() }
        }
        SpikeLog.add("Telecom: ${if (agent) "agent" else "incoming"} call created, ringing. Answer on the watch, or with Answer here.")
        return SpikeConnection(applicationContext, agent).apply { setRinging() }
    }

    override fun onCreateOutgoingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        SpikeLog.add("FAIL Telecom refused the outgoing call (another call may be active)")
    }

    override fun onCreateIncomingConnectionFailed(account: PhoneAccountHandle?, request: ConnectionRequest?) {
        SpikeLog.add("FAIL Telecom refused the incoming call (another call may be active)")
    }
}

/** One spike call. The test starts when it turns active. */
class SpikeConnection(private val ctx: Context, private val agent: Boolean = false) : Connection() {
    companion object {
        /** The call in progress, for the screen's Answer and Hang up. */
        @Volatile var current: SpikeConnection? = null
        private const val RATE = 16000
        private const val SECONDS = 5
    }

    @Volatile private var ended = false
    @Volatile private var started = false
    @Volatile private var loop: AgentLoop? = null
    /** Set by the screen's Answer button, so B tells a phone tap from a watch tap. */
    @Volatile var answeredOnPhone = false
    @Volatile private var answered = false
    val isEnded: Boolean get() = ended
    private val audio = ctx.getSystemService(AudioManager::class.java)

    init {
        current = this
        connectionProperties = PROPERTY_SELF_MANAGED
        audioModeIsVoip = true
        setAddress(SpikeAccount.address, TelecomManager.PRESENTATION_ALLOWED)
        setCallerDisplayName("AgentX", TelecomManager.PRESENTATION_ALLOWED)
    }

    override fun onShowIncomingCallUi() {
        SpikeLog.add("Telecom: show the incoming call. Check the watch: does it ring and show answer / hang up?")
    }

    override fun onAnswer() {
        SpikeLog.add("Answered")
        answered = true
        if (agent) {
            val s = (android.os.SystemClock.elapsedRealtime() - WatchStart.ringAt) / 1000
            SpikeLog.add(if (answeredOnPhone) "RESULT B: answered with the phone's Answer button after $s s (the watch did not answer)"
                else "RESULT B: PASS answered on the watch after $s s")
        }
        setActive()
        startTest()
    }

    override fun onReject() { SpikeLog.add("Rejected"); end(DisconnectCause.REJECTED) }
    override fun onDisconnect() {
        SpikeLog.add(if (agent) "RESULT C: PASS the hang-up reached the app (watch, or Bluetooth)" else "Hung up (watch or phone)")
        end(DisconnectCause.LOCAL)
    }
    override fun onAbort() { SpikeLog.add("Aborted"); end(DisconnectCause.CANCELED) }

    override fun onStateChanged(state: Int) {
        if (state == STATE_ACTIVE) startTest()
    }

    @Deprecated("Deprecated in API 34; still called, and enough for the spike")
    override fun onCallAudioStateChanged(state: CallAudioState?) {
        state ?: return
        SpikeLog.add("Route: ${routeName(state.route)} (supported: ${routeNames(state.supportedRouteMask)})")
    }

    /** Called from Telecom's thread and the test thread; runs once. */
    @Synchronized fun end(cause: Int) {
        if (ended) return
        ended = true
        loop?.hangUp()
        setDisconnected(DisconnectCause(cause))
        destroy()
        if (current === this) current = null
        restoreAudio()
    }

    @Synchronized private fun startTest() {
        if (started) return
        started = true
        thread(name = "watch-spike") {
            try {
                if (agent) runAgent() else runTest()
            } catch (e: Exception) {
                SpikeLog.add("FAIL ${e.javaClass.simpleName}: ${e.message}")
            } finally {
                if (!ended) SpikeLog.add("Done. Hanging up.")
                end(DisconnectCause.LOCAL)
            }
        }
    }

    private fun runAgent() {
        Thread.sleep(500)
        val route = routeToWatch()
        SpikeLog.add(if (route) "PASS audio is on the watch" else "FAIL audio is not on a Bluetooth headset (the agent is on the phone's speaker)")
        if (!answered) SpikeLog.add("RESULT B (answer by itself): ${if (route) "PASS" else "FAIL"} audio ${if (route) "reached" else "did not reach"} the watch without a tap")
        if (ended) return
        AgentLoop(ctx, this).also { loop = it }.run()
    }

    private fun runTest() {
        Thread.sleep(1000)
        val route = routeToWatch()
        SpikeLog.add(if (route) "PASS audio is on the watch" else "FAIL audio is not on a Bluetooth headset")
        if (ended) return

        val spoken = speak("This is AgentX on your watch. After this sentence, speak for five seconds. You will hear it back.")
        SpikeLog.add(if (spoken) "Test phrase played. Heard on the watch? (check by ear)" else "FAIL test phrase did not play")
        if (ended) return

        val pcm = record()
        if (ended || pcm == null) return
        val peak = pcm.maxOfOrNull { abs(it.toInt()) } ?: 0
        SpikeLog.add(if (peak > 1000) "PASS microphone captured sound (peak $peak of 32767)" else "FAIL microphone heard almost nothing (peak $peak)")
        play(pcm)
        SpikeLog.add("Played the recording back. Heard on the watch? (check by ear)")
    }

    /** Telecom's own route first (the API meant for a self-managed call), then AudioManager. */
    @Suppress("DEPRECATION")
    private fun routeToWatch(): Boolean {
        val state = callAudioState
        if (state != null && state.supportedRouteMask and CallAudioState.ROUTE_BLUETOOTH != 0) {
            SpikeLog.add("Asking Telecom for the Bluetooth route")
            setAudioRoute(CallAudioState.ROUTE_BLUETOOTH)
            for (i in 0 until 30) {
                if (callAudioState?.route == CallAudioState.ROUTE_BLUETOOTH) return true
                Thread.sleep(100)
            }
            SpikeLog.add("Telecom did not move to Bluetooth in 3 s")
        } else {
            SpikeLog.add("Telecom offers no Bluetooth route for this call")
        }

        audio.mode = AudioManager.MODE_IN_COMMUNICATION
        if (Build.VERSION.SDK_INT >= 31) {
            val devices = audio.availableCommunicationDevices
            SpikeLog.add("Communication devices: ${devices.joinToString { "${it.productName} (type ${it.type})" }}")
            val sco = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } ?: return false
            val ok = audio.setCommunicationDevice(sco)
            SpikeLog.add("setCommunicationDevice(${sco.productName}): $ok")
            return ok
        }
        audio.startBluetoothSco()
        audio.isBluetoothScoOn = true
        for (i in 0 until 40) {
            if (audio.isBluetoothScoOn) return true
            Thread.sleep(100)
        }
        return false
    }

    @Suppress("DEPRECATION")
    private fun restoreAudio() {
        if (Build.VERSION.SDK_INT >= 31) audio.clearCommunicationDevice()
        else audio.stopBluetoothSco()
        audio.mode = AudioManager.MODE_NORMAL
    }

    val voiceAttrs: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    /** Says the phrase on the call's audio and waits until it is spoken. */
    fun speak(text: String): Boolean {
        val ready = CountDownLatch(1)
        val done = CountDownLatch(1)
        // Written on the TTS threads, read here.
        val ok = AtomicBoolean(false)
        val tts = AtomicReference<TextToSpeech?>()
        Handler(Looper.getMainLooper()).post {
            tts.set(TextToSpeech(ctx) { status -> ok.set(status == TextToSpeech.SUCCESS); ready.countDown() })
        }
        if (!ready.await(10, TimeUnit.SECONDS) || !ok.get()) return false
        val t = tts.get() ?: return false
        t.setAudioAttributes(voiceAttrs)
        t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) { done.countDown() }
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) { ok.set(false); done.countDown() }
        })
        t.speak(text, TextToSpeech.QUEUE_FLUSH, null, "phrase")
        var finished = false
        // A hang-up stops the wait; the timeout grows with the text.
        val limit = System.currentTimeMillis() + 20_000 + text.length * 100L
        while (!finished && !ended && System.currentTimeMillis() < limit) finished = done.await(300, TimeUnit.MILLISECONDS)
        if (ended) t.stop()
        t.shutdown()
        if (!finished && !ended) SpikeLog.add("Speech timed out")
        return finished && ok.get()
    }

    /** 5 s from the call's microphone, with the device it came from. */
    @Suppress("MissingPermission")
    private fun record(): ShortArray? {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE))
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            SpikeLog.add("FAIL microphone could not open (is the microphone permission on?)")
            rec.release()
            return null
        }
        val pcm = ShortArray(RATE * SECONDS)
        var n = 0
        rec.startRecording()
        SpikeLog.add("Recording 5 s…")
        while (n < pcm.size && !ended) {
            val got = rec.read(pcm, n, minOf(1600, pcm.size - n))
            if (got <= 0) break
            n += got
        }
        val from = rec.routedDevice
        SpikeLog.add("Microphone: ${from?.productName ?: "unknown"} (type ${from?.type ?: "?"}; ${AudioDeviceInfo.TYPE_BLUETOOTH_SCO} = Bluetooth SCO)")
        rec.stop()
        rec.release()
        return pcm.copyOf(n)
    }

    private fun play(pcm: ShortArray) {
        if (pcm.isEmpty()) return
        val track = AudioTrack.Builder()
            .setAudioAttributes(voiceAttrs)
            .setAudioFormat(AudioFormat.Builder().setSampleRate(RATE).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC)
            .setBufferSizeInBytes(pcm.size * 2)
            .build()
        track.write(pcm, 0, pcm.size)
        track.play()
        Thread.sleep(pcm.size * 1000L / RATE + 300)
        track.release()
    }

    private fun routeName(r: Int) = when (r) {
        CallAudioState.ROUTE_BLUETOOTH -> "Bluetooth"
        CallAudioState.ROUTE_EARPIECE -> "earpiece"
        CallAudioState.ROUTE_SPEAKER -> "speaker"
        CallAudioState.ROUTE_WIRED_HEADSET -> "wired headset"
        else -> "route $r"
    }

    private fun routeNames(mask: Int) = listOf(
        CallAudioState.ROUTE_BLUETOOTH, CallAudioState.ROUTE_EARPIECE,
        CallAudioState.ROUTE_SPEAKER, CallAudioState.ROUTE_WIRED_HEADSET,
    ).filter { mask and it != 0 }.joinToString { routeName(it) }
}
