import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import qrcode from 'qrcode-terminal';
import { startTunnel } from './tunnel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

// Generate secure random token if default or not provided
let TOKEN = process.env.AUTH_TOKEN;
let isGeneratedToken = false;
if (!TOKEN || TOKEN === 'change-this-token') {
  TOKEN = crypto.randomBytes(16).toString('hex');
  isGeneratedToken = true;
}

const MAX_HISTORY_BYTES = 128 * 1024; // 128KB scrollback buffer per session
const sessions = new Map();

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const hasHeader = !!req.get('x-auth-token');
    const hasQuery = !!req.query?.token;
    const tokenValid = (hasHeader && safeEqual(req.get('x-auth-token'), TOKEN)) || (hasQuery && safeEqual(req.query.token, TOKEN));
    const authStatus = tokenValid ? 'authenticated=true' : (hasHeader || hasQuery) ? 'authenticated=false(invalid)' : 'authenticated=false(none)';
    console.log(`[HTTP] ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode} ${authStatus} (${Date.now() - start}ms)`);
  });
  next();
});

app.use(express.static(path.join(root, 'web')));

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function sessionSummary(s) {
  return {
    id: s.id,
    title: s.title,
    shell: s.shell,
    pid: s.pty ? s.pty.pid : null,
    createdAt: s.createdAt,
    clientCount: s.clients.size,
    status: s.exited ? 'exited' : 'running'
  };
}

function spawnShell() {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'powershell.exe', args: [] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] };
}

function createSession(title = 'Terminal') {
  const id = crypto.randomUUID();
  const shell = spawnShell();
  const term = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 35,
    cwd: process.env.USERPROFILE || process.cwd(),
    env: process.env
  });

  const session = {
    id,
    title,
    shell: shell.file,
    pty: term,
    createdAt: new Date().toISOString(),
    clients: new Set(),
    history: [],
    historyBytes: 0,
    exited: false
  };

  sessions.set(id, session);

  term.onData(data => {
    // Append to rolling scrollback buffer
    session.history.push(data);
    session.historyBytes += Buffer.byteLength(data, 'utf8');

    while (session.historyBytes > MAX_HISTORY_BYTES && session.history.length > 1) {
      const removed = session.history.shift();
      session.historyBytes -= Buffer.byteLength(removed, 'utf8');
    }

    // Broadcast to all active clients of this session
    const message = JSON.stringify({ type: 'output', data });
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(message);
    }
  });

  term.onExit(({ exitCode }) => {
    session.exited = true;
    const message = JSON.stringify({ type: 'exit', exitCode });
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(message);
    }
    sessions.delete(id);
  });

  return session;
}

// Upgrade handler: Allow WebSocket upgrade and authenticate either via query/header or via first message
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');
  const protocolHeader = req.headers['sec-websocket-protocol'];

  // If token is provided in upgrade request, check it; otherwise permit upgrade and authenticate via first message
  if (queryToken && !safeEqual(queryToken, TOKEN)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  if (protocolHeader && !safeEqual(protocolHeader, TOKEN)) {
    // If protocol header is present but doesn't match
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  console.log(`[WS] Upgrade request on ${url.pathname}`);

  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const queryToken = url.searchParams.get('token');
  const querySessionId = url.searchParams.get('session');

  console.log(`[WS] Connection established on ${url.pathname}`);

  let authenticated = queryToken && safeEqual(queryToken, TOKEN);
  let attachedSession = querySessionId ? sessions.get(querySessionId) : null;

  // Timeout unauthenticated connections after 5 seconds
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      try {
        console.log('[WS] Auth timeout: client failed to authenticate within 5s');
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication timeout' }));
        ws.close(4401, 'Unauthorized');
      } catch {}
    }
  }, 5000);

  function attachToSession(session) {
    clearTimeout(authTimeout);
    attachedSession = session;
    session.clients.add(ws);
    console.log(`[WS] Session attached: "${session.title}" (PID: ${session.pty.pid})`);

    // Send ready event with session details including OS PID
    ws.send(JSON.stringify({
      type: 'ready',
      session: sessionSummary(session)
    }));

    // Replay scrollback buffer so client immediately gets the current terminal screen
    if (session.history.length > 0) {
      ws.send(JSON.stringify({
        type: 'history',
        data: session.history.join('')
      }));
    }
  }

  if (authenticated && attachedSession) {
    attachToSession(attachedSession);
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());

      // Handle in-payload authentication (zero token in URL)
      if (msg.type === 'auth') {
        const isValid = safeEqual(msg.token, TOKEN);
        console.log(`[WS] Auth message received: valid=${isValid}, targetSession=${msg.session}`);
        if (!isValid) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid authentication token' }));
          ws.close(4401, 'Unauthorized');
          return;
        }
        authenticated = true;
        const targetSession = sessions.get(msg.session);
        if (!targetSession) {
          console.log(`[WS] Session not found: ${msg.session}`);
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          ws.close();
          return;
        }
        attachToSession(targetSession);
        return;
      }

      if (!authenticated || !attachedSession) {
        return; // Reject messages prior to authentication
      }

      if (msg.type === 'input' && typeof msg.data === 'string') {
        attachedSession.pty.write(msg.data);
      } else if (msg.type === 'resize') {
        const cols = Math.max(20, Math.min(300, Number(msg.cols) || 120));
        const rows = Math.max(5, Math.min(100, Number(msg.rows) || 35));
        attachedSession.pty.resize(cols, rows);
      }
    } catch {
      // Ignore malformed client messages.
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (attachedSession) {
      attachedSession.clients.delete(ws);
      // attachedSession.pty continues running undisturbed on the laptop
    }
  });
});

