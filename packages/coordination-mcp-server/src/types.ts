/**
 * Core domain types for the WorkingTogether coordination layer.
 * See docs/design/coordination-mcp.md for the full model.
 */

export type Kind = "agent" | "human";
export type Mode = "exclusive" | "shared";
export type Grain = "repo" | "node" | "region";
export type ErrorClass = "BLOCKED_RETRYABLE" | "TERMINAL";

/** A held claim on a region. The `fence` is the spine: it is monotonic across the
 *  whole store and must be presented (and validated) by the write path (invariant I12). */
export interface Claim {
  claimId: string;
  repo: string;
  regionId: string;
  nodeId: string; // symbol-less hash of the file path; the containment parent of region claims
  byteRange?: [number, number]; // advisory only — never hashed (region overlap fallback)
  requestId?: string; // owning request_id, so idempotency entries can be invalidated on release
  grain: Grain;
  anchor: string; // human-readable path or path#Symbol
  holder: string; // actorId
  kind: Kind;
  mode: Mode;
  fence: number;
  intent: string;
  grantedAt: number;
  expiresAt: number;
  ttlMs: number;
  heartbeatMs: number;
  holdCount: number; // reentrancy
  lastProgress: number; // high-water progress token (proof-of-agent-progress, §4.3)
}

export interface DecisionScope {
  level: "repo" | "node" | "region" | "task";
  id?: string; // nodeId | regionId | taskId
  pathHint?: string;
}

export interface Decision {
  decisionId: string;
  repo: string;
  scope: DecisionScope;
  kind: string; // constraint | convention | rationale | interface | ...
  title: string;
  body: string;
  author: string;
  authorKind: Kind;
  supersedes?: string;
  supersededBy?: string;
  tags: string[];
  ord: number; // monotonic order, never wall-clock for ordering
  createdAt: number;
}

export interface Presence {
  actorId: string;
  repo: string;
  kind: Kind;
  state: string; // idle | reading | thinking | editing | blocked-waiting | landing
  focus?: { regionId?: string; nodeId?: string; pathHint?: string; intent?: string };
  expiresAt: number;
  lastProgress: number;
  updatedAt: number;
}

export interface Identity {
  actorId: string;
  kind: Kind; // declared
  displayName?: string;
  contact?: string;
}

export interface ConflictInfo {
  regionId: string;
  holder: string;
  holderKind: Kind;
  intent: string;
}

export interface WtError {
  code: string;
  class: ErrorClass;
  message: string;
  retry_after_ms?: number;
  holder?: string;
  holder_kind?: Kind;
  intent?: string;
  fence_required_above?: number;
  remediation?: string[];
}

export type ClaimOutcome =
  | { result: "GRANTED"; claim: Claim }
  | { result: "WARN_PROCEED"; claim: Claim | null; conflicts: ConflictInfo[]; soft_fence: number }
  | { result: "BLOCKED"; error: WtError }
  | { result: "ERROR"; error: WtError };

export type SimpleResult<T> = { ok: true; value: T } | { ok: false; error: WtError };
