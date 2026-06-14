#!/usr/bin/env node
/**
 * Verifies daemon-side claim enforcement ([D-46]) — protection against edits
 * that BYPASS the Claude Code hook (e.g. a human editing in a plain editor).
 *
 * Setup: coordination + relay + two daemons (alice, bob) with enforcement on.
 *   1. bob claims shared.txt (directly, as if his agent's hook did).
 *   2. alice edits shared.txt MANUALLY (no hook). Her daemon checks the claim,
 *      sees bob holds it, and REVERTS the file instead of broadcasting.
 *   3. Assert: alice's file reverted; bob's file NOT clobbered.
 *   4. bob releases; alice edits again -> now allowed -> syncs to bob.
 *
 *   node examples/enforcement-check.mjs   (build packages first)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const COORD = path.join(root, "packages/coordination-mcp-server/dist/index.js");
const RELAY = path.join(root, "packages/sync-relay/dist/index.js");
const DAEMON = path.join(root, "packages/sync-daemon/dist/index.js");
const COORD_PORT = 4155;
const RELAY_PORT = 4255;
const COORD_URL = `http://localhost:${COORD_PORT}`;
const RELAY_URL = `ws://localhost:${RELAY_PORT}`;
const REPO = "demo-repo";

for (const f of [COORD, RELAY, DAEMON]) {
  if (!fs.existsSync(f)) { console.error(`Missing build: ${f}. Run: npm run build`); process.exit(2); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = new Set();
function spawnNode(entry, args, env, tag) {
  const c = spawn(process.execPath, [entry, ...args], { env: { ...process.env, ...env } });
  c.stdout.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  c.stderr.on("data", (d) => process.stdout.write(`[${tag}] ${d}`));
  procs.add(c);
  c.on("close", () => procs.delete(c));
  return c;
}
const post = (u, b) => fetch(COORD_URL + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
async function waitFor(file, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fsp.readFile(file, "utf8")) === expected) return true; } catch { /* */ }
    await sleep(150);
  }
  return false;
}
async function read(file) { try { return await fsp.readFile(file, "utf8"); } catch { return "<missing>"; } }

let failures = 0;
function check(name, ok, detail = "") { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failures++; }

async function main() {
  const dirA = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-eA-"));
  const dirB = await fsp.mkdtemp(path.join(os.tmpdir(), "wt-eB-"));
  await fsp.writeFile(path.join(dirA, "shared.txt"), "baseline");
  await fsp.writeFile(path.join(dirB, "shared.txt"), "baseline");

  spawnNode(COORD, [], { PORT: String(COORD_PORT) }, "coord");
  spawnNode(RELAY, [], { PORT: String(RELAY_PORT) }, "relay");
  await sleep(900);
  // daemons with enforcement on (coord + actor)
  spawnNode(DAEMON, ["--dir", dirA, "--relay", RELAY_URL, "--room", REPO, "--coord", COORD_URL, "--actor", "alice", "--repo", REPO], {}, "A");
  await sleep(1200);
  spawnNode(DAEMON, ["--dir", dirB, "--relay", RELAY_URL, "--room", REPO, "--coord", COORD_URL, "--actor", "bob", "--repo", REPO], {}, "B");
  await sleep(1500);

  console.log("\n--- bob claims shared.txt; alice edits it manually (no hook) ---");
  const claim = await post("/v1/claim", { repo: REPO, actorId: "bob", path: "shared.txt", origin: "agent", intent: "bob owns this", request_id: "bob-claim-1" });
  check("bob holds the claim", claim.result === "GRANTED", claim.result);

  await fsp.writeFile(path.join(dirA, "shared.txt"), "ALICE CLOBBER (no hook)");
  await sleep(2000); // alice's daemon checks the claim and reverts

  check("alice's bypassing edit was reverted", (await read(path.join(dirA, "shared.txt"))) === "baseline", await read(path.join(dirA, "shared.txt")));
  check("bob's file was NOT clobbered", (await read(path.join(dirB, "shared.txt"))) === "baseline", await read(path.join(dirB, "shared.txt")));

  console.log("\n--- bob releases; alice edits again -> now allowed ---");
  await post("/v1/release_by_region", { repo: REPO, actorId: "bob", path: "shared.txt" });
  await sleep(300);
  await fsp.writeFile(path.join(dirA, "shared.txt"), "alice edit after release");
  check("alice's edit now syncs to bob", await waitFor(path.join(dirB, "shared.txt"), "alice edit after release"));

  for (const c of procs) { try { c.kill(); } catch { /* */ } }
  await Promise.all([dirA, dirB].map((d) => fsp.rm(d, { recursive: true, force: true }).catch(() => {})));

  console.log(failures === 0 ? "\nPASS — daemon-side enforcement blocks hook-bypassing edits." : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("check error:", e); for (const c of procs) { try { c.kill(); } catch { /* */ } } process.exit(1); });
