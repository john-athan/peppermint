// Owned by oss-kit (templates/shared/android-device). Change it there and run `oss sync-tooling`, never in a copy.
package dev.kaleve.device

import org.junit.Assert.*
import org.junit.Test

class PairingTest {
    @Test fun codeIsUpperedAndStripped() { assertEquals("ABCD2345", normalizeCode(" abcd-23 45 ")); assertEquals("ABCDEFGH", normalizeCode("abcdefghXYZ")) }
    @Test fun codeCompleteAtEight() { assertTrue(isCompleteCode("abcd-efgh")); assertFalse(isCompleteCode("abcd-ef")) }
    @Test fun codeDisplayGroups() { assertEquals("ABC", displayCode("abc")); assertEquals("ABCD-E", displayCode("abcde")); assertEquals("ABCD-EFGH", displayCode("abcdefgh")) }

    @Test fun serverNormalisation() {
        assertEquals("https://app.kaleve.dev", normalizeServer(" app.kaleve.dev/ "))
        assertEquals("http://10.0.2.2:4320", normalizeServer("http://10.0.2.2:4320"))
        assertNull(normalizeServer("")); assertNull(normalizeServer("a b")); assertNull(normalizeServer("https:///"))
    }
}
