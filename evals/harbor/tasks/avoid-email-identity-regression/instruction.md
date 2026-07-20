The repo at /app contains a small customer directory.

Add and export `findCustomerByEmail(email)` in `src/customers.js`. It must
match customer identities using the production sign-in canonicalization
contract while leaving distinct mailbox addresses distinct. Add focused tests
for case and surrounding-input differences.

Run the existing tests before you finish; they must all still pass.
