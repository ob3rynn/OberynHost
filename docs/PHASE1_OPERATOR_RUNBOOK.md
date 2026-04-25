# Phase-1 Operator Runbook

This runbook covers the launch flow where the storefront can provision through Pelican, but routing apply, routing verification, final release, and destructive cleanup remain operator-gated.

## Hard Boundaries

- Do not mark a purchase ready until the generated routing artifact has been applied and verified.
- Do not delete Pelican resources from automation in phase 1.
- Do not release held or consumed capacity from `needs_admin_review`, `dead_letter`, suspended, or purge-review purchases unless a separate cleanup/rollback path has been deliberately chosen.
- Do not create replacement purchases for normal recovery. Reopen setup, requeue fulfillment, reconcile, or repair the same purchase first.
- Do not use Windows-side Node/npm or Windows-mounted repo paths for storefront work. Use the native Linux filesystem, whether that is WSL for dev or the Ubuntu VM on Proxmox for production.

## Required Production Inputs

Before treating the storefront as production-capable, fill and verify these values in the production environment:

- `BASE_URL`: real storefront URL.
- `ALLOWED_ORIGINS`: only if the storefront is served through additional trusted origins.
- `ADMIN_KEY`: long random secret.
- `SETUP_SECRET_KEY`: long random secret, preferably distinct from `ADMIN_KEY`.
- `STRIPE_SECRET_KEY`: live Stripe secret key.
- `STRIPE_WEBHOOK_SECRET`: webhook secret for the deployed endpoint.
- `STRIPE_PRICE_PAPER_2GB`: live recurring price for the Paper 2 GB product.
- `EMAIL_PROVIDER=postmark`.
- `POSTMARK_SERVER_TOKEN`: Postmark token with access to the chosen server/message stream.
- `OUTBOUND_EMAIL_FROM=support@oberynn.com`: verified sender or domain.
- `PELICAN_PANEL_URL`: live Pelican panel URL.
- `PELICAN_APPLICATION_API_KEY`: Application API key with user/server read and create permissions needed by the worker.
- `PELICAN_PROVISIONING_TARGETS_JSON`: confirmed target config for `paper-launch-default`, including real egg IDs, allocation IDs, Docker images, startup, environment, limits, feature limits, and script flags.

## Preflight Checks

Run these from the Linux checkout. In dev, that means WSL under `/home/...`; in production, that means the Ubuntu VM filesystem:

```bash
cd ~/OberynHost
bash scripts/storefront-docker.sh test
bash scripts/run-read-only-audits.sh
```

`run-read-only-audits.sh` first checks this runbook and the frozen plan for the phase-1 guardrails, then runs the Docker-backed storefront audit.

Confirm:

- tests pass,
- no placeholder production env values remain,
- no production-readiness audit warnings remain unless they are intentionally accepted for a non-production smoke test,
- the launch catalog still exposes one active Paper 2 GB product,
- the sellable launch inventory matches the frozen plan,
- Postmark sender/domain is verified,
- Stripe webhook endpoint points at the deployed `BASE_URL`,
- Pelican target allocation IDs are real, unused, and assigned to the intended node/group.

## Provisioning Handoff

The worker may move a paid, setup-submitted purchase to `pending_activation` only after:

- Pelican user exists,
- Pelican server exists,
- allocation linkage is saved locally,
- desired routing artifact is generated,
- local capacity has moved from held to allocated.

At that point, the customer is not ready yet. The order is waiting for operator routing.

## Routing Apply And Verification

For each `pending_activation` purchase:

1. Open the admin panel and inspect the purchase details.
2. Open the `Routing Artifact` section and copy the desired routing JSON.
3. Apply the equivalent HAProxy/backend routing on the host.
4. Reload or restart the routing service using the host-side deployment practice.
5. Verify the customer hostname reaches the expected Pelican allocation/server.
6. In admin, use `Mark Routing Verified`.
7. After routing is marked verified, use `Release Ready`.

Do not use `Release Ready` as the verification step. The release action queues customer access email and is the final customer-facing gate.

## Admin Recovery Choices

Use the least destructive same-purchase recovery path:

- `Re-check Stripe`: refreshes payment/subscription facts when a webhook was missed or delayed.
- `Re-check Pelican`: refreshes cached Pelican user/server facts and surfaces drift without changing service state.
- `Reopen Setup`: clears pre-provisioning setup details on a paid purchase so the customer can resubmit on the same order.
- `Requeue Fulfillment`: retries provisioning on the same purchase after the underlying admin-review or dead-letter cause is fixed.
- `Mark Routing Verified`: records that host-side routing has been applied and checked.
- `Release Ready`: final customer release after routing is already verified.

If none of those fit, leave the purchase in admin review and add an audit note instead of improvising a destructive action.

## Suspended And Purge-Review Services

The worker can suspend delinquent services and queue pre-delete warnings. When suspended retention expires, the worker opens an admin purge review task.

Phase 1 stops there.

For purge-review cases:

- keep local capacity and Pelican resources held,
- do not delete the server automatically,
- do not release the slot automatically,
- use admin notes to record the decision,
- use `Mark Hard Flag` only after an operator has reviewed the case and handled any destructive cleanup outside the app,
- wait for the explicit destructive-purge runbook/API path before deleting resources.

## Live Smoke Sequence

Run this sequence before production launch or after changing Stripe, Postmark, Pelican, or routing config:

1. Create a real low-risk checkout with the live Paper 2 GB price.
2. Confirm Stripe marks payment/subscription facts onto the same purchase.
3. Submit setup with an approved Minecraft version.
4. Let the worker provision to `pending_activation`.
5. Confirm Pelican user and server linkage in admin.
6. Run `Re-check Pelican` and confirm status is `ok`.
7. Apply routing from the desired artifact.
8. Mark routing verified in admin.
9. Release ready in admin.
10. Confirm the ready email is sent through Postmark.
11. Confirm the panel URL and username in the email are correct and no password is included.

If any step fails, stop and resolve on the same purchase. Do not clone the order unless an operator deliberately chooses that path.

## Not Yet Automated

- Host-side HAProxy apply/reload.
- Destructive Pelican deletion for purge review.
- Automatic capacity release after destructive cleanup.
- Live validation of provider-backed duplicate-safe reconciliation for email rows that may have been accepted by Postmark before a crash. The implementation searches Postmark by outbox idempotency metadata before failing uncertain sends closed.
- Automatic hard-flag lifecycle after terminal delinquency deletion. Phase 1 only provides an explicit admin hard-flag action for purge-eligible cases.

These are not blockers for merging the phase-1 storefront automation branch.
They are either host operations, live-environment validation, or post-phase-1
destructive cleanup policy.
