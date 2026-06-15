/**
 * Zod input shapes for the hive_* tool surface. registerTool() takes a raw shape
 * (a plain object of zod fields), so these are exported as shapes, not z.object().
 */

import { z } from "zod";

export const resolveRegionShape = {
  repo: z.string().min(1).describe("Repository id (e.g. 'org/name' or an absolute path)."),
  path: z.string().min(1).describe("File path relative to repo root."),
  symbol: z.string().optional().describe("Optional symbol/function path within the file (e.g. 'Foo::bar'). Omit to claim the whole file."),
};

export const claimShape = {
  repo: z.string().min(1),
  actorId: z.string().min(1).describe("Stable per-machine actor id."),
  origin: z.enum(["agent", "human"]).describe("Who is making this edit. The hook stamps 'agent'; the watcher/manual path stamps 'human'."),
  intent: z.string().min(1).max(280).describe("One line: what you're about to do here."),
  regionId: z.string().optional().describe("Region id from hive_resolve_region. Provide this OR (path[, symbol])."),
  path: z.string().optional().describe("File path; used if regionId is omitted (and for per-glob policy)."),
  symbol: z.string().optional(),
  mode: z.enum(["exclusive", "shared"]).default("exclusive"),
  request_id: z.string().min(1).describe("Idempotency guid; a retried request returns the same outcome."),
  progress_token: z.number().int().nonnegative().optional().describe("Monotonic per-actor counter proving the agent (not just the daemon) is alive."),
  force: z.boolean().default(false),
};

export const releaseShape = {
  claim_id: z.string().min(1),
  fence: z.number().int().nonnegative(),
};

export const heartbeatShape = {
  claim_id: z.string().min(1),
  fence: z.number().int().nonnegative(),
  progress_token: z.number().int().nonnegative().optional().describe("Advance this to extend the lease; absent/stale progress will NOT extend it."),
};

export const whosEditingShape = {
  repo: z.string().min(1),
  region_id: z.string().optional(),
  path_glob: z.string().optional().describe("Glob over file paths, e.g. 'src/**'."),
};

export const announceShape = {
  repo: z.string().min(1),
  actorId: z.string().min(1),
  kind: z.enum(["agent", "human"]),
  state: z.enum(["idle", "reading", "thinking", "editing", "blocked-waiting", "landing"]),
  focus_path: z.string().optional(),
  focus_symbol: z.string().optional(),
  intent: z.string().max(280).optional(),
  ttl_ms: z.number().int().min(1000).max(120000).default(30000),
  progress_token: z.number().int().nonnegative().optional(),
};

export const postDecisionShape = {
  repo: z.string().min(1),
  scope_level: z.enum(["repo", "node", "region", "task"]).default("repo"),
  scope_id: z.string().optional().describe("nodeId | regionId | taskId for non-repo scopes."),
  path_hint: z.string().optional(),
  kind: z.enum(["constraint", "convention", "rationale", "interface", "todo", "note"]).default("note"),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(4000),
  author: z.string().min(1),
  author_kind: z.enum(["agent", "human"]),
  supersedes: z.string().optional().describe("decisionId this replaces (append-only supersede chain)."),
  tags: z.array(z.string()).optional(),
  request_id: z.string().min(1),
};

export const getDecisionsShape = {
  repo: z.string().min(1),
  scope_level: z.enum(["repo", "node", "region", "task"]).default("repo"),
  scope_id: z.string().optional(),
  path_hint: z.string().optional(),
  include_superseded: z.boolean().default(false),
};

export const askDecisionsShape = {
  repo: z.string().min(1),
  query: z.string().min(1).describe("Natural-language question, e.g. 'what's our error-handling convention?'. Keyword search over decisions (not semantic)."),
  scope_level: z.enum(["repo", "node", "region", "task"]).optional(),
  scope_id: z.string().optional(),
  path_hint: z.string().optional().describe("Narrow to a file/symbol's decisions; omit to search the whole repo."),
  limit: z.number().int().min(1).max(20).default(5),
};

export const captureShape = {
  repo: z.string().min(1),
  actorId: z.string().min(1),
};

export const registerShape = {
  actorId: z.string().min(1),
  kind: z.enum(["agent", "human"]),
  display_name: z.string().optional(),
  contact: z.string().optional(),
};
