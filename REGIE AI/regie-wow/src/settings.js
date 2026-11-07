// API de la page de réglages (/reglages) : lit et écrit config.json.
// config.json contient des mots de passe alors que le serveur écoute sur tout le réseau :
// ces routes ne répondent qu'aux requêtes locales (127.0.0.1 / localhost).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { OBSWebSocket } from 'obs-websocket-js';
import { MAX_PLAYERS } from './layouts.js';

const LOCAL_ADDR = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hostname = h => (h || '').replace(/:\d+$/, '').toLowerCase();

const isLocal = req => LOCAL_ADDR.has(req.socket.remoteAddress) && LOCAL_HOST.has(hostname(req.headers.host));

/** Bloque les requêtes envoyées par un autre site ouvert dans le navigateur */
function sameOrigin(req) {
  if (!(req.headers['content-type'] || '').includes('application/json')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const json = (res, code, obj) => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));

const readBody = req => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 1e6) { reject(new Error('Requête trop volumineuse')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('JSON invalide')); } });
  req.on('error', reject);
});

/** Forme canonique (clés triées) pour comparer deux configs */
const stable = v => {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]));
  return v;
};
const sameConfig = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** Complète une config avec les valeurs de l'exemple (nouveaux champs absents d'un ancien fichier) */
export function withDefaults(cfg, example) {
  const out = { ...example, ...cfg };
  for (const k of Object.keys(example)) {
    const m = example[k];
    if (m && typeof m === 'object' && !Array.isArray(m) && cfg[k] && typeof cfg[k] === 'object') out[k] = { ...m, ...cfg[k] };
  }
  if (cfg.twitch?.rewards) out.twitch.rewards = cfg.twitch.rewards;
  return out;
}

const NULLABLE = new Set(['pc2.roomCam']); // renseignés dans l'exemple, mais optionnels

/** Vérifie que chaque valeur a le même type que dans config.example.json */
function checkTypes(value, model, at, err) {
  if (NULLABLE.has(at) && value === null) return;
  if (model === null) { if (value !== null && typeof value !== 'string') err(at, 'doit être un texte ou vide'); return; }
  if (typeof model === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) err(at, 'doit être un nombre'); return; }
  if (typeof model === 'string') { if (typeof value !== 'string') err(at, 'doit être un texte'); return; }
  if (typeof model === 'boolean') { if (typeof value !== 'boolean') err(at, 'doit être oui ou non'); return; }
  if (Array.isArray(model)) {
    if (!Array.isArray(value)) { err(at, 'doit être une liste'); return; }
    if (model.length) value.forEach((v, i) => checkTypes(v, model[0], `${at}.${i}`, err));
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { err(at, 'section invalide'); return; }
  for (const k of Object.keys(model)) {
    if (k.startsWith('_')) continue;
    checkTypes(value[k], model[k], at ? `${at}.${k}` : k, err);
  }
}

const POSITIVE = [
  'pc1.screenshotEverySec', 'pc2.tweenMs',
  'director.evalEverySec', 'director.minHoldSec', 'director.urgentMinHoldSec', 'director.maxHoldSec',
  'director.hotThreshold', 'director.calmThreshold', 'director.debtScaleSec', 'director.afkAfterSec',
  'director.mosaicDurationSec', 'director.roomDurationSec', 'director.spotlightSec',
  'twitch.voteSeconds', 'llm.everySec'
];
const NOT_NEGATIVE = [
  'pc2.syncDelayMs', 'director.mosaicEveryMin', 'director.roomEveryMin', 'director.screenTimeBoardEveryMin',
  'casters.fullAfterTalkSec', 'casters.minHoldSec'
];
const get = (o, p) => p.split('.').reduce((v, k) => v?.[k], o);

