#!/usr/bin/env node
// Agent joueur (aucune dépendance, Node 20+) : lit le combat log de WoW en direct
// et envoie les événements du joueur au directeur de régie.
//
//   node agent.mjs --server http://192.168.1.20:8080 --player 3
//   node agent.mjs --server http://192.168.1.20:8080 --player 3 --logs "D:\Jeux\World of Warcraft\_forever_\Logs"
//   node agent.mjs --test "WoWCombatLog-110526_201512.txt"     (analyse un fichier et affiche les comptes)
//
// Dans le jeu : tape /combatlog à chaque session (le fichier n'est écrit que si c'est activé).
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return acc;
}, []));

const MINE = f => (f & 0xF) === 0x1;
const IS_PLAYER = f => (f & 0x400) !== 0;
const IS_PET = f => (f & 0x3000) !== 0;
const me = f => MINE(f) && (IS_PLAYER(f) || IS_PET(f));
const meExact = f => MINE(f) && IS_PLAYER(f);

/** Découpe une ligne CSV du combat log (les noms sont entre guillemets) */
function splitCsv(s) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') q = !q;
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Surplus de dégâts d'un coup : positif si ce coup a tué sa cible. Les lignes de sorts ont un champ de plus en fin de ligne. */
const overkill = (ev, f) => Number(f[f.length - (/^(SPELL|RANGE)_/.test(ev) ? 9 : 8)]) || 0;

// WoW écrit le log à la fin du combat. Une mort finit le combat : le coup mortel est écrit aussitôt,
// mais le UNIT_DIED qui le suit de 2 ms n'arrive qu'à l'écriture suivante, plusieurs minutes après (mesuré : 198 s).
// La mort part donc sur le coup mortel, et ce UNIT_DIED est reconnu à son heure pour ne pas la compter deux fois.
const SAME_DEATH_MS = 5000;
let lastFatalAt = null;

/** Transforme une ligne en type d'événement pour la régie (ou null) */
export function classify(line) {
  const sep = line.indexOf('  ');
  if (sep < 0) return null;
  const f = splitCsv(line.slice(sep + 2).trim());
  const ev = f[0];
  if (ev === 'ENCOUNTER_START') return 'boss_start';
  if (ev === 'ENCOUNTER_END') return f[5] === '1' ? 'boss_kill' : 'boss_wipe';
  const src = parseInt(f[3], 16) || 0, dst = parseInt(f[7], 16) || 0;
  if (ev.endsWith('_DAMAGE') && meExact(dst) && overkill(ev, f) > 0) {
    lastFatalAt = Date.parse(line.slice(0, sep));
    return 'death';
  }
  if (ev === 'UNIT_DIED' && meExact(dst)) return Math.abs(Date.parse(line.slice(0, sep)) - lastFatalAt) < SAME_DEATH_MS ? null : 'death';
  if (ev === 'PARTY_KILL' && me(src)) return 'kill';
  if (ev === 'SPELL_INTERRUPT' && me(src)) return 'interrupt';
  if (ev === 'SPELL_RESURRECT' && (me(src) || meExact(dst))) return 'res';
  if (ev.endsWith('_DAMAGE') || ev.endsWith('_MISSED')) {
    if (me(src)) return 'dmg_out';
    if (meExact(dst)) return 'dmg_in';
    return null;
  }
  if ((ev === 'SPELL_HEAL' || ev === 'SPELL_PERIODIC_HEAL') && me(src)) return 'heal';
  if (ev === 'SPELL_CAST_SUCCESS' && me(src)) return 'cast';
  return null;
}

// ---- Mode test : analyse d'un fichier existant ----
if (args.test) {
  const counts = {};
  for (const line of fs.readFileSync(args.test, 'utf8').split(/\r?\n/)) {
    const k = classify(line);
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  console.log(counts);
  process.exit(0);
}

const server = (args.server || '').replace(/\/$/, '');
const player = parseInt(args.player, 10) - 1;
if (!server || !(player >= 0)) {
  console.error('Usage : node agent.mjs --server http://IP_REGIE:8080 --player <1-8> [--logs "dossier Logs de WoW"]');
  process.exit(1);
}

function candidateLogDirs() {
  if (args.logs) return [args.logs];
  const roots = ['C:\\Program Files (x86)\\World of Warcraft', 'C:\\Program Files\\World of Warcraft', 'D:\\World of Warcraft', 'D:\\Jeux\\World of Warcraft'];
  const dirs = [];
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r)) if (d.startsWith('_')) dirs.push(path.join(r, d, 'Logs'));
    } catch { /* dossier absent */ }
  }
  return dirs;
}

