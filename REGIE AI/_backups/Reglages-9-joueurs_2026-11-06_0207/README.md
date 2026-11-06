# Régie WoW Forever — 8 POV, Auto IA / Chat / Manuel

Une petite appli Node.js qui réalise ton live à ta place, ou avec toi :

- **AUTO IA** : choisit le plan (plein écran, split, PIP, quad, mosaïque, caméra pièce) d'après ce qui se passe en jeu, avec une **équité du temps d'écran** entre les 8 joueurs.
- **CHAT** : le chat vote `!pov 3` ou `!pov pseudo`, et les points de chaîne servent de « coup de projecteur ».
- **MANUEL** : panneau sur tablette avec les 8 vignettes en direct. L'IA y affiche ses suggestions, que tu valides d'un tap.
- **Casters** : PIP, split ou plein écran automatique selon qu'ils sont **devant la caméra** et qu'ils **parlent**.

Simulation sur 10 h (`npm run simu`) : avec une équité à 60 %, l'écart entre le joueur le plus vu et le moins vu est d'environ **3 à 4 minutes**. C'est vrai même quand un joueur est 6 fois plus « spectaculaire » qu'un autre. Avec l'équité à 0 %, le joueur le plus actif prend 41 % de l'antenne.

---

## Comment ça s'insère dans ton setup

```
 8 PC joueurs ──SRT──▶ PC POV (OBS) ──HDMI──▶ PC Stream (OBS) ──▶ Twitch
   │ agent.mjs           ▲ scènes REGIE_A/B       ▲ scène LIVE : capture HDMI, cam casters,
   │ (combat log)        │ 8 POV + noms           │ cam pièce, overlay régie, dock de pilotage
   └──────────────▶  RÉGIE (ce programme, idéalement sur le PC Stream) ◀── tablette / Stream Deck
                                                          ◀── chat Twitch, IA (optionnelle)
```

- **PC POV** : uniquement les 8 POV reçues en SRT. La régie compose le plan dans deux scènes, `REGIE_A` et `REGIE_B` (plein écran, split, PIP, quad, mosaïque). Elle prépare la scène cachée, puis bascule dessus, ce qui déclenche ta transition OBS (fondu ou stinger). La sortie HDMI est un **projecteur plein écran (Programme)**.
- **PC Stream** : la régie ne touche qu'à **trois éléments** de ta scène `LIVE`, avec une petite animation : la capture HDMI, la cam casters et la cam pièce. Tes overlays, tes micros et le reste ne sont pas modifiés.
  - **Plan « Pièce »** : la cam pièce prend la place du jeu. Le PC POV garde son plan en dessous, rien n'y bouge.
  - **Mosaïque** : le PC POV affiche les 8 POV en 3×3 avec la case centrale vide, et le PC Stream y pose la cam pièce. Le décalage `pc2.syncDelayMs` (350 ms par défaut) attend que la transition du PC POV soit passée par le HDMI. Ajuste-le si la cam arrive trop tôt ou trop tard.

## Installation (≈ 20 min)

1. Installe **Node.js 20 ou plus** sur le PC qui fera tourner la régie. Le **PC Stream** est le bon choix : c'est là que tu auras le dock. C'est très léger.
2. Dézippe le dossier, puis dans un terminal : `npm install`.
3. Copie `config.example.json` en **`config.json`** et remplis :
   - `players` : pseudo affiché, nom exact de la source POV dans OBS (et `mic` si les micros des joueurs arrivent dans l'OBS du PC POV).
   - `pc1` / `pc2` : IP et mot de passe obs-websocket. Dans OBS : *Outils > Paramètres du serveur WebSocket*, à activer sur les deux PC.
   - `pc2.scene`, `gameSource`, `casterCam`, `roomCam`, `casterMics` : les noms exacts dans l'OBS du PC Stream (mets `roomCam: null` si tu n'as pas de cam pièce).
