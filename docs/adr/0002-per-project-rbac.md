# ADR-0002: Per-project roles with permissions defined in code

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

The brief names four roles: Admin, Project Manager, Developer and Viewer. In real teams a person
leads one project and only watches another, so a single global role per user can't express
reality.

## Decision

- `users.is_admin` is the only global role flag.
- `project_members(project_id, user_id, role_id)` gives each member one role per project. The
  `roles` table holds the three project roles as reference data (stable keys `PROJECT_MANAGER`,
  `DEVELOPER`, `VIEWER`) so they can carry display metadata and be joined in reports.
- The **role → permission mapping lives in code** (`access-control/permissions.ts`) as a typed
  constant, and is checked by a guard driven by the `@RequireProjectPermission()` decorator.
- A non-member receives `404` for project-scoped resources.

## Alternatives considered

- **Global roles only.** Too coarse, as described above.
- **Fully dynamic RBAC (permissions table editable by admins).** Rejected for v1. It adds UI,
  migrations and a class of bugs ("admin removed own permission") without a user need. The
  permission set is tied to code paths anyway.
- **Policy engine (Casbin / OPA).** Overkill for about 20 permissions and 3 roles. It would be
  worth revisiting if attribute-based rules grow.

## Consequences

- ➕ The permission matrix is unit-tested as a table and reviewed in PRs like any other code.
- ➕ One guard handles every route, so it is hard to forget authorisation.
- ➖ Changing what a role can do requires a deploy. That is acceptable, and arguably desirable
  for security-relevant changes.
