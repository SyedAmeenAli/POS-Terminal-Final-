import type { PaymentPort } from "../../application/ports/payment.port.js";

const disabledPayload = {
  errorType: "INTEGRATION_DISABLED" as const,
  message: "Razorpay is not available right now.",
  success: false as const,
};

export class RazorpayStubAdapter implements PaymentPort {
  async generateQr() {
    return disabledPayload;
  }

  async checkStatus() {
    return disabledPayload;
  }

  async voidQr() {
    return disabledPayload;
  }
}
