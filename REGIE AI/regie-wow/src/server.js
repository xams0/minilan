// Point d'entrée : serveur web (panneau, overlays, API agents) + pilotage OBS + chat + IA.
//   npm start            → tout démarre
//   npm start -- --no-obs → sans OBS (répétition / test du panneau)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Director } from './director.js';
import { Pc1, Pc2 } from './obs.js';
import { TwitchChat } from './twitch.js';
import { LlmDirector } from './llm.js';
import { createSettingsApi, withDefaults } from './settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Avec RegieIA.exe, le programme est remplacé à chaque mise à jour : config.json et data/ restent à côté de l'exe
const HOME = process.env.REGIE_HOME ? path.resolve(process.env.REGIE_HOME) : ROOT;
const DATA = path.join(HOME, 'data');
const PUBLIC = path.join(ROOT, 'public');
const noObsFlag = process.argv.includes('--no-obs');

let cfgFile = path.join(HOME, 'config.json');
if (!fs.existsSync(cfgFile)) {
  console.warn('config.json absent : utilisation de config.example.json (règle-la sur /reglages)');
  cfgFile = path.join(ROOT, 'config.example.json');
}
const config = withDefaults(
  JSON.parse(fs.readFileSync(cfgFile, 'utf8')),
  JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))
);
const noObs = noObsFlag || config.obsEnabled === false;

const director = new Director(config, { dataDir: DATA });
const clients = new Set();
const lastTags = {};
let lastThumbs = {};
let lastCasterThumb = null;
let lastRoomThumb = null;

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (roles, obj) => {
  const s = JSON.stringify(obj);
  for (const c of clients) if (roles.includes(c.role) && c.ws.readyState === 1) c.ws.send(s);
};

// ---- OBS ----
const pc1 = new Pc1(config, director, {
  onTags: (slot, tags, canvas) => { lastTags[slot] = { type: 'tags', slot, tags, canvas }; broadcast(['tags'], lastTags[slot]); },
  onThumbs: thumbs => { lastThumbs = { ...lastThumbs, ...thumbs }; broadcast(['panel'], { type: 'thumbs', thumbs }); }
});
const pc2 = new Pc2(config, director, {
  dataDir: DATA,
  onThumb: uri => { lastCasterThumb = uri; broadcast(['panel'], { type: 'casterThumb', uri }); },
  onRoomThumb: uri => { lastRoomThumb = uri; broadcast(['panel'], { type: 'roomThumb', uri }); }
});
director.output.applyLayout = layout => { pc2.setLayout(layout); return pc1.applyLayout(layout); };
director.output.applyCaster = mode => pc2.applyCaster(mode);
if (!noObs) { pc1.start(); pc2.start(); } else director.addLog('Mode sans OBS (--no-obs)');

const twitch = new TwitchChat(config, director);
twitch.start();
new LlmDirector(config, director).start();

// ---- Diffusion de l'état (limitée à ~4 messages/s) ----
let stateTimer = null;
director.on('state', () => {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const st = director.getState();
    st.unknownRewards = [...twitch.unknownRewards.values()];
    broadcast(['panel', 'joueur'], { type: 'state', state: st });
  }, 250);
});
director.on('overlay', o => broadcast(['overlay'], { ...o, kind: o.type, type: 'overlay' }));
setInterval(() => {
  const st = director.getState();
  broadcast(['overlay'], { type: 'live', voteSeconds: config.twitch.voteSeconds, mode: st.mode, vote: st.vote, label: st.current.label, source: st.current.source, timedUntil: st.current.timedUntil, now: st.now });
}, 1000);

setInterval(() => director.tick(), 1000);

// ---- Commandes du panneau et des joueurs ----
function handleCommand(client, m) {
  const d = director;
  if (client.role === 'joueur') {
    if (m.cmd === 'private' && m.i === client.player) d.setPrivate(m.i, m.value);
    return;
  }
  if (client.role !== 'panel') return;
  switch (m.cmd) {
    case 'mode': d.setMode(m.mode); break;
    case 'take': d.take(m.layout); break;
    case 'lock': d.setLocked(m.value); break;
    case 'fairness': d.setFairness(m.value); break;
    case 'private': d.setPrivate(m.i, m.value); break;
    case 'caster': d.setCasterMode(m.mode); break;
    case 'calibrate': pc2.calibrate(); d.emitState(); break;
    case 'applySuggestion': d.applySuggestion(); break;
    case 'board': d.showBoard(); break;
    case 'resetScreen': d.resetScreenTime(); break;
    case 'startVote': if (d.mode === 'CHAT') d.startVote(); break;
    case 'spot': m.action === 'drop' ? d.dropSpotlight() : d.runSpotlight(); break;
    case 'testEvent': d.addEvent(m.i, m.kind); d.emitState(); break;
  }
}

