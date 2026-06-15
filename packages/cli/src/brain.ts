/**
 * The "shared brain" CLI surface: see who's editing, read relevant decisions,
 * and record decisions. Backed by the coordination server's REST endpoints, so
 * an agent can use these via Bash even without the MCP tools wired.
 */
import crypto from "node:crypto";
import { loadConfig, authHeaders, type WtConfig } from "./config.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

async function api(cfg: WtConfig, path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(`${cfg.serverUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders(cfg), ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 401 ? " (bad/missing token)" : ""}`);
  return r.json();
}

export async function who(): Promise<void> {
  const cfg = loadConfig();
  try {
    const data = (await api(cfg, `/v1/whos_editing?repo=${encodeURIComponent(cfg.repo)}`)) as {
      claims?: Array<{ holder: string; kind: string; anchor: string; intent?: string }>;
      presence?: Array<{ actorId: string; state: string; focus?: { pathHint?: string } }>;
    };
    const claims = data.claims ?? [];
    if (!claims.length) console.log("no active claims");
    for (const c of claims) console.log(`${c.holder} [${c.kind}] -> ${c.anchor}${c.intent ? `  "${c.intent}"` : ""}`);
    for (const p of data.presence ?? []) {
      console.log(`(presence) ${p.actorId} ${p.state}${p.focus?.pathHint ? ` @ ${p.focus.pathHint}` : ""}`);
    }
  } catch (e) {
    console.error(`hive who: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export async function decisions(): Promise<void> {
  const cfg = loadConfig();
  const path = flag("path");
  const qs = new URLSearchParams({ repo: cfg.repo });
  if (path) {
    qs.set("level", "node");
    qs.set("id", path);
    qs.set("path", path);
  }
  try {
    const data = (await api(cfg, `/v1/decisions?${qs.toString()}`)) as {
      decisions?: Array<{ kind: string; title: string; body: string; scope: { level: string; id?: string }; author: string }>;
    };
    const list = data.decisions ?? [];
    if (!list.length) {
      console.log("no decisions" + (path ? ` for ${path}` : ""));
      return;
    }
    for (const d of list) {
      const scope = d.scope.level === "repo" ? "repo" : `${d.scope.level}:${d.scope.id}`;
      console.log(`• [${d.kind}] ${d.title}  (${scope}, by ${d.author})`);
      if (d.body && d.body !== d.title) console.log(`    ${d.body}`);
    }
  } catch (e) {
    console.error(`hive decisions: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export async function capture(): Promise<void> {
  const cfg = loadConfig();
  try {
    const data = (await api(cfg, `/v1/captures?repo=${encodeURIComponent(cfg.repo)}&actor=${encodeURIComponent(cfg.actor)}`)) as {
      captures?: Array<{ anchor: string; path: string; intent?: string }>;
    };
    const list = data.captures ?? [];
    if (!list.length) {
      console.log("no recent edits without a recorded decision — you're all caught up");
      return;
    }
    console.log("Recent edits with no recorded decision. If any was a deliberate choice, record it:");
    for (const c of list) {
      console.log(`  ${c.anchor}${c.intent ? `  (${c.intent})` : ""}`);
      console.log(`    hive decide "<the rule you chose>" --path ${c.path} --kind convention`);
    }
  } catch (e) {
    console.error(`hive capture: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export async function ask(): Promise<void> {
  const cfg = loadConfig();
  const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"));
  const query = flag("query") ?? positional.join(" ");
  if (!query) {
    console.error('usage: hive ask "<question>" [--path <file>] [--limit N]');
    process.exit(2);
  }
  const path = flag("path");
  const qs = new URLSearchParams({ repo: cfg.repo, q: query });
  if (path) {
    qs.set("level", "node");
    qs.set("path", path);
  }
  if (flag("limit")) qs.set("limit", flag("limit")!);
  try {
    const data = (await api(cfg, `/v1/ask?${qs.toString()}`)) as {
      decisions?: Array<{ kind: string; title: string; body: string; scope: { level: string; id?: string }; author: string }>;
    };
    const list = data.decisions ?? [];
    if (!list.length) {
      console.log(`no matching decisions for "${query}" (keyword search — try different terms or 'hive decisions')`);
      return;
    }
    for (const d of list) {
      const scope = d.scope.level === "repo" ? "repo" : `${d.scope.level}:${d.scope.id ?? ""}`;
      console.log(`• [${d.kind}] ${d.title}  (${scope}, by ${d.author})`);
      if (d.body && d.body !== d.title) console.log(`    ${d.body}`);
    }
  } catch (e) {
    console.error(`hive ask: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export async function announce(): Promise<void> {
  const cfg = loadConfig();
  const positional = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;
  const state = flag("state") ?? positional ?? "online";
  const body = {
    repo: cfg.repo,
    actorId: cfg.actor,
    kind: flag("kind") ?? "human",
    state,
    path: flag("path"),
    intent: flag("intent"),
    ttl_ms: flag("ttl") ? Number(flag("ttl")) : undefined,
  };
  try {
    await api(cfg, "/v1/announce", { method: "POST", body: JSON.stringify(body) });
    console.log(`announced: ${state}${body.path ? " @ " + body.path : ""}`);
  } catch (e) {
    console.error(`hive announce: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export async function decide(): Promise<void> {
  const cfg = loadConfig();
  const positional = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : undefined;
  const title = flag("title") ?? positional;
  if (!title) {
    console.error('usage: hive decide "<title>" [--body "..."] [--path <file>] [--kind constraint|convention|rationale|interface|note]');
    process.exit(2);
  }
  const path = flag("path");
  const body = {
    repo: cfg.repo,
    title,
    body: flag("body") ?? title,
    kind: flag("kind") ?? "note",
    author: cfg.actor,
    author_kind: "agent",
    level: path ? "node" : "repo",
    id: path,
    path,
    supersedes: flag("supersedes"),
    request_id: crypto.randomUUID(),
  };
  try {
    const r = (await api(cfg, "/v1/decisions", { method: "POST", body: JSON.stringify(body) })) as {
      decisionId?: string;
      conflicts?: Array<{ decisionId: string; title: string; reason: string }>;
    };
    console.log(`recorded decision ${r.decisionId ?? ""}`.trim());
    for (const c of r.conflicts ?? []) {
      console.log(`⚠ may contradict "${c.title}" (${c.reason}). If intended, re-record with --supersedes ${c.decisionId}.`);
    }
  } catch (e) {
    console.error(`hive decide: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
