# Claude Proxy — Project Rules

## Who you're talking to

- **Name:** Tam
- **Timezone:** America/New_York (EST)
- **Notes:** 38yo data scientist, working on side projects. Prefers direct, useful responses over filler.

## Style

- Be genuinely helpful, not performatively helpful. Skip "Great question!" and "I'd be happy to help!" — just help.
- Have opinions. Disagree when it makes sense.
- Be resourceful before asking.
- Don't send half-baked replies.
- Don't use acronyms — spell out the full term (write "developer experience", not "DX").
- No markdown tables — use bullet lists.
- No headers — use **bold** or CAPS for emphasis.

## Safety

- Don't exfiltrate private data.
- Don't run destructive commands without asking.
- Prioritize action over planning, but do no harm.

## Credentials

API keys, tokens, and secrets live in `~/.env`.

## What this repo is

`claude-proxy` is the local Anthropic API proxy that fronts every OpenClaw Telegram agent. Read `proxy.js` for the request flow, `~/.openclaw/openclaw.json` for the agent/binding config (gitignored junction at `.openclaw/`).

What lives where:
- **`proxy.js`** — main proxy server. Spawns `claude -p` per request. Streaming + idle/absolute timeouts. SESSION_PROJECTS map.
- **`logs/proxy-stdout.log`** — proxy startup + per-request log. `tail -f` to watch live.
- **`logs/requests.jsonl`** — structured per-request log (ts, session, durationMs, status, prompt). Use this to diagnose timeout/error patterns.
- **`.openclaw/openclaw.json`** — junction to `~/.openclaw/openclaw.json`. Holds agent IDs, model routing, Telegram bindings.
- **`.openclaw/projects/`** — junction to `~/.openclaw/projects/`. One dir per Telegram group with its routing CLAUDE.md.
- **`.openclaw/projects/_telegram_base.md`** — shared base imported by every group's routing.

## Long tasks — confirm first

Before doing any multi-step work (DB writes, registering agents, regex-rewriting configs, restarting services, anything that involves more than 1-2 tool calls), send a 1-line confirmation FIRST:

> "Starting X — will update when done."

Then continue with the work in the same turn.

**Hard rule: if you find yourself polling, sleeping, or waiting for an external service in the same turn that started the work, STOP. End the turn.**

### Proxy timeouts

- **Idle timeout: 120 seconds.** Resets every time you emit anything. If you go silent for 2 min, you get killed.
- **Absolute cap: 30 minutes.** Hard ceiling regardless of activity.

For long work, run with `run_in_background: true` and end the turn.

## Don't kill all node processes

Never `taskkill /F /IM node.exe` — the proxy and gateway both run as node. Always kill by PID: get it with `tasklist /V`, confirm it's the right process, then `taskkill /F /PID <pid>`.

## Restart procedures (touch with care)

- **Proxy:** `Stop-Process -Id <pid>; nohup node ~/claude-proxy/proxy.js > ~/claude-proxy/logs/proxy-stdout.log 2>&1 &`. Find PID via `netstat -ano | grep :9182`.
- **OpenClaw gateway:** `Stop-Process -Id <pid>; openclaw gateway start`. Port 18789. Wait 5-7s before health-checking; scheduled task takes a moment to bring it back.
- **Both:** ALWAYS confirm restart success (port listening + curl /health) before reporting done.

## Don't restart blindly

Editing `proxy.js` requires a proxy restart to pick up changes. Editing `~/.openclaw/openclaw.json` requires a gateway restart. Editing CLAUDE.md / CLAUDE.local.md does NOT require any restart — Claude Code re-reads them per session.
