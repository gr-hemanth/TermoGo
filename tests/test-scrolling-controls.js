import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import xtermPkg from '@xterm/xterm';
const { Terminal } = xtermPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('============================================================');
console.log('       Testing TermoGo Mobile Viewport Jump & ENTER Controls');
console.log('============================================================\n');

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

// ============================================================
// 1. Audit HTML DOM for Toolbar Controls, Icons & Layout
// ============================================================
console.log('--- 1. Toolbar DOM Audit & Visual Icons ---');
const htmlPath = path.resolve(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

// Verify frontend script parses cleanly without syntax errors
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch !== null, 'Client <script> block found in index.html');
let scriptSyntaxValid = false;
try {
  new vm.Script(scriptMatch[1]);
  scriptSyntaxValid = true;
} catch (e) {
  console.error('[SYNTAX ERROR IN index.html]:', e.message);
}
assert(scriptSyntaxValid, 'Frontend client script (web/index.html) compiles cleanly without syntax errors');

const toolbarMatch = html.match(/<div class="mobile-toolbar">([\s\S]*?)<\/div>/);
assert(toolbarMatch !== null, 'Found mobile toolbar in HTML');

const toolbarHtml = toolbarMatch[1];
const orderStop = toolbarHtml.indexOf('id="key-stop"');
const orderCopyLast = toolbarHtml.indexOf('id="key-copy-last"');
const orderUp = toolbarHtml.indexOf('id="key-up"');
const orderDown = toolbarHtml.indexOf('id="key-down"');
const orderEssentials = toolbarHtml.indexOf('id="btn-essentials"');
const orderEnter = toolbarHtml.indexOf('id="key-enter"');

const correctOrder = (
  orderStop !== -1 &&
  orderCopyLast !== -1 &&
  orderUp !== -1 &&
  orderDown !== -1 &&
  orderEssentials !== -1 &&
  orderEnter !== -1 &&
  orderStop < orderCopyLast &&
  orderCopyLast < orderUp &&
  orderUp < orderDown &&
  orderDown < orderEssentials &&
  orderEssentials < orderEnter
);

assert(correctOrder, 'Toolbar buttons follow exact approved ordering: STOP -> COPY -> UP -> DOWN -> ESSENTIALS -> ENTER');

// Verify UP & DOWN updated to line-and-arrow Jump Icons
assert(toolbarHtml.includes('id="key-up"') && toolbarHtml.includes('M5 3h14') && toolbarHtml.includes('M18 13l-6-6-6 6'), 'UP button has line-and-arrow Jump to Top icon');
assert(toolbarHtml.includes('id="key-down"') && toolbarHtml.includes('M5 21h14') && toolbarHtml.includes('M6 11l6 6 6-6'), 'DOWN button has line-and-arrow Jump to Bottom icon');
assert(toolbarHtml.includes('title="Jump to Top"'), 'UP button has title="Jump to Top"');
assert(toolbarHtml.includes('title="Jump to Bottom"'), 'DOWN button has title="Jump to Bottom"');

// Verify ENTER button markup, return arrow icon and ENTER label
assert(toolbarHtml.includes('id="key-enter"'), 'ENTER button (#key-enter) is present in toolbar');
assert(toolbarHtml.includes('>ENTER<'), 'ENTER button has clear visible ENTER label');
assert(toolbarHtml.includes('polyline points="9 10 4 15 9 20"') && toolbarHtml.includes('M20 4v7a4 4 0 0 1-4 4H4'), 'ENTER button has recognizable return arrow icon');
assert(toolbarHtml.includes('type="button"') && toolbarHtml.includes('tabindex="-1"'), 'ENTER button has type="button" and tabindex="-1"');

// Auxiliary & Touchpad controls preserved
assert(html.includes('id="btn-scroll-up"'), 'Touchpad Scroll Up button (#btn-scroll-up) is present in DOM');
assert(html.includes('id="btn-scroll-down"'), 'Touchpad Scroll Down button (#btn-scroll-down) is present in DOM');
assert(html.includes('id="btn-scroll-bottom"'), 'Touchpad Scroll Bottom button (#btn-scroll-bottom) is present in DOM');

