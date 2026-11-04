# Bereitstellung: rechtliche und formale Checkliste

Stand: 04.11.2026. Ziel: balki strom öffentlich in Deutschland anbieten, sodass Berliner Stellen
(z. B. Bezirksamt Friedrichshain-Kreuzberg, Initiative „Balkonkraftwerke für Mieter*innen“) darauf
verlinken oder es bereitstellen können.

Legende: ✅ erledigt · ⬜ offen · **Wer:** Betreiber = Jan-Hendrik Höltkemeier, BA = Bezirksamt,
Hoster = Hosting-Anbieter. Platzhalter in den Seiten sind gelb markiert (`[Platzhalter: …]`).

> Diese Liste ist keine Rechtsberatung. Vor dem Start sollte jemand mit Rechtskenntnis
> (z. B. Rechtsamt/Datenschutzbeauftragte des BA oder Rechtsberatung der TU Berlin) drüberschauen.

## 1. Betreiber und Impressum (`web/impressum.html`)

- ✅ Seite nach § 5 DDG (ersetzt seit 14.05.2024 das TMG) und § 18 Abs. 2 MStV angelegt.
  Eine rein private Seite für Familie/Freunde bräuchte kein Impressum; ein dauerhaftes, öffentlich
  beworbenes Angebot gilt aber schnell als „geschäftsmäßig“ (auch ohne Entgelt). Daher: Impressum
  bereitstellen – das ist der sichere Weg.
- ⬜ **Betreiber:** ladungsfähige Anschrift (kein Postfach), E-Mail, Telefon eintragen
  (Impressum, Datenschutz, Barrierefreiheit). Telefon: alternativ ein anderer schneller
  Kontaktweg; E-Mail ist Pflicht.
  Tipp: Wer die Privatadresse nicht veröffentlichen will, kann einen Impressums-/Anschriftenservice
  mit ladungsfähiger Anschrift nutzen.
- ⬜ **Betreiber + BA:** klären, wer Betreiber ist. Bleibt es die Privatperson, gilt alles hier.
  Betreibt das BA selbst (eigener Server, eigene Domain, eigene Verantwortung), werden das BA bzw.
  das Land Berlin Anbieter und Verantwortlicher: dann Impressum, Datenschutz und
  Barrierefreiheitserklärung durch das BA ersetzen (siehe Abschnitt 5).
- ⬜ **Betreiber:** Hinweis „kein Angebot der TU Berlin“ mit der Uni abstimmen, falls das Projekt
  als Studienleistung gilt (Rechte an Ergebnissen, Logo-Nutzung – derzeit kein TU-Logo verwendet).
- ✅ Kein Link zur EU-OS-Plattform nötig (kein Unternehmer/Online-Händler; die Plattform wurde
  zudem am 20.07.2025 eingestellt). Kein Hinweis nach VSBG nötig (kein Unternehmer).

## 2. Datenschutz (DSGVO, TDDDG) (`web/datenschutz.html`)

- ✅ Datenschutzerklärung passend zum tatsächlichen Verhalten: keine Cookies, kein Tracking,
  keine Fremdinhalte, Adresssuche und Vermieter-E-Mail nur im Browser, Ertrags-Anfrage nur mit
  Punktkoordinaten, nicht gespeichert; Ratenlimit nur im Arbeitsspeicher; Beschwerderecht bei der
  Berliner Beauftragten für Datenschutz und Informationsfreiheit (Alt-Moabit 59–61, 10555 Berlin).
  Alter Text mit Platzhaltern ersetzt.
- ⬜ **Betreiber:** Hoster wählen und eintragen (Name, Anschrift, Rechenzentrum in Deutschland,
  z. B. Hetzner Falkenstein/Nürnberg).
- ⬜ **Betreiber + Hoster:** Vertrag zur Auftragsverarbeitung (AV-Vertrag, Art. 28 DSGVO)
  abschließen (bei Hetzner im Kundenkonto online möglich) und ablegen.
- ⬜ **Betreiber:** Caddy-Zugriffslog so konfigurieren, wie es in der Erklärung steht, oder Text
  anpassen: IP gekürzt (IPv4 /24, IPv6 /48), 7 Tage Aufbewahrung, danach automatisch löschen
  (logrotate/journald). Wenn kein Zugriffslog nötig ist: ganz abschalten und den Abschnitt kürzen.
  Danach Markierungen „[Zu bestätigen]“ entfernen.
- ✅ **Ratenlimit:** abgelaufene IP-Einträge werden jede Minute aus dem Speicher gelöscht; nach
  spätestens einer Stunde ist eine IP-Adresse nicht mehr im Speicher (`server/app.py`, `Begrenzer`).
- ✅ **Kein Speichern auf dem Gerät:** kein `localStorage`, keine Cookies; Annahmen gelten nur für den
  geöffneten Tab. Damit kein einwilligungspflichtiger Zugriff nach § 25 TDDDG.
