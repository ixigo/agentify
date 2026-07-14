import { calcShipRate } from "../shipping.js";

// Admin-facing report: recomputes the shipping rate for each shipment row.
export function shippingReport(shipments) {
  return shipments.map((shipment) => ({
    id: shipment.id,
    rate: calcShipRate(shipment.weightKg, shipment.zone),
  }));
}
