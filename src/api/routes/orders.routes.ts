import type { FastifyPluginAsync } from "fastify";

import type { StandardizedIntegrationError } from "../../application/ports/errors.js";
import {
  cancelOrder,
  confirmOrder,
  createOrder,
  createOrderRequiresOwnerOverride,
  emailOrderReceipt,
  generatePaymentQr,
  getOrder,
  getOrderStatus,
  listOrders,
  orderDiscountRequiresOwnerOverride,
  payOrder,
  returnOrder,
  voidPaymentQr,
} from "../../application/services/order.service.js";
import { requireOwnerOverride, requireRole } from "../middleware/auth.js";
import { parseWithSchema } from "../server.js";
import {
  confirmOrderBodySchema,
  createOrderBodySchema,
  emailReceiptBodySchema,
  integrationTransitionBodySchema,
  listOrdersQuerySchema,
  orderParamsSchema,
  payOrderBodySchema,
  returnOrderBodySchema,
  transitionBodySchema,
} from "../validators/orders.js";

const integrationErrorStatusCode: Record<string, number> = {
  AUTHENTICATION_FAILURE: 401,
  INTEGRATION_DISABLED: 503,
  EMAIL_DELIVERY_FAILED: 502,
  LOGISTICS_TIMEOUT: 504,
  NETWORK_TIMEOUT: 504,
  PAYMENT_GATEWAY_UNAVAILABLE: 503,
};

const isIntegrationErrorResult = (value: unknown): value is StandardizedIntegrationError =>
  typeof value === "object" &&
  value !== null &&
  "success" in value &&
  value.success === false &&
  "errorType" in value;

const allRoles = requireRole("admin", "manager", "warehouse_staff", "pos_operator");
const managerAndPosRoles = requireRole("admin", "manager", "pos_operator");
const returnRoles = requireRole("admin", "manager", "warehouse_staff", "pos_operator");

export const registerOrderRoutes: FastifyPluginAsync = async (app) => {
  app.post("/orders", { preHandler: managerAndPosRoles }, async (request, reply) => {
    const body = parseWithSchema(createOrderBodySchema, request.body);

    if (await createOrderRequiresOwnerOverride(body)) {
      await requireOwnerOverride(request, {
        action: "order.create",
        cashierId: body.cashierId,
        reason: "discount_threshold_exceeded",
      });
    }

    const result = await createOrder(
      request.tenantId!,
      request.terminal
        ? { ...body, actorUserId: request.user!.id, terminalId: request.terminal.id }
        : { ...body, actorUserId: request.user?.id },
    );

    return reply.status(result.duplicate ? 200 : 201).send({
      success: true,
      duplicate: result.duplicate,
      data: result.order,
    });
  });

  app.get("/orders", { preHandler: allRoles }, async (request, reply) => {
    const query = parseWithSchema(listOrdersQuerySchema, request.query);
    return reply.send({ success: true, data: await listOrders(request.tenantId!, query) });
  });

  app.get("/orders/:id", { preHandler: allRoles }, async (request, reply) => {
    const params = parseWithSchema(orderParamsSchema, request.params);
    return reply.send({ success: true, data: await getOrder(request.tenantId!, params.id) });
  });

  app.patch("/orders/:id/confirm", { preHandler: managerAndPosRoles }, async (request, reply) => {
    const params = parseWithSchema(orderParamsSchema, request.params);
    const body = parseWithSchema(confirmOrderBodySchema, request.body);

    if (await orderDiscountRequiresOwnerOverride(request.tenantId!, params.id)) {
      await requireOwnerOverride(request, {
        action: "order.confirm",
        cashierId: body.cashierId,
        orderId: params.id,
        reason: "discount_threshold_exceeded",
      });
    }

    const result = await confirmOrder(request.tenantId!, params.id, { ...body, actorUserId: request.user!.id });

    return reply.send({ success: true, duplicate: result.duplicate, data: result.order });
  });

  app.patch("/orders/:id/pay", { preHandler: managerAndPosRoles }, async (request, reply) => {
    const params = parseWithSchema(orderParamsSchema, request.params);
    const body = parseWithSchema(payOrderBodySchema, request.body);
    const result = await payOrder(request.tenantId!, params.id, {
      ...body,
      actorUserId: request.user!.id,
    });

    return reply.send({ success: true, duplicate: result.duplicate, data: result.order });
  });

  app.post("/orders/:id/email-receipt", { preHandler: managerAndPosRoles }, async (request, reply) => {
    const params = parseWithSchema(orderParamsSchema, request.params);
    const body = parseWithSchema(emailReceiptBodySchema, request.body);
    const result = await emailOrderReceipt(request.tenantId!, params.id, body.email);

    if (isIntegrationErrorResult(result)) {
      return reply.status(integrationErrorStatusCode[result.errorType] ?? 502).send(result);
    }

    return reply.send({ success: true, data: result.data });
  });

  app.patch("/orders/:id/cancel", { preHandler: managerAndPosRoles }, async (request, reply) => {
    const params = parseWithSchema(orderParamsSchema, request.params);
    const body = parseWithSchema(transitionBodySchema, request.body);

    if ((await getOrderStatus(request.tenantId!, params.id)) === "Paid") {
      await requireOwnerOverride(request, {
        action: "order.cancel",
        cashierId: body.cashierId,
        orderId: params.id,
        reason: "paid_order_cancel",
      });
    }

    const result = await cancelOrder(request.tenantId!, params.id, {
      ...body,
      actorUserId: request.user!.id,
    });

    return reply.send({ success: true, duplicate: result.duplicate, data: result.order });
  });

  app.patch("/orders/:id/return", { preHandler: returnRoles }, async (request, reply) => {
    const params = parseWithSchema(orderParamsSchema, request.params);
    const body = parseWithSchema(returnOrderBodySchema, request.body);
    await requireOwnerOverride(request, {
      action: "order.return",
      cashierId: body.cashierId,
      orderId: params.id,
      reason: "return",
    });
    const result = await returnOrder(request.tenantId!, params.id, {
      ...body,
      actorUserId: request.user!.id,
    });

    return reply.send({ success: true, duplicate: result.duplicate, data: result.order, creditNote: result.creditNote });
  });

  app.post("/orders/:id/generate-payment-qr", { preHandler: managerAndPosRoles }, async (request, reply) => {
    const params = parseWithSchema(orderParamsSchema, request.params);
    const body = parseWithSchema(integrationTransitionBodySchema, request.body);
    const result = await generatePaymentQr(request.tenantId!, params.id, {
      ...body,
      actorUserId: request.user!.id,
    });

    if (isIntegrationErrorResult(result)) {
      return reply.status(integrationErrorStatusCode[result.errorType] ?? 503).send(result);
    }

    return reply.send({ success: true, duplicate: result.duplicate, data: result.order });
  });

  app.post("/orders/:id/void-payment-qr", { preHandler: managerAndPosRoles }, async (request, reply) => {
    const params = parseWithSchema(orderParamsSchema, request.params);
    const body = parseWithSchema(integrationTransitionBodySchema, request.body);
    await requireOwnerOverride(request, {
      action: "order.void_payment_qr",
      cashierId: body.cashierId,
      orderId: params.id,
      reason: "void_payment_qr",
    });
    const result = await voidPaymentQr(request.tenantId!, params.id, {
      ...body,
      actorUserId: request.user!.id,
    });

    if (isIntegrationErrorResult(result)) {
      return reply.status(integrationErrorStatusCode[result.errorType] ?? 503).send(result);
    }

    return reply.send({ success: true, duplicate: result.duplicate, data: result.order });
  });

};
