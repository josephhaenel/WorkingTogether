#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for WorkingTogether.
 *
 * Claims the target file BEFORE an Edit/Write. If another AGENT holds it -> DENY
 * (the agent does other work / coordinates). If a human is involved -> ASK. The
 * PostToolUse hook releases the claim by repo+actor+path (no client-side state).
 * On any server error we fail OPEN (allow) so the coordination layer can never
 * hard-block editing if it's down.
 *
 * Wire up in .claude/settings.json (PreToolUse, matcher "Edit|Write|MultiEdit").
 *
 * Env: WT_SERVER_URL (default http://localhost:4100), WT_ACTOR_ID (default hostname),
 *      WT_REPO (default basename of cwd), WT_ORIGIN (default "agent").
 */
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const SERVER = process.env.WT_SERVER_URL || "http://localhost:4100";
const ACTOR = process.env.WT_ACTOR_ID || os.hostname();
const REPO = process.env.WT_REPO || path.basename(process.cwd());
const ORIGIN = process.env.WT_ORIGIN || "agent";
const TOKEN = process.env.WT_TOKEN;
const authHeaders = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

function decision(permission, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: permission, // "allow" | "deny" | "ask"
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

async function main() {
  let input;
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {
    decision("allow", "wt: could not parse hook input; failing open");
  }

  const filePath = input?.tool_input?.file_path;
  if (!filePath) decision("allow", "wt: no file_path; nothing to claim");

  const rel = path.isAbsolute(filePath) ? path.relative(process.cwd(), filePath) : filePath;
  const posixRel = rel.split(path.sep).join("/");

  try {
    const resp = await fetch(`${SERVER}/v1/claim`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({
        repo: REPO,
        actorId: ACTOR,
        path: posixRel,
        origin: ORIGIN,
        intent: `${input.tool_name} ${posixRel}`,
        request_id: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(1500),
    });
    const out = await resp.json();

    if (out.result === "GRANTED") {
      decision("allow", `wt: claimed ${posixRel} (fence ${out.claim.fence})`);
    }
    if (out.result === "WARN_PROCEED") {
      const who = out.conflicts?.[0]?.holder ?? "someone";
      decision("ask", `wt: ${who} is also working on ${posixRel}. Proceed and risk a tracked conflict?`);
    }
    if (out.result === "BLOCKED") {
      const e = out.error || {};
      decision(
        "deny",
        `wt: ${posixRel} is held by ${e.holder} (${e.holder_kind}): "${e.intent}". Try again in ~${Math.ceil(
          (e.retry_after_ms || 0) / 1000
        )}s, or work on a different file.`
      );
    }
    decision("allow", "wt: unexpected response; failing open");
  } catch (e) {
    decision("allow", `wt: coordination server unreachable (${String(e)}); failing open`);
  }
}

main();
