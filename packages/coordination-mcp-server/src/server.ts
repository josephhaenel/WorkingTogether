/**
 * Builds an McpServer exposing the hive_* coordination tool surface over a shared
 * CoordinationStore. A fresh McpServer is built per HTTP request (stateless
 * transport), but every tool closes over the SAME store, so state is shared
 * across all connected agents/machines.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CoordinationStore } from "./store.js";
import type { ClaimOutcome, WtError } from "./types.js";
import {
  announceShape,
  claimShape,
  getDecisionsShape,
  askDecisionsShape,
  captureShape,
  heartbeatShape,
  postDecisionShape,
  registerShape,
  releaseShape,
  resolveRegionShape,
  whosEditingShape,
} from "./schemas.js";

function ok(payload: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

function fail(error: WtError): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(error, null, 2) }],
    structuredContent: error as unknown as Record<string, unknown>,
    isError: true,
  };
}

/** Map a claim outcome to an MCP tool result. */
function claimResult(o: ClaimOutcome): CallToolResult {
  switch (o.result) {
    case "GRANTED":
      return ok({
        result: "GRANTED",
        claim_id: o.claim.claimId,
        fence: o.claim.fence,
        region_id: o.claim.regionId,
        ttl_ms: o.claim.ttlMs,
        heartbeat_ms: o.claim.heartbeatMs,
        message: `Granted exclusive claim on '${o.claim.anchor}'. Present this fence on every write; heartbeat within ttl_ms with an advancing progress_token.`,
        decisions: o.decisions.map((d) => ({
          kind: d.kind,
          title: d.title,
          body: d.body,
          author: d.author,
          scope: d.scope,
        })),
      });
    case "WARN_PROCEED":
      return ok({
        result: "WARN_PROCEED",
        soft_fence: o.soft_fence,
        conflicts: o.conflicts,
        message:
          "A human is involved on this region. You may proceed, but your edit may become a tracked conflict. Coordinate via hive_whos_editing.",
        decisions: o.decisions.map((d) => ({
          kind: d.kind,
          title: d.title,
          body: d.body,
          author: d.author,
          scope: d.scope,
        })),
      });
    case "BLOCKED":
    case "ERROR":
      return fail(o.error);
  }
}

