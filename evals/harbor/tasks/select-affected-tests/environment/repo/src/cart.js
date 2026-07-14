// pricekit — cart aggregation helpers, all working in integer cents.
export function cartSubtotalCents(items) {
  return items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
}

export function itemCount(items) {
  return items.reduce((n, item) => n + item.qty, 0);
}
