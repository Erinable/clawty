import { verifyAccessToken } from "../lib/jwt.js";
import { loadSession } from "../services/session-store.js";

export function ensureAuth(req) {
  const payload = verifyAccessToken(req.headers.authorization || "");
  return loadSession(payload.session_id);
}