4. Lance `npm run setup-obs -- --regie http://IP_DE_LA_REGIE:8080`. Le script :
   - crée `REGIE_A` et `REGIE_B` sur le PC POV et y ajoute les 8 POV et les noms des joueurs ;
   - règle les sources SRT pour qu'elles **restent ouvertes hors antenne**. Sinon chaque passage à l'image relance la connexion et donne 1 à 2 s de noir ;
   - ajoute la cam casters, la cam pièce et l'overlay régie (`REGIE_OVERLAY`) dans ta scène LIVE si elles n'y sont pas.
5. Sur le PC POV :
   - ajoute un fond (image) tout en bas des deux scènes REGIE ;
   - choisis ta transition ;
   - lance le projecteur plein écran (Programme) vers la sortie HDMI.
6. Lance `npm start`.
7. **Interface sur le PC Stream** : dans OBS, *Docks > Docks de navigateur personnalisés*, ajoute `http://localhost:8080/dock`. Tu as alors un panneau compact dans OBS : modes AUTO / CHAT / MANUEL, verrou, plan en cours, 8 boutons joueurs, split/PIP/quad, casters, vote en cours. Quand le dock est actif au clavier : `1`-`8` plein écran, `A`/`C`/`M` pour les modes, `L` pour le verrou.
8. Le **panneau complet** (avec les vignettes en direct) est sur `http://IP_DE_LA_REGIE:8080`, pour une tablette ou un 2e écran.

### Page de réglages

Tout `config.json` se modifie sur **`http://127.0.0.1:PORT/reglages`** (bouton ⚙ du panneau) : adresses et mots de passe WebSocket, noms des scènes et des sources, joueurs, réalisation, casters, Twitch, Claude, planning.

- **Tester la connexion** lit les scènes et les sources de l'OBS sans rien y modifier, les propose dans les champs et signale les noms introuvables.
- **Enregistrer** écrit `config.json` et garde la version précédente dans `config.json.bak`. Ensuite, **Redémarrer la régie** applique les réglages : le temps d'écran est conservé tant que les pseudos ne changent pas. Ce bouton demande une régie lancée avec `npm start`.
- **Piloter OBS** autorise la régie à changer les scènes à l'antenne. `npm start -- --no-obs` le coupe quel que soit ce réglage.
- La page ne fonctionne que depuis le PC de la régie : `config.json` contient des mots de passe, en clair, et le reste du serveur est visible sur le réseau.

### Nombre de joueurs

La régie gère de 1 à 9 joueurs. À 9, la mosaïque remplit toute la grille 3×3 : le 9e joueur prend la case centrale et la caméra pièce n'y apparaît plus. Elle garde son plan plein écran.

### Sources SRT

- Sur le PC POV, chaque POV est une **Source média** avec l'entrée `srt://…` et « Fichier local » décoché.
- Mets la **même latence SRT** sur les 8 flux (par exemple `?latency=200000`, en microsecondes), sinon les POV seront décalées entre elles dans les splits et la mosaïque.
- Le script de setup décoche « Fermer le fichier quand inactif » et « Redémarrer à l'activation ». Vérifie que c'est bien fait si tu crées des sources après coup.

### Stream Deck

Avec l'action « Site web » (en arrière-plan) ou le plugin API Ninja, appelle une de ces adresses :

| Action | Adresse |
|---|---|
| Mode | `http://IP:8080/api/cmd?cmd=mode&mode=AUTO` (ou `CHAT`, `MANUEL`) |
| Plein écran joueur 3 | `http://IP:8080/api/cmd?cmd=take&type=FULL&players=3` |
| Split 2 et 5 | `http://IP:8080/api/cmd?cmd=take&type=SPLIT&players=2,5` |
| Mosaïque / Pièce | `http://IP:8080/api/cmd?cmd=take&type=MOSAIC` / `type=ROOM` |
| Casters | `http://IP:8080/api/cmd?cmd=caster&mode=FULL` (ou `AUTO`, `OFF`, `PIP`, `SPLIT`) |
| Verrou | `http://IP:8080/api/cmd?cmd=lock&value=1` (ou `0`) |
| Classement à l'écran | `http://IP:8080/api/cmd?cmd=board` |

