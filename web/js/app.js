// balki strom: Adresse -> Haus in 3D -> Balkon als Rahmen aufziehen (oder antippen) -> Ergebnis -> Schritte
// Zustand steht im URL-Hash (#a=Straße|Nr&p=kachel,x,y,z,nx,ny,nz&w=2.4&m=2&g=senkrecht | &r=180 für die grobe Schätzung),
// damit Neuladen und Zurück funktionieren. Annahmen (Strompreis, Haushalt) merkt sich nur der eigene Browser.
import { ladeAdressen, bindeSuche, findeGenau, adressText, gebietText } from './suche.js';
import { ertrag, schaetzeJahr, richtungAus, ErtragsFehler } from './api.js';
import { zeigeErgebnis, zeigeLaden, zeigeFehler } from './ergebnis.js';
import { PARAMS, ladeAnnahmen, speichereAnnahmen } from './params.js';
import { initSchritte, setzeKontext } from './schritte.js';
import { initSonne, sonneZeigen, sonneVerstecken } from './sonne.js';

const $ = id => document.getElementById(id);
const schmal = () => matchMedia('(max-width: 999px)').matches;

const st = {
  adresse: null, punkt: null, grobAz: null, antwort: null, grob: false,
  annahmen: ladeAnnahmen(), kein3d: false, viewer: null, viewerP: null, abbruch: null,
  breite: null,            // Breite des aufgezogenen Rahmens (m); null = angetippt
  moduleExplizit: false,   // Modulzahl selbst gewählt (sonst wählt der Server nach der Breite)
  rahmenMoeglich: false, modus: 'rahmen', viewerMod: null,
};
const E = $('ergebnis');

// ---------------------------------------------------------------- Hash
function hashSchreiben(push) {
  const h = new URLSearchParams();
  if (st.adresse) h.set('a', `${st.adresse.s}|${st.adresse.n}`);
  if (st.punkt) {
    const p = st.punkt;
    h.set('p', [p.kachel, p.x, p.y, p.z, p.nx, p.ny, p.nz || 0].join(','));
  }
  if (st.punkt && st.breite) { h.set('w', st.breite.toFixed(2)); if (st.hoehe != null) h.set('hh', st.hoehe.toFixed(2)); }
  if (st.grob && st.grobAz != null) h.set('r', String(st.grobAz));
  if (st.punkt || st.grob) {
    if (!st.breite || st.moduleExplizit) h.set('m', String(st.annahmen.module));
    h.set('g', st.annahmen.aufstellung);
  }
  const url = location.pathname + location.search + (h.toString() ? '#' + h.toString() : '');
  if (url === location.pathname + location.search + location.hash) return;
  history[push ? 'pushState' : 'replaceState'](null, '', url);
}

function hashLesen() {
  const h = new URLSearchParams(location.hash.slice(1));
  const out = {};
  const a = h.get('a');
  if (a && a.includes('|')) { const i = a.lastIndexOf('|'); out.s = a.slice(0, i); out.n = a.slice(i + 1); }
  const p = (h.get('p') || '').split(',');
  if (p.length === 7 && /^[\w-]{1,40}$/.test(p[0]) && p.slice(1).every(v => Number.isFinite(+v) && v !== '')) {
    const [kachel, x, y, z, nx, ny, nz] = p;
    out.punkt = {kachel, x: +x, y: +y, z: +z, nx: +nx, ny: +ny, nz: +nz};
  }
  const r = +h.get('r');
  if (h.has('r') && Number.isFinite(r) && r >= 0 && r < 360) out.r = r;
  if (h.get('m') === '1' || h.get('m') === '2') out.m = +h.get('m');
  const w = +h.get('w');
  if (h.has('w') && Number.isFinite(w) && w >= 0.5 && w <= 15) out.w = w;
  const hh = +h.get('hh');
  if (h.has('hh') && Number.isFinite(hh) && hh >= 0 && hh <= 8) out.hh = hh;
  if (h.get('g') === 'senkrecht' || h.get('g') === 'geneigt') out.g = h.get('g');
  return out;
}