export function validate(cfg, example) {
  const errors = [];
  const err = (p, msg) => errors.push({ path: p, msg });
  checkTypes(cfg, example, '', err);
  if (errors.length) return errors;

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) err('port', 'doit être entre 1 et 65535');
  for (const pc of ['pc1', 'pc2']) {
    if (!/^wss?:\/\/\S+$/.test(cfg[pc].url)) err(`${pc}.url`, 'doit ressembler à ws://192.168.1.10:4455');
    cfg[pc].canvas.forEach((v, i) => { if (!(v > 0)) err(`${pc}.canvas.${i}`, 'doit être supérieur à 0'); });
    if (cfg[pc].canvas.length !== 2) err(`${pc}.canvas`, 'il faut une largeur et une hauteur');
  }
  const [a, b] = cfg.pc1.scenes;
  if (cfg.pc1.scenes.length !== 2) err('pc1.scenes', 'il faut exactement deux scènes');
  if (!a?.trim()) err('pc1.scenes.0', 'nom obligatoire');
  if (!b?.trim()) err('pc1.scenes.1', 'nom obligatoire');
  if (a && a === b) err('pc1.scenes.1', 'doit être différente de la scène A');
  if (!cfg.pc1.tagsSource.trim()) err('pc1.tagsSource', 'nom obligatoire');
  if (!['bottom-left', 'bottom-right', 'top-left', 'top-right'].includes(cfg.pc1.pipCorner)) err('pc1.pipCorner', 'coin inconnu');

  for (const k of ['scene', 'gameSource', 'casterCam']) if (!cfg.pc2[k].trim()) err(`pc2.${k}`, 'nom obligatoire');
  for (const mode of ['OFF', 'PIP', 'SPLIT', 'FULL']) {
    const l = cfg.pc2.layouts[mode];
    if (l?.game?.length !== 4) err(`pc2.layouts.${mode}.game`, 'il faut X, Y, largeur et hauteur');
    if (mode !== 'OFF' && l?.cam?.length !== 4) err(`pc2.layouts.${mode}.cam`, 'il faut X, Y, largeur et hauteur');
  }

  if (cfg.players.length < 1 || cfg.players.length > MAX_PLAYERS) err('players', `il faut entre 1 et ${MAX_PLAYERS} joueurs`);
  const seen = new Set();
  cfg.players.forEach((p, i) => {
    if (!p.name.trim()) err(`players.${i}.name`, 'pseudo obligatoire');
    if (!p.source.trim()) err(`players.${i}.source`, 'source obligatoire');
    if (seen.has(p.source)) err(`players.${i}.source`, 'déjà utilisée par un autre joueur');
    seen.add(p.source);
  });

  for (const p of POSITIVE) if (!(get(cfg, p) > 0)) err(p, 'doit être supérieur à 0');
  for (const p of NOT_NEGATIVE) if (get(cfg, p) < 0) err(p, 'ne peut pas être négatif');
  if (cfg.director.fairness < 0 || cfg.director.fairness > 1) err('director.fairness', 'doit être entre 0 et 1');
  if (cfg.pc2.presenceThreshold < 0 || cfg.pc2.presenceThreshold > 1) err('pc2.presenceThreshold', 'doit être entre 0 et 1');

  if (!cfg.twitch.rewards || typeof cfg.twitch.rewards !== 'object' || Array.isArray(cfg.twitch.rewards)) err('twitch.rewards', 'section invalide');
  else for (const [id, action] of Object.entries(cfg.twitch.rewards)) {
    if (!['spotlight', 'split', 'mosaic'].includes(action)) err('twitch.rewards', `action inconnue pour ${id}`);
  }
  cfg.schedule.forEach((s, i) => {
    if (!(s.minute >= 0 && s.minute <= 59)) err(`schedule.${i}.minute`, 'doit être entre 0 et 59');
    if (!(s.durationMin > 0)) err(`schedule.${i}.durationMin`, 'doit être supérieur à 0');
    if (!['AUTO', 'CHAT', 'MANUEL'].includes(s.mode)) err(`schedule.${i}.mode`, 'mode inconnu');
  });
  return errors;
}

const portFree = port => new Promise(resolve => {
  const t = net.createServer();
  t.once('error', () => resolve(false));
  t.once('listening', () => t.close(() => resolve(true)));
  t.listen(port, '0.0.0.0'); // même adresse que le serveur : sans elle, Windows ne signale pas le conflit
});

