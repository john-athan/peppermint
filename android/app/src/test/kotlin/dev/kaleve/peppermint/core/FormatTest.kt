package dev.kaleve.peppermint.core

import org.junit.Assert.*
import org.junit.Test

class FormatTest {
    @Test fun `length in minutes`() { assertEquals("42 min", formatLength(2520)); assertEquals("1 min", formatLength(20)) }
    @Test fun `length in hours`() = assertEquals("1 h 05 min", formatLength(3900))
    @Test fun `no length`() { assertNull(formatLength(null)); assertNull(formatLength(0)) }
    @Test fun `clock`() { assertEquals("0:07", formatClock(7_000)); assertEquals("3:07", formatClock(187_000)); assertEquals("1:02:03", formatClock(3_723_000)); assertEquals("0:00", formatClock(-5)) }
}
