#!/usr/bin/env node
/**
 * Local Anthropic API proxy that routes requests through `claude -p`
 * This uses your Claude subscription instead of API credits.
 * Supports real-time streaming via claude's stream-json output.
 */

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = process.env.PROXY_PORT || 9182;
const MAX_PROMPT_CHARS = 80000;
const CLAUDE_TIMEOUT_MS = 180000; // 3 min timeout
const MAX_CONCURRENT = 3;
const PROJECTS_ROOT = path.join(os.homedir(), ".openclaw", "projects");
const OPENCLAW_JSON = path.join(os.homedir(), ".openclaw", "openclaw.json");

// Map of session-name -> project directory.
// Session is selected per-request from the OpenClaw peer ID embedded in the
// user message metadata blob (OpenClaw strips the model `@suffix` upstream,
// so we can't rely on that). DM/dashboard requests default to "main".
const SESSION_PROJECTS = {
  main: path.join(PROJECTS_ROOT, "openclaw-main"),
  misc: path.join(PROJECTS_ROOT, "openclaw-misc"),
  "barreleyes": path.join(PROJECTS_ROOT, "openclaw-barreleyes"),
  "viet-translator": path.join(PROJECTS_ROOT, "openclaw-viet-translator"),
  "poe2": path.join(PROJECTS_ROOT, "openclaw-poe2"),
  "content": path.join(PROJECTS_ROOT, "openclaw-content"),
  "devtools": path.join(PROJECTS_ROOT, "openclaw-devtools"),
  "ai-data": path.join(PROJECTS_ROOT, "openclaw-ai-data"),
  "barreleyes-1": path.join(PROJECTS_ROOT, "openclaw-barreleyes-1"),
  "roboflow": path.join(PROJECTS_ROOT, "openclaw-roboflow"),
  "shopping": path.join(PROJECTS_ROOT, "openclaw-shopping"),
  "misc-web": path.join(PROJECTS_ROOT, "openclaw-misc-web"),
  "woodworking": path.join(PROJECTS_ROOT, "openclaw-woodworking"),
  "fixmyform": path.join(PROJECTS_ROOT, "openclaw-fixmyform"),
};

// --- Structured file logging ---
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "requests.jsonl");
const MAX_LOG_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB, rotate after this

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function rotateLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_LOG_SIZE) {
      const rotated = LOG_FILE.replace(".jsonl", `.${Date.now()}.jsonl`);
      fs.renameSync(LOG_FILE, rotated);
    }
  } catch {}
}

function logRequest(entry) {
  rotateLogIfNeeded();
  fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
}

let requestCounter = 0;

// Remove API keys so child processes use subscription
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_BASE_URL;

const childEnv = { ...process.env };
childEnv.ANTHROPIC_API_KEY = "";
childEnv.ANTHROPIC_AUTH_TOKEN = "";
childEnv.ANTHROPIC_BASE_URL = "";

const claudePath = path.join(os.homedir(), ".local", "bin", "claude.exe");

// Concurrency queue
let activeCount = 0;
const queue = [];

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeCount++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeCount--;
          if (queue.length > 0) queue.shift()();
        });
    };
    if (activeCount < MAX_CONCURRENT) {
      run();
    } else {
      queue.push(run);
    }
  });
}

// Extract prompt from Anthropic Messages API format
function extractPrompt(body) {
  const messages = body.messages || [];
  const systemParts = [];

  if (body.system) {
    if (typeof body.system === "string") {
      systemParts.push(body.system);
    } else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block.type === "text") systemParts.push(block.text);
      }
    }
  }

  const parts = [];
  if (systemParts.length > 0) {
    parts.push(`<system>\n${systemParts.join("\n")}\n</system>`);
  }

  for (const msg of messages) {
    const role = msg.role;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
    parts.push(`<${role}>\n${text}\n</${role}>`);
  }

  let prompt = parts.join("\n\n");

  if (prompt.length > MAX_PROMPT_CHARS) {
    console.log(`[proxy] Truncating prompt from ${prompt.length} to ${MAX_PROMPT_CHARS} chars`);
    const systemEnd = prompt.indexOf("</system>");
    if (systemEnd > 0) {
      const system = prompt.substring(0, systemEnd + 9);
      const rest = prompt.substring(systemEnd + 9);
      const keep = MAX_PROMPT_CHARS - system.length;
      prompt = system + "\n\n[...earlier context truncated...]\n\n" + rest.slice(-keep);
    } else {
      prompt = prompt.slice(-MAX_PROMPT_CHARS);
    }
  }

  return prompt;
}

