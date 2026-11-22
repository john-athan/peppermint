// Local stand-in for the Anthropic Messages API, for development and tests without a key.
// Speaks the same JSON and SSE shapes server/llm.ts reads from the real API. Output is clearly marked as stub text.
import { tagLocally } from "../server/tag";

const PORT = Number(process.env.STUB_PORT ?? 4399);
const enc = new TextEncoder();

// The agent's structured answers, told apart by the fields their schema asks for. Plans follow a few keywords.
function agentJSON(props: Record<string, unknown>, user: string): unknown {
  const said = /The reader (?:typed|said|asks): (.+)$/m.exec(user)?.[1] ?? "";
  if ("action" in props) {
    const l = said.toLowerCase();
    const topic = /energy|energie/.test(l) ? "Energy" : /football|fußball/.test(l) ? "Football" : /ai|ki/.test(l) ? "AI" : "Science";
    if (/\b(never|nie)\b/.test(l)) return { action: "palate", reply: `Stub: never ${topic}.`, title: "", searches: [], lang: "en", follow: false, changes: [], rules: [{ action: "never", kind: "topic", value: topic }] };
    if (/\b(more|less|mehr|weniger)\b/.test(l)) return { action: "palate", reply: `Stub: ${/less|weniger/.test(l) ? "less" : "more"} ${topic}.`, title: "", searches: [], lang: "en", follow: false, changes: [{ kind: "topic", name: topic, weight: /less|weniger/.test(l) ? -1 : 2 }], rules: [] };
    if (/why|warum|explain/.test(l)) return { action: "explain", reply: "Stub: here is why.", title: "", searches: [], lang: "en", follow: false, changes: [], rules: [] };
    if (/optimi|check my palate|tune/.test(l)) return { action: "optimize", reply: "Stub: two suggestions.", title: "", searches: [], lang: "en", follow: false, changes: [], rules: [] };
    if (/new|discover|surprise|neues/.test(l)) return { action: "discover", reply: "Stub: trying three new things.", title: "", searches: [], lang: "en", follow: false, changes: [], rules: [] };
    return { action: "research", reply: "Stub: researching.", title: said.replace(/^(what'?s going on with|tell me about|keep me posted on)\s*/i, "").slice(0, 40) || "Stub dossier", searches: [said.slice(0, 60) || "news"], lang: "en", follow: /posted|follow/.test(l), changes: [], rules: [] };
  }
  if ("timeline" in props) return { title: "Stub dossier", summary: "Stub summary: with a Claude key, Sonnet writes where things stand from the articles found.", timeline: [{ date: "3 Nov", event: "Stub event one" }, { date: "12 Nov", event: "Stub event two" }], people: [{ name: "Stub person", role: "stub role" }], questions: [{ q: "What happens next?", a: "Stub answer from the material." }, { q: "How long will it last?", a: "" }] };
  if ("proposals" in props) return { proposals: [{ why: "Stub: you boosted AI but dismissed most AI stories.", changes: [{ kind: "topic", name: "AI", weight: 0.3 }], rules: [] }] };
  if ("probes" in props) return { probes: [{ label: "Materials science", search: "battery materials", lang: "en", why: "Stub: near your interest in hardware." }] };
  if ("refs" in props) return { text: "Stub: you see transport stories because Transport has a weight of 1.5, and Celebrities stay out at -2.", refs: [{ kind: "topic", name: "Transport" }] };
  if ("searches" in props && !("operator" in props)) return { searches: [] };
  // digging into a sentence: no searches, so the stub answers from the story alone
  if ("news" in props && "wiki" in props) return { news: [], wiki: "" };
  return caseJSON(props, user);
}

// Investigations (server/investigate.ts, server/desk.ts): the Lindenplatz example from the design, so a local
// walk through the whole flow reads like the real thing. Evidence ids come from the request ([E12] markers).
function caseJSON(props: Record<string, any>, user: string): unknown {
  const ev = [...user.matchAll(/\[E(\d+)\] ([^·\n]+)/g)].map(m => ({ id: `E${m[1]}`, kind: m[2].trim() }));
  const own = ev.filter(e => e.kind.startsWith("the writer")).map(e => e.id), web = ev.filter(e => !e.kind.startsWith("the writer") && e.kind !== "an answer by email").map(e => e.id);
  const reply = ev.filter(e => e.kind === "an answer by email").map(e => e.id);
  const all = ev.map(e => e.id);
  if ("operator" in props) return { title: "Glänzender Boden, Lindenplatz", place: "U-Bahnhof Lindenplatz", place_detail: "Bahnsteig (U2), Maxvorstadt, München", operator: "MVG (Münchner Verkehrsgesellschaft)",
    searches: ["U-Bahnhof Lindenplatz Boden", "MVG Bodensanierung U-Bahnhof 2026", "Lindenplatz U-Bahn Arbeiten"], wiki: ["U-Bahnhof Lindenplatz"],
    questions: [{ q: "Ist der Boden bei Nässe rutschiger als vorher?", options: ["Ja", "Nein", "Weiß nicht"] }, { q: "Glänzen beide Bahnsteigseiten?", options: ["Beide", "Nur eine"] }],
    contacts: [{ name: "MVG Pressestelle", why: "Betreibt den Bahnhof und die Bauarbeiten", subject: "Frage zum Bahnsteigboden am U-Bahnhof Lindenplatz", question: "Guten Tag,\n\nich schreibe für meine lokale Seite über die Maxvorstadt. Seit dem 19. November glänzt der Boden am Bahnsteig der Lindenplatz, das Sperrengeschoss nicht.\n\n1. Was wurde gemacht, und warum jetzt?\n2. Ist der Boden danach so rutschfest wie vorher?\n3. Folgen andere Bahnhöfe?\n\nVielen Dank!" }] };
  if (props.items?.items?.properties?.same) return { items: [0, 1, 2].map(i => ({ i, relevant: i < 2, same: false, says: i === 0 ? "Die MVG kündigt Pflegearbeiten an Bahnsteigböden mehrerer U-Bahnhöfe an (Stub)." : "Ein älterer Bericht über Rutschgefahr auf polierten Böden (Stub)." })) };
  if ("best" in props) return { kind: /^The writer noticed:.*routine/im.test(user) ? "none" : "story", why: "Niemand hat darüber berichtet, und ob der Boden bei Nässe rutschiger ist, betrifft jeden Tag Tausende (Stub).", first: true, best: 0,
    angles: [{ title: "Glänzend, aber rutschig?", pitch: "Was der neue Glanz für die Sicherheit bedeutet", needs: "Am besten belegt", fit: 0.9, ev: [...own, ...web].slice(0, 4) },
      { title: "45 Jahre stumpf", pitch: "Der Boden des Bahnhofs und woraus er wirklich ist", needs: "Hintergrund aus Wikipedia", fit: 0.7, ev: web.slice(0, 2) },
      { title: "Die Nachtschicht im Untergrund", pitch: "Wer nachts die Böden schleift", needs: "Braucht ein Gespräch", fit: 0.5, ev: own.slice(0, 1) }] };
  if ("headlines" in props) return { headlines: ["Warum der Boden an der Lindenplatz plötzlich glänzt (Stub)", "Glänzend, aber rutschig?", "45 Jahre stumpf, jetzt poliert", "Der neue Glanz im Untergrund"],
    blocks: [
      { type: "p", text: "Seit sechs Jahren steige ich an der Lindenplatz aus. Der Boden am Bahnsteig war immer grau wie ein Novembermorgen. Seit Donnerstag spiegelt er die Neonröhren.", ev: own },
      { type: "p", text: "Nur unten glänzt es. Das Sperrengeschoss oben ist so stumpf wie immer.", ev: own },
      { type: "p", text: "Die MVG hat für November Pflegearbeiten an Bahnsteigböden mehrerer U-Bahnhöfe angekündigt, die Lindenplatz steht auf der Liste.", ev: web.slice(0, 1) },
      { type: "c", text: "Auf Reddit schreiben einige, der Boden sei bei Nässe rutschiger als vorher.", ev: [] },
      ...(reply.length ? [{ type: "p", text: "Die MVG schreibt auf meine Frage, der Granit werde turnusmäßig kristallisiert, die Rutschfestigkeit bleibe gleich.", ev: reply }] : []),
      { type: "p", text: "Was genau gemacht wurde, und ob andere Bahnhöfe folgen, habe ich die MVG gefragt. Bis dahin bleibt die Frage: Wie lange glänzt ein Boden, über den jeden Tag Tausende laufen?", ev: own },
    ], alt: "Polierter grauer Steinboden am Bahnsteig, Neonlicht spiegelt sich", caption: "Bahnsteig Lindenplatz, 20. November", accuses: [] };
  if ("notes" in props && "blocks" in props) {
    const n = [...user.matchAll(/^(\d+)\. \((\w)/gm)].map(m => ({ i: Number(m[1]), t: m[2] }));
    return { blocks: n.map(x => ({ i: x.i, support: x.t === "c" ? "none" : x.i === 2 ? "strong" : "ok", unsupported: [] })), notes: n.length > 2 ? [{ i: 2, note: "Absatz 2 wiederholt den ersten. Kürzen?", fix: "Nur unten glänzt es, oben nicht." }] : [] };
  }
  if ("answer" in props && "notes" in props) return { answer: "Der Einstieg trägt. Der Schluss könnte konkreter fragen (Stub).", notes: [{ i: 1, note: "Erster Satz länger als nötig", fix: "Seit sechs Jahren steige ich hier aus. Der Boden war immer grau. Seit Donnerstag spiegelt er die Neonröhren." }] };
  if ("worth" in props) return { worth: true, summary: "Die MVG hat geantwortet: turnusmäßige Kristallisation, Rutschfestigkeit unverändert (Stub).", add: [{ after: 2, text: "Auf meine Frage antwortet die MVG: Der Granit werde turnusmäßig kristallisiert, das mache die Oberfläche dichter, an der Rutschfestigkeit ändere sich nichts.", ev: reply.length ? reply : all.slice(-1) }], resolves: [] };
  if ("profile" in props && "lang" in props) return { profile: "Beginnt mit einer Szene, die ich selbst gesehen habe.\nKurze Sätze, erste Person.\nEin trockener Witz pro Text, nie in der Überschrift.\nZahlen nur, wenn sie zählen.\nEndet mit einer offenen Frage.", lang: "de" };
  if (props.blocks?.items?.properties?.from) { const n = [...user.matchAll(/^(\d+)\. \((\w)[^)]*\) (.+)$/gm)]; return { blocks: n.map(m => ({ type: m[2], text: m[2] === "p" ? m[3].split(/(?<=[.!?])\s/)[0] : m[3], from: [Number(m[1])] })) }; }
  if (Object.keys(props).join() === "text") {
    if (user.includes("[new sentences go here]")) return { text: `Laut ${/Source \([^,]+, ([^)]+)\)/.exec(user)?.[1] ?? "der Quelle"} wurde der Bahnhof 1980 eröffnet; der Boden ist seitdem derselbe (Stub).` };
    if (!user.includes("\n") && user.length < 600) return { text: "Ob der Boden bei Nässe rutschiger ist, ist offen: einige auf Reddit sagen es, bestätigt ist es nicht (Stub)." };
    return { text: "Stub: so klänge der Absatz in deiner Stimme." };
  }
  return null;
}
function seeJSON() {
  return JSON.stringify({ summary: "Ein frisch polierter, glänzender Steinboden am U-Bahnsteig (Stub)", details: ["Grauer Granit, stark spiegelnd", "Neonröhren spiegeln sich im Boden", "Sperrengeschoss oben nicht poliert"], signs: ["Lindenplatz"], place_hint: "U-Bahnhof Lindenplatz", people: 1, faces: [{ photo: 1, x: 0.62, y: 0.28, w: 0.06, h: 0.09 }], plates: [] });
}

function lensText(user: string) {
  if (user.startsWith("The reporter's note:")) return seeJSON();
  if (user.includes("Answer the reader's question")) {
    const quote = (user.split("Text:\n")[1] ?? "").split(/(?<=[.!?])\s+/).find(s => s.split(" ").length >= 5)?.split(" ").slice(0, 8).join(" ") ?? "";
    return quote ? `Stub answer: the text says so.[1] A real answer appears with a Claude key.\n---\n[1] "${quote}" (stub)` : "Stub: the material does not answer that.";
  }
  if (user.includes("The sentence: ")) {
    const quote = (user.split("Text:\n")[1] ?? "").split(/(?<=[.!?])\s+/).find(s => s.split(" ").length >= 5)?.split(" ").slice(0, 8).join(" ") ?? "";
    const verdict = user.startsWith("Check whether") ? "@partly\n" : "";
    return `${verdict}Stub: the story says so, and a real answer weighs other reports too.[1] It appears with a Claude key.\n---\n[1] "${quote}" (stub)`;
  }
  // Listen: the episode script with its part markers, one part per story in the request
  const stories = [...user.matchAll(/<story id="(\d+)">\nTitle: (.+)/g)];
  if (stories.length) return ["@intro\nStub episode. Real scripts need a Claude key.", ...stories.map(m => `@story ${m[1]}\n${m[2]}. This is stub narration for the story.`), "@outro\nThat was the stub edition."].join("\n\n");
  const facts = [...user.matchAll(/^- \((\w+)\) (.+)$/gm)].map(m => [m[1], m[2]]);
  const title = /Title: (.+)/.exec(user)?.[1] ?? "This story";
  const de = /Language: German/.test(user);
  if (user.includes("Summarize what people say")) return de ? "Stub: die meisten Kommentare stimmen zu.\nStub: ein Kommentar widerspricht." : "Stub: most commenters agree with the article.\nStub: one commenter pushes back.";
  // the TL;DR ends with a sentence on the discussion when comments came with the request
  const talk = user.includes("Public comments about this story") ? (de ? " Stub: die Diskussion ergänzt eine Sicht." : " Stub: the discussion adds a view.") : "";
  if (user.includes("Write a TL;DR")) return de ? `${title}. (Stub: so sieht ein TL;DR aus, wenn der Server einen Claude-Key hat.)${talk}` : `${title}. ${facts[0]?.[1] ?? ""} (Stub TL;DR: a real one appears once the server has a Claude key.)${talk}`;
  if (user.includes("storyboard")) {
    // one scene of every visual kind, using a figure and a portrait when the material offers them
    const fig = /\n\[1\] /.test(user), person = /Portraits: ([^(;\n]+)/.exec(user)?.[1]?.trim();
    return [
      `385 times less compute | Stub: the big number counts up. | {"stat": "385×", "label": "less compute than the baseline"}`,
      `Accuracy on hard puzzles | Stub: a chart builds. | {"chart": {"title": "Sudoku-Extreme accuracy", "unit": "%", "data": {"EBR": 99.4, "Looped model": 87.1, "Baseline": 54.6}, "highlight": "EBR"}}`,
      fig ? `The energy landscape | Stub: the article's own figure. | {"figure": 1}` : `The story's photo | Stub: the photo. | {"picture": true}`,
      `In their words | Stub: a quote, large. | {"quote": "Small gradient means stop.", "by": "${person ?? "The authors"}"}`,
      person && person !== "none" ? `Who this is about | Stub: a portrait. | {"person": "${person}"}` : `Back to the photo | Stub: the photo again. | {"picture": true}`,
      `Easy stops early | Stub: values side by side. | {"compare": [["Easy puzzle", "3 steps"], ["Medium", "8 steps"], ["Hard puzzle", "13 steps"]]}`,
      `Read on in peppermint | Stub: the closing scene. | {"picture": true}`,
    ].join("\n");
  }
  if (user.includes("spoken script")) return `${title}. This is a stub audio script. A real one appears once the server has Claude. It is read sentence by sentence.`;
  if (user.includes("Write a brief")) return `${title}. ${facts[0]?.[1] ?? ""} (Stub brief: Claude writes this in your language and style.)`;
  // charts: Studio's "Chart from my numbers", and a hero chart in retellings and in briefs of stories with numbers
  const STUB_CHART = '{"title": "Minutes per bug fix", "unit": "min", "data": {"Gemini 4 Carbon": 22.35, "Opus 5.5": 9.55, "Astra": 8.1}, "highlight": "Gemini 4 Carbon", "hero": true, "source": "stub"}';
  if (user.includes("Write exactly one chart")) return STUB_CHART;
  if (user.includes("Retell the whole article")) return (de ? "Stub-Nacherzählung in deinem Stil.\n\n```chart\n" : "Stub retelling in your style.\n\n```chart\n") + STUB_CHART + "\n```\n\n" + (user.split("Text:\n")[1] ?? "").slice(0, 600);
  if (user.includes("Write a brief") && /\d{2}/.test(title)) return `${title}. (Stub brief with a chart.)\n\n\`\`\`chart\n${STUB_CHART}\n\`\`\``;
  if (user.includes("Retell the whole article")) return (de ? "Stub-Nacherzählung in deinem Stil:\n\n" : "Stub retelling in your style:\n\n") + (user.split("Text:\n")[1] ?? "").slice(0, 600);
  if (user.includes("Translate")) return (de ? "Stub-Übersetzung:\n\n" : "Stub translation:\n\n") + (user.split("Text:\n")[1] ?? "").slice(0, 600);
  return `${title}. ${facts.slice(0, 2).map(f => f[1]).join(" ")}\n\n${de ? "Hintergrund: Dies ist Stub-Text. Mit einem Claude-Key schreibt Sonnet hier die Erklärung." : "Background: this is stub text. With a Claude key, Sonnet writes the explainer here."}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || !url.pathname.endsWith("/v1/messages")) return new Response("not found", { status: 404 });
    const body = await req.json() as any;
    const user = typeof body.messages[0].content === "string" ? body.messages[0].content : body.messages[0].content.map((c: any) => c.text).join("");
    const id = "msg_stub_" + Math.random().toString(36).slice(2);
    if (!body.stream) {
      const agent = agentJSON(body.output_config?.format?.schema?.properties ?? {}, user);
      if (agent) return Response.json({ id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(agent) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 80 } });
      const title = /Title: (.+)/.exec(user)?.[1] ?? "";
      const rest = user.split(/Title: .+\n/)[1] ?? "";
      const t = tagLocally({ title, body: rest });
      const out = { lang: t.lang, title_en: t.lang === "en" ? title : `[EN stub] ${title}`, summary_en: t.summary_en || title, topics: t.topics.length ? t.topics : ["Business"], people: t.people, orgs: [], places: t.places, atoms: t.atoms.length ? t.atoms.slice(0, 5) : [{ kind: "what", text: title }], opinion: false };
      return Response.json({ id, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 80 } });
    }
    const text = lensText(user);
    const chunks = text.match(/\s*\S+/g) ?? [];
    const stream = new ReadableStream({
      async start(c) {
        const ev = (type: string, data: any) => c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`));
        ev("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
        ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
        for (const ch of chunks) { ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: ch } }); await Bun.sleep(12); }
        ev("content_block_stop", { index: 0 });
        ev("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: chunks.length } });
        ev("message_stop", {});
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(`anthropic stub on http://localhost:${PORT}`);
