#!/usr/bin/env bash
# Build and (re)start the WhatsApp gateway on a Linux host with PM2.
#
# Usage:
#   bash deploy/deploy-prod.sh   # install, build, restart PM2
#
# The gateway listens on 127.0.0.1:8095 only. There is no Nginx site for it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PM2_CONFIG="${SCRIPT_DIR}/ecosystem.prod.config.js"
APP_NAME="kampusping-wa-gateway"
APP_PORT=8095

for arg in "$@"; do
  case "${arg}" in
    -h|--help)
      sed -n '2,7p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: ${arg}" >&2
      exit 1
      ;;
  esac
done

cd "${REPO_ROOT}"

if [[ ! -f ".env" ]]; then
  echo "Missing .env. Copy .env.example to .env and fill in real values." >&2
  exit 1
fi

echo "==> Installing dependencies"
npm ci --no-audit --no-fund

echo "==> Building"
npm run build

echo "==> PM2: ${APP_NAME}"
pm2 delete "${APP_NAME}" 2>/dev/null || true
pm2 start "${PM2_CONFIG}"
pm2 save

# Every route needs the API key, so an unauthenticated probe must answer 401.
sleep 3
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/status" || true)"
if [[ "${code}" != "401" ]]; then
  echo "ERROR: health check failed (expected HTTP 401, got ${code})" >&2
  pm2 logs "${APP_NAME}" --lines 40 --nostream || true
  exit 1
fi

echo "==> Gateway deployed"
pm2 status "${APP_NAME}"
