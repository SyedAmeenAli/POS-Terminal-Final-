import { and, eq, like, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { AppError } from "../../api/errors.js";
import { db } from "../../infrastructure/database/db.js";
import {
  categories,
  inventoryStock,
  productTypes,
  productVariants,
  products,
} from "../../infrastructure/database/schema.js";

type ProductListFilters = {
  brand?: string;
  limit: number;
  offset: number;
  productTypeId?: string;
};

type CreateProductInput = {
  brand: string;
  name: string;
  productTypeId: string;
  qualityTier: "Basic" | "Medium" | "Premium";
  styleCode: string;
  imagePath?: string;
};

type PatchProductInput = Partial<CreateProductInput>;

type CreateVariantInput = {
  color: string;
  costPrice: number;
  retailPrice: number;
  size: string;
  status?: "active" | "archived";
};

type PatchVariantInput = {
  costPrice?: number;
  retailPrice?: number;
  status?: "active" | "archived";
};

const normalizeCode = (value: string, maxLength: number): string => {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized.slice(0, maxLength) || "NA";
};

const getTierInitial = (qualityTier: string): string => {
  const tierMap: Record<string, string> = {
    BASIC: "B",
    MEDIUM: "M",
    PREMIUM: "P",
  };

  return tierMap[qualityTier.toUpperCase()] ?? normalizeCode(qualityTier, 1);
};

// Quality tier used to constrain retail price to a hardcoded band
// (Basic 0-600, Medium 600-900, Premium 900-1200). Those bands could not be
// satisfied by the live catalogue, which prices apparel from Rs 2,800 upward and
// carries tiers ("Standard", "Luxury") outside the three the check knew about.
// The result was that every variant create and update failed with a 422, so the
// tier is treated as descriptive metadata instead. Reintroducing the rule needs
// the bands to come from business settings rather than constants.

const buildSkuBase = (input: {
  brand: string;
  categoryCode: string;
  color: string;
  productTypeCode: string;
  qualityTier: string;
  size: string;
  styleCode: string;
}): string =>
  [
    normalizeCode(input.categoryCode, 10),
    normalizeCode(input.productTypeCode, 10),
    normalizeCode(input.styleCode, 20),
    getTierInitial(input.qualityTier),
    normalizeCode(input.color, 16),
    normalizeCode(input.brand, 20),
    normalizeCode(input.size, 10),
  ].join("-");

const getNextSku = async (tenantId: string, baseSku: string): Promise<string> => {
  const existing = await db
    .select({ sku: productVariants.sku })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.tenantId, tenantId),
        or(eq(productVariants.sku, baseSku), like(productVariants.sku, `${baseSku}-%`)),
      ),
    );

  if (existing.length === 0) {
    return baseSku;
  }

  const nextSuffix =
    existing.reduce((maxSuffix, row) => {
      if (row.sku === baseSku) {
        return Math.max(maxSuffix, 1);
      }

      const suffix = Number(row.sku.slice(baseSku.length + 1));
      return Number.isInteger(suffix) ? Math.max(maxSuffix, suffix) : maxSuffix;
    }, 1) + 1;

  return `${baseSku}-${nextSuffix}`;
};

// products/product_types/product_variants have no tenant_id column of their
// own — they inherit the tenant boundary through the FK chain up to
// categories, which does. Mirrors ims-1's catalog-service.ts.

export const getProductById = async (tenantId: string, productId: string) => {
  const product = await db
    .select({
      brand: products.brand,
      createdAt: products.createdAt,
      id: products.id,
      imagePath: products.imagePath,
      name: products.name,
      productTypeId: products.productTypeId,
      qualityTier: products.qualityTier,
      styleCode: products.styleCode,
    })
    .from(products)
    .innerJoin(productTypes, eq(products.productTypeId, productTypes.id))
    .innerJoin(categories, eq(productTypes.categoryId, categories.id))
    .where(and(eq(products.id, productId), eq(categories.tenantId, tenantId)))
    .limit(1);

  if (!product[0]) {
    throw new AppError(404, "Product not found");
  }

  return product[0];
};

