import http from 'node:http';
import readline from 'node:readline';
import { exec } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  root,
  getPortOwner,
  isTermoGoProcess,
  readStateFile
} from './lifecycle.js';
import {
  startServer,
  getLocalIp,
  ensureStableToken,
  shutdown,
  normalizeToken
} from './index.js';
import { isCloudflaredAvailable } from './tunnel.js';
import { stopTermoGo } from './stop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure consistent working directory
process.chdir(root);

const envPath = path.join(root, '.env');
if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(envPath);
  } catch {}
}

const DEFAULT_PORT = Number(process.env.PORT || 8787);
const DEFAULT_HOST = process.env.HOST || '0.0.0.0';

export function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      exec(`start "" "${url}"`, { windowsHide: true }, () => {});
    } else if (process.platform === 'darwin') {
      exec(`open "${url}"`, () => {});
    } else {
      exec(`xdg-open "${url}"`, () => {});
    }
  } catch {}
}

export async function waitForHttp(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const statusCode = await new Promise((resolve, reject) => {
        const req = http.get(url, { timeout: 1500 }, (res) => {
          resolve(res.statusCode);
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      if (statusCode && statusCode >= 200 && statusCode < 400) {
        return true;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

export async function runLauncher(args = process.argv.slice(2)) {
  // Ensure token is stable and loaded
  ensureStableToken();

  const port = DEFAULT_PORT;
  const host = DEFAULT_HOST;

  // 1. Check for CLI arguments for quick/automated launch
  const argLocal = args.includes('--local') || args.includes('-1');
  const argRemote = args.includes('--remote') || args.includes('-2');
  const argStop = args.includes('--stop') || args.includes('-3');

  if (argStop) {
    const res = await stopTermoGo();
    return res.success ? 0 : 1;
  }

  // 2. Check port status before launching
  const owner = getPortOwner(port);
  if (owner) {
    const isOur = isTermoGoProcess(owner.pid);
    if (isOur) {
      console.log(`\n[TermoGo] A TermoGo instance is already running on port ${port} (PID: ${owner.pid}).`);
      const localIp = getLocalIp();
      console.log(`Local URL: http://localhost:${port}`);
      console.log(`LAN URL:   http://${localIp}:${port}\n`);

      console.log('[TermoGo] Opening browser: http://localhost:' + port);
      openBrowser(`http://localhost:${port}`);

      if (process.stdin.isTTY && !argLocal && !argRemote) {
        console.log('\nOptions:');
        console.log('  [1] Keep server running (exit launcher)');
        console.log('  [2] Stop running instance');
        const choice = await askQuestion('\nSelect option (1/2) [default: 1]: ');
        if (choice === '2') {
          await stopTermoGo();
        }
      }
      return 0;
    } else {
      console.error(`\n============================================================`);
      console.error(`                 PORT CONFLICT DETECTED`);
      console.error(`============================================================`);
      console.error(`Port ${port} is currently used by an unrelated program:`);
      console.error(`  Process Name: ${owner.name}`);
      console.error(`  Process PID:  ${owner.pid}`);
      console.error(`\nTermoGo will NOT terminate unrelated processes.`);
      console.error(`Please close that program or edit PORT in .env before starting.`);
      console.error(`============================================================\n`);
      return 1;
    }
  }

  // 3. Determine launch mode
  let enableTunnel = false;
  const cloudflaredAvailable = isCloudflaredAvailable();
  const localIp = getLocalIp();

  if (argLocal) {
    enableTunnel = false;
  } else if (argRemote) {
    if (!cloudflaredAvailable) {
      console.error('\n[Error] Cloudflare Tunnel (cloudflared) is not installed or not in PATH.');
      console.error('Install via: winget install Cloudflare.cloudflared');
      return 1;
    }
    enableTunnel = true;
  } else if (process.stdin.isTTY) {
    console.log('\n============================================================');
    console.log('               TERMOGO STARTUP LAUNCHER                  ');
    console.log('============================================================');
    console.log(`Detected Wi-Fi / LAN IP:  ${localIp}`);
    console.log(`Cloudflare Tunnel:        ${cloudflaredAvailable ? 'Installed & Ready' : 'Not installed'}`);
    console.log('------------------------------------------------------------');
    console.log('Select connection mode:');
    console.log('  [1] Local Wi-Fi   (Phone on same Wi-Fi / LAN - Fast & Direct)');
    console.log('  [2] Remote Access (Cloudflare Tunnel - Anywhere / Mobile Data)');
    console.log('  [3] Stop TermoGo');
    console.log('  [4] Exit');
    console.log('------------------------------------------------------------');

    const choice = await askQuestion('Enter choice [1-4] (default: 1): ');

    if (choice === '2') {
      if (!cloudflaredAvailable) {
        console.log('\n[Warning] cloudflared was not found on your system.');
        console.log('To install Cloudflare Tunnel on Windows, run in PowerShell:');
        console.log('  winget install Cloudflare.cloudflared');
        console.log('or download from: https://github.com/cloudflare/cloudflared/releases\n');
        const fallback = await askQuestion('Would you like to start in Local Wi-Fi mode instead? (Y/n): ');
        if (fallback.toLowerCase() === 'n') {
          return 0;
        }
        enableTunnel = false;
      } else {
        enableTunnel = true;
      }
    } else if (choice === '3') {
      await stopTermoGo();
      return 0;
    } else if (choice === '4') {
      console.log('Exiting launcher.');
      return 0;
    } else {
      enableTunnel = false;
    }
  } else {
    // Non-interactive fallback: respect .env setting or default to local
    enableTunnel = process.env.TUNNEL === 'true';
  }

  // 4. Start Server
  console.log(`\nStarting TermoGo (${enableTunnel ? 'Remote Tunnel' : 'Local Wi-Fi'})...\n`);

  try {
    const instance = await startServer({
      port,
      host,
      enableTunnel
    });

    // 5. Open browser automatically once server responds
    const testUrl = `http://127.0.0.1:${port}/index.html`;
    waitForHttp(testUrl, 10000).then((ready) => {
      if (ready) {
        console.log(`[TermoGo] Server ready. Opening browser at http://localhost:${port}...`);
        openBrowser(`http://localhost:${port}`);
      }
    });

    // 6. Handle shutdown signals
    process.on('SIGINT', () => {
      shutdown({ signal: 'SIGINT', exitCode: 0, exitProcess: true });
    });
    process.on('SIGTERM', () => {
      shutdown({ signal: 'SIGTERM', exitCode: 0, exitProcess: true });
    });

    // Keep process alive for user terminal interaction
    return new Promise(() => {});
  } catch (err) {
    console.error('\n[TermoGo Startup Failed]', err.message);
    return 1;
  }
}

// Execute if run directly
const isMain = Boolean(
  process.argv[1] && (
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) ||
    process.argv[1].endsWith('launcher.js')
  )
);

if (isMain) {
  runLauncher().then((code) => {
    if (typeof code === 'number') {
      process.exit(code);
    }
  }).catch((err) => {
    console.error('[TermoGo Launcher Error]', err);
    process.exit(1);
  });
}
