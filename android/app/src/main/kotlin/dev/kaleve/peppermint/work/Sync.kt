package dev.kaleve.peppermint.work

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import dev.kaleve.device.ApiError
import dev.kaleve.device.Unauthorized
import dev.kaleve.peppermint.core.*
import dev.kaleve.peppermint.data.*
import dev.kaleve.peppermint.play.Now
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.UUID

/**
 * One sync: report heard episodes, fetch the queue, download what is missing, drop what is gone, record the edition.
 * Unauthorized propagates to the worker (the phone is disconnected there); any other failure of one step leaves the
 * rest of the sync to carry on or to the next run.
 */
class Sync(private val ctx: Context, private val api: Api, private val settings: Settings) {
    private val store = Store(ctx)

    // the periodic and the one-off worker may start together: one sync at a time, or each deletes the other's .part
    // files and edition folder
    suspend fun run() = lock.withLock { withContext(Dispatchers.IO) {
        retryHeard()
        val raw = api.queue()
        store.saveQueue(raw)
        val queue = Queue.parse(raw)
        settings.heardHere = settings.heardHere.intersect(queue.episodes.map { it.id }.toSet())
        SyncState.changed()
        episodes(queue)
        // the episodes are done: a script that cannot be had now waits for the next run instead of failing this one
        try { edition(queue) } catch (e: Unauthorized) { throw e } catch (_: IOException) {}
    } }

    /** A heard report that failed earlier is sent again; an episode the server no longer knows needs no report. */
    private fun retryHeard() {
        for (id in settings.heardPending) {
            try { api.heard(id) } catch (e: Unauthorized) { throw e } catch (e: ApiError) { if (e.status != 404) continue } catch (_: IOException) { continue }
            settings.heardPending = settings.heardPending - id
        }
    }

    private suspend fun episodes(queue: Queue) {
        store.episodes.mkdirs()
        store.episodes.listFiles { f -> f.name.endsWith(".part") }?.forEach { it.delete() }
        val plan = planEpisodes(queue.episodes.map { it.id }, store.onDisk(), Now.episodeId)
        for (id in plan.delete) store.episodeFile(id)?.delete()
        var used = store.onDisk().sumOf { it.bytes }
        val byId = queue.episodes.associateBy { it.id }
        for (id in plan.download) {
            currentCoroutineContext().ensureActive()
            if (!fitsBudget(used, 0)) break
            val ep = byId.getValue(id)
            SyncState.downloading.value = id
            SyncState.changed()
            try {
                val target = File(store.episodes, "$id.${audioExtension(ep.audio)}")
                used += download(ep.audio, target, MAX_BYTES - used)
            } catch (e: Unauthorized) { throw e
            } catch (e: IOException) { /* this one fails, the next may not */ }
            finally { SyncState.downloading.value = null; SyncState.changed() }
        }
    }

    /**
     * Downloads [url] into a `.part` file next to [target] and renames it when whole. The publisher's host never sees
     * the device token: this connection is not the Api's. Redirects are followed by hand (http to https included).
     * Returns the bytes written; throws IOException when the file would pass [room].
     */
    private suspend fun download(url: String, target: File, room: Long): Long {
        var u = URL(url)
        var c: HttpURLConnection
        var hops = 0
        while (true) {
            c = u.openConnection() as HttpURLConnection
            c.connectTimeout = 15_000; c.readTimeout = 30_000; c.instanceFollowRedirects = false
            val code = c.responseCode
            if (code in 301..308 && code != 304 && hops++ < 5) {
                val next = c.getHeaderField("Location") ?: throw IOException("redirect without target")
                c.disconnect(); u = URL(u, next); continue
            }
            if (code !in 200..299) { c.disconnect(); throw IOException("status $code") }
            break
        }
        val announced = c.contentLengthLong
        if (announced > room) { c.disconnect(); throw IOException("over budget") }
        val part = File(target.path + ".part")
        var written = 0L
        try {
            c.inputStream.use { input -> part.outputStream().use { out ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val n = input.read(buf); if (n < 0) break
                    written += n
                    if (written > room) throw IOException("over budget")
                    out.write(buf, 0, n)
                }
            } }
            if (announced >= 0 && written != announced) throw IOException("file ended early")
            if (!part.renameTo(target)) throw IOException("rename failed")
            return written
        } catch (e: Throwable) {
            part.delete(); throw e
        } finally { c.disconnect() }
    }

    /** Records the edition when its (id, sig, language) is not the one on disk. */
    private suspend fun edition(queue: Queue) {
        val info = queue.edition ?: return
        val key = info.key(queue.lang)
        if (settings.editionKey == key && store.editionFiles().isNotEmpty()) return
        SyncState.recording.value = true
        try {
            val parts = parseScript(api.editionScript(queue.lang))
            if (parts.isEmpty()) return
            store.editionTemp.deleteRecursively(); store.editionTemp.mkdirs()
            val locale = if (queue.lang == "de") Locale.GERMANY else Locale.UK
            record(parts, locale, store.editionTemp)
            store.edition.deleteRecursively()
            if (!store.editionTemp.renameTo(store.edition)) throw IOException("swap failed")
            settings.editionTitle = info.title
            settings.editionKey = key
        } finally {
            store.editionTemp.deleteRecursively()
            SyncState.recording.value = false
            SyncState.changed()
        }
    }

    private companion object { val lock = Mutex() }

    /** Speaks every part with the phone's own voice into numbered WAV files, in script order. */
    private suspend fun record(parts: List<ScriptPart>, locale: Locale, dir: File) {
        val tts = engine()
        try {
            val lang = tts.setLanguage(locale)
            if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) throw IOException("no voice for $locale")
            val max = TextToSpeech.getMaxSpeechInputLength() - 1
            var n = 0
            for (part in parts) for (piece in splitAtSentences(part.text, max)) {
                currentCoroutineContext().ensureActive()
                synth(tts, piece, File(dir, "${n++}.wav"))
            }
        } finally { tts.shutdown() }
    }

    private suspend fun engine(): TextToSpeech {
        val status = CompletableDeferred<Int>()
        val tts = TextToSpeech(ctx) { status.complete(it) }
        if (status.await() != TextToSpeech.SUCCESS) { tts.shutdown(); throw IOException("no speech engine") }
        return tts
    }

    private suspend fun synth(tts: TextToSpeech, text: String, file: File) {
        val id = UUID.randomUUID().toString()
        val done = CompletableDeferred<Boolean>()
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {}
            override fun onDone(utteranceId: String?) { if (utteranceId == id) done.complete(true) }
            @Deprecated("Deprecated in Java") override fun onError(utteranceId: String?) { if (utteranceId == id) done.complete(false) }
            override fun onError(utteranceId: String?, errorCode: Int) { if (utteranceId == id) done.complete(false) }
        })
        if (tts.synthesizeToFile(text, Bundle(), file, id) != TextToSpeech.SUCCESS || !done.await() || !file.exists()) throw IOException("synthesis failed")
    }
}
