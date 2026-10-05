package dev.agentx.phone

import org.json.JSONObject
import java.net.URI
import java.time.Instant

// What the shell sends to and reads from the computer, kept free of Android
// classes so it is tested on the JVM (ProtocolTest).
//
// The computer's API is the phone app's own (/api/app/*), with the same
// device token the phone app holds: nothing here is new to the server
// except /api/app/places*.

data class PlaceDef(val id: String, val name: String, val lat: Double, val lon: Double, val radiusMeters: Float)

data class PlacesSnapshot(
    val enabled: Boolean,
    val reason: String?,
    val version: String,
    val places: List<PlaceDef>,
    val responsivenessSeconds: Int,
    val syncMinutes: Int,
)

data class PairLink(val origin: String, val token: String)

object Protocol {
    const val COOKIE = "agentx_app"

    /**
     * The computer's address as an https origin, from what the owner typed:
     * "my-mac.example.ts.net", "https://my-mac.example.ts.net/app" or a
     * whole pairing link. Null when it isn't one. Only https: the phone app
     * and Chrome's Trusted Web Activity both need it.
     */
    fun normalizeServer(input: String): String? {
        var s = input.trim()
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "https://$s"
        val uri = try { URI(s) } catch (e: Exception) { return null }
        if (!uri.scheme.equals("https", ignoreCase = true)) return null
        val host = uri.host ?: return null
        if (uri.userInfo != null) return null
        val port = if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
        return "https://${host.lowercase()}$port"
    }

    /** The link `agentx app pair` prints as a QR code: origin/app/pair#token=… */
    fun parsePairLink(input: String): PairLink? {
        val s = input.trim()
        val i = s.indexOf("#token=")
        if (i < 0) return null
        val origin = normalizeServer(s.substring(0, i)) ?: return null
        val token = s.substring(i + 7).substringBefore('&').trim()
        return if (token.length >= 16) PairLink(origin, token) else null
    }

    /** A pairing code as `agentx app pair` prints it, without spaces or dashes, upper case. */
    fun normalizeCode(input: String): String = input.filter { it.isLetterOrDigit() }.uppercase()

    /** The device token from the Set-Cookie headers of POST /api/app/pair-code. */
    fun tokenFromSetCookie(headers: List<String>): String? {
        for (h in headers) {
            val first = h.substringBefore(';').trim()
            val eq = first.indexOf('=')
            if (eq > 0 && first.substring(0, eq).trim() == COOKIE) {
                val v = first.substring(eq + 1).trim()
                if (v.isNotEmpty()) return v
            }
        }
        return null
    }

    /** GET /api/app/places, keeping only places a geofence can hold. */
    fun parsePlaces(body: String): PlacesSnapshot {
        val o = JSONObject(body)
        val settings = o.optJSONObject("settings")
        val list = o.optJSONArray("places")
        val places = mutableListOf<PlaceDef>()
        if (list != null) {
            for (i in 0 until list.length()) {
                val p = list.optJSONObject(i) ?: continue
                val id = p.optString("id")
                val lat = p.optDouble("lat", Double.NaN)
                val lon = p.optDouble("lon", Double.NaN)
                val r = p.optDouble("radiusMeters", Double.NaN)
                if (id.isEmpty() || lat.isNaN() || lon.isNaN() || r.isNaN() || r <= 0) continue
                places.add(PlaceDef(id, p.optString("name", id), lat, lon, r.toFloat()))
            }
        }
        return PlacesSnapshot(
            enabled = o.optBoolean("enabled", false),
            reason = if (o.isNull("reason")) null else o.optString("reason"),
            version = o.optString("version", ""),
            // Android holds at most 100 geofences per app.
            places = places.take(100),
            responsivenessSeconds = settings?.optInt("responsivenessSeconds", 60) ?: 60,
            syncMinutes = maxOf(15, settings?.optInt("syncMinutes", 360) ?: 360),
        )
    }

    /** The one thing a geofence event sends: which place, which way, when. */
    fun eventJson(id: String, placeId: String, enter: Boolean, atMillis: Long): String =
        JSONObject()
            .put("id", id)
            .put("place", placeId)
            .put("transition", if (enter) "enter" else "exit")
            .put("at", Instant.ofEpochMilli(atMillis).toString())
            .toString()

    /** The error text in a JSON answer, or the start of the body. */
    fun errorOf(body: String): String =
        try { JSONObject(body).optString("error").ifEmpty { body.take(160) } } catch (e: Exception) { body.take(160) }
}
