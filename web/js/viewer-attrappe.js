// Attrappe des 3D-Viewers (gleiche Schnittstelle wie web/js/viewer.js, siehe docs/ARCHITEKTUR.md)
// Wird mit ?attrappe=1 (oder ?attrappe=viewer) geladen. Zeigt eine gezeichnete Hauswand mit Balkonen;
// ein Tipp auf einen Balkon meldet eine erfundene Auswahl. Mit &kein3d=1 wird ViewerNichtVerfuegbar geworfen.

export class ViewerNichtVerfuegbar extends Error {
  constructor(text = 'WebGL ist auf diesem Gerät nicht verfügbar.') { super(text); this.name = 'ViewerNichtVerfuegbar'; }
}

const STOCK = 5, SPALTEN = 3, BODEN_Z = 34, GESCHOSS_H = 3.2;

export async function erstelleViewer(container, opts = {}) {
  if (new URLSearchParams(location.search).get('kein3d') === '1') throw new ViewerNichtVerfuegbar();
  let auswahlCb = () => {}, statusCb = () => {}, ort = null, gewaehlt = null, module = null;
  const wurzel = document.createElement('div');
  wurzel.className = 'attrappe';
  container.appendChild(wurzel);

  // Richtung der Hauswand aus der Adresse ableiten (damit verschiedene Adressen verschieden rechnen)
  const normale = (x, y) => {
    const az = [180, 135, 225, 90, 270, 160, 200, 0][Math.abs(Math.round(x * 7 + y * 3)) % 8] * Math.PI / 180;
    return {nx: +Math.sin(az).toFixed(3), ny: +Math.cos(az).toFixed(3)};
  };

  function zeichne() {
    if (!ort) { wurzel.innerHTML = ''; return; }
    const W = 300, H = 330, bw = 70, bh = 34, gx = 30, gy = 60;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="group" aria-label="Attrappe: Hauswand mit Balkonen" class="attrappe-svg">`;
    s += `<rect x="20" y="20" width="${W - 40}" height="${H - 20}" rx="4" class="a-wand"/>`;
    s += `<text x="${W / 2}" y="14" text-anchor="middle" class="a-titel">Attrappe – kein echtes 3D</text>`;
    for (let f = STOCK - 1; f >= 0; f--) for (let c = 0; c < SPALTEN; c++) {
      const x = gx + c * (bw + 20), y = H - gy - f * 54;
      s += `<rect x="${x + 12}" y="${y - 26}" width="${bw - 24}" height="26" class="a-fenster"/>`;
      const id = `${f}-${c}`, sel = gewaehlt && gewaehlt.id === id;
      s += `<g class="a-balkon${sel ? ' an' : ''}" tabindex="0" role="button" data-id="${id}" aria-label="Balkon ${f === 0 ? 'Erdgeschoss' : f + '. Stock'}, ${['links', 'Mitte', 'rechts'][c]}">` +
        `<rect x="${x}" y="${y}" width="${bw}" height="${bh * 0.55}" rx="2" class="a-gelaender"/>`;
      if (sel && module) {
        const n = module.length, mw = (bw - 8 - (n - 1) * 3) / n;
        for (let i = 0; i < n; i++) s += `<rect x="${x + 4 + i * (mw + 3)}" y="${y + 1}" width="${mw}" height="${bh * 0.55 - 2}" rx="1" class="a-modul"/>`;
      }
      if (sel) s += `<circle cx="${x + bw / 2}" cy="${y - 4}" r="5" class="a-marker"/>`;
      s += '</g>';
    }
    s += '</svg>';
    wurzel.innerHTML = s;
    for (const g of wurzel.querySelectorAll('.a-balkon')) {
      const los = () => waehle(g.dataset.id);
      g.addEventListener('click', los);
      g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); los(); } });
    }
  }

  function waehle(id) {
    const [f, c] = id.split('-').map(Number);
    const {nx, ny} = normale(ort.x, ort.y);
    const tx = -ny, ty = nx;
    const p = {kachel: '3858_58171', x: +(ort.x + tx * (c - 1) * 4 + nx * 2).toFixed(1), y: +(ort.y + ty * (c - 1) * 4 + ny * 2).toFixed(1),
      z: +(BODEN_Z + f * GESCHOSS_H + 1.1).toFixed(1), nx, ny, nz: 0};
    gewaehlt = {id}; module = null; zeichne();
    auswahlCb(p);
  }

  return {
    zeigeOrt(x, y) {
      ort = {x, y}; gewaehlt = null; module = null;
      statusCb({ladend: true, fortschritt: 0, text: 'Lade dein Haus …'});
      wurzel.innerHTML = '';
      let f = 0;
      const t = setInterval(() => {
        f += 0.25;
        statusCb({ladend: f < 1, fortschritt: Math.min(1, f), text: f < 1 ? 'Lade dein Haus …' : 'Fertig'});
        if (f >= 1) { clearInterval(t); zeichne(); }
      }, 150);
    },
    beiAuswahl(cb) { auswahlCb = cb; },
    zeigeMarker(x, y, z) { if (x === null) { gewaehlt = null; zeichne(); } },
    zeigeModule(m) { module = m; zeichne(); },
    setzeSonne() {},
    beiStatus(cb) { statusCb = cb; },
    entsorge() { wurzel.remove(); },
  };
}
