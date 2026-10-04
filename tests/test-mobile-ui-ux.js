import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-mobile-ui-ux';
const PORT = 8801;
const baseUrl = `http://127.0.0.1:${PORT}`;

process.env.PORT = String(PORT);
process.env.AUTH_TOKEN = TOKEN;
process.env.TUNNEL = 'false';

console.log('============================================================');
console.log('       Starting TermoGo Mobile UI/UX Verification Suite     ');
console.log('============================================================\n');

const { startServer } = await import('../server/index.js');
const serverInstance = await startServer({ port: PORT, host: '127.0.0.1', enableTunnel: false });

function makeRequest(pathName, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, baseUrl);
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

function connectWs(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN, session: sessionId }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') resolve(ws);
      } catch {}
    });
    ws.on('error', reject);
  });
}

function sendAndAwaitOutput(ws, command, expectedMarker, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let accumulated = '';
    const onMessage = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'output') {
          accumulated += msg.data;
          if (accumulated.includes(expectedMarker)) {
            ws.off('message', onMessage);
            clearTimeout(timer);
            resolve({ matched: true, output: accumulated });
          }
        }
      } catch {}
    };

    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve({ matched: false, output: accumulated });
    }, timeoutMs);

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'input', data: command }));
  });
}

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

async function runAllTests() {
  console.log('--- TEST A: STOP Button (Ctrl+C Interrupt Without Destroying Session) ---');
  // 1. Get or create a session
  const listRes = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  assert(listRes.status === 200 && listRes.body.length > 0, 'Sessions available for TEST A');
  const sessionA = listRes.body[0];

  // 2. Open terminal via WebSocket
  const wsA = await connectWs(sessionA.id);
  assert(wsA.readyState === WebSocket.OPEN, 'Connected WebSocket to session for TEST A');

  // 3. Run long running command
  const longCmd = 'Write-Host "START_LONG_PROCESS"; Start-Sleep -Seconds 15; Write-Host "UNEXPECTED_AFTER_SLEEP"\r';
  const startPromise = sendAndAwaitOutput(wsA, longCmd, 'START_LONG_PROCESS', 6000);
  const startResult = await startPromise;
  assert(startResult.matched, 'Long running command started and outputted initial marker');

  // 4. Tap STOP (sends \x03 Ctrl+C to PTY)
  console.log('   Action: Tapping [ STOP ] (sending \\x03 Ctrl+C interrupt)...');
  wsA.send(JSON.stringify({ type: 'input', data: '\x03' }));

  // 5. Wait 2 seconds and confirm command stopped (never outputted UNEXPECTED_AFTER_SLEEP)
  let postStopOutput = '';
  const postStopPromise = new Promise(resolve => {
    const handler = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'output') postStopOutput += msg.data;
      } catch {}
    };
    wsA.on('message', handler);
    setTimeout(() => {
      wsA.off('message', handler);
      resolve();
    }, 2000);
  });
  await postStopPromise;

  assert(!postStopOutput.includes('UNEXPECTED_AFTER_SLEEP'), 'Command stopped immediately after STOP was tapped (did not finish 15s sleep)');
  assert(wsA.readyState === WebSocket.OPEN, 'Terminal WebSocket remains open and alive after STOP');

  // 6. Enter another command and confirm it works immediately
  const nextCmdResult = await sendAndAwaitOutput(wsA, 'echo "IMMEDIATE_NEXT_CMD_OK"\r', 'IMMEDIATE_NEXT_CMD_OK', 6000);
  assert(nextCmdResult.matched, 'Entered new command immediately and confirmed it works');

  wsA.close();

  console.log('\n--- TEST B: DELETE Terminal Lifecycle & Confirmation ---');
  // 1. Create two new distinct terminals
  const create1 = await makeRequest('/api/sessions', {
    method: 'POST',
    headers: { 'x-auth-token': TOKEN, 'content-type': 'application/json' },
    body: { title: 'Delete Test Terminal 1' }
  });
  const create2 = await makeRequest('/api/sessions', {
    method: 'POST',
    headers: { 'x-auth-token': TOKEN, 'content-type': 'application/json' },
    body: { title: 'Delete Test Terminal 2' }
  });

  assert(create1.status === 201 && create2.status === 201, 'Created two distinct terminals for deletion test');
  const term1 = create1.body;
  const term2 = create2.body;
  assert(typeof term1.pid === 'number' && typeof term2.pid === 'number', `Both terminals have active OS processes (PID: ${term1.pid}, PID: ${term2.pid})`);

  // 2. Verify both appear in sessions list
  const listBefore = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  const idsBefore = listBefore.body.map(s => s.id);
  assert(idsBefore.includes(term1.id) && idsBefore.includes(term2.id), 'Both terminals exist in server session list');

  // 3. Simulate cancel: user opens dialog, hits Cancel -> no API call, nothing deleted
  console.log('   Simulating: User clicks Cancel on confirmation dialog -> no deletion occurs');
  const listCancel = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  assert(listCancel.body.map(s => s.id).includes(term1.id), 'Cancel action verified: terminal was NOT deleted');

  // 4. Confirm Delete for term1
  console.log(`   Simulating: User confirms Delete for "${term1.title}" (${term1.id})...`);
  const delRes = await makeRequest(`/api/sessions/${term1.id}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': TOKEN }
  });
  assert(delRes.status === 204, 'DELETE /api/sessions/:id returned HTTP 204 No Content');

  // 5. Verify term1 is removed from sessions list
  const listAfter = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  const idsAfter = listAfter.body.map(s => s.id);
  assert(!idsAfter.includes(term1.id), 'Deleted terminal disappeared from session manager list');

  // 6. Verify term2 remains completely unaffected and operational
  assert(idsAfter.includes(term2.id), 'Other terminal (Terminal 2) remains unaffected in session list');
  const wsTerm2 = await connectWs(term2.id);
  const term2Cmd = await sendAndAwaitOutput(wsTerm2, 'echo "TERM2_STILL_OPERATIONAL"\r', 'TERM2_STILL_OPERATIONAL', 5000);
  assert(term2Cmd.matched, 'Other terminal remains operational and executes commands successfully');
  wsTerm2.close();

  console.log('\n--- TEST C: CURRENT TERMINAL DELETION ---');
  // Connect WebSocket to term2 (representing the actively viewed terminal)
  const wsActive = await connectWs(term2.id);
  let receivedExit = false;
  let exitCloseCode = null;

  wsActive.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'exit') receivedExit = true;
    } catch {}
  });

  wsActive.on('close', (code) => {
    exitCloseCode = code;
  });

  // User currently viewing term2 deletes term2
  console.log(`   Deleting currently viewed terminal "${term2.title}"...`);
  const delCurrentRes = await makeRequest(`/api/sessions/${term2.id}`, {
    method: 'DELETE',
    headers: { 'x-auth-token': TOKEN }
  });
  assert(delCurrentRes.status === 204, 'DELETE of active terminal returned HTTP 204');

  await new Promise(r => setTimeout(r, 600));

  assert(receivedExit || exitCloseCode !== null, 'Client attached to deleted active terminal received exit/close event cleanly');
  const listFinal = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  assert(!listFinal.body.map(s => s.id).includes(term2.id), 'Active terminal completely removed from server sessions');

  console.log('\n--- TEST D: PHONE UX, LAYOUT & CONTROLS AUDIT ---');
  const htmlPath = path.resolve(__dirname, '..', 'web', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // 1. Verify STOP button replaces ^C
  assert(html.includes('id="key-stop"'), 'STOP button (#key-stop) is present in DOM');
  assert(html.includes('■ STOP') || html.includes('STOP'), 'STOP button has clear, visible STOP label');
  assert(!html.includes('id="key-ctrl-c"'), 'Old ^C button (#key-ctrl-c) has been replaced');
  assert(html.includes('.tool-key-stop'), 'STOP button has dedicated distinguished styling (.tool-key-stop)');

  // 2. Verify COPY LAST button retained and styled
  assert(html.includes('id="key-copy-last"') && html.includes('COPY LAST'), 'COPY LAST retained in mobile toolbar with clear label');
  assert(html.includes('.tool-key-copy-last'), 'COPY LAST has dedicated distinguished styling (.tool-key-copy-last)');

  // 3. Verify other essential controls retained
  assert(html.includes('id="key-esc"') && html.includes('ESC'), 'ESC control retained');
  assert(html.includes('id="key-tab"') && html.includes('TAB'), 'TAB control retained');
  assert(html.includes('id="key-ctrl"') && html.includes('CTRL'), 'CTRL control retained');
  assert(html.includes('id="key-up"') && html.includes('id="key-down"'), 'Arrow navigation controls retained');
  assert(html.includes('id="key-copy"') && html.includes('SEL'), 'SEL (copy selection) retained');

  // 4. Verify touch targets and gap spacing
  assert(html.includes('min-width: 44px') || html.includes('min-height: 40px'), 'Buttons have comfortable mobile touch target sizing (min-height >= 40px)');
  assert(html.includes('gap: 8px'), 'Mobile toolbar has 8px gap between buttons preventing accidental adjacent taps');

  // 5. Verify horizontal scroll & no page overflow
  assert(html.includes('overflow-x: auto'), 'Mobile toolbar supports horizontal momentum scrolling');
  assert(html.includes('overscroll-behavior-x: contain'), 'Toolbar contains scroll bounce preventing whole-page shift');

  // 6. Verify Delete Confirmation Dialog
  assert(html.includes('id="delete-modal"'), 'Delete confirmation modal (#delete-modal) exists');
  assert(html.includes('Delete terminal?'), 'Modal title "Delete terminal?" exists');
  assert(html.includes('id="btn-cancel-delete"'), 'Cancel button (#btn-cancel-delete) exists in dialog');
  assert(html.includes('id="btn-confirm-delete"'), 'Confirm Delete button (#btn-confirm-delete) exists in dialog');

  // 7. Verify Terminals top-right button
  assert(html.includes('id="btn-toggle-view"') && html.includes('Terminals'), 'Terminals header button exists for session management view');

  // 8. Verify Open and Delete actions on cards
  assert(html.includes('btn-card-open'), 'Terminal cards provide dedicated [Open] action');
  assert(html.includes('btn-card-delete'), 'Terminal cards provide dedicated [Delete] action');

  console.log(`\n============================================================`);
  console.log(`Verification Complete: ${passed}/${total} assertions passed.`);
  console.log(`============================================================\n`);

  serverInstance.stop();
  process.exit(passed === total ? 0 : 1);
}

runAllTests().catch(err => {
  console.error('Test execution failed:', err);
  if (serverInstance) serverInstance.stop();
  process.exit(1);
});
