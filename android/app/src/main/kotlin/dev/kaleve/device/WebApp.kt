// Owned by oss-kit (templates/shared/android-device). Change it there and run `oss sync-tooling`, never in a copy.
package dev.kaleve.device

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.trusted.TrustedWebActivityIntentBuilder

/**
 * The app is the web app: [open] shows the server as a Trusted Web Activity (Chrome's engine, full screen, the same
 * passkeys and session as Chrome). Chrome drops the address bar once the server's /.well-known/assetlinks.json names
 * the app's signing key. The manifest must list the CustomTabsService in <queries>, or Android 11+ hides the browsers.
 * Call [close] from onDestroy.
 */
class WebApp(private val ctx: Context) {
    private var connection: CustomTabsServiceConnection? = null

    /** TWA when a browser supports it, a Custom Tab when it only knows those, the plain browser otherwise. */
    fun open(uri: Uri, done: () -> Unit) {
        val pkg = CustomTabsClient.getPackageName(ctx, null)
        if (pkg == null) {
            runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, uri)) }; done(); return
        }
        val c = object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, client: CustomTabsClient) {
                client.warmup(0)
                val session = client.newSession(null)
                if (session != null) TrustedWebActivityIntentBuilder(uri).build(session).launchTrustedWebActivity(ctx)
                else CustomTabsIntent.Builder().build().launchUrl(ctx, uri)
                done()
            }
            override fun onServiceDisconnected(name: ComponentName) {}
        }
        connection = c
        if (!CustomTabsClient.bindCustomTabsService(ctx, pkg, c)) {
            connection = null
            CustomTabsIntent.Builder().build().launchUrl(ctx, uri); done()
        }
    }

    fun close() { connection?.let { runCatching { ctx.unbindService(it) } }; connection = null }
}
