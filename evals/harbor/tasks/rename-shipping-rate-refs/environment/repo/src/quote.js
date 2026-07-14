import { calcShipRate } from "./shipping.js";

// A single quote line describing the shipping charge for a shipment.
export function quoteLine(weightKg, zone) {
  const shipping = calcShipRate(weightKg, zone);
  return { shipping, label: `Shipping (${zone})` };
}
