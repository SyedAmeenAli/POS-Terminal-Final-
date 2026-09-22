import { asc, eq, isNull, or } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";

import { logAudit } from "../../application/services/audit-log.service.js";
import type { AuthenticatedUser } from "../../application/services/auth.service.js";
import { getOwnerPasswordHash } from "../../application/services/owner-credentials.service.js";
import {
  OWNER_SESSION_COOKIE,
  verifyOwnerSessionToken,
} from "../../application/services/owner-session.service.js";
import { terminalTokenPrefix } from "../../application/services/terminal-token.js";
import { loadEnvSync } from "../../env-sync.js";
import { verifyPassword } from "../../infrastructure/adapters/password.adapter.js";
import { getBootstrapDb } from "../../infrastructure/database/db.js";
import { posTerminals, users } from "../../infrastructure/database/schema.js";
import { logJson } from "../../utils/logger.js";
import { AppError } from "../errors.js";

type TerminalStatus = "active" | "disabled";

type AuthenticatedTerminal = {
  id: string;
  name: string;
  status: TerminalStatus;
  tenantId: string;
};

type TerminalRow = AuthenticatedTerminal & {
  tokenHash: string;
};

declare module "fastify" {
  interface FastifyInstance {
    authorizationProbe?: boolean;
    authDisabled?: boolean;
  }

  interface FastifyRequest {
    startTime?: bigint;
    terminal?: AuthenticatedTerminal;
    tenantId?: string;
    user?: AuthenticatedUser;
    // T1b request-scoped transaction (see db.ts / server.ts). Undefined when
    // requestTransactions is off (the default in tests).
    dbTxHandle?: import("../../infrastructure/database/db.js").RequestTransactionHandle;
    dbTxSettled?: boolean;
  }
}

export type Role = AuthenticatedUser["role"];
export const ALL_ROLES: Role[] = ["admin", "manager", "warehouse_staff", "pos_operator"];

const MAX_CACHE_ENTRIES = 256;
const LAST_SEEN_UPDATE_INTERVAL_MS = 60_000;
const TERMINAL_UNAUTHORISED_MESSAGE = "Terminal not authorised";

const terminalCache = new Map<string, { expiresAt: number; terminal: AuthenticatedTerminal }>();
const lastSeenUpdates = new Map<string, number>();

let cachedOwner: AuthenticatedUser | null = null;

export class MissingOwnerUserError extends Error {
  constructor() {
    super(
      "No active user row found. Create the owner user from the IMS back office before starting the POS backend.",
    );
    this.name = "MissingOwnerUserError";
  }
}

export const getTerminalTokenFromRequest = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;

  if (!header) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : undefined;
};

const digestToken = (token: string): string => createHash("sha256").update(token).digest("hex");

const getAuthCacheTtlMs = (): number => loadEnvSync().TERMINAL_AUTH_CACHE_TTL_SECONDS * 1000;

const cacheTerminal = (digest: string, terminal: AuthenticatedTerminal): void => {
  if (terminalCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = terminalCache.keys().next().value as string | undefined;
    if (oldestKey) {
      terminalCache.delete(oldestKey);
    }
  }

  terminalCache.set(digest, {
    expiresAt: Date.now() + getAuthCacheTtlMs(),
    terminal,
  });
};

const getCachedTerminal = (digest: string): AuthenticatedTerminal | undefined => {
  const entry = terminalCache.get(digest);

  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    terminalCache.delete(digest);
    return undefined;
  }

  return entry.terminal;
};

export const flushTerminalAuthCache = (): void => {
  terminalCache.clear();
};

export const resetAuthStateForTests = (): void => {
  cachedOwner = null;
  terminalCache.clear();
  lastSeenUpdates.clear();
};

const logAuthFailure = (request: FastifyRequest): void => {
  logJson("warn", "terminal_auth_failed", {
    ip: request.ip,
    method: request.method,
    path: request.url.split("?")[0],
  });
};

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

const throwUnauthorized = (request: FastifyRequest): never => {
  logAuthFailure(request);
  throw new AppError(401, TERMINAL_UNAUTHORISED_MESSAGE);
};

