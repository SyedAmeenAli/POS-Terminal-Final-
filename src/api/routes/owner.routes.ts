import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import { logAudit } from "../../application/services/audit-log.service.js";
import { getOwnerPasswordHash } from "../../application/services/owner-credentials.service.js";
import {
  createOwnerSessionToken,
  getOwnerSessionExpiry,
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_TTL_MS,
  verifyOwnerSessionToken,
} from "../../application/services/owner-session.service.js";
import { verifyPassword } from "../../infrastructure/adapters/password.adapter.js";
import { AppError } from "../errors.js";
import {
  assertOwnerOverrideAllowed,
  clearOwnerOverrideFailures,
  recordOwnerOverrideFailure,
} from "../middleware/owner-rate-limit.js";
import { parseWithSchema } from "../server.js";

const verifyBodySchema = z.object({
  password: z.string().min(1),
});

const parseCookieHeader = (cookieHeader: string | undefined): Map<string, string> => {
  const cookies = new Map<string, string>();

  for (const part of cookieHeader?.split(";") ?? []) {
    const [name, ...valueParts] = part.trim().split("=");
    if (!name || valueParts.length === 0) {
      continue;
    }
    cookies.set(name, decodeURIComponent(valueParts.join("=")));
  }

  return cookies;
};

const getOwnerCookieValue = (request: FastifyRequest): string | undefined =>
  parseCookieHeader(request.headers.cookie).get(OWNER_SESSION_COOKIE);

const isPlaintextLocalhost = (request: FastifyRequest): boolean => {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto ?? request.protocol;
  const host = request.hostname.split(":")[0];

  return protocol === "http" && (host === "localhost" || host === "127.0.0.1" || host === "::1");
};

const buildOwnerCookie = (request: FastifyRequest, value: string, maxAgeSeconds: number): string => {
  const cookie = [
    `${OWNER_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (!isPlaintextLocalhost(request)) {
    cookie.push("Secure");
  }

  return cookie.join("; ");
};

const auditOwnerVerifyFailure = async (
  request: FastifyRequest,
  reason: string,
): Promise<void> => {
  if (!request.user) {
    return;
  }

  await logAudit({
    action: "owner.override.failed",
    entityId: request.terminal?.id ?? "unknown-terminal",
    entityType: "owner_override",
    metadata: {
      reason,
      terminalId: request.terminal?.id ?? null,
    },
    tenantId: request.tenantId!,
    userId: request.user.id,
  });
};

export const registerOwnerRoutes: FastifyPluginAsync = async (app) => {
  app.post("/owner/verify", async (request, reply) => {
    const body = parseWithSchema(verifyBodySchema, request.body);
    const ownerPasswordHash = await getOwnerPasswordHash(request.tenantId!);

    if (!ownerPasswordHash) {
      await auditOwnerVerifyFailure(request, "owner_password_not_set");
      throw new AppError(
        401,
        "Owner password is not set. Set it in IMS.",
        undefined,
        "OWNER_PASSWORD_NOT_SET",
      );
    }

    const failureKey = request.terminal?.id ?? request.ip;
    assertOwnerOverrideAllowed(failureKey);

    const authenticated = await verifyPassword(body.password, ownerPasswordHash);
    if (!authenticated) {
      recordOwnerOverrideFailure(failureKey);
      await auditOwnerVerifyFailure(request, "wrong_password");
      throw new AppError(401, "Owner password not accepted", undefined, "OWNER_LOGIN_FAILED");
    }

    clearOwnerOverrideFailures(failureKey);
    const token = createOwnerSessionToken();
    const expiresAt = getOwnerSessionExpiry(token);
    reply.header("Set-Cookie", buildOwnerCookie(request, token, OWNER_SESSION_TTL_MS / 1000));
    return reply.send({
      success: true,
      data: { authorised: true, expiresAt: expiresAt?.toISOString() ?? null },
    });
  });

  app.post("/owner/end", async (request, reply) => {
    reply.header("Set-Cookie", buildOwnerCookie(request, "", 0));
    return reply.send({ success: true, data: { authorised: false, expiresAt: null } });
  });

  app.get("/owner/status", async (request, reply) => {
    const ownerPasswordHash = await getOwnerPasswordHash(request.tenantId!);
    const token = getOwnerCookieValue(request);
    const authorised = Boolean(ownerPasswordHash) && verifyOwnerSessionToken(token);
    const expiresAt = authorised ? getOwnerSessionExpiry(token) : null;

    return reply.send({
      success: true,
      data: { authorised, expiresAt: expiresAt?.toISOString() ?? null },
    });
  });
};

