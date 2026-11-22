package dev.kaleve.peppermint.data

import org.json.JSONObject

/** An episode of the queue. [audio] is the publisher's own URL; [duration] is in seconds. */
data class Episode(val id: Long, val title: String, val show: String, val audio: String, val duration: Long?) {
    companion object {
        fun from(j: JSONObject) = Episode(
            j.getLong("id"), j.optString("title"), j.optString("show"), j.getString("audio"),
            if (j.isNull("duration")) null else j.optLong("duration"),
        )
    }
}

/** The edition the server offers to read aloud; the recording is remade when [key] changes. */
data class EditionInfo(val id: Long, val day: String, val slot: String, val sig: String) {
    fun key(lang: String) = "$id|$sig|$lang"
    val title get() = "Edition, $day $slot"
}

data class Queue(val name: String, val lang: String, val edition: EditionInfo?, val episodes: List<Episode>) {
    companion object {
        fun parse(j: JSONObject): Queue {
            val e = j.optJSONObject("edition")
            val list = j.optJSONArray("episodes")
            return Queue(
                j.optString("name"), if (j.optString("lang") == "de") "de" else "en",
                e?.let { EditionInfo(it.getLong("id"), it.optString("day"), it.optString("slot"), it.optString("sig")) },
                buildList { if (list != null) for (i in 0 until list.length()) add(Episode.from(list.getJSONObject(i))) },
            )
        }
    }
}
