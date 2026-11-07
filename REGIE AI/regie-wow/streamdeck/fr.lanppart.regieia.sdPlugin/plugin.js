/*
 * Plugin Stream Deck « Régie IA » : un simple écran pour la régie.
 * Il ne contient ni touche, ni lien, ni commande : la régie (src/streamdeck.js) envoie ce qu'il faut dessiner à chaque
 * position, et le plugin lui renvoie les appuis. Seule l'adresse de la régie est ici, réglable dans l'inspecteur.
 *
 * Le logiciel Stream Deck fait tourner cette page cachée, où Chromium ralentit les minuteries :
 * la reconnexion est rythmée par un Worker, qui lui n'est pas ralenti.
 */
(function () {
    'use strict';
    var ADRESSE_DEFAUT = '127.0.0.1:8081', TAILLE = 144;
    var sd = null, regie = null, adresse = ADRESSE_DEFAUT;
    var touches = {};      // context → { col, row, signature }
    var recues = {};       // "col,row" → ce que la régie demande d'afficher
    var vignettes = {};    // identifiant → Image
    var versionVignettes = {};

    // ---------- Logiciel Stream Deck ----------
    function versSd(o) { if (sd && sd.readyState === 1) sd.send(JSON.stringify(o)); }

    window.connectElgatoStreamDeckSocket = function (port, uuid, inscription) {
        sd = new WebSocket('ws://127.0.0.1:' + port);
        sd.onopen = function () {
            versSd({ event: inscription, uuid: uuid });
            versSd({ event: 'getGlobalSettings', context: uuid });
        };
        sd.onmessage = function (m) {
            var d = JSON.parse(m.data), p = d.payload || {};
            if (d.event === 'didReceiveGlobalSettings') changerAdresse((p.settings || {}).adresse);
            else if (d.event === 'willAppear') { touches[d.context] = { col: p.coordinates.column, row: p.coordinates.row, signature: null }; dessiner(d.context); }
            else if (d.event === 'willDisappear') delete touches[d.context];
            else if (d.event === 'keyDown') appui(d.context);
        };
    };

    function appui(ctx) {
        var t = touches[ctx];
        if (!t) return;
        var k = recues[t.col + ',' + t.row];
        if (regie && regie.readyState === 1 && k && !k.off) regie.send(JSON.stringify({ cmd: 'press', col: t.col, row: t.row }));
        else if (!k || !k.off) versSd({ event: 'showAlert', context: ctx });
    }

    // ---------- Régie ----------
    function changerAdresse(a) {
        a = String(a || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '') || ADRESSE_DEFAUT;
        if (a === adresse && regie) return;
        adresse = a;
        if (regie) { var r = regie; regie = null; r.onclose = null; r.close(); }
        recues = {};
        connecter();
        tout();
    }

    function connecter() {
        if (regie) return;
        var r;
        try { r = new WebSocket('ws://' + adresse + '/ws?role=streamdeck'); } catch (e) { return; }
        regie = r;
        r.onmessage = function (m) {
            var d = JSON.parse(m.data);
            if (d.type === 'deckKeys') { recues = d.keys; tout(); }
            else if (d.type === 'thumbs') { for (var id in d.thumbs) vignette(id, d.thumbs[id]); }
            else if (d.type === 'casterThumb') vignette('caster', d.uri);
            else if (d.type === 'roomThumb') vignette('room', d.uri);
        };
        r.onclose = function () { if (regie === r) regie = null; recues = {}; tout(); };
        r.onerror = function () { r.close(); };
    }

    function vignette(id, uri) {
        var img = new Image();
        img.onload = function () { vignettes[id] = img; versionVignettes[id] = (versionVignettes[id] || 0) + 1; tout(); };
        img.src = uri;
    }

    var tic = new Worker(URL.createObjectURL(new Blob(['setInterval(function () { postMessage(0); }, 1500);'], { type: 'text/javascript' })));
    tic.onmessage = function () { if (!regie && Object.keys(touches).length) connecter(); };

    // ---------- Dessin ----------
    var canvas = document.createElement('canvas'); canvas.width = canvas.height = TAILLE;
    var c = canvas.getContext('2d');
    var POLICE = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

    function texte(t, x, y, taille, couleur, graisse, aligne) {
        c.font = (graisse || 400) + ' ' + taille + 'px ' + POLICE;
        c.fillStyle = couleur; c.textAlign = aligne || 'center'; c.textBaseline = 'middle';
        c.fillText(t, x, y);
    }
    function lignes(t, largeur, max, taille, graisse) {
        c.font = (graisse || 400) + ' ' + taille + 'px ' + POLICE;
        var mots = String(t || '').split(/\s+/).filter(Boolean), res = [], cur = '';
        for (var i = 0; i < mots.length; i++) {
            var essai = cur ? cur + ' ' + mots[i] : mots[i];
            if (c.measureText(essai).width <= largeur || !cur) cur = essai; else { res.push(cur); cur = mots[i]; }
        }
        if (cur) res.push(cur);
        if (res.length > max) { res = res.slice(0, max); res[max - 1] += '…'; }
        return res.map(function (l) {
            if (c.measureText(l).width <= largeur) return l;
            while (l.length > 1 && c.measureText(l + '…').width > largeur) l = l.replace(/…$/, '').slice(0, -1);
            return l.replace(/…?$/, '…');
        });
    }
    function bloc(t, y, taille, couleur, graisse, max) {
        var l = lignes(t, 126, max, taille, graisse), h = taille * 1.15;
        l.forEach(function (x, i) { texte(x, 72, y + (i - (l.length - 1) / 2) * h, taille, couleur, graisse); });
    }

    function image(k) {
        c.globalAlpha = 1; c.clearRect(0, 0, TAILLE, TAILLE);
        c.fillStyle = k.bg; c.fillRect(0, 0, TAILLE, TAILLE);
        var img = k.thumb && vignettes[k.thumb];
        if (img) {
            var e = Math.max(TAILLE / img.width, TAILLE / img.height), w = img.width * e, h = img.height * e;
            c.globalAlpha = k.dim ? 0.25 : 1;
            c.drawImage(img, (TAILLE - w) / 2, (TAILLE - h) / 2, w, h);
            c.globalAlpha = 1;
            var g = c.createLinearGradient(0, 70, 0, 144);
            g.addColorStop(0, 'rgba(5,7,13,0)'); g.addColorStop(0.5, 'rgba(5,7,13,0.9)'); g.addColorStop(1, 'rgba(5,7,13,0.95)');
            c.fillStyle = g; c.fillRect(0, 70, TAILLE, 74);
        }
        var bandeau = k.num || k.tag;
        if (k.num) { c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(8, 8, 30, 26); texte(k.num, 23, 22, 18, INK(k), 700); }
        if (k.tag) texte(k.tag, k.num ? 136 : 72, 22, 14, k.tagFg, 700, k.num ? 'right' : 'center');
        if (k.dot) { c.fillStyle = k.dot; c.beginPath(); c.arc(72, 42, 11, 0, 7); c.fill(); }

        var taille = k.small ? 19 : 26, enBas = !!(k.num || img);
        if (enBas) {
            bloc(k.label, k.sub ? 102 : 116, 22, k.fg, 700, 1);
            if (k.sub) bloc(k.sub, 124, 15, k.subFg, 500, 1);
        } else if (k.dot) {
            bloc(k.label, 84, taille, k.fg, 700, 2);
            if (k.sub) bloc(k.sub, 116, 18, k.subFg, 600, 1);
        } else {
            var yTitre = bandeau ? 72 : k.sub ? 58 : 72;
            bloc(k.label, yTitre, taille, k.fg, 700, k.small ? 3 : 2);
            if (k.sub) bloc(k.sub, 112, 16, k.subFg, 500, 2);
        }
        if (k.interest > 0) { c.fillStyle = '#35e6ff'; c.fillRect(0, 138, 144 * k.interest, 6); }
        c.strokeStyle = k.border; var ep = k.heavy ? 8 : 3; c.lineWidth = ep;
        c.strokeRect(ep / 2, ep / 2, TAILLE - ep, TAILLE - ep);
        return canvas.toDataURL('image/png');
    }
    function INK(k) { return k.fg; }

    function horsLigne(t) {
        c.globalAlpha = 1;
        c.fillStyle = '#05070d'; c.fillRect(0, 0, TAILLE, TAILLE);
        if (t.col === 0 && t.row === 0) {
            c.strokeStyle = '#ff4470'; c.lineWidth = 4; c.strokeRect(2, 2, TAILLE - 4, TAILLE - 4);
            texte('RÉGIE', 72, 42, 24, '#e8ecf5', 700);
            texte('HORS LIGNE', 72, 74, 18, '#ff4470', 700);
            lignes(adresse, 128, 1, 13, 400).forEach(function (l) { texte(l, 72, 108, 13, '#8c98b8', 400); });
        }
        return canvas.toDataURL('image/png');
    }

    function dessiner(ctx) {
        var t = touches[ctx]; if (!t) return;
        var k = recues[t.col + ',' + t.row];
        var connecte = regie && regie.readyState === 1 && Object.keys(recues).length;
        var sig = !connecte ? 'hors|' + adresse + '|' + t.col + '|' + t.row : k ? JSON.stringify(k) + (k.thumb ? '|' + (versionVignettes[k.thumb] || 0) : '') : 'vide';
        if (sig === t.signature) return;
        t.signature = sig;
        var img;
        if (!connecte) img = horsLigne(t);
        else if (k) img = image(k);
        else { c.fillStyle = '#05070d'; c.fillRect(0, 0, TAILLE, TAILLE); img = canvas.toDataURL('image/png'); }
        versSd({ event: 'setImage', context: ctx, payload: { image: img, target: 0 } });
    }
    function tout() { Object.keys(touches).forEach(dessiner); }
})();
