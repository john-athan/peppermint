package dev.kaleve.peppermint.work

import android.content.Context
import androidx.work.*
import dev.kaleve.device.TokenVault
import dev.kaleve.device.Unauthorized
import dev.kaleve.peppermint.data.Account
import dev.kaleve.peppermint.data.Api
import dev.kaleve.peppermint.data.Settings
import java.io.IOException
import java.util.concurrent.TimeUnit

class SyncWorker(private val ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val token = TokenVault(ctx).load() ?: return Result.success()
        val settings = Settings(ctx)
        return try {
            Sync(ctx, Api(settings.server, token), settings).run()
            Result.success()
        } catch (_: Unauthorized) {
            Account.disconnect(ctx); SyncState.unauthorized.value = true; Result.failure()
        } catch (_: IOException) {
            // offline, a publisher or the server failing: the next run tries again
            Result.retry()
        }
    }
}

object Scheduler {
    private fun constraints(s: Settings): Constraints = Constraints.Builder()
        .setRequiredNetworkType(if (s.wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
        .setRequiresBatteryNotLow(true)
        .build()

    /** Every 2 hours. Call again whenever the Wi-Fi switch changes. */
    fun configure(ctx: Context) {
        val req = PeriodicWorkRequestBuilder<SyncWorker>(2, TimeUnit.HOURS).setConstraints(constraints(Settings(ctx))).build()
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("periodic", ExistingPeriodicWorkPolicy.UPDATE, req)
    }

    /** One run now, under the switches. [replace] restarts a queued run, which the changed Wi-Fi switch needs. */
    fun kick(ctx: Context, replace: Boolean = false) {
        val req = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(constraints(Settings(ctx))).build()
        WorkManager.getInstance(ctx).enqueueUniqueWork("now", if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP, req)
    }
}
