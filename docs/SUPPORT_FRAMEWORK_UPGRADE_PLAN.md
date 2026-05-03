# Support Framework Current State

This document records the support framework that exists in the current repo. It is not an implementation plan for a future PR.

The support framework is verified-context-first: customers can use existing private service access context to get deterministic lifecycle guidance, create scoped support tickets, request eligible billing access, and resend ready-access email when the current service state allows it. Anonymous public visitors can read support guidance and use the purchase-access recovery mailto path, but they cannot create database-backed support tickets.

## Implemented Now

- `/support` serves the customer support hub and avoids anonymous public ticket intake.
- Verified support context is built from existing signed/private access flows tied to purchase and service state.
- Verified ticket creation records support tickets, immutable ticket events, and creation snapshots without storing secrets, raw tokens, passwords, Stripe secrets, Pelican credentials, or full sensitive payloads.
- Support ticket refs are opaque customer-safe values such as `OH-7K4Q2M`, not database IDs or customer-derived identifiers.
- Ticket classification stores category, scope classification, priority, human-required state, deterministic rule recommendation, and escalation reason when applicable.
- Low-risk guided submissions can record a ticket and immediate deterministic guidance; risky, unknown, ambiguous, refund, abuse, security, legal, destructive, or severe outage ambiguity cases require admin attention.
- Customer-facing lifecycle text maps internal state to calm public explanations and does not expose dead-letter, invariant breach, worker failure, admin-review internals, or diagnostic details directly.
- Eligible verified support context can show safe service fields such as panel URL, hostname, and username when the service is allowed to expose them.
- Eligible verified support context can create Stripe Billing Portal access when the backend already has enough verified billing context; otherwise it shows deterministic fallback guidance.
- Eligible verified support context can resend ready-access email only when the service is ready, customer-facing access fields exist, the requesting context matches the purchase/customer email, and rate limits allow it.
- `/admin/support` reuses existing admin authentication and same-origin protections for ticket review, classification, notes, replies, and status changes.
- Admin support actions append immutable ticket events; replies are sent through the existing email outbox.
- Support ticket creation, ready-email resend, and Billing Portal access attempts are rate limited.
- Support docs and macros live under `docs/support/` and describe hosting, billing, panel access, provisioning, routing, allocation, and platform responsibility boundaries.

## Intentionally Disabled / Non-goals

- No anonymous public ticketing.
- No customer account system, password login, or general customer portal account layer.
- No inbound email parsing or email-thread ingestion.
- No live model calls.
- No customer-facing assistant.
- Assistant/model flags default off and must remain off for production unless a separate reviewed implementation changes that contract.
- Support does not automatically refund, provision, suspend, delete, release capacity, repair Pelican/Stripe drift, or override dangerous service lifecycle state.
- Support context builders do not perform live Pelican or Stripe fetches; they observe local verified state and explain it.
- Support does not provide a plugin, mod, gameplay, moderation, custom server administration, broken customer config, or workload-caused performance troubleshooting engine.
- Support does not implement an SLA system.

## Remaining Future Work

- Decide whether any future inbound email ingestion should exist and what verification model would prevent email from creating unsafe support context.
- Decide whether assistant/model-assisted admin drafting should ever be enabled; any version must stay admin-only, deterministic where possible, audited, and customer-invisible by default.
- Expand support macros and public FAQ coverage as real support patterns emerge.
- Add future destructive cleanup or refund workflows only through separately reviewed operator/admin contracts; do not route them through generic support ticket handling.
- Consider additional reporting views for repeated categories, response times, and unresolved admin workload after launch operations produce enough real data.

## Test/audit Expectations

- Backend tests cover anonymous `/support` behavior, rejection of anonymous ticket creation, verified ticket creation, email mismatch rejection, rate limits, opaque ref safety, deterministic classifications, immutable events, snapshot redaction, public-safe lifecycle wording, admin auth, admin event/status/classification actions, reply outbox creation, ready-email resend eligibility/cooldown, Billing Portal fallback behavior, and disabled assistant stubs.
- Config tests and read-only audits should continue to show support tickets enabled by default, support email acknowledgments enabled by default, assistant/model flags disabled by default, and support rate-limit defaults present.
- Any future support change must preserve the safety boundary that support observes and explains lifecycle state without mutating dangerous service state.
