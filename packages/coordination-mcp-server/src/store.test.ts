import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CoordinationStore } from "./store.js";

type Over = Partial<Parameters<CoordinationStore["claim"]>[0]> & { symbol?: string };
function mkReq(store: CoordinationStore, over: Over = {}) {
  const repo = over.repo ?? "demo";
  const path = over.path ?? "src/app.ts";
  const r = store.resolveRegion(repo, path, over.symbol);
  const { symbol, ...rest } = over;
  return {
    repo,
    regionId: r.regionId,
    nodeId: r.nodeId,
    anchor: r.anchor,
    grain: r.grain,
    path,
    actorId: "A",
    origin: "agent" as const,
    mode: "exclusive" as const,
    intent: "edit",
    requestId: Math.random().toString(36).slice(2),
    ...rest,
  };
}

test("first claim is granted with a fence", () => {
  const s = new CoordinationStore();
  const o = s.claim(mkReq(s));
  assert.equal(o.result, "GRANTED");
  if (o.result === "GRANTED") assert.ok(o.claim.fence > 0);
});

test("agent-vs-agent on the same region is BLOCKED", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { actorId: "A" }));
  const o = s.claim(mkReq(s, { actorId: "B" }));
  assert.equal(o.result, "BLOCKED");
  if (o.result === "BLOCKED") {
    assert.equal(o.error.code, "REGION_CLAIMED");
    assert.equal(o.error.class, "BLOCKED_RETRYABLE");
    assert.equal(o.error.holder, "A");
  }
});

test("human involved -> WARN_PROCEED, not blocked", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { actorId: "A", origin: "agent" }));
  const o = s.claim(mkReq(s, { actorId: "H", origin: "human" }));
  assert.equal(o.result, "WARN_PROCEED");
});

test("disjoint regions don't collide", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { actorId: "A", path: "src/a.ts" }));
  const o = s.claim(mkReq(s, { actorId: "B", path: "src/b.ts" }));
  assert.equal(o.result, "GRANTED");
});

test("fence is monotonic across regions (one global domain)", () => {
  const s = new CoordinationStore();
  const o1 = s.claim(mkReq(s, { actorId: "A", path: "src/a.ts" }));
  const o2 = s.claim(mkReq(s, { actorId: "B", path: "src/b.ts" }));
  assert.ok(o1.result === "GRANTED" && o2.result === "GRANTED");
  if (o1.result === "GRANTED" && o2.result === "GRANTED") assert.ok(o2.claim.fence > o1.claim.fence);
});

test("release frees the region for another actor; stale fence rejected", () => {
  const s = new CoordinationStore();
  const o = s.claim(mkReq(s, { actorId: "A" }));
  assert.equal(o.result, "GRANTED");
  if (o.result !== "GRANTED") return;
  const bad = s.release(o.claim.claimId, o.claim.fence + 999);
  assert.equal(bad.ok, false);
  const good = s.release(o.claim.claimId, o.claim.fence);
  assert.equal(good.ok, true);
  const o2 = s.claim(mkReq(s, { actorId: "B" }));
  assert.equal(o2.result, "GRANTED");
});

test("reentrant claim by same actor returns same fence", () => {
  const s = new CoordinationStore();
  const o1 = s.claim(mkReq(s, { actorId: "A" }));
  const o2 = s.claim(mkReq(s, { actorId: "A" }));
  assert.ok(o1.result === "GRANTED" && o2.result === "GRANTED");
  if (o1.result === "GRANTED" && o2.result === "GRANTED") assert.equal(o1.claim.fence, o2.claim.fence);
});

test("idempotent claim: same request_id replays the same outcome", () => {
  const s = new CoordinationStore();
  const req = mkReq(s, { actorId: "A" });
  const o1 = s.claim(req);
  const o2 = s.claim(req);
  assert.deepEqual(o1, o2);
});

test("heartbeat without progress does NOT extend; with progress does", () => {
  const s = new CoordinationStore();
  const o = s.claim(mkReq(s, { actorId: "A", progressToken: 1 }));
  assert.equal(o.result, "GRANTED");
  if (o.result !== "GRANTED") return;
  const noProg = s.heartbeat(o.claim.claimId, o.claim.fence, 1); // not advanced
  assert.ok(noProg.ok && noProg.value.extended === false);
  const prog = s.heartbeat(o.claim.claimId, o.claim.fence, 2); // advanced
  assert.ok(prog.ok && prog.value.extended === true);
});

test("decisions: supersede chain hides the old head", () => {
  const s = new CoordinationStore();
  const d1 = s.postDecision({
    repo: "demo",
    scope: { level: "repo" },
    kind: "convention",
    title: "use tabs",
    body: "...",
    author: "A",
    authorKind: "agent",
    requestId: "r1",
  });
  assert.ok(d1.ok);
  if (!d1.ok) return;
  const d2 = s.postDecision({
    repo: "demo",
    scope: { level: "repo" },
    kind: "convention",
    title: "use spaces",
    body: "...",
    author: "A",
    authorKind: "agent",
    supersedes: d1.value.decisionId,
    requestId: "r2",
  });
  assert.ok(d2.ok);
  const heads = s.getDecisions("demo", { level: "repo" }, false);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].title, "use spaces");
});

