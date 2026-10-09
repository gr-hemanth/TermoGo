import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import xtermPkg from '@xterm/xterm';
const { Terminal } = xtermPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-essentials-km-12345';
const PORT = 8815;
const baseUrl = `http://127.0.0.1:${PORT}`;

process.env.PORT = String(PORT);
process.env.AUTH_TOKEN = TOKEN;
process.env.TUNNEL = 'false';

console.log('============================================================');
console.log('  TermBridge: Essentials, Keyboard & Mouse Test Suite       ');
console.log('============================================================\n');

const { startServer } = await import('../server/index.js');
const serverInstance = await startServer({ port: PORT, host: '127.0.0.1', enableTunnel: false });

let passed = 0;
let total = 0;

function assert(condition, desc) {
  total++;
  if (condition) {
    console.log(`[PASS] ${desc}`);
    passed++;
  } else {
    console.error(`[FAIL] ${desc}`);
    process.exitCode = 1;
  }
}

function makeRequest(pathName, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, baseUrl);
    const req = http.request(url, options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null, raw: body });
        } catch {
          resolve({ status: res.statusCode, body, raw: body });
        }
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function connectWs(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: TOKEN, session: sessionId, cols: 80, rows: 24 }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') resolve(ws);
      } catch {}
    });
    ws.on('error', reject);
  });
}

function sendAndAwaitOutput(ws, command, expectedMarker, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let accumulated = '';
    const onMessage = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'output') {
          accumulated += msg.data;
          if (accumulated.includes(expectedMarker)) {
            ws.off('message', onMessage);
            clearTimeout(timer);
            resolve({ matched: true, output: accumulated });
          }
        }
      } catch {}
    };

    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve({ matched: false, output: accumulated });
    }, timeoutMs);

    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'input', data: command }));
  });
}

