export async function saveUserProfile(record) {
  return {
    ok: true,
    version: 2,
    record
  };
}
