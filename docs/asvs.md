# OWASP ASVS Level 1 checklist

NFR-6 asks for the OWASP Application Security Verification Standard (4.0.3) at Level 1. This is
the self-assessment: each applicable requirement, how Forge meets it, and what checks it. The
controls themselves are described in [security](security.md); the threat model is in
[architecture §6](architecture.md#6-security-architecture).

Legend: **Met** (implemented and checked), **Gap** (not met; see the end), **N/A** (the feature
does not exist in Forge).

## V2 Authentication

| ID    | Requirement (short)                               | Status | How                                                                           | Checked by                          |
| ----- | ------------------------------------------------- | ------ | ----------------------------------------------------------------------------- | ----------------------------------- |
| 2.1.1 | Passwords of at least 12 characters               | Met    | `PASSWORD_MIN_LENGTH = 12` in the shared schema                               | `auth.test.ts`                      |
| 2.1.2 | Passwords of at least 64 characters are allowed   | Met    | Up to 128                                                                     | `auth.test.ts`                      |
| 2.1.3 | No truncation                                     | Met    | argon2id hashes the whole password                                            | `password-hasher.spec.ts`           |
| 2.1.4 | Any printable Unicode, including spaces and emoji | Met    | Only length is checked                                                        | `auth.test.ts`                      |
| 2.1.5 | Users can change their password                   | Met    | `POST /users/me/password`                                                     | `auth.int-spec.ts`                  |
| 2.1.6 | Changing a password needs the current one         | Met    | `currentPassword` is required and verified                                    | `auth.int-spec.ts`                  |
| 2.1.7 | Breached passwords are refused                    | Met    | Pwned Passwords k-anonymity lookup (fails open)                               | `breached-password.service.spec.ts` |
| 2.1.9 | No composition rules                              | Met    | NIST SP 800-63B: length only                                                  | `auth.test.ts`                      |
| 2.2.1 | Anti-automation against credential stuffing       | Met    | Per-account and per-IP lockout with `Retry-After`; route rate limits          | `auth.int-spec.ts`                  |
| 2.2.2 | Weak authenticators limited                       | N/A    | No SMS or email one-time codes                                                |                                     |
| 2.5.1 | Recovery secrets are not sent in clear            | Met    | The reset link holds a random token; the password is never emailed            | `auth.int-spec.ts`                  |
| 2.5.2 | No password hints or secret questions             | Met    | None exist                                                                    | Review                              |
| 2.5.3 | Recovery does not reveal the current password     | Met    | Passwords are stored as argon2id hashes only                                  | Review                              |
| 2.5.4 | No shared or default accounts                     | Met    | The demo seed runs only on request (`pnpm stack:seed`), never in a deployment | Review of `deploy.yml`              |
| 2.5.6 | Recovery uses a time-limited, single-use secret   | Met    | 30-minute, single-use, hashed tokens; newest link only                        | `auth.int-spec.ts`                  |

## V3 Session management

| ID    | Requirement (short)                        | Status | How                                                                         | Checked by                               |
| ----- | ------------------------------------------ | ------ | --------------------------------------------------------------------------- | ---------------------------------------- |
| 3.1.1 | Session tokens never in URLs               | Met    | Access token in memory, refresh token in a cookie                           | ZAP 10024 (sensitive information in URL) |
| 3.2.1 | A new session token on authentication      | Met    | Every login issues a new refresh-token family                               | `auth.int-spec.ts`                       |
| 3.2.2 | At least 64 bits of entropy                | Met    | 256-bit random refresh tokens                                               | Review of `auth.service.ts`              |
| 3.2.3 | Tokens stored securely in the browser      | Met    | httpOnly cookie; the access token is never written to storage               | `auth.int-spec.ts`; review               |
| 3.3.1 | Logout invalidates the session             | Met    | Refresh family revoked; Redis cutoff for access tokens                      | `auth.int-spec.ts`                       |
| 3.4.1 | Cookies have `Secure`                      | Met    |                                                                             | `auth.int-spec.ts`                       |
| 3.4.2 | Cookies have `HttpOnly`                    | Met    |                                                                             | `auth.int-spec.ts`                       |
| 3.4.3 | Cookies have `SameSite`                    | Met    | `Strict`                                                                    | `auth.int-spec.ts`                       |
| 3.4.5 | Cookies are path-scoped                    | Met    | `/api/v1/auth`                                                              | `auth.int-spec.ts`                       |
| 3.7.1 | Re-authentication before sensitive changes | Met    | Password changes need the current password; account deletion does not exist | `auth.int-spec.ts`                       |

## V4 Access control

| ID    | Requirement (short)                                       | Status | How                                                                                                | Checked by                                     |
| ----- | --------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 4.1.1 | Enforced on a trusted service                             | Met    | Global guard in the API; the web app's checks are convenience only                                 | `admin-and-rbac.int-spec.ts`                   |
| 4.1.2 | Access-control data cannot be changed by users            | Met    | Unknown keys (`isAdmin`, `role`) are dropped by Zod                                                | `admin-and-rbac.int-spec.ts`                   |
| 4.1.3 | Least privilege                                           | Met    | Role matrix in code; the API's database login cannot change the schema                             | `permissions.test.ts`, `db-logins.int-spec.ts` |
| 4.1.5 | Fails securely                                            | Met    | Secure by default: routes opt out with `@Public()`                                                 | `app.e2e-spec.ts`                              |
| 4.2.1 | Protection against IDOR                                   | Met    | Project guard on every project route; non-members get 404                                          | Supertest suites, every resource type          |
| 4.2.2 | Anti-CSRF                                                 | Met    | Bearer tokens for the API; the two cookie endpoints use SameSite=Strict and an `Origin` allow-list | `auth.int-spec.ts`                             |
| 4.3.1 | Administrative interfaces use multi-factor authentication | Gap    | No MFA yet                                                                                         |                                                |
| 4.3.2 | Directory browsing is off                                 | Met    | Nothing serves directories; storage is private                                                     | ZAP baseline                                   |

## V5 Validation, sanitisation and encoding

| ID    | Requirement (short)                      | Status | How                                                                                     | Checked by                                      |
| ----- | ---------------------------------------- | ------ | --------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 5.1.1 | Defence against HTTP parameter pollution | Met    | Zod schemas take single values                                                          | Schema tests (`packages/types`)                 |
| 5.1.3 | Input validated with allow-lists         | Met    | A Zod schema for every body, query and parameter                                        | Schema tests (`packages/types`)                 |
| 5.1.5 | Redirects only to allowed destinations   | Met    | `safeNextPath` accepts same-origin paths only                                           | `login-form.test.tsx`                           |
| 5.2.1 | Untrusted HTML is sanitised              | Met    | Markdown rendered by react-markdown without raw HTML; `javascript:` links dropped       | `security.spec.ts` (an attacking description)   |
| 5.2.6 | Protection against SSRF                  | Met    | No user-supplied URL is fetched; GitHub pagination links are confined to the API origin | `github.client.spec.ts`                         |
| 5.3.3 | Output encoding against XSS              | Met    | React escaping; a nonce-based CSP as a second layer                                     | `security.spec.ts` (injected markup cannot run) |
| 5.3.4 | Parameterised queries                    | Met    | Prisma; raw SQL only as tagged templates (a lint rule bans the unsafe forms)            | ESLint                                          |
| 5.3.8 | No OS command injection                  | N/A    | The services run no shell commands                                                      |                                                 |

## V7 Errors and logging

| ID    | Requirement (short)                           | Status | How                                                                | Checked by                         |
| ----- | --------------------------------------------- | ------ | ------------------------------------------------------------------ | ---------------------------------- |
| 7.1.1 | No credentials or session tokens in logs      | Met    | Request-log allow-list; redaction of tokens, cookies and passwords | Review of `config/root-modules.ts` |
| 7.1.2 | No other sensitive data in logs               | Met    | No bodies logged; error reports scrubbed                           | `errors.spec.ts`, `test_errors.py` |
| 7.4.1 | Generic error messages with an ID for support | Met    | `problem+json` without stack traces, carrying the request ID       | `app.e2e-spec.ts`                  |

## V8 Data protection

| ID    | Requirement (short)                             | Status | How                                                                 | Checked by                       |
| ----- | ----------------------------------------------- | ------ | ------------------------------------------------------------------- | -------------------------------- |
| 8.2.1 | Anti-caching headers on sensitive data          | Met    | `Cache-Control: no-store` on every API response                     | `app.e2e-spec.ts`                |
| 8.2.2 | No sensitive data in browser storage            | Met    | Nothing in `localStorage` or `sessionStorage`                       | Review                           |
| 8.2.3 | Authenticated data cleared on logout            | Met    | The query cache is cleared on sign-out and when the session expires | `auth-provider.test.tsx`         |
| 8.3.1 | Sensitive data in bodies or headers, never URLs | Met    | The auth forms POST, even before hydration                          | `auth-forms.test.tsx`, ZAP 10024 |

## V9 Communications

| ID    | Requirement (short)             | Status | How                                                  | Checked by       |
| ----- | ------------------------------- | ------ | ---------------------------------------------------- | ---------------- |
| 9.1.1 | TLS for every client connection | Met    | ALB: HTTPS only (port 80 redirects), HSTS for a year | `terraform test` |
| 9.1.2 | Strong cipher suites only       | Met    | `ELBSecurityPolicy-TLS13-1-2-2021-06`                | `terraform test` |
| 9.1.3 | Old TLS versions disabled       | Met    | TLS 1.2 and 1.3 only                                 | `terraform test` |

## V10 Malicious code

| ID     | Requirement (short)                    | Status | How                                                                         | Checked by                     |
| ------ | -------------------------------------- | ------ | --------------------------------------------------------------------------- | ------------------------------ |
| 10.3.2 | Integrity of updates and deployed code | Met    | Signed build attestations verified before deploy; images deployed by digest | `deploy.yml`, `terraform test` |
| 10.3.3 | Subdomain takeover                     | Met    | DNS records are managed by the same Terraform as their targets              | Review of `edge.tf`            |

## V12 Files and resources

| ID     | Requirement (short)                 | Status | How                                                                   | Checked by                    |
| ------ | ----------------------------------- | ------ | --------------------------------------------------------------------- | ----------------------------- |
| 12.1.1 | Upload size limits                  | Met    | 10 MB, signed into the upload URL and rechecked                       | `attachments.int-spec.ts`     |
| 12.3.1 | User file names never become paths  | Met    | Storage keys are random UUIDs                                         | `attachments.test.ts`         |
| 12.4.1 | Uploads stored outside the web root | Met    | Private object storage on a separate origin                           | ADR-0011                      |
| 12.5.2 | Uploaded files are never executed   | Met    | `Content-Disposition: attachment`; HTML, SVG and script types refused | `content-disposition.spec.ts` |

## V13 API

| ID     | Requirement (short)                     | Status | How                                                                                                                                      | Checked by                      |
| ------ | --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 13.1.1 | One consistent encoding and parsing     | Met    | JSON in and out (`problem+json` for errors)                                                                                              | Schema tests (`packages/types`) |
| 13.1.3 | No secrets in API URLs                  | Met    | Tokens travel in headers or cookies; the reset token is in the page URL only, removed from the address bar and never sent as a `Referer` | `auth.int-spec.ts`              |
| 13.2.1 | Only intended HTTP methods are accepted | Met    | Nest routes declare their methods; others get 404                                                                                        | `app.e2e-spec.ts`               |
| 13.2.3 | REST CSRF protection                    | Met    | As 4.2.2                                                                                                                                 |                                 |

## V14 Configuration

| ID     | Requirement (short)                                     | Status | How                                                                           | Checked by                                     |
| ------ | ------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| 14.2.1 | Components are up to date                               | Met    | Trivy fails images with fixable High or Critical findings; updates are manual | `images.yml`                                   |
| 14.3.2 | Debug modes off in production                           | Met    | `NODE_ENV=production`; no stack traces in responses                           | `problem-details.filter.spec.ts`               |
| 14.3.3 | Headers do not expose versions                          | Met    | `x-powered-by` off in Next.js and Express; Nginx `server_tokens off`          | `app.e2e-spec.ts`, ZAP baseline                |
| 14.4.1 | Every response has a correct `Content-Type` and charset | Met    | Except the empty-bodied redirect from `/` (reviewed, `.zap/rules.tsv`)        | ZAP baseline                                   |
| 14.4.3 | A Content Security Policy                               | Met    | Per-request nonce, `strict-dynamic`, no inline or eval script                 | `proxy.test.ts`, `security.spec.ts`, ZAP 10038 |
| 14.4.4 | `X-Content-Type-Options: nosniff`                       | Met    | Web and API                                                                   | `security.spec.ts`, `app.e2e-spec.ts`          |
| 14.4.5 | HSTS                                                    | Met    | Set by the ALB, where TLS ends                                                | `terraform test`                               |
| 14.4.6 | A suitable `Referrer-Policy`                            | Met    | `strict-origin-when-cross-origin`; `no-referrer` on the reset page            | ZAP baseline                                   |
| 14.4.7 | Framing restricted                                      | Met    | `frame-ancestors 'none'` and `X-Frame-Options: DENY`                          | `security.spec.ts`                             |
| 14.5.3 | CORS `Origin` allow-list                                | Met    | Configured origins only                                                       | `app.e2e-spec.ts`                              |

## Gaps

- **4.3.1, multi-factor authentication for administrators.** Not implemented. The admin
  routes re-check `isAdmin` in the database on every call and are audited, which limits but
  does not replace a second factor. TOTP for admins is the next step.

## How this stays true

- **Every pull request:** gitleaks over the full history and the ZAP baseline against the
  production images. Any new ZAP warning fails the build unless `.zap/rules.tsv` ignores it, with
  a reason.
- **Every image:** a Trivy scan (`images.yml`).
- **Infrastructure:** a Trivy misconfiguration scan and `terraform test`.
