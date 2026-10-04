# TermBridge ⚡

TermBridge is a mobile-first, browser-based remote terminal system for controlling and viewing persistent terminal sessions running on your laptop directly from your phone over the internet.

---

## 🌟 Key Features

1. **Different Networks / Internet Remote Access**:
   - Access your laptop terminals from anywhere (e.g., Phone on 4G/5G mobile data, laptop on home/office Wi-Fi).
   - Powered by an isolated outbound **Cloudflare Quick Tunnel** (`cloudflared`).
   - Zero router configuration, zero port forwarding, works behind NAT, firewalls, and CGNAT.
   - Automatically provisions a public HTTPS/WSS endpoint with valid TLS certificates.

2. **Persistent Terminal Sessions**:
   - Terminal processes run continuously on the laptop and are decoupled from browser connections.
   - Closing the phone browser, putting the phone to sleep, or switching networks **never** kills the laptop terminal.
   - Automatic rolling **Scrollback Ring Buffer (128 KB)**: When reconnecting, the exact live screen state and recent output history are instantly restored on your phone.

3. **Multiple Terminals Support**:
   - Manage and switch between multiple named terminal sessions simultaneously (e.g., `PowerShell`, `AGY`, build watchers).
   - Visual terminal list view matching your dashboard requirements.
   - Add new terminals dynamically from your phone with the "+ Terminal" button.

4. **Mobile-First Browser Experience**:
   - Responsive [xterm.js](https://xtermjs.org/) terminal engine with `@xterm/addon-fit`.
   - **Touch Key Accessory Bar**: Quick-tap `ESC`, `TAB`, `CTRL`, `^C` (instant SIGINT interrupt), `▲`, `▼`, `◀`, `▶`.
   - **Command & Prompt Input Box**: Easily paste multiline scripts, URLs, or prompts directly into the terminal without fighting virtual keyboard quirks.
   - Native text selection and touch scrolling enabled.
   - Smooth viewport adaptation (`window.visualViewport`) when mobile virtual keyboard opens and closes.

5. **Security & Zero-Typing Pairing**:
   - Cryptographic constant-time authentication (`crypto.timingSafeEqual`).
   - If an `AUTH_TOKEN` is not specified in `.env`, a secure random 32-character token is automatically generated on boot.
   - Outputs a **QR code** in the laptop terminal: scan it with your phone's camera to pair and authenticate automatically!

---

## 🚀 Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start TermBridge
```bash
npm start
```

### 3. Connect from your phone
1. Look at your laptop console output.
2. Scan the displayed **QR Code** with your phone's camera (or open the `Direct Pairing Link`).
3. Your phone will immediately open the mobile terminal interface and connect over HTTPS/WSS!

---

## 🧪 Verification & Testing

Run the automated verification suite:
```bash
npm test
```

This validates:
- [x] Unauthorized requests correctly blocked (401)
- [x] Authenticated requests succeed (200)
- [x] Default persistent sessions exist (`PowerShell`, `AGY`)
- [x] Full-duplex WebSocket I/O (command input & terminal output)
- [x] Disconnect resilience: Terminal process persists on laptop after client disconnects
- [x] Reconnection & Scrollback replay: Reconnected client instantly recovers previous screen state
- [x] Multi-session management & simultaneous session handling

---

## ⚙️ Configuration (`.env`)

You can customize TermBridge settings in `.env`:
```env
PORT=8787
HOST=0.0.0.0
# Leave blank to auto-generate a secure token on startup:
AUTH_TOKEN=
# Set TUNNEL=false to run only locally / over LAN:
TUNNEL=true
```
