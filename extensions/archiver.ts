/**
 * Wire + title logic for the pi conversation-archiver.
 *
 * Deliberately free of any `@earendil-works/pi-coding-agent` import: the
 * extension host is a Node process, so everything here is plain Node
 * (built-ins only) and can be unit-tested without pi installed. The event
 * wiring lives in `conversation-archiver.ts`.
 *
 * Emits GenTerminal's OSC 9999 `genterm-notify` sequence
 * (`ESC ] 9999 ; <base64(JSON)> ST`) exactly like cc/codex/opencode
 * conversation-archiver does, so the app's `utils/osc.ts` parser and the
 * sidebar Sessions name sync treat pi as a first-class agent. Under tmux the
 * sequence is wrapped in the DCS passthrough envelope and `allow-passthrough`
 * is enabled pane-scoped — otherwise tmux drops the unknown OSC (same
 * technique as the codex plugin's notify.py).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

export const SOURCE = 'pi-conversation-archiver';
export const PLACEHOLDER_TITLE = 'Pi';
/** Same cap codex puts on fallback titles (and what the app expects). */
export const SESSION_TITLE_MAX_LEN = 120;

const OSC_PREFIX = '\x1b]9999;';
const ST = '\x1b\\';
const MAGIC = 'genterm-notify';

export interface TmuxContext {
  socket?: string;
  session?: string;
  windowId?: string;
  windowIndex?: number;
  windowName?: string;
}

/**
 * Control wrappers stripped before deriving a title from a prompt. Pi hands
 * the raw user prompt to `before_agent_start`, but a prompt may still carry
 * wrapper blocks (skills / templates / injected context); a naive first line
 * would then pick up `<environment_context>` noise. Same set the codex
 * archiver strips.
 */
const CONTROL_WRAPPERS = [
  'command-message',
  'command-name',
  'command-args',
  'local-command-caveat',
  'local-command-stderr',
  'local-command-stdout',
  'task-notification',
  'system-reminder',
  'ide_opened_file',
  'ide_selection',
  'environment_context',
  'user_instructions',
  'skills_instructions',
  'turn_aborted',
  'permissions_update',
];

function stripControlWrappers(text: string): string {
  let out = text;
  for (const name of CONTROL_WRAPPERS) {
    out = out.replace(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'gi'), ' ');
    out = out.replace(new RegExp(`</?${name}>`, 'gi'), ' ');
  }
  return out;
}

/**
 * First real line of a user prompt, control characters stripped and capped —
 * pi's own fallback title is "the first message" when a session has no
 * user-chosen name, so this mirrors what its session picker shows. Returns
 * null when nothing usable remains.
 */
export function deriveTitleFromPrompt(prompt: string | null | undefined): string | null {
  if (typeof prompt !== 'string' || !prompt) {
    return null;
  }
  const stripped = stripControlWrappers(prompt);
  for (const line of stripped.split(/\r?\n/)) {
    // eslint-disable-next-line no-control-regex
    const clean = line.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (clean) {
      return clean.slice(0, SESSION_TITLE_MAX_LEN);
    }
  }
  return null;
}

/**
 * Last path segment of pi's working directory (`ctx.cwd`) — the managed tmux
 * record's natural default label. Used when a session has NO title at all and
 * there is nothing to derive one from: a `/new` conversation (see the
 * `session_start` wiring) must REVERT the previously reported title, and the
 * cwd basename is the deterministic, field-free value to revert to. Handles
 * POSIX and Windows separators; returns null for a root/empty cwd.
 */
export function cwdBasename(cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string') {
    return null;
  }
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/]/).pop() ?? '';
  return base.trim() ? base.trim().slice(0, SESSION_TITLE_MAX_LEN) : null;
}

/**
 * Title resolution order, mirroring what pi's own session picker displays:
 *   1. the user's session name (`/name`, `--name`, `pi.setSessionName()`) —
 *      the explicit rename, highest priority;
 *   2. the first real user prompt (pi's fallback title);
 *   3. the fixed placeholder "Pi", which GenTerminal filters so a fresh
 *      session can never clobber the record's user-chosen name.
 */
