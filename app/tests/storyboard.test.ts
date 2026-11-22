// The story video's script: scenes with a visual each, the fallbacks for anything malformed, counting numbers in both
// notations, and the article figures extraction keeps for the video.
import { test, expect } from "bun:test";
import { parseScene, scenesOf, visualOf, countable } from "../shared/storyboard";
import { extract } from "../server/connectors/util";

test("a scene line carries caption, narration and one visual of each kind", () => {
  expect(parseScene("385 times less | It needs far less compute. | {\"stat\": \"385×\", \"label\": \"less compute\"}")).toEqual({ caption: "385 times less", line: "It needs far less compute.", visual: { kind: "stat", value: "385×", label: "less compute" } });
  expect(visualOf('{"figure": 2}')).toEqual({ kind: "figure", n: 2 });
  expect(visualOf('{"quote": "Small gradient means stop.", "by": "The authors"}')).toEqual({ kind: "quote", text: "Small gradient means stop.", by: "The authors" });
  expect(visualOf('{"person": "Markus Söder"}')).toEqual({ kind: "person", name: "Markus Söder" });
  expect(visualOf('{"compare": [["Easy", "3 steps"], ["Hard", "13 steps"]]}')).toEqual({ kind: "compare", items: [{ label: "Easy", value: "3 steps" }, { label: "Hard", value: "13 steps" }] });
  expect(visualOf('{"chart": {"data": {"A": 1, "B": 2}}}').kind).toBe("chart");
});

test("anything malformed or unknown falls back to the story's photo; a line without a visual is still a scene", () => {
  expect(visualOf("{nope")).toEqual({ kind: "picture" });
  expect(visualOf('{"chart": {"data": {}}}')).toEqual({ kind: "picture" });
  expect(visualOf('{"figure": 0}')).toEqual({ kind: "picture" });
  expect(visualOf('{"compare": [["Only one", "1"]]}')).toEqual({ kind: "picture" });
  expect(parseScene("Old style | Just a narration.")).toEqual({ caption: "Old style", line: "Just a narration.", visual: { kind: "picture" } });
  expect(parseScene("no separator here")).toBeNull();
});

test("while the script streams, a line counts once its newline has arrived", () => {
  expect(scenesOf("A | one | {\"picture\": true}\nB | tw", true).length).toBe(1);
  expect(scenesOf("A | one | {\"picture\": true}\nB | two", false).length).toBe(2);
});

test("numbers count up in the notation they were written in", () => {
  expect(countable("385×")).toMatchObject({ pre: "", n: 385, num: "385", post: "×", decimals: 0 });
  expect(countable("€4,2 Mrd.")).toMatchObject({ pre: "€", n: 4.2, post: " Mrd.", decimals: 1, comma: true });
  expect(countable("1,234.5 km")).toMatchObject({ n: 1234.5, decimals: 1, comma: false });
  expect(countable("12.345 Fahrgäste")).toMatchObject({ n: 12345, decimals: 0 });
  expect(countable("no number")).toBeNull();
});

test("extraction keeps the article's figures with captions, skips logos, icons and small pictures", async () => {
  const html = `<article><figure><img src="/a.png" alt="alt text" width="1200"><figcaption>Figure 1: the energy landscape</figcaption></figure>
    <p>${"Text. ".repeat(80)}</p><figure><img srcset="/b-400.png 400w, /b-1600.png 1600w" alt="Accuracy versus compute per puzzle"></figure>
    <figure><img src="/logo.png" alt="Company logo"></figure><img src="/inline.jpg" alt="A photo of the lab with the robot arm" width="900">
    <img src="/tiny.png" alt="A small thing that is too small" width="40"></article>`;
  const r = await extract(html, { base: "https://x.example/post/" });
  expect(r.figures).toEqual([
    { src: "https://x.example/a.png", caption: "Figure 1: the energy landscape" },
    { src: "https://x.example/b-1600.png", caption: "Accuracy versus compute per puzzle" },
    { src: "https://x.example/inline.jpg", caption: "A photo of the lab with the robot arm" },
  ]);
  expect(r.text).not.toContain("energy landscape");
});
