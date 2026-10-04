import pkg from '@xterm/xterm';
const { Terminal } = pkg;
import { stripAnsi, extractFromTerminal, extractCleanResponseFromLines } from '../server/index.js';

console.log('--- Testing AGY Clean Response Extractor ---');

async function testUserExample() {
  const term = new Terminal({ cols: 100, rows: 30 });
  
  // Exact example from user prompt:
  // [AGY internal/rendered terminal UI]
  // The folder has been created on your Desktop:
  // • test_successful (active Desktop:
  //   C:/Users/Hemanth/OneDrive/Desktop/test_successful)
  // ────────────────────────
  // >
  // ────────────────────────
  // ? for shortcuts
  // Gemini 3.8 Flash · high
  
  const rawPtyInput = 
    '\x1b[?1004h\x1b[O\x1b[O' +
    '● Bash(mkdir C:\\Users\\Hemanth\\OneDrive\\Desktop\\test_successful)\r\n' +
    'The folder has been created on your Desktop:\r\n\r\n' +
    '• test_successful (active Desktop:\r\n' +
    '  C:/Users/Hemanth/OneDrive/Desktop/test_successful)\r\n\r\n' +
    '────────────────────────────────────────────────\r\n' +
    '> \r\n' +
    '────────────────────────────────────────────────\r\n' +
    '? for shortcuts\r\n' +
    'Gemini 3.8 Flash · high\r\n';

  await new Promise(r => term.write(rawPtyInput, r));

  const extracted = extractFromTerminal(term).text;
  console.log('EXTRACTED RESULT:\n------------------\n' + extracted + '\n------------------');

  const expected = 
    'The folder has been created on your Desktop:\n\n' +
    '• test_successful (active Desktop:\n' +
    '  C:/Users/Hemanth/OneDrive/Desktop/test_successful)';

  if (extracted === expected) {
    console.log('[PASS] Exact user example extracted cleanly!');
  } else {
    console.error('[FAIL] Expected:\n' + JSON.stringify(expected) + '\nGot:\n' + JSON.stringify(extracted));
    process.exit(1);
  }

  // Verify none of the unwanted elements leaked:
  const forbidden = [
    '[O[O',
    '● Bash',
    'Bash(',
    '────────────────',
    '? for shortcuts',
    'Gemini 3.8 Flash'
  ];

  for (const f of forbidden) {
    if (extracted.includes(f)) {
      console.error(`[FAIL] Unwanted element leaked: "${f}"`);
      process.exit(1);
    }
  }
  console.log('[PASS] Zero unwanted UI elements or control sequences in extracted output.');
}

async function testWithToolCallsAndPreviousInteractions() {
  const term = new Terminal({ cols: 100, rows: 40 });

  const stream = 
    '────────────────────────────────────────────────\r\n' +
    '> check files and create directory\r\n' +
    '────────────────────────────────────────────────\r\n' +
    '● Read(package.json)\r\n' +
    '● Bash(mkdir -p test_dir)\r\n' +
    'Done! I have created `test_dir`.\r\n' +
    'Here are the details:\r\n' +
    '• Created at root\r\n' +
    '• Ready for testing\r\n' +
    '────────────────────────────────────────────────\r\n' +
    '> \r\n' +
    '────────────────────────────────────────────────\r\n' +
    '? for shortcuts\r\n' +
    'Gemini 3.8 Flash · high\r\n';

  await new Promise(r => term.write(stream, r));
  const extracted = extractFromTerminal(term).text;
  console.log('MULTI-TOOL RESULT:\n------------------\n' + extracted + '\n------------------');

  if (extracted.includes('● Read') || extracted.includes('● Bash') || extracted.includes('Gemini') || extracted.includes('shortcuts')) {
    console.error('[FAIL] Tool or footer leaked into extracted output');
    process.exit(1);
  }
  if (!extracted.includes('Done! I have created `test_dir`') || !extracted.includes('• Created at root')) {
    console.error('[FAIL] Missing response text');
    process.exit(1);
  }
  console.log('[PASS] Multi-tool interaction cleanly extracted!');
}

async function testWithBulletsAndQuotesInsideResponse() {
  const term = new Terminal({ cols: 100, rows: 40 });

  const stream = 
    '────────────────────────────────────────────────\r\n' +
    '> list the options and quote\r\n' +
    '────────────────────────────────────────────────\r\n' +
    '● Bash(cat options.txt)\r\n' +
    'Here are the proposed changes:\r\n\r\n' +
    '● Option 1: Use client-side extraction\r\n' +
    '● Option 2: Use virtual terminal on server\r\n\r\n' +
    '> Note: both options preserve fidelity.\r\n' +
    '────────────────────────────────────────────────\r\n' +
    '> \r\n' +
    '────────────────────────────────────────────────\r\n' +
    '? for shortcuts\r\n' +
    'Gemini 3.8 Flash · high\r\n';

  await new Promise(r => term.write(stream, r));
  const extracted = extractFromTerminal(term).text;
  console.log('INTERNAL BULLETS RESULT:\n------------------\n' + extracted + '\n------------------');

  if (!extracted.includes('● Option 1: Use client-side extraction')) {
    console.error('[FAIL] Legitimate bullet inside response was stripped!');
    process.exit(1);
  }
  if (!extracted.includes('> Note: both options preserve fidelity.')) {
    console.error('[FAIL] Legitimate quote inside response was stripped!');
    process.exit(1);
  }
  if (extracted.includes('● Bash') || extracted.includes('Gemini 3.8 Flash')) {
    console.error('[FAIL] Unwanted UI chrome leaked');
    process.exit(1);
  }
  console.log('[PASS] Legitimate bullets and quotes inside response preserved!');
}

async function testShellInteraction() {
  const term = new Terminal({ cols: 100, rows: 25 });

  const stream = 
    'PS C:\\Users\\Hemanth\\OneDrive\\Desktop\\termogo> git status\r\n' +
    'On branch main\r\n' +
    'Your branch is up to date with \'origin/main\'.\r\n\r\n' +
    'nothing to commit, working tree clean\r\n' +
    'PS C:\\Users\\Hemanth\\OneDrive\\Desktop\\termogo> ';

  await new Promise(r => term.write(stream, r));
  const extracted = extractFromTerminal(term).text;
  console.log('SHELL INTERACTION RESULT:\n------------------\n' + extracted + '\n------------------');

  if (!extracted.includes('On branch main') || !extracted.includes('nothing to commit, working tree clean')) {
    console.error('[FAIL] Shell output not extracted');
    process.exit(1);
  }
  console.log('[PASS] Regular shell interaction extracted cleanly!');
}

async function run() {
  await testUserExample();
  await testWithToolCallsAndPreviousInteractions();
  await testWithBulletsAndQuotesInsideResponse();
  await testShellInteraction();
  console.log('\nAll extractor tests PASSED successfully!');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});