const getProductWithSkuContext = async (tenantId: string, productId: string) => {
  const rows = await db
    .select({
      brand: products.brand,
      categoryCode: categories.code,
      id: products.id,
      productTypeCode: productTypes.code,
      qualityTier: products.qualityTier,
      styleCode: products.styleCode,
    })
    .from(products)
    .innerJoin(productTypes, eq(products.productTypeId, productTypes.id))
    .innerJoin(categories, eq(productTypes.categoryId, categories.id))
    .where(and(eq(products.id, productId), eq(categories.tenantId, tenantId)))
    .limit(1);

  if (!rows[0]) {
    throw new AppError(404, "Product not found");
  }

  return rows[0];
};

export const listCategories = async (tenantId: string) =>
  db
    .select()
    .from(categories)
    .where(eq(categories.tenantId, tenantId))
    .orderBy(categories.name);

export const createCategory = async (
  tenantId: string,
  input: { code: string; name: string },
) => {
  const created = await db
    .insert(categories)
    .values({
      id: randomUUID(),
      tenantId,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
    })
    .returning();

  return created[0];
};

export const listProductTypes = async (tenantId: string, categoryId?: string) =>
  db
    .select({
      categoryId: productTypes.categoryId,
      code: productTypes.code,
      id: productTypes.id,
      name: productTypes.name,
    })
    .from(productTypes)
    .innerJoin(categories, eq(productTypes.categoryId, categories.id))
    .where(
      and(
        eq(categories.tenantId, tenantId),
        categoryId ? eq(productTypes.categoryId, categoryId) : undefined,
      ),
    )
    .orderBy(productTypes.name);

export const createProductType = async (
  tenantId: string,
  input: {
    categoryId: string;
    code: string;
    name: string;
  },
) => {
  const category = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.id, input.categoryId), eq(categories.tenantId, tenantId)))
    .limit(1);

  if (!category[0]) {
    throw new AppError(404, "Category not found");
  }

  const created = await db
    .insert(productTypes)
    .values({
      id: randomUUID(),
      categoryId: input.categoryId,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      tenantId,
    })
    .returning();

  return created[0];
};

export const listProducts = async (tenantId: string, filters: ProductListFilters) => {
  const conditions = [
    eq(categories.tenantId, tenantId),
    filters.productTypeId ? eq(products.productTypeId, filters.productTypeId) : undefined,
    filters.brand ? eq(products.brand, filters.brand.trim()) : undefined,
  ].filter(Boolean);

  return db
    .select({
      brand: products.brand,
      createdAt: products.createdAt,
      id: products.id,
      imagePath: products.imagePath,
      name: products.name,
      productTypeId: products.productTypeId,
      qualityTier: products.qualityTier,
      styleCode: products.styleCode,
    })
    .from(products)
    .innerJoin(productTypes, eq(products.productTypeId, productTypes.id))
    .innerJoin(categories, eq(productTypes.categoryId, categories.id))
    .where(and(...conditions))
    .limit(filters.limit)
    .offset(filters.offset)
    .orderBy(products.createdAt);
};

export const createProduct = async (tenantId: string, input: CreateProductInput) => {
  const productType = await db
    .select({ id: productTypes.id })
    .from(productTypes)
    .innerJoin(categories, eq(productTypes.categoryId, categories.id))
    .where(and(eq(productTypes.id, input.productTypeId), eq(categories.tenantId, tenantId)))
    .limit(1);

  if (!productType[0]) {
    throw new AppError(404, "Product type not found");
  }

  const created = await db
    .insert(products)
    .values({
      id: randomUUID(),
      tenantId,
      brand: input.brand.trim(),
      name: input.name.trim(),
      productTypeId: input.productTypeId,
      qualityTier: input.qualityTier,
      styleCode: input.styleCode.trim().toUpperCase(),
      imagePath: input.imagePath,
    })
    .returning();

  return created[0];
};

export const updateProduct = async (
  tenantId: string,
  productId: string,
  input: PatchProductInput,
) => {
  await getProductById(tenantId, productId);

  if (input.productTypeId) {
    const productType = await db
      .select({ id: productTypes.id })
      .from(productTypes)
      .innerJoin(categories, eq(productTypes.categoryId, categories.id))
      .where(and(eq(productTypes.id, input.productTypeId), eq(categories.tenantId, tenantId)))
      .limit(1);

    if (!productType[0]) {
      throw new AppError(404, "Product type not found");
    }
  }

  const updated = await db
    .update(products)
    .set({
      brand: input.brand?.trim(),
      name: input.name?.trim(),
      productTypeId: input.productTypeId,
      qualityTier: input.qualityTier,
      styleCode: input.styleCode?.trim().toUpperCase(),
      imagePath: input.imagePath,
    })
    .where(eq(products.id, productId))
    .returning();

  if (!updated[0]) {
    throw new AppError(404, "Product not found");
  }

  return updated[0];
};

