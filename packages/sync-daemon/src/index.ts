#!/usr/bin/env node
/**
 * WorkingTogether sync daemon CLI.
 *
 *   wt-sync-daemon --dir <repoDir> --relay ws://host:4200 --room <repoId>
 *
 * Flags fall back to env (WT_DIR, WT_RELAY, WT_ROOM) then sensible defaults
 * (cwd, ws://localhost:4200, basename of the dir).
 */
import path from "node:path";
import { SyncDaemon } from "./daemon.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const repoDir = path.resolve(arg("dir") || process.env.WT_DIR || process.cwd());
const relayUrl = arg("relay") || process.env.WT_RELAY || "ws://localhost:4200";
const room = arg("room") || process.env.WT_ROOM || path.basename(repoDir);

// Optional claim enforcement ([D-46]): pass --coord + --actor (or WT_COORD_URL +
// WT_ACTOR_ID) to gate local edits that bypass the Claude Code hook.
const coordUrl = arg("coord") || process.env.WT_COORD_URL || undefined;
const actorId = arg("actor") || process.env.WT_ACTOR_ID || undefined;
const repoId = arg("repo") || process.env.WT_REPO || room;
const token = arg("token") || process.env.WT_TOKEN || undefined;

const daemon = new SyncDaemon({ repoDir, relayUrl, room, coordUrl, actorId, repoId, token });

daemon.start().catch((e) => {
  console.error("[daemon] fatal:", e);
  process.exit(1);
});

const shutdown = () => {
  daemon
    .stop()
    .catch(() => {})
    .finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
