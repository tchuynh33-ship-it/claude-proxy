# claude-proxy

Local proxy that routes Anthropic API calls through `claude -p` (pipe mode), so you can use your **Claude Max subscription** instead of paying for API credits or Extra Usage.

Built for [OpenClaw](https://github.com/openclaw/openclaw) but works with any Anthropic SDK client.

## How it works

```
Your App (OpenClaw, etc.)
    |
    | HTTP POST /v1/messages (standard Anthropic API format)
    v
claude-proxy (localhost:9182)
    |
    | spawns: claude -p --model sonnet --output-format stream-json
    v
Claude Code CLI (uses your Max subscription)
    |
    | streams response back as Anthropic SSE events
    v
Your App receives response
```

The proxy accepts standard Anthropic Messages API requests and translates them into `claude -p` subprocess calls. Since `claude -p` uses your Claude subscription directly, no API key or Extra Usage is needed.

## Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` command must work)
- Claude Max/Pro subscription (the whole point)
- Node.js 18+

Verify Claude CLI works with your subscription:
```bash
echo "hi" | claude -p --model sonnet
```

## Setup

### 1. Clone and start the proxy

```bash
git clone https://github.com/tchuynh33-ship-it/claude-proxy.git
cd claude-proxy
node proxy.js
```

The proxy starts on `http://127.0.0.1:9182`.

### 2. Point your app at the proxy

Set the `ANTHROPIC_BASE_URL` environment variable:

```bash
# Linux/macOS
export ANTHROPIC_BASE_URL=http://127.0.0.1:9182

# Windows (cmd)
set ANTHROPIC_BASE_URL=http://127.0.0.1:9182

# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:9182"
```

Any app using the Anthropic SDK will now route through the proxy.

### 3. Test it

```bash
curl -X POST http://127.0.0.1:9182/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-5","messages":[{"role":"user","content":"What is 2+2?"}],"max_tokens":100}'
```

## OpenClaw setup

Add this line to `~/.openclaw/gateway.cmd` (Windows) before the node command:

```cmd
set "ANTHROPIC_BASE_URL=http://127.0.0.1:9182"
```

Or on Linux/macOS, add to `~/.openclaw/gateway.sh`:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:9182
```

Then restart the daemon:

```bash
openclaw daemon restart
```

## Auto-start (Windows)

Create a file at `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\claude-proxy.vbs`:

```vbs
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\path\to\claude-proxy\proxy.js""", 0, False
```

## Auto-start (Linux/macOS)

Create a systemd service or add to your shell profile:

```bash
nohup node /path/to/claude-proxy/proxy.js > /tmp/claude-proxy.log 2>&1 &
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `9182` | Port the proxy listens on |

Constants in `proxy.js`:

| Setting | Default | Description |
|---------|---------|-------------|
| `MAX_PROMPT_CHARS` | `80000` | Truncate prompts longer than this |
| `CLAUDE_TIMEOUT_MS` | `180000` | Timeout per request (3 min) |
| `MAX_CONCURRENT` | `3` | Max concurrent `claude -p` processes |

## Features

- **Real-time streaming** -- pipes `claude -p --output-format stream-json` back as Anthropic SSE events
- **Concurrency queue** -- limits concurrent `claude` processes to avoid overload
- **Prompt truncation** -- caps very long prompts (keeps system prompt + recent messages)
- **Timeout handling** -- kills stuck processes after 3 minutes
- **Model mapping** -- maps model IDs to CLI aliases (opus, sonnet, haiku)

## Limitations

- **~1-2s extra latency** per request due to process spawn overhead
- **No tool use** -- tool call responses are not translated (text-only)
- **No image input** -- image content blocks are stripped (text-only extraction)
- **Single machine** -- runs on localhost only

## License

MIT
