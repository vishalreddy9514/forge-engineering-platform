# API reference

> The live, complete reference is the OpenAPI document generated from the code: Swagger UI at
> `http://localhost:4000/api/docs`, JSON at `/api/docs/openapi.json` (disabled in production
> unless `SWAGGER_ENABLED=true`). This page covers conventions and the endpoints built so far.
> Conventions are defined in [architecture §14](architecture.md#14-api-design-conventions).

## Basics

|            |                                                                                      |
| ---------- | ------------------------------------------------------------------------------------ |
| Base path  | `/api/v1`                                                                            |
| Format     | JSON in and out; errors are `application/problem+json` (RFC 9457)                    |
| Auth       | `Authorization: Bearer <access token>` on every route unless marked **public** below |
| Request ID | Send `X-Request-ID` to correlate; it is echoed back, or generated if absent          |

### Errors

```json
{
  "type": "about:blank",
  "title": "Bad Request",
  "status": 400,
  "detail": "Validation failed",
  "instance": "/api/v1/auth/register",
  "requestId": "8f0c…",
  "errors": [{ "path": "password", "message": "Use at least 12 characters" }]
}
```

| Status | Meaning                                                                                                                                    |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | Validation failed; `errors[]` lists each field                                                                                             |
| 401    | Missing, invalid, expired or revoked access token (`WWW-Authenticate: Bearer`)                                                             |
| 403    | Authenticated but not allowed (wrong project role, not an admin, cross-site cookie request)                                                |
| 404    | Not found, **or not visible to you**. Project-scoped resources in projects you are not a member of are indistinguishable from missing ones |
| 409    | Conflict (duplicate email; concurrent refresh, retry once)                                                                                 |
| 429    | Rate limited or account temporarily locked; see `Retry-After`                                                                              |

Every response carries `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers.

## Authentication

Sessions are an **access token** (ES256 JWT, 15 minutes, kept in memory by the client) plus a
**refresh token** in an `HttpOnly; Secure; SameSite=Strict` cookie named `forge_rt`, scoped to
`Path=/api/v1/auth`. See [ADR-0003](adr/0003-auth-tokens.md) and
[ADR-0010](adr/0010-es256-access-tokens-and-revocation.md).

| Method | Path                           | Auth           | Rate limit                      | Body → Response                                                                |
| ------ | ------------------------------ | -------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| POST   | `/auth/register`               | public         | 5/min/IP                        | `{ email, displayName, password }` → **201** `AuthResponse` + cookies          |
| POST   | `/auth/login`                  | public         | 10/min/IP, plus account lockout | `{ email, password }` → **200** `AuthResponse` + cookies                       |
| POST   | `/auth/refresh`                | refresh cookie | 30/min/IP                       | → **200** `AuthResponse` + rotated cookie · **401** signed out · **409** retry |
| POST   | `/auth/logout`                 | refresh cookie | default                         | → **204**, ends this device's session                                          |
| POST   | `/auth/logout-all`             | bearer         | default                         | → **204**, ends every session and voids access tokens                          |
| POST   | `/auth/password-reset/request` | public         | 5/min/IP                        | `{ email }` → **202** (identical whether or not the account exists)            |
| POST   | `/auth/password-reset/confirm` | public         | 10/min/IP                       | `{ token, newPassword }` → **204**, signs out everywhere                       |

`AuthResponse`:

```json
{
  "accessToken": "eyJhbGciOiJFUzI1NiIsImtpZCI6…",
  "expiresIn": 900,
  "user": {
    "id": "0192…",
    "email": "priya@forge.local",
    "displayName": "Priya Shah",
    "avatarUrl": null,
    "isAdmin": false,
    "createdAt": "2026-09-26T10:00:00.000Z"
  }
}
```

Behaviour worth knowing:

- **Refresh rotation.** Each refresh consumes the cookie's token and sets a new one. Replaying a
  consumed token more than 10 seconds later revokes that whole session family (theft
  detection). Within 10 seconds it is treated as two tabs racing and answered with `409`.
- **Lockout.** After 5 failed logins for an email (whether or not the account exists) or 20
  from one IP within 15 minutes, logins answer `429` with `Retry-After`.
- **CSRF.** `refresh` and `logout` reject requests whose `Origin` is not the web app.
- **Passwords** need 12–128 characters, with no composition rules, and are rejected if they
  appear in a public breach (Have I Been Pwned k-anonymity check).

## Current user

| Method | Path                 | Body → Response                                                                   |
| ------ | -------------------- | --------------------------------------------------------------------------------- |
| GET    | `/users/me`          | → `UserProfile`                                                                   |
| PATCH  | `/users/me`          | `{ displayName?, avatarUrl? }` (https URLs only) → `UserProfile`                  |
| POST   | `/users/me/password` | `{ currentPassword, newPassword }` → `AuthResponse` + cookies; other sessions end |

## Administration

Requires `isAdmin`, which is re-checked against the database on every request.

| Method | Path                                 | Body → Response                                                                                                             |
| ------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/admin/users?limit=25&cursor=…&q=…` | → `{ data: AdminUser[], nextCursor }` (keyset pagination; `q` searches email and name)                                      |
| PATCH  | `/admin/users/:id`                   | `{ isActive?, isAdmin? }` → `AdminUser`. Deactivation ends the user's sessions immediately; admins cannot change themselves |

## Project permissions

Project-scoped routes declare a permission, e.g.
`@RequireProjectPermission('issue:update', 'issue')`. The role → permission matrix is in
[requirements §2](requirements.md#permission-matrix) and
[`permissions.ts`](../apps/api/src/access-control/permissions.ts). Non-members get **404**,
members without the permission **403**, and platform admins are allowed everything.

## Projects

Projects are addressed by ID in the API and by key in the web app (`/projects/PAY`).
**Archived projects are read-only**: any write except restoring answers `409`.

| Method | Path                                         | Permission        | Body → Response                                                                                                                            |
| ------ | -------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/projects?q=&archived=false&limit=&cursor=` | signed in         | → `{ data: ProjectSummary[], nextCursor }`. Your projects (admins: all), by name                                                           |
| POST   | `/projects`                                  | signed in         | `{ key, name, description? }` → **201** `ProjectDetail`; the creator becomes project manager. Taken key → **409** with a `key` field error |
| GET    | `/projects/by-key/:projectKey`               | `project:read`    | → `ProjectDetail` (key is case-insensitive)                                                                                                |
| GET    | `/projects/:projectId`                       | `project:read`    | → `ProjectDetail`                                                                                                                          |
| PATCH  | `/projects/:projectId`                       | `project:update`  | `{ name?, description?, defaultAssigneeId? }` → `ProjectDetail`. The key is immutable; the default assignee must be a member               |
| POST   | `/projects/:projectId/archive` · `/restore`  | `project:archive` | → `ProjectDetail` (idempotent)                                                                                                             |
| DELETE | `/projects/:projectId?confirm=KEY`           | platform admin    | → **204**. The project must be archived first (**409**), and `confirm` must repeat its key (**400**)                                       |

`ProjectSummary` has `id, key, name, description, archivedAt, createdAt, myRole, memberCount,
openIssueCount`. `ProjectDetail` adds `defaultAssignee`, `createdBy` and `activeSprint`.

### Members

| Method | Path                                   | Permission                           | Body → Response                                                                                                                             |
| ------ | -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/projects/:projectId/members`         | `project:read`                       | → `ProjectMember[]` (managers first, then by name)                                                                                          |
| POST   | `/projects/:projectId/members`         | `member:manage`                      | `{ email, role }` → **201** `ProjectMember`. Unknown or inactive email → **404**, already a member → **409** (both as `email` field errors) |
| PATCH  | `/projects/:projectId/members/:userId` | `member:manage`                      | `{ role }` → `ProjectMember`                                                                                                                |
| DELETE | `/projects/:projectId/members/:userId` | `member:manage`, or yourself (leave) | → **204**                                                                                                                                   |

Role changes and removals apply on the member's very next request (the membership cache entry is
invalidated). A project always keeps at least one project manager: demoting or removing the last
one answers **409**, even when two managers demote each other at the same moment.

### Labels

| Method | Path                          | Permission       | Body → Response                                                                                                          |
| ------ | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/projects/:projectId/labels` | `project:read`   | → `Label[]` with `issueCount`, by name                                                                                   |
| POST   | `/projects/:projectId/labels` | `project:update` | `{ name, color: "#rrggbb", description? }` → **201** `Label`. Names are unique per project, case-insensitively (**409**) |
| PATCH  | `/labels/:labelId`            | `project:update` | any of the create fields → `Label`                                                                                       |
| DELETE | `/labels/:labelId`            | `project:update` | → **204**, and the label is removed from its issues                                                                      |

## Issues

Issues are numbered per project and addressed as `KEY-number` in the web app (`/projects/PAY/issues/PAY-42`).
Deleting is a soft delete: the issue disappears from lists, the board and lookups, and its history is kept.

| Method | Path                            | Permission     | Body → Response                                                                                                              |
| ------ | ------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/projects/:projectId/issues?…` | `project:read` | → `{ data: IssueSummary[], nextCursor }`, filters below                                                                      |
| POST   | `/projects/:projectId/issues`   | `issue:create` | `{ title, description?, type?, priority?, status?, assigneeId?, labelIds?, storyPoints?, dueDate? }` → **201** `IssueDetail` |
| GET    | `/issues/by-key/:issueKey`      | `project:read` | → `IssueDetail` (key is case-insensitive)                                                                                    |
| GET    | `/issues/:issueId`              | `project:read` | → `IssueDetail`                                                                                                              |
| PATCH  | `/issues/:issueId`              | `issue:update` | `{ version, …any create field }` → `IssueDetail`. Stale `version` → **409**; a disallowed status move → **400** on `status`  |
| DELETE | `/issues/:issueId`              | `issue:delete` | → **204** (soft delete)                                                                                                      |
| GET    | `/issues/:issueId/events`       | `project:read` | → `IssueEvent[]`, oldest first: every field change, label, comment and lifecycle event with the actor                        |

- **Create.** New issues start in `BACKLOG` or `TODO`. Omitting `assigneeId` uses the project's
  default assignee (if still a member); `null` leaves it unassigned. The assignee must be a
  project member and labels must belong to the project (both **400** field errors).
- **Workflow.** Backlog → To do / In progress / Cancelled; To do → Backlog / In progress /
  Cancelled; In progress → To do / In review / Done / Cancelled; In review → In progress / Done /
  Cancelled; Done → To do / In progress (reopen); Cancelled → Backlog / To do. Entering Done or
  Cancelled sets `resolvedAt`; leaving clears it.
- **Optimistic locking.** Every issue has a `version`. A PATCH must send the version it last saw;
  if someone else saved first the answer is **409** and nothing is written. Of two simultaneous
  edits exactly one wins. A PATCH that changes nothing does not bump the version.
- **Labels** in a PATCH are the complete new set.

List filters (all optional, combined with AND):

| Parameter                    | Example                            | Meaning                                                                   |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------- |
| `status`, `priority`, `type` | `status=TODO,IN_PROGRESS`          | Any of the comma-separated values                                         |
| `assignee`                   | `me`, `none` or a user ID          | Assigned to you, unassigned, or to that person                            |
| `label`                      | label ID                           | Has that label                                                            |
| `q`                          | `refund timeout`                   | Full-text search on title and description (stemmed), plus title substring |
| `sort`                       | `updated` · `created` · `priority` | Newest activity (default), newest issue, or most urgent first             |
| `limit`, `cursor`            | `limit=50`                         | Keyset pagination, stable under concurrent writes                         |

`IssueSummary` has `id, key, number, title, type, status, priority, assignee, labels, storyPoints,
dueDate, commentCount, version, createdAt, updatedAt`. `IssueDetail` adds `projectId, projectKey,
description, reporter, resolvedAt`.

### Comments

| Method | Path                        | Permission                        | Body → Response                           |
| ------ | --------------------------- | --------------------------------- | ----------------------------------------- |
| GET    | `/issues/:issueId/comments` | `project:read`                    | → `Comment[]`, oldest first               |
| POST   | `/issues/:issueId/comments` | `comment:create`                  | `{ body }` (Markdown) → **201** `Comment` |
| PATCH  | `/comments/:commentId`      | the author, or `comment:moderate` | `{ body }` → `Comment` (sets `editedAt`)  |
| DELETE | `/comments/:commentId`      | the author, or `comment:moderate` | → **204**                                 |

Deleted comments stay in the thread as `{ deleted: true, body: null }` so replies keep their
context; the text itself is not returned. Comments do not change the issue's `version`, so
discussing an issue never conflicts with editing it.

### Attachments

Files go straight from the browser to object storage; the API never handles the bytes.

| Method | Path                                  | Permission                                 | Body → Response                                                                                                              |
| ------ | ------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/issues/:issueId/attachments`        | `attachment:create`                        | `{ fileName, contentType, sizeBytes }` → **201** `{ attachment, upload: { url, method: "PUT", headers, expiresAt } }`        |
| POST   | `/attachments/:attachmentId/complete` | `attachment:create`, and you requested it  | → `Attachment` (`AVAILABLE`). Nothing uploaded yet → **409**; stored object differs from the request → **400** and discarded |
| GET    | `/issues/:issueId/attachments`        | `project:read`                             | → `Attachment[]` (completed uploads only, oldest first)                                                                      |
| GET    | `/attachments/:attachmentId/download` | `project:read`                             | → `{ url, expiresAt }`: a pre-signed GET valid for 60 seconds, served with `Content-Disposition: attachment`                 |
| DELETE | `/attachments/:attachmentId`          | the uploader, or `issue:delete` (managers) | → **204**; the object is deleted from storage first                                                                          |

The upload flow:

1. Request an upload. The API checks the type against the allow-list (images, PDF, text, CSV,
   Markdown, JSON, zip and gzip; never HTML or SVG), the 10 MB limit, and 50 files per issue.
   It sanitises the file name and returns a pre-signed PUT valid for 10 minutes.
2. `PUT` the file to `upload.url` with exactly `upload.headers`. Size, type and disposition are
   part of the signature, so storage rejects any other body with `403`.
3. Complete. The API reads the stored object's size and type before making it visible.

Uploads that are never completed are deleted by an hourly worker job. Storage keys are random
and never contain the file name.

### Notifications

Created by the worker from domain events (see [architecture §5.2](architecture.md#52-transactional-outbox)),
so they appear a moment after the change. You only ever see your own.

| Method | Path                                    | Body → Response                                               |
| ------ | --------------------------------------- | ------------------------------------------------------------- |
| GET    | `/notifications?unread=&limit=&cursor=` | → `{ data: Notification[], nextCursor }`, newest first        |
| GET    | `/notifications/unread-count`           | → `{ count }`; the web app polls this every 30 seconds        |
| POST   | `/notifications/:id/read`               | → **204** (idempotent; someone else's notification → **404**) |
| POST   | `/notifications/read-all`               | → **204**                                                     |

`Notification` is `{ id, type, payload, readAt, createdAt }`. Issue notifications carry
`{ projectKey, issueKey, issueTitle, actorName }`; sprint notifications carry
`{ projectKey, sprintId, sprintName, actorName }`. Current triggers:

| Event                     | Who is notified                                                   | Email |
| ------------------------- | ----------------------------------------------------------------- | ----- |
| Issue assigned to someone | The new assignee, unless they assigned themselves                 | Yes   |
| Comment added             | The reporter, the assignee and earlier commenters, not the author | No    |
| Sprint started/completed  | Every project member except the person who did it                 | No    |

Recipients must still be active members of the project when the worker runs. @mentions are not
implemented yet; pull-request and AI events arrive with those features (Phases 8 and 9–11).

## Sprints

A project has any number of planned sprints, at most one active sprint (a partial unique index
guarantees it even when two people press Start at once), and its completed sprints. Planning,
starting and completing need `sprint:manage` (project managers); everyone in the project can read.

| Method | Path                                      | Permission      | Body → Response                                                                                                         |
| ------ | ----------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET    | `/projects/:projectId/sprints`            | `project:read`  | → `Sprint[]`: active first, then planned by start date, then completed, newest first                                    |
| POST   | `/projects/:projectId/sprints`            | `sprint:manage` | `{ name, goal?, startDate, endDate }` → **201** `Sprint`. At most 56 days; names unique per project (**409** on `name`) |
| GET    | `/sprints/:sprintId`                      | `project:read`  | → `Sprint`                                                                                                              |
| PATCH  | `/sprints/:sprintId`                      | `sprint:manage` | any create field (`goal` may be `null`) → `Sprint`. Completed sprints are fixed (**409**)                               |
| DELETE | `/sprints/:sprintId`                      | `sprint:manage` | → **204**; planned sprints only (**409** otherwise). Its issues return to the backlog                                   |
| POST   | `/sprints/:sprintId/start`                | `sprint:manage` | → `Sprint`. **409** if another sprint is active, or this one already started                                            |
| POST   | `/sprints/:sprintId/complete`             | `sprint:manage` | `{ moveOpenIssuesTo: "backlog" \| plannedSprintId }` → `{ sprint, completed, movedToBacklog, movedToSprint }`           |
| POST   | `/sprints/:sprintId/issues`               | `sprint:manage` | `{ issueIds }` (1–100) → `Sprint`. An issue in another open sprint moves here                                           |
| DELETE | `/sprints/:sprintId/issues/:issueId`      | `sprint:manage` | → **204**; the issue returns to the backlog                                                                             |
| GET    | `/sprints/:sprintId/burndown`             | `project:read`  | → `Burndown`                                                                                                            |
| GET    | `/projects/:projectId/velocity?sprints=6` | `project:read`  | → `Velocity` for the last 1–20 completed sprints                                                                        |

`Sprint` has `id, projectId, name, goal, status, startDate, endDate, startedAt, completedAt,
issueCount, points: { total, done }`. For a completed sprint the counts describe what it ended with.

**Completing a sprint** closes every membership with an outcome: Done issues are `COMPLETED`,
cancelled or deleted ones `REMOVED`, and the rest `CARRIED_OVER`, into the backlog or the chosen
planned sprint of the same project. Every move is written to the issue's history
(`SPRINT_CHANGED`), and starting and completing notify the project's members (`SPRINT_STARTED`,
`SPRINT_COMPLETED`) through the outbox.

**Burndown** (`{ committed, days: [{ date, remaining, ideal, scopeChange }] }`) is rebuilt from
issue history on every request rather than from nightly snapshots, so it is exact for any sprint,
past or present. For each day (UTC) it takes the state at the end of that day, or at completion:
an issue counts while it belongs to the sprint and is neither Done nor Cancelled, with the story
points it had at that moment. `committed` is the remaining work when the sprint started,
`ideal` falls in a straight line from it to zero, `scopeChange` is points added (+) or removed
(−) that day, and days that have not happened yet have `remaining: null`.

**Velocity** (`{ sprints: [{ id, name, completedAt, committed, completed }], average }`), oldest
first: `committed` is the points in the sprint when it started, `completed` the points of issues
done at completion.

The issue list takes `sprint=<id>|active|none` (`none` is the backlog), and every issue carries
its current `sprint: { id, name } | null`.

## Health

| Method | Path            | Auth   | Response                                                                                                    |
| ------ | --------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| GET    | `/health/live`  | public | `200 { status: "ok" }`: the process is up                                                                   |
| GET    | `/health/ready` | public | `200` or `503 { status, checks: { database, redis } }`. Failure reasons are generic; details go to the logs |
