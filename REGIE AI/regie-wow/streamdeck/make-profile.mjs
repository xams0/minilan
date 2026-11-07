// Génère le profil Stream Deck : 8 × 5 touches « Touche Régie » identiques, chacune affiche ce que la régie prévoit à sa position.
//   node make-profile.mjs DOSSIER
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const COLS = 8, ROWS = 5;
const PROFILE = 'A7C5E2D0-1B3F-4E6A-9D21-5F8B7C3E4A10';
const PAGE = 'C2D4F6A8-3E5B-47C9-8A1D-6B9E2F4C7D31';
const DEFAULT_PAGE = 'E1B3D5F7-4A6C-48DA-9B2E-7C1F3A5D8E42';
const VERSION = JSON.parse(fs.readFileSync(new URL('./fr.lanppart.regieia.sdPlugin/manifest.json', import.meta.url), 'utf8')).Version;

const out = process.argv[2];
const root = path.join(out, `${PROFILE}.sdProfile`);
const write = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); };

// Id stable par position : recompiler le profil ne change rien pour le logiciel
const actionId = key => {
  const h = crypto.createHash('sha1').update(`regieia:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const actions = {};
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    const key = `${col},${row}`;
    actions[key] = {
      ActionID: actionId(key),
      LinkedTitle: true,
      Name: 'Touche Régie',
      Plugin: { Name: 'Régie IA', UUID: 'fr.lanppart.regieia', Version: VERSION },
      Resources: null,
      Settings: {},
      State: 0,
      States: [{ FontFamily: '', FontSize: 12, FontStyle: '', FontUnderline: false, OutlineThickness: 2, ShowTitle: false, TitleAlignment: 'bottom', TitleColor: '#ffffff' }],
      UUID: 'fr.lanppart.regieia.touche'
    };
  }
}

write(path.join(root, 'manifest.json'), {
  // Stream Deck Mobile en Wi-Fi, grille 8 × 5
  Device: { Model: 'VSD2/WiFi', UUID: '' },
  Name: 'RegieIA',
  Pages: { Current: PAGE.toLowerCase(), Default: DEFAULT_PAGE.toLowerCase(), Pages: [PAGE.toLowerCase()] },
  Version: '3.0'
});
write(path.join(root, 'Profiles', PAGE, 'manifest.json'), { Controllers: [{ Actions: actions, Type: 'Keypad' }], Icon: '', Name: '' });
write(path.join(root, 'Profiles', DEFAULT_PAGE, 'manifest.json'), { Controllers: [{ Actions: {}, Type: 'Keypad' }], Icon: '', Name: '' });
console.log(`Profil généré : ${COLS * ROWS} touches`);