async function anwenden() {
  // Sprungmarken wie #schritte sind kein Zustand
  if (location.hash.length > 1 && !location.hash.includes('=')) return;
  const h = hashLesen();
  if (h.m) st.annahmen.module = h.m;
  if (h.g) st.annahmen.aufstellung = h.g;
  syncWahl();
  if (!h.s) { zurueckZumStart(false); return; }
  const D = await ladeAdressen();
  const a = findeGenau(D, h.s, h.n);
  if (!a) { zurueckZumStart(false); return; }
  if (!st.adresse || st.adresse !== a) await adresseGewaehlt(a, {push: false, fokus: false});
  if (h.punkt && h.w) {
    st.grob = false; await bereit();
    // Rahmen aus Mitte der Unterkante und Breite rekonstruieren (für die Anzeige)
    const p = h.punkt, n = Math.hypot(p.nx, p.ny) || 1, tx = -p.ny / n, ty = p.nx / n, hb = h.w / 2, hh = h.hh || 0;
    rahmenGezogen({...p, breite_m: h.w, hoehe_m: h.hh, a: [p.x - tx * hb, p.y - ty * hb, p.z], b: [p.x + tx * hb, p.y + ty * hb, p.z + hh]},
      {push: false, explizit: !!h.m});
  } else if (h.punkt) { st.grob = false; await bereit(); balkonGewaehlt(h.punkt, {push: false}); }
  else if (h.r != null) { grobModus(); waehleRichtung(h.r, {push: false}); }
  else if (st.punkt || st.grob) {
    // zurück zu "noch kein Balkon gewählt"
    if (st.abbruch) st.abbruch.abort();
    st.punkt = null; st.grob = false; st.antwort = null; st.breite = null;
    viewerLeeren();
    ergebnisWarten();
  }
}

function viewerLeeren() {
  sonneVerstecken();
  if (!st.viewer) return;
  st.viewer.zeigeMarker(null); st.viewer.zeigeModule(null);
  if (typeof st.viewer.zeigeRahmen === 'function') st.viewer.zeigeRahmen(null);
}

// ---------------------------------------------------------------- 1. Adresse
function zurueckZumStart(fokus = true) {
  st.adresse = null; st.punkt = null; st.antwort = null; st.grob = false; st.breite = null;
  sonneVerstecken();
  document.body.classList.remove('hat-adresse');
  $('arbeit').hidden = true;
  suche.setze(null);
  setzeKontext({adresse: null, berechnet: false});
  if (fokus) $('adresse').focus();
}

async function adresseGewaehlt(a, {push = true, fokus = true} = {}) {
  if (st.abbruch) st.abbruch.abort();
  st.adresse = a; st.punkt = null; st.antwort = null; st.grob = false; st.grobAz = null; st.breite = null; st.moduleExplizit = false;
  viewerLeeren();
  suche.setze(a);
  document.body.classList.add('hat-adresse');
  $('arbeit').hidden = false;
  $('haus-adresse').textContent = `${adressText(a)}, ${a.p} Berlin`;
  if (!st.kein3d) { $('ohne3d').hidden = true; $('ohne3d-link').parentElement.hidden = false; titelSetzen(); }
  $('richtungen').querySelectorAll('input').forEach(i => { i.checked = false; });
  ergebnisWarten();
  setzeKontext({adresse: a, berechnet: false});
  if (push) hashSchreiben(true);
  if (fokus) {
    $('haus-titel').focus({preventScroll: true});
    $('haus').scrollIntoView({behavior: 'smooth', block: 'start'});
  }
  const v = await viewerHolen();
  if (!v) return;
  $('viewer-hinweis').hidden = true;
  let ok = true;
  try { ok = await v.zeigeOrt(a.x, a.y); } catch (e) { console.warn('zeigeOrt', e); ok = false; }
  if (st.adresse !== a) return;             // inzwischen andere Adresse gewählt
  if (ok === false) {
    zeigeHinweis('Für dieses Gebiet gibt es noch kein 3D-Modell. Unten kannst du grob schätzen lassen.');
    grobModus();
    return;
  }
  if (v.ort && v.ort.haus === 'umgebung') {
    zeigeHinweis(st.rahmenMoeglich
      ? 'Dein Haus liegt am Rand des 3D-Modells und ist nur vereinfacht zu sehen. Du kannst trotzdem einen Rahmen auf die Wand ziehen.'
      : 'Dein Haus liegt am Rand des 3D-Modells und ist nur vereinfacht zu sehen. Du kannst trotzdem auf die Wand tippen.');
  }
  if (st.rahmenMoeglich) { setzeModus(st.modus); if (!st.punkt) rahmenHilfeZeigen(); }
}

