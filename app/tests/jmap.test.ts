import { test, expect } from "bun:test";
import { jmapConfigured, mailTo, replyAddress, repliesSince, plainReply } from "../server/jmap";

const setEnv = () => {
  process.env.PEPPERMINT_JMAP_URL = "https://mail.example.org/.well-known/jmap";
  process.env.PEPPERMINT_JMAP_USER = "peppermint@example.org";
  process.env.PEPPERMINT_JMAP_PASSWORD = "secret";
  process.env.PEPPERMINT_REPLY_ADDRESS = "peppermint@example.org";
};

test("replyAddress formats and rejects bad tokens", () => {
  setEnv();
  expect(jmapConfigured()).toBe(true);
  expect(replyAddress("case-48-k3j9x2")).toBe("peppermint+case-48-k3j9x2@example.org");
  expect(() => replyAddress("Bad Token")).toThrow();
  expect(() => replyAddress("abc")).toThrow();
  delete process.env.PEPPERMINT_REPLY_ADDRESS;
  expect(replyAddress("case-48-k3j9x2")).toBeNull();
  setEnv();
});

test("plainReply cuts history and signatures", () => {
  expect(plainReply("Yes, Tuesday.\n\nOn Fri, Nov 20, 2026 at 10:00 AM X <x@y> wrote:\n> old\n> older")).toBe("Yes, Tuesday.");
  expect(plainReply("Yes.\n\nOn Fri, Nov 20, 2026 at 10:00 AM Some Long Name\n<x@y> wrote:\n> old")).toBe("Yes.");
  expect(plainReply("Ja.\n\nAm 20.11.2026 um 10:00 schrieb peppermint:\n> alt")).toBe("Ja.");
  expect(plainReply("Fine.\n\n-----Original Message-----\nFrom: a\nSent: b\nold")).toBe("Fine.");
  expect(plainReply("Gut.\n\nVon: A <a@b>\nGesendet: Freitag\nAn: C\nBetreff: Hi\n\nalt")).toBe("Gut.");
  expect(plainReply("Thanks\n-- \nJane\nCEO")).toBe("Thanks");
  expect(plainReply("a\n> quoted\nb\n\n\n\n\nc")).toBe("a\nb\n\nc");
  expect(plainReply("x".repeat(7000)).length).toBe(6000);
});

test("repliesSince reads replies by plus address", async () => {
  setEnv();
  const calls: { url: string; init?: RequestInit }[] = [];
  const email = (id: string, to: any[], cc: any[], subject: string, text: string) => ({
    id, messageId: [`${id}@mx`], from: [{ name: "Anna", email: "anna@example.com" }], to, cc, subject,
    receivedAt: "2026-11-21T09:00:00Z", textBody: [{ partId: "1" }], bodyValues: { "1": { value: text } },
  });
  const fake = (async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/.well-known/jmap")) {
      return Response.json({ apiUrl: "https://mail.example.org/jmap", primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" } });
    }
    return Response.json({ methodResponses: [["Email/query", { ids: ["e1", "e2", "e3"] }, "q"], ["Email/get", { list: [
      email("e1", [{ email: "Peppermint+case-48-ab12cd@example.org" }], [], "Re: Question", "Yes, Tuesday works.\n\nAm 20.11.2026 um 10:00 schrieb peppermint:\n> old"),
      email("e2", [{ email: "bob@example.com" }], [{ email: "peppermint+case-7-zz99@example.org" }], "Re: Other", "Hello"),
      email("e3", [{ email: "peppermint@example.org" }], [], "No plus", "Hi"),
    ] }, "g"]] });
  }) as unknown as typeof fetch;

  const since = Date.parse("2026-11-20T00:00:00Z");
  const r = await repliesSince(since, fake);
  expect(r.map((x) => x.token)).toEqual(["case-48-ab12cd", "case-7-zz99"]);
  expect(r[0]).toMatchObject({ from: "anna@example.com", fromName: "Anna", subject: "Re: Question", text: "Yes, Tuesday works.", messageId: "e1@mx", receivedAt: Date.parse("2026-11-21T09:00:00Z") });
  expect(r[1].text).toBe("Hello");

  const basic = "Basic " + Buffer.from("peppermint@example.org:secret").toString("base64");
  const api = calls.find((c) => c.url === "https://mail.example.org/jmap")!;
  expect((api.init!.headers as any).authorization).toBe(basic);
  const body = JSON.parse(String(api.init!.body));
  // only investigation replies are asked for: a newsletter in the same mailbox never fills this window
  expect(body.methodCalls[0][1].filter).toEqual({ after: "2026-11-20T00:00:00.000Z", to: "peppermint+case-" });
  expect(body.using).toContain("urn:ietf:params:jmap:mail");
  expect((calls[0].init!.headers as any).authorization).toBe(basic);
});

test("repliesSince explains a refused login", async () => {
  setEnv();
  // a different URL so the cached session of the test above is not used
  process.env.PEPPERMINT_JMAP_URL = "https://other.example/.well-known/jmap";
  const fake = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  await expect(repliesSince(0, fake)).rejects.toThrow("Mail server refused the login (401).");
  setEnv();
});

test("mailTo reads one newsletter address: its HTML, sender and unsubscribe header, nothing sent elsewhere", async () => {
  setEnv();
  let filter: any = null;
  const fake = (async (url: any, init?: RequestInit) => {
    if (String(url).endsWith("/.well-known/jmap")) return Response.json({ apiUrl: "https://mail.example.org/jmap", primaryAccounts: { "urn:ietf:params:jmap:mail": "a1" } });
    filter = JSON.parse(String(init!.body)).methodCalls[0][1].filter;
    const m = (id: string, to: string, html: boolean) => ({
      id, messageId: [`${id}@mx`], from: [{ name: "ECHA", email: "news@echa.europa.eu" }], to: [{ email: to }], subject: "ECHA Weekly", receivedAt: "2026-11-21T09:00:00Z",
      textBody: [{ partId: "t", type: "text/plain" }], htmlBody: html ? [{ partId: "h", type: "text/html" }] : [{ partId: "t", type: "text/plain" }],
      bodyValues: { t: { value: "plain" }, h: { value: "<p>rich</p>" } }, "header:List-Unsubscribe:asURLs": ["mailto:u@x.example", "https://x.example/u"],
    });
    return Response.json({ methodResponses: [["Email/query", { ids: [] }, "q"], ["Email/get", { list: [
      m("n1", "peppermint+nl-7f3k9q2m@example.org", true), m("n2", "peppermint+nl-7f3k9q2m@example.org", false), m("n3", "peppermint+nl-other123@example.org", true),
    ] }, "g"]] });
  }) as unknown as typeof fetch;
  const r = await mailTo("nl-7f3k9q2m", 0, fake);
  expect(filter.to).toBe("peppermint+nl-7f3k9q2m");
  expect(r.map(x => [x.messageId, x.html, x.text])).toEqual([["n1@mx", "<p>rich</p>", "plain"], ["n2@mx", null, "plain"]]);
  expect(r[0]).toMatchObject({ fromName: "ECHA", from: "news@echa.europa.eu", listUnsubscribe: "https://x.example/u" });
});
