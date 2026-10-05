package dev.agentx.phone

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** Plain HTTPS calls to the paired computer's /api/app routes. Blocking:
 *  call off the main thread. */
object Api {
    class HttpError(val status: Int, message: String) : IOException(message)

    private const val COOKIE = "agentx_app"

    /** Normalises what the owner typed: https only, no path, no slash. */
    fun normaliseAddress(input: String): String? {
        var s = input.trim()
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val url = try { URL(s) } catch (e: Exception) { return null }
        if (url.protocol != "https" || url.host.isNullOrEmpty()) return null
        return "https://" + url.host + (if (url.port > 0 && url.port != 443) ":${url.port}" else "")
    }

    /** Trades a pairing code for this phone's device key. The computer
     *  answers with the key in its session cookie, the same one the phone
     *  app gets; it is read from that header. */
    fun pairWithCode(base: String, code: String): String {
        val conn = open("$base/api/app/pair-code", "POST", null)
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(JSONObject().put("code", code).toString().toByteArray()) }
        val status = conn.responseCode
        if (status != 200) throw HttpError(status, errorText(conn))
        val cookies = conn.headerFields.entries.filter { it.key?.equals("Set-Cookie", true) == true }.flatMap { it.value }
        for (c in cookies) {
            val first = c.substringBefore(';')
            if (first.substringBefore('=').trim() == COOKIE) {
                val token = first.substringAfter('=').trim()
                if (token.isNotEmpty()) return token
            }
        }
        throw IOException("The computer accepted the code but sent no key.")
    }

    fun getPlaces(base: String, token: String): JSONObject {
        val conn = open("$base/api/app/places", "GET", token)
        val status = conn.responseCode
        if (status != 200) throw HttpError(status, errorText(conn))
        return JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
    }

    /** Sends one crossing. Returns the HTTP status. [quick] keeps it short
     *  enough to finish inside the geofence broadcast. */
    fun postEvent(base: String, token: String, event: JSONObject, quick: Boolean = false): Int {
        val conn = open("$base/api/app/places/event", "POST", token)
        if (quick) {
            conn.connectTimeout = 4_000
            conn.readTimeout = 4_000
        }
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(event.toString().toByteArray()) }
        val status = conn.responseCode
        try { (if (status < 400) conn.inputStream else conn.errorStream)?.close() } catch (_: IOException) {}
        return status
    }

    private fun open(url: String, method: String, token: String?): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 15_000
        conn.readTimeout = 20_000
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        conn.setRequestProperty("Accept", "application/json")
        if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
        if (method == "POST") conn.doOutput = true
        return conn
    }

    private fun errorText(conn: HttpURLConnection): String {
        val body = try { conn.errorStream?.bufferedReader()?.use { it.readText() } } catch (_: IOException) { null }
        val msg = try { body?.let { JSONObject(it).optString("error") } } catch (_: Exception) { null }
        return if (!msg.isNullOrBlank()) msg else "The computer answered HTTP ${conn.responseCode}."
    }
}
