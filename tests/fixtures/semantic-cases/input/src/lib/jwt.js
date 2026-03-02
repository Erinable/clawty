export function verifyAccessToken(token) {
  const raw = String(token || "").replace(/^Bearer\s+/i, "");
  return {
    session_id: raw || "session-fallback"
  };
}
