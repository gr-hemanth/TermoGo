import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import {
  root,
  STATE_FILE,
  readStateFile,
  writeStateFile,
  removeStateFile,
  isPidRunning,
  getPortOwner,
  isPortInUse,
  waitForPortFree,
  stopProcessTree,
  isTermBridgeProcess
} from '../server/lifecycle.js';
import { stopTermBridge } from '../server/stop.js';

const TEST_PORT = 8796;
const TEST_TOKEN = 'test-lifecycle-token-1234567890';

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

async function runLifecycleTests() {
  console.log('============================================================');
  console.log('       TermBridge Process Lifecycle & Port Cleanup Tests    ');
  console.log('============================================================\n');

  // Ensure clean test baseline
  removeStateFile();
  await waitForPortFree(TEST_PORT, 2000);

  // 1. Test basic lifecycle helpers
  console.log('--- 1. Port & State File Helpers ---');
  assert(!isPortInUse(TEST_PORT), 'Test port is initially free');
  assert(readStateFile() === null, 'readStateFile returns null when no state file exists');

  const testStateData = { pid: process.pid, port: TEST_PORT, startedAt: new Date().toISOString() };
  writeStateFile(testStateData);
  assert(fs.existsSync(STATE_FILE), 'writeStateFile creates state file on disk');
  const readBack = readStateFile();
  assert(readBack && readBack.pid === process.pid && readBack.port === TEST_PORT, 'readStateFile correctly reads written metadata');
  removeStateFile();
  assert(!fs.existsSync(STATE_FILE), 'removeStateFile successfully deletes state file');

  // 2. Test isPidRunning & isTermBridgeProcess
  console.log('\n--- 2. Process Identification & Safe PID Guards ---');
  assert(isPidRunning(process.pid), 'isPidRunning correctly identifies current running process');
  assert(!isPidRunning(99999999), 'isPidRunning returns false for non-existent PID');
  assert(isTermBridgeProcess(process.pid, root), 'isTermBridgeProcess recognizes current test process in termogo workspace');

  // 3. Test starting TermBridge and state registration
  console.log('\n--- 3. Clean Startup & State Registration ---');
  process.env.PORT = String(TEST_PORT);
  process.env.AUTH_TOKEN = TEST_TOKEN;
  process.env.TUNNEL = 'false';

  const { startServer } = await import('../server/index.js');
  const serverInstance = await startServer({
    port: TEST_PORT,
    host: '127.0.0.1',
    enableTunnel: false,
    authToken: TEST_TOKEN
  });

  assert(isPortInUse(TEST_PORT), 'Port is now in use after server start');
  const registeredState = readStateFile();
  assert(registeredState !== null, 'State file was written upon server start');
  assert(registeredState && registeredState.pid === process.pid, 'State file records correct server PID');
  assert(registeredState && registeredState.port === TEST_PORT, 'State file records correct server port');

  // 4. Test port conflict detection without crashing or killing existing process
  console.log('\n--- 4. Port Conflict Detection & Safety ---');
  let conflictDetected = false;
  try {
    // Attempt to start a second server instance on the exact same port
    await startServer({
      port: TEST_PORT,
      host: '127.0.0.1',
      enableTunnel: false,
      authToken: TEST_TOKEN
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      conflictDetected = true;
    }
  }
  assert(conflictDetected, 'Starting a second instance detects port conflict before listen and rejects cleanly');
  assert(isPortInUse(TEST_PORT), 'Original server instance remains alive and untouched after conflict rejection');

  // 5. Test session persistence on client disconnect vs server shutdown
  console.log('\n--- 5. Terminal Session Persistence vs Deliberate Shutdown ---');
  // Find PowerShell session
  const defaultSession = Array.from(serverInstance.sessions.values()).find(s => s.title === 'PowerShell');
  assert(Boolean(defaultSession), 'Default persistent session exists');

  const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
  await new Promise((resolve) => ws.on('open', resolve));

  // Authenticate and attach to PowerShell session
  ws.send(JSON.stringify({ type: 'auth', token: TEST_TOKEN, session: defaultSession.id }));
  await new Promise(r => setTimeout(r, 500));

  // Send input to attached session
  ws.send(JSON.stringify({ type: 'input', data: 'Write-Host "LIFECYCLE_PERSIST_TEST"\r' }));
  await new Promise(r => setTimeout(r, 1200));

  // Disconnect WebSocket client (simulating mobile phone disconnection)
  ws.close();
  await new Promise(r => setTimeout(r, 400));

  assert(serverInstance.sessions.has(defaultSession.id), 'Session remains alive in memory after client disconnects');
  assert(defaultSession.history.join('').includes('LIFECYCLE_PERSIST_TEST'), 'Session scrollback buffer is preserved after client disconnects');

  // 6. Test graceful shutdown via loopback HTTP POST /api/server/shutdown
  console.log('\n--- 6. Loopback Graceful Shutdown API ---');
  // First test unauthorized call
  const unauthRes = await new Promise((resolve) => {
    const req = http.request(
      `http://127.0.0.1:${TEST_PORT}/api/server/shutdown`,
      { method: 'POST', headers: { 'x-auth-token': 'wrong-token' } },
      (res) => resolve(res.statusCode)
    );
    req.end();
  });
  assert(unauthRes === 401, 'Unauthorized request to /api/server/shutdown is rejected with 401');

  // Test authorized shutdown
  const authRes = await new Promise((resolve) => {
    const req = http.request(
      `http://127.0.0.1:${TEST_PORT}/api/server/shutdown`,
      { method: 'POST', headers: { 'x-auth-token': TEST_TOKEN } },
      (res) => resolve(res.statusCode)
    );
    req.end();
  });
  assert(authRes === 200, 'Authorized request to /api/server/shutdown succeeds with 200');

  // Wait for port release
  const freed = await waitForPortFree(TEST_PORT, 4000);
  assert(freed, 'Listener port was successfully released following shutdown');
  assert(!fs.existsSync(STATE_FILE), 'State file was automatically removed upon shutdown');

  // 7. Test npm run stop when server is already stopped (idempotency)
  console.log('\n--- 7. Idempotent Stop When Already Stopped ---');
  const alreadyStoppedResult = await stopTermBridge();
  assert(alreadyStoppedResult.success === true, 'stopTermBridge succeeds and exits code 0 when server is already stopped');
  assert(alreadyStoppedResult.stopped === false, 'stopTermBridge correctly reports server was not running');

  // 8. Test stale state file cleanup
  console.log('\n--- 8. Stale State File Cleanup ---');
  writeStateFile({ pid: 99999998, port: TEST_PORT, startedAt: new Date().toISOString() });
  assert(fs.existsSync(STATE_FILE), 'Created dummy stale state file');
  const staleCleanResult = await stopTermBridge();
  assert(staleCleanResult.success === true, 'stopTermBridge safely cleans up stale state file');
  assert(!fs.existsSync(STATE_FILE), 'Stale state file was deleted');

  // 9. Test stop command with a spawned child TermBridge instance
  console.log('\n--- 9. Full Process Spawn and npm run stop Cycle ---');
  // Spawn child node server/index.js on TEST_PORT
  const childEnv = { ...process.env, PORT: String(TEST_PORT), AUTH_TOKEN: TEST_TOKEN, TUNNEL: 'false' };
  const child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    env: childEnv,
    stdio: 'ignore',
    windowsHide: true
  });

  // Wait for child to bind port and write state file
  const childStarted = await new Promise(async (resolve) => {
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (isPortInUse(TEST_PORT) && fs.existsSync(STATE_FILE)) {
        return resolve(true);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    resolve(false);
  });

  assert(childStarted, 'Child TermBridge process started and bound port');
  const childState = readStateFile();
  assert(childState && childState.pid === child.pid, 'Child state file recorded child PID');

  // Now execute stopTermBridge to stop the spawned child instance
  const stopChildResult = await stopTermBridge();
  assert(stopChildResult.success === true, 'stopTermBridge successfully stopped the child instance');
  const childFreed = await waitForPortFree(TEST_PORT, 4000);
  assert(childFreed, 'Port was verified completely free after stopping child instance');
  assert(!isPidRunning(child.pid), 'Child process is verified terminated');
  assert(!fs.existsSync(STATE_FILE), 'State file removed after stopping child instance');

  // 10. Summary
  console.log('\n============================================================');
  console.log(`Lifecycle Verification Summary: ${passed}/${total} assertions passed.`);
  console.log('============================================================\n');

  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runLifecycleTests().catch(err => {
  console.error('[FATAL] Lifecycle test suite error:', err);
  removeStateFile();
  process.exit(1);
});
