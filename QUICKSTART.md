# WorkingTogether — Quickstart

Multiplayer for AI coding agents: two+ people coding the same repo with Claude Code / Codex get **collision avoidance** (agents don't clobber each other's functions) and **live file sync** (you see each other's code as it changes).

## What's in here

| Piece | What it does | Package |
|---|---|---|
| Coordination server | claims / presence / shared decisions (the "don't clobber" layer) | [`packages/coordination-mcp-server`](packages/coordination-mcp-server) |
| Sync relay | one shared CRDT per repo, fans edits out | [`packages/sync-relay`](packages/sync-relay) |
| Sync daemon | mirrors your working tree into the CRDT (per machine) | [`packages/sync-daemon`](packages/sync-daemon) |
| Hooks | claim-before-edit / release-after-edit for Claude Code | `packages/coordination-mcp-server/hooks` |

Design docs: [`docs/design/sync-loop.md`](docs/design/sync-loop.md), [`docs/design/coordination-mcp.md`](docs/design/coordination-mcp.md).

## See it work (one machine)

```bash
npm run install:all
npm run build
npm run demo        # combined: collision avoidance + live sync, all real components
npm test            # coordination-server unit tests
```

`npm run demo` spins up the coordination server, the relay, and two daemons on two temp dirs, drives the real Claude Code hooks, and proves: same file → blocked; different files → fine; edits sync live; release frees the region.

## Use it for real (per collaborator)

> **Hosting it for a team (TLS + auth)?** See [deploy/README.md](deploy/README.md) — one script self-hosts the server on a VPS (automatic HTTPS via sslip.io, no domain needed). The steps below are the manual / local-network version.

1. **One person runs the shared services** (or host them somewhere both can reach):
   ```bash
   # set these to persist state across restarts (otherwise in-memory):
   export WT_DATA_DIR=./.wt-data            # coordination: decisions + identity
   export WT_RELAY_DATA_DIR=./.wt-data/crdt # relay: per-repo CRDT docs
   npm run start:coord    # http://localhost:4100   (claims)
   npm run start:relay    # ws://localhost:4200     (sync)
   ```
2. **Each collaborator** runs a daemon over their checkout and sets two env vars:
   ```bash
   export WT_ACTOR_ID="alice"      # unique per person
   export WT_REPO="my-repo"        # SAME for everyone on this repo
   # add --coord for enforcement: edits that bypass the hook (e.g. a plain editor)
   # are then also gated against claims and reverted if someone else holds the region.
   node packages/sync-daemon/dist/index.js --dir . --relay ws://RELAY_HOST:4200 \
        --room my-repo --coord http://COORD_HOST:4100 --actor "$WT_ACTOR_ID" --repo "$WT_REPO"
   ```
3. **Wire Claude Code** (in the repo's `.claude/settings.json`):
   ```jsonc
   {
     "hooks": {
       "PreToolUse": [
         { "matcher": "Edit|Write|MultiEdit",
           "hooks": [{ "type": "command", "command": "node /abs/path/packages/coordination-mcp-server/hooks/pre-tool-use.mjs" }] }
       ],
       "PostToolUse": [
         { "matcher": "Edit|Write|MultiEdit",
           "hooks": [{ "type": "command", "command": "node /abs/path/packages/coordination-mcp-server/hooks/post-tool-use.mjs" }] }
       ]
     }
   }
   ```
   Set `WT_SERVER_URL=http://COORD_HOST:4100`, `WT_ACTOR_ID`, and `WT_REPO` in each collaborator's environment. The hooks **fail open** — if the coordination server is down, your editing is never blocked.

   Optionally also add the coordination MCP server (`http://COORD_HOST:4100/mcp`) so agents can call `wt_whos_editing`, `wt_post_decision`, etc.

## Current limits (MVP)

Durable state is opt-in via `WT_DATA_DIR` / `WT_RELAY_DATA_DIR` (decisions, identity, and the per-repo CRDT survive restarts; active claims/presence are TTL-ephemeral by design). Claim enforcement works both at the Claude Code hook AND, opt-in, at the daemon (`--coord`) so hook-bypassing edits are gated too. Still MVP: text files only, under 512 KB; rename = delete+create; identity is first-seen-trust. The remaining production hardening (git-baseline landing, monotonic fencing threaded to the write path, crypto identity/trust-root) is specified in the design docs and tracked as next steps.
