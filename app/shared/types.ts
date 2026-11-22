// The shapes the server sends and the client reads, defined once. Both sides import from here;
// tests/conventions.test.ts fails when one of these names is declared again anywhere else.
import type { Chart } from "./chart";
import type { EmblemSpec } from "./emblem";

export type Reason = { label: string; v: number };
export type StoryImage = { src: string; w: number; h: number; shape: "wide" | "square" | "tall"; credit: string | null; pending?: boolean };
/** One story as a card on Today, the reading list and the reader's head. */
export type Card = { id: number; title: string; title_orig: string; translated: boolean; lang: string; summary: string; sources: { name: string; kind: string; icon?: string | null }[]; authors: string[]; count: number; at: number; topics: string[]; places: string[]; meta: any; score: number; reasons: Reason[]; pinned: boolean; url: string; brief: string | null; image?: StoryImage | null; figures?: { src: string; w: number; h: number; caption: string }[]; chart?: Chart | null; emblem?: EmblemSpec | null;
  /** set on update cards: a followed story with reports you have not seen */
  update?: { count: number; reports: { title: string; source: string; kind: string; icon?: string | null }[]; text: string | null };
  /** research found nothing to read behind the headline (a login, paywall or empty page): shown as a slim card */
  unreadable?: boolean;
  /** the article could not be read; another report (its site) or the discussion stands in, shown as a pill in the Reader */
  stand_in?: { kind: "report" | "discussion"; site: string };
  /** little to read even after research: the card shows the source's summary, with no brief and no TL;DR */
  short?: boolean;
  /** an edition slotted it in for you to try: from a source on trial, or from outside your usual subjects */
  slot?: "trial" | "different" };
export type Edition = { id: number; day: string; slot: string; current: boolean; considered: number; updated_at: number; cut: { reason: string; n: number }[]; cards: Card[]; minutes: number; viewed: number; saved: number };

/** Studio: a draft is a list of blocks; quotes carry their story and source. */
export type Block = { id: string; type: "h" | "p" | "q" | "c" | "chart"; text: string; cite?: { story_id: number; source: string; kind: string; url: string | null; icon?: string | null };
  /** the evidence of an investigation this block rests on (ids into its case file), and how well it holds */
  ev?: number[]; support?: "strong" | "ok" | "weak";
  /** an unconfirmed claim kept as an open question: it states nothing, so it needs no source */
  open?: boolean };
export type Draft = { id: number; title: string; blocks: Block[]; status: "draft" | "published"; created_at: number; updated_at: number; published_at: number | null;
  investigation_id?: number | null; slug?: string | null; publish_at?: number | null; meta?: DraftMeta };
/** What an editor needs beside the text: other headlines, Claude's notes, the photo, decisions made before publishing. */
export type DraftMeta = {
  headlines?: string[]; notes?: EditorNote[]; photo?: number | null; angle?: string; lang?: "de" | "en";
  /** someone the piece holds responsible, and whether they had a chance to answer */
  accuses?: { who: string; what: string }[]; reply_ok?: boolean;
  channels?: { mail: boolean }; mailed_at?: number | null; preview?: string | null;
};
/** Claude as an editor: a remark on one block (or the whole piece), with the replacement it proposes ("" cuts the block). */
export type EditorNote = { id: string; block: string | null; text: string; fix: string | null; kind: "edit" | "answer" };
export type DraftVersion = { id: number; by: "claude" | "you" | "update"; label: string; created_at: number; words: number };

/* ---------- investigations: something you noticed becomes a researched, written piece ---------- */
export type EvidenceKind = "photo" | "note" | "answer" | "web" | "wiki" | "harvest" | "reply" | "tip";
/** One thing an investigation knows, with where it comes from. `fresh`: arrived after the piece was written. */
export type Evidence = { id: number; kind: EvidenceKind; title: string; site: string; url: string | null; quote: string; at: number | null; fresh: boolean; same: boolean };
export type CaseQuestion = { id: string; q: string; options: string[]; answer: string | null };
export type CaseContact = { id: string; name: string; why: string; subject: string; question: string; to: string; sent_at: number | null; replied_at: number | null; token?: string };
export type Angle = { key: string; title: string; pitch: string; needs: string; fit: number; ev: number[] };
/** A box on a photo, as fractions of its width and height. */
export type Box = { x: number; y: number; w: number; h: number };
export type CasePhoto = { id: number; w: number; h: number; faces: Box[]; blur: boolean; alt: string; caption: string; focal: { x: number; y: number }; public: boolean; taken_at: number | null };
export type Place = { name: string; detail: string; lat: number | null; lng: number | null; operator: string;
  /** taken somewhere private (a home): never named in research, the piece or the public page */
  private?: boolean };
