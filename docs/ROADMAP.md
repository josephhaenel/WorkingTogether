# Roadmap

Where WorkingTogether is and where it's going. The MVP is shipped, deployed, and open-source: collision avoidance (hook + daemon-side), live file sync, a shared decisions bus, persistence, shared-token auth + TLS, and one-command self-hosting. The work below turns "works for us" into "genuinely good to use."

Each initiative lists its **goal**, **why it matters**, the **key tasks**, **dependencies**, and a rough **size**. They're ordered so each one makes the next easier or more valuable.

---

## 0. CI & tests — *foundation* ✅ in progress

**Goal:** every push builds, unit-tests, and runs the integration demos on GitHub Actions; green badge in the README.
**Why:** cheap credibility for a public repo and a safety net for everything below.
**Tasks:** GitHub Actions workflow (build + `npm test` + `npm run demo`/`demo:enforce`/`demo:persist`); README badge; a `CONTRIBUTING.md` note. Add more integration tests as features land.
**Size:** S.

## 1. Frictionless onboarding — *adoption*

**Goal:** go from "clone, build, hand-edit `.claude/settings.json`, run a long daemon command" to **one command**.
**Why:** the single biggest lever for usefulness — nobody adopts a tool they can't start in a minute.
**Tasks:**
- `@workingtogether/cli` with `wt init` — prompts for server URL / token / repo / actor, writes the pre/post hooks into `.claude/settings.json`, and launches the daemon.
- `wt status` — connection state, who's editing what, your active claims.
- `wt up` / `wt down` — start/stop the daemon as a managed background process.
- Publish packages to npm so `npx @workingtogether/cli init` works with zero clone.
**Depends on:** nothing (the daemon + hooks already exist).
**Size:** M.

## 2. Make agents *use* the shared brain — *realize the unique value*

**Goal:** agents actively consult presence and the decisions bus during real work, not just claim-before-write.
**Why:** the decisions bus and awareness only pay off if agents read/write them; this is what makes the tool "shared context," not just "file locking."
**Tasks:**
- First-class MCP wiring so Claude Code/Codex can call `wt_whos_editing`, `wt_get_decisions`, `wt_post_decision`.
- A generated `CLAUDE.md` snippet (written by `wt init`) instructing the agent to check who's editing and read relevant decisions before starting, and to record decisions as it makes them.
- Auto-inject scope-relevant decisions on a claim grant (already specced in `coordination-mcp.md`).
**Depends on:** 1 (so the MCP + CLAUDE.md are wired automatically).
**Size:** M.

## 3. Awareness dashboard — *make it visible*

**Goal:** a lightweight web view served by the coordination server: live presence, active claims, recent decisions.
**Why:** humans need to *see* the collaboration; also the best demo/GIF material.
**Tasks:** a read-only web UI (served at `/` on the coordination server) polling `wt_whos_editing` + decisions; live updates; token-gated.
**Depends on:** 2 (so there's presence + decision activity worth showing).
**Size:** M.

## 4. Smarter collision avoidance — *core capability depth*

**Goal:** two agents can work in the **same file, different functions**, and overlaps surface gracefully.
**Why:** whole-file claims are coarse; region-level is the headline capability jump (and it's already designed in `coordination-mcp.md`).
**Tasks:**
- Region/symbol-level claims via tree-sitter structural anchoring (`regionId = H(nodeId, symbol-path)`); the hook computes the symbol from the edit target.
- `conflict-as-data` (diff3) instead of the daemon's hard revert, so overlapping edits become reviewable conflicts.
- Wire the fence all the way to the write path for overlapping-region safety.
**Depends on:** 1, 2 (stable client + active coordination first).
**Size:** L.

---

## Ideal order

**0 → 1 → 2 → 3 → 4.** CI first (protects everything), then get people *in the door* (1), make the experience *deliver its unique value* (2), make it *feel alive* (3), then deepen the *core capability* (4).

## Beyond this roadmap (when real usage demands it)

The production-grade pieces specified in [`docs/design/sync-loop.md`](design/sync-loop.md) and [`docs/design/coordination-mcp.md`](design/coordination-mcp.md): the git-baseline/epoch landing model (durable snapshots, offline reconnect), binary/large-file sync, per-user accounts + per-repo access control (vs. one shared token), and cryptographic identity/trust-root. These are big and best driven by what real usage shows breaking first.
