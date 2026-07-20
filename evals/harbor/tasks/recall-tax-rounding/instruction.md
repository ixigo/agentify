The repo at /app contains integer-cent money helpers for a checkout service.

Add and export `calculateTax(amountCents, rateBasisPoints)` in `src/tax.js`.
It must return tax in integer cents and follow the checkout ledger's rounding
contract for fractional cents. Add focused tests around fractional results.

Run the existing tests before you finish; they must all still pass.
