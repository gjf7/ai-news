import { z } from "zod";

export const HealthStatus = z.object({
  status: z.enum(["ok", "degraded"]),
  database: z.enum(["ok", "error"]),
  uptimeSeconds: z.number().nonnegative(),
});

export type HealthStatus = z.infer<typeof HealthStatus>;
