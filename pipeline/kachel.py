#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Eine Mesh-Kachel (Berlin 3D-Downloadportal) -> Web-Paket + Server-Cache
=====================================================================

  python3 pipeline/kachel.py data/<kachel-ordner> [--name Wilmersdorf]

Idempotent: teure Schritte werden in data/work/<id>/_cache/ zwischengespeichert, ein zweiter Aufruf
dauert Sekunden. Weitere Kacheln = denselben Befehl noch einmal; Kacheln, deren Umgebungsring die neue
Kachel überdeckt, bekommen ihren Ring automatisch neu (Mesh geht vor LoD2/bDOM).

Erzeugt
  web/tiles/<id>/meta.json       Beschreibung des Pakets (Format: siehe schreibe_web / web/js/viewer.js)
  web/tiles/<id>/z/<ix>_<iy>.bin  Geometrie-Zelle (quantisiert), Dreiecke: erst Hauswand/Boden, dann Baum
  web/tiles/<id>/z/<ix>_<iy>_<k>.jpg  Textur-Atlas der Zelle, Stufe k = 0 (40 cm/px), 1 (20), 2 (10)
  web/tiles/<id>/fern.bin        stark vereinfachtes Mesh der ganzen Kachel mit Vertexfarben (Fernansicht)
  web/tiles/<id>/u/<ix>_<iy>.bin LoD2-Gebäude im 250-m-Ring außerhalb von Mesh-Kacheln (grau, Kontext)
  web/tiles/<id>/gelaende.bin    Gelände 8 m (uint16 cm über zmin) für Bodenfläche
  web/tiles/tiles.json           Liste aller Kacheln (Vertrag in docs/ARCHITEKTUR.md)
  data/work/<id>/wolke.npz       Punktwolke Mesh + Ring (LoD2/bDOM) für den Horizont
  data/work/<id>/mesh.npz        Original-Mesh (relativ), Baum je Dreieck
  data/work/<id>/gelaende.npz    Geländemodell 1 m über Kachel + Ring
  data/work/<id>/meta.json
  data/umgebung/lod2, bdom       Downloads von gdi.berlin.de (dl-de/zero-2-0), fortsetzbar

Optionen
  --name NAME       Anzeigename in tiles.json (bleibt sonst erhalten, Standard: id)
  --umgebung-neu    Ring (LoD2/bDOM außerhalb der Mesh-Kacheln) neu berechnen
  --web-neu         Web-Paket neu schreiben
  --neu             alles neu (auch OBJ einlesen, Baum-Markierung)
  --keine-nachbarn  Ringe benachbarter Kacheln nicht automatisch aktualisieren

