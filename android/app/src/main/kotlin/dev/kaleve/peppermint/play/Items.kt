package dev.kaleve.peppermint.play

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import dev.kaleve.peppermint.data.Episode
import java.io.File

private fun item(id: String, uri: Uri, meta: MediaMetadata): MediaItem = MediaItem.Builder()
    .setMediaId(id).setUri(uri).setMediaMetadata(meta)
    .setRequestMetadata(MediaItem.RequestMetadata.Builder().setMediaUri(uri).build())
    .build()

/** The downloaded file when there is one, else the publisher's stream. The media id is the episode id. */
fun episodeItem(ep: Episode, file: File?): MediaItem = item(
    ep.id.toString(), file?.let { Uri.fromFile(it) } ?: Uri.parse(ep.audio),
    MediaMetadata.Builder().setTitle(ep.title).setArtist(ep.show).setDurationMs(ep.duration?.times(1000)).build(),
)

/** The edition's recorded parts, one title for all of them. Their media ids start with "edition" so no position is kept. */
fun editionItems(files: List<File>, title: String): List<MediaItem> = files.mapIndexed { i, f ->
    item("edition-$i", Uri.fromFile(f), MediaMetadata.Builder().setTitle(title).setArtist("peppermint").build())
}
