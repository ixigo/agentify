// pricekit — order total helper.
// total() returns a dollars-and-cents string, e.g. "19.99".
export function total(subtotal, taxRate) {
  return (subtotal * (1 + taxRate)).toFixed(2);
}
