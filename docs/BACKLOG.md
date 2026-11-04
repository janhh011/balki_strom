# Backlog

Stand: 04.11.2026 · Mesh-Version. Offene Punkte, Ideen und bekannte Grenzen an einer Stelle.
Erledigtes steht in der Git-Historie. Größere Punkte werden bei Bedarf als GitHub-Issue angelegt
und hier verlinkt.

**Priorität:** P1 = vor dem öffentlichen Start · P2 = bald danach · P3 = Idee / später
**Aufwand:** S = Stunden · M = 1–2 Tage · L = mehrere Tage

## Vor dem öffentlichen Start

| ID | Thema | Bereich | Prio | Aufwand | Verantwortlich |
|---|---|---|---|---|---|
| B-01 | Platzhalter in Impressum, Datenschutz, Barrierefreiheit ausfüllen (Anschrift, E-Mail, Hoster, Domain) | Recht | P1 | S | Betreiber |
| B-02 | Schriftliche Bestätigung des Mesh-Anbieters zur nicht kommerziellen Nutzung inkl. genauer Quellenangabe; Text in Footer, Impressum, Lizenzen übernehmen | Recht/Daten | P1 | S | Betreiber |
| B-03 | Entscheiden, ob drei aus dem Mesh abgeleitete Bilder aus der alten Git-Historie entfernt werden müssen (`docs/balkon.jpg`, `erkennung.jpg`, `karte.jpg`) | Recht | P1 | S | Betreiber |
| B-04 | Server einrichten nach `docs/BETRIEB.md` (VPS in Deutschland, AV-Vertrag, Caddy ohne Access-Log, systemd), Domain | Betrieb | P1 | M | Betreiber |
| B-05 | Test auf echten Geräten: älteres Android-Handy, iPhone, schwacher Laptop (Ladezeit, Bedienung, Hitze/Akku) | Qualität | P1 | S | Team |
| B-06 | 3D-Ansicht per Tastatur bedienbar (Balkonwahl ohne Maus/Touch); danach Barrierefreiheitserklärung aktualisieren | Barrierefreiheit | P1 | M | Entwicklung |
| B-07 | Kurzer Nutzertest mit 3–5 Mieter*innen (ohne Vorwissen): Finden sie Adresse, Balkon, Ergebnis, nächste Schritte? | UX | P1 | S | Team |

## Daten und Genauigkeit

| ID | Thema | Bereich | Prio | Aufwand | Notiz |
|---|---|---|---|---|---|
| D-01 | Kacheln rund um das **Zentrum Kreuzberg** verarbeiten, sobald das Berlin-3D-Portal wieder läuft (ein Befehl je Kachel) | Daten | P1 | S | Pilot mit Bezirksamt/Plan B 2030 |
| D-02 | Echtes Wetter: PVGIS-Referenzjahr (TMY) für Berlin statt synthetischem Jahr; Schnittstelle `--wetter` existiert | Rechnung | P2 | S | braucht einmalig Zugriff auf re.jrc.ec.europa.eu |
| D-03 | Validierung mit gemessenen Erträgen echter Balkonkraftwerke (z. B. aus dem Kreuzberg-Projekt); Genauigkeitsangabe danach belegen | Rechnung | P2 | M | Daten von Teilnehmenden, freiwillig |
| D-04 | Balkone, die im Mesh nur als Textur auf glatter Fassade existieren: Tiefe optional vom Nutzer angeben lassen (z. B. „Balkon ragt ca. 1,2 m vor“) | Rechnung/UX | P3 | M | Auswirkung auf Ertrag meist gering |
| D-05 | Bodenreflexion in engen Höfen an die Himmelssicht koppeln statt wie auf freiem Feld | Rechnung | P3 | S | |
| D-06 | Sonnenstunden wettergewichtet ausweisen (heute: direkte Sonne bei klarem Himmel) | Rechnung | P3 | S | |
| D-07 | Kleine Module (< 1,8 m Geländer) und Speicher als Variante | Rechnung | P3 | M | |
| D-08 | LoD2-Ring ausdünnen (heute 4,4 Mio. Punkte bei 0,6 m Abstand) – weniger Arbeitsspeicher je Kachel | Server | P2 | S | ~560 MB Spitze je Kachel |

## 3D-Ansicht und Bedienung

