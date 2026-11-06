// Lance la régie et la relance quand la page de réglages le demande.
//   npm start            → tout démarre
//   npm start -- --no-obs → sans OBS (répétition / test du panneau)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RESTART_CODE = 75;
const serverFile = fileURLToPath(new URL('./server.js', import.meta.url));
let child;

function start() {
  child = spawn(process.execPath, [serverFile, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, REGIE_SUPERVISED: '1' }
  });
  child.on('exit', (code, signal) => {
    if (code === RESTART_CODE) { console.log('Redémarrage de la régie…'); start(); return; }
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// Le serveur reçoit le même signal et sauvegarde son état : on attend qu'il ait fini.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill());
start();
