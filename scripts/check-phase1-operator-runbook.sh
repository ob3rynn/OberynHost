#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
runbook_path="${repo_root}/docs/PHASE1_OPERATOR_RUNBOOK.md"
plan_path="${repo_root}/docs/OBERYNHOST_AUTOMATION_PLAN_FROZEN.md"
failures=0

pass() {
    printf '[PASS] %s\n' "$1"
}

fail() {
    printf '[FAIL] %s\n' "$1" >&2
    failures=$((failures + 1))
}

require_file() {
    local file_path="$1"
    local label="$2"

    if [[ -f "$file_path" ]]; then
        pass "$label exists"
    else
        fail "$label is missing: ${file_path}"
    fi
}

require_text() {
    local file_path="$1"
    local label="$2"
    local needle="$3"

    if [[ ! -f "$file_path" ]]; then
        fail "Cannot check ${label}; missing file: ${file_path}"
        return
    fi

    if grep -Fq "$needle" "$file_path"; then
        pass "$label"
    else
        fail "${label} is missing '${needle}'"
    fi
}

printf 'Phase-1 operator readiness check\n'

if [[ "$repo_root" == /mnt/* ]]; then
    fail "Repo is on a Windows-mounted path; use a native Linux filesystem instead"
else
    pass "Repo is on a native Linux filesystem"
fi

require_file "$runbook_path" "Phase-1 operator runbook"
require_file "$plan_path" "Frozen automation plan"

require_text "$runbook_path" "Runbook documents routing verification" "Mark Routing Verified"
require_text "$runbook_path" "Runbook documents final release gate" "Release Ready"
require_text "$runbook_path" "Runbook documents Pelican target config" "PELICAN_PROVISIONING_TARGETS_JSON"
require_text "$runbook_path" "Runbook documents Postmark production email" "EMAIL_PROVIDER=postmark"
require_text "$runbook_path" "Runbook documents live Stripe price input" "STRIPE_PRICE_3GB"
require_text "$runbook_path" "Runbook blocks automated Pelican deletion" "Do not delete Pelican resources"
require_text "$runbook_path" "Runbook blocks Windows-side Node/npm and mounted paths" "Do not use Windows-side Node/npm"
require_text "$plan_path" "Frozen plan links the phase-1 runbook" "PHASE1_OPERATOR_RUNBOOK.md"
require_text "$plan_path" "Frozen plan keeps destructive purge operator-gated" "does not delete Pelican resources or release capacity"

stale_capacity_matches="$(grep -R -n -F "22 active server slots" "${repo_root}/docs" 2>/dev/null || true)"

if [[ -n "$stale_capacity_matches" ]]; then
    fail "Docs still mention stale 22-slot launch capacity: ${stale_capacity_matches//$'\n'/; }"
else
    pass "Docs do not mention stale 22-slot launch capacity"
fi

if [[ "$failures" -gt 0 ]]; then
    printf 'Phase-1 operator readiness check found %s issue(s).\n' "$failures" >&2
    exit 1
fi

printf 'Phase-1 operator readiness check passed.\n'
