import { calcShipRate } from "./shipping.js";

// Order total in cents: item subtotal plus shipping for the shipment.
export function checkoutTotal(subtotalCents, weightKg, zone) {
  return subtotalCents + calcShipRate(weightKg, zone);
}
