import { STRIPE_TIMEOUT_MS } from "../../config/payments.js";

export async function chargeInvoice(context) {
  const timeoutMs = STRIPE_TIMEOUT_MS;
  return {
    status: "charged",
    invoice_id: context.invoice_id,
    timeout_ms: timeoutMs
  };
}
