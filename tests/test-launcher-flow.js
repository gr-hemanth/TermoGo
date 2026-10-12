import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  getLocalIp,
  normalizeToken,
  ensureStableToken,
  startServer
} from '../server/index.js';
import { isCloudflaredAvailable, findCloudflaredBinary } from '../server/tunnel.js';
import { getPortOwner, isTermBridgeProcess } from '../server/lifecycle.js';
import { waitForHttp } from '../server/launcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

let total = 0;
let passed = 0;

function check(desc, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
  }
}

async function checkAsync(desc, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${desc}`);
  } catch (err) {
    console.error(`  ✗ ${desc}`);
    console.error(`    ${err.message}`);
  }
}

async function runLauncherFlowTests() {
  console.log('\n============================================================');
  console.log('             TERMBRIDGE LAUNCHER FLOW TESTS                 ');
  console.log('============================================================\n');

  console.log('--- 1. Wi-Fi / Local IP Detection ---');
  check('getLocalIp returns non-empty IPv4', () => {
    const ip = getLocalIp();
    assert.ok(typeof ip === 'string' && ip.length > 0);
    assert.match(ip, /^\d+\.\d+\.\d+\.\d+$/);
  });

  check('getLocalIp strictly excludes Cloudflare WARP tunnel adapter (172.16.0.2)', () => {
    const ip = getLocalIp();
    assert.notEqual(ip, '172.16.0.2');
  });

  check('getLocalIp excludes APIPA link-local addresses (169.254.x.x)', () => {
    const ip = getLocalIp();
    assert.ok(!ip.startsWith('169.254.'));
  });

  check('getLocalIp prioritizes active Wi-Fi IPv4 address when available', () => {
    const ip = getLocalIp();
    const ifaces = os.networkInterfaces();
    if (ifaces['Wi-Fi']) {
      const wifiIpv4 = ifaces['Wi-Fi'].find(i => i.family === 'IPv4' && !i.internal);
      if (wifiIpv4) {
        assert.equal(ip, wifiIpv4.address);
      }
    }
  });

  console.log('\n--- 2. Token Normalization ---');
  check('normalizeToken trims leading/trailing whitespace', () => {
    assert.equal(normalizeToken('   secretToken   '), 'secretToken');
  });

  check('normalizeToken strips double and single quotes', () => {
    assert.equal(normalizeToken('"quotedToken"'), 'quotedToken');
    assert.equal(normalizeToken("'singleQuoted'"), 'singleQuoted');
  });

  check('normalizeToken handles mixed quotes with surrounding whitespace', () => {
    assert.equal(normalizeToken(' " mixedQuotes " '), 'mixedQuotes');
    assert.equal(normalizeToken(" ' mixedSingle ' "), 'mixedSingle');
  });

  check('normalizeToken returns empty string for non-string/falsy inputs', () => {
    assert.equal(normalizeToken(null), '');
    assert.equal(normalizeToken(undefined), '');
    assert.equal(normalizeToken(''), '');
  });

  console.log('\n--- 3. Configuration Healing & Persistence ---');
  check('ensureStableToken heals concatenated .env lines', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-env-test-'));
    const testEnvPath = path.join(tempDir, '.env');
    fs.writeFileSync(testEnvPath, 'PORT=8787\nHOST=0.0.0.0\nTUNNEL=trueAUTH_TOKEN=test-token-1234567890\n', 'utf8');

    const result = ensureStableToken({ envFilePath: testEnvPath });
    assert.equal(result.token, 'test-token-1234567890');
    assert.equal(result.generated, false);

    const healed = fs.readFileSync(testEnvPath, 'utf8');
    assert.ok(healed.includes('TUNNEL=true\nAUTH_TOKEN=test-token-1234567890'));

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  console.log('\n--- 4. HTTP Auth Flow with Token Variations ---');
  const TEST_PORT = 8992;
  const TEST_TOKEN = 'launcher-test-flow-token-98765';

  const instance = await startServer({
    port: TEST_PORT,
    host: '127.0.0.1',
    enableTunnel: false,
    authToken: TEST_TOKEN
  });

  try {
    await checkAsync('Exact token authenticates successfully (HTTP 200)', async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/sessions`, {
        headers: { 'x-auth-token': TEST_TOKEN }
      });
      assert.equal(res.status, 200);
    });

    await checkAsync('Padded token with whitespace authenticates successfully (HTTP 200)', async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/sessions`, {
        headers: { 'x-auth-token': `  ${TEST_TOKEN}  ` }
      });
      assert.equal(res.status, 200);
    });

    await checkAsync('Quoted token authenticates successfully (HTTP 200)', async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/sessions`, {
        headers: { 'x-auth-token': `"${TEST_TOKEN}"` }
      });
      assert.equal(res.status, 200);
    });

    await checkAsync('Invalid token is rejected with HTTP 401', async () => {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/sessions`, {
        headers: { 'x-auth-token': 'invalid-token-value' }
      });
      assert.equal(res.status, 401);
    });

    await checkAsync('waitForHttp detects running server within timeout', async () => {
      const ready = await waitForHttp(`http://127.0.0.1:${TEST_PORT}/index.html`, 3000);
      assert.equal(ready, true);
    });
  } finally {
    await instance.stop();
  }

  console.log('\n--- 5. Cloudflare Tunnel Binary Detection ---');
  check('findCloudflaredBinary finds executable path or command name', () => {
    const bin = findCloudflaredBinary();
    assert.ok(typeof bin === 'string' && bin.length > 0);
  });

  check('isCloudflaredAvailable returns valid boolean', () => {
    const available = isCloudflaredAvailable();
    assert.ok(typeof available === 'boolean');
  });

  console.log(`\n============================================================`);
  console.log(`Launcher Flow Tests: ${passed}/${total} passed`);
  console.log(`============================================================\n`);

  process.exit(passed === total ? 0 : 1);
}

runLauncherFlowTests().catch((err) => {
  console.error('[Fatal Error in Test Suite]', err);
  process.exit(1);
});
