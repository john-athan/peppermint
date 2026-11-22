package dev.kaleve.peppermint.work

import kotlinx.coroutines.flow.MutableStateFlow

/** What a running sync tells the screen. The worker and the activity share a process, so plain flows do. */
object SyncState {
    /** Episode being downloaded right now. */
    val downloading = MutableStateFlow<Long?>(null)
    /** The edition is being fetched or recorded. */
    val recording = MutableStateFlow(false)
    /** Bumped whenever files or the stored queue changed: the screen reads them again. */
    val version = MutableStateFlow(0)
    /** The server refused the token: the phone is no longer paired. */
    val unauthorized = MutableStateFlow(false)

    fun changed() { version.value += 1 }
    fun reset() { downloading.value = null; recording.value = false; unauthorized.value = false; changed() }
}
