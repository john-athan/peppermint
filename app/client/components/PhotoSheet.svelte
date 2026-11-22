<script lang="ts">
  // The lead photo before it goes public: what readers will see (faces and plates blurred), its alt text and caption,
  // and where the crops for each channel centre (tap the photo to move the point). Switching the blur makes the
  // public copy again.
  import { untrack } from "svelte";
  import Sheet from "./Sheet.svelte";
  import { api } from "../lib/api";
  import { toast } from "../lib/state.svelte";
  import { I } from "../lib/icons";
  import { blurred, crop } from "../lib/photo";
  import type { CasePhoto } from "../../shared/types";

  let { open = $bindable(false), photo, draftId, onchanged }: { open: boolean; photo: CasePhoto; draftId: number; onchanged: () => Promise<void> | void } = $props();
  let alt = $state(""), caption = $state(""), focal = $state({ x: 0.5, y: 0.5 }), v = $state(0), working = $state(false);
  $effect(() => { if (open) untrack(() => { alt = photo.alt; caption = photo.caption; focal = { ...photo.focal }; }); });
  const src = $derived(`/api/photos/${photo.id}?v=public&t=${v}`);
  const CROPS = [["16:9", 16 / 9, "page"], ["4:5", 4 / 5, "Instagram"], ["1:1", 1, "link previews"]] as const;

  /** Makes the public copy again (with or without the blur) and stores it. */
  export async function remake(blur: boolean) {
    working = true;
    try {
      const b = await blurred(`/api/photos/${photo.id}`, blur ? photo.faces : []);
      await api(`/api/photos/${photo.id}/public`, { method: "PUT", body: b });
      v++;
    } finally { working = false; }
  }
  async function setBlur(on: boolean) {
    try { await api(`/api/photos/${photo.id}`, { method: "PATCH", json: { blur: on } }); photo.blur = on; await remake(on); await onchanged(); toast(on ? "Faces blurred again." : "Shown without blur. Only do this when everyone in it agreed."); }
    catch (e) { toast((e as Error).message); }
  }
  async function save() {
    try { await api(`/api/photos/${photo.id}`, { method: "PATCH", json: { alt, caption, focal } }); await onchanged(); open = false; toast("Photo saved."); }
    catch (e) { toast((e as Error).message); }
  }
  async function remove() {
    await api(`/api/drafts/${draftId}/meta`, { method: "PATCH", json: { photo: null } }); await onchanged(); open = false; toast("The piece goes out without a photo.");
  }
  function setFocal(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    focal = { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  }
</script>

<Sheet bind:open label="Photo">
  <h3>Photo</h3>
  <button class="ph-main" type="button" onclick={setFocal} aria-label="Tap to set where the crops centre">
    <img {src} alt={alt} width={photo.w} height={photo.h} />
    <i class="ph-focal" style:left="{focal.x * 100}%" style:top="{focal.y * 100}%"></i>
    {#if working}<span class="ph-busy">Making the public copy…</span>{/if}
  </button>
  <ul class="checks ph-checks">
    {#if photo.faces.length}
      <li class:ok={photo.blur}><i>{@html photo.blur ? I.check : I.alert}</i><div><b>{photo.faces.length} {photo.faces.length === 1 ? "face or plate" : "faces or plates"} {photo.blur ? "blurred" : "visible"}</b><small>{photo.blur ? "Passers-by stay unrecognisable" : "Only with the consent of everyone in it"}</small></div>
        <button class="link-btn" type="button" onclick={() => setBlur(!photo.blur)}>{photo.blur ? "Undo" : "Blur again"}</button></li>
    {:else}
      <li class="ok"><i>{@html I.check}</i><div><b>Nobody recognisable</b><small>No faces or plates found</small></div></li>
    {/if}
    <li class="ok"><i>{@html I.check}</i><div><b>Location removed from the file</b><small>Readers see the picture, not where your phone was</small></div></li>
  </ul>
  <label class="field"><span>Alt text <small>read out to people who cannot see it</small></span><textarea rows="2" bind:value={alt}></textarea></label>
  <label class="field"><span>Caption</span><input type="text" bind:value={caption} /></label>
  <div class="field"><span>Crops <small>tap the photo to move their centre</small></span>
    <div class="ph-crops">
      {#each CROPS as [label, ratio, use]}
        {@const c = crop(photo.w, photo.h, ratio, focal)}
        <figure><div class="ph-crop" style:aspect-ratio={ratio}><img {src} alt="" style:width="{100 / c.w}%" style:left="{-c.x / c.w * 100}%" style:top="{-c.y / c.h * 100}%" /></div><figcaption>{label}<small>{use}</small></figcaption></figure>
      {/each}
    </div>
  </div>
  <div class="pub-acts mt-s"><button class="primary" type="button" onclick={save}>Save</button><button class="link-btn danger" type="button" onclick={remove}>No photo</button></div>
</Sheet>
