# TermoGo

**Control your Windows terminal from your phone. Anywhere.**

TermoGo is a mobile-friendly terminal control application that lets you access and interact with terminal sessions running on your Windows laptop through a web browser on your phone.

Use the same Wi-Fi network for local access or Cloudflare Tunnel for remote access. Run commands, interact with terminal-based tools, navigate output, and control your sessions without sitting in front of your laptop.

> **Important:** TermoGo provides access to a real terminal on your computer. Anyone who gains unauthorized access may be able to execute commands on your machine. Keep your access token private and share access only with trusted people.

## Features

- **Mobile terminal access** — Control your Windows terminal through your phone's browser.
- **Local and remote connectivity** — Connect over Wi-Fi or use Cloudflare Tunnel to access your laptop from another network.
- **Persistent terminal sessions** — Sessions can continue running when the phone disconnects, while TermoGo remains running.
- **Mobile-optimized controls** — Dedicated STOP, COPY LAST, scroll up, scroll down, and terminal navigation controls.
- **Virtual keyboard** — Send keyboard input, special keys, and key combinations from your phone.
- **Touchpad and mouse modes** — Interact with terminal applications and select terminal text.
- **Terminal output and history** — View existing output and navigate scrollback.
- **Session management** — Create, access, and delete terminal sessions.
- **Authentication and security controls** — Access-token verification, rate limiting, origin validation, and authenticated WebSocket communication.
- **One-click Windows launchers** — Start or stop the application using `.bat` files instead of remembering commands.
- **Port conflict handling** — Detect existing instances and avoid terminating unrelated processes.

## How it works

TermoGo runs on your Windows laptop, where the terminal processes execute. Your phone acts as the remote interface.

```text
┌─────────────────────┐
│     Your Phone      │
│    Web Browser      │
└──────────┬──────────┘
           │
           │ Local Wi-Fi
           │       OR
           │ Cloudflare Tunnel
           ▼
┌─────────────────────┐
│   TermoGo Server    │
│ Authentication      │
│ WebSocket / API     │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Windows Terminal    │
│ PowerShell / Shell  │
│ Commands and Tools  │
└─────────────────────┘
```

Terminal commands execute on the laptop, not on the phone. Disconnecting the phone does not necessarily terminate the running terminal session.

## Requirements

- Windows 10 or Windows 11.
- Node.js 20.x or a compatible version.
- npm, included with Node.js.
- A modern web browser on your phone.
- A Wi-Fi network for local access.
- Cloudflare Tunnel (`cloudflared`) for remote access, if you choose that mode.

## Getting started

### 1. Clone the repository

Open PowerShell and run:

```powershell
git clone https://github.com/gr-hemanth/TermoGo.git
cd TermoGo
```

If the repository has a different URL, substitute your repository's URL.

### 2. Install dependencies

```powershell
npm install
```

The Windows launcher can also check dependencies and install them when necessary.

### 3. Start TermoGo

Double-click:

```text
Start-TermoGo.bat
```

Choose one of the modes from the startup menu:

| Mode | When to use it |
|---|---|
| Local Wi-Fi | Your phone and laptop are connected to the same network. |
| Remote Access | Your phone connects through another Wi-Fi network or mobile data. |
| Stop TermoGo | Stops the running application through its shutdown mechanism. |

Keep the server window open while you use the application. The launcher displays the relevant connection URL and status information.

### 4. Authenticate

Open the URL displayed by the launcher on your phone.

Enter the current access token when prompted. Obtain it from the trusted local startup output or your local configuration, as appropriate.

Do not share your token publicly, commit it to Git, or include it in screenshots or public bug reports.

## Connecting from your phone

### Option A — Local Wi-Fi

1. Start TermoGo and select **Local Wi-Fi**.
2. Make sure your phone and laptop are connected to the same network.
3. Open the LAN URL displayed by the launcher on your phone.
4. Authenticate and select your terminal session.

Use the laptop's displayed LAN IP address rather than `localhost`. The LAN address may change when your laptop reconnects to Wi-Fi.

If the website does not load, check that the server is running and that Windows Firewall permits the necessary local-network connection. Some campus and public Wi-Fi networks prevent devices from communicating directly.

### Option B — Remote Access

