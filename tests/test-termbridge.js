import http from 'node:http';
import { WebSocket } from 'ws';

const TOKEN = 'test-token-secure-12345';
process.env.PORT = '8799';
process.env.AUTH_TOKEN = TOKEN;
process.env.TUNNEL = 'false'; // Keep test local for deterministic speed

console.log('--- Starting TermBridge Verification Test Suite ---');

// Import and explicitly start server on port 8799
const { startServer } = await import('../server/index.js');
const serverInstance = await startServer({ port: 8799, host: '127.0.0.1', enableTunnel: false });

const baseUrl = 'http://127.0.0.1:8799';

function makeRequest(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
        } catch {
          resolve({ status: res.statusCode, body });
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

async function runTests() {
  let passed = 0;
  let total = 0;

  function assert(condition, desc) {
    total++;
    if (condition) {
      console.log(`[PASS] ${desc}`);
      passed++;
    } else {
      console.error(`[FAIL] ${desc}`);
      process.exitCode = 1;
    }
  }

  // 1. Auth check: REST
  const unauthRes = await makeRequest('/api/sessions');
  assert(unauthRes.status === 401, 'Unauthenticated REST request correctly rejected with 401');

  // 2. Authenticated sessions list
  const authRes = await makeRequest('/api/sessions', {
    headers: { 'x-auth-token': TOKEN }
  });
  assert(authRes.status === 200, 'Authenticated request succeeds with 200');
  assert(Array.isArray(authRes.body) && authRes.body.length >= 2, 'Default persistent sessions exist (PowerShell, AGY)');
  assert(typeof authRes.body[0].pid === 'number', `Session reports valid OS Process ID (PID: ${authRes.body[0].pid})`);
  console.log(`       Active sessions found: ${authRes.body.map(s => `${s.title} [PID: ${s.pid}]`).join(', ')}`);

  const targetSession = authRes.body[0];
  const targetId = targetSession.id;
  const originalPid = targetSession.pid;

  // 3. WebSocket Security: Reject invalid token
  const badWs = new WebSocket(`ws://127.0.0.1:8799/ws`);
  const rejectedPromise = new Promise(resolve => {
    badWs.on('open', () => {
      badWs.send(JSON.stringify({ type: 'auth', token: 'wrong-token', session: targetId }));
    });
    badWs.on('close', (code) => resolve(code));
    badWs.on('error', () => resolve(4401));
    setTimeout(() => resolve(0), 3000);
  });
  const rejectCode = await rejectedPromise;
  assert(rejectCode === 4401 || rejectCode === 1006, `WebSocket with invalid token correctly rejected (close code: ${rejectCode})`);

  // 4. WebSocket connect with clean URL & payload auth (No token in query string)
  const ws1 = new WebSocket(`ws://127.0.0.1:8799/ws`);
  let outputReceived = false;
  let outputText = '';
  let readyReceived = false;

  await new Promise((resolve, reject) => {
    ws1.on('open', () => {
      // Authenticate via payload (zero token in URL)
      ws1.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetId }));
    });
    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') {
        readyReceived = true;
        // Send a test command to the terminal
        ws1.send(JSON.stringify({
          type: 'input',
          data: 'echo "TB_MARKER_TEST_123"\r'
        }));
      }
      if (msg.type === 'output') {
        outputText += msg.data;
        if (outputText.includes('TB_MARKER_TEST_123')) {
          outputReceived = true;
          resolve();
        }
      }
    });
    ws1.on('error', reject);
    setTimeout(() => resolve(), 5000);
  });

  assert(readyReceived && outputReceived, 'First-message WebSocket auth & bidirectional I/O succeeded');

  // 5. Test Disconnect & Persistence (Phone losing signal / closing browser)
  ws1.close();
  await new Promise(r => setTimeout(r, 500));

  const afterDisconnect = await makeRequest('/api/sessions', {
    headers: { 'x-auth-token': TOKEN }
  });
  const stillExisting = afterDisconnect.body.find(s => s.id === targetId);
  assert(stillExisting !== undefined, 'Terminal session persists after WebSocket client disconnects');
  assert(stillExisting.pid === originalPid, `Process identity preserved across disconnect: PID remains ${originalPid}`);

  // 6. Test Reconnection & History Replay (Phone reconnects)
  const ws2 = new WebSocket(`ws://127.0.0.1:8799/ws`);
  let historyReceived = false;
  let historyText = '';

  await new Promise((resolve, reject) => {
    ws2.on('open', () => {
      ws2.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetId }));
    });
    ws2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'history') {
        historyText = msg.data;
        if (historyText.includes('TB_MARKER_TEST_123')) {
          historyReceived = true;
          resolve();
        }
      }
    });
    ws2.on('error', reject);
    setTimeout(() => resolve(), 4000);
  });
  ws2.close();

  assert(historyReceived, 'Scrollback history replay: reconnected client recovered previous screen output');

  // 7. Test Multi-Session Creation
  const newSessionRes = await makeRequest('/api/sessions', {
    method: 'POST',
    headers: {
      'x-auth-token': TOKEN,
      'content-type': 'application/json'
    },
    body: { title: 'Worker 3' }
  });
  assert(newSessionRes.status === 201 && newSessionRes.body.title === 'Worker 3', 'Created new persistent terminal session: Worker 3');

  const listAfterCreate = await makeRequest('/api/sessions', {
    headers: { 'x-auth-token': TOKEN }
  });
  assert(listAfterCreate.body.length === 3, 'Multiple terminal sessions managed simultaneously (3 sessions)');

  console.log(`\nVerification Complete: ${passed}/${total} assertions passed.`);
  serverInstance.stop();
  process.exit(passed === total ? 0 : 1);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
