#!/usr/bin/env bash
#
# Update an existing WorkingTogether server to the latest code and restart it.
# Run as root on the VPS:  sudo bash deploy/update.sh
#
# Pulls the public repo into /opt/workingtogether/app (converting the initial
# rsync'd copy to a git clone on first run), rebuilds, and restarts the services.
#
set -euo pipefail

APP="/opt/workingtogether/app"
REPO="https://github.com/josephhaenel/WorkingTogether.git"

[ "$(id -u)" = "0" ] || { echo "Please run as root (sudo bash deploy/update.sh)"; exit 1; }

if [ -d "$APP/.git" ]; then
  echo "==> git pull"
  sudo -u wt git -C "$APP" pull --ff-only
else
  echo "==> converting $APP to a git clone of $REPO"
  rm -rf "$APP"
  sudo -u wt git clone "$REPO" "$APP"
fi

echo "==> install + build"
sudo -u wt bash -lc "cd '$APP' && npm run install:all && npm run build"

echo "==> restart services"
systemctl restart wt-coordination wt-relay

sleep 2
systemctl is-active wt-coordination wt-relay caddy
echo "==> updated."
