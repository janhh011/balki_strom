// 3D-Viewer für balki strom: Berliner Foto-Mesh, nur nahe Zellen laden, Antippen von Hauswänden.
//
// Schnittstelle (docs/ARCHITEKTUR.md):
//   const viewer = await erstelleViewer(container, { manifest: 'tiles/tiles.json', qualitaet: 'auto' });
//   viewer.zeigeOrt(x, y) -> Promise<boolean>   (false: keine Kachel an diesem Ort)
//   viewer.beiAuswahl(cb)    cb({kachel, x, y, z, nx, ny, nz})   nur Hauswand/Balkon (EPSG:25833)
//   viewer.zeigeMarker(x, y, z | null)
//   viewer.zeigeModule([[[x,y,z] x 4], ...] | null)
//   viewer.setzeSonne(date)
//   viewer.beiStatus(cb)     cb({ladend, fortschritt 0..1, text})
//   viewer.entsorge()
// Zusätzlich (nicht Teil des Vertrags, optional): viewer.beiFehlgriff(cb) cb({art: 'baum'|'dach'|'boden'|
//   'unscharf'|'leer'}), viewer.qualitaet, viewer.grund, viewer.statistik().
//
// Die Seite braucht eine Import-Map für three:  {"imports": {"three": "./vendor/three/three.module.min.js"}}
// Der Container braucht eine feste Höhe (z. B. height: 60vh); der Viewer füllt ihn mit einem <canvas>.
//
// Qualität 'auto' (Heuristik, siehe waehleQualitaet): 'niedrig' bei Software-Rendering (SwiftShader,
// llvmpipe), Datensparmodus/2G/3G, MAX_TEXTURE_SIZE < 4096, deviceMemory <= 4 GB, weniger als 4 Kernen
// oder Mobilgerät (außer deviceMemory >= 8 und >= 8 Kernen); sonst 'hoch'.
//   niedrig: Zellen bis 60 m um das Ziel, Textur 20 cm/px bis 22 m, sonst 40 cm/px; keine Schatten,
//            Pixelverhältnis max. 1,5 (beim Bewegen 60 % davon), kein Antialiasing, keine Dämpfung,
//            bilineare Filterung ohne Anisotropie.
//   hoch:    Zellen bis 110 m, Textur 10 cm/px bis 20 m, 20 cm/px bis 60 m, sonst 40 cm/px;
//            Schattenkarte 2048², Pixelverhältnis max. 2 (beim Bewegen 75 %), Antialiasing.
// Gezeichnet wird nur bei Bedarf (Kamerabewegung, Laden, API-Aufrufe), kein Dauer-rAF.

import * as THREE from 'three';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';

export class ViewerNichtVerfuegbar extends Error {
  constructor(text = 'Die 3D-Ansicht braucht WebGL, das in diesem Browser nicht verfügbar ist.') {
    super(text);
    this.name = 'ViewerNichtVerfuegbar';
  }
}

const STUFEN = {
  // [max. Abstand Zelle–Ziel (m), Texturstufe]; Zellen weiter weg: Fernansicht
  // bewegung: Anteil der Auflösung während Drehen/Zoomen/Flug (danach ein scharfes Bild)
  niedrig: { ringe: [[22, 1], [60, 0]], entladen: 100, pixel: 1.5, aa: false, schatten: 0, parallel: 4,
             bewegung: 0.6, aniso: 1, daempfung: false },
  hoch: { ringe: [[20, 2], [60, 1], [110, 0]], entladen: 160, pixel: 2, aa: true, schatten: 2048, parallel: 6,
          bewegung: 0.75, aniso: 4, daempfung: true },
};
const FERN_RADIUS = 700;       // m: Kacheln, deren Fernansicht geladen wird
const UMG_RADIUS = 260;        // m: LoD2-Umgebungszellen
const BREITE = 52.5, LAENGE = 13.4;
const WAND_NZ = 0.5;           // |nz| der geglätteten Normale darunter = Wand (Fläche mind. 60° steil)

// ------------------------------------------------------------------------------------------------ Qualität
export function waehleQualitaet(gl) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const ua = nav.userAgent || '';
  const mobil = /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua) ||
    (nav.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const mem = nav.deviceMemory;            // nur Chromium, gerundet, max. 8
  const kerne = nav.hardwareConcurrency || 4;
  const con = nav.connection || {};
  let renderer = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { /* egal */ }
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const gruende = [];
  if (/SwiftShader|llvmpipe|softpipe|Software|Basic Render|Microsoft Basic/i.test(renderer)) gruende.push('Software-Rendering');
  if (con.saveData) gruende.push('Datensparmodus');
  if (/(^|-)2g|3g/.test(con.effectiveType || '')) gruende.push('langsame Verbindung');
  if (maxTex < 4096) gruende.push('kleine Texturgrenze');
  if (mem && mem <= 4) gruende.push(`${mem} GB Speicher`);
  if (kerne < 4) gruende.push(`${kerne} Kerne`);
  if (mobil && !(mem >= 8 && kerne >= 8)) gruende.push('Mobilgerät');
  return { stufe: gruende.length ? 'niedrig' : 'hoch', grund: gruende.join(', ') || 'leistungsfähiges Gerät', maxTex, renderer };
}

// ------------------------------------------------------------------------------------------------ Sonne
// Sonnenstand (vereinfachter Algorithmus nach dem Astronomical Almanac, ±0,1°), Azimut ab Nord im Uhrzeigersinn.
export function sonnenstand(date, breite = BREITE, laenge = LAENGE) {
  const rad = Math.PI / 180;
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
  const gmst = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
  const H = (gmst * 15 + laenge) * rad - ra;
  const phi = breite * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { azimut: ((az / rad) % 360 + 360) % 360, hoehe: el / rad };
}

// ------------------------------------------------------------------------------------------------ Hilfen
function sRGBnachLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LIN = new Float32Array(256).map((_, i) => sRGBnachLinear(i));

function abstandRechteck(x, y, x0, y0, x1, y1) {
  const dx = Math.max(x0 - x, 0, x - x1), dy = Math.max(y0 - y, 0, y - y1);
  return Math.hypot(dx, dy);
}

function glUnterstuetzt() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return null;
    return gl;
  } catch (e) {
    return null;
  }
}

