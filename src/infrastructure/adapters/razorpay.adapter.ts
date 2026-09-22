import { fetchJson, IntegrationHttpError } from "./integration-http.js";
import type { IntegrationResult, StandardizedIntegrationError } from "../../application/ports/errors.js";
import type {
  PaymentPort,
  PaymentQrData,
  PaymentStatusData,
  PaymentVoidData,
} from "../../application/ports/payment.port.js";
import type { SecretsPort } from "../../application/ports/secrets.port.js";

type RazorpayAdapterConfig = {
  baseUrl: string;
  liveEnabled: boolean;
  timeoutMs: number;
};

const toPaymentError = (
  error: unknown,
  fallbackMessage: string,
): StandardizedIntegrationError => {
  if (error instanceof IntegrationHttpError) {
    if (error.statusCode === 401 || error.statusCode === 403) {
      return {
        success: false,
        errorType: "AUTHENTICATION_FAILURE",
        message: "Razorpay authentication failed.",
        payloadFallback: error.payload ?? undefined,
      };
    }

    return {
      success: false,
      errorType: "PAYMENT_GATEWAY_UNAVAILABLE",
      message: fallbackMessage,
      payloadFallback: error.payload ?? undefined,
    };
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return {
      success: false,
      errorType: "NETWORK_TIMEOUT",
      message: "Razorpay request timed out.",
    };
  }

  return {
    success: false,
    errorType: "PAYMENT_GATEWAY_UNAVAILABLE",
    message: fallbackMessage,
  };
};

export class RazorpayAdapter implements PaymentPort {
  #config: RazorpayAdapterConfig;
  #secrets: SecretsPort;

  constructor(secrets: SecretsPort, config: RazorpayAdapterConfig) {
    this.#config = config;
    this.#secrets = secrets;
  }

  async #getAuthHeader(): Promise<string> {
    const keyId = await this.#secrets.getSecret("RAZORPAY_KEY_ID");
    const keySecret = await this.#secrets.getSecret("RAZORPAY_KEY_SECRET");
    return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  }

  async #request(
    path: string,
    init: RequestInit,
    fallbackMessage: string,
  ): Promise<IntegrationResult<Record<string, unknown>>> {
    if (!this.#config.liveEnabled) {
      return {
        success: false,
        errorType: "INTEGRATION_DISABLED",
        message: "Razorpay is not available right now.",
      };
    }

    try {
      const authHeader = await this.#getAuthHeader();
      const body = await fetchJson(
        `${this.#config.baseUrl}${path}`,
        {
          ...init,
          headers: {
            authorization: authHeader,
            "content-type": "application/json",
            ...(init.headers ?? {}),
          },
        },
        this.#config.timeoutMs,
      );

      return {
        success: true,
        data: body ?? {},
      };
    } catch (error) {
      return toPaymentError(error, fallbackMessage);
    }
  }

  async generateQr(orderId: string, amount: number): Promise<IntegrationResult<PaymentQrData>> {
    const result = await this.#request(
      "/v1/payments/qr_codes",
      {
        method: "POST",
        body: JSON.stringify({
          description: `IMS order ${orderId}`,
          fixed_amount: true,
          name: `order-${orderId}`,
          payment_amount: Math.round(amount * 100),
          type: "upi_qr",
          usage: "single_use",
        }),
      },
      "Razorpay QR generation failed.",
    );

    if (result.success === false) {
      return result;
    }

    return {
      success: true,
      data: {
        paymentId: typeof result.data.id === "string" ? result.data.id : orderId,
        qrCodeUrl:
          typeof result.data.image_url === "string"
            ? result.data.image_url
            : typeof result.data.short_url === "string"
              ? result.data.short_url
              : null,
        raw: result.data,
      },
    };
  }

  async checkStatus(paymentId: string): Promise<IntegrationResult<PaymentStatusData>> {
    const result = await this.#request(
      `/v1/payments/${paymentId}`,
      {
        method: "GET",
      },
      "Razorpay payment status lookup failed.",
    );

    if (result.success === false) {
      return result;
    }

    return {
      success: true,
      data: {
        paymentId,
        raw: result.data,
        status: typeof result.data.status === "string" ? result.data.status : "unknown",
      },
    };
  }

  async voidQr(paymentId: string): Promise<IntegrationResult<PaymentVoidData>> {
    const result = await this.#request(
      `/v1/payments/qr_codes/${paymentId}/close`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
      "Razorpay QR void failed.",
    );

    if (result.success === false) {
      return result;
    }

    return {
      success: true,
      data: {
        paymentId,
        raw: result.data,
        voided: true,
      },
    };
  }
}
