// The sky behind the mark: the time of day and the weather at home, drawn into the disc around the sprig.
// Pure functions: skyState() reads the clock (sun times and the moon's age are computed here, so it works offline),
// skySvg() draws the state into two layers, one behind the sprig and one in front of it (fog, snow on the ground).
// All coordinates are the mark's own viewBox (-150..150); colours are CSS variables from app.css.

/** Home for the sky: the reader lives in Munich. */
export const HOME = { lat: 48.137, lng: 11.575 };

const f = n => +n.toFixed(1);
const RAD = Math.PI / 180;

/** Sunrise and sunset (epoch ms) for the day of `t` at lat/lng, NOAA's simplified equations; null in polar day or night. */
export function sunTimes(t, lat = HOME.lat, lng = HOME.lng) {
  const day = Math.floor(t / 864e5), n = day - 10957 + 0.0008; // days since 2000-01-01 12:00 UTC
  const J = n - lng / 360, M = (357.5291 + 0.98560028 * J) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const L = (M + C + 180 + 102.9372) % 360;
  const noon = 2451545 + J + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * L * RAD);
  const dec = Math.asin(Math.sin(L * RAD) * Math.sin(23.44 * RAD));
  const cosH = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(dec)) / (Math.cos(lat * RAD) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return null;
  const H = Math.acos(cosH) / RAD / 360, ms = jd => (jd - 2440587.5) * 864e5;
  return { rise: ms(noon - H), set: ms(noon + H) };
}

/** The moon's age as a share of the synodic month: 0 new, .25 first quarter, .5 full, .75 last quarter. */
export function moonAge(t) {
  const age = ((t - Date.UTC(2000, 0, 6, 18, 14)) / 864e5) / 29.530588853;
  return age - Math.floor(age);
}

/** WMO weather code (Open-Meteo) to what the mark draws. */
export function wxFromCode(code) {
  if (code == null || !Number.isFinite(code)) return "clear";
  if (code <= 1) return "clear";
  if (code === 2) return "partly";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 95) return "storm";
  return "clear";
}

/** What the sky shows at `t`: dawn and dusk are the 40 minutes either side of sunrise and sunset. */
export function skyState(t, weatherCode = null) {
  const s = sunTimes(t), win = 40 * 6e4;
  let tod;
  if (!s) tod = new Date(t).getUTCMonth() >= 3 && new Date(t).getUTCMonth() <= 8 ? "day" : "night";
  else if (Math.abs(t - s.rise) <= win) tod = "dawn";
  else if (Math.abs(t - s.set) <= win) tod = "dusk";
  else tod = t > s.rise && t < s.set ? "day" : "night";
  // the moon is drawn at a resolution of a sixtieth of its month (about twelve hours), so the markup stays stable
  return { tod, wx: wxFromCode(weatherCode), moon: Math.round(moonAge(t) * 60) / 60 };
}

/* ---------- pieces ---------- */

const ANCHOR = [64, -70];

function sun([x, y], low) {
  const c = low ? "var(--sun-low)" : "var(--sun)";
  let s = `<g class="pm-sun" transform="translate(${x} ${y})">`;
  s += `<circle class="pm-fine" r="44" fill="${c}" opacity=".1"/><circle r="34" fill="${c}" opacity=".18"/>`;
  s += `<g class="pm-rays" fill="${c}">`;
  for (let i = 0; i < 12; i++) {
    const a = i * 30 * RAD, r1 = 27, r2 = i % 2 ? 34 : 40, w = 6.5 * RAD;
    const p = (r, d) => `${f(Math.cos(a + d) * r)},${f(Math.sin(a + d) * r)}`;
    s += `<polygon points="${p(r1, -w)} ${p(r2, 0)} ${p(r1, w)}"/>`;
  }
  s += `</g><circle r="22" fill="${c}" stroke="var(--sun-edge)" stroke-width="1.4"/>`;
  s += `<circle cx="-5" cy="-5.5" r="12" fill="var(--sun-core)" opacity=".75"/><circle class="pm-fine" cx="-8.5" cy="-9.5" r="3.8" fill="var(--sun-core)"/>`;
  // a low sun sits behind bands of haze
  if (low) s += `<g stroke="var(--disc)" stroke-linecap="round"><path d="M-28 7 H24" stroke-width="3.4"/><path d="M-21 14.5 H30" stroke-width="2.8"/><path class="pm-fine" d="M-14 21 H16" stroke-width="2"/></g>`;
  return s + `</g>`;
}