Abhängigkeiten: numpy, scipy, pillow, opencv-python, pyproj; optional fast-simplification
(Fernansicht) und mapbox-earcut (Dreiecke für LoD2-Polygone, sonst Fächer).
"""
import argparse
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

import cv2
import numpy as np
from PIL import Image
from scipy.ndimage import (binary_dilation, binary_opening, label, maximum, maximum_filter,
                           minimum_filter, uniform_filter)

Image.MAX_IMAGE_PIXELS = None

PROJEKT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(PROJEKT, "web")
WORK = os.path.join(PROJEKT, "data", "work")
UMGEBUNG = os.path.join(PROJEKT, "data", "umgebung")
CRS = "EPSG:25833"

WEB_VERSION = 1
# --- Server-Cache
RING = 250.0              # m Umgebung außerhalb der Kachel (Horizont reicht 220 m)
PUNKT_ABSTAND = 0.6       # m Punktabstand auf Mesh-Dreiecken und LoD2-Flächen
GREEN_EXG = 0.06          # Grünindex (2G-R-B)/(R+G+B) ab dem ein Dreieck "grün" ist
BAUM_MIN_FLAECHE = 20     # m² Kronenfläche
BAUM_MIN_HOEHE = 6.0      # m über Gelände
BAU_MIN_FLAECHE = 30      # m²
BAU_MIN_HOEHE = 2.5       # m
BDOM_BAUM_H = 2.5         # m über Gelände: bDOM-Zelle ist Vegetation (außerhalb Gebäuden)
PHANTOM_TOLERANZ = 3.0    # m LoD2 über gemessener Oberfläche -> gibt es so nicht
# --- Web-Paket
ZELLE_ZIEL = 48.0         # m Kantenlänge einer Geometrie-Zelle (ca. 6000 Dreiecke)
TEX_STUFEN = (0.25, 0.5, 1.0)   # Texturauflösung je Stufe relativ zur Quelle (~10 cm/px)
TEX_MAX = 2048            # px größte Kantenlänge eines Zell-Atlas (Stufe 2)
TEX_PAD = 8               # px Rand um jede Teiltextur (bei Stufe 0 noch 2 px)
JPEG_Q = (80, 80, 82)
FERN_DREIECKE = 50000     # Dreiecke der Fernansicht je Kachel
GELAENDE_WEB_RES = 8      # m
UMG_ZELLE = 110.0         # m Zellen der LoD2-Umgebung im Web
LOD2_URL = "https://gdi.berlin.de/data/a_lod2/atom/LoD2_{e}_{n}.zip"
BDOM_URL = "https://gdi.berlin.de/data/bdom/atom/{e}_{n}.zip"

T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a, flush=True)


def mb(n):
    return f"{n / 1e6:.2f} MB"


def atomar_json(pfad, obj, **kw):
    tmp = pfad + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, **kw)
    os.replace(tmp, pfad)


def atomar_npz(pfad, komprimiert=False, **arr):
    tmp = pfad + ".tmp.npz"
    (np.savez_compressed if komprimiert else np.savez)(tmp, **arr)
    os.replace(tmp, pfad)


def kachel_id(ordner):
    m = re.search(r"(\d{4})_(\d{5})", os.path.basename(os.path.normpath(ordner)))
    if not m:
        sys.exit(f"Kachel-ID nicht erkennbar in {ordner} (erwartet z. B. 3858_58171_-002)")
    return f"{m.group(1)}_{m.group(2)}"


# =====================================================================================================
# 1. Mesh einlesen (aus fassaden_pipeline.load_mesh übernommen)
# =====================================================================================================
def parse_mtl(mtl_path):
    mats, cur = {}, None
    with open(mtl_path, encoding="utf-8", errors="ignore") as f:
        for line in f:
            p = line.strip().split(None, 1)
            if not p:
                continue
            if p[0] == "newmtl":
                cur = p[1].strip()
                mats[cur] = None
            elif p[0] == "map_Kd" and cur is not None:
                mats[cur] = p[1].strip()
    return mats


def lade_mesh(tile_dir, cache, neu=False):
    objs = sorted(glob.glob(os.path.join(tile_dir, "*.obj")))
    if not objs:
        sys.exit(f"Keine .obj-Datei in {tile_dir}")
    obj = objs[0]
    if not neu and os.path.exists(cache) and os.path.getmtime(cache) > os.path.getmtime(obj):
        d = np.load(cache, allow_pickle=False)
        tex = [os.path.join(tile_dir, str(n)) for n in d["tex_names"]]
        return d["V"], d["F"], d["VT"], d["FT"], d["mat"], tex
    log(f"Lese {os.path.basename(obj)}")
    V, VT, F, FT, M = [], [], [], [], []
    mat_names, mat_index, mtl_file, cur = [], {}, None, 0
    with open(obj, encoding="utf-8", errors="ignore") as f:
        for line in f:
            if line.startswith("v "):
                V.append(line.split()[1:4])
            elif line.startswith("vt "):
                VT.append(line.split()[1:3])
            elif line.startswith("f "):
                idx = [p.split("/") for p in line.split()[1:]]
                for k in range(1, len(idx) - 1):
                    tri = (idx[0], idx[k], idx[k + 1])
                    F.append([int(t[0]) for t in tri])
                    FT.append([int(t[1]) if len(t) > 1 and t[1] else 0 for t in tri])
                    M.append(cur)
            elif line.startswith("usemtl"):
                name = line.split(None, 1)[1].strip()
                if name not in mat_index:
                    mat_index[name] = len(mat_names)
                    mat_names.append(name)
                cur = mat_index[name]
            elif line.startswith("mtllib"):
                mtl_file = line.split(None, 1)[1].strip()
    mats = parse_mtl(os.path.join(tile_dir, mtl_file)) if mtl_file else {}
    tex_names = [os.path.basename(mats.get(n) or "") for n in mat_names]
    V = np.asarray(V, np.float64)
    VT = np.asarray(VT, np.float64) if VT else np.zeros((1, 2))
    F = np.asarray(F, np.int64) - 1
    FT = np.asarray(FT, np.int64) - 1
    M = np.asarray(M, np.int16)
    atomar_npz(cache, V=V, F=F, VT=VT, FT=FT, mat=M, tex_names=np.array(tex_names))
    return V, F, VT, FT, M, [os.path.join(tile_dir, n) for n in tex_names]


def lade_texturen(tex):
    out = []
    for p in tex:
        out.append(np.asarray(Image.open(p).convert("RGB")))
    return out


# =====================================================================================================
# 2. Baum-Dreiecke, Punktwolke, Bereinigung (aus angebot.py übernommen, erweitert)
# =====================================================================================================
def gruen_dreiecke(F, VT, FT, mat, texbilder):
    """Grünindex je Dreieck (Mittel aus Ecken und Schwerpunkt der Textur)."""
    uvs = VT[FT]
    uvs = np.concatenate([uvs, uvs.mean(1, keepdims=True)], axis=1)
    rgb = np.zeros((len(F), 3), np.float32)
    for m, im in enumerate(texbilder):
        s = mat == m
        if not s.any():
            continue
        h, w, _ = im.shape
        u = uvs[s]
        px = np.clip(np.round(u[..., 0] * (w - 1)).astype(np.int64), 0, w - 1)
        py = np.clip(np.round((1 - u[..., 1]) * (h - 1)).astype(np.int64), 0, h - 1)
        rgb[s] = im[py, px].astype(np.float32).mean(1)
    exg = (2 * rgb[:, 1] - rgb[:, 0] - rgb[:, 2]) / (rgb.sum(1) + 1e-6)
    return exg > GREEN_EXG


def punktwolke(V, F, tri_gruen):
    """Gleichmäßig verteilte Punkte (~0,6 m) auf allen Dreiecken + Mesh-Ecken, Grün-Markierung je Punkt."""
    T = V[F]
    area = 0.5 * np.linalg.norm(np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0]), axis=1)
    k = np.clip(np.ceil(area / PUNKT_ABSTAND ** 2), 1, 400).astype(np.int64)
    idx = np.repeat(np.arange(len(F)), k)
    rng = np.random.default_rng(0)
    r1 = np.sqrt(rng.random(len(idx)))
    r2 = rng.random(len(idx))
    P = (T[idx, 0] * (1 - r1)[:, None] + T[idx, 1] * (r1 * (1 - r2))[:, None]
         + T[idx, 2] * (r1 * r2)[:, None])
    P = np.concatenate([P, V])
    gruen = np.concatenate([tri_gruen[idx], np.zeros(len(V), bool)])
    return P, gruen


def bereinige(P, baum):
    """Wie angebot.bereinige_wolke: nur eindeutige Hindernisse (Gebäude >= 30 m², Bäume >= 20 m² Krone und
    >= 6 m hoch). Gibt zusätzlich das Raster der gültigen Baumzellen zurück, damit auch Dreiecke
    sauber als Baum markiert werden können (Balkonpflanzen sind kein Baum)."""
    res = 1.0
    x0, y0 = P[:, 0].min(), P[:, 1].min()
    ix = ((P[:, 0] - x0) / res).astype(np.int64)
    iy = ((P[:, 1] - y0) / res).astype(np.int64)
    ny, nx = iy.max() + 1, ix.max() + 1
    zmin = np.full((ny, nx), np.inf)
    np.minimum.at(zmin, (iy, ix), P[:, 2])
    zmin[~np.isfinite(zmin)] = np.nanmax(np.where(np.isfinite(zmin), zmin, np.nan))
    gelaende = minimum_filter(zmin, size=31)
    h = P[:, 2] - gelaende[iy, ix]
    acht = np.ones((3, 3), bool)
    hb = np.full((ny, nx), -1.0)
    np.maximum.at(hb, (iy[baum], ix[baum]), h[baum])
    lab, n = label(hb >= 2.0, structure=acht)
    flaeche = np.bincount(lab.ravel(), minlength=n + 1) * res * res
    hoehe = np.zeros(n + 1)
    if n:
        hoehe[1:] = maximum(hb, lab, index=np.arange(1, n + 1))
    ok_t = (flaeche >= BAUM_MIN_FLAECHE) & (hoehe >= BAUM_MIN_HOEHE)
    ok_t[0] = False
    baum_zelle = ok_t[lab]
    hg = np.full((ny, nx), -1.0)
    np.maximum.at(hg, (iy[~baum], ix[~baum]), h[~baum])
    gm = binary_opening(hg >= BAU_MIN_HOEHE, structure=acht)
    lab2, n2 = label(gm, structure=acht)
    ok_g = np.bincount(lab2.ravel(), minlength=n2 + 1) * res * res >= BAU_MIN_FLAECHE
    ok_g[0] = False
    bau_zelle = binary_dilation(ok_g[lab2], structure=acht)
    keep = np.where(baum, baum_zelle[iy, ix] & (h >= 1.0), bau_zelle[iy, ix] | (h < BAU_MIN_HOEHE))
    return keep, dict(x0=x0, y0=y0, res=res, baum_zelle=baum_zelle, gelaende=gelaende)


def baum_dreiecke_sauber(V, F, tri_gruen, info):
    """Dreieck ist Baum, wenn grün, Schwerpunkt in einer gültigen Baumzelle und >= 1 m über Gelände."""
    c = V[F].mean(1)
    ix = np.clip(((c[:, 0] - info["x0"]) / info["res"]).astype(np.int64), 0, info["baum_zelle"].shape[1] - 1)
    iy = np.clip(((c[:, 1] - info["y0"]) / info["res"]).astype(np.int64), 0, info["baum_zelle"].shape[0] - 1)
    return tri_gruen & info["baum_zelle"][iy, ix] & (c[:, 2] - info["gelaende"][iy, ix] >= 1.0)


# =====================================================================================================
# 3. Umgebung: LoD2 + bDOM (offene Daten Berlin) herunterladen und lesen
# =====================================================================================================
def lade_datei(url, ziel):
    """Fortsetzbarer Download (curl -C -). Rückgabe True, wenn die Datei vorliegt."""
    if os.path.exists(ziel) and os.path.getsize(ziel) > 0:
        return True
    os.makedirs(os.path.dirname(ziel), exist_ok=True)
    teil = ziel + ".teil"
    log(f"  lade {url}")
    for _ in range(3):
        r = subprocess.run(["curl", "-fsSL", "--retry", "3", "-C", "-", "-o", teil, url],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if r.returncode == 0:
            os.replace(teil, ziel)
            return True
        if "404" in r.stderr or r.returncode == 22:
            break
    if os.path.exists(teil) and os.path.getsize(teil) == 0:
        os.remove(teil)
    log(f"  nicht verfügbar: {url} ({r.stderr.strip()[:120]})")
    return False


def lod2_dateien(box):
    out = []
    for e in range(int(box[0] // 1000), int(box[2] // 1000) + 1):
        for n in range(int(box[1] // 1000), int(box[3] // 1000) + 1):
            p = os.path.join(UMGEBUNG, "lod2", f"LoD2_{e}_{n}.zip")
            if lade_datei(LOD2_URL.format(e=e, n=n), p):
                out.append(p)
    return out


def bdom_dateien(box):
    out = []
    for e in range(int(box[0] // 2000) * 2, int(box[2] // 2000) * 2 + 1, 2):
        for n in range(int(box[1] // 2000) * 2, int(box[3] // 2000) * 2 + 1, 2):
            p = os.path.join(UMGEBUNG, "bdom", f"bDOM_{e}_{n}.zip")
            if lade_datei(BDOM_URL.format(e=e, n=n), p):
                out.append((p, e * 1000, n * 1000))
    return out


G = "{http://www.opengis.net/gml}"
B = "{http://www.opengis.net/citygml/building/1.0}"


def _poly_punkte(poly):
    pl = poly.find(f"{G}exterior/{G}LinearRing/{G}posList")
    if pl is None or not pl.text:
        return None
    v = np.array(pl.text.split(), float)
    v = v.reshape(-1, int(pl.get("srsDimension", 3)))[:, :3]
    if len(v) > 3 and np.allclose(v[0], v[-1]):
        v = v[:-1]
    return v if len(v) >= 3 else None


def lies_lod2_zip(zp):
    """LoD2-Zip -> (ids, verts, off, art, geb) als kompakte Arrays, gecacht neben dem Zip (.npz).
    art: 0 Wand, 1 Dach, 2 Boden; geb: Index in ids."""
    cache = zp[:-4] + ".npz"
    if os.path.exists(cache) and os.path.getmtime(cache) > os.path.getmtime(zp):
        d = np.load(cache)
        return list(d["ids"]), d["verts"], d["off"], d["art"], d["geb"]
    log(f"  lese {os.path.basename(zp)}")
    ids, verts, off, art, geb = [], [], [0], [], []
    with zipfile.ZipFile(zp) as z:
        name = next(n for n in z.namelist() if n.lower().endswith((".xml", ".gml")))
        with z.open(name) as fh:
            for _, el in ET.iterparse(fh, events=("end",)):
                if el.tag != "{http://www.opengis.net/citygml/1.0}cityObjectMember":
                    continue
                b = el.find(f"{B}Building")
                if b is not None:
                    gi = len(ids)
                    n0 = len(art)
                    for a, tag in ((0, "WallSurface"), (1, "RoofSurface"), (2, "GroundSurface")):
                        for s in b.iter(f"{B}{tag}"):
                            for poly in s.iter(f"{G}Polygon"):
                                v = _poly_punkte(poly)
                                if v is not None:
                                    verts.append(v)
                                    off.append(off[-1] + len(v))
                                    art.append(a)
                                    geb.append(gi)
                    if len(art) > n0:
                        ids.append(b.get(f"{G}id") or f"{os.path.basename(zp)}#{gi}")
                el.clear()
    verts = np.vstack(verts) if verts else np.zeros((0, 3))
    off, art, geb = np.array(off, np.int64), np.array(art, np.uint8), np.array(geb, np.int32)
    tmp = cache[:-4] + ".tmp.npz"
    np.savez(tmp, ids=np.array(ids), verts=verts, off=off, art=art, geb=geb)
    os.replace(tmp, cache)
    return ids, verts, off, art, geb


def lod2_polygone(dateien, box):
    """Alle LoD2-Polygone im Gebiet, Gebäude über mehrere Zips nur einmal -> Liste (art, geb, v[n,3])."""
    gesehen = {}
    out = []
    for zp in dateien:
        ids, verts, off, art, geb = lies_lod2_zip(zp)
        neu = np.array([gid not in gesehen for gid in ids], bool)
        for gid in ids:
            if gid not in gesehen:
                gesehen[gid] = len(gesehen)
        # Polygone des Gebiets
        pmin = np.minimum.reduceat(verts[:, :2], off[:-1], axis=0) if len(art) else np.zeros((0, 2))
        pmax = np.maximum.reduceat(verts[:, :2], off[:-1], axis=0) if len(art) else np.zeros((0, 2))
        im = (pmax[:, 0] >= box[0]) & (pmin[:, 0] <= box[2]) & (pmax[:, 1] >= box[1]) & (pmin[:, 1] <= box[3])
        if len(geb):
            im &= neu[geb]
        for i in np.nonzero(im)[0]:
            out.append((int(art[i]), gesehen[ids[geb[i]]], verts[off[i]:off[i + 1]]))
    return out


def lies_bdom(dateien, box):
    """bDOM-Zips (xyz, 1 m) -> Raster dom[iy, ix] über box, Zeile 0 = Süden (box[1]), NaN = keine Daten.
    Je Zip wird ein 2000x2000-Raster als .npy neben dem Zip gecacht."""
    x0, y0 = int(box[0]), int(box[1])
    W, H = int(box[2]) - x0, int(box[3]) - y0
    dom = np.full((H, W), np.nan, np.float32)
    for zp, e0, n0 in dateien:
        cache = zp[:-4] + ".npy"
        if os.path.exists(cache) and os.path.getmtime(cache) > os.path.getmtime(zp):
            r = np.load(cache)
        else:
            log(f"  lese {os.path.basename(zp)}")
            with zipfile.ZipFile(zp) as z:
                a = np.array(z.read(z.namelist()[0]).split(), dtype=np.float64).reshape(-1, 3)
            r = np.full((2000, 2000), np.nan, np.float32)
            ix = np.floor(a[:, 0] - e0).astype(np.int64)
            iy = np.floor(a[:, 1] - n0).astype(np.int64)
            s = (ix >= 0) & (ix < 2000) & (iy >= 0) & (iy < 2000)
            r[iy[s], ix[s]] = a[s, 2]
            np.save(cache + ".tmp.npy", r)
            os.replace(cache + ".tmp.npy", cache)
        # Überlappung einkopieren
        ax0, ay0 = max(x0, e0), max(y0, n0)
        ax1, ay1 = min(x0 + W, e0 + 2000), min(y0 + H, n0 + 2000)
        if ax1 > ax0 and ay1 > ay0:
            dom[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = r[ay0 - n0:ay1 - n0, ax0 - e0:ax1 - e0]
    return dom


# ---------------------------------------------------------------------------------------- Geometrie
def newell(v):
    a, b = v, np.roll(v, -1, axis=0)
    n = np.array([((a[:, 1] - b[:, 1]) * (a[:, 2] + b[:, 2])).sum(),
                  ((a[:, 2] - b[:, 2]) * (a[:, 0] + b[:, 0])).sum(),
                  ((a[:, 0] - b[:, 0]) * (a[:, 1] + b[:, 1])).sum()])
    L = np.linalg.norm(n)
    return n / L if L > 0 else n


def ebene_basis(v):
    n = newell(v)
    if not n.any():
        return None
    a = v[1] - v[0]
    a = a - n * (a @ n)
    if np.linalg.norm(a) < 1e-6:
        k = np.argmax(np.linalg.norm(v - v[0], axis=1))
        a = v[k] - v[0]
        a = a - n * (a @ n)
        if np.linalg.norm(a) < 1e-6:
            return None
    e1 = a / np.linalg.norm(a)
    return n, e1, np.cross(n, e1)


def flaeche_abtasten(v, schritt):
    """Gleichmäßige Punkte auf einem ebenen 3D-Polygon (aus lod2_pipeline übernommen)."""
    b = ebene_basis(v)
    if b is None:
        return v
    n, e1, e2 = b
    uv = np.c_[(v - v[0]) @ e1, (v - v[0]) @ e2]
    lo, hi = uv.min(0), uv.max(0)
    w, h = int((hi[0] - lo[0]) / schritt) + 2, int((hi[1] - lo[1]) / schritt) + 2
    if w * h > 4_000_000:
        return v
    m = np.zeros((h, w), np.uint8)
    pts = np.round((uv - lo) / schritt).astype(np.int32)
    cv2.fillPoly(m, [pts], 1)
    iy, ix = np.nonzero(m)
    p = v[0] + np.outer(ix * schritt + lo[0], e1) + np.outer(iy * schritt + lo[1], e2)
    return np.vstack([p, v])


try:
    import mapbox_earcut as _earcut
except ImportError:      # Fächer als Notlösung (falsch bei konkaven Polygonen)
    _earcut = None


def dreiecke_polygon(v):
    """Ebenes 3D-Polygon -> Dreiecksindizes (k,3)."""
    n = len(v)
    if n == 3:
        return np.array([[0, 1, 2]])
    if _earcut is not None:
        b = ebene_basis(v)
        if b is not None:
            uv = np.c_[(v - v[0]) @ b[1], (v - v[0]) @ b[2]]
            t = _earcut.triangulate_float64(uv, np.array([n], np.uint32))
            if len(t):
                return np.asarray(t, np.int64).reshape(-1, 3)
    return np.array([[0, k, k + 1] for k in range(1, n - 1)])


def in_boxen(x, y, boxen):
    m = np.zeros(len(x), bool)
    for b in boxen:
        m |= (x >= b[0]) & (x <= b[2]) & (y >= b[1]) & (y <= b[3])
    return m


# =====================================================================================================
# 4. Umgebung (Ring) + Gelände
# =====================================================================================================
def baue_umgebung(bounds, mesh_boxen, wolke_mesh=None):
    """Ring um die Kachel aus LoD2 + bDOM. mesh_boxen: Rechtecke aller Mesh-Kacheln (inkl. dieser), in denen
    keine Ersatzpunkte erzeugt werden. Rückgabe dict mit Pg (Gebäudepunkte), Pt (Baumpunkte), gelaende,
    polys (LoD2-Polygone außerhalb der Meshes für das Web)."""
    box = [math.floor(bounds[0] - RING), math.floor(bounds[1] - RING),
           math.ceil(bounds[2] + RING), math.ceil(bounds[3] + RING)]
    W, H = box[2] - box[0], box[3] - box[1]
    log("Umgebung: LoD2 + bDOM (gdi.berlin.de, dl-de/zero-2-0)")
    polys = lod2_polygone(lod2_dateien(box), box)
    dom = lies_bdom(bdom_dateien(box), box)
    ok = np.isfinite(dom)
    log(f"  {len(polys):,} LoD2-Polygone, bDOM {ok.mean() * 100:.0f} % abgedeckt")

    # Gebäude-Grundrisse (Boden + Dach, von oben)
    fuss = np.zeros((H, W), np.uint8)
    for art, _, v in polys:
        if art in (1, 2):
            p = np.round(np.c_[v[:, 0] - box[0], v[:, 1] - box[1]]).astype(np.int32)
            cv2.fillPoly(fuss, [p], 1)
    fuss = fuss > 0

    # Gelände: tiefste Nicht-Gebäude-Oberfläche in der Umgebung, geglättet
    flaeche = dom.copy()
    if wolke_mesh is not None and (~ok).any():   # Lücken im bDOM innerhalb der Kachel: Mesh-Minimum
        P = wolke_mesh
        ix = np.floor(P[:, 0] - box[0]).astype(np.int64)
        iy = np.floor(P[:, 1] - box[1]).astype(np.int64)
        s = (ix >= 0) & (ix < W) & (iy >= 0) & (iy < H)
        zm = np.full((H, W), np.inf, np.float32)
        np.minimum.at(zm, (iy[s], ix[s]), P[s, 2].astype(np.float32))
        fuell = ~ok & np.isfinite(zm)
        flaeche[fuell] = zm[fuell]
    okf = np.isfinite(flaeche)
    gross = np.where(okf & ~fuss, flaeche, np.inf).astype(np.float32)
    gel = minimum_filter(gross, size=25)
    gel2 = minimum_filter(gross, size=81)
    # Berlin ist flach: höchstens 2,5 m über dem Minimum im 81-m-Fenster (Baumkronen/kleine Höfe sind kein Boden)
    gel = np.where(np.isfinite(gel), np.minimum(gel, gel2 + 2.5), gel2)
    rest = np.isfinite(gel)
    gel = np.where(rest, gel, np.median(gel[rest]) if rest.any() else 35.0).astype(np.float32)
    gel = uniform_filter(gel, size=15).astype(np.float32)

    # LoD2-Gebäudepunkte außerhalb der Meshes
    pts = []
    web_polys = []
    for art, gi, v in polys:
        c = v.mean(0)
        if art in (0, 1) and not in_boxen(v[:, 0], v[:, 1], mesh_boxen).all():
            p = flaeche_abtasten(v, PUNKT_ABSTAND)
            p = p[~in_boxen(p[:, 0], p[:, 1], mesh_boxen)]
            p = p[(p[:, 0] >= box[0]) & (p[:, 0] < box[2]) & (p[:, 1] >= box[1]) & (p[:, 1] < box[3])]
            if len(p):
                pts.append(p)
            if not in_boxen(np.array([c[0]]), np.array([c[1]]), mesh_boxen)[0]:
                web_polys.append((art, gi, v))
    Pg = np.vstack(pts) if pts else np.zeros((0, 3))
    if len(Pg):
        dom_max = maximum_filter(np.where(ok, dom, -1e9), size=3)
        gx = np.clip((Pg[:, 0] - box[0]).astype(np.int64), 0, W - 1)
        gy = np.clip((Pg[:, 1] - box[1]).astype(np.int64), 0, H - 1)
        ref = dom_max[gy, gx]
        phantom = (ref > -1e8) & (Pg[:, 2] > ref + PHANTOM_TOLERANZ)
        Pg = Pg[~phantom]
        log(f"  {len(Pg):,} LoD2-Punkte im Ring ({phantom.mean() * 100:.1f} % über bDOM verworfen)")

    # Bäume aus bDOM: Vegetation außerhalb der Gebäude, nur große Kronen (wie Bereinigung im Mesh)
    ndom = np.where(ok, dom - gel, 0)
    geb_rand = binary_dilation(fuss, iterations=2)
    veg = ok & (ndom > BDOM_BAUM_H) & ~geb_rand
    lab, n = label(veg, structure=np.ones((3, 3), bool))
    fl = np.bincount(lab.ravel(), minlength=n + 1)
    ho = np.zeros(n + 1)
    if n:
        ho[1:] = maximum(ndom, lab, index=np.arange(1, n + 1))
    gut = (fl >= BAUM_MIN_FLAECHE) & (ho >= BAUM_MIN_HOEHE)
    gut[0] = False
    baum = gut[lab]
    by, bx = np.nonzero(baum)
    xs, ys = box[0] + bx + 0.5, box[1] + by + 0.5
    drin = in_boxen(xs, ys, mesh_boxen)
    by, bx, xs, ys = by[~drin], bx[~drin], xs[~drin], ys[~drin]
    top = dom[by, bx]
    hoehe = ndom[by, bx]
    tb = []
    for k in range(0, 8):          # Krone als Körper: Oberfläche und darunter bis ~45 % der Höhe, alle 1 m
        z = top - k * 1.0
        s = z > top - 0.45 * hoehe
        if not s.any():
            break
        tb.append(np.c_[xs[s], ys[s], z[s]])
    Pt = np.vstack(tb) if tb else np.zeros((0, 3))
    log(f"  {len(Pt):,} bDOM-Baumpunkte im Ring")
    return dict(box=box, Pg=Pg, Pt=Pt, gelaende=gel, web_polys=web_polys)


# =====================================================================================================
# 5. Web-Paket
# =====================================================================================================
def uv_inseln(F, FT, VT, mat):
    """Zusammenhängende Textur-Inseln: Dreiecke, die eine Ecke mit gleicher UV teilen."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    uvq = np.round(VT[FT] * 65536).astype(np.int64)
    k = np.stack([F, uvq[..., 0], uvq[..., 1], np.repeat(mat[:, None].astype(np.int64), 3, 1)], -1).reshape(-1, 4)
    _, inv = np.unique(k, axis=0, return_inverse=True)
    inv = inv.ravel()
    n, nk = len(F), inv.max() + 1
    tri = np.repeat(np.arange(n), 3)
    g = coo_matrix((np.ones(len(tri), np.int8), (tri, inv + n)), shape=(n + nk, n + nk))
    _, lab = connected_components(g, directed=False)
    _, lab = np.unique(lab[:n], return_inverse=True)
    return lab.ravel()


