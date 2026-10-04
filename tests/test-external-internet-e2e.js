import https from 'node:https';
import { WebSocket } from 'ws';
import { startServer } from '../server/index.js';

console.log('=== Starting Real End-to-End Internet Tunnel Verification ===\n');

// 1. Launch TermBridge with live Cloudflare Tunnel
const testPort = 8788;
const appInstance = await startServer({
  port: testPort,
  host: '127.0.0.1',
  enableTunnel: true
});

const token = appInstance.token;
let publicUrl = appInstance.publicUrl;

if (!publicUrl && appInstance.tunnel) {
  publicUrl = await appInstance.tunnel.url;
}

console.log(`\nPublic Cloudflare URL: ${publicUrl}`);
console.log('Waiting for Cloudflare Edge DNS & routing synchronization...');

function httpsRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: 10000
    };

    const req = https.request(opts, (res) => {
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
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTPS timeout')); });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// 2. Poll public URL until Cloudflare edge reports ready (status 200 on /)
let edgeSynced = false;
for (let i = 1; i <= 15; i++) {
  try {
    process.stdout.write(`Sync Attempt ${i}/15: Pinging edge... `);
    const check = await httpsRequest(publicUrl);
    console.log(`HTTP ${check.status}`);
    if (check.status === 200) {
      edgeSynced = true;
      break;
    }
  } catch (err) {
    console.log(`Failed (${err.message})`);
  }
  await new Promise(r => setTimeout(r, 2000));
}

if (!edgeSynced) {
  console.error('\n[FAIL] Cloudflare edge did not synchronize in time.');
  appInstance.stop();
  process.exit(1);
}

console.log('\n[PASS] Cloudflare Edge synchronized successfully.\n');

// 3. Test Public HTTPS REST API Auth over Internet
console.log('Testing Public HTTPS REST API...');
const unauth = await httpsRequest(`${publicUrl}/api/sessions`);
if (unauth.status !== 401) {
  console.error(`[FAIL] Expected 401 for unauthenticated public request, got ${unauth.status}`);
  appInstance.stop();
  process.exit(1);
}
console.log('[PASS] Unauthenticated public HTTPS request blocked with 401.');

const authRes = await httpsRequest(`${publicUrl}/api/sessions`, {
  headers: { 'x-auth-token': token }
});
if (authRes.status !== 200 || !Array.isArray(authRes.body)) {
  console.error(`[FAIL] Authenticated public HTTPS request failed: status ${authRes.status}`);
  appInstance.stop();
  process.exit(1);
}
console.log(`[PASS] Authenticated public HTTPS request succeeded (200).`);
console.log(`       Discovered active sessions via Internet:`);
authRes.body.forEach(s => console.log(`         • ${s.title} (PID: ${s.pid})`));

const targetSession = authRes.body[0];
const targetId = targetSession.id;
const initialPid = targetSession.pid;

// 4. Test Public WSS WebSocket Connection over Internet
console.log('\nTesting Public WSS WebSocket Connection via Cloudflare...');
const wssUrl = publicUrl.replace(/^https:/, 'wss:') + '/ws';
console.log(`Connecting to: ${wssUrl}`);

const ws = new WebSocket(wssUrl);
let commandOutput = '';
let readyEvent = null;

await new Promise((resolve, reject) => {
  ws.on('open', () => {
    console.log('Public WSS connection opened. Sending payload authentication...');
    ws.send(JSON.stringify({ type: 'auth', token, session: targetId }));
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'ready') {
      readyEvent = msg;
      console.log(`[PASS] WSS received ready event for session ${msg.session.title} (PID: ${msg.session.pid})`);
      // Send a test command through the public internet
      console.log('Sending command over public WSS...');
      ws.send(JSON.stringify({
        type: 'input',
        data: 'echo "CLOUDFLARE_WSS_INTERNET_SUCCESS"\r'
      }));
    } else if (msg.type === 'output') {
      commandOutput += msg.data;
      if (commandOutput.includes('CLOUDFLARE_WSS_INTERNET_SUCCESS')) {
        console.log('[PASS] Output received over public WSS matching command!');
        resolve();
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WSS Error:', err);
    reject(err);
  });

  setTimeout(() => {
    if (!commandOutput.includes('CLOUDFLARE_WSS_INTERNET_SUCCESS')) {
      reject(new Error('Timeout waiting for public WSS command output'));
    }
  }, 12000);
});

// 5. Test Disconnect & Process Persistence
console.log('\nClosing public WSS connection (simulating phone disconnect/screen lock)...');
ws.close();
await new Promise(r => setTimeout(r, 1000));

// Verify via public HTTPS that session PID has NOT changed
const afterDisconnect = await httpsRequest(`${publicUrl}/api/sessions`, {
  headers: { 'x-auth-token': token }
});
const persistentSession = afterDisconnect.body.find(s => s.id === targetId);
if (!persistentSession || persistentSession.pid !== initialPid) {
  console.error(`[FAIL] Process identity lost! Expected PID ${initialPid}, found ${persistentSession?.pid}`);
  appInstance.stop();
  process.exit(1);
}
console.log(`[PASS] Terminal process remained alive and running during client disconnect! (PID: ${initialPid})`);

// 6. Test Reconnect & Scrollback Recovery over Public WSS
console.log('\nReconnecting 2nd public WSS client (simulating phone reconnection)...');
const ws2 = new WebSocket(wssUrl);
let recoveredHistory = false;

await new Promise((resolve, reject) => {
  ws2.on('open', () => {
    ws2.send(JSON.stringify({ type: 'auth', token, session: targetId }));
  });

  ws2.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'history') {
      if (msg.data.includes('CLOUDFLARE_WSS_INTERNET_SUCCESS')) {
        recoveredHistory = true;
        console.log('[PASS] Reconnected public WSS received full scrollback history replay!');
        resolve();
      }
    }
  });

  ws2.on('error', reject);
  setTimeout(() => resolve(), 8000);
});

ws2.close();

if (!recoveredHistory) {
  console.error('[FAIL] History replay did not contain previous command output.');
  appInstance.stop();
  process.exit(1);
}

console.log('\n============================================================');
console.log('       ALL END-TO-END INTERNET TESTS COMPLETED SUCCESSFULLY!  ');
console.log('============================================================\n');

appInstance.stop();
process.exit(0);
