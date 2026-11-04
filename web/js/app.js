// balki strom – Ablauf der Seite: Adresse -> Haus in 3D -> Balkon antippen -> Ergebnis -> Schritte
// Zustand steht im URL-Hash (#a=Straße|Nr&p=kachel,x,y,z,nx,ny,nz&m=2&g=senkrecht | &r=180 für die grobe Schätzung),
// damit Neuladen und Zurück funktionieren. Annahmen (Strompreis, Haushalt) merkt sich nur der eigene Browser.
import { ladeAdressen, bindeSuche, findeGenau, adressText, gebietText } from './suche.js';
import { ertrag, schaetzeJahr, richtungAus, ErtragsFehler } from './api.js';
import { zeigeErgebnis, zeigeLaden, zeigeFehler } from './ergebnis.js';
import { PARAMS, ladeAnnahmen, speichereAnnahmen } from './params.js';
import { initSchritte, setzeKontext } from './schritte.js';

const $ = id => document.getElementById(id);
const Q = new URLSearchParams(location.search);
const LOKAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);   // Testmodus nur lokal
const ATTRAPPE_VIEWER = LOKAL && (Q.get('attrappe') === '1' || Q.get('attrappe') === 'viewer');
const schmal = () => matchMedia('(max-width: 999px)').matches;

const st = {
  adresse: null, punkt: null, grobAz: null, antwort: null, grob: false,
  annahmen: ladeAnnahmen(), kein3d: false, viewer: null, viewerP: null, abbruch: null,
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
  if (st.grob && st.grobAz != null) h.set('r', String(st.grobAz));
  if (st.punkt || st.grob) { h.set('m', String(st.annahmen.module)); h.set('g', st.annahmen.aufstellung); }
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
  if (h.get('g') === 'senkrecht' || h.get('g') === 'geneigt') out.g = h.get('g');
  return out;
}

async function anwenden() {
  const h = hashLesen();
  if (h.m) st.annahmen.module = h.m;
  if (h.g) st.annahmen.aufstellung = h.g;
  syncWahl();
  if (!h.s) { zurueckZumStart(false); return; }
  const D = await ladeAdressen();
  const a = findeGenau(D, h.s, h.n);
  if (!a) { zurueckZumStart(false); return; }
  if (!st.adresse || st.adresse !== a) await adresseGewaehlt(a, {push: false, fokus: false});
  if (h.punkt) { st.grob = false; await bereit(); balkonGewaehlt(h.punkt, {push: false}); }
  else if (h.r != null) { grobModus(); waehleRichtung(h.r, {push: false}); }
  else if (st.punkt || st.grob) {
    // zurück zu "noch kein Balkon gewählt"
    if (st.abbruch) st.abbruch.abort();
    st.punkt = null; st.grob = false; st.antwort = null;
    if (st.viewer) { st.viewer.zeigeMarker(null); st.viewer.zeigeModule(null); }
    ergebnisWarten();
  }
}

// ---------------------------------------------------------------- 1. Adresse
function zurueckZumStart(fokus = true) {
  st.adresse = null; st.punkt = null; st.antwort = null; st.grob = false;
  document.body.classList.remove('hat-adresse');
  $('arbeit').hidden = true;
  suche.setze(null);
  setzeKontext({adresse: null});
  if (fokus) $('adresse').focus();
}

