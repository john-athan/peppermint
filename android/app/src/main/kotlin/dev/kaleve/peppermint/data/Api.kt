package dev.kaleve.peppermint.data

import dev.kaleve.device.ApiError
import dev.kaleve.device.DeviceApi
import dev.kaleve.device.Unauthorized
import dev.kaleve.peppermint.core.SseParser
import org.json.JSONObject
import java.io.IOException

/** peppermint's own calls; pairing, the token header and the error mapping are the shared DeviceApi. */
class Api(server: String, token: String? = null) : DeviceApi(server, token) {

    fun queue(): JSONObject = call("GET", "/api/listen/queue")

    fun episode(id: Long): Episode = Episode.from(call("GET", "/api/listen/episodes/$id"))

    fun heard(id: Long) { call("POST", "/api/listen/episodes/$id/heard", JSONObject()) }

    /**
     * The edition's script, read from the same stream the Listen page uses: `delta` events carry the text in `t`,
     * `done` ends it, `error` gives up (IOException). A stream that ends without `done` is an error too.
     */
    fun editionScript(lang: String): String {
        val c = open("/api/listen?lang=$lang", "GET")
        c.setRequestProperty("Accept", "text/event-stream")
        c.readTimeout = 120_000
        val status = c.responseCode
        if (status == 401 || status == 403) throw Unauthorized()
        if (status !in 200..299) throw ApiError(status)
        val script = StringBuilder()
        val sse = SseParser()
        c.inputStream.bufferedReader().use { r ->
            while (true) {
                val line = r.readLine() ?: throw IOException("stream ended early")
                val e = sse.feed(line) ?: continue
                when (e.name) {
                    "delta" -> script.append(JSONObject(e.data).optString("t"))
                    "done" -> return script.toString()
                    "error" -> throw IOException("script failed")
                }
            }
        }
    }
}
