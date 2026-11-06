// Pilotage des deux OBS via obs-websocket v5.
//  - Pc1 : PC qui reçoit les 8 POV en SRT. Compose le plan dans deux scènes REGIE_A / REGIE_B
//          (on prépare la scène cachée puis on bascule : la transition OBS s'applique).
//  - Pc2 : PC Stream. Ne touche qu'à trois éléments de la scène LIVE : la capture HDMI du jeu,
//          la caméra casters (OFF / PIP / SPLIT / FULL) et la caméra pièce (plan ROOM,
//          centre de la mosaïque), avec une petite animation.
import { OBSWebSocket, EventSubscription } from 'obs-websocket-js';
import jpeg from 'jpeg-js';
import fs from 'node:fs';
import path from 'node:path';
import { cells, MOSAIC_FULL_AT } from './layouts.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Décode une capture JPEG d'OBS en niveaux de gris (Float32Array 0..1) */
export function grayFromDataUri(uri) {
  const b64 = uri.slice(uri.indexOf(',') + 1);
  const img = jpeg.decode(Buffer.from(b64, 'base64'), { useTArray: true, formatAsRGBA: true });
  const g = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (0.299 * img.data[j] + 0.587 * img.data[j + 1] + 0.114 * img.data[j + 2]) / 255;
  }
  return g;
}

export function meanAbsDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

const peakDb = levels => {
  // inputLevelsMul : [[magnitude, peak, inputPeak], ...] par canal
  let m = 0;
  for (const ch of levels || []) m = Math.max(m, ch[1] || 0);
  return m > 0 ? 20 * Math.log10(m) : -100;
};

const transform = ([x, y, w, h]) => ({
  positionX: x, positionY: y, alignment: 5, rotation: 0,
  boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: Math.max(1, w), boundsHeight: Math.max(1, h), boundsAlignment: 0,
  cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0
});

/** Connexion OBS avec reconnexion automatique */
class ObsLink {
  constructor(name, url, password, log, { meters = false } = {}) {
    this.name = name; this.url = url; this.password = password; this.log = log;
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.meters = meters;
    this.onConnect = async () => {};
    this.onStatus = () => {};
    this.obs.on('ConnectionClosed', () => {
      if (this.connected) this.log(`${this.name} : connexion perdue, nouvelle tentative…`);
      this.connected = false;
      this.onStatus(false);
    });
  }

  async start() {
    for (;;) {
      if (!this.connected) {
        try {
          const subs = EventSubscription.All | (this.meters ? EventSubscription.InputVolumeMeters : 0);
          await this.obs.connect(this.url, this.password || undefined, { eventSubscriptions: subs });
          this.connected = true;
          this.log(`${this.name} connecté (${this.url})`);
          this.onStatus(true);
          await this.onConnect();
        } catch (e) {
          if (this.connected) this.log(`${this.name} : ${e.message}`);
          try { await this.obs.disconnect(); } catch { /* déjà fermé */ }
          this.connected = false;
          this.onStatus(false);
        }
      }
      await sleep(5000);
    }
  }

  call(type, data) { return this.obs.call(type, data); }
  batch(reqs) { return reqs.length ? this.obs.callBatch(reqs) : Promise.resolve([]); }
}

export class Pc1 {
  constructor(cfg, director, { onTags, onThumbs }) {
    this.cfg = cfg; this.c = cfg.pc1; this.dir = director;
    this.onTags = onTags; this.onThumbs = onThumbs;
    const log = m => director.addLog(m);
    this.hasMics = cfg.players.some(p => p.mic);
    this.link = new ObsLink('PC POV', this.c.url, this.c.password, log, { meters: this.hasMics });
    this.link.onStatus = v => { director.status.pc1 = v; director.emitState(); };
    this.link.onConnect = () => this.init();
    this.items = {};        // scene -> sourceName -> { id, index }
    this.counts = {};
    this.program = null;
    this.prevGray = [];
    this.applying = Promise.resolve();
    this.link.obs.on('CurrentProgramSceneChanged', e => { this.program = e.sceneName; });
    if (this.hasMics) {
      const micToPlayer = new Map(cfg.players.map((p, i) => [p.mic, i]).filter(([m]) => m));
      const db = this.c.speakingDb ?? cfg.pc2.speakingDb ?? -35;
      this.link.obs.on('InputVolumeMeters', ({ inputs }) => {
        for (const inp of inputs) {
          const i = micToPlayer.get(inp.inputName);
          if (i !== undefined) director.setSpeaking(i, peakDb(inp.inputLevelsMul) > db);
        }
      });
    }
  }

