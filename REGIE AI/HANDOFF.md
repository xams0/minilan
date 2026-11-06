# Régie Forever — brief de reprise pour Claude Code

> But de ce document : permettre à Claude Code de reprendre le projet sans l'historique de la conversation.
> Le code existant est dans ce dossier (`regie-wow/`). La maquette du dock cible est publiée en artifact (« Régie Forever »).

---

## 1. Contexte

- Live Twitch de **10 h** sur **WoW Forever**, en **LAN** : **8 joueurs** dans la même maison.
- Objectif : une **régie automatique** qui choisit quelles POV afficher (plein écran, split, PIP, quad, mosaïque, caméra pièce), avec **3 modes** :
  - **AUTO IA** : décide seule à partir de l'action en jeu + équité du temps d'écran.
  - **CHAT** : le chat Twitch vote (`!pov 3`, `!pov pseudo`) + points de chaîne.
  - **MANUEL** : le régisseur choisit, l'IA suggère.
- Contrainte forte : **temps d'écran équitable** entre les 8 joueurs sur 10 h (≈ 72–75 min chacun).
- Les **casters** apparaissent automatiquement (PIP / split / plein écran) selon qu'ils sont devant leur caméra et qu'ils parlent.

## 2. Setup matériel (réel, à respecter)

```
8 PC joueurs ──SRT──▶ PC POV (OBS) ──HDMI──▶ PC Stream (OBS) ──▶ Twitch
  │ agent.mjs           scènes REGIE_A/B        scène LIVE :
  │ (combat log)        8 POV uniquement        capture HDMI + cam casters
  │                                             + cam pièce + overlays + micros casters
  └────────────▶ RÉGIE (Node.js, tourne sur le PC Stream, port 8080)
                  ◀── dock OBS, tablette, Stream Deck, chat Twitch, Claude (option)
```

- **PC POV** : reçoit les **8 POV en SRT** (Sources média `srt://…`). Ne contient **que** les POV. Compose plein écran / split / PIP / quad / mosaïque. Sortie = projecteur plein écran (Programme) en **HDMI** vers le PC Stream.
- **PC Stream** : reçoit le HDMI, gère overlays, micros casters, **caméra casters** et **caméra pièce**, envoie sur Twitch. C'est là que le régisseur travaille → **l'interface principale est un dock OBS** sur ce PC.
- Les deux OBS sont pilotés via **obs-websocket v5** (port 4455).

## 3. Ce qui existe déjà (code dans ce dossier)

Node.js ≥ 20, ESM. Dépendances : `obs-websocket-js`, `ws`, `jpeg-js`.

