const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = 8080;
const MTX_API   = 'http://127.0.0.1:9997/v3/paths/list';
const DASHBOARD = path.join(__dirname, 'dashboard.html');

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/paths') {
    try {
      const r    = await fetch(MTX_API);
      const data = await r.json();
      const body = JSON.stringify(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch (e) {
      res.writeHead(502);
      res.end('MediaMTX non accessible');
    }
  } else {
    const html = fs.readFileSync(DASHBOARD);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Dashboard → http://127.0.0.1:${PORT} (et sur l'IP LAN)`);
});
