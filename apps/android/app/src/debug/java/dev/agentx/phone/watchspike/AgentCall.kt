package dev.agentx.phone.watchspike

import android.content.Context
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.media.ToneGenerator
import dev.agentx.phone.Prefs
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// The agent side of a watch call (#1664), debug builds only. Same routes
// as the phone app's voice orb, with this app's device key:
// recording → /api/app/voice/transcribe → /api/app/chat (one conversation
// per call) → /api/app/voice/speak → played on the call's audio.

/** Blocking calls to the paired computer. [current] is the open request, so a hang-up can cut it. */
class AgentClient(private val base: String, private val token: String) {
    class Failure(message: String) : IOException(message)

    @Volatile var current: HttpURLConnection? = null

    fun cancel() { current?.disconnect() }

    fun transcribe(wav: ByteArray, ms: Long): String {
        val conn = open("/api/app/voice/transcribe", 90_000)
        conn.setRequestProperty("Content-Type", "audio/wav")
        conn.setRequestProperty("X-Audio-Duration-Ms", ms.toString())
        conn.outputStream.use { it.write(wav) }
        val j = readJson(conn)
        return j.optString("text").trim()
    }

    /** One turn. Returns the conversation id and the answer. */
    fun ask(message: String, conversationId: String?, node: String, agent: String): Pair<String, String> {
        val conn = open("/api/app/chat", 60_000)
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Accept", "text/event-stream")
        val body = JSONObject().put("message", message).put("spoken", true)
        if (conversationId != null) body.put("conversationId", conversationId) else body.put("node", node).put("agent", agent)
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        if (conn.responseCode != 200) readJson(conn)
        var id = conversationId
        var answer: String? = null
        conn.inputStream.bufferedReader().use { r ->
            Sse.read(r) { name, data ->
                val j = try { JSONObject(data) } catch (_: Exception) { JSONObject() }
                when (name) {
                    "conversation" -> { id = j.optString("id").ifEmpty { id }; true }
                    "final" -> {
                        answer = j.optString("content").ifBlank { j.optString("error").ifBlank { "The agent sent no answer." } }
                        false
                    }
                    else -> true
                }
            }
        }
        val convId = id ?: throw Failure("The computer opened no conversation.")
        return convId to (answer ?: throw Failure("The answer stream ended early."))
    }

    /** The agent's voice as audio, or null with the text to say with the phone's voice. */
    fun speak(conversationId: String, text: String): Pair<ByteArray?, String> {
        val said = text.take(8_000)
        val conn = open("/api/app/voice/speak", 90_000)
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(JSONObject().put("conversationId", conversationId).put("text", said).toString().toByteArray()) }
        if (conn.responseCode == 200 && (conn.contentType ?: "").startsWith("audio/")) {
            return conn.inputStream.use { it.readBytes() } to said
        }
        val j = try { readJson(conn) } catch (_: Failure) { JSONObject() }
        return null to j.optString("text").ifBlank { said }
    }

    fun stop(conversationId: String) {
        try {
            val conn = open("/api/app/chat/stop", 10_000)
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(JSONObject().put("conversationId", conversationId).toString().toByteArray()) }
            conn.responseCode
            conn.disconnect()
        } catch (e: IOException) {
            SpikeLog.add("Stop request failed: ${e.message}")
        }
    }

    private fun open(path: String, readMs: Int): HttpURLConnection {
        val conn = URL(base + path).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15_000
        conn.readTimeout = readMs
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.setRequestProperty("Authorization", "Bearer $token")
        current = conn
        return conn
    }

    private fun readJson(conn: HttpURLConnection): JSONObject {
        val status = conn.responseCode
        val stream = if (status < 400) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        val j = try { JSONObject(text) } catch (_: Exception) { JSONObject() }
        if (status != 200) throw Failure(j.optString("error").ifBlank { "The computer answered HTTP $status." })
        return j
    }
}

/**
 * The conversation on one answered watch call: listen, ask, speak, until
 * the call ends. Half duplex: nothing is recorded while the agent speaks.
 */
class AgentLoop(private val ctx: Context, private val call: SpikeConnection) {
    companion object {
        private const val RATE = 16000
        private const val MAX_TURN_MS = 45_000
        private const val WAIT_MS = 30_000
    }

    private val settings = WatchStart.settings(ctx)
    private var client: AgentClient? = null
    private var conversationId: String? = null
    @Volatile private var player: MediaPlayer? = null

    /** Cuts what is running: the request, and the reply being played. */
    fun hangUp() {
        client?.cancel()
        try { player?.stop() } catch (_: IllegalStateException) {}
        val id = conversationId
        val c = client
        if (id != null && c != null) Thread { c.stop(id) }.start()
    }

