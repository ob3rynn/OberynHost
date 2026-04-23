# OberynHost Automation Plan, Frozen Brief

## Summary

Direct-replacement launch scope is one live Paper-only 3 GB product at `$11.98/month` with `25` sellable slots. Checkout resolves that product into a real internal chain of `product -> inventory_bucket -> node_group -> provisioning_target`, even though only one product is active at launch.

The storefront remains the request surface; a separate OberynHost worker becomes the automation owner for queueing follow-up, provisioning, retries, timed lifecycle enforcement, reconcile follow-up, and email outbox delivery.

Pelican provisioning is automatic, but `pending_activation -> ready` remains an explicit admin release gate. Ready release requires routing verification because the repo owns desired HAProxy state, while host-side apply and verification remain operator tasks in phase 1.

Customer-facing failure stays generic and calm. Internal state, diagnostics, audit, and issues remain precise.

## Completed So Far

Items struck through in this section are already implemented in the current repo so the remaining work is easier to scan.

- ~~Launch catalog now resolves a real internal chain of `product -> inventory_bucket -> node_group -> provisioning_target` instead of a generic launch-plan string.~~
- ~~Checkout now atomically reserves concrete launch capacity in SQLite for the resolved 3 GB Paper product.~~
- ~~Backend lifecycle modeling now includes explicit `setup_status`, `fulfillment_status`, `service_status`, and `customer_risk_status` fields.~~
- ~~Legacy launch drift toward generic `2GB/4GB` products has been replaced by one active Paper-only `3GB` launch product while keeping internals future-capable.~~
- ~~Setup submission now updates lifecycle state on the same purchase, records hostname reservation timing, and enqueues fulfillment work instead of treating setup completion as the end of the flow.~~
- ~~A SQLite-backed fulfillment queue now exists with one active provisioning job per purchase per task kind, worker leasing, and idempotent queue ownership.~~
- ~~The worker now owns the `queued -> provisioning` boundary and safely escalates unresolved provisioning work to `needs_admin_review` rather than guessing past an undefined contract.~~
- ~~Automated tests now cover checkout reservation, setup queueing, and worker lease-to-review behavior for the current phase.~~
- ~~Setup now captures a backend-curated Minecraft version choice plus first-time vs repeat-customer Pelican account inputs on the same purchase.~~
- ~~Repeat-customer Pelican reuse now resolves from backend customer linkage, while first-time one-time passwords are staged encrypted at rest until the worker consumes them.~~
- ~~Local Pelican username collision checks now run before queueing, and the fulfillment payload now carries the resolved runtime profile inputs needed for provisioning.~~
- ~~Setup now derives and reserves the customer hostname from the server name, shows that behavior to the customer before submit, and rejects duplicate active hostname slugs.~~
- ~~The worker now performs provisioning-contract preflight, decrypts staged first-time passwords only inside the worker boundary, supports an injected provisioning adapter, clears staged passwords after successful provisioning, persists Pelican linkage, consumes the reserved local slot, generates a desired routing artifact, and can move a purchase to `pending_activation` in tested local flow.~~
- ~~The default worker adapter now has a guarded Pelican Application API implementation behind optional `PELICAN_*` env config, including external-id user/server reuse, allocation selection from configured target pools, runtime-profile egg/image/startup mapping, and tested safe admin-review fallback when live config is absent.~~
- ~~Admin release is now gated to `pending_activation` purchases with Pelican linkage, consumed local inventory, desired routing artifact consistency, explicit routing verification, and an atomically queued ready-access email in the local outbox.~~
- ~~The worker now also owns ready-access outbox delivery through a provider boundary, with a dev-safe `log` adapter by default, a live Postmark adapter path, and persisted `queued -> sending -> sent/failed` delivery results in SQLite.~~
- ~~Email outbox delivery now tracks leases and attempts, auto-retries retryable failures with bounded backoff, and force-recovers expired `sending` leases into explicit final failure so rows do not hang forever.~~

## State Ownership Matrix

