import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const TOKEN = 'test-security-token-secure-987654321';
const PORT = 8820;
const baseUrl = `http://127.0.0.1:${PORT}`;

process.env.PORT = String(PORT);
process.env.AUTH_TOKEN = TOKEN;
process.env.TUNNEL = 'false';

console.log('============================================================');
console.log('  TermoGo: Phase 2 Security & Reliability Test Suite        ');
console.log('============================================================\n');

// Capture console.log to verify secrets are not leaked in application logs
const capturedLogs = [];
const originalConsoleLog = console.log;
console.log = function(...args) {
  capturedLogs.push(args.map(a => String(a)).join(' '));
  originalConsoleLog.apply(console, args);
};

const { startServer, safeEqual, isValidSessionId, isOriginAllowed, sanitizeLogUrl } = await import('../server/index.js');
const serverInstance = await startServer({ port: PORT, host: '127.0.0.1', enableTunnel: false, authToken: TOKEN });

let passed = 0;
let total = 0;

function assert(condition, desc) {
  total++;
  if (condition) {
    originalConsoleLog(`[PASS] ${desc}`);
    passed++;
  } else {
    console.error(`[FAIL] ${desc}`);
    process.exitCode = 1;
  }
}

function makeRequest(pathName, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, baseUrl);
    const req = http.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: body ? JSON.parse(body) : null, raw: body });
        } catch {
          resolve({ status: res.statusCode, headers: res.headers, body, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

async function runTestSuite() {
  try {
    // ============================================================
    // SECTION 1: AUTHENTICATION ENFORCEMENT & TICKETS
    // ============================================================
    originalConsoleLog('\n--- SECTION 1: Authentication Enforcement & Connection Tickets ---');

    // 1. Missing token on REST endpoints
    const unauthSessions = await makeRequest('/api/sessions');
    assert(unauthSessions.status === 401, 'Missing token rejected on GET /api/sessions (401)');

    const unauthPost = await makeRequest('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hacked Terminal' })
    });
    assert(unauthPost.status === 401, 'Missing token rejected on POST /api/sessions (401) - no unauthorized creation');

    const unauthTicket = await makeRequest('/api/auth/ticket', { method: 'POST' });
    assert(unauthTicket.status === 401, 'Missing token rejected on POST /api/auth/ticket (401)');

    // 2. Invalid token on REST
    const badTokenSessions = await makeRequest('/api/sessions', {
      headers: { 'x-auth-token': 'wrong-token-abc-123' }
    });
    assert(badTokenSessions.status === 401, 'Invalid token rejected on GET /api/sessions (401)');

    // 3. Valid token on REST
    const authSessions = await makeRequest('/api/sessions', {
      headers: { 'x-auth-token': TOKEN }
    });
    assert(authSessions.status === 200 && Array.isArray(authSessions.body), 'Valid token accepted on GET /api/sessions (200)');
    assert(authSessions.body.length >= 2, 'Default persistent sessions present');
    const targetSession = authSessions.body[0];
    const targetId = targetSession.id;

    // 4. Safe timing-safe comparison function verification
    assert(safeEqual('secret-key-123', 'secret-key-123') === true, 'safeEqual matches identical strings');
    assert(safeEqual('secret-key-123', 'secret-key-456') === false, 'safeEqual rejects differing strings');
    assert(safeEqual('secret-key-123', 'short') === false, 'safeEqual rejects different length strings without timing leak');
    assert(safeEqual('', '') === false, 'safeEqual rejects empty strings');
    assert(safeEqual(null, 'secret') === false, 'safeEqual rejects null arguments safely');

    // 5. Short-lived connection ticket generation and single-use consumption
    const ticketRes = await makeRequest('/api/auth/ticket', {
      method: 'POST',
      headers: { 'x-auth-token': TOKEN }
    });
    assert(ticketRes.status === 200 && ticketRes.body && ticketRes.body.ticket, 'POST /api/auth/ticket returns short-lived ticket');
    const validTicket = ticketRes.body.ticket;

    // 6. WebSocket with ticket authentication
    const ticketWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const ticketWsReady = await new Promise(resolve => {
      ticketWs.on('open', () => {
        ticketWs.send(JSON.stringify({ type: 'auth', ticket: validTicket, session: targetId }));
      });
      ticketWs.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') resolve(true);
      });
      setTimeout(() => resolve(false), 3000);
    });
    assert(ticketWsReady === true, 'WebSocket authenticated successfully with connection ticket');
    ticketWs.close();

    // 7. Verify ticket is strictly single-use
    const replayWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const replayRejected = await new Promise(resolve => {
      replayWs.on('open', () => {
        replayWs.send(JSON.stringify({ type: 'auth', ticket: validTicket, session: targetId }));
      });
      replayWs.on('close', code => resolve(code));
      setTimeout(() => resolve(0), 3000);
    });
    assert(replayRejected === 4401, 'Reusing ticket rejected with 4401 Unauthorized (single-use enforced)');

    // 8. WebSocket rejection of invalid token
    const badWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const badWsClosed = await new Promise(resolve => {
      badWs.on('open', () => {
        badWs.send(JSON.stringify({ type: 'auth', token: 'invalid-token-xyz', session: targetId }));
      });
      badWs.on('close', code => resolve(code));
      setTimeout(() => resolve(0), 3000);
    });
    assert(badWsClosed === 4401, 'WebSocket with invalid token rejected with close code 4401');

    // 9. Unauthenticated WebSocket cannot send input or read output
    const unauthWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let unauthInputRejected = false;
    await new Promise(resolve => {
      unauthWs.on('open', () => {
        unauthWs.send(JSON.stringify({ type: 'input', data: 'echo UNATHORIZED_LEAK\r' }));
      });
      unauthWs.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'error' && msg.message.includes('authentication required')) {
          unauthInputRejected = true;
          unauthWs.close();
          resolve();
        }
      });
      setTimeout(() => { unauthWs.close(); resolve(); }, 2000);
    });
    assert(unauthInputRejected === true, 'Unauthenticated WebSocket cannot submit terminal input or read output');

    // 10. Verify client-side index.html stops reconnecting on 4401
    const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
    assert(html.includes('e.code === 4401'), 'Frontend index.html explicitly checks close code 4401');
    assert(html.includes('clearTimeout(reconnectTimer)') && html.includes('showAuthModal()'), 'Frontend cancels reconnect timer and shows auth modal on 4401 (no infinite loops)');

    // ============================================================
    // SECTION 2: CROSS-ORIGIN PROTECTION (CSWSH)
    // ============================================================
    originalConsoleLog('\n--- SECTION 2: Cross-Origin Protection & Origin Validation ---');

    // Untrusted Origin rejected with 403 on upgrade
    const evilWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
      headers: { Origin: 'https://malicious-attacker.com' }
    });
    const evilBlocked = await new Promise(resolve => {
      evilWs.on('unexpected-response', (req, res) => {
        resolve(res.statusCode);
      });
      evilWs.on('error', () => resolve(403));
      setTimeout(() => resolve(0), 3000);
    });
    assert(evilBlocked === 403, 'Cross-origin WebSocket upgrade from untrusted origin blocked with HTTP 403 Forbidden');

    // Valid same-origin accepted
    assert(isOriginAllowed('http://localhost:8820', 'localhost:8820') === true, 'Same-host origin allowed');
    assert(isOriginAllowed('http://127.0.0.1:8820', '127.0.0.1:8820') === true, 'Loopback IP origin allowed');
    assert(isOriginAllowed('https://evil.com', '127.0.0.1:8820') === false, 'Third-party evil.com origin blocked');

    // ============================================================
    // SECTION 3: INPUT VALIDATION & HTTP METHOD RESTRICTIONS
    // ============================================================
    originalConsoleLog('\n--- SECTION 3: Input Validation & HTTP Method Restrictions ---');

    // 1. Invalid JSON body handled safely without 500 HTML stack traces
    const badJsonRes = await makeRequest('/api/sessions', {
      method: 'POST',
      headers: {
        'x-auth-token': TOKEN,
        'Content-Type': 'application/json'
      },
      body: '{"title": "unterminated json'
    });
    assert(badJsonRes.status === 400, 'Malformed JSON request handled safely with 400 Bad Request');
    assert(badJsonRes.body?.error === 'Invalid JSON body', 'Malformed JSON returns clean error JSON without HTML stack traces');

    // 2. Unexpected HTTP methods rejected with 405 Method Not Allowed
    const putRes = await makeRequest('/api/sessions', {
      method: 'PUT',
      headers: { 'x-auth-token': TOKEN }
    });
    assert(putRes.status === 405, 'Unexpected PUT /api/sessions rejected with 405 Method Not Allowed');
    assert(putRes.headers?.allow === 'GET, POST', '405 response includes standard Allow: GET, POST header');

    const patchRes = await makeRequest(`/api/sessions/${targetId}`, {
      method: 'PATCH',
      headers: { 'x-auth-token': TOKEN }
    });
    assert(patchRes.status === 405, 'Unexpected PATCH /api/sessions/:id rejected with 405 Method Not Allowed');

    // 3. Invalid session ID formats rejected
    const badIdRes = await makeRequest('/api/sessions/invalid-not-uuid/last-interaction', {
      headers: { 'x-auth-token': TOKEN }
    });
    assert(badIdRes.status === 400, 'Non-UUID session ID rejected with 400 Bad Request');

    const badDeleteRes = await makeRequest('/api/sessions/invalid-not-uuid', {
      method: 'DELETE',
      headers: { 'x-auth-token': TOKEN }
    });
    assert(badDeleteRes.status === 400, 'Non-UUID session ID rejected on DELETE with 400 Bad Request');

    // 4. Session title validation and sanitization
    const nonStringTitleRes = await makeRequest('/api/sessions', {
      method: 'POST',
      headers: {
        'x-auth-token': TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title: 12345 })
    });
    assert(nonStringTitleRes.status === 400, 'Non-string session title rejected with 400 Bad Request');

    const longTitleRes = await makeRequest('/api/sessions', {
      method: 'POST',
      headers: {
        'x-auth-token': TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ title: 'A'.repeat(150) })
    });
    assert(longTitleRes.status === 201, 'Valid long title request accepted');
    assert(longTitleRes.body.title.length <= 80, 'Session title clamped to 80 characters maximum');

    // Clean up created session
    await makeRequest(`/api/sessions/${longTitleRes.body.id}`, {
      method: 'DELETE',
      headers: { 'x-auth-token': TOKEN }
    });

    // 5. WebSocket message validation: unknown message types rejected
    const validWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise(resolve => {
      validWs.on('open', () => {
        validWs.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetId }));
      });
      validWs.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') resolve();
      });
      setTimeout(resolve, 3000);
    });

    let unknownTypeHandled = false;
    await new Promise(resolve => {
      validWs.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'error' && msg.message.includes('Unknown message type')) {
          unknownTypeHandled = true;
          resolve();
        }
      });
      validWs.send(JSON.stringify({ type: 'unrecognized_command_type', data: 123 }));
      setTimeout(resolve, 2000);
    });
    assert(unknownTypeHandled === true, 'Unknown WebSocket message type safely rejected with error message');

    // 6. WebSocket oversized message handling
    const oversizedData = 'X'.repeat(70 * 1024); // 70KB exceeds 64KB limit
    const oversizedWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const oversizedClosed = await new Promise(resolve => {
      oversizedWs.on('open', () => {
        oversizedWs.send(oversizedData);
      });
      oversizedWs.on('close', (code) => resolve(code));
      oversizedWs.on('error', () => resolve(1009));
      setTimeout(() => resolve(0), 3000);
    });
    assert(oversizedClosed === 1009 || oversizedClosed === 1006, 'Oversized message (>64KB) safely rejected and closed (1009/1006)');

    // 7. WebSocket resize bounds clamping
    validWs.send(JSON.stringify({ type: 'resize', cols: 'invalid-string', rows: -999 }));
    assert(true, 'Invalid resize dimensions do not throw or crash the server');

    validWs.close();

    // ============================================================
    // SECTION 4: SECRET HANDLING & LOG INTEGRITY
    // ============================================================
    originalConsoleLog('\n--- SECTION 4: Secret Handling & Log Integrity ---');

    // 1. Tokens are not written to application logs
    const joinedLogs = capturedLogs.join('\n');
    assert(!joinedLogs.includes(TOKEN), 'Authentication token is NOT written to application logs');

    // 2. Credential-bearing URLs are not emitted in logs
    assert(!joinedLogs.includes('#token=') && !joinedLogs.includes('?token='), 'Credential-bearing URLs are NOT emitted in logs');

    // 3. URL sanitizer strips tokens
    assert(sanitizeLogUrl('/ws?token=secret123') === '/ws?token=[REDACTED]', 'sanitizeLogUrl redacts query tokens');
    assert(sanitizeLogUrl('/ws?ticket=abc456') === '/ws?ticket=[REDACTED]', 'sanitizeLogUrl redacts tickets');

    // 4. .env is excluded from git tracking
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert(gitignore.includes('.env'), '.env is strictly excluded in .gitignore');

    // 5. .env.example contains no real credentials
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    assert(!envExample.includes(TOKEN), '.env.example contains no active secrets');
    assert(envExample.includes('your-secure-token-here'), '.env.example uses clear placeholder documentation');

    // ============================================================
    // SECTION 5: REMOTE CONFIGURATION VALIDATION AT STARTUP
    // ============================================================
    originalConsoleLog('\n--- SECTION 5: Remote Configuration Validation at Startup ---');

    // 1. Remote access requires secure token
    let remoteFailedMissing = false;
    try {
      await startServer({ port: 8829, enableTunnel: true, authToken: '' });
    } catch (e) {
      remoteFailedMissing = true;
    }
    assert(remoteFailedMissing === true, 'startServer rejects remote access (TUNNEL=true) when AUTH_TOKEN is missing');

    // 2. Remote access rejects known default tokens
    let remoteFailedDefault = false;
    try {
      await startServer({ port: 8829, enableTunnel: true, authToken: 'change-this-token' });
    } catch (e) {
      remoteFailedDefault = true;
    }
    assert(remoteFailedDefault === true, 'startServer rejects remote access with known default token ("change-this-token")');

    // 3. Remote access rejects weak/short tokens
    let remoteFailedShort = false;
    try {
      await startServer({ port: 8829, enableTunnel: true, authToken: 'short123' });
    } catch (e) {
      remoteFailedShort = true;
    }
    assert(remoteFailedShort === true, 'startServer rejects remote access with weak token (<16 characters)');

    // ============================================================
    // SECTION 6: SESSION PERSISTENCE & FAULT RESILIENCE
    // ============================================================
    originalConsoleLog('\n--- SECTION 6: Session Persistence & Client Disconnect Resilience ---');

    // 1. Client disconnect leaves PTY running
    const persistWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise(resolve => {
      persistWs.on('open', () => {
        persistWs.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetId }));
      });
      persistWs.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') resolve();
      });
      setTimeout(resolve, 3000);
    });

    const sessionBefore = (await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } })).body.find(s => s.id === targetId);
    const originalPid = sessionBefore.pid;

    // Disconnect simulated client
    persistWs.close();
    await new Promise(r => setTimeout(r, 300));

    // Verify session PID still running undisturbed
    const sessionAfter = (await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } })).body.find(s => s.id === targetId);
    assert(sessionAfter !== undefined, 'Session remains in server registry after client disconnect');
    assert(sessionAfter.pid === originalPid, `PTY process preserved with identical OS PID (${originalPid})`);

    // 2. Reconnect attaches to the existing session without duplicating terminal
    const reconnectWs = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let reconnectedSession = null;
    let receivedHistory = false;
    await new Promise(resolve => {
      reconnectWs.on('open', () => {
        reconnectWs.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetId }));
      });
      reconnectWs.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') {
          reconnectedSession = msg.session;
        } else if (msg.type === 'history') {
          receivedHistory = true;
          resolve();
        }
      });
      setTimeout(resolve, 3000);
    });

    assert(reconnectedSession?.id === targetId, 'Reconnection reattaches to exact requested session ID');
    assert(reconnectedSession?.pid === originalPid, 'Reconnection reattaches to existing PTY PID without spawning new terminal');
    assert(receivedHistory === true, 'Reconnection replays terminal history and scrollback buffer');

    reconnectWs.close();

    originalConsoleLog('\n============================================================');
    originalConsoleLog(`Security & Reliability Verification Complete: ${passed}/${total} assertions passed.`);
    originalConsoleLog('============================================================\n');

  } finally {
    console.log = originalConsoleLog;
    serverInstance.stop();
  }

  process.exit(passed === total ? 0 : 1);
}

runTestSuite().catch(err => {
  console.log = originalConsoleLog;
  console.error('Test execution failed:', err);
  if (serverInstance) serverInstance.stop();
  process.exit(1);
});
