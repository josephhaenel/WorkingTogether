#!/usr/bin/env node
/**
 * WorkingTogether coordination MCP server — entry point.
 *
 * Runs ONE long-lived HTTP process that all machines connect to. This is
 * deliberate: the coordination store must be shared across clients, so stdio
 * (one server per client) would defeat the purpose. The single process is the
 * linearizable coordination store.
 *
 *   POST /mcp        — the MCP (Streamable HTTP, stateless JSON) endpoint for agents
 *   POST /v1/claim   — thin REST shim for hooks/daemons (Claude Code PreToolUse)
 *   POST /v1/release — thin REST shim
 *   GET  /v1/whos_editing
 *   GET  /healthz
 */

import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CoordinationStore } from "./store.js";
import { buildServer } from "./server.js";
import type { DecisionScope, Kind, Mode } from "./types.js";

const PORT = parseInt(process.env.PORT || "4100", 10);
const ENFORCE_REGISTRATION = process.env.WT_ENFORCE_REGISTRATION === "1";
const DATA_DIR = process.env.WT_DATA_DIR; // if set, decisions + identity persist here

// The single shared store — the linearizable coordination state for all clients.
const store = new CoordinationStore({ enforceRegistration: ENFORCE_REGISTRATION, dataDir: DATA_DIR });

function shutdown(): void {
  try {
    store.flushPersistence();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const TOKEN = process.env.WT_TOKEN; // if set, every request must present it

const app = express();
app.use(express.json({ limit: "1mb" }));

// The dashboard shell + liveness are public; the data endpoints stay token-gated
// (the dashboard's JS sends the token on its /v1/overview calls).
const PUBLIC_PATHS = new Set(["/", "/healthz", "/dashboard"]);

// ---- auth: shared-secret bearer token (skipped entirely if WT_TOKEN is unset) ----
if (TOKEN) {
  app.use((req: Request, res: Response, next: express.NextFunction) => {
    if (PUBLIC_PATHS.has(req.path)) return next(); // dashboard shell + liveness stay open
    const auth = req.header("authorization");
    const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : req.header("x-wt-token");
    if (provided !== TOKEN) {
      res.status(401).json({ error: "unauthorized: missing or invalid WT token" });
      return;
    }
    next();
  });
}

// ---- MCP endpoint (stateless: fresh server + transport per request, shared store) ----
app.post("/mcp", async (req: Request, res: Response) => {
  const server = buildServer(store);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null });
    }
  }
});

// ---- thin REST shims for hooks/daemons (no MCP handshake needed) ----
app.post("/v1/claim", (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.repo || !b.actorId || !b.path || !b.request_id) {
    res.status(400).json({ error: "repo, actorId, path, request_id are required" });
    return;
  }
  const r = store.resolveRegion(b.repo, b.path, b.symbol);
  const outcome = store.claim({
    repo: b.repo,
    regionId: r.regionId,
    nodeId: r.nodeId,
    byteRange: Array.isArray(b.byte_range) ? (b.byte_range as [number, number]) : undefined,
    anchor: r.anchor,
    grain: r.grain,
    path: b.path,
    actorId: b.actorId,
    origin: (b.origin as Kind) ?? "agent",
    mode: (b.mode as Mode) ?? "exclusive",
    intent: b.intent ?? "(edit)",
    requestId: b.request_id,
    progressToken: b.progress_token,
    force: Boolean(b.force),
  });
  res.json(outcome);
});

app.post("/v1/release", (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.claim_id || typeof b.fence !== "number") {
    res.status(400).json({ error: "claim_id and numeric fence are required" });
    return;
  }
  const r = store.release(b.claim_id, b.fence);
  res.json(r);
});

app.post("/v1/release_by_region", (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.repo || !b.actorId || !b.path) {
    res.status(400).json({ error: "repo, actorId, path are required" });
    return;
  }
  const r = store.resolveRegion(b.repo, b.path); // release ALL of this actor's claims in the file (node)
  res.json(store.releaseByNode(r.nodeId, b.actorId));
});

