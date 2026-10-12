import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  root,
  readStateFile,
  removeStateFile,
  isPidRunning,
  getPortOwner,
  waitForPortFree,
  stopProcessTree,
  isTermBridgeProcess
} from './lifecycle.js';

const envPath = path.join(root, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
  } catch {}
}

const DEFAULT_PORT = Number(process.env.PORT || 8787);

async function requestGracefulShutdown(port, token) {
  if (!token) return false;
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/server/shutdown',
        method: 'POST',
        headers: {
          'x-auth-token': token,
          'connection': 'close'
        },
        timeout: 1500
      },
      (res) => {
        resolve(res.statusCode === 200);
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export async function stopTermBridge() {
  console.log('[TermBridge Stop] Inspecting running instance...');
  const state = readStateFile();
  const targetPort = state?.port || DEFAULT_PORT;

  if (state && state.pid) {
    const pid = Number(state.pid);
    if (!isPidRunning(pid)) {
      console.log(`[TermBridge Stop] Stale state file detected (PID ${pid} is not running). Cleaning up...`);
      removeStateFile();
      const portOwner = getPortOwner(targetPort);
      if (!portOwner) {
        console.log(`[TermBridge Stop] Port ${targetPort} is already free. TermBridge is stopped.`);
        return { success: true, stopped: true, reason: 'stale_cleaned' };
      }
      console.warn(`[TermBridge Stop Warning] Port ${targetPort} is occupied by ${portOwner.name} (PID: ${portOwner.pid}).`);
    } else {
      // Process is running, verify it belongs to TermBridge
      const isOurs = isTermBridgeProcess(pid, root);
      if (!isOurs) {
        console.warn(`[TermBridge Stop Warning] PID ${pid} does not appear to match this TermBridge workspace. Skipping termination to prevent collateral damage.`);
        removeStateFile();
        return { success: false, reason: 'unmatched_process' };
      }

      console.log(`[TermBridge Stop] Found active TermBridge instance (PID: ${pid}, Port: ${targetPort}). Requesting shutdown...`);

      // Try graceful loopback HTTP shutdown first if token exists
      let gracefulInitiated = false;
      if (state.token) {
        gracefulInitiated = await requestGracefulShutdown(targetPort, state.token);
      }

      if (gracefulInitiated) {
        console.log('[TermBridge Stop] Graceful shutdown requested over loopback. Waiting for port release...');
        const released = await waitForPortFree(targetPort, 3500);
        if (released && !isPidRunning(pid)) {
          removeStateFile();
          console.log(`[TermBridge Stop] Successfully stopped TermBridge (PID ${pid}). Port ${targetPort} released.`);
          return { success: true, stopped: true };
        }
      }

      // If graceful shutdown didn't exit or didn't release port, use targeted process tree kill
      console.log(`[TermBridge Stop] Performing targeted process termination for PID ${pid}...`);
      if (state.tunnelPid && isPidRunning(state.tunnelPid)) {
        stopProcessTree(state.tunnelPid);
      }
      stopProcessTree(pid);

      const released = await waitForPortFree(targetPort, 4000);
      removeStateFile();

      if (released) {
        console.log(`[TermBridge Stop] Successfully stopped TermBridge and released port ${targetPort}.`);
        return { success: true, stopped: true };
      } else {
        const remainingOwner = getPortOwner(targetPort);
        console.warn(`[TermBridge Stop Warning] Port ${targetPort} is still held by ${remainingOwner?.name} (PID ${remainingOwner?.pid}).`);
        return { success: false, reason: 'port_still_held' };
      }
    }
  }

  // If no state file, check if port has a running TermBridge process
  const portOwner = getPortOwner(targetPort);
  if (!portOwner) {
    console.log(`[TermBridge Stop] TermBridge is not running (Port ${targetPort} is free).`);
    return { success: true, stopped: false, reason: 'not_running' };
  }

  // Port is in use, verify if it belongs to TermBridge
  if (isTermBridgeProcess(portOwner.pid, root)) {
    console.log(`[TermBridge Stop] Found unmanaged TermBridge process (PID: ${portOwner.pid}, Name: ${portOwner.name}) on port ${targetPort}. Stopping...`);
    stopProcessTree(portOwner.pid);
    const released = await waitForPortFree(targetPort, 4000);
    removeStateFile();
    if (released) {
      console.log(`[TermBridge Stop] Released port ${targetPort}.`);
      return { success: true, stopped: true };
    }
    return { success: false, reason: 'port_not_released' };
  } else {
    console.warn(`[TermBridge Stop] Port ${targetPort} is occupied by unrelated process "${portOwner.name}" (PID: ${portOwner.pid}). Leaving process untouched.`);
    return { success: false, reason: 'unrelated_process_on_port' };
  }
}

// Direct execution
const isMain = Boolean(
  process.argv[1] && (
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
    process.argv[1].endsWith('stop.js')
  )
);

if (isMain) {
  stopTermBridge().then(result => {
    process.exit(result.success ? 0 : 1);
  }).catch(err => {
    console.error('[TermBridge Stop Error]', err);
    process.exit(1);
  });
}
