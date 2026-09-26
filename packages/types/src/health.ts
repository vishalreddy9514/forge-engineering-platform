import { z } from 'zod';

export const HealthStatus = z.enum(['ok', 'error']);

/** Response of GET /health/ready: overall status plus one entry per dependency. */
export const ReadinessResponse = z.object({
  status: HealthStatus,
  checks: z.record(
    z.string(),
    z.object({
      status: HealthStatus,
      message: z.string().optional(),
    }),
  ),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;