// ---- HTTP ----
const PAGES = { '/': 'panel.html', '/panel': 'panel.html', '/dock': 'dock.html', '/deck': 'deck.html', '/reglages': 'reglages.html', '/joueur': 'joueur.html', '/overlay/tags': 'overlay-tags.html', '/overlay/stream': 'overlay-stream.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const RESTART_CODE = 75; // compris par src/run.js
const settingsApi = createSettingsApi({
  root: ROOT,
  home: HOME,
  running: config,
  runtime: () => ({ port: config.port, obsActive: !noObs, noObsFlag, canRestart: !!process.env.REGIE_SUPERVISED, status: director.status }),
  restart: process.env.REGIE_SUPERVISED ? () => { director.saveState(); process.exit(RESTART_CODE); } : null
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (settingsApi(req, res, url)) return;
  if (req.method === 'POST' && url.pathname === '/api/agent') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const { player, events } = JSON.parse(body);
        director.agentSeen(player);
        director.addAgentEvents(player, events || []);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  // Commandes simples en GET, pour un Stream Deck (action "Site web" / "API Ninja") :
  //   /api/cmd?cmd=mode&mode=CHAT   /api/cmd?cmd=caster&mode=FULL   /api/cmd?cmd=take&type=FULL&players=3
  //   /api/cmd?cmd=lock&value=1     /api/cmd?cmd=board
  if (url.pathname === '/api/cmd') {
    const q = Object.fromEntries(url.searchParams);
    const m = { ...q };
    if (q.cmd === 'take') m.layout = { type: (q.type || 'FULL').toUpperCase(), players: (q.players || '').split(',').filter(Boolean).map(n => Number(n) - 1) };
    if (q.mode) m.mode = q.mode.toUpperCase();
    if ('value' in q) m.value = q.value === '1' || q.value === 'true';
    if (q.i) m.i = Number(q.i) - 1;
    handleCommand({ role: 'panel' }, m);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, mode: director.mode, plan: director.getState().current.label }));
    return;
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(director.getState()));
    return;
  }
  const file = PAGES[url.pathname] || url.pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404).end('Introuvable'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(full).pipe(res);
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Le port ${config.port} est déjà utilisé par un autre programme : change "port" dans config.json.` : e);
  process.exit(1);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const client = { ws, role: url.searchParams.get('role') || 'panel', slot: url.searchParams.get('slot'), player: Number(url.searchParams.get('p')) - 1 };
  clients.add(client);
  ws.on('close', () => clients.delete(client));
  ws.on('message', raw => { try { handleCommand(client, JSON.parse(raw)); } catch { /* message invalide */ } });
  if (client.role === 'panel' || client.role === 'joueur') {
    send(ws, { type: 'config', players: config.players.map(p => p.name), hasRoom: director.hasRoom, voteSeconds: config.twitch.voteSeconds });
    send(ws, { type: 'state', state: { ...director.getState(), unknownRewards: [...twitch.unknownRewards.values()] } });
  }
  if (client.role === 'panel') {
    send(ws, { type: 'thumbs', thumbs: lastThumbs });
    if (lastCasterThumb) send(ws, { type: 'casterThumb', uri: lastCasterThumb });
    if (lastRoomThumb) send(ws, { type: 'roomThumb', uri: lastRoomThumb });
  }
  if (client.role === 'tags') {
    if (lastTags[client.slot]) send(ws, lastTags[client.slot]);
    else send(ws, { type: 'tags', slot: client.slot, tags: [], canvas: config.pc1.canvas });
  }
});

// Adresse explicite : sans elle, Node écoute en IPv6 et Windows ne signale pas un port déjà pris en IPv4
server.listen(config.port, '0.0.0.0', () => {
  console.log(`Régie prête : http://localhost:${config.port}  (panneau)`);
  console.log(`  Réglages (depuis ce PC uniquement) : http://127.0.0.1:${config.port}/reglages`);
  console.log(`  Overlays : /overlay/tags?slot=A, /overlay/tags?slot=B (PC POV), /overlay/stream (PC Stream)`);
  console.log(`  Dock OBS (PC Stream) : /dock   ·   Steam Deck : /deck   ·   Stream Deck : /api/cmd?cmd=mode&mode=CHAT`);
  console.log(`  Page joueur : /joueur?p=1 … /joueur?p=${config.players.length}`);
});

const bye = () => { director.saveState(); process.exit(0); };
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
// RegieIA.exe demande l'arrêt en fermant cette entrée (sous Windows, un signal couperait net sans sauvegarder).
// Elle se ferme aussi si l'exe disparaît : le serveur ne reste jamais orphelin.
if (process.env.REGIE_LAUNCHER) {
  process.stdin.on('end', bye);
  process.stdin.on('close', bye);
  process.stdin.resume();
}
