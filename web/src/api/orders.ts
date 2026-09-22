import { apiGet, apiPatch, apiPost } from "./client";
import type {
  ApiEnvelope,
  Cashier,
  ConfirmOrderBody,
  CreateOrderBody,
  InventoryStock,
  InventoryStockWire,
  Order,
  OrderTransitionResponse,
  OwnerStatus,
  PayOrderBody,
  Product,
  ProductVariant,
  ShiftReport,
} from "./types";

export const listProducts = async () => (await apiGet<ApiEnvelope<Product[]>>("/products?limit=100")).data;

export const listProductVariants = async (productId: string) =>
  (await apiGet<ApiEnvelope<ProductVariant[]>>(`/products/${productId}/variants`)).data;

/**
 * Per-variant stock, converted out of milli-units at the boundary.
 *
 * The one place this conversion happens, so a figure on the counter screen
 * that is wrong by a factor of a thousand has exactly one place to look.
 */
export const getInventory = async (variantId: string): Promise<InventoryStock> => {
  const wire = (await apiGet<ApiEnvelope<InventoryStockWire>>(`/inventory/${variantId}`)).data;
  const toUnits = (milli: string | undefined) => (milli === undefined ? 0 : Number(milli) / 1000);
  return {
    // Taken from the server rather than derived. The server owns the
    // authoritative figure and a till that computed its own could disagree
    // with the invoice it is about to print.
    availableQty: toUnits(wire.availableQtyMilli),
    damagedQty: toUnits(wire.damagedQtyMilli),
    onHandQty: toUnits(wire.onHandQtyMilli),
    reservedQty: toUnits(wire.reservedQtyMilli),
    variantId: wire.variantId,
  };
};

export const listOrders = async () => (await apiGet<ApiEnvelope<Order[]>>("/orders?limit=20")).data;

export const createOrder = (body: CreateOrderBody) => apiPost<OrderTransitionResponse>("/orders", body);

export const confirmOrder = (id: string, body: ConfirmOrderBody) =>
  apiPatch<OrderTransitionResponse>(`/orders/${id}/confirm`, body);

export const payOrder = (id: string, body: PayOrderBody) =>
  apiPatch<OrderTransitionResponse>(`/orders/${id}/pay`, body);

export const emailReceipt = (id: string, email: string) =>
  apiPost<ApiEnvelope<{ messageId: string | null }>>(`/orders/${id}/email-receipt`, { email });

export const listCashiers = async () => (await apiGet<ApiEnvelope<Cashier[]>>("/cashiers")).data;

export const verifyCashierPin = async (cashierId: string, pin: string) =>
  (await apiPost<ApiEnvelope<{ cashierId: string; name: string }>>("/cashiers/verify-pin", {
    cashierId,
    pin,
  })).data;

export const getCurrentShift = async () => (await apiGet<ApiEnvelope<ShiftReport | null>>("/shifts/current")).data;

export const openShift = async (body: { cashierId?: string; openingFloat: string }) =>
  (await apiPost<ApiEnvelope<ShiftReport["shift"]>>("/shifts/open", body)).data;

export const closeShift = async (body: { cashierId?: string; countedCash: string; note?: string }) =>
  (await apiPost<ApiEnvelope<ShiftReport>>("/shifts/close", body)).data;

export const getShiftReport = async (id: string) =>
  (await apiGet<ApiEnvelope<ShiftReport>>(`/shifts/${id}/report`)).data;

export const getOwnerStatus = async () =>
  (await apiGet<ApiEnvelope<OwnerStatus>>("/owner/status")).data;

export const verifyOwner = async (password: string) =>
  (await apiPost<ApiEnvelope<OwnerStatus>>("/owner/verify", { password })).data;

export const endOwnerOverride = async () =>
  (await apiPost<ApiEnvelope<OwnerStatus>>("/owner/end", {})).data;
