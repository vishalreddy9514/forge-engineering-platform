// NFR-1: the CRUD endpoints at a steady 50 requests per second against the 100k-issue project,
// p95 under 250 ms. A constant arrival rate, so a slow server cannot lower the load it receives.
import http from 'k6/http';
import { Counter } from 'k6/metrics';

import { API, ok, params, project, signIn } from './lib.js';

const RATE = Number(__ENV.RATE || 50);
const conflicts = new Counter('edit_conflicts');

// The mix a team's day produces: mostly reading, some writing.
const MIX = [
  ['list issues', 30],
  ['get issue', 25],
  ['list comments', 10],
  ['update issue', 15],
  ['add comment', 10],
  ['create issue', 10],
];

export const options = {
  scenarios: {
    crud: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: __ENV.DURATION || '2m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
  },
  thresholds: {
    'http_req_duration{kind:crud}': ['p(95)<250'],
    ...Object.fromEntries(MIX.map(([name]) => [`http_req_duration{op:${name}}`, ['p(95)<250']])),
    'http_req_failed{kind:crud}': ['rate<0.01'],
    dropped_iterations: ['count<10'],
  },
  // A 409 is the API refusing a stale edit (optimistic locking), not an error.
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 409));

export function setup() {
  const token = signIn();
  const { id: projectId } = project(token);
  // A pool of issues to read and edit, from across the project.
  const ids = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const url = `${API}/projects/${projectId}/issues?limit=100${cursor ? `&cursor=${cursor}` : ''}`;
    const res = http.get(url, params(token, 'setup'));
    for (const issue of res.json('data')) ids.push(issue.id);
    cursor = res.json('nextCursor');
    if (!cursor) break;
  }
  // Warm-up, not measured (tagged `setup`): steady state is what the thresholds are about.
  for (let i = 0; i < 30; i += 1) {
    http.get(`${API}/issues/${ids[i % ids.length]}`, params(token, 'setup'));
    http.get(`${API}/issues/${ids[i % ids.length]}/comments`, params(token, 'setup'));
  }
  return { token, projectId, ids };
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function operation() {
  let roll = Math.random() * 100;
  for (const [name, weight] of MIX) {
    roll -= weight;
    if (roll < 0) return name;
  }
  return MIX[0][0];
}

export default function ({ token, projectId, ids }) {
  const op = operation();
  const p = (name) => params(token, name, { kind: 'crud', op });
  const id = pick(ids);
  switch (op) {
    case 'list issues':
      ok(http.get(`${API}/projects/${projectId}/issues?limit=50`, p('GET /projects/:id/issues')));
      break;
    case 'get issue':
      ok(http.get(`${API}/issues/${id}`, p('GET /issues/:id')));
      break;
    case 'list comments':
      ok(http.get(`${API}/issues/${id}/comments`, p('GET /issues/:id/comments')));
      break;
    case 'update issue': {
      const current = http.get(`${API}/issues/${id}`, p('GET /issues/:id'));
      if (!ok(current)) break;
      const res = http.patch(
        `${API}/issues/${id}`,
        JSON.stringify({
          version: current.json('version'),
          priority: pick(['LOW', 'MEDIUM', 'HIGH']),
        }),
        p('PATCH /issues/:id'),
      );
      if (res.status === 409) conflicts.add(1);
      else ok(res);
      break;
    }
    case 'add comment':
      ok(
        http.post(
          `${API}/issues/${id}/comments`,
          JSON.stringify({ body: 'Load test: reproduced on staging.' }),
          p('POST /issues/:id/comments'),
        ),
        201,
      );
      break;
    case 'create issue':
      ok(
        http.post(
          `${API}/projects/${projectId}/issues`,
          JSON.stringify({ title: `Load test issue ${__VU}-${__ITER}`, priority: 'LOW' }),
          p('POST /projects/:id/issues'),
        ),
        201,
      );
      break;
  }
}
