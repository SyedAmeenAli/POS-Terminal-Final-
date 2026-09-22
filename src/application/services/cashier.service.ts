import { and, eq } from "drizzle-orm";

import { AppError } from "../../api/errors.js";
import { loadEnvSync } from "../../env-sync.js";
import { verifyPassword } from "../../infrastructure/adapters/password.adapter.js";
import { db } from "../../infrastructure/database/db.js";
import { cashiers } from "../../infrastructure/database/schema.js";

type DbExecutor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

type CashierAttribution = {
  id: string;
  name: string;
};

type PinFailureEntry = {
  count: number;
  expiresAt: number;
};

const PIN_UNAUTHORISED_MESSAGE = "Cashier PIN not accepted";
const DUMMY_PIN_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$UeAeW1eQFqyjf9G3H3AeRw$bENpYYHpROe2NgaLafaDnSszI0IAC0JM4axa+LJWM2g";

const pinFailures = new Map<string, PinFailureEntry>();

const failureKey = (terminalId: string, cashierId: string): string =>
  `${terminalId}:${cashierId}`;

const getWindowMs = (): number => loadEnvSync().CASHIER_PIN_WINDOW_SECONDS * 1000;

const getMaxFailures = (): number => loadEnvSync().CASHIER_PIN_MAX_FAILURES;

const getFailureEntry = (key: string): PinFailureEntry | undefined => {
  const entry = pinFailures.get(key);

  if (!entry) {
    return undefined;
  }

  if (entry.expiresAt <= Date.now()) {
    pinFailures.delete(key);
    return undefined;
  }

  return entry;
};

const recordPinFailure = (key: string): void => {
  const existing = getFailureEntry(key);
  pinFailures.set(key, {
    count: (existing?.count ?? 0) + 1,
    expiresAt: existing?.expiresAt ?? Date.now() + getWindowMs(),
  });
};

const clearPinFailures = (key: string): void => {
  pinFailures.delete(key);
};

export const resetCashierPinFailuresForTests = (): void => {
  pinFailures.clear();
};

const rejectPin = (): never => {
  throw new AppError(401, PIN_UNAUTHORISED_MESSAGE);
};

export const listActiveCashiers = async (): Promise<CashierAttribution[]> =>
  db
    .select({
      id: cashiers.id,
      name: cashiers.name,
    })
    .from(cashiers)
    .where(eq(cashiers.status, "active"))
    .orderBy(cashiers.name);

export const getActiveCashierForAttribution = async (
  cashierId: string,
  executor: DbExecutor = db,
): Promise<CashierAttribution> => {
  const [cashier] = await executor
    .select({
      id: cashiers.id,
      name: cashiers.name,
    })
    .from(cashiers)
    .where(and(eq(cashiers.id, cashierId), eq(cashiers.status, "active")))
    .limit(1);

  if (!cashier) {
    throw new AppError(401, "Cashier not accepted");
  }

  return cashier;
};

export const verifyCashierPin = async (
  cashierId: string,
  pin: string,
  terminalId: string,
): Promise<CashierAttribution> => {
  const key = failureKey(terminalId, cashierId);
  const existingFailure = getFailureEntry(key);

  if ((existingFailure?.count ?? 0) >= getMaxFailures()) {
    return rejectPin();
  }

  const [cashier] = await db
    .select({
      id: cashiers.id,
      name: cashiers.name,
      pinHash: cashiers.pinHash,
      status: cashiers.status,
    })
    .from(cashiers)
    .where(eq(cashiers.id, cashierId))
    .limit(1);

  const pinMatches = await verifyPassword(pin, cashier?.pinHash ?? DUMMY_PIN_HASH);

  if (!cashier || cashier.status !== "active" || !pinMatches) {
    recordPinFailure(key);
    return rejectPin();
  }

  clearPinFailures(key);
  return {
    id: cashier.id,
    name: cashier.name,
  };
};