/** News after the piece was written, as a change to it: paragraphs to add, unverified claims it now confirms. */
export type CaseUpdate = { summary: string; add: { after: string | null; text: string; ev: number[] }[]; resolves: string[]; ev: number[]; at: number };
export type Investigation = {
  id: number; title: string; note: string; since: string | null; lang: "de" | "en";
  status: "running" | "ready" | "quiet" | "error" | "dropped"; stage: string | null; steps: AgentStep[];
  place: Place; seen: { summary: string; details: string[] }; photos: CasePhoto[]; evidence: Evidence[];
  questions: CaseQuestion[]; contacts: CaseContact[]; angles: Angle[]; angle: string | null; angle_deadline: number | null;
  verdict: { kind: "story" | "note" | "none"; why: string; first: boolean } | null;
  draft_id: number | null; draft_status: Draft["status"] | null; update: CaseUpdate | null; watch_until: number | null;
  error: string | null; created_at: number; updated_at: number;
};
/** How the writer writes, learned from their pieces; every line can be edited. */
export type Voice = { profile: string; samples: { id: string; title: string; text: string; mine: boolean }[]; length: number; lang: "de" | "en"; learned_at: number | null };
/** The writer's public page and the imprint German law asks of it. */
export type Profile = { name: string; handle: string; bio: string; imprint: string; email: string };
/** What readers sent back from a published piece. */
export type ReaderNote = { id: number; kind: "tip" | "fix"; text: string; contact: string; status: "open" | "done"; created_at: number };
export type PieceStats = { reads: number; finishes: number; shares: number; subscribers: number; days: { day: string; reads: number }[] };

/** Search: a story found by what you typed, with the matched words between \u0002 and \u0003 in its snippet. */
export type SearchHit = Card & { snippet: string };

/** The agent. One request becomes a task (a dossier, a probe, an explanation, a shared link) or a palate proposal. */
export type AgentStep = { label: string; done: boolean };
/** An article a dossier's answer or timeline entry rests on. */
export type Cite = { site: string; url: string };
export type Dossier = {
  summary: string; timeline: { date: string; event: string; src?: Cite[] }[]; people: { name: string; role: string }[];
  questions: { q: string; a: string; src?: Cite[] }[]; related: { id: number; title: string }[]; steer: string[];
  follow_until: number | null; searched_at: number | null; lang: "en" | "de";
  /** the questions the research set out to answer, each with its search */
  plan?: { q: string; search: string }[];
  /** the story "Research this" started from */
  seed?: number;
  /** what flew into Research from that story: its headline, picture and chips, shown as "Started from" */
  from?: StartedFrom;
};
export type StartedFrom = { title: string; image: string | null; chips: { name: string; img: string | null }[] };
/** One topic in the Research folder. */
export type Topic = { id: number; title: string; status: Task["status"]; step: string | null; sources: number; following: boolean; news: number;
  updated_at: number; image: StoryImage | null; from: StartedFrom | null };
export type Task = {
  id: number; kind: "dossier" | "probe" | "explain" | "link"; input: string; title: string;
  status: "running" | "done" | "error" | "dismissed"; steps: AgentStep[]; story_id: number | null; error: string | null;
  created_at: number; updated_at: number;
  /** dossier: Dossier; probe: { label, why, verdict? }; explain: { text, refs }; link: { url } */
  result: any;
  card?: Card | null;
};
export type PalateChange =
  | { type: "weight"; kind: "topic" | "person" | "org" | "place" | "source"; name: string; weight: number; from?: number | null }
  | { type: "rule"; action: "always" | "boost" | "mute" | "never"; kind: "topic" | "person" | "org" | "place" | "source" | "word"; value: string; from?: string | null };
export type Proposal = {
  id: number; origin: "command" | "inference"; said: string; why: string; changes: PalateChange[];
  preview: { in: { id: number; title: string }[]; out: { id: number; title: string }[] };
  status: "open" | "applied" | "dismissed" | "undone"; created_at: number; decided_at: number | null;
};
/** What the agent did with one input; `ask` is the question left over when a link came with one. */
export type AgentReply = { action: "link" | "research" | "palate" | "explain" | "optimize" | "discover" | "unclear"; reply: string; task?: Task; proposal?: Proposal; proposals?: Proposal[]; story_id?: number; ask?: string };
/** A question asked about one story, with Claude's answer: sentences with [n] markers, then `---` and the quoted passages. */
export type Ask = { id: number; q: string; answer: string; created_at: number };
