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

Project-scoped routes (from Phase 5) declare a permission, e.g.
`@RequireProjectPermission('issue:update', 'issue')`. The role → permission matrix is in
[requirements §2](requirements.md#permission-matrix) and
[`permissions.ts`](../apps/api/src/access-control/permissions.ts). Non-members get **404**,
members without the permission **403**, and platform admins are allowed everything.

## Health

| Method | Path            | Auth   | Response                                                                                                    |
| ------ | --------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| GET    | `/health/live`  | public | `200 { status: "ok" }`: the process is up                                                                   |
| GET    | `/health/ready` | public | `200` or `503 { status, checks: { database, redis } }`. Failure reasons are generic; details go to the logs |
