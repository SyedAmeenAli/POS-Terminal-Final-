import {
  BadgeCheck,
  CreditCard,
  Download,
  Mail,
  Minus,
  Printer,
  RefreshCcw,
  ScanLine,
  Search,
  ShieldAlert,
  UserRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AxLogo } from "../components/AxLogo";
import { ThemeToggle } from "../components/ThemeToggle";
import { ApiError, getStoredTerminalToken, setStoredTerminalToken } from "../api/client";
import {
  closeShift,
  confirmOrder,
  createOrder,
  endOwnerOverride,
  emailReceipt,
  getCurrentShift,
  getInventory,
  getOwnerStatus,
  listCashiers,
  listOrders,
  listProductVariants,
  listProducts,
  openShift,
  payOrder,
  verifyOwner,
  verifyCashierPin,
} from "../api/orders";
import type {
  Cashier,
  ConfirmOrderBody,
  CreateOrderBody,
  DiscountType,
  Order,
  PayOrderBody,
  Product,
  ProductVariant,
  ShiftReport,
  TenderInput,
  TenderMethod,
} from "../api/types";
import {
  exportQueueJson,
  listQueuedSales,
  putQueuedSale,
  updateQueuedSale,
  type QueueFailureReason,
  type QueuedSale,
} from "../utils/offlineQueue";
import { formatQuantityMilli, isFractionalUnit, milliToUnits, parseCartQuantity, unitLabel } from "../utils/quantity";
import { apiGet } from "../api/client";

type CartItem = {
  availableQty: number;
  discountType?: DiscountType;
  discountValue?: number;
  product: Product;
  quantity: number;
  variant: ProductVariant;
};

type TenderDraft = TenderInput;

type ActiveCashier = {
  id: string;
  name: string;
  verified: boolean;
};

type FailureMode = "online" | "offline" | "backend_unreachable" | "database_down";

const emptyAddress = {
  shippingAddressLine1: "Counter sale",
  shippingCity: "Shop",
  shippingPostalCode: "000000",
  shippingState: "Local",
};

const money = (value: number | string | null | undefined) => `₹${Number(value ?? 0).toFixed(2)}`;

const decimal = (value: number) => value.toFixed(2);

const classifyQueueableError = (error: unknown): QueueFailureReason | null => {
  if (!(error instanceof ApiError)) return "backend_unreachable";
  if (error.errorType === "BACKEND_UNREACHABLE") return "backend_unreachable";
  if (error.errorType === "DATABASE_DOWN") return "database_down";
  if (error.errorType === "INSUFFICIENT_STOCK") return "insufficient_stock";
  if (error.errorType === "AUTH") return "terminal_revoked";
  return null;
};

const isQueueableNow = (mode: FailureMode, error?: unknown) =>
  mode !== "online" || classifyQueueableError(error) !== null;

const getCachedCashiers = (): Cashier[] => {
  try {
    return JSON.parse(localStorage.getItem("pos_cashiers_cache") ?? "[]") as Cashier[];
  } catch {
    return [];
  }
};

const cacheCashiers = (cashiers: Cashier[]) => {
  localStorage.setItem("pos_cashiers_cache", JSON.stringify(cashiers));
};

// Colour and size are optional since T30, so they are FILTERED rather than
// interpolated. A template literal renders a null as the four characters
// "null", which is what a cashier would have read on the cart line for every
// hardware item.
const getProductLabel = (product: Product, variant: ProductVariant) =>
  [product.name, variant.color, variant.size, variant.sku].filter(Boolean).join(" ");

const shortRef = (value: string) => value.slice(0, 8);

const formatDateTime = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : "Time pending";

const calculateDiscountedLineTotal = (item: Order["items"][number]) => {
  const gross = Number(item.unitPrice) * milliToUnits(item.quantityMilli);
  const discount = Number(item.discountValue ?? 0);
  if (!item.discountType || discount <= 0) return gross;
  return Math.max(0, item.discountType === "percent" ? gross * (1 - discount / 100) : gross - discount);
};

const tenderLabel = (method: TenderMethod) => (method === "UPI" ? "UPI" : method[0]!.toUpperCase() + method.slice(1));

