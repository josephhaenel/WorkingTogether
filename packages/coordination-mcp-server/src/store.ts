/**
 * CoordinationStore — the linearizable coordination state.
 *
 * Linearizability comes for free in the MVP: this is a single Node process and
 * every mutation runs to completion synchronously on the event loop. Fences are
 * drawn from ONE monotonic counter (never per-region), so two callers can never
 * observe equal fences (defends the split-brain equal-fence hazard).
 *
 * MVP simplifications (documented, not hidden):
 *  - `shared` claims are advisory (recorded for awareness, never block / blocked).
 *    `exclusive` claims are the real lock. Read-lock semantics are post-MVP.
 *  - Identity is first-seen-trust unless `enforceRegistration` is set; the
 *    cryptographic provenance / trust-root (§5.2) is post-MVP.
 *  - `force` does not preempt a live holder (per spec it never may); it degrades
 *    to WARN_PROCEED for a human principal.
 */

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { JsonFilePersistence } from "./persistence.js";
import type {
  Claim,
  ClaimOutcome,
  ConflictInfo,
  Decision,
  DecisionScope,
  Grain,
  Identity,
  Kind,
  Mode,
  Presence,
  SimpleResult,
  WtError,
} from "./types.js";
import { DEFAULT_POLICY, decide, resolvePolicy, type PolicyRule } from "./policy.js";

export interface ResolvedRegion {
  regionId: string;
  anchor: string;
  grain: Grain;
  symbol: string | null;
}

export interface ClaimRequest {
  repo: string;
  regionId: string;
  anchor: string;
  grain: Grain;
  path?: string; // for policy resolution
  actorId: string;
  origin: Kind;
  mode: Mode;
  intent: string;
  requestId: string;
  progressToken?: number;
  force?: boolean;
}

export interface StoreOptions {
  policyRules?: PolicyRule[];
  enforceRegistration?: boolean; // §5.3 fail-closed for unregistered on enforcing regions
  dataDir?: string; // if set, decisions + identity are persisted here (durable across restarts)
}

const err = (
  code: string,
  cls: WtError["class"],
  message: string,
  extra: Partial<WtError> = {}
): WtError => ({ code, class: cls, message, ...extra });

export class CoordinationStore {
  private fenceCounter = 0;
  private ordCounter = 0;
  private exclusiveByRegion = new Map<string, Claim>();
  private sharedByRegion = new Map<string, Map<string, Claim>>(); // regionId -> actorId -> claim
  private claimById = new Map<string, Claim>();
  private decisions = new Map<string, Decision>();
  private presence = new Map<string, Presence>(); // keyed by actorId
  private identity = new Map<string, Identity>();
  private idempotency = new Map<string, ClaimOutcome>();
  private policyRules: PolicyRule[];
  private enforceRegistration: boolean;
  private persistence?: JsonFilePersistence;

  constructor(opts: StoreOptions = {}) {
    this.policyRules = opts.policyRules ?? [];
    this.enforceRegistration = opts.enforceRegistration ?? false;
    if (opts.dataDir) {
      this.persistence = new JsonFilePersistence(path.join(opts.dataDir, "coordination.json"));
      this.loadSnapshot();
    }
  }

  /** Restore durable state (decisions + identity) from disk. Claims/presence are
   *  TTL-ephemeral by design and intentionally NOT persisted. */
  private loadSnapshot(): void {
    const snap = this.persistence?.load<{ decisions?: Decision[]; identity?: Identity[] }>();
    if (!snap) return;
    for (const d of snap.decisions ?? []) {
      this.decisions.set(d.decisionId, d);
      if (d.ord > this.ordCounter) this.ordCounter = d.ord;
    }
    for (const id of snap.identity ?? []) this.identity.set(id.actorId, id);
  }

  private persistSnapshot(): void {
    this.persistence?.scheduleSave({
      decisions: [...this.decisions.values()],
      identity: [...this.identity.values()],
    });
  }

