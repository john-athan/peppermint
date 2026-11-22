package dev.kaleve.peppermint.core

import org.junit.Assert.*
import org.junit.Test

class SseTest {
    private fun run(vararg lines: String): List<SseEvent> { val p = SseParser(); return lines.mapNotNull { p.feed(it) } }

    @Test fun `event with data ends at the blank line`() {
        assertEquals(listOf(SseEvent("delta", """{"t":"Hi"}""")), run("id: 3", "event: delta", """data: {"t":"Hi"}""", ""))
    }
    @Test fun `no event name is message`() = assertEquals("message", run("data: x", "")[0].name)
    @Test fun `data lines join with a newline`() = assertEquals("a\nb", run("data: a", "data: b", "")[0].data)
    @Test fun `comments and a blank line without data give nothing`() = assertTrue(run(": keep-alive", "", "retry: 5", "").isEmpty())
    @Test fun `the name does not leak into the next event`() {
        val e = run("event: done", "data: {}", "", "data: y", "")
        assertEquals(listOf("done", "message"), e.map { it.name })
    }
    @Test fun `only one space after the colon is dropped`() = assertEquals(" x", run("data:  x", "")[0].data)
}
