#!/usr/bin/env bash
#
# WorkingTogether — one-command self-host setup for a fresh Ubuntu/Debian VPS.
#
# Sets up: Node + Caddy, a non-root `wt` service user, the coordination server
# and sync relay under systemd (auto-restart + persistence), automatic HTTPS/WSS
# via Caddy + Let's Encrypt (using sslip.io so NO domain is required), a UFW
# firewall (only 22/80/443 public), and a shared-secret auth token.
#
# Usage (run from inside a fresh clone of the repo):
#   sudo bash deploy/setup.sh
#
# Optional overrides:
#   WT_DOMAIN=wt.example.com   # use your own domain instead of sslip.io
#   WT_TOKEN=...               # reuse a specific token (else one is generated)
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WT_USER="wt"
WT_HOME="/opt/workingtogether"
ENV_FILE="/etc/wt/wt.env"

[ "$(id -u)" = "0" ] || { echo "Please run as root (sudo bash deploy/setup.sh)"; exit 1; }

echo "==> Detecting public address"
PUBIP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
WT_DOMAIN="${WT_DOMAIN:-auto}"
if [ "$WT_DOMAIN" = "auto" ]; then WT_DOMAIN="${PUBIP//./-}.sslip.io"; fi
echo "    public IP : $PUBIP"
echo "    domain    : $WT_DOMAIN"

echo "==> Resolving auth token"
mkdir -p /etc/wt
if [ -n "${WT_TOKEN:-}" ]; then
  TOKEN="$WT_TOKEN"
elif [ -f "$ENV_FILE" ] && grep -q '^WT_TOKEN=' "$ENV_FILE"; then
  TOKEN="$(grep '^WT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)"
else
  TOKEN="$(openssl rand -hex 24)"
fi

echo "==> Installing dependencies (node, caddy, ufw, rsync)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ufw rsync openssl ca-certificates gnupg
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

echo "==> Creating service user and copying app to $WT_HOME"
id -u "$WT_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$WT_HOME" --shell /usr/sbin/nologin "$WT_USER"
mkdir -p "$WT_HOME/app" "$WT_HOME/data/crdt"
rsync -a --delete --exclude node_modules --exclude dist --exclude .git "$REPO_DIR/" "$WT_HOME/app/"
chown -R "$WT_USER:$WT_USER" "$WT_HOME"

echo "==> Building (npm install + build)"
sudo -u "$WT_USER" bash -lc "cd '$WT_HOME/app' && npm run install:all && npm run build"

echo "==> Writing $ENV_FILE"
cat > "$ENV_FILE" <<EOF
WT_TOKEN=$TOKEN
WT_DATA_DIR=$WT_HOME/data
WT_RELAY_DATA_DIR=$WT_HOME/data/crdt
EOF
chmod 640 "$ENV_FILE"; chown root:"$WT_USER" "$ENV_FILE"

echo "==> Writing systemd units"
cat > /etc/systemd/system/wt-coordination.service <<EOF
[Unit]
Description=WorkingTogether coordination server
After=network.target
[Service]
User=$WT_USER
EnvironmentFile=$ENV_FILE
Environment=PORT=4100
WorkingDirectory=$WT_HOME/app/packages/coordination-mcp-server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/wt-relay.service <<EOF
[Unit]
Description=WorkingTogether sync relay
After=network.target
[Service]
User=$WT_USER
EnvironmentFile=$ENV_FILE
Environment=PORT=4200
WorkingDirectory=$WT_HOME/app/packages/sync-relay
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

echo "==> Writing Caddyfile (automatic HTTPS)"
cat > /etc/caddy/Caddyfile <<EOF
$WT_DOMAIN {
	handle_path /sync/* {
		reverse_proxy localhost:4200
	}
	handle /v1/* {
		reverse_proxy localhost:4100
	}
	handle /mcp* {
		reverse_proxy localhost:4100
	}
	handle /healthz {
		reverse_proxy localhost:4100
	}
	handle {
		respond "WorkingTogether server" 200
	}
}
EOF

echo "==> Configuring firewall (UFW: 22, 80, 443)"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Starting services"
systemctl daemon-reload
systemctl enable --now wt-coordination wt-relay >/dev/null 2>&1 || systemctl enable --now wt-coordination wt-relay
systemctl restart caddy

sleep 2
echo
echo "================ WorkingTogether is up ================"
echo "Coordination (WT_SERVER_URL):  https://$WT_DOMAIN"
echo "Relay        (--relay):        wss://$WT_DOMAIN/sync"
echo "MCP endpoint:                  https://$WT_DOMAIN/mcp"
echo "Shared token (WT_TOKEN):       $TOKEN"
echo
echo "Each collaborator sets:"
echo "  WT_SERVER_URL=https://$WT_DOMAIN"
echo "  WT_TOKEN=$TOKEN"
echo "  WT_REPO=<your-repo-id>      (same for everyone)"
echo "  WT_ACTOR_ID=<unique-name>   (different per person)"
echo "and runs the sync daemon:"
echo "  node packages/sync-daemon/dist/index.js --dir . \\"
echo "    --relay wss://$WT_DOMAIN/sync --coord https://$WT_DOMAIN \\"
echo "    --room \$WT_REPO --actor \$WT_ACTOR_ID --token \$WT_TOKEN"
echo "See deploy/README.md for the Claude Code hook wiring."
echo "======================================================="