1. Install and configure Cloudflare Tunnel if it is not already available.
2. Start TermoGo and select **Remote Access**.
3. Wait for the tunnel to become ready.
4. Open the actual HTTPS URL displayed by the launcher on your phone.
5. Authenticate with your access token.

Your laptop must remain powered on, connected to the internet, and running TermoGo and its tunnel process.

Do not assume the remote URL stays the same between runs. Use the current URL printed by the launcher.

## Using the mobile controls

| Control | Purpose |
|---|---|
| **STOP** | Stops the current foreground command or process using the application's stop behavior. |
| **COPY LAST** | Copies the most recent command interaction and its output. |
| **UP / DOWN** | Navigates terminal scrollback without sending those actions as shell input. |
| **Essentials** | Opens additional keyboard and mouse controls. |
| **Virtual Keyboard** | Sends keyboard input, including supported special keys and combinations. |
| **Mouse / Touchpad** | Interacts with supported terminal interfaces or selects terminal text, depending on the active mode. |

The behavior of terminal applications varies. Some full-screen terminal programs handle mouse input differently from a normal shell.

## Stopping TermoGo

Double-click:

```text
Stop-TermoGo.bat
```

Alternatively, run the project's stop script from PowerShell:

```powershell
npm run stop
```

Use the project's graceful shutdown mechanism instead of manually killing arbitrary Node.js processes.

Stopping the server may terminate the terminal sessions it owns. Disconnecting the phone, by itself, should not be treated as a shutdown command.

## Configuration

The repository includes `.env.example` as a configuration template.

The application uses environment configuration for settings such as authentication and tunnel behavior. A local `.env` file may be generated or maintained during startup.

- Keep `.env` local and out of version control.
- Never commit your real access token or other secrets.
- Do not replace a valid token merely to troubleshoot a network issue.
- Use the configuration template to understand available settings.
- Review security-sensitive changes before enabling remote access.

## Security

TermoGo provides control of an actual terminal, so security is essential.

- Keep authentication enabled for local and remote access.
- Protect your access token as you would a password.
- Share access only with people you trust.
- Avoid exposing port `8787` directly to the public internet.
- Use appropriately scoped firewall rules for local access.
- Keep your dependencies and Node.js installation maintained.
- Do not commit `.env` files, credentials, runtime state, or private logs.
- Stop remote access when you no longer need it.

Remote access should be treated as privileged access to your laptop, not merely access to a website.

## Development

Install dependencies:

```powershell
npm install
```

Run the test suite:

```powershell
npm test
```

The project's test suite covers terminal behavior, mobile controls, scrolling, keyboard and mouse interactions, authentication, security, process lifecycle management, token handling, and launcher behavior.

Run tests against your local code before submitting changes. A passing automated suite does not replace testing the application on an actual phone and network.

## Troubleshooting

**The website does not open**

Confirm the server started successfully. For local access, use the current LAN URL printed by the launcher. For remote access, wait until the tunnel reports a valid URL.

**The server reports that port `8787` is occupied**

Determine which process owns the port. Reuse an existing healthy TermoGo instance where appropriate; do not terminate unrelated applications.

**Authentication fails**

Use the current access token from the local startup output or trusted local configuration. Check the server logs for authentication errors, but do not publish tokens or secret values.

**Local access works, but remote access fails**

Check that Cloudflare Tunnel is installed, configured, and running. Use the actual current HTTPS URL and confirm the laptop still has internet access.

**The terminal stops responding**

Check the server window for errors and verify that the session still exists. Avoid terminating the server abruptly unless graceful shutdown is unavailable.

## Contributing

Contributions, bug reports, and feature suggestions are welcome.

Before submitting changes:

1. Describe the problem or improvement.
2. Keep changes focused and logically separated.
3. Run `npm test`.
4. Avoid committing secrets or machine-specific configuration.
5. Include reproducible steps for bugs, especially those involving mobile devices or remote connectivity.

## Project status

TermoGo includes Windows launchers, local and remote connectivity options, mobile terminal controls, session management, and automated tests.

The project is intended to make controlling a laptop's terminal from a phone simpler and more practical.

---

**TermoGo - Your terminal, in your pocket.**
## Author

**G R HEMANTH** - Creator and Maintainer of TermoGo.

GitHub: [@gr-hemanth](https://github.com/gr-hemanth)

TermoGo is developed and maintained as a project to make remote terminal interaction more accessible through a mobile-friendly interface.