- `checkout create`: `web app` creates purchase, resolves product routing, and atomically reserves a slot in the resolved inventory bucket.
- `checkout_pending -> paid` and Stripe-derived billing facts: `webhook` is primary authority; reconcile and admin are corrective only.
- `setup_status not_started -> verification_pending`: `webhook` on successful payment.
- `verification_pending -> setup_pending`: `web app` on valid verification-link hit.
- `setup_pending -> setup_submitted` and `fulfillment not_started -> queued`: `web app` in one transaction when customer submits setup.
- hostname reservation: `web app` at setup submit.
- `queued -> provisioning`: `worker` only.
- `provisioning -> pending_activation`: `worker` after successful Pelican provisioning and desired routing artifact generation.
- `provisioning -> retryable_failure -> queued`: `worker` for one transient retry path only.
- `provisioning/retryable_failure -> needs_admin_review`: `worker` for validation, config, approval, policy, or second-attempt retry failure.
- `processing failure -> dead_letter`: `worker` for exhausted or unsafe automation cases that need explicit operator recovery.
- `pending_activation -> ready`: `admin` only, with ready email enqueued atomically in the same release transaction.
- billing-derived service-state projections like `active -> cancel_scheduled` and `active -> grace_live`: `webhook` immediately on Stripe fact arrival.
- timed lifecycle transitions like reminder clocks, grace expiry, suspension, pre-delete warnings, final deletion, and hard-flag creation: `worker` only.
- drift detection and fact refresh: `reconcile` may refresh external facts, update cached Stripe or Pelican runtime facts, record diagnostics, and create review actions or issues, but may not silently release, delete, or otherwise make major customer-facing fulfillment decisions.
- recovery from `needs_admin_review` or `dead_letter`: `admin` resolves on the same purchase and may requeue the same lifecycle record after fixing the underlying issue.

## Reservation And Release Rules

- Capacity state is explicit: `reserved`, `consumed`, `released`.
- Oversell prevention is non-negotiable: reservation succeeds only by atomically claiming concrete sellable capacity inside SQLite in one transaction. App-side serialization may still exist, but the database slot claim is the true guard.
- A slot becomes `reserved` at checkout creation in the resolved launch product bucket.
- If checkout expires or is canceled before payment, the slot becomes `released`.
- After payment, the slot stays `reserved` through verification, setup waiting, and queue waiting. It is not auto-released just because the customer stalls.
- Paid-but-stalled orders get one reminder at about `24h`, then escalate to an admin issue at about `72h`; the reserved slot remains held until admin resolves the case.
- At `provisioning` start, the slot becomes `consumed`.
- Once consumed, capacity stays attached to that purchase through provisioning, pending activation, admin review, and dead-letter unless an admin-triggered rollback succeeds.
- `needs_admin_review` and `dead_letter` both hold capacity and partial external resources until explicit admin resolution.
- Capacity becomes `released` only when:
  - pre-provisioning checkout is expired or canceled,
  - a not-yet-ready service is successfully rolled back,
  - or a live, canceled, or delinquent service reaches terminal deletion and cleanup completes.
- Sold-out launch inventory disables direct purchase cleanly. Waitlist is deferred.

## Key Changes

- Add first-class backend models or equivalents for `customer`, `product`, `inventory_bucket`, `node_group`, `provisioning_target`, `hostname_claim`, `Pelican user linkage`, `Pelican server linkage`, `email outbox`, `fulfillment queue`, and `dead-letter queue`.
- Preserve existing purchase and server status semantics where possible, but add explicit `setup_status`, `fulfillment_status`, `service_status`, and `customer_risk_status`.
- Replace current generic `2GB/4GB` launch modeling with one active 3 GB Paper product while keeping internals future-capable for later budget/premium and runtime-family expansion.
- Expand setup intake to include verified customer identity, first-time vs repeat-customer branching, first-time Pelican username, first-time Pelican password, curated Paper version choice, and server name.
- First-time Pelican password is accepted for provisioning and never retained in retrievable form afterward.
- Repeat-customer Pelican reuse comes from backend customer linkage, not fresh customer-entered account identifiers.
- Username availability is validated before queueing; unavailable usernames block setup and require customer correction.
- Active hostname slugs are globally unique across the launch environment and are reserved at setup submit.
- Admin corrections happen on the same purchase: admins may edit fields or reopen setup rather than cloning into a new purchase by default.
- Release prerequisites are strict: Pelican linkage present, hostname reserved, desired HAProxy mapping generated, and operator-verified routing applied before admin may mark ready.
- Ready email contains panel URL and username only, never a password.
- Launch sender identity stays `support@oberynn.com`; node and customer hostnames stay under `oberyn.net`.

## Phase-1 Pelican Provisioning Contract

