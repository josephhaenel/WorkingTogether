/**
 * SyncDaemon — mirrors a gitignore-bounded working tree into a shared Yjs CRDT.
 *
 *   disk -> CRDT : a chokidar watcher turns local file writes into Y.Text splices.
 *   CRDT -> disk : a deep observer writes remote changes back to disk.
 *
 * Loop guard: a `shadow` map holds the last content we synced for each path, in
 * either direction. Before applying a change we compare against the shadow and
 * skip if equal — so a CRDT->disk write doesn't bounce back as a disk->CRDT op,
 * and vice-versa. Local disk->CRDT transactions are tagged with LOCAL_ORIGIN so
 * the observer ignores them too (belt and suspenders).
 *
 * MVP scope (see docs/design/sync-loop.md for the production design):
 *  - per-file Y.Text keyed by repo-relative path; rename = delete + create
 *    (no nodeId tree-CRDT yet), text files only, under MAX_BYTES.
 *  - no git baseline / epoch landing; the CRDT is the live state.
 *  - collision avoidance comes from the coordination layer (claims), not here.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import chokidar, { type FSWatcher } from "chokidar";
import { buildIgnore, isIgnored, toRel, type Ignore } from "./scope.js";
import { computeSplice } from "./diff.js";

const MAX_BYTES = 512 * 1024;
const LOCAL_ORIGIN = "wt-local-disk";

export interface DaemonOptions {
  repoDir: string;
  relayUrl: string; // e.g. ws://localhost:4200
  room: string;
  log?: (msg: string) => void;
  /** Opt-in claim enforcement ([D-46]): if set, a local edit is gated by the
   *  coordination server before broadcasting, and reverted if another actor
   *  holds the region. Catches edits that bypass the Claude Code hook. */
  coordUrl?: string; // e.g. http://localhost:4100
  actorId?: string; // must match the hook's WT_ACTOR_ID for reentrancy
  repoId?: string; // claim repo id (defaults to room); must match the hook's WT_REPO
}

export class SyncDaemon {
  private readonly doc = new Y.Doc();
  private readonly files: Y.Map<Y.Text>;
  private readonly provider: WebsocketProvider;
  private readonly ig: Ignore;
  private readonly shadow = new Map<string, string>();
  private watcher?: FSWatcher;
  private readonly log: (msg: string) => void;
  private readonly enforce: boolean;
  private readonly repoId: string;

