package dev.kaleve.peppermint.data

import android.content.Context
import dev.kaleve.peppermint.core.OnDisk
import org.json.JSONObject
import java.io.File

/** What lives in filesDir: the last queue, the downloaded episodes, the recorded edition and the play positions. */
class Store(private val ctx: Context) {
    private val root = ctx.filesDir
    private val queueFile = File(root, "queue.json")
    val episodes = File(root, "episodes")
    val edition = File(root, "edition")
    val editionTemp = File(root, "edition.new")
    private val positions = ctx.getSharedPreferences("positions", Context.MODE_PRIVATE)

    fun saveQueue(j: JSONObject) {
        val tmp = File(root, "queue.json.part")
        tmp.writeText(j.toString())
        tmp.renameTo(queueFile)
    }

    /** The last queue the server gave, for the screen and for offline use. */
    fun loadQueue(): Queue? = runCatching { Queue.parse(JSONObject(queueFile.readText())) }.getOrNull()

    fun episodeFile(id: Long): File? = episodes.listFiles { f -> f.isFile && !f.name.endsWith(".part") && f.name.substringBefore('.') == id.toString() }?.firstOrNull()

    fun onDisk(): List<OnDisk> = episodes.listFiles { f -> f.isFile && !f.name.endsWith(".part") }
        ?.mapNotNull { f -> f.name.substringBefore('.').toLongOrNull()?.let { OnDisk(it, f.length()) } } ?: emptyList()

    fun editionFiles(): List<File> = edition.listFiles { f -> f.name.endsWith(".wav") }?.sortedBy { it.nameWithoutExtension.toIntOrNull() ?: Int.MAX_VALUE } ?: emptyList()

    fun position(id: Long): Long = positions.getLong(id.toString(), 0)
    fun savePosition(id: Long, ms: Long) = positions.edit().putLong(id.toString(), ms).apply()
    fun forgetPosition(id: Long) = positions.edit().remove(id.toString()).apply()

    /** Everything this phone holds of the account: used by Disconnect. */
    fun wipe() {
        episodes.deleteRecursively(); edition.deleteRecursively(); editionTemp.deleteRecursively()
        queueFile.delete(); positions.edit().clear().apply()
    }
}
