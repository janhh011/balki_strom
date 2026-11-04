# Mitmachen

Danke für dein Interesse. Fehlerberichte, Vorschläge und Pull Requests sind willkommen.

## Fehler melden und Ideen vorschlagen

Öffne ein [Issue](https://github.com/janhh011/balki_strom/issues). Hilfreich sind: Adresse oder Kachel, Gerät und Browser, was du erwartet hast und was passiert ist, bei Darstellungsfehlern ein Screenshot. Gemessene Jahreserträge echter Balkonkraftwerke (Ort, Ausrichtung, Module, kWh) helfen, die Rechnung zu prüfen.

Sicherheitslücken bitte **nicht** als Issue melden, sondern wie in [SECURITY.md](SECURITY.md) beschrieben.

## Lokal starten

```bash
pip install -r requirements.txt
python3 pipeline/kachel.py data/<kachel-ordner>   # Mesh-Kachel aus dem Berlin 3D-Downloadportal
python3 pipeline/adressen.py
python3 server/app.py                             # http://127.0.0.1:8000
```

Nur die Oberfläche, ohne Kachel und Server: `python3 -m http.server -d web 8000` und `http://127.0.0.1:8000/?attrappe=1` öffnen. Die 3D-Ansicht und die API werden dann durch Testdaten ersetzt.

## Tests

```bash
python3 tests/test_rechner.py
```

Die Tests bauen eine synthetische Szene (zwei Häuser, ein Balkon) und brauchen keine echte Kachel. Wer die Rechnung in `balki/` ändert, ergänzt einen Test.

## Regeln für den Code

- **Deutsche Bezeichner** für Funktionen, Variablen und Kommentare, wie im übrigen Code (`ertrag`, `kachel`, `zeigeOrt`). Nutzertexte in einfacher Sprache und per Du, siehe [docs/STYLEGUIDE.md](docs/STYLEGUIDE.md).
- **Keine externen Ressourcen zur Laufzeit.** Keine CDNs, keine Webfonts von Dritten, keine Karten- oder Geocoding-Dienste im Browser. Bibliotheken werden unter `web/vendor/` selbst gehostet.
- **Kein Tracking, keine Cookies, keine Speicherung personenbezogener Daten.** Der Server bekommt nur, was er für die Rechnung braucht.
- **Wenige Abhängigkeiten.** Der Server nutzt die Python-Standardbibliothek plus numpy, pandas, pvlib und pyproj. Neue Abhängigkeiten bitte im Pull Request begründen.
- **Schnittstellen** (`tiles.json`, Viewer, `/api/ertrag`) sind in [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) festgelegt. Wer sie ändert, passt das Dokument mit an.
- Fehlertexte für Nutzer\*innen sind verständliche deutsche Sätze ohne technische Details.

## Pull Requests

1. Fork anlegen und einen Branch vom aktuellen Stand erstellen.
2. Kleine, in sich geschlossene Änderungen; eine Sache pro Pull Request.
3. Tests laufen lassen, die Seite im Browser prüfen, bei Oberflächenänderungen auch bei 320 px Breite.
4. Pull Request mit kurzer Beschreibung öffnen: was, warum, wie getestet.

Mit einem Beitrag stimmst du zu, dass er unter der [GNU AGPL-3.0](LICENSE) veröffentlicht wird.
