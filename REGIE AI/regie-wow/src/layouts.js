// Géométrie des plans du PC POV (PC1) et poids "temps d'écran" de chaque case.
// Un plan = { type, players: [indices] }.
//   FULL   : 1 joueur plein écran
//   SPLIT  : 2 joueurs côte à côte
//   PIP    : players[0] plein écran + players[1] en incrustation
//   QUAD   : 4 joueurs en 2x2
//   MOSAIC : tous les joueurs en 3x3. Jusqu'à 8, caméra pièce au centre ; à 9, grille pleine
//   ROOM   : caméra pièce plein écran

export const LAYOUT_TYPES = ['FULL', 'SPLIT', 'PIP', 'QUAD', 'MOSAIC', 'ROOM'];

export const MAX_PLAYERS = 9;
export const MOSAIC_FULL_AT = 9; // nombre de joueurs à partir duquel le centre de la mosaïque est occupé

// Nombre de joueurs attendus par type (MOSAIC/ROOM n'en demandent pas)
export const SLOTS = { FULL: 1, SPLIT: 2, PIP: 2, QUAD: 4, MOSAIC: 0, ROOM: 0 };

// Poids de temps d'écran : 1 = plein écran
export const WEIGHTS = {
  FULL: [1],
  SPLIT: [0.5, 0.5],
  PIP: [0.75, 0.25],
  QUAD: [0.25, 0.25, 0.25, 0.25]
  // MOSAIC : 1 / nombre de joueurs (au moins 8), calculé dans cells()
};

const PIP_MARGIN = 40;

export const rectsOverlap = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** Partie réellement occupée par une image 16:9 dans une zone : OBS la centre et garde ses proportions */
function fitted16x9([x, y, w, h]) {
  const iw = Math.min(w, h * 16 / 9), ih = iw * 9 / 16;
  return [x + (w - iw) / 2, y + (h - ih) / 2, iw, ih];
}

/** Position du PIP joueur dans l'image du PC POV, en base 1920 × 1080 */
function playerPipRect(corner) {
  const w = 480, h = 270;
  return [corner.includes('right') ? 1920 - w - PIP_MARGIN : PIP_MARGIN, corner.includes('top') ? PIP_MARGIN : 1080 - h - PIP_MARGIN, w, h];
}

/** Coin du PIP joueur qui ne touche pas le PIP casters : le coin voulu si possible, sinon le plus proche */
export function freePlayerPipCorner(wanted, casterCam, game) {
  const [x, y, iw] = fitted16x9(game);
  const scale = iw / 1920;
  const onStream = corner => playerPipRect(corner).map((v, i) => (i === 0 ? x + v * scale : i === 1 ? y + v * scale : v * scale));
  const swap = (s, a, b) => (s.includes(a) ? s.replace(a, b) : s.replace(b, a));
  const side = swap(wanted, 'left', 'right'), height = swap(wanted, 'top', 'bottom');
  return [wanted, side, height, swap(side, 'top', 'bottom')].find(c => !rectsOverlap(onStream(c), casterCam)) ?? wanted;
}

/**
 * Renvoie les cases à afficher : [{ who: index joueur | 'room', rect: [x,y,w,h], weight, top }]
 */
export function cells(layout, opts = {}) {
  const [W, H] = opts.canvas || [1920, 1080];
  const sx = W / 1920, sy = H / 1080;
  const r = (x, y, w, h) => [Math.round(x * sx), Math.round(y * sy), Math.round(w * sx), Math.round(h * sy)];
  const p = layout.players || [];
  const out = [];

  switch (layout.type) {
    case 'FULL':
      out.push({ who: p[0], rect: r(0, 0, 1920, 1080), weight: 1 });
      break;
    case 'SPLIT': {
      const g = 8, w = (1920 - 3 * g) / 2, h = w * 9 / 16, y = (1080 - h) / 2;
      out.push({ who: p[0], rect: r(g, y, w, h), weight: 0.5 });
      out.push({ who: p[1], rect: r(2 * g + w, y, w, h), weight: 0.5 });
      break;
    }
    case 'PIP':
      out.push({ who: p[0], rect: r(0, 0, 1920, 1080), weight: 0.75 });
      out.push({ who: p[1], rect: r(...playerPipRect(opts.pipCorner || 'bottom-left')), weight: 0.25, top: true });
      break;
    case 'QUAD':
      for (let i = 0; i < 4; i++) {
        out.push({ who: p[i], rect: r((i % 2) * 960, Math.floor(i / 2) * 540, 960, 540), weight: 0.25 });
      }
      break;
    case 'MOSAIC': {
      const n = opts.playerCount ?? 8;
      const weight = 1 / Math.max(n, 8);
      let k = 0;
      for (let c = 0; c < 9; c++) {
        const rect = r((c % 3) * 640, Math.floor(c / 3) * 360, 640, 360);
        if (c === 4) {
          // À 9 joueurs, la case centrale revient au 9e : plus de place pour la caméra pièce
          if (n >= MOSAIC_FULL_AT) out.push({ who: 8, rect, weight });
          else if (opts.hasRoom) out.push({ who: 'room', rect, weight: 0 });
          continue;
        }
        if (k < n) out.push({ who: k, rect, weight });
        k++;
      }
      break;
    }
    case 'ROOM':
      out.push({ who: 'room', rect: r(0, 0, 1920, 1080), weight: 0 });
      break;
  }
  return out.filter(c => c.who !== undefined && c.who !== null);
}

/** Poids d'écran par joueur pour un plan : Map(index -> poids) */
export function screenWeights(layout, playerCount) {
  const m = new Map();
  for (const c of cells(layout, { playerCount, hasRoom: true })) {
    if (typeof c.who === 'number') m.set(c.who, (m.get(c.who) || 0) + c.weight);
  }
  return m;
}

export function sameLayout(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  const pa = a.players || [], pb = b.players || [];
  return pa.length === pb.length && pa.every((v, i) => v === pb[i]);
}

export function validLayout(l, playerCount) {
  if (!l || !LAYOUT_TYPES.includes(l.type)) return false;
  const need = SLOTS[l.type];
  const p = l.players || [];
  if (p.length < need) return false;
  const used = p.slice(0, need);
  if (new Set(used).size !== used.length) return false;
  return used.every(i => Number.isInteger(i) && i >= 0 && i < playerCount);
}

export function describe(l, names) {
  const n = i => names[i] ?? `#${i + 1}`;
  const p = l.players || [];
  switch (l.type) {
    case 'FULL': return `Plein écran ${n(p[0])}`;
    case 'SPLIT': return `Split ${n(p[0])} / ${n(p[1])}`;
    case 'PIP': return `${n(p[0])} + PIP ${n(p[1])}`;
    case 'QUAD': return `Quad ${p.slice(0, 4).map(n).join(', ')}`;
    case 'MOSAIC': return `Mosaïque ${names.length} POV`;
    case 'ROOM': return 'Caméra pièce';
  }
  return l.type;
}
