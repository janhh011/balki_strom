// Ergebnis: Ertrag (vom Server) -> Eigenverbrauch (lastgang.js) -> €, Kosten, Amortisation
// Rechnet im Browser; nichts davon geht an den Server.
import { lastgang, pvMinuten, eigenverbrauch } from './lastgang.js';
import { PARAMS, kwhFuer, STAND } from './params.js';

export const nf = (x, d = 0) => Number(x).toLocaleString('de-DE', {minimumFractionDigits: d, maximumFractionDigits: d});
export const eur = x => nf(Math.round(x)) + ' €';
const rund = x => x >= 50 ? Math.round(x / 10) * 10 : Math.round(x / 5) * 5;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const ZUHAUSE_TEXT = {0: 'tagsüber selten jemand', 0.4: 'tagsüber teils jemand', 1: 'tagsüber meist jemand'};

// ---------------------------------------------------------------- Rechnung
const lastCache = new Map();
const pvCache = new WeakMap();
function haushalt(personen, zuhause) {
  const k = `${personen}_${zuhause}`;
  if (!lastCache.has(k)) {
    if (lastCache.size > 6) lastCache.clear();
    lastCache.set(k, lastgang({kwh: kwhFuer(personen), personen: Math.min(personen, 4), zuhause}));
  }
  return lastCache.get(k);
}

// Jahre bis die Ersparnis (mit Strompreissteigerung, Moduldegradation) den Kaufpreis deckt
export function amortisation(kosten, spar1) {
  let kum = 0;
  for (let y = 1; y <= 40; y++) {
    const s = spar1 * (1 - PARAMS.degradation) ** (y - 1) * (1 + PARAMS.strompreisSteigerung) ** (y - 1);
    if (kum + s >= kosten) return y - 1 + (kosten - kum) / s;
    kum += s;
  }
  return Infinity;
}
function summeJahre(spar1, n) {
  let kum = 0;
  for (let y = 1; y <= n; y++) kum += spar1 * (1 - PARAMS.degradation) ** (y - 1) * (1 + PARAMS.strompreisSteigerung) ** (y - 1);
  return kum;
}

export function rechne(antwort, a) {
  if (!pvCache.has(antwort.stunde_wh)) pvCache.set(antwort.stunde_wh, pvMinuten(Float64Array.from(antwort.stunde_wh)));
  const erzeugt = antwort.kwh_jahr;
  const selbst = Math.min(erzeugt, eigenverbrauch(pvCache.get(antwort.stunde_wh), haushalt(a.personen, a.zuhause), {kapKwh: 0, maxW: PARAMS.wechselrichterMaxW}));
  const preis = a.strompreisCt / 100;
  const spar = selbst * preis;
  const anz = antwort.modul && antwort.modul.anzahl === 1 ? 1 : 2;
  const k = PARAMS.kosten[anz], auf = a.aufstellung === 'geneigt' ? PARAMS.kostenGeneigtAufschlag : 0;
  const kosten = {min: k.min + auf, typisch: k.typisch + auf, max: k.max + auf};
  return {
    erzeugt, selbst, quote: erzeugt > 0 ? selbst / erzeugt : 0, spar, kosten,
    jahre: {min: amortisation(kosten.min, spar), typisch: amortisation(kosten.typisch, spar), max: amortisation(kosten.max, spar)},
    netto: summeJahre(spar, PARAMS.jahre) - kosten.typisch,
  };
}

// ---------------------------------------------------------------- Texte
const jahreKurz = j => !Number.isFinite(j) || j > 30 ? 'mehr als 30' : nf(Math.max(1, Math.round(j)));
function jahreSpanne(j) {
  const a = jahreKurz(j.min), b = jahreKurz(j.max);
  return a === b ? `${a} Jahren` : `${a} bis ${b} Jahren`;
}
function stockText(g) {
  if (g == null || !Number.isFinite(g)) return '';
  return g === 0 ? 'Erdgeschoss' : `${g}. Stock`;
}
function sonneText(v) {
  if (v < 0.15) return 'kaum Schatten';
  if (v < 0.35) return 'etwas Schatten';
  if (v < 0.6) return 'viel Schatten';
  return 'sehr viel Schatten';
}

