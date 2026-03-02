import { ensureAuth } from "../middleware/auth.js";
import { processInvoiceCheckout } from "../services/billing-service.js";

export async function handleCheckout(req, res) {
  const user = ensureAuth(req);
  const result = await processInvoiceCheckout({
    user_id: user.id,
    invoice_id: req.body.invoice_id
  });
  return res.json(result);
}
