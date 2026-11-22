package dev.kaleve.peppermint.core

import org.junit.Assert.*
import org.junit.Test

class ScriptTest {
    @Test fun `parts follow the marker lines`() {
        val parts = parseScript("@intro\nGood morning.\n@story 12\nTitle. Body line one.\nLine two.\n@story 7\nNext.\n@outro\nBye.")
        assertEquals(listOf("intro", "story 12", "story 7", "outro"), parts.map { it.marker })
        assertEquals("Title. Body line one.\nLine two.", parts[1].text)
        assertEquals("Bye.", parts[3].text)
    }
    @Test fun `text before the first marker and empty parts are dropped`() {
        val parts = parseScript("noise\n@intro\n\n@story 3\nText\n")
        assertEquals(listOf(ScriptPart("story 3", "Text")), parts)
    }
    @Test fun `an at sign inside a line is text`() =
        assertEquals("write to me@x.de", parseScript("@intro\nwrite to me@x.de")[0].text)
    @Test fun `an empty script has no parts`() = assertTrue(parseScript("").isEmpty())

    @Test fun `short text stays whole`() = assertEquals(listOf("One. Two."), splitAtSentences("One. Two.", 100))
    @Test fun `cuts at sentence ends and packs greedily`() =
        assertEquals(listOf("Aaaa. Bbbb.", "Cccc."), splitAtSentences("Aaaa. Bbbb. Cccc.", 12))
    @Test fun `a long sentence is cut at a space`() {
        val out = splitAtSentences("aaa bbb ccc ddd", 8)
        assertEquals(listOf("aaa bbb", "ccc ddd"), out)
    }
    @Test fun `a word longer than the limit is cut hard`() = assertEquals(listOf("abcd", "efgh", "ij"), splitAtSentences("abcdefghij", 4))
    @Test fun `no piece exceeds the limit`() {
        val text = (1..200).joinToString(" ") { "Sentence number $it is here." }
        assertTrue(splitAtSentences(text, 300).all { it.length <= 300 })
    }
}