// ---------------------------------------------------------------- Darstellung
// el: <section id="ergebnis">; kontext: {adresse, grob}
export function zeigeLaden(el, text = 'Wir rechnen Sonne und Schatten für deinen Balkon …') {
  el.hidden = false;
  el.querySelector('[data-e="inhalt"]').hidden = true;
  const l = el.querySelector('[data-e="laden"]');
  l.hidden = false; l.querySelector('[data-e="ladetext"]').textContent = text;
  el.querySelector('[data-e="fehler"]').hidden = true;
}

export function zeigeFehler(el, text) {
  el.hidden = false;
  el.querySelector('[data-e="inhalt"]').hidden = true;
  el.querySelector('[data-e="laden"]').hidden = true;
  const f = el.querySelector('[data-e="fehler"]');
  f.hidden = false; f.querySelector('[data-e="fehlertext"]').textContent = text;
}

export function zeigeErgebnis(el, antwort, a, kontext = {}) {
  const r = rechne(antwort, a);
  const q = s => el.querySelector(`[data-e="${s}"]`);
  el.hidden = false;
  q('laden').hidden = true; q('fehler').hidden = true; q('inhalt').hidden = false;

  const spar = rund(r.spar);
  q('ort').textContent = kontext.adresse ? `Dein Ergebnis für ${kontext.adresse}` : 'Dein Ergebnis';
  q('titel').innerHTML = r.spar >= 5
    ? `Dein Balkon spart rund <span class="kpi-zahl">${eur(spar)}</span> im Jahr.`
    : `Dein Balkon macht rund <span class="kpi-zahl">${nf(rund(r.erzeugt))} kWh</span> Strom im Jahr.`;
  q('unter').textContent = kontext.grob
    ? 'Grobe Schätzung ohne 3D-Modell: Schatten von Nachbarhäusern und Bäumen haben wir pauschal angenommen.'
    : 'Hier siehst du, wie wir darauf kommen.';

  const stock = stockText(antwort.geschoss);
  const kpis = [
    ['Strom im Jahr', `${nf(rund(r.erzeugt))} kWh`, `davon nutzt du rund ${nf(Math.round(r.quote * 100))} % selbst`],
    ['Ausrichtung', antwort.richtung || '–', [stock, kontext.grob ? '' : sonneText(antwort.verschattung)].filter(Boolean).join(' · ')],
    ['Schatten', kontext.grob ? 'pauschal' : `−${nf(Math.round(antwort.verschattung * 100))} %`, kontext.grob ? `angenommen: −${nf(PARAMS.grobVerschattung * 100)} %` : 'Ertrag weniger durch Häuser und Bäume'],
    ['Set kostet etwa', `${nf(r.kosten.min)}–${nf(r.kosten.max)} €`, `${antwort.modul.anzahl} ${antwort.modul.anzahl === 1 ? 'Modul' : 'Module'} mit Halterung`],
    ['Bezahlt nach', jahreSpanne(r.jahre), 'danach sparst du jedes Jahr'],
  ];
  q('kpis').innerHTML = kpis.map(([t, z, s], i) =>
    `<div class="kpi${i === 4 ? ' kpi-gruen' : ''}"><dt>${t}</dt><dd><span class="kpi-wert">${esc(z)}</span><span class="kpi-sub">${esc(s)}</span></dd></div>`).join('');

  q('lang').textContent = Number.isFinite(r.netto) && r.netto > 0
    ? `Über ${PARAMS.jahre} Jahre bleiben dir nach Abzug des Kaufpreises (${eur(r.kosten.typisch)}) rund ${eur(Math.round(r.netto / 50) * 50)}.`
    : `Bei diesem Balkon dauert es lange, bis sich das Set bezahlt macht. Ehrlich: Hier lohnt es sich vor allem fürs gute Gefühl – oder mit günstigeren Annahmen.`;

  // Hinweise des Servers
  const hinweise = [...(antwort.hinweise || [])];
  if (antwort.rand) hinweise.push('Dein Balkon liegt am Rand unseres 3D-Gebiets. Schatten von weiter weg schätzen wir mit einfacheren Daten.');
  if (!kontext.grob && antwort.verschattung >= 0.6) hinweise.push('Hier kommt wenig direkte Sonne an. Ein Balkonkraftwerk lohnt sich dann nur langsam.');
  q('hinweise').innerHTML = hinweise.slice(0, 4).map(h => `<li>${esc(h)}</li>`).join('');
  q('hinweise').hidden = !hinweise.length;

  monatsDiagramm(q('monate'), antwort.monat_kwh || []);

  // So haben wir gerechnet
  const rows = [
    ['Module', `${antwort.modul.anzahl} × ${nf(antwort.modul.wp_je_modul)} Wp (${nf(antwort.modul.breite_m, 2)} × ${nf(antwort.modul.hoehe_m, 2)} m), ${a.aufstellung === 'geneigt' ? '30° ausgestellt' : 'senkrecht am Geländer'}`],
    ['Wechselrichter', `höchstens ${nf(PARAMS.wechselrichterMaxW)} W`],
    ['Strom im Jahr', `${nf(Math.round(r.erzeugt))} kWh${kontext.grob ? '' : ` (ohne Schatten wären es ${nf(Math.round(antwort.kwh_jahr_frei))} kWh)`}`],
    ['Selbst genutzt', `${nf(Math.round(r.selbst))} kWh – der Rest geht ohne Vergütung ins Netz`],
    ['Haushalt', `${a.personen === 4 ? '4 und mehr' : a.personen} ${a.personen === 1 ? 'Person' : 'Personen'}, ${nf(kwhFuer(a.personen))} kWh im Jahr, ${ZUHAUSE_TEXT[a.zuhause]}`],
    ['Strompreis', `${nf(a.strompreisCt, 1)} ct/kWh, +${nf(PARAMS.strompreisSteigerung * 100)} % pro Jahr`],
    ['Kosten des Sets', `${nf(r.kosten.min)}–${nf(r.kosten.max)} € (typisch ${nf(r.kosten.typisch)} €), Richtwert ${STAND}, 0 % MwSt.`],
    ['Alterung', `Module −${nf(PARAMS.degradation * 100, 1)} % Leistung pro Jahr`],
  ];
  if (!kontext.grob && antwort.sonnenstunden_frei) rows.splice(3, 0, ['Direkte Sonne', `${nf(antwort.sonnenstunden)} von ${nf(antwort.sonnenstunden_frei)} möglichen Stunden`]);
  q('annahmen').innerHTML = rows.map(([t, v]) => `<dt>${t}</dt><dd>${esc(v)}</dd>`).join('');
  q('wetter').textContent = kontext.grob
    ? 'Ohne 3D-Modell rechnen wir mit einem typischen Berliner Wetterjahr und pauschalem Schatten. Mit dem 3D-Modell wird es genauer.'
    : `Wir haben Nachbarhäuser und Bäume aus dem 3D-Stadtmodell Berlin vermessen und den Ertrag für jede Stunde eines Jahres simuliert${antwort.wetter ? ` (${antwort.wetter})` : ''}. Deinen Verbrauch rechnen wir Minute für Minute mit einem typischen Haushalt deiner Größe. Das ist eine Schätzung: Das Wetter schwankt von Jahr zu Jahr, und Verbrauch und Montage verändern das Ergebnis.`;
  return r;
}

function monatsDiagramm(svg, monate) {
  const M = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
  const W = 336, H = 132, B = 20, T = 18, bw = 18, step = W / 12;
  const max = Math.max(1, ...monate);
  const iMax = monate.indexOf(Math.max(...monate));
  let s = `<line x1="0" x2="${W}" y1="${H - B}" y2="${H - B}" class="achse"/>`;
  monate.forEach((v, i) => {
    const h = Math.max(2, (v / max) * (H - B - T)), x = i * step + (step - bw) / 2, y = H - B - h;
    const r = Math.min(4, h / 2);
    s += `<path class="balken" d="M${x},${H - B}V${y + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${H - B}Z"><title>${M[i]}: ${nf(Math.round(v))} kWh</title></path>`;
    s += `<text x="${x + bw / 2}" y="${H - 5}" text-anchor="middle" class="tick">${M[i].slice(0, 1)}</text>`;
    if (i === iMax) s += `<text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" class="wert">${nf(Math.round(v))}</text>`;
  });
  svg.innerHTML = s;
  svg.setAttribute('aria-label', 'Strom je Monat in kWh: ' + monate.map((v, i) => `${M[i]} ${nf(Math.round(v))}`).join(', '));
}
