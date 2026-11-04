// Sonnenverlauf: „Sonne und Schatten an deinem Balkon“
// Zeigt für 21. Juni / März / Dezember, wo die Sonne steht, ob sie den Balkon erreicht (Horizont aus der
// Server-Antwort) und wie viel Leistung die Module um diese Uhrzeit typischerweise bringen (stunde_wh).
// Der 3D-Viewer zeigt dazu Sonnenstand und Schatten (setzeSonne / spieleSonne, falls vorhanden).
import { sonnenstandErsatz } from './api.js';

const $ = id => document.getElementById(id);
const JAHR = 2025;
const T0_MEZ = Date.UTC(JAHR, 0, 1) - 3600e3;     // stunde_wh: Stunde 0 = 1. Januar 00:00 MEZ
const VON = 5 * 60, BIS = 22 * 60;                 // Minuten (Ortszeit)
const DAUER_MS = 10000;
const ruhig = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let antwort = null, viewer = null, sonnenstand = sonnenstandErsatz;
let monat = 5, minuten = 13 * 60, spielt = null, schonGespielt = false;

// Ortszeit Berlin -> Date (21. Juni: Sommerzeit, 21. März und 21. Dezember: Normalzeit)
const versatz = m => (m >= 3 && m <= 9 ? 2 : 1);
const datum = (m, min) => new Date(Date.UTC(JAHR, m, 21, 0, min - versatz(m) * 60));
const uhr = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(Math.round(min % 60)).padStart(2, '0')}`;

// Leistung (W) um diese Uhrzeit: Mittel über 7 Tage rund um das Datum, linear zwischen Stundenmitten
function leistung(d) {
  const w = antwort && antwort.stunde_wh;
  if (!w) return null;
  let s = 0, n = 0;
  for (let k = -3; k <= 3; k++) {
    const h = (d.getTime() + k * 864e5 - T0_MEZ) / 3600e3 - 0.5;
    const i = Math.floor(h), f = h - i;
    if (i < 0 || i + 1 >= w.length) continue;
    s += w[i] * (1 - f) + w[i + 1] * f; n++;
  }
  return n ? s / n : null;
}

function sonnenLage(d) {
  const s = sonnenstand(d);
  if (s.hoehe <= 0) return minuten < 12 * 60 ? 'Die Sonne ist noch nicht aufgegangen.' : 'Die Sonne ist untergegangen.';
  const diff = Math.abs(((s.azimut - antwort.azimut + 540) % 360) - 180);
  if (diff >= 90) return 'Die Sonne steht hinter dem Haus.';
  const hz = antwort.horizont;
  if (hz && Array.isArray(hz.gebaeude) && hz.gebaeude.length) {
    const i = Math.round(s.azimut / (hz.schritt_grad || 2)) % hz.gebaeude.length;
    const g = +hz.gebaeude[i] || 0, b = (hz.baeume && +hz.baeume[i]) || 0;
    if (s.hoehe < Math.max(g, b)) return b > g ? 'Ein Baum wirft Schatten auf deinen Balkon.' : 'Ein Nachbarhaus wirft Schatten auf deinen Balkon.';
  }
  return 'Die Sonne scheint auf deinen Balkon.';
}

function zeige(viewerAuch = true) {
  if (!antwort) return;
  const d = datum(monat, minuten);
  $('sonne-zeit').value = String(Math.round(minuten));
  $('sonne-uhr').textContent = uhr(minuten);
  $('sonne-zeit').setAttribute('aria-valuetext', `${uhr(minuten)} Uhr`);
  const w = leistung(d);
  $('sonne-leistung').textContent = w == null ? '' : `${uhr(minuten)} Uhr: Leistung ca. ${Math.round(w / 10) * 10} W. `;
  $('sonne-status').textContent = sonnenLage(d);
  if (viewerAuch && viewer && typeof viewer.setzeSonne === 'function') viewer.setzeSonne(d);
}

function knopf() {
  const b = $('sonne-play');
  b.classList.toggle('spielt', !!spielt);
  b.setAttribute('aria-label', spielt ? 'Sonnenverlauf anhalten' : 'Sonnenverlauf abspielen');
  $('sonne-live').setAttribute('aria-live', spielt ? 'off' : 'polite');   // während des Abspielens nicht ständig vorlesen
}

function stopp() {
  if (spielt) { try { spielt.stopp(); } catch { /* egal */ } }
  spielt = null; knopf();
}

function spiele() {
  stopp();
  if (minuten >= BIS - 5) minuten = VON;
  const start = minuten;
  if (viewer && typeof viewer.spieleSonne === 'function') {
    const ctl = viewer.spieleSonne({
      tag: datum(monat, 12 * 60), von: start / 60, bis: BIS / 60, dauer_s: DAUER_MS / 1000 * (BIS - start) / (BIS - VON),
      beiZeit: d => {
        // Ortszeit aus dem gelieferten Datum
        minuten = Math.min(BIS, ((d.getUTCHours() + versatz(monat)) % 24) * 60 + d.getUTCMinutes());
        zeige(false);
        if (minuten >= BIS - 1 && spielt === ctl) { spielt = null; knopf(); }
      },
    });
    spielt = ctl && typeof ctl.stopp === 'function' ? ctl : {stopp() {}};
  } else {
    // Ersatz: eigene Schleife über setzeSonne
    let an = true, t0 = performance.now();
    const schritt = now => {
      if (!an) return;
      minuten = Math.min(BIS, start + (now - t0) / DAUER_MS * (BIS - VON));
      zeige();
      if (minuten >= BIS) { spielt = null; knopf(); return; }
      requestAnimationFrame(schritt);
    };
    requestAnimationFrame(schritt);
    spielt = {stopp() { an = false; }};
  }
  knopf();
}

export function initSonne() {
  $('sonne-play').addEventListener('click', () => (spielt ? stopp() : spiele()));
  $('sonne-zeit').addEventListener('input', e => { stopp(); minuten = +e.target.value; zeige(); });
  document.querySelectorAll('input[name=sonnentag]').forEach(i => i.addEventListener('change', () => {
    const lief = !!spielt; stopp(); monat = +i.value; zeige(); if (lief) spiele();
  }));
}

// nach einem Ergebnis: Bereich zeigen; beim ersten Ergebnis einmal automatisch abspielen
export function sonneZeigen(a, {v = null, stand = null} = {}) {
  stopp();
  antwort = a; viewer = v; if (stand) sonnenstand = stand;
  $('sonne').hidden = false;
  zeige();
  if (!schonGespielt && !ruhig()) { schonGespielt = true; minuten = VON; spiele(); }
}

export function sonneVerstecken() {
  stopp();
  if (antwort && viewer && typeof viewer.setzeSonne === 'function') {
    try { viewer.setzeSonne(null); } catch { /* ältere Viewer kennen null nicht */ }
  }
  antwort = null;
  $('sonne').hidden = true;
}
