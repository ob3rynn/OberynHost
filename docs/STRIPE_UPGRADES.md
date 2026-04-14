# Stripe Upgrade Checklist

Use this checklist any time we change the Stripe SDK version, `STRIPE_API_VERSION`, webhook endpoint version, or Stripe product/price wiring.

## Baseline rules

- Keep the backend dependency pinned exactly in [backend/package.json](/home/oberynn/store-site/backend/package.json) and deploy with `npm ci`.
- Keep `STRIPE_API_VERSION` explicit in every environment. The app fails fast if it is missing.
- Upgrade the app request version and the webhook endpoint version as separate steps.
- Treat the live sandbox scripts as part of the release gate, not optional smoke tests.

## Before changing anything

1. Read the Stripe changelog for the target SDK/API version.
2. List the flows affected in this repo:
   - checkout session creation in [backend/routes/api/checkout.js](/home/oberynn/store-site/backend/routes/api/checkout.js)
   - setup recovery in [backend/routes/api/setup.js](/home/oberynn/store-site/backend/routes/api/setup.js)
   - webhook processing in [backend/middleware/stripeWebhook.js](/home/oberynn/store-site/backend/middleware/stripeWebhook.js)
   - admin reconcile in [backend/routes/api/admin.js](/home/oberynn/store-site/backend/routes/api/admin.js)
3. Confirm the target API version value that will be pinned in `STRIPE_API_VERSION`.

## App-side upgrade

1. Change the exact `stripe` package version in [backend/package.json](/home/oberynn/store-site/backend/package.json).
2. Update `STRIPE_API_VERSION` in env files and deployment secrets.
3. Run:

```bash
cd backend
npm ci
npm test
```

4. Run live sandbox drills from [docs/LOCAL_SETUP.md](/home/oberynn/store-site/docs/LOCAL_SETUP.md):

```bash
cd backend
npm run test:stripe:live
npm run test:stripe:abuse
npm run test:stripe:ops:all
```

5. Verify these outcomes:
   - checkout sessions are still created successfully
   - successful payments still mark purchases as `paid`
   - subscription IDs, customer IDs, price IDs, and period end values still persist correctly
   - webhook retries or outages can still be recovered via admin reconcile

## Webhook upgrade

1. In Stripe, create a second test webhook endpoint pinned to the new webhook API version.
2. Deliver the same events to that endpoint and verify our handler still accepts:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.expired`
   - `invoice.paid`
   - `invoice.payment_failed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
3. Only switch production webhook traffic after the new endpoint payloads have been validated.

## Production rollout

1. Deploy app code first with the new pinned SDK and `STRIPE_API_VERSION`.
2. Watch logs and metrics for:
   - checkout creation failures
   - webhook signature or parsing failures
   - spikes in `/api/admin/purchases/:purchaseId/reconcile-stripe`
   - purchases stuck in `checkout_pending`
3. After the app is stable, switch the production webhook endpoint version.
4. If anything looks wrong, use Stripe's rollback window for the account-side upgrade and keep the app pinned until the incompatibility is understood.

## Repo-specific notes

- Most automated tests mock Stripe in [backend/test/helpers/testApp.js](/home/oberynn/store-site/backend/test/helpers/testApp.js), so unit tests protect our state transitions more than Stripe response compatibility.
- The live sandbox scripts are what catch real hosted checkout and webhook behavior changes.
- The admin reconcile endpoint provides an operational fallback when webhooks are delayed or missed.
