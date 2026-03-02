#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "Usage: $0 <frp_base_url> <direct_base_url> <api_path> <json_body_template>"
  echo "Example:"
  echo "  $0 \"https://demo.example.com\" \"http://127.0.0.1:4173\" \"/api/chat\" '{\"message\":\"hi\",\"thread_slug\":\"cat-cafe\",\"request_id\":\"__REQ_ID__\"}'"
  exit 1
fi

FRP_BASE_URL="${1%/}"
DIRECT_BASE_URL="${2%/}"
API_PATH="$3"
JSON_TEMPLATE="$4"
REQUEST_ID="${REQUEST_ID:-req-$(date -u +%Y%m%dT%H%M%SZ)-$RANDOM}"
JSON_BODY="${JSON_TEMPLATE//__REQ_ID__/$REQUEST_ID}"

probe_once() {
  local label="$1"
  local base_url="$2"
  local start_utc
  local end_utc
  local result
  local status
  local total_s
  local response_file

  start_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  response_file="$(mktemp)"

  if ! result="$(
    curl -sS \
      -o "$response_file" \
      -w "%{http_code} %{time_total}" \
      -X POST "${base_url}${API_PATH}" \
      -H "Content-Type: application/json" \
      -H "X-Request-Id: ${REQUEST_ID}" \
      --data "$JSON_BODY"
  )"; then
    end_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    echo "[${label}] request failed request_id=${REQUEST_ID} start_utc=${start_utc} end_utc=${end_utc} url=${base_url}${API_PATH}"
    rm -f "$response_file"
    return 1
  fi

  end_utc="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  status="${result%% *}"
  total_s="${result##* }"

  echo "[${label}] request_id=${REQUEST_ID} start_utc=${start_utc} end_utc=${end_utc} status=${status} total_s=${total_s} url=${base_url}${API_PATH}"
  echo "[${label}] response_preview=$(head -c 240 "$response_file" | tr '\n' ' ')"
  rm -f "$response_file"
}

echo "request_id=${REQUEST_ID}"
probe_once "frp" "$FRP_BASE_URL"
probe_once "direct" "$DIRECT_BASE_URL"
