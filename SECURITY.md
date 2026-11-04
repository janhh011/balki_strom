# Sicherheit

## Sicherheitslücke melden

Bitte melde Sicherheitslücken **nicht** in einem öffentlichen Issue, sondern vertraulich über GitHub:
[Security Advisories → Report a vulnerability](https://github.com/janhh011/balki_strom/security/advisories/new).

Hilfreich sind: betroffene Datei oder URL, Schritte zum Nachvollziehen, mögliche Auswirkung. Ich antworte so bald wie möglich; das Projekt wird privat betreut. Bitte veröffentliche Details erst, wenn die Lücke behoben ist oder wir uns auf einen Zeitpunkt geeinigt haben.

## Umfang

Relevant sind vor allem:

- `server/app.py`: Pfad-Traversal, Umgehen der Eingabeprüfung oder des Ratenlimits, Denial of Service durch einzelne Anfragen, Preisgabe interner Fehlertexte oder Dateien.
- `web/`: Cross-Site-Scripting, Umgehen der Content-Security-Policy, Abfluss von Daten an Dritte (z. B. Adresse oder E-Mail-Text).
- `balki/` und `pipeline/`: Verarbeitung manipulierter Eingabedateien.

Nicht im Umfang:

- Ungenaue Ertrags- oder Kostenwerte. Das sind Schätzungen; bitte als normales Issue melden.
- Angriffe, die physischen Zugriff auf den Server oder ein kompromittiertes Gerät voraussetzen.
- Fehlende Sicherheits-Header einer Hosting-Konfiguration, die nicht Teil dieses Repositorys ist.
- Automatisierte Scans ohne nachgewiesene Auswirkung.

## Unterstützte Versionen

Sicherheitskorrekturen gibt es nur für den aktuellen Stand des Standard-Branches.
