import type { IntegrationResult } from "./errors.js";

export type PaymentQrPayload = {
  amount: number;
  orderId: string;
};

export type PaymentQrData = {
  paymentId: string;
  qrCodeUrl: string | null;
  raw: Record<string, unknown>;
};

export type PaymentStatusData = {
  paymentId: string;
  raw: Record<string, unknown>;
  status: string;
};

export type PaymentVoidData = {
  paymentId: string;
  raw: Record<string, unknown>;
  voided: boolean;
};

export interface PaymentPort {
  generateQr(orderId: string, amount: number): Promise<IntegrationResult<PaymentQrData>>;
  checkStatus(paymentId: string): Promise<IntegrationResult<PaymentStatusData>>;
  voidQr(paymentId: string): Promise<IntegrationResult<PaymentVoidData>>;
}