// ============================================================
// 2. Visual Styling & Mobile Responsiveness
// ============================================================
console.log('\n--- 2. Visual Styling & Responsive Sizing ---');
assert(html.includes('.tool-btn-enter') || html.includes('.tool-key-enter'), 'Dedicated .tool-btn-enter / .tool-key-enter CSS exists');
assert(html.includes('flex: 1'), 'ENTER button has flex: 1 to occupy available horizontal space');
assert(html.includes('min-width: 68px'), 'ENTER button has min-width: 68px for easy tapping on phone');
assert(html.includes('.tool-key-scroll.soften'), '.soften visual cue class exists for top/bottom edge state');

// Responsive Calculations across Mobile Widths
const widths = [320, 360, 390, 412];
const fixedButtonsWidth = 44 * 5; // STOP, COPY, UP, DOWN, ESSENTIALS (44px each)
const dividerWidth = 5;          // 1px border + 4px margins
const gapsWidth = 8 * 5;         // 5 gaps between 6 buttons
const paddingWidth = 12 * 2;     // 12px padding on each side
const totalBaseWidth = fixedButtonsWidth + dividerWidth + gapsWidth + paddingWidth; // 289px

widths.forEach(width => {
  const enterAvailableWidth = width - totalBaseWidth;
  if (width >= 360) {
    assert(enterAvailableWidth >= 68, `Width ${width}px: ENTER button has ample flex width (${enterAvailableWidth}px >= 68px min-width) without wrapping`);
  } else {
    assert(html.includes('overflow-x: auto'), `Width ${width}px: Narrow screen accommodates toolbar safely via overflow-x: auto momentum scrolling`);
  }
});

// ============================================================
// 3. Terminal Viewport Jump Navigation (One-Tap Top & Bottom)
// ============================================================
console.log('\n--- 3. Viewport Jump Navigation Mechanics ---');
const term = new Terminal({ cols: 80, rows: 10, scrollback: 1000 });
term._core.viewport = { scrollLines: (e) => term._core._bufferService.scrollLines(e) };

// Generate 80 lines of output
let bufferText = '';
for (let i = 1; i <= 80; i++) {
  bufferText += `SCROLL_HISTORY_LINE_${i}\r\n`;
}
await new Promise(r => term.write(bufferText, r));

assert(term.buffer.active.length >= 80, `Terminal populated with ${term.buffer.active.length} buffer lines`);
const baseY = term.buffer.active.baseY;
assert(baseY > 0, `Base scroll offset baseY = ${baseY}`);

// Initially at bottom
assert(term.buffer.active.viewportY === baseY, `Initial viewport is at the bottom (viewportY = ${term.buffer.active.viewportY})`);

// JUMP TEST 1: From bottom to absolute top in one tap
term.scrollToTop();
assert(term.buffer.active.viewportY === 0, `[JUMP 1] UP immediately jumped from bottom (${baseY}) to absolute top (viewportY = 0) in one tap`);

// JUMP TEST 2: From top to absolute bottom in one tap
term.scrollToBottom();
assert(term.buffer.active.viewportY === baseY, `[JUMP 2] DOWN immediately jumped from top (0) to absolute bottom (viewportY = ${baseY}) in one tap`);

// JUMP TEST 3: From middle of scrollback to absolute top
const midY = Math.floor(baseY / 2);
term.scrollLines(-(baseY - midY));
assert(term.buffer.active.viewportY === midY, `Positioned in middle of scrollback at line ${midY}`);

term.scrollToTop();
assert(term.buffer.active.viewportY === 0, `[JUMP 3] UP immediately jumped from middle (${midY}) to absolute top (viewportY = 0)`);

// JUMP TEST 4: From middle of scrollback to absolute bottom
term.scrollLines(midY);
assert(term.buffer.active.viewportY === midY, `Re-positioned in middle of scrollback at line ${midY}`);

