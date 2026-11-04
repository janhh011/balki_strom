// Anbindung an POST /api/ertrag (Vertrag: docs/ARCHITEKTUR.md)
// ---------------------------------------------------------------
// ertrag(anfrage)  -> Antwort wie /api/ertrag
// schaetzeJahr(...) -> dieselbe Form, synthetisch (auch für die grobe Schätzung ohne 3D)

const ZEITLIMIT_MS = 45000;
const BERLIN = {lat: 52.50, lon: 13.40};
const RICHTUNGEN = ['Nord', 'Nordost', 'Ost', 'Südost', 'Süd', 'Südwest', 'West', 'Nordwest'];
// Globalstrahlung Berlin, kWh/m² je Monat (langjähriges Mittel, gerundet; DWD-Größenordnung ~1.020 kWh/m²·a)
const GHI_MONAT = [19, 34, 72, 118, 152, 158, 157, 134, 90, 52, 23, 14];
const MODUL = {breite: 1.72, hoehe: 1.13, wp: 430};

export class ErtragsFehler extends Error {
  constructor(text, art = 'fehler') { super(text); this.art = art; }
}

export const richtungAus = az => RICHTUNGEN[Math.round((((az % 360) + 360) % 360) / 45) % 8];
export const azimutAus = (nx, ny) => ((Math.atan2(nx, ny) * 180 / Math.PI) + 360) % 360;

export async function ertrag(anfrage, {signal} = {}) {
  const body = {
    kachel: String(anfrage.kachel), x: +anfrage.x, y: +anfrage.y, z: +anfrage.z,
    nx: +anfrage.nx, ny: +anfrage.ny,
    aufstellung: anfrage.aufstellung === 'geneigt' ? 'geneigt' : 'senkrecht',
  };
  // module optional: fehlt es und ist breite_m gesetzt, wählt der Server 1 oder 2 nach der Breite
  if (anfrage.module === 1 || anfrage.module === 2) body.module = anfrage.module;
  const b = +anfrage.breite_m;
  if (Number.isFinite(b) && b >= 0.5 && b <= 15) {
    body.breite_m = Math.round(b * 100) / 100;
    const h = +anfrage.hoehe_m;
    if (Number.isFinite(h) && h >= 0 && h <= 8) body.hoehe_m = Math.round(h * 100) / 100;
  }
  else if (!body.module) body.module = 2;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ZEITLIMIT_MS);
  if (signal) signal.addEventListener('abort', () => ctl.abort(), {once: true});
  let r;
  try {
    r = await fetch('api/ertrag', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
      signal: ctl.signal, credentials: 'omit', cache: 'no-store',
    });
  } catch (e) {
    if (signal && signal.aborted) throw e;
    throw new ErtragsFehler(ctl.signal.aborted
      ? 'Die Rechnung hat zu lange gedauert. Versuch es bitte gleich noch einmal.'
      : 'Der Server ist gerade nicht erreichbar. Prüf deine Internetverbindung und versuch es noch einmal.', 'netz');
  } finally { clearTimeout(timer); }
  let d = null;
  try { d = await r.json(); } catch { /* keine JSON-Antwort */ }
  if (r.status === 429) throw new ErtragsFehler('Gerade rechnen sehr viele gleichzeitig. Versuch es bitte in einer Minute noch einmal.', 'voll');
  if (r.status === 503) throw new ErtragsFehler('Der Server ist gerade ausgelastet. Versuch es bitte in einer Minute noch einmal.', 'voll');
  if (!r.ok || !d || d.ok === false) {
    throw new ErtragsFehler((d && typeof d.fehler === 'string' && d.fehler.length < 300) ? d.fehler
      : 'Für diese Stelle klappt die Rechnung gerade nicht. Tipp bitte etwas anders auf deinen Balkon.', 'eingabe');
  }
  if (!Array.isArray(d.stunde_wh) || d.stunde_wh.length < 8760 || !Number.isFinite(d.kwh_jahr)) {
    throw new ErtragsFehler('Die Antwort des Servers war unvollständig. Versuch es bitte noch einmal.', 'antwort');
  }
  return d;
}

