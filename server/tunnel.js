import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export function findCloudflaredBinary() {
  if (process.env.CLOUDFLARED_PATH && fs.existsSync(process.env.CLOUDFLARED_PATH)) {
    return process.env.CLOUDFLARED_PATH;
  }

  const standardWindowsPaths = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    path.join(root, 'bin', 'cloudflared.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'cloudflared', 'cloudflared.exe'),
    path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'cloudflared.exe')
  ];

  for (const candidate of standardWindowsPaths) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback to searching PATH
  return 'cloudflared';
}

export function startTunnel({ port = 8787, host = '127.0.0.1' } = {}) {
  const binary = findCloudflaredBinary();
  let tunnelProcess = null;
  let tunnelUrl = null;
  let urlPromiseResolve;
  let urlPromiseReject;

  const urlPromise = new Promise((resolve, reject) => {
    urlPromiseResolve = resolve;
    urlPromiseReject = reject;
  });

  const args = ['tunnel', '--url', `http://${host}:${port}`];

  try {
    tunnelProcess = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  } catch (err) {
    urlPromiseReject(err);
    return {
      url: urlPromise,
      stop: () => {},
      process: null
    };
  }

  const urlRegex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
  let resolved = false;

  const handleOutput = (chunk) => {
    const text = chunk.toString();
    const match = text.match(urlRegex);
    if (match && !resolved) {
      resolved = true;
      tunnelUrl = match[0];
      urlPromiseResolve(tunnelUrl);
    }
  };

  if (tunnelProcess.stdout) tunnelProcess.stdout.on('data', handleOutput);
  if (tunnelProcess.stderr) tunnelProcess.stderr.on('data', handleOutput);

  tunnelProcess.on('error', (err) => {
    if (!resolved) {
      resolved = true;
      urlPromiseReject(err);
    }
  });

  tunnelProcess.on('exit', (code, signal) => {
    if (!resolved) {
      resolved = true;
      urlPromiseReject(new Error(`cloudflared exited early with code ${code} signal ${signal}`));
    }
  });

  const cleanup = () => {
    if (tunnelProcess && !tunnelProcess.killed) {
      try {
        tunnelProcess.kill('SIGTERM');
      } catch {
        // Process might have already exited
      }
    }
  };

  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);

  // Set a 30s timeout for tunnel URL acquisition
  const timeoutId = setTimeout(() => {
    if (!resolved) {
      resolved = true;
      urlPromiseReject(new Error('Timed out waiting for Cloudflare Tunnel URL'));
    }
  }, 30000);

  urlPromise.finally(() => clearTimeout(timeoutId));

  return {
    url: urlPromise,
    stop: () => {
      clearTimeout(timeoutId);
      cleanup();
    },
    getProcess: () => tunnelProcess,
    getUrl: () => tunnelUrl
  };
}
