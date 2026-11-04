# Betrieb auf einem eigenen Server

Stand: November 2026, nach dem Sicherheits-Review. Ziel: kleiner VPS in Deutschland (2 vCPU, ≥ 2 GB RAM je
aktiver Kachel), davor Caddy für TLS und statische Dateien. Das Python-Programm rechnet nur `POST /api/ertrag`.

```
Browser ──HTTPS──▶ Caddy ──┬── statisch: /srv/balki/web  (index.html, js, tiles/, adressen.json; .gz vorkomprimiert)
                           └── POST /api/ertrag ──▶ 127.0.0.1:8000  server/app.py --hinter-proxy (systemd, Sandbox)
```

## Einrichten

```bash
# als root
useradd --system --no-create-home --shell /usr/sbin/nologin balki
git clone https://github.com/janhh011/balki_strom /srv/balki
python3 -m venv /srv/balki/.venv
/srv/balki/.venv/bin/pip install -r /srv/balki/requirements-server.txt
# Kacheln auf einem stärkeren Rechner verarbeiten (pipeline/kachel.py, pipeline/adressen.py) und kopieren:
#   web/tiles/  web/adressen.json  data/work/<kachel>/
chmod -R a+rX /srv/balki            # die App schreibt nichts, gehört root
rm -f /srv/balki/web/viewer-demo.html
```

## `/etc/caddy/Caddyfile` (Caddy ≥ 2.7)

Keine Zugriffsprotokolle (ohne `log`-Direktive schreibt Caddy keine) – so steht es in der Datenschutzerklärung.

```caddy
{
	servers {
		timeouts {
			read_header 10s
			read_body 10s
			write 60s
			idle 2m
		}
	}
}

balki-strom.example {
	root * /srv/balki/web
	encode zstd gzip

	@ertrag {
		method POST
		path /api/ertrag
	}
	handle @ertrag {
		request_body {
			max_size 2KB
		}
		reverse_proxy 127.0.0.1:8000 {
			header_up X-Forwarded-For {remote_host}
			transport http {
				dial_timeout 2s
				response_header_timeout 60s
				max_conns_per_host 16
			}
		}
	}
	handle /api/* {
		respond 404
	}

	@gesperrt path /.* */.* /viewer-demo.html *.md *.py
	handle @gesperrt {
		respond 404
	}

	handle {
		file_server {
			precompressed gzip
			hide .*
		}
	}

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy no-referrer
		Permissions-Policy "geolocation=(), camera=(), microphone=()"
		Cross-Origin-Opener-Policy same-origin
		Cross-Origin-Resource-Policy same-origin
		# Hash anpassen, wenn sich die Import-Map in web/index.html ändert. Unterseiten verschärfen per <meta>.
		Content-Security-Policy "default-src 'self'; script-src 'self' 'sha256-kaEog0AsPo4/9apXRMvp5eF3zpfBg9ltlJNNm2KUPio='; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		-Server
	}

	# Kacheldateien eine Woche cachen (pipeline --web-neu überschreibt dieselben Namen, daher nicht "immutable")
	@kachel path_regexp ^/tiles/.+\.(bin|jpg)$
	header @kachel Cache-Control "public, max-age=604800"
	@rest not path_regexp ^/tiles/.+\.(bin|jpg)$
	header @rest ?Cache-Control "no-cache"
}
```

## `/etc/systemd/system/balki.service`

```ini
[Unit]
Description=balki strom – Ertrags-API
After=network.target

[Service]
User=balki
Group=balki
WorkingDirectory=/srv/balki
ExecStart=/srv/balki/.venv/bin/python -I server/app.py --host 127.0.0.1 --port 8000 --hinter-proxy --work /srv/balki/data/work --web /srv/balki/web
Environment=PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 PROJ_NETWORK=OFF
Restart=on-failure
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectProc=invisible
ProcSubset=pid
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RemoveIPC=yes
CapabilityBoundingSet=
AmbientCapabilities=
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
RestrictAddressFamilies=AF_INET AF_UNIX
IPAddressDeny=any
IPAddressAllow=localhost
UMask=0077
# gemessen ~560 MB Spitze für eine Kachel; je weitere Kachel ~600 MB mehr
MemoryMax=2G
TasksMax=128
LimitNOFILE=1024

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now balki caddy
ufw allow 22,80,443/tcp && ufw enable      # SSH nur mit Schlüssel; unattended-upgrades aktivieren
```

## Grenzen (Umgebungsvariablen von `server/app.py`)

| Variable | Standard | Bedeutung |
|---|---|---|
| `LIMIT_ERTRAG_STUNDE` | 120 | Rechnungen je IP (IPv6 je /56) und Stunde |
| `LIMIT_ERTRAG_GESAMT_STUNDE` | 1500 | Rechnungen aller Nutzer zusammen je Stunde |
| `LIMIT_LESEN_MINUTE` | 600 | statische Abrufe je IP und Minute (nur ohne Caddy relevant) |
| `RECHNEN_PARALLEL` | 2 | gleichzeitige Rechnungen |
| `MAX_VERBINDUNGEN` | 64 | gleichzeitige Verbindungen zur App |
