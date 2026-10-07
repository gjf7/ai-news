import { z } from "zod";

export const PublicError = z.object({
  code: z.string(),
  message: z.string(),
});

export type PublicError = z.infer<typeof PublicError>;

/** Every non-2xx JSON response uses this envelope. */
export const ErrorEnvelope = z.object({
  error: PublicError.extend({ requestId: z.string() }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