const findTerminalByToken = async (
  token: string,
  request: FastifyRequest,
): Promise<AuthenticatedTerminal> => {
  // Narrow by the indexed token prefix first. Rows provisioned before that
  // column existed have NULL and cannot be backfilled — bcrypt is one-way — so
  // they stay reachable through the legacy scan until re-provisioned. Once no
  // NULL rows remain this is one indexed lookup instead of a bcrypt compare
  // against every terminal in the table.
  //
  // Tenant identity isn't known yet — that's what this query resolves — so
  // it uses the bootstrap role instead of the main connection: SELECT-only
  // on pos_terminals, no other table reachable. See
  // ims-1/scripts/provision-bootstrap-role.ts.
  const rows = await getBootstrapDb()
    .select({
      id: posTerminals.id,
      name: posTerminals.name,
      status: posTerminals.status,
      tenantId: posTerminals.tenantId,
      tokenHash: posTerminals.tokenHash,
    })
    .from(posTerminals)
    .where(
      or(
        eq(posTerminals.tokenPrefix, terminalTokenPrefix(token)),
        isNull(posTerminals.tokenPrefix),
      ),
    );

  for (const row of rows as TerminalRow[]) {
    if (!(await verifyPassword(token, row.tokenHash))) {
      continue;
    }

    if (row.status !== "active") {
      return throwUnauthorized(request);
    }

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      tenantId: row.tenantId,
    };
  }

  return throwUnauthorized(request);
};

const updateLastSeenAtIfDue = async (terminalId: string): Promise<void> => {
  const now = Date.now();
  const previous = lastSeenUpdates.get(terminalId) ?? 0;

  if (now - previous < LAST_SEEN_UPDATE_INTERVAL_MS) {
    return;
  }

  // PROPOSAL 11 §3.4 — this map only ever grew. It has one timestamp per
  // terminal and nothing ever removed an entry, so it retained every terminal
  // this process had ever authenticated.
  //
  // MUCH milder than the IMS leak that prompted the audit: that one was keyed
  // by IP on a public unauthenticated endpoint, so its key space was
  // attacker-controlled. This key space is provisioned terminals, and reaching
  // it at all needs a valid token — a shop has a handful of tills. It is
  // capped rather than left alone because "bounded by how many tills exist" is
  // an assumption about deployment, not a property of the code, and terminalCache
  // above already had the cap this one was missing.
  //
  // Entries past the interval carry no information: the next request from that
  // terminal is due an update regardless of what is remembered.
  if (lastSeenUpdates.size >= MAX_CACHE_ENTRIES) {
    for (const [id, seenAt] of lastSeenUpdates) {
      if (now - seenAt >= LAST_SEEN_UPDATE_INTERVAL_MS) lastSeenUpdates.delete(id);
    }
    // Still full means every entry is live, which for this map would mean more
    // than MAX_CACHE_ENTRIES tills active inside one interval. Drop the oldest
    // rather than grow without bound; the cost is one redundant UPDATE.
    while (lastSeenUpdates.size >= MAX_CACHE_ENTRIES) {
      const oldest = lastSeenUpdates.keys().next();
      if (oldest.done) break;
      lastSeenUpdates.delete(oldest.value);
    }
  }

  lastSeenUpdates.set(terminalId, now);
  // Runs inside the authentication hook, before any request transaction, so
  // there is no app.current_tenant_id yet — on the pooled connection this
  // UPDATE silently matched zero rows once RLS was enabled. Stamped through
  // the bootstrap role, which holds a column-level grant on exactly this
  // column (migration 0017).
  await getBootstrapDb()
    .update(posTerminals)
    .set({ lastSeenAt: new Date(now) })
    .where(eq(posTerminals.id, terminalId));
};

export const requireTerminal = async (request: FastifyRequest): Promise<void> => {
  const token = getTerminalTokenFromRequest(request);

  if (!token) {
    return throwUnauthorized(request);
  }

  const digest = digestToken(token);
  const cached = getCachedTerminal(digest);
  const terminal = cached ?? (await findTerminalByToken(token, request));

  if (!cached) {
    cacheTerminal(digest, terminal);
  }

  request.terminal = terminal;
  request.tenantId = terminal.tenantId;
  await updateLastSeenAtIfDue(terminal.id);
};

