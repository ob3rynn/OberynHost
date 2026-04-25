# Live-ish Fulfillment Test Harness

This harness is an operator-run integration test around the storefront automation system. It exercises the real local/dev chain as far as practical before production:

Stripe test checkout -> Stripe webhook -> paid purchase -> setup submitted -> fulfillment queued -> worker provisions through Pelican -> local/dev Wings exposes the server through Pelican Client API -> purchase reaches `pending_activation` -> operator verifies routing -> operator releases ready.

It is dev-only. It does not prove production Cloudflare behavior, public DNS, firewall rules, final HAProxy routing, or production network topology. HAProxy apply/reload remains out of scope; desired routing artifact generation is in scope.

## Product Truth

- Product: `Paper 2 GB`
- Plan type: `paper-2gb`
- Product code: `minecraft-paper-2gb`
- Runtime: Paper
- Container memory limit: `2424 MB`
- JVM memory target: `2024 MB`
- Billing: Stripe test-mode recurring price in `STRIPE_PRICE_PAPER_2GB`

Do not use legacy `2GB`, `4GB`, `3GB`, `STRIPE_PRICE_2GB`, `STRIPE_PRICE_4GB`, or `STRIPE_PRICE_3GB` values for the launch harness.

## One-Time Operator Setup

1. In Stripe Dashboard test mode, create product `Paper 2 GB`.
2. Create its recurring test price and copy the price id into `STRIPE_PRICE_PAPER_2GB`.
3. Run the Stripe CLI listener or create a test webhook endpoint pointing at:

```bash
http://127.0.0.1:3000/api/stripe/webhook
```

4. Copy the test webhook secret into `STRIPE_WEBHOOK_SECRET`.
5. Keep `EMAIL_PROVIDER=log` for the core harness. Postmark is optional and not required here.
6. Create or choose a reusable Pelican harness user.
7. Generate a Client API key for that Pelican harness user and set:

```bash
LIVEISH_HARNESS_PELICAN_USER_ID=
LIVEISH_HARNESS_PELICAN_USERNAME=
LIVEISH_HARNESS_PELICAN_CLIENT_API_KEY=
```

8. Build and review the Pelican target JSON from operator-owned values. The helper validates, but it does not invent Pelican IDs, Docker images, startup commands, environment variables, allocation IDs, node IDs, nest IDs, or target codes.

```bash
cd apps/storefront/backend
npm run build:liveish-target -- --target-json-file ./operator-target.json
```

9. Put the resulting `PELICAN_PROVISIONING_TARGETS_JSON` into the live-ish environment.

Use `apps/storefront/backend/.env.liveish.example` as the checklist for the harness-specific env. When `backend/.env.liveish` exists, the harness scripts and the local Stripe dev helper prefer it over `backend/.env`, so restart the backend after changing it.

## Commands

Run the audit first:

```bash
cd apps/storefront/backend
npm run audit:liveish
```

Run the real smoke only when local Stripe forwarding, the backend, Pelican, and Wings are ready:

```bash
OBERYNHOST_RUN_LIVEISH=1 npm run smoke:liveish
```

Without `OBERYNHOST_RUN_LIVEISH=1`, the smoke exits safely and does not create anything.

Cleanup is dry-run by default:

```bash
npm run cleanup:liveish
```

Local cleanup and Stripe test subscription cancellation require explicit flags:

```bash
npm run cleanup:liveish -- --apply-local
npm run cleanup:liveish -- --cancel-stripe
```

The cleanup script only targets artifacts marked with `liveish-<timestamp>-<short-random>`. It never deletes Pelican resources.

## Smoke Scenarios

The smoke intentionally uses two marked purchases:

- First-time customer scenario: creates a new Pelican user, provisions a server, verifies Application API linkage, verifies local linkage, verifies staged password fields are cleared, verifies desired routing artifact generation, and stops at `pending_activation`.
- Reusable-user scenario: pre-links the Stripe test customer to the reusable Pelican harness user, provisions a server for that user, then verifies customer-side Pelican Client API resource visibility for the server.

The split is important. A first-time customer path proves password lifecycle. A reusable-user path proves customer-side Client API/Wings visibility without assuming the harness can obtain a Client API token for a newly created customer.

## Acceptance Criteria

A passing live-ish smoke proves:

- active launch product is `Paper 2 GB`
- container memory is `2424 MB`
- JVM target is `2024 MB`
- Stripe test mode can drive payment state
- setup submission queues fulfillment
- the worker uses the real Pelican Application API
- Pelican creates or reuses the user depending on scenario
- Pelican creates the server
- local/dev Wings is visible through the customer-side Client API resource endpoint
- local linkage is saved
- staged customer password fields are cleared after first-time provisioning
- desired routing artifact is generated
- purchase reaches `pending_activation`
- purchase is not marked ready automatically

Admin release remains manual. After smoke, an operator may inspect the generated routing artifact, manually verify routing, and use the admin release action if they intentionally want to exercise that final gate.

## Out Of Scope

- production Cloudflare routing
- public DNS
- production firewall rules
- production HAProxy apply/reload
- automatic ready release
- automatic destructive Pelican cleanup
- waitlist/reserve mode
- multi-product expansion
- production Postmark requirement
- replacement-purchase recovery
