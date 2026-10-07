import { z } from "zod";

export const LoginRequest = z.object({
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof LoginRequest>;

export const SessionState = z.object({
  authenticated: z.boolean(),
});

export type SessionState = z.infer<typeof SessionState>;