app.get('/api/sessions', (req, res) => {
  const reqToken = req.get('x-auth-token') || req.query.token || '';
  if (!safeEqual(reqToken, TOKEN)) return res.status(401).json({ error: 'Unauthorized' });
  res.json([...sessions.values()].map(sessionSummary));
});

app.post('/api/sessions', express.json(), (req, res) => {
  const reqToken = req.get('x-auth-token') || req.query.token || '';
  if (!safeEqual(reqToken, TOKEN)) return res.status(401).json({ error: 'Unauthorized' });
  const count = sessions.size + 1;
  const title = typeof req.body?.title === 'string' && req.body.title.trim()
    ? req.body.title.trim().slice(0, 80)
    : `Terminal ${count}`;
  const session = createSession(title);
  res.status(201).json(sessionSummary(session));
});

app.delete('/api/sessions/:id', (req, res) => {
  const reqToken = req.get('x-auth-token') || req.query.token || '';
  if (!safeEqual(reqToken, TOKEN)) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  session.pty.kill();
  sessions.delete(session.id);
  res.status(204).end();
});

// Create initial default persistent sessions
const defaultSession1 = createSession('PowerShell');
const defaultSession2 = createSession('AGY');

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

export function startServer({ port = PORT, host = HOST, enableTunnel = process.env.TUNNEL !== 'false' } = {}) {
  return new Promise((resolve, reject) => {
    server.listen(port, host, async () => {
      const localIp = getLocalIp();
      console.log('\n============================================================');
      console.log('                 TermBridge Server Started                  ');
      console.log('============================================================');
      console.log(`Local Access:        http://localhost:${port}`);
      console.log(`LAN Access:          http://${localIp}:${port}`);
      console.log(`Auth Token:          ${TOKEN} ${isGeneratedToken ? '(Auto-generated secure token)' : '(Configured in environment)'}`);
      console.log(`Persistent Sessions: 2 active (${defaultSession1.title} [PID: ${defaultSession1.pty.pid}], ${defaultSession2.title} [PID: ${defaultSession2.pty.pid}])`);
      console.log('------------------------------------------------------------');

      let tunnel = null;
      let publicUrl = null;
      let pairingUrl = null;

      if (enableTunnel) {
        console.log('Starting Cloudflare Tunnel for Internet Access...');
        try {
          tunnel = startTunnel({ port });
          publicUrl = await tunnel.url;
          pairingUrl = `${publicUrl}/#token=${TOKEN}`;

          console.log('\n============================================================');
          console.log('               INTERNET REMOTE ACCESS READY                 ');
          console.log('============================================================');
          console.log(`Public URL:          ${publicUrl}`);
          console.log(`Direct Pairing Link: ${pairingUrl}`);
          console.log('------------------------------------------------------------');
          console.log('Scan this QR code with your phone camera to connect:');
          qrcode.generate(pairingUrl, { small: true }, qr => console.log(qr));
          console.log('============================================================\n');
        } catch (err) {
          console.warn(`[Tunnel Warning] Cloudflare Tunnel failed: ${err.message}`);
          console.log('TermBridge is still running locally and over LAN.');
        }
      } else {
        console.log('Tunnel disabled via TUNNEL=false. Running local only.\n');
      }

      resolve({
        server,
        port,
        token: TOKEN,
        publicUrl,
        pairingUrl,
        tunnel,
        sessions,
        stop: () => {
          if (tunnel) tunnel.stop();
          server.close();
        }
      });
    });
    server.on('error', reject);
  });
}

// Auto-start if run directly
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  startServer().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