function resolveModelAlias(modelId) {
  if (!modelId) return "sonnet";
  // Strip the @session suffix before alias resolution.
  const base = modelId.split("@")[0];
  const lower = base.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("haiku")) return "haiku";
  return "sonnet";
}

// Build peerId -> sessionName map from openclaw.json bindings (read once at startup).
// Reload on SIGHUP if you ever need it.
function loadPeerSessionMap() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_JSON, "utf8"));
    const map = {};
    for (const b of cfg.bindings || []) {
      const peerId = b.match?.peer?.id;
      const agentId = b.agentId;
      if (peerId && agentId && SESSION_PROJECTS[agentId]) {
        map[peerId] = agentId;
      }
    }
    return map;
  } catch (e) {
    console.error(`[proxy] Could not load openclaw.json bindings: ${e.message}`);
    return {};
  }
}

let PEER_SESSION_MAP = loadPeerSessionMap();
console.log(`[proxy] Loaded ${Object.keys(PEER_SESSION_MAP).length} peer->session bindings`);

// Extract OpenClaw peer ID and is_group_chat from the latest user message metadata.
// OpenClaw embeds a JSON block at the start of each user message like:
//   "conversation_label": "Woodworking id:-5201959106",
//   "is_group_chat": true
function extractPeerInfo(body) {
  const msgs = body.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user") continue;
    const txt = typeof m.content === "string"
      ? m.content
      : (Array.isArray(m.content) ? m.content.filter(b => b.type === "text").map(b => b.text).join("\n") : "");
    const idMatch = txt.match(/"conversation_label"\s*:\s*"[^"]*id:(-?\d+)"/);
    const groupMatch = txt.match(/"is_group_chat"\s*:\s*(true|false)/);
    if (idMatch || groupMatch) {
      return {
        peerId: idMatch ? idMatch[1] : null,
        isGroupChat: groupMatch ? groupMatch[1] === "true" : null,
      };
    }
  }
  return { peerId: null, isGroupChat: null };
}

// Extract just the latest user message text from an Anthropic Messages request.
// Used in session mode — system prompt + history live in CLAUDE.md and the resumed session.
function extractLatestUserMessage(body) {
  const messages = body.messages || [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
    }
  }
  return "";
}

// Return true if this session has been initialized (has a flag file in its project dir).
function sessionInitialized(projectDir) {
  return fs.existsSync(path.join(projectDir, ".session-initialized"));
}

function markSessionInitialized(projectDir) {
  try {
    fs.writeFileSync(path.join(projectDir, ".session-initialized"), new Date().toISOString());
  } catch (e) {
    console.error(`[proxy] Could not mark session initialized for ${projectDir}: ${e.message}`);
  }
}