async function adresseGewaehlt(a, {push = true, fokus = true} = {}) {
  if (st.abbruch) st.abbruch.abort();
  st.adresse = a; st.punkt = null; st.antwort = null; st.grob = false; st.grobAz = null;
  if (st.viewer) { st.viewer.zeigeMarker(null); st.viewer.zeigeModule(null); }
  suche.setze(a);
  document.body.classList.add('hat-adresse');
  $('arbeit').hidden = false;
  $('haus-adresse').textContent = `${adressText(a)}, ${a.p} Berlin`;
  if (!st.kein3d) { $('ohne3d').hidden = true; $('ohne3d-link').parentElement.hidden = false; $('haus-titel').textContent = 'Tippe auf deinen Balkon'; }
  $('richtungen').querySelectorAll('input').forEach(i => { i.checked = false; });
  ergebnisWarten();
  setzeKontext({adresse: a});
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
  } else if (v.ort && v.ort.haus === 'umgebung') {
    zeigeHinweis('Dein Haus liegt am Rand des 3D-Modells und ist nur vereinfacht zu sehen. Du kannst trotzdem auf die Wand tippen.');
  }
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
      mod = ATTRAPPE_VIEWER ? await import('./viewer-attrappe.js') : await import('./viewer.js');
    } catch (e) {
      console.warn('Viewer-Modul nicht ladbar', e);
      ohne3d('Die 3D-Ansicht konnte nicht laden', 'Vielleicht ist die Verbindung gerade schwach. Lade die Seite später neu – oder schätze hier grob: Wohin zeigt dein Balkon?');
      return null;
    }
    try {
      const v = await mod.erstelleViewer($('viewer'), {manifest: 'tiles/tiles.json', qualitaet: 'auto'});
      v.beiStatus(statusAnzeigen);
      v.beiAuswahl(p => balkonGewaehlt(p, {push: false}));
      if (typeof v.beiFehlgriff === 'function') v.beiFehlgriff(fehlgriff);
      st.viewer = v;
      laden.hidden = true;
      return v;
    } catch (e) {
      const keinWebgl = e && (e.name === 'ViewerNichtVerfuegbar' || (mod.ViewerNichtVerfuegbar && e instanceof mod.ViewerNichtVerfuegbar));
      if (!keinWebgl) console.warn('Viewer-Fehler', e);
      ohne3d(keinWebgl ? 'Dein Gerät kann die 3D-Ansicht leider nicht zeigen' : 'Die 3D-Ansicht konnte nicht starten',
        'Kein Problem – eine grobe Schätzung geht trotzdem. Wohin zeigt dein Balkon?');
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
  $('viewer-tipp').hidden = ladend || !!st.punkt;
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
  st.grob = true; st.grobAz = az; st.punkt = null;
  const r = $('richtungen').querySelector(`input[value="${az}"]`); if (r) r.checked = true;
  if (st.viewer) { st.viewer.zeigeMarker(null); st.viewer.zeigeModule(null); }
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
  dach: 'Das ist ein Dach – tippe auf die Hauswand oder das Geländer deines Balkons.',
  boden: 'Das ist der Boden – tippe auf die Hauswand oder das Geländer deines Balkons.',
  baum: 'Da ist ein Baum im Weg – dreh das Haus ein wenig und tippe auf deinen Balkon.',
  unscharf: 'Bitte etwas näher heranzoomen und dann auf deinen Balkon tippen.',
  leer: 'Da ist nichts – tippe auf die Hauswand oder das Geländer deines Balkons.',
};
let meldungTmr = 0;
function fehlgriff({art} = {}) {
  const m = $('viewer-meldung');
  m.textContent = FEHLGRIFF[art] || FEHLGRIFF.leer;
  m.hidden = false;
  clearTimeout(meldungTmr);
  meldungTmr = setTimeout(() => { m.hidden = true; }, 4000);
}
function zeigeHinweis(text) { const h = $('viewer-hinweis'); h.textContent = text; h.hidden = false; }

function balkonGewaehlt(p, {push}) {
  $('viewer-meldung').hidden = true;
  st.punkt = p; st.grob = false;
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
  try {
    const d = await ertrag({...st.punkt, module: st.annahmen.module, aufstellung: st.annahmen.aufstellung}, {signal: ctl.signal});
    if (ctl.signal.aborted) return;
    st.antwort = d;
    if (st.viewer && Array.isArray(d.module)) st.viewer.zeigeModule(d.module);
    render(false, true);
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
    setzeKontext({module: d.modul.anzahl, wpJeModul: d.modul.wp_je_modul, breite: d.modul.breite_m, hoehe: d.modul.hoehe_m, aufstellung: st.annahmen.aufstellung});
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
    st.annahmen.module = +i.value; speichereAnnahmen(st.annahmen); hashSchreiben(false); berechne();
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
baueAnnahmen();
baueRichtungen();
$('andere-adresse').addEventListener('click', () => { $('adresse').select(); $('adresse').focus(); window.scrollTo({top: 0, behavior: 'smooth'}); });
$('ohne3d-link').addEventListener('click', () => { grobModus(); $('richtungen').querySelector('input').focus(); });
$('nochmal').addEventListener('click', () => berechne());
$('link-rechnung').addEventListener('click', () => { $('rechnung').open = true; });
window.addEventListener('popstate', anwenden);

ladeAdressen().then(D => {
  if (D) $('gebiet').textContent = `Bisher verfügbar für ${gebietText(D)}. Weitere Kieze folgen.`;
});
if (location.hash.length > 1) anwenden();
