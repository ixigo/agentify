The repo at /app contains a tiny billing gateway used by a settlement webhook.

Add and export `settleInvoice(event)` in `src/settlement.js`. The event has
`id`, `invoiceId`, and `amountCents` fields. Capture the invoice through the
existing gateway and return its receipt, following the production settlement
contract. Add focused tests for the new handler.

Run the existing tests before you finish; they must all still pass.
