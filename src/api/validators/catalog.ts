import { z } from "zod";

const uuidSchema = z.uuid("Invalid UUID");

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const categoryBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(10),
});

export const productTypeBodySchema = z.object({
  categoryId: uuidSchema,
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(10),
});

export const productTypeQuerySchema = z.object({
  categoryId: uuidSchema.optional(),
});

export const qualityTierSchema = z.enum(["Basic", "Medium", "Premium"]);

export const createProductBodySchema = z.object({
  productTypeId: uuidSchema,
  name: z.string().trim().min(1).max(255),
  styleCode: z.string().trim().min(1).max(20),
  qualityTier: qualityTierSchema,
  brand: z.string().trim().min(1).max(100),
  imagePath: z.string().optional(),
});

export const patchProductBodySchema = createProductBodySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  {
    message: "At least one product field is required",
  },
);

export const productListQuerySchema = paginationSchema.extend({
  productTypeId: uuidSchema.optional(),
  brand: z.string().trim().min(1).max(100).optional(),
});

export const productIdParamsSchema = z.object({
  id: uuidSchema,
});

export const productVariantParamsSchema = z.object({
  id: uuidSchema,
  variantId: uuidSchema,
});

export const createVariantBodySchema = z.object({
  color: z.string().trim().min(1).max(50),
  size: z.string().trim().min(1).max(20),
  retailPrice: z.coerce.number().finite().nonnegative(),
  costPrice: z.coerce.number().finite().nonnegative(),
  status: z.enum(["active", "archived"]).optional(),
});

export const patchVariantBodySchema = z
  .object({
    retailPrice: z.coerce.number().finite().nonnegative().optional(),
    costPrice: z.coerce.number().finite().nonnegative().optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one variant field is required",
  });
