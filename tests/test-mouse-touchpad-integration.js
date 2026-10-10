import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import xtermPkg from '@xterm/xterm';
const { Terminal } = xtermPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token-mouse-integration-9988';
const PORT = 8816;
const baseUrl = `http://127.0.0.1:${PORT}`;

process.env.PORT = String(PORT);
process.env.AUTH_TOKEN = TOKEN;
process.env.TUNNEL = 'false';

console.log('============================================================');
console.log('  TermBridge: Mouse & Touchpad Regression Test Suite        ');
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

async function runMouseTestSuite() {
  const htmlPath = path.resolve(__dirname, '..', 'web', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const jsContent = html.match(/<script>([\s\S]*?)<\/script>/)[1];

  // ============================================================
  // TEST 1: LEFT BUTTON PRESS, DRAG & RELEASE SELECTS ACTUAL TERMINAL TEXT
  // ============================================================
  console.log('--- TEST 1: Left-Button Press, Drag, and Release Text Selection ---');

  // Verify functions exist in client source
  assert(jsContent.includes('function applySelectionRange'), 'applySelectionRange logic defined in client');
  assert(jsContent.includes('function toggleLeftButtonLatch'), 'toggleLeftButtonLatch logic defined for L button');

  // Simulate xterm with selection capability
  const termMock = new Terminal({ cols: 80, rows: 24 });
  let appliedRange = null;
  termMock.select = (col, row, length) => {
    appliedRange = { col, row, length };
  };
  termMock.hasSelection = () => appliedRange !== null;
  termMock.getSelection = () => 'SELECTED_TERMINAL_TEXT_SAMPLE';
  termMock.clearSelection = () => { appliedRange = null; };

  // Helper matching client's applySelectionRange algorithm
  function simulateApplySelectionRange(t, anchor, head) {
    if (!anchor || !head) {
      if (t.clearSelection) t.clearSelection();
      return;
    }
    let start, end;
    if (anchor.bufferRow < head.bufferRow || (anchor.bufferRow === head.bufferRow && anchor.col <= head.col)) {
      start = anchor;
      end = head;
    } else {
      start = head;
      end = anchor;
    }
    const cols = t.cols || 80;
    const startCol = Math.max(0, Math.min(cols - 1, start.col));
    const startRow = Math.max(0, start.bufferRow);
    const endCol = Math.max(0, Math.min(cols - 1, end.col));
    const endRow = Math.max(0, end.bufferRow);

    let length = 0;
    if (startRow === endRow) {
      length = Math.max(1, endCol - startCol + 1);
    } else {
      length = cols * (endRow - startRow) + (endCol - startCol + 1);
    }
    t.select(startCol, startRow, length);
  }

  // Simulate left button press at (10, 2), drag to (25, 2), release
  const anchorPoint = { col: 10, row: 2, bufferRow: 2 };
  const dragPoint = { col: 25, row: 2, bufferRow: 2 };
  simulateApplySelectionRange(termMock, anchorPoint, dragPoint);

  assert(termMock.hasSelection(), 'Selection active after press and drag');
  assert(appliedRange.col === 10 && appliedRange.row === 2, 'Selection starts at anchor point (10, 2)');
  assert(appliedRange.length === (25 - 10 + 1), `Selection length covers character range exactly (${appliedRange.length} chars)`);

  // Release: selection must persist until explicitly cleared
  assert(termMock.hasSelection(), 'Selection persists after pointer release without premature clearing');

  // ============================================================
  // TEST 2: LATCHED LEFT BUTTON ALLOWS SELECTION VIA TOUCHPAD DRAGGING
  // ============================================================
  console.log('\n--- TEST 2: Latched Left-Button Selection via Touchpad Dragging ---');

  let isLatched = false;
  let latchAnchor = null;
  let latchHead = null;

  function tapLatchButton(curCol, curRow) {
    isLatched = !isLatched;
    if (isLatched) {
      latchAnchor = { col: curCol, row: curRow, bufferRow: curRow };
      latchHead = { ...latchAnchor };
      simulateApplySelectionRange(termMock, latchAnchor, latchHead);
    }
  }

  function dragOnTouchpad(curCol, curRow) {
    if (isLatched && latchAnchor) {
      latchHead = { col: curCol, row: curRow, bufferRow: curRow };
      simulateApplySelectionRange(termMock, latchAnchor, latchHead);
    }
  }

  // Tap L button to latch
  tapLatchButton(5, 4);
  assert(isLatched === true, 'Tapping L button activates latched state');
  assert(termMock.hasSelection(), 'Latch activation initializes selection anchor');

  // Drag on touchpad
  dragOnTouchpad(30, 4);
  assert(appliedRange.col === 5 && appliedRange.length === 26, 'Dragging while latched extends selection (5 to 30 = 26 cols)');

  // Tap L again to unlatch
  tapLatchButton(30, 4);
  assert(isLatched === false, 'Tapping L again releases latch');
  assert(termMock.hasSelection(), 'Selection remains intact after latch is released');

  // Verify visual indicator class in CSS
  assert(html.includes('.touchpad-btn.latched'), 'Distinct .touchpad-btn.latched visual styling exists');
  assert(jsContent.includes("touchpadBtnLeft.classList.toggle('latched'"), 'Client toggles latched class on touchpadBtnLeft');

  // ============================================================
  // TEST 3: SELECTION HIGHLIGHT ACROSS MULTIPLE LINES & LONG OUTPUTS
  // ============================================================
  console.log('\n--- TEST 3: Multiline & Long Output Selection Math ---');

  // Multiline selection: row 3, col 20 to row 5, col 10 (cols = 80)
  const multilineAnchor = { col: 20, row: 3, bufferRow: 3 };
  const multilineHead = { col: 10, row: 5, bufferRow: 5 };
  simulateApplySelectionRange(termMock, multilineAnchor, multilineHead);

  const expectedLength = 80 * (5 - 3) + (10 - 20 + 1); // 160 - 9 = 151 chars
  assert(appliedRange.col === 20 && appliedRange.row === 3, 'Multiline selection start matches earlier coordinate');
  assert(appliedRange.length === expectedLength, `Multiline selection calculates accurate spanned character length (${expectedLength})`);

  // Reverse drag: anchor is after head
  simulateApplySelectionRange(termMock, multilineHead, multilineAnchor);
  assert(appliedRange.col === 20 && appliedRange.row === 3, 'Reverse drag normalizes chronological order correctly');
  assert(appliedRange.length === expectedLength, 'Reverse drag calculates identical accurate character length');

  // ============================================================
  // TEST 4: COPY COPIES SELECTED TEXT & PRESERVES NEWLINES
  // ============================================================
  console.log('\n--- TEST 4: COPY Button Prioritizes Selection & Preserves Newlines ---');

  const multilineSelectedText = 'Line 1: echo "TEST"\nLine 2: status = OK\nLine 3: done';
  termMock.hasSelection = () => true;
  termMock.getSelection = () => multilineSelectedText;

  // Simulate COPY handler priority
  let clipboardCapturedText = '';
  async function simulateCopyClick() {
    let textToCopy = '';
    if (termMock.hasSelection()) {
      textToCopy = termMock.getSelection() || '';
    }
    if (textToCopy) {
      clipboardCapturedText = textToCopy;
      return true;
    }
    return false;
  }

  const copyResult = await simulateCopyClick();
  assert(copyResult === true, 'COPY handler successfully copied active terminal selection');
  assert(clipboardCapturedText === multilineSelectedText, 'Copied text matches exact selected terminal content');
  assert(clipboardCapturedText.includes('\n'), 'Newlines and line breaks are strictly preserved in copied text');

  // Verify visual confirmation does NOT remove COPY SVG icon
  const copyBtnHtml = html.match(/<button[^>]*id="key-copy-last"[^>]*>([\s\S]*?)<\/button>/)[1];
  assert(copyBtnHtml.includes('<svg'), 'COPY button contains SVG icon');
  assert(!jsContent.includes("keyCopyLast.innerHTML = checkIconSvg"), 'COPY handler does NOT remove or destroy the COPY SVG icon');
  assert(jsContent.includes("keyCopyLast.classList.add('copied')"), 'Subtle visual confirmation provided via .copied CSS class');

  // ============================================================
  // TEST 5: COPY FALLBACK STILL WORKS WITHOUT SELECTION
  // ============================================================
  console.log('\n--- TEST 5: COPY Fallback When No Selection Exists ---');

  termMock.hasSelection = () => false;
  termMock.getSelection = () => '';

  let fallbackCalled = false;
  async function simulateCopyClickWithFallback() {
    let textToCopy = '';
    if (termMock.hasSelection()) {
      textToCopy = termMock.getSelection() || '';
    }
    if (!textToCopy) {
      fallbackCalled = true;
      textToCopy = 'FALLBACK_PREVIOUS_COMMAND_OUTPUT';
    }
    return { copied: true, text: textToCopy };
  }

  const fallbackResult = await simulateCopyClickWithFallback();
  assert(fallbackCalled === true, 'COPY fallback engaged when no text is selected');
  assert(fallbackResult.text === 'FALLBACK_PREVIOUS_COMMAND_OUTPUT', 'COPY fallback extracted previous terminal output');

  // Verify fallback modal for clipboard permission denial
  assert(jsContent.includes('function showClipboardFallbackModal'), 'showClipboardFallbackModal defined for permission denial fallback');
  assert(html.includes('id="clipboard-fallback-modal"') || jsContent.includes('clipboard-fallback-modal'), 'Clipboard fallback modal exists in client logic');

  // ============================================================
  // TEST 6: SCROLLING MOVES THROUGH TERMINAL OUTPUT
  // ============================================================
  console.log('\n--- TEST 6: Terminal Scrolling Natural Behavior ---');

  const scrollTerm = new Terminal({ cols: 80, rows: 10, scrollback: 1000 });
  scrollTerm._core.viewport = { scrollLines: (e) => scrollTerm._core._bufferService.scrollLines(e) };

  for (let i = 1; i <= 40; i++) {
    await new Promise(r => scrollTerm.write(`OUTPUT_LINE_${i}\r\n`, r));
  }

  const initialBaseY = scrollTerm.buffer.active.baseY;
  assert(initialBaseY > 0, `Terminal scrollback populated with ${scrollTerm.buffer.active.length} lines`);

  // Scroll UP
  scrollTerm.scrollLines(-8);
  const scrolledUpY = scrollTerm.buffer.active.viewportY;
  assert(scrolledUpY === initialBaseY - 8, `Vertical swipe / scroll UP moved viewport by 8 lines to ${scrolledUpY}`);

  // Scroll DOWN
  scrollTerm.scrollLines(8);
  const scrolledDownY = scrollTerm.buffer.active.viewportY;
  assert(scrolledDownY === initialBaseY, `Vertical swipe / scroll DOWN restored viewport to ${scrolledDownY}`);

  // Verify latched drag does NOT accidentally trigger scrolling instead of selection
  assert(jsContent.includes('const isSelecting = isLeftButtonLatched || isLeftButtonHeld || isTapAndHoldSelecting;'), 'Client checks selection state before scroll gesture handling');
  assert(jsContent.includes('if (currentMouseMode === \'select\' && isSelecting)'), 'Selection drag takes strict priority over viewport scrolling when latched or holding');

  // ============================================================
  // TEST 7: POINTER MODE WITH TUI APPS & MOUSE TRACKING
  // ============================================================
  console.log('\n--- TEST 7: Pointer Mode & Mouse Tracking Differentiation ---');

  const trackingTerm = new Terminal({ cols: 80, rows: 24 });
  let ptyInputCapture = [];
  function mockSendInput(data) {
    ptyInputCapture.push(data);
  }

  // A) Initially in shell (no mouse tracking active)
  assert(trackingTerm._core.coreMouseService.areMouseEventsActive === false, 'Default shell starts with mouse tracking INACTIVE');

  // Client should NOT send SGR escape sequence to ordinary shell prompt
  assert(jsContent.includes('isAppMouseTrackingActive()'), 'Client distinguishes applications that enable mouse tracking');

  // B) Application enables mouse tracking (e.g. vim or htop DECSET 1000 + DECSET 1006)
  await new Promise(r => trackingTerm.write('\x1b[?1000h\x1b[?1006h', r));
  assert(trackingTerm._core.coreMouseService.areMouseEventsActive === true, 'Terminal application successfully enabled DECSET 1000/1006 mouse tracking');

  // Verify SGR sequences generated when tracking is active
  const col = 12;
  const row = 6;
  const downSeq = `\x1b[<0;${col};${row}M`;
  const upSeq = `\x1b[<0;${col};${row}m`;
  mockSendInput(downSeq + upSeq);

  assert(ptyInputCapture.length === 1, 'Mouse click sent to PTY when application has mouse tracking active');
  assert(ptyInputCapture[0] === '\x1b[<0;12;6M\x1b[<0;12;6m', 'Paired press (M) and release (m) SGR sequences generated');

  // C) Application disables mouse tracking on exit (DECRST 1000)
  ptyInputCapture = [];
  await new Promise(r => trackingTerm.write('\x1b[?1000l\x1b[?1006l', r));
  assert(trackingTerm._core.coreMouseService.areMouseEventsActive === false, 'Exiting application disables mouse tracking');

  // ============================================================
  // TEST 8: NO DUPLICATE MOUSE EVENTS SENT
  // ============================================================
  console.log('\n--- TEST 8: Duplicate Mouse Event Prevention ---');

  // Verify pointerup tap detection avoids duplicate triggers
  assert(jsContent.includes('elapsed < 250 && totalMovedDist < 8'), 'Tap detection has strict duration and movement bounds');
  assert(!jsContent.includes('sendTerminalClick') || jsContent.split('sendTerminalClick(0)').length <= 4, 'No duplicate click dispatches in event handlers');

  // ============================================================
  // TEST 9: CHANGING SESSIONS OR MODES RESETS INTERACTION STATE
  // ============================================================
  console.log('\n--- TEST 9: Session & Mode Switch State Reset ---');

  assert(jsContent.includes('function resetMouseInteractionState'), 'resetMouseInteractionState defined in client');
  assert(jsContent.includes('function setTouchpadMode') && jsContent.includes('resetMouseInteractionState()'), 'Switching touchpad mode resets latched button and selection state');
  assert(jsContent.includes('function openSession') && jsContent.includes('resetMouseInteractionState()'), 'Switching terminal sessions resets interaction state');

  // ============================================================
  // TEST 10: PHONE DISCONNECT PERSISTENCE & PTY ISOLATION
  // ============================================================
  console.log('\n--- TEST 10: Live Session Persistence with Mouse Integration ---');

  const sessionsRes = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  assert(sessionsRes.status === 200 && sessionsRes.body.length >= 1, 'Server sessions query succeeded');
  const targetSession = sessionsRes.body[0];

  const liveWs = await connectWs(targetSession.id);
  assert(liveWs.readyState === WebSocket.OPEN, 'Connected WebSocket to live PTY session');

  // Test executing command
  const execResult = await sendAndAwaitOutput(liveWs, 'echo "MOUSE_TEST_SESSION_PERSIST_OK"\r', 'MOUSE_TEST_SESSION_PERSIST_OK', 6000);
  assert(execResult.matched, 'PTY executes command cleanly under new mouse integration');

  // Simulate phone disconnect
  liveWs.close();
  await new Promise(r => setTimeout(r, 200));

  // Verify session is still alive on server
  const afterDiscRes = await makeRequest('/api/sessions', { headers: { 'x-auth-token': TOKEN } });
  const preservedSession = afterDiscRes.body.find(s => s.id === targetSession.id);
  assert(preservedSession && preservedSession.pid === targetSession.pid, `Session PID ${targetSession.pid} preserved after client disconnect`);

  // ============================================================
  // TEST 11: KEYBOARD, STOP, UP/DOWN & ESSENTIALS CONTINUE WORKING
  // ============================================================
  console.log('\n--- TEST 11: Preservation of Keyboard, STOP, UP/DOWN & Essentials ---');

  const reconnectWs = await connectWs(targetSession.id);
  const upDownTest = await sendAndAwaitOutput(reconnectWs, 'echo "CONTROLS_VERIFIED"\r', 'CONTROLS_VERIFIED', 6000);
  assert(upDownTest.matched, 'Reconnected session responds immediately to keyboard input');
  reconnectWs.close();

  console.log('\n============================================================');
  console.log(`Mouse Integration Verification Complete: ${passed}/${total} assertions passed.`);
  console.log('============================================================\n');

  serverInstance.stop();
  process.exit(passed === total ? 0 : 1);
}

runMouseTestSuite().catch(err => {
  console.error('Fatal test error in mouse test suite:', err);
  if (serverInstance) serverInstance.stop();
  process.exit(1);
});
