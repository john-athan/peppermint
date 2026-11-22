<script lang="ts">
  // One task of the agent as a card on Today, in lilac: everything the agent made looks like this, everything else stays mint.
  import Link from "./Link.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { dismissTask, react, following, storyUrl } from "../lib/agent.svelte";
  import { toast } from "../lib/state.svelte";
  import { I } from "../lib/icons";
  import type { Task } from "../../shared/types";

  let { task }: { task: Task } = $props();
  const fail = (e: unknown) => toast((e as Error).message);
  const dismiss = () => dismissTask(task).catch(fail);
  const answer = (v: "more" | "less") => react(task, v).catch(fail);
</script>

<article class="ag" aria-busy={task.status === "running"}>
  <button class="ag-x" type="button" aria-label="Dismiss" onclick={dismiss}>{@html I.x}</button>
  {#if task.kind === "dossier"}
    {#if task.status === "running"}
      <span class="ag-chip">✦ Dossier · researching</span>
      <h3>{task.title}</h3>
      <ul class="ag-steps">{#each task.steps as s}<li class:done={s.done}><i aria-hidden="true">{s.done ? "✓" : "◦"}</i>{s.label}</li>{/each}</ul>
      <Skeleton lines={2} sm label="Researching" />
    {:else if task.status === "error"}
      <span class="ag-chip">✦ Dossier</span>
      <h3>{task.title}</h3>
      <p class="ag-why">{task.error ?? "The research did not finish."}</p>
    {:else}
      <span class="ag-chip">✦ Dossier{following(task) ? " · following" : ""}</span>
      <h3><Link href="/dossier/{task.id}">{task.title}</Link></h3>
      <p class="ag-sum">{task.result?.summary}</p>
    {/if}
  {:else if task.kind === "probe"}
    <span class="ag-chip">✦ Trying · {task.result?.label}</span>
    <h3>{#if task.story_id}<Link href={storyUrl(task.story_id)}>{task.card?.title ?? task.title}</Link>{:else}{task.card?.title ?? task.title}{/if}</h3>
    <p class="ag-why">{task.result?.why}</p>
    <div class="ag-acts">
      <button class="primary" type="button" onclick={() => answer("more")}>More of this</button>
      <button class="ghost" type="button" onclick={() => answer("less")}>Not for me</button>
    </div>
  {:else if task.kind === "explain"}
    <span class="ag-chip">✦ Why</span>
    <p class="ag-sum all">{task.result?.text}</p>
    {#if task.result?.refs?.length}<div class="ag-refs">{#each task.result.refs as r}<span>{r.name}</span>{/each}</div>{/if}
  {:else}
    <span class="ag-chip">✦ Shared by you</span>
    <h3>{#if task.story_id}<Link href={storyUrl(task.story_id)}>{task.card?.title ?? task.title}</Link>{:else}{task.title}{/if}</h3>
  {/if}
</article>
