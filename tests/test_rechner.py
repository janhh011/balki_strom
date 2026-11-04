"""
Synthetische Testszene für balki/rechner.py (ohne echte Kachel):
Haus A mit Südwand und Balkon, gegenüber (19 m südlich) Haus B. Erwartung: Horizont nach Süden
≈ atan((Höhe B − Modulhöhe) / Abstand), Module hängen außen vor dem Geländer, Normale zeigt nach Süden.

    python3 -m pytest tests/ -q      (oder: python3 tests/test_rechner.py)
"""
import json
import math
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from balki.rechner import Rechner, EingabeFehler  # noqa: E402

X0, Y0, Z0 = 386000.0, 5817300.0, 35.0


def quader(x0, y0, z0, x1, y1, z1):
    """Dreiecke eines Quaders, Normalen nach außen."""
    v = np.array([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
                  [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]])
    f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
         [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
    return v[np.array(f)]


def szene(ordner):
    T = np.concatenate([
        quader(-40, 0, 0, 40, 12, 15),          # Haus A, Südwand bei y = 0, 15 m hoch
        quader(8, -1.5, 5.8, 12, 0, 6.0),       # Balkonplatte
        quader(8, -1.5, 6.0, 12, -1.45, 7.0),   # Brüstung vorn, Oberkante 7 m
        quader(-60, -40, 0, 60, -19, 10),       # Haus B, Nordwand bei y = -19, 10 m hoch
        quader(-120, -120, -0.2, 120, 120, 0),  # Boden
    ])
    T = T + np.array([X0, Y0, Z0])
    V = T.reshape(-1, 3)
    F = np.arange(len(V)).reshape(-1, 3)
    origin = np.floor(V.min(0))
    np.savez(os.path.join(ordner, "mesh.npz"), origin=origin, V=(V - origin).astype(np.float32),
             F=F.astype(np.int32), baum=np.zeros(len(F), bool))
    # Punktwolke: 0,5-m-Raster auf allen Flächen
    pts = []
    rng = np.random.default_rng(1)
    for tri in T:
        a = 0.5 * np.linalg.norm(np.cross(tri[1] - tri[0], tri[2] - tri[0]))
        k = int(min(max(a / 0.25, 1), 40000))
        r1, r2 = np.sqrt(rng.random(k)), rng.random(k)
        pts.append(tri[0] * (1 - r1)[:, None] + tri[1] * (r1 * (1 - r2))[:, None] + tri[2] * (r1 * r2)[:, None])
    P = np.concatenate(pts)
    po = np.floor(P.min(0))
    np.savez(os.path.join(ordner, "wolke.npz"), origin=po, P=(P - po).astype(np.float32),
             baum=np.zeros(len(P), bool), quelle=np.zeros(len(P), np.uint8))
    np.savez(os.path.join(ordner, "gelaende.npz"), x0=X0 - 150, y0=Y0 - 150, res=1.0,
             z=np.full((300, 300), Z0, np.float32))
    json.dump({"id": "test", "bounds": [X0 - 120, Y0 - 120, X0 + 120, Y0 + 120], "crs": "EPSG:25833"},
              open(os.path.join(ordner, "meta.json"), "w"))


_R = None


def rechner():
    global _R
    if _R is None:
        work = tempfile.mkdtemp()
        os.makedirs(os.path.join(work, "test"))
        szene(os.path.join(work, "test"))
        _R = Rechner(work)
    return _R


def test_balkon_sued():
    r = rechner().ertrag("test", X0 + 10, Y0 - 1.5, Z0 + 6.5, 0.0, -1.0, 2, "senkrecht")
    assert r["richtung"] == "Süd", r["richtung"]
    assert abs(r["azimut"] - 180) < 3, r["azimut"]
    ecken = np.array(r["module"])                       # (2, 4, 3)
    assert ecken.shape == (2, 4, 3)
    assert np.all(ecken[:, :, 1] < Y0 - 1.5), "Module müssen vor der Brüstung hängen"
    assert abs(ecken[:, :, 2].max() - (Z0 + 7.0)) < 0.25, ecken[:, :, 2].max()
    # Horizont nach Süden (Sektor 180°): Haus B 10 m hoch, ~19 m entfernt, Module ~5,9–7 m hoch
    h = r["horizont"]["gebaeude"][180 // 2]
    erwartet = math.degrees(math.atan((10 - 6.4) / 17.4))
    assert abs(h - erwartet) < 4, (h, erwartet)
    assert 400 < r["kwh_jahr_frei"] < 800, r["kwh_jahr_frei"]
    assert 0 < r["verschattung"] < 0.5, r["verschattung"]
    assert r["geschoss"] == 2, r["geschoss"]
    assert len(r["stunde_wh"]) == 8760 and len(r["monat_kwh"]) == 12
    assert not r["hinweise"], r["hinweise"]


def test_normale_falsch_herum():
    """Viewer liefert die Innenseite der Wand: Rechner dreht auf die Außenseite."""
    r = rechner().ertrag("test", X0 + 10, Y0 - 1.5, Z0 + 6.5, 0.0, 1.0, 1, "senkrecht")
    assert r["richtung"] == "Süd", r["richtung"]


def test_wand_ohne_balkon():
    r = rechner().ertrag("test", X0 - 20, Y0, Z0 + 10, 0.0, -1.0, 1, "senkrecht")
    assert r["richtung"] == "Süd"
    assert r["hinweise"], "Hinweis 'kein Balkon erkannt' erwartet"


def test_geneigt_mehr_ertrag_frei():
    s = rechner().ertrag("test", X0 + 10, Y0 - 1.5, Z0 + 6.5, 0.0, -1.0, 1, "senkrecht")
    g = rechner().ertrag("test", X0 + 10, Y0 - 1.5, Z0 + 6.5, 0.0, -1.0, 1, "geneigt")
    assert g["kwh_jahr_frei"] > s["kwh_jahr_frei"]


def test_dach_abgelehnt():
    try:
        rechner().ertrag("test", X0 + 10, Y0 + 5, Z0 + 15, 0.0, 0.0, 1, "senkrecht")
    except EingabeFehler:
        return
    raise AssertionError("Dach muss abgelehnt werden")


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