def regalpacken(groessen):
    """Rechtecke (w,h) in Regale packen. Rückgabe Positionen (n,2), Breite, Höhe (Vielfache von 16)."""
    groessen = np.asarray(groessen, np.int64)
    flaeche = (groessen[:, 0] * groessen[:, 1]).sum()
    W = int(max(groessen[:, 0].max(), math.sqrt(flaeche * 1.12)))
    W = (W + 15) // 16 * 16
    reihenf = np.lexsort((-groessen[:, 0], -groessen[:, 1]))
    pos = np.zeros_like(groessen)
    x = y = regal_h = 0
    for i in reihenf:
        w, h = groessen[i]
        if x + w > W:
            y += regal_h
            x = regal_h = 0
        pos[i] = (x, y)
        x += w
        regal_h = max(regal_h, h)
    H = (y + regal_h + 15) // 16 * 16
    return pos, W, H


def zell_textur(tri, F, VT, FT, mat, insel, texbilder):
    """Atlas für die Dreiecke tri: Inseln (Bounding-Box + Rand) aus den Quelltexturen umpacken.
    Rückgabe atlas (H,W,3) uint8, neue UV je Ecke (len(tri),3,2) in Pixeln des Atlas (y nach unten)."""
    gr = np.array([[im.shape[1], im.shape[0]] for im in texbilder], np.float64)
    m = mat[tri].astype(np.int64)
    px = VT[FT[tri]] * gr[m][:, None, :]
    px[..., 1] = gr[m][:, None, 1] - px[..., 1]                  # Bild-y nach unten
    _, gruppe = np.unique(insel[tri], return_inverse=True)
    gruppe = gruppe.ravel()
    ng = gruppe.max() + 1
    lo = np.full((ng, 2), np.inf)
    hi = np.full((ng, 2), -np.inf)
    np.minimum.at(lo, gruppe, px.min(1))
    np.maximum.at(hi, gruppe, px.max(1))
    gm = np.zeros(ng, np.int64)
    gm[gruppe] = m
    s0 = np.maximum(np.floor(lo).astype(np.int64) - TEX_PAD, 0)
    s1 = np.minimum(np.ceil(hi).astype(np.int64) + TEX_PAD, gr[gm].astype(np.int64))
    groesse = s1 - s0
    pos, W, H = regalpacken(groesse)
    atlas = np.zeros((H, W, 3), np.uint8)
    for g in range(ng):
        (x0, y0), (x1, y1), (dx, dy) = s0[g], s1[g], pos[g]
        atlas[dy:dy + y1 - y0, dx:dx + x1 - x0] = texbilder[gm[g]][y0:y1, x0:x1]
    uv = px - s0[gruppe][:, None, :] + pos[gruppe][:, None, :]
    return atlas, uv


