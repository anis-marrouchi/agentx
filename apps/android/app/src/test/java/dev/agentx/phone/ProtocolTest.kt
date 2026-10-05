package dev.agentx.phone

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolTest {
    @Test
    fun normalizesWhatTheOwnerTypes() {
        assertEquals("https://my-mac.example.ts.net", Protocol.normalizeServer(" My-Mac.example.ts.net "))
        assertEquals("https://my-mac.example.ts.net", Protocol.normalizeServer("https://my-mac.example.ts.net/app"))
        assertEquals("https://host.example.com:8443", Protocol.normalizeServer("https://host.example.com:8443/"))
        assertNull(Protocol.normalizeServer("http://host.example.com"))
        assertNull(Protocol.normalizeServer("https://user@host.example.com"))
        assertNull(Protocol.normalizeServer(""))
    }

    @Test
    fun readsAPairingLink() {
        val link = Protocol.parsePairLink("https://my-mac.example.ts.net/app/pair#token=agx_live_0123456789abcdef")
        assertEquals(PairLink("https://my-mac.example.ts.net", "agx_live_0123456789abcdef"), link)
        assertNull(Protocol.parsePairLink("https://my-mac.example.ts.net/app"))
        assertNull(Protocol.parsePairLink("https://my-mac.example.ts.net/app/pair#token=short"))
    }

    @Test
    fun normalizesACode() {
        assertEquals("ABCDEFGH", Protocol.normalizeCode(" abcd-efgh "))
    }

    @Test
    fun findsTheTokenInSetCookie() {
        val headers = listOf("other=1; Path=/", "agentx_app=agx_live_secret; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Lax")
        assertEquals("agx_live_secret", Protocol.tokenFromSetCookie(headers))
        assertNull(Protocol.tokenFromSetCookie(listOf("agentx_app=; Path=/")))
        assertNull(Protocol.tokenFromSetCookie(emptyList()))
    }

    @Test
    fun parsesThePlaceListAndDropsWhatAGeofenceCantHold() {
        val body = """
            {"enabled":true,"version":"2-1-x","places":[
              {"id":"pl_a","name":"School","lat":48.85,"lon":2.29,"radiusMeters":150},
              {"id":"pl_b","name":"Broken","lat":null,"lon":2.29,"radiusMeters":150},
              {"id":"","name":"No id","lat":1,"lon":1,"radiusMeters":150}
            ],"reminders":[],"settings":{"responsivenessSeconds":30,"syncMinutes":5}}
        """.trimIndent()
        val s = Protocol.parsePlaces(body)
        assertTrue(s.enabled)
        assertEquals("2-1-x", s.version)
        assertEquals(listOf(PlaceDef("pl_a", "School", 48.85, 2.29, 150f)), s.places)
        assertEquals(30, s.responsivenessSeconds)
        assertEquals(15, s.syncMinutes) // WorkManager's floor
    }

    @Test
    fun readsPlacesTurnedOff() {
        val s = Protocol.parsePlaces("""{"enabled":false,"reason":"off here","version":"off","places":[]}""")
        assertFalse(s.enabled)
        assertEquals("off here", s.reason)
        assertTrue(s.places.isEmpty())
    }

    @Test
    fun anEventCarriesOnlyThePlaceTheDirectionAndTheTime() {
        val o = JSONObject(Protocol.eventJson("evt-1", "pl_a", true, 0))
        assertEquals(setOf("id", "place", "transition", "at"), o.keySet())
        assertEquals("enter", o.getString("transition"))
        assertEquals("1970-01-01T00:00:00Z", o.getString("at"))
        assertEquals("exit", JSONObject(Protocol.eventJson("evt-2", "pl_a", false, 0)).getString("transition"))
    }

    @Test
    fun readsAnErrorBody() {
        assertEquals("no such place", Protocol.errorOf("""{"error":"no such place"}"""))
        assertEquals("<html>", Protocol.errorOf("<html>"))
    }
}
