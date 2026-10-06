# Performance

How fast Forge is under load, how that is measured, and what measuring it found. Two
requirements set the bar ([requirements](requirements.md#4-non-functional-requirements)):

| Requirement | Target                                                       | Result (p95)                                                   |
| ----------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| NFR-1       | CRUD endpoints p95 < 250 ms at 50 requests per second        | **14.5 ms** at 57.9 req/s, 0 errors                            |
| NFR-3       | The issue list p95 < 150 ms in a project with 100,000 issues | **25 ms** across nine variants; slowest (keyword search) 40 ms |

Measured on 2026-10-06 against the production images (`pnpm stack:up`), with the whole stack
and k6 on one 4-vCPU, 15 GB machine. Numbers on a laptop or in AWS will differ; what carries
over is the shape: every list is an index range, nothing scans the table.

## Method

```sh
STACK_RATE_LIMITS_ENABLED=false pnpm stack:up   # rate limits would refuse the load itself
pnpm stack:perf-seed                            # project PERF: 100,000 issues (≈10 s)
docker run --rm --network host -v "$PWD/perf:/perf:ro" grafana/k6 run /perf/crud.js
docker run --rm --network host -v "$PWD/perf:/perf:ro" grafana/k6 run /perf/issue-list.js
```

- **The dataset** (`apps/api/prisma/perf-seed.ts`) is generated inside PostgreSQL with
  `generate_series`: 100,000 issues over two years (70% done, 10% each backlog, to do and
  cancelled, 300 in flight in the active sprint), 21 members, eight labels on 60,000 issue
  rows, 40,000 comments and 20 sprints. Titles combine word lists, so "checkout" matches one
  issue in sixteen, as a common search term would. It ends with `VACUUM ANALYZE`, the state
  autovacuum keeps a live database in. IDs are random v4 UUIDs rather than the API's v7.
- **`perf/crud.js` (NFR-1)** sends a constant 50 requests per second for two minutes, whatever
  the response times (an arrival rate, so a slow server cannot lower its own load). The mix:
  list issues 30%, read an issue 25%, edit one 15% (read, then `PATCH` with its version),
  list comments 10%, comment 10%, create an issue 10%.
- **`perf/issue-list.js` (NFR-3)** asks for a 50-issue page 20 times a second for a minute,
  rotating through every way the app asks: recently updated (the default), by priority, newest
  first, a status filter, an assignee, a label, the active sprint, keyword search and the
  second page.
- **Pass or fail is in the scripts.** Thresholds per operation and per variant fail the run;
  so does an error rate over 1% or more than ten dropped iterations. Each script warms up in
  `setup()`, which is not measured.

## Results

| `crud.js`, 50 req/s for 2 min | p50    | p95         | p99   |
| ----------------------------- | ------ | ----------- | ----- |
| all requests (7,002)          | 6.2 ms | **14.5 ms** | 31 ms |
| list issues                   | 6.4 ms | 12.9 ms     | 27 ms |
| read an issue                 | 4.6 ms | 9.0 ms      | 24 ms |
| edit an issue                 | 6.2 ms | 17.9 ms     | 35 ms |
| list comments                 | 3.5 ms | 6.7 ms      | 12 ms |
| comment                       | 8.2 ms | 17.7 ms     | 42 ms |
| create an issue               | 9.3 ms | 17.7 ms     | 33 ms |

| `issue-list.js`, 100k issues, 20 req/s for 1 min | p50    | p95       |
| ------------------------------------------------ | ------ | --------- |
| all variants (1,233)                             | 6.9 ms | **25 ms** |
| recently updated (default)                       | 6.2 ms | 9.1 ms    |
| by priority                                      | 6.5 ms | 16 ms     |
| newest first                                     | 5.8 ms | 13 ms     |
| status filter                                    | 6.6 ms | 11 ms     |
| assignee                                         | 4.1 ms | 17 ms     |
| label                                            | 7.6 ms | 12 ms     |
| active sprint                                    | 8.1 ms | 19 ms     |
| second page (cursor)                             | 6.5 ms | 11 ms     |
| keyword search ("checkout", 6,250 matches)       | 24 ms  | 40 ms     |

## What measuring found

The first run of `crud.js` failed: the issue list's p95 was **358 ms** under the mixed load
(71 ms with reads alone). Postgres's slow-statement log pointed at one query, and the fixes
followed from `EXPLAIN ANALYZE`:

1. **Counting comments scanned every comment.** The list asked Prisma for each issue's
   `_count` of comments, which Prisma 7 compiles into a join with a subquery that groups every
   comment in the database by issue. The planner then read all 100,000 issues and all 40,000
   comments to show 50 rows (about 40 ms when idle, far more under concurrent writes). The
   counts now come from one `GROUP BY` over the page's 50 IDs: 0.27 ms. List p95 under load:
   358 → 13 ms. The same pattern was removed from project cards (open issues and members:
   22 → 6 ms) and labels.
2. **Sorting by priority had no index.** Each page sorted the project's 100,000 live issues
   (a top-N heapsort, 14 ms of CPU in each of three workers). A partial index in that order,
   `issues_active_by_priority_idx`, makes it a 51-row index range: 0.3 ms.
3. **"Open issues" could not use the status index.** `status NOT IN ('DONE','CANCELLED')`
   was read with a sequential scan; `status IN` the four open statuses is answered from
   `issues_active_by_status_idx` alone (5.6 → 1.9 ms). The dashboard's open-issue breakdowns
   use the same definition (`OPEN_ISSUES`, with a test that fails if a status is added
   without deciding whether it is open). Dashboard: about 75 → 30 ms.
4. **Keyword search returned the wrong first page.** Not a speed problem, but found by
   looking at the search's plan. Search collects at most 1,000 matching IDs before the list
   applies its sort; it took them in no particular order, so with 6,250 matches the "most
   recently updated" page was the most recent of an arbitrary 1,000. The prefetch now uses the
   list's own order, so the cap only ever cuts the end of the list. It is also faster (60 →
   40 ms), because the scan can stop at 1,000. A test with 1,100 matches pins this, and fails
   without the fix.

Each fix has a test that fails when it is undone: comment, member, open-issue and label counts
(`projects.int-spec.ts`), the search order (`issues-api.int-spec.ts`) and the open statuses
(`open-issues.spec.ts`).

## Query plans (100,000 issues)

| Query                               | Plan                                                                    | Time    |
| ----------------------------------- | ----------------------------------------------------------------------- | ------- |
| Page, recently updated              | Index Only Scan `issues_active_by_updated_idx`, 51 rows                 | 0.46 ms |
| Page, by priority                   | Index Only Scan `issues_active_by_priority_idx`, 51 rows                | 0.32 ms |
| Page, newest first                  | Index Scan Backward `issues_project_id_number_key`, 51 rows             | 0.68 ms |
| Page, status filter                 | Index Scan `issues_active_by_updated_idx`, 96 rows filtered out         | 0.25 ms |
| Page, label filter                  | Index Only Scan `issues_active_by_updated_idx` + label lookup, 456 rows | 3.6 ms  |
| Search prefetch, "checkout"         | Index Scan `issues_active_by_updated_idx`, stops at 1,000 matches       | 29 ms   |
| Open issues of a project (21k rows) | Index Only Scan `issues_active_by_status_idx`                           | 5.7 ms  |
| Comment counts for one page         | Bitmap Index Scan `issue_comments_issue_id_created_at_idx`              | 0.27 ms |

## In CI

The end-to-end job loads the same dataset into the production images and runs both scripts
for 30 seconds each, with the same thresholds; the k6 summaries are uploaded. On a shared
runner that is a regression gate with margins (each target is 4 to 17 times today's p95),
not a benchmark; the comment-count bug above would have failed it.

## Limits and what is not measured

- **Keyword search beyond 1,000 matches.** Pages past the first thousand matches are not
  reachable; narrowing the search finds them. Moving the text condition into the list query
  itself would remove the cap.
- **AWS.** These numbers come from one machine. In AWS the database and Redis are a network
  hop away and Fargate tasks have 0.5–1 vCPU, so expect higher absolute latencies; the plans,
  which are what made the difference, are the same.
- **AI features** are not load-tested here: they are queued or streamed by design (NFR-2) and
  bounded by provider rate limits and per-user budgets, not by Forge.
