import { z } from 'zod';

/** RFC 9457 problem details, the body of every error response from the API. */
export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const PROBLEM_JSON_CONTENT_TYPE = 'application/problem+json';
