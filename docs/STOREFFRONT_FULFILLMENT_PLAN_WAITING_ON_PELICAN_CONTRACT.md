# Storefront Fulfillment Plan Waiting On Pelican Contract

Status: Paused before implementation on purpose.

Reason: The storefront automation design is mostly defined, but the Pelican-side
contract is not yet specific enough to automate safely.

## What Is Already Settled

- Stripe stays the billing source of truth.
- Pelican will be the provisioned-service source of truth.
- `/admin` becomes the operator control plane for retries, overrides,
  reconcile, diagnostics, and lifecycle actions.
- The current storefront purchase lifecycle and admin surface should be
  preserved and extended, not rewritten.
- Billing state and fulfillment state must be separate.
- Fulfillment should use a SQLite-backed job queue with retry, idempotency,
  dead-letter handling, and periodic reconcile sweeps.
- Tests should be layered:
  - fast mocked CI and local tests
  - queue and lifecycle worker tests
  - integration drills
  - optional Pelican smoke coverage
- Feature flags should be split so provisioning, suspension, deprovision, and
  overall automation can be enabled independently.
- `failed` and `action_required` must be visibly different in admin and
  diagnostics.
- Audit entries should record whether they came from an operator, worker,
  webhook, or reconcile sweep.
- Dead-letter and blocked fulfillment items must be visible in the Issues view.
- This is a single-runtime SQLite automation system for now, not a horizontal
  multi-instance design.

## Policy Decisions Already Made

- Reuse Pelican users across multiple purchases.
- Use a stable external ID as the primary Pelican user linkage.
- Use email only as a fallback for recovery or migration.
- Keep the existing post-payment `serverName` step.
- Use `serverName` as the initial Pelican server display name during
  provisioning.
- Later local or admin edits to `serverName` stay local in this pass and do not
  automatically rename the Pelican server.
- Preserve the current grace, suspension, and retention model.
- Final terminal cleanup should be configurable after retention, not hardcoded.
- Runtime mode should support something like `delete` vs `notify_admin`.

## What Is Not Settled Yet

The actual Pelican-side lifecycle contract still needs to be defined:

- what API operations the storefront will call
- what inputs are required to create a Pelican user and server
- what Pelican IDs and state the storefront must persist locally
- how suspend, unsuspend, and delete map to real Pelican behavior
- what "deprovision" technically means in Pelican
- how reconciliation works when local storefront state and Pelican drift apart

## Practical Meaning

The storefront-side automation plan is mostly ready.

Implementation should not begin until the Pelican-side provisioning and
lifecycle contract is defined clearly enough that the automation layer is not
forced to guess.

## Next Required Step

Define the Pelican-side contract first.

Recommended order:

1. Provisioning contract
2. Suspend and unsuspend behavior
3. Terminal cleanup and retention behavior
4. Reconciliation and drift recovery rules
