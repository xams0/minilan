// Couche IA optionnelle : toutes les N secondes, Claude reçoit un résumé de la partie
// et propose un plan. Le directeur l'applique si rien d'urgent ne se passe.
// Sans clé API, la régie Auto fonctionne entièrement avec l'heuristique locale.

const SYSTEM = `Tu es réalisateur·rice d'un live Twitch : un groupe d'amis joue à World of Warcraft: Forever en LAN.
Tu choisis le plan suivant parmi :
- FULL (1 joueur), SPLIT (2 joueurs côte à côte), PIP (joueur principal + 1 en incrustation),
- QUAD (4 joueurs), MOSAIC (tous les joueurs), ROOM (caméra de la pièce).
Objectifs, dans l'ordre : montrer l'action la plus spectaculaire (morts, boss, combats), raconter une histoire lisible
(pas de zapping inutile), et équilibrer le temps d'écran (screenDebtMin > 0 = joueur en retard d'écran).
Ne montre jamais un joueur "private": true. Évite les joueurs "afk": true.
Réponds UNIQUEMENT par un objet JSON : {"layout":"FULL|SPLIT|PIP|QUAD|MOSAIC|ROOM","players":[index,...],"reason":"phrase courte en français"}
Les index sont ceux fournis (base 0). "players" est vide pour MOSAIC et ROOM.`;

export class LlmDirector {
  constructor(cfg, director) {
    this.c = cfg.llm || {}; this.dir = director;
    this.key = process.env.ANTHROPIC_API_KEY || this.c.apiKey;
    this.busy = false;
  }

  start() {
    if (!this.c.enabled) return;
    if (!this.key) { this.dir.addLog('IA : aucune clé API (ANTHROPIC_API_KEY), heuristique locale seulement'); this.dir.status.llm = false; return; }
    setInterval(() => this.run(), (this.c.everySec || 45) * 1000);
  }

  async run() {
    if (this.busy || this.dir.mode !== 'AUTO' || this.dir.locked) return;
    this.busy = true;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: this.c.model || 'claude-haiku-5-5',
          max_tokens: 300,
          system: SYSTEM,
          messages: [{ role: 'user', content: JSON.stringify(this.dir.summaryForLlm()) }]
        }),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const data = await res.json();
      const text = data.content?.map(c => c.text || '').join('') || '';
      const json = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || 'null');
      if (json) {
        this.dir.status.llm = true;
        this.dir.setLlmSuggestion({ layout: { type: json.layout, players: json.players || [] }, reason: json.reason });
      }
    } catch (e) {
      this.dir.status.llm = false;
      this.dir.addLog(`IA indisponible : ${e.message}`);
    } finally {
      this.busy = false;
    }
  }
}
