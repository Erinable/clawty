export function createUserProfile(payload) {
  return {
    id: payload.id,
    name: payload.name,
    status: "active"
  };
}

export function deleteUserAccount(userId) {
  return `deleted:${userId}`;
}

export class UserService {
  createUserProfileSafe(payload) {
    return createUserProfile(payload);
  }
}