  constructor(private readonly opts: DaemonOptions) {
    this.log = opts.log ?? ((m) => console.error(`[daemon] ${m}`));
    this.files = this.doc.getMap<Y.Text>("files");
    this.ig = buildIgnore(opts.repoDir);
    this.enforce = Boolean(opts.coordUrl && opts.actorId);
    this.repoId = opts.repoId ?? opts.room;
    this.provider = new WebsocketProvider(opts.relayUrl, opts.room, this.doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      connect: true,
    });
  }

  async start(): Promise<void> {
    this.files.observeDeep((events, txn) => {
      if (txn.origin === LOCAL_ORIGIN) return; // our own disk->CRDT change
      const changed = this.changedKeys(events);
      for (const key of changed) {
        this.applyCrdtToDisk(key).catch((e) => this.log(`crdt->disk ${key} failed: ${e}`));
      }
    });

    await this.waitSynced();
    await this.initialReconcile();
    this.startWatching();
    this.log(`synced ${this.opts.repoDir} <-> ${this.opts.relayUrl}/${this.opts.room}`);
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
    this.provider.destroy();
    this.doc.destroy();
  }

  // ---- helpers ----
  private abs(rel: string): string {
    return path.join(this.opts.repoDir, rel);
  }

  private changedKeys(events: Y.YEvent<any>[]): Set<string> {
    const changed = new Set<string>();
    for (const e of events) {
      if (e.target === this.files) {
        for (const key of (e as Y.YMapEvent<Y.Text>).keysChanged) changed.add(key);
      } else {
        // a Y.Text changed: find its key (maps are small in the MVP)
        for (const [k, v] of this.files.entries()) {
          if (v === e.target) {
            changed.add(k);
            break;
          }
        }
      }
    }
    return changed;
  }

  private waitSynced(): Promise<void> {
    return new Promise((resolve) => {
      if (this.provider.synced) return resolve();
      const onSync = () => resolve();
      this.provider.once("sync", onSync);
      setTimeout(resolve, 5000); // proceed even if the relay is slow/empty
    });
  }

  private async readText(rel: string): Promise<string | null> {
    try {
      const stat = await fsp.stat(this.abs(rel));
      if (!stat.isFile() || stat.size > MAX_BYTES) return null;
      const buf = await fsp.readFile(this.abs(rel));
      if (buf.includes(0)) return null; // looks binary
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }

  private async scanDisk(dir = this.opts.repoDir): Promise<string[]> {
    const out: string[] = [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const ent of entries) {
      const absPath = path.join(dir, ent.name);
      if (isIgnored(this.ig, this.opts.repoDir, absPath)) continue;
      if (ent.isDirectory()) {
        out.push(...(await this.scanDisk(absPath)));
      } else if (ent.isFile()) {
        const rel = toRel(this.opts.repoDir, absPath);
        if (rel) out.push(rel);
      }
    }
    return out;
  }

  private async initialReconcile(): Promise<void> {
    // CRDT -> disk for everything already in the shared doc
    for (const [rel] of this.files.entries()) {
      await this.applyCrdtToDisk(rel);
    }
    // disk -> CRDT for tracked files not yet in the doc (seeds a fresh room)
    for (const rel of await this.scanDisk()) {
      if (!this.files.has(rel)) {
        const content = await this.readText(rel);
        if (content !== null) this.diskToCrdt(rel, content);
      }
    }
  }

  // ---- enforcement ([D-46]): gate a local edit before it is broadcast ----
  private async handleLocalWrite(rel: string, content: string): Promise<void> {
    if (this.shadow.get(rel) === content) return; // remote apply or unchanged
    if (this.enforce) {
      const chk = await this.canWrite(rel);
      if (!chk.allowed) {
        await this.revertToCrdt(rel);
        this.log(`BLOCKED local edit to ${rel}: region held by ${chk.holder} (${chk.holderKind}); reverted`);
        return;
      }
    }
    this.diskToCrdt(rel, content);
  }

  private async canWrite(
    rel: string
  ): Promise<{ allowed: boolean; holder?: string; holderKind?: string }> {
    try {
      const url =
        `${this.opts.coordUrl}/v1/can_write?repo=${encodeURIComponent(this.repoId)}` +
        `&actorId=${encodeURIComponent(this.opts.actorId!)}&path=${encodeURIComponent(rel)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return (await resp.json()) as { allowed: boolean; holder?: string; holderKind?: string };
    } catch {
      return { allowed: true }; // fail-open: never hard-block editing if coordination is down
    }
  }

  private async revertToCrdt(rel: string): Promise<void> {
    const text = this.files.get(rel);
    if (!text) return; // not a shared file yet; nothing authoritative to revert to
    const content = text.toString();
    this.shadow.set(rel, content); // so the resulting watcher event is ignored
    await fsp.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fsp.writeFile(this.abs(rel), content, "utf8");
  }

  // ---- disk -> CRDT ----
  private diskToCrdt(rel: string, content: string): void {
    if (this.shadow.get(rel) === content) return; // unchanged / our own remote write
    this.shadow.set(rel, content);
    this.doc.transact(() => {
      let text = this.files.get(rel);
      if (!text) {
        text = new Y.Text();
        this.files.set(rel, text);
      }
      const cur = text.toString();
      const { index, deleteCount, insert } = computeSplice(cur, content);
      if (deleteCount > 0) text.delete(index, deleteCount);
      if (insert) text.insert(index, insert);
    }, LOCAL_ORIGIN);
  }

  // ---- CRDT -> disk ----
  private async applyCrdtToDisk(rel: string): Promise<void> {
    const text = this.files.get(rel);
    if (!text) {
      // deletion
      if (this.shadow.has(rel)) {
        this.shadow.delete(rel);
        await fsp.rm(this.abs(rel), { force: true });
        this.log(`deleted ${rel}`);
      }
      return;
    }
    const content = text.toString();
    if (this.shadow.get(rel) === content) return; // already in sync (loop guard)
    this.shadow.set(rel, content);
    await fsp.mkdir(path.dirname(this.abs(rel)), { recursive: true });
    await fsp.writeFile(this.abs(rel), content, "utf8");
    this.log(`applied remote change to ${rel}`);
  }

  // ---- watcher ----
  private startWatching(): void {
    this.watcher = chokidar.watch(this.opts.repoDir, {
      ignoreInitial: true,
      ignored: (p: string) => isIgnored(this.ig, this.opts.repoDir, p),
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    });

    const onWrite = (absPath: string) => {
      const rel = toRel(this.opts.repoDir, absPath);
      if (!rel) return;
      this.readText(rel)
        .then((content) => {
          if (content !== null) return this.handleLocalWrite(rel, content);
        })
        .catch(() => {});
    };

    this.watcher
      .on("add", onWrite)
      .on("change", onWrite)
      .on("unlink", (absPath: string) => {
        const rel = toRel(this.opts.repoDir, absPath);
        if (!rel || !this.files.has(rel)) return;
        this.shadow.delete(rel);
        this.doc.transact(() => this.files.delete(rel), LOCAL_ORIGIN);
      });
  }
}
