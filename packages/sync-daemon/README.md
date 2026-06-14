# @workingtogether/sync-daemon (+ sync-relay)

Real-time file sync for **WorkingTogether** — the piece that makes collaborators see each other's *code* live, not just each other's claims. MVP slice of the sync substrate in [`docs/design/sync-loop.md`](../../docs/design/sync-loop.md).

## How it works

```
  machine A                         relay (cloud)                 machine B
  working dir <--watch/write--> [ sync-daemon ] <--ws--> [ room CRDT ] <--ws--> [ sync-daemon ] <--watch/write--> working dir
```

- The **relay** ([`../sync-relay`](../sync-relay)) holds one Yjs CRDT document per room (room = repo) in memory and fans updates between connected daemons. Standard y-protocols, so the official `WebsocketProvider` talks to it directly.
- The **daemon** mirrors the gitignore-bounded working tree into that CRDT:
  - **disk → CRDT:** a file watcher turns each local write into a minimal Y.Text splice.
  - **CRDT → disk:** a deep observer writes remote changes back to disk.
  - A **shadow map** (last-synced content per path) breaks the feedback loop in both directions.

## Run it

```bash
# in packages/sync-relay
npm install && npm run build && npm start          # ws://localhost:4200

# in packages/sync-daemon (per collaborator / working dir)
npm install && npm run build
node dist/index.js --dir /path/to/repo --relay ws://relay-host:4200 --room my-repo
```

Every collaborator points their daemon at the **same relay + room**; edits then propagate live.

## Verify (one machine, two dirs)

```bash
# from packages/sync-daemon, after building BOTH packages:
npm run demo
```

Spins up a relay + two daemons on two temp dirs and asserts an edit in A appears in B, a new file in A appears in B, and an edit in B appears in A.

## MVP scope (deferred to the full spec)

This slice is **"live shared working tree."** Intentionally **not** here yet (see `sync-loop.md`):
- git baseline / epoch landing / durable snapshotting — the CRDT is the live state; the relay is in-memory.
- the nodeId tree-CRDT — files are keyed by path; **rename = delete + create** for now.
- text files only, under 512 KB; binary/large files are skipped.
- **collision avoidance** comes from the coordination layer (claims). The Claude Code hook gates agent edits before they happen; additionally, pass `--coord http://host:4100 --actor <id> --repo <id>` to enable **daemon-side enforcement** ([D-46]): a local edit that bypasses the hook (e.g. a plain-editor save) is checked against claims and reverted if another actor holds the region. Without `--coord`, the daemon is pure sync. See `examples/enforcement-check.mjs`.
- offline reconnect, structural-op fidelity, secrets purge, fencing — all per the spec.
