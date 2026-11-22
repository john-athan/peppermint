package dev.kaleve.peppermint.ui

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.kaleve.device.ApiError
import dev.kaleve.device.TokenVault
import dev.kaleve.device.Unauthorized
import dev.kaleve.peppermint.data.*
import dev.kaleve.peppermint.play.Remote
import dev.kaleve.peppermint.play.editionItems
import dev.kaleve.peppermint.play.episodeItem
import dev.kaleve.peppermint.work.Scheduler
import dev.kaleve.peppermint.work.SyncState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException

/** What the Listen screen shows and does. State is Compose state; files and preferences are read again by [refresh]. */
class Model(private val app: Context) {
    private val vault = TokenVault(app)
    private val settings = Settings(app)
    private val store = Store(app)
    val remote = Remote(app)

    var paired by mutableStateOf(vault.load() != null)
    var queue by mutableStateOf<Queue?>(null)
    var onDisk by mutableStateOf<Set<Long>>(emptySet())
    var heardHere by mutableStateOf<Set<Long>>(emptySet())
    var editionReady by mutableStateOf(false)
    var wifiOnly by mutableStateOf(settings.wifiOnly)

    var code by mutableStateOf("")
    /** A code from a `peppermint://pair` link, waiting for the user's Connect. */
    var confirm by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)

    val host: String get() = settings.server.substringAfter("://").substringBefore('/')
    val server: String get() = settings.server

    fun refresh() {
        paired = vault.load() != null
        queue = store.loadQueue()
        onDisk = store.onDisk().map { it.id }.toSet()
        heardHere = settings.heardHere
        val q = queue
        editionReady = q?.edition != null && q.edition.key(q.lang) == settings.editionKey && store.editionFiles().isNotEmpty()
    }

    fun episodes(): List<Episode> = queue?.episodes?.filter { it.id !in heardHere } ?: emptyList()

    suspend fun connect(raw: String) {
        busy = true; message = null
        try {
            val token = withContext(Dispatchers.IO) { Api(settings.server).claim(raw) }
            vault.save(token)
            code = ""; confirm = null; SyncState.unauthorized.value = false
            Scheduler.configure(app); Scheduler.kick(app)
        } catch (e: ApiError) {
            message = if (e.status == 429) "Too many tries. Wait a minute." else "That code is wrong or has expired. Make a new one on the Account page."
        } catch (_: IOException) {
            message = "The server cannot be reached. Check your network."
        } finally { busy = false }
        refresh()
    }

    fun changeWifiOnly(on: Boolean) {
        wifiOnly = on; settings.wifiOnly = on
        Scheduler.configure(app); Scheduler.kick(app, replace = true)
    }

    fun disconnect() {
        remote.release()
        Account.disconnect(app)
        refresh()
    }

    /** From the list: this episode, then the ones after it. */
    fun playFrom(list: List<Episode>, index: Int) {
        val items = list.drop(index).map { episodeItem(it, store.episodeFile(it.id)) }
        remote.play(items, store.position(list[index].id))
    }

    fun playEdition() {
        val files = store.editionFiles()
        if (files.isNotEmpty()) remote.play(editionItems(files, settings.editionTitle))
    }

    /** `peppermint://play?episode=N`: ask the server for it, so an episode outside the queue plays too. */
    suspend fun playLink(id: Long) {
        val token = vault.load() ?: return
        try {
            val ep = withContext(Dispatchers.IO) { Api(settings.server, token).episode(id) }
            remote.play(listOf(episodeItem(ep, store.episodeFile(ep.id))), store.position(ep.id))
        } catch (_: Unauthorized) {
            disconnect()
        } catch (e: ApiError) {
            message = if (e.status == 404) "That episode is not available." else "The server could not give that episode."
        } catch (_: IOException) {
            message = "The server cannot be reached. Check your network."
        }
    }
}
