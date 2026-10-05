package dev.agentx.phone

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** An answer from the computer that isn't a success. */
class ApiError(val status: Int, message: String) : IOException(message)

/**
 * Calls to the computer's phone-app API. Blocking: call from a worker or a
 * background thread. Every call but pairing sends the device token as a
 * Bearer header, the way the phone app's own API allows non-browser clients.
 */
object Api {
    private const val TIMEOUT_MS = 15_000

    /** Trades a one-time pairing code for this phone's device token. */
    fun redeemCode(server: String, code: String): String {
        val c = open("$server/api/app/pair-code", "POST", null)
        c.setRequestProperty("Content-Type", "application/json")
        c.outputStream.use { it.write("{\"code\":\"${Protocol.normalizeCode(code)}\"}".toByteArray()) }
        val status = c.responseCode
        val body = read(c)
        if (status != 200) throw ApiError(status, Protocol.errorOf(body))
        return Protocol.tokenFromSetCookie(c.headerFields["Set-Cookie"] ?: c.headerFields["set-cookie"] ?: emptyList())
            ?: throw ApiError(status, "the computer answered without a session")
    }

    /** The device name the token belongs to; checks the token works. */
    fun me(server: String, token: String): String {
        val body = call(server, token, "GET", "/api/app/me", null)
        return org.json.JSONObject(body).optString("device", "Phone")
    }

    fun places(server: String, token: String): PlacesSnapshot =
        Protocol.parsePlaces(call(server, token, "GET", "/api/app/places", null))

    fun postEvent(server: String, token: String, json: String) {
        call(server, token, "POST", "/api/app/places/events", json)
    }

    private fun call(server: String, token: String, method: String, path: String, json: String?): String {
        val c = open(server + path, method, token)
        if (json != null) {
            c.setRequestProperty("Content-Type", "application/json")
            c.outputStream.use { it.write(json.toByteArray()) }
        }
        val status = c.responseCode
        val body = read(c)
        if (status !in 200..299) throw ApiError(status, Protocol.errorOf(body))
        return body
    }

    private fun open(url: String, method: String, token: String?): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = TIMEOUT_MS
        c.readTimeout = TIMEOUT_MS
        c.instanceFollowRedirects = false
        c.setRequestProperty("Accept", "application/json")
        if (token != null) c.setRequestProperty("Authorization", "Bearer $token")
        if (method == "POST") c.doOutput = true
        return c
    }

    private fun read(c: HttpURLConnection): String {
        val stream = if (c.responseCode in 200..299) c.inputStream else c.errorStream
        return stream?.bufferedReader()?.use { it.readText() } ?: ""
    }
}
