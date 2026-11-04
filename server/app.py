#!/usr/bin/env python3
"""
balki strom – Webserver
=======================
Liefert web/ statisch aus und rechnet den Ertrag für einen angetippten Balkon:

    POST /api/ertrag   {"kachel", "x", "y", "z", "nx", "ny", "module": 1|2, "aufstellung": "senkrecht"|"geneigt"}

Schnittstelle: docs/ARCHITEKTUR.md. Es werden keine personenbezogenen Daten gespeichert und keine
IP-Adressen geschrieben (Ratenlimit nur im Speicher). Nur Standardbibliothek + numpy/pvlib.

Start:
    python3 server/app.py                      # web/ und data/work/ im Projektordner, Port 8000
    python3 server/app.py --port 8000 --hinter-proxy   # hinter Caddy/nginx
"""
import argparse
import ipaddress
import json
import math
import mimetypes
import os
import sys
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from balki.rechner import EingabeFehler, Rechner  # noqa: E402

MAX_BODY = 1024
MAX_VERBINDUNGEN = int(os.environ.get("MAX_VERBINDUNGEN", 64))
RECHNEN_PARALLEL = int(os.environ.get("RECHNEN_PARALLEL", 2))   # gleichzeitige Rechnungen
RECHNEN_WARTEN = 30                                              # s, länger wartet keine Anfrage (dann 503)
LIMITS = {                                                       # (Anzahl, Zeitfenster in s) je IP
    "ertrag": (int(os.environ.get("LIMIT_ERTRAG_STUNDE", 60)), 3600),
    "lesen": (int(os.environ.get("LIMIT_LESEN_MINUTE", 600)), 60),
}
FELDER = {"kachel", "x", "y", "z", "nx", "ny", "module", "aufstellung"}
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/json", ".json")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("application/octet-stream", ".bin")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def json_streng(roh):
    """JSON ohne NaN/Infinity."""
    def nein(_):
        raise ValueError("ungültige Zahl")
    return json.loads(roh, parse_constant=nein)


def zahl(v, lo, hi):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise EingabeFehler("Ungültige Anfrage.")
    return float(v)


def pruefe_ertrag(d, kacheln):
    if not isinstance(d, dict) or not set(d) <= FELDER:
        raise EingabeFehler("Ungültige Anfrage.")
    kid = d.get("kachel")
    if not isinstance(kid, str) or kid not in kacheln:
        raise EingabeFehler("Dieses Gebiet kennen wir noch nicht.")
    module = d.get("module", 2)
    if module not in (1, 2) or isinstance(module, bool):
        raise EingabeFehler("Bitte 1 oder 2 Module wählen.")
    aufstellung = d.get("aufstellung", "senkrecht")
    if aufstellung not in ("senkrecht", "geneigt"):
        raise EingabeFehler("Ungültige Anfrage.")
    return dict(kid=kid, x=zahl(d.get("x"), 360000, 420000), y=zahl(d.get("y"), 5790000, 5850000),
                z=zahl(d.get("z"), -50, 500), nx=zahl(d.get("nx"), -1.01, 1.01), ny=zahl(d.get("ny"), -1.01, 1.01),
                anzahl=int(module), aufstellung=aufstellung)


class Begrenzer:
    """Gleitendes Zeitfenster je (IP, Art). Nur im Speicher, wird nie gespeichert."""

    def __init__(self):
        self.t = defaultdict(deque)
        self.lock = threading.Lock()
        self.aufgeraeumt = time.time()

    @staticmethod
    def schluessel(ip):
        """IPv6 je /64 zusammenfassen, IPv4 einzeln."""
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return ip
        if a.version == 6:
            if a.ipv4_mapped:
                return str(a.ipv4_mapped)
            return str(ipaddress.ip_network(f"{a}/64", strict=False))
        return str(a)

    def erlaubt(self, ip, art):
        n, fenster = LIMITS[art]
        now = time.time()
        with self.lock:
            q = self.t[(self.schluessel(ip), art)]
            while q and q[0] < now - fenster:
                q.popleft()
            if len(q) >= n:
                return False
            q.append(now)
            if now - self.aufgeraeumt > 60:      # jede Minute: IPs ohne Anfrage in der letzten Stunde löschen
                self.aufgeraeumt = now
                lang = max(f for _, f in LIMITS.values())
                for k in [k for k, v in self.t.items() if not v or v[-1] < now - lang]:
                    del self.t[k]
            return True


