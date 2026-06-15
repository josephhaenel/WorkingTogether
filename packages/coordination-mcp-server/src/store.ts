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
  DecisionConflict,
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
  nodeId: string; // hash of the path alone (the containment parent)
  anchor: string;
  grain: Grain;
  symbol: string | null;
}

export interface ClaimRequest {
  repo: string;
  regionId: string;
  nodeId: string; // symbol-less hash of the path (containment parent); === regionId for node grain
  byteRange?: [number, number];
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

// Auto-inject: at most this many shared decisions ride along on a single claim grant.
const AUTO_INJECT_CAP = 5;
// Surface the most binding kinds first so a hard constraint is never crowded out of the cap by a soft note.
const KIND_RANK: Record<string, number> = { constraint: 0, interface: 1, convention: 2, rationale: 3, note: 4 };
const kindRank = (kind: string): number => KIND_RANK[kind] ?? 9;

// ---- dependency-free decision retrieval (`hive ask`) ----
// Keyword search over a small, curated corpus. NOT semantic Q&A — scope-filtered
// coverage ranking with light stemming + a tiny dev-synonym map. Coverage is the
// primary signal (how many query terms a decision matches, weighted by field), which
// stays stable at the tens-of-items corpus sizes where BM25's IDF degenerates.
const ASK_CANDIDATE_CAP = 500;
const ASK_STOPWORDS = new Set(
  "a an and are as at be by do does for from how in into is it of on or our should that the to use using we what when where which with you your".split(" ")
);
const ASK_SYNONYMS: string[][] = [
  ["error", "exception", "throw", "fail", "failure"],
  ["auth", "authentication", "authenticate", "login", "signin"],
  ["config", "configuration", "configure", "setting"],
  ["async", "asynchronous", "concurrent", "concurrency", "await", "promise"],
  ["dep", "dependency", "package", "module", "import"],
  ["db", "database", "sql", "query", "persistence"],
  ["test", "testing", "spec", "fixture"],
  ["type", "typing", "interface", "schema"],
];
function askStem(t: string): string {
  for (const suf of ["ing", "ies", "ed", "es", "s"]) {
    if (t.length > suf.length + 2 && t.endsWith(suf)) return t.slice(0, -suf.length);
  }
  return t;
}
function askTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !ASK_STOPWORDS.has(t))
    .map(askStem);
}
const ASK_SYN_INDEX: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const group of ASK_SYNONYMS) {
    const stemmed = [...new Set(group.map(askStem))];
    for (const w of stemmed) m.set(w, stemmed);
  }
  return m;
})();
/** Stemmed query tokens, expanded with synonym-group members for better recall. */
function askExpandQuery(query: string): Set<string> {
  const out = new Set<string>();
  for (const t of askTokenize(query)) {
    out.add(t);
    for (const w of ASK_SYN_INDEX.get(t) ?? []) out.add(w);
  }
  return out;
}
// ---- self-consistency: conservative, advisory conflict detection ----
// Two decisions "conflict" when they sit on opposite sides of a known dev-axis.
// We flag ONLY on an antonym-pair flip (NOT bare negation, which fires on every
// legitimate supersede) within the same decision family — deliberately high-precision,
// low-recall: a wrong "may contradict" erodes trust in the bus faster than a missed one.
const ANTONYM_PAIRS: Array<[string, string]> = [
  ["tab", "space"],
  ["sync", "async"],
  ["allow", "deny"],
  ["allow", "forbid"],
  ["enable", "disable"],
  ["required", "optional"],
  ["camelcase", "snakecase"],
  ["rest", "graphql"],
  ["accept", "reject"],
  ["include", "exclude"],
  ["always", "never"],
];
// Raw (un-stemmed) tokens for antonym matching — stemming is too lossy here
// ("spaces" must still match the antonym term "space"), so we keep words intact and
// tolerate a trailing plural -s in the membership check below.
function conflictTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));
}
function hasTerm(tokens: Set<string>, term: string): boolean {
  return tokens.has(term) || tokens.has(term + "s");
}

/** Coarse kind family — a directive can only contradict another directive, an
 *  interface another interface; rationale (pure explanation) never conflicts. */
function decisionFamily(kind: string): "policy" | "interface" | null {
  if (kind === "interface") return "interface";
  if (kind === "constraint" || kind === "convention" || kind === "note" || kind === "todo") return "policy";
  return null; // rationale / unknown — not a directive, skip conflict checks
}

/** Coverage score: each distinct query token contributes its best matching field
 *  weight (title 3 > kind/tags 2 > body 1), plus a small term-frequency bonus. */
