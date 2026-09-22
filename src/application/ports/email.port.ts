import type { IntegrationResult } from "./errors.js";

export type ReceiptEmailData = {
  to: string;
  orderId: string;
  items: Array<{ name: string; sku: string; quantity: number; unitPrice: string }>;
  subtotal: string;
  taxAmount: string;
  taxRatePercent: string;
  total: string;
  paidAt: string;
};

export interface EmailPort {
  sendReceipt(data: ReceiptEmailData): Promise<IntegrationResult<{ messageId: string | null }>>;
}
