# pi-conversation-archiver

A [pi](https://pi.dev) package that reports the pi session's **execution
status** and **title** to [GenTerminal](https://genterminal.ai) over OSC 9999
(`genterm-notify`) — the pi counterpart of
[cc-conversation-archiver](https://github.com/genspark-ai/cc-conversation-archiver)
(Claude Code), [opencode-conversation-archiver](https://github.com/genspark-ai/opencode-conversation-archiver)
(opencode / GenCode) and [codex-conversation-archiver](https://github.com/genspark-ai/codex-conversation-archiver).

This directory is the package root, published as
[genspark-ai/pi-conversation-archiver](https://github.com/genspark-ai/pi-conversation-archiver)
(the tmux-session bootstrap installs it with
`pi install git:github.com/genspark-ai/pi-conversation-archiver`) — this tree
is the origin copy; keep the two in sync when touching the package:

```
package.json                          pi package manifest (`pi.extensions`)
extensions/conversation-archiver.ts   event wiring (the extension pi loads)
extensions/archiver.ts                title resolution + OSC 9999 emitter (plain Node, no pi import)
tests/selftest.mjs                    Node selftest (also run from CI via the Jest wrapper in the terminal repo)
```

## What it reports

Every handled event pushes at most ONE notification
`{v, magic:"genterm-notify", source:"pi-conversation-archiver",
sourceId:<session file>, event, title, body, tmux}`:

| pi event              | `body`                      | Notes |
|-----------------------|-----------------------------|-------|
| `session_start`       | `Session started` / `Session resumed` | reason `resume` says resumed; reason `new` (`/new`) titles the fresh conversation with the working directory's basename, reverting the previous title |
| `before_agent_start`  | `Turn N started`            | counts turns per session; carries the first-prompt title |
| `agent_settled`       | `Turn complete · N turns`   | fired once the run can no longer continue (retry / compaction / queued follow-ups done) |
| `session_info_changed`| `Session renamed`           | carries the new name (a `/name` rename) |
| `session_shutdown`    | `Session ended`             | |

## Title resolution (same order as pi's own session picker)

1. the user's explicit session name (`/name`, `--name`,
   `pi.setSessionName()`) — the rename, highest priority;
2. the **first real user prompt** — pi's fallback title when no name is set:
   control wrappers stripped (`<environment_context>`, `<user_instructions>`,
   …), first non-empty line, 120-char cap;
3. the fixed placeholder **`Pi`** — GenTerminal filters placeholder titles, so
   a fresh session never clobbers the user's chosen record name.

On `/new` (a fresh, nameless conversation) pi emits no `session_info_changed`,
so the previously reported title would otherwise stick on the record forever.
The plugin therefore reports the **working directory's basename** on
`session_start` with reason `new` — a normal title the app renames to, without
any app-side change or stored baseline. `startup` keeps the placeholder, so a
record the user named by hand is untouched on first launch.

GenTerminal's sidebar Sessions section joins on
`payload.tmux.session == record.tmux_name` (consent: the record was created
with "Launch Pi") and renames the record + its live tab to the reported title;
every report also lights the unread dot and refreshes last-activity sorting
when the tab is in the background.

## Properties

- **Never blocks the agent** and never throws: every handler is wrapped,
  emission is best-effort, and a missing tty / wedged tmux degrades to
  silence.
- **No runtime dependencies** — plain Node built-ins (`node:child_process`,
  `node:fs`). The extension does not import
  `@earendil-works/pi-coding-agent`, so a bare `git:` install needs no
  `npm install`.
- **tmux-aware**: the OSC rides tmux's DCS passthrough (`allow-passthrough`
  enabled pane-scoped), so it reaches the client in the panes GenTerminal
  manages.

## Testing

```
node plugins/pi-conversation-archiver/tests/selftest.mjs
```

Covers title resolution, the OSC 9999 wire contract (base64 + magic + tmux
wrap), and the event wiring driven through a fake pi API. The terminal repo
runs the same selftest from Jest
(`plugins/pi-conversation-archiver/__tests__/piArchiverPlugin.test.ts`).
