package dev.kaleve.peppermint.core

/** "42 min", "1 h 05 min": an episode's length for the list. Null when the feed gave none. */
fun formatLength(seconds: Long?): String? {
    if (seconds == null || seconds <= 0) return null
    val min = (seconds + 30) / 60
    return if (min < 60) "${maxOf(min, 1)} min" else "${min / 60} h ${(min % 60).toString().padStart(2, '0')} min"
}

/** "3:07" or "1:02:03": a playback position. */
fun formatClock(ms: Long): String {
    val s = maxOf(ms, 0) / 1000
    val h = s / 3600; val m = s % 3600 / 60; val sec = s % 60
    return if (h > 0) "$h:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}" else "$m:${sec.toString().padStart(2, '0')}"
}
