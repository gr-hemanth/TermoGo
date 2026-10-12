import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
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

// Auto-load .env file consistently across all execution modes
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn('[TermBridge] Warning: Failed to load .env file:', err.message);
  }
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

export const KNOWN_DEFAULT_TOKENS = new Set([
  'change-this-token',
  'admin',
  'password',
  'root',
  '12345678',
  'secret',
  'termbridge'
]);

export function shouldDisplayToken() {
  if (process.env.DISPLAY_TOKEN === 'false') return false;
  if (process.env.DISPLAY_TOKEN === 'true') return true;
  if (process.env.IS_DAEMON === 'true' || process.env.DAEMON === 'true') return false;
  return Boolean(process.stdout.isTTY);
}

export function normalizeToken(t) {
  if (!t || typeof t !== 'string') return '';
  return t.trim().replace(/^["']|["']$/g, '').trim();
}

export function ensureStableToken({ envFilePath = envPath } = {}) {
  let envContent = '';
  let envFileExists = false;
  try {
    if (fs.existsSync(envFilePath)) {
      envContent = fs.readFileSync(envFilePath, 'utf8');
      envFileExists = true;
    }
  } catch {}

  // Heal accidental line concatenations (e.g. TUNNEL=trueAUTH_TOKEN=...)
  if (/([^\r\n])AUTH_TOKEN\s*=/.test(envContent)) {
    envContent = envContent.replace(/([^\r\n])AUTH_TOKEN\s*=/g, '$1\nAUTH_TOKEN=');
    try { fs.writeFileSync(envFilePath, envContent, 'utf8'); } catch {}
  }

  const authLineRegex = /^(\s*AUTH_TOKEN\s*=)(.*)$/m;
  const match = envContent.match(authLineRegex);
  const envTokenVal = match ? normalizeToken(match[2]) : null;

  const candidate = envFilePath === envPath
    ? normalizeToken(process.env.AUTH_TOKEN || envTokenVal)
    : envTokenVal;
  const isCandidateDefault = candidate && KNOWN_DEFAULT_TOKENS.has(candidate.toLowerCase());

  // 1. If a valid, non-empty, non-default token exists, keep it without changing .env
  if (candidate && !isCandidateDefault) {
    if (envFilePath === envPath) {
      process.env.AUTH_TOKEN = candidate;
    }
    return { token: candidate, generated: false };
  }

  // 2. Generate a cryptographically secure 32-character hex token (128-bit)
  const generatedToken = crypto.randomBytes(16).toString('hex');
  if (envFilePath === envPath) {
    process.env.AUTH_TOKEN = generatedToken;
  }

  // 3. Persist into target .env file preserving existing settings & comments
  try {
    if (envFileExists) {
      if (authLineRegex.test(envContent)) {
        envContent = envContent.replace(authLineRegex, `AUTH_TOKEN=${generatedToken}`);
      } else {
        const separator = envContent.length > 0 && !envContent.endsWith('\n') ? '\n' : '';
        envContent += `${separator}AUTH_TOKEN=${generatedToken}\n`;
      }
      fs.writeFileSync(envFilePath, envContent, 'utf8');
    } else {
      const examplePath = path.join(path.dirname(envFilePath), '.env.example');
      if (fs.existsSync(examplePath)) {
        let template = fs.readFileSync(examplePath, 'utf8');
        if (authLineRegex.test(template)) {
          template = template.replace(authLineRegex, `AUTH_TOKEN=${generatedToken}`);
        } else {
          template += `\nAUTH_TOKEN=${generatedToken}\n`;
        }
        fs.writeFileSync(envFilePath, template, 'utf8');
      } else {
        const defaultEnv = `PORT=8787\nHOST=0.0.0.0\nTUNNEL=false\nAUTH_TOKEN=${generatedToken}\n`;
        fs.writeFileSync(envFilePath, defaultEnv, 'utf8');
      }
    }
    console.log('[TermBridge] Generated secure access token and saved to .env for persistence.');
  } catch (err) {
    console.warn('[TermBridge Warning] Could not persist AUTH_TOKEN to .env:', err.message);
  }

  return { token: generatedToken, generated: true };
}

// Ensure stable token across restarts (loads from .env or generates & saves to .env)
const tokenResult = ensureStableToken();
let TOKEN = normalizeToken(tokenResult.token);
let isGeneratedToken = tokenResult.generated;

const MAX_HISTORY_BYTES = 128 * 1024; // 128KB scrollback buffer per session
const MAX_SESSIONS = 15;
const sessions = new Map();

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const key = crypto.randomBytes(32);
  const ha = crypto.createHmac('sha256', key).update(a).digest();
  const hb = crypto.createHmac('sha256', key).update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Single-use short-lived connection tickets (30s lifetime)
const tickets = new Map();

export function createTicket(ttlMs = 30000) {
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, { expiresAt: Date.now() + ttlMs });
  return ticket;
}

export function consumeTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') return false;
  const entry = tickets.get(ticket);
  if (!entry) return false;
  tickets.delete(ticket); // single use
  return Date.now() <= entry.expiresAt;
}

