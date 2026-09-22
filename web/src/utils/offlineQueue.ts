import type { ConfirmOrderBody, CreateOrderBody, PayOrderBody } from "../api/types";

export type QueueFailureReason = "backend_unreachable" | "database_down" | "insufficient_stock" | "terminal_revoked";

export type QueuedSale = {
  cashierUnverified?: boolean;
  confirmBody: ConfirmOrderBody;
  createBody: CreateOrderBody;
  failedReason?: QueueFailureReason;
  id: string;
  localOrderId: string;
  payBody: PayOrderBody;
  queuedAt: string;
  resultOrderId?: string;
  status: "pending" | "syncing" | "failed" | "synced";
};

const DB_NAME = "pos-terminal-queue";
const STORE_NAME = "sales";
const FALLBACK_KEY = "pos_offline_queue_fallback";

const hasIndexedDb = () => typeof indexedDB !== "undefined";

const openDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
};

const readFallback = (): QueuedSale[] => {
  try {
    return JSON.parse(localStorage.getItem(FALLBACK_KEY) ?? "[]") as QueuedSale[];
  } catch {
    return [];
  }
};

const writeFallback = (items: QueuedSale[]) => {
  localStorage.setItem(FALLBACK_KEY, JSON.stringify(items));
};

export const listQueuedSales = async (): Promise<QueuedSale[]> => {
  if (!hasIndexedDb()) return readFallback();
  return withStore("readonly", (store) => store.getAll() as IDBRequest<QueuedSale[]>);
};

export const putQueuedSale = async (sale: QueuedSale) => {
  if (!hasIndexedDb()) {
    const items = readFallback().filter((item) => item.id !== sale.id);
    writeFallback([...items, sale]);
    return;
  }
  await withStore("readwrite", (store) => store.put(sale));
};

export const updateQueuedSale = async (id: string, patch: Partial<QueuedSale>) => {
  const current = await listQueuedSales();
  const sale = current.find((item) => item.id === id);
  if (!sale) return;
  await putQueuedSale({ ...sale, ...patch });
};

export const exportQueueJson = async () => JSON.stringify(await listQueuedSales(), null, 2);
