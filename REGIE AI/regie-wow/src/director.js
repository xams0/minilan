// Le "cerveau" de la régie : scores d'intérêt, dette de temps d'écran,
// décisions automatiques, modes AUTO / CHAT / MANUEL, casters, spotlight, votes.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { screenWeights, sameLayout, validLayout, describe, SLOTS } from './layouts.js';

// Poids d'intérêt par type d'événement de jeu
const EVENT_WEIGHTS = {
  dmg_out: 0.12, dmg_in: 0.2, heal: 0.04, cast: 0.03,
  kill: 1.0, interrupt: 0.5, res: 1.0,
  death: 4.5, boss_start: 5, boss_kill: 4, boss_wipe: 3, level: 3.5,
  shout: 1.2
};
const URGENT = new Set(['death', 'boss_start', 'boss_kill', 'boss_wipe', 'level']);
// WoW écrit le log en fin de combat : ces événements restent intéressants en retard, sans justifier une coupe urgente.
// Les autres décrivent une action déjà finie, y compris un pull de boss.
const KEPT_WHEN_LATE = new Set(['death', 'kill', 'boss_kill', 'boss_wipe']);
// Fréquents : agrégés. Les rares comptent chacun.
const AGGREGATED = new Set(['dmg_out', 'dmg_in', 'heal', 'cast']);
const LABELS = {
  death: 'Mort de', boss_start: 'Pull de boss', boss_kill: 'Boss tombé', boss_wipe: 'Wipe',
  level: 'Level up de', kill: 'Kill de', dmg_in: 'En danger :', dmg_out: 'Combat de', shout: 'Ça crie chez',
  interrupt: 'Interruption de', res: 'Résurrection par'
};
const KIND_NAMES = {
  death: 'Mort', kill: 'Kill', boss_start: 'Pull de boss', boss_kill: 'Boss tombé', boss_wipe: 'Wipe', interrupt: 'Interruption', res: 'Résurrection',
  dmg_out: 'Dégâts infligés', dmg_in: 'Dégâts subis', heal: 'Soin', cast: 'Sort lancé', level: 'Level up'
};
const AGENT_SEEN_MS = 15000;
const CAUSE_OF_SOURCE = { manual: 'MANUEL', chat: 'CHAT', spotlight: 'PROJECTEUR' };
const JOURNAL_SIZE = 12;

/** Ce qui a rendu ces joueurs « chauds » : le combat log, leur micro, ou autre chose */
function causeOf(players) {
  if (players.some(p => p.lastKind && p.lastKind !== 'shout')) return 'LOGS';
  return players.some(p => p.lastKind === 'shout') ? 'MICRO' : 'ACTION';
}
const logAgeOf = players => players.map(p => p.lastKindAge).find(a => a != null);
const INTEREST_CAP = 10;
const HALF_LIFE_SEC = 8;
const MODES = ['AUTO', 'CHAT', 'MANUEL'];
const CASTER_MODES = ['AUTO', 'OFF', 'PIP', 'SPLIT', 'FULL'];
const CASTER_GAME_FACTOR = { OFF: 1, PIP: 0.9, SPLIT: 0.5, FULL: 0.25 };

export class Director extends EventEmitter {
  constructor(config, { dataDir, now = () => Date.now() } = {}) {
    super();
    this.cfg = config;
    this.d = config.director;
    this.now = now;
    this.dataDir = dataDir;
    this.hasRoom = !!config.pc2?.roomCam; // caméra pièce branchée sur le PC Stream
    this.players = config.players.map((p, i) => ({
      i, name: p.name, interest: 0, motion: 0, motionKnown: false, lastMotionAt: 0,
      lastEventAt: 0, urgentAt: 0, lastKind: null, events: [], private: false, afk: false,
      speaking: false, agentSeenAt: 0, screenTime: 0,
      logs: { counts: {}, lastAt: 0, lastKind: null, lastAge: null }
    }));
    this.N = this.players.length;
    this.mode = 'AUTO';
    this.locked = false;
    this.fairness = this.d.fairness;
    const t = this.now();
    this.current = { layout: { type: 'MOSAIC', players: [] }, since: t, reason: 'Démarrage', source: 'auto', timedUntil: 0 };
    this.suggestion = null;
    this.journal = []; // pourquoi le plan change, et les événements reçus des logs : le plus récent d'abord
    this.distributed = 0;
    this.startedAt = t;
    this.lastMosaicAt = t;
    this.lastRoomAt = t;
    this.lastBoardAt = t;
    this.lastEvalAt = 0;
    this.lastTickAt = t;
    this.spotQueue = [];
    this.vote = null;
    this.lastVoteWinner = null;
    this.llmSuggestion = null;
    this.schedule = { activeIdx: -1, from: null };
    this.log = [];
    this.caster = {
      mode: 'AUTO', applied: 'OFF', appliedAt: 0, present: false, presenceCalibrated: false,
      speaking: false, lastSpokeAt: 0, talkStartAt: 0
    };
    this.status = { pc1: false, pc2: false, twitch: false, llm: !!(config.llm?.enabled) };
    this.output = { applyLayout: async () => {}, applyCaster: async () => {} };
    this.loadState();
  }