def schreibe_zellen(ziel, V, F, VT, FT, mat, tri_baum, texbilder, bounds):
    """Geometrie-Zellen + Textur-Stufen. Rückgabe (raster, zellen-Liste für meta.json, Bytes)."""
    os.makedirs(os.path.join(ziel, "z"), exist_ok=True)
    ex, ey = bounds[2] - bounds[0], bounds[3] - bounds[1]
    nx, ny = max(1, round(ex / ZELLE_ZIEL)), max(1, round(ey / ZELLE_ZIEL))
    zx, zy = ex / nx, ey / ny
    c = V[F].mean(1)
    cx = np.clip(((c[:, 0] - bounds[0]) / zx).astype(np.int64), 0, nx - 1)
    cy = np.clip(((c[:, 1] - bounds[1]) / zy).astype(np.int64), 0, ny - 1)
    zid = cy * nx + cx
    log("  Textur-Inseln suchen")
    insel = uv_inseln(F, FT, VT, mat)
    reihenf = np.argsort(zid, kind="stable")
    grenzen = np.searchsorted(zid[reihenf], np.arange(nx * ny + 1))
    zellen, summe = [], 0
    for k in range(nx * ny):
        tri = reihenf[grenzen[k]:grenzen[k + 1]]
        if len(tri) == 0:
            continue
        ix, iy = k % nx, k // nx
        name = f"{ix}_{iy}"
        tri = tri[np.argsort(tri_baum[tri], kind="stable")]     # Bäume ans Ende
        nb = int(tri_baum[tri].sum())
        atlas, uvpx = zell_textur(tri, F, VT, FT, mat, insel, texbilder)
        Ha, Wa = atlas.shape[:2]
        skala = min(1.0, TEX_MAX / max(Ha, Wa))
        tex = []
        for st, (f, q) in enumerate(zip(TEX_STUFEN, JPEG_Q)):
            w = max(4, int(round(Wa * f * skala / 4)) * 4)
            h = max(4, int(round(Ha * f * skala / 4)) * 4)
            im = Image.fromarray(atlas)
            if (w, h) != (Wa, Ha):
                im = im.resize((w, h), Image.BOX if f * skala <= 0.5 else Image.LANCZOS)
            p = os.path.join(ziel, "z", f"{name}_{st}.jpg")
            im.save(p, quality=q, optimize=True)
            tex.append([w, h, os.path.getsize(p)])
            summe += os.path.getsize(p)
        # Ecken deduplizieren: gleiche Mesh-Ecke + gleiche Atlas-UV
        uvn = uvpx / np.array([Wa, Ha], np.float64)
        uvq = np.clip(np.round(uvn * 65535), 0, 65535).astype(np.int64)
        ecke = F[tri].ravel()
        schl = (ecke * 65536 + uvq[..., 0].ravel()) * 65536 + uvq[..., 1].ravel()
        einzig, erst, idx = np.unique(schl, return_index=True, return_inverse=True)
        idx = idx.ravel()
        pv = V[ecke[erst]]
        lo, hi = pv.min(0), pv.max(0)
        q = max(float((hi - lo).max()) / 65535.0, 1e-4)
        q = math.ceil(q * 1e6) / 1e6
        lo = np.floor(lo * 1000) / 1000
        pos = np.clip(np.round((pv - lo) / q), 0, 65535).astype("<u2")
        uvo = uvq.reshape(-1, 2)[erst].astype("<u2")
        i32 = len(einzig) > 65535
        ind = idx.astype("<u4" if i32 else "<u2")
        roh = pos.tobytes()
        roh += b"\0" * (-len(roh) % 4)
        roh += uvo.tobytes() + ind.tobytes()
        p = os.path.join(ziel, "z", f"{name}.bin")
        with open(p, "wb") as fh:
            fh.write(roh)
        summe += len(roh)
        zellen.append(dict(id=name, ix=ix, iy=iy, o=[round(float(v), 3) for v in lo], q=q,
                           nv=int(len(einzig)), nt=int(len(tri)), nb=nb, i32=bool(i32), bytes=len(roh),
                           zmax=round(float(hi[2]), 2), tex=tex))
    raster = dict(x0=round(bounds[0], 3), y0=round(bounds[1], 3), dx=round(zx, 4), dy=round(zy, 4), nx=nx, ny=ny)
    return raster, zellen, summe


