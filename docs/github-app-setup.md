# GitHub App setup

Forge reads GitHub through its own **GitHub App** (ADR-0008): installation-scoped, read-only,
and revocable by the GitHub account that installed it. The integration is optional. Without it,
the Code tab shows any data synced earlier, and nothing else in Forge changes.

## 1. Register the App

On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App** (or an
organisation's settings for an org-owned App).

| Field                                 | Value                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| GitHub App name                       | e.g. `forge-yourname-dev` (the URL slug becomes `GITHUB_APP_SLUG`)                   |
| Homepage URL                          | your web origin, e.g. `http://localhost:3000`                                        |
| Setup URL (under "Post installation") | `<WEB_ORIGIN>/github`. GitHub redirects here with `?installation_id=…`               |
| Redirect on update                    | ✓                                                                                    |
| Webhook → Active                      | ✓                                                                                    |
| Webhook URL                           | `<public API origin>/api/v1/webhooks/github` (see [local webhooks](#local-webhooks)) |
| Webhook secret                        | `openssl rand -hex 32` → `GITHUB_WEBHOOK_SECRET`                                     |
| Where can this App be installed?      | "Only on this account" is enough for a single-organisation deployment                |

**Repository permissions** (all **read-only**): Contents, Issues, Metadata, Pull requests.
Nothing else, and no account permissions.

**Subscribe to events:** Issues, Pull request, Push, Repository. Installation events are sent
to every App automatically.

After creating it, note the **App ID**, and under **Private keys** generate a key; GitHub
downloads a `.pem` file.

## 2. Configure Forge

```bash
GITHUB_APP_ID=123456
GITHUB_APP_SLUG=forge-yourname-dev
GITHUB_APP_PRIVATE_KEY="$(awk 'NF {sub(/\r/, ""); printf "%s\\n", $0}' forge.private-key.pem)"
GITHUB_WEBHOOK_SECRET=<the webhook secret>
```

All four or none: the API refuses to start with a partial set, and a malformed key fails at
startup rather than at the first sync. In AWS these come from SSM Parameter Store (Phase 16);
the private key never goes into the database. Optional tuning:

| Variable                    | Default                  | Meaning                                                                              |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `GITHUB_RATE_LIMIT_RESERVE` | `200`                    | Requests per installation that background sync leaves for interactive use            |
| `GITHUB_SYNC_MAX_PAGES`     | `10`                     | Pages of 100 per resource per sync, which bounds the first sync of huge repositories |
| `GITHUB_API_URL`            | `https://api.github.com` | GitHub Enterprise Server: `https://<host>/api/v3`                                    |

Restart the API and the worker.

## 3. Connect and link

1. Sign in as a Forge **administrator** and open **GitHub** in the top bar.
2. **Install on GitHub**, then choose the account and the repositories to grant.
3. GitHub redirects back to `/github`. Forge confirms the installation with GitHub (as the App)
   and the worker fetches its repository list.
4. In a project, a **project manager** opens **Code → Link repository**. The first sync
   runs in the background; the card shows its progress.

From then on, webhooks keep it current, and an hourly reconciliation job catches anything a
missed delivery left behind.

Mention an issue key such as `PAY-123` in a PR title, description or branch name, or in a commit
message, and it appears in that issue's **Development** panel. The assignee (or, without one,
the reporter) is notified when a PR mentioning their issue is opened.

## Local webhooks

GitHub cannot reach `localhost`. Either rely on reconciliation (hourly), use **Sync now** on the
Code tab, or forward deliveries with [smee.io](https://smee.io):

```bash
npx smee-client --url https://smee.io/<your-channel> --target http://localhost:4000/api/v1/webhooks/github
```

and set the App's webhook URL to the smee channel. Signatures are computed by GitHub and checked
by the API, so the relay cannot forge deliveries.

## Troubleshooting

| Symptom                                            | Cause                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Webhook deliveries show **401** on GitHub          | `GITHUB_WEBHOOK_SECRET` differs from the App's secret                               |
| "GitHub does not know that installation"           | The installation belongs to a different App (check `GITHUB_APP_ID` and the key)     |
| Repository card: **Waiting for GitHub rate limit** | The installation reached the reserve; the sync resumes on its own at the reset time |
| Repository card: **Sync failed**, 404              | The App was uninstalled or lost access to the repository; reinstall or unlink it    |

Every delivery is stored for 14 days in `github_webhook_deliveries` with its processing result,
which is the first place to look.
