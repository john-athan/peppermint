package dev.kaleve.peppermint.core

const val MAX_DOWNLOADS = 8
const val MAX_BYTES = 3L * 1024 * 1024 * 1024

/** A downloaded episode file: the episode id and the bytes it takes. */
data class OnDisk(val id: Long, val bytes: Long)

/** What a sync does with the episode folder: fetch [download] (queue order), remove [delete]. */
data class Plan(val download: List<Long>, val delete: List<Long>)

/**
 * The first [MAX_DOWNLOADS] episodes of the queue are wanted; those not on disk are downloaded. Files whose episode
 * left the queue (heard, unfollowed, too old) are deleted, except the one that is playing right now.
 */
fun planEpisodes(queue: List<Long>, onDisk: List<OnDisk>, playing: Long?): Plan {
    val have = onDisk.map { it.id }.toSet()
    val inQueue = queue.toSet()
    return Plan(
        download = queue.take(MAX_DOWNLOADS).filter { it !in have },
        delete = onDisk.map { it.id }.filter { it !in inQueue && it != playing },
    )
}

/** True when another [incoming] bytes still keep the folder at or under [MAX_BYTES]. [incoming] 0 means unknown. */
fun fitsBudget(usedBytes: Long, incoming: Long): Boolean = usedBytes < MAX_BYTES && usedBytes + incoming <= MAX_BYTES

/** The file extension of an audio URL (query and fragment ignored), mp3 when there is none that looks like one. */
fun audioExtension(url: String): String {
    val path = url.substringBefore('#').substringBefore('?').substringAfterLast('/')
    val ext = path.substringAfterLast('.', "").lowercase()
    return if (ext.length in 2..4 && ext.all { it in 'a'..'z' || it in '0'..'9' }) ext else "mp3"
}

/** An episode counts as heard when it ended or its position passed 95 % of a known duration. */
fun isHeard(positionMs: Long, durationMs: Long, ended: Boolean): Boolean =
    ended || (durationMs > 0 && positionMs >= durationMs * 0.95)
