import { and, desc, eq, gte, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "../../infrastructure/database/db.js";
import { auditLog, users } from "../../infrastructure/database/schema.js";

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AuditLogInput = {
  action: string;
  entityId: string;
  entityType: string;
  metadata?: Record<string, unknown>;
  tenantId: string;
  userId: string;
};

export type AuditLogFilters = {
  action?: string;
  entityId?: string;
  entityType?: string;
  from?: Date;
  limit: number;
  offset: number;
  to?: Date;
  userId?: string;
};

export const logAudit = async (
  input: AuditLogInput,
  executor: DbExecutor = db,
) => {
  const [created] = await executor
    .insert(auditLog)
    .values({
      action: input.action,
      entityId: input.entityId,
      entityType: input.entityType,
      id: randomUUID(),
      metadata: input.metadata ?? {},
      tenantId: input.tenantId,
      userId: input.userId,
    })
    .returning();

  return created;
};

export const listAuditLog = async (tenantId: string, filters: AuditLogFilters) => {
  const predicates = [
    eq(users.tenantId, tenantId),
    filters.userId ? eq(auditLog.userId, filters.userId) : undefined,
    filters.action ? eq(auditLog.action, filters.action) : undefined,
    filters.entityType ? eq(auditLog.entityType, filters.entityType) : undefined,
    filters.entityId ? eq(auditLog.entityId, filters.entityId) : undefined,
    filters.from ? gte(auditLog.createdAt, filters.from) : undefined,
    filters.to ? lte(auditLog.createdAt, filters.to) : undefined,
  ].filter((predicate) => predicate !== undefined);

  const rows = await db
    .select({
      action: auditLog.action,
      createdAt: auditLog.createdAt,
      entityId: auditLog.entityId,
      entityType: auditLog.entityType,
      id: auditLog.id,
      metadata: auditLog.metadata,
      userId: auditLog.userId,
    })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.userId))
    .where(and(...predicates))
    .orderBy(desc(auditLog.createdAt))
    .limit(filters.limit)
    .offset(filters.offset);

  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
};