export function modulEcken(p, anzahl, aufstellung) {
  const n = Math.hypot(p.nx, p.ny) || 1, nx = p.nx / n, ny = p.ny / n, tx = -ny, ty = nx;
  const W = MODUL.breite, H = MODUL.hoehe, gap = 0.04, ges = anzahl * W + (anzahl - 1) * gap;
  const neig = aufstellung === 'geneigt' ? 30 * Math.PI / 180 : 0;
  const z0 = p.z - 0.2, abst = 0.12;
  const out = [];
  for (let i = 0; i < anzahl; i++) {
    const a = -ges / 2 + i * (W + gap), e = a + W;
    const unten = abst + H * Math.sin(neig), oben = abst, zOben = z0 + H * Math.cos(neig);
    const P = (t, o, z) => [+(p.x + tx * t + nx * o).toFixed(2), +(p.y + ty * t + ny * o).toFixed(2), +z.toFixed(2)];
    out.push([P(a, unten, z0), P(e, unten, z0), P(e, oben, zOben), P(a, oben, zOben)]);
  }
  return out;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Sonnenstand im Format von viewer.js (Ersatz, falls der Viewer nicht geladen ist)
export function sonnenstandErsatz(date) { const s = sonne(date.getTime(), BERLIN.lat, BERLIN.lon); return {azimut: s.az, hoehe: s.el}; }

// Sonnenstand (vereinfachter NOAA-Algorithmus); ms = UTC-Zeitstempel -> {el, az} in Grad (az von Nord im Uhrzeigersinn)
function sonne(ms, lat, lon) {
  const RAD = Math.PI / 180, d = ms / 86400000 + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * RAD, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD, e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = ((gmst * 15 + lon) * RAD - ra);
  const la = lat * RAD;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
  return {el: el / RAD, az: ((az / RAD) + 360) % 360};
}

// Synthetisches Ertragsjahr (2025, Zeitachse wie lastgang.js: Stunde 0 = 1. Januar 00:00 MEZ)
export function schaetzeJahr({azimut, aufstellung = 'senkrecht', module = 2, horizont = null, himmelSicht = 1, verschattung = 0, seed = 7}) {
  const R = rng(seed), RAD = Math.PI / 180;
  const beta = (aufstellung === 'geneigt' ? 60 : 90) * RAD, gam = azimut;
  const wp = module * MODUL.wp, VERLUST = 0.14, MAXW = 800;
  const t0 = Date.UTC(2025, 0, 1) - 3600e3;
  const tage = Array.from({length: 365}, () => 0.12 + 0.88 * R() ** 0.8);  // Klarheit je Tag
  const sonnen = new Array(8760), roh = new Float64Array(8760);
  const monatRoh = new Float64Array(12);
  for (let h = 0; h < 8760; h++) {
    const ms = t0 + (h + 0.5) * 3600e3, s = sonne(ms, BERLIN.lat, BERLIN.lon);
    sonnen[h] = s;
    if (s.el <= 0) continue;
    const sinEl = Math.sin(s.el * RAD), klar = 1098 * sinEl * Math.exp(-0.057 / Math.max(sinEl, 0.03));
    roh[h] = klar * tage[Math.floor(h / 24)];
    monatRoh[new Date(ms + 3600e3).getUTCMonth()] += roh[h] / 1000;
  }
  const horiz = (az, el) => {
    if (!horizont) return false;
    const i = Math.round(az / (horizont.schritt_grad || 2)) % horizont.gebaeude.length;
    return el < Math.max(horizont.gebaeude[i] || 0, horizont.baeume[i] || 0);
  };
  const stunde = new Array(8760), monat = new Array(12).fill(0);
  let kwh = 0, kwhFrei = 0, sh = 0, shFrei = 0;
  for (let h = 0; h < 8760; h++) {
    const s = sonnen[h];
    if (s.el <= 0) { stunde[h] = 0; continue; }
    const m = new Date(t0 + (h + 0.5) * 3600e3 + 3600e3).getUTCMonth();
    const ghi = roh[h] * GHI_MONAT[m] / monatRoh[m];
    const kday = tage[Math.floor(h / 24)];
    const dhi = ghi * Math.min(1, Math.max(0.15, 1.05 - 0.85 * kday));
    const sinEl = Math.sin(s.el * RAD), dni = Math.min(1000, (ghi - dhi) / Math.max(sinEl, 0.05));
    const cosT = sinEl * Math.cos(beta) + Math.cos(s.el * RAD) * Math.sin(beta) * Math.cos((s.az - gam) * RAD);
    const direkt = dni * Math.max(0, cosT), diffus = dhi * (1 + Math.cos(beta)) / 2, boden = ghi * 0.2 * (1 - Math.cos(beta)) / 2;
    const zu = horiz(s.az, s.el);
    const poaFrei = direkt + diffus + boden;
    const poa = (zu ? 0 : direkt) * (1 - verschattung) + diffus * himmelSicht + boden;
    if (cosT > 0 && s.el > 2) { shFrei++; if (!zu) sh++; }
    const p = w => Math.min(MAXW, w / 1000 * wp * (1 - VERLUST));
    stunde[h] = Math.round(p(poa));
    kwh += stunde[h] / 1000; kwhFrei += p(poaFrei) / 1000; monat[m] += stunde[h] / 1000;
  }
  return {
    modul: {anzahl: module, wp_je_modul: MODUL.wp, wp: wp, breite_m: MODUL.breite, hoehe_m: MODUL.hoehe},
    kwh_jahr: +kwh.toFixed(1), kwh_jahr_frei: +kwhFrei.toFixed(1),
    verschattung: +Math.max(0, 1 - kwh / kwhFrei).toFixed(3),
    monat_kwh: monat.map(v => +v.toFixed(1)), stunde_wh: stunde,
    sonnenstunden: sh, sonnenstunden_frei: shFrei,
    horizont: horizont || {schritt_grad: 2, gebaeude: new Array(180).fill(0), baeume: new Array(180).fill(0)},
  };
}
