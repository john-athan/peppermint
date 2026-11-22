package dev.kaleve.peppermint.core

/** One server-sent event: its name (`message` when the stream gives none) and the data lines joined with a newline. */
data class SseEvent(val name: String, val data: String)

/**
 * Reads an event stream line by line, the way the Listen page does: `event:` names the next event, `data:` lines
 * collect, a blank line ends it. Comments (`:`), `id:` and `retry:` are ignored. Feed lines without their newline.
 */
class SseParser {
    private var name: String? = null
    private val data = StringBuilder()
    private var hasData = false

    /** The finished event when [line] closes one, otherwise null. */
    fun feed(line: String): SseEvent? {
        if (line.isEmpty()) {
            val e = if (hasData) SseEvent(name ?: "message", data.toString()) else null
            name = null; data.setLength(0); hasData = false
            return e
        }
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        val value = if (colon < 0) "" else line.substring(colon + 1).removePrefix(" ")
        when (field) {
            "event" -> name = value
            "data" -> { if (hasData) data.append('\n'); data.append(value); hasData = true }
        }
        return null
    }
}
