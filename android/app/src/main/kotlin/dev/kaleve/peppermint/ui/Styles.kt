package dev.kaleve.peppermint.ui

import androidx.compose.ui.graphics.Color

/** The colours of the web app's mint paper (client/app.css, `:root` and its dark variant). */
data class Palette(
    val ground: Color, val surface: Color, val surface2: Color, val surface3: Color,
    val ink: Color, val muted: Color, val rule: Color,
    val mint: Color, val onMint: Color, val mintSoft: Color, val rose: Color,
    val dark: Boolean,
)

object Palettes {
    val light = Palette(
        ground = Color(0xFFE8F7EC), surface = Color(0xFFF7FDF8), surface2 = Color(0xFFDAF1E1), surface3 = Color(0xFFC6E8D1),
        ink = Color(0xFF0F2A1B), muted = Color(0xFF4C6B58), rule = Color(0xFFC2E2CC),
        mint = Color(0xFF12804C), onMint = Color(0xFFFFFFFF), mintSoft = Color(0xFFC9F0D8), rose = Color(0xFFC2405A),
        dark = false,
    )
    val dark = Palette(
        ground = Color(0xFF071A10), surface = Color(0xFF0D2618), surface2 = Color(0xFF123220), surface3 = Color(0xFF19412A),
        ink = Color(0xFFDDF7E6), muted = Color(0xFF8DB39B), rule = Color(0xFF1D4029),
        mint = Color(0xFF5FE39B), onMint = Color(0xFF04160B), mintSoft = Color(0xFF134A2C), rose = Color(0xFFFF7088),
        dark = true,
    )
}
