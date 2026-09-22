import { fetchJson, IntegrationHttpError } from "./integration-http.js";
import type { EmailPort, ReceiptEmailData } from "../../application/ports/email.port.js";
import type { IntegrationResult, StandardizedIntegrationError } from "../../application/ports/errors.js";
import type { SecretsPort } from "../../application/ports/secrets.port.js";

type EmailAdapterConfig = {
  baseUrl: string;
  fromAddress: string;
  liveEnabled: boolean;
  timeoutMs: number;
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const buildTextReceipt = (data: ReceiptEmailData): string => {
  const lines = data.items.map(
    (item) => `${item.quantity} x ${item.name} (${item.sku}) @ INR ${item.unitPrice}`,
  );

  return [
    "Receipt",
    `Order: ${data.orderId}`,
    `Paid at: ${data.paidAt}`,
    "",
    ...lines,
    "",
    `Subtotal: INR ${data.subtotal}`,
    `Tax (${data.taxRatePercent}%): INR ${data.taxAmount}`,
    `Total: INR ${data.total}`,
  ].join("\n");
};

const buildHtmlReceipt = (data: ReceiptEmailData): string => `
  <h1>Receipt</h1>
  <p><strong>Order:</strong> ${escapeHtml(data.orderId)}</p>
  <p><strong>Paid at:</strong> ${escapeHtml(data.paidAt)}</p>
  <table cellpadding="6" cellspacing="0" border="1">
    <thead>
      <tr><th align="left">Item</th><th align="right">Qty</th><th align="right">Unit price</th></tr>
    </thead>
    <tbody>
      ${data.items
        .map(
          (item) => `
            <tr>
              <td>${escapeHtml(item.name)}<br><small>${escapeHtml(item.sku)}</small></td>
              <td align="right">${item.quantity}</td>
              <td align="right">INR ${escapeHtml(item.unitPrice)}</td>
            </tr>
          `,
        )
        .join("")}
    </tbody>
  </table>
  <p><strong>Subtotal:</strong> INR ${escapeHtml(data.subtotal)}</p>
  <p><strong>Tax (${escapeHtml(data.taxRatePercent)}%):</strong> INR ${escapeHtml(data.taxAmount)}</p>
  <p><strong>Total:</strong> INR ${escapeHtml(data.total)}</p>
`;

const toEmailError = (
  error: unknown,
  fallbackMessage: string,
): StandardizedIntegrationError => {
  if (error instanceof IntegrationHttpError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return {
        success: false,
        errorType: "AUTHENTICATION_FAILURE",
        message: "Email provider authentication failed.",
        payloadFallback: error.payload ?? undefined,
      };
    }

    return {
      success: false,
      errorType: "EMAIL_DELIVERY_FAILED",
      message: fallbackMessage,
      payloadFallback: error.payload ?? undefined,
    };
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      success: false,
      errorType: "NETWORK_TIMEOUT",
      message: "Email provider request timed out.",
    };
  }

  return {
    success: false,
    errorType: "EMAIL_DELIVERY_FAILED",
    message: fallbackMessage,
  };
};

export class EmailAdapter implements EmailPort {
  #config: EmailAdapterConfig;
  #secrets: SecretsPort;

  constructor(secrets: SecretsPort, config: EmailAdapterConfig) {
    this.#config = config;
    this.#secrets = secrets;
  }

  async sendReceipt(
    data: ReceiptEmailData,
  ): Promise<IntegrationResult<{ messageId: string | null }>> {
    if (!this.#config.liveEnabled) {
      return {
        success: false,
        errorType: "INTEGRATION_DISABLED",
        message: "Receipt email is not available right now.",
      };
    }

    try {
      const apiKey = await this.#secrets.getSecret("EMAIL_API_KEY");
      const response = await fetchJson(
        `${this.#config.baseUrl}/emails`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: this.#config.fromAddress,
            html: buildHtmlReceipt(data),
            subject: `Receipt for order ${data.orderId}`,
            text: buildTextReceipt(data),
            to: [data.to],
          }),
        },
        this.#config.timeoutMs,
      );

      return {
        success: true,
        data: {
          messageId: typeof response?.id === "string" ? response.id : null,
        },
      };
    } catch (error) {
      return toEmailError(error, "Email provider request failed.");
    }
  }
}