| ID | Thema | Bereich | Prio | Aufwand | Notiz |
|---|---|---|---|---|---|
| V-08 | **Bäume vor dem Balkon:** Rahmen oder Tippen trifft den Baum statt der Fassade; die Module landen am Baum. Lösungsideen: Raycast durch Baum-Dreiecke hindurch auf die Fassade (Bäume nur für die Auswahl ignorieren), Bäume beim Markieren halbtransparent oder ausblendbar („Bäume ausblenden“), Kamera bevorzugt Blickwinkel ohne Baum | Viewer/UX | P1 | M | Rückmeldung PO, 04.11.2026 |
| V-09 | **Zoomen zu träge** (Mac, Trackpad und Mausrad): Zoomgeschwindigkeit, Dämpfung und Trackpad-Pinch prüfen; auf echten Macs messen | Viewer | P1 | S | Rückmeldung PO |
| V-10 | **Kamera hängt vom Seitenverhältnis ab:** bei hohen Fenstern (z. B. 1280×1000, Adresse Pfalzburger Straße 21) fast Draufsicht statt Fassade. Ansatz: Kandidaten unabhängig vom Seitenverhältnis bewerten (festes vertikales Sichtfeld, Abstand so, dass die Fassade in beide Richtungen passt), maximale Neigung von oben begrenzen; testen bei 1280×700/800/1000/1300, 390×844, 768×1024 und Adressen in der Mitte und am Rand | Viewer | P1 | S | Angefangen, abgebrochen (04.11.2026); nicht übernommen |
| U-01 | **Ergebnisbereich neu ordnen:** Simulation steht im Mittelpunkt. Start/Pause und die aktuelle Leistung direkt im oder links neben dem 3D-Bild; die Rechnung rechts daneben, inhaltlich und optisch an der Simulation ausgerichtet | UX | P1 | M | Rückmeldung PO |
| U-02 | **Ausstattung sofort wählbar** (Module, Montage) direkt beim Ergebnis, nicht weiter unten | UX | P1 | S | Rückmeldung PO |
| U-03 | **Auf den ersten Blick eine Rechnung**, Details per Aufklappen: z. B. Ersparnis = Eigenverbrauch × Strompreis, Amortisation aus Kaufpreis und Ersparnis; jeweils „genauer ansehen“ für die ausführliche Rechnung | UX | P1 | M | Rückmeldung PO |
| V-01 | Häuser am Kachelrand: bessere Kameraposition, Hinweis klarer (heute graue LoD2-Blöcke, Blick fast von oben) | Viewer | P2 | M | entfällt teilweise mit Nachbarkacheln |
| V-02 | Fernansicht (vereinfachtes Mesh) wirkt von oben „verlaufen“ | Viewer | P3 | M | |
| V-03 | Wiederherstellung nach Verlust des WebGL-Kontexts testen | Viewer | P2 | S | Code vorhanden, ungetestet |
| V-04 | Hofseiten nur wählbar, wenn die Zellen geladen sind – Nachladen beim Drehen | Viewer | P2 | S | |
| V-05 | Sonnenverlauf als Schieberegler im Ergebnis (Viewer kann es schon: `setzeSonne`) | UX | P3 | S | „Wann scheint die Sonne auf meinen Balkon?“ |
| V-06 | Adresse vertippt oder Gebiet noch nicht abgedeckt unterscheiden (Liste aller Berliner Straßennamen, nur bei Fehlschlag laden) | UX | P3 | S | ~50 KB gzip |
| V-07 | Teilen-Link: kurzer Hinweis, dass der Link die Adresse enthält | Datenschutz/UX | P3 | S | |

## Betrieb und Entwicklung

| ID | Thema | Bereich | Prio | Aufwand | Notiz |
|---|---|---|---|---|---|
| E-01 | GitHub Actions: Tests (`tests/test_rechner.py`) und Syntaxprüfung bei jedem Push | Qualität | P2 | S | |
| E-02 | Browser-Ende-zu-Ende-Test (Playwright) ins Repo: Adresse → Balkon → Ergebnis | Qualität | P2 | S | Skript existiert lokal |
| E-03 | Abhängigkeiten mit Hashes festschreiben (`pip install --require-hashes`) | Sicherheit | P3 | S | |
| E-04 | Kachel-Releases versionieren (neue URL bei geänderten Daten), dann Kacheldateien `immutable` cachen | Betrieb | P3 | S | |
| E-05 | Alte Skripte aus der LoD2-/Claude-Version aufräumen (`pipeline/angebot.py`, `balkone_claude.py`, `fassaden_pipeline.py`, …) | Wartung | P3 | S | `kachel.py` nutzt noch Teile davon |

## Ideen für die Zusammenarbeit mit dem Bezirk

| ID | Thema | Prio | Notiz |
|---|---|---|---|
| I-01 | Flyer/Aushang mit QR-Code für Häuser im Projektgebiet | P2 | Styleguide hat Formate (gestapeltes Logo) |
| I-02 | „Solarbotschafter*innen-Modus“: mehrere Balkone eines Hauses nacheinander prüfen und als Übersicht ausdrucken | P3 | ohne Speicherung auf dem Server |
| I-03 | Leichte Sprache und englische Fassung | P3 | Berlin.de bietet Leichte Sprache an |