export function buildServer(store: CoordinationStore): McpServer {
  const server = new McpServer({ name: "hive-coordination-mcp-server", version: "0.1.0" });

  server.registerTool(
    "hive_resolve_region",
    {
      title: "Resolve a claimable region id",
      description:
        "Resolve a (repo, path[, symbol]) into a stable, structurally-anchored regionId you can claim. Region grain when a symbol is given, file grain otherwise. Pure / read-only.",
      inputSchema: resolveRegionShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo, path, symbol }) => ok(store.resolveRegion(repo, path, symbol))
  );

  server.registerTool(
    "hive_register",
    {
      title: "Register an actor's identity",
      description:
        "Register an actorId as an 'agent' or 'human'. Party drives the collision policy (agent-vs-agent hard-blocks; human-involved soft-warns). Idempotent per actorId.",
      inputSchema: registerShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ actorId, kind, display_name, contact }) => {
      store.registerIdentity({ actorId, kind, displayName: display_name, contact });
      return ok({ ok: true, actorId, kind });
    }
  );

  server.registerTool(
    "hive_claim",
    {
      title: "Claim a region before editing",
      description:
        "Claim a region BEFORE you write to it. Provide regionId (from hive_resolve_region) OR path[,symbol]. On GRANTED you receive a monotonic `fence` and a claim_id — present the fence on writes and heartbeat to keep the lease. On REGION_CLAIMED (class BLOCKED_RETRYABLE) another agent holds it: do other work and retry after retry_after_ms, or hive_handoff. On WARN_PROCEED a human is involved: you may proceed but may create a tracked conflict. Errors of class TERMINAL must not be spin-retried.",
      inputSchema: claimShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      let regionId = a.regionId;
      let nodeId: string;
      let anchor = a.path ?? a.regionId ?? "";
      let grain: "repo" | "node" | "region" = a.symbol ? "region" : a.path ? "node" : "region";
      if (!regionId) {
        if (!a.path) {
          return fail({
            code: "MISSING_TARGET",
            class: "TERMINAL",
            message: "Provide either regionId or path[,symbol].",
          });
        }
        const r = store.resolveRegion(a.repo, a.path, a.symbol);
        regionId = r.regionId;
        nodeId = r.nodeId;
        anchor = r.anchor;
        grain = r.grain;
      } else {
        // opaque regionId supplied directly; derive nodeId from path when available
        nodeId = a.path ? store.resolveRegion(a.repo, a.path).nodeId : regionId;
      }
      return claimResult(
        store.claim({
          repo: a.repo,
          regionId,
          nodeId,
          anchor,
          grain,
          path: a.path,
          actorId: a.actorId,
          origin: a.origin,
          mode: a.mode,
          intent: a.intent,
          requestId: a.request_id,
          progressToken: a.progress_token,
          force: a.force,
        })
      );
    }
  );

  server.registerTool(
    "hive_release",
    {
      title: "Release a claim",
      description:
        "Release a claim you hold, by claim_id + fence. Idempotent. A stale fence returns FENCE_REJECTED (TERMINAL) — the claim was already reclaimed or handed off.",
      inputSchema: releaseShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ claim_id, fence }) => {
      const r = store.release(claim_id, fence);
      return r.ok ? ok({ ok: true, ...r.value }) : fail(r.error);
    }
  );

  server.registerTool(
    "hive_heartbeat",
    {
      title: "Heartbeat a held claim",
      description:
        "Extend a claim's lease. You MUST advance progress_token to actually extend it — a heartbeat without progress will not keep a lease alive (so a stalled/dead agent auto-releases). Returns FENCE_REJECTED (TERMINAL) if the lease was lost; re-claim before writing again.",
      inputSchema: heartbeatShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ claim_id, fence, progress_token }) => {
      const r = store.heartbeat(claim_id, fence, progress_token);
      return r.ok ? ok({ ok: true, ...r.value }) : fail(r.error);
    }
  );

  server.registerTool(
    "hive_whos_editing",
    {
      title: "See who is editing what",
      description:
        "List active claims and live presence for a repo (optionally scoped by region_id or path_glob). Read-only awareness; use before starting work to avoid collisions.",
      inputSchema: whosEditingShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ repo, region_id, path_glob }) => {
      const { claims, presence } = store.whosEditing(repo, { regionId: region_id, pathGlob: path_glob });
      return ok({
        claims: claims.map((c) => ({
          region_id: c.regionId,
          anchor: c.anchor,
          holder: c.holder,
          kind: c.kind,
          mode: c.mode,
          intent: c.intent,
          expires_in_ms: Math.max(0, c.expiresAt - Date.now()),
        })),
        presence: presence.map((p) => ({ actorId: p.actorId, kind: p.kind, state: p.state, focus: p.focus })),
      });
    }
  );

  server.registerTool(
    "hive_announce",
    {
      title: "Publish presence",
      description:
        "Publish ephemeral presence (what you're doing / focused on). Expires after ttl_ms unless re-announced. Used for live awareness, not enforcement.",
      inputSchema: announceShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      store.announce({
        actorId: a.actorId,
        repo: a.repo,
        kind: a.kind,
        state: a.state,
        focus:
          a.focus_path || a.focus_symbol || a.intent
            ? { pathHint: a.focus_path, intent: a.intent }
            : undefined,
        lastProgress: a.progress_token ?? 0,
        ttlMs: a.ttl_ms,
      });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "hive_post_decision",
    {
      title: "Post a shared decision",
      description:
        "Append an immutable decision to the shared bus (constraint/convention/rationale/interface/...), scoped to repo|node|region|task so teammates' agents retrieve the few that matter. Use `supersedes` to replace a prior decision (append-only supersede chain). Idempotent per request_id.",
      inputSchema: postDecisionShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const r = store.postDecision({
        repo: a.repo,
        scope: { level: a.scope_level, id: a.scope_id, pathHint: a.path_hint },
        kind: a.kind,
        title: a.title,
        body: a.body,
        author: a.author,
        authorKind: a.author_kind,
        supersedes: a.supersedes,
        tags: a.tags,
        requestId: a.request_id,
      });
      return r.ok ? ok({ ok: true, ...r.value }) : fail(r.error);
    }
  );

  server.registerTool(
    "hive_get_decisions",
    {
      title: "Get relevant shared decisions",
      description:
        "Retrieve the decisions relevant to a scope (repo|node|region|task). Returns chain-heads only by default (superseded ones hidden). Repo-scoped decisions are always included. Read before you claim/edit.",
      inputSchema: getDecisionsShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const decisions = store.getDecisions(
        a.repo,
        { level: a.scope_level, id: a.scope_id, pathHint: a.path_hint },
        a.include_superseded
      );
      return ok({
        count: decisions.length,
        decisions: decisions.map((d) => ({
          id: d.decisionId,
          scope: d.scope,
          kind: d.kind,
          title: d.title,
          body: d.body,
          author: d.author,
          tags: d.tags,
          superseded: Boolean(d.supersededBy),
        })),
      });
    }
  );

  server.registerTool(
    "hive_capture",
    {
      title: "List your recent edits that have no recorded decision",
      description:
        "Returns the files/symbols you've recently edited that don't yet have a shared decision. After a deliberate convention/constraint/interface choice, use this to find what to record via hive_post_decision (so the team's agents pick it up).",
      inputSchema: captureShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const captures = store.recentCaptures(a.repo, a.actorId);
      return ok({ count: captures.length, captures });
    }
  );

  server.registerTool(
    "hive_ask",
    {
      title: "Ask the shared brain a question",
      description:
        "Keyword search over the team's recorded decisions (constraints/conventions/interfaces) relevant to a scope. Use it to answer 'what's our convention for X?' before deciding how to implement. Keyword retrieval over a curated corpus — not semantic search.",
      inputSchema: askDecisionsShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a) => {
      const scope = a.scope_level ? { level: a.scope_level, id: a.scope_id, pathHint: a.path_hint } : undefined;
      const decisions = store.askDecisions(a.repo, a.query, scope, a.limit);
      return ok({
        count: decisions.length,
        query: a.query,
        decisions: decisions.map((d) => ({
          id: d.decisionId,
          scope: d.scope,
          kind: d.kind,
          title: d.title,
          body: d.body,
          author: d.author,
          tags: d.tags,
        })),
      });
    }
  );

  return server;
}
