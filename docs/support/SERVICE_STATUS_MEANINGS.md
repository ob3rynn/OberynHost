# Service Status Meanings

Customer-facing support copy should map internal states to calm public explanations.

- Checkout pending: payment is still being verified.
- Paid, setup pending: payment is verified and server details are still needed.
- Setup submitted: server details were received and provisioning is waiting or underway.
- Provisioning: the service is being prepared.
- Pending activation: the service is prepared and waiting on final routing checks.
- Ready or active: the service is ready to use.
- Grace live: payment needs attention, but the service is still recoverable.
- Cancel scheduled: the service remains active until the scheduled cancellation date.
- Suspended final recovery: the service is suspended for nonpayment and may be recoverable for a limited time.
- Deleted: the service has been closed.

Do not show raw states such as dead-letter, invariant breach, worker failure, or internal admin-review details to customers.
