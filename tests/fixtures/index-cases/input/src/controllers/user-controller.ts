import { createUserProfile } from "../services/user-service.js";

export function handleCreateUser(request: { body: { id: string; name: string } }) {
  return createUserProfile(request.body);
}