- ✅ **Kein Cookie-Banner nötig:** keine Cookies, kein Speicher auf dem Gerät, kein Tracking, keine
  Drittinhalte. Ein Banner wäre irreführend.
- ⬜ **Betreiber:** Verzeichnis von Verarbeitungstätigkeiten (Art. 30 DSGVO): Die Ausnahme für
  < 250 Beschäftigte greift nicht bei nicht nur gelegentlicher Verarbeitung – Server-Logs laufen
  ständig. Ein kurzes Verzeichnis (1 Seite: Hosting/Logs, Ertrags-API) anlegen; Muster der
  Datenschutzkonferenz (DSK) genügt. Nicht veröffentlichen, nur bereithalten.
- ✅ Kein Datenschutzbeauftragter nötig (Privatperson, keine 20 Personen mit Datenverarbeitung).
- ⬜ **BA:** Falls das BA verlinkt: reicht in der Regel ein Hinweis „externes Angebot“. Falls das
  BA das Angebot betreibt/einbettet: behördlichen DSB einbinden, eigene Datenschutzerklärung.

## 3. Lizenzen und Quellenangaben (`web/lizenzen.html`)

- ⬜ **Betreiber:** **Schriftliche Bestätigung** des Datenbereitstellers für das 3D-Mesh
  (Berlin 3D-Downloadportal, Senatsverwaltung für Stadtentwicklung, Bauen und Wohnen / Berlin
  Partner als Portalbetreiber) einholen: nicht kommerzielle, öffentliche Nutzung im Web inkl.
  Weitergabe verkleinerter Kacheln an Browser – und ob eine Verlinkung/Bereitstellung durch ein
  Bezirksamt daran etwas ändert. Genaue Quellenangabe übernehmen und an drei Stellen den Platzhalter
  ersetzen: `impressum.html`, `lizenzen.html`, Fußzeile in `index.html` (+ Unterseiten, siehe unten).
- ✅ Geoportal-Daten (Hauskoordinaten, LoD2, bDOM): Datenlizenz Deutschland – Zero – Version 2.0
  (www.govdata.de/dl-de/zero-2-0) – keine Bedingungen, Quellenangabe trotzdem gesetzt.
- ✅ three.js r160 (MIT): vollständiger Lizenztext auf der Lizenzseite, `web/vendor/three/LICENSE`.
- ✅ Sora, Figtree (SIL OFL 1.1): Lizenzdateien in `web/fonts/`, verlinkt.
- ⬜ **Betreiber:** Wetterdaten: Angabe auf der Lizenzseite bestätigen (synthetisches Wetter mit
  pvlib oder PVGIS-TMY; bei PVGIS Quellenangabe „© Europäische Union, JRC PVGIS“ prüfen).
- ✅ AGPL-3.0: Quellcode-Link im Kopf, in der Fußzeile und auf der Lizenzseite (erfüllt § 13 AGPL
  „Remote Network Interaction“, solange das Repo öffentlich und aktuell ist).
- ⬜ **Betreiber:** sicherstellen, dass die ausgelieferte Version dem öffentlichen Repo entspricht
  (z. B. nur aus getaggten Commits deployen).

## 4. Barrierefreiheit (`web/barrierefreiheit.html`)

- ✅ Erklärung angelegt: „teilweise vereinbar“, bekannte Lücken (3D-Ansicht nur per Zeiger, keine
  Leichte Sprache/DGS, kein Screenreader-Test), Alternative „grob schätzen“ per Himmelsrichtung
  (tastaturbedienbar), Feedback-Kontakt, Hinweis auf die Landesbeauftragte für digitale
  Barrierefreiheit (Senatskanzlei, Jüdenstraße 1, 10178 Berlin).
- Rechtslage: Für öffentliche Stellen des Landes Berlin gilt das Barrierefreie-IKT-Gesetz Berlin
  (BIKTG Bln) mit Verweis auf BITV 2.0 / EN 301 549 (WCAG 2.1 AA) – inkl. Pflicht zur Erklärung
  mit Feedback-Mechanismus und Durchsetzungsverfahren. Für einen privaten, nicht kommerziellen
  Betreiber ist das freiwillig; das BFSG (seit 28.06.2025) betrifft nur bestimmte Produkte und
  Dienstleistungen von Unternehmen (z. B. Online-Handel) – hier nicht einschlägig.
- ⬜ **Betreiber:** Selbstbewertung mit Datum durchführen (Tastatur, Zoom 200/400 %, Kontrast,
  NVDA/VoiceOver), Ergebnis und Datum eintragen.
- ⬜ **Betreiber:** Tastatursteuerung der 3D-Ansicht (Pfeiltasten drehen, +/− zoomen, Enter wählt
  die Wand in der Bildmitte) – größte bekannte Lücke; Zeitplan in der Erklärung eintragen.
