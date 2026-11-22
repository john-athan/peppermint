package dev.kaleve.peppermint.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun Txt(text: String, p: Palette, size: Float = 15f, color: Color = p.ink, weight: FontWeight = FontWeight.Normal,
        modifier: Modifier = Modifier, maxLines: Int = Int.MAX_VALUE) {
    BasicText(text, modifier, maxLines = maxLines, overflow = TextOverflow.Ellipsis,
        style = TextStyle(color = color, fontSize = size.sp, fontWeight = weight, lineHeight = (size * 1.4f).sp))
}

@Composable
fun Card(p: Palette, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(p.surface)
        .border(1.dp, p.rule, RoundedCornerShape(18.dp)), content = content)
}

/** A thin rule above every row but the first. */
fun Modifier.ruleAbove(p: Palette, first: Boolean): Modifier = if (first) this else drawBehind {
    drawLine(p.rule, Offset(0f, 0f), Offset(size.width, 0f), 1.dp.toPx())
}

@Composable
fun PillButton(text: String, p: Palette, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().height(48.dp).background(p.mint.copy(alpha = if (enabled) 1f else .4f), RoundedCornerShape(24.dp))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Txt(text, p, 15f, p.onMint, FontWeight.SemiBold) }
}

@Composable
fun GhostButton(text: String, p: Palette, color: Color = p.mint, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().height(48.dp).border(1.5.dp, color, RoundedCornerShape(24.dp))
            .clip(RoundedCornerShape(24.dp)).clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Txt(text, p, 15f, color, FontWeight.SemiBold) }
}

@Composable
fun SwitchRow(title: String, sub: String?, on: Boolean, p: Palette, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().toggleable(on, role = Role.Switch, onValueChange = onChange).heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Txt(title, p)
            if (sub != null) Txt(sub, p, 13f, p.muted)
        }
        Box(Modifier.size(46.dp, 28.dp).background(if (on) p.mint else p.surface3, RoundedCornerShape(14.dp))) {
            Box(Modifier.padding(start = if (on) 21.dp else 3.dp, top = 3.dp).size(22.dp).background(if (on) p.onMint else p.surface, CircleShape))
        }
    }
}

/** A round button; [desc] is what a screen reader says. */
@Composable
fun RoundButton(desc: String, p: Palette, size: Dp = 44.dp, filled: Boolean = false, onClick: () -> Unit, content: @Composable BoxScope.() -> Unit) {
    Box(
        Modifier.size(size).semantics { contentDescription = desc }
            .background(if (filled) p.mint else p.surface2, CircleShape).clip(CircleShape).clickable(role = Role.Button, onClick = onClick),
        contentAlignment = Alignment.Center, content = content,
    )
}

/** Play triangle or pause bars, drawn so the app needs no icon font. */
@Composable
fun PlayGlyph(playing: Boolean, color: Color, size: Dp = 20.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width; val h = this.size.height
        if (playing) {
            drawRect(color, Offset(w * .2f, h * .12f), androidx.compose.ui.geometry.Size(w * .22f, h * .76f))
            drawRect(color, Offset(w * .58f, h * .12f), androidx.compose.ui.geometry.Size(w * .22f, h * .76f))
        } else {
            drawPath(Path().apply { moveTo(w * .25f, h * .1f); lineTo(w * .88f, h * .5f); lineTo(w * .25f, h * .9f); close() }, color)
        }
    }
}

/** The pairing code, shown as ABCD-EFGH while typing. */
@Composable
fun CodeField(value: String, p: Palette, onChange: (String) -> Unit) {
    BasicTextField(
        value, onChange, singleLine = true,
        textStyle = TextStyle(color = p.ink, fontSize = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 3.sp),
        cursorBrush = SolidColor(p.mint),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
        decorationBox = { inner ->
            Box(Modifier.fillMaxWidth().height(56.dp).background(p.surface, RoundedCornerShape(14.dp)).border(1.dp, p.rule, RoundedCornerShape(14.dp)).padding(horizontal = 16.dp),
                contentAlignment = Alignment.CenterStart) {
                if (value.isEmpty()) Txt("ABCD-EFGH", p, 22f, p.muted.copy(alpha = .5f))
                inner()
            }
        },
    )
}

/** Progress of the playing item, a bar without a handle: seeking is back 15 and forward 30. */
@Composable
fun ProgressBar(fraction: Float, p: Palette) {
    Box(Modifier.fillMaxWidth().height(4.dp).background(p.surface3, CircleShape)) {
        Box(Modifier.fillMaxWidth(fraction.coerceIn(0f, 1f)).fillMaxHeight().background(p.mint, CircleShape))
    }
}