/** Écrit le fichier en une seule opération, après avoir gardé la version précédente */
function writeConfig(file, cfg) {
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** Connexion courte à OBS, en lecture seule, pour vérifier l'adresse et lister scènes et sources */
export async function testObs(url, password) {
  if (typeof url !== 'string' || !/^wss?:\/\/\S+$/.test(url)) return { ok: false, error: 'Adresse invalide : elle doit ressembler à ws://192.168.1.10:4455' };
  const obs = new OBSWebSocket();
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 4000); });
    await Promise.race([obs.connect(url, password || undefined, { eventSubscriptions: 0 }), timeout]);
    const [version, sceneList, inputList] = await Promise.race([
      Promise.all([obs.call('GetVersion'), obs.call('GetSceneList'), obs.call('GetInputList')]),
      timeout
    ]);
    return {
      ok: true,
      version: version.obsVersion,
      program: sceneList.currentProgramSceneName,
      scenes: sceneList.scenes.map(s => s.sceneName).reverse(),
      inputs: inputList.inputs.map(i => i.inputName)
    };
  } catch (e) {
    if (e.code === 4009) return { ok: false, error: password ? 'Mot de passe incorrect' : 'OBS demande un mot de passe' };
    if (e.message === 'timeout') return { ok: false, error: 'Pas de réponse d\'OBS au bout de 4 s : vérifie l\'adresse et le pare-feu' };
    return { ok: false, error: `OBS injoignable : ${e.message || 'connexion refusée'}. Le serveur WebSocket est-il activé ?` };
  } finally {
    clearTimeout(timer);
    try { await obs.disconnect(); } catch { /* déjà fermé */ }
  }
}

/**
 * Renvoie un gestionnaire de routes.
 * @param root     dossier du projet (où se trouve config.example.json)
 * @param home     dossier de config.json : celui du projet, ou celui de RegieIA.exe
 * @param running  config chargée au démarrage (pour savoir si un redémarrage est nécessaire)
 * @param runtime  () => état du processus affiché dans la page
 * @param restart  () => redémarre, ou null si la régie n'a pas été lancée par `npm start`
 */
export function createSettingsApi({ root, home = root, running, runtime, restart }) {
  const file = path.join(home, 'config.json');
  const exampleFile = path.join(root, 'config.example.json');
  const readExample = () => JSON.parse(fs.readFileSync(exampleFile, 'utf8'));
  const readDisk = example => withDefaults(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : example, example);

  const routes = {
    'GET /api/config': async (req, res) => {
      const example = readExample();
      const cfg = readDisk(example);
      json(res, 200, { config: cfg, needsRestart: !sameConfig(cfg, withDefaults(running, example)), runtime: runtime() });
    },
    'POST /api/config': async (req, res) => {
      const cfg = await readBody(req);
      const example = readExample();
      const errors = validate(cfg, example);
      if (!errors.length && cfg.port !== running.port && !(await portFree(cfg.port))) errors.push({ path: 'port', msg: 'déjà utilisé par un autre programme' });
      if (errors.length) return json(res, 422, { ok: false, errors });
      writeConfig(file, cfg);
      json(res, 200, { ok: true, needsRestart: !sameConfig(cfg, withDefaults(running, example)) });
    },
    'POST /api/obs-test': async (req, res) => {
      const { url, password } = await readBody(req);
      json(res, 200, await testObs(url, password));
    },
    'POST /api/restart': async (req, res) => {
      if (!restart) return json(res, 409, { ok: false, error: 'Redémarrage impossible depuis cette page : relance la régie avec npm start.' });
      json(res, 200, { ok: true, port: readDisk(readExample()).port });
      setTimeout(restart, 150);
    }
  };

  return (req, res, url) => {
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) return false;
    if (!isLocal(req)) { json(res, 403, { ok: false, error: 'Réglages accessibles uniquement depuis ce PC, sur http://127.0.0.1' }); return true; }
    if (req.method === 'POST' && !sameOrigin(req)) { json(res, 403, { ok: false, error: 'Requête refusée' }); return true; }
    route(req, res).catch(e => { if (!res.headersSent) json(res, 400, { ok: false, error: e.message }); });
    return true;
  };
}
