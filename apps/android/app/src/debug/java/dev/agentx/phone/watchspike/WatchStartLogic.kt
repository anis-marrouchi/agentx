package dev.agentx.phone.watchspike

import java.io.BufferedReader
import java.nio.ByteBuffer
import java.nio.ByteOrder

// Pure parts of the watch-side start (#1664), kept apart so unit tests can
// run them off the phone: the AgentX number, the WAV the computer takes,
// the chat stream's events and the end-of-speech detector.

/** The number the watch dials. Never a real line: +214 is a spare ITU
 *  country code, so if the phone ever lets the call reach the SIM, the
 *  network refuses it without connecting. */
object AgentNumber {
    const val DEFAULT = "+21400000000"

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

    /** Whether [dialed] (a tel: number as Telecom passes it) is ours. */
    fun matches(dialed: String?, ours: String): Boolean {
        if (dialed.isNullOrBlank()) return false
        val a = normalise(dialed)
        val b = normalise(ours)
        return a.length >= 6 && a == b
    }

    /** For the log: the last 3 digits only, so other people's numbers stay out of it. */
    fun masked(number: String?): String {
        val d = number?.filter { it.isDigit() } ?: return "?"
        return if (d.length <= 3) "…" else "…" + d.takeLast(3)
    }
}

/** 16-bit mono PCM as a WAV file, the format /api/app/voice/transcribe takes. */
object Wav {
    fun encode(pcm: ShortArray, rate: Int): ByteArray {
        val data = pcm.size * 2
        val b = ByteBuffer.allocate(44 + data).order(ByteOrder.LITTLE_ENDIAN)
        b.put("RIFF".toByteArray()).putInt(36 + data).put("WAVE".toByteArray())
        b.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1).putInt(rate).putInt(rate * 2).putShort(2).putShort(16)
        b.put("data".toByteArray()).putInt(data)
        for (s in pcm) b.putShort(s)
        return b.array()
    }
}

/** Server-sent events from POST /api/app/chat: `event: x` + `data: {...}`, blank line between. */
object Sse {
    /** Reads events until [onEvent] returns false or the stream ends. Comments (": ping") are skipped. */
    fun read(reader: BufferedReader, onEvent: (name: String, data: String) -> Boolean) {
        var name = "message"
        val data = StringBuilder()
        while (true) {
            val line = reader.readLine() ?: return
            when {
                line.isEmpty() -> {
                    if (data.isNotEmpty() && !onEvent(name, data.toString())) return
                    name = "message"
                    data.setLength(0)
                }
                line.startsWith(":") -> {}
                line.startsWith("event:") -> name = line.substringAfter(':').trim()
                line.startsWith("data:") -> {
                    if (data.isNotEmpty()) data.append('\n')
                    data.append(line.substringAfter(':').removePrefix(" "))
                }
            }
        }
    }
}

/**
 * Says when one spoken turn ends, from 20 ms frames: speech starts after
 * [startFrames] loud frames in a row, and ends after [endMs] of quiet.
 * "Loud" is above 3 × the quietest level heard so far, and never below
 * [minLevel], so a noisy room doesn't count as talking.
 */
class Endpointer(
    private val frameMs: Int = 20,
    private val startFrames: Int = 3,
    private val endMs: Int = 1200,
    private val minLevel: Double = 500.0,
) {
    enum class State { WAITING, SPEAKING, DONE }

    var state = State.WAITING
        private set
    private var floor = Double.MAX_VALUE
    private var loudRun = 0
    private var quietMs = 0

    fun feed(frame: ShortArray, n: Int = frame.size): State {
        if (state == State.DONE || n == 0) return state
        val level = rms(frame, n)
        if (level < floor) floor = level
        val loud = level > maxOf(minLevel, floor * 3)
        when (state) {
            State.WAITING -> { loudRun = if (loud) loudRun + 1 else 0; if (loudRun >= startFrames) state = State.SPEAKING }
            State.SPEAKING -> { quietMs = if (loud) 0 else quietMs + frameMs; if (quietMs >= endMs) state = State.DONE }
            State.DONE -> {}
        }
        return state
    }

    companion object {
        fun rms(frame: ShortArray, n: Int = frame.size): Double {
            var sum = 0.0
            for (i in 0 until n) sum += frame[i].toDouble() * frame[i]
            return Math.sqrt(sum / n)
        }
    }
}