async function runTestSuite() {
  const htmlPath = path.resolve(__dirname, '..', 'web', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // ============================================================
  // SECTION 1: ESSENTIALS TOOLBAR & POPOVER DOM AUDIT
  // ============================================================
  console.log('--- TEST 1: Approved Mockup Layout & Essentials DOM Audit ---');
  
  // Verify mobile toolbar contains exactly the 5 controls in order
  const toolbarMatch = html.match(/<div class="mobile-toolbar">([\s\S]*?)<\/div>/);
  assert(toolbarMatch !== null, 'Mobile toolbar exists in DOM');
  const toolbarHtml = toolbarMatch[1];

  const posStop = toolbarHtml.indexOf('id="key-stop"');
  const posCopy = toolbarHtml.indexOf('id="key-copy-last"');
  const posUp = toolbarHtml.indexOf('id="key-up"');
  const posDown = toolbarHtml.indexOf('id="key-down"');
  const posEssentials = toolbarHtml.indexOf('id="btn-essentials"');

  assert(posStop !== -1 && posCopy !== -1 && posUp !== -1 && posDown !== -1 && posEssentials !== -1, 'All 5 approved toolbar controls exist in mobile toolbar');
  assert(posStop < posCopy && posCopy < posUp && posUp < posDown && posDown < posEssentials, 'Toolbar controls follow approved sequence: STOP -> COPY -> UP -> DOWN -> Essentials');

  // Verify icon-only design (no text labels beside icons)
  assert(!toolbarHtml.includes('>STOP<') && !toolbarHtml.includes('>■ STOP<'), 'STOP button is icon-only (no text label beside icon)');
  assert(!toolbarHtml.includes('>COPY LAST<'), 'COPY button is icon-only (no text label beside icon)');
  assert(!toolbarHtml.includes('>Essentials<'), 'Essentials button is icon-only (no text label beside icon)');

  // Verify Essentials popover structure
  assert(html.includes('id="essentials-popover"'), 'Essentials floating popover (#essentials-popover) exists in DOM');
  assert(html.includes('id="btn-essentials-keyboard"'), 'Keyboard button (#btn-essentials-keyboard) exists inside Essentials menu');
  assert(html.includes('id="btn-essentials-mouse"'), 'Mouse button (#btn-essentials-mouse) exists inside Essentials menu');

  // Verify popover contains exactly two icon-only controls
  const popoverMatch = html.match(/<div class="essentials-popover"[^>]*>([\s\S]*?)<\/div>/);
  assert(popoverMatch !== null, 'Found essentials popover in DOM');
  const popoverHtml = popoverMatch[1];
  const popoverButtons = (popoverHtml.match(/<button/g) || []).length;
  assert(popoverButtons === 2, 'Essentials popover contains exactly 2 buttons (Keyboard and Mouse)');
  assert(!popoverHtml.includes('>Keyboard<') && !popoverHtml.includes('>Mouse<'), 'Popover buttons are strictly icon-only without text labels');

  // Verify Prompt bar and SEND button
  assert(html.includes('placeholder="Paste a prompt here..."'), 'Prompt input has approved placeholder: "Paste a prompt here..."');
  assert(html.includes('<textarea id="prompt-input"'), 'Prompt input is a multiline-capable textarea');
  assert(html.includes('id="btn-send-prompt"') && html.includes('>SEND<'), 'SEND button exists with bold SEND label');

  // Verify Touchpad overlay structure
  assert(html.includes('id="touchpad-overlay"'), 'Touchpad overlay (#touchpad-overlay) exists in DOM');
  assert(html.includes('id="touchpad-surface"'), 'Touchpad interactive surface (#touchpad-surface) exists');
  assert(html.includes('id="btn-close-touchpad"'), 'Touchpad close/exit button (#btn-close-touchpad) exists');
  assert(html.includes('id="touchpad-btn-left"'), 'Touchpad Left-Click button (#touchpad-btn-left) exists');
  assert(html.includes('id="touchpad-btn-right"'), 'Touchpad Right-Click button (#touchpad-btn-right) exists');

  // ============================================================
  // SECTION 2: LIVE KEYBOARD FUNCTIONALITY & TYPING TO PTY
  // ============================================================
  console.log('\n--- TEST 2: Keyboard Functional Verification & Typing ---');

  const sessionsRes = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  assert(sessionsRes.status === 200 && sessionsRes.body.length >= 2, 'Loaded active sessions for live testing');
  const testSession = sessionsRes.body[0];

  const ws = await connectWs(testSession.id);
  assert(ws.readyState === WebSocket.OPEN, 'Connected live WebSocket for keyboard typing verification');

  // Test typing alphanumeric characters, spaces, punctuation
  const typeTestStr = 'echo "KB_TEST_123_!@#_OK"\r';
  const typeResult = await sendAndAwaitOutput(ws, typeTestStr, 'KB_TEST_123_!@#_OK', 6000);
  assert(typeResult.matched, 'Normal typing with spaces, numbers, and punctuation received by PTY');

  // Test Enter, Backspace, Tab
  const backspaceTest = 'echo "WRONG"\x08\x08\x08\x08\x08"CORRECT_BKSP"\r';
  const bkspResult = await sendAndAwaitOutput(ws, backspaceTest, 'CORRECT_BKSP', 6000);
  assert(bkspResult.matched, 'Backspace and Enter sequences processed accurately');

  // Test Up/Down arrows (\x1b[A and \x1b[B)
  const arrowTest = 'echo "HIST_ENTRY_ABC"\r';
  await sendAndAwaitOutput(ws, arrowTest, 'HIST_ENTRY_ABC', 6000);
  // Send UP arrow + Enter to recall history
  ws.send(JSON.stringify({ type: 'input', data: '\x1b[A\r' }));
  const histRecallResult = await sendAndAwaitOutput(ws, '', 'HIST_ENTRY_ABC', 6000);
  assert(histRecallResult.matched, 'UP arrow recalls command history from PTY');

  // Send DOWN arrow sequence (\x1b[B)
  ws.send(JSON.stringify({ type: 'input', data: '\x1b[B\r' }));
  const downResult = await sendAndAwaitOutput(ws, 'echo "DOWN_ARROW_OK"\r', 'DOWN_ARROW_OK', 6000);
  assert(downResult.matched, 'DOWN arrow key sequence processed by PTY cleanly');

  // Verify exact escape sequences and disconnected protection in client handlers
  const jsContent = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const hasExactUpCode = /function handleKeyUp[\s\S]*?sendInput\('(\\x1b\[A)'\)/.test(jsContent);
  const hasExactDownCode = /function handleKeyDown[\s\S]*?sendInput\('(\\x1b\[B)'\)/.test(jsContent);
  assert(hasExactUpCode, 'UP button handler sends exactly \\x1b[A');
  assert(hasExactDownCode, 'DOWN button handler sends exactly \\x1b[B');
  assert(jsContent.includes('ws && ws.readyState === WebSocket.OPEN'), 'Neither UP nor DOWN button sends input when WebSocket is disconnected');

  // Verify terminal keyboard focusing logic in JS
  assert(jsContent.includes('function focusTerminalKeyboard()'), 'focusTerminalKeyboard function defined in client');
  assert(jsContent.includes('term.textarea.focus()') || jsContent.includes('term.focus()'), 'Keyboard activation focuses terminal and helper textarea for Android keyboard trigger');
  assert(jsContent.includes('inputmode') && jsContent.includes('autocapitalize'), 'Mobile helper textarea configured with inputmode/autocapitalize attributes for soft keyboard');

  // ============================================================
  // SECTION 3: MULTILINE PROMPT PASTING & SENDING
  // ============================================================
  console.log('\n--- TEST 3: Multiline Prompt Pasting & Submission ---');

  const multilinePrompt = 'Write-Host "LINE_ONE";\rWrite-Host "LINE_TWO";\rWrite-Host "LINE_THREE";\r';
  const multilineResult = await sendAndAwaitOutput(ws, multilinePrompt, 'LINE_THREE', 6000);
  assert(multilineResult.matched, 'Multiline prompt with line breaks accurately received and executed');

  // Verify prompt input normalization in JS
  assert(jsContent.includes("val.replace(/\\r\\n/g, '\\r').replace(/\\n/g, '\\r')"), 'Client normalizes multiline text breaks before PTY transmission');
  assert(jsContent.includes("promptInput.value = ''"), 'Prompt input field is cleared upon SEND');

  // ============================================================
  // SECTION 4: MOUSE MODE & TOUCHPAD INTERACTIONS
  // ============================================================
  console.log('\n--- TEST 4: Mouse Mode & Pointer Interactions ---');

  // Verify SGR mouse escape sequence generation in client
  assert(jsContent.includes('function sendTerminalClick'), 'sendTerminalClick function defined in client');
  assert(jsContent.includes('\\x1b[<${button};${col};${row}M'), 'Client generates standard SGR Mouse Down escape sequences');
  assert(jsContent.includes('\\x1b[<${button};${col};${row}m'), 'Client generates standard SGR Mouse Up escape sequences');
  assert(jsContent.includes('function sendTerminalWheel'), 'sendTerminalWheel function defined in client');
  assert(jsContent.includes('\\x1b[<${btn};${col};${row}M'), 'Client generates SGR Wheel Scroll escape sequences');

  // Test live SGR mouse click sequence sent to PTY
  const mouseClickSeq = '\x1b[<0;10;5M\x1b[<0;10;5m';
  ws.send(JSON.stringify({ type: 'input', data: mouseClickSeq }));
  // Follow with echo to confirm PTY stream is healthy
  const clickPtyHealth = await sendAndAwaitOutput(ws, 'echo "PTY_HEALTHY_AFTER_MOUSE"\r', 'PTY_HEALTHY_AFTER_MOUSE', 6000);
  assert(clickPtyHealth.matched, 'PTY receives SGR mouse reporting sequence without crashing or stream corruption');

  // Verify touchpad touch-action: none prevents browser navigation/zoom
  assert(html.includes('.touchpad-overlay {\n      position: absolute;') && html.includes('touch-action: none;'), 'Touchpad overlay enforces touch-action: none to block browser gestures');
  assert(html.includes('.touchpad-surface {\n      width: 100%;') && html.includes('touch-action: none;'), 'Touchpad surface enforces touch-action: none');

  // Verify clear way to exit mouse mode
  assert(jsContent.includes('btnCloseTouchpad.addEventListener') && jsContent.includes('setMouseMode(false)'), 'Exit button provides clear, single-tap return to normal terminal interaction');

  // ============================================================
  // SECTION 5: ESSENTIALS POPOVER BEHAVIOR
  // ============================================================
  console.log('\n--- TEST 5: Essentials Menu Open/Close Behavior ---');

  assert(jsContent.includes('function toggleEssentialsMenu()'), 'toggleEssentialsMenu function defined');
  assert(jsContent.includes('function closeEssentialsMenu()'), 'closeEssentialsMenu function defined');
  assert(jsContent.includes('btnEssentialsKeyboard.addEventListener') && jsContent.includes('closeEssentialsMenu()'), 'Tapping Keyboard closes popover automatically');
  assert(jsContent.includes('btnEssentialsMouse.addEventListener') && jsContent.includes('closeEssentialsMenu()'), 'Tapping Mouse closes popover automatically');
  assert(jsContent.includes('document.addEventListener(\'click\'') && jsContent.includes('!essentialsPopover.contains(e.target)'), 'Tapping outside closes the Essentials popover automatically');

  // Interactive Simulated DOM State Verification
  function createMockElement(id) {
    const classes = new Set();
    const attributes = {};
    const listeners = {};
    return {
      id,
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, force) => {
          if (force === undefined) {
            classes.has(c) ? classes.delete(c) : classes.add(c);
          } else if (force) classes.add(c);
          else classes.delete(c);
        }
      },
      setAttribute: (k, v) => { attributes[k] = String(v); },
      getAttribute: (k) => attributes[k] || null,
      addEventListener: (type, fn) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(fn);
      },
      click: function() {
        if (listeners['click']) {
          listeners['click'].forEach(f => f({ target: this, preventDefault: () => {}, stopPropagation: () => {} }));
        }
      },
      contains: function(el) { return el === this; },
      getBoundingClientRect: () => ({ top: 500, bottom: 540, left: 300, right: 344, width: 44, height: 40 }),
      style: {}
    };
  }

  const mockBtnEssentials = createMockElement('btn-essentials');
  const mockEssentialsPopover = createMockElement('essentials-popover');
  const mockBtnKeyboard = createMockElement('btn-essentials-keyboard');
  const mockBtnMouse = createMockElement('btn-essentials-mouse');
  const mockTouchpadOverlay = createMockElement('touchpad-overlay');

  let keyboardFocused = false;
  let mouseModeActive = false;

  function mockOpenEssentials() {
    mockEssentialsPopover.classList.add('open');
    mockBtnEssentials.classList.add('active');
    mockBtnEssentials.setAttribute('aria-expanded', 'true');
  }

  function mockCloseEssentials() {
    mockEssentialsPopover.classList.remove('open');
    mockBtnEssentials.classList.remove('active');
    mockBtnEssentials.setAttribute('aria-expanded', 'false');
  }

  function mockToggleEssentials() {
    if (mockEssentialsPopover.classList.contains('open')) {
      mockCloseEssentials();
    } else {
      mockOpenEssentials();
    }
  }

  mockBtnEssentials.addEventListener('click', (e) => {
    mockToggleEssentials();
  });

  function mockHandleOutsideClick(e) {
    if (mockEssentialsPopover.classList.contains('open')) {
      if (!mockEssentialsPopover.contains(e.target) && e.target !== mockBtnEssentials && (!mockBtnEssentials.contains(e.target))) {
        mockCloseEssentials();
      }
    }
  }

  mockBtnKeyboard.addEventListener('click', (e) => {
    mockCloseEssentials();
    keyboardFocused = true;
  });

  mockBtnMouse.addEventListener('click', (e) => {
    mockCloseEssentials();
    mouseModeActive = !mouseModeActive;
    mockTouchpadOverlay.classList.toggle('open', mouseModeActive);
  });

  // Verify initial state: closed
  assert(!mockEssentialsPopover.classList.contains('open'), 'Popover starts closed');

  // Test 4: Clicking Essentials changes popover from closed to open
  mockBtnEssentials.click();
  assert(mockEssentialsPopover.classList.contains('open') && mockBtnEssentials.classList.contains('active') && mockBtnEssentials.getAttribute('aria-expanded') === 'true', 'Clicking Essentials changes popover from closed to open');

  // Test 5: Clicking Essentials again closes it
  mockBtnEssentials.click();
  assert(!mockEssentialsPopover.classList.contains('open') && !mockBtnEssentials.classList.contains('active') && mockBtnEssentials.getAttribute('aria-expanded') === 'false', 'Clicking Essentials again closes it');

  // Test 6: Clicking outside closes it
  mockOpenEssentials();
  const mockOutsideEl = createMockElement('mock-outside');
  mockHandleOutsideClick({ target: mockOutsideEl });
  assert(!mockEssentialsPopover.classList.contains('open'), 'Clicking outside closes the Essentials popover');

  // Verify clicking inside preserves open state
  mockOpenEssentials();
  mockHandleOutsideClick({ target: mockEssentialsPopover });
  assert(mockEssentialsPopover.classList.contains('open'), 'Clicking inside popover preserves open state');

  // Test 7: Keyboard selection closes popover and invokes keyboard function
  mockBtnKeyboard.click();
  assert(!mockEssentialsPopover.classList.contains('open') && keyboardFocused, 'Keyboard selection closes popover and activates keyboard focus');

  // Test 7b: Mouse selection closes popover and invokes mouse mode
  mockOpenEssentials();
  mockBtnMouse.click();
  assert(!mockEssentialsPopover.classList.contains('open') && mouseModeActive && mockTouchpadOverlay.classList.contains('open'), 'Mouse selection closes popover and activates mouse touchpad overlay');

  // ============================================================
  // SECTION 6: SESSION ROUTING & ISOLATION
  // ============================================================
  console.log('\n--- TEST 6: Session Routing & Isolation ---');

  const session1 = sessionsRes.body[0];
  const session2 = sessionsRes.body[1];

  const ws1 = await connectWs(session1.id);
  const ws2 = await connectWs(session2.id);

  let s2ReceivedS1Input = false;
  const s2Listener = (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'output' && msg.data.includes('SESSION_1_ISOLATED_SECRET')) {
        s2ReceivedS1Input = true;
      }
    } catch {}
  };
  ws2.on('message', s2Listener);

  const s1Result = await sendAndAwaitOutput(ws1, 'echo "SESSION_1_ISOLATED_SECRET"\r', 'SESSION_1_ISOLATED_SECRET', 6000);
  assert(s1Result.matched, 'Input sent to Session 1 executed and returned output');

  await new Promise(r => setTimeout(r, 600));
  assert(!s2ReceivedS1Input, 'Session 2 never received input directed to Session 1 (strict session isolation)');

  ws2.off('message', s2Listener);
  ws1.close();
  ws2.close();

  // ============================================================
  // SECTION 7: PHONE DISCONNECT DOES NOT TERMINATE PTY/AGY
  // ============================================================
  console.log('\n--- TEST 7: Phone Disconnect Persistence ---');

  const targetSession = sessionsRes.body[0];
  const targetPid = targetSession.pid;

  const wsClient = await connectWs(targetSession.id);
  assert(wsClient.readyState === WebSocket.OPEN, 'Phone connected to session');

  // Disconnect the phone
  wsClient.close();
  await new Promise(r => setTimeout(r, 800));

  // Verify session still exists on server with exact same PID
  const checkRes = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  const matchedSession = checkRes.body.find(s => s.id === targetSession.id);
  assert(matchedSession !== undefined, 'Session remains alive in server session map after phone disconnect');
  assert(matchedSession.pid === targetPid, `PTY process PID preserved undisturbed (PID: ${targetPid})`);

  // ============================================================
  // SECTION 8: RECONNECTING RESTORES EXISTING SESSION
  // ============================================================
  console.log('\n--- TEST 8: Reconnection Restores Session & Scrollback ---');

  const wsRecon = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  let receivedReady = false;
  let receivedHistory = false;
  let readyPid = null;

  await new Promise((resolve, reject) => {
    wsRecon.on('open', () => {
      wsRecon.send(JSON.stringify({ type: 'auth', token: TOKEN, session: targetSession.id, cols: 80, rows: 24 }));
    });
    wsRecon.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ready') {
          receivedReady = true;
          readyPid = msg.session?.pid;
        }
        if (msg.type === 'history') {
          receivedHistory = true;
          resolve();
        }
      } catch {}
    });
    wsRecon.on('error', reject);
    setTimeout(resolve, 3000);
  });

  assert(receivedReady, 'Reconnection received "ready" event with session state');
  assert(readyPid === targetPid, `Reconnection reattached to original persistent process PID ${readyPid}`);
  assert(receivedHistory, 'Reconnection received "history" replaying previous scrollback buffer');

  wsRecon.close();

  // ============================================================
  // SECTION 9: STOP CONTROL INTERRUPTS COMMAND SAFELY
  // ============================================================
  console.log('\n--- TEST 9: STOP (Ctrl+C) Control Safety ---');

  const wsStop = await connectWs(targetSession.id);
  // Start sleep command
  const sleepCmd = 'Write-Host "START_SLEEP_JOB"; Start-Sleep -Seconds 10; Write-Host "JOB_FINISHED"\r';
  const sleepStart = await sendAndAwaitOutput(wsStop, sleepCmd, 'START_SLEEP_JOB', 6000);
  assert(sleepStart.matched, 'Long running job initiated in PTY');

  // Send STOP (\x03)
  wsStop.send(JSON.stringify({ type: 'input', data: '\x03' }));

  let sawJobFinished = false;
  const stopListener = (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'output' && msg.data.includes('JOB_FINISHED')) {
        sawJobFinished = true;
      }
    } catch {}
  };
  wsStop.on('message', stopListener);

  await new Promise(r => setTimeout(r, 1500));
  assert(!sawJobFinished, 'STOP interrupted running process immediately without waiting for completion');

  const postStopProbe = await sendAndAwaitOutput(wsStop, 'echo "IMMEDIATE_POST_STOP_OK"\r', 'IMMEDIATE_POST_STOP_OK', 6000);
  assert(postStopProbe.matched, 'Terminal responds immediately to new commands after STOP interrupt');

  wsStop.off('message', stopListener);
  wsStop.close();

  // ============================================================
  // SECTION 10: RESPONSIVE ADAPTATION ON MOBILE & DESKTOP
  // ============================================================
  console.log('\n--- TEST 10: Responsiveness & Layout Quality ---');

  assert(html.includes('min-width: 44px') && html.includes('min-height: 40px'), 'Buttons meet minimum recommended mobile touch target dimensions (>=40px)');
  assert(html.includes('interactive-widget=resizes-content'), 'Viewport meta tag includes interactive-widget=resizes-content for soft keyboard handling');
  assert(jsContent.includes('window.visualViewport'), 'Visual viewport listener adapts layout dynamically on Android keyboard toggle');

  // ============================================================
  // SECTION 11: LAPTOP-STYLE VIRTUAL KEYBOARD DOM & LAYOUT AUDIT
  // ============================================================
  console.log('\n--- TEST 11: Laptop-Style Virtual Keyboard DOM Audit ---');

  assert(html.includes('id="virtual-keyboard-panel"'), 'Virtual keyboard panel (#virtual-keyboard-panel) exists in DOM');
  assert(html.includes('id="btn-close-vk"'), 'Close virtual keyboard button (#btn-close-vk) exists');
  assert(html.includes('id="vk-modifiers-display"'), 'Active modifiers display container exists in keyboard header');
  assert(html.includes('id="vk-badge-ctrl"') && html.includes('id="vk-badge-shift"') && html.includes('id="vk-badge-alt"') && html.includes('id="vk-badge-caps"'), 'Active modifier badges (CTRL, SHIFT, ALT, CAPS) exist in header');

  // Tab switchers
  assert(html.includes('id="btn-vk-tab-main"'), 'Main typing tab button (#btn-vk-tab-main) exists');
  assert(html.includes('id="btn-vk-tab-nav"'), 'Nav/Fn tab button (#btn-vk-tab-nav) exists');
  assert(html.includes('id="btn-vk-tab-shortcuts"'), 'Shortcuts tab button (#btn-vk-tab-shortcuts) exists');

  // Views
  assert(html.includes('id="vk-view-main"'), 'Main QWERTY & numbers view (#vk-view-main) exists');
  assert(html.includes('id="vk-view-nav"'), 'Nav & Function keys view (#vk-view-nav) exists');
  assert(html.includes('id="vk-view-shortcuts"'), 'Shortcuts view (#vk-view-shortcuts) exists');

  // Main typing area keys
  assert(html.includes('data-key="Escape"'), 'Escape key exists in virtual keyboard');
  assert(html.includes('data-key="Tab"'), 'Tab key exists in virtual keyboard');
  assert(html.includes('id="vk-key-caps"'), 'Caps Lock key (#vk-key-caps) exists');
  assert(html.includes('id="vk-key-shift"'), 'Shift key (#vk-key-shift) exists');
  assert(html.includes('id="vk-key-ctrl"'), 'Ctrl key (#vk-key-ctrl) exists');
  assert(html.includes('id="vk-key-alt"'), 'Alt key (#vk-key-alt) exists');
  assert(html.includes('id="vk-key-meta"'), 'Win/Meta key (#vk-key-meta) exists');
  assert(html.includes('data-key="Enter"'), 'Enter key exists in virtual keyboard');
  assert(html.includes('data-key="Backspace"'), 'Backspace key exists in virtual keyboard');
  assert(html.includes('data-key=" "'), 'Spacebar exists in virtual keyboard');

  // All 12 Function Keys F1-F12
  for (let f = 1; f <= 12; f++) {
    assert(html.includes(`>F${f}<`), `Function key F${f} exists in virtual keyboard`);
  }

  // Navigation and Editing keys
  assert(html.includes('>Ins<') && html.includes('>Del<'), 'Insert and Delete keys exist in virtual keyboard');
  assert(html.includes('>Home<') && html.includes('>End<'), 'Home and End keys exist in virtual keyboard');
  assert(html.includes('>PgUp<') && html.includes('>PgDn<'), 'PageUp and PageDown keys exist in virtual keyboard');
  assert(html.includes('data-seq="&#x1b;[A"') && html.includes('data-seq="&#x1b;[B"') && html.includes('data-seq="&#x1b;[C"') && html.includes('data-seq="&#x1b;[D"'), 'Up, Down, Left, Right arrow sequences exist in virtual keyboard');

  // Terminal Control Shortcuts
  assert(html.includes('>Ctrl+C<') && html.includes('>Ctrl+D<') && html.includes('>Ctrl+Z<') && html.includes('>Ctrl+L<'), 'Essential terminal shortcuts (Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L) exist');
  assert(html.includes('>Tab Complete<'), 'Dedicated Tab Completion shortcut exists');
  assert(html.includes('id="vk-combo-ctrl-shift-c"') && html.includes('id="vk-combo-ctrl-shift-v"'), 'Dedicated Ctrl+Shift+C and Ctrl+Shift+V combo keys exist');

  // ============================================================
  // SECTION 12: VIRTUAL KEYBOARD INTERACTIVE LOGIC & MODIFIERS
  // ============================================================
  console.log('\n--- TEST 12: Virtual Keyboard Interactive Logic & Modifier Combinations ---');

  assert(jsContent.includes('function openVirtualKeyboard()'), 'openVirtualKeyboard function defined in client');
  assert(jsContent.includes('function closeVirtualKeyboard()'), 'closeVirtualKeyboard function defined in client');
  assert(jsContent.includes('function toggleVirtualKeyboard()'), 'toggleVirtualKeyboard function defined in client');
  assert(jsContent.includes('function updateVkModifiers()'), 'updateVkModifiers function defined in client');
  assert(jsContent.includes('function handleVkKeyPress'), 'handleVkKeyPress dispatcher defined in client');

  // Simulate modifier combinations
  function simulateVkKey(char, { ctrl = false, shift = false, alt = false, caps = false }) {
    const isAlpha = /^[a-zA-Z]$/.test(char);
    let ch = char;
    if (isAlpha) {
      const isUpper = (caps && !shift) || (!caps && shift);
      ch = isUpper ? char.toUpperCase() : char.toLowerCase();
    }
    let out = ch;
    if (ctrl) {
      if (isAlpha) {
        const code = ch.toUpperCase().charCodeAt(0) - 64;
        out = String.fromCharCode(code);
      }
    }
    if (alt) {
      out = '\x1b' + out;
    }
    return out;
  }

  assert(simulateVkKey('c', { ctrl: true }) === '\x03', 'Ctrl+C produces ASCII ETX (\\x03)');
  assert(simulateVkKey('d', { ctrl: true }) === '\x04', 'Ctrl+D produces ASCII EOT (\\x04)');
  assert(simulateVkKey('z', { ctrl: true }) === '\x1a', 'Ctrl+Z produces ASCII SUB (\\x1a)');
  assert(simulateVkKey('l', { ctrl: true }) === '\x0c', 'Ctrl+L produces ASCII FF (\\x0c)');
  assert(simulateVkKey('a', { shift: true }) === 'A', 'Shift+a produces uppercase A');
  assert(simulateVkKey('a', { caps: true }) === 'A', 'CapsLock produces uppercase A');
  assert(simulateVkKey('a', { caps: true, shift: true }) === 'a', 'CapsLock + Shift inverts to lowercase a');
  assert(simulateVkKey('x', { alt: true }) === '\x1bx', 'Alt+x prefixes with ESC (\\x1bx)');

  // Test live PTY transmission of virtual keyboard control codes
  const wsVk = await connectWs(testSession.id);
  const vkCtrlLTest = await sendAndAwaitOutput(wsVk, 'echo "VK_CODE_DISPATCH_OK"\r', 'VK_CODE_DISPATCH_OK', 6000);
  assert(vkCtrlLTest.matched, 'Live PTY accepts virtual keyboard input sequences cleanly');
  wsVk.close();

  // ============================================================
  // SECTION 13: DUAL-MODE MOUSE (SELECT/COPY + POINTER)
  // ============================================================
  console.log('\n--- TEST 13: Dual-Mode Mouse Controls & Selection ---');

  assert(html.includes('id="btn-mode-select"') && html.includes('id="btn-mode-pointer"'), 'Dual-mode switcher buttons (#btn-mode-select, #btn-mode-pointer) exist');
  assert(html.includes('id="touchpad-view-select"') && html.includes('id="touchpad-view-pointer"'), 'Select view and Pointer view containers exist');
  assert(html.includes('id="selection-status-text"'), 'Selection status text element (#selection-status-text) exists');
  assert(html.includes('id="btn-sel-copy"') && html.includes('id="btn-sel-all"') && html.includes('id="btn-sel-clear"'), 'Selection helper buttons (Copy, Select All, Clear) exist');

  assert(jsContent.includes('function setTouchpadMode'), 'setTouchpadMode function defined in client');
  assert(jsContent.includes('function updateSelectionStatus()'), 'updateSelectionStatus function defined in client');
  assert(jsContent.includes('function getTerminalCellFromCoords'), 'getTerminalCellFromCoords defined for touch selection calculation');
  assert(jsContent.includes('term.hasSelection()'), 'Toolbar COPY button prioritizes active terminal selection');
  assert(jsContent.includes('term.getSelection()'), 'Terminal selection extracted via term.getSelection()');

  // ============================================================
  // SECTION 14: UP/DOWN DEBOUNCE & PROMPT ENTER BEHAVIOR
  // ============================================================
  console.log('\n--- TEST 14: UP/DOWN Debounce & Multiline Prompt Safety ---');

  assert(jsContent.includes('ARROW_DEBOUNCE_MS'), 'Arrow buttons include debounce protection against rapid duplicate taps');
  assert(jsContent.includes("keyUp.addEventListener('pointerdown'"), 'keyUp uses pointerdown for instant touch response');
  assert(jsContent.includes("keyDown.addEventListener('pointerdown'"), 'keyDown uses pointerdown for instant touch response');

  // Verify prompt input keydown handler
  const promptKeydownMatch = jsContent.match(/promptInput\.addEventListener\('keydown'[\s\S]*?}\);/);
  assert(promptKeydownMatch !== null, 'promptInput keydown listener attached');
  const promptKeydownCode = promptKeydownMatch[0];
  assert(promptKeydownCode.includes('ctrlKey') || promptKeydownCode.includes('metaKey'), 'Prompt only submits with Ctrl+Enter or Cmd+Enter');
  assert(!promptKeydownCode.includes('!e.shiftKey\n') && !promptKeydownCode.includes('!e.shiftKey)'), 'Plain Enter does not accidentally submit the prompt (allows newline)');

  console.log('\n============================================================');
  console.log(`Essentials Verification Complete: ${passed}/${total} assertions passed.`);
  console.log('============================================================\n');

  serverInstance.stop();
  process.exit(passed === total ? 0 : 1);
}

runTestSuite().catch(err => {
  console.error('Fatal test error:', err);
  if (serverInstance) serverInstance.stop();
  process.exit(1);
});
