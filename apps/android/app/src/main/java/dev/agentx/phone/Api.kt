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

    // --- Talk to AgentX (#1636): the phone app's own Chat and voice routes ---

    /** GET /api/app/agents: the agents this phone may talk to, by node. */
    fun getAgents(base: String, token: String): List<TalkTarget> {
        val conn = open("$base/api/app/agents", "GET", token)
        val status = conn.responseCode
        if (status != 200) throw HttpError(status, errorText(conn))
        val nodes = JSONObject(conn.inputStream.bufferedReader().use { it.readText() }).optJSONArray("nodes") ?: return emptyList()
        val out = mutableListOf<TalkTarget>()
        for (i in 0 until nodes.length()) {
            val n = nodes.optJSONObject(i) ?: continue
            val target = n.optString("target").takeIf { !n.isNull("target") && it.isNotEmpty() } ?: continue
            if (!n.optBoolean("online")) continue
            val agents = n.optJSONArray("agents") ?: continue
            val many = nodes.length() > 1
            for (j in 0 until agents.length()) {
                val a = agents.optJSONObject(j) ?: continue
                val name = a.optString("name").ifEmpty { a.optString("id") }
                out.add(TalkTarget(target, a.optString("id"), if (many) "$name (${n.optString("name")})" else name))
            }
        }
        return out
    }

    /** POST /api/app/voice/transcribe with a WAV recording. Returns the words. */
    fun transcribe(base: String, token: String, wav: ByteArray, ms: Long): String {
        val conn = open("$base/api/app/voice/transcribe", "POST", token)
        conn.readTimeout = 180_000
        conn.setRequestProperty("Content-Type", "audio/wav")
        conn.setRequestProperty("X-Audio-Duration-Ms", ms.toString())
        conn.setFixedLengthStreamingMode(wav.size)
        conn.outputStream.use { it.write(wav) }
        val status = conn.responseCode
        if (status != 200) throw HttpError(status, errorText(conn))
        return JSONObject(conn.inputStream.bufferedReader().use { it.readText() }).optString("text").trim()
    }

    class Reply(val conversationId: String?, val status: String, val content: String, val error: String?)

    /** POST /api/app/chat and read its stream to the final answer. [hold]
     *  gets the connection first, so a hang-up can cut it; the computer
     *  finishes the answer and keeps it in Chat either way. */
    fun chat(base: String, token: String, body: JSONObject, hold: (HttpURLConnection) -> Unit): Reply {
        val conn = open("$base/api/app/chat", "POST", token)
        conn.readTimeout = 15 * 60_000
        conn.setRequestProperty("Accept", "text/event-stream")
        conn.setRequestProperty("Content-Type", "application/json")
        hold(conn)
        conn.outputStream.use { it.write(body.toString().toByteArray()) }
        val status = conn.responseCode
        if (status != 200) throw HttpError(status, errorText(conn))
        var id: String? = null
        val sse = SseParser()
        conn.inputStream.bufferedReader().use { r ->
            while (true) {
                val line = r.readLine() ?: break
                val (event, data) = sse.line(line) ?: continue
                val o = try { JSONObject(data) } catch (_: Exception) { continue }
                when (event) {
                    "conversation" -> id = o.optString("id").ifEmpty { id }
                    "final" -> return Reply(id, o.optString("status", "done"), o.optString("content"), o.optString("error").ifEmpty { null })
                }
            }
        }
        throw IOException("The answer stopped before it was done.")
    }

    /** POST /api/app/voice/speak: the answer in the agent's voice, as
     *  (content type, bytes). Null when the computer has no voice for it;
     *  the phone then says the answer itself. */
    fun speak(base: String, token: String, conversationId: String, text: String): Pair<String, ByteArray>? {
        val conn = open("$base/api/app/voice/speak", "POST", token)
        conn.readTimeout = 90_000
        conn.setRequestProperty("Accept", "audio/*, application/json")
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(JSONObject().put("conversationId", conversationId).put("text", text).toString().toByteArray()) }
        val status = conn.responseCode
        val type = conn.contentType ?: ""
        if (status == 200 && type.startsWith("audio/")) return type to conn.inputStream.use { it.readBytes() }
        try { (if (status < 400) conn.inputStream else conn.errorStream)?.close() } catch (_: IOException) {}
        return null
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