  start() { this.link.start(); this.shotLoop(); }

  managedSources() {
    return this.cfg.players.map(p => p.source);
  }

  async init() {
    for (const scene of this.c.scenes) {
      const { sceneItems } = await this.link.call('GetSceneItemList', { sceneName: scene });
      this.items[scene] = {};
      for (const it of sceneItems) this.items[scene][it.sourceName] = { id: it.sceneItemId, index: it.sceneItemIndex };
      this.counts[scene] = sceneItems.length;
      const missing = this.managedSources().filter(s => !this.items[scene][s]);
      if (missing.length) this.dir.addLog(`⚠️ ${scene} : sources absentes ${missing.join(', ')} (lance "npm run setup-obs")`);
    }
    const { currentProgramSceneName } = await this.link.call('GetCurrentProgramScene');
    this.program = currentProgramSceneName;
    await this.applyLayout(this.dir.current.layout);
  }

  applyLayout(layout) {
    // Les changements sont sérialisés pour ne jamais préparer deux scènes en même temps
    this.applying = this.applying.then(() => this._apply(layout)).catch(e => this.dir.addLog(`PC POV : ${e.message}`));
    return this.applying;
  }

  async _apply(layout) {
    // La caméra pièce est sur le PC Stream : le PC POV garde son plan précédent en dessous
    if (layout.type === 'ROOM') return;
    const [A, B] = this.c.scenes;
    const scene = this.program === A ? B : A;
    const list = cells(layout, { canvas: this.c.canvas, pipCorner: this.c.pipCorner, playerCount: this.cfg.players.length, hasRoom: false });
    this.onTags(scene === A ? 'A' : 'B', list.map(c => ({
      rect: c.rect, name: c.who === 'room' ? null : this.cfg.players[c.who].name, small: c.top || c.rect[2] < 700
    })), this.c.canvas);
    if (!this.link.connected || !this.items[scene]) return;

    const srcOf = who => this.cfg.players[who].source;
    const shown = new Map(list.map(c => [srcOf(c.who), c]));
    const reqs = [];
    for (const src of this.managedSources()) {
      const it = this.items[scene][src];
      if (!it) continue;
      const c = shown.get(src);
      if (c) reqs.push({ requestType: 'SetSceneItemTransform', requestData: { sceneName: scene, sceneItemId: it.id, sceneItemTransform: transform(c.rect) } });
      reqs.push({ requestType: 'SetSceneItemEnabled', requestData: { sceneName: scene, sceneItemId: it.id, sceneItemEnabled: !!c } });
    }
    // L'incrustation PIP doit passer au-dessus du plein écran (mais sous les noms)
    const top = list.find(c => c.top);
    if (top) {
      const it = this.items[scene][srcOf(top.who)];
      const hasTags = !!this.items[scene][`${this.c.tagsSource}_${scene === A ? 'A' : 'B'}`];
      if (it) reqs.push({ requestType: 'SetSceneItemIndex', requestData: { sceneName: scene, sceneItemId: it.id, sceneItemIndex: this.counts[scene] - (hasTags ? 2 : 1) } });
    }
    await this.link.batch(reqs);
    await sleep(60); // laisse OBS appliquer les transformations avant la transition
    await this.link.call('SetCurrentProgramScene', { sceneName: scene });
    this.program = scene;
  }

  /** Captures basse définition : mouvement (AFK / chargement) + vignettes du panneau */
  async shotLoop() {
    const every = (this.c.screenshotEverySec || 2) * 1000;
    for (;;) {
      await sleep(every);
      if (!this.link.connected) continue;
      const sources = this.managedSources();
      try {
        const res = await this.link.batch(sources.map(s => ({
          requestType: 'GetSourceScreenshot',
          requestData: { sourceName: s, imageFormat: 'jpg', imageWidth: 192, imageCompressionQuality: 55 }
        })));
        const thumbs = {};
        res.forEach((r, k) => {
          const uri = r.responseData?.imageData;
          if (!r.requestStatus?.result || !uri) return;
          thumbs[k] = uri;
          const g = grayFromDataUri(uri);
          this.dir.setMotion(k, meanAbsDiff(g, this.prevGray[k]));
          this.prevGray[k] = g;
        });
        this.onThumbs(thumbs);
      } catch (e) { /* capture ratée : on réessaie au prochain tour */ }
    }
  }
}