- ⬜ **BA:** Wenn das BA das Angebot bereitstellt: BITV-Test (z. B. durch eine Prüfstelle), Texte
  in Leichter Sprache/DGS-Video nach BIKTG Bln/BITV 2.0 bereitstellen, Erklärung übernehmen und
  den eigenen Feedback-Kontakt eintragen.

## 5. Domain, Hosting, Einbindung bei berlin.de

- ⬜ **Betreiber:** neutrale Domain registrieren (z. B. `balki-strom.de`), Inhaber = Betreiber;
  Domain in `barrierefreiheit.html` eintragen.
- ⬜ **Betreiber:** Server in Deutschland (z. B. Hetzner), Caddy davor (automatisches TLS),
  `python3 server/app.py --hinter-proxy` nur auf 127.0.0.1, als systemd-Dienst ohne Root.
- ⬜ **BA:** Für eine Verlinkung von berlin.de genügt üblicherweise ein externer Link; Impressen auf
  berlin.de enthalten einen Haftungshinweis für externe Links (Prüfung bei Linksetzung). Die
  genauen Anforderungen der Redaktion von berlin.de bzw. des BA (Kennzeichnung als externes
  Angebot, Barrierefreiheit verlinkter Angebote) konnten nicht verifiziert werden – beim BA
  (Online-Redaktion) erfragen.
- ⬜ **BA:** Einbettung als iframe in berlin.de ist derzeit **nicht möglich**: Server sendet
  `X-Frame-Options: DENY` und `frame-ancestors 'none'`. Empfehlung: verlinken statt einbetten.
  Sonst müsste `frame-ancestors https://www.berlin.de` gezielt erlaubt werden.

## 6. Sicherheit

- ✅ Content-Security-Policy (Meta-Tag in allen Seiten; Unterseiten ohne Skripte:
  `script-src 'none'`), keine externen Ressourcen, `Referrer-Policy: no-referrer`.
- ✅ Server: strenge Eingabeprüfung, max. 1 KB je Anfrage, Body-Lesefrist 5 s, eine Rechnung je
  Verbindung (kein Request-Smuggling), Ratenlimits (120 Rechnungen/Stunde je IP bzw. IPv6-/56,
  1500/Stunde gesamt, 600 Abrufe/Minute), Verbindungs- und Parallelitätsgrenzen, keine IPs in App-Logs.
- ✅ CSP: strenge Meta-CSP je Seite (Hash der Import-Map), Header ergänzt `frame-ancestors`; für den
  Betrieb steht die vollständige CSP im Caddyfile (`docs/BETRIEB.md`).
- ✅ Sicherheits-Review (04.11.2026) durchgeführt, Befunde behoben; Betriebskonfiguration in `docs/BETRIEB.md`.
- ⬜ **Betreiber:** TLS nur über Caddy (HTTPS erzwingen, HSTS), Firewall nur 80/443/SSH,
  SSH nur mit Schlüssel, automatische Sicherheitsupdates (unattended-upgrades), Python-Pakete
  (numpy, pandas, pvlib, pyproj) und three.js regelmäßig aktualisieren.
- ⬜ **Betreiber:** `security.txt` (`/.well-known/security.txt`) mit Kontakt – optional, hilfreich.

## 7. Inhalte, Haftung, Aktualität

- ✅ Haftungshinweis zu Berechnungen (Schätzungen, keine Beratung) im Impressum und auf der
  Ergebnisseite („Alle Werte sind Schätzungen, keine Zusage“); Haftung für Vorsatz/grobe
  Fahrlässigkeit nicht ausgeschlossen (wäre ohnehin unwirksam).
- ⬜ **Betreiber:** mindestens halbjährlich prüfen und Datum aktualisieren: Strompreis-Annahme,
  Set-Preise, Rechtslage (§ 554 BGB, MaStR-Anmeldung, 800-W-Grenze, Umsatzsteuer 0 %),
  Aktionsfristen (z. B. „bewerben bis 01.12.2026“ nach Ablauf entfernen), Links.
- ⬜ **Betreiber:** „Stand“-Datum auf Datenschutz-, Lizenz- und Barrierefreiheitsseite bei jeder
  Änderung anpassen.

## Alle Platzhalter auf einen Blick

| Seite | Platzhalter |
|---|---|
| impressum.html | Straße/Hausnummer, PLZ/Ort, E-Mail, Telefon, Quellenangabe Mesh |
| datenschutz.html | Anschrift, E-Mail, Hoster (Name, Anschrift, Standort); „Zu bestätigen“: Proxy-Logs, 7 Tage |
| barrierefreiheit.html | Domain, Datum Selbstbewertung, Zeitplan Tastatur-3D, E-Mail Barrierefreiheit, Anschrift, Antwortfrist, Erstellungsdatum; Absatz für den Fall öffentlicher Betreiber |
| lizenzen.html | Quellenangabe Mesh; Wettergrundlage bestätigen |
| index.html (Fußzeile) | Mesh-Quellenangabe nach Lizenzbestätigung angleichen |