// Run claude -p with real-time streaming, piping SSE events back to the HTTP response.
// `opts` may include { extraArgs: string[], cwd: string, label: string }.
function runClaudeStreaming(prompt, model, res, reqId, startTime, opts = {}) {
  return enqueue(() => new Promise((resolve, reject) => {
    const alias = resolveModelAlias(model);
    const args = [
      "-p",
      "--model", alias,
      "--output-format", "stream-json",
      "--verbose",
      ...(opts.extraArgs || []),
    ];

    const msgId = `msg_proxy_${Date.now()}`;
    let totalOutput = 0;
    let headersSent = false;
    let finished = false;
    let killed = false;
    let buffer = "";
    let ttfbMs = null;
    let fullResponse = "";

    const label = opts.label || `--model ${alias}`;
    console.log(`[proxy] Spawning claude -p ${label} streaming (prompt=${prompt.length} chars, cwd=${opts.cwd || "default"}, active=${activeCount}, queued=${queue.length})`);

    const proc = spawn(claudePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: childEnv,
      windowsHide: true,
      cwd: opts.cwd,
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      if (!headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "Timeout" } }));
      } else {
        // Send error event and close
        sendSSE(res, "message_stop", { type: "message_stop" });
        res.end();
      }
      reject(new Error("timeout"));
    }, CLAUDE_TIMEOUT_MS);

    function sendSSE(res, event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    function sendHeaders() {
      if (headersSent) return;
      headersSent = true;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Send message_start
      sendSSE(res, "message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          content: [],
          model: model || "claude-sonnet-4-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 0 },
        },
      });

      // Send content_block_start
      sendSSE(res, "content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
    }

    function sendDelta(text) {
      if (!text) return;
      if (ttfbMs === null) ttfbMs = Date.now() - startTime;
      sendHeaders();
      totalOutput += text.length;
      fullResponse += text;
      sendSSE(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    }

    function finishStream() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (!headersSent) {
        // No output at all — send empty response
        sendHeaders();
      }

      sendSSE(res, "content_block_stop", { type: "content_block_stop", index: 0 });
      sendSSE(res, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: Math.ceil(totalOutput / 4) },
      });
      sendSSE(res, "message_stop", { type: "message_stop" });
      res.end();
      console.log(`[proxy] ${reqId} Stream complete (${totalOutput} chars, ttfb=${ttfbMs}ms, total=${Date.now() - startTime}ms)`);
      resolve({ totalOutput, ttfbMs, fullResponse });
    }

    // Process JSONL lines from claude's stream-json output
    function processLine(line) {
      if (!line.trim()) return;
      try {
        const obj = JSON.parse(line);

        // Handle different event types from claude stream-json
        if (obj.type === "content_block_delta" && obj.delta?.text) {
          sendDelta(obj.delta.text);
        } else if (obj.type === "assistant" && obj.message?.content) {
          // Full assistant message — extract text
          for (const block of obj.message.content) {
            if (block.type === "text") sendDelta(block.text);
          }
        } else if (obj.type === "result") {
          // Final result — if we haven't streamed anything yet, send the result text
          if (totalOutput === 0 && obj.result) {
            sendDelta(obj.result);
          }
        }
      } catch {
        // Not JSON — treat as plain text output
        if (line.trim() && totalOutput === 0) {
          sendDelta(line);
        }
      }
    }

    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      // Process complete lines
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete last line in buffer
      for (const line of lines) {
        processLine(line);
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (text.trim()) console.log(`[proxy] stderr: ${text.substring(0, 200)}`);
    });

    proc.on("close", (code) => {
      if (killed) return;
      // Process remaining buffer
      if (buffer.trim()) processLine(buffer);
      if (code !== 0 && !headersSent) {
        console.error(`[proxy] claude -p failed (code=${code})`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `claude exited ${code}` } }));
        reject(new Error(`exit ${code}`));
      } else {
        finishStream();
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[proxy] spawn error:`, err.message);
      if (!headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
      }
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  }));
}

// Run claude -p non-streaming (for non-stream requests).
// `opts` may include { extraArgs: string[], cwd: string, label: string }.
function runClaude(prompt, model, opts = {}) {
  return enqueue(() => new Promise((resolve, reject) => {
    const alias = resolveModelAlias(model);
    const args = ["-p", "--model", alias, ...(opts.extraArgs || [])];

    const label = opts.label || `--model ${alias}`;
    console.log(`[proxy] Spawning claude -p ${label} (prompt=${prompt.length} chars, cwd=${opts.cwd || "default"}, active=${activeCount}, queued=${queue.length})`);

    const proc = spawn(claudePath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: childEnv,
      windowsHide: true,
      cwd: opts.cwd,
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      reject(new Error("timeout"));
    }, CLAUDE_TIMEOUT_MS);

    proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0 && !stdout) {
        console.error(`[proxy] claude -p failed (code=${code}): ${stderr.substring(0, 200)}`);
        reject(new Error(`claude exited ${code}`));
      } else {
        console.log(`[proxy] claude -p success (${stdout.length} chars)`);
        resolve(stdout);
      }
    });

    proc.on("error", (err) => { clearTimeout(timer); reject(err); });

    proc.stdin.write(prompt);
    proc.stdin.end();
  }));
}

function buildResponse(text, model) {
  return {
    id: `msg_proxy_${Date.now()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: model || "claude-sonnet-4-5",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Math.ceil(text.length / 4),
      output_tokens: Math.ceil(text.length / 4),
    },
  };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", proxy: "claude-subscription-proxy", active: activeCount, queued: queue.length }));
    return;
  }

  // Recent request logs — last N entries
  if (req.url.startsWith("/logs")) {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 500);
    try {
      const raw = fs.readFileSync(LOG_FILE, "utf8").trim();
      const lines = raw ? raw.split("\n") : [];
      const recent = lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: recent.length, total: lines.length, entries: recent }));
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: 0, total: 0, entries: [] }));
    }
    return;
  }

  if (req.url === "/v1/messages" && req.method === "POST") {
    let rawBody = "";
    for await (const chunk of req) rawBody += chunk;

    let body;
    try { body = JSON.parse(rawBody); } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // DEBUG: dump full body + headers to find session identifier
    try {
      const dump = {
        ts: new Date().toISOString(),
        url: req.url,
        headers: req.headers,
        body: body,
      };
      fs.appendFileSync(path.join(LOG_DIR, "debug-full.jsonl"), JSON.stringify(dump) + "\n");
    } catch {}

    const model = body.model;
    const isStream = body.stream === true;
    const reqId = `req_${Date.now()}_${++requestCounter}`;
    const startTime = Date.now();
    const msgCount = (body.messages || []).length;
    const rawBodyLen = rawBody.length;

    // Determine session mode vs legacy mode based on peer ID in the embedded
    // OpenClaw metadata (model `@suffix` is stripped upstream so we can't use it).
    const { peerId, isGroupChat } = extractPeerInfo(body);
    let session = null;
    if (peerId && PEER_SESSION_MAP[peerId]) {
      session = PEER_SESSION_MAP[peerId];
    } else if (isGroupChat === false && SESSION_PROJECTS["main"]) {
      // 1:1 DMs (and dashboard) -> main session.
      session = "main";
    }

    let mode = "legacy";
    let prompt;
    let runOpts = {};
    if (session) {
      const projectDir = SESSION_PROJECTS[session];
      mode = "session";
      prompt = extractLatestUserMessage(body);
      const initialized = sessionInitialized(projectDir);
      const flag = initialized ? "-r" : "-n";
      runOpts = {
        extraArgs: [flag, session],
        cwd: projectDir,
        label: `${flag} ${session}`,
      };
      // Mark as initialized eagerly — even if this call fails, claude likely created the session.
      if (!initialized) markSessionInitialized(projectDir);
    } else {
      prompt = extractPrompt(body);
    }

    console.log(`[proxy] ${new Date().toISOString()} ${reqId} mode=${mode} model=${model} stream=${isStream} prompt_len=${prompt.length} raw_body=${rawBodyLen} msgs=${msgCount}`);

    if (isStream) {
      // Real-time streaming: pipe claude output directly as SSE
      try {
        const result = await runClaudeStreaming(prompt, model, res, reqId, startTime, runOpts);
        logRequest({
          ts: new Date().toISOString(),
          reqId,
          model,
          alias: resolveModelAlias(model),
          mode,
          session,
          stream: true,
          promptChars: prompt.length,
          rawBodyBytes: rawBodyLen,
          messageCount: msgCount,
          responseChars: result.totalOutput,
          ttfbMs: result.ttfbMs,
          durationMs: Date.now() - startTime,
          status: "ok",
          active: activeCount,
          queued: queue.length,
          prompt,
          response: result.fullResponse,
        });
      } catch (err) {
        console.error(`[proxy] Stream error: ${err.message}`);
        logRequest({
          ts: new Date().toISOString(),
          reqId,
          model,
          alias: resolveModelAlias(model),
          mode,
          session,
          stream: true,
          promptChars: prompt.length,
          rawBodyBytes: rawBodyLen,
          messageCount: msgCount,
          responseChars: 0,
          durationMs: Date.now() - startTime,
          status: "error",
          error: err.message,
          active: activeCount,
          queued: queue.length,
          prompt,
        });
        // Response may already be partially sent
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
        }
      }
    } else {
      try {
        const raw = await runClaude(prompt, model, runOpts);
        const text = raw.trim();
        if (!text) throw new Error("Empty response");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildResponse(text, model)));
        logRequest({
          ts: new Date().toISOString(),
          reqId,
          model,
          alias: resolveModelAlias(model),
          mode,
          session,
          stream: false,
          promptChars: prompt.length,
          rawBodyBytes: rawBodyLen,
          messageCount: msgCount,
          responseChars: text.length,
          durationMs: Date.now() - startTime,
          status: "ok",
          active: activeCount,
          queued: queue.length,
          prompt,
          response: text,
        });
      } catch (err) {
        console.error(`[proxy] Error: ${err.message}`);
        logRequest({
          ts: new Date().toISOString(),
          reqId,
          model,
          alias: resolveModelAlias(model),
          mode,
          session,
          stream: false,
          promptChars: prompt.length,
          rawBodyBytes: rawBodyLen,
          messageCount: msgCount,
          responseChars: 0,
          durationMs: Date.now() - startTime,
          status: "error",
          error: err.message,
          active: activeCount,
          queued: queue.length,
          prompt,
        });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: err.message } }));
      }
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", path: req.url }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[claude-proxy] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[claude-proxy] Real-time streaming enabled`);
  console.log(`[claude-proxy] Max concurrent: ${MAX_CONCURRENT}, timeout: ${CLAUDE_TIMEOUT_MS / 1000}s`);
  console.log(`[claude-proxy] Claude binary: ${claudePath}`);
  console.log(`[claude-proxy] Request log: ${LOG_FILE}`);
  console.log(`[claude-proxy] Log viewer: http://127.0.0.1:${PORT}/logs?limit=20`);
});
