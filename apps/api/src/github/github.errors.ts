/** GitHub refused the call for rate-limit reasons, or Forge held it back to protect the quota. */
export class GithubRateLimitError extends Error {
  constructor(readonly resetAt: Date) {
    super(`GitHub rate limit reached; retry after ${resetAt.toISOString()}`);
    this.name = 'GithubRateLimitError';
  }
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}