/**
 * Date écrite dans le nom : WoWCombatLog-110726_080848.txt = 7 novembre 2026 à 08:08:48, heure locale (MMJJAA_HHMMSS).
 * Elle est décodée car un tri alphabétique placerait 123126 après 010127.
 * Même logique que GameFinder.cs : toute évolution doit être faite des deux côtés.
 */
function dateInName(name) {
  const m = /^WoWCombatLog-(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.txt$/i.exec(name);
  if (!m) return null;
  const [mo, d, y, h, mi, s] = m.slice(1).map(Number);
  const t = new Date(2000 + y, mo - 1, d, h, mi, s);
  return t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : null;
}

function newestLog() {
  let best = null;
  for (const dir of candidateLogDirs()) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/^WoWCombatLog.*\.txt$/i.test(f)) continue;
        const p = path.join(dir, f), st = fs.statSync(p);
        // Le nom fait foi : ré-enregistrer un ancien log change sa date d'écriture, pas son nom
        const time = dateInName(f) ?? Math.max(st.mtimeMs, st.birthtimeMs);
        if (!best || time > best.time) best = { p, time };
      }
    } catch { /* dossier absent */ }
  }
  return best?.p || null;
}

const startedAt = Date.now();
let file = null, pos = 0, rest = '';
const pending = {};
let lastSend = 0;

function poll() {
  const latest = newestLog();
  if (latest && latest !== file) {
    try { readNew(); } catch { /* ancien log disparu */ } // sa fin, écrite depuis le dernier tour
    const st = fs.statSync(latest);
    file = latest;
    // Log déjà là au lancement : on part de la fin pour ne pas rejouer le passé.
    // Log créé depuis (nouveau /combatlog) : tout son contenu est récent.
    pos = st.birthtimeMs >= startedAt ? 0 : st.size;
    rest = '';
    console.log(`Lecture de ${file}`);
  }
  readNew();
}

function readNew() {
  if (!file) return;
  let st;
  try { st = fs.statSync(file); } catch { file = null; return; }
  if (st.size < pos) pos = 0;
  if (st.size === pos) return;
  const fd = fs.openSync(file, 'r');
  const len = Math.min(st.size - pos, 4 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, pos);
  fs.closeSync(fd);
  pos += len;
  const lines = (rest + buf.toString('utf8')).split(/\r?\n/);
  rest = lines.pop();
  for (const l of lines) {
    const k = classify(l);
    if (!k) continue;
    const key = `${k}|${lineAge(l)}`;
    pending[key] = (pending[key] || 0) + 1;
  }
}

/** Ancienneté de la ligne en secondes, pour que la régie écarte ce que WoW écrit en retard. Bornée pour limiter la taille des envois. */
function lineAge(line) {
  const age = Math.round((Date.now() - Date.parse(line.slice(0, line.indexOf('  ')))) / 1000);
  return Math.min(60, Math.max(0, age || 0));
}

async function send() {
  const events = Object.entries(pending).map(([key, n]) => { const [kind, age] = key.split('|'); return { kind, n, age: Number(age) }; });
  if (!events.length && Date.now() - lastSend < 5000) return;
  for (const k of Object.keys(pending)) delete pending[k];
  lastSend = Date.now();
  try {
    await fetch(`${server}/api/agent`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ player, events }), signal: AbortSignal.timeout(3000)
    });
  } catch (e) {
    console.log(`Régie injoignable (${e.message}), on continue…`);
  }
}

console.log(`Agent joueur ${player + 1} → ${server}`);
if (!newestLog()) console.log('⚠️ Aucun WoWCombatLog*.txt trouvé : tape /combatlog en jeu, ou passe --logs "<dossier Logs>"');
setInterval(() => { try { poll(); } catch (e) { console.log(e.message); } }, 400);
setInterval(send, 500);
