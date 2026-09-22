import type { FastifyPluginAsync } from "fastify";

import { getInventoryByVariantId } from "../../application/services/inventory.service.js";
import { listLotsForVariant } from "../../application/services/lot.service.js";
import { requireRole } from "../middleware/auth.js";
import { parseWithSchema } from "../server.js";
import { inventoryParamsSchema } from "../validators/inventory.js";

const warehouseRoles = requireRole("admin", "manager", "warehouse_staff");

export const registerInventoryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/inventory/:variantId", { preHandler: warehouseRoles }, async (request, reply) => {
    const params = parseWithSchema(inventoryParamsSchema, request.params);

    return reply.send({
      success: true,
      data: await getInventoryByVariantId(request.tenantId!, params.variantId),
    });
  });

  // PROPOSAL 02 §2d — the batches behind a cart line, so a cashier refused
  // with EXPIRED_STOCK can see which batch caused it, and can tell a customer
  // what they are actually being handed.
  //
  // Read-only, and it does NOT let the till choose. Outbound batch selection
  // stays on the server: FEFO exists precisely so the counter does not pick,
  // and letting a cashier override it would give away the whole point.
  //
  // pos_operator as well as warehouse roles — the person who needs this is the one
  // standing at the counter with the customer.
  app.get(
    "/inventory/:variantId/lots",
    { preHandler: requireRole("admin", "manager", "warehouse_staff", "pos_operator") },
    async (request, reply) => {
      const params = parseWithSchema(inventoryParamsSchema, request.params);

      return reply.send({
        success: true,
        data: await listLotsForVariant(request.tenantId!, params.variantId),
      });
    },
  );
};
