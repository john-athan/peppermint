<script lang="ts">
  // Signing in, and every link that makes a passkey (/setup#token): the first run, an invite, a new passkey for a lost
  // phone, one more device. The link first says whose passkey it makes and what happens to the old ones.
  import type { AccountLinkPreview } from "../../shared/accounts";
  import { app } from "../lib/state.svelte";
  import { deviceLabel, login, passkeyMessage, passkeysSupported, previewLink, register, takeLinkToken } from "../lib/passkeys";
  import Mark from "../components/Mark.svelte";
  let { setup }: { setup: boolean } = $props();
  let busy = $state(false), error = $state(""), link = $state<AccountLinkPreview | null>(null), gone = $state("");
  // the token lives in the fragment, which no server and no log ever sees; take it and clear the address bar
  const token = location.pathname === "/setup" ? takeLinkToken() : "";
  if (token) previewLink(token).then(l => (link = l), e => (gone = e.message));
  const lead = $derived(!link ? "" : link.purpose === "setup" ? "Create the first passkey. It makes you the admin of this peppermint, who invites the others."
    : link.purpose === "join" ? `Welcome, ${link.name}. Create your passkey: it stays on this device and syncs with your password manager.`
    : link.purpose === "recover" ? `A new passkey for ${link.name}. It replaces all their passkeys and signs out every browser they were signed in on.`
    : `One more passkey for ${link.name}, on this device. The others stay.`);

  async function create() {
    busy = true; error = "";
    try { await register(deviceLabel(), token); location.replace("/"); }
    catch (e: any) { error = passkeyMessage(e, "en"); busy = false; }
  }
  async function signIn() {
    busy = true; error = "";
    try { await login(); location.replace("/"); }
    catch (e: any) { error = passkeyMessage(e, "en"); busy = false; }
  }
</script>
<div class="center-stage">
  <Mark cls="anim {busy ? 'loading' : ''}" />
  <span class="latin">Mentha × piperita</span>
  <span class="word">peppermint</span>
  {#if !passkeysSupported()}
    <p>This browser cannot use passkeys. Open peppermint in a current Safari, Chrome or Firefox.</p>
  {:else if token && gone}
    <p>{gone}</p>
    {#if !app.auth}<button class="ghost" type="button" disabled={busy} onclick={signIn}>Sign in with passkey</button>{/if}
  {:else if token && link}
    <p>{lead}</p>
    {#if app.auth && link.purpose !== "add"}<p>Someone is signed in on this browser. The new passkey signs it in as {link.name ?? "the new admin"} instead.</p>{/if}
    <button class="primary" type="button" disabled={busy} onclick={create}>Create passkey</button>
  {:else if token}
    <p role="status">One moment.</p>
  {:else if setup}
    <p>No passkey exists yet. Open the setup link the server printed when it first started, with everything after the #.</p>
  {:else}
    <p>Everything you follow, distilled to your taste.</p>
    <button class="primary" type="button" disabled={busy} onclick={signIn}>Sign in with passkey</button>
  {/if}
  <p class="error-line" role="alert">{error}</p>
</div>
