<script lang="ts">
  // Account: you, the people who share this peppermint, your passkeys and where you are signed in. An admin invites,
  // gives someone a new passkey for a lost phone, and takes access away (docs/accounts.md). Each reader's sources,
  // palate and writing are their own; nobody here reads anyone else's.
  import type { AccountDevice, AccountLink, AccountMe, AccountMember, AccountPairing, AccountPasskey, AccountSession } from "../../shared/accounts";
  import { appLink, inApp } from "../lib/inapp";
  import { api } from "../lib/api";
  import { ago } from "../lib/format";
  import { app, toast } from "../lib/state.svelte";
  import { deviceLabel, logout, passkeyMessage, passkeysSupported, register } from "../lib/passkeys";
  import Loading from "../components/Loading.svelte";

  let me = $state<AccountMe | null>(null), people = $state<AccountMember[]>([]), keys = $state<AccountPasskey[]>([]), sessions = $state<AccountSession[]>([]);
  let name = $state(""), guest = $state(""), busy = $state(false), asking = $state<string | null>(null);
  let link = $state<(AccountLink & { who: string }) | null>(null), copied = $state(false);
  let devices = $state<AccountDevice[]>([]), pairing = $state<AccountPairing | null>(null);
  const admin = $derived(me?.role === "admin");
  const admins = $derived(people.filter(p => p.role === "admin").map(p => p.name));

  async function load() {
    try {
      [me, people, keys, sessions, devices] = await Promise.all([api<AccountMe>("/api/account"), api<AccountMember[]>("/api/members"), api<AccountPasskey[]>("/api/passkeys"), api<AccountSession[]>("/api/sessions"), api<AccountDevice[]>("/api/devices")]);
      devices = devices.filter(d => !d.revokedAt);
      if (!name) name = me.name;
    } catch (e: any) { toast(e.message); }
  }
  $effect(() => { load(); });
  /** Runs a change, shows the server's sentence when it is refused, and reloads. */
  async function act(f: () => Promise<unknown>, done?: string) {
    busy = true;
    try { await f(); asking = null; if (done) toast(done); await load(); } catch (e: any) { toast(passkeyMessage(e, "en")); } finally { busy = false; }
  }
  const ask = (k: string) => (asking = asking === k ? null : k);
  const showLink = (l: AccountLink, who: string) => { link = { ...l, who }; copied = false; };

  const rename = (e: Event) => { e.preventDefault(); if (name.trim() && name.trim() !== me?.name) act(() => api("/api/account", { method: "PATCH", json: { name: name.trim() } }), "Your name is saved."); };
  const invite = (e: Event) => { e.preventDefault(); const who = guest.trim(); if (who) act(async () => { showLink(await api<AccountLink>("/api/members", { method: "POST", json: { name: who } }), who); guest = ""; }); };
  const newLink = (p: AccountMember) => act(async () => showLink(await api<AccountLink>(`/api/members/${p.id}/link`, { method: "POST" }), p.name));
  const ownLink = () => act(async () => showLink(await api<AccountLink>("/api/account/link", { method: "POST" }), me?.name ?? ""));
  const setRole = (p: AccountMember, role: "admin" | "member") => act(() => api(`/api/members/${p.id}`, { method: "PATCH", json: { role } }));
  const remove = (p: AccountMember) => act(async () => {
    const r = await api<{ result: "deleted" | "revoked" }>(`/api/members/${p.id}`, { method: "DELETE" });
    if (link?.member === p.id) link = null;
    toast(r.result === "deleted" ? `The invite for ${p.name} is withdrawn.` : `${p.name} can no longer sign in. Their sources and writing stay.`);
    if (p.you) location.replace("/");
  });
  const addKey = () => act(() => register(deviceLabel()), "The passkey is added.");
  const dropKey = (k: AccountPasskey) => act(() => api(`/api/passkeys/${encodeURIComponent(k.id)}`, { method: "DELETE" }));
  const endSession = (s: AccountSession) => act(() => api(`/api/sessions/${s.id}`, { method: "DELETE" }));
  // a phone: the code is typed into the Android app, or, inside the app, handed over by the link
  const pair = () => act(async () => { pairing = await api<AccountPairing>("/api/devices/pair", { method: "POST" }); });
  const unpair = (d: AccountDevice) => act(() => api(`/api/devices/${d.id}`, { method: "DELETE" }), `${d.name} is disconnected.`);
  const shownCode = (c: string) => c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
  async function signOut() { try { await logout(); } catch {} location.replace("/"); }
  async function copy() { if (!link) return; try { await navigator.clipboard.writeText(link.link); copied = true; } catch { toast("Copying did not work. Select the link by hand."); } }

  const until = (ms: number) => new Date(ms).toLocaleString(app.lang === "de" ? "de-DE" : "en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  const standing = (p: AccountMember) => [p.role === "admin" ? "admin" : "", p.status === "invited" ? (p.link ? `invited, link until ${until(p.link.expiresAt)}` : "invited") : p.status === "none" ? "no access" : p.lastSeenAt ? `active ${ago(p.lastSeenAt)}` : "active"].filter(Boolean).join(" · ");
  const linkText = $derived(!link ? "" : link.purpose === "join" ? `Send ${link.who} this link. It works once, until ${until(link.expiresAt)}, and makes their own passkey.`
    : link.purpose === "recover" ? `Send ${link.who} this link. It works once, until ${until(link.expiresAt)}. Their new passkey replaces the old ones and signs out every browser they used.`
    : `Open this link on the other device within the hour. It works once and adds a passkey there.`);
  /** "Chrome on Mac" from a user agent, enough to tell sessions apart. */
  function browserOf(ua: string | null) {
    if (!ua) return "Browser";
    const b = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    return os ? `${b} on ${os}` : b;
  }
</script>

<div class="page">
  <header class="appbar"><h1>Account</h1><span class="sp"></span><button class="ghost sm" type="button" onclick={signOut}>Sign out</button></header>
  {#if !me}
    <Loading />
  {:else}
    <form class="pad acct-name" onsubmit={rename}>
      <label class="field">Your name<input type="text" bind:value={name} maxlength="40" autocomplete="nickname" /></label>
      <button class="ghost" type="submit" disabled={busy || !name.trim() || name.trim() === me.name}>Save</button>
    </form>
    <p class="pad hint mt-xs">How the others here see you.{admin ? " You are an admin: you invite people and help with lost phones." : ""}</p>

    <div class="group-label">People here</div>
    <div class="list">
      {#each people as p (p.id)}
        <div class="acct-row">
          <span class="min0"><span class="nm">{p.name}{#if p.you}<span class="chip">you</span>{/if}</span><span class="sub">{standing(p)}</span></span>
          {#if admin}
            <span class="acct-acts">
              {#if !p.you}<button class="ghost sm" type="button" disabled={busy} onclick={() => newLink(p)}>{p.status === "active" ? "New passkey" : "New link"}</button>{/if}
              {#if p.status === "active" && (!p.you || admins.length > 1)}<button class="ghost sm" type="button" disabled={busy} onclick={() => setRole(p, p.role === "admin" ? "member" : "admin")}>{p.role === "admin" ? (p.you ? "Step down" : "Remove admin") : "Make admin"}</button>{/if}
              {#if p.status !== "none" && !(p.role === "admin" && admins.length <= 1)}
                {#if asking === `x${p.id}`}<button class="primary sm danger" type="button" disabled={busy} onclick={() => remove(p)}>{p.status === "invited" ? "Withdraw invite" : "Take access away"}</button>
                {:else}<button class="ghost sm" type="button" onclick={() => ask(`x${p.id}`)}>Remove</button>{/if}
              {/if}
            </span>
          {/if}
        </div>
      {/each}
    </div>
    {#if admin}
      <form class="pad mt-m acct-name" onsubmit={invite}>
        <label class="field">Invite someone<input type="text" bind:value={guest} maxlength="40" placeholder="Their name" /></label>
        <button class="primary" type="submit" disabled={busy || !guest.trim()}>Invite</button>
      </form>
    {:else}
      <p class="pad hint mt-m">{admins.length > 1 ? `${admins.join(" and ")} invite people` : `${admins[0] ?? "An admin"} invites people`} and can give you a new passkey if you lose your phone.</p>
    {/if}
    {#if link}
      <div class="notice acct-link mt-m" role="status">
        <span>{linkText}</span>
        <code>{link.link}</code>
        <button class="ghost sm" type="button" onclick={copy}>{copied ? "Copied" : "Copy link"}</button>
      </div>
    {/if}

    <div class="group-label">Your passkeys</div>
    <div class="list">
      {#each keys as k (k.id)}
        <div class="acct-row">
          <span class="min0"><span class="nm">{k.name}</span><span class="sub">added {ago(k.createdAt)}{k.lastUsedAt ? ` · used ${ago(k.lastUsedAt)}` : ""}</span></span>
          {#if keys.length > 1}
            {#if asking === `k${k.id}`}<button class="primary sm danger" type="button" disabled={busy} onclick={() => dropKey(k)}>Delete it</button>
            {:else}<button class="ghost sm" type="button" onclick={() => ask(`k${k.id}`)}>Delete</button>{/if}
          {/if}
        </div>
      {/each}
    </div>
    <div class="pad mt-s acct-acts">
      {#if passkeysSupported()}<button class="ghost sm" type="button" disabled={busy} onclick={addKey}>Add a passkey on this device</button>{/if}
      <button class="ghost sm" type="button" disabled={busy} onclick={ownLink}>Link for another device</button>
    </div>

    <div class="group-label">Phones</div>
    <div class="list">
      {#each devices as d (d.id)}
        <div class="acct-row">
          <span class="min0"><span class="nm">{d.name}</span><span class="sub">connected {ago(d.createdAt)}{d.lastSeenAt ? ` · last seen ${ago(d.lastSeenAt)}` : ""}</span></span>
          {#if asking === `d${d.id}`}<button class="primary sm danger" type="button" disabled={busy} onclick={() => unpair(d)}>Disconnect it</button>
          {:else}<button class="ghost sm" type="button" onclick={() => ask(`d${d.id}`)}>Disconnect</button>{/if}
        </div>
      {/each}
    </div>
    {#if pairing}
      <div class="notice acct-link mt-m" role="status">
        {#if inApp}
          <span>Connect this phone, so the app downloads your podcasts and the edition to listen to offline. The code works once, for ten minutes.</span>
          <a class="primary sm" href={appLink.pair(pairing.code)}>Connect this phone</a>
        {:else}
          <span>Type this code into the peppermint app on your phone within ten minutes. It works once.</span>
          <code>{shownCode(pairing.code)}</code>
        {/if}
      </div>
    {:else}
      <div class="pad mt-s acct-acts"><button class="ghost sm" type="button" disabled={busy} onclick={pair}>{inApp ? "Connect this phone" : "Connect a phone"}</button></div>
    {/if}
    <p class="pad hint mt-xs">A connected phone fetches episodes and the edition to listen to, nothing else.</p>

    <div class="group-label">Signed in</div>
    <div class="list">
      {#each sessions as s (s.id)}
        <div class="acct-row">
          <span class="min0"><span class="nm">{browserOf(s.userAgent)}{#if s.current}<span class="chip">this one</span>{/if}</span><span class="sub">signed in {ago(s.createdAt)} · last seen {ago(s.lastSeenAt)}</span></span>
          {#if !s.current}<button class="ghost sm" type="button" disabled={busy} onclick={() => endSession(s)}>Sign out</button>{/if}
        </div>
      {/each}
    </div>
    <p class="pad hint mt-m acct-foot">A session ends 30 days after its last use, and after 180 days at the latest.</p>
  {/if}
</div>
