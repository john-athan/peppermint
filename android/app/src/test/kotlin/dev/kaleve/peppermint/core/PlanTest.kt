package dev.kaleve.peppermint.core

import org.junit.Assert.*
import org.junit.Test

class PlanTest {
    private fun disk(vararg ids: Long) = ids.map { OnDisk(it, 1000) }

    @Test fun `downloads the first eight that are missing, in queue order`() {
        val p = planEpisodes((1L..12L).toList(), disk(2, 4), null)
        assertEquals(listOf(1L, 3, 5, 6, 7, 8), p.download)
    }
    @Test fun `episodes past the eighth are not fetched`() = assertTrue(9L !in planEpisodes((1L..12L).toList(), emptyList(), null).download)
    @Test fun `deletes what left the queue`() = assertEquals(listOf(5L, 6L), planEpisodes(listOf(1, 2), disk(1, 5, 6), null).delete)
    @Test fun `keeps the playing one even when it left the queue`() = assertEquals(listOf(6L), planEpisodes(listOf(1), disk(1, 5, 6), 5).delete)
    @Test fun `a queued episode on disk beyond the eighth is kept`() = assertTrue(planEpisodes((1L..12L).toList(), disk(11), null).delete.isEmpty())
    @Test fun `empty queue deletes everything`() = assertEquals(listOf(1L, 2L), planEpisodes(emptyList(), disk(1, 2), null).delete)

    @Test fun `budget is three gigabytes`() {
        assertTrue(fitsBudget(0, 100))
        assertTrue(fitsBudget(MAX_BYTES - 100, 100))
        assertFalse(fitsBudget(MAX_BYTES - 99, 100))
        assertFalse(fitsBudget(MAX_BYTES, 0))
        assertTrue(fitsBudget(MAX_BYTES - 1, 0))
    }
    @Test fun `extension comes from the url path`() {
        assertEquals("m4a", audioExtension("https://x.example/a/ep.M4A?token=1.mp3"))
        assertEquals("mp3", audioExtension("https://x.example/stream"))
        assertEquals("mp3", audioExtension("https://x.example/a.b/stream"))
        assertEquals("mp3", audioExtension("https://x.example/file.toolongext"))
        assertEquals("ogg", audioExtension("https://x.example/e.ogg#t=1"))
    }
    @Test fun `heard when ended`() = assertTrue(isHeard(0, 0, true))
    @Test fun `heard past 95 percent`() { assertTrue(isHeard(950, 1000, false)); assertFalse(isHeard(949, 1000, false)) }
    @Test fun `unknown duration is not heard before the end`() = assertFalse(isHeard(99999, 0, false))
}
