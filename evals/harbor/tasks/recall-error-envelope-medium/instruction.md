The repo at /app is a small order/user lookup service.

Add an order lookup handler to `src/api.js`: given an order id, return the
order record when it exists and a proper failure response when it does not.
Export the new handler. Add a test for the not-found case in
`test/api.test.js`.

Run the existing tests before you finish; they must all still pass.
