The repo at /app is a small e-commerce core library.

Rename the shipping rate function `calcShipRate` to `quoteShippingRate` across
the entire codebase: the definition, every call site, and the tests. Do not
leave a compatibility alias or re-export under the old name.

Run the existing tests before you finish; they must all still pass.
