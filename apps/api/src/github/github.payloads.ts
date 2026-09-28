import { z } from 'zod';

/**
 * The parts of GitHub's REST and webhook payloads Forge reads. Everything from GitHub is
 * external input: it is parsed with these schemas before use, and unknown fields are ignored.
 * Where the REST list and the webhook shapes differ (commits), there is one schema for each.
 */

const Timestamp = z.iso.datetime({ offset: true });
const Account = z.object({ login: z.string(), type: z.string().optional() }).nullable();

export const Repository = z.object({
  id: z.number().int(),
  full_name: z.string().max(200),
  private: z.boolean(),
  html_url: z.url(),
  default_branch: z.string().max(255).optional(),
});
export type Repository = z.infer<typeof Repository>;

export const Installation = z.object({
  id: z.number().int(),
  account: z.object({ login: z.string(), type: z.string() }),
  suspended_at: Timestamp.nullable().optional(),
});
export type Installation = z.infer<typeof Installation>;

export const InstallationRepositories = z.object({
  total_count: z.number().int(),
  repositories: z.array(Repository),
});

export const PullRequest = z.object({
  id: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().optional(),
  merged_at: Timestamp.nullable(),
  closed_at: Timestamp.nullable(),
  created_at: Timestamp,
  updated_at: Timestamp,
  user: Account,
  html_url: z.url(),
  head: z.object({ ref: z.string(), sha: z.string().length(40) }),
  base: z.object({ ref: z.string() }),
  // Only on single-PR responses and webhook payloads, not in list responses.
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  changed_files: z.number().int().optional(),
});
export type PullRequest = z.infer<typeof PullRequest>;

/** GET /repos/{owner}/{repo}/commits items. */
export const Commit = z.object({
  sha: z.string().length(40),
  html_url: z.url(),
  commit: z.object({
    message: z.string(),
    author: z.object({ name: z.string().optional(), date: Timestamp }).nullable(),
  }),
  author: Account,
});
export type Commit = z.infer<typeof Commit>;

/** `push` webhook commits: a different shape from the REST list. */
export const PushCommit = z.object({
  id: z.string().length(40),
  message: z.string(),
  timestamp: Timestamp,
  url: z.url(),
  author: z.object({ name: z.string().optional(), username: z.string().optional() }),
});
export type PushCommit = z.infer<typeof PushCommit>;

/** GET /repos/{owner}/{repo}/issues items. Pull requests appear here too, with `pull_request`. */
export const Issue = z.object({
  id: z.number().int(),
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  user: Account,
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  comments: z.number().int(),
  html_url: z.url(),
  created_at: Timestamp,
  updated_at: Timestamp,
  closed_at: Timestamp.nullable(),
  pull_request: z.unknown().optional(),
});
export type Issue = z.infer<typeof Issue>;

export const Contributor = z.object({
  login: z.string().max(100),
  avatar_url: z.url().nullable().optional(),
  contributions: z.number().int(),
});
export type Contributor = z.infer<typeof Contributor>;

// ───────────── Webhook events (only the fields handlers read) ─────────────

const WebhookRepository = z.object({ id: z.number().int(), full_name: z.string() });

export const InstallationEvent = z.object({
  action: z.string(),
  installation: Installation,
});

export const PullRequestEvent = z.object({
  action: z.string(),
  pull_request: PullRequest,
  repository: WebhookRepository,
});

export const PushEvent = z.object({
  ref: z.string(),
  deleted: z.boolean().optional(),
  commits: z.array(PushCommit),
  repository: WebhookRepository,
});

export const IssuesEvent = z.object({
  action: z.string(),
  issue: Issue,
  repository: WebhookRepository,
});

/** A list response parsed item by item: one malformed item is skipped, not the whole page. */
export function parseItems<T>(
  schema: z.ZodType<T>,
  items: unknown[],
): { valid: T[]; invalid: number } {
  const valid: T[] = [];
  let invalid = 0;
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
    else invalid++;
  }
  return { valid, invalid };
}
