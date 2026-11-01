package dev.agentx.phone

import org.json.JSONObject

// The parts of "Talk to AgentX" (#1636) that need no phone: the recording's
// file format, reading the chat stream, telling when the owner stopped
// speaking, and turning an answer into plain sentences to say. Unit tested.

/** The agent a call talks to, as POST /api/app/chat takes it. */
data class TalkTarget(val node: String, val agent: String, val name: String) {
    fun toJson(): String = JSONObject().put("node", node).put("agent", agent).put("name", name).toString()

    companion object {
        fun fromJson(s: String?): TalkTarget? = try {
            val o = JSONObject(s ?: return null)
            val node = o.optString("node"); val agent = o.optString("agent")
            if (node.isEmpty() || agent.isEmpty()) null else TalkTarget(node, agent, o.optString("name").ifEmpty { agent })
        } catch (_: Exception) { null }
    }
}

/** The number the watch dials to start a call (#1664). Never a real line:
 *  +214 is a spare ITU country code, so if a call ever reaches the SIM the
 *  network refuses it without connecting. */
object WatchNumber {
    const val NUMBER = "+21400000000"

    /** "+", then digits; a leading 00 counts as +. Spaces, dashes and the rest go. */
    fun normalise(raw: String): String {
        val t = raw.trim()
        val digits = t.filter { it.isDigit() }
        return when {
            t.startsWith("+") -> "+$digits"
            digits.startsWith("00") -> "+" + digits.substring(2)
            else -> digits
        }
    }

    /** Whether [dialed], as Telecom passes it, is the AgentX number. */
    fun matches(dialed: String?): Boolean = !dialed.isNullOrBlank() && normalise(dialed) == NUMBER
}

/** 16-bit mono PCM as a WAV file, which /api/app/voice/transcribe takes. */
object Wav {
    fun encode(pcm: ShortArray, rate: Int): ByteArray {
        val data = pcm.size * 2
        val out = ByteArray(44 + data)
        fun str(at: Int, s: String) = s.forEachIndexed { i, c -> out[at + i] = c.code.toByte() }
        fun int(at: Int, v: Int) { for (i in 0 until 4) out[at + i] = (v shr (8 * i)).toByte() }
        fun short(at: Int, v: Int) { out[at] = v.toByte(); out[at + 1] = (v shr 8).toByte() }
        str(0, "RIFF"); int(4, 36 + data); str(8, "WAVE")
        str(12, "fmt "); int(16, 16); short(20, 1); short(22, 1)
        int(24, rate); int(28, rate * 2); short(32, 2); short(34, 16)
        str(36, "data"); int(40, data)
        for (i in pcm.indices) short(44 + 2 * i, pcm[i].toInt())
        return out
    }
}

/** Server-sent events, one line at a time: returns (event, data) when a
 *  blank line ends one. */
class SseParser {
    private var event = "message"
    private val data = StringBuilder()

    fun line(raw: String): Pair<String, String>? {
        val line = raw.removeSuffix("\r")
        if (line.isEmpty()) {
            if (data.isEmpty()) { event = "message"; return null }
            val out = event to data.toString()
            event = "message"; data.setLength(0)
            return out
        }
        if (line.startsWith(":")) return null
        val field = line.substringBefore(':')
        val value = if (line.contains(':')) line.substringAfter(':').removePrefix(" ") else ""
        when (field) {
            "event" -> event = value
            "data" -> { if (data.isNotEmpty()) data.append('\n'); data.append(value) }
        }
        return null
    }
}

/**
 * Tells, frame by frame, when the owner has finished speaking. A frame is
 * loud when its peak is over [threshold]; speech starts after [startFrames]
 * loud frames in a row and ends after [silenceMs] without one. Nothing heard
 * in [noSpeechMs] ends it as silent; [maxMs] ends it in any case.
 */
class Endpointer(
    private val frameMs: Int = 20,
    private val threshold: Int = 700,
    private val startFrames: Int = 3,
    private val silenceMs: Int = 1500,
    private val noSpeechMs: Int = 8000,
    private val maxMs: Int = 45_000,
) {
    enum class State { WAITING, SPEAKING, DONE, SILENT, FULL }

    var state = State.WAITING; private set
    private var elapsed = 0
    private var loudRun = 0
    private var quietMs = 0

    fun frame(peak: Int): State {
        if (state != State.WAITING && state != State.SPEAKING) return state
        elapsed += frameMs
        val loud = peak > threshold
        loudRun = if (loud) loudRun + 1 else 0
        if (state == State.WAITING) {
            if (loudRun >= startFrames) { state = State.SPEAKING; quietMs = 0 }
            else if (elapsed >= noSpeechMs) state = State.SILENT
        } else {
            quietMs = if (loud) 0 else quietMs + frameMs
            if (quietMs >= silenceMs) state = State.DONE
        }
        if (elapsed >= maxMs && (state == State.WAITING || state == State.SPEAKING)) {
            state = if (state == State.SPEAKING) State.FULL else State.SILENT
        }
        return state
    }
}

/** An answer as words to say: no Markdown, no code, no links' addresses. */
object Speech {
    fun plain(text: String): String = text
        .replace(Regex("```[\\s\\S]*?```"), " (code left out) ")
        .replace(Regex("`([^`]*)`"), "$1")
        .replace(Regex("!?\\[([^\\]]*)]\\([^)]*\\)"), "$1")
        .replace(Regex("https?://\\S+"), "a link")
        .replace(Regex("(?m)^\\s{0,3}(#{1,6}|>|[-*+]|\\d+[.)])\\s+"), "")
        .replace(Regex("[*_~|]+"), "")
        .replace(Regex("[ \\t]+"), " ")
        .replace(Regex(" ?\\n ?"), "\n")
        .replace(Regex("\\n{2,}"), "\n")
        .trim()

    /** Pieces of at most [max] characters, cut after a sentence where possible. */
    fun chunks(text: String, max: Int): List<String> {
        val out = mutableListOf<String>()
        var rest = text.trim()
        while (rest.length > max) {
            val window = rest.substring(0, max)
            var cut = maxOf(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf('\n'))
            cut = if (cut > max / 3) cut + 1 else window.lastIndexOf(' ').takeIf { it > max / 3 } ?: max
            out.add(rest.substring(0, cut).trim())
            rest = rest.substring(cut).trim()
        }
        if (rest.isNotEmpty()) out.add(rest)
        return out
    }
}
