import { z } from "zod";

export const verifyCashierPinBodySchema = z.object({
  cashierId: z.uuid("Invalid UUID"),
  pin: z.string().trim().min(1).max(32),
});
