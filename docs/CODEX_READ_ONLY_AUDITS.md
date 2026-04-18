# Codex Read-Only Audits

This document defines how a Codex instance may inspect this repo on a live or production-adjacent host without changing application state.

## Purpose

Use Codex for diagnostics, drift detection, and upgrade planning.

Do not use Codex on the live host for unattended upgrades, dependency installs, file edits, service restarts, or database writes.

## Approved audit commands

These commands are intended to be safe and read-only for routine use:

```bash
bash scripts/run-read-only-audits.sh
bash scripts/run-update-review.sh
cd apps/storefront/backend && npm run audit:config
cd apps/storefront/backend && npm run audit:runtime
cd apps/storefront/backend && npm run audit:read-only
cd apps/storefront/backend && npm run audit:updates
cd apps/storefront/backend && node scripts/audit-read-only.js --json
git status --short
git log --oneline -n 20
```

What the audit scripts inspect:

- required environment/config presence
- pinned Stripe package and API version settings
- whether Stripe clients are centralized through the shared helper
- available npm package updates in the storefront backend workspace
- current branch and worktree cleanliness
- read-only SQLite health checks for checkout, setup, subscription, and policy drift

## Forbidden actions on the live host

Codex must not do any of the following unless a human explicitly asks for that exact action in the current session:

- edit files
- run `npm install`, `npm update`, `npm audit fix`, or `npm ci`
- change `.env` or deployment secrets
- restart services, stop services, or reload reverse proxies
- run write SQL, migrations, or repair scripts
- expire Stripe sessions, reconcile orders, or call live admin mutation endpoints
- create commits, branches, pushes, or pull requests from the live host
- delete logs, caches, uploads, databases, or backups

## Expected audit workflow

1. Run `bash scripts/run-read-only-audits.sh`.
2. Run `cd apps/storefront/backend && npm run audit:updates` to inventory dependency updates.
3. For each update candidate, browse official changelogs, release notes, migration guides, and security advisories before recommending action.
4. Use [docs/CODEX_UPDATE_RECOMMENDATION_TEMPLATE.md](./CODEX_UPDATE_RECOMMENDATION_TEMPLATE.md) for the final human-facing answer.
5. Summarize findings under four buckets:
   - upgrade now
   - safe to defer
   - do not change on production yet
   - needs staging validation
6. If vendor freshness is relevant, use the local audit output first, then do a separate web review of official changelogs or docs.
7. Propose the exact staging checks needed before any production change.

## Reporting rules

Each audit report should include:

- current pinned Stripe package version
- current `STRIPE_API_VERSION`
- available package updates with `current`, `wanted`, and `latest`
- whether the worktree is clean
- whether there are stale pending checkouts
- whether there are purchases missing subscription runtime data
- whether any subscriptions need suspension or purge review
- whether the next step is observe, stage, or intervene manually

## Guardrails for upgrades

- Stripe SDK upgrades and `STRIPE_API_VERSION` changes must be treated as planned releases.
- Webhook endpoint version changes must be handled separately from app deploys.
- Live sandbox Stripe drills are required before production upgrades. See [docs/STRIPE_UPGRADES.md](./STRIPE_UPGRADES.md).
- Read-only audits may recommend changes, but they must not apply them.
- Recommendations should prefer official sources: vendor docs, changelogs, release notes, migration guides, and security advisories.
- If the online research is inconclusive, the recommendation should explicitly say so and default to `safe to defer` unless there is a security or deprecation signal.

## Notes

- The runtime audit opens the SQLite database in read-only mode.
- The audit scripts do not call Stripe, mutate the database, or write files.
- For machine-readable output, use `node scripts/audit-read-only.js --json`.
