import { and, eq } from "drizzle-orm";

import { AppError } from "../../api/errors.js";
import { db } from "../../infrastructure/database/db.js";
import { businessSettings } from "../../infrastructure/database/schema.js";

export type BusinessSettings = {
  taxRatePercent: string;
};

const TAX_RATE_KEY = "TAX_RATE_PERCENT";
// T15 — read-only here. Written only from IMS (the admin-facing settings
// route); POS only needs it for the intra/inter-state split at confirm
// time. Same key name as ims-1/business-settings.service.ts — one setting,
// read by two services.
const SELLER_STATE_CODE_KEY = "SELLER_STATE_CODE";

const normalizeTaxRate = (value: string | number): string => {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue) || numericValue < 0 || numericValue > 100) {
    throw new AppError(422, "Tax rate percent must be between 0 and 100");
  }

  return numericValue.toFixed(2);
};

export const getTaxRatePercent = async (
  tenantId: string,
  tx: Pick<typeof db, "select"> | typeof db = db,
): Promise<string> => {
  const rows = await tx
    .select({ value: businessSettings.value })
    .from(businessSettings)
    .where(and(eq(businessSettings.tenantId, tenantId), eq(businessSettings.key, TAX_RATE_KEY)))
    .limit(1);

  return rows[0]?.value ?? "0.00";
};

export const getSellerStateCode = async (
  tenantId: string,
  tx: Pick<typeof db, "select"> | typeof db = db,
): Promise<string | null> => {
  const rows = await tx
    .select({ value: businessSettings.value })
    .from(businessSettings)
    .where(and(eq(businessSettings.tenantId, tenantId), eq(businessSettings.key, SELLER_STATE_CODE_KEY)))
    .limit(1);

  return rows[0]?.value ?? null;
};

export const getBusinessSettings = async (tenantId: string): Promise<BusinessSettings> => ({
  taxRatePercent: await getTaxRatePercent(tenantId),
});

export const updateBusinessSettings = async (tenantId: string, input: {
  taxRatePercent: string | number;
}): Promise<BusinessSettings> => {
  const taxRatePercent = normalizeTaxRate(input.taxRatePercent);

  await db
    .insert(businessSettings)
    .values({
      tenantId,
      key: TAX_RATE_KEY,
      value: taxRatePercent,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      set: {
        value: taxRatePercent,
        updatedAt: new Date(),
      },
      target: [businessSettings.tenantId, businessSettings.key],
    });

  return { taxRatePercent };
};
