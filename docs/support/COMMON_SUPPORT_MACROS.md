# Common Support Macros

## panel_access_info

Your service is verified. If the server is ready, the support hub can show the panel URL, hostname, and username, and can resend the ready-access email when eligible.

## service_not_ready_state

Your current service state was captured with the ticket. If setup or provisioning is still underway, we will follow the verified state instead of guessing from email alone.

## billing_portal_first

Billing changes are handled through Stripe Billing Portal when the verified service has enough billing context. If the portal is unavailable or the billing state looks wrong, this ticket gives us the context to review it.

## billing_portal_cancellation

Cancellation is handled through Stripe Billing Portal when available. If the portal is unavailable for this verified service, the founder will review the request.

## plugin_support_boundary

OberynHost supports hosting, billing, panel access, provisioning, routing, allocation, and platform issues. Plugins, gameplay, moderation, custom configs, and server administration are self-managed unless OberynHost explicitly provides that service.

## diagnostic_needed

This can be platform-related or customer-managed server behavior. We captured the verified service context so review can start from the current state.

## platform_issue_acknowledged

This sounds tied to the hosting platform, routing, provisioning, or allocated service. We captured the verified service context for founder review.

## escalation_received

This needs founder review. We recorded the request and will handle it carefully.
