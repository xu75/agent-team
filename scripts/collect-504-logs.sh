#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/collect-504-logs.sh [request_id]
# Collects 504 / timeout evidence from all three layers: Node, Nginx, frp.
#
# Node access log path (written by ui-server.js):
#   logs/ui-server.access.log   (relative to project root)
# Set NODE_LOG_PATH env to override.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

REQUEST_ID="${1:-}"
NODE_LOG_PATH="${NODE_LOG_PATH:-${PROJECT_ROOT}/logs/ui-server.access.log}"

# --- Nginx: try macOS Homebrew paths first, then Linux default ---
if [ -z "${NGINX_ACCESS_LOG:-}" ]; then
  for candidate in \
    /opt/homebrew/var/log/nginx/access.log \
    /usr/local/var/log/nginx/access.log \
    /var/log/nginx/access.log; do
    if [ -f "$candidate" ]; then
      NGINX_ACCESS_LOG="$candidate"
      break
    fi
  done
  NGINX_ACCESS_LOG="${NGINX_ACCESS_LOG:-/opt/homebrew/var/log/nginx/access.log}"
fi

if [ -z "${NGINX_ERROR_LOG:-}" ]; then
  for candidate in \
    /opt/homebrew/var/log/nginx/error.log \
    /usr/local/var/log/nginx/error.log \
    /var/log/nginx/error.log; do
    if [ -f "$candidate" ]; then
      NGINX_ERROR_LOG="$candidate"
      break
    fi
  done
  NGINX_ERROR_LOG="${NGINX_ERROR_LOG:-/opt/homebrew/var/log/nginx/error.log}"
fi

# --- frp: try common log locations ---
if [ -z "${FRP_LOG_PATH:-}" ]; then
  for candidate in \
    "${PROJECT_ROOT}/logs/frpc.log" \
    "${PROJECT_ROOT}/frpc.log" \
    /var/log/frpc.log \
    /var/log/frps.log; do
    if [ -f "$candidate" ]; then
      FRP_LOG_PATH="$candidate"
      break
    fi
  done
  FRP_LOG_PATH="${FRP_LOG_PATH:-}"
fi

show_matches() {
  local title="$1"
  local file_path="$2"
  local base_pattern="$3"

  echo "===== ${title} (${file_path}) ====="
  if [ ! -f "$file_path" ]; then
    echo "  [file not found — skipping]"
    echo
    return 0
  fi

  if [ -n "$REQUEST_ID" ]; then
    grep -nE "$base_pattern|${REQUEST_ID}" "$file_path" | tail -n 120 || true
  else
    grep -nE "$base_pattern" "$file_path" | tail -n 120 || true
  fi
  echo
}

echo "=== 504 / timeout log collection ==="
echo "  Node log : ${NODE_LOG_PATH}"
echo "  Nginx A  : ${NGINX_ACCESS_LOG}"
echo "  Nginx E  : ${NGINX_ERROR_LOG}"
echo "  frp log  : ${FRP_LOG_PATH:-<not found>}"
echo "  filter   : ${REQUEST_ID:-<all recent>}"
echo

show_matches "Node access+trace (5xx / timeouts / warnings)" \
  "$NODE_LOG_PATH" \
  "http-trace|request_error|client-error|probable_504|504|timeout|30s_warning|level=ERROR|level=WARN"

show_matches "Nginx access" \
  "$NGINX_ACCESS_LOG" \
  ' 504 |upstream|timeout|request_time'

show_matches "Nginx error" \
  "$NGINX_ERROR_LOG" \
  '504|timeout|upstream|premature|reset|closed'

if [ -n "${FRP_LOG_PATH}" ]; then
  show_matches "frp log" \
    "$FRP_LOG_PATH" \
    '504|timeout|proxy|upstream|disconnect|close'
else
  echo "===== frp log (not found via file) ====="
  echo "  Trying macOS unified log for frpc (last 1h)..."
  if command -v log >/dev/null 2>&1; then
    log show --predicate 'process == "frpc"' --last 1h 2>/dev/null | grep -iE '504|timeout|error|close' | tail -n 60 || echo "  (no frpc entries in unified log)"
  else
    echo "  [log command not available]"
  fi
  echo
fi
