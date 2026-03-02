export const STRIPE_TIMEOUT_MS = 9000;
export const PAYMENT_RETRY_LIMIT = 3;

export function getPaymentConfig() {
  return {
    timeout_ms: STRIPE_TIMEOUT_MS,
    retry_limit: PAYMENT_RETRY_LIMIT
  };
}
