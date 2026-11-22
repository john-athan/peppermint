package dev.kaleve.peppermint.play

/** The episode the player is on, for a sync that must not delete the file under it. Null for the edition or silence. */
object Now {
    @Volatile var episodeId: Long? = null
}