export const deleteProduct = async (tenantId: string, productId: string) => {
  await getProductById(tenantId, productId);

  const variantCountRows = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
    .from(productVariants)
    .where(eq(productVariants.productId, productId));

  const variantCount = variantCountRows[0]?.count ?? 0;

  if (variantCount > 0) {
    throw new AppError(409, "Product has variants and cannot be deleted");
  }

  const deleted = await db.delete(products).where(eq(products.id, productId)).returning();

  if (!deleted[0]) {
    throw new AppError(404, "Product not found");
  }

  return { deleted: true };
};

export const listProductVariants = async (
  tenantId: string,
  productId: string,
  options: { includeArchived?: boolean } = {},
) => {
  await getProductById(tenantId, productId);

  // The till sells only what is currently stocked, so archived variants are
  // hidden by default. Anything that genuinely needs the full set, such as
  // resolving a line on an old receipt, opts in explicitly.
  const conditions = [
    eq(productVariants.productId, productId),
    options.includeArchived ? undefined : eq(productVariants.status, "active"),
  ].filter(Boolean);

  return db
    .select()
    .from(productVariants)
    .where(and(...conditions))
    .orderBy(productVariants.createdAt);
};

export const createProductVariant = async (
  tenantId: string,
  productId: string,
  input: CreateVariantInput,
) => {
  const product = await getProductWithSkuContext(tenantId, productId);

  // T30 — the apparel columns are nullable now, so an empty string stands in
  // where a shop has nothing to say. Never a placeholder: a SKU is printed on
  // a label stuck to physical stock, and this only runs for a NEW variant.
  const baseSku = buildSkuBase({
    brand: product.brand ?? "",
    categoryCode: product.categoryCode,
    color: input.color ?? "",
    productTypeCode: product.productTypeCode,
    qualityTier: product.qualityTier ?? "",
    size: input.size ?? "",
    styleCode: product.styleCode ?? "",
  });

  // Retry up to 5 times to handle concurrent SKU collisions.
  // getNextSku is called inside the transaction so the collision check and insert
  // are as close together as possible, and the DB unique index is the final guard.
  const MAX_RETRIES = 5;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const result = await db.transaction(async (tx) => {
        const sku = await getNextSku(tenantId, baseSku);
        const variantId = randomUUID();

        const createdVariants = await tx
          .insert(productVariants)
          .values({
            id: variantId,
            color: input.color.trim(),
            costPrice: input.costPrice.toFixed(2),
            productId,
            retailPrice: input.retailPrice.toFixed(2),
            size: input.size.trim().toUpperCase(),
            sku,
            status: input.status ?? "active",
            tenantId,
          })
          .returning();

        await tx.insert(inventoryStock).values({
          id: randomUUID(),
          tenantId,
          damagedQtyMilli: 0n,
          onHandQtyMilli: 0n,
          reservedQtyMilli: 0n,
          variantId,
        });

        return createdVariants[0];
      });
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSkuConflict = msg.includes("product_variants_sku_idx") || msg.includes("unique constraint");
      if (!isSkuConflict || attempt === MAX_RETRIES - 1) throw err;
    }
  }
  throw new Error("Failed to generate unique SKU after retries");
};

export const updateProductVariant = async (
  tenantId: string,
  productId: string,
  variantId: string,
  input: PatchVariantInput,
) => {
  // Validates the product exists within this tenant; throws 404 when it does not.
  await getProductById(tenantId, productId);

  const existingVariant = await db
    .select()
    .from(productVariants)
    .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, productId)))
    .limit(1);

  if (!existingVariant[0]) {
    throw new AppError(404, "Variant not found");
  }

  const updated = await db
    .update(productVariants)
    .set({
      costPrice: input.costPrice?.toFixed(2),
      retailPrice: input.retailPrice?.toFixed(2),
      status: input.status,
    })
    .where(and(eq(productVariants.id, variantId), eq(productVariants.productId, productId)))
    .returning();

  return updated[0];
};