  // ---------- Entrées ----------

  addEvent(i, kind, extra = {}) {
    const p = this.players[i];
    if (!p || !EVENT_WEIGHTS[kind]) return;
    const t = this.now();
    const w = EVENT_WEIGHTS[kind] * (extra.mult || 1);
    p.interest = Math.min(INTEREST_CAP, p.interest + w * Math.max(0.05, 1 - p.interest / INTEREST_CAP));
    const prevAt = p.lastEventAt;
    p.lastEventAt = t;
    if (URGENT.has(kind) && !extra.late) p.urgentAt = t;
    // Le "dernier type" sert à expliquer la décision : on garde le plus marquant des 5 dernières secondes
    if (URGENT.has(kind) || t - prevAt > 5000 || EVENT_WEIGHTS[kind] >= (EVENT_WEIGHTS[p.lastKind] ?? 0)) { p.lastKind = kind; p.lastKindAge = extra.age ?? null; }
    p.events.push({ t, kind });
    if (p.events.length > 400) p.events.splice(0, p.events.length - 400);
  }

  /** Événements d'un agent. age = ancienneté de la ligne du log en secondes, absente chez un agent plus ancien. */
  addAgentEvents(i, events = []) {
    const p = this.players[i];
    if (!p) return;
    const fresh = {};
    let noted = false;
    for (const { kind, n, age = 0 } of events) {
      if (EVENT_WEIGHTS[kind]) {
        // Compté même en retard : /logs dit ce qui est arrivé, pas ce qui a fait changer le plan
        p.logs.counts[kind] = (p.logs.counts[kind] || 0) + n;
        p.logs.lastAt = this.now();
        if (!noted || !AGGREGATED.has(kind)) { p.logs.lastKind = kind; p.logs.lastAge = age; }
      }
      const late = age > this.d.maxEventAgeSec;
      if (!late) fresh[kind] = { n: (fresh[kind]?.n || 0) + n, age: Math.min(age, fresh[kind]?.age ?? age) };
      else if (KEPT_WHEN_LATE.has(kind)) for (let k = 0; k < Math.min(n, 3); k++) this.addEvent(i, kind, { late: true, age });
      else p.lastEventAt = this.now(); // plus rien à montrer, mais le joueur n'est pas AFK
      if (EVENT_WEIGHTS[kind] && !AGGREGATED.has(kind)) {
        const name = /( de| par| :)$/.test(LABELS[kind] || '') ? `${LABELS[kind]} ${p.name}` : `${LABELS[kind] || kind} (${p.name})`;
        this.note({ type: 'log', label: name, age, ignored: late && !KEPT_WHEN_LATE.has(kind) });
        noted = true;
      }
    }
    for (const [kind, { n, age }] of Object.entries(fresh)) {
      if (AGGREGATED.has(kind)) this.addEvent(i, kind, { mult: Math.min(n, 4), age });
      else for (let k = 0; k < Math.min(n, 3); k++) this.addEvent(i, kind, { age });
    }
    if (noted) this.emitState();
  }

  /** Pour la page /logs : joueur par joueur, l'agent est-il là et que reçoit-on ? */
  logSummary() {
    const t = this.now();
    return this.players.map(p => ({
      name: p.name,
      connected: t - p.agentSeenAt < AGENT_SEEN_MS,
      everSeen: p.agentSeenAt > 0,
      seenAgoSec: p.agentSeenAt ? Math.round((t - p.agentSeenAt) / 1000) : null,
      lastLabel: p.logs.lastKind ? KIND_NAMES[p.logs.lastKind] || p.logs.lastKind : null,
      lastAgoSec: p.logs.lastAt ? Math.round((t - p.logs.lastAt) / 1000) : null,
      lastAge: p.logs.lastAge,
      counts: p.logs.counts
    }));
  }

