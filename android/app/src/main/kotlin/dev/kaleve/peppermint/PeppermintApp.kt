package dev.kaleve.peppermint

import android.app.Application
import dev.kaleve.device.TokenVault
import dev.kaleve.peppermint.work.Scheduler

class PeppermintApp : Application() {
    override fun onCreate() {
        super.onCreate()
        if (TokenVault(this).load() != null) Scheduler.configure(this)
    }
}