// ---------------------------------------------------------------- Rahmen ziehen / Ansicht drehen
const touch = () => matchMedia('(pointer: coarse)').matches;
function titelSetzen() {
  $('haus-titel').textContent = st.rahmenMoeglich ? 'Markiere deinen Balkon' : 'Tippe auf deinen Balkon';
  $('warten-text').textContent = st.rahmenMoeglich
    ? 'Such im Bild deinen Balkon und zieh einen Rahmen über seine Breite. Dann werden Sonne und Schatten für genau diese Stelle durchgerechnet.'
    : 'Such im Bild deinen Balkon und tippe darauf. Dann werden Sonne und Schatten für genau diese Stelle durchgerechnet.';
}
function setzeModus(m) {
  st.modus = m === 'drehen' ? 'drehen' : 'rahmen';
  document.querySelectorAll('input[name=modus]').forEach(i => { i.checked = i.value === st.modus; });
  if (st.viewer && typeof st.viewer.setzeModus === 'function') st.viewer.setzeModus(st.modus);
  $('modus-tipp').textContent = st.modus === 'rahmen'
    ? (touch() ? 'Ein Finger zieht den Rahmen. Mit zwei Fingern drehen und zoomen.' : 'Linke Maustaste zieht den Rahmen. Rechte Maustaste dreht, Mausrad zoomt.')
    : (touch() ? 'Ein Finger dreht die Ansicht, zwei Finger zoomen. Kurz tippen wählt eine Stelle.' : 'Ziehen dreht die Ansicht, Mausrad zoomt. Klicken wählt eine Stelle.');
  if (st.modus === 'drehen') rahmenHilfeAus();
}
let hilfeTmr = 0;
function rahmenHilfeZeigen() {
  const h = $('rahmen-hilfe');
  h.hidden = false; h.classList.remove('aus');
  h.classList.toggle('bewegt', !matchMedia('(prefers-reduced-motion: reduce)').matches);
  clearTimeout(hilfeTmr);
  hilfeTmr = setTimeout(rahmenHilfeAus, 3 * 2400 + 400);     // drei Durchläufe, dann ausblenden
}
function rahmenHilfeAus() {
  const h = $('rahmen-hilfe');
  clearTimeout(hilfeTmr);
  if (h.hidden) return;
  h.classList.add('aus');
  setTimeout(() => { h.hidden = true; h.classList.remove('aus'); }, 400);
}

function rahmenGezogen(r, {push = false, explizit = false} = {}) {
  $('viewer-meldung').hidden = true;
  rahmenHilfeAus();
  st.punkt = {kachel: r.kachel, x: r.x, y: r.y, z: r.z, nx: r.nx, ny: r.ny, nz: r.nz || 0};
  st.breite = r.breite_m; st.hoehe = Number.isFinite(+r.hoehe_m) ? +r.hoehe_m : null;
  st.grob = false; st.moduleExplizit = explizit;
  if (st.viewer) {
    st.viewer.zeigeMarker(null);
    if (typeof st.viewer.zeigeRahmen === 'function') st.viewer.zeigeRahmen(r);
  }
  hashSchreiben(push);
  berechne();
}

function ergebnisWarten() {
  E.querySelector('[data-e="warten"]').hidden = false;
  for (const k of ['inhalt', 'laden', 'fehler']) E.querySelector(`[data-e="${k}"]`).hidden = true;
}