    fun run() {
        val prefs = Prefs(ctx)
        val base = prefs.baseUrl
        val token = prefs.token
        if (base == null || token == null) {
            say("This phone is not paired with AgentX yet. Open the watch app on the phone and pair it.")
            return
        }
        client = AgentClient(base, token)
        val agent = settings.agent
        say("AgentX here. Talk to $agent after the beep.")
        var idle = 0
        while (!call.isEnded) {
            beep(ToneGenerator.TONE_PROP_BEEP)
            val heard = listen() ?: return
            if (heard.isEmpty()) {
                if (++idle >= 2) { say("No one is talking. Goodbye."); return }
                say("I'm still here. Say something, or hang up.")
                continue
            }
            idle = 0
            val text = try {
                client!!.transcribe(Wav.encode(heard, RATE), heard.size * 1000L / RATE)
            } catch (e: IOException) {
                if (call.isEnded) return
                SpikeLog.add("FAIL speech to text: ${e.message}")
                say("I could not hear that. ${e.message ?: ""}")
                continue
            }
            if (text.isEmpty()) { say("I heard nothing I could understand. Try again."); continue }
            SpikeLog.add("You: $text")
            val answer = withTicks {
                try {
                    val (id, a) = client!!.ask(text, conversationId, settings.node, agent)
                    conversationId = id
                    a
                } catch (e: IOException) {
                    if (call.isEnded) null else "Sorry, the agent could not answer. ${e.message ?: ""}"
                }
            } ?: return
            SpikeLog.add("Agent: ${answer.take(300)}${if (answer.length > 300) "…" else ""}")
            if (call.isEnded) return
            playAnswer(answer)
        }
    }

    /** One spoken turn from the call's microphone. Empty when nobody spoke; null when the call ended. */
    @Suppress("MissingPermission")
    private fun listen(): ShortArray? {
        val min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val rec = AudioRecord(MediaRecorder.AudioSource.VOICE_COMMUNICATION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(min, RATE))
        if (rec.state != AudioRecord.STATE_INITIALIZED) {
            rec.release()
            SpikeLog.add("FAIL microphone could not open (is the microphone permission on?)")
            say("The phone's microphone is blocked. Allow it for the watch app.")
            return null
        }
        val ep = Endpointer()
        val frame = ShortArray(RATE / 50)
        val out = ShortArray(RATE * MAX_TURN_MS / 1000)
        val before = ArrayDeque<ShortArray>()
        var n = 0
        var waited = 0
        var peak = 0
        rec.startRecording()
        try {
            while (!call.isEnded) {
                val got = rec.read(frame, 0, frame.size)
                if (got <= 0) break
                for (i in 0 until got) peak = maxOf(peak, kotlin.math.abs(frame[i].toInt()))
                val state = ep.feed(frame, got)
                if (state == Endpointer.State.WAITING) {
                    // Keep the last 300 ms before speech, so the first word isn't cut.
                    before.addLast(frame.copyOf(got))
                    if (before.size > 15) before.removeFirst()
                    waited += got * 1000 / RATE
                    if (waited >= WAIT_MS) break
                    continue
                }
                while (before.isNotEmpty()) {
                    val f = before.removeFirst()
                    System.arraycopy(f, 0, out, n, f.size); n += f.size
                }
                val room = minOf(got, out.size - n)
                System.arraycopy(frame, 0, out, n, room); n += room
                if (state == Endpointer.State.DONE || n >= out.size) break
            }
            val from = rec.routedDevice
            SpikeLog.add("Mic: ${from?.productName ?: "unknown"} (type ${from?.type ?: "?"}), peak $peak${if (peak == 0) " — silent: Android blocks the mic for an app in the background; keep the watch app open" else ""}")
        } finally {
            rec.stop()
            rec.release()
        }
        if (call.isEnded) return null
        return if (ep.state == Endpointer.State.WAITING) ShortArray(0) else out.copyOf(n)
    }

    /** Short beeps every 4 s while [work] runs, so the silence on the watch isn't a dead line. */
    private fun <T> withTicks(work: () -> T): T {
        val done = CountDownLatch(1)
        val ticker = Thread {
            while (!done.await(4, TimeUnit.SECONDS) && !call.isEnded) beep(ToneGenerator.TONE_PROP_ACK, 120)
        }
        ticker.start()
        try { return work() } finally { done.countDown() }
    }

    private fun playAnswer(answer: String) {
        val id = conversationId
        val (audio, text) = try {
            if (id == null) null to answer else client!!.speak(id, answer)
        } catch (e: IOException) {
            SpikeLog.add("Agent voice failed (${e.message}); using the phone's voice")
            null to answer
        }
        if (call.isEnded) return
        if (audio == null) { say(text); return }
        val file = File(ctx.cacheDir, "watch-answer.mp3").apply { writeBytes(audio) }
        val finished = CountDownLatch(1)
        val mp = MediaPlayer()
        player = mp
        try {
            mp.setAudioAttributes(call.voiceAttrs)
            mp.setDataSource(file.path)
            mp.setOnCompletionListener { finished.countDown() }
            mp.setOnErrorListener { _, what, extra -> SpikeLog.add("Player error $what/$extra"); finished.countDown(); true }
            mp.prepare()
            mp.start()
            // Poll so a hang-up stops the wait as well as the sound.
            while (!finished.await(300, TimeUnit.MILLISECONDS) && !call.isEnded) {}
        } catch (e: Exception) {
            SpikeLog.add("Could not play the agent's voice (${e.message}); using the phone's voice")
            say(text)
        } finally {
            player = null
            mp.release()
            file.delete()
        }
    }

    private fun say(text: String) {
        if (call.isEnded) return
        if (!call.speak(text)) SpikeLog.add("FAIL could not say: $text")
    }

    private fun beep(tone: Int, ms: Int = 200) {
        try {
            val g = ToneGenerator(AudioManager.STREAM_VOICE_CALL, 80)
            g.startTone(tone, ms)
            Thread.sleep(ms + 50L)
            g.release()
        } catch (e: RuntimeException) {
            SpikeLog.add("Beep failed: ${e.message}")
        }
    }
}
