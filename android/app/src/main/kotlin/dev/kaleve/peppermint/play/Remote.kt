package dev.kaleve.peppermint.play

import android.content.ComponentName
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture

/**
 * The screen's handle on the PlaybackService: a MediaController, connected while the screen is visible. What the
 * mini player shows is compose state, filled from the player's events and [poll] for the moving position.
 */
class Remote(private val ctx: Context) {
    var mediaId by mutableStateOf<String?>(null); private set
    var title by mutableStateOf(""); private set
    var subtitle by mutableStateOf(""); private set
    var playing by mutableStateOf(false); private set
    var positionMs by mutableStateOf(0L); private set
    var durationMs by mutableStateOf(0L); private set

    private var future: ListenableFuture<MediaController>? = null
    private var controller: MediaController? = null
    private var waiting: ((MediaController) -> Unit)? = null

    private val listener = object : Player.Listener {
        override fun onEvents(player: Player, events: Player.Events) = read(player)
    }

    fun connect() {
        if (future != null) return
        val f = MediaController.Builder(ctx, SessionToken(ctx, ComponentName(ctx, PlaybackService::class.java))).buildAsync()
        future = f
        f.addListener({
            val c = runCatching { f.get() }.getOrNull() ?: run { future = null; return@addListener }
            controller = c
            c.addListener(listener)
            read(c)
            waiting?.invoke(c); waiting = null
        }, ContextCompat.getMainExecutor(ctx))
    }

    fun release() {
        controller?.removeListener(listener)
        future?.let { MediaController.releaseFuture(it) }
        future = null; controller = null; waiting = null
    }

    private fun read(p: Player) {
        mediaId = p.currentMediaItem?.mediaId
        title = p.mediaMetadata.title?.toString() ?: ""
        subtitle = p.mediaMetadata.artist?.toString() ?: ""
        playing = p.isPlaying
        poll(p)
    }

    /** Position and length, called while the screen shows the player. */
    fun poll(p: Player? = controller) {
        val c = p ?: return
        positionMs = c.currentPosition.coerceAtLeast(0)
        durationMs = c.duration.takeIf { it != C.TIME_UNSET } ?: 0
    }

    /** Plays [items] in order from the first one, starting [startMs] into it. */
    fun play(items: List<MediaItem>, startMs: Long = 0) = with { c ->
        c.setMediaItems(items, 0, startMs); c.prepare(); c.play()
    }

    fun toggle() = with { c -> if (c.isPlaying) c.pause() else c.play() }
    fun back() = with { it.seekBack() }
    fun forward() = with { it.seekForward() }

    private fun with(block: (MediaController) -> Unit) {
        val c = controller
        if (c != null) block(c) else { waiting = block; connect() }
    }
}
