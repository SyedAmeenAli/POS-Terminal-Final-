import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";

import { loadEnvSync } from "../env-sync.js";
import { AppError, getPgConflictMessage, isPgConflictError } from "./errors.js";
import { flushTerminalAuthCache, globalAuthenticationHook } from "./middleware/auth.js";
import { enforceGlobalRateLimit } from "./middleware/global-rate-limit.js";
import { resolveTenantHook } from "./middleware/tenant.js";
import { registerCashierRoutes } from "./routes/cashiers.routes.js";
import { registerCatalogRoutes } from "./routes/catalog-routes.js";
import { registerInventoryRoutes } from "./routes/inventory.routes.js";
import { registerOrderRoutes } from "./routes/orders.routes.js";
import { registerOwnerRoutes } from "./routes/owner.routes.js";
import { registerSettingsRoutes } from "./routes/settings.routes.js";
import { registerShiftRoutes } from "./routes/shifts.routes.js";
import {
  beginRequestTransaction,
  commitRequestTransaction,
  rollbackRequestTransaction,
  scopedDbStorage,
} from "../infrastructure/database/db.js";
import { logError, logJson } from "../utils/logger.js";

export const parseWithSchema = <T>(schema: ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);

  if (!result.success) {
    throw new AppError(400, "Validation failed", result.error.flatten());
  }

  return result.data;
};

type BuildServerOptions = {
  authEnabled?: boolean;
  authorizationProbe?: boolean;
  // T1b: opt-in, off by default — mirrors ims-1's server.ts. See that file
  // for why (the test suite points DATABASE_URL at a nonexistent host on
  // purpose, so opening a real connection per request would hang every
  // mocked route test). index.ts turns this on for the real server.
  requestTransactions?: boolean;
};

