import { respondError, respondOk } from "./errors.js";
import { users } from "./store.js";

export function getUser(id) {
  const user = users.get(id);
  if (!user) {
    return respondError(404, "user_not_found", `No user with id ${id}`);
  }
  return respondOk(user);
}
