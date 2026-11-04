# Architektur balki strom (Mesh-Version)

Stand: 04.11.2026. Ziel: **so einfach wie möglich.** Adresse eingeben → eigenes Haus in 3D sehen →
auf den Balkon tippen → Ertrag, Kosten, Amortisation → „So einfach geht's“ (Vermieter, Kauf, Montage,
Marktstammdatenregister). Kostenlos, ohne Anmeldung, ohne Cookies, ohne Tracking, nicht kommerziell.
Erwartete Last: höchstens ~10 gleichzeitige Nutzer.

## Grundentscheidungen

1. **Das Berliner 3D-Mesh ist die Hauptsache.** Nutzer sehen ihr echtes Haus mit Fototextur und tippen
   direkt auf ihren Balkon. Kein Wand-Auswählen, kein Rechteck-Zeichnen, keine KI-Balkonerkennung
   (keine API-Kosten, kein API-Key auf dem Server).
2. **Kacheln sind Pakete.** Eine heruntergeladene Mesh-Kachel wird mit **einem Befehl** zu einem
   statischen Web-Paket plus Server-Cache verarbeitet und in `web/tiles/tiles.json` eingetragen.
   Weitere Kacheln = denselben Befehl noch einmal ausführen.
3. **Schwache Geräte zuerst.** Der Browser lädt nur Zellen in der Nähe der Adresse, Geometrie
   quantisiert, Texturen in Stufen (2048 px für schwache Geräte, 4096 px sonst – nie 8192).
4. **Der Server rechnet nur den Ertrag** (Horizont + Jahressimulation, ~1 s). Alles andere ist statisch.
   Wirtschaftlichkeit (Eigenverbrauch, €, Amortisation) rechnet der Browser.
5. **Alle Koordinaten zwischen Modulen sind EPSG:25833** (x = Ost, y = Nord, z = Höhe DHHN2016, Meter).
   Lokale Ursprünge sind Sache des jeweiligen Moduls.

## Verzeichnisse

```
balki/                    Python-Paket (Server + Pipeline gemeinsam)
  physik.py               Wetter, Sonnenstand, Horizont, Ertrag (aus dem alten angebot.py übernommen)
  rechner.py              Tipp-Punkt + Normale -> Module -> Ertrag; lädt Server-Caches je Kachel
pipeline/
  kachel.py               "python3 pipeline/kachel.py data/<kachel-ordner>" -> Web-Paket + Server-Cache
  adressen.py             amtliche Hauskoordinaten für alle Kacheln aus tiles.json -> web/adressen.json
server/app.py             Statische Dateien aus web/ + POST /api/ertrag
web/                      Webroot (wird so ausgeliefert)
  index.html  css/  fonts/  vendor/three/
  js/app.js  js/suche.js  js/ergebnis.js  js/schritte.js  js/lastgang.js  js/params.js
  js/viewer.js
  tiles/                  ERZEUGT, nicht im Repo
    tiles.json
    <kachel-id>/ ...      Geometrie-Zellen, Texturstufen, meta.json
  adressen.json           ERZEUGT, nicht im Repo
data/                     NICHT im Repo
  <kachel-ordner>/        Rohkachel (OBJ, MTL, JPG) aus dem Berlin-3D-Downloadportal
  umgebung/               LoD2 + bDOM (offene Daten) für Schatten über den Kachelrand hinaus
  work/<kachel-id>/       Server-Cache: Punktwolke, Baum-Markierung, Gelände
```

## Schnittstellen

### `web/tiles/tiles.json` (von `pipeline/kachel.py` geschrieben)

```json
{
  "version": 1,
  "crs": "EPSG:25833",
  "kacheln": [
    {
      "id": "3858_58171",
      "name": "Wilmersdorf",
      "bounds": [385848.0, 5817143.6, 386226.2, 5817517.4],
      "url": "tiles/3858_58171/",
      "meta": "tiles/3858_58171/meta.json"
    }
  ]
}
```
Das Format von `meta.json` und den Zellen bestimmt allein `pipeline/kachel.py` + `web/js/viewer.js`.

### `web/js/viewer.js` (ES-Modul)

