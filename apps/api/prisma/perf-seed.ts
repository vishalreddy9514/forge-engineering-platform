/**
 * The performance dataset (Phase 19, docs/performance.md): one project, PERF, with 100,000 issues
 * and the rows around them (members, labels, comments, sprints), for the load tests in perf/.
 *
 * Rows are generated inside PostgreSQL with generate_series, so 100k issues take seconds rather
 * than the hours one API call per issue would. The values are spread the way a busy project's
 * are (statuses, priorities, assignees, labels, two years of history), and titles combine words
 * from small lists so keyword search has realistic hit rates.
 *
 * Run in the migrate image: `pnpm stack:perf-seed`. It refuses production and does nothing if
 * PERF already exists. IDs are random UUIDs (v4), not the API's time-ordered v7: only the list
 * order's tie-breaker reads them.
 */
import { Client } from 'pg';

import { hashPassword } from '../src/common/security/password-hasher';

export const PERF_PROJECT_KEY = 'PERF';
export const PERF_MANAGER_EMAIL = 'perf-manager@example.test';
const DEVELOPERS = 20;

export async function seedPerformanceData(
  db: Client,
  { issues, password }: { issues: number; password: string },
): Promise<boolean> {
  const exists = await db.query(`SELECT 1 FROM projects WHERE key = $1`, [PERF_PROJECT_KEY]);
  if (exists.rowCount) return false;

  const passwordHash = await hashPassword(password);
  await db.query('BEGIN');
  try {
    // People: the manager the load tests sign in as, and the developers issues are assigned to.
    await db.query(
      `INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at)
       SELECT gen_random_uuid(),
              CASE WHEN n = 0 THEN $1 ELSE format('perf-dev-%s@example.test', n) END,
              CASE WHEN n = 0 THEN 'Perf Manager' ELSE format('Perf Developer %s', n) END,
              $2, now() - interval '2 years', now()
       FROM generate_series(0, $3) AS n`,
      [PERF_MANAGER_EMAIL, passwordHash, DEVELOPERS],
    );
    const { rows: projectRows } = await db.query<{ id: string }>(
      `INSERT INTO projects (id, key, name, description, issue_seq, created_by_id, created_at, updated_at)
       SELECT gen_random_uuid(), $1, 'Performance', 'Load-test dataset (prisma/perf-seed.ts).', $2,
              id, now() - interval '2 years', now()
       FROM users WHERE email = $3
       RETURNING id`,
      [PERF_PROJECT_KEY, issues, PERF_MANAGER_EMAIL],
    );
    const projectId = projectRows[0]?.id;
    await db.query(
      `INSERT INTO project_members (project_id, user_id, role_id)
       SELECT $1, id, CASE WHEN email = $2 THEN 1 ELSE 2 END
       FROM users WHERE email = $2 OR email LIKE 'perf-dev-%@example.test'`,
      [projectId, PERF_MANAGER_EMAIL],
    );
    await db.query(
      `INSERT INTO labels (id, project_id, name, color)
       SELECT gen_random_uuid(), $1, name, '#1d76db'
       FROM unnest(ARRAY['bug','payments','auth','ui','api','performance','security','docs']) AS name`,
      [projectId],
    );

    // The issues. Distributions: mostly done (an old project), some in flight; a fifth unassigned.
    await db.query(
      `WITH people AS (
         SELECT array_agg(id ORDER BY email) AS ids FROM users WHERE email LIKE 'perf-dev-%@example.test'
       ), words AS (
         SELECT ARRAY['Checkout','Refund','Login','Webhook','Invoice','Search','Export','Session',
                      'Upload','Report','Payment','Dashboard','Token','Email','Sprint','Board'] AS a,
                ARRAY['fails','times out','is slow','shows the wrong total','loses data',
                      'needs a retry','returns 500','ignores the filter','double-charges',
                      'renders badly','leaks memory','drops events'] AS b,
                ARRAY['on mobile','for new users','after a deploy','under load','in Safari',
                      'for EU customers','at month end','with large files','behind the proxy',
                      'on the second attempt'] AS c
       )
       INSERT INTO issues (id, project_id, number, title, description, type, status, priority,
                           reporter_id, assignee_id, story_points, version, resolved_at,
                           created_at, updated_at)
       SELECT gen_random_uuid(), $1, n,
              format('%s %s %s', a[1 + n % 16], b[1 + (n / 16) % 12], c[1 + (n / 192) % 10]),
              format('Seen %s times. Steps: open the %s page, then retry. Expected it to work.',
                     1 + n % 50, lower(a[1 + n % 16])),
              (ARRAY['BUG','TASK','FEATURE','CHORE'])[1 + (n * 7) % 4]::issue_type,
              s.status::issue_status,
              (ARRAY['LOW','MEDIUM','MEDIUM','HIGH','CRITICAL'])[1 + (n * 3) % 5]::issue_priority,
              (SELECT ids[1 + (n * 11) % array_length(ids, 1)] FROM people),
              CASE WHEN n % 5 = 0 THEN NULL
                   ELSE (SELECT ids[1 + (n * 13) % array_length(ids, 1)] FROM people) END,
              (ARRAY[1,2,3,5,8])[1 + n % 5],
              1 + n % 4,
              CASE WHEN s.status IN ('DONE', 'CANCELLED') THEN t.created + interval '3 days' END,
              t.created, t.created + (n % 30) * interval '1 day'
       FROM generate_series(1, $2) AS n
       CROSS JOIN words
       CROSS JOIN LATERAL (SELECT now() - interval '730 days' + (n::float / $2) * interval '725 days'
                           AS created) AS t
       CROSS JOIN LATERAL (SELECT CASE
                             WHEN n > $2 - 300 THEN (ARRAY['TODO','IN_PROGRESS','IN_REVIEW'])[1 + n % 3]
                             WHEN n % 10 < 7 THEN 'DONE'
                             WHEN n % 10 = 7 THEN 'BACKLOG'
                             WHEN n % 10 = 8 THEN 'TODO'
                             ELSE 'CANCELLED' END AS status) AS s`,
      [projectId, issues],
    );

    // Labels on half the issues, two on a tenth.
    await db.query(
      `WITH l AS (SELECT array_agg(id ORDER BY name) AS ids FROM labels WHERE project_id = $1)
       INSERT INTO issue_labels (issue_id, label_id, project_id)
       SELECT i.id, l.ids[1 + i.number % 8], $1 FROM issues i, l
       WHERE i.project_id = $1 AND i.number % 2 = 0
       UNION ALL
       SELECT i.id, l.ids[1 + (i.number + 3) % 8], $1 FROM issues i, l
       WHERE i.project_id = $1 AND i.number % 10 = 0`,
      [projectId],
    );

    // Comments: one or two on a third of the issues.
    await db.query(
      `INSERT INTO issue_comments (id, issue_id, author_id, body, created_at)
       SELECT gen_random_uuid(), i.id, i.assignee_id,
              format('Looked into this (%s): reproduced, fix in progress.', k), i.created_at + k * interval '1 hour'
       FROM issues i CROSS JOIN generate_series(1, 2) AS k
       WHERE i.project_id = $1 AND i.assignee_id IS NOT NULL AND i.number % 3 = 0
         AND (k = 1 OR i.number % 2 = 0)`,
      [projectId],
    );

    // Two-week sprints: the active one holds the in-flight issues, older ones are completed.
    await db.query(
      `INSERT INTO sprints (id, project_id, name, status, start_date, end_date, started_at,
                           completed_at, created_at, updated_at)
       SELECT gen_random_uuid(), $1, format('Sprint %s', k),
              CASE WHEN k = 20 THEN 'ACTIVE' ELSE 'COMPLETED' END::sprint_status,
              current_date - (20 - k) * 14 - 13, current_date - (20 - k) * 14,
              now() - ((20 - k) * 14 + 13) * interval '1 day',
              CASE WHEN k < 20 THEN now() - (20 - k) * 14 * interval '1 day' END,
              now() - ((20 - k) * 14 + 14) * interval '1 day', now()
       FROM generate_series(1, 20) AS k`,
      [projectId],
    );
    await db.query(
      `INSERT INTO sprint_issues (sprint_id, issue_id, project_id, story_points_at_add, added_at)
       SELECT s.id, i.id, $1, i.story_points, s.started_at
       FROM issues i JOIN sprints s ON s.project_id = $1 AND s.status = 'ACTIVE'
       WHERE i.project_id = $1 AND i.status IN ('TODO', 'IN_PROGRESS', 'IN_REVIEW')
         AND i.number > $2 - 300`,
      [projectId, issues],
    );

    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  // As autovacuum would have done on a live database: statistics for the planner, and the
  // visibility map that lets counts be answered from an index alone.
  await db.query('VACUUM ANALYZE issues, issue_labels, issue_comments, sprint_issues');
  return true;
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to load the performance dataset into a production database.');
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  const issues = Number(process.env.PERF_ISSUES ?? 100_000);
  const password = process.env.PERF_PASSWORD ?? 'forge-perf-password';

  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const started = Date.now();
    const created = await seedPerformanceData(db, { issues, password });
    console.log(
      created
        ? `Created project ${PERF_PROJECT_KEY} with ${issues} issues in ${Date.now() - started} ms.`
        : `Project ${PERF_PROJECT_KEY} already exists; nothing to do.`,
    );
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
