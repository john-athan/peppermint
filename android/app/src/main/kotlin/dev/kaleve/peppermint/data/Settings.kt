package dev.kaleve.peppermint.data

import android.content.Context

/** Plain preferences: server, the Wi-Fi switch, what the edition recording was made from, heard episodes. The token is not here. */
class Settings(context: Context) {
    private val p = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var server: String
        get() = p.getString("server", DEFAULT_SERVER) ?: DEFAULT_SERVER
        set(v) = p.edit().putString("server", v).apply()
    var wifiOnly: Boolean
        get() = p.getBoolean("wifiOnly", true)
        set(v) = p.edit().putBoolean("wifiOnly", v).apply()

    /** Key (id, sig, lang) of the edition recording on disk, null when there is none. */
    var editionKey: String?
        get() = p.getString("editionKey", null)
        set(v) = p.edit().putString("editionKey", v).apply()
    /** "Edition, <day> <slot>" of the recording on disk: the player's title. */
    var editionTitle: String
        get() = p.getString("editionTitle", "Edition") ?: "Edition"
        set(v) = p.edit().putString("editionTitle", v).apply()

    /** Episodes heard here, hidden from the list until the server's queue stops naming them. */
    var heardHere: Set<Long>
        get() = ids("heardHere")
        set(v) = putIds("heardHere", v)
    /** Heard reports the server has not confirmed yet; retried on every sync. */
    var heardPending: Set<Long>
        get() = ids("heardPending")
        set(v) = putIds("heardPending", v)

    private fun ids(key: String): Set<Long> = (p.getStringSet(key, emptySet()) ?: emptySet()).mapNotNull { it.toLongOrNull() }.toSet()
    private fun putIds(key: String, v: Set<Long>) = p.edit().putStringSet(key, v.map { it.toString() }.toSet()).apply()

    companion object { const val DEFAULT_SERVER = "https://peppermint.kaleve.dev" }
}
