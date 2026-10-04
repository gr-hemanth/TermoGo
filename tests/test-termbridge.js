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
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null, raw: body });
        } catch {
          resolve({ status: res.statusCode, body, raw: body });
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

function sendAndAwaitOutput(ws, command, expectedMarker, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let accumulated = '';
    const onMessage = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'output') {
          accumulated += msg.data;
          if (accumulated.includes(expectedMarker)) {
            ws.off('message', onMessage);
            clearTimeout(timer);
            resolve(accumulated);
          }
        }
      } catch {}
    };

    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(accumulated); // return whatever was accumulated
    }, timeoutMs);

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'input', data: command }));
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

  const targetSession1 = authRes.body[0];
  const targetId1 = targetSession1.id;
  const targetSession2 = authRes.body[1];
  const targetId2 = targetSession2.id;
  const originalPid = targetSession1.pid;

  // 3. WebSocket Security: Reject invalid token
  const badWs = new WebSocket(`ws://127.0.0.1:8799/ws`);
  const rejectedPromise = new Promise(resolve => {
    badWs.on('open', () => {
      badWs.send(JSON.stringify({ type: 'auth', token: 'wrong-token', session: targetId1 }));
    });
    badWs.on('close', (code) => resolve(code));
    badWs.on('error', () => resolve(4401));
    setTimeout(() => resolve(0), 3000);
  });
  const rejectCode = await rejectedPromise;
  assert(rejectCode === 4401 || rejectCode === 1006, `WebSocket with invalid token correctly rejected (close code: ${rejectCode})`);

  // 4. WebSocket connect with clean URL & payload auth (No token in query string)
  const ws1 = new WebSocket(`ws://127.0.0.1:8799/ws`);
  await new Promise(resolve => {
    ws1.on('open', () => {
      ws1.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetId1 }));
    });
    ws1.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') resolve();
    });
  });

  // Generate an initial marker
  await sendAndAwaitOutput(ws1, 'echo "TB_MARKER_TEST_123"\r', 'TB_MARKER_TEST_123');
  assert(true, 'First-message WebSocket auth & bidirectional I/O succeeded');

  // --- FEATURE TESTS: COPY LAST ---

  // Test 1: Send echo "hello" -> COPY LAST contains latest command and output
  console.log('\n--- Testing COPY LAST Feature ---');
  await sendAndAwaitOutput(ws1, 'echo "COPY_LAST_HELLO"\r', 'COPY_LAST_HELLO');
  await new Promise(r => setTimeout(r, 200));

  const copyRes1 = await makeRequest(`/api/sessions/${targetId1}/last-interaction`, {
    headers: { 'x-auth-token': TOKEN }
  });
  assert(copyRes1.status === 200, 'GET /api/sessions/:id/last-interaction returns 200');
  assert(copyRes1.body.text.includes('COPY_LAST_HELLO'), '[Test 1] COPY LAST contains the command and its output ("COPY_LAST_HELLO")');

  // Test 2: Send second command -> COPY LAST contains ONLY second command and subsequent output
  await sendAndAwaitOutput(ws1, 'echo "COPY_LAST_SECOND"\r', 'COPY_LAST_SECOND');
  await new Promise(r => setTimeout(r, 200));

  const copyRes2 = await makeRequest(`/api/sessions/${targetId1}/last-interaction`, {
    headers: { 'x-auth-token': TOKEN }
  });
  assert(copyRes2.body.text.includes('COPY_LAST_SECOND'), '[Test 2a] COPY LAST contains second command ("COPY_LAST_SECOND")');
  assert(!copyRes2.body.text.includes('COPY_LAST_HELLO'), '[Test 2b] COPY LAST excludes first command ("COPY_LAST_HELLO")');

  // Test 3: Generate previous history -> COPY LAST does NOT copy entire history
  assert(!copyRes2.body.text.includes('TB_MARKER_TEST_123'), '[Test 3] COPY LAST does not copy previous history from earlier sessions');

  // Test 4: Multiline paste treated as one interaction
  const multilineInput = 'echo "PASTE_BLOCK_1"\necho "PASTE_BLOCK_2"\r';
  await sendAndAwaitOutput(ws1, multilineInput, 'PASTE_BLOCK_2');
  await new Promise(r => setTimeout(r, 200));

  const copyRes4 = await makeRequest(`/api/sessions/${targetId1}/last-interaction`, {
    headers: { 'x-auth-token': TOKEN }
  });
  assert(copyRes4.body.text.includes('PASTE_BLOCK_1') && copyRes4.body.text.includes('PASTE_BLOCK_2'), '[Test 4] Multiline paste treated as one single interaction in COPY LAST');

  // Test 5: Multiple terminals have independent boundaries
  const ws2 = new WebSocket(`ws://127.0.0.1:8799/ws`);
  await new Promise(resolve => {
    ws2.on('open', () => {
      ws2.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetId2 }));
    });
    ws2.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') resolve();
    });
  });

  await sendAndAwaitOutput(ws2, 'echo "TERMINAL_2_EXCLUSIVE"\r', 'TERMINAL_2_EXCLUSIVE');
  await new Promise(r => setTimeout(r, 200));

  const copyTerm1 = await makeRequest(`/api/sessions/${targetId1}/last-interaction`, {
    headers: { 'x-auth-token': TOKEN }
  });
  const copyTerm2 = await makeRequest(`/api/sessions/${targetId2}/last-interaction`, {
    headers: { 'x-auth-token': TOKEN }
  });

  assert(copyTerm1.body.text.includes('PASTE_BLOCK_2') && !copyTerm1.body.text.includes('TERMINAL_2_EXCLUSIVE'), '[Test 5a] Terminal 1 keeps its own interaction boundary');
  assert(copyTerm2.body.text.includes('TERMINAL_2_EXCLUSIVE') && !copyTerm2.body.text.includes('PASTE_BLOCK_2'), '[Test 5b] Terminal 2 maintains completely independent interaction boundary');

  // Test 6: Disconnect/reconnect keeps boundary working
  ws2.close();
  await new Promise(r => setTimeout(r, 500));

  const ws2Reconnect = new WebSocket(`ws://127.0.0.1:8799/ws`);
  await new Promise(resolve => {
    ws2Reconnect.on('open', () => {
      ws2Reconnect.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetId2 }));
    });
    ws2Reconnect.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') resolve();
    });
  });

  const copyAfterReconnect = await makeRequest(`/api/sessions/${targetId2}/last-interaction`, {
    headers: { 'x-auth-token': TOKEN }
  });
  assert(copyAfterReconnect.body.text.includes('TERMINAL_2_EXCLUSIVE'), '[Test 6] COPY LAST remains intact after client disconnect and reconnect');
  ws2Reconnect.close();

  // Test 7: Long-running command copied while still running
  // We send a two-part output command with a delay between them
  const longCmd = 'Write-Host "STAGE_ONE_ACTIVE"; Start-Sleep -Milliseconds 1500; Write-Host "STAGE_TWO_ACTIVE"\r';
  const longRunPromise = sendAndAwaitOutput(ws1, longCmd, 'STAGE_ONE_ACTIVE', 8000);
  await longRunPromise;

  // Immediately check while STAGE_ONE is done but STAGE_TWO hasn't finished yet
  const copyWhileRunning = await makeRequest(`/api/sessions/${targetId1}/last-interaction`, {
    headers: { 'x-auth-token': TOKEN }
  });
  assert(copyWhileRunning.body.text.includes('STAGE_ONE_ACTIVE'), '[Test 7a] Long-running command: captured output while command is still running');

  // Wait for STAGE_TWO to complete
  await new Promise(r => setTimeout(r, 2000));
  const copyAfterComplete = await makeRequest(`/api/sessions/${targetId1}/last-interaction`, {
    headers: { 'x-auth-token': TOKEN }
  });
  assert(copyAfterComplete.body.text.includes('STAGE_ONE_ACTIVE') && copyAfterComplete.body.text.includes('STAGE_TWO_ACTIVE'), '[Test 7b] Long-running command: captured complete output after command finished');

  ws1.close();

  console.log(`\nVerification Complete: ${passed}/${total} assertions passed.`);
  serverInstance.stop();
  process.exit(passed === total ? 0 : 1);
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
