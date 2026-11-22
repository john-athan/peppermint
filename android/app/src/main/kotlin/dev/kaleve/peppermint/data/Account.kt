package dev.kaleve.peppermint.data

import android.content.Context
import android.content.Intent
import androidx.work.WorkManager
import dev.kaleve.device.TokenVault
import dev.kaleve.peppermint.play.PlaybackService
import dev.kaleve.peppermint.work.SyncState

/** Ends the pairing on this phone: token, scheduled work, playback, downloads and everything remembered. */
object Account {
    fun disconnect(ctx: Context) {
        TokenVault(ctx).clear()
        WorkManager.getInstance(ctx).cancelAllWork()
        ctx.stopService(Intent(ctx, PlaybackService::class.java))
        Store(ctx).wipe()
        Settings(ctx).apply { editionKey = null; heardHere = emptySet(); heardPending = emptySet() }
        SyncState.reset()
    }
}
