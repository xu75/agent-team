#!/usr/bin/env bash
set -euo pipefail

REQUEST_ID="${1:-}"
NODE_LOG_PATH="${NODE_LOG_PATH:-logs/ui-server.http.log}"
FRP_LOG_PATH="${FRP_LOG_PATH:-/var/log/frps.log}"
NGINX_ACCESS_LOG="${NGINX_ACCESS_LOG:-/var/log/nginx/access.log}"
NGINX_ERROR_LOG="${NGINX_ERROR_LOG:-/var/log/nginx/error.log}"

show_matches() {
  local title="$1"
  local file_path="$2"
  local base_pattern="$3"

  echo "===== ${title} (${file_path}) ====="
  if [ ! -f "$file_path" ]; then
    echo "file not found"
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

show_matches "Node trace" "$NODE_LOG_PATH" "http-trace|request_error|504|timeout"
show_matches "FRP log" "$FRP_LOG_PATH" "504|timeout|proxy|upstream|disconnect|close"
show_matches "Nginx access" "$NGINX_ACCESS_LOG" " 504 |upstream|timeout|request_time"
show_matches "Nginx error" "$NGINX_ERROR_LOG" "504|timeout|upstream|premature|reset|closed"
