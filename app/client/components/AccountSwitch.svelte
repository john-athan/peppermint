<script lang="ts">
  // One button for the account in front: tap it to switch to another account signed in on this browser, add one, or
  // open the account page. With a single account it still shows whose peppermint this is.
  import Sheet from "./Sheet.svelte";
  import { I } from "../lib/icons";
  import { go, toast } from "../lib/state.svelte";
  import { accountsHere, addAccount, initials, switchTo, type Here } from "../lib/keyring";
  let { wide = false, cls = "" }: { wide?: boolean; cls?: string } = $props();
  let here = $state<Here | null>(null), open = $state(false), busy = $state(false);
  accountsHere().then(h => (here = h)).catch(() => {});
  const name = $derived(here?.current?.name ?? "");
  async function run(f: () => Promise<void>) { busy = true; try { await f(); } catch (e) { toast((e as Error).message); busy = false; } }
</script>
<button class="acct-switch {cls}" class:wide type="button" aria-haspopup="dialog" aria-label={name ? `Account: ${name}. Switch account` : "Switch account"} onclick={() => (open = true)}>
  <span class="acct-dot" aria-hidden="true">{name ? initials(name) : ""}</span>{#if wide}<span class="min0">{name || "Account"}</span>{/if}
</button>
<Sheet bind:open label="Accounts">
  <h3>Accounts on this device</h3>
  {#if here?.current}
    <div class="acct-pick" aria-current="true"><span class="acct-dot">{initials(here.current.name)}</span><span class="min0">{here.current.name}</span><span class="chip">in front</span></div>
  {/if}
  {#each here?.others ?? [] as o (o.id)}
    <button class="acct-pick" type="button" disabled={busy} onclick={() => run(() => switchTo(o.id))}><span class="acct-dot">{initials(o.name)}</span><span class="min0">{o.name}</span>{@html I.swap}</button>
  {/each}
  <p class="hint mt-s">Every account stays signed in here; one tap switches. Signing out ends only the one in front.</p>
  <div class="tune-row mt-m">
    <button class="ghost" type="button" disabled={busy || (here?.others.length ?? 0) >= 4} onclick={() => run(addAccount)}>{@html I.plus}Add account</button>
    <button class="ghost" type="button" onclick={() => { open = false; go("/account"); }}>{@html I.key}Account</button>
  </div>
</Sheet>
