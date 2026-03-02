import { chargeInvoice } from "../../packages/payments/payment-gateway.js";

export async function syncPendingPayments() {
  return chargeInvoice({
    invoice_id: "pending-batch",
    user_id: "system"
  });
}