| Fichier | Rôle | État |
|---|---|---|
| `src/director.js` | Cerveau : scores d'intérêt, dette d'écran, décisions, modes, casters, votes, spotlight, persistance `data/state.json` | Fonctionnel, testé en simulation |
| `src/layouts.js` | Géométrie des plans (canevas 1920×1080) + poids de temps d'écran | OK |
| `src/obs.js` | `Pc1` (PC POV, bascule REGIE_A/B, captures pour mouvement/AFK, vignettes) · `Pc2` (PC Stream : jeu, cam casters, cam pièce, animations, détection de présence par diff d'image, VU-mètres micros) | Écrit, **jamais testé contre un vrai OBS** |
| `src/twitch.js` | Chat IRC (votes, `!temps`, `!regie`, récompenses via `custom-reward-id`) | Écrit, non testé en réel |
| `src/llm.js` | Couche Claude optionnelle (API Messages, suggestion de plan toutes les 45 s) | Écrit, non testé en réel |
| `src/server.js` | HTTP + WebSocket : pages, `/api/agent`, `/api/state`, `/api/cmd` (Stream Deck), diffusion d'état | Testé en `--no-obs` |
| `agent/agent.mjs` | Agent sur chaque PC joueur : lit `WoWCombatLog*.txt` en tail, classe les événements, POST vers la régie | Parser testé sur log synthétique |
| `public/panel.html` | Panneau complet (tablette) avec vignettes | OK |
| `public/dock.html` | **Dock OBS v1 — trop simple, à remplacer** | À refaire (voir §5) |
| `public/joueur.html` | Bouton « privé » sur téléphone du joueur | OK |
| `public/overlay-tags.html` | Noms des joueurs sur les POV (browser source PC POV, `?slot=A/B`) | OK |
| `public/overlay-stream.html` | Vote, projecteur, classement (browser source PC Stream) | OK |
| `scripts/setup-obs.js` | Crée scènes/sources, force SRT « ouvert hors antenne », ajoute overlay | Écrit, non testé |
| `scripts/simulate.js` | Simule 10 h sans OBS | OK |
| `config.example.json` | Toute la configuration | OK |

Commandes : `npm install` · `npm start` · `npm start -- --no-obs` · `npm run simu` · `npm run setup-obs -- --regie http://IP:8080`

## 4. Logique clé (à conserver)

### Score et décision (mode AUTO)
- Intérêt par joueur, demi-vie **8 s**, plafonné à 10. Poids d'événements :
  `boss_start 5 · death 4.5 · boss_kill 4 · level 3.5 · boss_wipe 3 · shout 1.2 · kill 1 · res 1 · interrupt 0.5 · dmg_in 0.2 · dmg_out 0.12 · heal 0.04 · cast 0.03`
- **Priorité** = `intérêt + fairness × hotThreshold × 1.5 × dette_normalisée` (dette normalisée sur ±300 s).
- Choix du plan : ≥ 4 joueurs chauds ou pull de boss à ≥ 4 → **QUAD** · 2 chauds → **SPLIT** · 1 chaud (+ un actif) → **PIP**, sinon **FULL** · calme → FULL du joueur le plus en retard · calme + 12 min → **MOSAÏQUE 20 s** · calme + 20 min ou ½ AFK → **PIÈCE**.
- Anti-zapping : min **25 s** par plan, **7 s** si urgent (mort/boss hors champ), max **150 s**, nouveau plan doit être **> 1,3× + 0,4** meilleur.
- Joueur **privé** → retiré immédiatement, **même en MANUEL ou verrouillé**.

### Équité
- Temps d'écran pondéré : FULL 1 · SPLIT 0,5 chacun · PIP 0,75 / 0,25 · QUAD 0,25 · MOSAÏQUE 0,125 · PIÈCE 0.
- Multiplié par la place laissée au jeu par les casters : OFF 1 · PIP 0,9 · SPLIT 0,5 · FULL 0,25.
- Dette = cible (`total distribué / 8`) − temps reçu. Sauvegarde toutes les 30 s.
- Simulation 10 h : équité 0,6 → **écart max ≈ 3–5 min** ; équité 0 → le plus actif prend **41 %**.

### Répartition des plans entre les deux PC
- PIÈCE : **PC Stream** affiche la cam pièce à la place de la capture jeu ; **PC POV ne bouge pas**.
- MOSAÏQUE : PC POV fait la grille 3×3 **case centrale vide** ; PC Stream pose la cam pièce au centre après `pc2.syncDelayMs` (350 ms) pour attendre la transition HDMI.
- Casters (PC Stream) : OFF / PIP (haut-droite 480×270) / SPLIT / FULL (jeu en vignette bas-droite). Ordre z : jeu < pièce < casters, inversé en FULL.
- Casters AUTO : absent → OFF · présent → PIP · parle depuis 15 s et jeu calme → FULL · action en jeu → PIP. Tenue min 8 s.
- Présence : diff moyenne en niveaux de gris vs photo « siège vide » (calibrage), seuil 0,09 ; 2 frames présent / 5 frames absent.

### Chat
- Vote 90 s, dernier vote par viewer compte. Gagnant → FULL ; 2e → PIP s'il a ≥ 30 % des voix du gagnant. Pondération par dette (×0,7 à ×1,3), gagnant précédent ×0,5. Aucun vote → l'IA garde la main.
- Points de chaîne (récompense avec texte) : `spotlight` (60 s), `split` (2 au hasard), `mosaic`. Mapping `config.twitch.rewards { id: action }`. En MANUEL, les projecteurs attendent validation.
- Planning : CHAT de hh:00 à hh:15, retour AUTO ensuite.

## 5. Tâche principale : refaire le dock OBS (`public/dock.html`)

Le dock doit **régler presque tout en direct**, sans redémarrer. Référence visuelle : maquette « Régie Forever » (artifact). Style : sombre, sobre, type Apple, accent or `#e9b44c`, rouge antenne `#ff453a`, police Geist / système.

Six onglets :

1. **Antenne** — mode AUTO / CHAT / MANUEL (+ prochain passage planifié), verrou, plan à l'antenne + raison + barre de tenue (x / max), suggestion IA « Prendre », sélecteur de plan avec pictogrammes (Plein, Split, PIP, Quad, Mosaïque, Pièce) puis tap joueurs, grille 8 joueurs (intérêt, dette ±min, LIVE, privé, AFK), actions rapides (classement à l'écran, lancer projecteur).
2. **Réalisation** — curseurs : durée min plan, coupe urgente après, durée max, exigence pour couper (%), seuil « en action », seuil « calme », AFK après ; mosaïque toutes les X min + durée ; plan pièce toutes les X min + durée ; plan pièce si ½ AFK ; coin du PIP joueur ; transition PC POV (coupe / fondu / stinger + durée) ; Claude on/off + fréquence.
3. **PC Stream** — mode casters AUTO/OFF/PIP/SPLIT/FULL + mini-aperçu de composition ; jauge de présence live + seuil + bouton calibrer ; VU micros casters + seuil de parole (dB) + couper micros si absent ; plein écran auto (on/off, après X s de parole, tenue min) ; coin, taille et durée d'animation de l'incrustation casters ; cam pièce au centre de la mosaïque (on/off), délai synchro HDMI (ms) + bouton « tester la synchro ».
4. **Chat** — vote en cours (compte à rebours, top 3, relancer) ; durée du vote, seuil 2e en PIP, favoriser joueurs en retard, autoriser mosaïque / pièce ; points de chaîne (liste, récompenses inconnues → bouton « Associer »), durée projecteur, validation en manuel ; planning horaire visuel (début + durée du créneau CHAT) ; bot annonce / modos `!regie`.
5. **Équité** — curseur équité, objectif actuel, plus grand écart, tableau par joueur (temps, retard/avance), poids des plans, fréquence du classement à l'écran, remise à zéro avec confirmation intégrée (pas de `confirm()`).
6. **Système** — état des connexions (PC POV, PC Stream, Twitch, Claude), état des **8 flux SRT** (débit, latence, pertes), état des **agents combat log** (dernier message), dernière sauvegarde.

