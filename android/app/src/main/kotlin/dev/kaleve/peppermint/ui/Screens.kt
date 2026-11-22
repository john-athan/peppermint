package dev.kaleve.peppermint.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.kaleve.device.displayCode
import dev.kaleve.device.isCompleteCode
import dev.kaleve.peppermint.core.formatClock
import dev.kaleve.peppermint.core.formatLength
import dev.kaleve.peppermint.work.SyncState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue

/** Everything the screen can do that is not the model's: opening the web app, asking for the notification permission. */
class Actions(val getCode: () -> Unit, val askNotifications: () -> Unit)

@Composable
fun Root(m: Model, p: Palette, a: Actions) {
    Column(Modifier.fillMaxSize().background(p.ground).systemBarsPadding()) {
        if (!m.paired) Unpaired(m, p, a) else Paired(m, p, a)
    }
}

@Composable
private fun ColumnScope.Unpaired(m: Model, p: Palette, a: Actions) {
    val scope = rememberCoroutineScope()
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Txt("peppermint", p, 30f, weight = FontWeight.Bold)
        Txt("Connect this phone to your account and it downloads your podcasts and records the edition, so they play offline with the screen off.", p, 15f, p.muted)
        val pending = m.confirm
        if (pending != null) {
            Card(p) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Txt("Connect this phone to ${m.host}?", p, 17f, weight = FontWeight.SemiBold)
                    Txt("Only continue if you opened this link on your own Account page.", p, 13f, p.muted)
                    PillButton(if (m.busy) "Connecting" else "Connect", p, !m.busy) { scope.launch { m.connect(pending) } }
                    GhostButton("Cancel", p) { m.confirm = null; m.message = null }
                }
            }
        } else {
            CodeField(displayCode(m.code), p) { m.code = displayCode(it) }
            PillButton(if (m.busy) "Connecting" else "Connect", p, isCompleteCode(m.code) && !m.busy) { scope.launch { m.connect(m.code) } }
            GhostButton("Get a code", p, onClick = a.getCode)
        }
        m.message?.let { Txt(it, p, 14f, p.rose) }
    }
}

@Composable
private fun ColumnScope.Paired(m: Model, p: Palette, a: Actions) {
    val downloading by SyncState.downloading.collectAsState()
    val recording by SyncState.recording.collectAsState()
    val q = m.queue
    val episodes = m.episodes()
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Txt(q?.name?.ifBlank { null } ?: "peppermint", p, 28f, weight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 4.dp))
        m.message?.let { Txt(it, p, 14f, p.rose, modifier = Modifier.padding(horizontal = 4.dp)) }

        Card(p) {
            Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    Txt("Edition", p, 16f, weight = FontWeight.SemiBold)
                    val e = q?.edition
                    Txt(when {
                        m.editionReady && e != null -> "Ready, ${e.day} ${e.slot}"
                        recording -> "Recording"
                        else -> "Not yet"
                    }, p, 13f, p.muted)
                }
                if (m.editionReady) RoundButton("Play the edition", p, 48.dp, filled = true, onClick = { a.askNotifications(); m.playEdition() }) { PlayGlyph(false, p.onMint) }
            }
        }

        Card(p) {
            if (episodes.isEmpty()) Txt("Nothing to listen to yet. New episodes of the podcasts you follow, and the ones you saved, appear here.", p, 14f, p.muted, modifier = Modifier.padding(16.dp))
            episodes.forEachIndexed { i, ep ->
                Column(
                    Modifier.fillMaxWidth().ruleAbove(p, i == 0)
                        .clickable(role = Role.Button) { a.askNotifications(); m.playFrom(episodes, i) }.padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Txt(ep.title, p, 15f, weight = if (m.remote.mediaId == ep.id.toString()) FontWeight.Bold else FontWeight.Medium, maxLines = 2)
                    val state = when { ep.id in m.onDisk -> "Downloaded"; ep.id == downloading -> "Downloading"; else -> "Waiting" }
                    Txt(listOfNotNull(ep.show.ifBlank { null }, formatLength(ep.duration), state).joinToString(", "), p, 13f, p.muted, maxLines = 1)
                }
            }
        }

        Card(p) { SwitchRow("Wi-Fi only", "Downloads and recordings wait for Wi-Fi.", m.wifiOnly, p) { m.changeWifiOnly(it) } }
        GhostButton("Disconnect", p, p.rose) { m.disconnect() }
    }
    if (m.remote.mediaId != null) MiniPlayer(m, p)
}

@Composable
private fun MiniPlayer(m: Model, p: Palette) {
    val r = m.remote
    Card(p, Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Txt(r.title, p, 15f, weight = FontWeight.SemiBold, maxLines = 1)
            ProgressBar(if (r.durationMs > 0) r.positionMs.toFloat() / r.durationMs else 0f, p)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Txt("${formatClock(r.positionMs)} / ${formatClock(r.durationMs)}", p, 12f, p.muted, modifier = Modifier.weight(1f))
                RoundButton("Back 15 seconds", p, onClick = r::back) { Txt("-15", p, 13f, weight = FontWeight.SemiBold) }
                RoundButton(if (r.playing) "Pause" else "Play", p, 52.dp, filled = true, onClick = r::toggle) { PlayGlyph(r.playing, p.onMint) }
                RoundButton("Forward 30 seconds", p, onClick = r::forward) { Txt("+30", p, 13f, weight = FontWeight.SemiBold) }
            }
        }
    }
}