app.get("/v1/can_write", (req: Request, res: Response) => {
  const repo = String(req.query.repo ?? "");
  const actorId = String(req.query.actorId ?? "");
  const p = String(req.query.path ?? "");
  if (!repo || !actorId || !p) {
    res.status(400).json({ error: "repo, actorId, path query params required" });
    return;
  }
  const r = store.resolveRegion(repo, p, req.query.symbol ? String(req.query.symbol) : undefined);
  res.json(store.canWrite({ repo, nodeId: r.nodeId, regionId: r.regionId, grain: r.grain, actorId }));
});

app.post("/v1/announce", (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.repo || !b.actorId) {
    res.status(400).json({ error: "repo, actorId are required" });
    return;
  }
  store.announce({
    repo: b.repo,
    actorId: b.actorId,
    kind: (b.kind as Kind) ?? "human",
    state: b.state ?? "online",
    focus: b.path || b.intent ? { pathHint: b.path, intent: b.intent } : undefined,
    lastProgress: b.progress_token ?? 0,
    ttlMs: typeof b.ttl_ms === "number" ? b.ttl_ms : 30_000,
  });
  res.json({ ok: true });
});

app.get("/v1/whos_editing", (req: Request, res: Response) => {
  const repo = String(req.query.repo ?? "");
  if (!repo) {
    res.status(400).json({ error: "repo query param required" });
    return;
  }
  res.json(store.whosEditing(repo, { pathGlob: req.query.path_glob ? String(req.query.path_glob) : undefined }));
});

// ---- decisions bus (REST mirror of the wt_post_decision / wt_get_decisions tools) ----
app.get("/v1/decisions", (req: Request, res: Response) => {
  const repo = String(req.query.repo ?? "");
  if (!repo) {
    res.status(400).json({ error: "repo query param required" });
    return;
  }
  const scope: DecisionScope = {
    level: (String(req.query.level ?? "repo") as DecisionScope["level"]),
    id: req.query.id ? String(req.query.id) : undefined,
    pathHint: req.query.path ? String(req.query.path) : undefined,
  };
  const includeSuperseded = req.query.include_superseded === "1";
  res.json({ decisions: store.getDecisions(repo, scope, includeSuperseded) });
});

app.post("/v1/decisions", (req: Request, res: Response) => {
  const b = req.body ?? {};
  if (!b.repo || !b.title || !b.body || !b.author) {
    res.status(400).json({ error: "repo, title, body, author are required" });
    return;
  }
  const r = store.postDecision({
    repo: b.repo,
    scope: { level: b.level ?? "repo", id: b.id, pathHint: b.path },
    kind: b.kind ?? "note",
    title: b.title,
    body: b.body,
    author: b.author,
    authorKind: (b.author_kind as Kind) ?? "agent",
    supersedes: b.supersedes,
    tags: b.tags,
    requestId: b.request_id ?? randomUUID(),
  });
  if (r.ok) res.json(r.value);
  else res.status(409).json(r.error);
});

// ---- awareness dashboard (public shell; data via the token-gated /v1/overview) ----
const DASHBOARD_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "dashboard.html");

app.get("/", (_req: Request, res: Response) => {
  try {
    res.type("html").send(fs.readFileSync(DASHBOARD_PATH, "utf8"));
  } catch {
    res.type("html").send("<!doctype html><title>WorkingTogether</title><h1>WorkingTogether</h1><p>dashboard.html not found</p>");
  }
});

app.get("/v1/overview", (_req: Request, res: Response) => {
  res.json(store.overview());
});

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({ ok: true, ...store.stats() });
});

app.listen(PORT, () => {
  // stderr so it never pollutes stdout protocol streams
  console.error(`wt-coordination-mcp-server listening on http://localhost:${PORT}`);
  console.error(`  MCP:   POST /mcp`);
  console.error(`  hooks: POST /v1/claim, POST /v1/release, GET /v1/whos_editing`);
  console.error(`  health: GET /healthz   (enforceRegistration=${ENFORCE_REGISTRATION}, persist=${DATA_DIR ?? "off"}, auth=${TOKEN ? "on" : "off"})`);
});