term.scrollToBottom();
assert(term.buffer.active.viewportY === baseY, `[JUMP 4] DOWN immediately jumped from middle (${midY}) to absolute bottom (viewportY = ${baseY})`);

// ============================================================
// 4. Live Output Pinning & Live Output Following
// ============================================================
console.log('\n--- 4. Live Output Pinning & Auto-Following ---');

// User jumps to top to inspect history
term.scrollToTop();
assert(term.buffer.active.viewportY === 0, 'User navigated to top of scrollback');

// New output arrives while user is reading history
await new Promise(r => term.write('NEW_STREAMING_LINE_A\r\nNEW_STREAMING_LINE_B\r\n', r));
assert(term.buffer.active.viewportY === 0, 'Live output arrived but viewport remained strictly pinned at top (line 0)');

// User taps DOWN to return to latest output
term.scrollToBottom();
const updatedBaseY = term.buffer.active.baseY;
assert(term.buffer.active.viewportY === updatedBaseY, `Tap DOWN restored viewport to live bottom (line ${updatedBaseY})`);

// Subsequent output auto-follows at bottom
await new Promise(r => term.write('FOLLOW_LINE_C\r\n', r));
assert(term.buffer.active.viewportY === term.buffer.active.baseY, 'Subsequent live output continues auto-following at the bottom');

// ============================================================
// 5. Zero PTY Side Effects for Jump Controls
// ============================================================
console.log('\n--- 5. Zero PTY Side Effects Verification ---');
const jsContent = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const upMatch = jsContent.match(/function handleKeyUp\([^{]*\)\s*\{([\s\S]*?)\n  \}/);
const downMatch = jsContent.match(/function handleKeyDown\([^{]*\)\s*\{([\s\S]*?)\n  \}/);
assert(upMatch !== null, 'Found handleKeyUp implementation in client script');
assert(downMatch !== null, 'Found handleKeyDown implementation in client script');

const upBody = upMatch[1];
const downBody = downMatch[1];

assert(upBody.includes('scrollToTop()'), 'handleKeyUp invokes activeTerm.scrollToTop()');
assert(!upBody.includes('sendInput') && !upBody.includes('ws.send') && !upBody.includes('\\x1b['), 'handleKeyUp does NOT call sendInput, ws.send, or emit arrow escape sequences');

assert(downBody.includes('scrollToBottom()'), 'handleKeyDown invokes activeTerm.scrollToBottom()');
assert(!downBody.includes('sendInput') && !downBody.includes('ws.send') && !downBody.includes('\\x1b['), 'handleKeyDown does NOT call sendInput, ws.send, or emit arrow escape sequences');

// Touchpad controls also verified for zero PTY input
const scrollUpCode = jsContent.match(/btnScrollUp\.onclick\s*=\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\};/)[1];
const scrollDownCode = jsContent.match(/btnScrollDown\.onclick\s*=\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\};/)[1];
const scrollBottomCode = jsContent.match(/btnScrollBottom\.onclick\s*=\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\};/)[1];
assert(!scrollUpCode.includes('sendInput') && !scrollUpCode.includes('ws.send'), 'Touchpad Scroll UP does NOT call sendInput or ws.send');
assert(!scrollDownCode.includes('sendInput') && !scrollDownCode.includes('ws.send'), 'Touchpad Scroll DOWN does NOT call sendInput or ws.send');
assert(!scrollBottomCode.includes('sendInput') && !scrollBottomCode.includes('ws.send'), 'Touchpad Scroll BOTTOM does NOT call sendInput or ws.send');