test("enforceRegistration: unregistered agent fails closed on enforcing region", () => {
  const s = new CoordinationStore({ enforceRegistration: true });
  const o = s.claim(mkReq(s, { actorId: "ghost", origin: "agent" }));
  assert.equal(o.result, "ERROR");
  if (o.result === "ERROR") assert.equal(o.error.code, "UNREGISTERED_ACTOR");
});

// ---- region lattice (repo ⊃ node ⊃ region) ----

test("two agents can hold DIFFERENT symbols in the same file", () => {
  const s = new CoordinationStore();
  const a = s.claim(mkReq(s, { actorId: "A", symbol: "foo" }));
  const b = s.claim(mkReq(s, { actorId: "B", symbol: "bar" }));
  assert.equal(a.result, "GRANTED");
  assert.equal(b.result, "GRANTED");
});

test("the SAME symbol stays exclusive (agent-vs-agent blocked)", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { actorId: "A", symbol: "foo" }));
  const b = s.claim(mkReq(s, { actorId: "B", symbol: "foo" }));
  assert.equal(b.result, "BLOCKED");
});

test("a whole-file claim blocks region claims in that file (and vice versa)", () => {
  const s1 = new CoordinationStore();
  s1.claim(mkReq(s1, { actorId: "A" })); // node grain
  assert.equal(s1.claim(mkReq(s1, { actorId: "B", symbol: "foo" })).result, "BLOCKED");

  const s2 = new CoordinationStore();
  s2.claim(mkReq(s2, { actorId: "A", symbol: "foo" })); // region grain
  assert.equal(s2.claim(mkReq(s2, { actorId: "B" })).result, "BLOCKED");
});

test("same actor may hold both a file and a region within it", () => {
  const s = new CoordinationStore();
  assert.equal(s.claim(mkReq(s, { actorId: "A", symbol: "foo" })).result, "GRANTED");
  assert.equal(s.claim(mkReq(s, { actorId: "A" })).result, "GRANTED");
});

test("canWrite at node grain over-blocks a held sub-region for another actor", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { actorId: "A", symbol: "foo" }));
  const r = s.resolveRegion("demo", "src/app.ts"); // node grain (no symbol)
  assert.equal(s.canWrite({ repo: "demo", nodeId: r.nodeId, regionId: r.regionId, grain: r.grain, actorId: "B" }).allowed, false);
  assert.equal(s.canWrite({ repo: "demo", nodeId: r.nodeId, regionId: r.regionId, grain: r.grain, actorId: "A" }).allowed, true);
});

test("releaseByNode frees an actor's region claim; the file becomes claimable", () => {
  const s = new CoordinationStore();
  assert.equal(s.claim(mkReq(s, { actorId: "A", symbol: "foo" })).result, "GRANTED");
  const r = s.resolveRegion("demo", "src/app.ts");
  assert.equal(s.releaseByNode(r.nodeId, "A").released, 1);
  assert.equal(s.claim(mkReq(s, { actorId: "B" })).result, "GRANTED"); // bucket cleared
});

test("a claim lights up presence, scoped to its repo", () => {
  const s = new CoordinationStore();
  s.claim(mkReq(s, { repo: "r1", actorId: "A", symbol: "foo" }));
  const here = s.whosEditing("r1");
  assert.equal(here.presence.length, 1);
  assert.equal(here.presence[0].actorId, "A");
  assert.equal(here.presence[0].state, "editing");
  assert.equal(s.whosEditing("r2").presence.length, 0); // scoped to r1
});

test("persistence: decisions + identity survive across store instances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-persist-"));
  try {
    const s1 = new CoordinationStore({ dataDir: dir });
    s1.registerIdentity({ actorId: "alice", kind: "agent", displayName: "Alice" });
    s1.postDecision({
      repo: "demo",
      scope: { level: "repo" },
      kind: "constraint",
      title: "no any types",
      body: "use unknown",
      author: "alice",
      authorKind: "agent",
      requestId: "p1",
    });
    s1.flushPersistence();

    const s2 = new CoordinationStore({ dataDir: dir });
    const heads = s2.getDecisions("demo", { level: "repo" }, false);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].title, "no any types");

    // a fresh decision after reload gets a higher ord (counter restored)
    const r = s2.postDecision({
      repo: "demo",
      scope: { level: "repo" },
      kind: "note",
      title: "second",
      body: "x",
      author: "alice",
      authorKind: "agent",
      requestId: "p2",
    });
    assert.ok(r.ok && r.value.ord > heads[0].ord);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
