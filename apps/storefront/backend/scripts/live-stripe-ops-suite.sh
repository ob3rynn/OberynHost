#!/usr/bin/env bash
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$(mktemp -d /tmp/oberynn-stripe-ops.XXXXXX)"
ACTIVE_PGID=""
CURRENT_LOG=""

cleanup_background() {
  if [[ -n "$ACTIVE_PGID" ]]; then
    if kill -0 "$ACTIVE_PGID" >/dev/null 2>&1; then
      kill "$ACTIVE_PGID" >/dev/null 2>&1 || true
    fi
    pkill -P "$ACTIVE_PGID" >/dev/null 2>&1 || true
    pkill -f 'node scripts/dev-with-stripe.js|node --watch server.js|node server.js|stripe listen' >/dev/null 2>&1 || true
    wait "$ACTIVE_PGID" 2>/dev/null || true
    sleep 1
  fi
  ACTIVE_PGID=""
}

reset_existing_services() {
  pkill -f 'node scripts/dev-with-stripe.js|node --watch server.js|node server.js|stripe listen' >/dev/null 2>&1 || true
}

wait_for_server() {
  local attempt
  for attempt in $(seq 1 40); do
    if curl -fsS http://127.0.0.1:3000/api/plans >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "Server did not become ready in time." >&2
  return 1
}

start_backend_only() {
  cleanup_background
  CURRENT_LOG="$LOG_DIR/backend-only.log"
  : >"$CURRENT_LOG"
  setsid bash -lc "cd '$BACKEND_DIR' && exec node server.js" >"$CURRENT_LOG" 2>&1 &
  ACTIVE_PGID=$!
  wait_for_server
}

start_listener_stack() {
  cleanup_background
  CURRENT_LOG="$LOG_DIR/dev-with-stripe.log"
  : >"$CURRENT_LOG"
  setsid bash -lc "cd '$BACKEND_DIR' && exec npm run dev" >"$CURRENT_LOG" 2>&1 &
  ACTIVE_PGID=$!
  wait_for_server
}

run_scenario() {
  local scenario="$1"
  echo
  echo "==> Running $scenario"
  (
    cd "$BACKEND_DIR"
    node scripts/live-stripe-ops.js "$scenario"
  )
}

dump_failure_log() {
  if [[ -n "$CURRENT_LOG" && -f "$CURRENT_LOG" ]]; then
    echo
    echo "--- Last background log ($CURRENT_LOG) ---" >&2
    tail -n 200 "$CURRENT_LOG" >&2 || true
  fi
}

on_exit() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    dump_failure_log
  fi
  cleanup_background
  rm -rf "$LOG_DIR"
  exit $status
}

trap on_exit EXIT

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "This script must run inside the storefront devtools container." >&2
  exit 1
fi

reset_existing_services

echo "Starting backend-only mode for webhook outage drill..."
start_backend_only
run_scenario outage-reconcile

echo "Switching to listener-backed dev mode for recurring lifecycle drills..."
start_listener_stack
run_scenario mobile-pass
run_scenario subscription-policy
run_scenario expiry-release
run_scenario cancel-at-period-end

echo
echo "All live Stripe ops scenarios passed."
