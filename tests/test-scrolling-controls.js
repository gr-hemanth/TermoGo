import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import xtermPkg from '@xterm/xterm';
const { Terminal } = xtermPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

console.log('============================================================');
console.log('       Testing TermoGo Mobile Viewport Scroll Controls      ');
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

// 1. Audit HTML DOM for preferred button ordering & styling
const htmlPath = path.resolve(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

assert(html.includes('id="btn-scroll-up"'), 'Scroll Up button (#btn-scroll-up) is present in DOM');
assert(html.includes('id="btn-scroll-down"'), 'Scroll Down button (#btn-scroll-down) is present in DOM');
assert(html.includes('id="btn-scroll-bottom"'), 'Scroll Bottom button (#btn-scroll-bottom) is present in DOM');

// Verify approved ordering in toolbar: STOP -> COPY -> UP -> DOWN -> ESSENTIALS
const toolbarMatch = html.match(/<div class="mobile-toolbar">([\s\S]*?)<\/div>/);
assert(toolbarMatch !== null, 'Found mobile toolbar in HTML');

const toolbarHtml = toolbarMatch[1];
const orderStop = toolbarHtml.indexOf('id="key-stop"');
const orderCopyLast = toolbarHtml.indexOf('id="key-copy-last"');
const orderUp = toolbarHtml.indexOf('id="key-up"');
const orderDown = toolbarHtml.indexOf('id="key-down"');
const orderEssentials = toolbarHtml.indexOf('id="btn-essentials"');

const correctOrder = (
  orderStop !== -1 &&
  orderCopyLast !== -1 &&
  orderUp !== -1 &&
  orderDown !== -1 &&
  orderEssentials !== -1 &&
  orderStop < orderCopyLast &&
  orderCopyLast < orderUp &&
  orderUp < orderDown &&
  orderDown < orderEssentials
);

assert(correctOrder, 'Toolbar buttons follow exact approved ordering: STOP -> COPY -> UP -> DOWN -> ESSENTIALS');

// Mandatory UI Cleanup Assertions
const copyLastButtons = (html.match(/id="key-copy-last"/g) || []).length;
assert(copyLastButtons === 1, 'Single COPY LAST button verified in DOM (only #key-copy-last in mobile toolbar)');
assert(!html.includes('id="btn-copy-last"'), 'Duplicate session-bar COPY LAST button (#btn-copy-last) removed');
assert(!html.includes('id="debug-bar"'), 'Diagnostic debug-bar element (#debug-bar) completely removed from DOM');
assert(!html.includes('◀ Terminals</small>'), 'Redundant "◀ Terminals" text removed from session subbar');

// 2. Verify visual styling classes exist
assert(html.includes('.tool-key-scroll'), 'Dedicated .tool-key-scroll CSS class exists');
assert(html.includes('.tool-key-scroll-bottom'), 'Distinct .tool-key-scroll-bottom CSS class exists with accent styling');
assert(html.includes('.tool-key-scroll.soften'), '.soften visual cue class exists for top/bottom edge state');

// 3. Test xterm.js scrolling behavior, live output pinning, and scrollToBottom
const term = new Terminal({ cols: 80, rows: 10, scrollback: 1000 });
// Wire headless viewport bridge to bufferService (as xterm's DOM Viewport does in browser)
term._core.viewport = { scrollLines: (e) => term._core._bufferService.scrollLines(e) };

// Produce 60 lines of output
let bufferText = '';
for (let i = 1; i <= 60; i++) {
  bufferText += `LINE ${i}\r\n`;
}

await new Promise(r => term.write(bufferText, r));

assert(term.buffer.active.length >= 60, `Terminal buffer populated (${term.buffer.active.length} lines)`);
const baseY = term.buffer.active.baseY;
assert(baseY > 0, `Base scroll offset baseY = ${baseY}`);

// Initially at the bottom
assert(term.buffer.active.viewportY === baseY, `Initial viewport is at the bottom (viewportY = ${term.buffer.active.viewportY})`);

// TEST A: Scroll Up by 8 lines
const SCROLL_AMOUNT = 8;
term.scrollLines(-SCROLL_AMOUNT);
const yAfterUp = term.buffer.active.viewportY;
assert(yAfterUp === baseY - SCROLL_AMOUNT, `[TEST A] Scroll UP by ${SCROLL_AMOUNT} lines moved viewport from ${baseY} to ${yAfterUp}`);

// Tap UP again
term.scrollLines(-SCROLL_AMOUNT);
const yAfterUp2 = term.buffer.active.viewportY;
assert(yAfterUp2 === baseY - (SCROLL_AMOUNT * 2), `[TEST A] Second UP moved viewport to ${yAfterUp2}`);

// TEST B: Scroll Down by 8 lines
term.scrollLines(SCROLL_AMOUNT);
const yAfterDown = term.buffer.active.viewportY;
assert(yAfterDown === yAfterUp, `[TEST B] Scroll DOWN moved viewport down to ${yAfterDown}`);

// TEST D: Live Output Pinning (Viewport must NOT jump to bottom when user is scrolled up)
assert(yAfterDown < baseY, 'User is currently scrolled upward in history');
const oldViewportY = term.buffer.active.viewportY;

// New live output arrives
await new Promise(r => term.write('NEW_STREAMING_LINE_1\r\nNEW_STREAMING_LINE_2\r\n', r));
const viewportAfterLiveOutput = term.buffer.active.viewportY;
assert(viewportAfterLiveOutput === oldViewportY, `[TEST D] Live output did NOT force viewport to bottom (preserved at line ${viewportAfterLiveOutput})`);

// TEST C: Scroll to Bottom
term.scrollToBottom();
const yAfterBottom = term.buffer.active.viewportY;
const newBaseY = term.buffer.active.baseY;
assert(yAfterBottom === newBaseY, `[TEST C] Tap BOTTOM immediately restored viewport to latest output (line ${yAfterBottom})`);

// Now that we're at bottom, verify live output continues to follow
await new Promise(r => term.write('NEW_FOLLOW_LINE\r\n', r));
assert(term.buffer.active.viewportY === term.buffer.active.baseY, 'After BOTTOM, live output auto-follows at bottom');

// TEST E: Verify NO PTY Side Effect
// Verify that click handlers only invoke local xterm methods and do NOT call sendInput
const jsContent = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const scrollUpCode = jsContent.match(/btnScrollUp\.onclick\s*=\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\};/)[1];
const scrollDownCode = jsContent.match(/btnScrollDown\.onclick\s*=\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\};/)[1];
const scrollBottomCode = jsContent.match(/btnScrollBottom\.onclick\s*=\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\};/)[1];

assert(!scrollUpCode.includes('sendInput') && !scrollUpCode.includes('ws.send'), '[TEST E] Scroll UP does NOT call sendInput or ws.send');
assert(!scrollDownCode.includes('sendInput') && !scrollDownCode.includes('ws.send'), '[TEST E] Scroll DOWN does NOT call sendInput or ws.send');
assert(!scrollBottomCode.includes('sendInput') && !scrollBottomCode.includes('ws.send'), '[TEST E] Scroll BOTTOM does NOT call sendInput or ws.send');

console.log(`\n============================================================`);
console.log(`Scroll Controls Verification: ${passed}/${total} assertions passed.`);
console.log(`============================================================\n`);

process.exit(passed === total ? 0 : 1);
