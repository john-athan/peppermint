package dev.kaleve.peppermint

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import dev.kaleve.device.WebApp
import dev.kaleve.peppermint.data.Settings

/**
 * The launcher: the app is the web app. It opens the server as a Trusted Web Activity (Chrome's engine, full screen,
 * the same passkeys and session as Chrome), paired or not. Chrome drops the address bar once the server's
 * /.well-known/assetlinks.json names this app's signing key. What a browser does badly, listening, is
 * [ListenActivity], reached by the icon's long-press shortcut "Listen". The TWA plumbing is the shared WebApp.
 */
class BrowseActivity : Activity() {
    private val web by lazy { WebApp(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web.open(Uri.parse(Settings(this).server)) { finish() }
    }

    override fun onDestroy() {
        web.close()
        super.onDestroy()
    }
}
