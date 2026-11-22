<script lang="ts">
  // An in-app link: a plain <a> that navigates without a reload, and leaves Cmd/Ctrl/Shift-click and middle-click to the browser.
  import type { Snippet } from "svelte";
  import type { HTMLAnchorAttributes } from "svelte/elements";
  import { go } from "../lib/state.svelte";
  let { href, stop = false, children, ...rest }: HTMLAnchorAttributes & { href: string; stop?: boolean; children?: Snippet } = $props();
  function click(e: MouseEvent) {
    if (stop) e.stopPropagation();
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); go(href);
  }
</script>
<a {href} {...rest} onclick={click}>{@render children?.()}</a>