export const buildServer = (options: BuildServerOptions = {}) => {
  const app = Fastify();

  // T30 — quantities are bigint now, and JSON.stringify THROWS on a BigInt
  // rather than degrading: "Do not know how to serialize a BigInt", which
  // surfaces as a 500 on any response carrying one. At a till that is a sale
  // that cannot be rung up.
  //
  // setReplySerializer, NOT setSerializerCompiler: the latter only applies to
  // routes declaring a response schema, of which this API has almost none.
  //
  // Serialised as a STRING, never a Number — coercing to a double is exactly
  // the precision loss milli-units exist to remove.
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value)),
  );
  const env = loadEnvSync();
  const allowedOrigins = new Set(
    env.CORS_ALLOWED_ORIGINS.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
  const authEnabled = options.authEnabled ?? true;
  app.decorate("authorizationProbe", options.authorizationProbe ?? false);
  app.decorate("authDisabled", !authEnabled);

  void app.register(cors, {
    // @fastify/cors defaults to GET,HEAD,POST only. The order lifecycle uses
    // PATCH (confirm, pay, cancel, return), so without this the browser blocks
    // those at preflight and no sale can complete when the UI is served from a
    // different origin than the API.
    methods: ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    origin: (origin, callback) => {
      callback(null, !origin || allowedOrigins.has(origin));
    },
  });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      try {
        const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
        (request as typeof request & { rawBody?: Buffer }).rawBody = rawBody;
        const text = rawBody.toString("utf8");
        done(null, text.length === 0 ? {} : JSON.parse(text));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  app.addHook("onRequest", async (request) => {
    request.startTime = process.hrtime.bigint();

    const origin = request.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      throw new AppError(403, "Origin not allowed");
    }
  });

  if (authEnabled) {
    app.addHook("onRequest", globalAuthenticationHook);
    app.addHook("onRequest", resolveTenantHook);
  }

  const requestTransactions = options.requestTransactions ?? false;

  if (requestTransactions) {
    // Must run after resolveTenantHook so request.tenantId (taken from the
    // authenticated terminal row) is already known. Callback-style, calling
    // done() synchronously inside scopedDbStorage.run(), for the reason
    // documented on scopedDbStorage in db.ts.
    app.addHook("onRequest", (request, reply, done) => {
      beginRequestTransaction(request.tenantId)
        .then((handle) => {
          request.dbTxHandle = handle;
          scopedDbStorage.run({ db: handle.txDb, inTransaction: true }, () => done());
        })
        .catch((err: unknown) => done(err as Error));
    });

    app.addHook("onError", async (request) => {
      if (request.dbTxHandle && !request.dbTxSettled) {
        request.dbTxSettled = true;
        await rollbackRequestTransaction(request.dbTxHandle);
      }
    });
  }

  app.addHook("onRequest", async (request) => {
    enforceGlobalRateLimit(request);
  });

  app.addHook("onResponse", async (request, reply) => {
    const durationMs = request.startTime
      ? Number(process.hrtime.bigint() - request.startTime) / 1_000_000
      : undefined;

    logJson("info", "http_request", {
      durationMs: durationMs === undefined ? undefined : Number(durationMs.toFixed(2)),
      method: request.method,
      path: request.url.split("?")[0],
      status: reply.statusCode,
      terminalId: request.terminal?.id ?? null,
    });

    if (requestTransactions && request.dbTxHandle && !request.dbTxSettled) {
      request.dbTxSettled = true;
      await commitRequestTransaction(request.dbTxHandle);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      logJson(error.statusCode >= 500 ? "error" : "warn", "http_error", {
        errorMessage: error.message,
        errorType: error.errorType ?? null,
        method: request.method,
        path: request.url.split("?")[0],
        status: error.statusCode,
        terminalId: request.terminal?.id ?? null,
      });

      return reply.status(error.statusCode).send({
        errorType: error.errorType,
        success: false,
        message: error.message,
        errors: error.errors,
      });
    }

    if (isPgConflictError(error)) {
      logJson("warn", "http_error", {
        errorMessage: getPgConflictMessage(error, "Unique constraint violation"),
        errorType: "PG_CONFLICT",
        method: request.method,
        path: request.url.split("?")[0],
        status: 409,
        terminalId: request.terminal?.id ?? null,
      });

      return reply.status(409).send({
        success: false,
        message: getPgConflictMessage(error, "Unique constraint violation"),
      });
    }

    logError("http_error", error, {
      errorType: "INTERNAL",
      method: request.method,
      path: request.url.split("?")[0],
      status: 500,
      terminalId: request.terminal?.id ?? null,
    });

    return reply.status(500).send({
      success: false,
      message: "Internal server error",
    });
  });

  app.get("/health", async () => ({
    success: true,
    data: { status: "ok" },
  }));

  app.post("/internal/flush-auth-cache", async (request, reply) => {
    const localAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

    if (!localAddresses.has(request.ip)) {
      return reply.status(403).send({ success: false, message: "Forbidden" });
    }

    flushTerminalAuthCache();
    return reply.send({ success: true });
  });

  void app.register(registerCatalogRoutes);
  void app.register(registerCashierRoutes);
  void app.register(registerInventoryRoutes);
  void app.register(registerOrderRoutes);
  void app.register(registerOwnerRoutes);
  void app.register(registerSettingsRoutes);
  void app.register(registerShiftRoutes);

  // Serve the built till UI from this same service when present, so one URL
  // provides both the app and its API and there is no cross-origin request to
  // configure. Absent in local development, where Vite serves the UI instead.
  const webRoot = path.join(process.cwd(), "web", "dist");

  if (existsSync(webRoot)) {
    void app.register(fastifyStatic, { root: webRoot });

    // Single-page app: unknown non-API GETs return index.html so client-side
    // routing works on a hard refresh. API 404s are left untouched.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api")) {
        return reply.sendFile("index.html");
      }

      return reply.status(404).send({ success: false, message: "Not found" });
    });
  }

  return app;
};