export function resolveTitle(
  sessionName: string | null | undefined,
  firstPrompt: string | null | undefined,
): string {
  const name = typeof sessionName === 'string' ? sessionName.trim() : '';
  if (name) {
    return name.slice(0, SESSION_TITLE_MAX_LEN);
  }
  return deriveTitleFromPrompt(firstPrompt) ?? PLACEHOLDER_TITLE;
}

/** `{ v, magic, source, sourceId, event, title, body, tmux? }` → OSC bytes. */
export function buildOscSequence(
  source: string,
  sourceId: string,
  event: string,
  title: string,
  body: string,
  tmux: TmuxContext | null | undefined,
): string {
  const payload: Record<string, unknown> = {
    v: 1,
    magic: MAGIC,
    source,
    sourceId,
    event,
    title,
    body,
  };
  if (tmux && Object.keys(tmux).length > 0) {
    payload.tmux = tmux;
  }
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return `${OSC_PREFIX}${encoded}${ST}`;
}

/** tmux socket/session/window snapshot so the app can switch to the tab on
 *  click. Returns null outside tmux or when the query fails. */
export function tmuxContext(): TmuxContext | null {
  if (!process.env.TMUX) {
    return null;
  }
  try {
    const out = execFileSync(
      'tmux',
      ['display-message', '-p', '#{socket_path}\t#S\t#{window_id}\t#{window_index}\t#{window_name}'],
      { encoding: 'utf8', timeout: 5000 },
    );
    const parts = out.replace(/\n$/, '').split('\t');
    if (parts.length < 5) {
      return null;
    }
    const [socket, session, windowId, windowIndex, windowName] = parts;
    const ctx: TmuxContext = {};
    if (socket) {
      ctx.socket = socket;
    }
    if (session) {
      ctx.session = session;
    }
    if (windowId) {
      ctx.windowId = windowId;
    }
    if (/^\d+$/.test(windowIndex)) {
      ctx.windowIndex = Number(windowIndex);
    }
    if (windowName) {
      ctx.windowName = windowName;
    }
    return Object.keys(ctx).length > 0 ? ctx : null;
  } catch {
    return null;
  }
}

/** Pane tty under tmux (so the passthrough reaches the attached client),
 *  else /dev/tty when this process actually has a controlling terminal. */
function targetTty(): string | null {
  if (process.env.TMUX) {
    try {
      const t = execFileSync('tmux', ['display-message', '-p', '#{pane_tty}'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      if (t.startsWith('/dev/')) {
        return t;
      }
    } catch {
      // fall through
    }
  }
  if (process.platform !== 'win32') {
    try {
      fs.accessSync('/dev/tty', fs.constants.W_OK);
      return '/dev/tty';
    } catch {
      return null;
    }
  }
  return null;
}

/** DCS passthrough envelope — tmux drops unknown OSC sequences unless they
 *  ride inside this (with `allow-passthrough on`); every ESC in the payload
 *  must be doubled. Exported for the selftest. */
export function wrapForTmux(seq: string): string {
  return `\x1bPtmux;${seq.replace(/\x1b/g, '\x1b\x1b')}\x1b\\`;
}

/**
 * One best-effort notification. Returns true when the sequence was written.
 * NEVER throws — this sits on the agent's event path and a missing tty, a
 * wedged tmux or a write error must degrade to silence, not break the pane.
 */
export function emitNotification(
  source: string,
  sourceId: string,
  event: string,
  title: string,
  body: string,
  tmux: TmuxContext | null | undefined,
): boolean {
  if (!source || !sourceId || !title) {
    return false;
  }
  try {
    let seq = buildOscSequence(source, sourceId, event, title, body, tmux);
    if (process.env.TMUX) {
      try {
        execFileSync('tmux', ['set', '-p', 'allow-passthrough', 'on'], {
          stdio: 'ignore',
          timeout: 5000,
        });
      } catch {
        // best-effort; the wrap is still required and applied below
      }
      seq = wrapForTmux(seq);
    }
    const target = targetTty();
    if (!target) {
      return false;
    }
    const fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);
    try {
      fs.writeSync(fd, seq);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
