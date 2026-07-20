export const customers = [
  { id: "cus-1", email: "lina@example.test", name: "Lina" },
  { id: "cus-2", email: "casey.smith+vip@example.test", name: "Casey" },
];

export function findCustomerById(id) {
  return customers.find((customer) => customer.id === id) ?? null;
}
