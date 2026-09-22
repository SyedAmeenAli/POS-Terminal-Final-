import type { FastifyPluginAsync } from "fastify";

import {
  listActiveCashiers,
  verifyCashierPin,
} from "../../application/services/cashier.service.js";
import { parseWithSchema } from "../server.js";
import { verifyCashierPinBodySchema } from "../validators/cashiers.js";

export const registerCashierRoutes: FastifyPluginAsync = async (app) => {
  app.get("/cashiers", async (_request, reply) =>
    reply.send({ success: true, data: await listActiveCashiers() }),
  );

  app.post("/cashiers/verify-pin", async (request, reply) => {
    const body = parseWithSchema(verifyCashierPinBodySchema, request.body);
    const cashier = await verifyCashierPin(body.cashierId, body.pin, request.terminal!.id);

    return reply.send({ success: true, data: { cashierId: cashier.id, name: cashier.name } });
  });
};
