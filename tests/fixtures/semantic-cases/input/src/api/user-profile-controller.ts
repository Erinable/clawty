import { ensureAuth } from "../middleware/auth.js";
import { updateUserProfile } from "../services/user-profile-service.ts";

export async function handleUpdateProfile(req, res) {
  const user = ensureAuth(req);
  const payload = req.body || {};
  const result = await updateUserProfile(user.id, payload);
  return res.json(result);
}
