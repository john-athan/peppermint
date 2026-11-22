package dev.kaleve.peppermint

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.lifecycleScope
import dev.kaleve.device.WebApp
import dev.kaleve.device.isCompleteCode
import dev.kaleve.device.normalizeCode
import dev.kaleve.peppermint.ui.Actions
import dev.kaleve.peppermint.ui.Model
import dev.kaleve.peppermint.ui.Palettes
import dev.kaleve.peppermint.ui.Root
import dev.kaleve.peppermint.work.Scheduler
import dev.kaleve.peppermint.work.SyncState
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Listening: pairing on first start, then the edition, the queue, the player and the Wi-Fi switch. Opened by the
 * icon's shortcut, the player notification, and the links `peppermint://pair?code=…` and `peppermint://play?episode=N`.
 * It has its own task (taskAffinity in the manifest), so the launcher icon keeps opening the web app.
 */
class ListenActivity : ComponentActivity() {
    private lateinit var model: Model
    private val web by lazy { WebApp(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        model = Model(applicationContext)
        if (savedInstanceState == null) handle(intent)

        setContent {
            val p = if (isSystemInDarkTheme()) Palettes.dark else Palettes.light
            val view = LocalView.current
            SideEffect {
                val c = WindowCompat.getInsetsController(window, view)
                c.isAppearanceLightStatusBars = !p.dark; c.isAppearanceLightNavigationBars = !p.dark
            }

            val version by SyncState.version.collectAsState()
            val unauthorized by SyncState.unauthorized.collectAsState()
            val notify = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
            val askNotifications = {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                    notify.launch(Manifest.permission.POST_NOTIFICATIONS)
            }

            LifecycleEventEffect(Lifecycle.Event.ON_START) { model.remote.connect() }
            LifecycleEventEffect(Lifecycle.Event.ON_STOP) { model.remote.release() }
            LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { if (model.paired) Scheduler.kick(applicationContext) }
            LaunchedEffect(version, unauthorized) {
                model.refresh()
                if (unauthorized) model.message = "This phone was disconnected. Connect it again with a new code."
            }
            // the playing position moves between the player's events
            LaunchedEffect(Unit) { while (true) { model.remote.poll(); delay(500) } }

            Root(model, p, Actions(getCode = { web.open(Uri.parse(model.server + "/account")) {} }, askNotifications = askNotifications))
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onDestroy() {
        web.close()
        model.remote.release()
        super.onDestroy()
    }

    /** Never takes a server from a link: the code is claimed on the stored server, and only after the user says Connect. */
    private fun handle(i: Intent) {
        val data = i.data ?: return
        if (data.scheme != "peppermint") return
        when (data.host) {
            "pair" -> {
                val code = data.getQueryParameter("code")
                if (code != null && isCompleteCode(code)) { model.confirm = normalizeCode(code); model.message = null }
                else model.message = "That link has no valid code. Make a new one on the Account page."
            }
            "play" -> data.getQueryParameter("episode")?.toLongOrNull()?.let { id ->
                model.refresh()
                if (model.paired) lifecycleScope.launch { model.playLink(id) }
            }
        }
    }
}
