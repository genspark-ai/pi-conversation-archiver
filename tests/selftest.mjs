/**
 * pi-conversation-archiver selftest (plain Node, no test framework).
 *
 * Imports the TypeScript sources directly, which needs Node's built-in type
 * stripping (Node >= 22.19 — exactly what pi itself requires). On an older
 * Node the selftest prints a skip and exits 0; the terminal repo's Jest
 * wrapper covers the same code through ts-jest in CI.
 *
 *     node tests/selftest.mjs
 */
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

let archiver;
try {
  archiver = await import(path.join(here, '..', 'extensions', 'archiver.ts'));
} catch (err) {
  console.log(`selftest skipped: cannot import TS sources on this Node (${err?.code ?? err})`);
  process.exit(0);
}

const {
  PLACEHOLDER_TITLE,
  SESSION_TITLE_MAX_LEN,
  SOURCE,
  buildOscSequence,
  cwdBasename,
  deriveTitleFromPrompt,
  resolveTitle,
  wrapForTmux,
} = archiver;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function decode(seq) {
  const m = /^\x1b\]9999;([A-Za-z0-9+/=]+)\x1b\\$/.exec(seq);
  if (!m) {
    return null;
  }
  return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
}

// ── title resolution ──────────────────────────────────────────────────────
check('placeholder when nothing', resolveTitle(null, null), PLACEHOLDER_TITLE);
check('placeholder when name blank', resolveTitle('   ', null), PLACEHOLDER_TITLE);
check('session name wins', resolveTitle('Refactor auth', 'some prompt'), 'Refactor auth');
check('session name trimmed', resolveTitle('  Refactor auth  ', null), 'Refactor auth');
check('first prompt fallback', resolveTitle(null, 'Fix the login bug'), 'Fix the login bug');
check('first non-empty line wins', resolveTitle(null, '\n\n  Fix it now  \nsecond'), 'Fix it now');
check('control chars stripped', resolveTitle(null, 'Fix\u0007 the bug'), 'Fix the bug');
check(
  'empty after wrappers -> placeholder',
  resolveTitle(null, '<environment_context>cwd: /x</environment_context>'),
  PLACEHOLDER_TITLE,
);
check(
  'wrapper block dropped',
  deriveTitleFromPrompt('<system-reminder>noise</system-reminder>\nReal title'),
  'Real title',
);
const longLine = 'x'.repeat(200);
check('120-char cap', deriveTitleFromPrompt(longLine).length, SESSION_TITLE_MAX_LEN);

// ── /new fallback title (cwd basename) ────────────────────────────────────
check('cwd basename posix', cwdBasename('/srv/app'), 'app');
check('cwd basename trailing slash', cwdBasename('/srv/app/'), 'app');
check('cwd basename windows', cwdBasename('C:\\Users\\dev\\proj'), 'proj');
check('cwd basename root is null', cwdBasename('/'), null);
check('cwd basename empty is null', cwdBasename(''), null);
check('cwd basename missing is null', cwdBasename(undefined), null);

// ── OSC 9999 wire contract ────────────────────────────────────────────────
const seq = buildOscSequence(SOURCE, 'sess-1', 'TurnStarted', 'Fix it', 'Turn 1 started', null);
check('osc prefix/suffix', seq.startsWith('\x1b]9999;') && seq.endsWith('\x1b\\'), true);
const decoded = decode(seq);
check('magic', decoded?.magic, 'genterm-notify');
check('version', decoded?.v, 1);
check('source', decoded?.source, SOURCE);
check('sourceId', decoded?.sourceId, 'sess-1');
check('event', decoded?.event, 'TurnStarted');
check('title', decoded?.title, 'Fix it');
check('body', decoded?.body, 'Turn 1 started');
check('no tmux field when absent', Object.prototype.hasOwnProperty.call(decoded ?? {}, 'tmux'), false);

const withTmux = decode(
  buildOscSequence(SOURCE, 's', 'SessionStarted', 'Pi', 'Session started', {
    socket: '/tmp/tmux-1000/default,123,0',
    session: 'gt-abcd1234',
    windowId: '@1',
    windowIndex: 0,
    windowName: 'gt-abcd1234',
  }),
);
check('tmux.session', withTmux?.tmux?.session, 'gt-abcd1234');
check('tmux.windowIndex number', withTmux?.tmux?.windowIndex, 0);

// ── tmux DCS passthrough envelope ─────────────────────────────────────────
const wrapped = wrapForTmux('\x1b]9999;abc\x1b\\');
check('wrap prefix', wrapped.startsWith('\x1bPtmux;'), true);
check('wrap doubles inner ESC', wrapped.includes('\x1b\x1b]9999;'), true);
check('wrap terminates DCS', wrapped.endsWith('\x1b\\'), true);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
