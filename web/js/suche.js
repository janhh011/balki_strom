// Adresssuche – läuft komplett im Browser auf web/adressen.json (erzeugt von pipeline/adressen.py)
// Kann: Tippfehler, Teil-Eingaben, "Str."/"Straße"/"Strasse", fehlende Umlaute/ß, Hausnummer genau zuerst
// (5 ≠ 50), Zusätze (24a / 24 a), Postleitzahl als weicher Filter. Bedienung als ARIA-Combobox.

let datenP = null;
export function ladeAdressen() {
  if (!datenP) datenP = fetch('adressen.json', {cache: 'default'})
    .then(r => (r.ok ? r.json() : null))
    .then(d => (d ? index(d) : null))
    .catch(() => null);
  return datenP;
}

// Normalform: klein, ß->ss, Umlaute->Grundbuchstabe (auch ae/oe/ue), "str." -> "strasse", Satzzeichen weg
export const norm = s => String(s).toLowerCase()
  .replace(/ß/g, 'ss').replace(/straße/g, 'strasse')
  .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-zäöü]{2,})/g, '$1 $2')
  .replace(/str\.?(\s|$|,)/g, 'strasse$1').replace(/\bstr\b/g, 'strasse')
  .replace(/[äöü]/g, c => ({ä: 'a', ö: 'o', ü: 'u'}[c])).replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
  .replace(/[éèê]/g, 'e').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function index(d) {
  const adressen = [], strassen = [];
  for (const [s, liste] of d.strassen || []) {
    const sn = norm(s), st = {name: s, woerter: sn.split(' '), kompakt: sn.replace(/ /g, ''), adressen: []};
    for (const [n, p, x, y] of liste) {
      const hn = norm(n).replace(/\s+/g, '');
      const a = {s, n, p, x, y, hn, basis: (hn.match(/^\d+/) || [''])[0], strasse: st};
      st.adressen.push(a); adressen.push(a);
    }
    strassen.push(st);
  }
  return {gebiete: d.gebiete || [], quelle: d.quelle, adressen, strassen};
}

// Anfrage zerlegen: Straßenwörter, Hausnummer (auch "24 a" -> "24a"), Postleitzahl; "Berlin" ignorieren
export function zerlege(q) {
  const t = norm(q).split(' ').filter(w => w && w !== 'berlin');
  const strasse = [], plz = [];
  let nr = null;
  for (let i = 0; i < t.length; i++) {
    const w = t[i];
    if (/^\d{5}$/.test(w)) { plz.push(w); continue; }
    if (/^\d{1,4}[a-z]?$/.test(w) && nr === null) {
      nr = w;
      if (/^\d+$/.test(w) && /^[a-z]$/.test(t[i + 1] || '')) { nr += t[i + 1]; i++; }
      continue;
    }
    if (/^\d/.test(w)) continue;               // zweite Zahl, z. B. "24-26"
    strasse.push(w);
  }
  return {strasse, nr, plz};
}

