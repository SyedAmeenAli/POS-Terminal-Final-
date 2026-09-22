import type { users } from "../../infrastructure/database/schema.js";

/**
 * Login was removed: this deployment is single-owner and every request runs as the
 * owner account (see `src/api/middleware/auth.ts`). This type is kept because
 * `request.user` still carries the acting identity for audit trails and the
 * `actorUserId` foreign keys on orders, inventory and user management.
 */
export type AuthenticatedUser = {
  id: string;
  role: typeof users.$inferSelect.role;
};