  /** Force a synchronous write of pending durable state (call on shutdown). */
  flushPersistence(): void {
    this.persistence?.flush();
  }

  private nextFence(): number {
    return ++this.fenceCounter;
  }
  private nextOrd(): number {
    return ++this.ordCounter;
  }
  private now(): number {
    return Date.now();
  }

  // ---- region identity (structural, never positional) ----
  resolveRegion(repo: string, path: string, symbol?: string): ResolvedRegion {
    const anchor = symbol ? `${path}#${symbol}` : path;
    const grain: Grain = symbol ? "region" : "node";
    const regionId = createHash("sha256")
      .update(`${repo}${String.fromCharCode(0)}${anchor}`) // NUL delimiter — cannot appear in a repo id or path
      .digest("hex")
      .slice(0, 32);
    return { regionId, anchor, grain, symbol: symbol ?? null };
  }

  // ---- identity ----
  registerIdentity(id: Identity): void {
    this.identity.set(id.actorId, id);
    this.persistSnapshot();
  }
  private kindOf(actorId: string, origin: Kind): Kind | null {
    const rec = this.identity.get(actorId);
    if (rec) return rec.kind;
    return null; // unregistered
  }

  // ---- lazy expiry sweep (TTL reclaim of crashed holders) ----
  private sweep(): void {
    const t = this.now();
    for (const [rid, c] of this.exclusiveByRegion) {
      if (c.expiresAt <= t) {
        this.exclusiveByRegion.delete(rid);
        this.claimById.delete(c.claimId);
      }
    }
    for (const [rid, holders] of this.sharedByRegion) {
      for (const [actor, c] of holders) {
        if (c.expiresAt <= t) {
          holders.delete(actor);
          this.claimById.delete(c.claimId);
        }
      }
      if (holders.size === 0) this.sharedByRegion.delete(rid);
    }
    for (const [a, p] of this.presence) if (p.expiresAt <= t) this.presence.delete(a);
  }

  // ---- claim ----
  claim(req: ClaimRequest): ClaimOutcome {
    this.sweep();

    // idempotency: a retried request_id replays the same outcome (never double-applies)
    const cached = this.idempotency.get(req.requestId);
    if (cached) return cached;

    const pol = resolvePolicy(req.path, this.policyRules);
    const incomingKind = this.resolveIncomingKind(req);

    // fail-closed for unregistered actor on an enforcing region (§5.3)
    if (
      this.enforceRegistration &&
      incomingKind === null &&
      req.mode === "exclusive" &&
      pol.agentVsAgent === "block"
    ) {
      return this.remember(
        req.requestId,
        {
          result: "ERROR",
          error: err(
            "UNREGISTERED_ACTOR",
            "TERMINAL",
            `Actor '${req.actorId}' is not registered; enforcing regions require registration. Call wt_register first.`,
            { remediation: ["wt_register"] }
          ),
        }
      );
    }
    const effectiveKind: Kind = incomingKind ?? req.origin; // first-seen trust when not enforcing

    // shared claims are advisory in the MVP: always granted, never block.
    if (req.mode === "shared") {
      const claim = this.mintClaim(req, "shared", effectiveKind, pol);
      let holders = this.sharedByRegion.get(req.regionId);
      if (!holders) {
        holders = new Map();
        this.sharedByRegion.set(req.regionId, holders);
      }
      holders.set(req.actorId, claim);
      this.claimById.set(claim.claimId, claim);
      return this.remember(req.requestId, { result: "GRANTED", claim });
    }

    // exclusive
    const existing = this.exclusiveByRegion.get(req.regionId);

    if (existing && existing.holder === req.actorId) {
      // reentrant: same fence, bump hold count, refresh lease
      existing.holdCount += 1;
      existing.expiresAt = this.now() + existing.ttlMs;
      if (req.progressToken && req.progressToken > existing.lastProgress) {
        existing.lastProgress = req.progressToken;
      }
      return this.remember(req.requestId, { result: "GRANTED", claim: existing });
    }

    if (!existing) {
      const claim = this.mintClaim(req, "exclusive", effectiveKind, pol);
      this.exclusiveByRegion.set(req.regionId, claim);
      this.claimById.set(claim.claimId, claim);
      return this.remember(req.requestId, { result: "GRANTED", claim });
    }

    // contended
    const verdict = decide(effectiveKind, existing.kind, pol);
    if (verdict === "BLOCKED") {
      const retry = Math.max(0, existing.expiresAt - this.now());
      return this.remember(req.requestId, {
        result: "BLOCKED",
        error: err(
          "REGION_CLAIMED",
          "BLOCKED_RETRYABLE",
          `Region '${req.anchor}' is held exclusively by '${existing.holder}' (${existing.kind}): ${existing.intent}`,
          {
            holder: existing.holder,
            holder_kind: existing.kind,
            intent: existing.intent,
            retry_after_ms: retry,
            remediation: ["wt_whos_editing", "wt_handoff", "retry after retry_after_ms"],
          }
        ),
      });
    }

    // WARN_PROCEED (human involved): no exclusive lock taken; the write proceeds
    // and conflict-as-data handles overlap later. Return a soft fence for tracing.
    const conflicts: ConflictInfo[] = [
      {
        regionId: existing.regionId,
        holder: existing.holder,
        holderKind: existing.kind,
        intent: existing.intent,
      },
    ];
    return this.remember(req.requestId, {
      result: "WARN_PROCEED",
      claim: null,
      conflicts,
      soft_fence: this.nextFence(),
    });
  }

