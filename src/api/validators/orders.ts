import { z } from "zod";

const uuidSchema = z.uuid("Invalid UUID");

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const addressFieldsSchema = z.object({
  shippingAddressLine1: z.string().trim().min(1).max(255).optional(),
  shippingCity: z.string().trim().min(1).max(100).optional(),
  shippingPostalCode: z.string().trim().min(1).max(20).optional(),
  shippingState: z.string().trim().min(1).max(100).optional(),
});

const discountFieldsSchema = z
  .object({
    discountType: z.enum(["percent", "flat"]).optional(),
    discountValue: z.coerce.number().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    const hasType = value.discountType !== undefined;
    const hasValue = value.discountValue !== undefined;

    if (hasType !== hasValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "discountType and discountValue must be provided together",
        path: [hasType ? "discountValue" : "discountType"],
      });
    }

    if (
      value.discountType === "percent" &&
      value.discountValue !== undefined &&
      value.discountValue > 100
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "percent discount cannot exceed 100",
        path: ["discountValue"],
      });
    }
  });

export const createOrderBodySchema = discountFieldsSchema.extend({
  cashierId: uuidSchema.optional(),
  idempotencyKey: z.string().trim().min(1, "idempotencyKey is required"),
  items: z
    .array(
      discountFieldsSchema.extend({
        // T30 — no longer .int(). A grocery sells 1.5 kg. Whether a
        // fraction is allowed depends on the item's UNIT, which this schema
        // cannot see; quantityToMilli enforces it once the variant is known.
        quantity: z.coerce.number().finite().positive(),
        variantId: uuidSchema,
      }),
    )
    .min(1),
  paymentPreference: z.enum(["cash", "UPI"]).optional(),
});

export const orderParamsSchema = z.object({
  id: uuidSchema,
});

export const confirmOrderBodySchema = addressFieldsSchema.extend({
  cashierId: uuidSchema.optional(),
  idempotencyKey: z.string().trim().min(1, "idempotencyKey is required"),
});

export const payOrderBodySchema = z.object({
  cashierId: uuidSchema.optional(),
  idempotencyKey: z.string().trim().min(1, "idempotencyKey is required"),
  razorpayPaymentId: z.string().trim().min(1).max(255).optional(),
  tenders: z
    .array(
      z.object({
        amount: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/, "amount must be a decimal string"),
        cardApprovalCode: z.string().trim().min(1).max(32).optional(),
        cardLast4: z.string().trim().regex(/^\d{4}$/, "cardLast4 must be 4 digits").optional(),
        method: z.enum(["cash", "UPI", "card"]),
        razorpayPaymentId: z.string().trim().min(1).max(255).optional(),
      }),
    )
    .min(1)
    .optional(),
});

export const emailReceiptBodySchema = z.object({
  email: z.email("Invalid email address"),
});

export const transitionBodySchema = z.object({
  cashierId: uuidSchema.optional(),
  idempotencyKey: z.string().trim().min(1, "idempotencyKey is required"),
});

export const integrationTransitionBodySchema = transitionBodySchema;

export const returnOrderBodySchema = z.object({
  cashierId: uuidSchema.optional(),
  idempotencyKey: z.string().trim().min(1, "idempotencyKey is required"),
  items: z
    .array(
      z.object({
        restockable: z.boolean(),
        variantId: uuidSchema,
      }),
    )
    .min(1),
  reason: z.enum(["return", "damage", "price_adjustment", "cancellation"]).optional(),
});

export const listOrdersQuerySchema = paginationSchema.extend({
  customerId: z.string().trim().optional(),
  status: z
    .enum([
      "Draft",
      "Pending",
      "Paid",
      "Packed",
      "Shipped",
      "Delivered",
      "Completed",
      "Cancelled",
      "Returned",
      "Refunded",
    ])
    .optional(),
});