// Tippfehler: Damerau-Levenshtein (benachbarte Vertauschung zählt 1)
function abstand(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 9;
  const d = Array.from({length: m + 1}, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
const toleranz = w => (w.length < 4 ? 0 : w.length < 8 ? 1 : 2);

// Wie gut passt die Straße? 0 = gar nicht
function strassenPunkte(st, qw) {
  if (!qw.length) return 1;
  if (qw.every(w => st.woerter.some(x => x.startsWith(w)))) return 3;
  const qc = qw.join('');
  if (qc.length >= 3 && st.kompakt.includes(qc)) return 2.5;
  // unscharf: jedes Wort ähnelt dem Anfang eines Straßenworts
  let fehler = 0;
  const ok = qw.every(w => {
    const tol = toleranz(w);
    if (!tol) return st.woerter.some(x => x.startsWith(w));
    let best = 9;
    for (const x of st.woerter) best = Math.min(best, abstand(w, x.slice(0, w.length)), abstand(w, x));
    fehler += best;
    return best <= tol;
  });
  if (ok) return 2 - 0.2 * fehler;
  const tol = toleranz(qc);
  if (tol && abstand(qc, st.kompakt.slice(0, qc.length)) <= tol) return 1.4;
  return 0;
}

const MAX = 7;
// Ergebnis: Array von Adressen; .genau = Hausnummer exakt getroffen; .nrFehlt = Nummer gibt es nicht (Nachbarn angeboten)
export function suche(D, q) {
  const leer = Object.assign([], {genau: false});
  if (!D) return null;
  const {strasse, nr, plz} = zerlege(q);
  if (!strasse.length && !nr && !plz.length) return leer;
  // Straßen bewerten
  let kandidaten = D.strassen.map(st => ({st, p: strassenPunkte(st, strasse)})).filter(k => k.p > 0);
  if (!kandidaten.length) return leer;
  const top = Math.max(...kandidaten.map(k => k.p));
  kandidaten = kandidaten.filter(k => k.p >= Math.min(top, 2) - 0.6).sort((a, b) => b.p - a.p || a.st.name.localeCompare(b.st.name, 'de'));
  const finde = filter => {
    const pool = kandidaten.flatMap(k => k.st.adressen.filter(filter));
    if (!nr) {
      // nur Straße: je Straße die ersten Nummern (bei mehreren Straßen erst eine je Straße)
      if (kandidaten.length > 1) {
        const je = kandidaten.map(k => k.st.adressen.find(filter)).filter(Boolean);
        return Object.assign(je.slice(0, MAX), {genau: false, nurStrasse: true});
      }
      return Object.assign(pool.slice(0, MAX), {genau: false, nurStrasse: true});
    }
    const genau = pool.filter(e => e.hn === nr);
    const zusatz = pool.filter(e => e.hn !== nr && /^\d+$/.test(nr) && e.basis === nr);
    const ohneZusatz = /[a-z]$/.test(nr) ? pool.filter(e => e.hn === nr.replace(/[a-z]$/, '')) : [];
    const anfang = pool.filter(e => e.hn !== nr && e.basis !== nr && e.hn.startsWith(nr));
    let t = [...genau, ...zusatz, ...ohneZusatz, ...anfang];
    let nrFehlt = false;
    if (!t.length && pool.length && strasse.length) {
      // Nummer gibt es (in den Daten) nicht: nächstgelegene Nummern derselben Straße anbieten
      const n = parseInt(nr, 10);
      t = [...pool].sort((a, b) => Math.abs(parseInt(a.basis || 0, 10) - n) - Math.abs(parseInt(b.basis || 0, 10) - n)).slice(0, 5);
      nrFehlt = true;
    }
    return Object.assign(t.slice(0, MAX), {genau: genau.length > 0, nrFehlt});
  };
  // Postleitzahl nur als Filter, solange sie nicht alle Treffer verwirft
  if (plz.length) {
    const mit = finde(e => plz.includes(e.p));
    if (mit.length && !mit.nrFehlt) return mit;
  }
  return finde(() => true);
}

export const adressText = a => `${a.s} ${a.n}`;

export function findeGenau(D, s, n) {
  if (!D) return null;
  return D.adressen.find(a => a.s === s && a.n === n) || null;
}

export function gebietText(D) {
  if (!D || !D.gebiete.length) return '';
  const namen = [...new Set(D.gebiete.map(g => g.name).filter(Boolean))];
  const str = D.strassen.map(s => s.name);
  const bsp = str.slice(0, 4).join(', ') + (str.length > 4 ? ' …' : '');
  return `${namen.join(', ') || 'das Testgebiet'} (${bsp})`;
}

// ---------------------------------------------------------------- Combobox
// form, input, liste (ul), status (aria-live) -> onWahl(adresse)
export function bindeSuche({form, input, liste, status, onWahl}) {
  let treffer = [], aktiv = -1, tmr = 0, letzte = '';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

  const schliessen = () => {
    liste.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); aktiv = -1;
  };
  const markiere = i => {
    const lis = [...liste.querySelectorAll('[role=option]')];
    aktiv = i;
    lis.forEach((l, k) => l.setAttribute('aria-selected', String(k === i)));
    if (lis[i]) { input.setAttribute('aria-activedescendant', lis[i].id); lis[i].scrollIntoView({block: 'nearest'}); }
    else input.removeAttribute('aria-activedescendant');
  };

  async function zeige(q) {
    const D = await ladeAdressen();
    if (input.value !== q) return;              // veraltet
    treffer = suche(D, q);
    liste.textContent = ''; aktiv = -1;
    const info = html => { const li = document.createElement('li'); li.className = 'info'; li.innerHTML = html; liste.appendChild(li); };
    if (!q.trim()) { schliessen(); status.textContent = ''; return; }
    if (treffer === null) {
      info('Die Adresssuche konnte nicht laden. Lade die Seite bitte neu.');
      status.textContent = 'Die Adresssuche konnte nicht laden.';
    } else if (!treffer.length) {
      info(`<b>Diese Adresse ist noch nicht dabei.</b> Bisher gibt es balki strom nur für ${esc(gebietText(D))}. Weitere Kieze kommen dazu. Prüf sonst die Schreibweise.`);
      status.textContent = 'Keine passende Adresse im bisherigen Gebiet.';
    } else {
      if (treffer.nrFehlt) info('Diese Hausnummer gibt es hier nicht. Meintest du:');
      treffer.forEach((a, i) => {
        const li = document.createElement('li');
        li.id = `vorschlag-${i}`; li.setAttribute('role', 'option'); li.setAttribute('aria-selected', 'false');
        li.innerHTML = `<span class="v-str">${esc(a.s)} ${esc(a.n)}</span><span class="v-ort">${esc(a.p)} Berlin</span>`;
        li.addEventListener('mousedown', e => e.preventDefault());
        li.addEventListener('click', () => nimm(a));
        liste.appendChild(li);
      });
      status.textContent = `${treffer.length} ${treffer.length === 1 ? 'Vorschlag' : 'Vorschläge'}. Mit Pfeiltasten auswählen.`;
    }
    liste.hidden = false; input.setAttribute('aria-expanded', 'true');
  }

  function nimm(a) {
    input.value = adressText(a); letzte = input.value;
    schliessen(); status.textContent = `${adressText(a)} gewählt.`;
    onWahl(a);
  }

  input.addEventListener('focus', () => ladeAdressen(), {once: true});
  input.addEventListener('input', () => {
    clearTimeout(tmr);
    const q = input.value;
    tmr = setTimeout(() => zeige(q), 60);
  });
  input.addEventListener('keydown', e => {
    const n = liste.querySelectorAll('[role=option]').length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (liste.hidden && input.value.trim()) { zeige(input.value); return; }
      if (!n) return;
      markiere((aktiv + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (e.key === 'Escape') {
      if (!liste.hidden) { e.preventDefault(); schliessen(); }
      else input.value = '';
    }
  });
  input.addEventListener('blur', () => setTimeout(schliessen, 150));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const D = await ladeAdressen();
    const t = suche(D, input.value);
    if (t && t.length && aktiv >= 0 && t[aktiv]) return nimm(t[aktiv]);
    if (t && t.length && !t.nrFehlt && !t.nurStrasse && (t.genau || t.length === 1)) return nimm(t[0]);
    await zeige(input.value);
    if (!liste.hidden) markiere(-1);
  });
  return {setze: a => { input.value = a ? adressText(a) : ''; letzte = input.value; }, get letzte() { return letzte; }};
}
