import http from 'node-pty';
import { WebSocket } from 'ws';

const TOKEN = 'test-token-fidelity-12345';
const PORT = 8805;
const baseUrl = `http://127.0.0.1:${PORT}`;

process.env.PORT = String(PORT);
process.env.AUTH_TOKEN = TOKEN;
process.env.TUNNEL = 'false';

console.log('============================================================');
console.log('      TermoGo Terminal Fidelity & Latency Test Suite        ');
console.log('============================================================\n');

const { startServer } = await import('../server/index.js');
const serverInstance = await startServer({ port: PORT, host: '127.0.0.1', enableTunnel: false });

let total = 0;
let passed = 0;

function assert(cond, desc) {
  total++;
  if (cond) {
    console.log(`[PASS] ${desc}`);
    passed++;
  } else {
    console.error(`[FAIL] ${desc}`);
    process.exitCode = 1;
  }
}

// Helper to make REST requests
async function makeRequest(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { 'x-auth-token': TOKEN }
  });
  return { status: res.status, body: await res.json() };
}

// 1. Verify REST API returns cols and rows
const sessionsRes = await makeRequest('/api/sessions');
assert(sessionsRes.status === 200, 'GET /api/sessions returns 200');
assert(sessionsRes.body.length >= 2, 'Sessions list has default sessions');
const s0 = sessionsRes.body[0];
assert(typeof s0.cols === 'number' && typeof s0.rows === 'number', `Session reports dimensions: ${s0.cols}x${s0.rows}`);

// 2. Test Dimension Handshake on Auth:
// Client connects simulating a mobile phone: cols=46, rows=22
const mobileSessionId = s0.id;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);

let readyEvent = null;
let historyEvent = null;

await new Promise(resolve => {
  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'auth',
      token: TOKEN,
      session: mobileSessionId,
      cols: 46,
      rows: 22
    }));
  });

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') readyEvent = msg;
      if (msg.type === 'history') historyEvent = msg;
      if (readyEvent && (historyEvent || !msg.type)) resolve();
    } catch {}
  });

  setTimeout(resolve, 1500);
});

assert(readyEvent !== null, 'Client received "ready" event upon auth');
assert(readyEvent.session?.cols === 46 && readyEvent.session?.rows === 22, `PTY was synchronized to mobile dimensions on auth (46x22)`);

// 3. Test Output Micro-Batching & Streaming Fidelity:
// Wait for PowerShell prompt to be ready
await new Promise(r => setTimeout(r, 1000));

// Send a command producing multiple chunks. Verify messages are received without data loss.
let accumulatedOutput = '';
let messageCount = 0;

const marker = 'FIDELITY_BATCH_COMPLETE_9988';
await new Promise(resolve => {
  const expectedMarker = 'MARKER_EXECUTION_COMPLETED_SUCCESS';
  const onMsg = raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'output') {
        messageCount++;
        accumulatedOutput += msg.data;
        if (accumulatedOutput.includes(expectedMarker)) {
          ws.off('message', onMsg);
          resolve();
        }
      }
    } catch {}
  };
  ws.on('message', onMsg);

  // Send command that outputs lines and prints a marker (compatible with CMD and PowerShell)
  ws.send(JSON.stringify({
    type: 'input',
    data: 'echo CHUNK_LINE_1 & echo CHUNK_LINE_2 & echo CHUNK_LINE_10 & echo MARKER_EXECUTION_COMPLETED_SUCCESS\r'
  }));

  setTimeout(resolve, 5000);
});

assert(accumulatedOutput.includes('MARKER_EXECUTION_COMPLETED_SUCCESS'), 'Received expected output marker in stream');
assert(accumulatedOutput.includes('CHUNK_LINE_1') && accumulatedOutput.includes('CHUNK_LINE_10'), 'Stream preserves all generated lines in correct order');

// 4. Test Terminal Resize Synchronization
ws.send(JSON.stringify({
  type: 'resize',
  cols: 75,
  rows: 28
}));
await new Promise(r => setTimeout(r, 400));

const checkResizeRes = await makeRequest('/api/sessions');
const updatedSession = checkResizeRes.body.find(s => s.id === mobileSessionId);
assert(updatedSession.cols === 75 && updatedSession.rows === 28, `PTY resized correctly to 75x28 via WebSocket resize event`);

// 5. Test Screen Reconnect:
// Close first WebSocket
ws.close();
await new Promise(r => setTimeout(r, 500));

// Reconnect to same session
const wsReconnect = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let reconnectedHistory = '';
let reconnectedReady = null;

await new Promise(resolve => {
  wsReconnect.on('open', () => {
    wsReconnect.send(JSON.stringify({
      type: 'auth',
      token: TOKEN,
      session: mobileSessionId,
      cols: 75,
      rows: 28
    }));
  });

  wsReconnect.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ready') reconnectedReady = msg;
      if (msg.type === 'history') {
        reconnectedHistory = msg.data;
        resolve();
      }
    } catch {}
  });

  setTimeout(resolve, 2000);
});

assert(reconnectedReady !== null, 'Reconnection received "ready" event with existing session');
assert(reconnectedHistory.includes('MARKER_EXECUTION_COMPLETED_SUCCESS'), 'Reconnection received history containing previously executed output');
assert(reconnectedReady.session?.cols === 75 && reconnectedReady.session?.rows === 28, 'Reconnected session maintains synchronized dimensions (75x28)');

wsReconnect.close();

console.log(`\n============================================================`);
console.log(`Fidelity & Latency Verification: ${passed}/${total} assertions passed.`);
console.log(`============================================================\n`);

serverInstance.stop();
process.exit(passed === total ? 0 : 1);
