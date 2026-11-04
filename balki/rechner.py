"""
Ertrag für einen angetippten Punkt auf einer Hauswand.

Eingabe: Kachel-ID, Punkt (EPSG:25833) und Flächennormale aus dem 3D-Viewer, Anzahl Module, Aufstellung.
Ablauf:
  1. Wandrichtung robust aus den Mesh-Dreiecken rund um den Punkt (nicht nur dem einen getippten Dreieck)
  2. Außenseite prüfen (dort, wo kein Dach über einem liegt)
  3. Geländer-Vorderkante und -Oberkante aus dem Mesh -> Module hängen außen davor
  4. Horizont aus der Punktwolke (Mesh + Umgebung aus LoD2/bDOM), Jahressimulation (physik.py)

Server-Cache je Kachel (von pipeline/kachel.py): data/work/<id>/wolke.npz, mesh.npz, gelaende.npz, meta.json
"""
import json
import math
import os
import threading
import time
from collections import OrderedDict

import numpy as np
from pyproj import Geod, Transformer

from . import physik as ph

ZELLE = 20.0                  # m, Rasterweite des Punkt-Index
ERGEBNIS_DAUER = 600          # s, so lange bleibt ein Ergebnis im Arbeitsspeicher (dann gelöscht)
RICHTUNGEN = ["Nord", "Nordost", "Ost", "Südost", "Süd", "Südwest", "West", "Nordwest"]
GESCHOSS_HOEHE = 3.1          # m, Mittel Altbau/Neubau
MODUL_ABSTAND = 0.15          # m, Abstand der Module vor der Geländer-Vorderkante
UMKREIS_WAND = 2.5            # m, Dreiecke in diesem Umkreis bestimmen die Wandrichtung
MAX_KACHELN_IM_SPEICHER = 3


class EingabeFehler(ValueError):
    """Text darf der Nutzer sehen."""


