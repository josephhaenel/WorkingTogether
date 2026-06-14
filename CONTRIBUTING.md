# Contributing

Thanks for your interest in WorkingTogether!

## Getting started

```bash
npm run install:all   # install all package deps
npm run build         # build all packages
npm test              # unit tests (coordination core)
npm run demo          # end-to-end: collision avoidance + live sync
```

CI runs the build, unit tests, and the integration demos (`demo`, `demo:enforce`, `demo:persist`) on every push and PR — please make sure those pass locally before opening a PR.

## Where things live

- `packages/coordination-mcp-server` — claims / presence / decisions (the control plane)
- `packages/sync-relay` — Yjs CRDT relay (the data plane)
- `packages/sync-daemon` — per-machine disk⇄CRDT mirror
- `docs/design` — the design specs; `docs/ROADMAP.md` — what's planned next

## Conventions

- TypeScript, strict mode; no `any`.
- **LF line endings** (enforced by `.gitattributes`) — required because the project ships bash scripts and runs on Linux servers.
- Keep new behavior covered by a unit test or an integration demo.

## Good first areas

See [docs/ROADMAP.md](docs/ROADMAP.md). Onboarding DX (the `wt` CLI) and the awareness dashboard are self-contained places to start.
