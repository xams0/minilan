// Simule 10 h de live sans OBS pour vérifier le comportement de la régie Auto :
// répartition du temps d'écran, nombre de changements de plan, types de plans.
//   npm run simu            (10 h, équité 0.6)
//   npm run simu -- 4 0     (4 h, équité 0 = action pure)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Director } from '../src/director.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
cfg.schedule = [];
const hours = Number(process.argv[2] || 10);
const fairness = process.argv[3] !== undefined ? Number(process.argv[3]) : cfg.director.fairness;

let clock = Date.UTC(2026, 10, 5, 18, 0, 0);
const d = new Director(cfg, { now: () => clock });
d.setFairness(fairness);
let switches = 0;
const types = {};
d.output.applyLayout = l => { switches++; types[l.type] = (types[l.type] || 0) + 1; };
d.output.applyCaster = () => {};

// Profils : certains joueurs sont beaucoup plus "spectaculaires" que d'autres
const activity = [1.8, 1.4, 1.2, 1.0, 0.9, 0.7, 0.5, 0.3];
const rnd = Math.random;
let bossUntil = 0;

for (let s = 0; s < hours * 3600; s++) {
  clock += 1000;
  if (rnd() < 1 / 900) bossUntil = clock + 4 * 60000; // un boss de groupe toutes les ~15 min
  const boss = clock < bossUntil;
  if (boss && clock - (bossUntil - 4 * 60000) < 1000) for (let i = 0; i < 5; i++) d.addEvent(i, 'boss_start');
  d.players.forEach((p, i) => {
    d.setMotion(i, rnd() < 0.97 ? 0.05 : 0.0);
    const a = activity[i] * (boss && i < 5 ? 3 : 1);
    if (rnd() < 0.25 * a) d.addEvent(i, 'dmg_out', { mult: 2 });
    if (rnd() < 0.12 * a) d.addEvent(i, 'dmg_in', { mult: 2 });
    if (rnd() < 0.01 * a) d.addEvent(i, 'kill');
    if (rnd() < 0.0008 * a) d.addEvent(i, 'death');
  });
  // Les casters passent de temps en temps devant la caméra
  d.setCasterPresent(Math.floor(s / 1800) % 3 === 1);
  if (rnd() < 0.3) d.setCasterSpeaking(true);
  d.tick();
}

const total = d.players.reduce((a, p) => a + p.screenTime, 0);
console.log(`Simulation ${hours} h · équité ${fairness} · ${switches} changements de plan (${(switches / hours).toFixed(0)}/h)`);
console.log('Plans :', types);
console.log('Temps d\'écran (pondéré) par joueur :');
for (const p of d.players) {
  const pct = (p.screenTime / total) * 100;
  console.log(`  ${p.name.padEnd(9)} activité ${String(activity[p.i]).padEnd(4)} ${String(Math.round(p.screenTime / 60)).padStart(4)} min  ${pct.toFixed(1).padStart(5)} %  ${'█'.repeat(Math.round(pct))}`);
}
const vals = d.players.map(p => p.screenTime / 60);
console.log(`Écart max-min : ${(Math.max(...vals) - Math.min(...vals)).toFixed(1)} min (objectif ${(total / 60 / d.N).toFixed(0)} min chacun)`);
