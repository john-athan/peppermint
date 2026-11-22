// Owned by oss-kit (templates/shared/android-device). Change it there and run `oss sync-tooling`, never in a copy.
package dev.kaleve.device

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Keeps the device token encrypted at rest: AES-GCM with a key that lives in the
 * Android Keystore and never leaves it. The file holds IV + ciphertext, base64.
 * The token is never logged and never put in an exception message.
 */
class TokenVault(context: Context) {
    private val prefs = context.getSharedPreferences("vault", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    fun save(token: String) {
        val c = Cipher.getInstance(TRANSFORM)
        c.init(Cipher.ENCRYPT_MODE, key())
        val blob = c.iv + c.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit().putString("t", Base64.encodeToString(blob, Base64.NO_WRAP)).apply()
    }

    /** Null when nothing is stored or the key no longer opens it (then it is dropped). */
    fun load(): String? {
        val s = prefs.getString("t", null) ?: return null
        return try {
            val blob = Base64.decode(s, Base64.NO_WRAP)
            val c = Cipher.getInstance(TRANSFORM)
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, blob, 0, IV_BYTES))
            String(c.doFinal(blob, IV_BYTES, blob.size - IV_BYTES), Charsets.UTF_8)
        } catch (_: Exception) {
            clear(); null
        }
    }

    fun clear() { prefs.edit().remove("t").apply() }

    private companion object {
        // the alias the first app (Monet) shipped with: keeping it keeps every paired phone paired
        const val ALIAS = "peppermint-device-token"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
    }
}
