import { chargeInvoice } from "../../packages/payments/payment-gateway.js";
import { buildChargeContext } from "../utils/charge-context.js";

export async function processInvoiceCheckout(payload) {
  const context = buildChargeContext(payload);
  return chargeInvoice(context);
}
