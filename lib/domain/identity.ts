import { z } from "zod";

// PayPal's documented boolean and observed sandbox string are both explicit
// affirmative claims. Never coerce truthiness: "false" must remain rejected.
export const verifiedPayPalProfileSchema = z.object({
  payer_id: z.string().regex(/^[A-Z0-9]{6,64}$/),
  verified_account: z.union([z.literal(true), z.literal("true")]).transform(() => true as const),
  email: z.string().email().optional(),
});
