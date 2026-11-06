# MediaMTX — LAN eSport

Serveur de relay SRT pour 16 joueurs en LAN. Chaque joueur envoie son flux OBS vers MediaMTX, la régie tire les flux par ID joueur.

## Stack

- **MediaMTX v1.18.2** — relay SRT, port UDP 8890
- **Node.js v24** — proxy HTTP pour le dashboard (port 8080)
- **OS** : Windows 11

## Structure

```
MediaMTX/
├── mediamtx.exe          # Binaire MediaMTX
├── mediamtx.yml          # Config (16 paths joueur1..joueur16)
├── dashboard.html        # Dashboard monitoring dark/bleuté
├── server.js             # Proxy Node.js (HTML + /api/paths)
└── start_dashboard.ps1   # Lance MediaMTX + Node en une commande
joueurs_urls.txt          # Feuille récap URLs OBS à distribuer aux joueurs
```

## Lancer

```powershell
# Tout en une commande
.\MediaMTX\start_dashboard.ps1

# Ou séparément
.\MediaMTX\mediamtx.exe .\MediaMTX\mediamtx.yml   # Terminal 1
node .\MediaMTX\server.js                           # Terminal 2
```

Dashboard accessible sur : `http://127.0.0.1:8080`

## URLs OBS

| Rôle | URL |
|---|---|
| Joueur N (publier) | `srt://127.0.0.1:8890?streamid=publish:joueurN` |
| Régie (lire) | `srt://127.0.0.1:8890?streamid=read:joueurN` |

Remplacer `127.0.0.1` par l'IP LAN du serveur pour le vrai événement :
```powershell
$ip = "192.168.1.XXX"
(Get-Content .\MediaMTX\mediamtx.yml)    -replace "127\.0\.0\.1", $ip | Set-Content .\MediaMTX\mediamtx.yml
(Get-Content .\joueurs_urls.txt)         -replace "127\.0\.0\.1", $ip | Set-Content .\joueurs_urls.txt
```

## Config OBS joueur

- **Paramètres → Flux → Service** : `Personnalisé`
- **Serveur** : `srt://127.0.0.1:8890?streamid=publish:joueurN&latency=50`
- **Clé de stream** : *(laisser vide)*
- **Paramètres → Sortie → Encodeur → Intervalle de keyframe** : `1` (pas 0 = auto = 2s)

## Config OBS régie (source Média)

- **URL** : `srt://127.0.0.1:8890?streamid=read:joueurN&latency=50`
- **Tampon réseau** : `0 ms`

## Latence attendue

~1 seconde totale (minimum avec OBS SRT). Répartition :
- Keyframe interval : jusqu'à 1s
- SRT latency : 50ms
- Buffer Media Source : 0ms

## Notes techniques

- Le dashboard fait des appels fetch vers `/api/paths` (proxy Node) et non directement vers le port 9997 — CORS bloque les appels depuis `file://` ou un port différent.
- MediaMTX v1.18.2 : champs invalides dans le yml → crash immédiat. Ne pas ajouter `srtLatency`, `allowOrigin`, `publishPermissions`, `readBufferCount`.
- Les joueurs sont en mode SRT **Caller** → aucun port à ouvrir côté joueur, tout passe par le port 8890 du serveur.
