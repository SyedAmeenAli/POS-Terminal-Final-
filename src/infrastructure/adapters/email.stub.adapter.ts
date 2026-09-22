import type { EmailPort, ReceiptEmailData } from "../../application/ports/email.port.js";

const disabledPayload = {
  errorType: "INTEGRATION_DISABLED" as const,
  message: "Receipt email is not available right now.",
  success: false as const,
};

export class EmailStubAdapter implements EmailPort {
  async sendReceipt(_data: ReceiptEmailData) {
    return disabledPayload;
  }
}