  private resolveIncomingKind(req: ClaimRequest): Kind | null {
    return this.kindOf(req.actorId, req.origin);
  }

  private mintClaim(req: ClaimRequest, mode: Mode, kind: Kind, pol = DEFAULT_POLICY): Claim {
    const now = this.now();
    return {
      claimId: randomUUID(),
      repo: req.repo,
      regionId: req.regionId,
      grain: req.grain,
      anchor: req.anchor,
      holder: req.actorId,
      kind,
      mode,
      fence: this.nextFence(),
      intent: req.intent,
      grantedAt: now,
      expiresAt: now + pol.ttlMs,
      ttlMs: pol.ttlMs,
      heartbeatMs: pol.heartbeatMs,
      holdCount: 1,
      lastProgress: req.progressToken ?? 0,
    };
  }

  private remember(requestId: string, outcome: ClaimOutcome): ClaimOutcome {
    this.idempotency.set(requestId, outcome);
    return outcome;
  }

  // ---- release ----
  release(claimId: string, fence: number): SimpleResult<{ released: boolean; wokeNext: boolean }> {
    const c = this.claimById.get(claimId);
    if (!c) return { ok: true, value: { released: true, wokeNext: false } }; // idempotent
    if (c.fence !== fence) {
      return {
        ok: false,
        error: err("FENCE_REJECTED", "TERMINAL", "Stale fence; this claim was reclaimed or handed off.", {
          fence_required_above: c.fence,
        }),
      };
    }
    c.holdCount -= 1;
    if (c.holdCount > 0) return { ok: true, value: { released: false, wokeNext: false } };
    this.removeClaim(c);
    return { ok: true, value: { released: true, wokeNext: false } };
  }

  /** Non-mutating check used by the daemon write path (§4.2 / [D-46]) to gate
   *  edits that bypass the hook: allowed iff the region is free or held by me. */
  canWrite(regionId: string, actorId: string): { allowed: boolean; holder?: string; holderKind?: Kind } {
    this.sweep();
    const c = this.exclusiveByRegion.get(regionId);
    if (!c || c.holder === actorId) return { allowed: true };
    return { allowed: false, holder: c.holder, holderKind: c.kind };
  }

  /** Release whatever exclusive claim `actorId` holds on `regionId` (used by the
   *  PostToolUse hook, which knows repo+actor+path but not the claim_id/fence). */
  releaseByRegion(regionId: string, actorId: string): { released: boolean } {
    this.sweep();
    const c = this.exclusiveByRegion.get(regionId);
    if (c && c.holder === actorId) {
      this.removeClaim(c);
      return { released: true };
    }
    return { released: false };
  }