  /** Ajoute une ligne au journal affiché par /overlay/journal */
  note(entry) {
    this.journal.unshift({ t: this.now(), ...entry });
    this.journal.length = Math.min(this.journal.length, JOURNAL_SIZE);
  }

  agentSeen(i) { if (this.players[i]) this.players[i].agentSeenAt = this.now(); }

  setMotion(i, motion) {
    const p = this.players[i];
    if (!p) return;
    p.motionKnown = true;
    p.motion = motion;
    if (motion > 0.02) p.lastMotionAt = this.now();
  }

  setSpeaking(i, speaking) {
    const p = this.players[i];
    if (!p) return;
    if (speaking && !p.speaking) this.addEvent(i, 'shout', { mult: 0.5 });
    p.speaking = speaking;
    if (speaking) p.interest = Math.min(INTEREST_CAP, p.interest + 0.15);
  }

  setPrivate(i, value) {
    const p = this.players[i];
    if (!p) return;
    p.private = !!value;
    this.addLog(`${p.name} ${p.private ? 'passe en privé' : 'redevient visible'}`);
    // La vie privée passe avant tout, même en mode MANUEL ou plan verrouillé
    if (p.private && this.isShown(i)) {
      const d = this.decide();
      this.apply({ ...d, reason: `${p.name} en privé → ${d.reason}`, source: this.mode === 'MANUEL' ? 'manual' : 'auto', cause: 'PRIVÉ' });
    }
    this.emitState();
  }

  setCasterPresent(v) { this.caster.present = !!v; this.caster.presenceCalibrated = true; }
  setCasterSpeaking(v) {
    const t = this.now(), c = this.caster;
    c.speaking = !!v;
    if (v) {
      if (!c.talkStartAt || t - c.lastSpokeAt > 2500) c.talkStartAt = t;
      c.lastSpokeAt = t;
    }
  }

  setMode(mode, why = 'régie') {
    if (!MODES.includes(mode) || mode === this.mode) return;
    this.mode = mode;
    if (mode !== 'CHAT') this.vote = null;
    if (this.current.source === 'chat') this.current.timedUntil = 0;
    this.addLog(`Mode ${mode} (${why})`);
    if (mode === 'CHAT') this.startVote();
    this.emitState();
  }

  setCasterMode(mode) {
    if (!CASTER_MODES.includes(mode)) return;
    this.caster.mode = mode;
    this.evaluateCaster(true);
    this.emitState();
  }

  setLocked(v) { this.locked = !!v; this.addLog(this.locked ? 'Plan verrouillé' : 'Plan déverrouillé'); this.emitState(); }
  setFairness(v) { this.fairness = Math.max(0, Math.min(1, Number(v) || 0)); this.emitState(); }

  /** Prise manuelle depuis le panneau (fonctionne dans tous les modes) */
  take(layout, reason = 'Prise manuelle') {
    if (!validLayout(layout, this.N)) return false;
    if (SLOTS[layout.type] === 0) layout = { type: layout.type, players: [] };
    else layout = { type: layout.type, players: layout.players.slice(0, SLOTS[layout.type]) };
    this.apply({ layout, reason, source: 'manual' });
    return true;
  }

  /** En mode MANUEL les coups de projecteur attendent : le régisseur les lance d'un tap */
  runSpotlight() {
    if (!this.spotQueue.length) return;
    const mode = this.mode;
    this.mode = 'AUTO';
    this.current.timedUntil = 0;
    this.evaluate();
    this.mode = mode;
  }

  dropSpotlight() { this.spotQueue.shift(); this.emitState(); }

  applySuggestion() { if (this.suggestion) this.apply({ ...this.suggestion, source: 'manual' }); }

  setLlmSuggestion(s) {
    if (!s || !validLayout(s.layout, this.N)) return;
    const shown = s.layout.players.slice(0, SLOTS[s.layout.type]);
    if (shown.some(i => this.players[i].private)) return;
    this.llmSuggestion = { layout: { type: s.layout.type, players: shown }, reason: `IA : ${s.reason || 'suggestion'}`, cause: 'IA', at: this.now() };
    this.addLog(`Suggestion IA : ${describe(this.llmSuggestion.layout, this.names())} — ${s.reason || ''}`);
  }