### Sur chaque PC joueur (combat log)

1. Copie `agent/agent.mjs` (un seul fichier, aucune installation à part Node) puis lance :
   ```
   node agent.mjs --server http://IP_DE_LA_REGIE:8080 --player 3
   ```
   Si le dossier n'est pas trouvé tout seul, ajoute `--logs "C:\...\World of Warcraft\_forever_\Logs"`. Vérifie le nom exact du dossier du jeu.
2. **En jeu, tape `/combatlog` à chaque session**, sinon rien n'est écrit.
3. WoW écrit le fichier par paquets, donc compte 1 à 3 s de délai. C'est pour ça qu'une mort reste à l'écran au moins 7 s.

Sans agent, la régie marche quand même. Elle se base alors sur le mouvement à l'image des POV (pour repérer les AFK et les chargements), les micros et l'équité. Elle est juste moins « intelligente » sur l'action.

### Page joueur : bouton « privé »

Chaque joueur ouvre **`http://IP_DE_LA_REGIE:8080/joueur?p=3`** sur son téléphone. Un gros bouton retire sa POV de l'antenne (pour Discord, le téléphone, une pause). Ça s'applique tout de suite, **même en mode manuel**.

## Les modes en détail

### AUTO IA

Chaque POV reçoit un **score d'intérêt** qui décroît de moitié toutes les 8 s. Il monte avec ces événements, du plus fort au plus faible :

1. Pull de boss
2. Mort
3. Boss tombé
4. Wipe
5. Kill
6. Dégâts subis
7. Dégâts infligés
8. Cris au micro

La **priorité** d'un joueur se calcule ainsi :

> intérêt + équité × retard de temps d'écran

Elle sert à choisir le plan :

| Situation | Plan |
|---|---|
| ≥ 4 joueurs en action ou pull de boss à plusieurs | QUAD |
| 2 joueurs en action | SPLIT |
| 1 joueur en action (+ un 2e actif) | PIP, sinon plein écran |
| Calme | Plein écran du joueur le plus en retard d'écran |
| Calme, toutes les 12 min | Mosaïque 20 s |
| Calme, toutes les 20 min ou la moitié des joueurs AFK | Caméra pièce |

Les garde-fous anti-zapping :

- un plan reste au moins 25 s, sauf événement urgent (7 s minimum) ;
- un plan est changé au bout de 2 min 30 maximum ;
- il faut un plan nettement meilleur (+30 %) pour couper.

Le **temps d'écran est pondéré** :

| Plan | Poids |
|---|---|
| Plein écran | 1 |
| Split | 0,5 |
| PIP | 0,75 et 0,25 |
| Quad | 0,25 |
| Mosaïque | 0,125 |

Il est aussi multiplié par la place laissée au jeu par les casters : 0,9 en PIP, 0,5 en split, 0,25 en plein écran. Il est sauvegardé toutes les 30 s, donc un crash ne remet pas l'équité à zéro.

**Couche Claude (optionnelle)** : mets `llm.enabled: true` et la variable d'environnement `ANTHROPIC_API_KEY`. Toutes les 45 s, Claude reçoit un résumé de la partie et propose un plan avec une phrase d'explication. Sa proposition passe si rien d'urgent n'arrive. Sans clé, l'heuristique locale suffit.

### CHAT