  private removeClaim(c: Claim): void {
    this.claimById.delete(c.claimId);
    if (c.mode === "exclusive") {
      if (this.exclusiveByRegion.get(c.regionId)?.claimId === c.claimId) {
        this.exclusiveByRegion.delete(c.regionId);
      }
    } else {
      const holders = this.sharedByRegion.get(c.regionId);
      holders?.delete(c.holder);
      if (holders && holders.size === 0) this.sharedByRegion.delete(c.regionId);
    }
  }

  // ---- heartbeat (proof-of-agent-progress; extends TTL only if progress advanced) ----
  heartbeat(
    claimId: string,
    fence: number,
    progressToken?: number
  ): SimpleResult<{ ttlMs: number; extended: boolean }> {
    const c = this.claimById.get(claimId);
    if (!c || c.expiresAt <= this.now()) {
      return {
        ok: false,
        error: err("FENCE_REJECTED", "TERMINAL", "Lease lost (expired or reclaimed). Re-claim before writing."),
      };
    }
    if (c.fence !== fence) {
      return {
        ok: false,
        error: err("FENCE_REJECTED", "TERMINAL", "Stale fence.", { fence_required_above: c.fence }),
      };
    }
    const advanced = progressToken !== undefined && progressToken > c.lastProgress;
    if (advanced) {
      c.lastProgress = progressToken!;
      c.expiresAt = this.now() + c.ttlMs;
      return { ok: true, value: { ttlMs: c.ttlMs, extended: true } };
    }
    // no progress proof -> do NOT extend (a dead agent's daemon cannot keep a lease alive)
    return { ok: true, value: { ttlMs: Math.max(0, c.expiresAt - this.now()), extended: false } };
  }

  // ---- presence ----
  announce(p: Omit<Presence, "expiresAt" | "updatedAt"> & { ttlMs: number }): void {
    this.sweep();
    const now = this.now();
    this.presence.set(p.actorId, {
      actorId: p.actorId,
      kind: p.kind,
      state: p.state,
      focus: p.focus,
      expiresAt: now + p.ttlMs,
      lastProgress: p.lastProgress,
      updatedAt: now,
    });
  }

  whosEditing(
    repo: string,
    scope?: { regionId?: string; nodeId?: string; pathGlob?: string }
  ): { claims: Claim[]; presence: Presence[] } {
    this.sweep();
    const claims: Claim[] = [];
    for (const c of this.claimById.values()) {
      if (c.repo !== repo) continue;
      if (scope?.regionId && c.regionId !== scope.regionId) continue;
      if (scope?.pathGlob && !matchAnchor(scope.pathGlob, c.anchor)) continue;
      claims.push(c);
    }
    const presence = [...this.presence.values()];
    return { claims, presence };
  }

  // ---- decisions bus (append-only, supersede chains) ----
  postDecision(d: {
    repo: string;
    scope: DecisionScope;
    kind: string;
    title: string;
    body: string;
    author: string;
    authorKind: Kind;
    supersedes?: string;
    tags?: string[];
    requestId: string;
  }): SimpleResult<{ decisionId: string; ord: number }> {
    const existing = [...this.decisions.values()].find((x) => x.decisionId === d.requestId);
    if (existing) return { ok: true, value: { decisionId: existing.decisionId, ord: existing.ord } };

    if (d.supersedes) {
      const prev = this.decisions.get(d.supersedes);
      if (!prev) {
        return { ok: false, error: err("SUPERSEDE_TARGET_MISSING", "TERMINAL", "Superseded decision not found.") };
      }
      if (prev.supersededBy) {
        return {
          ok: false,
          error: err("SUPERSEDE_RACE", "BLOCKED_RETRYABLE", "Target is no longer the chain head.", {
            remediation: ["wt_get_decisions to find the current head, then resupersede"],
          }),
        };
      }
    }

    const decisionId = randomUUID();
    const ord = this.nextOrd();
    const decision: Decision = {
      decisionId,
      repo: d.repo,
      scope: d.scope,
      kind: d.kind,
      title: d.title,
      body: d.body,
      author: d.author,
      authorKind: d.authorKind,
      supersedes: d.supersedes,
      tags: d.tags ?? [],
      ord,
      createdAt: this.now(),
    };
    this.decisions.set(decisionId, decision);
    if (d.supersedes) {
      const prev = this.decisions.get(d.supersedes)!;
      prev.supersededBy = decisionId;
    }
    this.persistSnapshot();
    return { ok: true, value: { decisionId, ord } };
  }

