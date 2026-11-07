// Prépare automatiquement OBS :
//  PC POV    : crée REGIE_A et REGIE_B, y ajoute les 8 POV (SRT) + les noms (browser source)
//  PC Stream : vérifie la scène LIVE (capture HDMI, cam casters, cam pièce) et ajoute l'overlay régie
//
//   npm run setup-obs -- --regie http://192.168.1.20:8080
// Les sources POV (Source média SRT) doivent déjà exister dans OBS sous les noms du config.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OBSWebSocket } from 'obs-websocket-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.REGIE_HOME ? path.resolve(process.env.REGIE_HOME) : ROOT; // voir src/server.js
const cfgPath = fs.existsSync(path.join(HOME, 'config.json')) ? path.join(HOME, 'config.json') : path.join(ROOT, 'config.example.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const i = process.argv.indexOf('--regie');
const regie = (i > 0 ? process.argv[i + 1] : `http://localhost:${cfg.port}`).replace(/\/$/, '');

async function connect(name, c) {
  const obs = new OBSWebSocket();
  try {
    await obs.connect(c.url, c.password || undefined);
    console.log(`✔ ${name} connecté (${c.url})`);
    return obs;
  } catch (e) {
    console.log(`✘ ${name} injoignable (${c.url}) : ${e.message}`);
    console.log('  → OBS > Outils > Paramètres du serveur WebSocket : activer, port 4455, mot de passe dans config.json');
    return null;
  }
}

async function inputNames(obs) {
  const { inputs } = await obs.call('GetInputList');
  return new Set(inputs.map(x => x.inputName));
}

async function setupPc1() {
  const obs = await connect('PC POV', cfg.pc1);
  if (!obs) return;
  const [W, H] = cfg.pc1.canvas;
  const { scenes } = await obs.call('GetSceneList');
  const existing = new Set(scenes.map(s => s.sceneName));
  const inputs = await inputNames(obs);
  const sources = cfg.players.map(p => p.source);
  const missing = sources.filter(s => !inputs.has(s));
  if (missing.length) {
    console.log(`⚠ Sources introuvables sur le PC POV : ${missing.join(', ')}`);
    console.log(`  Sources existantes : ${[...inputs].join(', ')}`);
    console.log('  Crée-les (Source média, entrée srt://…) ou corrige les noms dans config.json, puis relance.');
  }
  // SRT en Source média : on garde les flux ouverts même quand ils ne sont pas à l'image,
  // sinon chaque passage à l'antenne relance la connexion (écran noir de 1-2 s).
  const { inputs: all } = await obs.call('GetInputList');
  for (const inp of all.filter(x => sources.includes(x.inputName) && x.inputKind === 'ffmpeg_source')) {
    await obs.call('SetInputSettings', { inputName: inp.inputName, inputSettings: { close_when_inactive: false, restart_on_activate: false } });
    console.log(`  ✔ ${inp.inputName} : flux SRT gardé ouvert hors antenne`);
  }

  for (const [k, scene] of cfg.pc1.scenes.entries()) {
    const slot = k === 0 ? 'A' : 'B';
    if (!existing.has(scene)) { await obs.call('CreateScene', { sceneName: scene }); console.log(`  + scène ${scene}`); }
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
    const inScene = new Set(sceneItems.map(s => s.sourceName));
    for (const s of sources) {
      if (!inputs.has(s) || inScene.has(s)) continue;
      await obs.call('CreateSceneItem', { sceneName: scene, sourceName: s, sceneItemEnabled: false });
      console.log(`  + ${s} → ${scene}`);
    }
    const tagName = `${cfg.pc1.tagsSource}_${slot}`;
    const url = `${regie}/overlay/tags?slot=${slot}`;
    if (!inputs.has(tagName)) {
      await obs.call('CreateInput', { sceneName: scene, inputName: tagName, inputKind: 'browser_source', inputSettings: { url, width: W, height: H, reroute_audio: true } });
      console.log(`  + noms des joueurs (${tagName}) → ${url}`);
    } else {
      await obs.call('SetInputSettings', { inputName: tagName, inputSettings: { url, width: W, height: H } });
      if (!inScene.has(tagName)) await obs.call('CreateSceneItem', { sceneName: scene, sourceName: tagName });
    }
    // Les noms toujours au premier plan
    const { sceneItems: items } = await obs.call('GetSceneItemList', { sceneName: scene });
    const tag = items.find(x => x.sourceName === tagName);
    if (tag) await obs.call('SetSceneItemIndex', { sceneName: scene, sceneItemId: tag.sceneItemId, sceneItemIndex: items.length - 1 });
  }
  console.log('  Astuce : ajoute un fond (image) tout en bas de REGIE_A et REGIE_B pour les splits et la mosaïque.');
  console.log('  Astuce : choisis la transition (Fondu 300 ms ou Stinger) dans OBS : elle sert à chaque changement de plan.');
  console.log('  Sortie HDMI : clic droit sur l\'aperçu > Projecteur plein écran (Programme) sur la sortie de la carte reliée au PC Stream.');
  obs.disconnect();
}

async function setupPc2() {
  const obs = await connect('PC Stream', cfg.pc2);
  if (!obs) return;
  const c = cfg.pc2;
  const { scenes } = await obs.call('GetSceneList');
  if (!scenes.some(s => s.sceneName === c.scene)) {
    console.log(`⚠ Scène "${c.scene}" absente sur le PC Stream : corrige pc2.scene dans config.json`);
    obs.disconnect();
    return;
  }
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: c.scene });
  const inScene = new Set(sceneItems.map(s => s.sourceName));
  const inputs = await inputNames(obs);
  for (const s of [c.gameSource, c.casterCam, c.roomCam].filter(Boolean)) {
    if (inScene.has(s)) console.log(`  ✔ ${s}`);
    else if (inputs.has(s)) {
      await obs.call('CreateSceneItem', { sceneName: c.scene, sourceName: s, sceneItemEnabled: s === c.gameSource });
      console.log(`  + ${s} ajouté à la scène ${c.scene}`);
    } else console.log(`  ⚠ source introuvable : ${s}`);
  }
  for (const m of c.casterMics || []) if (!inputs.has(m)) console.log(`  ⚠ micro caster introuvable : ${m}`);
  const name = 'REGIE_OVERLAY';
  const url = `${regie}/overlay/stream`;
  const [W, H] = c.canvas;
  if (!inputs.has(name)) {
    await obs.call('CreateInput', { sceneName: c.scene, inputName: name, inputKind: 'browser_source', inputSettings: { url, width: W, height: H } });
    console.log(`  + overlay régie (${name}) → ${url}`);
  } else {
    await obs.call('SetInputSettings', { inputName: name, inputSettings: { url, width: W, height: H } });
    if (!inScene.has(name)) await obs.call('CreateSceneItem', { sceneName: c.scene, sourceName: name });
  }
  console.log(`  Dock de pilotage : OBS > Docks > Docks de navigateur personnalisés > URL ${regie}/dock`);
  obs.disconnect();
}

console.log(`Régie : ${regie}  (config : ${path.basename(cfgPath)})`);
await setupPc1();
await setupPc2();
console.log('Terminé.');
