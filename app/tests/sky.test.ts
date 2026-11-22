import { test, expect } from "bun:test";
import { sunTimes, moonAge, wxFromCode, skyState, skySvg } from "../shared/sky.mjs";
import { iconSvg, mark } from "../shared/logo.mjs";

const hm = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

test("sun times for Munich match the almanac within a few minutes", () => {
  const june = sunTimes(Date.UTC(2026, 5, 21, 12))!, dec = sunTimes(Date.UTC(2026, 11, 21, 12))!;
  expect(hm(june.rise)).toMatch(/^05:1\d$/); // 05:12
  expect(hm(june.set)).toMatch(/^21:1\d$/); // 21:17
  expect(hm(dec.rise)).toMatch(/^0(7:5\d|8:0\d)$/); // 08:01
  expect(hm(dec.set)).toMatch(/^16:2\d$/); // 16:22
});

test("the moon's age follows real full and new moons", () => {
  expect(Math.abs(moonAge(Date.UTC(2026, 0, 3, 10, 3)) - 0.5)).toBeLessThan(0.02); // full moon
  const nm = moonAge(Date.UTC(2026, 1, 17, 12, 1)); // new moon
  expect(Math.min(nm, 1 - nm)).toBeLessThan(0.02);
});

test("weather codes map to what the mark draws", () => {
  expect([0, 2, 3, 45, 53, 63, 81, 73, 86, 95, null].map(wxFromCode)).toEqual(["clear", "partly", "cloudy", "fog", "drizzle", "rain", "rain", "snow", "snow", "storm", "clear"]);
});

test("time of day: night, dawn, day, dusk", () => {
  const at = (h: number, m = 0) => skyState(Date.UTC(2026, 5, 21, h, m)).tod; // UTC; sunrise 03:12, sunset 19:17
  expect([at(1), at(3, 15), at(12), at(19, 20), at(21)]).toEqual(["night", "dawn", "day", "dusk", "night"]);
});

test("every sky is balanced markup with colours from tokens only", () => {
  for (const tod of ["dawn", "day", "dusk", "night"]) for (const wx of ["clear", "partly", "cloudy", "fog", "drizzle", "rain", "snow", "storm"]) for (const moon of [0, 0.1, 0.3, 0.5, 0.7, 0.9]) {
    const { back, front } = skySvg({ tod, wx, moon });
    for (const s of [back, front]) {
      const open = (s.match(/<g[\s>]/g) ?? []).length, close = (s.match(/<\/g>/g) ?? []).length;
      expect(open).toBe(close);
      expect(s).not.toMatch(/#[0-9a-f]{3,6}\b|NaN|undefined/i);
    }
  }
});

test("the icon has no sky, grooves or glare; the mark has empty slots for them", () => {
  expect(mark()).toContain('<g class="pm-sky"></g>');
  expect(mark()).toContain('<g class="pm-front"></g>');
  expect(iconSvg()).not.toMatch(/pm-(sky|front|grooves|sheen)/);
});
