import type { FastifyPluginAsync } from "fastify";

import {
  closeShift,
  getCurrentShift,
  getShiftReport,
  openShift,
} from "../../application/services/shift.service.js";
import { parseWithSchema } from "../server.js";
import {
  closeShiftBodySchema,
  openShiftBodySchema,
  shiftParamsSchema,
} from "../validators/shifts.js";

export const registerShiftRoutes: FastifyPluginAsync = async (app) => {
  app.post("/shifts/open", async (request, reply) => {
    const body = parseWithSchema(openShiftBodySchema, request.body);
    const shift = await openShift(request.tenantId!, { ...body, terminalId: request.terminal!.id });

    return reply.status(201).send({ success: true, data: shift });
  });

  app.get("/shifts/current", async (request, reply) =>
    reply.send({ success: true, data: await getCurrentShift(request.terminal!.id) }),
  );

  app.post("/shifts/close", async (request, reply) => {
    const body = parseWithSchema(closeShiftBodySchema, request.body);
    const report = await closeShift({ ...body, terminalId: request.terminal!.id });

    return reply.send({ success: true, data: report });
  });

  app.get("/shifts/:id/report", async (request, reply) => {
    const params = parseWithSchema(shiftParamsSchema, request.params);

    return reply.send({ success: true, data: await getShiftReport(params.id) });
  });
};
