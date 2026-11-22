<script lang="ts">
  import { I } from "../lib/icons";
  import { appLink, inApp } from "../lib/inapp";
  // A podcast episode or a YouTube video inside the reader. The video loads only when you press play, from YouTube's
  // no-cookie player, so opening a story contacts nobody. Inside the Android app an episode plays in the app's own player,
  // which keeps going with the screen off and keeps what it downloaded.
  let { media, title, poster = null, episode = null }: { media: { audio: string | null; video: string | null; duration: number | null; image: string | null }; title: string; poster?: string | null; episode?: number | null } = $props();
  let playVideo = $state(false);
  const dur = (s: number) => `${Math.floor(s / 3600) ? Math.floor(s / 3600) + " h " : ""}${Math.round((s % 3600) / 60)} min`;
</script>

{#if media.video}
  <div class="player video">
    {#if playVideo}
      <iframe src="https://www.youtube-nocookie.com/embed/{media.video}?autoplay=1&rel=0" title={title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
    {:else}
      <button type="button" class="poster" onclick={() => (playVideo = true)} aria-label="Play the video">
        <img src={poster ?? `https://i.ytimg.com/vi/${media.video}/hqdefault.jpg`} alt="" loading="lazy" referrerpolicy="no-referrer" />
        <span class="play" aria-hidden="true">{@html I.play}</span>
      </button>
    {/if}
  </div>
{:else if media.audio}
  <div class="player audio">
    {#if poster ?? media.image}<img src={poster ?? media.image} alt="" loading="lazy" referrerpolicy="no-referrer" />{/if}
    <div><small>Episode{media.duration ? ` · ${dur(media.duration)}` : ""}</small>{#if inApp && episode != null}<a class="primary sm" href={appLink.play(episode)}>Play in the app</a>{:else}<audio controls preload="none" src={media.audio}></audio>{/if}</div>
  </div>
{/if}
