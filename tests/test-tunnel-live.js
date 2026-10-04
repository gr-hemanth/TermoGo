import https from 'node:https';
import http from 'node:http';
import { startTunnel } from '../server/tunnel.js';

console.log('Testing live Cloudflare Tunnel connectivity with edge propagation...');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('TERMBRIDGE_INTERNET_TUNNEL_SUCCESS');
});

server.listen(8798, '127.0.0.1', async () => {
  const tunnel = startTunnel({ port: 8798, host: '127.0.0.1' });

  try {
    const publicUrl = await tunnel.url;
    console.log('Obtained Public Tunnel URL:', publicUrl);
    console.log('Waiting for Cloudflare edge routing to synchronize...');

    let success = false;
    for (let attempt = 1; attempt <= 10; attempt++) {
      await new Promise(r => setTimeout(r, 3000));
      process.stdout.write(`Attempt ${attempt}: Pinging ${publicUrl}... `);

      const res = await new Promise((resolve) => {
        const req = https.get(publicUrl, { timeout: 5000 }, (resp) => {
          let body = '';
          resp.on('data', c => body += c);
          resp.on('end', () => resolve({ status: resp.statusCode, body }));
        });
        req.on('error', (err) => resolve({ status: 0, body: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
      });

      console.log(`Status ${res.status}`);
      if (res.status === 200 && res.body === 'TERMBRIDGE_INTERNET_TUNNEL_SUCCESS') {
        console.log('\n[PASS] Internet tunnel verified: External HTTPS communication works!');
        success = true;
        break;
      }
    }

    if (!success) {
      console.error('\n[FAIL] Could not verify tunnel endpoint after retries.');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[FAIL] Tunnel test failed:', err);
    process.exitCode = 1;
  } finally {
    tunnel.stop();
    server.close();
  }
});
