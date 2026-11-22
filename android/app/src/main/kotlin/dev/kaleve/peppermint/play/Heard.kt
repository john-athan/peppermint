package dev.kaleve.peppermint.play

import android.content.Context
import dev.kaleve.device.TokenVault
import dev.kaleve.peppermint.data.Api
import dev.kaleve.peppermint.data.Settings
import dev.kaleve.peppermint.data.Store

/** An episode was heard: hide it here at once, tell the server, and keep telling until it accepts (see Sync). */
object Heard {
    fun mark(ctx: Context, id: Long) {
        val settings = Settings(ctx)
        settings.heardHere = settings.heardHere + id
        settings.heardPending = settings.heardPending + id
        Store(ctx).forgetPosition(id)
        val token = TokenVault(ctx).load() ?: return
        val server = settings.server
        Thread {
            try {
                Api(server, token).heard(id)
                settings.heardPending = settings.heardPending - id
            } catch (_: Exception) { /* stays pending: the next sync sends it again */ }
        }.start()
    }
}
