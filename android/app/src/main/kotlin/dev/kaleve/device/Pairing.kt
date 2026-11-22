// Owned by oss-kit (templates/shared/android-device). Change it there and run `oss sync-tooling`, never in a copy.
package dev.kaleve.device

/** Pairing codes come from an unambiguous alphabet; users may type spaces, dashes, lower case. */
fun normalizeCode(raw: String): String =
    raw.filter { it.isLetterOrDigit() && it.code < 128 }.uppercase().take(8)

fun isCompleteCode(raw: String): Boolean = normalizeCode(raw).length == 8

/** ABCD-EFGH while typing. */
fun displayCode(raw: String): String {
    val c = normalizeCode(raw)
    return if (c.length <= 4) c else c.substring(0, 4) + "-" + c.substring(4)
}

/** Trims, adds https:// when no scheme is typed, drops trailing slashes. Null when not a usable URL. */
fun normalizeServer(raw: String): String? {
    var s = raw.trim()
    if (s.isEmpty() || s.any { it.isWhitespace() }) return null
    if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://$s"
    val rest = s.substringAfter("://").trimEnd('/')
    if (rest.isEmpty()) return null
    return s.substringBefore("://") + "://" + rest
}