def ecken_farben(V, F, VT, FT, mat, texbilder):
    """Mittlere Texturfarbe je Mesh-Ecke (für die Fernansicht)."""
    summe = np.zeros((len(V), 3))
    n = np.zeros(len(V))
    for m, im in enumerate(texbilder):
        s = np.nonzero(mat == m)[0]
        if not len(s):
            continue
        h, w, _ = im.shape
        uv = VT[FT[s]]
        # leicht zur Dreiecksmitte ziehen (Inselränder vermeiden)
        uv = uv * 0.8 + uv.mean(1, keepdims=True) * 0.2
        px = np.clip((uv[..., 0] * w).astype(np.int64), 0, w - 1)
        py = np.clip(((1 - uv[..., 1]) * h).astype(np.int64), 0, h - 1)
        col = im[py, px].astype(np.float64)                         # (k,3,3)
        e = F[s].ravel()
        for ch in range(3):
            summe[:, ch] += np.bincount(e, col[..., ch].ravel(), len(V))
        n += np.bincount(e, minlength=len(V))
    return (summe / np.maximum(n, 1)[:, None]).astype(np.float32)


def schreibe_fern(ziel, V, F, VT, FT, mat, texbilder, raster, bounds):
    try:
        import fast_simplification
    except ImportError:
        log("  fast-simplification fehlt -> keine Fernansicht (pip install fast-simplification)")
        return None
    from scipy.spatial import cKDTree
    o = V.min(0)
    Vr = (V - o).astype(np.float32)
    red = 1.0 - min(1.0, FERN_DREIECKE / len(F))
    pv, pf = fast_simplification.simplify(Vr, F.astype(np.int32), target_reduction=red, agg=7)
    farbe_ecke = ecken_farben(V, F, VT, FT, mat, texbilder)
    d, nn = cKDTree(Vr).query(pv, k=6)
    w = 1.0 / (d + 0.2)
    col = (farbe_ecke[nn] * w[..., None]).sum(1) / w.sum(1)[:, None]
    col = np.clip(col, 0, 255).astype(np.uint8)
    # Dreiecke nach Zelle sortieren (der Viewer blendet Zellen aus, die im Detail geladen sind)
    c = pv[pf].mean(1) + o.astype(np.float32)
    cx = np.clip(((c[:, 0] - raster["x0"]) / raster["dx"]).astype(np.int64), 0, raster["nx"] - 1)
    cy = np.clip(((c[:, 1] - raster["y0"]) / raster["dy"]).astype(np.int64), 0, raster["ny"] - 1)
    zid = cy * raster["nx"] + cx
    r = np.argsort(zid, kind="stable")
    pf, zid = pf[r], zid[r]
    gr = np.searchsorted(zid, np.arange(raster["nx"] * raster["ny"] + 1))
    bereiche = {f"{k % raster['nx']}_{k // raster['nx']}": [int(gr[k]), int(gr[k + 1] - gr[k])]
                for k in range(raster["nx"] * raster["ny"]) if gr[k + 1] > gr[k]}
    lo = np.floor((pv.min(0) + o) * 1000) / 1000
    pa = pv.astype(np.float64) + o
    q = math.ceil(float((pa.max(0) - lo).max()) / 65535.0 * 1e6) / 1e6
    pos = np.clip(np.round((pa - lo) / q), 0, 65535).astype("<u2")
    i32 = len(pv) > 65535
    roh = pos.tobytes() + col.tobytes()
    roh += b"\0" * (-len(roh) % 4)
    roh += pf.astype("<u4" if i32 else "<u2").tobytes()
    with open(os.path.join(ziel, "fern.bin"), "wb") as fh:
        fh.write(roh)
    return dict(datei="fern.bin", o=[round(float(v), 3) for v in lo], q=q, nv=int(len(pv)), nt=int(len(pf)),
                i32=bool(i32), bytes=len(roh), zellen=bereiche)