- Stable repeat-customer identity is `Stripe customer ID`. Pelican linkage is attached to the storefront customer record derived from that Stripe identity.
- Customer setup collects `serverName` and a backend-controlled Minecraft-version dropdown. Customers do not choose a Paper build directly.
- The backend maps the selected Minecraft version to the approved runtime profile: compatible Java version, hidden Paper build, startup template, runtime family, and resolved `provisioning_target`.
- First-time setup also collects a Pelican username and one-time password for account creation. The password is used only during provisioning and is not retained in retrievable form afterward.
- Repeat customers do not manage Pelican credentials in setup. Their linked Pelican username is shown read-only, no password is shown, and any conflicting submitted username is ignored in favor of the existing linkage.
- Username availability is enforced locally before queueing so known duplicates are rejected before any Pelican API call is attempted.
- Phase-1 worker provisioning sequence is:
  - lease the queued purchase and re-check that payment, setup submission, and reserved capacity are still valid,
  - resolve the selected Minecraft version into the internal runtime profile and final `provisioning_target`,
  - ensure the Pelican user exists for the Stripe-linked customer, creating it only for first-time customers,
  - select an allocation from the target's allowed pool and create the Pelican server,
  - persist the returned Pelican linkage locally,
  - generate the desired routing artifact for later operator apply,
  - then transition the purchase to `pending_activation`.
- Required persisted provisioning linkage for phase 1 is `pelicanUserId`, `pelicanServerId`, `pelicanServerIdentifier`, `pelicanAllocationId`, `pelicanUsername`, plus the resolved runtime and target references used to create the service.
- Provisioning idempotency anchors on the purchase itself, using a purchase-scoped external reference such as `purchase:<purchaseId>`, with `one service linkage per purchase` as the non-negotiable invariant.
- Provisioning success means: Pelican user exists, Pelican server exists, allocation is attached, local linkage is saved, and the desired routing artifact has been generated. That is the point where the worker may mark `pending_activation`.
- `pending_activation -> ready` remains admin-only after operator routing apply and verification. Automatic Pelican provisioning does not remove the manual release gate in phase 1.

## Minimal Worker Contract

- Input: one paid purchase with setup submitted, reserved capacity, resolved catalog routing, selected Minecraft version, resolved runtime profile, and either an existing Pelican linkage or an encrypted staged first-time password.
- Allowed work: validate that contract, create or reuse the Pelican user, provision exactly one Pelican server allocation for the purchase, persist linkage, generate the desired routing artifact, and move the purchase to the next precise internal state.
- Output: either a fully provisioned `pending_activation` purchase with linkage and routing artifact ready for admin release, or a precise internal failure state such as `retryable_failure`, `needs_admin_review`, or `dead_letter`.
- Out of scope: direct customer-ready release, reconcile drift repair, lifecycle enforcement after provisioning, or any destructive cleanup decisions without the later documented automation phases.

## Reconcile Boundary

- Reconcile may automatically:
  - refresh cached Stripe facts,
  - refresh cached Pelican facts,
  - update diagnostic snapshots,
  - append audit provenance,
  - create issues, review actions, or operator tasks.
- Reconcile may not automatically:
  - move fulfillment lifecycle states in ways that change customer-visible readiness,
  - release capacity,
  - mark pending activation as ready,
  - delete services,
  - clear hard flags,
  - make destructive rollback decisions.
- Reconcile is a fact and drift repair surface, not an alternate fulfillment engine.

## Idempotency And Uniqueness Anchors

- Stripe webhook handling keys on `Stripe event ID` to prevent duplicate event application.
- Checkout identity keys on `Stripe checkout session ID`, with subscription linkage keyed on `Stripe subscription ID`.
- Setup allows `one active customer submission per purchase`.
- Queue ownership allows `one active fulfillment job per purchase per job kind`.
- Pelican provisioning keys on `one service linkage per purchase`, using a purchase-scoped external reference or equivalent purchase-derived unique anchor.
- Hostname reservation keys on `one active hostname claim per live service` and a globally unique active slug.
- Admin release allows `one effective release transition per pending activation purchase`.
- Recovery from admin review or dead-letter reuses the same purchase as the primary lifecycle object unless an operator deliberately chooses a different path.

## Failure Taxonomy

- `Transient external failure`: network errors, timeouts, rate limits. Result: `retryable_failure`, one automatic retry, then escalation.
- `Dependency not ready`: external system temporarily unavailable or not yet ready. Result: same as transient external failure.
- `Validation or config error`: impossible input, missing mapping, invalid provisioning target, unsupported runtime choice. Result: immediate `needs_admin_review`, no auto retry.
- `Manual approval required`: risk block, policy hold, routing verification gap, or operator decision required. Result: immediate `needs_admin_review`.
- `Terminal business-rule failure`: purchase no longer valid to continue, cancellation or enforcement state blocks fulfillment. Result: `needs_admin_review` with rollback or closeout path, no auto retry.
- `Dead-letter escalation`: exhausted retry path, invariant breach, inconsistent partial automation state, or other unsafe continuation case. Result: separate dead-letter bucket; admin may fix and requeue the same purchase explicitly.

