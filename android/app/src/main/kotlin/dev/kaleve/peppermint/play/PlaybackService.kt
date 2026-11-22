package dev.kaleve.peppermint.play

import android.app.PendingIntent
import android.content.Intent
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import dev.kaleve.peppermint.ListenActivity
import dev.kaleve.peppermint.R
import dev.kaleve.peppermint.core.isHeard
import dev.kaleve.peppermint.data.Settings
import dev.kaleve.peppermint.data.Store

/**
 * Plays episodes and the edition so that they go on with the screen off: lock screen, headphones and the
 * notification all talk to the MediaSession. It also keeps the place per episode (every 10 s while playing, on pause
 * and on stop) and reports an episode as heard when it ends or passes 95 %.
 */
@OptIn(UnstableApi::class) // androidx.annotation.OptIn: the one lint understands
class PlaybackService : MediaSessionService() {
    private var session: MediaSession? = null
    private val handler = Handler(Looper.getMainLooper())
    private val store by lazy { Store(this) }
    private val settings by lazy { Settings(this) }

    private val tick = object : Runnable {
        override fun run() { session?.player?.let(::checkProgress); handler.postDelayed(this, SAVE_EVERY_MS) }
    }

    override fun onCreate() {
        super.onCreate()
        val player = ExoPlayer.Builder(this)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_SPEECH).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .setSeekBackIncrementMs(15_000)
            .setSeekForwardIncrementMs(30_000)
            .build()
        player.addListener(Watcher(player))
        setMediaNotificationProvider(DefaultMediaNotificationProvider.Builder(this).build().apply { setSmallIcon(R.drawable.ic_stat) })
        session = MediaSession.Builder(this, player)
            .setSessionActivity(PendingIntent.getActivity(this, 0, Intent(this, ListenActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .build()
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        session?.player?.let(::checkProgress)
        Now.episodeId = null
        session?.run { player.release(); release() }
        session = null
        super.onDestroy()
    }

    private fun episodeId(item: MediaItem?): Long? = item?.mediaId?.toLongOrNull()

    private fun heard(id: Long) { if (id !in settings.heardHere) Heard.mark(this, id) }

    /** Saves the place of the current episode, and reports it heard past 95 %. */
    private fun checkProgress(player: Player) {
        val id = episodeId(player.currentMediaItem) ?: return
        if (id in settings.heardHere) return
        val pos = player.currentPosition
        if (isHeard(pos, player.duration.takeIf { it != C.TIME_UNSET } ?: 0, false)) heard(id) else store.savePosition(id, pos)
    }

    private inner class Watcher(private val player: Player) : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) {
            handler.removeCallbacks(tick)
            checkProgress(player)
            if (isPlaying) handler.postDelayed(tick, SAVE_EVERY_MS)
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) episodeId(player.currentMediaItem)?.let { heard(it) }
        }

        override fun onPositionDiscontinuity(old: Player.PositionInfo, new: Player.PositionInfo, reason: Int) {
            val id = episodeId(old.mediaItem) ?: return
            if (old.mediaItem?.mediaId == new.mediaItem?.mediaId) return
            val duration = old.mediaItem?.mediaMetadata?.durationMs ?: 0
            if (reason == Player.DISCONTINUITY_REASON_AUTO_TRANSITION || isHeard(old.positionMs, duration, false)) heard(id)
            else if (id !in settings.heardHere) store.savePosition(id, old.positionMs)
        }

        override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
            val id = episodeId(item)
            Now.episodeId = id
            // the first item of a playlist starts where it was left by the controller's start position; later ones here
            if (id != null && reason != Player.MEDIA_ITEM_TRANSITION_REASON_PLAYLIST_CHANGED) {
                val saved = store.position(id)
                if (saved > 0 && player.currentPosition < 1_000) player.seekTo(saved)
            }
        }
    }

    private companion object { const val SAVE_EVERY_MS = 10_000L }
}
