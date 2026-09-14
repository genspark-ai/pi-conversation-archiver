/**
 * pi conversation-archiver — reports the pi session's status and title to
 * GenTerminal over OSC 9999 (`genterm-notify`), the pi counterpart of
 * cc/codex/opencode-conversation-archiver.
 *
 * Loaded by pi as a package extension. Reports:
 *   - session_start        → "Session started" / "Session resumed"; on
 *                            reason "new" (`/new`) the title reverts to the
 *                            working directory's basename, because the fresh
 *                            conversation has no title and pi emits no
 *                            session_info_changed to clear the old one
 *   - before_agent_start   → "Turn N started" (and the first-prompt title)
 *   - agent_settled        → "Turn complete · N turns"
 *   - session_info_changed → the new title (a /name rename)
 *   - session_shutdown     → "Session ended"
 *
 * GenTerminal's sidebar Sessions section joins on `payload.tmux.session ==
 * record.tmux_name` (consent: the record was created with Launch Pi) and
 * renames the record to the reported title; placeholder titles are filtered
 * app-side so a fresh session cannot clobber a user-chosen record name.
 *
 * Everything is best-effort: no handler may ever throw into pi's event loop.
 */
import {
  SOURCE,
  cwdBasename,
  emitNotification,
  resolveTitle,
  tmuxContext,
} from './archiver';

/**
 * The slice of pi's ExtensionAPI this extension uses. Declared structurally
 * (rather than imported from `@earendil-works/pi-coding-agent`) so the
 * package has NO runtime dependency: pi injects the API object and the host
 * resolves the import, but a bare `git:` install never installs that package
 * locally.
 */
interface PiExtensionApiLike {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
  getSessionName?: () => string | null | undefined;
}

interface PiEventContextLike {
  /** Current working directory (pi's ExtensionContext.cwd). */
  cwd?: string;
  sessionManager?: {
    getSessionFile?: () => string | null | undefined;
    getSessionId?: () => string | null | undefined;
    getEntries?: () => unknown;
  };
}

interface PiMessagePartLike {
  type?: string;
  text?: string;
}

interface PiEntryLike {
  type?: string;
  message?: { role?: string; content?: unknown };
}

/** Flatten a message content value (string or text parts) to plain text. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = part as PiMessagePartLike | null;
        return p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string'
          ? p.text
          : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * The FIRST user message already in the session — present when pi resumes,
 * forks or re-opens an existing session. Without this, `session_start` would
 * reset the derived title and the next prompt would rename the record away
 * from the conversation's original title (Bugbot on PR #608). A brand-new
 * session has no user entries yet, so this returns null and the first prompt
 * supplied via `before_agent_start` takes over.
 */
function firstUserPromptFromSession(ctx: unknown): string | null {
  const entries = (ctx as PiEventContextLike | undefined)?.sessionManager?.getEntries?.();
  if (!Array.isArray(entries)) {
    return null;
  }
  for (const raw of entries) {
    const entry = raw as PiEntryLike;
    if (entry?.type === 'message' && entry.message?.role === 'user') {
      const text = textOfContent(entry.message.content).trim();
      if (text) {
        return text;
      }
    }
  }
  return null;
}

function sessionIdOf(ctx: unknown): string {
  const manager = (ctx as PiEventContextLike | undefined)?.sessionManager;
  const id = manager?.getSessionFile?.() ?? manager?.getSessionId?.();
  return typeof id === 'string' && id ? id : 'pi';
}

/** The user's explicit session name, trimmed, or null (`/name`, `--name`,
 *  `pi.setSessionName()`). Never throws into pi's event loop. */
function readSessionName(pi: PiExtensionApiLike): string | null {
  try {
    const name = pi.getSessionName?.();
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

export default function piConversationArchiver(pi: PiExtensionApiLike): void {
  let turns = 0;
  let firstPrompt: string | null = null;

  const report = (ctx: unknown, event: string, body: string, overrideTitle?: string): void => {
    try {
      const title = overrideTitle ?? resolveTitle(readSessionName(pi), firstPrompt);
      emitNotification(SOURCE, sessionIdOf(ctx), event, title, body, tmuxContext());
    } catch {
      // never disrupt the session
    }
  };

  pi.on('session_start', (event, ctx) => {
    turns = 0;
    const reason = (event as { reason?: string } | undefined)?.reason;
    if (reason === 'new') {
      // `/new` starts a FRESH, nameless conversation and pi emits NO
      // session_info_changed for it, so nothing would clear the previous
      // conversation's title — the managed record + tab would keep it. Report
      // the working directory's basename (the record's natural default label)
      // as a normal rename so the app reverts both, no app change needed. A
      // session name still wins if the new session somehow carries one; with
      // neither, the placeholder is reported and the app leaves the name as
      // the user set it.
      firstPrompt = null;
      report(
        ctx,
        'SessionStarted',
        'Session started',
        readSessionName(pi) ??
          cwdBasename((ctx as PiEventContextLike | undefined)?.cwd) ??
          undefined,
      );
      return;
    }
    // Resume/fork/re-open/reload: recover the conversation's original first
    // prompt from the existing history so the derived title is not replaced by
    // the next prompt. Startup sessions have no user entries yet.
    firstPrompt = firstUserPromptFromSession(ctx);
    report(ctx, 'SessionStarted', reason === 'resume' ? 'Session resumed' : 'Session started');
  });

  pi.on('before_agent_start', (event, ctx) => {
    const prompt = (event as { prompt?: unknown } | undefined)?.prompt;
    if (!firstPrompt && typeof prompt === 'string' && prompt) {
      firstPrompt = prompt;
    }
    turns += 1;
    report(ctx, 'TurnStarted', `Turn ${turns} started`);
  });

  pi.on('agent_settled', (_event, ctx) => {
    const unit = turns === 1 ? 'turn' : 'turns';
    report(ctx, 'TurnComplete', `Turn complete · ${turns} ${unit}`);
  });

  pi.on('session_info_changed', (event, ctx) => {
    const name = (event as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || !name.trim()) {
      return;
    }
    // A rename is always reported with the new name itself — no placeholder
    // substitution, and no read-back race with pi.getSessionName().
    report(ctx, 'TitleChanged', 'Session renamed', name.trim());
  });

  pi.on('session_shutdown', (_event, ctx) => {
    report(ctx, 'SessionEnded', 'Session ended');
  });
}
