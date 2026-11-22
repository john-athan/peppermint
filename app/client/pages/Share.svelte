<script lang="ts">
  // Where the system share sheet lands: the shared link becomes a story, and you read it at once.
  import { onMount } from "svelte";
  import Loading from "../components/Loading.svelte";
  import { go, toast } from "../lib/state.svelte";
  import { submit } from "../lib/agent.svelte";
  import { openCapture } from "../lib/capture.svelte";

  /** Photos the service worker kept from the share sheet, as files again; the cache is emptied once read. */
  async function sharedPhotos(n: number) {
    const c = await caches.open("pm-share"); const files: File[] = [];
    for (let i = 0; i < n; i++) {
      const r = await c.match(`/share-file/${i}`); if (!r) continue;
      files.push(new File([await r.blob()], decodeURIComponent(r.headers.get("x-name") ?? `photo-${i + 1}.jpg`), { type: r.headers.get("content-type") ?? "image/jpeg" }));
    }
    await caches.delete("pm-share");
    return files;
  }

  onMount(() => {
    const q = new URLSearchParams(location.search);
    // photos: an investigation starts, with whatever text came along as the note
    const n = Number(q.get("photos"));
    if (n > 0) { sharedPhotos(n).then(files => { go("/studio", true); openCapture(files, q.get("text") ?? ""); }); return; }
    // some apps put the link in `text`, with words around it; the agent finds it there
    const input = (q.get("url") || q.get("text") || q.get("title") || "").trim();
    if (!input) { go("/", true); return; }
    // a link opens its story in place of this page, so Back does not share it twice
    submit(input, { kind: "today" }, true).then(r => { if (!(r.action === "link" && r.story_id)) go("/", true); }).catch(e => { toast((e as Error).message); go("/", true); });
  });
</script>
<div class="page"><Loading text="Reading the page…" /></div>