class App:
    def __init__(self, webroot, work_dir, wetter=None):
        self.webroot = os.path.realpath(webroot)
        self.rechner = Rechner(work_dir, wetter)
        self.plaetze = threading.BoundedSemaphore(RECHNEN_PARALLEL)
        kacheln = self.rechner.kachel_ids()
        log(f"Kacheln mit Server-Daten: {', '.join(kacheln) or 'keine – zuerst pipeline/kachel.py ausführen'}")

    def ertrag(self, d):
        e = pruefe_ertrag(d, set(self.rechner.kachel_ids()))
        if not self.plaetze.acquire(timeout=RECHNEN_WARTEN):
            raise TimeoutError
        try:
            t = time.time()
            r = self.rechner.ertrag(e["kid"], e["x"], e["y"], e["z"], e["nx"], e["ny"], e["anzahl"], e["aufstellung"])
            log(f"Ertrag {e['kid']}: {r['kwh_jahr']:.0f} kWh/a, {r['richtung']}, {time.time() - t:.1f} s")
            return r
        finally:
            self.plaetze.release()


def handler_fuer(app, begrenzer, vertraue_proxy):
    webroot = app.webroot

    class H(BaseHTTPRequestHandler):
        server_version = "balki"
        sys_version = ""
        timeout = 15                           # s: hängende Verbindungen schließen
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):     # keine IPs ins Log
            pass

        def ip(self):
            if vertraue_proxy and self.client_address[0] in ("127.0.0.1", "::1"):
                xf = self.headers.get("X-Forwarded-For", "")
                if xf:
                    return xf.split(",")[-1].strip()
            return self.client_address[0]

        def sicherheits_header(self):
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
            self.send_header("Cross-Origin-Opener-Policy", "same-origin")

        def json(self, code, obj):
            body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.sicherheits_header()
            self.end_headers()
            self.wfile.write(body)

        def fehler(self, code, text):
            self.json(code, {"ok": False, "fehler": text})

        # ------------------------------------------------------------ GET
        def do_GET(self):
            self.statisch(urlparse(self.path).path)

        def do_HEAD(self):
            self.statisch(urlparse(self.path).path, nur_kopf=True)

        def statisch(self, pfad, nur_kopf=False):
            if not begrenzer.erlaubt(self.ip(), "lesen"):
                return self.fehler(429, "Zu viele Anfragen. Bitte kurz warten.")
            try:
                self._statisch(pfad, nur_kopf)
            except (OSError, ValueError):
                try:
                    self.fehler(404, "Nicht gefunden.")
                except OSError:
                    pass

        def _statisch(self, pfad, nur_kopf=False):
            rel = unquote(pfad).lstrip("/")
            if "\x00" in rel or "\\" in rel:
                return self.fehler(404, "Nicht gefunden.")
            if rel == "" or rel.endswith("/"):
                rel += "index.html"
            teile = rel.split("/")
            if any(t.startswith((".", "_")) for t in teile) or teile[-1].endswith((".py", ".command", ".csv", ".md")):
                return self.fehler(404, "Nicht gefunden.")
            ziel = os.path.realpath(os.path.join(webroot, rel))
            if not ziel.startswith(webroot + os.sep) or not os.path.isfile(ziel):
                return self.fehler(404, "Nicht gefunden.")
            typ = mimetypes.guess_type(ziel)[0] or "application/octet-stream"
            if typ.startswith("text/") or typ == "application/json":
                typ += "; charset=utf-8"
            # vorkomprimierte Fassung (.gz) ausliefern, wenn der Browser sie annimmt
            gz = ziel + ".gz"
            mit_gz = os.path.isfile(gz) and "gzip" in self.headers.get("Accept-Encoding", "")
            datei = gz if mit_gz else ziel
            groesse = os.path.getsize(datei)
            self.send_response(200)
            self.send_header("Content-Type", typ)
            self.send_header("Content-Length", str(groesse))
            if mit_gz:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
            unveraenderlich = "/tiles/" in "/" + rel and not rel.endswith(".json")
            self.send_header("Cache-Control", "public, max-age=604800" if unveraenderlich else "no-cache")
            self.sicherheits_header()
            if rel.endswith(".html"):
                # Die eigentliche Richtlinie (script-src mit Hash der Import-Map) steht als <meta> in jeder Seite;
                # hier nur, was per <meta> nicht geht (frame-ancestors) und was nie erlaubt sein soll.
                self.send_header("Content-Security-Policy",
                                 "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            if not nur_kopf:
                with open(datei, "rb") as fh:
                    while True:
                        chunk = fh.read(1 << 16)
                        if not chunk:
                            break
                        self.wfile.write(chunk)

        # ------------------------------------------------------------ POST
        def do_POST(self):
            pfad = urlparse(self.path).path
            ctype = self.headers.get("Content-Type", "")
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = -1
            if pfad != "/api/ertrag":
                return self.fehler(404, "Unbekannt.")
            if not ctype.startswith("application/json") or not 0 < n <= MAX_BODY:
                return self.fehler(400, "Ungültige Anfrage.")
            if not begrenzer.erlaubt(self.ip(), "ertrag"):
                return self.fehler(429, "Du hast gerade sehr viele Balkone berechnet. Bitte versuch es später noch einmal.")
            try:
                daten = json_streng(self.rfile.read(n))
                return self.json(200, app.ertrag(daten))
            except (ValueError, EingabeFehler) as e:
                return self.fehler(400, str(e) if isinstance(e, EingabeFehler) else "Ungültige Anfrage.")
            except TimeoutError:
                return self.fehler(503, "Gerade rechnen viele gleichzeitig. Bitte versuch es in einer Minute noch einmal.")
            except Exception as e:      # noqa: BLE001 – Details nur ins Server-Log
                log("Fehler:", type(e).__name__, e)
                return self.fehler(500, "Da ist etwas schiefgegangen. Bitte später noch einmal.")

    return H


class BegrenzterServer(ThreadingHTTPServer):
    """Höchstens MAX_VERBINDUNGEN gleichzeitig – weitere Verbindungen werden sofort geschlossen."""
    daemon_threads = True
    plaetze = threading.BoundedSemaphore(MAX_VERBINDUNGEN)

    def process_request(self, request, client_address):
        if not self.plaetze.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.plaetze.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.plaetze.release()


def main():
    ap = argparse.ArgumentParser(description="balki strom – Webserver")
    ap.add_argument("--web", default=os.path.join(ROOT, "web"))
    ap.add_argument("--work", default=os.path.join(ROOT, "data", "work"))
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1", help="hinter einem Reverse-Proxy immer 127.0.0.1")
    ap.add_argument("--wetter", help="PVGIS-TMY-Datei (optional)")
    ap.add_argument("--hinter-proxy", action="store_true", help="X-Forwarded-For von 127.0.0.1 übernehmen")
    a = ap.parse_args()
    app = App(a.web, a.work, a.wetter)
    srv = BegrenzterServer((a.host, a.port), handler_fuer(app, Begrenzer(), a.hinter_proxy))
    log(f"balki strom läuft auf http://{a.host}:{a.port}/")
    srv.serve_forever()


if __name__ == "__main__":
    main()
