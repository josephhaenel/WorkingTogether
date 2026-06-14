# Self-hosting WorkingTogether

Run your own WorkingTogether server so you and your collaborators can use it on your own repos. One script handles TLS, a service user, systemd, a firewall, and an auth token.

## 1. Server (one VPS, run once)

On a fresh Ubuntu/Debian VPS:

```bash
git clone <this-repo> workingtogether
cd workingtogether
sudo bash deploy/setup.sh
```

What it does:
- installs Node + [Caddy](https://caddyserver.com), runs the **coordination server** (`:4100`) and **sync relay** (`:4200`) under `systemd` as a non-root `wt` user, with persistence on;
- gets **automatic HTTPS/WSS** via Caddy + Let's Encrypt — using [`sslip.io`](https://sslip.io) so you **don't need to buy a domain** (your URL will look like `https://203-0-113-5.sslip.io`). Want a nicer URL? Point a domain's A-record at the VPS and re-run with `WT_DOMAIN=wt.example.com sudo -E bash deploy/setup.sh`;
- locks the firewall to ports **22/80/443** only (the app ports are reachable only via Caddy on localhost);
- generates a shared **auth token** and prints the exact settings collaborators need.

At the end it prints something like:

```
Coordination (WT_SERVER_URL):  https://203-0-113-5.sslip.io
Relay        (--relay):        wss://203-0-113-5.sslip.io/sync
Shared token (WT_TOKEN):       a1b2c3...
```

Share the URL + token **only** with people you want in (anyone with both can join). Treat the token like a password.

### Updating / managing

```bash
git pull && sudo bash deploy/setup.sh        # redeploy after changes
systemctl status wt-coordination wt-relay     # health
journalctl -u wt-coordination -f              # logs
```

## 2. Each collaborator (per machine)

Set these in your shell (or your shell profile):

```bash
export WT_SERVER_URL="https://203-0-113-5.sslip.io"   # from the server output
export WT_TOKEN="a1b2c3..."                            # from the server output
export WT_REPO="my-repo"                               # SAME for everyone on this repo
export WT_ACTOR_ID="alice"                             # UNIQUE per person
```

**Run the sync daemon** over your checkout (clone the repo first; everyone starts from the same commit):

```bash
node packages/sync-daemon/dist/index.js --dir . \
  --relay "$WT_SERVER_URL/sync" --coord "$WT_SERVER_URL" \
  --room "$WT_REPO" --actor "$WT_ACTOR_ID" --token "$WT_TOKEN"
```
(replace `https://` with `wss://` for `--relay`, i.e. `wss://203-0-113-5.sslip.io/sync`.)

**Wire the Claude Code hooks** in the repo's `.claude/settings.json`:

```jsonc
{
  "hooks": {
    "PreToolUse":  [{ "matcher": "Edit|Write|MultiEdit",
      "hooks": [{ "type": "command", "command": "node /abs/path/packages/coordination-mcp-server/hooks/pre-tool-use.mjs" }] }],
    "PostToolUse": [{ "matcher": "Edit|Write|MultiEdit",
      "hooks": [{ "type": "command", "command": "node /abs/path/packages/coordination-mcp-server/hooks/post-tool-use.mjs" }] }]
  }
}
```

The hooks read `WT_SERVER_URL`, `WT_TOKEN`, `WT_REPO`, `WT_ACTOR_ID` from the environment. They **fail open** — if the server is unreachable, your editing is never blocked (you just lose coordination until it's back).

Optionally also register the coordination MCP server (`$WT_SERVER_URL/mcp`, with an `Authorization: Bearer $WT_TOKEN` header) so your agent can call `wt_whos_editing`, `wt_post_decision`, etc.

## 3. Verify

Two people, same `WT_REPO`, different `WT_ACTOR_ID`: have one person's agent start editing a file — the other sees it appear, and their agent is blocked from editing that same file until it's released.

## Security notes

- **The token is the only access control** in this MVP — anyone with the URL + token has full read/write to the shared state. Per-user accounts and per-repo access control are a future milestone.
- TLS is enforced end-to-end (Caddy). The app ports (4100/4200) are not exposed publicly; only Caddy reaches them.
- Run on a VPS you control; keep the OS patched and SSH key-only.
- To rotate the token: edit `/etc/wt/wt.env`, `systemctl restart wt-coordination wt-relay`, and redistribute it.