  // ---------- Chat ----------

  /** Interprète un argument de vote : numéro, nom, mosaïque, pièce */
  parseChoice(arg) {
    if (!arg) return null;
    const a = arg.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/^\d+$/.test(a)) {
      const n = parseInt(a, 10) - 1;
      return n >= 0 && n < this.N ? n : null;
    }
    if (['mosaique', 'tous', 'all', 'mosaic'].includes(a)) return 'MOSAIC';
    if (this.hasRoom && ['piece', 'salle', 'room', 'cam'].includes(a)) return 'ROOM';
    if (a.length < 3) return null;
    const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const exact = this.players.findIndex(p => norm(p.name) === a);
    if (exact >= 0) return exact;
    const pre = this.players.filter(p => norm(p.name).startsWith(a));
    return pre.length === 1 ? pre[0].i : null;
  }

  chatVote(user, arg) {
    if (this.mode !== 'CHAT' || !this.vote) return;
    const choice = this.parseChoice(arg);
    if (choice === null) return;
    if (typeof choice === 'number' && this.players[choice].private) return;
    this.vote.votes.set(user.toLowerCase(), choice);
    this.emitVote();
  }

  startVote() {
    const t = this.now();
    this.vote = { round: (this.vote?.round || 0) + 1, startedAt: t, endsAt: t + this.cfg.twitch.voteSeconds * 1000, votes: new Map() };
    this.emitVote();
  }

  tally() {
    const counts = new Map();
    if (!this.vote) return counts;
    for (const c of this.vote.votes.values()) counts.set(c, (counts.get(c) || 0) + 1);
    return counts;
  }

  resolveVote() {
    const counts = this.tally();
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) {
      this.addLog(`Vote #${this.vote.round} : aucun vote, l'IA garde la main`);
      this.startVote();
      return;
    }
    // Pondération : un joueur en retard de temps d'écran est un peu favorisé,
    // le gagnant précédent est pénalisé pour éviter la monopolisation.
    const scored = [...counts.entries()].map(([c, v]) => {
      let eff = v;
      if (typeof c === 'number') eff *= 0.7 + 0.6 * ((this.debtNorm(c) + 1) / 2);
      if (c === this.lastVoteWinner) eff *= 0.5;
      return { c, v, eff };
    }).sort((a, b) => b.eff - a.eff);
    const win = scored[0];
    let layout;
    if (win.c === 'MOSAIC' || win.c === 'ROOM') layout = { type: win.c, players: [] };
    else {
      const second = scored.find(s => typeof s.c === 'number' && s.c !== win.c && s.v >= 0.3 * win.v);
      layout = second ? { type: 'PIP', players: [win.c, second.c] } : { type: 'FULL', players: [win.c] };
    }
    this.lastVoteWinner = win.c;
    const label = typeof win.c === 'number' ? this.players[win.c].name : (win.c === 'MOSAIC' ? 'la mosaïque' : 'la caméra pièce');
    const reason = `Vote du chat #${this.vote.round} : ${label} (${win.v}/${total} votes)`;
    this.apply({ layout, reason, source: 'chat', timedUntil: this.now() + this.cfg.twitch.voteSeconds * 1000 });
    this.emit('say', `🎬 Le chat a choisi ${label} ! Prochain vote : !pov <numéro ou pseudo>`);
    this.emit('overlay', { type: 'voteResult', label, votes: win.v, total });
    this.startVote();
  }

  /** Récompense de points de chaîne (déclarée dans config.twitch.rewards) */
  redeem(action, user, text) {
    if (action === 'spotlight') {
      const c = this.parseChoice(text);
      if (typeof c !== 'number') { this.emit('say', `@${user} pseudo ou numéro de joueur introuvable : « ${text} »`); return; }
      if (this.players[c].private) { this.emit('say', `@${user} ${this.players[c].name} est en pause, réessaie plus tard`); return; }
      this.spotQueue.push({ player: c, by: user, sec: this.d.spotlightSec });
      this.addLog(`Coup de projecteur demandé par ${user} sur ${this.players[c].name}`);
    } else if (action === 'split') {
      const pool = this.players.filter(p => !p.private && !p.afk).map(p => p.i);
      if (pool.length < 2) return;
      const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
      const b = pool[Math.floor(Math.random() * pool.length)];
      this.spotQueue.push({ layout: { type: 'SPLIT', players: [a, b] }, by: user, sec: this.d.spotlightSec });
      this.addLog(`Split surprise demandé par ${user}`);
    } else if (action === 'mosaic') {
      this.spotQueue.push({ layout: { type: 'MOSAIC', players: [] }, by: user, sec: 30 });
    }
    this.emitState();
  }

  // ---------- Équité ----------

  target() { return this.distributed / this.N; }
  debt(i) { return this.target() - this.players[i].screenTime; }
  debtNorm(i) { return Math.max(-1, Math.min(1, this.debt(i) / this.d.debtScaleSec)); }
  priority(i) {
    const p = this.players[i];
    return p.interest + this.fairness * this.d.hotThreshold * 1.5 * this.debtNorm(i);
  }

  resetScreenTime() {
    for (const p of this.players) p.screenTime = 0;
    this.distributed = 0;
    this.startedAt = this.now();
    this.addLog('Compteurs de temps d\'écran remis à zéro');
    this.saveState();
    this.emitState();
  }

  // ---------- Boucle ----------

  tick() {
    const t = this.now();
    const dt = Math.min(5, (t - this.lastTickAt) / 1000);
    this.lastTickAt = t;
    const decay = Math.exp(-dt * Math.LN2 / HALF_LIFE_SEC);
    for (const p of this.players) {
      p.interest *= decay;
      const seenAt = Math.max(p.lastEventAt, p.lastMotionAt);
      p.afk = p.motionKnown && (t - seenAt) / 1000 > this.d.afkAfterSec;
      p.events = p.events.filter(e => t - e.t < 120000);
    }

    // Temps d'écran : poids du plan × part de l'image laissée au jeu par les casters
    const gf = CASTER_GAME_FACTOR[this.caster.applied] ?? 1;
    for (const [i, w] of screenWeights(this.current.layout, this.N)) {
      this.players[i].screenTime += w * gf * dt;
      this.distributed += w * gf * dt;
    }

    this.runSchedule(t);

    if (this.mode === 'CHAT') {
      if (!this.vote) this.startVote();
      else if (t >= this.vote.endsAt) this.resolveVote();
    }

    if (t - this.lastEvalAt >= this.d.evalEverySec * 1000) {
      this.lastEvalAt = t;
      this.evaluate();
    }
    this.evaluateCaster();

    if (this.d.screenTimeBoardEveryMin > 0 && t - this.lastBoardAt > this.d.screenTimeBoardEveryMin * 60000) {
      this.lastBoardAt = t;
      this.showBoard();
    }
    if (Math.floor(t / 30000) !== Math.floor((t - dt * 1000) / 30000)) this.saveState();
    this.emitState();
  }

  runSchedule(t) {
    if (!this.cfg.scheduleEnabled) return;
    const sched = this.cfg.schedule || [];
    const d = new Date(t);
    const minute = d.getMinutes() + d.getSeconds() / 60;
    const idx = sched.findIndex(s => minute >= s.minute && minute < s.minute + s.durationMin);
    if (idx !== this.schedule.activeIdx) {
      if (idx >= 0 && this.mode === 'AUTO') {
        this.schedule = { activeIdx: idx, from: 'AUTO' };
        this.setMode(sched[idx].mode, 'planning');
      } else if (idx < 0 && this.schedule.from && this.mode === sched[this.schedule.activeIdx]?.mode) {
        this.schedule = { activeIdx: -1, from: null };
        this.setMode('AUTO', 'fin du planning');
      } else {
        this.schedule = { activeIdx: idx, from: null };
      }
    }
  }

  isShown(i) { return screenWeights(this.current.layout, this.N).has(i); }

  /** Calcule le plan idéal à l'instant T (heuristique) */
  decide({ exclude = [] } = {}) {
    const t = this.now(), d = this.d;
    const ps = this.players;
    const cands = ps.filter(p => !p.private);
    if (cands.length === 0) {
      return { layout: { type: this.hasRoom ? 'ROOM' : 'MOSAIC', players: [] }, reason: 'Tout le monde est en privé' };
    }
    let active = cands.filter(p => !p.afk);
    if (active.length === 0) active = cands;
    const ex = active.filter(p => !exclude.includes(p.i));
    if (ex.length > 0) active = ex;
    const byPrio = [...active].sort((a, b) => this.priority(b.i) - this.priority(a.i));
    const hot = byPrio.filter(p => p.interest >= d.hotThreshold);
    const maxI = Math.max(...cands.map(p => p.interest));
    const bossGroup = cands.filter(p => p.events.some(e => e.kind === 'boss_start' && t - e.t < 20000)).length;
    const urgentOf = arr => arr.some(p => t - p.urgentAt < 4000 && !this.isShown(p.i));
    const afkCount = cands.filter(p => p.afk).length;

    if (maxI < d.calmThreshold) {
      if (this.hasRoom && afkCount >= Math.ceil(cands.length / 2)) {
        return { layout: { type: 'ROOM', players: [] }, reason: `Pause : ${afkCount} joueurs inactifs`, special: true, cause: 'PAUSE' };
      }
      if (this.hasRoom && t - this.lastRoomAt > d.roomEveryMin * 60000) {
        return { layout: { type: 'ROOM', players: [] }, reason: 'Plan de coupe pièce', timedSec: d.roomDurationSec, special: true, cause: 'PLANNING' };
      }
      if (t - this.lastMosaicAt > d.mosaicEveryMin * 60000 && cands.length >= 4) {
        return { layout: { type: 'MOSAIC', players: [] }, reason: 'Tour de table mosaïque', timedSec: d.mosaicDurationSec, special: true, cause: 'PLANNING' };
      }
    }

    if (hot.length >= 4 || bossGroup >= 4) {
      const pick = [...hot, ...byPrio.filter(p => !hot.includes(p))].slice(0, 4);
      if (pick.length === 4) {
        return {
          layout: { type: 'QUAD', players: pick.map(p => p.i) },
          reason: bossGroup >= 4 ? `Pull de boss (${bossGroup} joueurs)` : `${hot.length} joueurs en action`,
          urgent: urgentOf(pick),
          cause: bossGroup >= 4 ? 'LOGS' : causeOf(hot), logAge: logAgeOf(hot)
        };
      }
    }
    if (hot.length >= 2) {
      const [a, b] = hot;
      return { layout: { type: 'SPLIT', players: [a.i, b.i] }, reason: `Action : ${a.name} et ${b.name}`, urgent: urgentOf([a, b]), cause: causeOf([a, b]), logAge: logAgeOf([a, b]) };
    }
    if (hot.length === 1) {
      const a = hot[0];
      const second = byPrio.find(p => p !== a && p.interest >= d.calmThreshold);
      const why = `${LABELS[a.lastKind] || 'Action :'} ${a.name}`;
      if (second) return { layout: { type: 'PIP', players: [a.i, second.i] }, reason: `${why} (+ ${second.name} en PIP)`, urgent: urgentOf([a]), cause: causeOf([a]), logAge: logAgeOf([a]) };
      return { layout: { type: 'FULL', players: [a.i] }, reason: why, urgent: urgentOf([a]), cause: causeOf([a]), logAge: logAgeOf([a]) };
    }
    const top = byPrio[0];
    const debtMin = this.debt(top.i) / 60;
    return {
      layout: { type: 'FULL', players: [top.i] },
      reason: debtMin > 1 ? `Rattrapage temps d'écran : ${top.name} (${debtMin.toFixed(1)} min de retard)` : `Rotation : ${top.name}`,
      cause: 'ROTATION'
    };
  }

  layoutScore(layout) {
    const pr = [...screenWeights(layout, this.N).keys()].map(i => this.players[i].private ? -99 : this.priority(i)).sort((a, b) => b - a);
    if (pr.length === 0) return 0.5;
    return pr[0] + 0.3 * pr.slice(1).reduce((a, b) => a + b, 0);
  }

  evaluate(force = false) {
    const t = this.now(), d = this.d, cur = this.current;
    const shownPrivate = [...screenWeights(cur.layout, this.N).keys()].some(i => this.players[i].private);

    if (this.mode === 'MANUEL') {
      this.suggestion = this.decide();
      return;
    }
    if (this.locked && !shownPrivate) return;

    // Spotlight (points de chaîne)
    if (cur.source === 'spotlight' && t < cur.timedUntil && !shownPrivate) return;
    if (this.spotQueue.length) {
      const s = this.spotQueue.shift();
      const layout = s.layout || { type: 'FULL', players: [s.player] };
      const label = s.layout ? describe(layout, this.names()) : this.players[s.player].name;
      this.apply({ layout, reason: `Coup de projecteur de ${s.by} : ${label}`, source: 'spotlight', timedUntil: t + s.sec * 1000 });
      this.emit('overlay', { type: 'spotlight', by: s.by, label, sec: s.sec });
      this.emit('say', `🔦 Coup de projecteur de @${s.by} sur ${label} pendant ${s.sec}s !`);
      return;
    }
    // Résultat de vote ou plan spécial minuté
    if (t < cur.timedUntil && !shownPrivate) {
      if (cur.source === 'chat') return;
      const desired = this.decide();
      if (!desired.urgent) return;
    }

    let desired = this.decide();
    if (this.llmSuggestion && t - this.llmSuggestion.at < 20000 && !desired.urgent) {
      desired = { ...this.llmSuggestion };
      this.llmSuggestion = null;
    }
    this.suggestion = desired;
    if (sameLayout(desired.layout, cur.layout)) { cur.reason = desired.reason; return; }

    const hold = (t - cur.since) / 1000;
    if (shownPrivate || force) return this.apply(desired);
    if (hold < d.minHoldSec) {
      if (desired.urgent && hold >= d.urgentMinHoldSec) this.apply(desired);
      return;
    }
    if (desired.timedSec || desired.special) return this.apply(desired);
    const curScore = this.layoutScore(cur.layout);
    const desScore = this.layoutScore(desired.layout);
    if (desScore > curScore * 1.3 + 0.4) return this.apply(desired);
    if (hold > d.maxHoldSec) {
      const shown = [...screenWeights(cur.layout, this.N).keys()];
      const alt = this.decide({ exclude: shown });
      alt.reason = `${alt.reason} (changement après ${Math.round(hold)}s)`;
      return this.apply(alt);
    }
  }

  apply({ layout, reason, source = 'auto', timedUntil = 0, timedSec, cause, logAge }) {
    const t = this.now();
    if (timedSec) timedUntil = t + timedSec * 1000;
    if (layout.type === 'MOSAIC') this.lastMosaicAt = t;
    if (layout.type === 'ROOM') this.lastRoomAt = t;
    const changed = !sameLayout(layout, this.current.layout);
    this.current = { layout, since: changed ? t : this.current.since, reason, source, timedUntil };
    if (changed) {
      this.addLog(`${describe(layout, this.names())} — ${reason}`);
      this.note({ type: 'switch', cause: CAUSE_OF_SOURCE[source] || cause || 'AUTO', label: describe(layout, this.names()), reason, age: logAge ?? null });
      Promise.resolve(this.output.applyLayout(layout)).catch(e => this.addLog(`Erreur PC POV : ${e.message}`));
    }
    this.emitState();
  }

  // ---------- Casters ----------

  casterAutoTarget() {
    const t = this.now(), c = this.caster, cc = this.cfg.casters;
    const maxI = Math.max(0, ...this.players.map(p => p.interest));
    const present = c.presenceCalibrated ? c.present : (t - c.lastSpokeAt < 20000);
    if (!present) return 'OFF';
    if (maxI >= this.d.hotThreshold) return 'PIP';
    const talking = t - c.lastSpokeAt < 3000;
    if (cc.autoFull && talking && c.talkStartAt && (t - c.talkStartAt) / 1000 >= cc.fullAfterTalkSec && maxI < this.d.calmThreshold) return 'FULL';
    if (c.applied === 'FULL' && t - c.lastSpokeAt < 8000) return 'FULL';
    return 'PIP';
  }

  evaluateCaster(force = false) {
    const t = this.now(), c = this.caster;
    const target = c.mode === 'AUTO' ? this.casterAutoTarget() : c.mode;
    if (target === c.applied) return;
    if (!force && c.mode === 'AUTO' && t - c.appliedAt < this.cfg.casters.minHoldSec * 1000) return;
    c.applied = target;
    c.appliedAt = t;
    this.addLog(`Casters : ${target}`);
    Promise.resolve(this.output.applyCaster(target)).catch(e => this.addLog(`Erreur PC Stream : ${e.message}`));
  }

  // ---------- Sorties ----------

  names() { return this.players.map(p => p.name); }

  addLog(msg) {
    const d = new Date(this.now());
    const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    this.log.unshift(`${hh}  ${msg}`);
    if (this.log.length > 60) this.log.pop();
  }

  showBoard() { this.emit('overlay', { type: 'board', board: this.board() }); }

  board() {
    const tgt = this.target();
    return this.players.map(p => ({ i: p.i, name: p.name, screenTime: p.screenTime, debt: tgt - p.screenTime }))
      .sort((a, b) => b.screenTime - a.screenTime);
  }

  voteState() {
    if (!this.vote) return null;
    const counts = this.tally();
    const opts = this.players.map(p => ({ key: p.i, label: p.name, n: counts.get(p.i) || 0, private: p.private }));
    opts.push({ key: 'MOSAIC', label: 'Mosaïque', n: counts.get('MOSAIC') || 0 });
    if (this.hasRoom) opts.push({ key: 'ROOM', label: 'Pièce', n: counts.get('ROOM') || 0 });
    return { round: this.vote.round, endsAt: this.vote.endsAt, total: this.vote.votes.size, options: opts };
  }

  emitVote() { this.emit('overlay', { type: 'vote', vote: this.voteState() }); }

  getState() {
    const t = this.now();
    return {
      now: t,
      mode: this.mode, locked: this.locked, fairness: this.fairness,
      status: this.status,
      current: { ...this.current, label: describe(this.current.layout, this.names()), holdSec: Math.round((t - this.current.since) / 1000) },
      suggestion: this.suggestion ? { ...this.suggestion, label: describe(this.suggestion.layout, this.names()) } : null,
      target: this.target(),
      elapsedSec: (t - this.startedAt) / 1000,
      players: this.players.map(p => ({
        i: p.i, name: p.name, interest: +p.interest.toFixed(2), priority: +this.priority(p.i).toFixed(2),
        motion: +p.motion.toFixed(3), afk: p.afk, private: p.private, speaking: p.speaking,
        agent: t - p.agentSeenAt < 15000, screenTime: Math.round(p.screenTime), debt: Math.round(this.debt(p.i)),
        lastKind: p.lastKind, shown: this.isShown(p.i)
      })),
      caster: { ...this.caster, talking: t - this.caster.lastSpokeAt < 3000 },
      vote: this.mode === 'CHAT' ? this.voteState() : null,
      spotQueue: this.spotQueue.map(s => ({ by: s.by, label: s.layout ? describe(s.layout, this.names()) : this.players[s.player].name })),
      hasRoom: this.hasRoom,
      log: this.log.slice(0, 25),
      journal: this.journal
    };
  }

  emitState() { this.emit('state'); }

  /** Résumé compact pour la couche LLM */
  summaryForLlm() {
    const t = this.now();
    return {
      current: describe(this.current.layout, this.names()),
      holdSec: Math.round((t - this.current.since) / 1000),
      casters: this.caster.applied,
      players: this.players.map(p => {
        const counts = {};
        for (const e of p.events) if (t - e.t < 60000) counts[e.kind] = (counts[e.kind] || 0) + 1;
        return {
          index: p.i, name: p.name, interest: +p.interest.toFixed(1), afk: p.afk, private: p.private,
          screenDebtMin: +(this.debt(p.i) / 60).toFixed(1), last60s: counts
        };
      })
    };
  }

  // ---------- Persistance (un crash ne remet pas l'équité à zéro) ----------

  statePath() { return this.dataDir ? path.join(this.dataDir, 'state.json') : null; }

  saveState() {
    const f = this.statePath();
    if (!f) return;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(f, JSON.stringify({
        savedAt: this.now(), startedAt: this.startedAt, distributed: this.distributed,
        players: this.players.map(p => ({ name: p.name, screenTime: p.screenTime }))
      }, null, 2));
    } catch { /* disque plein ou lecture seule : on continue */ }
  }

  loadState() {
    const f = this.statePath();
    if (!f || !fs.existsSync(f)) return;
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (s.players?.length !== this.N || s.players.some((p, i) => p.name !== this.players[i].name)) return;
      s.players.forEach((p, i) => { this.players[i].screenTime = p.screenTime; });
      this.distributed = s.distributed;
      this.startedAt = s.startedAt;
      this.addLog('Temps d\'écran restaurés depuis la dernière sauvegarde');
    } catch { /* fichier corrompu : on repart de zéro */ }
  }
}
