// Shared helpers for the k6 load tests (docs/performance.md).
import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8080';
export const API = `${BASE_URL}/api/v1`;

/** Signs in as the performance dataset's manager (prisma/perf-seed.ts). */
export function signIn() {
  const res = http.post(
    `${API}/auth/login`,
    JSON.stringify({
      email: __ENV.PERF_EMAIL || 'perf-manager@example.test',
      password: __ENV.PERF_PASSWORD || 'forge-perf-password',
    }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'setup' } },
  );
  if (res.status !== 200) fail(`sign-in failed: ${res.status} ${res.body}`);
  return res.json('accessToken');
}

export function params(token, name, extra = {}) {
  return {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    tags: { name, ...extra },
  };
}

export function project(token, key = __ENV.PERF_PROJECT || 'PERF') {
  const res = http.get(`${API}/projects/by-key/${key}`, params(token, 'setup'));
  if (res.status !== 200) fail(`project ${key} not found: run \`pnpm stack:perf-seed\` first`);
  return res.json();
}

export function ok(res, status = 200) {
  return check(res, { [`status ${status}`]: (r) => r.status === status });
}
