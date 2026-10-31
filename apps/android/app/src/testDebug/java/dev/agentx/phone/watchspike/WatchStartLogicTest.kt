package dev.agentx.phone.watchspike

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.StringReader

class WatchStartLogicTest {
    @Test
    fun matchesTheAgentNumberHoweverItIsWritten() {
        val ours = AgentNumber.DEFAULT
        assertTrue(AgentNumber.matches("+21400000000", ours))
        assertTrue(AgentNumber.matches("0021400000000", ours))
        assertTrue(AgentNumber.matches("+214 00 000 000", ours))
        assertTrue(AgentNumber.matches("+214-0000-0000", ours))
    }

    @Test
    fun leavesOtherNumbersAlone() {
        val ours = AgentNumber.DEFAULT
        assertFalse(AgentNumber.matches("+21698000000", ours))
        assertFalse(AgentNumber.matches("21400000000", ours))
        assertFalse(AgentNumber.matches("112", ours))
        assertFalse(AgentNumber.matches("", ours))
        assertFalse(AgentNumber.matches(null, ours))
    }

    @Test
    fun masksNumbersInTheLog() {
        assertEquals("…567", AgentNumber.masked("+216 98 234 567"))
        assertEquals("…", AgentNumber.masked("112"))
    }

    @Test
    fun writesAWavHeader() {
        val wav = Wav.encode(shortArrayOf(1, -1), 16000)
        assertEquals(48, wav.size)
        assertEquals("RIFF", String(wav, 0, 4))
        assertEquals("WAVE", String(wav, 8, 4))
        assertEquals("data", String(wav, 36, 4))
        assertEquals(4, wav[40].toInt())
        assertEquals(1, wav[44].toInt())
        assertEquals(-1, wav[47].toInt())
    }

    @Test
    fun readsChatStreamEventsUntilFinal() {
        val stream = """
            event: conversation
            data: {"id":"c1"}

            : ping

            event: delta
            data: {"text":"Hi"}

            event: final
            data: {"content":"Hello"}

            event: after
            data: {}

        """.trimIndent()
        val seen = mutableListOf<String>()
        Sse.read(BufferedReader(StringReader(stream))) { name, data -> seen.add("$name $data"); name != "final" }
        assertEquals(listOf("conversation {\"id\":\"c1\"}", "delta {\"text\":\"Hi\"}", "final {\"content\":\"Hello\"}"), seen)
    }

    @Test
    fun endsATurnAfterSpeechThenQuiet() {
        val ep = Endpointer()
        val quiet = ShortArray(320) { 50 }
        val loud = ShortArray(320) { if (it % 2 == 0) 4000 else -4000 }
        repeat(20) { assertEquals(Endpointer.State.WAITING, ep.feed(quiet)) }
        ep.feed(loud); ep.feed(loud)
        assertEquals(Endpointer.State.SPEAKING, ep.feed(loud))
        repeat(59) { assertEquals(Endpointer.State.SPEAKING, ep.feed(quiet)) }
        assertEquals(Endpointer.State.DONE, ep.feed(quiet))
    }

    @Test
    fun aQuietRoomIsNotSpeech() {
        val ep = Endpointer()
        val hum = ShortArray(320) { if (it % 2 == 0) 300 else -300 }
        repeat(200) { assertEquals(Endpointer.State.WAITING, ep.feed(hum)) }
    }
}
