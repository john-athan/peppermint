<script lang="ts">
  import { app } from "../lib/state.svelte";
  import Mark from "./Mark.svelte";
</script>
{#if app.toast}
  <div class="toast" role="status">
    {#if app.toast.loading}<Mark cls="loading sm" label="" />{/if}
    <span>{app.toast.msg}</span>
    {#if app.toast.action}<button type="button" onclick={() => { app.toast?.action?.run(); app.toast = null; }}>{app.toast.action.label}</button>
      {#key app.toast}<i class="toast-bar" style:--ms="{app.toast.ms ?? 2600}ms" aria-hidden="true"></i>{/key}{/if}
  </div>
{/if}
