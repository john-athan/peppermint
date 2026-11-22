// The agent's things, kept once: the tasks and proposals every screen draws, the polling while one is still running,
// and what to do with an answer. Screens ask through submit() and read the state; none talks to /api/agent on its own.
import { api } from "./api";
import { flyTo } from "./motion";
import { app, go, toast } from "./state.svelte";
import type { AgentReply, Proposal, Task } from "../../shared/types";

export const agent = $state({ tasks: [] as Task[], proposals: [] as Proposal[], loaded: false });
export const following = (t: Task) => (t.result?.follow_until ?? 0) > Date.now();
export const storyUrl = (id: number, ask?: string) => `/story/${id}${ask ? `?ask=${encodeURIComponent(ask)}` : ""}`;

// polling: every 2 s while a task runs, only while some screen is watching
let watchers = 0, timer: ReturnType<typeof setTimeout> | undefined;
export async function loadAgent() {
  clearTimeout(timer);
  try {
    const r = await api<{ tasks: Task[]; proposals: Proposal[] }>("/api/agent");
    agent.tasks = r.tasks.filter(t => t.status !== "dismissed"); agent.proposals = r.proposals; agent.loaded = true;
  } catch {}
  if (watchers && agent.tasks.some(t => t.status === "running")) timer = setTimeout(loadAgent, 2000);
}
/** Call from an $effect: loads now and keeps the state fresh while something runs; the returned function stops it. */
export function watchAgent() {
  watchers++; loadAgent();
  return () => { if (--watchers <= 0) { watchers = 0; clearTimeout(timer); } };
}
const put = (t: Task) => { agent.tasks = [t, ...agent.tasks.filter(x => x.id !== t.id)]; };
export const openProposals = () => agent.proposals.filter(p => p.status === "open");

/** The edition was rebuilt on the server (a palate change): fetch it again so Today shows the new one. */
export async function reloadEdition() {
  const r = await api("/api/edition");
  app.edition = r.edition; app.sources = r.sources; app.llm = r.llm; app.feed = { cards: [], done: false, fresh: [] };
}

export async function dismissTask(t: Task) {
  agent.tasks = agent.tasks.filter(x => x.id !== t.id);
  await api(`/api/agent/tasks/${t.id}/dismiss`, { method: "POST" }).catch(() => loadAgent());
}
export async function react(t: Task, verdict: "more" | "less") {
  const r = await api<{ moved: { name: string; delta: number }[] }>(`/api/agent/tasks/${t.id}/react`, { method: "POST", json: { verdict } });
  agent.tasks = agent.tasks.filter(x => x.id !== t.id);
  const m = r.moved?.[0];
  toast(m ? `Palate: ${m.name} ${m.delta > 0 ? "+" : "−"}${Math.abs(m.delta).toFixed(1)}${r.moved.length > 1 ? ` and ${r.moved.length - 1} more` : ""}. Next harvest follows.` : "Palate updated.");
}

/** Undo for an applied proposal: back to what it said before, and Today follows. */
export async function undoProposal(id: number) {
  await api(`/api/agent/proposals/${id}/undo`, { method: "POST" });
  await reloadEdition().catch(() => {}); loadAgent();
  toast("Undone.");
}
export async function applyProposal(p: Proposal, onchange?: () => void) {
  await api(`/api/agent/proposals/${p.id}/apply`, { method: "POST" });
  agent.proposals = agent.proposals.filter(x => x.id !== p.id);
  await reloadEdition().catch(() => {});
  toast("Applied.", { ms: 7000, action: { label: "Undo", run: () => undoProposal(p.id).then(onchange) } });
  onchange?.();
}
export async function dismissProposal(p: Proposal) {
  agent.proposals = agent.proposals.filter(x => x.id !== p.id);
  await api(`/api/agent/proposals/${p.id}/dismiss`, { method: "POST" }).catch(() => loadAgent());
}

/** One input to the agent, and what its answer becomes on screen. Errors carry the server's sentence; the caller toasts them. */
export async function submit(input: string, scope: { kind: "today" | "palate" | "story"; story_id?: number }, replace = false): Promise<AgentReply> {
  const r = await api<AgentReply>("/api/agent", { method: "POST", json: { input, scope } });
  switch (r.action) {
    case "link": if (r.story_id) go(storyUrl(r.story_id, r.ask), replace); break;
    case "palate":
      if (r.proposal) toast(r.reply, { ms: 7000, action: { label: "Undo", run: () => undoProposal(r.proposal!.id) } }); else toast(r.reply);
      await reloadEdition().catch(() => {});
      break;
    case "research": {
      // a question becomes a topic in Research: the tab answers, and the toast opens it
      if (r.task) put(r.task); loadAgent(); flyTo([], "/research");
      const id = r.task?.id;
      toast(r.reply, id ? { ms: 6000, action: { label: "Open", run: () => go(`/dossier/${id}`) } } : undefined);
      break;
    }
    case "explain": if (r.task) put(r.task); loadAgent(); break;
    case "optimize": loadAgent(); if (!r.proposals?.length) toast(r.reply); break;
    case "discover": loadAgent(); toast(r.reply); break;
    default: toast(r.reply);
  }
  return r;
}