// ---------------------------------------------------------------- 2. Viewer (erst nach der Adresswahl laden)
function viewerHolen() {
  if (st.viewerP) return st.viewerP;
  const laden = $('viewer-laden');
  laden.hidden = false; $('viewer-ladetext').textContent = 'Lade die 3D-Ansicht …';
  st.viewerP = (async () => {
    let mod;
    try {
      mod = await import('./viewer.js');
    } catch (e) {
      console.warn('Viewer-Modul nicht ladbar', e);
      ohne3d('Die 3D-Ansicht konnte nicht laden', 'Vielleicht ist die Verbindung gerade schwach. Lade die Seite später neu oder schätze hier grob: Wohin zeigt dein Balkon?');
      return null;
    }
    try {
      const v = await mod.erstelleViewer($('viewer'), {manifest: 'tiles/tiles.json', qualitaet: 'auto'});
      v.beiStatus(statusAnzeigen);
      v.beiAuswahl(p => balkonGewaehlt(p, {push: false}));
      if (typeof v.beiFehlgriff === 'function') v.beiFehlgriff(fehlgriff);
      st.rahmenMoeglich = typeof v.beiRahmen === 'function' && typeof v.setzeModus === 'function';
      if (st.rahmenMoeglich) v.beiRahmen(r => rahmenGezogen(r, {push: false}));
      $('modus-zeile').hidden = !st.rahmenMoeglich;
      titelSetzen();
      st.viewer = v; st.viewerMod = mod;
      laden.hidden = true;
      return v;
    } catch (e) {
      const keinWebgl = e && (e.name === 'ViewerNichtVerfuegbar' || (mod.ViewerNichtVerfuegbar && e instanceof mod.ViewerNichtVerfuegbar));
      if (!keinWebgl) console.warn('Viewer-Fehler', e);
      ohne3d(keinWebgl ? 'Dein Gerät kann die 3D-Ansicht leider nicht zeigen' : 'Die 3D-Ansicht konnte nicht starten',
        'Eine grobe Schätzung geht trotzdem. Wohin zeigt dein Balkon?');
      return null;
    }
  })();
  return st.viewerP;
}
const bereit = () => viewerHolen();

function statusAnzeigen({ladend, fortschritt = 0, text = ''}) {
  const laden = $('viewer-laden');
  laden.hidden = !ladend;
  if (text) $('viewer-ladetext').textContent = text;
  const pct = Math.round(Math.max(0, Math.min(1, fortschritt)) * 100);
  $('viewer-balken').style.width = pct + '%';
  laden.querySelector('[role=progressbar]').setAttribute('aria-valuenow', String(pct));
  $('viewer-tipp').hidden = ladend || !!st.punkt || st.rahmenMoeglich;
}

function ohne3d(titel, text) {
  st.kein3d = true;
  $('viewer-laden').hidden = true;
  $('viewer').closest('.viewer-rahmen').hidden = true;
  $('ohne3d-titel').textContent = titel; $('ohne3d-text').textContent = text;
  $('ohne3d').hidden = false; $('ohne3d-link').parentElement.hidden = true;
  $('haus-titel').textContent = 'Wohin zeigt dein Balkon?';
}

// grobe Schätzung ohne 3D: Himmelsrichtung wählen
const RICHTUNG_AZ = [['Süd', 180], ['Südwest', 225], ['West', 270], ['Südost', 135], ['Ost', 90], ['Nordwest', 315], ['Nordost', 45], ['Nord', 0]];
function grobModus() {
  if (!$('ohne3d').hidden) return;
  $('ohne3d-titel').textContent = 'Grob schätzen ohne 3D';
  $('ohne3d-text').textContent = 'Wohin zeigt dein Balkon? Nimm die Richtung, in die du vom Balkon aus schaust. Der Schatten wird dann pauschal angenommen.';
  $('ohne3d').hidden = false; $('ohne3d-link').parentElement.hidden = true;
}
function baueRichtungen() {
  $('richtungen').innerHTML = RICHTUNG_AZ.map(([n, az]) =>
    `<label><input type="radio" name="richtung" value="${az}"><span>${n}</span></label>`).join('');
  $('richtungen').addEventListener('change', e => waehleRichtung(+e.target.value, {push: false}));
}
function waehleRichtung(az, {push}) {
  st.grob = true; st.grobAz = az; st.punkt = null; st.breite = null;
  const r = $('richtungen').querySelector(`input[value="${az}"]`); if (r) r.checked = true;
  viewerLeeren();
  hashSchreiben(push);
  rechneGrob();
}
function rechneGrob() {
  const a = st.annahmen;
  const d = schaetzeJahr({azimut: st.grobAz, aufstellung: a.aufstellung, module: a.module, verschattung: PARAMS.grobVerschattung, himmelSicht: 0.8});
  st.antwort = {ok: true, azimut: st.grobAz, richtung: richtungAus(st.grobAz), geschoss: null, module: [], rand: false, hinweise: [], ...d};
  render(true);
}

