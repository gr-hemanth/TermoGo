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
import xtermPkg from '@xterm/xterm';
const { Terminal: VirtualTerminal } = xtermPkg;

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
    cols: s.pty ? s.pty.cols : 120,
    rows: s.pty ? s.pty.rows : 35,
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

export function stripAnsi(str) {
  if (!str) return '';
  return str
    // 1. CSI sequences: ESC [ ... final_byte
    .replace(/\x1b\[[0-9:;<=>?]*[ !"#$%&'()*+,-./]*[@-~]/g, '')
    // 2. OSC sequences: ESC ] ... BEL or ESC \
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // 3. DCS / APC / PM sequences
    .replace(/\x1b[P^_][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // 4. SS2 / SS3 sequences
    .replace(/\x1b[NO][ -~]/g, '')
    // 5. 2-char ESC sequences
    .replace(/\x1b[ %()*+-./][@-~]/g, '')
    .replace(/\x1b[=><#][0-9A-Za-z]/g, '')
    .replace(/\x1b[6-9c-zCEHMNOXYZ]/g, '')
    // 6. Bare ESC
    .replace(/\x1b+/g, '')
    // 7. Non-printable control characters (preserve \t, \n, \r)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function extractCleanResponseFromLines(rawLines) {
  if (!rawLines || rawLines.length === 0) return '';

  const lines = rawLines.map(l => stripAnsi(l || '').trimEnd());

  // 1. Find the bottom-most non-empty line
  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && !lines[lastNonEmpty].trim()) {
    lastNonEmpty--;
  }
  if (lastNonEmpty < 0) return { text: '', isAgy: false };

  // 2. Locate the AGY active input box & footer at the bottom
  // Expected structure at the bottom of an AGY terminal:
  // [optional: model info like "Gemini ... · high"]
  // [optional: "? for shortcuts"]
  // [bottom border: ────────]
  // [prompt: "> " or ">"]
  // [top border: ────────]
  let footerPromptBoxTop = -1;
  let isAgySession = false;

  for (let i = lastNonEmpty; i >= Math.max(0, lastNonEmpty - 8); i--) {
    const line = lines[i].trim();
    // Look for the active prompt line `>` or `> `
    if (/^>\s*$/.test(line)) {
      // Find the border directly above it
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        if (/^[─\-_=━―—\s]{3,}$/.test(lines[j].trim())) {
          footerPromptBoxTop = j;
          isAgySession = true;
          break;
        }
      }
      if (footerPromptBoxTop !== -1) break;
    }
  }

  let responseEndIndex = lastNonEmpty;
  if (isAgySession && footerPromptBoxTop !== -1) {
    responseEndIndex = footerPromptBoxTop - 1;
  } else {
    // If not detected as AGY active prompt box, check if bottom is a shell prompt
    const lastLine = lines[lastNonEmpty].trim();
    if (/^(PS [A-Z]:\\.*>|[a-zA-Z0-9_\-@]+[:#$\s].*[$#>])\s*$/.test(lastLine) || /^>\s*$/.test(lastLine)) {
      responseEndIndex = lastNonEmpty - 1;
    }
  }

  // Trim trailing empty lines
  while (responseEndIndex >= 0 && !lines[responseEndIndex].trim()) {
    responseEndIndex--;
  }
  if (responseEndIndex < 0) return { text: '', isAgy: isAgySession };

  // 3. Scan upwards from responseEndIndex to locate top boundary
  // In AGY, the top boundary is:
  // - Tool execution cards: e.g. "● Bash(...)", "● ReadFile(...)"
  // - Or the user's prompt box: "────────" / "> user prompt" / "────────"
  let responseStartIndex = 0;
  for (let i = responseEndIndex; i >= 0; i--) {
    const line = lines[i].trim();

    // Check if this line is an AGY tool call:
    const isToolCall = /^[●•*]\s+[A-Za-z0-9_]+\s*\(.*\)/.test(line) ||
                       /^[●•*]\s+(Bash|Read|Edit|Write|Task|Glob|Grep|Browse|Run)\b/i.test(line) ||
                       /^\s*└─\s+(exit|status|result)/i.test(line);

    if (isToolCall) {
      responseStartIndex = i + 1;
      break;
    }

    // Check if this line is the bottom border of a user prompt box
    if (/^[─\-_=━―—\s]{10,}$/.test(line)) {
      if (i > 0 && /^>\s+\S+/.test(lines[i - 1].trim())) {
        responseStartIndex = i + 1;
        break;
      }
      responseStartIndex = i + 1;
      break;
    }

    // Check if this line is a user prompt line directly: "> some command"
    if (/^>\s+[a-zA-Z0-9]/.test(line) && (i === 0 || /^[─\-_=━―—\s]{3,}$/.test(lines[i-1]?.trim() || ''))) {
      responseStartIndex = i + 1;
      break;
    }
  }

  // Trim leading empty lines
  while (responseStartIndex <= responseEndIndex && !lines[responseStartIndex].trim()) {
    responseStartIndex++;
  }

  if (responseStartIndex > responseEndIndex) return { text: '', isAgy: isAgySession };

  return {
    text: lines.slice(responseStartIndex, responseEndIndex + 1).join('\n').trim(),
    isAgy: isAgySession
  };
}

export function extractFromTerminal(term) {
  if (!term || !term.buffer || !term.buffer.active) return { text: '', isAgy: false };
  const buffer = term.buffer.active;
  const lines = [];

  for (let i = 0; i < buffer.length; i++) {
    const lineObj = buffer.getLine(i);
    if (!lineObj) continue;
    const str = lineObj.translateToString(true);
    if (lineObj.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += str;
    } else {
      lines.push(str);
    }
  }

  return extractCleanResponseFromLines(lines);
}

function cleanTerminalOutput(raw) {
  return stripAnsi(raw);
}

function getHistorySlice(session, fromOffset) {
  const effectiveOffset = Math.max(session.historyStartOffset, fromOffset);
  const skipChars = effectiveOffset - session.historyStartOffset;

  let currentPos = 0;
  const resultChunks = [];

  for (const chunk of session.history) {
    const chunkEnd = currentPos + chunk.length;
    if (chunkEnd <= skipChars) {
      currentPos = chunkEnd;
      continue;
    }
    if (currentPos < skipChars) {
      const sliceStart = skipChars - currentPos;
      resultChunks.push(chunk.slice(sliceStart));
    } else {
      resultChunks.push(chunk);
    }
    currentPos = chunkEnd;
  }

  return resultChunks.join('');
}

function getLastInteraction(session) {
  if (!session) return { id: '', command: '', text: '' };

  let cleanText = '';

  // 1. If this session is running an AGY interaction, use virtual terminal TUI extractor
  if (session.virtualTerm) {
    const agyExtract = extractFromTerminal(session.virtualTerm);
    if (agyExtract.isAgy && agyExtract.text) {
      cleanText = agyExtract.text;
    }
  }

  // 2. For regular shell sessions (PowerShell/CMD/Bash), use exact command boundary slice
  if (!cleanText && session.history.length > 0) {
    const rawSlice = getHistorySlice(session, session.lastCommandStartOffset);
    let sliceText = stripAnsi(rawSlice);
    sliceText = sliceText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

    const cleanCmd = session.lastCommandInput
      ? session.lastCommandInput.replace(/[\r\n]+/g, '\n').trim()
      : '';

    if (cleanCmd && !sliceText.includes(cleanCmd)) {
      sliceText = cleanCmd + (sliceText ? '\n' + sliceText : '');
    }
    cleanText = sliceText;
  }

  // 3. Fallback to general virtual term extraction if slice was empty
  if (!cleanText && session.virtualTerm) {
    const fallback = extractFromTerminal(session.virtualTerm);
    cleanText = fallback.text || '';
  }

  const cleanCmd = session.lastCommandInput
    ? session.lastCommandInput.replace(/[\r\n]+/g, '\n').trim()
    : '';

  return {
    id: session.id,
    title: session.title,
    command: cleanCmd,
    text: cleanText
  };
}

function handleSessionInput(session, data) {
  if (!data || typeof data !== 'string') return;

  // Ctrl+C or Ctrl+Z: current command is cancelled
  if (data.includes('\x03') || data.includes('\x1a')) {
    session.awaitingCommandStart = true;
    session.lastCommandInput = '';
    return;
  }

  // If waiting for the start of a new command
  if (session.awaitingCommandStart) {
    // Filter out standalone non-input control codes (like bare ESC or null)
    const isPureControl = data.length === 1 && data.charCodeAt(0) < 32 && data !== '\r' && data !== '\n' && data !== '\t';
    if (!isPureControl) {
      session.lastCommandStartOffset = session.totalOutputLength;
      session.lastCommandInput = '';
      session.awaitingCommandStart = false;
    }
  }

  session.lastCommandInput += data;

  // If the input contains a carriage return or newline, the command was submitted
  if (data.includes('\r') || data.includes('\n')) {
    session.awaitingCommandStart = true;
  }
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

  const virtualTerm = new VirtualTerminal({
    cols: 120,
    rows: 35,
    scrollback: 5000,
    allowProposedApi: true
  });

  let pendingOutput = '';
  let flushTimer = null;

  function flushOutput() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingOutput) return;
    const dataToSend = pendingOutput;
    pendingOutput = '';
    const message = JSON.stringify({ type: 'output', data: dataToSend });
    for (const ws of session.clients) {
      if (ws.readyState === 1) ws.send(message);
    }
  }

  const session = {
    id,
    title,
    shell: shell.file,
    pty: term,
    virtualTerm,
    createdAt: new Date().toISOString(),
    clients: new Set(),
    history: [],
    historyBytes: 0,
    historyStartOffset: 0,
    totalOutputLength: 0,
    lastCommandStartOffset: 0,
    lastCommandInput: '',
    awaitingCommandStart: true,
    exited: false,
    flushOutput
  };

  sessions.set(id, session);

  term.onData(data => {
    // 1. Maintain virtual terminal state for accurate TUI parsing
    try { session.virtualTerm.write(data); } catch {}

    // 2. Append to rolling scrollback buffer (raw stream untouched)
    session.history.push(data);
    session.historyBytes += Buffer.byteLength(data, 'utf8');
    session.totalOutputLength += data.length;

    while (session.historyBytes > MAX_HISTORY_BYTES && session.history.length > 1) {
      const removed = session.history.shift();
      session.historyBytes -= Buffer.byteLength(removed, 'utf8');
      session.historyStartOffset += removed.length;
    }

    // 3. Coalesce rapid PTY output chunks into 8ms micro-batches
    // Preserves ordering, ANSI/VT escape sequences, eliminates mobile event-loop flooding
    pendingOutput += data;
    if (pendingOutput.length >= 4096) {
      flushOutput();
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushOutput, 8);
    }
  });

  term.onExit(({ exitCode }) => {
    flushOutput();
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
    console.log(`[WS] Session attached: "${session.title}" (PID: ${session.pty.pid}, ${session.pty.cols}x${session.pty.rows})`);

    // Flush any pending coalesced output before sending state
    if (typeof session.flushOutput === 'function') {
      session.flushOutput();
    }

    // Send ready event with session details including OS PID and dimensions
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

        // Synchronize terminal dimensions BEFORE attaching and sending history
        if (msg.cols && msg.rows) {
          const cols = Math.max(20, Math.min(300, Number(msg.cols) || 120));
          const rows = Math.max(5, Math.min(100, Number(msg.rows) || 35));
          if (targetSession.pty && (targetSession.pty.cols !== cols || targetSession.pty.rows !== rows)) {
            try {
              targetSession.pty.resize(cols, rows);
              targetSession.virtualTerm.resize(cols, rows);
            } catch {}
          }
        }

        attachToSession(targetSession);
        return;
      }

      if (!authenticated || !attachedSession) {
        return; // Reject messages prior to authentication
      }

      if (msg.type === 'input' && typeof msg.data === 'string') {
        handleSessionInput(attachedSession, msg.data);
        attachedSession.pty.write(msg.data);
      } else if (msg.type === 'resize') {
        const cols = Math.max(20, Math.min(300, Number(msg.cols) || 120));
        const rows = Math.max(5, Math.min(100, Number(msg.rows) || 35));
        if (attachedSession.pty && (attachedSession.pty.cols !== cols || attachedSession.pty.rows !== rows)) {
          attachedSession.pty.resize(cols, rows);
          try { attachedSession.virtualTerm.resize(cols, rows); } catch {}
        }
      } else if (msg.type === 'copy_last' || msg.type === 'get_last_interaction') {
        const interaction = getLastInteraction(attachedSession);
        ws.send(JSON.stringify({
          type: 'last_interaction',
          ...interaction
        }));
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

app.get('/api/sessions/:id/last-interaction', (req, res) => {
  const reqToken = req.get('x-auth-token') || req.query.token || '';
  if (!safeEqual(reqToken, TOKEN)) return res.status(401).json({ error: 'Unauthorized' });
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(getLastInteraction(session));
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

  for (const clientWs of session.clients) {
    try {
      clientWs.send(JSON.stringify({ type: 'exit', exitCode: 0, reason: 'deleted' }));
      clientWs.close(1000, 'Session deleted');
    } catch {}
  }
  session.clients.clear();

  try {
    session.pty.kill();
  } catch (err) {
    console.warn(`[DELETE] PTY kill error for session ${session.id}:`, err?.message || err);
  }
  sessions.delete(session.id);
  console.log(`[DELETE] Session "${session.title}" (${session.id}) terminated and removed.`);
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
