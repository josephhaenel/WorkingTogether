/**
 * `hive init` — one-command onboarding. Saves .hive/config.json, wires the pre/post
 * hooks into .claude/settings.json (calling this CLI, so no script paths to
 * manage), and makes sure the token-bearing config never gets committed.
 *
 * Flags (all optional; prompts fill the rest when run interactively):
 *   --server <url> --token <t> --repo <id> --actor <id> --relay <wss-url>
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, CONFIG_PATH, type WtConfig } from "./config.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function ask(rl: readline.Interface | null, question: string, def: string): Promise<string> {
  if (!rl) return def;
  const a = (await rl.question(`${question}${def ? ` [${def}]` : ""}: `)).trim();
  return a || def;
}

function deriveRelay(serverUrl: string): string {
  try {
    const u = new URL(serverUrl);
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}/sync`;
  } catch {
    return serverUrl.replace(/^http/, "ws") + "/sync";
  }
}

/** Absolute path to this CLI's entry, so settings.json works regardless of PATH. */
function cliEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "index.js");
}

function wireHooks(): void {
  const settingsPath = path.join(process.cwd(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    /* new file */
  }
  const entry = cliEntry();
  const hooks = (settings.hooks as Record<string, unknown[]>) ?? {};
  for (const [event, sub] of [["PreToolUse", "pre"], ["PostToolUse", "post"]] as const) {
    const list = (hooks[event] as Array<{ hooks?: Array<{ command?: string }> }>) ?? [];
    const already = list.some((g) => g.hooks?.some((h) => h.command?.includes(`hook ${sub}`)));
    if (!already) {
      list.push({
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: `node "${entry}" hook ${sub}` }],
      } as never);
    }
    hooks[event] = list as never;
  }
  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

/** Keep token-bearing files out of git. */
function protectFromGit(patterns: string[]): void {
  const gi = path.join(process.cwd(), ".gitignore");
  let body = "";
  try {
    body = fs.readFileSync(gi, "utf8");
  } catch {
    /* none */
  }
  const present = new Set(body.split(/\r?\n/).map((l) => l.trim()));
  const missing = patterns.filter((p) => !present.has(p));
  if (missing.length) {
    fs.writeFileSync(gi, (body && !body.endsWith("\n") ? body + "\n" : body) + missing.join("\n") + "\n");
  }
}

/** Register the coordination MCP server so the agent gets the hive_* tools natively. */
function writeMcpJson(cfg: WtConfig): void {
  const p = path.join(process.cwd(), ".mcp.json");
  let json: { mcpServers?: Record<string, unknown> } = {};
  try {
    json = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    /* new file */
  }
  json.mcpServers = json.mcpServers ?? {};
  json.mcpServers.hivemind = {
    type: "http",
    url: `${cfg.serverUrl.replace(/\/$/, "")}/mcp`,
    headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
  };
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + "\n");
}

const CLAUDE_MD_START = "<!-- hivemind:start -->";
const CLAUDE_MD_END = "<!-- hivemind:end -->";

/** Drop guidance so the agent actively uses the shared brain. Idempotent. */
function writeClaudeMd(): void {
  const p = path.join(process.cwd(), "CLAUDE.md");
  let body = "";
  try {
    body = fs.readFileSync(p, "utf8");
  } catch {
    /* new file */
  }
  if (body.includes(CLAUDE_MD_START)) return; // already wired
  const section = `${CLAUDE_MD_START}
## Working together (real-time multiplayer)

You are sharing this repository with other people and their AI agents at the same time. Coordinate through the Hivemind tools so you never silently overwrite someone else's work:

- **Before editing**, check who else is active: \`hive who\` (or the \`hive_whos_editing\` MCP tool). If another agent holds the file you need, work on something else and come back.
- **When you claim a file to edit, its relevant decisions are surfaced to you automatically** (repo + file + symbol scope) — read them and honor them; they're constraints/conventions teammates established. To pull the full list any time: \`hive decisions --path <file>\` (or \`hive_get_decisions\`).
- **Have a question about how this team does something?** Ask the shared brain: \`hive ask "what's our X convention?"\` (or \`hive_ask\`) before inventing an answer.
- **When you make a notable choice** (a convention, constraint, interface contract, or non-obvious rationale), record it so others' agents pick it up: \`hive decide "<short title>" --path <file>\` (or \`hive_post_decision\`). To see which of your recent edits still need a decision, run \`hive capture\`.
- Your \`Edit\`/\`Write\` calls are auto-claimed by a hook. If one is **denied** because another agent holds the file, switch tasks and retry shortly rather than forcing it.
${CLAUDE_MD_END}
`;
  fs.writeFileSync(p, body && !body.endsWith("\n") ? body + "\n\n" + section : body + section);
}

export async function init(): Promise<void> {
  const existing = loadConfig();
  const interactive = process.stdin.isTTY && !flag("server");
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;

  const serverUrl = flag("server") ?? (await ask(rl, "Coordination server URL", existing.serverUrl));
  const token = flag("token") ?? (await ask(rl, "Shared token (blank for none)", existing.token ?? ""));
  const repo = flag("repo") ?? (await ask(rl, "Repo id (same for everyone on this repo)", existing.repo));
  const actor = flag("actor") ?? (await ask(rl, "Your actor id (unique per person)", existing.actor));
  const relayUrl = flag("relay") ?? deriveRelay(serverUrl);
  rl?.close();

  const cfg: WtConfig = { serverUrl, relayUrl, token: token || undefined, repo, actor };
  saveConfig(cfg);
  protectFromGit([".hive/", ".wt/", ".mcp.json"]);
  wireHooks();
  writeMcpJson(cfg);
  writeClaudeMd();

  console.log(`\n✓ wrote ${path.relative(process.cwd(), CONFIG_PATH)} (gitignored)`);
  console.log(`✓ wired PreToolUse/PostToolUse hooks into .claude/settings.json`);
  console.log(`✓ registered the coordination MCP server in .mcp.json (gitignored)`);
  console.log(`✓ added a "Working together" section to CLAUDE.md`);
  console.log(`\n  server : ${serverUrl}`);
  console.log(`  relay  : ${relayUrl}`);
  console.log(`  repo   : ${repo}`);
  console.log(`  actor  : ${actor}`);
  console.log(`\nNext:  hive up      # start syncing this folder`);
  console.log(`       hive status  # see who's editing`);
}