// ---------------------------------------------------------------- 3. Balkon gewählt -> Ertrag
// Rückmeldung, wenn daneben getippt wurde (verschwindet nach ein paar Sekunden)
const FEHLGRIFF = {
  dach: 'Das ist ein Dach. Tippe auf die Hauswand oder das Geländer deines Balkons.',
  boden: 'Das ist der Boden. Tippe auf die Hauswand oder das Geländer deines Balkons.',
  baum: 'Da ist ein Baum im Weg. Dreh das Haus ein wenig und tippe auf deinen Balkon.',
  unscharf: 'Bitte etwas näher heranzoomen und dann auf deinen Balkon tippen.',
  leer: 'Da ist nichts. Tippe auf die Hauswand oder das Geländer deines Balkons.',
};
let meldungTmr = 0;
function fehlgriff({art} = {}) {
  const m = $('viewer-meldung');
  let t = FEHLGRIFF[art] || FEHLGRIFF.leer;
  if (st.rahmenMoeglich && st.modus === 'rahmen') t = t.replace('Tippe auf die Hauswand oder das Geländer deines Balkons.', 'Zieh den Rahmen auf der Hauswand über deinen Balkon.')
    .replace('tippe auf deinen Balkon', 'zieh den Rahmen über deinen Balkon').replace('auf deinen Balkon tippen', 'den Rahmen über deinen Balkon ziehen');
  m.textContent = t;
  m.hidden = false;
  clearTimeout(meldungTmr);
  meldungTmr = setTimeout(() => { m.hidden = true; }, 4000);
}
function zeigeHinweis(text) { const h = $('viewer-hinweis'); h.textContent = text; h.hidden = false; }

function balkonGewaehlt(p, {push}) {
  $('viewer-meldung').hidden = true;
  rahmenHilfeAus();
  st.punkt = p; st.grob = false; st.breite = null;     // Antippen: wie bisher mit der gewählten Modulzahl
  if (st.viewer && typeof st.viewer.zeigeRahmen === 'function') st.viewer.zeigeRahmen(null);
  $('viewer-tipp').hidden = true;
  if (st.viewer) st.viewer.zeigeMarker(p.x, p.y, p.z);
  hashSchreiben(push);
  berechne();
}

async function berechne() {
  if (st.grob) return rechneGrob();
  if (!st.punkt) return;
  if (st.abbruch) st.abbruch.abort();
  const ctl = st.abbruch = new AbortController();
  E.querySelector('[data-e="warten"]').hidden = true;
  zeigeLaden(E);
  setzeWahlAktiv(false);
  sonneVerstecken();
  try {
    const anfrage = {...st.punkt, aufstellung: st.annahmen.aufstellung};
    if (st.breite) { anfrage.breite_m = st.breite; if (st.hoehe != null) anfrage.hoehe_m = st.hoehe; }
    if (!st.breite || st.moduleExplizit) anfrage.module = st.annahmen.module;   // sonst wählt der Server nach der Breite
    const d = await ertrag(anfrage, {signal: ctl.signal});
    if (ctl.signal.aborted) return;
    st.antwort = d;
    if (d.modul && (d.modul.anzahl === 1 || d.modul.anzahl === 2)) { st.annahmen.module = d.modul.anzahl; syncWahl(); }
    if (st.viewer && Array.isArray(d.module)) st.viewer.zeigeModule(d.module);
    render(false, true);
    if (st.viewer) sonneZeigen(d, {v: st.viewer, stand: st.viewerMod && st.viewerMod.sonnenstand});
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    zeigeFehler(E, e instanceof ErtragsFehler ? e.message : 'Da ist etwas schiefgegangen. Versuch es bitte noch einmal.');
  } finally {
    if (st.abbruch === ctl) setzeWahlAktiv(true);
  }
}

function render(grob, neu = false) {
  E.querySelector('[data-e="warten"]').hidden = true;
  // Eigenverbrauch braucht etwas Rechenzeit: erst "rechnet" zeigen, dann rechnen
  zeigeLaden(E, 'Dein Eigenverbrauch wird berechnet …');
  requestAnimationFrame(() => setTimeout(() => {
    const d = st.antwort; if (!d) return;
    zeigeErgebnis(E, d, st.annahmen, {adresse: st.adresse ? adressText(st.adresse) : '', grob});
    setzeKontext({berechnet: true, module: d.modul.anzahl, wpJeModul: d.modul.wp_je_modul, breite: d.modul.breite_m, hoehe: d.modul.hoehe_m, aufstellung: st.annahmen.aufstellung});
    if (neu && schmal()) E.scrollIntoView({behavior: 'smooth', block: 'start'});
  }, 30));
}