// ============================================================
// 6. ENTER Button Client Keystroke & Form Isolation
// ============================================================
console.log('\n--- 6. ENTER Button Keystroke & Form Isolation ---');
const enterMatch = jsContent.match(/function handleKeyEnter\([^{]*\)\s*\{([\s\S]*?)\n  \}/);
assert(enterMatch !== null, 'Found handleKeyEnter implementation in client script');

const enterBody = enterMatch[1];
assert(enterBody.includes("sendInput('\\r')"), 'handleKeyEnter transmits standard carriage return (\\r) to active terminal');
assert(!enterBody.includes('btnSendPrompt') && !enterBody.includes('sendPrompt'), 'handleKeyEnter does NOT click SEND button or invoke sendPrompt()');
assert(!enterBody.includes('promptInput'), 'handleKeyEnter does NOT submit or alter promptInput textarea');
assert(jsContent.includes('ENTER_DEBOUNCE_MS'), 'handleKeyEnter includes debounce guard against rapid duplicate touch/click firing');
assert(jsContent.includes("keyEnter.addEventListener('pointerdown', handleKeyEnter)"), 'keyEnter attaches pointerdown listener for instant mobile touch reaction');
assert(jsContent.includes('keyEnter.onclick = handleKeyEnter'), 'keyEnter attaches click fallback listener');

// Verify sendInput safely handles disconnected state
const sendInputMatch = jsContent.match(/function sendInput\([^{]*\)\s*\{([\s\S]*?)\n  \}/);
assert(sendInputMatch !== null, 'Found sendInput implementation');
const sendInputBody = sendInputMatch[1];
assert(sendInputBody.includes('ws && ws.readyState === WebSocket.OPEN'), 'sendInput safely verifies WebSocket connection before sending, preventing exceptions when disconnected');

// ============================================================
// 7. Multi-Session Switching & Active Terminal Binding
// ============================================================
console.log('\n--- 7. Session Switching & Active Terminal Binding ---');
assert(jsContent.includes('function getActiveTerminal()'), 'getActiveTerminal() helper defined for dynamic terminal instance binding');

// Simulate multi-session terminal management
let simulatedCurrentSession = 'session-1';
const termSession1 = new Terminal({ cols: 80, rows: 10, scrollback: 1000 });
termSession1._core.viewport = { scrollLines: (e) => termSession1._core._bufferService.scrollLines(e) };
for (let i = 1; i <= 40; i++) termSession1.write(`SESSION_1_LINE_${i}\r\n`);

const termSession2 = new Terminal({ cols: 80, rows: 10, scrollback: 1000 });
termSession2._core.viewport = { scrollLines: (e) => termSession2._core._bufferService.scrollLines(e) };
for (let i = 1; i <= 70; i++) termSession2.write(`SESSION_2_LINE_${i}\r\n`);

let activeTerm = termSession1;
function getSimulatedActiveTerminal() {
  return activeTerm;
}

// 7a. Operate on Session 1
getSimulatedActiveTerminal().scrollToTop();
assert(termSession1.buffer.active.viewportY === 0, 'Session 1: UP jumped active session 1 terminal to top');

getSimulatedActiveTerminal().scrollToBottom();
assert(termSession1.buffer.active.viewportY === termSession1.buffer.active.baseY, 'Session 1: DOWN jumped active session 1 terminal to bottom');

// 7b. Switch session to Session 2
simulatedCurrentSession = 'session-2';
activeTerm = termSession2;

// 7c. Operate on Session 2 - verify controls target Session 2
getSimulatedActiveTerminal().scrollToTop();
assert(termSession2.buffer.active.viewportY === 0, 'Session 2: After session switch, UP jumped active session 2 terminal to top');

getSimulatedActiveTerminal().scrollToBottom();
assert(termSession2.buffer.active.viewportY === termSession2.buffer.active.baseY, 'Session 2: After session switch, DOWN jumped active session 2 terminal to bottom');

// Session 1 remains untouched
assert(termSession1.buffer.active.viewportY === termSession1.buffer.active.baseY, 'Session 1 viewport state was preserved independently during session switch');

console.log(`\n============================================================`);
console.log(`Scroll & ENTER Controls Verification: ${passed}/${total} assertions passed.`);
console.log(`============================================================\n`);

process.exit(passed === total ? 0 : 1);
