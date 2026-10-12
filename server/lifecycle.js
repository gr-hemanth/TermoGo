import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(__dirname, '..');
export const STATE_FILE = path.join(root, '.termbridge.state.json');

export function getStateFilePath() {
  return STATE_FILE;
}

export function readStateFile() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const content = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch {}
  return null;
}

export function writeStateFile(data) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.warn('[TermBridge Warning] Could not write state file:', err.message);
    return false;
  }
}

export function removeStateFile() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      fs.unlinkSync(STATE_FILE);
      return true;
    }
  } catch {}
  return false;
}

export function isPidRunning(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export function getPortOwner(port) {
  const targetPort = Number(port);
  if (!Number.isFinite(targetPort) || targetPort <= 0) return null;

  if (process.platform !== 'win32') {
    try {
      const out = execSync(`lsof -i :${targetPort} -t`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000
      });
      const pid = parseInt(out.trim(), 10);
      return Number.isFinite(pid) ? { pid, name: 'unknown' } : null;
    } catch {
      return null;
    }
  }

  try {
    const output = execSync('netstat -ano -p tcp', {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    });

    const lines = output.split('\n');
    for (const line of lines) {
      if (!line.includes('LISTENING')) continue;
      // Match patterns like 0.0.0.0:8787, 127.0.0.1:8787, [::]:8787
      const portRegex = new RegExp(`(?:0\\.0\\.0\\.0|127\\.0\\.0\\.1|\\[::\\]):${targetPort}\\s+.*LISTENING\\s+(\\d+)`, 'i');
      const match = line.match(portRegex);
      if (match) {
        const pid = parseInt(match[1], 10);
        let name = 'unknown';
        try {
          const taskOutput = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
            encoding: 'utf8',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000
          });
          const parts = taskOutput.trim().split(',');
          if (parts.length > 0 && parts[0]) {
            name = parts[0].replace(/"/g, '').trim();
          }
        } catch {}
        return { pid, name };
      }
    }
  } catch {}
  return null;
}

export function isPortInUse(port) {
  return getPortOwner(port) !== null;
}

export async function waitForPortFree(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isPortInUse(port)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return !isPortInUse(port);
}

export function stopProcessTree(pid) {
  const numPid = Number(pid);
  if (!numPid || !Number.isFinite(numPid) || !isPidRunning(numPid)) return true;

  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(numPid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 4000
      });
      return !isPidRunning(numPid);
    } catch {
      return false;
    }
  } else {
    try {
      process.kill(numPid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
}

export function getProcessCommandLine(pid) {
  const numPid = Number(pid);
  if (!numPid || !Number.isFinite(numPid) || process.platform !== 'win32') return '';
  try {
    const cmd = `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${numPid}').CommandLine`;
    const out = execSync(`powershell -NoProfile -Command "${cmd}"`, {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000
    });
    return out ? out.trim() : '';
  } catch {
    return '';
  }
}

export function isTermBridgeProcess(pid, expectedRoot = root) {
  const numPid = Number(pid);
  if (!isPidRunning(numPid)) return false;

  const cmdLine = getProcessCommandLine(numPid).toLowerCase();
  const rootLower = (expectedRoot || '').toLowerCase();
  const baseName = path.basename(expectedRoot || '').toLowerCase();

  if (
    cmdLine.includes('server/index.js') ||
    cmdLine.includes('server\\index.js') ||
    cmdLine.includes('server/stop.js') ||
    cmdLine.includes('server\\stop.js') ||
    cmdLine.includes('termbridge') ||
    cmdLine.includes('test-lifecycle')
  ) {
    return true;
  }
  if (baseName && cmdLine.includes(baseName)) {
    return true;
  }
  if (rootLower && cmdLine.includes(rootLower)) {
    return true;
  }
  return false;
}