### Ce que ça implique côté serveur
- Nouvelle commande WebSocket `set` : `{ cmd: 'set', path: 'director.minHoldSec', value: 30 }` avec liste blanche de chemins, validation des bornes, application immédiate (le directeur lit `this.d` / `this.cfg` à chaque tick — vérifier les valeurs copiées au constructeur comme `fairness`).
- Persister les réglages modifiés dans `data/settings.json` (surcharge de `config.json` au démarrage), ne pas réécrire `config.json`.
- Rendre paramétrables ce qui est codé en dur aujourd'hui : coin/taille du PIP casters (recalcul de `pc2.layouts.PIP`), exigence de coupe (`1.3 / 0.4` dans `director.evaluate`), seuil du 2e en PIP (0,3 dans `resolveVote`), durée de tenue min casters, options chat (mosaïque/pièce autorisées).
- Transition PC POV : `SetCurrentSceneTransition` + `SetCurrentSceneTransitionDuration` sur Pc1.
- Stats SRT : `GetMediaInputStatus` ne donne pas le débit ; envisager `GetStats` global + présence d'image (diff des captures) comme indicateur « flux vivant ». Ne pas inventer de métriques indisponibles : afficher ce qu'OBS fournit réellement.
- Exposer dans l'état : niveaux micros casters (dB), `presenceDiff`, dernier contact par agent, prochain créneau planifié.
- Endpoint « tester la synchro » : force MOSAIC 3 s puis revient au plan précédent.

## 6. Autres points ouverts

- **Rien n'a été testé contre de vrais OBS** : à faire en priorité avec 2 instances OBS (ou une seule en local pour les deux rôles).
- Format du combat log WoW Forever **supposé identique** au client moderne (flags `0x511`, `ENCOUNTER_START/END`, `UNIT_DIED`). Vérifier avec `node agent/agent.mjs --test <log réel>`.
- Le dossier d'install de WoW Forever (`_forever_` ?) est deviné dans `agent.mjs` → option `--logs` en secours.
- SRT : même latence sur les 8 flux ; `close_when_inactive: false` et `restart_on_activate: false` sur les Sources média.
- Aucun mot de passe sur le panneau : réseau local uniquement.
- Couche Claude : modèle `claude-haiku-5-5` par défaut, clé via `ANTHROPIC_API_KEY`.

## 7. Critères d'acceptation

- `npm start -- --no-obs` : le dock s'ouvre sur `/dock`, chaque réglage modifie l'état en direct (visible dans `/api/state`) et survit à un redémarrage.
- Largeur du dock OBS ~340–420 px : aucun débordement horizontal, onglets défilables.
- `npm run simu` reste à un écart < 6 min avec équité 0,6.
- Aucun `alert()` / `confirm()` dans les pages (le dock tourne dans OBS CEF).
