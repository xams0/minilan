// Touches du Stream Deck. Tout se décide ici, dans la régie : le plugin se contente de dessiner ce qu'on lui envoie
// et de renvoyer les appuis. Un joueur, une caméra ou une touche de plus ne demande donc ni nouveau plugin ni nouveau profil.
//
//   AUTO    CHAT    MANUEL  VERROU  ANTENNE SUGG.   CLASST  VOTE
//   SPLIT   PIP     QUAD    MOSAÏQ  PIÈCE   POV 1   POV 2   POV 3
//   CAST.AU CAST.OF CAST.PI CAST.SP CAST.FU POV 4   POV 5   POV 6
//   PRIVÉ   PROJ.   IGNORER CASTERS VOTE?   POV 7   POV 8   POV 9
//   PC POV  PC STR. TWITCH  IA      AGENTS
export const COLS = 8, ROWS = 5;

const INK = '#e8ecf5', DIM = '#8c98b8', OFF_INK = '#545f80', VOID = '#05070d', RAISED = '#0f1729', PANEL = '#0b111e', LINE = '#2c3c60';
const CYAN = '#35e6ff', LIVE = '#ff4470', WARN = '#ffb648', WIN = '#35e6a0', VIOLET = '#8b6bff';
const NEED = { SPLIT: 2, PIP: 2, QUAD: 4 };

