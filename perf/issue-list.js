// NFR-3: the issue list stays under 150 ms at p95 in a project with 100k issues, for every way
// the app asks for it (sorts, filters, search, the next page).
import http from 'k6/http';

import { API, ok, params, project, signIn } from './lib.js';

const VARIANTS = [
  'recently updated',
  'by priority',
  'newest first',
  'status filter',
  'assignee filter',
  'label filter',
  'active sprint',
  'keyword search',
  'next page',
];

export const options = {
  scenarios: {
    list: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.RATE || 20),
      timeUnit: '1s',
      duration: __ENV.DURATION || '1m',
      preAllocatedVUs: 20,
      maxVUs: 100,
    },
  },
  thresholds: {
    'http_req_duration{kind:list}': ['p(95)<150'],
    ...Object.fromEntries(VARIANTS.map((v) => [`http_req_duration{variant:${v}}`, ['p(95)<150']])),
    'http_req_failed{kind:list}': ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const token = signIn();
  const { id: projectId } = project(token);
  const labels = http.get(`${API}/projects/${projectId}/labels`, params(token, 'setup')).json();
  const members = http
    .get(`${API}/projects/${projectId}/members`, params(token, 'setup'))
    .json()
    .filter((m) => m.role !== 'PROJECT_MANAGER');
  const first = http.get(`${API}/projects/${projectId}/issues?limit=50`, params(token, 'setup'));
  const data = {
    token,
    projectId,
    labelId: labels[0].id,
    assigneeId: (members[0].user || members[0]).id,
    cursor: first.json('nextCursor'),
  };
  // Warm-up, not measured (tagged `setup`): steady state is what the thresholds are about.
  for (let round = 0; round < 3; round += 1) {
    for (const variant of VARIANTS) {
      http.get(
        `${API}/projects/${projectId}/issues?limit=50${queryFor(variant, data)}`,
        params(token, 'setup'),
      );
    }
  }
  return data;
}

export default function (data) {
  const variant = VARIANTS[(__ITER + __VU) % VARIANTS.length];
  ok(
    http.get(
      `${API}/projects/${data.projectId}/issues?limit=50${queryFor(variant, data)}`,
      params(data.token, 'GET /projects/:id/issues', { kind: 'list', variant }),
    ),
  );
}

function queryFor(variant, data) {
  return {
    'recently updated': '',
    'by priority': '&sort=priority',
    'newest first': '&sort=created',
    'status filter': '&status=TODO,IN_PROGRESS',
    'assignee filter': `&assignee=${data.assigneeId}`,
    'label filter': `&label=${data.labelId}`,
    'active sprint': '&sprint=active',
    'keyword search': '&q=checkout',
    'next page': `&cursor=${data.cursor}`,
  }[variant];
}
