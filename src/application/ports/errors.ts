export interface StandardizedIntegrationError {
  success: false;
  errorType:
    | "INTEGRATION_DISABLED"
    | "NETWORK_TIMEOUT"
    | "AUTHENTICATION_FAILURE"
    | "PAYMENT_GATEWAY_UNAVAILABLE"
    | "LOGISTICS_TIMEOUT"
    | "EMAIL_DELIVERY_FAILED"
    | "VISION_UNAVAILABLE"
    | "VISION_PARSE_FAILURE";
  message: string;
  payloadFallback?: Record<string, unknown>;
}

export type IntegrationSuccess<T> = {
  success: true;
  data: T;
};

export type IntegrationResult<T> = IntegrationSuccess<T> | StandardizedIntegrationError;

export const isStandardizedIntegrationError = (
  value: IntegrationResult<unknown>,
): value is StandardizedIntegrationError => value.success === false;