setInterval(() => {
  const now = Date.now();
  for (const [t, data] of tickets.entries()) {
    if (now > data.expiresAt) tickets.delete(t);
  }
}, 60000).unref();

// In-memory rate limiting (Zero dependency)
const authFailures = new Map();
const sessionCreations = new Map();

export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded && typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

export function checkAuthRateLimit(ip) {
  const record = authFailures.get(ip);
  if (!record) return true;
  const now = Date.now();
  if (record.lockedUntil && now < record.lockedUntil) return false;
  if (record.lockedUntil && now >= record.lockedUntil) {
    authFailures.delete(ip);
    return true;
  }
  return true;
}

export function recordAuthFailure(ip) {
  const now = Date.now();
  const record = authFailures.get(ip) || { count: 0, firstFail: now, lockedUntil: 0 };
  if (now - record.firstFail > 60000) {
    record.count = 1;
    record.firstFail = now;
    record.lockedUntil = 0;
  } else {
    record.count++;
  }
  if (record.count >= 10) {
    record.lockedUntil = now + 60000;
  }
  authFailures.set(ip, record);
}

export function recordAuthSuccess(ip) {
  authFailures.delete(ip);
}

export function checkSessionCreationRateLimit(ip) {
  const now = Date.now();
  const record = sessionCreations.get(ip);
  if (!record || now >= record.resetAt) {
    sessionCreations.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (record.count >= 10) {
    return false;
  }
  record.count++;
  return true;
}

export function sanitizeLogUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  return urlStr.replace(/([?&](token|ticket)=)[^&]+/gi, '$1[REDACTED]');
}

export function isOriginAllowed(originHeader, hostHeader) {
  if (!originHeader) return true;
  try {
    const originUrl = new URL(originHeader);
    const hostHeaderLower = (hostHeader || '').toLowerCase();
    const originHostLower = originUrl.host.toLowerCase();

    if (originHostLower === hostHeaderLower) return true;

    const originHostname = originUrl.hostname.toLowerCase();
    if (originHostname === 'localhost' || originHostname === '127.0.0.1' || originHostname === '::1') {
      return true;
    }

    const localIp = getLocalIp();
    if (originHostname === localIp) return true;

    if (originHostname.endsWith('.trycloudflare.com')) {
      return originHostLower === hostHeaderLower;
    }

    return false;
  } catch {
    return false;
  }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidSessionId(id) {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const headerToken = normalizeToken(req.get('x-auth-token'));
    const queryToken = normalizeToken(req.query?.token);
    const hasHeader = !!headerToken;
    const hasQuery = !!queryToken;
    const tokenValid = (hasHeader && safeEqual(headerToken, TOKEN)) || (hasQuery && safeEqual(queryToken, TOKEN));
    const authStatus = tokenValid ? 'authenticated=true' : (hasHeader || hasQuery) ? 'authenticated=false(invalid)' : 'authenticated=false(none)';
    const cleanUrl = sanitizeLogUrl(req.originalUrl || req.url);
    console.log(`[HTTP] ${req.method} ${cleanUrl} -> ${res.statusCode} ${authStatus} (${Date.now() - start}ms)`);
  });
  next();
});

