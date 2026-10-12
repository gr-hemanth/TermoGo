import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocket } from 'ws';
import {
  root,
  isPortInUse,
  waitForPortFree
} from '../server/lifecycle.js';
import { stopTermBridge } from '../server/stop.js';
import {
  ensureStableToken,
  shouldDisplayToken,
  startServer
} from '../server/index.js';

const TEST_PORT = 8794;
let passed = 0;
let total = 0;

function assert(condition, message) {
  total++;
  if (condition) {
    console.log(`[PASS] ${message}`);
    passed++;
  } else {
    console.error(`[FAIL] ${message}`);
  }
}

async function runTests() {
  console.log('============================================================');
  console.log('       TermBridge Token Display & Persistence Tests         ');
  console.log('============================================================\n');

  // Ensure test port is free initially
  await stopTermBridge();
  await waitForPortFree(TEST_PORT, 2000);

  // 1. Test ensureStableToken persistence & comment preservation on custom temp env
  console.log('--- 1. Token Generation, Stability & .env Preservation ---');
  const tempEnvPath = path.join(root, 'scratch-test.env');
  const initialContent = '# Initial configuration comment\nPORT=9999\nHOST=127.0.0.1\n# Auth placeholder\nAUTH_TOKEN=\nTUNNEL=false\n';
  fs.writeFileSync(tempEnvPath, initialContent, 'utf8');

  // First run: should generate token and write to scratch-test.env
  const result1 = ensureStableToken({ envFilePath: tempEnvPath });
  assert(result1.generated === true, 'Generated new token when AUTH_TOKEN was empty');
  assert(typeof result1.token === 'string' && result1.token.length === 32, 'Generated token is 32 hex characters (128-bit)');

  const updatedContent = fs.readFileSync(tempEnvPath, 'utf8');
  assert(updatedContent.includes('# Initial configuration comment'), 'Preserved top comment in .env');
  assert(updatedContent.includes('PORT=9999'), 'Preserved PORT setting in .env');
  assert(updatedContent.includes('HOST=127.0.0.1'), 'Preserved HOST setting in .env');
  assert(updatedContent.includes(`AUTH_TOKEN=${result1.token}`), 'Saved generated token in AUTH_TOKEN line');

  // Second run: should retain exact same token across restarts without regenerating
  const result2 = ensureStableToken({ envFilePath: tempEnvPath });
  assert(result2.generated === false, 'Did not regenerate token when valid token was present in .env');
  assert(result2.token === result1.token, 'Preserved identical token across restarts');

  // Clean up scratch env
  if (fs.existsSync(tempEnvPath)) fs.unlinkSync(tempEnvPath);

  // 2. Test shouldDisplayToken helper
  console.log('\n--- 2. Foreground vs Redirection Security Guards ---');
  const origDisplay = process.env.DISPLAY_TOKEN;
  const origDaemon = process.env.IS_DAEMON;

  process.env.DISPLAY_TOKEN = 'true';
  assert(shouldDisplayToken() === true, 'shouldDisplayToken returns true when DISPLAY_TOKEN=true');

  process.env.DISPLAY_TOKEN = 'false';
  assert(shouldDisplayToken() === false, 'shouldDisplayToken returns false when DISPLAY_TOKEN=false');

  delete process.env.DISPLAY_TOKEN;
  process.env.IS_DAEMON = 'true';
  assert(shouldDisplayToken() === false, 'shouldDisplayToken returns false when running as daemon');

  // Restore env
  if (origDisplay !== undefined) process.env.DISPLAY_TOKEN = origDisplay; else delete process.env.DISPLAY_TOKEN;
  if (origDaemon !== undefined) process.env.IS_DAEMON = origDaemon; else delete process.env.IS_DAEMON;

  // 3. Test Remote Access strict validation at startup
  console.log('\n--- 3. Remote Access Token Validation ---');
  let emptyRejected = false;
  try {
    await startServer({ port: TEST_PORT, enableTunnel: true, authToken: '' });
  } catch {
    emptyRejected = true;
  }
  assert(emptyRejected, 'Remote access rejects empty token');

  let defaultRejected = false;
  try {
    await startServer({ port: TEST_PORT, enableTunnel: true, authToken: 'change-this-token' });
  } catch {
    defaultRejected = true;
  }
  assert(defaultRejected, 'Remote access rejects default token');

  let shortRejected = false;
  try {
    await startServer({ port: TEST_PORT, enableTunnel: true, authToken: 'short-123' });
  } catch {
    shortRejected = true;
  }
  assert(shortRejected, 'Remote access rejects token under 16 characters');

  // 4. Test live server process startup, banner output & token display
  console.log('\n--- 4. Live Server Process & Foreground Console Banner ---');
  const childEnv = {
    ...process.env,
    PORT: String(TEST_PORT),
    TUNNEL: 'false',
    DISPLAY_TOKEN: 'true'
  };

  let capturedOutput = '';
  const serverChild = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverChild.stdout.on('data', chunk => { capturedOutput += chunk.toString(); });
  serverChild.stderr.on('data', chunk => { capturedOutput += chunk.toString(); });

  // Wait for server to bind port and display banner
  const serverReady = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (capturedOutput.includes('TERMBRIDGE SERVER STARTED') && capturedOutput.includes('ACCESS TOKEN:')) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > 10000) {
        clearInterval(iv);
        resolve(false);
      }
    }, 200);
  });

  assert(serverReady, 'Server started and printed banner with ACCESS TOKEN within 10s');
  assert(capturedOutput.includes('Local URL:    http://localhost:' + TEST_PORT), 'Banner displays correct Local URL');
  assert(capturedOutput.includes('LAN URL:      http://'), 'Banner displays actual LAN URL');
  assert(capturedOutput.includes('Keep your token private.'), 'Banner displays security notice');

  // Extract the displayed access token from captured banner
  const tokenMatch = capturedOutput.match(/ACCESS TOKEN:\r?\n([a-f0-9]{16,64})/i);
  assert(Boolean(tokenMatch && tokenMatch[1]), 'Successfully parsed displayed access token from terminal banner');
  const displayedToken = tokenMatch ? tokenMatch[1] : '';

  // 5. Test authentication from mobile client using the displayed token
  console.log('\n--- 5. Authentication Verification with Displayed Token ---');
  // REST API check
  const restRes = await new Promise((resolve) => {
    const req = http.request(
      `http://127.0.0.1:${TEST_PORT}/api/sessions`,
      { method: 'GET', headers: { 'x-auth-token': displayedToken } },
      (res) => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(b) }));
      }
    );
    req.end();
  });

  assert(restRes.status === 200, 'REST request authenticated successfully with displayed token');
  assert(Array.isArray(restRes.data) && restRes.data.length >= 2, 'Default terminal sessions returned to authenticated client');
  const targetSession = restRes.data[0];

  // WebSocket check
  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  let wsAuthSuccess = false;
  let wsAttached = false;

  await new Promise((resolve) => {
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth_success') wsAuthSuccess = true;
        if (msg.type === 'ready' || msg.type === 'attached') {
          wsAttached = true;
          resolve();
        }
      } catch {}
    });
    // Send auth with displayed token
    ws.send(JSON.stringify({ type: 'auth', token: displayedToken, session: targetSession.id }));
    setTimeout(resolve, 3000);
  });

  assert(wsAttached, 'WebSocket authenticated and attached successfully with displayed token');
  ws.close();

  // 6. Test token stability across process restarts
  console.log('\n--- 6. Token Stability Across Server Restarts ---');
  // Stop running child
  await stopTermBridge();
  await waitForPortFree(TEST_PORT, 4000);
  assert(!isPortInUse(TEST_PORT), 'First server instance stopped and port released');

  // Spawn second child instance
  let secondCapturedOutput = '';
  const secondChild = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  secondChild.stdout.on('data', chunk => { secondCapturedOutput += chunk.toString(); });
  secondChild.stderr.on('data', chunk => { secondCapturedOutput += chunk.toString(); });

  const secondReady = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (secondCapturedOutput.includes('TERMBRIDGE SERVER STARTED') && secondCapturedOutput.includes('ACCESS TOKEN:')) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > 10000) {
        clearInterval(iv);
        resolve(false);
      }
    }, 200);
  });

  assert(secondReady, 'Second server instance started and printed banner');
  const secondTokenMatch = secondCapturedOutput.match(/ACCESS TOKEN:\r?\n([a-f0-9]{16,64})/i);
  const secondDisplayedToken = secondTokenMatch ? secondTokenMatch[1] : '';

  assert(
    secondDisplayedToken === displayedToken,
    'Restarted server displayed the EXACT SAME token (stable across restarts)'
  );

  // 7. Test non-interactive redaction guard
  console.log('\n--- 7. Non-Interactive Output Redaction Guard ---');
  // Stop second child
  await stopTermBridge();
  await waitForPortFree(TEST_PORT, 4000);

  // Spawn with DISPLAY_TOKEN=false to simulate redirected output / daemon
  let redirectedOutput = '';
  const thirdChild = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: { ...childEnv, DISPLAY_TOKEN: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  thirdChild.stdout.on('data', chunk => { redirectedOutput += chunk.toString(); });
  thirdChild.stderr.on('data', chunk => { redirectedOutput += chunk.toString(); });

  await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (redirectedOutput.includes('TERMBRIDGE SERVER STARTED')) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > 8000) {
        clearInterval(iv);
        resolve(false);
      }
    }, 200);
  });

  assert(!redirectedOutput.includes(displayedToken), 'Access token is NOT printed when output is redirected/non-interactive');
  assert(redirectedOutput.includes('[Protected - Non-interactive/redirected stdout]'), 'Redacted security notice printed in redirected output');

  // Final stop
  await stopTermBridge();
  await waitForPortFree(TEST_PORT, 4000);
  assert(!isPortInUse(TEST_PORT), 'Test port cleanly released');

  // Summary
  console.log('\n============================================================');
  console.log(`Verification Summary: ${passed}/${total} assertions passed.`);
  console.log('============================================================\n');

  process.exit(passed === total ? 0 : 1);
}

runTests().catch(async (err) => {
  console.error('[FATAL ERROR]', err);
  await stopTermBridge();
  process.exit(1);
});
