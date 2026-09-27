import { createVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

const FIXTURES = join(__dirname, '../../fixtures/github');

type Json = Record<string, unknown>;

export interface FakeRepo {
  repository: Json;
  pulls: Json[];
  commits: Json[];
  issues: Json[];
  contributors: Json[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
}

let nextOffset = 1;

/**
 * The recorded fixtures (test/fixtures/github, see record.sh) as a fresh repository. GitHub IDs
 * are unique across the database, so each copy shifts every numeric ID and renames the
 * repository; everything else is exactly what GitHub returned.
 */
export function recordedRepo(name: string): FakeRepo {
  const offset = nextOffset++ * 1_000_000_000_000;
  const load = (file: string) => JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as unknown;
  const repository = load('repository.json') as Json;
  const fullName = `forge-fixtures/${name}`;
  const shift = (item: Json) => ({ ...item, id: (item.id as number) + offset });
  return {
    repository: {
      ...shift(repository),
      name,
      full_name: fullName,
      html_url: `https://github.com/${fullName}`,
    },
    pulls: (load('pulls.json') as Json[]).map(shift),
    commits: load('commits.json') as Json[],
    issues: (load('issues.json') as Json[]).map(shift),
    contributors: load('contributors.json') as Json[],
  };
}

interface FakeInstallation {
  id: number;
  account: { login: string; type: 'Organization' | 'User' };
  suspended_at: string | null;
  repos: string[];
}

type Override = (req: RecordedRequest) => { status: number; body: unknown; headers?: Json } | null;

/**
 * A stand-in for api.github.com that serves recorded responses. It checks what the real API
 * checks for the calls Forge makes: the App JWT (RS256 signature, issuer, expiry) on /app
 * routes, and an installation token scoped to that installation's repositories elsewhere. It
 * paginates with Link headers, filters by `since`, and reports rate-limit headers.
 */
export class FakeGithub {
  readonly requests: RecordedRequest[] = [];
  readonly installations = new Map<number, FakeInstallation>();
  readonly repos = new Map<string, FakeRepo>();
  /** GitHub's page size cap, lowered to exercise pagination with small fixtures. */
  pageSize = 100;
  /** Rate-limit headers per installation: remaining quota counts down on every call. */
  readonly quota = new Map<number, { remaining: number; reset: number }>();
  private overrides: Override[] = [];
  private server: Server | undefined;

  constructor(
    private readonly appId: number,
    private readonly publicKey: string,
  ) {}

  async listen(url: string): Promise<void> {
    const { port, hostname } = new URL(url);
    this.server = createServer((req, res) => {
      this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(Number(port), hostname, resolve));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }

  reset(): void {
    this.requests.length = 0;
    this.overrides = [];
    this.pageSize = 100;
    this.quota.clear();
  }

  addInstallation(id: number, login: string, repos: FakeRepo[] = []): void {
    for (const repo of repos) this.repos.set(repo.repository.full_name as string, repo);
    this.installations.set(id, {
      id,
      account: { login, type: 'Organization' },
      suspended_at: null,
      repos: repos.map((r) => r.repository.full_name as string),
    });
  }

  /** Answers matching requests differently (until removed); return null to pass through. */
  override(fn: Override): () => void {
    this.overrides.push(fn);
    return () => {
      this.overrides = this.overrides.filter((o) => o !== fn);
    };
  }

  requestsTo(pathPrefix: string): RecordedRequest[] {
    return this.requests.filter((r) => r.path.startsWith(pathPrefix));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    const request: RecordedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      auth: req.headers.authorization,
    };
    this.requests.push(request);

    const send = (status: number, body: unknown, headers: Json = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    for (const override of this.overrides) {
      const answer = override(request);
      if (answer) {
        send(answer.status, answer.body, answer.headers);
        return;
      }
    }
    try {
      const [status, body, headers] = this.route(request, url);
      send(status, body, headers);
    } catch (error) {
      send(500, { message: String(error) });
    }
  }

  private route(req: RecordedRequest, url: URL): [number, unknown, Json?] {
    const app = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(req.path);
    if (app) {
      if (!this.validAppJwt(req.auth))
        return [401, { message: 'A JSON web token could not be decoded' }];
      const installation = this.installations.get(Number(app[1]));
      if (!installation) return [404, { message: 'Not Found' }];
      if (app[2] && req.method === 'POST') {
        return [
          201,
          {
            token: `ghs_fake_${String(installation.id)}`,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        ];
      }
      const { repos: _, ...body } = installation;
      return [200, body];
    }

    const installation = this.installationFor(req.auth);
    if (!installation) return [401, { message: 'Bad credentials' }];
    const headers = this.spend(installation.id);

    if (req.path === '/installation/repositories') {
      const all = installation.repos.map((name) => this.repos.get(name)?.repository);
      const { items, link } = this.page(all, url);
      return [200, { total_count: all.length, repositories: items }, { ...headers, ...link }];
    }

    const repoMatch = /^\/repos\/([^/]+\/[^/]+)(\/[a-z]+)?$/.exec(req.path);
    const repo =
      repoMatch && installation.repos.includes(repoMatch[1] ?? '')
        ? this.repos.get(repoMatch[1] ?? '')
        : undefined;
    if (!repoMatch || !repo) return [404, { message: 'Not Found' }, headers];

    const since = url.searchParams.get('since');
    const after = (field: (item: Json) => unknown) => (item: Json) =>
      !since || String(field(item)) >= since;
    let list: unknown[];
    switch (repoMatch[2]) {
      case undefined:
        return [200, repo.repository, headers];
      case '/pulls':
        list = repo.pulls;
        break;
      case '/commits':
        list = repo.commits.filter(
          after((c) => (c.commit as { author: { date: string } }).author.date),
        );
        break;
      case '/issues':
        list = repo.issues.filter(after((i) => i.updated_at));
        break;
      case '/contributors':
        list = repo.contributors;
        break;
      default:
        return [404, { message: 'Not Found' }, headers];
    }
    const { items, link } = this.page(list, url);
    return [200, items, { ...headers, ...link }];
  }

  private page(items: unknown[], url: URL): { items: unknown[]; link: Json } {
    const size = Math.min(Number(url.searchParams.get('per_page') ?? 30), this.pageSize);
    const page = Number(url.searchParams.get('page') ?? 1);
    const slice = items.slice((page - 1) * size, page * size);
    if (page * size >= items.length) return { items: slice, link: {} };
    const next = new URL(url.toString().replace('http://fake', `http://${this.host()}`));
    next.searchParams.set('page', String(page + 1));
    return { items: slice, link: { link: `<${next.toString()}>; rel="next"` } };
  }

  private host(): string {
    const address = this.server?.address();
    return typeof address === 'object' && address ? `127.0.0.1:${String(address.port)}` : '';
  }

  private spend(installationId: number): Json {
    const quota = this.quota.get(installationId) ?? {
      remaining: 5000,
      reset: Math.floor(Date.now() / 1000) + 3600,
    };
    quota.remaining = Math.max(0, quota.remaining - 1);
    this.quota.set(installationId, quota);
    return {
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(quota.remaining),
      'x-ratelimit-reset': String(quota.reset),
    };
  }

  private installationFor(auth: string | undefined): FakeInstallation | undefined {
    const id = /^Bearer ghs_fake_(\d+)$/.exec(auth ?? '')?.[1];
    return id ? this.installations.get(Number(id)) : undefined;
  }

  private validAppJwt(auth: string | undefined): boolean {
    const [header, payload, signature] = (auth ?? '').replace(/^Bearer /, '').split('.');
    if (!header || !payload || !signature) return false;
    const verify = createVerify('RSA-SHA256');
    verify.update(`${header}.${payload}`);
    if (!verify.verify(this.publicKey, Buffer.from(signature, 'base64url'))) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      iss?: string;
      exp?: number;
      iat?: number;
    };
    const now = Date.now() / 1000;
    return (
      claims.iss === String(this.appId) &&
      (claims.exp ?? 0) > now &&
      (claims.iat ?? Infinity) <= now &&
      (claims.exp ?? 0) - (claims.iat ?? 0) <= 600
    );
  }
}
