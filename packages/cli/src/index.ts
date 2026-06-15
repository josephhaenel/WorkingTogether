#!/usr/bin/env node
/**
 * hive — Hivemind CLI.
 */
import { status } from "./status.js";
import { hookPre, hookPost } from "./hook.js";
import { init } from "./init.js";
import { up, down } from "./daemon.js";
import { who, decisions, decide, announce, ask, capture } from "./brain.js";

const HELP = `hive — Hivemind CLI

Usage:
  hive init                Set up this repo: save config + wire the Claude Code hooks + MCP
  hive up                  Start syncing this folder (background daemon)
  hive down                Stop the daemon
  hive status              Show server health + who's editing this repo
  hive who                 Who's editing what right now
  hive announce [state]    Publish your presence (state: online|editing|reviewing|idle)
  hive decisions [--path P]            Read shared decisions (repo-wide, or for a file)
  hive ask "<question>" [--path P]     Search the shared brain (keyword) for relevant decisions
  hive decide "<title>" [--body ..] [--path P] [--kind K]   Record a decision
  hive capture             Your recent edits with no recorded decision (capture candidates)
  hive hook pre|post       Internal: the Claude Code Edit/Write hooks (wired by init)

Config comes from .hive/config.json (written by init) or env:
  WT_SERVER_URL  WT_TOKEN  WT_REPO  WT_ACTOR_ID  WT_RELAY

Docs: https://github.com/josephhaenel/Hivemind`;

async function main(): Promise<void> {
  const [cmd, sub] = process.argv.slice(2);
  switch (cmd) {
    case "init":
      await init();
      break;
    case "up":
      up();
      break;
    case "down":
      down();
      break;
    case "status":
      await status();
      break;
    case "who":
      await who();
      break;
    case "announce":
      await announce();
      break;
    case "decisions":
      await decisions();
      break;
    case "ask":
      await ask();
      break;
    case "capture":
      await capture();
      break;
    case "decide":
      await decide();
      break;
    case "hook":
      if (sub === "pre") await hookPre();
      else if (sub === "post") await hookPost();
      else {
        console.error("usage: hive hook <pre|post>");
        process.exit(2);
      }
      break;
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      break;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
