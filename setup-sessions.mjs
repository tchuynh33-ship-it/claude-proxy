// One-shot setup: create CLAUDE.md per project, register sessions in proxy.js,
// and add agent + binding entries to openclaw.json for each Telegram group.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const OPENCLAW_JSON = path.join(HOME, ".openclaw", "openclaw.json");
const PROJECTS_ROOT = path.join(HOME, ".openclaw", "projects");
const PROXY_JS = path.join(HOME, "claude-proxy", "proxy.js");

// session-name -> { id, label, prompt }
const GROUPS = {
  "barreleyes":      { id: "-5264876159", label: "Barreleyes" },
  "viet-translator": { id: "-5240659291", label: "Vietnamese Translator" },
  "poe2":            { id: "-5155161884", label: "PoE2 Tools" },
  "content":         { id: "-5139660958", label: "Content / Social Media" },
  "devtools":        { id: "-5062314150", label: "Dev Tools" },
  "ai-data":         { id: "-5139478246", label: "AI + Data" },
  "barreleyes-1":    { id: "-5111055593", label: "Barreleyes-1" },
  "roboflow":        { id: "-5204115216", label: "RoboFlow" },
  "shopping":        { id: "-5103944255", label: "Shopping" },
  "misc-web":        { id: "-5189376445", label: "Miscellaneous (web)" },
  "woodworking":     { id: "-5201959106", label: "Woodworking" },
  "fixmyform":       { id: "-5151938837", label: "FixMyFormAI" },
};

// Read existing systemPrompts from openclaw.json
const cfg = JSON.parse(fs.readFileSync(OPENCLAW_JSON, "utf8"));
const tgGroups = cfg.channels?.telegram?.groups || {};

const COMMON_HEADER = `# {{LABEL}} — OpenClaw Telegram Group

You are the assistant in Tam's **{{LABEL}}** Telegram group.

## Who you're talking to

- **Name:** Tam
- **What to call them:** Tam
- **Timezone:** America/New_York (EST)
- **Notes:** 38yo data scientist, working on side projects. Prefers direct, useful responses over filler.

## Style (Telegram)

- Be genuinely helpful, not performatively helpful. Skip "Great question!" and "I'd be happy to help!" — just help.
- Have opinions. Disagree when it makes sense.
- Be resourceful before asking.
- No markdown tables on Telegram — use bullet lists.
- No headers on Telegram — use **bold** or CAPS for emphasis.
- Don't send half-baked replies.

## Safety

- Don't exfiltrate private data.
- Don't run destructive commands without asking.
- When in doubt, ask before acting externally.

## Group-specific context

`;

// 1. Create project dirs and CLAUDE.md
let created = 0;
for (const [session, meta] of Object.entries(GROUPS)) {
  const dir = path.join(PROJECTS_ROOT, `openclaw-${session}`);
  fs.mkdirSync(dir, { recursive: true });
  const claudeMd = path.join(dir, "CLAUDE.md");
  if (fs.existsSync(claudeMd)) {
    console.log(`SKIP CLAUDE.md (exists): ${claudeMd}`);
  } else {
    const groupPrompt = (tgGroups[meta.id]?.systemPrompt || "(no prior systemPrompt)").replace(/â€¢/g, "•").replace(/â€”/g, "—");
    const content = COMMON_HEADER.replace(/\{\{LABEL\}\}/g, meta.label) + groupPrompt + "\n";
    fs.writeFileSync(claudeMd, content);
    console.log(`WROTE: ${claudeMd}`);
    created++;
  }
}

// 2. Update proxy.js SESSION_PROJECTS
let proxy = fs.readFileSync(PROXY_JS, "utf8");
const sessionLines = Object.keys(GROUPS).map(s => `  "${s}": path.join(PROJECTS_ROOT, "openclaw-${s}"),`).join("\n");
const newBlock = `const SESSION_PROJECTS = {
  main: path.join(PROJECTS_ROOT, "openclaw-main"),
  misc: path.join(PROJECTS_ROOT, "openclaw-misc"),
${sessionLines}
};`;
const oldBlockRegex = /const SESSION_PROJECTS = \{[\s\S]*?\};/;
if (oldBlockRegex.test(proxy)) {
  proxy = proxy.replace(oldBlockRegex, newBlock);
  fs.writeFileSync(PROXY_JS, proxy);
  console.log(`UPDATED: ${PROXY_JS} SESSION_PROJECTS`);
} else {
  console.log(`WARN: Could not find SESSION_PROJECTS block in proxy.js`);
}

// 3. Update openclaw.json — add agents + bindings
const existingAgents = new Set((cfg.agents?.list || []).map(a => a.id));
const existingBindings = new Set((cfg.bindings || []).map(b => b.match?.peer?.id));
cfg.agents = cfg.agents || {};
cfg.agents.list = cfg.agents.list || [];
cfg.bindings = cfg.bindings || [];

let addedAgents = 0;
let addedBindings = 0;

for (const [session, meta] of Object.entries(GROUPS)) {
  if (!existingAgents.has(session)) {
    cfg.agents.list.push({
      id: session,
      model: {
        primary: `anthropic/claude-sonnet-4-6@${session}`,
        fallbacks: ["anthropic/claude-sonnet-4-6"],
      },
    });
    addedAgents++;
  }
  if (!existingBindings.has(meta.id)) {
    cfg.bindings.push({
      type: "route",
      agentId: session,
      comment: `${meta.label} Telegram group -> per-project session via claude -r ${session}`,
      match: {
        channel: "telegram",
        peer: { kind: "group", id: meta.id },
      },
    });
    addedBindings++;
  }
}

fs.writeFileSync(OPENCLAW_JSON, JSON.stringify(cfg, null, 2));

console.log(`\nSUMMARY:`);
console.log(`  CLAUDE.md created: ${created}`);
console.log(`  Agents added: ${addedAgents}`);
console.log(`  Bindings added: ${addedBindings}`);
