# TermBridge ⚡

TermBridge is a mobile-first, browser-based remote terminal system for controlling AGY and persistent Windows terminal sessions directly from your phone over local Wi-Fi or the internet.

---

## 🚀 One-Click Quick Start (Windows)

No PowerShell troubleshooting, manual port finding, or complex commands needed.

### 1. Launch TermBridge
Double-click **`Start-TermBridge.bat`** in the project folder (or run `npm run launch`).

The launcher automatically:
- Checks that Node.js, npm, and project dependencies are available (installs missing packages if needed).
- Verifies and repairs your configuration (`.env`) preserving your stable access token.
- Dynamically detects your laptop's real Wi-Fi IP address (strictly excluding virtual adapters like WARP and WSL).
- Presents a clear, 1-click startup menu.

### 2. Choose Your Connection Mode

```text
============================================================
               TERMBRIDGE STARTUP LAUNCHER
============================================================
Detected Wi-Fi / LAN IP:  10.3.40.157
Cloudflare Tunnel:        Installed & Ready
------------------------------------------------------------
Select connection mode:
  [1] Local Wi-Fi   (Phone on same Wi-Fi / LAN - Fast & Direct)
  [2] Remote Access (Cloudflare Tunnel - Anywhere / Mobile Data)
  [3] Stop TermBridge
  [4] Exit
------------------------------------------------------------
Enter choice [1-4] (default: 1):
```

- **Option 1 — Local Wi-Fi**: Best when your phone and laptop share the same Wi-Fi. Lowest latency, completely local.
- **Option 2 — Remote Access**: Exposes TermBridge over Cloudflare Tunnel (`trycloudflare.com`). Control your laptop from your phone over 4G/5G mobile data or outside networks with zero router configuration.
- **Option 3 — Stop TermBridge**: Gracefully stops the running instance, closes tunnels, and releases port 8787.

### 3. Connect from Your Phone
Once started, the laptop console displays:
- **Local URL**: `http://localhost:8787` (automatically opens in your default browser)
- **LAN URL**: `http://<your-laptop-wifi-ip>:8787`
- **ACCESS TOKEN**: Your persistent pairing token (stored safely in `.env`)
- **QR Code**: Scan with your phone camera to open the interface immediately!

On your phone:
1. Scan the QR code or navigate to `http://<your-laptop-wifi-ip>:8787` in your mobile browser.
2. Enter the **ACCESS TOKEN** displayed on your laptop terminal.
3. Tap **Authenticate** (or press Enter). You now have full touch control of PowerShell, AGY, and other terminal sessions!

---

## 🛑 Clean Shutdown

To stop TermBridge and guarantee all listener ports and tunnel processes are released:
- Double-click **`Stop-TermBridge.bat`**, OR
- Press **Ctrl+C** in the running server window, OR
- Run `npm run stop` in terminal.

TermBridge safely shuts down its child PTYs and Cloudflare Tunnel process without terminating unrelated Node.js or system processes.

---

## 🛡️ Windows Firewall Setup (One-Time for Local Wi-Fi)

To allow your phone to connect over local Wi-Fi, Windows Firewall must allow incoming TCP traffic on port 8787.

Open **PowerShell as Administrator** and run:
```powershell
netsh advfirewall firewall add rule name="TermBridge" dir=in action=allow protocol=TCP localport=8787
```

*Note: This is only required for Option 1 (Local Wi-Fi). Option 2 (Remote Cloudflare Tunnel) uses outbound TLS connections and works automatically without firewall rules or port forwarding.*

---

## 🌟 Key Features

1. **Persistent Terminal Sessions**:
   - Terminal processes run continuously on your laptop, decoupled from browser connections.
   - Closing the mobile browser, phone sleep, or network switches **never** kills the laptop terminal.
   - Rolling **Scrollback Ring Buffer (128 KB)**: Live screen state and output history are instantly restored on reconnect.

2. **Laptop-Style Virtual Keyboard & Touchpad**:
   - Quick-access touch panel: `ESC`, `TAB`, `CTRL`, `ALT`, `SHIFT`, `CAPS`, arrow keys, function keys.
   - Dedicated touchpad overlay with text selection and copy modes.
   - Command/prompt bar for pasting long scripts, URLs, or prompts directly.

3. **Multi-Terminal Dashboard**:
   - Create and switch between multiple named terminal sessions (`PowerShell`, `AGY`, etc.).
   - Visual card list with live status indicators and safe session termination.

4. **Robust Port & Process Management**:
   - Detects port 8787 status before starting.
   - If TermBridge is already running, opens the browser directly instead of failing with `EADDRINUSE`.
   - Never kills unrelated processes occupying port 8787.

---

## ⚙️ Configuration (`.env`)

TermBridge preserves your configuration across restarts:
```env
PORT=8787
HOST=0.0.0.0
# Set TUNNEL=true for internet access, or false for local Wi-Fi:
TUNNEL=false
# Persistent 32-character authentication token:
AUTH_TOKEN=your-stable-access-token
```

---

## 🧪 Verification & Testing

Run the automated test suite covering lifecycle, token stability, networking, and UI UX:
```bash
npm test
```
All 12 test suites run automated end-to-end assertions with zero external test runners required.
