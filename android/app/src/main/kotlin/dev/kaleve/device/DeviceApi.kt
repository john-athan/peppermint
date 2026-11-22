// Owned by oss-kit (templates/shared/android-device). Change it there and run `oss sync-tooling`, never in a copy.
package dev.kaleve.device

import android.os.Build
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

class Unauthorized : IOException("unauthorized")
class ApiError(val status: Int) : IOException("status $status")

/**
 * The device side of the accounts module (docs/accounts.md, "Devices"): HttpURLConnection and org.json, nothing else.
 * The token only ever goes into the Authorization header. An app's own calls build on [open], [send] and [call].
 */
open class DeviceApi(protected val server: String, protected val token: String? = null) {

    fun open(path: String, method: String): HttpURLConnection {
        val c = URL(server + path).openConnection() as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 15_000
        c.readTimeout = 60_000
        c.instanceFollowRedirects = false
        c.setRequestProperty("Accept", "application/json")
        token?.let { c.setRequestProperty("Authorization", "Bearer $it") }
        return c
    }

    fun body(c: HttpURLConnection): String {
        val s: InputStream? = if (c.responseCode < 400) c.inputStream else c.errorStream
        return s?.bufferedReader()?.use { it.readText() } ?: ""
    }

    /** Sends [payload] (if any) and returns status and body. */
    fun send(c: HttpURLConnection, payload: JSONObject?): Pair<Int, String> {
        if (payload != null) {
            c.doOutput = true
            c.setRequestProperty("Content-Type", "application/json")
            val bytes = payload.toString().toByteArray()
            c.setFixedLengthStreamingMode(bytes.size)
            c.outputStream.use { it.write(bytes) }
        }
        val code = c.responseCode
        return code to body(c)
    }

    /** A JSON call with the token: Unauthorized on 401/403 (the device was removed), ApiError on any other refusal. */
    fun call(method: String, path: String, payload: JSONObject? = null): JSONObject {
        val (status, text) = send(open(path, method), payload)
        if (status == 401 || status == 403) throw Unauthorized()
        if (status !in 200..299) throw ApiError(status)
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }

    /** Trades the pairing code for a device token. Throws ApiError(400/404/410/429) on refusal. */
    fun claim(code: String, kind: String = "android"): String {
        val c = open("/api/devices/claim", "POST")
        val (status, text) = send(c, JSONObject().put("code", normalizeCode(code)).put("name", deviceName()).put("kind", kind))
        if (status !in 200..299) throw ApiError(status)
        return JSONObject(text).getString("token")
    }

    companion object {
        fun deviceName(): String = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ").take(60).ifBlank { "Android" }
    }
}
