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

### Sans npm : `RegieIA.exe`

Un seul fichier qui contient Node et la régie : double-clic, et elle démarre. Il remplace `npm start`.

- Mets-le dans un dossier à lui. `config.json` et `data/` restent à côté de l'exe et ne sont jamais touchés par une mise à jour. Le programme est extrait dans `app/`.
- Sans `config.json`, elle démarre avec la config de base de l'installation Lanppart (`config.example.json`), prévue pour tourner sur le PC Stream. `/reglages` crée ensuite le fichier.
- Pour reprendre une installation existante, copie `config.json` et `data/` à côté de l'exe : ce fichier passe avant la config de base.
- La fenêtre donne l'accès au panneau et aux réglages, l'adresse à taper sur le Steam Deck, le bouton **Préparer OBS** (l'équivalent de `npm run setup-obs`) et le journal. La fermer arrête la régie, après confirmation.
- Pour le compiler : `launcher\build.ps1 -Version 1.2.0`, avec Node installé sur le PC qui compile.

### Mises à jour automatiques

`AgentRegie.exe` et `RegieIA.exe` se mettent à jour depuis les Releases GitHub du dépôt, qui doit rester public.

- **Publier :** pousser un tag, `git tag agent-v1.2.0` ou `git tag regie-v1.2.0`, puis `git push origin <tag>`. GitHub Actions compile l'exe et crée la Release (`.github/workflows/`).
- **Au lancement :** la nouvelle version s'installe seule, puis l'exe se relance sans prendre le clavier. L'agent reprend l'envoi, la régie redémarre.
- **En cours de session :** une vérification par heure. Si une version sort, un bouton **Mettre à jour** apparaît : rien ne s'installe sans clic, pour ne couper ni un joueur en jeu ni le direct.
- **Sans internet :** l'exe démarre normalement. La régie attend au plus 5 s la réponse de GitHub.
- **Contrôles :** taille, empreinte SHA-256 fournie par GitHub, version annoncée, et démarrage de test du nouvel exe avant de remplacer l'ancien. Les exe ne sont pas signés : la sécurité repose sur le compte GitHub qui publie.
- Un exe compilé sans `-Version` (0.0.0) ne se met jamais à jour.

### Stream Deck : plugin et profil 8 × 5

Double-clique sur `streamdeck\dist\RegieIA.streamDeckPlugin` (créé par `streamdeck\build.ps1`, et joint aux Releases `regie-v*`). Il installe le plugin **Régie IA** et propose le profil **RegieIA** pour Stream Deck Mobile, en 8 × 5. Si le profil n'apparaît pas, double-clique sur `RegieIA.streamDeckProfile`.

Le plugin ne contient ni touche, ni lien, ni commande. `src/streamdeck.js`, dans la régie, décide de ce qu'affiche chaque position et traite les appuis. Ajouter un joueur ou changer une touche ne demande donc qu'une mise à jour de `RegieIA.exe`.

- **Adresse :** `192.168.1.41:8080` par défaut, le PC Stream. Si la régie tourne ailleurs ou sur un autre port, clique sur une touche dans le logiciel Stream Deck et change l'adresse dans l'inspecteur : elle vaut pour toutes les touches.
- **POV 1 à 9, à droite :** appui = plein écran, avec l'image du POV dans la touche.
- **PIP, Split, Quad :** appuie sur le plan, puis sur les joueurs. Pour un PIP, le premier joueur est le plan principal. Un second appui sur le plan annule.
- **Caméras :** Pièce (la caméra de `pc2.roomCam`), et la ligne Casters pour la caméra des casters (Auto, Off, PIP, Split, Plein écran).
- **Autres :** modes, verrou, suggestion, classement, vote, privé, projecteurs, état des connexions et des agents.

### Page tactile (tablette, Steam Deck)

Ouvre **`http://IP_DE_LA_REGIE:PORT/deck`** dans un navigateur : 40 touches tactiles carrées (8 × 5) en 1280 × 800, sans rien installer. Le bouton **Plein écran** retire la barre du navigateur. Ses touches sont écrites dans `public/deck.html`, pas dans `src/streamdeck.js`.

| Ligne | Touches |
|---|---|
| 1 | Modes, verrou, plan à l'antenne |
| 2-3 | Joueurs 1 à 9 avec leur image (appui = plein écran), puis Split, PIP, Quad, Mosaïque, Pièce, Privé, Suggestion |
| 4 | Casters, classement, nouveau vote |
| 5 | Projecteurs, plein écran, vote en cours, état des connexions |

Split, PIP et Quad : appuie sur le plan, puis sur les joueurs. Le plan part au dernier joueur choisi, et un second appui sur le plan annule. Privé : appuie dessus, puis sur le joueur.

### Stream Deck sans plugin

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

**Le plus simple : `agent/exe/dist/AgentRegie.exe`.** Copie ce seul fichier sur le PC joueur et lance-le, sans rien installer de plus (il a besoin de .NET Framework 4.8, déjà présent sur Windows 10 et 11 à jour).

- Au premier lancement, le joueur choisit son dossier `Logs` avec **Parcourir** (`World of Warcraft\_forever_\Logs`). Tout autre dossier est refusé.
- Le joueur vérifie l'adresse de la régie, choisit son pseudo dans la liste et clique sur **Démarrer**. Ces choix sont retenus, et l'envoi reprend tout seul aux lancements suivants.
- Le **journal** de la fenêtre affiche ce que l'agent reconnaît, en direct, avec les noms en couleur et en gras : `MORT`, `KILL`, `BOSS`, `COMBAT`, `PVP`, `BG`, `ARÈNE`, `INSTANCE`, `ZONE`, `INTERRUPTION`, `RÉSURRECTION`, `PERSONNAGE`, `LOG`. Il indique le retard de chaque ligne à partir de 3 s. `PVP`, `BG`, `ARÈNE`, `INSTANCE`, `ZONE` et `COMBAT` servent à la lecture : ils ne changent rien à ce qui part à la régie. Les zones affichent leur identifiant : si un BG apparaît en `INSTANCE`, ajoute son identifiant dans `Journal.cs`.
- Chaque `/combatlog` crée un fichier daté (`WoWCombatLog-110726_080848.txt`, soit MMJJAA_HHMMSS). L'agent suit toujours celui dont le nom porte la date la plus récente.
- Il faut toujours taper `/combatlog` en jeu, une fois par session. La fenêtre prévient si WoW tourne sans rien écrire.
- Pour pré-remplir une autre adresse : `agent\exe\build.ps1 -Regie http://IP_DE_LA_REGIE:PORT` (recompile l'exe, sans rien à installer sur le PC de la régie).

**Sans l'exe**, avec Node :

1. Copie `agent/agent.mjs` (un seul fichier, aucune installation à part Node) puis lance :
   ```
   node agent.mjs --server http://IP_DE_LA_REGIE:8080 --player 3
   ```
   Si le dossier n'est pas trouvé tout seul, ajoute `--logs "C:\...\World of Warcraft\_forever_\Logs"`. Vérifie le nom exact du dossier du jeu.
2. **En jeu, tape `/combatlog` à chaque session**, sinon rien n'est écrit.
3. WoW garde le log en mémoire et l'écrit à la fin de chaque combat (mesuré le 2026-11-07 : moins de 1 à 5 s après la fin d'un combat court). Pendant un combat, rien n'arrive à la régie : le début d'un combat de 10 s lui parvient avec 10 s de retard. Une mort arrive dans la seconde, car elle finit le combat : l'agent la détecte sur le coup mortel, le `UNIT_DIED` n'étant écrit que plusieurs minutes après.
4. L'agent envoie l'âge de chaque ligne. Au-delà de **Événement du log trop ancien** (6 s par défaut, sur `/reglages`), les dégâts, sorts, soins et pulls ne comptent plus dans le score d'intérêt : ils montrent seulement que le joueur n'est pas AFK. Les morts, kills et fins de boss comptent toujours, mais sans coupe urgente. Pendant un combat, AUTO se base donc surtout sur le mouvement à l'image et les micros.

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
- Si tu déplaces ou redimensionnes le PIP directement dans OBS, la régie retient cette position, y compris après un redémarrage (`data/caster-pip.json`). Modifier « Casters en PIP : caméra » sur `/reglages` la remplace.
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
| `agent/exe/` | Agent joueur avec interface (`AgentRegie.exe`). `CombatLog.cs` et `LogFinder.cs` doivent garder la même logique que `agent.mjs`. `Updater.cs` sert aussi à `RegieIA.exe` |
| `launcher/` | `RegieIA.exe` : lance la régie sans npm, Node inclus |
| `public/deck.html` | Page tactile 8 × 5 (`/deck`) |
| `src/streamdeck.js` | Touches du Stream Deck : ce qu'affiche chaque position, ce que fait chaque appui |
| `streamdeck/` | Plugin Stream Deck et génération du profil |
| `agent/agent.mjs` | Lecteur de combat log en ligne de commande, à lancer sur chaque PC joueur |
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
