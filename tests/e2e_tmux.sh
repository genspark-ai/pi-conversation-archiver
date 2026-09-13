#!/usr/bin/env bash
# Manual smoke test for the pi conversation-archiver's real-tmux path: run the
# REAL pi CLI inside a REAL tmux pane (with the package installed) and capture
# what an attached client receives. The extension writes the OSC 9999 sequence
# wrapped in tmux's DCS passthrough envelope (ESC doubled inside) because tmux
# would otherwise drop the unknown sequence; tmux then UNWRAPS the envelope and
# forwards the inner OSC 9999 to the attached client — what a GenTerminal tab's
# xterm parser sees. Pins both ends of that chain with the real agent.
#
# A local mock OpenAI-compatible server stands in for a provider (no API key
# needed) so the run exercises the full event path: session start, the turn
# (first-prompt title), settle and shutdown.
#
# ISOLATION: everything runs on a PRIVATE tmux socket (-L) — its own server
# process, its own socket under /tmp/tmux-$(id -u)/. The default tmux server
# (which on dev machines holds real work sessions) is never contacted, and the
# cleanup kill-server only ever sees this test's own server.
#
# Requires tmux + script(1) + python3 + a pi install. Run:
#   PI_BIN=/path/to/pi bash plugins/pi-conversation-archiver/tests/e2e_tmux.sh
set -euo pipefail

PI_BIN="${PI_BIN:-pi}"
PORT="${PI_MOCK_PORT:-8791}"
WORK="$(mktemp -d /tmp/pi-archiver-e2e-XXXX)"
SESSION="gt-pi-e2e-$$"
SOCKET="pi-archiver-e2e-$$"
tmux() { command tmux -L "$SOCKET" "$@"; }
MOCK_PID=""
cleanup() {
  tmux kill-server 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Isolated pi config dir; install the package under test into it, then add a
# mock provider extension + server so the agent loop can complete offline.
export PI_CODING_AGENT_DIR="$WORK/home"
mkdir -p "$PI_CODING_AGENT_DIR/extensions"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
"$PI_BIN" install "$REPO_ROOT/plugins/pi-conversation-archiver" >/dev/null

cat > "$PI_CODING_AGENT_DIR/extensions/mock-provider.ts" <<EOF
export default function (pi) {
  pi.registerProvider('mock', {
    baseUrl: 'http://127.0.0.1:$PORT/v1',
    apiKey: 'mock',
    api: 'openai-completions',
    models: [{
      id: 'mock-1', name: 'Mock', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096,
    }],
  });
}
EOF

python3 - "$PORT" <<'PYEOF' &
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "mock-1", "object": "model"}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        base = {"id": "c1", "object": "chat.completion.chunk", "created": 0, "model": "mock-1"}
        for delta, finish in [({"role": "assistant", "content": "ok"}, None), ({}, "stop")]:
            self.wfile.write(("data: " + json.dumps({**base, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n").encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PYEOF
MOCK_PID=$!
sleep 1

# 1. Detached session on the PRIVATE socket, running the REAL pi CLI with a
#    prompt. The pane WAITS first: tmux drops passthrough written while no
#    client is attached, so the client (step 2) must already be receiving.
tmux new-session -d -s "$SESSION" \
  "sleep 3; cd '$PI_CODING_AGENT_DIR'; PI_CODING_AGENT_DIR='$PI_CODING_AGENT_DIR' '$PI_BIN' --provider mock --model mock-1 -p 'Fix the login bug' >/dev/null 2>&1 || true; sleep 6"

# 2. Attach through a pty (script(1)) with the client's stdout piped to a file
#    — tmux attach refuses to run without a terminal, and the forwarded
#    sequence must land in the CLIENT's output (what a GenTerminal tab holds).
script -q -e -c "command tmux -L '$SOCKET' attach-session -t '$SESSION'" /dev/null > "$WORK/client.out" 2>/dev/null &
CLIENT=$!
wait "$CLIENT" 2>/dev/null || true
tmux kill-server 2>/dev/null || true

# 3. Decode from the raw client bytes. tmux unwraps the DCS passthrough, so the
#    client stream carries the inner OSC 9999 directly.
python3 - "$WORK/client.out" "$SESSION" <<'PYEOF'
import base64, json, re, sys

raw = open(sys.argv[1], "rb").read().decode("utf-8", errors="replace")
session = sys.argv[2]

seen = [json.loads(base64.b64decode(m.group(1)))
        for m in re.finditer(r"\033\]9999;([A-Za-z0-9+/=]+)\033\\", raw)]

assert seen, "no OSC 9999 sequence in the attached client's output:\n" + repr(raw[:600])
for payload in seen:
    assert payload["magic"] == "genterm-notify", payload
    assert payload["source"] == "pi-conversation-archiver", payload
    assert (payload.get("tmux") or {}).get("session") == session, payload

got = {(p["event"], p["title"], p["body"]) for p in seen}
expected = {
    ("SessionStarted", "Pi", "Session started"),
    ("TurnStarted", "Fix the login bug", "Turn 1 started"),
    ("TurnComplete", "Fix the login bug", "Turn complete · 1 turn"),
    ("SessionEnded", "Fix the login bug", "Session ended"),
}
missing = expected - got
assert not missing, f"missing notifications: {missing}\ngot: {got}"

print("e2e ok: OSC 9999 survived the tmux passthrough from the REAL pi CLI")
for e, t, b in sorted(got):
    print(f"  {t!r} — {b!r} ({e})")
print("  tmux session: " + session)
PYEOF
