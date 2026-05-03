# Support Framework Upgrade Plan

Implement this as a focused support-framework PR. Keep the implementation boring, deterministic, and test-heavy. Prefer reusing existing lifecycle/session/email/admin primitives over inventing new account systems or new fulfillment paths. Do not broaden scope into AI chat, public ticketing, or live external state fetching.

## Summary

Build the full support framework with one guiding priority: reduce repeated admin questions while keeping support safe, deterministic, and self-managed-Minecraft clear.

The support hub is verified-context-first. Anonymous users may read scope/help guidance and see a mailto fallback for purchase-access recovery only, but they cannot create database tickets from public input.

## Key Changes

- Replace `/support` with a verified support hub, not a public ticket form.
  - If verified context exists, show public-safe service/setup/billing explanations, deterministic guidance, ticket intake, and eligible self-service actions.
  - If no verified context exists, show support scope, customer-path guidance, pricing/waitlist direction, and purchase-access mailto fallback only.
  - Do not present mailto as general prospect support or unmanaged Minecraft help.
- Define verified support session as one of:
  - valid setup/verification/support token tied to a purchase,
  - valid customer portal/session flow already recognized by the app,
  - or another existing signed, expiring token mechanism already present in the repo.
- Do not add customer accounts, password login, or anonymous public ticketing.
- Add customer APIs only as needed for verified support hub context, verified ticket creation, eligible Billing Portal creation/fallback, and eligible ready-email resend.
- Add rate limits for support ticket creation, ready-email resend, and Billing Portal access attempts.
  - Key by verified purchase/session where available.
  - Use IP fallback where appropriate.
- Add safe support self-service:
  - show panel URL, hostname, and username only when verified and allowed,
  - create Stripe Billing Portal access only when the backend already has enough verified customer/subscription context,
  - otherwise show deterministic billing guidance and support fallback.
- Add ready-access email resend only when purchase/service is verified, service is ready, customer-facing access fields exist, requesting context matches purchase/customer email, and one-hour cooldown has expired.
- Customer-facing status text must map internal lifecycle states to calm public explanations.
  - Do not expose raw internal states like dead-letter, invariant breach, worker failure, admin review internals, or diagnostic details directly to customers.

## Tickets And Rules

- Add support ticket/event/snapshot tables with safe defaults.
  - Existing purchases/services do not need backfilled tickets.
  - Creation snapshots and ticket events must not store secrets, raw tokens, passwords, Stripe secrets, Pelican credentials, or full sensitive payloads.
- Add support tickets with opaque refs like `OH-7K4Q2M`.
  - Refs must be unique, non-sequential, customer-safe, and must not encode database IDs, purchase IDs, or customer information.
- Store `category`, `scope_classification`, `priority`, `human_required`, `rule_recommendation`, and nullable `escalation_reason`.
- Store immutable creation snapshot; admin also sees current cached local state.
- Ticket statuses: `waiting_on_customer`, `needs_admin`, `admin_review`, `replied`, `resolved`, `closed_no_response`.
- Defaults:
  - low-risk guided submissions still create ticket/event records and default to `waiting_on_customer`,
  - risky or human-required tickets default to `needs_admin`,
  - unknown or ambiguous tickets default to `needs_admin`.
- Scope classifications: `oberynhost_responsibility`, `customer_responsibility`, `mixed_diagnostic`, `billing_account`, `human_required`, `unknown`.
- Add safe deterministic rules.
  - Repeated low-risk questions get immediate guidance in the acknowledgment email.
  - Risky categories remain human-required: abuse, security ambiguity, refunds/disputes, legal threats, destructive requests, severe outage ambiguity.

## Admin, Docs, And UX

- Add separate `/admin/support`.
  - Reuse existing admin authentication and same-origin protections.
  - No support admin endpoint may be customer-accessible.
  - Default view prioritizes tickets needing admin attention.
  - Founder workflow: classify, review context/rule recommendation, choose macro/freeform reply, update status.
- Admin status, classification, note, and reply actions must create immutable ticket events.
  - Do not allow silent mutation of ticket history.
- Admin replies send through existing email outbox.
- Customer email followups are not ingested/tracked in v1.
- Support message rendering must escape/sanitize customer content.
- Support hub and admin support views should show clear loading, empty, and error states, and avoid fragile JavaScript-only flows where practical.
- Add docs and macros under `docs/support/` with firm-but-warm language.
  - Clearly include hosting, billing, panel access, provisioning, routing, allocation, and platform issues.
  - Clearly exclude plugins, gameplay, moderation, custom server administration, broken customer configs, and workload-caused performance issues.

## Config And Non-goals

- Add config audit coverage for support flags and rate-limit defaults.
- All assistant/model flags must default off and be reported by config audit if enabled.
- Non-goals:
  - no public anonymous ticketing system,
  - no full customer account/login system,
  - no inbound email parsing,
  - no live model calls,
  - no customer-facing assistant,
  - no automatic refunds, provisioning, suspension, deletion, or lifecycle overrides,
  - no Pelican/Stripe live fetches in support context builders,
  - no plugin/mod/gameplay troubleshooting engine,
  - no SLA system.

## Test Plan

- Cover verified support-session handling, anonymous `/support` behavior, no anonymous ticket creation, rate limits, opaque ticket ref uniqueness/safety, taxonomy validation, ticket creation, low-risk guided ticket recording, immutable ticket events, no secrets in snapshots/events, context snapshots, public-safe lifecycle wording, current-state admin context, deterministic rules, ready-email resend eligibility/cooldown, Stripe portal availability fallback, admin auth, same-origin protection, admin replies/outbox, config audit behavior, basic UI empty/error states, HTML/script inert rendering, and disabled assistant behavior.
- Run `npm test` in `apps/storefront/backend`.

## Assumptions

- Stripe remains the billing/account-management surface.
- Existing signed/session/token mechanisms should be reused where possible.
- Support observes and explains lifecycle state; it does not mutate dangerous service state.
- Anonymous users can use mailto for purchase-access recovery, but cannot create database tickets.
