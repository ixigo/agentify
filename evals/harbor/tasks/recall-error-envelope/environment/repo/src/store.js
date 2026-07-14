export const users = new Map([
  ["u-1", { id: "u-1", name: "Asha", email: "asha@example.test" }],
  ["u-2", { id: "u-2", name: "Bram", email: "bram@example.test" }],
]);

export const orders = new Map([
  ["o-100", { id: "o-100", userId: "u-1", total_cents: 4599, status: "shipped" }],
  ["o-101", { id: "o-101", userId: "u-2", total_cents: 1250, status: "pending" }],
]);
