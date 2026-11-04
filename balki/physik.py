"""
Physik des Ertrags: Wetter, Sonnenstand, Horizont, Himmelsanteil, Leistung.

Übernommen aus dem bisherigen pipeline/angebot.py (dort seit Oktober 2026 erprobt) – nur die Teile,
die für einen Balkon gebraucht werden. Koordinaten: EPSG:25833 (x Ost, y Nord, z Höhe in m).
"""
import math

import numpy as np
import pandas as pd
import pvlib

MODUL = dict(w=1.72, h=1.13, wp=430, gap=0.04)   # Standardmodul quer am Geländer
KLEIN = dict(w=1.15, h=1.03, wp=250)              # kleines Modul für schmale Balkone
MAX_MODULE = 2
WR_AC = 800.0            # W, Grenze Steckersolargerät
WR_ETA = 0.96
VERLUSTE = 0.03          # Kabel, Mismatch, Verschmutzung
GAMMA = -0.0035          # Temperaturkoeffizient Leistung 1/K
ALBEDO = 0.15            # städtischer Boden
TAU_BELAUBT = 0.30       # Lichtdurchlass Baumkrone Mai–Oktober (Kronen sind nicht dicht, eher optimistisch)
TAU_KAHL = 0.65          # Lichtdurchlass Baumkrone November–April
NAH_MIN = 1.8            # m, nähere Punkte zählen nicht als Schattenwerfer (eigener Balkon, Mesh-Rauschen)
HORIZONT_MIN_PUNKTE = 6  # so viele Punkte müssen in einem Sektor höher liegen, damit er als verdeckt zählt
HORIZONT_RADIUS = 220.0  # m
AZ_STEP = 2              # Grad je Horizont-Sektor
NB = 360 // AZ_STEP
JAHR = 2025
AUSSTELLWINKEL = 30      # Grad, verstellbare Geländerhalterung (Paket "Optimiert")
WP_OPTIMIERT = 450       # Wp, bifaziales Glas-Glas-Modul gleicher Größe

# Mittlere Monatssummen Globalstrahlung horizontal (kWh/m²) und Lufttemperatur (°C), Raum Berlin,
# gerundete Klimamittel. Linke-Trübung typisch Mitteleuropa, Stadt.
GHI_MONAT = [21, 38, 77, 123, 155, 163, 160, 136, 92, 52, 23, 15]
T_MONAT = [1.0, 1.9, 5.0, 10.1, 14.5, 17.7, 19.8, 19.4, 15.1, 10.0, 5.4, 2.1]
LINKE_MONAT = [3.0, 3.3, 3.6, 4.0, 4.2, 4.4, 4.5, 4.4, 4.0, 3.6, 3.2, 3.0]

AZC = (np.arange(NB) + 0.5) * AZ_STEP
ELC = np.arange(0.5, 90.0, 1.0)



# ------------------------------------------------------------------ Wetter
def zeitachse():
    idx = pd.date_range(f"{JAHR}-01-01 00:00", periods=8760, freq="h", tz="Europe/Berlin")
    return idx, idx + pd.Timedelta(minutes=30)


def synth_wetter(lat, lon, mid):
    loc = pvlib.location.Location(lat, lon, tz="Europe/Berlin", altitude=40)
    sp = loc.get_solarposition(mid)
    tl = pd.Series(np.array(LINKE_MONAT)[mid.month - 1], index=mid)
    cs = loc.get_clearsky(mid, model="ineichen", solar_position=sp, linke_turbidity=tl)
    ghi_cs = cs["ghi"].to_numpy()
    rng = np.random.default_rng(42)
    month = mid.month.to_numpy()
    doy = mid.dayofyear.to_numpy()
    kd_h = np.zeros(len(mid))
    K_h = np.zeros(len(mid))
    for m in range(1, 13):
        sel = month == m
        days = np.unique(doy[sel])
        target = GHI_MONAT[m - 1] * 1000.0
        K = min(target / ghi_cs[sel].sum(), 0.92)
        c = 1.6                                    # klein = viele klare und viele trübe Tage
        kd = rng.beta(K * c, (1 - K) * c, len(days))
        day_of = {d: i for i, d in enumerate(days)}
        di = np.array([day_of[d] for d in doy[sel]])
        for _ in range(8):                         # exakt auf die Monatssumme skalieren
            g = (ghi_cs[sel] * kd[di]).sum()
            kd = np.clip(kd * target / max(g, 1e-6), 0.04, 1.0)
        kd_h[sel] = kd[di]
        K_h[sel] = K
    ghi = ghi_cs * kd_h
    er = pvlib.irradiance.erbs(ghi, sp["zenith"], mid)
    dhi = np.clip(er["dhi"].to_numpy(), 0, None)
    dni = np.clip(np.nan_to_num(er["dni"].to_numpy()), 0, cs["dni"].to_numpy() * 1.05)
    hour = mid.hour.to_numpy() + 0.5
    summer = ((month >= 4) & (month <= 9)).astype(float)
    temp = (np.array(T_MONAT)[month - 1] + 3.5 * np.cos(2 * np.pi * (hour - 15) / 24)
            + (2 + 3 * summer) * (kd_h - K_h))
    w = pd.DataFrame(dict(ghi=ghi, dni=dni, dhi=dhi, temp_air=temp, wind_speed=2.0), index=mid)
    return w, sp, "synthetisches Referenzjahr (kalibriert auf Berliner Monatsmittel der Einstrahlung)"


