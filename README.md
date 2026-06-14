# WorkingTogether

[![CI](https://github.com/josephhaenel/WorkingTogether/actions/workflows/ci.yml/badge.svg)](https://github.com/josephhaenel/WorkingTogether/actions/workflows/ci.yml)

**Multiplayer for AI coding agents.** Two or more people coding the same repository — each with their own Claude Code / Codex session — without overwriting each other's work, and seeing each other's changes live.

> Pair-programming and mob-programming tools assume *humans* typing. AI agents don't type — they rewrite whole functions and files in a single shot. That breaks the usual assumptions, and it's the problem this project is built around.

---

## Why this is a hard problem

When two people each drive an AI agent against the same codebase, two things go wrong fast:

1. **Silent clobbering.** Agents rewrite entire functions atomically. If two agents touch the same function, a naïve character-level CRDT will happily *merge* both rewrites into something that compiles-but-is-wrong. Convergence is not correctness.
2. **No shared awareness.** Each agent has its own context window. Neither knows what the other is doing, deciding, or about to overwrite.

So the core insight driving the design: **the CRDT is only transport + convergence. The actual value is collision *avoidance* — claiming a region of code *before* writing to it.**

---

## What it does

- **Collision avoidance.** Before an agent edits a file, it *claims* the region. If another agent holds it, the edit is refused (agent-vs-agent → hard block; a human involved → soft warn). Enforced at the Claude Code hook **and**, optionally, at the sync daemon — so even a plain-editor save can't bypass it.
- **Live file sync.** Edits propagate between collaborators' working trees in real time over a shared CRDT.
- **Shared memory.** An append-only "decisions" bus lets agents record and retrieve the few decisions relevant to the code they're touching.
- **Durable + secure.** Opt-in persistence (state survives restarts) and a shared-secret auth token for remote deployments.

---

## How it works

```mermaid
flowchart LR
  subgraph A["Alice's machine"]
    CCA["Claude Code"] --> HA["pre/post-tool hooks"]
    HA --> DA["sync daemon"]
    DA <--> FSA[("working tree")]
  end
  subgraph B["Bob's machine"]
    CCB["Claude Code"] --> HB["pre/post-tool hooks"]
    HB --> DB["sync daemon"]
    DB <--> FSB[("working tree")]
  end
  subgraph S["Shared server"]
    COORD["coordination server<br/>claims · presence · decisions"]
    RELAY["sync relay<br/>CRDT, one doc per repo"]
  end
  HA -->|"claim before edit"| COORD
  HB -->|"claim before edit"| COORD
  DA <-->|"CRDT sync"| RELAY
  DB <-->|"CRDT sync"| RELAY
```

Two planes:

- **Control plane (claims).** A Claude Code `PreToolUse` hook calls the coordination server to claim the target region before an `Edit`/`Write`; `PostToolUse` releases it. The coordination server is a single, linearizable authority that hands out **fence tokens** so a stale lease can never overwrite a newer one.
- **Data plane (sync).** A per-machine daemon mirrors the gitignore-scoped working tree into a shared [Yjs](https://yjs.dev) CRDT via a relay: local writes become CRDT edits; remote edits get written back to disk. A "shadow" map breaks the feedback loop in both directions.

The two planes compose: the daemon can check a claim before broadcasting a local edit, so collision avoidance covers edits that bypass the hook entirely.

---

## Repository layout

| Path | What |
|---|---|
| [`packages/coordination-mcp-server`](packages/coordination-mcp-server) | Claims / presence / decisions. An MCP server (`wt_claim`, `wt_whos_editing`, `wt_post_decision`, …) plus REST shims for the hooks. Fence tokens, TTL+heartbeat leases, party-dependent policy. |
| [`packages/sync-relay`](packages/sync-relay) | Minimal Yjs CRDT websocket relay — one document per repo, fans updates out to peers. |
| [`packages/sync-daemon`](packages/sync-daemon) | Per-machine disk⇄CRDT mirror; optional daemon-side claim enforcement. |
| [`docs/design`](docs/design) | The full design specs (see below). |
| [`deploy`](deploy) | One-command self-host setup for a VPS (Caddy + TLS + systemd + firewall). |
| [`examples`](examples) | Runnable end-to-end demos. |

---

## Try it locally (no setup)

```bash
npm run install:all
npm run build
npm run demo          # collision avoidance + live sync together
npm run demo:enforce  # a hook-bypassing edit gets blocked & reverted
npm run demo:persist  # state survives a relay restart
npm test              # coordination core (unit tests)
```

`npm run demo` spins up the coordination server, the relay, and two daemons on two temp dirs, drives the real Claude Code hooks, and proves the whole loop: same file → blocked, different files → fine, edits sync live, release frees the region.

## Use it with real Claude Code, or host it for your team

- **Local / one machine:** see [QUICKSTART.md](QUICKSTART.md).
- **Self-host on a VPS (for you + collaborators):** see [deploy/README.md](deploy/README.md) — one script sets up TLS (via `sslip.io`, no domain required), a non-root service user, systemd, a firewall, and an auth token, then prints the exact connection settings your collaborators paste in.

---

## Design docs

This was designed spec-first, and the specs are worth reading on their own:

- [`docs/design/sync-loop.md`](docs/design/sync-loop.md) — the git-baseline ↔ CRDT-overlay synchronization model (the production target: epochs, durable landing, offline reconnect, conflict-as-data).
- [`docs/design/coordination-mcp.md`](docs/design/coordination-mcp.md) — the claims/presence/decisions layer (region identity, fencing, the agent-vs-human policy, partition behavior).

Both specs were produced and **adversarially hardened** with multi-agent workflows — independent agents designed each dimension, then a panel of skeptics attacked the design and the holes were folded back in. Mechanisms in the specs are tagged with the specific failure scenario they defend against.

---

## Status & scope

This is a working **MVP**: collision avoidance, live sync, shared decisions, persistence, and auth all function and are covered by demos/tests. Current simplifications (tracked toward the production design in the specs):

- claims are whole-file in the current hook wiring (region/symbol-level is specified, not yet wired);
- the CRDT is the live state (the git-baseline/epoch landing model is specified, not yet built);
- text files only, under 512 KB; rename = delete+create;
- shared-token auth (good for a team you invite; multi-user accounts are a later milestone).

Contributions and ideas welcome — start with the design docs.

## Roadmap

Active plan to make it genuinely good to use (full detail in [docs/ROADMAP.md](docs/ROADMAP.md)):

0. **CI & tests** — build + test + integration demos on every push.
1. **Frictionless onboarding** — `npx @workingtogether/cli init` wires the hooks and starts the daemon in one command; `wt status`.
2. **Agents use the shared brain** — agents actively check who's-editing and read/write the decisions bus during real work.
3. **Awareness dashboard** — a live web view of presence, claims, and decisions.
4. **Region-level claims** — tree-sitter symbol claims so two agents can work in the same file (different functions), with diff3 conflict-as-data.

## License

[MIT](LICENSE) © Joseph Haenel