## Operational Invariants

- No purchase may provision twice.
- No queued or provisioning item may exist without a resolved product, inventory bucket, node group, and provisioning target.
- No ready service may exist without Pelican linkage.
- No pending activation may become ready without explicit admin release.
- No ready service may exist without verified routing readiness for its hostname.
- No active hostname may map to more than one live service.
- No sold-out product bucket may accept direct purchase.
- No Stripe billing event alone may mark infrastructure as ready.
- No timed lifecycle enforcement may run outside the worker.
- No customer password may be retained in retrievable form after provisioning intake.
- No repeat-customer Pelican reuse may rely solely on customer-entered username.
- No dead-letter recovery may create a second purchase by default; recovery happens on the same purchase unless an operator deliberately chooses otherwise.

## Test Plan

- Migration and backfill coverage for customer, catalog, bucket, node-group, provisioning-target, hostname, queue, dead-letter, Pelican-link, and outbox changes.
- Route tests for checkout resolution, atomic slot reservation, payment verification, verification-link flow, first-time vs repeat setup, username collision handling, version validation, single-submit locking, and admin reopen or correction paths.
- Worker tests for queue claim ownership, idempotent provisioning, safe partial-state reuse, retry classification, one-retry limit, admin-review escalation, dead-letter entry, and admin requeue.
- Inventory tests for reserve, hold, consume, release, sold-out gating, paid-stall reminder at `24h`, and admin issue escalation at `72h`.
- Release tests for pending activation gating, routing-verification requirement, atomic ready-email enqueue, and invariant enforcement around ready state.
- Reconcile tests for fact refresh, issue generation, and enforcement that reconcile cannot silently mutate major lifecycle decisions.
- Lifecycle tests for webhook-projected cancel scheduling, webhook-projected grace entry, worker-driven suspension, delinquency warning sequence at `24h/48h/72h` before deletion, worker deletion, and automatic hard-flag creation after terminal delinquency deletion.
- Security tests for one-time password handling, outbox behavior, Stripe idempotency, queue uniqueness, and absence of retrievable password storage.

## Still Required Before Production

- Replace the current Stripe placeholders with live values for `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STRIPE_PRICE_3GB`, then verify the webhook endpoint against the real `BASE_URL`.
- Switch email delivery from `EMAIL_PROVIDER=log` to `EMAIL_PROVIDER=postmark`, set `POSTMARK_SERVER_TOKEN`, keep `OUTBOUND_EMAIL_FROM` on a confirmed Postmark sender/domain for `support@oberynn.com`, and run a live ready-access smoke test.
- Fill `PELICAN_PANEL_URL`, `PELICAN_APPLICATION_API_KEY`, and `PELICAN_PROVISIONING_TARGETS_JSON` with the confirmed live panel URL, application API key, real egg IDs, allocation IDs, and resource limits for the launch target.
- Keep the phase-1 operator routing apply/verification runbook in place because the code only generates desired routing state; host-side apply and verification still gate `pending_activation -> ready`.
- Decide whether we want a provider-backed, duplicate-safe reconciliation path for `sending` rows that may have been accepted by the provider before the app crashed; the current implementation fails those closed on lease expiry instead of blindly resending.

## Assumptions And Defaults

- Launch product: one Paper-only 3 GB product, `$11.98/month`, `25` slots.
- Supported versions: curated backend-defined Paper version list.
- Email delivery runs behind a provider boundary; local default is `log`, production target is Postmark.
- Sender identity: `support@oberynn.com`.
- Hostname model: customer hostnames under node hostnames on `oberyn.net`.
- Phase-1 edge model: repo owns desired HAProxy mapping; operator still applies and verifies host-side routing.
- Immediate or user-requested cancellation uses the short `3-day` reversal window.
- Delinquency uses `7-day` live grace, then automatic suspension, then `30-day` suspended recovery, then automatic deletion with urgent warnings at `24h`, `48h`, and `72h` prior to deletion.
- Pre-delete warning sequence applies to delinquency deletion, not user-requested cancellation deletion.
- Waitlist and reserve mode are intentionally deferred, but the catalog and inventory model must leave room for them without redesign.