export class Pc2 {
  constructor(cfg, director, { dataDir, onThumb, onRoomThumb }) {
    this.cfg = cfg; this.c = cfg.pc2; this.dir = director;
    this.onThumb = onThumb; this.onRoomThumb = onRoomThumb;
    this.refPath = path.join(dataDir, 'caster-ref.json');
    this.link = new ObsLink('PC Stream', this.c.url, this.c.password, m => director.addLog(m), { meters: true });
    this.link.onStatus = v => { director.status.pc2 = v; director.emitState(); };
    this.link.onConnect = () => this.init();
    this.ids = {};
    this.rects = { game: null, cam: null, room: null };
    this.casterMode = director.caster.applied;
    this.layoutType = director.current.layout.type;
    this.tweenToken = 0;
    this.ref = null;
    this.lastGray = null;
    this.presentStreak = 0;
    this.absentStreak = 0;
    this.lastDiff = 0;
    this.shots = 0;
    try {
      const r = JSON.parse(fs.readFileSync(this.refPath, 'utf8'));
      this.ref = Float32Array.from(r.gray);
      director.caster.presenceCalibrated = true;
    } catch { /* pas encore calibré */ }

    const mics = new Set(this.c.casterMics || []);
    const levels = new Map();
    this.link.obs.on('InputVolumeMeters', ({ inputs }) => {
      for (const inp of inputs) if (mics.has(inp.inputName)) levels.set(inp.inputName, peakDb(inp.inputLevelsMul));
      if (mics.size) director.setCasterSpeaking(Math.max(...[...levels.values(), -100]) > this.c.speakingDb);
    });
  }

  start() { this.link.start(); this.presenceLoop(); }

  sources() { return { game: this.c.gameSource, cam: this.c.casterCam, room: this.c.roomCam }; }

  async init() {
    for (const [k, src] of Object.entries(this.sources())) {
      this.ids[k] = null;
      if (!src) continue;
      try {
        const { sceneItemId } = await this.link.call('GetSceneItemId', { sceneName: this.c.scene, sourceName: src });
        this.ids[k] = sceneItemId;
      } catch {
        this.dir.addLog(`⚠️ PC Stream : "${src}" introuvable dans la scène "${this.c.scene}"`);
      }
    }
    this.rects = { game: null, cam: null, room: null };
    await this.render({ instant: true });
  }

  /** Mode casters (OFF / PIP / SPLIT / FULL) */
  applyCaster(mode) { this.casterMode = mode; return this.render(); }

  /** Plan de la régie : seuls ROOM et MOSAIC changent quelque chose sur le PC Stream */
  setLayout(layout) {
    const before = this.layoutType;
    this.layoutType = layout.type;
    const touches = t => t === 'ROOM' || t === 'MOSAIC';
    if (!touches(before) && !touches(layout.type)) return;
    // Entrée en mosaïque : on attend que la transition du PC POV soit passée par le HDMI
    const delay = layout.type === 'MOSAIC' ? (this.c.syncDelayMs ?? 350) : 0;
    setTimeout(() => this.render().catch(e => this.dir.addLog(`PC Stream : ${e.message}`)), delay);
  }

  /** Positions voulues de la capture jeu, de la cam casters et de la cam pièce */
  targets() {
    const L = this.c.layouts[this.casterMode] || this.c.layouts.OFF;
    let game = L.game, cam = L.cam, room = null;
    if (this.layoutType === 'ROOM' && this.ids.room != null) {
      room = game;      // la pièce prend la place du jeu (plein écran, ou vignette si casters en FULL)
      game = null;
    } else if (this.layoutType === 'MOSAIC' && game && this.ids.room != null && this.cfg.players.length < MOSAIC_FULL_AT) {
      const [x, y, w, h] = game; // case centrale de la mosaïque 3x3
      room = [x + w / 3, y + h / 3, w / 3, h / 3];
    }
    return { game, cam, room };
  }

