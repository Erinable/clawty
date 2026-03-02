import { saveUserProfile } from "../repositories/user-profile-repo.ts";

export async function updateUserProfile(userId, patch) {
  return saveUserProfile({
    user_id: userId,
    profile_patch: patch
  });
}
