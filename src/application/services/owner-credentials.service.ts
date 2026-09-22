import { and, eq } from "drizzle-orm";

import { db } from "../../infrastructure/database/db.js";
import { ownerCredentials } from "../../infrastructure/database/schema.js";

// Fixed singleton row id within a tenant, matching ims-1's
// owner-credentials.service.ts. POS only ever verifies the owner password
// (terminal override flow), never sets it — that stays an IMS-only operation.
const OWNER_CREDENTIALS_ID = "owner";

export const getOwnerPasswordHash = async (
  tenantId: string,
  tx: Pick<typeof db, "select"> | typeof db = db,
): Promise<string | null> => {
  const rows = await tx
    .select({ passwordHash: ownerCredentials.passwordHash })
    .from(ownerCredentials)
    .where(
      and(
        eq(ownerCredentials.tenantId, tenantId),
        eq(ownerCredentials.id, OWNER_CREDENTIALS_ID),
      ),
    )
    .limit(1);

  return rows[0]?.passwordHash ?? null;
};
