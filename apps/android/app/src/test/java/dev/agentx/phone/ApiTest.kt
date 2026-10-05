package dev.agentx.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ApiTest {
    @Test
    fun normalisesWhatTheOwnerTyped() {
        assertEquals("https://box.example.ts.net", Api.normaliseAddress("box.example.ts.net"))
        assertEquals("https://box.example.ts.net", Api.normaliseAddress(" https://box.example.ts.net/app/ "))
        assertEquals("https://box.example.ts.net:8443", Api.normaliseAddress("https://box.example.ts.net:8443/app"))
        assertEquals("https://box.example.ts.net", Api.normaliseAddress("https://box.example.ts.net:443"))
    }

    @Test
    fun refusesAnythingButHttps() {
        assertNull(Api.normaliseAddress(""))
        assertNull(Api.normaliseAddress("http://box.example.ts.net"))
        assertNull(Api.normaliseAddress("ftp://box.example.ts.net"))
    }
}
