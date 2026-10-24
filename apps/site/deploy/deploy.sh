#!/usr/bin/env bash
# Copies the site to the Lightsail instance.
#   SWEEP_SSH=ubuntu@<static-ip> [SWEEP_KEY=~/.ssh/lightsail.pem] npm run deploy -w @organizer/site
set -euo pipefail

: "${SWEEP_SSH:?Set SWEEP_SSH to user@host, e.g. ubuntu@203.0.113.10}"
SITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SSH_OPTS=()
[ -n "${SWEEP_KEY:-}" ] && SSH_OPTS=(-i "$SWEEP_KEY")

rsync -avz --delete \
  --exclude deploy --exclude package.json --exclude '.*' \
  -e "ssh ${SSH_OPTS[*]:-}" \
  "$SITE_DIR/" "$SWEEP_SSH:/var/www/sweepmail/"
