// A news headline that announces a podcast episode names the show in quotes; peppermint looks up the episode itself.
process.env.PEPPERMINT_DB = ":memory:";
import { test, expect } from "bun:test";
const { podcastName, itemGrade } = await import("../server/material");

test("the show's name comes from the quotes in a podcast headline, and only from podcast headlines", () => {
  expect(podcastName("SZ-Podcast „Hey München“: KI statt Kassierer: Ist das die Zukunft in Supermärkten?")).toBe("Hey München");
  expect(podcastName('Podcast "Das Politikteil": Wer regiert jetzt?')).toBe("Das Politikteil");
  expect(podcastName("Stadtrat beschließt „Plastik-Eis“ im Prinzregentenstadion")).toBe(null);
  expect(podcastName("Neue Podcastfolge ohne Namen")).toBe(null);
});

test("a teaser with the episode's audio counts as something to read and listen to, not as unreadable", () => {
  const teaser = { title: "SZ-Podcast „Hey München“: KI statt Kassierer", summary: "Zudem geht es um die Eisfläche.", body: null, kind: "feed" };
  expect(itemGrade({ ...teaser, meta: {} })).not.toBe("partial");
  expect(itemGrade({ ...teaser, meta: { audio: "https://audio.example/ep40.mp3" } })).toBe("partial");
});