function moon([x, y], age) {
  const r = 22, phi = age * 2 * Math.PI, k = (1 - Math.cos(phi)) / 2, rx = f(r * Math.abs(Math.cos(phi)));
  let s = `<g class="pm-moon" transform="translate(${x} ${y}) rotate(-24)">`;
  s += `<circle class="pm-fine" r="36" fill="var(--moon)" opacity=".1"/><circle r="${r + 5}" fill="var(--moon)" opacity=".12"/>`;
  // earthshine: the dark part of the moon stays faintly visible
  s += `<circle r="${r}" fill="var(--moon-shade)" opacity=".55"/>`;
  if (k > 0.985) s += `<circle r="${r}" fill="var(--moon)"/>`;
  else if (k > 0.015) {
    const waxing = age < 0.5;
    const limb = waxing ? 1 : 0, term = waxing ? (age < 0.25 ? 0 : 1) : (age > 0.75 ? 1 : 0);
    s += `<path d="M0 ${-r} A${r} ${r} 0 0 ${limb} 0 ${r} A${rx} ${r} 0 0 ${term} 0 ${-r}Z" fill="var(--moon)"/>`;
  }
  // maria and craters, faint over the whole face, as on the real moon
  s += `<g fill="var(--moon-shade)"><ellipse cx="-6" cy="-6" rx="7.4" ry="5.6" opacity=".32"/><ellipse cx="5" cy="7" rx="5.4" ry="4.2" opacity=".28"/>`;
  s += `<g class="pm-fine"><circle cx="10" cy="-8" r="2.6" opacity=".3"/><circle cx="-10" cy="10" r="2" opacity=".3"/><circle cx="14" cy="5" r="1.4" opacity=".35"/><circle cx="-1" cy="16" r="1.6" opacity=".3"/></g></g>`;
  s += `<circle r="${r}" fill="none" stroke="var(--moon-shade)" stroke-width=".8" opacity=".6"/>`;
  return s + `</g>`;
}

// four-point sparkles and pin-point stars, in the open sky left of the sprig
const STARS = [[-88, -72, 7], [-54, -102, 5.2], [-112, -26, 4.4], [-26, -118, 3.6], [24, -114, 4.2], [-80, -36, 3.4]];
const DOTS = [[-76, -98], [-104, -54], [-44, -82], [-120, 4], [6, -124], [104, -22]];
function stars(n = STARS.length) {
  let s = `<g class="pm-stars" fill="var(--star)">`;
  STARS.slice(0, n).forEach(([x, y, r], i) => {
    s += `<path class="pm-star" style="--s:${i}" d="M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r}Z"/>`;
  });
  s += `<g class="pm-fine">${DOTS.slice(0, n).map(([x, y], i) => `<circle class="pm-star" style="--s:${i + 3}" cx="${x}" cy="${y}" r="1.7"/>`).join("")}</g>`;
  return s + `</g>`;
}

// a cumulus: flat base, three rising lobes, a shaded underside and a lit crown
function cloud([x, y], scale = 1, dark = false, i = 0) {
  const fill = dark ? "var(--cloud-dark)" : "var(--cloud)";
  let s = `<g class="pm-cloud" style="--c:${i}" transform="translate(${x} ${y}) scale(${scale})">`;
  s += `<path d="M-30 12 H27 A11 11 0 0 0 30 -9 A14 14 0 0 0 8 -17 A18 18 0 0 0 -23 -10 A11.5 11.5 0 0 0 -30 12Z" fill="${fill}" stroke="var(--cloud-edge)" stroke-width="1.6" stroke-linejoin="round"/>`;
  s += `<path d="M-27 9 H25 A9 9 0 0 1 22 12 H-24 A6 6 0 0 1 -27 9Z" fill="var(--cloud-edge)" opacity=".28"/>`;
  s += `<path class="pm-fine" d="M-14 -10 A14 14 0 0 1 4 -14" fill="none" stroke="var(--cloud-lit)" stroke-width="2.4" stroke-linecap="round"/>`;
  s += `<path class="pm-fine" d="M12 -12 A9 9 0 0 1 24 -7" fill="none" stroke="var(--cloud-lit)" stroke-width="1.8" stroke-linecap="round"/>`;
  return s + `</g>`;
}

const drop = (x, y, i, sz = 1) => `<path class="pm-rain" style="--d:${i}" d="M${x} ${f(y - 4.6 * sz)} C${f(x + 2 * sz)} ${f(y - 1 * sz)} ${f(x + 2.7 * sz)} ${f(y + 1.5 * sz)} ${x} ${f(y + 3.3 * sz)} C${f(x - 2.7 * sz)} ${f(y + 1.5 * sz)} ${f(x - 2 * sz)} ${f(y - 1 * sz)} ${x} ${f(y - 4.6 * sz)}Z"/>`;
function rain(n, sz) {
  const at = [[40, -30], [58, -24], [76, -32], [94, -26], [48, -8], [66, -4], [84, -12], [100, -6], [32, -12]];
  return `<g fill="var(--rain)" transform="rotate(12 66 -20)">${at.slice(0, n).map(([x, y], i) => drop(x, y, i, sz)).join("")}</g>`;
}

