export const captures = [];

export function capture(invoiceId, amountCents) {
  const receipt = { id: `rcpt-${captures.length + 1}`, invoiceId, amountCents };
  captures.push(receipt);
  return receipt;
}

export function resetGateway() {
  captures.length = 0;
}
