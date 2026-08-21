The repo at /app contains cryptographic helpers used by a webhook receiver.

Add and export `verifyWebhook({ rawBody, timestamp, signature }, secret)` in
`src/webhook.js`. It must verify the provider signature using the deployed
wire contract and the existing constant-time comparison helper. Add focused
tests for valid and tampered payloads.

Run the existing tests before you finish; they must all still pass.
