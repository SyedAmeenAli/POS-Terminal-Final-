import type { FastifyPluginAsync } from "fastify";

import {
  getProductById,
  listCategories,
  listProducts,
  listProductTypes,
  listProductVariants,
} from "../../application/services/catalog-service.js";
import { requireRole } from "../middleware/auth.js";
import { parseWithSchema } from "../server.js";
import {
  productIdParamsSchema,
  productListQuerySchema,
  productTypeQuerySchema,
} from "../validators/catalog.js";

const allRoles = requireRole("admin", "manager", "warehouse_staff", "pos_operator");
const warehouseRoles = requireRole("admin", "manager", "warehouse_staff");

export const registerCatalogRoutes: FastifyPluginAsync = async (app) => {
  app.get("/categories", { preHandler: warehouseRoles }, async (request, reply) =>
    reply.send({ success: true, data: await listCategories(request.tenantId!) }),
  );

  app.get("/product-types", { preHandler: warehouseRoles }, async (request, reply) => {
    const query = parseWithSchema(productTypeQuerySchema, request.query);
    return reply.send({ success: true, data: await listProductTypes(request.tenantId!, query.categoryId) });
  });

  app.get("/products", { preHandler: allRoles }, async (request, reply) => {
    const query = parseWithSchema(productListQuerySchema, request.query);
    return reply.send({ success: true, data: await listProducts(request.tenantId!, query) });
  });

  app.get("/products/:id", { preHandler: allRoles }, async (request, reply) => {
    const params = parseWithSchema(productIdParamsSchema, request.params);
    return reply.send({ success: true, data: await getProductById(request.tenantId!, params.id) });
  });

  app.get("/products/:id/variants", { preHandler: allRoles }, async (request, reply) => {
    const params = parseWithSchema(productIdParamsSchema, request.params);
    return reply.send({
      success: true,
      data: await listProductVariants(request.tenantId!, params.id),
    });
  });
};
