// Alle Annahmen der Wirtschaftlichkeitsrechnung an einer Stelle (Stand Oktober/November 2026).
// Werte sind Richtwerte, keine Kaufempfehlung. Bei Änderungen: Datum in STAND anpassen.

export const STAND = 'November 2026';

export const PARAMS = {
  // Arbeitspreis laut Stromrechnung (ohne Grundgebühr), ct/kWh. Recherche Nov. 2026 für Berlin:
  // günstige Neukundentarife ≈ 31 ct (Verivox/Lichtblick Okt. 2026), Grundversorgung Vattenfall ≈ 38 ct
  // (4.11.2026). Viele Mieter*innen haben ältere Verträge oder Grundversorgung -> Mittelwert 35 ct.
  strompreisCt: 35,
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
  // Recherche Nov. 2026: 800-W-Komplettsets ohne Speicher meist 250–500 € (ADAC), Händlerangebote ab ~270 €;
  // gute Sets 350–600 € (Balkonkraftwerk-Kompendium). Einzelmodul-Sets entsprechend günstiger.
  kosten: {
    1: {min: 180, typisch: 230, max: 300},
    2: {min: 250, typisch: 350, max: 500},
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

// Annahmen werden NICHT im Browser gespeichert (kein localStorage, keine Cookies): jeder Besuch
// startet mit den Standardwerten. Ausstattung (Module, Aufstellung) steht im Link hinter "#".
const ERLAUBT = ['strompreisCt', 'personen', 'zuhause', 'module', 'aufstellung'];

export function ladeAnnahmen() {
  const a = {};
  for (const k of ERLAUBT) a[k] = PARAMS[k];
  return a;
}

export function speichereAnnahmen() { /* bewusst leer: nichts auf dem Gerät speichern */ }

export const kwhFuer = personen => (PARAMS.haushalte.find(h => h.personen === personen) || PARAMS.haushalte[1]).kwh;
