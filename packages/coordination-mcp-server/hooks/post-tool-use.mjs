#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook for WorkingTogether — releases the claim the
 * PreToolUse hook took for this file, so the region frees up immediately after
 * the edit (instead of waiting for the lease TTL). Releases by repo+actor+path,
 * so there is no client-side claim state to keep in sync.
 *
 * Wire up in .claude/settings.json (PostToolUse, matcher "Edit|Write|MultiEdit").
 * Never blocks (the tool already ran). Env mirrors the pre hook.
 */
import os from "node:os";
import path from "node:path";

const SERVER = process.env.WT_SERVER_URL || "http://localhost:4100";
const ACTOR = process.env.WT_ACTOR_ID || os.hostname();
const REPO = process.env.WT_REPO || path.basename(process.cwd());
const TOKEN = process.env.WT_TOKEN;

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

async function main() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    process.exit(0);
  }
  const filePath = input?.tool_input?.file_path;
  if (!filePath) process.exit(0);

  const rel = path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath;
  const posixRel = rel.split(path.sep).join("/");

  try {
    await fetch(`${SERVER}/v1/release_by_region`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: JSON.stringify({ repo: REPO, actorId: ACTOR, path: posixRel }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    /* best effort; the lease TTL will reclaim it anyway */
  }
  process.exit(0);
}

main();
