#!/usr/bin/env python3
"""
Adressen für die Adresssuche der Webseite
=========================================
Lädt alle amtlichen Hausadressen im Gebiet der vorhandenen 3D-Kacheln und schreibt web/adressen.json.
Die Suche läuft danach komplett im Browser (web/js/suche.js), ohne externen Geocoding-Dienst.

Quelle: Amtliche Hauskoordinaten, Geoportal Berlin (WFS „Adressen Berlin“),
        Datenlizenz Deutschland – Zero 2.0 (frei nutzbar, keine Namensnennung nötig; wir nennen sie trotzdem).

Gebiet: Vereinigung der Kachelgrenzen aus web/tiles/tiles.json, je Kachel 30 m Rand.
        Gibt es tiles.json noch nicht, das Gebiet mit --bbox angeben (EPSG:25833), z. B.
          python3 pipeline/adressen.py --bbox 385848,5817143,386226,5817517

Nutzung:
  python3 pipeline/adressen.py                       # Kacheln aus web/tiles/tiles.json
  python3 pipeline/adressen.py --bbox xmin,ymin,xmax,ymax [--name "Wilmersdorf"]
  python3 pipeline/adressen.py --web pfad/zu/web

Format von adressen.json (kompakt, gruppiert nach Straße):
  {"v": 2, "crs": "EPSG:25833", "quelle": "...", "stand": "YYYY-MM-DD",
   "gebiete": [{"id": "3858_58171", "name": "Wilmersdorf", "bounds": [xmin, ymin, xmax, ymax]}],
   "strassen": [["Düsseldorfer Straße", [["61", "10707", 385853.9, 5817541.2], ...]], ...]}
  Hausnummer inkl. Zusatz ("24a"), PLZ, x, y (0,1 m). Sortiert nach Straße und Hausnummer.
"""
import argparse
import collections
import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

WFS = "https://gdi.berlin.de/services/wfs/adressen_berlin"
TYP = "adressen_berlin:adressen_berlin"
RAND = 30.0       # m über die Kachel hinaus
SEITE = 5000      # Features je WFS-Anfrage
UA = "balki-strom-adressen/2.0 (nicht kommerziell)"


def holen(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.read()
    except urllib.error.URLError as e:
        # Python von python.org auf dem Mac kennt die Systemzertifikate oft nicht -> curl nutzt den Schlüsselbund
        if "CERTIFICATE_VERIFY_FAILED" not in str(e):
            raise
        cmd = ["curl", "-sS", "--fail", "--max-time", "120", "-A", UA, url]
        return subprocess.run(cmd, capture_output=True, check=True).stdout


def gebiete_aus_tiles(web):
    pfad = os.path.join(web, "tiles", "tiles.json")
    if not os.path.exists(pfad):
        return None
    t = json.load(open(pfad, encoding="utf-8"))
    if t.get("crs", "EPSG:25833") != "EPSG:25833":
        sys.exit(f"{pfad}: erwartet EPSG:25833, gefunden {t.get('crs')}")
    return [dict(id=k["id"], name=k.get("name") or "", bounds=[float(v) for v in k["bounds"]]) for k in t.get("kacheln", [])]


def features(b):
    """Alle Adresspunkte in der Box b (+RAND), seitenweise."""
    box = f"{b[0] - RAND},{b[1] - RAND},{b[2] + RAND},{b[3] + RAND},urn:ogc:def:crs:EPSG::25833"
    start, alle = 0, []
    while True:
        q = dict(SERVICE="WFS", VERSION="2.0.0", REQUEST="GetFeature", TYPENAMES=TYP, SRSNAME="EPSG:25833",
                 OUTPUTFORMAT="application/json", BBOX=box, COUNT=SEITE, STARTINDEX=start, SORTBY="adressid")
        fc = json.loads(holen(WFS + "?" + urllib.parse.urlencode(q)))
        f = fc.get("features", [])
        alle += f
        if len(f) < SEITE:
            return alle
        start += SEITE


def lesen(ft):
    p = {k.lower(): v for k, v in (ft.get("properties") or {}).items()}
    g = ft.get("geometry") or {}
    if g.get("type") != "Point" or not p.get("str_name") or p.get("hnr") in (None, ""):
        return None
    x, y = g["coordinates"][:2]
    zus = str(p.get("hnr_zusatz") or "").strip().lower()
    return dict(id=str(p.get("adressid") or ft.get("id")), s=str(p["str_name"]).strip(), n=f"{p['hnr']}{zus}",
                p=str(p.get("plz") or ""), ort=str(p.get("ort_name") or ""), x=round(x, 1), y=round(y, 1))


def main():
    ap = argparse.ArgumentParser(description="Amtliche Adressen für die Kacheln -> web/adressen.json")
    ap.add_argument("--web", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web"))
    ap.add_argument("--bbox", help="xmin,ymin,xmax,ymax in EPSG:25833 (statt tiles.json)")
    ap.add_argument("--name", help="Name des Gebiets bei --bbox (sonst häufigster Ortsteil)")
    a = ap.parse_args()
    web = os.path.normpath(a.web)

    if a.bbox:
        b = [float(v) for v in a.bbox.split(",")]
        if len(b) != 4 or b[0] >= b[2] or b[1] >= b[3]:
            sys.exit("--bbox erwartet xmin,ymin,xmax,ymax")
        gebiete = [dict(id="bbox", name=a.name or "", bounds=b)]
    else:
        gebiete = gebiete_aus_tiles(web)
        if not gebiete:
            sys.exit("web/tiles/tiles.json fehlt oder ist leer – Gebiet mit --bbox xmin,ymin,xmax,ymax angeben.")

    adr = {}
    for g in gebiete:
        neu = [d for d in map(lesen, features(g["bounds"])) if d]
        if not g["name"]:   # Name des Gebiets: häufigster Ortsteil der Adressen darin
            ortsteile = collections.Counter(d["ort"] for d in neu if d["ort"])
            g["name"] = ortsteile.most_common(1)[0][0] if ortsteile else "Testgebiet"
        for d in neu:
            adr[d["id"]] = d
        print(f"  {g['id']} ({g['name']}): {len(neu)} Adressen")
    if not adr:
        sys.exit("Keine Adressen gefunden – stimmt das Gebiet (EPSG:25833)?")

    # Doppelte (gleiche Straße + Nummer) zusammenfassen, sortieren
    eindeutig = {(d["s"], d["n"]): d for d in adr.values()}.values()
    nr_key = lambda n: (int(re.match(r"\d*", n).group() or 0), n)
    strassen = collections.defaultdict(list)
    for d in sorted(eindeutig, key=lambda d: (d["s"], nr_key(d["n"]))):
        strassen[d["s"]].append([d["n"], d["p"], d["x"], d["y"]])

    out = dict(v=2, crs="EPSG:25833",
               quelle="Amtliche Hauskoordinaten Berlin, Geoportal Berlin (Datenlizenz Deutschland – Zero 2.0)",
               stand=datetime.date.today().isoformat(),
               gebiete=[dict(id=g["id"], name=g["name"], bounds=[round(v, 1) for v in g["bounds"]]) for g in gebiete],
               strassen=[[s, l] for s, l in strassen.items()])
    os.makedirs(web, exist_ok=True)
    ziel = os.path.join(web, "adressen.json")
    tmp = ziel + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, ziel)
    n = sum(len(l) for _, l in out["strassen"])
    print(f"{n} Adressen in {len(out['strassen'])} Straßen -> {ziel} ({os.path.getsize(ziel) / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