// ---------------------------------------------------------------- Annahmen
function baueAnnahmen() {
  $('personen').innerHTML = PARAMS.haushalte.map(h => `<label><input type="radio" name="personen" value="${h.personen}"><span>${h.label}</span></label>`).join('');
  $('zuhause').innerHTML = PARAMS.zuhauseStufen.map(z => `<label><input type="radio" name="zuhause" value="${z.wert}"><span>${z.label}</span></label>`).join('');
  const preis = $('preis');
  preis.min = PARAMS.strompreisMinCt; preis.max = PARAMS.strompreisMaxCt;
  syncWahl();
  let tmr;
  preis.addEventListener('input', () => {
    const v = parseFloat(String(preis.value).replace(',', '.'));
    if (!Number.isFinite(v) || v < PARAMS.strompreisMinCt || v > PARAMS.strompreisMaxCt) return;
    st.annahmen.strompreisCt = v; speichereAnnahmen(st.annahmen);
    clearTimeout(tmr); tmr = setTimeout(neuRechnenLokal, 250);
  });
  for (const name of ['personen', 'zuhause']) document.querySelectorAll(`input[name=${name}]`).forEach(i => i.addEventListener('change', () => {
    st.annahmen[name] = +i.value; speichereAnnahmen(st.annahmen); neuRechnenLokal();
  }));
  document.querySelectorAll('input[name=module]').forEach(i => i.addEventListener('change', () => {
    st.annahmen.module = +i.value; st.moduleExplizit = true; speichereAnnahmen(st.annahmen); hashSchreiben(false); berechne();
  }));
  document.querySelectorAll('input[name=aufstellung]').forEach(i => i.addEventListener('change', () => {
    st.annahmen.aufstellung = i.value; speichereAnnahmen(st.annahmen); hashSchreiben(false); berechne();
  }));
}
function syncWahl() {
  const a = st.annahmen;
  $('preis').value = a.strompreisCt;
  const setz = (name, v) => document.querySelectorAll(`input[name=${name}]`).forEach(i => { i.checked = String(i.value) === String(v); });
  setz('personen', a.personen); setz('zuhause', a.zuhause); setz('module', a.module); setz('aufstellung', a.aufstellung);
  setzeKontext({module: a.module, aufstellung: a.aufstellung});
}
function setzeWahlAktiv(an) { document.querySelectorAll('input[name=module], input[name=aufstellung]').forEach(i => { i.disabled = !an; }); }
function neuRechnenLokal() {
  if (!st.antwort) return;
  zeigeErgebnis(E, st.antwort, st.annahmen, {adresse: st.adresse ? adressText(st.adresse) : '', grob: st.grob});
}

// ---------------------------------------------------------------- Start
const suche = bindeSuche({
  form: $('suche'), input: $('adresse'), liste: $('vorschlaege'), status: $('suche-status'),
  onWahl: a => adresseGewaehlt(a, {push: true}),
});
initSchritte();
initSonne();
baueAnnahmen();
document.querySelectorAll('input[name=modus]').forEach(i => i.addEventListener('change', () => setzeModus(i.value)));
baueRichtungen();
$('andere-adresse').addEventListener('click', () => { $('adresse').select(); $('adresse').focus(); window.scrollTo({top: 0, behavior: 'smooth'}); });
$('ohne3d-link').addEventListener('click', () => { grobModus(); $('richtungen').querySelector('input').focus(); });
$('nochmal').addEventListener('click', () => berechne());
$('link-rechnung').addEventListener('click', () => { $('rechnung').open = true; });
window.addEventListener('popstate', anwenden);
// Seiteninterne Links (#schritte, #rechnung, #inhalt) scrollen nur, ohne den Zustand im Hash zu überschreiben
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[href^="#"]');
  if (!a || a.getAttribute('href').length < 2) return;
  const ziel = document.getElementById(a.getAttribute('href').slice(1));
  if (!ziel) return;
  e.preventDefault();
  if (ziel.tagName === 'DETAILS') ziel.open = true;
  ziel.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start'});
  if (!ziel.hasAttribute('tabindex')) ziel.setAttribute('tabindex', '-1');
  ziel.focus({preventScroll: true});
});

ladeAdressen().then(D => {
  if (D) $('gebiet').textContent = `Bisher verfügbar für ${gebietText(D)}. Weitere Kieze folgen.`;
});
if (location.hash.length > 1) anwenden();