def richtung_text(az):
    return RICHTUNGEN[int(((az % 360) + 22.5) // 45) % 8]


class Kachel:
    def __init__(self, ordner):
        self.meta = json.load(open(os.path.join(ordner, "meta.json"), encoding="utf-8"))
        w = np.load(os.path.join(ordner, "wolke.npz"))
        P = w["P"].astype(np.float64) + w["origin"]
        baum = w["baum"].astype(bool)
        # Raster-Index (ZELLE m): Punkte nach Zelle sortiert, damit eine Anfrage nur die Zellen im Umkreis liest
        self.g0 = P[:, :2].min(0)
        ij = np.floor((P[:, :2] - self.g0) / ZELLE).astype(np.int64)
        self.gnx, self.gny = int(ij[:, 0].max()) + 1, int(ij[:, 1].max()) + 1
        zelle = ij[:, 1] * self.gnx + ij[:, 0]
        o = np.argsort(zelle, kind="stable")
        self.P, self.baum = P[o], baum[o]
        self.start = np.searchsorted(zelle[o], np.arange(self.gnx * self.gny + 1))
        self.umgebung = bool((w["quelle"] != 0).any()) if "quelle" in w.files else False
        m = np.load(os.path.join(ordner, "mesh.npz"))
        V = m["V"].astype(np.float64) + m["origin"]
        F = m["F"].astype(np.int64)
        T = V[F]
        cr = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
        flaeche = 0.5 * np.linalg.norm(cr, axis=1)
        self.tri_c = T.mean(1)
        self.tri_lo, self.tri_hi = T.min(1), T.max(1)
        self.tri_n = cr / np.maximum(2 * flaeche, 1e-12)[:, None]
        self.tri_a = flaeche
        self.tri_baum = m["baum"].astype(bool) if "baum" in m.files else np.zeros(len(F), bool)
        self.T = T
        g = np.load(os.path.join(ordner, "gelaende.npz"))
        self.g_x0, self.g_y0, self.g_res = float(g["x0"]), float(g["y0"]), float(g["res"])
        self.g_z = g["z"]
        xmin, ymin, xmax, ymax = self.meta["bounds"]
        cx, cy = (xmin + xmax) / 2, (ymin + ymax) / 2
        to_ll = Transformer.from_crs(self.meta.get("crs", "EPSG:25833"), "EPSG:4326", always_xy=True)
        lon0, lat0 = to_ll.transform(cx, cy)
        lon1, lat1 = to_ll.transform(cx, cy + 100)
        self.gn_true = Geod(ellps="WGS84").inv(lon0, lat0, lon1, lat1)[0]   # wahres Azimut der Gitter-Nordrichtung
        self.lonlat = (lon0, lat0)

    def umkreis(self, x, y, r):
        """Indizes aller Punkte in den Rasterzellen, die das Quadrat ±r um (x, y) berühren."""
        i0, j0 = np.floor((np.array([x - r, y - r]) - self.g0) / ZELLE).astype(int)
        i1, j1 = np.floor((np.array([x + r, y + r]) - self.g0) / ZELLE).astype(int)
        i0, i1 = max(i0, 0), min(i1, self.gnx - 1)
        j0, j1 = max(j0, 0), min(j1, self.gny - 1)
        if i0 > i1 or j0 > j1:
            return np.zeros(0, np.int64)
        teile = [np.arange(self.start[j * self.gnx + i0], self.start[j * self.gnx + i1 + 1]) for j in range(j0, j1 + 1)]
        return np.concatenate(teile)

    def gelaende(self, x, y):
        i = int(np.clip((y - self.g_y0) / self.g_res, 0, self.g_z.shape[0] - 1))
        j = int(np.clip((x - self.g_x0) / self.g_res, 0, self.g_z.shape[1] - 1))
        return float(self.g_z[i, j])

    def nah(self, p, r):
        """Indizes der Dreiecke, deren Umriss den Würfel ±r um p berührt (auch große Wanddreiecke)."""
        p = np.asarray(p, float)
        return np.nonzero(np.all(self.tri_hi >= p - r, axis=1) & np.all(self.tri_lo <= p + r, axis=1))[0]

    def flaechen_punkte(self, idx, p, r, abstand=0.12, max_je=3000):
        """Gleichmäßige Punkte auf den Dreiecken idx im Würfel ±r um p (für Geländer/Balkonplatte)."""
        T = self.T[idx]
        k = np.clip(np.ceil(self.tri_a[idx] / abstand ** 2), 1, max_je).astype(np.int64)
        j = np.repeat(np.arange(len(idx)), k)
        rng = np.random.default_rng(0)
        r1, r2 = np.sqrt(rng.random(len(j))), rng.random(len(j))
        Q = T[j, 0] * (1 - r1)[:, None] + T[j, 1] * (r1 * (1 - r2))[:, None] + T[j, 2] * (r1 * r2)[:, None]
        Q = np.vstack([Q, T.reshape(-1, 3)])
        b = np.r_[self.tri_baum[idx][j], np.repeat(self.tri_baum[idx], 3)]
        drin = np.all(np.abs(Q - p) <= r, axis=1)
        return Q[drin], b[drin]


class Rechner:
    def __init__(self, work_dir, wetter=None):
        self.work_dir = os.path.realpath(work_dir)
        self._kacheln = OrderedDict()
        self._lock = threading.Lock()
        self._ergebnisse = OrderedDict()
        self.idx, mid = ph.zeitachse()
        lat, lon = 52.50, 13.40                          # Wetter gilt für ganz Berlin
        if wetter:
            w, sp, self.wquelle = ph.pvgis_wetter(wetter, lat, lon, mid)
        else:
            w, sp, self.wquelle = ph.synth_wetter(lat, lon, mid)
        self.sim = ph.Sim(w, sp, mid)
        self.monat = self.idx.month.to_numpy()

    # ------------------------------------------------------------ Kacheln
    def kachel_ids(self):
        if not os.path.isdir(self.work_dir):
            return []
        return sorted(d for d in os.listdir(self.work_dir)
                      if os.path.exists(os.path.join(self.work_dir, d, "wolke.npz")))

    def kachel(self, kid):
        with self._lock:
            if kid in self._kacheln:
                self._kacheln.move_to_end(kid)
                return self._kacheln[kid]
        if kid not in self.kachel_ids():
            raise EingabeFehler("Für dieses Gebiet gibt es noch kein 3D-Modell.")
        k = Kachel(os.path.join(self.work_dir, kid))
        with self._lock:
            self._kacheln[kid] = k
            while len(self._kacheln) > MAX_KACHELN_IM_SPEICHER:
                self._kacheln.popitem(last=False)
        return k

    # ------------------------------------------------------------ Geometrie
    def wand(self, k, p, n_tipp):
        """Wandnormale (horizontal, nach außen) aus den Dreiecken um p."""
        idx = k.nah(p, UMKREIS_WAND)
        idx = idx[~k.tri_baum[idx]]
        if len(idx) == 0:
            raise EingabeFehler("An dieser Stelle ist keine Hauswand zu finden. Tippe bitte direkt auf deinen Balkon.")
        nn = k.tri_n[idx]
        senkrecht = np.abs(nn[:, 2]) < 0.35
        h = nn[:, :2]
        hl = np.linalg.norm(h, axis=1)
        ok = senkrecht & (hl > 0.5)
        if np.minimum(k.tri_a[idx][ok], (2 * UMKREIS_WAND) ** 2).sum() < 0.5:
            raise EingabeFehler("Hier ist keine senkrechte Wand. Tippe bitte auf die Wand oder das Geländer deines Balkons.")
        h = h[ok] / hl[ok, None]
        a = np.minimum(k.tri_a[idx][ok], (2 * UMKREIS_WAND) ** 2)
        # Doppelwinkel-Mittel: Richtung unabhängig vom Vorzeichen (Innen-/Außenseite einzelner Dreiecke)
        ang = np.arctan2(h[:, 1], h[:, 0])
        ref = math.atan2(n_tipp[1], n_tipp[0])
        # nur Dreiecke, deren Richtung höchstens 40° von der getippten Fläche abweicht (Ecken, Erker)
        d = np.angle(np.exp(2j * (ang - ref))) / 2
        nah_dran = np.abs(d) < math.radians(40)
        if a[nah_dran].sum() >= 0.5:
            ang, a, d = ang[nah_dran], a[nah_dran], d[nah_dran]
        mittel = ref + float(np.angle((a * np.exp(2j * d)).sum()) / 2)
        n = np.array([math.cos(mittel), math.sin(mittel)])
        if n @ n_tipp[:2] < 0:
            n = -n
        # Außenseite: über dem Punkt hinter der Wand liegt das Haus (Dach weit über p), davor freier Raum
        def dach(q):
            i = k.umkreis(q[0], q[1], 1.0)
            Pi = k.P[i]
            s = (np.abs(Pi[:, 0] - q[0]) < 1.0) & (np.abs(Pi[:, 1] - q[1]) < 1.0) & ~k.baum[i]
            return float(Pi[s, 2].max()) if s.any() else -1e9
        vorn, hinten = dach(p[:2] + 4 * n), dach(p[:2] - 4 * n)
        if vorn > hinten + 2.5:
            n = -n
        return n

    def balkon(self, k, p, n, anzahl, geneigt):
        """Module außen vor dem Geländer. Rückgabe: Module (Ecken, Rechenpunkte), Hinweise."""
        hinweise = []
        t = np.array([-n[1], n[0]])
        idx = k.nah(p, 4.0)
        idx = idx[~k.tri_baum[idx]]
        Q, _ = k.flaechen_punkte(idx, p, 4.0)
        u = (Q[:, :2] - p[:2]) @ t
        o = (Q[:, :2] - p[:2]) @ n
        z = Q[:, 2]
        # Geländer/Balkon: was in Höhe des Punktes vor der Wand liegt
        band = (np.abs(u) < 0.9) & (z > p[2] - 1.3) & (z < p[2] + 0.9) & (o > -2.0) & (o < 3.5)
        if band.sum() >= 20:
            vorn = float(np.percentile(o[band], 97))
        else:
            vorn = 0.0
        vorn = float(np.clip(vorn, 0.0, 3.5))
        # Oberkante: höchster Punkt nahe der Vorderkante, höchstens 1,3 m über dem Tipp-Punkt
        kante = (np.abs(u) < 0.9) & (z > p[2] - 1.3) & (z < p[2] + 1.3) & (o > vorn - 0.35) & (o < 3.5)
        if kante.sum() >= 10:
            oben = float(np.percentile(z[kante], 98))
        else:
            oben = p[2] + 0.5
        oben = float(np.clip(oben, p[2] - 0.2, p[2] + 1.3))
        # Viele Balkone sind im Photogrammetrie-Mesh nur Textur auf glatter Fläche: kein Hinweis an Nutzer,
        # die Module hängen dann an der sichtbaren Fassade (= Balkonfront).
        abstand = vorn + MODUL_ABSTAND
        m = ph.MODUL
        breite = anzahl * m["w"] + (anzahl - 1) * m["gap"]
        neig = math.radians(ph.AUSSTELLWINKEL) if geneigt else 0.0
        module = []
        for i in range(anzahl):
            ua = -breite / 2 + i * (m["w"] + m["gap"])
            ub = ua + m["w"]
            z_unten = oben - m["h"] * math.cos(neig)
            # geneigt: Unterkante am Geländer, Oberkante nach außen ausgestellt
            def ecke(uu, zz, aussen):
                q = p[:2] + t * uu + n * (abstand + aussen)
                return [round(float(q[0]), 2), round(float(q[1]), 2), round(float(zz), 2)]
            ecken = [ecke(ua, z_unten, 0.0), ecke(ub, z_unten, 0.0),
                     ecke(ub, oben, m["h"] * math.sin(neig)), ecke(ua, oben, m["h"] * math.sin(neig))]
            punkte = []
            for fu in (1 / 6, 0.5, 5 / 6):
                for fz in (0.25, 0.75):
                    q = p[:2] + t * (ua + fu * m["w"]) + n * (abstand + fz * m["h"] * math.sin(neig))
                    punkte.append([q[0], q[1], z_unten + fz * (oben - z_unten)])
            module.append(dict(ecken=ecken, punkte=np.array(punkte)))
        mitte = np.array([*(p[:2] + n * abstand), (oben + oben - m["h"]) / 2])
        return module, mitte, oben, hinweise

    # ------------------------------------------------------------ Ertrag
    def ertrag(self, kid, x, y, z, nx, ny, anzahl=None, aufstellung="senkrecht", breite=None):
        """breite: vom Nutzer aufgezogene Balkonbreite in m (optional). anzahl None = aus der Breite (1 oder 2)."""
        m = ph.MODUL
        passen = None
        if breite is not None:
            if not 0.5 <= breite <= 15:
                raise EingabeFehler("Der Rahmen ist zu klein oder zu groß. Zieh ihn bitte über die Breite deines Balkons.")
            passen = int(math.floor((breite + m["gap"]) / (m["w"] + m["gap"])))
        if anzahl is None:
            anzahl = 2 if passen is None else max(1, min(2, passen))
        if anzahl not in (1, 2):
            raise EingabeFehler("Bitte 1 oder 2 Module wählen.")
        if aufstellung not in ("senkrecht", "geneigt"):
            raise EingabeFehler("Unbekannte Aufstellung.")
        k = self.kachel(kid)
        xmin, ymin, xmax, ymax = k.meta["bounds"]
        if not (xmin - 2 <= x <= xmax + 2 and ymin - 2 <= y <= ymax + 2 and -50 < z < 400):
            raise EingabeFehler("Dieser Punkt liegt nicht in der gewählten Kachel.")
        hl = math.hypot(nx, ny)
        if hl < 0.3:
            raise EingabeFehler("Das ist ein Dach oder Boden. Tippe bitte auf die Wand oder das Geländer deines Balkons.")
        schluessel = (kid, round(x * 4), round(y * 4), round(z * 4), round(math.degrees(math.atan2(ny, nx)) / 2),
                      anzahl, aufstellung, None if breite is None else round(breite * 4))
        with self._lock:
            jetzt = time.monotonic()
            while self._ergebnisse and next(iter(self._ergebnisse.values()))[0] < jetzt - ERGEBNIS_DAUER:
                self._ergebnisse.popitem(last=False)
            if schluessel in self._ergebnisse:
                return self._ergebnisse[schluessel][1]
        p = np.array([x, y, z], float)
        n = self.wand(k, p, np.array([nx / hl, ny / hl]))
        module, mitte, oben, hinweise = self.balkon(k, p, n, anzahl, aufstellung == "geneigt")
        if passen is not None and anzahl > passen:
            hinweise.append(f"Dein Balkon ist etwa {breite:.1f} m breit".replace(".", ",")
                            + (". Dort passt rechnerisch kein Standardmodul (1,72 m); ein kleineres Modul bringt etwas weniger."
                               if passen == 0 else ". Dort passt rechnerisch nur ein Standardmodul."))
        geo = dict(module=module, n=n, vorschlag=dict(wp_modul=ph.MODUL["wp"]))
        # Hindernisse vor der Wand im Umkreis des Horizonts
        # nur Rasterzellen vor der Wand (Halbebene) im Umkreis lesen
        i = k.umkreis(mitte[0] + n[0] * ph.HORIZONT_RADIUS / 2, mitte[1] + n[1] * ph.HORIZONT_RADIUS / 2,
                      ph.HORIZONT_RADIUS / 2 + 2 * ZELLE)
        Pi = k.P[i]
        d = Pi[:, :2] - mitte[:2]
        sel = ((np.abs(d[:, 0]) < ph.HORIZONT_RADIUS) & (np.abs(d[:, 1]) < ph.HORIZONT_RADIUS)
               & (Pi[:, 2] > oben - ph.MODUL["h"] - 0.5) & (d @ n > 0.2))
        Q, qb = Pi[sel], k.baum[i][sel]
        az = (math.degrees(math.atan2(n[0], n[1])) + k.gn_true) % 360
        neigung = 90.0 - ph.AUSSTELLWINKEL if aufstellung == "geneigt" else 90.0
        wp_modul = ph.WP_OPTIMIERT if aufstellung == "geneigt" else ph.MODUL["wp"]
        r = ph.simuliere_balkon(self.sim, geo, Q, qb, k.gn_true, az, neigung=neigung, wp_modul=wp_modul)
        pac = np.round(r["pac"]).astype(int)
        frei = r["pac_frei"]
        kwh, kwh_frei = float(pac.sum()) / 1000, float(frei.sum()) / 1000
        monat = np.bincount(self.monat - 1, weights=pac, minlength=12) / 1000
        boden = k.gelaende(*mitte[:2])
        unterkante = oben - ph.MODUL["h"]
        hoehe = max(0.0, unterkante - boden)
        # Daten reichen 220 m weit? Ohne Umgebung (LoD2/bDOM) nur bis zum Kachelrand
        rand_abstand = min(mitte[0] - xmin, xmax - mitte[0], mitte[1] - ymin, ymax - mitte[1])
        rand = (not k.umgebung) and rand_abstand < 60
        if rand:
            hinweise.append("Dein Balkon liegt nah am Rand des 3D-Modells. Schatten von weiter entfernten "
                            "Häusern fehlen vielleicht, der Ertrag kann etwas niedriger sein.")
        ergebnis = dict(
            ok=True, kachel=kid, azimut=round(az, 1), richtung=richtung_text(az),
            hoehe_ueber_boden_m=round(hoehe, 1), geschoss=int(max(0, round(hoehe / GESCHOSS_HOEHE))),
            module=[m["ecken"] for m in module],
            modul=dict(anzahl=anzahl, wp_je_modul=wp_modul, wp=anzahl * wp_modul,
                       breite_m=ph.MODUL["w"], hoehe_m=ph.MODUL["h"],
                       balkon_breite_m=None if breite is None else round(breite, 2), passen=passen),
            kwh_jahr=round(kwh, 1), kwh_jahr_frei=round(kwh_frei, 1),
            verschattung=round(max(0.0, 1 - kwh / max(kwh_frei, 1e-6)), 3),
            monat_kwh=[round(float(v), 1) for v in monat],
            stunde_wh=pac.tolist(),
            sonnenstunden=round(r["sonne_mod"]), sonnenstunden_frei=round(r["sonne_frei"]),
            horizont=dict(schritt_grad=ph.AZ_STEP, gebaeude=[round(float(v), 1) for v in r["hb"]],
                          baeume=[round(float(v), 1) for v in r["ht"]]),
            rand=bool(rand), hinweise=hinweise, wetter=self.wquelle,
            annahmen=dict(verluste=ph.VERLUSTE, temperaturkoeffizient=ph.GAMMA, wechselrichter_w=ph.WR_AC,
                          wechselrichter_wirkungsgrad=ph.WR_ETA, albedo=ph.ALBEDO,
                          lichtdurchlass_baum_sommer=ph.TAU_BELAUBT, lichtdurchlass_baum_winter=ph.TAU_KAHL,
                          neigung_grad=neigung, jahr=ph.JAHR),
        )
        with self._lock:
            self._ergebnisse[schluessel] = (time.monotonic(), ergebnis)
            while len(self._ergebnisse) > 300:
                self._ergebnisse.popitem(last=False)
        return ergebnis