const key = (label, extra = {}) => ({ label, bg: RAISED, fg: INK, border: LINE, subFg: DIM, ...extra });
const selected = k => ({ ...k, bg: CYAN, fg: VOID, border: CYAN, subFg: '#063a44' });
const armed = k => ({ ...k, border: WARN, fg: WARN, subFg: WARN, heavy: true });
const disabled = k => ({ ...k, bg: PANEL, fg: OFF_INK, subFg: OFF_INK, border: '#1a2440', run: undefined });
const info = k => ({ ...k, bg: VOID, border: VOID, run: undefined });
const mmss = s => { s = Math.round(Math.abs(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export class StreamDeckSurface {
  /** @param send  (commande) => void : exécute une commande de la régie, comme un clic sur le panneau */
  constructor({ config, getState, send }) {
    this.config = config;
    this.getState = getState;
    this.send = send;
    this.plan = null;      // SPLIT, PIP, QUAD : plan en attente de ses joueurs
    this.picks = [];
    this.privateNext = false;
  }

  disarm() { this.plan = null; this.picks = []; this.privateNext = false; }

  pressPlayer(i, state) {
    if (this.privateNext) {
      this.send({ cmd: 'private', i, value: !state.players[i].private });
      this.disarm();
    } else if (!this.plan) {
      this.send({ cmd: 'take', layout: { type: 'FULL', players: [i] } });
    } else if (this.picks.includes(i)) {
      this.picks = this.picks.filter(p => p !== i);
    } else {
      this.picks.push(i);
      if (this.picks.length >= NEED[this.plan]) {
        this.send({ cmd: 'take', layout: { type: this.plan, players: this.picks } });
        this.disarm();
      }
    }
  }

  playerKey(p, state) {
    const k = key(p.name, { num: String(p.i + 1), thumb: String(p.i), interest: Math.min(1, p.interest / 10), run: () => this.pressPlayer(p.i, state) });
    if (p.private) return { ...k, tag: 'PRIVÉ', tagFg: DIM, dim: true };
    if (this.picks.includes(p.i)) return { ...k, border: WARN, heavy: true, tag: 'CHOISI', tagFg: WARN };
    if (p.shown) return { ...k, border: LIVE, heavy: true, tag: 'LIVE', tagFg: LIVE };
    return p.afk ? { ...k, tag: 'AFK', tagFg: DIM } : k;
  }

  planKey(type, label) {
    const need = NEED[type];
    const k = key(label, { sub: 'puis les joueurs', run: () => { const same = this.plan === type; this.disarm(); if (!same) this.plan = type; } });
    return this.plan === type ? armed({ ...k, sub: `${this.picks.length}/${need}` }) : k;
  }

  /** Toutes les touches, à la position "colonne,ligne" */
  build(state) {
    const s = state, keys = {};
    const put = (col, row, k) => { keys[`${col},${row}`] = k; };
    const take = type => () => { this.disarm(); this.send({ cmd: 'take', layout: { type, players: [] } }); };
    const toggle = (k, on) => (on ? selected(k) : k);

    // Ligne 1 : modes et antenne
    [['AUTO', 'AUTO IA'], ['CHAT', 'CHAT'], ['MANUEL', 'MANUEL']].forEach(([mode, label], col) =>
      put(col, 0, toggle(key(label, { run: () => this.send({ cmd: 'mode', mode }) }), s.mode === mode)));
    put(3, 0, toggle(key('VERROU', { sub: s.locked ? 'verrouillé' : 'libre', run: () => this.send({ cmd: 'lock', value: !s.locked }) }), s.locked));
    const left = s.current.timedUntil > s.now ? ` · ${Math.ceil((s.current.timedUntil - s.now) / 1000)} s` : '';
    put(4, 0, info(key(s.current.label, { small: true, tag: 'ANTENNE', tagFg: LIVE, sub: mmss(s.current.holdSec) + left, border: LIVE })));
    const showSuggestion = s.suggestion && s.suggestion.label !== s.current.label && (s.mode === 'MANUEL' || s.locked);
    put(5, 0, showSuggestion
      ? key('PRENDRE', { sub: s.suggestion.label, border: VIOLET, run: () => this.send({ cmd: 'applySuggestion' }) })
      : disabled(key('SUGGESTION', { sub: 'aucune' })));
    put(6, 0, key('CLASSEMENT', { small: true, run: () => this.send({ cmd: 'board' }) }));
    put(7, 0, s.mode === 'CHAT'
      ? key('NOUVEAU VOTE', { small: true, run: () => this.send({ cmd: 'startVote' }) })
      : disabled(key('NOUVEAU VOTE', { small: true, sub: 'mode CHAT' })));

    // Lignes 2 à 4, à droite : les POV, comme la mosaïque 3 × 3
    for (const p of s.players) {
      if (p.i < 9) put(5 + p.i % 3, 1 + Math.floor(p.i / 3), this.playerKey(p, s));
    }

    // Ligne 2 : plans et caméra de la pièce
    put(0, 1, this.planKey('SPLIT', 'SPLIT'));
    put(1, 1, this.planKey('PIP', 'PIP'));
    put(2, 1, this.planKey('QUAD', 'QUAD'));
    put(3, 1, toggle(key('MOSAÏQUE', { small: true, run: take('MOSAIC') }), s.current.layout?.type === 'MOSAIC'));
    const room = key(this.config.pc2?.roomCam || 'PIÈCE', { small: true, thumb: 'room', run: take('ROOM') });
    put(4, 1, !s.hasRoom ? disabled(room) : s.current.layout?.type === 'ROOM' ? { ...room, border: LIVE, heavy: true, tag: 'LIVE', tagFg: LIVE } : room);

    // Ligne 3 : caméra des casters
    [['AUTO', 'AUTO'], ['OFF', 'OFF'], ['PIP', 'PIP'], ['SPLIT', 'SPLIT'], ['FULL', 'PLEIN ÉCRAN']].forEach(([mode, sub], col) => {
      const k = key('CASTERS', { sub, run: () => this.send({ cmd: 'caster', mode }), thumb: mode === 'FULL' ? 'caster' : undefined });
      put(col, 2, s.caster.mode === mode ? (k.thumb ? { ...k, border: CYAN, heavy: true, tag: 'CHOISI', tagFg: CYAN } : selected(k)) : k);
    });

    // Ligne 4 : privé, projecteurs, informations
    const privK = key('PRIVÉ', { sub: 'puis un joueur', run: () => { const on = !this.privateNext; this.disarm(); this.privateNext = on; } });
    put(0, 3, this.privateNext ? armed(privK) : privK);
    const spot = s.spotQueue[0];
    put(1, 3, spot ? key('PROJECTEUR', { small: true, sub: `${spot.label} (${s.spotQueue.length})`, run: () => this.send({ cmd: 'spot', action: 'run' }) }) : disabled(key('PROJECTEUR', { small: true, sub: 'aucun' })));
    put(2, 3, spot ? key('IGNORER', { sub: 'projecteur', run: () => this.send({ cmd: 'spot', action: 'drop' }) }) : disabled(key('IGNORER', { sub: 'projecteur' })));
    put(3, 3, info(key('CASTERS', { sub: `${s.caster.present ? 'présents' : 'absents'}${s.caster.talking ? ', parlent' : ''} · ${s.caster.applied}` })));
    const top = s.vote ? [...s.vote.options].sort((a, b) => b.n - a.n)[0] : null;
    put(4, 3, info(key('VOTE', { sub: s.vote ? `${Math.max(0, Math.ceil((s.vote.endsAt - s.now) / 1000))} s · ${top ? `${top.label} (${top.n})` : '—'}` : '—' })));

    // Ligne 5 : connexions
    [['pc1', 'PC POV'], ['pc2', 'PC STREAM'], ['twitch', 'TWITCH'], ['llm', 'IA']].forEach(([id, label], col) =>
      put(col, 4, info(key(label, { small: true, dot: s.status[id] ? WIN : LIVE }))));
    const agents = s.players.filter(p => p.agent).length;
    put(4, 4, info(key('AGENTS', { small: true, sub: `${agents}/${s.players.length}`, dot: agents === s.players.length ? WIN : agents ? WARN : LIVE })));
    return keys;
  }

  /** Ce qui part au plugin : uniquement de quoi dessiner */
  message() {
    const keys = {};
    for (const [at, { run, ...shown }] of Object.entries(this.build(this.getState()))) keys[at] = { ...shown, off: !run };
    return { type: 'deckKeys', cols: COLS, rows: ROWS, keys };
  }

  press(col, row) {
    const k = this.build(this.getState())[`${col},${row}`];
    if (k?.run) k.run();
  }
}