  getDecisions(
    repo: string,
    scope: DecisionScope,
    includeSuperseded = false
  ): Decision[] {
    const out: Decision[] = [];
    for (const d of this.decisions.values()) {
      if (d.repo !== repo) continue;
      if (!includeSuperseded && d.supersededBy) continue;
      if (!scopeIntersects(scope, d.scope)) continue;
      out.push(d);
    }
    out.sort((a, b) => a.ord - b.ord);
    return out;
  }

  stats() {
    this.sweep();
    return {
      exclusiveClaims: this.exclusiveByRegion.size,
      sharedRegions: this.sharedByRegion.size,
      decisions: this.decisions.size,
      presence: this.presence.size,
      fenceHighWater: this.fenceCounter,
    };
  }

  /** A complete, cross-repo snapshot for the awareness dashboard. */
  overview(decisionLimit = 40) {
    this.sweep();
    const claims = [...this.claimById.values()];
    const repos = new Set<string>(claims.map((c) => c.repo));
    const decisions = [...this.decisions.values()]
      .filter((d) => !d.supersededBy)
      .sort((a, b) => b.ord - a.ord)
      .slice(0, decisionLimit);
    for (const d of decisions) repos.add(d.repo);
    return {
      serverTime: this.now(),
      stats: {
        claims: claims.length,
        people: this.presence.size,
        decisions: this.decisions.size,
        repos: repos.size,
        fenceHighWater: this.fenceCounter,
      },
      claims: claims.map((c) => ({
        repo: c.repo,
        holder: c.holder,
        kind: c.kind,
        mode: c.mode,
        anchor: c.anchor,
        intent: c.intent,
        grantedAt: c.grantedAt,
        expiresAt: c.expiresAt,
      })),
      presence: [...this.presence.values()].map((p) => ({
        actorId: p.actorId,
        kind: p.kind,
        state: p.state,
        focus: p.focus,
        updatedAt: p.updatedAt,
      })),
      decisions: decisions.map((d) => ({
        decisionId: d.decisionId,
        repo: d.repo,
        scope: d.scope,
        kind: d.kind,
        title: d.title,
        body: d.body,
        author: d.author,
        authorKind: d.authorKind,
        createdAt: d.createdAt,
      })),
    };
  }
}

function matchAnchor(glob: string, anchor: string): boolean {
  // anchor is path or path#Symbol; match the path part
  const path = anchor.split("#")[0];
  const re = glob
    .split("**")
    .map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  const rx = new RegExp("^" + re + "$");
  return rx.test(path) || rx.test(anchor);
}

/** Decision retrieval scope-intersection: repo-scoped decisions are always relevant;
 *  region/node/task decisions match by id; a node scope also surfaces region decisions
 *  under it when the pathHint matches. */
function scopeIntersects(query: DecisionScope, decision: DecisionScope): boolean {
  if (decision.level === "repo") return true; // repo constraints always relevant (#49)
  if (decision.level === query.level && decision.id === query.id) return true;
  // node query should also see region decisions whose pathHint sits under the node, and vice-versa
  if (query.id && decision.id && query.id === decision.id) return true;
  if (query.pathHint && decision.pathHint && decision.pathHint.startsWith(query.pathHint)) return true;
  return false;
}