export function POSPage() {
  const [tokenInput, setTokenInput] = useState("");
  const [hasToken, setHasToken] = useState(() => Boolean(getStoredTerminalToken()));
  const [terminalBlocked, setTerminalBlocked] = useState(false);
  const [failureMode, setFailureMode] = useState<FailureMode>(
    typeof navigator === "undefined" || navigator.onLine ? "online" : "offline",
  );
  const [products, setProducts] = useState<Product[]>([]);
  const [variantsByProduct, setVariantsByProduct] = useState<Record<string, Array<ProductVariant & { stock: number }>>>({});
  // Which product's variants are visible. Deliberately separate from
  // variantsByProduct, which is a fetch cache — deriving visibility from cache
  // presence meant a panel could never be closed once opened.
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Raw text while a cashier is mid-keystroke — "1." is not a number yet and
  // must not be forced into one, or the cursor jumps and the decimal point
  // cannot be typed at all.
  // PROPOSAL 02 §2d — the batch a line will be sold from, and when it
  // expires. The till does NOT choose it: FEFO decides server-side, and this
  // shows the cashier what that decision will be. A refusal reading only
  // EXPIRED_STOCK is one a cashier cannot act on.
  const [lotPreview, setLotPreview] = useState<Record<string, { batchNumber: string; expiryDate: string | null } | null>>({});

  const [qtyDrafts, setQtyDrafts] = useState<Record<string, string | undefined>>({});
  const [qtyError, setQtyError] = useState<Record<string, string | undefined>>({});
  const [cart, setCart] = useState<CartItem[]>([]);
  const [orderDiscountType, setOrderDiscountType] = useState<DiscountType>("flat");
  const [orderDiscountValue, setOrderDiscountValue] = useState("0");
  const [tenders, setTenders] = useState<TenderDraft[]>([{ amount: "0.00", method: "cash" }]);
  const [receiptEmail, setReceiptEmail] = useState("");
  const [message, setMessage] = useState("");
  const [finalOrder, setFinalOrder] = useState<Order | null>(null);
  const [recentOrders, setRecentOrders] = useState<Order[]>([]);
  const [queuedSales, setQueuedSales] = useState<QueuedSale[]>([]);
  const [cashiers, setCashiers] = useState<Cashier[]>([]);
  const [activeCashier, setActiveCashier] = useState<ActiveCashier | null>(null);
  const [cashierPin, setCashierPin] = useState("");
  const [cashierId, setCashierId] = useState("");
  const [shiftReport, setShiftReport] = useState<ShiftReport | null>(null);
  const [openingFloat, setOpeningFloat] = useState("0.00");
  const [countedCash, setCountedCash] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [lastZReport, setLastZReport] = useState<ShiftReport | null>(null);
  const [duplicateOrder, setDuplicateOrder] = useState<Order | null>(null);
  const [ownerOverride, setOwnerOverride] = useState<{ authorised: boolean; expiresAt: string | null }>({
    authorised: false,
    expiresAt: null,
  });
  const [ownerPassword, setOwnerPassword] = useState("");
  const [ownerPromptOpen, setOwnerPromptOpen] = useState(false);
  const [ownerPromptError, setOwnerPromptError] = useState("");
  const [pendingOwnerAction, setPendingOwnerAction] = useState<(() => Promise<void>) | null>(null);
  const [ownerRemainingSeconds, setOwnerRemainingSeconds] = useState(0);
  const scannerBufferRef = useRef("");
  const lastScannerKeyRef = useRef(0);
  const syncGuardRef = useRef(false);

  const refreshQueue = useCallback(async () => {
    setQueuedSales(await listQueuedSales());
  }, []);

  const handleAuthError = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.errorType === "AUTH") {
      setTerminalBlocked(true);
      setMessage("Terminal not authorised. Re-enter a token when a supervisor provides one.");
      return true;
    }
    return false;
  }, []);

  const refreshOwnerStatus = useCallback(async () => {
    if (!hasToken) return;
    try {
      setOwnerOverride(await getOwnerStatus());
    } catch {
      setOwnerOverride({ authorised: false, expiresAt: null });
    }
  }, [hasToken]);

  const endOverrideSession = useCallback(async () => {
    try {
      await endOwnerOverride();
    } finally {
      setOwnerOverride({ authorised: false, expiresAt: null });
      setOwnerPassword("");
      setOwnerPromptOpen(false);
      setPendingOwnerAction(null);
    }
  }, []);

  const requestOwnerOverride = useCallback((action: () => Promise<void>, messageText: string) => {
    if (failureMode !== "online") {
      setMessage("Owner override requires connection. This action is unavailable offline.");
      return;
    }

    setOwnerPromptError("");
    setMessage(messageText);
    setPendingOwnerAction(() => action);
    setOwnerPromptOpen(true);
  }, [failureMode]);

  const submitOwnerOverride = async () => {
    try {
      const status = await verifyOwner(ownerPassword);
      setOwnerOverride(status);
      setOwnerPassword("");
      setOwnerPromptOpen(false);
      const action = pendingOwnerAction;
      setPendingOwnerAction(null);
      if (action) await action();
    } catch (error) {
      setOwnerPassword("");
      setOwnerPromptError(error instanceof Error ? error.message : "Owner password not accepted.");
    }
  };

  useEffect(() => {
    void refreshOwnerStatus();
  }, [refreshOwnerStatus]);

  // PROPOSAL 02 §2d — which batch each cart line will come out of.
  //
  // The till does NOT choose it. FEFO decides server-side and this only
  // SHOWS that decision, because a cashier refused with EXPIRED_STOCK and
  // nothing else cannot act on it, and a customer asking "when does this go
  // off" deserves an answer at the counter rather than after the sale.
  //
  // The first row the server returns is the one FEFO will consume: the list
  // is ordered nearest-expiry first, undated last, by the same rule.
  useEffect(() => {
    const variantIds = cart.map((line) => line.variant.id);
    if (variantIds.length === 0) return;

    let cancelled = false;
    void Promise.all(
      variantIds.map(async (variantId) => {
        try {
          const res = await apiGet<{ data: Array<{ availableQtyMilli: string; batchNumber: string; expiryDate: string | null }> }>(
            `/inventory/${variantId}/lots`,
          );
          const next = res.data.find((lot) => Number(lot.availableQtyMilli) > 0) ?? null;
          return [variantId, next ? { batchNumber: next.batchNumber, expiryDate: next.expiryDate } : null] as const;
        } catch {
          // An untracked item has no lots and this 404s or returns empty.
          // Silent by design: most tills sell nothing batch-tracked, and an
          // error toast per cart line would be noise at a counter.
          return [variantId, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setLotPreview(Object.fromEntries(entries));
    });

    return () => {
      cancelled = true;
    };
  }, [cart]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!ownerOverride.authorised || !ownerOverride.expiresAt) {
        setOwnerRemainingSeconds(0);
        return;
      }

      const remaining = Math.max(0, Math.floor((new Date(ownerOverride.expiresAt).getTime() - Date.now()) / 1000));
      setOwnerRemainingSeconds(remaining);
      if (remaining === 0) {
        setOwnerOverride({ authorised: false, expiresAt: null });
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [ownerOverride]);

  useEffect(() => {
    let hiddenAt: number | null = null;
    const handleVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }

      if (hiddenAt && Date.now() - hiddenAt > 3 * 60 * 1000) {
        void endOverrideSession();
      }
      hiddenAt = null;
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [endOverrideSession]);

  const loadTillData = useCallback(async () => {
    if (!hasToken) return;
    try {
      const [loadedProducts, loadedCashiers, currentShift, orders] = await Promise.all([
        listProducts(),
        listCashiers(),
        getCurrentShift(),
        listOrders(),
      ]);
      setProducts(loadedProducts);
      setCashiers(loadedCashiers);
      cacheCashiers(loadedCashiers);
      setShiftReport(currentShift && "tenders" in currentShift ? currentShift : null);
      setRecentOrders(orders);
      setFailureMode("online");
      setTerminalBlocked(false);
    } catch (error) {
      if (handleAuthError(error)) return;
      if (error instanceof ApiError && error.errorType === "DATABASE_DOWN") {
        setFailureMode("database_down");
        setMessage("Backend is up but database calls are failing. Cash sales will queue.");
      } else {
        setFailureMode(navigator.onLine ? "backend_unreachable" : "offline");
        setMessage(navigator.onLine ? "Backend unreachable. Cash sales will queue." : "Offline. Cash sales will queue.");
      }
      const cached = getCachedCashiers();
      if (cached.length) setCashiers(cached);
    }
  }, [handleAuthError, hasToken]);

  useEffect(() => {
    void refreshQueue();
    void loadTillData();
  }, [loadTillData, refreshQueue]);

  const syncQueue = useCallback(async () => {
    if (syncGuardRef.current || !hasToken) return;
    syncGuardRef.current = true;
    try {
      const entries = await listQueuedSales();
      for (const entry of entries.filter((item) => item.status === "pending")) {
        try {
          await updateQueuedSale(entry.id, { status: "syncing" });
          const created = await createOrder(entry.createBody);
          const orderId = created.data.id;
          await confirmOrder(orderId, entry.confirmBody);
          const paid = await payOrder(orderId, entry.payBody);
          await updateQueuedSale(entry.id, { resultOrderId: paid.data.id, status: "synced" });
          setFinalOrder(paid.data);
        } catch (error) {
          const reason = classifyQueueableError(error);
          if (reason === "backend_unreachable" || reason === "database_down") {
            await updateQueuedSale(entry.id, { status: "pending" });
            setFailureMode(reason);
            break;
          }
          await updateQueuedSale(entry.id, {
            failedReason: reason ?? "database_down",
            status: "failed",
          });
          if (reason === "terminal_revoked") setTerminalBlocked(true);
          break;
        } finally {
          await refreshQueue();
        }
      }
    } finally {
      syncGuardRef.current = false;
    }
  }, [hasToken, refreshQueue]);

  useEffect(() => {
    const online = () => {
      setFailureMode("online");
      void syncQueue();
      void loadTillData();
    };
    const offline = () => setFailureMode("offline");
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, [loadTillData, syncQueue]);

  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return products;
    return products.filter((product) =>
      [product.name, product.brand, product.styleCode].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [products, query]);

  const lineDiscountedTotal = cart.reduce((total, item) => {
    const line = Number(item.variant.retailPrice) * item.quantity;
    const discount = item.discountValue ?? 0;
    const reduced = item.discountType === "percent" ? line * (1 - discount / 100) : line - discount;
    return total + Math.max(0, reduced);
  }, 0);
  const orderDiscount = Number(orderDiscountValue || 0);
  const payableTotal = Math.max(
    0,
    orderDiscountType === "percent" ? lineDiscountedTotal * (1 - orderDiscount / 100) : lineDiscountedTotal - orderDiscount,
  );
  const rawSubtotal = cart.reduce((total, item) => total + Number(item.variant.retailPrice) * item.quantity, 0);
  const effectiveDiscountPercent = rawSubtotal > 0 ? ((rawSubtotal - payableTotal) / rawSubtotal) * 100 : 0;

  useEffect(() => {
    setTenders((current) => current.map((tender, index) => (index === 0 ? { ...tender, amount: decimal(payableTotal) } : tender)));
  }, [payableTotal]);

  // Optimistic stock update for the moment a sale completes. loadVariants
  // caches per product.id and is never invalidated on its own, so without
  // this the picker keeps showing pre-sale stock until the whole page
  // reloads — a cashier reopening the same product right after selling the
  // last unit would see it as still purchasable. This edits the cache in
  // place rather than clearing it, so it's instant with no refetch; the
  // server's own count is still what order.service.ts enforces at sale time,
  // this is display only.
  const applyLocalStockDelta = (soldItems: CartItem[]) => {
    setVariantsByProduct((current) => {
      const next: typeof current = { ...current };
      for (const productId of Object.keys(next)) {
        next[productId] = next[productId]!.map((variant) => {
          const sold = soldItems.find((item) => item.variant.id === variant.id);
          return sold ? { ...variant, stock: Math.max(0, variant.stock - sold.quantity) } : variant;
        });
      }
      return next;
    });
  };

  const loadVariants = async (product: Product) => {
    if (variantsByProduct[product.id]) return variantsByProduct[product.id];
    try {
      const variants = await listProductVariants(product.id);
      const withStock = await Promise.all(
        variants.map(async (variant) => {
          try {
            const stock = await getInventory(variant.id);
            return { ...variant, stock: stock.availableQty };
          } catch {
            return { ...variant, stock: 0 };
          }
        }),
      );
      setVariantsByProduct((current) => ({ ...current, [product.id]: withStock }));
      return withStock;
    } catch (error) {
      handleAuthError(error);
      setMessage("Could not load variants for this product.");
      return [];
    }
  };

  // Cart-side stock cap. availableQty is a snapshot taken when the line was
  // started, so it can drift while offline — the server (order.service.ts)
  // still refuses INSUFFICIENT_STOCK at sync, unaffected by this. This only
  // stops the common case: a cashier scanning or clicking past what the
  // screen already showed as available.
  const addVariant = (product: Product, variant: ProductVariant & { stock: number }) => {
    setCart((current) => {
      const existing = current.find((item) => item.variant.id === variant.id);
      if (existing) {
        if (existing.quantity >= existing.availableQty) {
          setQtyError((errors) => ({ ...errors, [variant.id]: `Only ${existing.availableQty} in stock.` }));
          return current;
        }
        return current.map((item) => (item.variant.id === variant.id ? { ...item, quantity: item.quantity + 1 } : item));
      }
      if (variant.stock <= 0) {
        setQtyError((errors) => ({ ...errors, [variant.id]: "Out of stock." }));
        return current;
      }
      return [...current, { availableQty: variant.stock, product, quantity: 1, variant }];
    });
  };

  const scanSku = useCallback(
    async (sku: string) => {
      const normalized = sku.trim();
      if (!normalized) return;
      for (const product of products) {
        const variants = variantsByProduct[product.id] ?? (await loadVariants(product));
        const variant = variants.find((item) => item.sku === normalized);
        if (variant) {
          addVariant(product, variant);
          setMessage(`Scanned ${variant.sku}`);
          return;
        }
      }
      setMessage(`No product found for ${normalized}`);
    },
    [products, variantsByProduct],
  );

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) {
        return;
      }
      const now = performance.now();
      if (now - lastScannerKeyRef.current > 70) scannerBufferRef.current = "";
      if (event.key === "Enter") {
        void scanSku(scannerBufferRef.current);
        scannerBufferRef.current = "";
      } else if (event.key.length === 1) {
        scannerBufferRef.current += event.key;
      }
      lastScannerKeyRef.current = now;
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [scanSku]);

  const tenderTotal = tenders.reduce((total, tender) => total + Number(tender.amount || 0), 0);
  const tendersValid =
    Math.round(tenderTotal * 100) === Math.round(payableTotal * 100) &&
    tenders.every((tender) => tender.method !== "card" || (/^\d{4}$/.test(tender.cardLast4 ?? "") && Boolean(tender.cardApprovalCode?.trim())));

  const canQueue = tenders.every((tender) => tender.method === "cash");

  const buildCheckoutPayload = () => {
    const id = crypto.randomUUID();
    const cashierPayload = activeCashier ? { cashierId: activeCashier.id } : {};
    const createBody: CreateOrderBody = {
      ...cashierPayload,
      discountType: Number(orderDiscountValue || 0) > 0 ? orderDiscountType : undefined,
      discountValue: Number(orderDiscountValue || 0) > 0 ? Number(orderDiscountValue) : undefined,
      idempotencyKey: id,
      items: cart.map((item) => ({
        discountType: item.discountValue ? item.discountType : undefined,
        discountValue: item.discountValue,
        quantity: item.quantity,
        variantId: item.variant.id,
      })),
      paymentPreference: tenders.length === 1 && tenders[0]?.method === "UPI" ? "UPI" : "cash",
    };
    const confirmBody: ConfirmOrderBody = {
      ...cashierPayload,
      ...emptyAddress,
      idempotencyKey: `${id}:confirm`,
    };
    const payBody: PayOrderBody = {
      ...cashierPayload,
      idempotencyKey: `${id}:pay`,
      tenders: tenders.map((tender) => ({
        ...tender,
        amount: decimal(Number(tender.amount || 0)),
        cardApprovalCode: tender.cardApprovalCode?.trim() || undefined,
        cardLast4: tender.cardLast4?.trim() || undefined,
      })),
    };
    return { confirmBody, createBody, id, payBody };
  };

  const queueCheckout = async (payload: ReturnType<typeof buildCheckoutPayload>, reason: QueueFailureReason) => {
    if (!canQueue) {
      setMessage("Offline sales can queue only with cash tender. Use the bank slip after reconnect for card.");
      return;
    }
    await putQueuedSale({
      cashierUnverified: activeCashier ? !activeCashier.verified : undefined,
      confirmBody: payload.confirmBody,
      createBody: payload.createBody,
      failedReason: reason === "insufficient_stock" || reason === "terminal_revoked" ? reason : undefined,
      id: payload.id,
      localOrderId: `offline-${payload.id}`,
      payBody: payload.payBody,
      queuedAt: new Date().toISOString(),
      status: reason === "insufficient_stock" || reason === "terminal_revoked" ? "failed" : "pending",
    });
    await refreshQueue();
    if (reason === "database_down") setFailureMode("database_down");
    if (reason === "backend_unreachable") setFailureMode(navigator.onLine ? "backend_unreachable" : "offline");
    setFinalOrder({
      createdAt: new Date().toISOString(),
      discountType: Number(orderDiscountValue || 0) > 0 ? orderDiscountType : null,
      discountValue: Number(orderDiscountValue || 0) > 0 ? Number(orderDiscountValue) : null,
      id: `offline-${payload.id}`,
      invoiceNumber: null,
      items: cart.map((item) => ({
        discountType: item.discountType ?? null,
        discountValue: item.discountValue ?? null,
        id: `${payload.id}-${item.variant.id}`,
        name: item.product.name,
        orderId: `offline-${payload.id}`,
        // The cart's own quantity is already whole units — this synthetic
        // receipt (queued-offline order, never hit the server) must match
        // the SAME milli-string shape a real fetched order now carries.
        quantityMilli: String(Math.round(item.quantity * 1000)),
        sku: item.variant.sku,
        unitPrice: Number(item.variant.retailPrice),
        variantId: item.variant.id,
      })),
      orderStatus: "Paid",
      paymentPreference: "cash",
      subtotalAmount: payableTotal,
      taxAmount: 0,
      tenders: payload.payBody.tenders?.map((tender, index) => ({
        ...tender,
        id: `${payload.id}-tender-${index}`,
        orderId: `offline-${payload.id}`,
      })),
      total: payableTotal,
    });
    // Optimistic, same as the online path below — this queued sale is
    // expected to go through at sync, whatever knocked it offline.
    applyLocalStockDelta(cart);
    setCart([]);
    setMessage(reason === "terminal_revoked" ? "Queued sale marked terminal revoked." : "Cash sale queued. Stock levels may be outdated.");
  };

  const checkout = async () => {
    if (!cart.length) {
      setMessage("Cart is empty.");
      return;
    }
    // getOpenShiftIdForTerminal (order.service.ts) resolves the shift
    // server-side and silently stores shift_id: null when none is open —
    // the sale still completes, cash still changes hands, but the order
    // becomes permanently unattached to any shift's reconciliation. Without
    // this guard a cashier could sell all day with no shift open and the
    // Z report would read "Orders 0" against a real cash drawer.
    if (!shiftReport) {
      setMessage("Open a shift before taking a sale — otherwise this sale won't be counted in reconciliation.");
      return;
    }
    if (!tendersValid) {
      setMessage("Tender totals must match, and card needs last-4 plus approval code from the card machine slip.");
      return;
    }
    const payload = buildCheckoutPayload();
    if (failureMode !== "online" && effectiveDiscountPercent > 25) {
      setMessage("Owner override requires connection. Discounted sales over the threshold are unavailable offline.");
      return;
    }
    if (failureMode !== "online") {
      await queueCheckout(payload, failureMode === "database_down" ? "database_down" : "backend_unreachable");
      return;
    }
    try {
      const created = await createOrder(payload.createBody);
      await confirmOrder(created.data.id, payload.confirmBody);
      const paid = await payOrder(created.data.id, payload.payBody);
      if (receiptEmail) await emailReceipt(paid.data.id, receiptEmail);
      setFinalOrder(paid.data);
      setRecentOrders((current) => [paid.data, ...current.filter((order) => order.id !== paid.data.id)].slice(0, 20));
      applyLocalStockDelta(cart);
      setCart([]);
      setMessage("Paid. Invoice ready.");
      if (ownerOverride.authorised) void endOverrideSession();
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.errorType === "OWNER_LOGIN_REQUIRED" || error.errorType === "OWNER_PASSWORD_NOT_SET")
      ) {
        if (error.errorType === "OWNER_PASSWORD_NOT_SET") {
          setMessage("Owner password is not set in IMS.");
          return;
        }
        requestOwnerOverride(
          () => checkout(),
          "Owner password required for this high-risk action.",
        );
        return;
      }
      if (handleAuthError(error)) {
        await queueCheckout(payload, "terminal_revoked");
        return;
      }
      const reason = classifyQueueableError(error);
      if (isQueueableNow(failureMode, error) && reason) {
        await queueCheckout(payload, reason);
        return;
      }
      setMessage(error instanceof Error ? error.message : "Sale failed.");
    }
  };

  const chooseCashier = async () => {
    const chosen = cashiers.find((cashier) => (cashier.id ?? cashier.cashierId) === cashierId);
    if (!chosen) return;
    if (failureMode !== "online") {
      setActiveCashier({ id: chosen.id ?? chosen.cashierId!, name: chosen.name, verified: false });
      setMessage("Cashier switched offline. Actions will be labelled unverified.");
      return;
    }
    try {
      const verified = await verifyCashierPin(chosen.id ?? chosen.cashierId!, cashierPin);
      setActiveCashier({ id: verified.cashierId, name: verified.name, verified: true });
      setCashierPin("");
    } catch (error) {
      handleAuthError(error);
      setMessage("PIN not verified.");
    }
  };

  const handleOpenShift = async () => {
    try {
      await openShift({ cashierId: activeCashier?.id, openingFloat });
      setShiftReport(await getCurrentShift());
      setMessage("Shift open.");
    } catch (error) {
      handleAuthError(error);
      setMessage(error instanceof Error ? error.message : "Could not open shift.");
    }
  };

  const handleCloseShift = async () => {
    if (!countedCash) {
      setMessage("Enter counted cash before expected cash is revealed.");
      return;
    }
    try {
      const report = await closeShift({ cashierId: activeCashier?.id, countedCash, note: closeNote || undefined });
      setShiftReport(null);
      setLastZReport(report);
      setCountedCash("");
      setCloseNote("");
      setMessage("Shift closed. Z report ready.");
    } catch (error) {
      handleAuthError(error);
      setMessage(error instanceof Error ? error.message : "Could not close shift.");
    }
  };

  const signOutCashier = () => {
    setActiveCashier(null);
    setCashierId("");
    setCashierPin("");
    setMessage("Cashier signed out. Sales can continue unattributed.");
  };

  const exportQueue = async () => {
    const blob = new Blob([await exportQueueJson()], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `pos-queue-${new Date().toISOString()}.json`;
    link.click();
    URL.revokeObjectURL(href);
  };

  const retryTerminalRevoked = async () => {
    for (const sale of queuedSales.filter((item) => item.status === "failed" && item.failedReason === "terminal_revoked")) {
      await updateQueuedSale(sale.id, { failedReason: undefined, status: "pending" });
    }
    await refreshQueue();
    await syncQueue();
  };

  if (!hasToken) {
    return (
      <main className="setup-screen">
        <section className="setup-panel">
          <AxLogo active size={56} />
          <h1>Terminal Setup</h1>
          <p>Enter the terminal token a supervisor provisioned to unlock this till.</p>
          <input
            aria-label="Terminal token"
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="Paste provisioned terminal token"
            type="password"
            value={tokenInput}
          />
          <button
            className="btn-primary"
            onClick={() => {
              setStoredTerminalToken(tokenInput);
              setHasToken(Boolean(tokenInput.trim()));
            }}
            type="button"
          >
            Save Token
          </button>
        </section>
      </main>
    );
  }

  if (terminalBlocked) {
    return (
      <main className="setup-screen">
        <section className="setup-panel">
          <AxLogo size={56} />
          <ShieldAlert aria-hidden />
          <h1>Terminal Not Authorised</h1>
          <p>The stored token was not cleared. Re-enter a replacement token when ready.</p>
          <input
            aria-label="Replacement terminal token"
            onChange={(event) => setTokenInput(event.target.value)}
            placeholder="Replacement terminal token"
            type="password"
            value={tokenInput}
          />
          <button
            className="btn-primary"
            onClick={() => {
              setStoredTerminalToken(tokenInput);
              setTerminalBlocked(false);
              void loadTillData();
              void syncQueue();
            }}
            type="button"
          >
            Re-enter Token
          </button>
        </section>
      </main>
    );
  }

  const connectivityLabel =
    failureMode === "online"
      ? "Online"
      : failureMode === "offline"
        ? "Offline: stock levels may be outdated"
        : failureMode === "database_down"
          ? "Database unavailable: cash sales queue"
          : "Backend unreachable: cash sales queue";

  const receiptOrder = duplicateOrder ?? finalOrder;
  const cashierNames = new Map(cashiers.map((cashier) => [cashier.id ?? cashier.cashierId, cashier.name]));
  const receiptCashierName =
    receiptOrder?.cashierName ??
    (receiptOrder?.cashierId ? cashierNames.get(receiptOrder.cashierId) ?? `Cashier ${shortRef(receiptOrder.cashierId)}` : "Unattributed");
  const receiptTenders = receiptOrder?.tenders ?? [];
  const receiptTenderTotals = receiptTenders.reduce<Record<TenderMethod, number>>(
    (totals, tender) => ({
      ...totals,
      [tender.method]: totals[tender.method] + Number(tender.amount || 0),
    }),
    { UPI: 0, card: 0, cash: 0 },
  );
  const receiptCashTender = receiptTenderTotals.cash;
  const receiptChangeDue = receiptOrder ? Math.max(0, receiptCashTender - Number(receiptOrder.total)) : 0;
  const receiptDiscountText =
    receiptOrder?.discountType && Number(receiptOrder.discountValue ?? 0) > 0
      ? `${receiptOrder.discountType === "percent" ? `${receiptOrder.discountValue}%` : money(receiptOrder.discountValue)}`
      : money(0);
  const receiptMarker =
    receiptOrder?.orderStatus === "Returned"
      ? "RETURN"
      : receiptOrder?.orderStatus === "Refunded"
        ? "REFUND"
        : null;

  return (
    <main className="pos-app">
      <header className="top-bar">
        <div className="identity-group">
          <AxLogo size={28} />
          <span className="chip" data-mode={failureMode}>
            {connectivityLabel}
          </span>
          {queuedSales.some((sale) => sale.status === "pending") ? <span className="chip warn">Queue pending</span> : null}
        </div>
        <div className="status-banner">
          <span>{shiftReport ? `Shift ${shiftReport.businessDate}` : "No open shift"}</span>
          <span>
            <UserRound aria-hidden size={16} />
            {activeCashier ? `${activeCashier.name}${activeCashier.verified ? "" : " (unverified)"}` : "No cashier selected"}
          </span>
          <ThemeToggle />
        </div>
      </header>

      {failureMode !== "online" ? <div className="trust-banner">Stock levels may be outdated until the queue syncs.</div> : null}
      {ownerOverride.authorised ? (
        <div className="owner-override-banner">
          <span>Owner override active · {Math.floor(ownerRemainingSeconds / 60)}:{String(ownerRemainingSeconds % 60).padStart(2, "0")}</span>
          <button onClick={() => void endOverrideSession()} type="button">End override</button>
        </div>
      ) : null}
      {message ? <div className="message" role="status">{message}</div> : null}

      {ownerPromptOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section aria-modal="true" className="owner-modal" role="dialog">
            <h2>Owner Override</h2>
            <p>Requires connection. Gated actions are unavailable offline.</p>
            <input
              aria-label="Owner password"
              autoComplete="current-password"
              onChange={(event) => setOwnerPassword(event.target.value)}
              type="password"
              value={ownerPassword}
            />
            {ownerPromptError ? <div className="error-text">{ownerPromptError}</div> : null}
            <div className="modal-actions">
              <button
                onClick={() => {
                  setOwnerPromptOpen(false);
                  setOwnerPassword("");
                  setPendingOwnerAction(null);
                }}
                type="button"
              >
                Cancel
              </button>
              <button className="btn-primary" onClick={() => void submitOwnerOverride()} type="button">Authorise</button>
            </div>
          </section>
        </div>
      ) : null}

      <section className="workspace">
        <section className="catalog-pane" aria-label="Product catalogue">
          <div className="toolbar">
            <label className="search-box">
              <Search aria-hidden size={18} />
              <input aria-label="Search products" onChange={(event) => setQuery(event.target.value)} placeholder="Search product, brand, style" value={query} />
            </label>
            <button onClick={() => void scanSku(query)} title="Scan barcode" type="button">
              <ScanLine aria-hidden size={18} />
            </button>
          </div>
          <div className="product-grid">
            {filteredProducts.map((product) => (
              <article className="product-card" key={product.id}>
                <button
                  aria-expanded={expandedProductId === product.id}
                  onClick={() => {
                    // Single-open accordion: a till screen stays readable when
                    // only one variant list is expanded at a time.
                    const nextId = expandedProductId === product.id ? null : product.id;
                    setExpandedProductId(nextId);
                    if (nextId) void loadVariants(product);
                  }}
                  type="button"
                >
                  <strong>{product.name}</strong>
                  <span>{product.brand}</span>
                  <small>{product.styleCode}</small>
                </button>
                {expandedProductId === product.id && (
                  <div className="variant-list">
                    {(variantsByProduct[product.id] ?? []).map((variant) => (
                      <button
                        disabled={variant.stock <= 0}
                        key={variant.id}
                        onClick={() => addVariant(product, variant)}
                        type="button"
                      >
                        <span>{variant.color} / {variant.size}</span>
                        <strong>{money(variant.retailPrice)}</strong>
                        <small>{variant.sku} · stock {variant.stock <= 0 ? "out of stock" : variant.stock}</small>
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        </section>

        <aside className="cart-pane" aria-label="Cart">
          <div className="cart-header">
            <div className="cart-title">
              <h2>Cart</h2>
              <span>{cart.length} lines</span>
            </div>
            <div className="cart-total">{money(payableTotal)}</div>
          </div>

          <div className="cart-lines">
            {cart.map((item) => (
              <article className="cart-line" key={item.variant.id}>
                <div className="line-main">
                  <strong>{getProductLabel(item.product, item.variant)}</strong>
                  <span>
                    {money(item.variant.retailPrice)} · stock {item.availableQty}
                    {unitLabel(item.variant.baseUnit)}
                  </span>
                  {qtyError[item.variant.id] && (
                    <span className="cart-qty-error" role="alert">{qtyError[item.variant.id]}</span>
                  )}
                  {lotPreview[item.variant.id] && (
                    <span className="cart-line-batch">
                      Batch {lotPreview[item.variant.id]!.batchNumber}
                      {lotPreview[item.variant.id]!.expiryDate
                        ? ` · expires ${lotPreview[item.variant.id]!.expiryDate}`
                        : ""}
                    </span>
                  )}
                </div>
                <div className="stepper">
                  {/* Decrementing from 1 removes the line. Clamping at 1 left
                      wrongly-scanned items stuck in the cart with no way out. */}
                  <button
                    aria-label={`Reduce quantity for ${item.variant.sku}`}
                    onClick={() =>
                      setCart((current) =>
                        current.flatMap((line) => {
                          if (line.variant.id !== item.variant.id) return [line];
                          return line.quantity <= 1 ? [] : [{ ...line, quantity: line.quantity - 1 }];
                        }),
                      )
                    }
                    type="button"
                  >
                    <Minus aria-hidden size={14} />
                  </button>
                  {/* An INPUT, not a span. T30 made 1.5 kg and 2.75 m
                      representable everywhere in the system except here, so a
                      grocery could not ring up loose rice and a hardware shop
                      could not sell cable. The stepper stays for the
                      whole-unit case, which is most tills.

                      The server is still the enforcer — quantityToMilli
                      refuses a fraction on a whole-unit item with
                      FRACTIONAL_NOT_ALLOWED. This check exists so the cashier
                      is told BEFORE the sale is submitted, and it uses the
                      same rule rather than a looser one. */}
                  <input
                    aria-label={`Quantity for ${item.variant.sku}`}
                    className="cart-qty-input"
                    inputMode="decimal"
                    onChange={(event) => {
                      const raw = event.target.value;
                      setQtyDrafts((drafts) => ({ ...drafts, [item.variant.id]: raw }));
                      const parsed = parseCartQuantity(raw, item.variant.baseUnit);
                      if ("value" in parsed) {
                        if (parsed.value > item.availableQty) {
                          setQtyError((errors) => ({ ...errors, [item.variant.id]: `Only ${item.availableQty} in stock.` }));
                          return;
                        }
                        setQtyError((errors) => ({ ...errors, [item.variant.id]: undefined }));
                        setCart((current) =>
                          current.map((line) =>
                            line.variant.id === item.variant.id ? { ...line, quantity: parsed.value } : line,
                          ),
                        );
                      } else {
                        setQtyError((errors) => ({ ...errors, [item.variant.id]: parsed.error }));
                      }
                    }}
                    onBlur={() => {
                      // Snap back to the committed quantity so a half-typed
                      // value never sits on screen looking authoritative.
                      setQtyDrafts((drafts) => ({ ...drafts, [item.variant.id]: undefined }));
                      setQtyError((errors) => ({ ...errors, [item.variant.id]: undefined }));
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    step={isFractionalUnit(item.variant.baseUnit) ? "0.001" : "1"}
                    type="number"
                    value={qtyDrafts[item.variant.id] ?? String(item.quantity)}
                  />
                  <span className="cart-qty-unit">{unitLabel(item.variant.baseUnit)}</span>
                  <button
                    aria-label={`Increase quantity for ${item.variant.sku}`}
                    disabled={item.quantity >= item.availableQty}
                    onClick={() => setCart((current) => current.map((line) => line.variant.id === item.variant.id ? { ...line, quantity: line.quantity + 1 } : line))}
                    type="button"
                  >
                    +
                  </button>
                  <button
                    aria-label={`Remove ${item.variant.sku} from cart`}
                    className="cart-line-remove"
                    onClick={() =>
                      setCart((current) => current.filter((line) => line.variant.id !== item.variant.id))
                    }
                    title="Remove from cart"
                    type="button"
                  >
                    <X aria-hidden size={14} />
                  </button>
                </div>
                <div className="discount-grid">
                  <select
                    aria-label={`Discount type for ${item.variant.sku}`}
                    onChange={(event) => setCart((current) => current.map((line) => line.variant.id === item.variant.id ? { ...line, discountType: event.target.value as DiscountType } : line))}
                    value={item.discountType ?? "flat"}
                  >
                    <option value="flat">₹ off</option>
                    <option value="percent">% off</option>
                  </select>
                  <input
                    aria-label={`Discount value for ${item.variant.sku}`}
                    min="0"
                    onChange={(event) => setCart((current) => current.map((line) => line.variant.id === item.variant.id ? { ...line, discountValue: Number(event.target.value || 0) } : line))}
                    placeholder="0"
                    type="number"
                    value={item.discountValue ?? ""}
                  />
                </div>
              </article>
            ))}
          </div>

          <section className="panel">
            <h3>Order Discount</h3>
            <div className="inline-fields">
              <select aria-label="Order discount type" onChange={(event) => setOrderDiscountType(event.target.value as DiscountType)} value={orderDiscountType}>
                <option value="flat">₹ off</option>
                <option value="percent">% off</option>
              </select>
              <input aria-label="Order discount value" min="0" onChange={(event) => setOrderDiscountValue(event.target.value)} type="number" value={orderDiscountValue} />
            </div>
          </section>

          <section className="panel">
            <h3>Split Tender</h3>
            {tenders.map((tender, index) => (
              <div className="tender-row" key={index}>
                <select
                  aria-label={`Tender method ${index + 1}`}
                  onChange={(event) => setTenders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, method: event.target.value as TenderMethod } : item))}
                  value={tender.method}
                >
                  <option value="cash">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="card">Card</option>
                </select>
                <input
                  aria-label={`Tender amount ${index + 1}`}
                  onChange={(event) => setTenders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))}
                  value={tender.amount}
                />
                {tender.method === "card" ? (
                  <div className="card-fields">
                    <label>
                      Slip last-4
                      <input
                        aria-label="Card slip last-4"
                        inputMode="numeric"
                        maxLength={4}
                        onChange={(event) => setTenders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, cardLast4: event.target.value } : item))}
                        value={tender.cardLast4 ?? ""}
                      />
                    </label>
                    <label>
                      Slip approval code
                      <input
                        aria-label="Card slip approval code"
                        onChange={(event) => setTenders((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, cardApprovalCode: event.target.value } : item))}
                        value={tender.cardApprovalCode ?? ""}
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            ))}
            <div className="button-row">
              <button onClick={() => setTenders((current) => [...current, { amount: "0.00", method: "cash" }])} type="button">Add Tender</button>
              <button onClick={() => setTenders([{ amount: decimal(payableTotal), method: "cash" }])} type="button">Cash Exact</button>
              <button onClick={() => setTenders([{ amount: decimal(payableTotal), method: "UPI" }])} type="button">UPI Exact</button>
              <button onClick={() => setTenders([{ amount: decimal(payableTotal), method: "card" }])} type="button">
                <CreditCard aria-hidden size={16} /> Card Exact
              </button>
            </div>
          </section>

          <section className="panel">
            <h3>Receipt</h3>
            <input aria-label="Receipt email" onChange={(event) => setReceiptEmail(event.target.value)} placeholder="customer@example.com" value={receiptEmail} />
            <button className="btn-primary" disabled={!cart.length || !shiftReport} onClick={() => void checkout()} type="button">
              <BadgeCheck aria-hidden size={18} /> Pay
            </button>
            {!shiftReport && <p className="pay-blocked-note">Open a shift to enable Pay.</p>}
          </section>
        </aside>
      </section>

      <section className="ops-grid">
        <section className="panel">
          <h2>Cashier</h2>
          <div className="inline-fields">
            <select aria-label="Cashier picker" onChange={(event) => setCashierId(event.target.value)} value={cashierId}>
              <option value="">Select cashier</option>
              {cashiers.map((cashier) => (
                <option key={cashier.id ?? cashier.cashierId} value={cashier.id ?? cashier.cashierId}>{cashier.name}</option>
              ))}
            </select>
            <input aria-label="Cashier PIN" onChange={(event) => setCashierPin(event.target.value)} placeholder="PIN" type="password" value={cashierPin} />
            <button onClick={() => void chooseCashier()} type="button">Switch</button>
            {activeCashier ? <button onClick={signOutCashier} type="button">Sign out cashier</button> : null}
          </div>
        </section>

        <section className="panel">
          <h2>Shift</h2>
          {shiftReport ? (
            <>
              <p>X report: {shiftReport.orderCount} orders · cash {money(shiftReport.tenders.cash)} · UPI {money(shiftReport.tenders.UPI)} · card {money(shiftReport.tenders.card)}</p>
              <div className="inline-fields">
                <input aria-label="Counted cash" onChange={(event) => setCountedCash(event.target.value)} placeholder="Counted cash" value={countedCash} />
                <input aria-label="Close note" onChange={(event) => setCloseNote(event.target.value)} placeholder="Note" value={closeNote} />
                <button onClick={() => void handleCloseShift()} type="button">Close Shift</button>
              </div>
            </>
          ) : (
            <div className="inline-fields">
              <input aria-label="Opening float" onChange={(event) => setOpeningFloat(event.target.value)} value={openingFloat} />
              <button onClick={() => void handleOpenShift()} type="button">Open Shift</button>
            </div>
          )}
          {lastZReport ? (
            <div className="z-report">
              <strong>Z report</strong>
              <span>Business date {lastZReport.businessDate}</span>
              <span>Orders {lastZReport.orderCount}</span>
              <span>Cash {money(lastZReport.tenders.cash)} · UPI {money(lastZReport.tenders.UPI)} · Card {money(lastZReport.tenders.card)}</span>
              <span>Expected {money(lastZReport.shift.expectedCash)} · Counted {money(lastZReport.shift.countedCash)} · Variance {money(lastZReport.shift.variance)}</span>
            </div>
          ) : null}
        </section>

        <section className="panel">
          <h2>Queue</h2>
          <p>{queuedSales.filter((sale) => sale.status === "pending").length} pending · {queuedSales.filter((sale) => sale.status === "failed").length} failed</p>
          {queuedSales.filter((sale) => sale.failedReason === "insufficient_stock").map((sale) => (
            <p className="failure" key={sale.id}>INSUFFICIENT_STOCK on replay: {sale.id}</p>
          ))}
          {queuedSales.filter((sale) => sale.failedReason === "terminal_revoked").map((sale) => (
            <p className="failure" key={sale.id}>terminal_revoked: {sale.id}</p>
          ))}
          <div className="button-row">
            <button onClick={() => void syncQueue()} type="button"><RefreshCcw aria-hidden size={16} /> Sync</button>
            <button onClick={() => void retryTerminalRevoked()} type="button">Retry Revoked</button>
            <button onClick={() => void exportQueue()} type="button"><Download aria-hidden size={16} /> Export JSON</button>
          </div>
        </section>
      </section>

      {receiptOrder ? (
        <section className="receipt-panel" aria-label={duplicateOrder ? "Duplicate receipt" : "Receipt"}>
          <div className="receipt-paper">
            <div className="receipt-center">
              <strong>AxInventory</strong>
              <span>{duplicateOrder ? "DUPLICATE RECEIPT" : "TILL RECEIPT"}</span>
              {receiptMarker ? <span className="receipt-marker">{receiptMarker}</span> : null}
            </div>
            <div className="receipt-meta">
              <span>Invoice</span><strong>{receiptOrder.invoiceNumber ?? "Invoice pending until sync"}</strong>
              <span>Order</span><span>{shortRef(receiptOrder.id)}</span>
              <span>Date</span><span>{formatDateTime(receiptOrder.invoicedAt ?? receiptOrder.createdAt)}</span>
              <span>Cashier</span><span>{receiptCashierName}</span>
              <span>Terminal</span><span>{receiptOrder.terminalName ?? receiptOrder.terminalId ?? "Terminal pending"}</span>
            </div>
            <div className="receipt-lines">
              {receiptOrder.items.map((item) => (
                <div className="receipt-line-item" key={item.id}>
                  <span>{item.name ?? item.sku}</span>
                  <span>{formatQuantityMilli(item.quantityMilli)} x {money(item.unitPrice)}</span>
                  <strong>{money(calculateDiscountedLineTotal(item))}</strong>
                </div>
              ))}
            </div>
            <div className="receipt-totals">
              <span>Subtotal</span><span>{receiptOrder.subtotalAmount === null || receiptOrder.subtotalAmount === undefined ? "Pending" : money(receiptOrder.subtotalAmount)}</span>
              <span>Discount</span><span>{receiptDiscountText}</span>
              <span>Tax</span><span>{receiptOrder.taxAmount === null || receiptOrder.taxAmount === undefined ? "Pending" : money(receiptOrder.taxAmount)}</span>
              <strong>Total</strong><strong>{money(receiptOrder.total)}</strong>
            </div>
            <div className="receipt-tenders">
              {(["cash", "UPI", "card"] as TenderMethod[]).map((method) =>
                receiptTenderTotals[method] > 0 ? (
                  <span key={method}>
                    {tenderLabel(method)} {money(receiptTenderTotals[method])}
                    {method === "card"
                      ? receiptTenders
                        .filter((tender) => tender.method === "card")
                        .map((tender) => ` · last-4 ${tender.cardLast4 ?? "----"} · approval ${tender.cardApprovalCode ?? "pending"}`)
                        .join("")
                      : ""}
                  </span>
                ) : null,
              )}
              {receiptChangeDue > 0 ? <strong>Change due {money(receiptChangeDue)}</strong> : null}
            </div>
          </div>
          <div className="button-row">
            <button onClick={() => window.print()} type="button"><Printer aria-hidden size={16} /> Print</button>
            {receiptEmail ? <button onClick={() => void emailReceipt(receiptOrder.id, receiptEmail)} type="button"><Mail aria-hidden size={16} /> Email</button> : null}
          </div>
        </section>
      ) : null}

      <section className="panel recent">
        <h2>Recent Reprint</h2>
        <div className="recent-list">
          {recentOrders.map((order) => (
            <button key={order.id} onClick={() => setDuplicateOrder(order)} type="button">
              <span>{order.invoiceNumber ?? order.id}</span>
              <strong>DUPLICATE</strong>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
