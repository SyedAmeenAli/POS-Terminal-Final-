import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import {
  getBusinessSettings,
  updateBusinessSettings,
} from "../../application/services/business-settings.service.js";
import { getIntegrationStatuses } from "../../application/services/integration-settings.service.js";
import { requireRole } from "../middleware/auth.js";
import { parseWithSchema } from "../server.js";

const businessSettingsBodySchema = z.object({
  taxRatePercent: z.coerce.number().min(0).max(100),
});

export const registerSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/settings/integrations", { preHandler: requireRole("admin") }, async (_request, reply) =>
    reply.send({
      success: true,
      data: await getIntegrationStatuses(),
    }),
  );

  app.get("/settings/business", { preHandler: requireRole("admin") }, async (request, reply) =>
    reply.send({
      success: true,
      data: await getBusinessSettings(request.tenantId!),
    }),
  );

  app.patch("/settings/business", { preHandler: requireRole("admin") }, async (request, reply) => {
    const body = parseWithSchema(businessSettingsBodySchema, request.body);

    return reply.send({
      success: true,
      data: await updateBusinessSettings(request.tenantId!, body),
    });
  });
};
