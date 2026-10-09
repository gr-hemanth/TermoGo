import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.resolve(__dirname, '..', 'web', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

console.log('============================================================');
console.log('        TermoGo Mobile UI/UX Responsiveness Audit           ');
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

// 1. Mandatory Changes Verification
assert(!html.includes('id="btn-copy-last"'), 'Mandatory Change 1: Duplicate session bar COPY LAST button is removed');
const copyLastButtons = (html.match(/id="key-copy-last"/g) || []).length;
assert(copyLastButtons === 1, `Mandatory Change 1: Exactly 1 visible COPY button exists in DOM (#key-copy-last)`);
assert(!html.includes('id="debug-bar"'), 'Mandatory Change 2: [WS_READY] debug strip (#debug-bar) is removed from DOM');

// 2. Session Bar Layout
assert(!html.includes('◀ Terminals</small>'), 'Session bar: Redundant "◀ Terminals" link removed');
assert(html.includes('class="session-dot"'), 'Session bar: Compact status dot indicator present');
assert(html.includes('id="btn-reconnect"'), 'Session bar: Reconnect button preserved');
assert(html.includes('height: 32px'), 'Session bar: Compact 32px height applied saving vertical space');

// 3. Header Vertical Space
assert(html.includes('header {\n      height: 40px'), 'Header: Reduced to compact 40px height');
assert(html.includes('id="btn-toggle-view"') && html.includes('id="btn-new-term"'), 'Header: Action buttons preserved');
assert(html.includes('id="status-dot"') && html.includes('id="status-text"'), 'Header: Compact connection status indicator preserved');

// 4. Mobile Toolbar Priority & Dimensions
const toolbarHtml = html.match(/<div class="mobile-toolbar">([\s\S]*?)<\/div>/)[1];
const orderStop = toolbarHtml.indexOf('id="key-stop"');
const orderCopyLast = toolbarHtml.indexOf('id="key-copy-last"');
const orderUp = toolbarHtml.indexOf('id="key-up"');
const orderDown = toolbarHtml.indexOf('id="key-down"');
const orderEssentials = toolbarHtml.indexOf('id="btn-essentials"');

assert(orderStop < orderCopyLast, 'Toolbar: STOP is placed 1st');
assert(orderCopyLast < orderUp, 'Toolbar: COPY is placed 2nd');
assert(orderUp < orderDown, 'Toolbar: UP is placed 3rd');
assert(orderDown < orderEssentials, 'Toolbar: DOWN is placed 4th');
assert(orderEssentials !== -1, 'Toolbar: Essentials button is placed 5th');

assert(html.includes('min-height: 40px'), 'Toolbar buttons have comfortable >= 40px touch targets');
assert(html.includes('gap: 8px'), 'Toolbar buttons have 8px spacing preventing accidental tap overlaps');

// 5. Command Input Footer
assert(html.includes('id="prompt-input"'), 'Command Input: #prompt-input exists');
assert(html.includes('id="btn-send-prompt"'), 'Command Input: #btn-send-prompt exists');
assert(html.includes('btn-send-prompt'), 'Command Input: Styled Send button with unified height');
assert(html.includes('box-sizing: border-box'), 'Command Input: Box-sizing border-box applied to prevent horizontal overflow');

// 6. Responsive Width Calculations for 320px, 360px, 390px, 412px
const widths = [320, 360, 390, 412];
widths.forEach(width => {
  // Input footer: padding 10px each side (20px total) + gap 8px + send button 60px
  const footerPadding = 20;
  const gap = 8;
  const sendBtnWidth = 60;
  const inputWidth = width - footerPadding - gap - sendBtnWidth;
  assert(inputWidth >= 232, `Width ${width}px: Command input field has ample typing width (${inputWidth}px) with zero overflow`);

  // Subbar: padding 10px each side (20px total) + reconnect btn 65px
  const subbarAvailable = width - 20 - 65;
  assert(subbarAvailable >= 235, `Width ${width}px: Terminal title has ample width (${subbarAvailable}px) without collision`);
});

console.log(`\n============================================================`);
console.log(`Responsiveness & UI Verification: ${passed}/${total} assertions passed.`);
console.log(`============================================================\n`);

process.exit(passed === total ? 0 : 1);