def schreibe_umgebung_web(ziel, web_polys, box):
    """LoD2-Gebäude (außerhalb der Meshes) als graue Klötze in Zellen von UMG_ZELLE m."""
    d = os.path.join(ziel, "u")
    if os.path.isdir(d):
        shutil.rmtree(d)
    if not web_polys:
        return None
    os.makedirs(d)
    nx = max(1, math.ceil((box[2] - box[0]) / UMG_ZELLE))
    ny = max(1, math.ceil((box[3] - box[1]) / UMG_ZELLE))
    # Gebäude ganz einer Zelle zuordnen (nach Schwerpunkt aller seiner Polygone)
    gsum = {}
    for art, gi, v in web_polys:
        s = gsum.setdefault(gi, [0.0, 0.0, 0])
        s[0] += v[:, 0].mean()
        s[1] += v[:, 1].mean()
        s[2] += 1
    zelle_von = {gi: (min(nx - 1, max(0, int((s[0] / s[2] - box[0]) // UMG_ZELLE))),
                      min(ny - 1, max(0, int((s[1] / s[2] - box[1]) // UMG_ZELLE)))) for gi, s in gsum.items()}
    teile = {}
    for art, gi, v in web_polys:
        teile.setdefault(zelle_von[gi], []).append((art, v))
    zellen, summe = [], 0
    for (ix, iy), liste in sorted(teile.items()):
        P, Fi, Cn = [], [], []
        n0 = 0
        for art, v in liste:
            t = dreiecke_polygon(v)
            P.append(v)
            Fi.append(t + n0)
            Cn.append(np.full(len(v), art, np.uint8))
            n0 += len(v)
        P, Fi, A = np.vstack(P), np.vstack(Fi), np.concatenate(Cn)
        lo = np.floor(P.min(0) * 1000) / 1000
        q = math.ceil(max(float((P.max(0) - lo).max()) / 65535.0, 1e-4) * 1e6) / 1e6
        pos = np.clip(np.round((P - lo) / q), 0, 65535).astype("<u2")
        i32 = len(P) > 65535
        roh = pos.tobytes() + A.tobytes()
        roh += b"\0" * (-len(roh) % 4)
        roh += Fi.astype("<u4" if i32 else "<u2").tobytes()
        name = f"{ix}_{iy}"
        with open(os.path.join(d, f"{name}.bin"), "wb") as fh:
            fh.write(roh)
        summe += len(roh)
        zellen.append(dict(id=name, box=[box[0] + ix * UMG_ZELLE, box[1] + iy * UMG_ZELLE,
                                         min(box[2], box[0] + (ix + 1) * UMG_ZELLE),
                                         min(box[3], box[1] + (iy + 1) * UMG_ZELLE)],
                           o=[round(float(v), 3) for v in lo], q=q, nv=int(len(P)), nt=int(len(Fi)),
                           i32=bool(i32), bytes=len(roh)))
    return dict(zellen=zellen, bytes=summe)


def schreibe_gelaende_web(ziel, gel, box):
    r = GELAENDE_WEB_RES
    g = gel[::r, ::r]
    zmin = math.floor(float(g.min()))
    a = np.clip(np.round((g - zmin) * 100), 0, 65535).astype("<u2")
    with open(os.path.join(ziel, "gelaende.bin"), "wb") as fh:
        fh.write(a.tobytes())
    return dict(datei="gelaende.bin", x0=box[0] + 0.5, y0=box[1] + 0.5, res=r, nx=int(a.shape[1]),
                ny=int(a.shape[0]), zmin=zmin, skala=0.01, bytes=int(a.nbytes))


def nord_azimut(x, y):
    """Gitter-Azimut (Grad, im Uhrzeigersinn von Gitter-Nord) der geographischen Nordrichtung."""
    from pyproj import Transformer
    to_ll = Transformer.from_crs(CRS, "EPSG:4326", always_xy=True)
    to_g = Transformer.from_crs("EPSG:4326", CRS, always_xy=True)
    lon, lat = to_ll.transform(x, y)
    x2, y2 = to_g.transform(lon, lat + 0.001)
    return math.degrees(math.atan2(x2 - x, y2 - y)), lon, lat


# =====================================================================================================
# 6. Ablauf
# =====================================================================================================
def mesh_boxen_aller(ohne=None):
    out = {}
    for p in glob.glob(os.path.join(WORK, "*", "meta.json")):
        try:
            m = json.load(open(p, encoding="utf-8"))
            if m.get("id") != ohne:
                out[m["id"]] = m["bounds"]
        except (OSError, ValueError, KeyError):
            pass
    return out


def ring_und_ausgabe(kid, work, cache, bounds, web_dir, schreibe_web_ring=True):
    """Ring neu bauen: wolke.npz, gelaende.npz, Web-Umgebung (u/, gelaende.bin) -> meta.json des Web-Pakets."""
    andere = mesh_boxen_aller(ohne=kid)
    boxen = [bounds] + list(andere.values())
    zm = np.load(os.path.join(cache, "wolke_mesh.npz"))
    Pm = zm["P"].astype(np.float64) + zm["origin"]
    um = baue_umgebung(bounds, boxen, wolke_mesh=Pm)
    P = np.vstack([Pm, um["Pg"], um["Pt"]])
    baum = np.concatenate([zm["baum"], np.zeros(len(um["Pg"]), bool), np.ones(len(um["Pt"]), bool)])
    quelle = np.concatenate([np.zeros(len(Pm), np.uint8), np.ones(len(um["Pg"]), np.uint8),
                             np.full(len(um["Pt"]), 2, np.uint8)])
    origin = np.floor(P.min(0))
    atomar_npz(os.path.join(work, "wolke.npz"), origin=origin, P=(P - origin).astype(np.float32),
               baum=baum, quelle=quelle)
    box = um["box"]
    atomar_npz(os.path.join(work, "gelaende.npz"), x0=np.float64(box[0]), y0=np.float64(box[1]),
               res=np.float64(1.0), z=um["gelaende"].astype(np.float32))
    atomar_json(os.path.join(cache, "ring.json"), dict(ohne=sorted(andere), box=box,
                                                      erstellt=time.strftime("%Y-%m-%d %H:%M")))
    log(f"  wolke.npz: {len(P):,} Punkte (Mesh {len(Pm):,}, LoD2 {len(um['Pg']):,}, bDOM {len(um['Pt']):,})")
    web = None
    if schreibe_web_ring:
        os.makedirs(web_dir, exist_ok=True)
        web = dict(umgebung=schreibe_umgebung_web(web_dir, um["web_polys"], box),
                   gelaende=schreibe_gelaende_web(web_dir, um["gelaende"], box))
        atomar_json(os.path.join(cache, "web_ring.json"), web)
    return web


def tiles_json_eintragen(kid, name, bounds):
    p = os.path.join(WEB, "tiles", "tiles.json")
    d = {"version": 1, "crs": CRS, "kacheln": []}
    if os.path.exists(p):
        try:
            d = json.load(open(p, encoding="utf-8"))
        except ValueError:
            pass
    alt = next((k for k in d.get("kacheln", []) if k.get("id") == kid), None)
    eintrag = {"id": kid, "name": name or (alt or {}).get("name") or kid,
               "bounds": [round(v, 1) for v in bounds], "url": f"tiles/{kid}/", "meta": f"tiles/{kid}/meta.json"}
    d["version"], d["crs"] = 1, CRS
    d["kacheln"] = sorted([k for k in d.get("kacheln", []) if k.get("id") != kid] + [eintrag],
                          key=lambda k: k["id"])
    atomar_json(p, d, indent=2)


def ordnergroesse(p):
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(p) for f in fs)


def verarbeite(tile_dir, a):
    t_start = time.time()
    kid = kachel_id(tile_dir)
    work = os.path.join(WORK, kid)
    cache = os.path.join(work, "_cache")
    web_dir = os.path.join(WEB, "tiles", kid)
    os.makedirs(cache, exist_ok=True)
    zeiten = {}

    def zeit(name, t):
        zeiten[name] = round(time.time() - t, 1)

    log(f"Kachel {kid} aus {tile_dir}")
    t = time.time()
    V, F, VT, FT, mat, tex = lade_mesh(tile_dir, os.path.join(cache, "roh.npz"), neu=a.neu)
    bounds = [float(V[:, 0].min()), float(V[:, 1].min()), float(V[:, 0].max()), float(V[:, 1].max())]
    zeit("mesh_lesen", t)
    log(f"  {len(V):,} Ecken, {len(F):,} Dreiecke, {len(tex)} Texturen, "
        f"Ausdehnung {bounds[2] - bounds[0]:.0f} x {bounds[3] - bounds[1]:.0f} m")
    texbilder = None

    # --- Bäume + Punktwolke (Mesh-Teil)
    p_wm = os.path.join(cache, "wolke_mesh.npz")
    if a.neu or not os.path.exists(p_wm) or os.path.getmtime(p_wm) < os.path.getmtime(os.path.join(cache, "roh.npz")):
        t = time.time()
        log("Baum-Dreiecke (Grünindex) und Punktwolke")
        texbilder = lade_texturen(tex)
        gruen = gruen_dreiecke(F, VT, FT, mat, texbilder)
        P, pg = punktwolke(V, F, gruen)
        keep, info = bereinige(P, pg)
        tri_baum = baum_dreiecke_sauber(V, F, gruen, info)
        P, pg = P[keep], pg[keep]
        o = np.floor(P.min(0))
        atomar_npz(p_wm, origin=o, P=(P - o).astype(np.float32), baum=pg, tri_baum=tri_baum, gruen=gruen)
        log(f"  {gruen.mean() * 100:.1f} % grüne Dreiecke, davon Baum (große Krone): {tri_baum.mean() * 100:.1f} %; "
            f"Punktwolke {len(P):,} Punkte nach Bereinigung ({(~keep).mean() * 100:.0f} % entfernt)")
        zeit("baum_wolke", t)
    tri_baum = np.load(p_wm)["tri_baum"]

    # --- mesh.npz
    p_mesh = os.path.join(work, "mesh.npz")
    if a.neu or not os.path.exists(p_mesh) or os.path.getmtime(p_mesh) < os.path.getmtime(p_wm):
        o = np.floor(V.min(0))
        atomar_npz(p_mesh, origin=o, V=(V - o).astype(np.float32), F=F.astype(np.int32), baum=tri_baum)

    # --- meta.json (Server)  -- vor dem Ring, damit andere Kacheln diese Kachel ausschließen
    p_meta = os.path.join(work, "meta.json")
    alt_meta = json.load(open(p_meta, encoding="utf-8")) if os.path.exists(p_meta) else {}
    atomar_json(p_meta, {"id": kid, "bounds": [round(v, 3) for v in bounds], "crs": CRS,
                         "erstellt": alt_meta.get("erstellt") if not a.neu and alt_meta.get("erstellt")
                         else time.strftime("%Y-%m-%dT%H:%M:%S")}, indent=1)

    # --- Ring (LoD2 + bDOM) + Gelände
    p_ring = os.path.join(cache, "ring.json")
    andere = sorted(mesh_boxen_aller(ohne=kid))
    ring_alt = json.load(open(p_ring)) if os.path.exists(p_ring) else None
    ring_web = os.path.join(cache, "web_ring.json")
    if (a.neu or a.umgebung_neu or ring_alt is None or ring_alt.get("ohne") != andere
            or not all(os.path.exists(os.path.join(work, f)) for f in ("wolke.npz", "gelaende.npz"))
            or os.path.getmtime(p_ring) < os.path.getmtime(p_wm) or not os.path.exists(ring_web)):
        t = time.time()
        ring_und_ausgabe(kid, work, cache, bounds, web_dir)
        zeit("umgebung", t)
    ring_info = json.load(open(ring_web))

    # --- Web-Paket
    p_wmeta = os.path.join(web_dir, "meta.json")
    wmeta = json.load(open(p_wmeta)) if os.path.exists(p_wmeta) else {}
    sig = dict(v=WEB_VERSION, zelle=ZELLE_ZIEL, stufen=list(TEX_STUFEN), max=TEX_MAX, pad=TEX_PAD,
               q=list(JPEG_Q), fern=FERN_DREIECKE)
    if a.neu or a.web_neu or wmeta.get("sig") != sig or not os.path.isdir(os.path.join(web_dir, "z")):
        t = time.time()
        log("Web-Paket: Zellen, Texturstufen, Fernansicht")
        if texbilder is None:
            texbilder = lade_texturen(tex)
        zd = os.path.join(web_dir, "z")
        if os.path.isdir(zd):
            shutil.rmtree(zd)
        raster, zellen, nbytes = schreibe_zellen(web_dir, V, F, VT, FT, mat, tri_baum, texbilder, bounds)
        log(f"  {len(zellen)} Zellen, {mb(nbytes)}")
        fern = schreibe_fern(web_dir, V, F, VT, FT, mat, texbilder, raster, bounds)
        if fern:
            log(f"  Fernansicht {fern['nt']:,} Dreiecke, {mb(fern['bytes'])}")
        cx, cy = (bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2
        gn, lon, lat = nord_azimut(cx, cy)
        wmeta = dict(version=WEB_VERSION, id=kid, crs=CRS, bounds=[round(v, 3) for v in bounds],
                     z=[round(float(V[:, 2].min()), 2), round(float(V[:, 2].max()), 2)],
                     zentrum_ll=[round(lat, 6), round(lon, 6)], nord_gitter_az=round(gn, 4),
                     raster=raster, texel_m=[round(0.1 / f, 3) for f in TEX_STUFEN],
                     zellen=zellen, fern=fern, sig=sig, erstellt=time.strftime("%Y-%m-%dT%H:%M:%S"))
        zeit("web", t)
    wmeta["umgebung"] = ring_info["umgebung"]
    wmeta["gelaende"] = ring_info["gelaende"]
    os.makedirs(web_dir, exist_ok=True)
    atomar_json(p_wmeta, wmeta, separators=(",", ":"))
    tiles_json_eintragen(kid, a.name, bounds)

    # --- Nachbarn: deren Ring überdeckt diese Kachel -> neu (Mesh geht vor LoD2/bDOM)
    if not a.keine_nachbarn:
        for nid, nb in mesh_boxen_aller(ohne=kid).items():
            nr = os.path.join(WORK, nid, "_cache", "ring.json")
            if not os.path.exists(nr):
                continue
            r = json.load(open(nr))
            rb = r.get("box", [nb[0] - RING, nb[1] - RING, nb[2] + RING, nb[3] + RING])
            ueberlapp = rb[0] < bounds[2] and rb[2] > bounds[0] and rb[1] < bounds[3] and rb[3] > bounds[1]
            if ueberlapp and kid not in r.get("ohne", []):
                t = time.time()
                log(f"Nachbar {nid}: Ring ohne die neue Kachel neu berechnen")
                nweb = os.path.join(WEB, "tiles", nid)
                info = ring_und_ausgabe(nid, os.path.join(WORK, nid), os.path.join(WORK, nid, "_cache"), nb, nweb)
                pm = os.path.join(nweb, "meta.json")
                if os.path.exists(pm):
                    m = json.load(open(pm))
                    m["umgebung"], m["gelaende"] = info["umgebung"], info["gelaende"]
                    atomar_json(pm, m, separators=(",", ":"))
                zeit(f"nachbar_{nid}", t)

    # --- vorkomprimierte Fassungen (.gz) für den Server: Geometrie/JSON ~25–50 % kleiner, JPEG nicht
    vorkomprimieren(os.path.join(WEB, "tiles"))

    # --- Zusammenfassung
    w = np.load(os.path.join(work, "wolke.npz"))
    q = np.bincount(w["quelle"], minlength=3)
    print()
    print(f"Kachel {kid} fertig in {time.time() - t_start:.1f} s  (Schritte: {zeiten or 'alles aus dem Cache'})")
    print(f"  Mesh:     {len(V):,} Ecken, {len(F):,} Dreiecke, Baum-Dreiecke {tri_baum.mean() * 100:.1f} %")
    print(f"  Web:      {web_dir}  {mb(ordnergroesse(web_dir))}, {len(wmeta['zellen'])} Zellen "
          f"({wmeta['raster']['dx']:.1f} x {wmeta['raster']['dy']:.1f} m)")
    for st in range(len(TEX_STUFEN)):
        b = sum(z["tex"][st][2] for z in wmeta["zellen"])
        px = sum(z["tex"][st][0] * z["tex"][st][1] for z in wmeta["zellen"])
        print(f"            Texturstufe {st} ({wmeta['texel_m'][st] * 100:.0f} cm/px): {mb(b)} JPEG, "
              f"GPU {px * 4 * 4 / 3 / 1e6:.0f} MB für alle Zellen (RGBA + Mipmaps)")
    print(f"            Geometrie {mb(sum(z['bytes'] for z in wmeta['zellen']))}, "
          f"Fernansicht {mb((wmeta.get('fern') or {}).get('bytes', 0))}, "
          f"Umgebung {mb((wmeta.get('umgebung') or {}).get('bytes', 0))}")
    print(f"  Server:   {work}  wolke.npz {len(w['P']):,} Punkte (Mesh {q[0]:,}, LoD2 {q[1]:,}, bDOM {q[2]:,}), "
          f"Baum {w['baum'].mean() * 100:.1f} %; {mb(ordnergroesse(work) - ordnergroesse(cache))}")
    print(f"  tiles.json: {os.path.join(WEB, 'tiles', 'tiles.json')}")


def vorkomprimieren(ordner):
    """Für jede .bin/.json-Datei eine .gz daneben (nur wenn neuer oder fehlend); server/app.py liefert sie aus."""
    import gzip
    for wurzel, _, dateien in os.walk(ordner):
        for d in dateien:
            if not d.endswith((".bin", ".json")):
                continue
            q = os.path.join(wurzel, d)
            z = q + ".gz"
            if os.path.exists(z) and os.path.getmtime(z) >= os.path.getmtime(q):
                continue
            with open(q, "rb") as fi, gzip.GzipFile(z + ".teil", "wb", compresslevel=9, mtime=0) as fo:
                shutil.copyfileobj(fi, fo)
            os.replace(z + ".teil", z)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("kachel", help="Ordner mit OBJ/MTL/JPG aus dem Berlin-3D-Downloadportal")
    ap.add_argument("--name", help="Anzeigename (z. B. Wilmersdorf)")
    ap.add_argument("--umgebung-neu", action="store_true", help="Ring (LoD2/bDOM) neu berechnen")
    ap.add_argument("--web-neu", action="store_true", help="Web-Paket neu schreiben")
    ap.add_argument("--neu", action="store_true", help="alles neu berechnen")
    ap.add_argument("--keine-nachbarn", action="store_true", help="Ringe der Nachbarkacheln nicht anfassen")
    a = ap.parse_args()
    if not os.path.isdir(a.kachel):
        sys.exit(f"Ordner nicht gefunden: {a.kachel}")
    verarbeite(a.kachel, a)


if __name__ == "__main__":
    main()
