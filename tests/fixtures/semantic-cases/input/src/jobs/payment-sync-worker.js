import { PAYMENT_RETRY_LIMIT } from "../../config/payments.js";
import { withRetry } from "../utils/retry.js";
import { syncPendingPayments } from "../services/payment-sync.js";

export async function runPaymentSyncJob() {
  return withRetry(() => syncPendingPayments(), {
    retries: PAYMENT_RETRY_LIMIT
  });
}