- Un vote toutes les 90 s : `!pov 3`, `!pov Thrall`, `!pov mosaique` ou `!pov piece`. Le dernier vote de chaque viewer compte.
- Le gagnant passe en plein écran. Le 2e passe en PIP s'il a au moins 30 % des voix du gagnant.
- Un joueur en retard d'écran est un peu favorisé, et le gagnant précédent compte à moitié pour éviter qu'un seul joueur monopolise l'écran.
- Pas de vote : l'IA garde la main.
- `!temps` affiche le classement du temps d'écran. `!regie auto|chat|manuel` change de mode, pour les modos et toi seulement.
- **Points de chaîne** :
  - crée une récompense « Coup de projecteur » **avec texte à saisir** (le viewer tape le pseudo) ;
  - rachète-la une fois : son ID apparaît dans le panneau ;
  - colle-le dans `twitch.rewards` : `{ "ID": "spotlight" }`.
  - Autres actions possibles : `"split"` (deux joueurs au hasard) et `"mosaic"`.
- Pour que le bot annonce dans le chat, remplis `botUsername` et `oauthToken` (un token de chat). Sans token, la régie lit le chat en anonyme et tout s'affiche dans l'overlay.
- **Planning** : par défaut le mode CHAT se lance de hh:00 à hh:15, puis on revient en AUTO. C'est modifiable dans `schedule`.

### MANUEL

- Tap sur une vignette : plein écran.
- **Split / PIP / Quad** : tape le type, puis les joueurs dans l'ordre. Pour le PIP, le premier joueur tapé est le grand écran.
- **Mosaïque / Pièce** : un seul tap.
- La suggestion de l'IA s'affiche en jaune avec le bouton « Prendre ».
- **Verrouiller** fige le plan en mode AUTO, par exemple pendant un moment que tu veux garder.

### Casters

- Calibre la caméra **quand personne n'est assis** (bouton 📷). La présence est ensuite détectée par différence d'image. Ajuste `presenceThreshold` si besoin : la valeur s'affiche à côté de « Présent / Absent ».
- Le mode AUTO fonctionne ainsi :
  - absent → OFF ;
  - présent → PIP ;
  - présent, parle depuis 15 s et jeu calme → PLEIN ÉCRAN, le jeu reste en vignette ;
  - action en jeu → retour en PIP.
- Positions et tailles : `pc2.layouts` (en pixels sur 1920×1080).
- `muteMicsWhenAbsent: true` coupe les micros casters quand personne n'est là.

## Répéter avant le live

- `npm run simu` simule 10 h de jeu et affiche la répartition du temps d'écran. Ajoute `-- 10 0` pour voir la différence sans équité.
- `npm start -- --no-obs` lance le panneau sans OBS. Le menu « Répétition » du journal permet de simuler une mort ou un pull de boss.

## Fichiers

| Fichier | Rôle |
|---|---|
| `src/director.js` | Le cerveau : scores, équité, décisions, modes, casters |
| `src/obs.js` | Pilotage des deux OBS (scènes A/B sur le PC POV ; casters, cam pièce et détection de présence sur le PC Stream) |
| `src/twitch.js` | Chat Twitch (votes, commandes, points de chaîne) |
| `src/llm.js` | Couche Claude optionnelle |
| `agent/agent.mjs` | Lecteur de combat log à lancer sur chaque PC joueur |
| `src/run.js` | Lance le serveur et le relance à la demande de la page de réglages |
| `src/settings.js` | Lecture, validation et écriture de `config.json`, test de connexion OBS |
| `public/reglages.html` | Page de réglages |
| `public/panel.html` | Panneau complet (tablette, 2e écran) |
| `public/dock.html` | Dock compact pour OBS sur le PC Stream |
| `public/joueur.html` | Bouton « privé » des joueurs |
| `public/overlay-tags.html` | Noms sur les POV (PC POV) |
| `public/overlay-stream.html` | Votes, projecteur, classement (PC Stream) |
| `scripts/setup-obs.js` | Création automatique des scènes |

⚠️ Le panneau n'a pas de mot de passe : garde la régie sur ton réseau local et n'ouvre pas le port 8080 sur Internet.
