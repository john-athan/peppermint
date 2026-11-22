package dev.kaleve.peppermint.core

/** One part of the edition's script: its marker (`intro`, `story 12`, `outro`) and the text to speak. */
data class ScriptPart(val marker: String, val text: String)

private val MARKER = Regex("""^@(intro|outro|story\s+\d+)\s*$""")

/**
 * The script has one marker line per part (`@intro`, `@story <id>`, `@outro`), each followed by its text.
 * Text before the first marker and parts without any text are dropped.
 */
fun parseScript(script: String): List<ScriptPart> {
    val parts = mutableListOf<ScriptPart>()
    var marker: String? = null
    val text = StringBuilder()
    fun close() {
        val m = marker
        if (m != null && text.isNotBlank()) parts += ScriptPart(m, text.toString().trim())
        text.setLength(0)
    }
    for (line in script.lines()) {
        val hit = MARKER.matchEntire(line.trim())
        if (hit != null) { close(); marker = hit.groupValues[1].replace(Regex("\\s+"), " ") }
        else if (marker != null) text.append(line).append('\n')
    }
    close()
    return parts
}

private val SENTENCE_END = Regex("""(?<=[.!?…])\s+""")

/**
 * Cuts [text] into pieces of at most [max] characters, at sentence ends where it can. A single sentence longer than
 * [max] is cut at the last space before the limit (or hard at the limit when it has no space). TextToSpeech refuses
 * longer input, see getMaxSpeechInputLength().
 */
fun splitAtSentences(text: String, max: Int): List<String> {
    require(max > 0)
    val out = mutableListOf<String>()
    val cur = StringBuilder()
    fun flush() { if (cur.isNotBlank()) out += cur.toString().trim(); cur.setLength(0) }
    for (sentence in text.trim().split(SENTENCE_END)) {
        var s = sentence
        while (s.length > max) {
            flush()
            val cut = s.lastIndexOf(' ', max).takeIf { it > 0 } ?: max
            out += s.substring(0, cut).trim()
            s = s.substring(cut).trim()
        }
        if (s.isEmpty()) continue
        if (cur.isNotEmpty() && cur.length + 1 + s.length > max) flush()
        if (cur.isNotEmpty()) cur.append(' ')
        cur.append(s)
    }
    flush()
    return out
}
