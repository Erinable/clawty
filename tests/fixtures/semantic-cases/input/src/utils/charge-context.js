export function buildChargeContext(payload) {
  return {
    invoice_id: payload.invoice_id,
    user_id: payload.user_id,
    metadata: {
      source: "invoice_checkout_flow"
    }
  };
}