def pvgis_wetter(path, lat, lon, mid):
    r = pvlib.iotools.read_pvgis_tmy(path, map_variables=True)
    data = r[0] if isinstance(r, tuple) else r
    data = data.copy()
    data.index = pd.DatetimeIndex([t.replace(year=JAHR) for t in data.index])
    if data.index.tz is None:
        data.index = data.index.tz_localize("UTC")
    data = data.tz_convert("Europe/Berlin").sort_index()
    data = data[~data.index.duplicated()]
    data = data.reindex(mid, method="nearest")
    loc = pvlib.location.Location(lat, lon, tz="Europe/Berlin", altitude=40)
    sp = loc.get_solarposition(mid)
    w = data[["ghi", "dni", "dhi", "temp_air", "wind_speed"]].astype(float)
    return w, sp, "PVGIS typisches Referenzjahr (TMY)"


def horizont(p, nrm, Q, qb, gn_true):
    d = Q - p
    dh = np.hypot(d[:, 0], d[:, 1])
    front = d[:, :2] @ nrm
    # Teile direkt am Modul (Balkonplatte darüber, Brüstung, Loggia-Wände) sind im Mesh unsicher und
    # werden ignoriert: es zählen nur Hindernisse ab NAH_MIN Meter Abstand vor dem Modul.
    ok = (front > NAH_MIN) & (dh > NAH_MIN) & (d[:, 2] > 0) & (dh < HORIZONT_RADIUS)
    d, dh, bt = d[ok], dh[ok], qb[ok]
    el = np.degrees(np.arctan2(d[:, 2], dh))
    azt = (np.degrees(np.arctan2(d[:, 0], d[:, 1])) + gn_true) % 360
    bi = (azt // AZ_STEP).astype(np.int64) % NB
    return _horizont_robust(bi[~bt], el[~bt]), _horizont_robust(bi[bt], el[bt])


def _horizont_robust(bi, el, n=HORIZONT_MIN_PUNKTE):
    """Je Richtungssektor die Höhe, über der noch mindestens n Punkte liegen.
    Einzelne Ausreißer im Mesh (Antennen, Kanten, Rauschen) werfen so keinen Schatten."""
    h = np.zeros(NB)
    if len(el) == 0:
        return h
    o = np.lexsort((-el, bi))
    bi, el = bi[o], el[o]
    start = np.searchsorted(bi, np.arange(NB))
    ende = np.searchsorted(bi, np.arange(NB), side="right")
    for k in range(NB):
        c = ende[k] - start[k]
        if c >= n:
            h[k] = el[start[k] + n - 1]
    return h


def himmel_faktor(hb, ht, az_mod, tau, neigung=90.0):
    """Anteil des für die Modulfläche sichtbaren Himmels (isotrop gewichtet); neigung 90° = senkrecht."""
    A = np.radians(AZC - az_mod)[:, None]
    E = np.radians(ELC)[None, :]
    b = math.radians(neigung)
    ns = math.sin(b) * np.cos(E) * np.cos(A) + math.cos(b) * np.sin(E)
    w = np.clip(ns, 0, None) * np.cos(E)
    Bb = ELC[None, :] < hb[:, None]
    Bt = (ELC[None, :] < ht[:, None]) & ~Bb
    tot = w.sum()
    return float((tot - (w * Bb).sum() - (w * Bt).sum() * (1 - tau)) / tot)


# ------------------------------------------------------------------ Simulation
class Sim:
    def __init__(self, wetter, sp, mid):
        self.w = wetter
        self.sp = sp
        self.mid = mid
        self.el = (90 - sp["apparent_zenith"]).to_numpy()
        self.az = sp["azimuth"].to_numpy()
        self.bi = (self.az // AZ_STEP).astype(np.int64) % NB
        self.month = mid.month.to_numpy()
        self.belaubt = (self.month >= 5) & (self.month <= 10)
        self.tau = np.where(self.belaubt, TAU_BELAUBT, TAU_KAHL)
        self.dni_extra = pvlib.irradiance.get_extra_radiation(mid).to_numpy()

    def einstrahlung(self, az_mod, neigung=90.0):
        sp, w = self.sp, self.w
        aoi = pvlib.irradiance.aoi(neigung, az_mod, sp["apparent_zenith"], sp["azimuth"]).to_numpy()
        hd = pvlib.irradiance.haydavies(neigung, az_mod, w["dhi"], w["dni"], self.dni_extra,
                                        sp["apparent_zenith"], sp["azimuth"], return_components=True)
        iso = np.nan_to_num(np.asarray(hd["poa_isotropic"], float))
        circ = np.nan_to_num(np.asarray(hd["poa_circumsolar"], float))
        beam = np.where((aoi < 90) & (self.el > 0), w["dni"].to_numpy() * np.cos(np.radians(aoi)), 0.0)
        beam = np.clip(beam, 0, None)
        ground = w["ghi"].to_numpy() * ALBEDO * (1 - math.cos(math.radians(neigung))) / 2
        iam = np.nan_to_num(pvlib.iam.ashrae(aoi, b=0.05))
        return dict(aoi=aoi, iso=iso, circ=circ, beam=beam, ground=ground, iam=iam)

    def leistung(self, E, modul_frac, modul_iso, wp_modul):
        """modul_frac: Liste je Modul (8760,) Anteil direkte Sonne; modul_iso: (8760,) Himmelsfaktor."""
        pdc = np.zeros(len(self.mid))
        for frac, isof in zip(modul_frac, modul_iso):
            direkt = (E["beam"] + E["circ"]) * frac
            glob = direkt + E["iso"] * isof + E["ground"]
            eff = direkt * E["iam"] + (E["iso"] * isof + E["ground"]) * 0.95
            tc = pvlib.temperature.faiman(glob, self.w["temp_air"].to_numpy(), self.w["wind_speed"].to_numpy())
            pdc += pvlib.pvsystem.pvwatts_dc(eff, tc, wp_modul, GAMMA) * (1 - VERLUSTE)
        pac = pvlib.inverter.pvwatts(pdc, WR_AC / WR_ETA, WR_ETA)
        return np.clip(np.nan_to_num(np.asarray(pac, float)), 0, WR_AC)

    def referenz_dach(self):
        """Plausibilitätscheck: 1 kWp, 35° Süd, unverschattet."""
        sp, w = self.sp, self.w
        poa = pvlib.irradiance.get_total_irradiance(35, 180, sp["apparent_zenith"], sp["azimuth"],
                                                    w["dni"], w["ghi"], w["dhi"], dni_extra=self.dni_extra,
                                                    model="haydavies", albedo=ALBEDO)
        g = np.nan_to_num(poa["poa_global"].to_numpy())
        tc = pvlib.temperature.faiman(g, w["temp_air"].to_numpy(), w["wind_speed"].to_numpy())
        return float((pvlib.pvsystem.pvwatts_dc(g, tc, 1000, GAMMA) * 0.86).sum() / 1000)



def simuliere_balkon(sim, geo, Q, qb, gn_true, az_mod, neigung=90.0, wp_modul=None):
    E = sim.einstrahlung(az_mod, neigung)
    nrm = geo["n"]
    mv = geo["vorschlag"]
    fracs, isos, horis = [], [], []
    for m in geo["module"]:
        fr = np.zeros(len(sim.mid))
        iso_b = iso_k = 0.0
        for p in m["punkte"]:
            hb, ht = horizont(p, nrm, Q, qb, gn_true)
            horis.append((hb, ht))
            frei = sim.el > hb[sim.bi]
            hinter_baum = sim.el <= ht[sim.bi]
            fr += np.where(frei, np.where(hinter_baum, sim.tau, 1.0), 0.0)
            iso_b += himmel_faktor(hb, ht, az_mod, TAU_BELAUBT, neigung)
            iso_k += himmel_faktor(hb, ht, az_mod, TAU_KAHL, neigung)
        k = len(m["punkte"])
        fracs.append(fr / k)
        isos.append(np.where(sim.belaubt, iso_b / k, iso_k / k))
    wpm = wp_modul or mv["wp_modul"]
    pac = sim.leistung(E, fracs, isos, wpm)
    one = np.ones(len(sim.mid))
    pac_frei = sim.leistung(E, [one] * len(fracs), [one] * len(fracs), wpm)
    hb_all = np.max([h[0] for h in horis], axis=0)
    ht_all = np.max([h[1] for h in horis], axis=0)
    # Sonnenstunden auf dem Modul (Mittel der Module, nur Stunden mit Sonne vor der Fassade)
    vor = (sim.el > 0) & (E["aoi"] < 90)
    sonne_frei = float(vor.sum())
    sonne_mod = float((np.mean(fracs, axis=0) * vor).sum())
    return dict(pac=pac, pac_frei=pac_frei, hb=hb_all, ht=ht_all,
                frac=np.mean(fracs, axis=0), sonne_frei=sonne_frei, sonne_mod=sonne_mod,
                himmel=float(np.mean([i.mean() for i in isos])))

