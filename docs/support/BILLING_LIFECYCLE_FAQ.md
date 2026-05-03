# Billing Lifecycle FAQ

Billing changes should be handled through Stripe Billing Portal when a verified purchase has enough subscription context.

- Active: payment is current and the service can remain live.
- Payment failed: Stripe could not collect payment. Update billing in the portal.
- Grace period: the service may remain live briefly while payment is fixed.
- Suspension: the service can be restricted after grace expires.
- Cancellation scheduled: the service remains available until the paid period ends.
- Deletion warning: suspended services may become eligible for removal after the recovery window.
- Terminal deletion: deleted services are no longer recoverable through normal support.
- Refunds and reversals: founder review is required; support tickets must not promise automatic refunds.

If Stripe Billing Portal is unavailable for a verified purchase, show deterministic guidance and let the founder review the case.
