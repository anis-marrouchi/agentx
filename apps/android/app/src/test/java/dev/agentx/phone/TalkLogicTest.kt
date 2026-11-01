package dev.agentx.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TalkLogicTest {
    @Test
    fun wavHeaderDescribesTheRecording() {
        val wav = Wav.encode(shortArrayOf(1, -2, 0x1234), 16000)
        assertEquals(44 + 6, wav.size)
        assertEquals("RIFF", String(wav, 0, 4))
        assertEquals("WAVE", String(wav, 8, 4))
        assertEquals("data", String(wav, 36, 4))
        fun int(at: Int) = (0 until 4).sumOf { (wav[at + it].toInt() and 0xff) shl (8 * it) }
        assertEquals(36 + 6, int(4))
        assertEquals(16000, int(24))
        assertEquals(32000, int(28))
        assertEquals(6, int(40))
        // Little-endian samples.
        assertEquals(0x34.toByte(), wav[48])
        assertEquals(0x12.toByte(), wav[49])
        assertEquals(0xfe.toByte(), wav[46])
        assertEquals(0xff.toByte(), wav[47])
    }

    @Test
    fun sseGivesEachEventWhenItEnds() {
        val p = SseParser()
        val lines = listOf(
            "event: conversation", "data: {\"id\":\"c1\"}", "",
            ": keep-alive", "",
            "event: delta", "data: a", "data: b", "",
            "data: plain", "\r",
        )
        val out = lines.mapNotNull { p.line(it) }
        assertEquals(listOf("conversation" to "{\"id\":\"c1\"}", "delta" to "a\nb", "message" to "plain"), out)
    }

    @Test
    fun endpointerEndsAfterTheSilenceThatFollowsSpeech() {
        val ep = Endpointer(frameMs = 20, threshold = 700, startFrames = 3, silenceMs = 100, noSpeechMs = 1000)
        repeat(5) { assertEquals(Endpointer.State.WAITING, ep.frame(50)) }
        // A single click is not speech.
        assertEquals(Endpointer.State.WAITING, ep.frame(5000))
        assertEquals(Endpointer.State.WAITING, ep.frame(50))
        repeat(2) { ep.frame(2000) }
        assertEquals(Endpointer.State.SPEAKING, ep.frame(2000))
        repeat(4) { assertEquals(Endpointer.State.SPEAKING, ep.frame(50)) }
        assertEquals(Endpointer.State.DONE, ep.frame(50))
        assertEquals(Endpointer.State.DONE, ep.frame(5000))
    }

    @Test
    fun endpointerGivesUpWhenNothingIsSaid() {
        val ep = Endpointer(frameMs = 20, noSpeechMs = 200)
        repeat(9) { assertEquals(Endpointer.State.WAITING, ep.frame(100)) }
        assertEquals(Endpointer.State.SILENT, ep.frame(100))
    }

    @Test
    fun endpointerStopsAtTheLongestTurn() {
        val ep = Endpointer(frameMs = 20, startFrames = 1, silenceMs = 10_000, maxMs = 100)
        repeat(4) { ep.frame(3000) }
        assertEquals(Endpointer.State.FULL, ep.frame(3000))
    }

    @Test
    fun speechDropsMarkdownCodeAndAddresses() {
        val said = Speech.plain("# Plan\n\n- **Buy** milk\n- See [the list](https://example.com/x)\n\n```\nrm -rf /\n```\nRun `make` at https://example.com now.")
        assertEquals("Plan\nBuy milk\nSee the list\n(code left out)\nRun make at a link now.", said)
    }

    @Test
    fun speechChunksCutAfterASentence() {
        val text = "One two three. Four five six. Seven eight nine."
        val parts = Speech.chunks(text, 20)
        assertTrue(parts.all { it.length <= 20 })
        assertEquals(listOf("One two three.", "Four five six.", "Seven eight nine."), parts)
        assertEquals(listOf("short"), Speech.chunks("short", 20))
        assertEquals(text.replace(" ", ""), Speech.chunks(text, 7).joinToString("").replace(" ", ""))
    }

    @Test
    fun targetRoundTripsAndRefusesHalfOfOne() {
        val t = TalkTarget("local", "helper", "Helper")
        assertEquals(t, TalkTarget.fromJson(t.toJson()))
        assertEquals("helper", TalkTarget.fromJson("{\"node\":\"local\",\"agent\":\"helper\"}")?.name)
        assertNull(TalkTarget.fromJson("{\"node\":\"local\"}"))
        assertNull(TalkTarget.fromJson("not json"))
        assertNull(TalkTarget.fromJson(null))
    }

    @Test
    fun agentNumberMatchesHowEverItIsWritten() {
        val ours = AgentNumber.DEFAULT
        assertTrue(AgentNumber.matches("+21400000000", ours))
        assertTrue(AgentNumber.matches("0021400000000", ours))
        assertTrue(AgentNumber.matches("+214 00-000 000", ours))
        assertEquals("+21400000000", AgentNumber.normalise(" 00 214 0000 0000 "))
    }

    @Test
    fun otherNumbersAreLeftAlone() {
        val ours = AgentNumber.DEFAULT
        // Without the country code it is another number, so it goes out unchanged.
        assertFalse(AgentNumber.matches("21400000000", ours))
        assertFalse(AgentNumber.matches("+21400000001", ours))
        assertFalse(AgentNumber.matches("112", ours))
        assertFalse(AgentNumber.matches("", ours))
        assertFalse(AgentNumber.matches(null, ours))
        // Short numbers never match, even an equally short "ours".
        assertFalse(AgentNumber.matches("+123", "+123"))
    }

    @Test
    fun maskedNumbersKeepOnlyTheLastDigits() {
        assertEquals("…567", AgentNumber.masked("+44 1234 567"))
        assertEquals("…", AgentNumber.masked("112"))
        assertEquals("?", AgentNumber.masked(null))
    }

    @Test
    fun aDroppedWatchIsAskedForAgainWithinLimits() {
        assertTrue(WatchRoute.askAgain(onWatch = false, bluetoothOffered = true, msSinceLastAsk = 600, asks = 0))
        // On the watch already, or no watch connected: nothing to ask.
        assertFalse(WatchRoute.askAgain(onWatch = true, bluetoothOffered = true, msSinceLastAsk = 600, asks = 0))
        assertFalse(WatchRoute.askAgain(onWatch = false, bluetoothOffered = false, msSinceLastAsk = 600, asks = 0))
        // Too soon after the last ask, or asked enough for this drop.
        assertFalse(WatchRoute.askAgain(onWatch = false, bluetoothOffered = true, msSinceLastAsk = 100, asks = 1))
        assertFalse(WatchRoute.askAgain(onWatch = false, bluetoothOffered = true, msSinceLastAsk = 600, asks = WatchRoute.MAX_ASKS))
    }

    @Test
    fun micLevelGivesOneLinePerFullSecond() {
        val level = MicLevel(samplesPerSecond = 4)
        val pcm = shortArrayOf(100, -100, 100, -100, 3, -4)
        // Not a full second yet.
        assertEquals(emptyList<MicLevel.Second>(), level.add(pcm, 0, 3))
        // The fourth sample completes second 1: rms 100, peak 100.
        assertEquals(listOf(MicLevel.Second(1, 100, 100)), level.add(pcm, 3, 3))
        // Second 2 starts fresh from the samples after it.
        assertEquals(listOf(MicLevel.Second(2, 3, 4)), level.add(shortArrayOf(3, 3), 0, 2))
    }
}