// Protect against unexpected cross-origin access
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && !isOriginAllowed(origin, req.get('host'))) {
    console.warn(`[HTTP] Blocked cross-origin request from origin: ${origin}`);
    return res.status(403).json({ error: 'Cross-origin access forbidden' });
  }
  next();
});

app.use(express.static(path.join(root, 'web')));
app.use(express.json({ limit: '32kb' }));

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

function spawnShell(title = '') {
  if (process.platform === 'win32') {
    const lower = (title || '').toLowerCase();
    if (lower.includes('cmd')) {
      return { file: process.env.ComSpec || 'cmd.exe', args: [] };
    }
    return { file: 'powershell.exe', args: ['-NoLogo'] };
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] };
}

export function stripAnsi(str) {
  if (!str) return '';
  return str
    .replace(/\x1b\[[0-9:;<=>?]*[ !"#$%&'()*+,-./]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[P^_][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[NO][ -~]/g, '')
    .replace(/\x1b[ %()*+-./][@-~]/g, '')
    .replace(/\x1b[=><#][0-9A-Za-z]/g, '')
    .replace(/\x1b[6-9c-zCEHMNOXYZ]/g, '')
    .replace(/\x1b+/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export function extractCleanResponseFromLines(rawLines) {
  if (!rawLines || rawLines.length === 0) return '';
  const lines = rawLines.map(l => stripAnsi(l || '').trimEnd());

  let lastNonEmpty = lines.length - 1;
  while (lastNonEmpty >= 0 && !lines[lastNonEmpty].trim()) {
    lastNonEmpty--;
  }
  if (lastNonEmpty < 0) return { text: '', isAgy: false };

  let footerPromptBoxTop = -1;
  let isAgySession = false;

  for (let i = lastNonEmpty; i >= Math.max(0, lastNonEmpty - 8); i--) {
    const line = lines[i].trim();
    if (/^>\s*$/.test(line)) {
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
    const lastLine = lines[lastNonEmpty].trim();
    if (/^(PS [A-Z]:\\.*>|[a-zA-Z0-9_\-@]+[:#$\s].*[$#>])\s*$/.test(lastLine) || /^>\s*$/.test(lastLine)) {
      responseEndIndex = lastNonEmpty - 1;
    }
  }

  while (responseEndIndex >= 0 && !lines[responseEndIndex].trim()) {
    responseEndIndex--;
  }
  if (responseEndIndex < 0) return { text: '', isAgy: isAgySession };

  let responseStartIndex = 0;
  for (let i = responseEndIndex; i >= 0; i--) {
    const line = lines[i].trim();
    const isToolCall = /^[●•*]\s+[A-Za-z0-9_]+\s*\(.*\)/.test(line) ||
                       /^[●•*]\s+(Bash|Read|Edit|Write|Task|Glob|Grep|Browse|Run)\b/i.test(line) ||
                       /^\s*└─\s+(exit|status|result)/i.test(line);

    if (isToolCall) {
      responseStartIndex = i + 1;
      break;
    }

    if (/^[─\-_=━―—\s]{10,}$/.test(line)) {
      if (i > 0 && /^>\s+\S+/.test(lines[i - 1].trim())) {
        responseStartIndex = i + 1;
        break;
      }
      responseStartIndex = i + 1;
      break;
    }

    if (/^>\s+[a-zA-Z0-9]/.test(line) && (i === 0 || /^[─\-_=━―—\s]{3,}$/.test(lines[i-1]?.trim() || ''))) {
      responseStartIndex = i + 1;
      break;
    }
  }

  while (responseStartIndex <= responseEndIndex && !lines[responseStartIndex].trim()) {
    responseStartIndex++;
  }

  if (responseStartIndex > responseEndIndex) return { text: '', isAgy: isAgySession };
  return {
    text: lines.slice(responseStartIndex, responseEndIndex + 1).join('\n').trim(),
    isAgy: isAgySession
  };
}

export function extractFromTerminal(targetTerm) {
  if (!targetTerm || !targetTerm.buffer || !targetTerm.buffer.active) return { text: '', isAgy: false };
  const buffer = targetTerm.buffer.active;
  const lines = [];

  for (let i = 0; i < buffer.length; i++) {
    const lineObj = buffer.getLine(i);
    if (!lineObj) continue;
    const str = lineObj.translateToString(true);
    lines.push(str);
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

  if (session.virtualTerm) {
    const agyExtract = extractFromTerminal(session.virtualTerm);
    if (agyExtract.isAgy && agyExtract.text) {
      cleanText = agyExtract.text;
    }
  }

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

  if (data.startsWith('\x1b[<')) {
    return;
  }

  if (data.includes('\x03') || data.includes('\x1a')) {
    session.awaitingCommandStart = true;
    session.lastCommandInput = '';
    return;
  }

  if (session.awaitingCommandStart) {
    const isPureControl = data.length === 1 && data.charCodeAt(0) < 32 && data !== '\r' && data !== '\n' && data !== '\t';
    if (!isPureControl) {
      session.lastCommandStartOffset = session.totalOutputLength;
      session.lastCommandInput = '';
      session.awaitingCommandStart = false;
    }
  }

  session.lastCommandInput += data;

  if (data.includes('\r') || data.includes('\n')) {
    session.awaitingCommandStart = true;
  }
}

function createSession(title) {
  const id = crypto.randomUUID();
  const shell = spawnShell(title);

  const term = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 35,
    cwd: process.env.USERPROFILE || process.env.HOME || process.cwd(),
    env: process.env
  });

  const virtualTerm = new VirtualTerminal({
    cols: 120,
    rows: 35,
    scrollback: 1000,
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
    try { session.virtualTerm.write(data); } catch {}

    session.history.push(data);
    session.historyBytes += Buffer.byteLength(data, 'utf8');
    session.totalOutputLength += data.length;

    while (session.historyBytes > MAX_HISTORY_BYTES && session.history.length > 1) {
      const removed = session.history.shift();
      session.historyBytes -= Buffer.byteLength(removed, 'utf8');
      session.historyStartOffset += removed.length;
    }

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

// Upgrade handler: Allow WebSocket upgrade and authenticate via ticket, message payload, or query
server.on('upgrade', (req, socket, head) => {
  const clientIp = getClientIp(req);
  const host = req.headers.host || '';
  let url;
  try {
    url = new URL(req.url, `http://${host || '127.0.0.1'}`);
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // 1. Strict path validation: only /ws is accepted
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  // 2. Cross-origin protection: Validate Origin header if present
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin, host)) {
    console.warn(`[WS] Blocked upgrade from unauthorized origin: ${origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // 3. Rate limiting check
  if (!checkAuthRateLimit(clientIp)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
    socket.destroy();
    return;
  }

  // 4. Ticket or query authentication
  const queryTicket = url.searchParams.get('ticket');
  let preAuthenticated = false;
  if (queryTicket) {
    if (!consumeTicket(queryTicket)) {
      recordAuthFailure(clientIp);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    preAuthenticated = true;
  }

  const queryToken = normalizeToken(url.searchParams.get('token'));
  const protocolHeader = normalizeToken(req.headers['sec-websocket-protocol']);

  if (queryToken) {
    if (!safeEqual(queryToken, TOKEN)) {
      recordAuthFailure(clientIp);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    preAuthenticated = true;
  }

  if (protocolHeader && !safeEqual(protocolHeader, TOKEN)) {
    recordAuthFailure(clientIp);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const cleanLogPath = sanitizeLogUrl(url.pathname + (url.search ? url.search : ''));
  console.log(`[WS] Upgrade request on ${cleanLogPath}`);

  wss.handleUpgrade(req, socket, head, ws => {
    ws.preAuthenticated = preAuthenticated;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const clientIp = getClientIp(req);
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    ws.close(1002, 'Protocol error');
    return;
  }

  const cleanLogPath = sanitizeLogUrl(url.pathname);
  console.log(`[WS] Connection established on ${cleanLogPath}`);

  let authenticated = !!ws.preAuthenticated;
  const querySessionId = url.searchParams.get('session');
  let attachedSession = (authenticated && querySessionId && isValidSessionId(querySessionId))
    ? sessions.get(querySessionId)
    : null;

  // Timeout unauthenticated connections after 5 seconds
  const authTimeout = setTimeout(() => {
    if (!authenticated) {
      try {
        console.log('[WS] Auth timeout: client failed to authenticate within 5s');
        recordAuthFailure(clientIp);
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

    if (typeof session.flushOutput === 'function') {
      try { session.flushOutput(); } catch {}
    }

    try {
      ws.send(JSON.stringify({
        type: 'ready',
        session: sessionSummary(session)
      }));
    } catch {}

    if (session.history.length > 0) {
      try {
        ws.send(JSON.stringify({
          type: 'history',
          data: session.history.join('')
        }));
      } catch {}
    }
  }

  if (authenticated && attachedSession) {
    attachToSession(attachedSession);
  }

  ws.on('message', raw => {
    if (raw.length > 64 * 1024) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Message payload exceeds limit' }));
        ws.close(1009, 'Message too big');
      } catch {}
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message' }));
      } catch {}
      return;
    }

    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message structure' }));
      } catch {}
      return;
    }

    const ALLOWED_TYPES = new Set(['auth', 'input', 'resize', 'copy_last', 'get_last_interaction']);
    if (!ALLOWED_TYPES.has(msg.type)) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
      } catch {}
      return;
    }

    if (msg.type === 'auth') {
      if (!checkAuthRateLimit(clientIp)) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }));
          ws.close(4429, 'Too Many Requests');
        } catch {}
        return;
      }

      let isValid = false;
      if (msg.ticket) {
        isValid = consumeTicket(msg.ticket);
      } else if (msg.token) {
        isValid = safeEqual(normalizeToken(msg.token), TOKEN);
      }

      console.log(`[WS] Auth message received: valid=${isValid}, targetSession=${msg.session || 'none'}`);

      if (!isValid) {
        recordAuthFailure(clientIp);
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid authentication token' }));
          ws.close(4401, 'Unauthorized');
        } catch {}
        return;
      }

      recordAuthSuccess(clientIp);
      authenticated = true;

      // Attach to requested session if specified
      if (!msg.session) {
        clearTimeout(authTimeout);
        try {
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } catch {}
        return;
      }

      if (!isValidSessionId(msg.session)) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID format' }));
          ws.close(4400, 'Invalid session ID');
        } catch {}
        return;
      }

      const targetSession = sessions.get(msg.session);
      if (!targetSession) {
        try {
          ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
          ws.close(4404, 'Session not found');
        } catch {}
        return;
      }

      // Synchronize terminal dimensions BEFORE attaching and sending history
      if (msg.cols !== undefined && msg.rows !== undefined) {
        const colsNum = Math.floor(Number(msg.cols));
        const rowsNum = Math.floor(Number(msg.rows));
        const cols = Math.max(10, Math.min(500, Number.isFinite(colsNum) ? colsNum : 120));
        const rows = Math.max(2, Math.min(200, Number.isFinite(rowsNum) ? rowsNum : 35));
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

    // For any subsequent message, client must be authenticated and attached
    if (!authenticated || !attachedSession) {
      try {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: authentication required' }));
      } catch {}
      return;
    }

    if (msg.type === 'input') {
      if (attachedSession && attachedSession.pty) {
        if (typeof msg.data === 'string') {
          handleSessionInput(attachedSession, msg.data);
          attachedSession.pty.write(msg.data);
        }
      }
    } else if (msg.type === 'resize') {
      if (attachedSession && attachedSession.pty) {
        const cols = parseInt(msg.cols, 10);
        const rows = parseInt(msg.rows, 10);
        if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= 10 && cols <= 500 && rows >= 5 && rows <= 200) {
          try {
            attachedSession.pty.resize(cols, rows);
            if (attachedSession.virtualTerm) {
              attachedSession.virtualTerm.resize(cols, rows);
            }
          } catch (err) {
            console.warn(`[RESIZE] Error resizing session ${attachedSession.id}:`, err?.message || err);
          }
        }
      }
    } else if (msg.type === 'copy_last' || msg.type === 'get_last_interaction') {
      if (attachedSession) {
        const interaction = getLastInteraction(attachedSession);
        try {
          ws.send(JSON.stringify({
            type: 'last_interaction',
            sessionId: attachedSession.id,
            command: interaction.command,
            text: interaction.text
          }));
        } catch {}
      }
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (attachedSession) {
      attachedSession.clients.delete(ws);
      console.log(`[WS] Client disconnected from "${attachedSession.title}" (${attachedSession.clients.size} active clients remaining)`);
    }
  });

  ws.on('error', err => {
    clearTimeout(authTimeout);
    console.error('[WS ERROR]', err.message);
  });
});

// Single-use short-lived connection ticket endpoint
app.post('/api/auth/ticket', (req, res) => {
  const clientIp = getClientIp(req);
  if (!checkAuthRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' });
  }
  const reqToken = normalizeToken(req.get('x-auth-token') || req.query.token || '');
  if (!safeEqual(reqToken, TOKEN)) {
    recordAuthFailure(clientIp);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  recordAuthSuccess(clientIp);
  const ticket = createTicket();
  res.status(200).json({ ticket, expiresIn: 30 });
});

app.get('/api/sessions', (req, res) => {
  const clientIp = getClientIp(req);
  if (!checkAuthRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' });
  }
  const reqToken = normalizeToken(req.get('x-auth-token') || req.query.token || '');
  if (!safeEqual(reqToken, TOKEN)) {
    recordAuthFailure(clientIp);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  recordAuthSuccess(clientIp);
  res.json([...sessions.values()].map(sessionSummary));
});

app.get('/api/sessions/:id/last-interaction', (req, res) => {
  const clientIp = getClientIp(req);
  if (!checkAuthRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' });
  }
  const reqToken = normalizeToken(req.get('x-auth-token') || req.query.token || '');
  if (!safeEqual(reqToken, TOKEN)) {
    recordAuthFailure(clientIp);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  recordAuthSuccess(clientIp);

  if (!isValidSessionId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(getLastInteraction(session));
});

app.post('/api/sessions', (req, res) => {
  const clientIp = getClientIp(req);
  if (!checkAuthRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' });
  }
  const reqToken = normalizeToken(req.get('x-auth-token') || req.query.token || '');
  if (!safeEqual(reqToken, TOKEN)) {
    recordAuthFailure(clientIp);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  recordAuthSuccess(clientIp);

  if (!checkSessionCreationRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Session creation rate limit exceeded. Please wait.' });
  }

  if (sessions.size >= MAX_SESSIONS) {
    return res.status(400).json({ error: `Maximum active session limit of ${MAX_SESSIONS} reached` });
  }

  if (req.body && typeof req.body !== 'object') {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  if (req.body?.title !== undefined && typeof req.body.title !== 'string') {
    return res.status(400).json({ error: 'Session title must be a string' });
  }

  const count = sessions.size + 1;
  const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const sanitizedTitle = rawTitle
    ? rawTitle.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80)
    : `Terminal ${count}`;

  const session = createSession(sanitizedTitle || `Terminal ${count}`);
  res.status(201).json(sessionSummary(session));
});

app.delete('/api/sessions/:id', (req, res) => {
  const clientIp = getClientIp(req);
  if (!checkAuthRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many authentication attempts. Please try again later.' });
  }
  const reqToken = normalizeToken(req.get('x-auth-token') || req.query.token || '');
  if (!safeEqual(reqToken, TOKEN)) {
    recordAuthFailure(clientIp);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  recordAuthSuccess(clientIp);

  if (!isValidSessionId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

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
    if (session.pty) {
      session.pty.kill();
    }
  } catch (err) {
    console.warn(`[DELETE] PTY kill error for session ${session.id}:`, err?.message || err);
  }
  sessions.delete(session.id);
  console.log(`[DELETE] Session "${session.title}" (${session.id}) terminated and removed.`);
  res.status(204).end();
});

// Explicit HTTP method restrictions (405 Method Not Allowed)
app.all('/api/auth/ticket', (req, res) => {
  res.set('Allow', 'POST').status(405).json({ error: 'Method Not Allowed' });
});

app.all('/api/sessions', (req, res) => {
  res.set('Allow', 'GET, POST').status(405).json({ error: 'Method Not Allowed' });
});

app.all('/api/sessions/:id', (req, res) => {
  res.set('Allow', 'DELETE').status(405).json({ error: 'Method Not Allowed' });
});

app.all('/api/sessions/:id/last-interaction', (req, res) => {
  res.set('Allow', 'GET').status(405).json({ error: 'Method Not Allowed' });
});

// Central Express error handling (Prevents HTML stack trace leakage)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error('[HTTP ERROR]', err?.message || 'Internal error');
  res.status(500).json({ error: 'Internal server error' });
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

export function startServer({ port = PORT, host = HOST, enableTunnel = process.env.TUNNEL !== 'false', authToken = process.env.AUTH_TOKEN } = {}) {
  // Validate candidate authentication configuration at startup
  const candidateToken = normalizeToken(authToken !== undefined ? authToken : TOKEN);
  const isCandidateDefault = candidateToken && KNOWN_DEFAULT_TOKENS.has(candidateToken.toLowerCase());

  if (enableTunnel) {
    if (!candidateToken || candidateToken.length < 16 || isCandidateDefault) {
      throw new Error('Remote access requires a secure AUTH_TOKEN of at least 16 characters (cannot be a known default token).');
    }
  } else {
    if (candidateToken && isCandidateDefault) {
      throw new Error('Configured AUTH_TOKEN is a known insecure default token. Please change it.');
    }
  }

  // Only assign after validation has passed
  if (authToken) {
    TOKEN = normalizeToken(authToken);
    isGeneratedToken = false;
  }

  if (sessions.size === 0) {
    createSession('PowerShell');
    createSession('AGY');
  }

  return new Promise((resolve, reject) => {
    server.listen(port, host, async () => {
      const localIp = getLocalIp();
      let tunnel = null;
      let publicUrl = null;

      if (enableTunnel) {
        console.log('Starting Cloudflare Tunnel for Internet Access...');
        try {
          tunnel = startTunnel({ port });
          publicUrl = await tunnel.url;
        } catch (err) {
          console.warn(`[Tunnel Warning] Cloudflare Tunnel failed: ${err.message}`);
          console.log('TermBridge is still running locally and over LAN.');
        }
      }

      const pairingUrl = publicUrl || `http://${localIp}:${port}`;
      printStartupBanner({ port, localIp, publicUrl, token: TOKEN });

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

    server.once('error', (err) => {
      reject(err);
    });
  });
}

export function printStartupBanner({ port, localIp, publicUrl, token = TOKEN } = {}) {
  console.log('\n============================================================');
  console.log('             TERMBRIDGE SERVER STARTED                      ');
  console.log('============================================================');
  console.log(`Local URL:    http://localhost:${port}`);
  console.log(`LAN URL:      http://${localIp}:${port}`);
  if (publicUrl) {
    console.log(`Remote URL:   ${publicUrl}`);
  }
  console.log('');
  console.log('ACCESS TOKEN:');
  if (shouldDisplayToken()) {
    console.log(token);
  } else {
    console.log('[Protected - Non-interactive/redirected stdout]');
  }
  console.log('');
  console.log('Keep your token private. Anyone who obtains it may gain access to your terminal sessions.');
  console.log('============================================================\n');

  const qrTarget = publicUrl || `http://${localIp}:${port}`;
  console.log('Scan this QR code with your phone camera to open TermBridge:');
  qrcode.generate(qrTarget, { small: true }, qr => console.log(qr));
  console.log('Then enter the ACCESS TOKEN displayed above.\n');
}

const isMainModule = Boolean(
  process.argv[1] && (
    path.resolve(process.argv[1]) === path.resolve(__dirname, 'index.js') ||
    process.argv[1].endsWith('server\\index.js') ||
    process.argv[1].endsWith('server/index.js')
  )
);

if (isMainModule) {
  startServer().catch(err => {
    console.error('Fatal startup error:', err);
    process.exit(1);
  });
}
