#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
storefront_dir="${repo_root}/apps/storefront"
storefront_env="${storefront_dir}/backend/.env"

if [[ "$repo_root" == /mnt/* ]]; then
    echo "Storefront Docker workflows must run from a WSL/Linux checkout path, not ${repo_root}." >&2
    echo "Move the repo under /home/<user>/... and rerun this command from WSL." >&2
    exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for storefront workflows." >&2
    exit 1
fi

compose() {
    (
        cd "$storefront_dir"
        docker compose "$@"
    )
}

ensure_env_file() {
    if [[ ! -f "$storefront_env" ]]; then
        echo "Missing ${storefront_env}." >&2
        echo "Create it from ${storefront_dir}/backend/.env.example before running storefront Docker commands." >&2
        exit 1
    fi
}

stop_conflicting_services() {
    local target="$1"

    case "$target" in
        storefront)
            compose stop storefront-dev storefront-stripe-dev >/dev/null 2>&1 || true
            ;;
        storefront-dev)
            compose stop storefront storefront-stripe-dev >/dev/null 2>&1 || true
            ;;
        storefront-stripe-dev)
            compose stop storefront storefront-dev >/dev/null 2>&1 || true
            ;;
    esac
}

stop_services() {
    if [[ "$#" -eq 0 ]]; then
        return 0
    fi

    compose stop "$@" >/dev/null 2>&1 || true
}

ensure_service_running() {
    local service="$1"

    stop_conflicting_services "$service"
    compose up -d --build "$service"
}

wait_for_service_http_ready() {
    local service="$1"
    local path="${2:-/api/plans}"
    local attempts="${3:-60}"
    local attempt

    for ((attempt = 1; attempt <= attempts; attempt++)); do
        if compose exec -T "$service" sh -lc \
            "curl -fsS \"http://127.0.0.1:\${PORT:-3000}${path}\" >/dev/null" \
            >/dev/null 2>&1; then
            return 0
        fi

        sleep 1
    done

    echo "Timed out waiting for ${service} to serve ${path}." >&2
    compose logs --tail=200 "$service" >&2 || true
    exit 1
}

run_npm_in_service() {
    local service="$1"
    local script_name="$2"
    shift 2

    if [[ "$#" -gt 0 ]]; then
        compose exec -T "$service" npm run "$script_name" -- "$@"
    else
        compose exec -T "$service" npm run "$script_name"
    fi
}

run_npm_one_shot() {
    local service="$1"
    local script_name="$2"
    shift 2

    if [[ "$#" -gt 0 ]]; then
        compose run --rm --build "$service" npm run "$script_name" -- "$@"
    else
        compose run --rm --build "$service" npm run "$script_name"
    fi
}

command_name="${1:-help}"
if [[ "$#" -gt 0 ]]; then
    shift
fi

case "$command_name" in
    help|-h|--help)
        cat <<'EOF'
Storefront Docker workflow

Usage:
  bash scripts/storefront-docker.sh up
  bash scripts/storefront-docker.sh down
  bash scripts/storefront-docker.sh logs [service]
  bash scripts/storefront-docker.sh restart [service]
  bash scripts/storefront-docker.sh dev
  bash scripts/storefront-docker.sh dev:stripe
  bash scripts/storefront-docker.sh test
  bash scripts/storefront-docker.sh audit:config
  bash scripts/storefront-docker.sh audit:runtime
  bash scripts/storefront-docker.sh audit:read-only
  bash scripts/storefront-docker.sh audit:updates
  bash scripts/storefront-docker.sh stripe:login
  bash scripts/storefront-docker.sh stripe:live
  bash scripts/storefront-docker.sh stripe:abuse
  bash scripts/storefront-docker.sh stripe:ops
EOF
        ;;
    up)
        ensure_env_file
        stop_conflicting_services storefront
        compose up -d --build storefront
        ;;
    down)
        compose down --remove-orphans
        ;;
    logs)
        service_name="${1:-storefront}"
        if [[ "$#" -gt 0 ]]; then
            shift
        fi
        compose logs -f "$service_name" "$@"
        ;;
    restart)
        ensure_env_file
        service_name="${1:-storefront}"
        if [[ "$#" -gt 0 ]]; then
            shift
        fi
        stop_conflicting_services "$service_name"
        compose restart "$service_name" "$@"
        ;;
    dev)
        ensure_env_file
        stop_conflicting_services storefront-dev
        compose up --build storefront-dev
        ;;
    dev:stripe)
        ensure_env_file
        stop_conflicting_services storefront-stripe-dev
        compose up --build storefront-stripe-dev
        ;;
    test)
        ensure_env_file
        run_npm_one_shot storefront-dev test "$@"
        ;;
    audit:config)
        ensure_env_file
        run_npm_one_shot storefront audit:config "$@"
        ;;
    audit:runtime)
        ensure_env_file
        run_npm_one_shot storefront audit:runtime "$@"
        ;;
    audit:read-only)
        ensure_env_file
        run_npm_one_shot storefront audit:read-only "$@"
        ;;
    audit:updates)
        ensure_env_file
        run_npm_one_shot storefront-dev audit:updates "$@"
        ;;
    stripe:login)
        ensure_env_file
        compose run --rm --build storefront-dev stripe login "$@"
        ;;
    stripe:live)
        ensure_env_file
        ensure_service_running storefront-stripe-dev
        wait_for_service_http_ready storefront-stripe-dev /pricing
        run_npm_in_service storefront-stripe-dev test:stripe:live "$@"
        ;;
    stripe:abuse)
        ensure_env_file
        ensure_service_running storefront-stripe-dev
        wait_for_service_http_ready storefront-stripe-dev /pricing
        run_npm_in_service storefront-stripe-dev test:stripe:abuse "$@"
        ;;
    stripe:ops)
        ensure_env_file
        stop_services storefront storefront-dev storefront-stripe-dev
        run_npm_one_shot storefront-stripe-dev test:stripe:ops:all "$@"
        ;;
    *)
        echo "Unknown storefront Docker command: ${command_name}" >&2
        echo "Run 'bash scripts/storefront-docker.sh help' for usage." >&2
        exit 1
        ;;
esac