function askScore(qTokens: Set<string>, d: Decision): number {
  const fields: Array<[string, number]> = [
    [d.title, 3],
    [d.kind, 2],
    [(d.tags ?? []).join(" "), 2],
    [d.body, 1],
  ];
  const bestWeight = new Map<string, number>();
  const tf = new Map<string, number>();
  for (const [text, w] of fields) {
    for (const tok of askTokenize(text)) {
      if (!qTokens.has(tok)) continue;
      bestWeight.set(tok, Math.max(bestWeight.get(tok) ?? 0, w));
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
  }
  let score = 0;
  for (const [tok, w] of bestWeight) score += w + Math.min(tf.get(tok) ?? 0, 3) * 0.1;
  return score;
}

export class CoordinationStore {
  private fenceCounter = 0;
  private ordCounter = 0;
  private exclusiveByRegion = new Map<string, Claim>(); // storage/release index by regionId
  private sharedByRegion = new Map<string, Map<string, Claim>>(); // regionId -> actorId -> claim
  // containment index: nodeId(file) -> its whole-file claim + per-symbol region claims.
  // This is what enforces repo ⊃ node ⊃ region without ever un-hashing a regionId.
  private byNode = new Map<string, { nodeClaim?: Claim; regionClaims: Map<string, Claim> }>();
  private claimById = new Map<string, Claim>();
  private decisions = new Map<string, Decision>();
  private presence = new Map<string, Presence>(); // keyed by actorId
  private identity = new Map<string, Identity>();
  private idempotency = new Map<string, ClaimOutcome>();
  // Per-actor set of decisionIds already auto-injected, so a re-claim stays quiet.
  // Ephemeral + per-process + independent of the claim lifecycle ON PURPOSE: the
  // PostToolUse hook releases (and tears down) a claim after every edit, so any
  // dedup tied to claims would reset each edit and re-spam. Cleared only on restart.
  private decisionsSeen = new Map<string, Set<string>>();
  // Same idea, for the WARN_PROCEED path; disjoint from decisionsSeen (see decisionsForWarn).
  private warnSeen = new Map<string, Set<string>>();
  // requestId -> the decision result it produced, so a retried postDecision replays
  // (ephemeral, per-process — mirrors the claim idempotency map).
  private decisionByRequest = new Map<string, { decisionId: string; ord: number; conflicts?: DecisionConflict[] }>();
  // Self-populating capture: a bounded, ephemeral per-(repo,actor) ring of recently
  // edited anchors — a free byproduct of the claims the actor already makes (no hook
  // change, no file read, no file content). `hive capture` surfaces the ones with no
  // decision yet so the agent can record one. Never persisted.
  private captures = new Map<string, { anchor: string; path: string; nodeId: string; intent: string; at: number }[]>();
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
    const hash = (s: string) =>
      createHash("sha256")
        .update(`${repo}${String.fromCharCode(0)}${s}`) // NUL delimiter — cannot appear in a repo id or path
        .digest("hex")
        .slice(0, 32);
    // regionId hashes the full anchor (path or path#symbol); nodeId hashes the path
    // alone so the store can enforce node ⊃ region without un-hashing anything.
    return { regionId: hash(anchor), nodeId: hash(path), anchor, grain, symbol: symbol ?? null };
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
    // route every expiry through removeClaim so ALL indexes (exclusiveByRegion,
    // byNode, idempotency, shared) stay consistent — no phantom-block leaks.
    for (const c of [...this.claimById.values()]) {
      if (c.expiresAt <= t) this.removeClaim(c);
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
            `Actor '${req.actorId}' is not registered; enforcing regions require registration. Call hive_register first.`,
            { remediation: ["hive_register"] }
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
      this.touchPresence(req, effectiveKind);
      return this.remember(req.requestId, { result: "GRANTED", claim, decisions: this.decisionsForGrant(req) });
    }

    // exclusive — reentrant fast path: same actor re-claiming the exact same region/node
    const ownExact = this.exclusiveByRegion.get(req.regionId);
    if (ownExact && ownExact.holder === req.actorId) {
      ownExact.holdCount += 1;
      ownExact.expiresAt = this.now() + ownExact.ttlMs;
      if (req.progressToken && req.progressToken > ownExact.lastProgress) {
        ownExact.lastProgress = req.progressToken;
      }
      this.touchPresence(req, ownExact.kind);
      return this.remember(req.requestId, { result: "GRANTED", claim: ownExact, decisions: this.decisionsForGrant(req) });
    }

    // lattice conflict check (repo ⊃ node ⊃ region), excluding our own claims
    const existing = this.findConflicting(req);
    if (existing) {
      const verdict = decide(effectiveKind, existing.kind, pol);
      if (verdict === "BLOCKED") {
        const retry = Math.max(0, existing.expiresAt - this.now());
        return this.remember(req.requestId, {
          result: "BLOCKED",
          error: err(
            "REGION_CLAIMED",
            "BLOCKED_RETRYABLE",
            `'${req.anchor}' is held by '${existing.holder}' (${existing.kind}) via '${existing.anchor}': ${existing.intent}`,
            {
              holder: existing.holder,
              holder_kind: existing.kind,
              intent: existing.intent,
              retry_after_ms: retry,
              remediation: ["hive_whos_editing", "hive_handoff", "retry after retry_after_ms"],
            }
          ),
        });
      }
      // WARN_PROCEED (human involved): no lock taken; the write proceeds and is
      // conflict-marked later. Return a soft fence for tracing.
      const conflicts: ConflictInfo[] = [
        { regionId: existing.regionId, holder: existing.holder, holderKind: existing.kind, intent: existing.intent },
      ];
      this.touchPresence(req, effectiveKind);
      return this.remember(req.requestId, {
        result: "WARN_PROCEED",
        claim: null,
        conflicts,
        soft_fence: this.nextFence(),
        decisions: this.decisionsForWarn(req),
      });
    }

    // free — grant + index
    const claim = this.mintClaim(req, "exclusive", effectiveKind, pol);
    this.exclusiveByRegion.set(req.regionId, claim);
    this.claimById.set(claim.claimId, claim);
    this.indexClaim(claim);
    this.touchPresence(req, effectiveKind);
    return this.remember(req.requestId, { result: "GRANTED", claim, decisions: this.decisionsForGrant(req) });
  }

  /** The shared decisions to push to the actor at the moment a claim is GRANTED —
   *  the "shared brain" reaching the agent right when it matters, instead of waiting
   *  to be asked. Queried at NODE scope with a path-only pathHint so a symbol-level
   *  claim still surfaces the FILE's (and repo's) conventions, not just the exact
   *  region. Deduped per-actor by decisionId so a re-claim is silent; only the SHOWN
   *  heads are marked seen, so cap-dropped ones surface on a later claim rather than
   *  being suppressed forever. Most-binding kinds first. SIDE-EFFECTING. */
  private decisionsForGrant(req: ClaimRequest): Decision[] {
    this.recordCapture(req);
    return this.collectDecisions(req, this.decisionsSeen);
  }

  private static CAPTURE_CAP = 20;
  /** Remember that an actor just edited this anchor (called on every grant). Newest
   *  wins per anchor; bounded ring per (repo, actor); ephemeral. */
  private recordCapture(req: ClaimRequest): void {
    const key = req.repo + String.fromCharCode(0) + req.actorId;
    const buf = (this.captures.get(key) ?? []).filter((c) => c.anchor !== req.anchor);
    buf.push({ anchor: req.anchor, path: req.path ?? req.anchor.split("#")[0], nodeId: req.nodeId, intent: req.intent, at: this.now() });
    while (buf.length > CoordinationStore.CAPTURE_CAP) buf.shift();
    this.captures.set(key, buf);
  }

  /** Recent edits by this actor that have NO recorded decision yet — capture
   *  candidates for `hive capture`. Most-recent first. */
  recentCaptures(repo: string, actorId: string): { anchor: string; path: string; intent: string }[] {
    const buf = this.captures.get(repo + String.fromCharCode(0) + actorId) ?? [];
    return [...buf]
      .reverse()
      .filter((c) => this.getDecisions(repo, { level: "node", id: c.nodeId, pathHint: c.path }).length === 0)
      .map((c) => ({ anchor: c.anchor, path: c.path, intent: c.intent }));
  }

  /** Same shared decisions, for the WARN_PROCEED (human-holds-the-region) path.
   *  Uses a SEPARATE per-actor seen set (warnSeen), disjoint from decisionsSeen, so:
   *  (a) a sustained human-held region injects its decisions ONCE per actor, not on
   *  every edit (no spam while waiting on a human); and (b) the eventual real GRANT
   *  can still inject + mark them via the grant set independently. */
  private decisionsForWarn(req: ClaimRequest): Decision[] {
    this.recordCapture(req); // the agent proceeds to edit on a warn too
    return this.collectDecisions(req, this.warnSeen);
  }

  private collectDecisions(req: ClaimRequest, seenByActor: Map<string, Set<string>>): Decision[] {
    const pathOnly = req.anchor.split("#")[0];
    const relevant = this.getDecisions(req.repo, { level: "node", id: req.nodeId, pathHint: pathOnly });
    if (relevant.length === 0) return [];
    let seen = seenByActor.get(req.actorId);
    if (!seen) {
      seen = new Set<string>();
      seenByActor.set(req.actorId, seen);
    }
    const fresh = relevant.filter((d) => !seen!.has(d.decisionId));
    if (fresh.length === 0) return [];
    fresh.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || b.ord - a.ord);
    const shown = fresh.slice(0, AUTO_INJECT_CAP);
    for (const d of shown) seen.add(d.decisionId);
    return shown;
  }

  /** Lattice conflict check on the structural anchor (never un-hashes a regionId):
   *  repo covers all; node(file) covers itself + every region in it; a region
   *  conflicts with the same region + its covering node, but NOT a sibling region.
   *  A node-grain query conflicts with ANY held region in that file (safe over-block,
   *  used by the daemon's enforcement check which only knows the path). Own-actor
   *  claims never conflict (reentrancy across grains). */
  private findConflicting(req: {
    repo: string;
    nodeId: string;
    regionId: string;
    grain: Grain;
    actorId: string;
  }): Claim | null {
    const b = this.byNode.get(req.nodeId);
    if (!b) return null;
    if (b.nodeClaim && b.nodeClaim.holder !== req.actorId) return b.nodeClaim; // node covers everything in the file
    if (req.grain === "node" || req.grain === "repo") {
      for (const r of b.regionClaims.values()) if (r.holder !== req.actorId) return r; // over-block on file-grain query
      return null;
    }
    const same = b.regionClaims.get(req.regionId); // region-vs-same-region (siblings differ → no conflict)
    if (same && same.holder !== req.actorId) return same;
    return null;
  }

  private indexClaim(c: Claim): void {
    let b = this.byNode.get(c.nodeId);
    if (!b) {
      b = { regionClaims: new Map() };
      this.byNode.set(c.nodeId, b);
    }
    if (c.grain === "node" || c.grain === "repo") b.nodeClaim = c;
    else b.regionClaims.set(c.regionId, c);
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
      nodeId: req.nodeId,
      byteRange: req.byteRange,
      requestId: req.requestId,
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

  /** Non-mutating lattice check used by the daemon write path (§4.2 / [D-46]) to
   *  gate edits that bypass the hook. The daemon only knows the path (node grain),
   *  so a node-grain query conservatively conflicts with ANY held sub-region —
   *  it over-blocks rather than ever under-blocking. */
  canWrite(target: { repo: string; nodeId: string; regionId: string; grain: Grain; actorId: string }): {
    allowed: boolean;
    holder?: string;
    holderKind?: Kind;
  } {
    this.sweep();
    const c = this.findConflicting(target);
    if (!c) return { allowed: true };
    return { allowed: false, holder: c.holder, holderKind: c.kind };
  }

  /** Release all of `actorId`'s exclusive claims under a file (node). The
   *  PostToolUse hook knows repo+actor+path but not which symbol it claimed, so
   *  releasing by node is robust to grain drift / symbol rename between pre & post.
   *  Honors holdCount (mirrors release()). */
  releaseByNode(nodeId: string, actorId: string): { released: number } {
    this.sweep();
    const b = this.byNode.get(nodeId);
    if (!b) return { released: 0 };
    const mine: Claim[] = [];
    if (b.nodeClaim && b.nodeClaim.holder === actorId) mine.push(b.nodeClaim);
    for (const r of b.regionClaims.values()) if (r.holder === actorId) mine.push(r);
    let released = 0;
    for (const c of mine) {
      c.holdCount -= 1;
      if (c.holdCount <= 0) {
        this.removeClaim(c);
        released++;
      }
    }
    return { released };
  }

  private removeClaim(c: Claim): void {
    this.claimById.delete(c.claimId);
    // invalidate any idempotency entry that replays this (now-gone) GRANTED outcome
    if (c.requestId) this.idempotency.delete(c.requestId);
    if (c.mode === "exclusive") {
      if (this.exclusiveByRegion.get(c.regionId)?.claimId === c.claimId) {
        this.exclusiveByRegion.delete(c.regionId);
      }
      const b = this.byNode.get(c.nodeId);
      if (b) {
        if ((c.grain === "node" || c.grain === "repo") && b.nodeClaim?.claimId === c.claimId) b.nodeClaim = undefined;
        else if (b.regionClaims.get(c.regionId)?.claimId === c.claimId) b.regionClaims.delete(c.regionId);
        if (!b.nodeClaim && b.regionClaims.size === 0) this.byNode.delete(c.nodeId);
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
      repo: p.repo,
      kind: p.kind,
      state: p.state,
      focus: p.focus,
      expiresAt: now + p.ttlMs,
      lastProgress: p.lastProgress,
      updatedAt: now,
    });
  }

  /** Claiming a region IS an act of presence — light up "editing <anchor>" so the
   *  dashboard shows who's working where without any extra round-trip. TTL'd. */
  private touchPresence(req: ClaimRequest, kind: Kind): void {
    const now = this.now();
    this.presence.set(req.actorId, {
      actorId: req.actorId,
      repo: req.repo,
      kind,
      state: "editing",
      focus: { pathHint: req.anchor, intent: req.intent },
      expiresAt: now + 30_000,
      lastProgress: req.progressToken ?? 0,
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
    const presence = [...this.presence.values()].filter((p) => p.repo === repo);
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
  }): SimpleResult<{ decisionId: string; ord: number; conflicts?: DecisionConflict[] }> {
    // idempotency: a retried request_id replays the exact same result (incl. conflicts)
    const replay = this.decisionByRequest.get(d.requestId);
    if (replay) return { ok: true, value: replay };

    if (d.supersedes) {
      const prev = this.decisions.get(d.supersedes);
      if (!prev) {
        return { ok: false, error: err("SUPERSEDE_TARGET_MISSING", "TERMINAL", "Superseded decision not found.") };
      }
      if (prev.supersededBy) {
        return {
          ok: false,
          error: err("SUPERSEDE_RACE", "BLOCKED_RETRYABLE", "Target is no longer the chain head.", {
            remediation: ["hive_get_decisions to find the current head, then resupersede"],
          }),
        };
      }
    }

    const conflicts = this.detectConflicts(d);
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
    const value = { decisionId, ord, conflicts: conflicts.length ? conflicts : undefined };
    this.decisionByRequest.set(d.requestId, value);
    return { ok: true, value };
  }

  /** Advisory only — never blocks a post. Flags live heads in the same repo + decision
   *  family that sit on the OPPOSITE side of a known dev-axis (the antonym table), so the
   *  author can supersede instead of leaving two contradictory rules live. A legitimate
   *  supersede (d.supersedes targeting the head) is never flagged. */
  private detectConflicts(d: {
    repo: string;
    kind: string;
    title: string;
    body: string;
    supersedes?: string;
  }): DecisionConflict[] {
    const family = decisionFamily(d.kind);
    if (!family) return [];
    const mine = conflictTokens(`${d.title} ${d.body}`);
    if (mine.size === 0) return [];
    const out: DecisionConflict[] = [];
    for (const h of this.decisions.values()) {
      if (h.repo !== d.repo || h.supersededBy) continue; // live heads only
      if (h.decisionId === d.supersedes) continue; // replacing it is not a conflict
      if (decisionFamily(h.kind) !== family) continue;
      const theirs = conflictTokens(`${h.title} ${h.body}`);
      const flip = ANTONYM_PAIRS.find(
        ([x, y]) => (hasTerm(mine, x) && hasTerm(theirs, y)) || (hasTerm(mine, y) && hasTerm(theirs, x))
      );
      if (flip) {
        out.push({ decisionId: h.decisionId, title: h.title, reason: `opposite stance (${flip[0]} vs ${flip[1]}) to a live decision` });
      }
    }
    return out;
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

  /** `hive ask`: keyword search over the live decisions relevant to a scope, ranked by
   *  query-token coverage. Returns [] when nothing matches (rather than noise). This is
   *  keyword retrieval over a curated corpus, NOT semantic Q&A — see the helpers above. */
  askDecisions(repo: string, query: string, scope?: DecisionScope, limit = 5): Decision[] {
    const qTokens = askExpandQuery(query);
    if (qTokens.size === 0) return [];
    const candidates = this.getDecisions(repo, scope ?? { level: "repo" });
    // bound worst-case work on a large corpus: score only the most-recent heads
    const pool = candidates.length > ASK_CANDIDATE_CAP ? candidates.slice(-ASK_CANDIDATE_CAP) : candidates;
    return pool
      .map((d) => ({ d, s: askScore(qTokens, d) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || kindRank(a.d.kind) - kindRank(b.d.kind) || b.d.ord - a.d.ord)
      .slice(0, limit)
      .map((x) => x.d);
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
        repo: p.repo,
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
  // ...only at a real boundary ("#" symbol / "/" dir) so "src/a.ts" doesn't match "src/a.tsx".
  if (query.pathHint && decision.pathHint) {
    const q = query.pathHint;
    if (decision.pathHint === q || decision.pathHint.startsWith(q + "#") || decision.pathHint.startsWith(q + "/")) {
      return true;
    }
  }
  return false;
}
