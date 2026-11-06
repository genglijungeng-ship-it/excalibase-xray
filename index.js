'use strict';
// Excalibase architecture, read this before changing TLS settings:
//   FLClash --TLS(443)--> Excalibase edge --plaintext WS--> this Node
//   server (listening on $PORT) --plaintext WS--> Xray on 127.0.0.1:INTERNAL.
// Excalibase's edge already terminates TLS and serves *.excalibase.app / container app domain shown in Studio (VERIFY) with HTTPS.
// Putting security=tls inside Xray as well would double-terminate and break
// the handshake, so Xray itself uses security=none on the internal hop only.
// From the client's point of view the connection is still VLESS + WS + TLS,
// with SNI = your *.excalibase.app / container app domain shown in Studio (VERIFY) domain, on port 443.
//
// Required env vars (set in the Excalibase dashboard, Environment tab):
//   UUID    - VLESS user id, e.g. a uuid v4
//   WS_PATH - WebSocket path, must start with /, e.g. /<random-hex>
// Optional:
//   XRAY_VERSION - default v1.8.24 (WS is well supported there; newer
//                  26.x cores deprecate WebSocket transport)
//   INTERNAL_PORT - default 10000, Xray's loopback port only
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Excalibase: no compose file => app defaults to port 3000 or $PORT.
// Keep $PORT authoritative when the platform injects it.
const PORT = Number(process.env.PORT || 3000);
const INTERNAL_PORT = Number(process.env.INTERNAL_PORT || 10000);
const UUID = process.env.UUID;
let WS_PATH = process.env.WS_PATH || '';
if (!UUID) {
  console.error('Missing env var: UUID. Set it in Excalibase before deploying.');
  process.exit(1);
}
if (!WS_PATH.startsWith('/')) WS_PATH = `/${WS_PATH}`;
if (WS_PATH === '/') {
  console.error('WS_PATH must be a non-root path, e.g. /<random-hex>.');
  process.exit(1);
}

const DIR = __dirname;
const BIN = path.join(DIR, 'xray');
const CONFIG = path.join(DIR, 'config.json');

function writeConfig() {
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [{
      port: INTERNAL_PORT,
      listen: '127.0.0.1',
      protocol: 'vless',
      settings: { clients: [{ id: UUID }], decryption: 'none' },
      streamSettings: {
        network: 'ws',
        security: 'none',
        wsSettings: { path: WS_PATH },
      },
    }],
    outbounds: [{ protocol: 'freedom', settings: {} }],
  };
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2));
}

async function ensureBinary() {
  if (fs.existsSync(BIN)) return;
  // postinstall should already have fetched it; this is only a fallback
  // for consoles that skip postinstall on upload.
  console.log('xray binary missing, downloading at startup (slower cold start)');
  const { execFileSync } = require('child_process');
  execFileSync(process.execPath, [path.join(DIR, 'scripts', 'download-xray.js')], { stdio: 'inherit' });
}

function startXray() {
  const child = spawn(BIN, ['-c', CONFIG], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code, signal) => {
    console.error(`xray exited code=${code} signal=${signal}; restarting in 2s`);
    setTimeout(() => startXray(), 2000);
  });
  return child;
}

async function main() {
  writeConfig();
  await ensureBinary();
  startXray();

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
      return;
    }
    if (req.url === '/clash.yaml' || req.url === '/config.yaml') {
      // FLClash (Android) subscription/file import helper. It renders the
      // same VLESS+WS+TLS node from this app's env vars, using the Host
      // header as the server name, so no domain has to be hard-coded here.
      // WARNING: this endpoint returns the node's UUID. It is only for
      // personal import; do not publish the app domain, and remove this
      // endpoint after importing if you want the node to stay private.
      const host = (req.headers.host || '').split(':')[0];
      const yaml = [
        'mixed-port: 7890',
        'allow-lan: false',
        'mode: rule',
        'log-level: info',
        'proxies:',
        '  - name: "Excalibase"',
        '    type: vless',
        `    server: ${host}`,
        '    port: 443',
        `    uuid: ${UUID}`,
        '    network: ws',
        '    tls: true',
        `    servername: ${host}`,
        '    ws-opts:',
        `      path: ${WS_PATH}`,
        '      headers:',
        `        Host: ${host}`,
        'proxy-groups:',
        '  - name: "PROXY"',
        '    type: select',
        '    proxies:',
        '      - "Excalibase"',
        '      - DIRECT',
        'rules:',
        '  - MATCH,PROXY',
        '',
      ].join('\n');
      res.writeHead(200, { 'content-type': 'text/yaml; charset=utf-8' });
      res.end(yaml);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });

  // Forward a WebSocket upgrade to Xray, reconstructing the HTTP request
  // that Node already parsed, then piping the raw socket both ways.
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstream = net.createConnection(INTERNAL_PORT, '127.0.0.1', () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const onErr = () => { try { socket.destroy(); } catch {} try { upstream.destroy(); } catch {} };
    socket.on('error', onErr);
    upstream.on('error', onErr);
  });

  server.listen(PORT, () => {
    console.log(`listening on ${PORT}, forwarding WS ${WS_PATH} to Xray on 127.0.0.1:${INTERNAL_PORT}`);
    console.log('health probe: point any Excalibase health check at /health');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