```js
import { erstelleViewer, ViewerNichtVerfuegbar } from './viewer.js';

const viewer = await erstelleViewer(containerElement, { manifest: 'tiles/tiles.json', qualitaet: 'auto' });
// qualitaet: 'auto' | 'niedrig' | 'hoch'; wirft ViewerNichtVerfuegbar, wenn kein WebGL

viewer.zeigeOrt(x, y);              // Kamera auf das Haus an dieser Adresse, bevorzugt von der Sonnenseite
viewer.beiAuswahl(cb);              // cb({kachel, x, y, z, nx, ny, nz}) beim Tippen auf eine Hauswand/einen Balkon
                                    // (Dach/Boden/Baum werden nicht gemeldet; Normale = Flächennormale, Einheitsvektor)
viewer.zeigeMarker(x, y, z | null); // Markierung am getippten Punkt (null = weg)
viewer.zeigeModule(module | null);  // module: [[[x,y,z] × 4 Ecken], ...] in EPSG:25833 – Solarmodule einblenden
viewer.setzeSonne(date);            // Sonnenstand (Berlin) für Datum/Uhrzeit, mit Schatten
viewer.beiStatus(cb);               // cb({ladend: bool, fortschritt: 0..1, text}) für Ladeanzeige
viewer.entsorge();
```

### `POST /api/ertrag` (Server)

Anfrage (JSON, höchstens 1 KB):
```json
{ "kachel": "3858_58171", "x": 386001.2, "y": 5817300.4, "z": 52.3, "nx": 0.02, "ny": -0.99,
  "module": 2, "aufstellung": "senkrecht" }
```
`module`: 1 oder 2. `aufstellung`: `"senkrecht"` (am Geländer) oder `"geneigt"` (30° ausgestellt).

Antwort 200:
```json
{
  "ok": true,
  "kachel": "3858_58171",
  "azimut": 182.4, "richtung": "Süd",
  "hoehe_ueber_boden_m": 9.8, "geschoss": 3,
  "module": [[[x, y, z], [x, y, z], [x, y, z], [x, y, z]], ...],
  "modul": {"anzahl": 2, "wp_je_modul": 430, "wp": 860, "breite_m": 1.72, "hoehe_m": 1.13},
  "kwh_jahr": 512.3, "kwh_jahr_frei": 640.0, "verschattung": 0.2,
  "monat_kwh": [12 Werte],
  "stunde_wh": [8760 Werte, Wechselrichter-Ausgang, Jahr 2025, Europe/Berlin],
  "sonnenstunden": 1234, "sonnenstunden_frei": 1600,
  "horizont": {"schritt_grad": 2, "gebaeude": [180 Werte], "baeume": [180 Werte]},
  "rand": false,
  "hinweise": ["…"],
  "wetter": "…", "annahmen": {…}
}
```
Fehler: `400 {"ok": false, "fehler": "<verständlicher deutscher Satz>"}`, `429` (zu viele Anfragen),
`503` (ausgelastet). Fehlertexte enthalten nie technische Details.

### Wirtschaftlichkeit (Browser, `web/js/ergebnis.js` + `lastgang.js` + `params.js`)

`stunde_wh` → minutengenauer Eigenverbrauch mit dem Haushaltsmodell aus `lastgang.js` → € pro Jahr,
Kosten des Sets (Richtwert-Spanne), Amortisation. Alle Annahmen sichtbar und änderbar
(Strompreis, Haushaltsgröße, tagsüber zu Hause).

## Schatten über den Kachelrand hinaus

Der Horizont reicht 220 m weit, eine Kachel ist nur ~380 m breit. Für Punkte außerhalb der Mesh-Kachel
nimmt die Pipeline LoD2-Gebäude und bDOM-Bäume (offene Daten, gdi.berlin.de, Datenlizenz Deutschland
– Zero 2.0) als Ersatz. Liegen Nachbarkacheln als Mesh vor, gehen sie vor.

## Datenschutz und Sicherheit (Kurzfassung)

- Keine Cookies, kein Tracking, keine externen Ressourcen (Schriften, three.js selbst gehostet).
- Adresssuche läuft vollständig im Browser; der Server sieht nur Koordinaten des getippten Punktes.
- Die E-Mail an den Vermieter wird im Browser erzeugt (`mailto:` / Kopieren) – nichts davon erreicht
  den Server.
- Server: strenge Eingabeprüfung, Ratenlimit je IP im Speicher, keine IPs in Logs der App.
- Hosting-Beispiel (Caddy + systemd) siehe Git-Historie dieser Datei (Stand Oktober 2026).
