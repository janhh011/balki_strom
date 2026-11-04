// Alle Annahmen der Wirtschaftlichkeitsrechnung an einer Stelle (Stand Oktober/November 2026).
// Werte sind Richtwerte, keine Kaufempfehlung. Bei Änderungen: Datum in STAND anpassen.

export const STAND = 'November 2026';

export const PARAMS = {
  // Arbeitspreis laut Stromrechnung (ohne Grundgebühr), ct/kWh. Berliner Haushaltstarife Okt. 2026 ≈ 32–40 ct.
  strompreisCt: 37,
  strompreisMinCt: 15,
  strompreisMaxCt: 80,

  // Haushaltsgröße -> Jahresverbrauch (kWh), wie im alten Angebot (angebot.html)
  haushalte: [
    {personen: 1, kwh: 1500, label: '1'},
    {personen: 2, kwh: 2500, label: '2'},
    {personen: 3, kwh: 3200, label: '3'},
    {personen: 4, kwh: 4000, label: '4+'},
  ],
  personen: 2,

  // tagsüber zu Hause: Anteil der Werktage (lastgang.js, Parameter "zuhause")
  zuhauseStufen: [
    {wert: 0, label: 'selten'},
    {wert: 0.4, label: 'teils'},
    {wert: 1, label: 'meist'},
  ],
  zuhause: 0.4,

  // Ausstattung (an /api/ertrag)
  module: 2,                  // 1 oder 2
  aufstellung: 'senkrecht',   // 'senkrecht' (am Geländer) | 'geneigt' (30° ausgestellt)

  // Typisches Set inkl. Halterung, Endpreis (0 % MwSt. seit 2023). Spanne + typischer Wert (€).
  // Alte Richtpreise (angebot.html, Okt. 2026): 1 Modul 179 € + 59 € Halterung, 2 Module 269–329 € + 99 € Halterung.
  kosten: {
    1: {min: 200, typisch: 250, max: 350},
    2: {min: 300, typisch: 400, max: 550},
  },
  kostenGeneigtAufschlag: 40,   // ausstellbare Halterung kostet meist etwas mehr (€)

  // Langfristige Rechnung
  jahre: 20,                  // Betrachtungszeitraum
  strompreisSteigerung: 0.02, // pro Jahr
  degradation: 0.005,         // Modulleistung pro Jahr
  wechselrichterMaxW: 800,    // gesetzliche Grenze für Steckersolargeräte (Einspeiseleistung)

  // Grobe Schätzung ohne 3D (kein WebGL / ohne Tippen): Verschattung typischer Berliner Altbauhöfe/Straßen
  grobVerschattung: 0.3,
};

// Laden/Speichern der vom Nutzer geänderten Annahmen (nur im eigenen Browser, freiwillig)
const KEY = 'balki-annahmen-v1';
const ERLAUBT = ['strompreisCt', 'personen', 'zuhause', 'module', 'aufstellung'];

export function ladeAnnahmen() {
  const a = {};
  for (const k of ERLAUBT) a[k] = PARAMS[k];
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && typeof s === 'object') {
      if (Number.isFinite(s.strompreisCt) && s.strompreisCt >= PARAMS.strompreisMinCt && s.strompreisCt <= PARAMS.strompreisMaxCt) a.strompreisCt = s.strompreisCt;
      if (PARAMS.haushalte.some(h => h.personen === s.personen)) a.personen = s.personen;
      if (PARAMS.zuhauseStufen.some(z => z.wert === s.zuhause)) a.zuhause = s.zuhause;
      if (s.module === 1 || s.module === 2) a.module = s.module;
      if (s.aufstellung === 'senkrecht' || s.aufstellung === 'geneigt') a.aufstellung = s.aufstellung;
    }
  } catch { /* privates Fenster, gesperrt – egal */ }
  return a;
}

export function speichereAnnahmen(a) {
  try {
    const o = {};
    for (const k of ERLAUBT) o[k] = a[k];
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch { /* egal */ }
}

export const kwhFuer = personen => (PARAMS.haushalte.find(h => h.personen === personen) || PARAMS.haushalte[1]).kwh;