// a six-armed dendrite: each arm carries two pairs of side branches
function flake(x, y, size, i) {
  let d = "";
  for (let a = 0; a < 6; a++) {
    const t = a * 60 * RAD + 15 * RAD, ex = Math.cos(t), ey = Math.sin(t);
    d += `M${x} ${y} L${f(x + ex * size)} ${f(y + ey * size)}`;
    for (const [at, len] of [[0.45, 0.34], [0.72, 0.22]]) {
      const bx = x + ex * size * at, by = y + ey * size * at;
      for (const s of [1, -1]) { const u = t + s * 50 * RAD; d += `M${f(bx)} ${f(by)} l${f(Math.cos(u) * size * len)} ${f(Math.sin(u) * size * len)}`; }
    }
  }
  return `<path class="pm-flake" style="--d:${i}" d="${d}" fill="none" stroke="var(--snow)" stroke-width="1.7" stroke-linecap="round"/>`;
}
function snow() {
  const at = [[42, -26, 9], [72, -20, 7], [100, -34, 6], [56, 0, 6.4], [92, 2, 8], [-94, -44, 8], [-66, -88, 6.4], [-112, 0, 6], [-40, -112, 5.4]];
  return `<g>${at.map(([x, y, s], i) => flake(x, y, s, i)).join("")}</g>`;
}

// the glow of a low sun along the bottom of the disc: three caps of the disc, stacked
function glow() {
  return `<g fill="var(--sun-low)">${[10, 34, 56, 76, 94, 110].map(y => { const x = f(Math.sqrt(136 * 136 - y * y)); return `<path d="M${-x} ${y} A136 136 0 0 0 ${x} ${y}Z" opacity=".055"/>`; }).join("")}</g>`;
}

/* ---------- the two layers ---------- */

/** Markup for a sky state: `back` goes behind the sprig, `front` over it. */
export function skySvg({ tod, wx, moon: age }) {
  const night = tod === "night", low = tod === "dawn" || tod === "dusk";
  let back = "", front = "";
  if (night) back += `<circle r="138" fill="var(--night)" opacity=".34"/>`;
  if (low) back += glow();
  const body = night ? moon(ANCHOR, age) : sun(ANCHOR, low);
  const clearish = wx === "clear" || wx === "partly" || wx === "fog";
  if (night && clearish) back += stars(wx === "clear" ? 6 : 3);
  if (clearish) back += wx === "fog" ? `<g opacity=".45">${body}</g>` : body;
  if (wx === "partly") back += cloud([50, -50], 1.1);
  if (wx === "cloudy" || wx === "rain" || wx === "snow" || wx === "drizzle" || wx === "storm") {
    const dark = wx === "storm";
    if (wx !== "drizzle") back += cloud([74, -84], 0.7, dark, 1);
    back += cloud([60, -56], 1.3, dark);
  }
  if (wx === "drizzle") back += rain(5, 0.95);
  if (wx === "rain") back += rain(9, 1.4);
  if (wx === "storm") back += `<polygon class="pm-bolt" points="64,-44 49,-16 60,-16 51,12 77,-24 66,-24 75,-44" fill="var(--bolt)" stroke="var(--sun-edge)" stroke-width="1" stroke-linejoin="round"/>` + rain(7, 1.3);
  if (wx === "snow") back += snow();
  // rain rings on the ground, a drift of snow over the runner, banks of fog across the stem
  if (wx === "rain" || wx === "storm") front += `<g class="pm-fine" fill="none" stroke="var(--rain)" stroke-width="1.2">${[[-58, 129], [46, 127], [86, 126]].map(([x, y], i) => `<ellipse class="pm-ripple" style="--d:${i}" cx="${x}" cy="${y}" rx="9" ry="2.4"/>`).join("")}</g>`;
  if (wx === "snow") front += `<path d="M-98 129 C-80 119 -64 126 -48 122 C-30 117 -16 125 0 122 C18 118 34 126 52 121 C70 116 86 123 100 127 C76 134 -76 136 -98 129Z" fill="var(--snow)" stroke="var(--snow-edge)" stroke-width="1.2" stroke-linejoin="round"/>`;
  if (wx === "fog") front += `<g fill="none" stroke="var(--fog)" stroke-linecap="round">${[[40, 6, 0.5], [74, 8, 0.55], [104, 7, 0.6]].map(([y, w, o], i) => { const h = Math.sqrt(132 * 132 - y * y) - 6; return `<path class="pm-fog" style="--d:${i}" d="M${f(-h)} ${y} C${f(-h / 2)} ${y - 5} ${f(-h / 5)} ${y + 5} ${f(h / 6)} ${y} S${f(h * 0.7)} ${y - 4} ${f(h)} ${y + 1}" stroke-width="${w}" stroke-dasharray="${f(h * 0.7)} 9 ${f(h * 0.5)} 12" opacity="${o}"/>`; }).join("")}</g>`;
  return { back, front };
}