export const resolveOwnerUser = async (): Promise<AuthenticatedUser> => {
  if (cachedOwner) {
    return cachedOwner;
  }

  // Identity resolution on `users`, and it runs inside the authentication
  // hook — before the request transaction (and therefore before
  // app.current_tenant_id) exists — so it cannot see anything on the
  // tenant-scoped runtime connection. Same category as login-by-email and
  // the terminal-token scan, so it uses the same bootstrap role, which holds
  // SELECT on `users` and nothing else.
  const [owner] = await getBootstrapDb()
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.status, "active"))
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (!owner) {
    throw new MissingOwnerUserError();
  }

  cachedOwner = owner;
  return owner;
};

export const resetOwnerUserCache = (): void => {
  cachedOwner = null;
};

export const setOwnerUser = (user: AuthenticatedUser): void => {
  cachedOwner = user;
};

/**
 * Static assets of the till UI. These must load before a terminal token can be
 * entered — gating them would make the setup screen unreachable, since the app
 * that collects the token could never start. This mirrors local development,
 * where Vite serves the same files unauthenticated while the API stays gated.
 *
 * Deliberately an allow-list of asset paths, not "any GET": every API route
 * continues to require a valid terminal token.
 */
const STATIC_ASSET_PATHS = new Set([
  "/",
  "/index.html",
  "/favicon.ico",
  "/manifest.json",
  "/robots.txt",
]);

const isStaticAssetPath = (path: string): boolean =>
  STATIC_ASSET_PATHS.has(path) || path.startsWith("/assets/");

export const isOwnerLookupSkipped = (method: string, url: string): boolean => {
  const path = url.split("?")[0] ?? url;

  if (method !== "GET") {
    return false;
  }

  return path === "/health" || isStaticAssetPath(path);
};

export const requireAuthenticatedUser = async (request: FastifyRequest): Promise<void> => {
  request.user = await resolveOwnerUser();
};

export const globalAuthenticationHook = async (request: FastifyRequest): Promise<void> => {
  if (isOwnerLookupSkipped(request.method, request.url)) {
    return;
  }

  await requireTerminal(request);
  await requireAuthenticatedUser(request);
};

export const requireRole =
  (..._allowedRoles: Role[]) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.server.authDisabled) {
      return;
    }

    if (!request.terminal) {
      await requireTerminal(request);
    }

    if (!request.user) {
      request.user = await resolveOwnerUser();
    }

    if (request.server.authorizationProbe) {
      await reply.send({ success: true });
    }
  };

type OwnerOverrideInput = {
  action: string;
  cashierId?: string;
  orderId?: string;
  reason: string;
};

const auditOwnerOverride = async (
  request: FastifyRequest,
  input: OwnerOverrideInput & { result: "authorised" | "failed" },
): Promise<void> => {
  if (!request.user) {
    return;
  }

  await logAudit({
    action: input.result === "authorised" ? "owner.override.authorised" : "owner.override.failed",
    entityId: input.orderId ?? request.terminal?.id ?? "unknown-terminal",
    entityType: input.orderId ? "order" : "owner_override",
    metadata: {
      authorisedAction: input.action,
      cashierId: input.cashierId ?? null,
      orderId: input.orderId ?? null,
      reason: input.reason,
      terminalId: request.terminal?.id ?? null,
    },
    tenantId: request.tenantId!,
    userId: request.user.id,
  });
};

export const requireOwnerOverride = async (
  request: FastifyRequest,
  input: OwnerOverrideInput,
): Promise<void> => {
  const ownerPasswordHash = await getOwnerPasswordHash(request.tenantId!);

  if (!ownerPasswordHash) {
    await auditOwnerOverride(request, { ...input, result: "failed", reason: "owner_password_not_set" });
    throw new AppError(
      401,
      "Owner password is not set. Set it in IMS.",
      undefined,
      "OWNER_PASSWORD_NOT_SET",
    );
  }

  const token = parseCookieHeader(request.headers.cookie).get(OWNER_SESSION_COOKIE);
  if (!verifyOwnerSessionToken(token)) {
    await auditOwnerOverride(request, { ...input, result: "failed", reason: "owner_session_required" });
    throw new AppError(401, "Owner override required", undefined, "OWNER_LOGIN_REQUIRED");
  }

  await auditOwnerOverride(request, { ...input, result: "authorised" });
};
