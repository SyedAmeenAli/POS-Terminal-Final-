import { z } from "zod";

export const inventoryParamsSchema = z.object({
  variantId: z.uuid("Invalid UUID"),
});

export const inventoryAdjustmentBodySchema = z
  .object({
    eventType: z.enum([
      "SALE",
      "RESERVE",
      "RELEASE",
      "RETURN",
      "DAMAGE",
      "PURCHASE_RECEIPT",
      "ADJUSTMENT",
    ]),
    idempotencyKey: z.string().trim().min(1, "idempotencyKey is required").max(120),
    negativeOverride: z.boolean().optional().default(false),
    // T30 — see orders.ts. The unit decides, not the shape of the number.
    qtyDelta: z.coerce.number().finite(),
    reason: z.string().trim().min(1).max(500),
    variantId: z.uuid("Invalid UUID"),
  })
  .superRefine((value, ctx) => {
    if (value.eventType === "ADJUSTMENT") {
      if (value.qtyDelta === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "qtyDelta must be non-zero for ADJUSTMENT",
          path: ["qtyDelta"],
        });
      }
    } else if (value.qtyDelta <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "qtyDelta must be positive for this event type",
        path: ["qtyDelta"],
      });
    }

    if (value.negativeOverride && value.eventType !== "ADJUSTMENT") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "negativeOverride is only allowed for ADJUSTMENT events",
        path: ["negativeOverride"],
      });
    }
  });
