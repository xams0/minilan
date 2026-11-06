// Chat Twitch en IRC (aucune dépendance à une appli Twitch) :
//  - !pov <numéro|pseudo|mosaique|piece> : vote (mode CHAT)
//  - !temps : classement du temps d'écran
//  - !regie auto|chat|manuel : réservé modos / streamer
//  - Points de chaîne : les récompenses "avec texte à saisir" arrivent dans le chat
//    avec un tag custom-reward-id, mappé dans config.twitch.rewards.
import WebSocket from 'ws';

const unescapeTag = v => (v || '').replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\').replace(/\\r/g, '').replace(/\\n/g, '');

export function parseIrc(line) {
  const m = line.match(/^(?:@(\S+) )?(?::(\S+) )?(\S+)(?: (.*))?$/);
  if (!m) return null;
  const tags = {};
  if (m[1]) for (const kv of m[1].split(';')) { const [k, v] = kv.split('='); tags[k] = unescapeTag(v); }
  const params = m[4] || '';
  const ci = params.indexOf(' :');
  const trailing = params.startsWith(':') ? params.slice(1) : ci >= 0 ? params.slice(ci + 2) : '';
  const nick = m[2]?.split('!')[0];
  return { tags, nick, command: m[3], params, trailing };
}

export class TwitchChat {
  constructor(cfg, director) {
    this.t = cfg.twitch; this.dir = director;
    this.channel = (this.t.channel || '').toLowerCase().replace(/^#/, '');
    this.queue = [];
    this.unknownRewards = new Map();
    this.ws = null;
    director.on('say', msg => this.say(msg));
    setInterval(() => this.flush(), 1600);
  }

  start() {
    if (!this.channel) { this.dir.addLog('Twitch : aucune chaîne configurée (mode CHAT inactif)'); return; }
    this.connect();
  }

  connect() {
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    this.ws = ws;
    ws.on('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      if (this.t.oauthToken && this.t.botUsername) {
        ws.send(`PASS oauth:${this.t.oauthToken.replace(/^oauth:/, '')}`);
        ws.send(`NICK ${this.t.botUsername.toLowerCase()}`);
      } else {
        ws.send(`NICK justinfan${Math.floor(10000 + Math.random() * 80000)}`);
      }
      ws.send(`JOIN #${this.channel}`);
    });
    ws.on('message', data => {
      for (const line of data.toString().split('\r\n')) if (line) this.handle(line);
    });
    ws.on('close', () => {
      this.dir.status.twitch = false;
      this.dir.emitState();
      setTimeout(() => this.connect(), 5000);
    });
    ws.on('error', () => { /* géré par close */ });
  }

  handle(line) {
    const msg = parseIrc(line);
    if (!msg) return;
    if (msg.command === 'PING') { this.ws.send(`PONG :${msg.trailing || 'tmi.twitch.tv'}`); return; }
    if (msg.command === 'JOIN' && !this.dir.status.twitch) {
      this.dir.status.twitch = true;
      this.dir.addLog(`Twitch : connecté au chat #${this.channel}`);
      this.dir.emitState();
      return;
    }
    if (msg.command === 'NOTICE' && /auth/i.test(msg.trailing)) {
      this.dir.addLog(`Twitch : ${msg.trailing} (vérifie oauthToken)`);
      return;
    }
    if (msg.command !== 'PRIVMSG') return;
    const user = msg.tags['display-name'] || msg.nick;
    const text = msg.trailing.trim();

    const rewardId = msg.tags['custom-reward-id'];
    if (rewardId) {
      const action = this.t.rewards?.[rewardId];
      if (action) this.dir.redeem(action, user, text);
      else {
        this.unknownRewards.set(rewardId, { id: rewardId, lastText: text, at: Date.now() });
        this.dir.addLog(`Récompense inconnue ${rewardId} (« ${text} ») : ajoute-la dans config.twitch.rewards`);
      }
      return;
    }

    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.toLowerCase()) {
      case '!pov':
      case '!vote':
        this.dir.chatVote(msg.tags['user-id'] || user, arg);
        break;
      case '!temps': {
        const b = this.dir.board();
        const fmt = s => `${Math.floor(s / 60)}min`;
        this.say(`⏱️ Temps d'écran : ${b.map(p => `${p.name} ${fmt(p.screenTime)}`).join(' · ')}`);
        break;
      }
      case '!regie': {
        const isMod = msg.tags.mod === '1' || (msg.tags.badges || '').includes('broadcaster/');
        const map = { auto: 'AUTO', chat: 'CHAT', manuel: 'MANUEL', manual: 'MANUEL' };
        if (isMod && map[arg.toLowerCase()]) this.dir.setMode(map[arg.toLowerCase()], `chat, ${user}`);
        break;
      }
    }
  }

  say(text) {
    if (!this.t.announce || !this.t.oauthToken) return;
    this.queue.push(text.slice(0, 480));
    if (this.queue.length > 5) this.queue.shift();
  }

  flush() {
    if (!this.queue.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(`PRIVMSG #${this.channel} :${this.queue.shift()}`);
  }
}
