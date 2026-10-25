#!/bin/sh
# Deploy the latest main on the game server: run as the account that owns /opt/gd (not as gd).
#   /opt/gd/deploy/deploy.sh
# Restarting is safe: the server saves games on stop, and the worker pauses jobs that resume from checkpoints.
set -eu
cd /opt/gd
git fetch --quiet origin
git merge --ff-only origin/main
npm ci --no-audit --no-fund
npm run build
sudo systemctl restart gd-worker gd-server
sleep 2
systemctl --no-pager --lines=0 status gd-server gd-worker | grep -E '●|Active:'