  async render({ instant = false } = {}) {
    if (!this.link.connected) return;
    const token = ++this.tweenToken;
    const scene = this.c.scene;
    const targets = this.targets();
    const keys = ['game', 'cam', 'room'].filter(k => this.ids[k] != null);
    const req = (k, type, data) => ({ requestType: type, requestData: { sceneName: scene, sceneItemId: this.ids[k], ...data } });

    if (this.c.muteMicsWhenAbsent && this.c.casterMics?.length) {
      await this.link.batch(this.c.casterMics.map(m => ({ requestType: 'SetInputMute', requestData: { inputName: m, inputMuted: this.casterMode === 'OFF' } })));
    }

    // Ordre d'empilement d'abord, pour que les apparitions soient directement au bon niveau
    await this.reorder();

    const show = [];
    for (const k of keys) {
      if (targets[k] && !this.rects[k]) {
        show.push(req(k, 'SetSceneItemTransform', { sceneItemTransform: transform(targets[k]) }));
        show.push(req(k, 'SetSceneItemEnabled', { sceneItemEnabled: true }));
      }
    }
    await this.link.batch(show);

    const moving = keys.filter(k => targets[k] && this.rects[k]);
    const steps = instant ? 1 : Math.max(1, Math.round((this.c.tweenMs || 450) / 33));
    const from = Object.fromEntries(moving.map(k => [k, this.rects[k]]));
    for (let s = 1; s <= steps; s++) {
      if (token !== this.tweenToken) return; // une autre animation a pris la main
      const t = s / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await this.link.batch(moving.map(k => req(k, 'SetSceneItemTransform', {
        sceneItemTransform: transform(from[k].map((v, i) => v + (targets[k][i] - v) * e))
      })));
      if (s < steps) await sleep(33);
    }

    await this.link.batch(keys.filter(k => !targets[k]).map(k => req(k, 'SetSceneItemEnabled', { sceneItemEnabled: false })));
    this.rects = { ...targets };
  }

  /** Du bas vers le haut : jeu, pièce, casters — sauf casters en FULL où les vignettes passent devant */
  async reorder() {
    const want = this.casterMode === 'FULL' ? ['cam', 'game', 'room'] : ['game', 'room', 'cam'];
    const order = want.filter(k => this.ids[k] != null);
    for (let pass = 0; pass < 3; pass++) {
      const { sceneItems } = await this.link.call('GetSceneItemList', { sceneName: this.c.scene });
      const idx = k => sceneItems.find(i => i.sceneItemId === this.ids[k])?.sceneItemIndex;
      const bad = order.findIndex((k, n) => n > 0 && idx(order[n - 1]) > idx(k));
      if (bad < 0) return;
      // Monter l'élément à la place de celui qui doit être dessous : il passe juste au-dessus
      await this.link.call('SetSceneItemIndex', { sceneName: this.c.scene, sceneItemId: this.ids[order[bad]], sceneItemIndex: idx(order[bad - 1]) });
    }
  }

  /** Détection de présence : compare la caméra casters à une image du siège vide */
  async presenceLoop() {
    for (;;) {
      await sleep(1000);
      if (!this.link.connected) continue;
      if (this.c.roomCam && this.shots++ % 2 === 0) {
        this.link.call('GetSourceScreenshot', { sourceName: this.c.roomCam, imageFormat: 'jpg', imageWidth: 192, imageCompressionQuality: 55 })
          .then(r => this.onRoomThumb(r.imageData)).catch(() => {});
      }
      if (!this.c.casterCam) continue;
      try {
        const { imageData } = await this.link.call('GetSourceScreenshot', { sourceName: this.c.casterCam, imageFormat: 'jpg', imageWidth: 96, imageCompressionQuality: 60 });
        const g = grayFromDataUri(imageData);
        this.lastGray = g;
        this.onThumb(imageData);
        if (!this.ref) continue;
        this.lastDiff = meanAbsDiff(g, this.ref);
        if (this.lastDiff > this.c.presenceThreshold) { this.presentStreak++; this.absentStreak = 0; }
        else { this.absentStreak++; this.presentStreak = 0; }
        if (this.presentStreak >= 2) this.dir.setCasterPresent(true);
        if (this.absentStreak >= 5) this.dir.setCasterPresent(false);
        this.dir.caster.presenceDiff = +this.lastDiff.toFixed(3);
      } catch { /* caméra débranchée : on garde le dernier état */ }
    }
  }

  calibrate() {
    if (!this.lastGray) return false;
    this.ref = this.lastGray;
    fs.mkdirSync(path.dirname(this.refPath), { recursive: true });
    fs.writeFileSync(this.refPath, JSON.stringify({ at: Date.now(), gray: Array.from(this.ref, v => +v.toFixed(3)) }));
    this.dir.caster.presenceCalibrated = true;
    this.dir.addLog('Caméra casters calibrée (siège vide)');
    return true;
  }
}
