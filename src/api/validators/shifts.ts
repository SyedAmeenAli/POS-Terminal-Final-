import { z } from "zod";

const moneySchema = z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/, "amount must be a decimal string");

export const openShiftBodySchema = z.object({
  cashierId: z.uuid("Invalid UUID").optional(),
  openingFloat: moneySchema,
});

export const closeShiftBodySchema = z.object({
  cashierId: z.uuid("Invalid UUID").optional(),
  countedCash: moneySchema,
  note: z.string().trim().max(500).optional(),
});

export const shiftParamsSchema = z.object({
  id: z.uuid("Invalid UUID"),
});
