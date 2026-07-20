export function formatCents(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function addCents(...values) {
  return values.reduce((total, value) => total + value, 0);
}