const sanft = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ================================================================================================ Viewer
export async function erstelleViewer(container, optionen = {}) {
  if (!container) throw new Error('erstelleViewer: kein Container');
  const opt = { manifest: 'tiles/tiles.json', qualitaet: 'auto', ...optionen };
  const probe = glUnterstuetzt();
  if (!probe) throw new ViewerNichtVerfuegbar();
  const wahl = waehleQualitaet(probe);
  probe.getExtension('WEBGL_lose_context')?.loseContext();
  const stufe = opt.qualitaet === 'niedrig' || opt.qualitaet === 'hoch' ? opt.qualitaet : wahl.stufe;
  const Q = { ...STUFEN[stufe] };
  if (wahl.maxTex < 2048) Q.ringe = Q.ringe.map(([r, s]) => [r, Math.min(s, 0)]);
  else if (wahl.maxTex < 4096) Q.ringe = Q.ringe.map(([r, s]) => [r, Math.min(s, 1)]);
  const DETAIL_R = Q.ringe[Q.ringe.length - 1][0];

  const manifestUrl = new URL(opt.manifest, document.baseURI);
  const abbruch = new AbortController();
  const statistik = { bytes: 0, anfragen: 0, start: performance.now() };

  async function hole(url, art) {
    const r = await fetch(url, { signal: abbruch.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    statistik.anfragen++;
    if (art === 'json') {
      const t = await r.text();
      statistik.bytes += t.length;
      return JSON.parse(t);
    }
    if (art === 'blob') {
      const b = await r.blob();
      statistik.bytes += b.size;
      return b;
    }
    const b = await r.arrayBuffer();
    statistik.bytes += b.byteLength;
    return b;
  }

  const manifest = await hole(manifestUrl, 'json');
  const kacheln = (manifest.kacheln || []).map(k => ({
    // Pfade in tiles.json sind relativ zum Webroot (wie die manifest-Option relativ zur Seite)
    ...k, basis: new URL(k.url, document.baseURI), metaUrl: new URL(k.meta, document.baseURI),
    meta: null, metaLaden: null, gruppe: null, fern: null, fernLaden: null, gelaende: null,
    zellen: new Map(), umg: new Map(),
  }));
  if (!kacheln.length) throw new Error('tiles.json enthält keine Kacheln');

  // ---------------------------------------------------------------------------------------- Renderer
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: Q.aa, powerPreference: stufe === 'hoch' ? 'high-performance' : 'default' });
  } catch (e) {
    throw new ViewerNichtVerfuegbar();
  }
  const prVoll = Math.min(window.devicePixelRatio || 1, Q.pixel);
  const prBewegt = Math.max(0.5, prVoll * Q.bewegung);
  let prAktuell = prVoll;
  renderer.setPixelRatio(prVoll);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if (Q.schatten) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;      // nur neu, wenn Sonne/Geometrie sich ändert
  }
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;outline:none;';
  canvas.setAttribute('aria-label', '3D-Ansicht der Häuser. Ziehen zum Drehen, zwei Finger oder Mausrad zum Zoomen, auf eine Hauswand tippen zum Auswählen.');
  canvas.setAttribute('role', 'img');
  canvas.tabIndex = 0;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(canvas);
  const maxAniso = Math.min(Q.aniso, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const himmel = new THREE.Color(0xdde6ee);
  scene.background = himmel;
  scene.fog = new THREE.Fog(himmel, 450, 1400);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 3000);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = Q.daempfung;
  controls.dampingFactor = 0.12;
  controls.zoomToCursor = true;
  controls.minDistance = 4;
  controls.maxDistance = 600;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.listenToKeyEvents(canvas);

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb8b4a8, 1.6);
  scene.add(hemi);
  const sonne = new THREE.DirectionalLight(0xfff4e0, 1.2);
  scene.add(sonne, sonne.target);
  if (Q.schatten) {
    sonne.castShadow = true;
    sonne.shadow.mapSize.set(Q.schatten, Q.schatten);
    const sc = sonne.shadow.camera;
    sc.left = sc.bottom = -140; sc.right = sc.top = 140; sc.near = 1; sc.far = 1200;
    sonne.shadow.bias = -0.0004;
    sonne.shadow.normalBias = 0.08;
  }
  const welt = new THREE.Group();          // alle Kacheln
  const extras = new THREE.Group();        // Marker, Module
  scene.add(welt, extras);

  // Szenen-Ursprung: Mitte der ersten Kachel (Float32-Genauigkeit), Achsen: X=Ost, Y=Höhe, Z=-Nord
  const b0 = kacheln[0].bounds;
  const U = { x: Math.round((b0[0] + b0[2]) / 2), y: Math.round((b0[1] + b0[3]) / 2), z: 0 };
  const nachSzene = (x, y, z) => new THREE.Vector3(x - U.x, z - U.z, -(y - U.y));
  const nachWelt = v => ({ x: v.x + U.x, y: -v.z + U.y, z: v.y + U.z });

  // ---------------------------------------------------------------------------------------- Zeichnen bei Bedarf
  let rafId = 0, entsorgt = false, flug = null, interaktion = false;
  function zeichne() {
    if (!rafId && !entsorgt) rafId = requestAnimationFrame(bild);
  }
  const bildzeiten = [], bildabstaende = [];
  let letztesBild = 0;
  function bild(t) {
    rafId = 0;
    let weiter = false;
    if (flug) weiter = flugSchritt(t) || weiter;
    weiter = controls.update() || weiter;
    // geringere Auflösung, solange sich die Kamera bewegt; danach ein scharfes Bild
    const pr = weiter || interaktion ? prBewegt : prVoll;
    if (pr !== prAktuell) {
      prAktuell = pr;
      renderer.setPixelRatio(pr);
      renderer.setSize(container.clientWidth || 1, container.clientHeight || 1, false);
    }
    const t0 = performance.now();
    renderer.render(scene, camera);
    bildzeiten.push(performance.now() - t0);
    if (bildzeiten.length > 120) bildzeiten.shift();
    // langsames Gerät (Bildabstand > 60 ms beim Bewegen): Dämpfung aus, sonst zieht sie sich über Sekunden
    if (weiter || interaktion) {
      if (letztesBild && t - letztesBild < 1000) bildabstaende.push(t - letztesBild);
      if (bildabstaende.length > 12) bildabstaende.shift();
      if (controls.enableDamping && bildabstaende.length >= 8 &&
          [...bildabstaende].sort((a, b) => a - b)[4] > 60) controls.enableDamping = false;
    }
    letztesBild = t;
    if (weiter) zeichne();
  }
  controls.addEventListener('change', zeichne);

  function groesse() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    zeichne();
  }
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(groesse) : null;
  ro ? ro.observe(container) : window.addEventListener('resize', groesse);
  groesse();

  // ---------------------------------------------------------------------------------------- Status
  const statusCbs = [], auswahlCbs = [], fehlgriffCbs = [];
  let status = { ladend: false, fortschritt: 1, text: '' };
  function setzeStatus(s) {
    status = { ...status, ...s };
    for (const cb of statusCbs) try { cb({ ...status }); } catch (e) { console.error(e); }
  }

  // ---------------------------------------------------------------------------------------- Laden: Meta, Fern, Gelände
  async function ladeMeta(k) {
    if (k.meta) return k.meta;
    if (!k.metaLaden) {
      k.metaLaden = hole(k.metaUrl, 'json').then(m => {
        k.meta = m;
        k.gruppe = new THREE.Group();
        k.gruppe.name = k.id;
        welt.add(k.gruppe);
        return m;
      });
    }
    return k.metaLaden;
  }

  const fernMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const umgMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });   // LoD2-Flächen ohne Kappen
  const bodenMat = new THREE.MeshLambertMaterial({ color: 0xc9cfc0 });

  function ladeFern(k) {
    if (k.fernLaden || !k.meta.fern) return k.fernLaden;
    const f = k.meta.fern;
    k.fernLaden = hole(new URL(f.datei, k.basis)).then(buf => {
      const nv = f.nv, nt = f.nt;
      const p16 = new Uint16Array(buf, 0, nv * 3);
      const c8 = new Uint8Array(buf, nv * 6, nv * 3);
      let off = nv * 9; off += (4 - (off % 4)) % 4;
      const idx = f.i32 ? new Uint32Array(buf, off, nt * 3) : new Uint16Array(buf, off, nt * 3);
      const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
      const ox = f.o[0] - U.x, oy = f.o[1] - U.y, oz = f.o[2] - U.z, q = f.q;
      for (let i = 0; i < nv; i++) {
        pos[3 * i] = ox + q * p16[3 * i];
        pos[3 * i + 1] = oz + q * p16[3 * i + 2];
        pos[3 * i + 2] = -(oy + q * p16[3 * i + 1]);
        col[3 * i] = LIN[c8[3 * i]]; col[3 * i + 1] = LIN[c8[3 * i + 1]]; col[3 * i + 2] = LIN[c8[3 * i + 2]];
      }
      // gemeinsame Attribute, Dreiecke in Blöcken von 2x2 Zellen (eigene Meshes -> Frustum-Culling)
      const voll = new THREE.BufferGeometry();
      const aPos = new THREE.BufferAttribute(pos, 3), aCol = new THREE.BufferAttribute(col, 3);
      voll.setAttribute('position', aPos);
      voll.setIndex(new THREE.BufferAttribute(idx, 1));
      voll.computeVertexNormals();
      const aNorm = voll.getAttribute('normal');
      const bloecke = new Map();
      for (const id of Object.keys(f.zellen)) {
        const [ix, iy] = id.split('_').map(Number);
        const bid = `${ix >> 1}_${iy >> 1}`;
        if (!bloecke.has(bid)) bloecke.set(bid, { zellen: [], mesh: null, schmutzig: true });
        bloecke.get(bid).zellen.push(id);
      }
      for (const [bid, b] of bloecke) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', aPos);
        g.setAttribute('normal', aNorm);
        g.setAttribute('color', aCol);
        const m = new THREE.Mesh(g, fernMat);
        m.name = 'fern';
        m.renderOrder = 2;
        m.castShadow = m.receiveShadow = !!Q.schatten;
        m.matrixAutoUpdate = false;
        b.mesh = m;
        k.gruppe.add(m);
      }
      k.fern = { bloecke, voll: idx, versteckt: new Set() };
      fernIndex(k, true);
      zeichne();
    }).catch(e => { if (!entsorgt) console.warn('Fernansicht', e); });
    return k.fernLaden;
  }

  function fernIndex(k, alle = false) {
    // Index je Block ohne die Zellen, die im Detail geladen sind
    const f = k.fern;
    if (!f) return;
    const ber = k.meta.fern.zellen;
    for (const b of f.bloecke.values()) {
      if (!b.schmutzig && !alle) continue;
      const sicht = b.zellen.filter(id => !f.versteckt.has(id));
      const g = b.mesh.geometry;
      if (!g.index) {
        let gesamt = 0;
        for (const id of b.zellen) gesamt += ber[id][1];
        g.setIndex(new THREE.BufferAttribute(new f.voll.constructor(gesamt * 3), 1));
      }
      // sichtbare Zellen vorn in denselben Index-Puffer, Rest per drawRange abgeschnitten
      const neu = g.index.array;
      let o = 0;
      for (const id of sicht) {
        const [s, c] = ber[id];
        neu.set(f.voll.subarray(s * 3, (s + c) * 3), o);
        o += c * 3;
      }
      const n = o / 3;
      g.index.needsUpdate = true;
      g.setDrawRange(0, o);
      g.boundingSphere = null;
      if (n) {
        // Kugel nur über die eigenen Dreiecke
        const box = new THREE.Box3(), v = new THREE.Vector3(), P = g.attributes.position;
        for (let i = 0; i < o; i++) box.expandByPoint(v.fromBufferAttribute(P, neu[i]));
        g.boundingBox = box;
        g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      }
      b.mesh.visible = n > 0;
      b.schmutzig = false;
    }
  }
  let fernTimer = 0;
  function fernVerstecke(k, id, an) {
    if (!k.fern) return;
    an ? k.fern.versteckt.add(id) : k.fern.versteckt.delete(id);
    const [ix, iy] = id.split('_').map(Number);
    const b = k.fern.bloecke.get(`${ix >> 1}_${iy >> 1}`);
    if (b) b.schmutzig = true;
    if (!fernTimer) fernTimer = setTimeout(() => {
      fernTimer = 0;
      for (const kk of kacheln) fernIndex(kk);
      schattenNeu();
      zeichne();
    }, 60);
  }

  async function ladeGelaende(k) {
    const g = k.meta.gelaende;
    if (!g || k.gelaende) return;
    k.gelaende = { ...g, z: null };
    const buf = await hole(new URL(g.datei, k.basis));
    const a = new Uint16Array(buf);
    const z = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) z[i] = g.zmin + a[i] * g.skala;
    k.gelaende.z = z;
    // Bodenfläche (0,6 m tiefer, damit der Mesh-Boden darüber liegt)
    const { nx, ny, res, x0, y0 } = g;
    const pos = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const v = (j * nx + i) * 3;
      pos[v] = x0 + i * res - U.x;
      pos[v + 1] = z[j * nx + i] - 0.6 - U.z;
      pos[v + 2] = -(y0 + j * res - U.y);
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let o = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a0 = j * nx + i, a1 = a0 + 1, a2 = a0 + nx, a3 = a2 + 1;
      idx[o++] = a0; idx[o++] = a1; idx[o++] = a2; idx[o++] = a1; idx[o++] = a3; idx[o++] = a2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, bodenMat);
    m.name = 'boden';
    m.renderOrder = 3;           // zuletzt: meist vom Mesh verdeckt -> Tiefentest spart Füllrate
    m.receiveShadow = !!Q.schatten;
    m.matrixAutoUpdate = false;
    k.boden = m;
    k.gruppe.add(m);
    zeichne();
  }

  function bodenHoehe(x, y) {
    for (const k of kacheln) {
      const g = k.gelaende;
      if (!g || !g.z) continue;
      const fx = (x - g.x0) / g.res, fy = (y - g.y0) / g.res;
      if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) continue;
      const i = Math.min(Math.floor(fx), g.nx - 2), j = Math.min(Math.floor(fy), g.ny - 2);
      const u = fx - i, v = fy - j, z = g.z, n = g.nx;
      return (z[j * n + i] * (1 - u) + z[j * n + i + 1] * u) * (1 - v) + (z[(j + 1) * n + i] * (1 - u) + z[(j + 1) * n + i + 1] * u) * v;
    }
    const k = kacheln.find(k => k.meta);
    return k ? k.meta.z[0] + 2 : 35;
  }

  function ladeUmgebungsZelle(k, z) {
    if (!k.umgLaden) k.umgLaden = new Map();
    if (!k.umgLaden.has(z.id)) k.umgLaden.set(z.id, baueUmgebungsZelle(k, z).catch(e => { if (!entsorgt) console.warn('Umgebung', e); }));
    return k.umgLaden.get(z.id);
  }
  async function baueUmgebungsZelle(k, z) {
    const key = z.id;
    k.umg.set(key, null);
    const buf = await hole(new URL(`u/${z.id}.bin`, k.basis));
    const nv = z.nv, nt = z.nt;
    const p16 = new Uint16Array(buf, 0, nv * 3);
    const art = new Uint8Array(buf, nv * 6, nv);
    let off = nv * 7; off += (4 - (off % 4)) % 4;
    const idx = z.i32 ? new Uint32Array(buf, off, nt * 3) : new Uint16Array(buf, off, nt * 3);
    const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3);
    const ox = z.o[0] - U.x, oy = z.o[1] - U.y, oz = z.o[2] - U.z, q = z.q;
    const WAND = new THREE.Color(0xe4e1db).toArray(), DACH = new THREE.Color(0xa9a39b).toArray();
    for (let i = 0; i < nv; i++) {
      pos[3 * i] = ox + q * p16[3 * i];
      pos[3 * i + 1] = oz + q * p16[3 * i + 2];
      pos[3 * i + 2] = -(oy + q * p16[3 * i + 1]);
      const c = art[i] === 1 ? DACH : WAND;
      col[3 * i] = c[0]; col[3 * i + 1] = c[1]; col[3 * i + 2] = c[2];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, umgMat);
    m.name = 'umgebung';
    m.renderOrder = 1;
    m.castShadow = m.receiveShadow = !!Q.schatten;
    m.matrixAutoUpdate = false;
    k.umg.set(key, m);
    k.gruppe.add(m);
    schattenNeu();
    zeichne();
  }

  // ---------------------------------------------------------------------------------------- Detail-Zellen
  // Zellzustand: {k, z, stufe (geladen), ziel (gewünscht), mesh, box, laeuft}
  const zellen = new Map();      // `${kachel}/${id}` -> Zustand
  const warteschlange = [];
  let aktiv = 0, auftrag = { gesamt: 0, fertig: 0 };

  function zellRechteck(k, z) {
    const r = k.meta.raster;
    return [r.x0 + z.ix * r.dx, r.y0 + z.iy * r.dy, r.x0 + (z.ix + 1) * r.dx, r.y0 + (z.iy + 1) * r.dy];
  }

  function zielStufe(d) {
    for (const [r, s] of Q.ringe) if (d <= r) return s;
    return -1;
  }

  async function bild2textur(blob) {
    let src;
    if (typeof createImageBitmap === 'function') {
      try {
        src = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      } catch (e) { src = null; }
    }
    if (!src) {
      src = await new Promise((ok, fehler) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);
        img.onload = () => { URL.revokeObjectURL(url); ok(img); };
        img.onerror = () => { URL.revokeObjectURL(url); fehler(new Error('Bild')); };
        img.src = url;
      });
    }
    const t = new THREE.Texture(src);
    t.flipY = false;                                // UV der Zellen: v nach unten
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    t.generateMipmaps = true;
    t.minFilter = Q.aniso > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearMipmapNearestFilter;
    t.needsUpdate = true;
    if (src.close) t.onUpdate = () => { src.close(); t.onUpdate = null; };   // CPU-Kopie nach dem Hochladen freigeben
    return t;
  }

  function baueZellGeometrie(buf, z) {
    const nv = z.nv, nt = z.nt;
    const p16 = new Uint16Array(buf, 0, nv * 3);
    let off = nv * 6; off += (4 - (off % 4)) % 4;
    const uv = new Uint16Array(buf, off, nv * 2); off += nv * 4;
    const idx = z.i32 ? new Uint32Array(buf, off, nt * 3) : new Uint16Array(buf, off, nt * 3);
    const pos = new Float32Array(nv * 3);
    const ox = z.o[0] - U.x, oy = z.o[1] - U.y, oz = z.o[2] - U.z, q = z.q;
    for (let i = 0; i < nv; i++) {
      pos[3 * i] = ox + q * p16[3 * i];
      pos[3 * i + 1] = oz + q * p16[3 * i + 2];
      pos[3 * i + 2] = -(oy + q * p16[3 * i + 1]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2, true));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  async function ladeZelle(c) {
    const { k, z } = c;
    const st = c.ziel;
    const texUrl = new URL(`z/${z.id}_${st}.jpg`, k.basis);
    const geoP = c.mesh ? null : hole(new URL(`z/${z.id}.bin`, k.basis));
    const texP = hole(texUrl, 'blob').then(bild2textur);
    const [buf, tex] = await Promise.all([geoP, texP]);
    if (entsorgt || c.entladen) { tex.dispose(); return; }
    if (!c.mesh) {
      const g = baueZellGeometrie(buf, z);
      const mat = new THREE.MeshLambertMaterial({ map: tex });
      const m = new THREE.Mesh(g, mat);
      m.name = `zelle ${k.id}/${z.id}`;
      m.matrixAutoUpdate = false;
      m.castShadow = m.receiveShadow = !!Q.schatten;
      m.userData = { kachel: k.id, zelle: z, wandDreiecke: z.nt - z.nb };
      c.mesh = m;
      k.gruppe.add(m);
      fernVerstecke(k, z.id, true);
      schattenNeu();
    } else {
      const alt = c.mesh.material.map;
      c.mesh.material.map = tex;
      c.mesh.material.needsUpdate = true;
      alt?.dispose();
    }
    c.stufe = st;
    zeichne();
  }

  function entladeZelle(c) {
    c.entladen = true;
    if (c.mesh) {
      c.mesh.parent?.remove(c.mesh);
      c.mesh.geometry.dispose();
      c.mesh.material.map?.dispose();
      c.mesh.material.dispose();
      c.mesh = null;
      fernVerstecke(c.k, c.z.id, false);
    }
    zellen.delete(`${c.k.id}/${c.z.id}`);
  }

  function pumpe() {
    while (aktiv < Q.parallel && warteschlange.length) {
      warteschlange.sort((a, b) => a.d - b.d);
      const c = warteschlange.shift();
      if (c.entladen || c.stufe === c.ziel) { c.inSchlange = false; continue; }
      aktiv++;
      c.laeuft = true;
      c.inSchlange = false;
      ladeZelle(c).catch(e => { if (!entsorgt) console.warn('Zelle', c.z.id, e); c.fehler = (c.fehler || 0) + 1; })
        .finally(() => {
          aktiv--;
          c.laeuft = false;
          auftrag.fertig++;
          if (!c.entladen && c.stufe !== c.ziel && (c.fehler || 0) < 3) einreihen(c);
          meldeFortschritt();
          for (const w of warter.splice(0)) w();
          pumpe();
        });
    }
    meldeFortschritt();
  }
  function einreihen(c) {
    if (c.inSchlange || c.laeuft) return;
    c.inSchlange = true;
    warteschlange.push(c);
    auftrag.gesamt++;
  }
  function meldeFortschritt() {
    const offen = warteschlange.length + aktiv;
    if (offen === 0) {
      if (status.ladend) setzeStatus({ ladend: false, fortschritt: 1, text: '' });
      auftrag = { gesamt: 0, fertig: 0 };
    } else {
      const f = auftrag.gesamt ? auftrag.fertig / auftrag.gesamt : 0;
      setzeStatus({ ladend: true, fortschritt: Math.min(1, f), text: `3D-Modell wird geladen … ${Math.round(f * 100)} %` });
    }
  }
  const warter = [];
  const naechsteFertigmeldung = () => new Promise(ok => warter.push(ok));

  // Wunschliste neu berechnen: um den Punkt (x, y) in EPSG
  let letzterPunkt = null;
  async function aktualisiere(x, y) {
    letzterPunkt = [x, y];
    const umgNah = [];
    const nahe = kacheln.filter(k => abstandRechteck(x, y, ...k.bounds) < FERN_RADIUS);
    await Promise.all(nahe.map(ladeMeta));
    if (entsorgt) return;
    for (const k of nahe) {
      if (abstandRechteck(x, y, ...k.bounds) < FERN_RADIUS) ladeFern(k);
      if (!k.gelaende) ladeGelaende(k).catch(e => console.warn('Gelände', e));
      for (const z of k.meta.umgebung?.zellen || []) {
        const d = abstandRechteck(x, y, ...z.box);
        if (d < UMG_RADIUS) {
          const pr = ladeUmgebungsZelle(k, z);
          if (d < 100) umgNah.push(pr);
        }
      }
      for (const z of k.meta.zellen) {
        const d = abstandRechteck(x, y, ...zellRechteck(k, z));
        const key = `${k.id}/${z.id}`;
        let c = zellen.get(key);
        const s = zielStufe(d);
        if (s < 0) {
          if (c && d > Q.entladen && !c.laeuft) entladeZelle(c);
          else if (c) c.d = d;
          continue;
        }
        if (!c) {
          c = { k, z, stufe: -1, ziel: s, mesh: null, d };
          zellen.set(key, c);
        }
        c.d = d;
        // Stufe hoch sofort; runter nur mit Abstand (Hysterese), spart Speicher bei großen Sprüngen
        if (s > c.stufe || (c.stufe >= 0 && s < c.stufe - 0 && d > (Q.ringe.find(r => r[1] === c.stufe)?.[0] ?? 0) + 25)) {
          c.ziel = s;
          if (c.stufe !== s) einreihen(c);
        }
      }
    }
    pumpe();
    return umgNah;     // Umgebungszellen in der Nähe (für die Kamerawahl)
  }

  let nachladenTimer = 0;
  controls.addEventListener('end', () => {
    clearTimeout(nachladenTimer);
    nachladenTimer = setTimeout(() => {
      const w = nachWelt(controls.target);
      if (!letzterPunkt || Math.hypot(w.x - letzterPunkt[0], w.y - letzterPunkt[1]) > 8) {
        aktualisiere(w.x, w.y);
        schattenZentrum();
      }
    }, 250);
  });

  // ---------------------------------------------------------------------------------------- Strahlen
  const strahl = new THREE.Raycaster();
  function detailMeshes() {
    const out = [];
    for (const c of zellen.values()) if (c.mesh) out.push(c.mesh);
    return out;
  }
  // Treffer in Zellen, nach Abstand der Box sortiert, mit frühem Abbruch
  // mitKontext: true = auch Fernansicht + Umgebung, 'umgebung' = nur Umgebung (LoD2), false = nur Zellen
  // beidseitig: auch Rückseiten treffen (Kamera steckt in einem Haus/Baum), sonst nur Vorderseiten wie gezeichnet
  function schneide(ursprung, richtung, weit = Infinity, mitKontext = false, beidseitig = false) {
    strahl.set(ursprung, richtung);
    strahl.far = weit;
    const kand = [];
    const tmp = new THREE.Vector3();
    for (const m of detailMeshes()) {
      const p = strahl.ray.intersectBox(m.geometry.boundingBox, tmp);
      if (p) kand.push([ursprung.distanceTo(p), m]);
    }
    if (mitKontext) {
      for (const k of kacheln) {
        if (k.fern && mitKontext === true) for (const b of k.fern.bloecke.values()) if (b.mesh.visible) kand.push([0, b.mesh]);
        for (const m of k.umg.values()) if (m) kand.push([0, m]);
      }
    }
    kand.sort((a, b) => a[0] - b[0]);
    let best = null;
    const hits = [];
    for (const [d, m] of kand) {
      if (best && d > best.distance) break;
      hits.length = 0;
      const seite = m.material.side;
      if (beidseitig) m.material.side = THREE.DoubleSide;    // nur für den Strahltest, vor dem nächsten Bild zurück
      m.raycast(strahl, hits);
      m.material.side = seite;
      for (const h of hits) if (!best || h.distance < best.distance) best = h;
    }
    return best;
  }

  // geglättete Flächennormale (Szene) um den Trefferpunkt: Dreiecke derselben Zelle im Umkreis von 1 m
  function glatteNormale(treffer) {
    const g = treffer.object.geometry;
    const pos = g.attributes.position.array, idx = g.index.array;
    const n0 = treffer.face.normal.clone();
    const p = treffer.point, r2 = 1.0;
    const s = new THREE.Vector3();
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    const nw = treffer.object.userData.wandDreiecke;
    for (let t = 0; t < nw; t++) {
      const i0 = idx[3 * t] * 3, i1 = idx[3 * t + 1] * 3, i2 = idx[3 * t + 2] * 3;
      const cx = (pos[i0] + pos[i1] + pos[i2]) / 3 - p.x;
      const cy = (pos[i0 + 1] + pos[i1 + 1] + pos[i2 + 1]) / 3 - p.y;
      const cz = (pos[i0 + 2] + pos[i1 + 2] + pos[i2 + 2]) / 3 - p.z;
      if (cx * cx + cy * cy + cz * cz > r2) continue;
      a.fromArray(pos, i0); b.fromArray(pos, i1); c.fromArray(pos, i2);
      n.crossVectors(b.sub(a), c.sub(a));          // Länge = 2 x Fläche
      const L = n.length();
      if (L < 1e-9) continue;
      if (n.dot(n0) / L < 0.5) continue;
      s.add(n);
    }
    return s.lengthSq() > 0 ? s.normalize() : n0;
  }

  function klassifiziere(treffer, richtung) {
    if (!treffer) return { art: 'leer' };
    const ud = treffer.object.userData;
    if (!ud.zelle) return { art: 'unscharf' };
    if (treffer.faceIndex >= ud.wandDreiecke) return { art: 'baum' };
    const n = glatteNormale(treffer);
    if (n.dot(richtung) > 0) n.negate();
    const w = nachWelt(treffer.point);
    if (Math.abs(n.y) > WAND_NZ) {
      const boden = bodenHoehe(w.x, w.y);
      return { art: w.z - boden > 3 ? 'dach' : 'boden' };
    }
    return {
      art: 'wand',
      daten: {
        kachel: ud.kachel,
        x: +w.x.toFixed(3), y: +w.y.toFixed(3), z: +w.z.toFixed(3),
        nx: +n.x.toFixed(4), ny: +(-n.z).toFixed(4), nz: +n.y.toFixed(4),
      },
    };
  }

  // ---------------------------------------------------------------------------------------- Tippen
  const zeiger = new Map();
  let mehrfinger = false;
  function unten(e) {
    zeiger.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
    if (zeiger.size > 1) mehrfinger = true;
  }
  function oben(e) {
    const s = zeiger.get(e.pointerId);
    zeiger.delete(e.pointerId);
    const war = mehrfinger;
    if (zeiger.size === 0) mehrfinger = false;
    if (!s || war || e.button > 0) return;
    const tol = e.pointerType === 'mouse' ? 5 : 12;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > tol || e.timeStamp - s.t > 700) return;
    tippen(e.clientX, e.clientY);
  }
  function weg(e) { zeiger.delete(e.pointerId); if (zeiger.size === 0) mehrfinger = false; }
  canvas.addEventListener('pointerdown', unten);
  canvas.addEventListener('pointerup', oben);
  canvas.addEventListener('pointercancel', weg);

  function tippen(cx, cy) {
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    strahl.setFromCamera(ndc, camera);
    const o = strahl.ray.origin.clone(), d = strahl.ray.direction.clone();
    const t0 = performance.now();
    const h = schneide(o, d, 2000, true);    // Fern-/Umgebungstreffer davor (ungeladene Zelle) -> 'unscharf'
    const erg = klassifiziere(h, d);
    statistik.letzterPick = performance.now() - t0;
    if (erg.art === 'wand') {
      for (const cb of auswahlCbs) try { cb({ ...erg.daten }); } catch (e) { console.error(e); }
    } else {
      for (const cb of fehlgriffCbs) try { cb({ art: erg.art }); } catch (e) { console.error(e); }
    }
  }

  // ---------------------------------------------------------------------------------------- Kamera
  function fliege(pos, ziel, dauer = 1100) {
    const reduziert = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduziert || dauer <= 0) {
      flug = null;
      camera.position.copy(pos);
      controls.target.copy(ziel);
      controls.update();
      zeichne();
      return;
    }
    flug = { p0: camera.position.clone(), z0: controls.target.clone(), p1: pos.clone(), z1: ziel.clone(), t0: null, dauer };
    zeichne();
  }
  function flugSchritt(t) {
    if (flug.t0 === null) flug.t0 = t;
    const f = Math.min(1, (t - flug.t0) / flug.dauer), e = sanft(f);
    camera.position.lerpVectors(flug.p0, flug.p1, e);
    controls.target.lerpVectors(flug.z0, flug.z1, e);
    if (f >= 1) { flug = null; return false; }
    return true;
  }
  controls.addEventListener('start', () => { flug = null; interaktion = true; });
  controls.addEventListener('end', () => { interaktion = false; zeichne(); });

  function kameraVon(ziel, az, el, D) {
    const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
    // Kamera liegt in Richtung az vom Ziel aus (az ab Nord im Uhrzeigersinn)
    return ziel.clone().add(new THREE.Vector3(Math.sin(a) * Math.cos(e) * D, Math.sin(e) * D, -Math.cos(a) * Math.cos(e) * D));
  }

  // Kamera für ein Haus: bevorzugt von Süden, freie Sicht auf die Wand (Strahlen gegen geladene Zellen),
  // so tief wie möglich (ein paar Geschosse über dem Boden), sonst steiler von oben.
  function guteAnsicht(x, y) {
    const g = bodenHoehe(x, y);
    const dach = schneide(nachSzene(x, y, g + 250), new THREE.Vector3(0, -1, 0), 400, 'umgebung');
    let h = 15, art = 'unbekannt';
    if (dach) {
      const w = nachWelt(dach.point);
      if (w.z - g > 3) {
        h = Math.min(60, w.z - g);
        art = dach.object.userData.zelle ? 'mesh' : 'umgebung';
      }
    }
    const zMitte = g + Math.max(4, Math.min(h * 0.55, 15));
    const ziel = nachSzene(x, y, zMitte);
    const zielTief = nachSzene(x, y, Math.max(g + 3, zMitte - 6));
    // im Hochformat ist das Sichtfeld schmal -> weiter weg
    const D = THREE.MathUtils.clamp(30 + h * 1.2, 40, 75) * Math.max(1, 1 / Math.sqrt(Math.max(camera.aspect, 0.3)));
    const azs = [180, 155, 205, 130, 230, 100, 260, 60, 300, 0];
    const runter = new THREE.Vector3(0, -1, 0);
    const oben = new THREE.Vector3(0, 1, 0);
    let best = null;
    // Haus nicht im Mesh (Kachelrand): lieber von schräg oben, Straßenschluchten zwischen grauen Blöcken sind nutzlos
    for (const el of art === 'mesh' ? [16, 26, 38, 52] : [40, 55]) {
      for (const az of azs) {
        const pos = kameraVon(ziel, az, el, D);
        if (schneide(pos, runter, 8, 'umgebung', true) || schneide(pos, oben, 40, 'umgebung', true)) continue;   // in/unter/knapp über Dach
        // Strahlen: Mitte, Hausfuß, Kegel ±7° und Vordergrund bis -14° -> Anteil der Sicht, der vor der Hauswand hängen bleibt
        const mitte = ziel.clone().sub(pos).normalize();
        const rechts = new THREE.Vector3().crossVectors(mitte, oben).normalize();
        const hoch = new THREE.Vector3().crossVectors(rechts, mitte);
        const tan = Math.tan(THREE.MathUtils.degToRad(7));
        const richtungen = [mitte, zielTief.clone().sub(pos).normalize()];
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [0, -2], [-1.5, -1.5], [1.5, -1.5]]) {   // unten: Vordergrund
          richtungen.push(mitte.clone().addScaledVector(rechts, a * tan).addScaledVector(hoch, b * tan).normalize());
        }
        // zwei weite Seitenstrahlen (±18°): Häuser/Bäume nah an der Kamera = Straßenschlucht
        const tanW = Math.tan(THREE.MathUtils.degToRad(18));
        const seiten = [1, -1].map(a => mitte.clone().addScaledVector(rechts, a * tanW).normalize());
        let block = 0, fokus = null, zuNah = false;
        for (const dir of seiten) {
          const t = schneide(pos, dir, 25, 'umgebung', true);
          if (t) block += t.distance < 12 ? 1.5 : 0.7;
        }
        for (const [i, dir] of richtungen.entries()) {
          const t = schneide(pos, dir, D + 2, 'umgebung', true);
          if (t && t.distance < 10) { zuNah = true; break; }   // Kamera in/direkt an Baum oder Haus
          if (i === 0) fokus = t && t.distance > D - 24 ? t.point.clone() : ziel.clone();
          if (t && t.distance < D - 24) {
            const ud = t.object.userData;
            const istBaum = ud.zelle && t.faceIndex >= ud.wandDreiecke;
            block += istBaum ? 0.7 : 1;
            if (i < 2 && !istBaum) block += 3;   // Haus genau davor
          }
        }
        if (zuNah) continue;
        const score = Math.abs(az - 180) * 0.25 + Math.max(0, el - 16) * 0.6 + block * 12;
        if (!best || score < best.score) best = { score, pos, fokus };
        if (score <= 8) break;
      }
      if (best && best.score <= 20) break;
    }
    if (optionen.debug) window.__ansicht = { g, h, D, art, best: best && { score: best.score, pos: best.pos.toArray(), fokus: best.fokus.toArray() } };
    if (!best) return { pos: kameraVon(ziel, 180, 65, D * 1.2), fokus: ziel, art };
    return { ...best, art };
  }

  // ---------------------------------------------------------------------------------------- Sonne / Schatten
  let sonnenDatum = new Date();
  let ersterOrt = true, ortNr = 0;
  function schattenZentrum() {
    const ziel = controls.target;
    const k = kacheln.find(k => k.meta) || kacheln[0];
    const st = sonnenstand(sonnenDatum);
    const gn = k.meta?.nord_gitter_az || 0;
    const az = THREE.MathUtils.degToRad(st.azimut + gn), el = THREE.MathUtils.degToRad(Math.max(st.hoehe, 2));
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
    sonne.position.copy(ziel).addScaledVector(dir, 500);
    sonne.target.position.copy(ziel);
    sonne.target.updateMatrixWorld();
    sonne.updateMatrixWorld();
    const tag = st.hoehe > 0;
    // Fototexturen enthalten schon Licht: Summe so, dass besonnte Dächer etwa ihre Fotohelligkeit behalten,
    // Schatten aber sichtbar werden (Verhältnis Himmel : Sonne ~ 1 : 1,4)
    sonne.intensity = tag ? 0.5 + 1.7 * Math.min(1, Math.sin(el) * 2.2) : 0;
    hemi.intensity = tag ? 1.6 : 1.2;
    schattenNeu();
    zeichne();
  }
  function schattenNeu() {
    if (Q.schatten) renderer.shadowMap.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------------------- Marker, Module
  let marker = null, module = null;
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffc233, depthTest: false, transparent: true, opacity: 0.95 });
  const modulMat = new THREE.MeshLambertMaterial({ color: 0x2e6bf0, emissive: 0x0b2a6b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const rahmenMat = new THREE.LineBasicMaterial({ color: 0xffffff });

  function entsorgeObjekt(o) {
    o.traverse(c => { c.geometry?.dispose(); });
    o.parent?.remove(o);
  }

  // ================================================================================================ API
  const viewer = {
    qualitaet: stufe,
    ort: null,      // nach zeigeOrt: {x, y, haus: 'mesh' | 'umgebung' (nur LoD2-Block) | 'unbekannt'}
    grund: opt.qualitaet === 'auto' || !optionen.qualitaet ? wahl.grund : 'vorgegeben',

    async zeigeOrt(x, y) {
      if (entsorgt) return false;
      const nr = ++ortNr;                 // ein späterer Aufruf gewinnt
      const veraltet = () => entsorgt || nr !== ortNr;
      const k = kacheln.find(k => abstandRechteck(x, y, ...k.bounds) < 30);
      if (!k) {
        setzeStatus({ ladend: false, fortschritt: 1, text: 'Für diesen Ort gibt es noch kein 3D-Modell.' });
        return false;
      }
      setzeStatus({ ladend: true, fortschritt: 0, text: '3D-Modell wird geladen …' });
      await ladeMeta(k);
      await Promise.all([ladeFern(k), ladeGelaende(k).catch(() => {})]);
      if (veraltet()) return false;
      // vorläufige Ansicht von Süden, während die Zellen laden
      const g = bodenHoehe(x, y);
      const ziel0 = nachSzene(x, y, g + 10);
      fliege(kameraVon(ziel0, 180, 24, 70), ziel0, ersterOrt ? 0 : 900);
      ersterOrt = false;
      schattenZentrum();
      const umgNah = await aktualisiere(x, y);
      // warten, bis die Zellen im Umkreis von ~30 m da sind (höchstens 15 s)
      const ende = performance.now() + 15000;
      const nahFertig = () => [...zellen.values()].every(c => c.d > 30 || c.stufe >= 0 || (c.fehler || 0) >= 3);
      while (!nahFertig() && performance.now() < ende && !veraltet()) {
        await Promise.race([naechsteFertigmeldung(), new Promise(r => setTimeout(r, 500))]);
      }
      await Promise.all(umgNah || []);
      if (veraltet()) return false;
      const a = guteAnsicht(x, y);
      fliege(a.pos, a.fokus, 1200);
      schattenZentrum();
      viewer.ort = { x, y, haus: a.art };
      if (a.art === 'umgebung') {
        setzeStatus({ text: 'Dieses Haus liegt am Rand des 3D-Modells und ist nur als grauer Block zu sehen.' });
      }
      return true;
    },

    beiAuswahl(cb) { if (typeof cb === 'function') auswahlCbs.push(cb); },
    beiFehlgriff(cb) { if (typeof cb === 'function') fehlgriffCbs.push(cb); },
    beiStatus(cb) { if (typeof cb === 'function') { statusCbs.push(cb); cb({ ...status }); } },

    zeigeMarker(x, y, z) {
      if (marker) { entsorgeObjekt(marker); marker = null; }
      if (x != null && y != null && z != null) {
        // Kugel am Punkt (durch Wände sichtbar) + kurzer Stab nach oben, damit man ihn auch von weitem findet
        marker = new THREE.Group();
        const kugel = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), markerMat);
        const stab = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.5, 6), markerMat);
        stab.position.y = 1.25;
        kugel.renderOrder = stab.renderOrder = 10;
        marker.add(kugel, stab);
        marker.position.copy(nachSzene(x, y, z));
        extras.add(marker);
      }
      zeichne();
    },

    zeigeModule(liste) {
      if (module) { entsorgeObjekt(module); module = null; }
      if (Array.isArray(liste) && liste.length) {
        module = new THREE.Group();
        const pos = [], kanten = [];
        for (const q of liste) {
          if (!Array.isArray(q) || q.length !== 4) continue;
          const v = q.map(p => nachSzene(p[0], p[1], p[2]));
          for (const i of [0, 1, 2, 0, 2, 3]) pos.push(v[i].x, v[i].y, v[i].z);
          for (let i = 0; i < 4; i++) { const a = v[i], b = v[(i + 1) % 4]; kanten.push(a.x, a.y, a.z, b.x, b.y, b.z); }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        const m = new THREE.Mesh(g, modulMat);
        m.castShadow = !!Q.schatten;
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(kanten, 3));
        module.add(m, new THREE.LineSegments(lg, rahmenMat));
        extras.add(module);
      }
      schattenNeu();
      zeichne();
    },

    setzeSonne(date) {
      sonnenDatum = date instanceof Date && !isNaN(date) ? date : new Date();
      schattenZentrum();
      const s = sonnenstand(sonnenDatum);
      return { azimut: s.azimut, hoehe: s.hoehe };
    },

    statistik() {
      let tex = 0, dreiecke = 0, nz = 0, geo = 0;
      for (const c of zellen.values()) {
        if (!c.mesh) continue;
        nz++;
        dreiecke += c.z.nt;
        geo += c.z.nv * (12 + 12 + 4) + c.z.nt * 3 * (c.z.i32 ? 4 : 2);
        const t = c.z.tex[c.stufe];
        if (t) tex += t[0] * t[1] * 4 * 4 / 3;
      }
      for (const k of kacheln) if (k.fern) for (const b of k.fern.bloecke.values()) dreiecke += b.mesh.visible ? b.mesh.geometry.drawRange.count / 3 : 0;
      const bz = [...bildzeiten].sort((a, b) => a - b);
      return {
        qualitaet: stufe, grund: viewer.grund, zellen: nz, dreiecke: Math.round(dreiecke),
        texturMB: +(tex / 1e6).toFixed(1), geometrieMB: +(geo / 1e6).toFixed(1),
        geladenMB: +(statistik.bytes / 1e6).toFixed(2), anfragen: statistik.anfragen,
        warteschlange: warteschlange.length + aktiv,
        renderMs: bz.length ? +bz[Math.floor(bz.length / 2)].toFixed(2) : null,
        pixelRatio: renderer.getPixelRatio(), letzterPickMs: statistik.letzterPick ?? null,
        info: { ...renderer.info.render, ...renderer.info.memory },
      };
    },

    entsorge() {
      if (entsorgt) return;
      entsorgt = true;
      abbruch.abort();
      cancelAnimationFrame(rafId);
      clearTimeout(nachladenTimer); clearTimeout(fernTimer);
      ro ? ro.disconnect() : window.removeEventListener('resize', groesse);
      canvas.removeEventListener('pointerdown', unten);
      canvas.removeEventListener('pointerup', oben);
      canvas.removeEventListener('pointercancel', weg);
      controls.dispose();
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) for (const m of [].concat(o.material)) { m.map?.dispose(); m.dispose(); }
      });
      for (const m of [fernMat, umgMat, bodenMat, markerMat, modulMat, rahmenMat]) m.dispose();
      zellen.clear();
      statusCbs.length = auswahlCbs.length = fehlgriffCbs.length = 0;
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };

  // Kontextverlust (z. B. Tab im Hintergrund auf dem Handy): Zellen neu laden, sobald er zurück ist
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); setzeStatus({ ladend: false, text: 'Die 3D-Ansicht wurde vom Browser pausiert.' }); });
  canvas.addEventListener('webglcontextrestored', () => {
    for (const c of [...zellen.values()]) entladeZelle(c);
    if (letzterPunkt) aktualisiere(...letzterPunkt);
    schattenNeu();
    zeichne();
  });

  // Startansicht (leer, Himmel), bis zeigeOrt aufgerufen wird
  camera.position.set(0, 300, 400);
  controls.target.set(0, 0, 0);
  controls.update();
  zeichne();
  if (typeof window !== 'undefined' && optionen.debug) window.__viewer = { scene, camera, controls, renderer, zellen, kacheln };
  return viewer;
}
