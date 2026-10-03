# Deploying to AWS

Forge runs on ECS Fargate behind an Application Load Balancer, with RDS PostgreSQL (pgvector),
ElastiCache Redis, S3 for attachments, SES for email and SSM Parameter Store for secrets
([architecture §10](architecture.md#10-deployment-architecture-aws),
[ADR-0005](adr/0005-aws-ecs-fargate-cost-aware.md)). Everything is Terraform in
`infrastructure/terraform`; CI deploys through GitHub OIDC, with no long-lived AWS keys.

> **Status.** The infrastructure code, the deploy workflow and the images are complete and
> verified without an AWS account (see [Verified](#verified)). Producing the live URL needs the
> one-time setup below in an AWS account with a Route 53 hosted zone; after that, every merge to
> `main` deploys.

## Layout

```
infrastructure/terraform/
├── bootstrap/            # once per account: state bucket, ECR, GitHub OIDC, deploy roles, boundary
├── modules/
│   ├── network/          # VPC, 2 AZs, public/private subnets, fck-nat or NAT Gateway, S3 endpoint
│   ├── data/             # RDS PostgreSQL 16, ElastiCache Redis, their connection secrets
│   ├── service/          # one ECS service: task definition, logs, Service Connect, autoscaling
│   └── stack/            # one environment: the above + ALB, ACM, Route 53, S3, SES, IAM, alarms
│       └── tests/        # `terraform test` with a mocked AWS provider
└── environments/
    ├── dev/              # deployed by .github/workflows/deploy.yml
    └── prod/             # the same stack sized for availability (not deployed in this project)
```

| Piece              | dev                                           | prod (tfvars)                         |
| ------------------ | --------------------------------------------- | ------------------------------------- |
| Egress             | fck-nat on a `t4g.nano`                       | Managed NAT Gateway                   |
| api                | 0.5 vCPU / 1 GB, 1 task, Fargate Spot         | 1 vCPU / 2 GB, 2–6 tasks (CPU target) |
| worker, ai-service | 0.25 vCPU / 0.5 GB, 1 task each, Fargate Spot | 2–4 tasks, Fargate Spot               |
| web                | 0.25 vCPU / 0.5 GB, 1 task, Fargate Spot      | 2–4 tasks, on-demand                  |
| PostgreSQL         | `db.t4g.micro`, single-AZ, 7-day backups      | `db.t4g.medium`, Multi-AZ, 14 days    |
| Redis              | `cache.t4g.micro`, no replica                 | One replica, Multi-AZ failover        |
| Protection         | Off: `terraform destroy` removes everything   | Deletion protection, final snapshot   |

## One-time setup

You need an AWS account, a public Route 53 hosted zone (for example `example.com`), Terraform
1.11 or later and the AWS CLI, signed in as an administrator for the first step only.

**1. Bootstrap the account** (local state; keep `terraform.tfstate` somewhere safe):

```sh
cd infrastructure/terraform/bootstrap
terraform init
terraform apply -var region=eu-west-2
terraform output    # state_bucket, deploy_role_arns, ecr_registry
```

**2. Configure GitHub** (repository Settings → Environments and Variables):

| Where                    | Variable              | Value                                                     |
| ------------------------ | --------------------- | --------------------------------------------------------- |
| Repository variable      | `TF_STATE_BUCKET`     | `state_bucket` from step 1 (its presence enables deploys) |
| Repository variable      | `AWS_REGION`          | `eu-west-2`                                               |
| Environment `dev`        | `AWS_DEPLOY_ROLE_ARN` | `deploy_role_arns.dev` from step 1                        |
| Environment `dev`        | `FORGE_DOMAIN`        | Where the app is served, e.g. `forge.example.com`         |
| Environment `dev`        | `FORGE_HOSTED_ZONE`   | The hosted zone, e.g. `example.com`                       |
| Environment `dev` (opt.) | `FORGE_ALARM_EMAIL`   | Receives alarms (confirm the subscription email once)     |

The deploy role trusts only `repo:<owner>/<repo>:environment:dev`, so only jobs running in the
`dev` environment can assume it. Required reviewers or a branch rule on that environment add a
human gate.

**3. Deploy.** Merge to `main`: the Images workflow builds, scans and signs the images, and the
Deploy workflow then ships them. Or run **Deploy** by hand with a commit SHA from `main`.

**4. Optional integrations.** Real AI and the GitHub App read secrets an operator sets once; set
the variable in `environments/dev/terraform.tfvars`, deploy, put the values, deploy again:

```sh
# ai_provider = "openai"
aws ssm put-parameter --overwrite --type SecureString \
  --name /forge-dev/openai-api-key --value "$OPENAI_API_KEY"

# github_app = { id = 123456, slug = "forge-dev" }   (docs/github-app-setup.md)
aws ssm put-parameter --overwrite --type SecureString \
  --name /forge-dev/github-app-private-key --value "$(cat forge.private-key.pem)"
aws ssm put-parameter --overwrite --type SecureString \
  --name /forge-dev/github-webhook-secret --value "$WEBHOOK_SECRET"

# error_reporting = true   (docs/observability.md#errors)
aws ssm put-parameter --overwrite --type SecureString \
  --name /forge-dev/sentry-dsn --value "$SENTRY_DSN"
```

**5. Email.** SES verifies the domain through the DKIM records Terraform creates. A new SES
account is in the sandbox and delivers only to verified addresses until you request production
access; until then password-reset emails to other addresses are retried and dead-lettered.

## How a deploy works

```mermaid
sequenceDiagram
    participant GH as Deploy workflow
    participant GHCR as ghcr.io
    participant ECR as ECR
    participant TF as terraform apply
    participant ECS as ECS
    GH->>GHCR: digest of forge-*:sha-<commit>
    GH->>GHCR: gh attestation verify (signed by images.yml in this repo)
    GH->>ECR: crane copy by digest (immutable sha-<commit> tag)
    GH->>TF: images = { api = ecr/forge-api@sha256:… , … }
    TF->>ECS: register task definitions
    TF->>ECS: run the migrate task and wait (prisma migrate deploy, AI login)
    Note over TF,ECS: a failed migration fails the apply; no service changes
    TF->>ECS: update services (rolling, circuit breaker with rollback)
    TF-->>GH: wait for steady state
    GH->>GH: smoke test /api/v1/health/ready and /login over HTTPS
```

- **What runs is what was scanned.** Images are referenced by digest (a tag is refused by
  variable validation), copied with their digest intact, and only after their provenance is
  verified.
- **Migrations before code.** A `terraform_data` resource runs the migrate task whenever its
  task definition changes and fails the apply if it exits non-zero; every service depends on it.
- **Safe rollouts.** Each service keeps 100% healthy capacity during a deployment, and ECS rolls
  back a deployment whose tasks never become healthy. `wait_for_steady_state` makes the apply
  (and the workflow) fail when that happens.

## Secrets

| SSM parameter (`/forge-dev/…`)                    | Created by                     | Read by                     |
| ------------------------------------------------- | ------------------------------ | --------------------------- |
| `database-url`                                    | Terraform (generated password) | api, worker, migrate        |
| `ai-database-url`                                 | Terraform (generated password) | ai-service                  |
| `ai-db-password`                                  | Terraform (generated password) | migrate (creates the login) |
| `redis-url`                                       | Terraform (generated token)    | api, worker                 |
| `jwt-private-key`, `jwt-public-key`               | Terraform (ES256 key pair)     | api, worker                 |
| `ai-service-token`                                | Terraform (generated)          | api, worker, ai-service     |
| `openai-api-key`                                  | Operator, when enabled         | ai-service                  |
| `github-app-private-key`, `github-webhook-secret` | Operator, when enabled         | api, worker                 |

- **No secret is ever in Terraform state or a plan.** Generated values come from ephemeral
  resources (`ephemeral "random_password"`, `ephemeral "tls_private_key"`) and are written only
  through write-only arguments (`password_wo`, `auth_token_wo`, `value_wo`). The state bucket
  therefore holds no credentials. Operator secrets are created with a placeholder and never read.
- **Tasks get secrets by reference.** Task definitions list SSM ARNs; ECS injects the values at
  start. No secret is a plain environment variable (asserted by the Terraform tests).
- **Rotation.** Bump a number in `secret_versions` (for example `database = 2`) and deploy: a new
  value is generated, written to the database and SSM together, the migrate task re-runs (which
  updates the AI login), and every task definition changes so running tasks are replaced.
  Rotating `jwt` signs everybody out.

## Database TLS

RDS is configured with `rds.force_ssl = 1`, and every client verifies the server's certificate
against Amazon's RDS CA bundle, which each image carries at `/opt/rds-global-bundle.pem` (added
in the Dockerfiles, pinned by SHA-256). Testing against a TLS-only PostgreSQL with a private CA
showed the three drivers need different settings:

| Client                       | Verifies with                                 | Ignores                         |
| ---------------------------- | --------------------------------------------- | ------------------------------- |
| node-pg (API, worker, seed)  | `sslmode=verify-full&sslrootcert=<bundle>`    | `sslaccept`                     |
| Prisma migrate engine        | `sslaccept=strict` + `SSL_CERT_FILE=<bundle>` | `sslrootcert` (accepted any CA) |
| psycopg / libpq (AI service) | `sslmode=verify-full&sslrootcert=<bundle>`    |                                 |

Prisma's engine also reads only the first certificate of a file passed as `sslcert`, so the
100-plus-certificate RDS bundle has to come through `SSL_CERT_FILE` instead. The API, worker and
migrate task therefore share one URL,
`…?sslmode=verify-full&sslrootcert=/opt/rds-global-bundle.pem&sslaccept=strict`, with
`SSL_CERT_FILE` set on the migrate task. Each combination was checked to reject an untrusted CA
and a mismatched hostname.

When Amazon publishes a new bundle (new CAs are added years ahead of use), the image build fails
on the checksum. That is deliberate: review the new bundle, then update the three
`ADD --checksum` lines.

## Hibernate, wake and teardown

Run **Deploy** with _hibernate_ checked (or `terraform apply -var hibernate=true`). It removes
the services, the load balancer, the NAT and Redis, and stops the database. Kept: the database
(stopped), attachments, images, secrets, DNS zone and certificate. Running Deploy again without
the box wakes everything; the migrations run first as usual.

- Queued jobs in Redis are lost on hibernation; the outbox in PostgreSQL is the source of truth
  for events, and the worker re-queues the index backfill on start.
- AWS starts a stopped RDS instance again after seven days. Run hibernate again to stop it.

**Teardown** (dev has deletion protection off):

```sh
cd infrastructure/terraform/environments/dev
terraform init -backend-config="bucket=$TF_STATE_BUCKET" -backend-config="region=eu-west-2"
# Nothing is pulled during a destroy, so any digest-pinned references satisfy `images`.
d="@sha256:$(printf '0%.0s' {1..64})"
terraform destroy -var "images={api=\"x$d\",migrate=\"x$d\",web=\"x$d\",ai-service=\"x$d\"}"
# The account-level pieces last: in bootstrap/, set ecr_force_delete = true, remove the state
# bucket's prevent_destroy, and destroy (after copying away anything you want to keep).
```

## Cost

Approximate eu-west-2 list prices, before free tier and tax; check the
[AWS Pricing Calculator](https://calculator.aws/) before relying on them. Fargate Spot is
assumed at a 65% discount, which varies.

| Item                                          | Running (≈/month) | Hibernated   |
| --------------------------------------------- | ----------------- | ------------ |
| Fargate: api, worker, web, ai-service on Spot | $18               | $0           |
| Application Load Balancer (+ minimal LCUs)    | $20               | $0           |
| Public IPv4 addresses (ALB ×2, NAT ×1)        | $11               | $0           |
| RDS `db.t4g.micro` + 20 GB gp3                | $16               | $3 (storage) |
| ElastiCache `cache.t4g.micro`                 | $13               | $0           |
| fck-nat `t4g.nano`                            | $4                | $0           |
| CloudWatch logs and 7 alarms, Route 53, ECR   | $3                | $1           |
| **Total**                                     | **≈ $85**         | **≈ $4**     |

This is above the ~$75 target in NFR-11. The original estimate (ADR-0005) predates AWS charging
for public IPv4 addresses, which adds about $11. The levers, in order of effect: hibernate
outside demos (≈ $4); arm64 images, since Fargate on Graviton is about 20% cheaper (it needs
multi-platform builds in `images.yml`); and a cheaper region such as us-east-1. The NAT cannot
simply be dropped: tasks pull images and read secrets through it, and the VPC endpoints that
would replace it cost more than fck-nat.

## Operating

```sh
aws logs tail /forge-dev/api --follow                 # also worker, web, ai-service, migrate
aws ecs describe-services --cluster forge-dev --services api worker web ai-service \
  --query 'services[].{name:serviceName,running:runningCount,desired:desiredCount,rollout:deployments[0].rolloutState}'
```

Alarms (SNS topic `forge-dev-alarms`): API 5xx, API p95 latency, unhealthy API or web targets,
database CPU and free storage, and Redis memory (Redis is set to `noeviction`, so a full Redis
rejects new jobs rather than silently dropping queued ones).

The CloudWatch dashboard `forge-dev` shows the same at a glance: requests and 5xx, API p95,
healthy targets, CPU and memory per service, database CPU and connections, Redis memory. The
detailed application metrics (routes, queues, model calls) and the request-ID correlation are
described in [observability](observability.md).

## Verified

Without an AWS account (no credentials were available while building this phase):

- `terraform validate` on every root, `terraform fmt`, and Trivy's misconfiguration scan with no
  High or Critical findings (the remaining Medium and Low ones are listed in
  [security](security.md#aws-deployment)).
- `terraform test` (`modules/stack/tests`, mocked AWS provider, real `random` and `tls`): six
  runs covering HTTPS-only entry, the `/api/*` route, private tasks, who may reach the AI
  service, the private and encrypted data tier, the public-access block, secrets by reference
  only, the worker entry point, alarms, hibernation, the operator secrets, and the refusal of
  images that are not pinned by digest. 11 of 11 deliberate breakages were caught.
- A rehearsal of the AWS configuration with the real images: a TLS-only PostgreSQL with a
  private CA standing in for RDS, read-only root filesystems with only `/tmp` writable, and the
  exact environment of each task definition. The migrate command applied every migration and
  created the AI login (and was a no-op the second time); the API was ready with the database
  and Redis; the AI service was ready as `forge_ai_service`; the web app reached the API through
  `http://api:4000`; a registration was written over a verified TLS connection.
- The AI login script and the SES mail transport have their own tests
  (`test/integration/ai-login.int-spec.ts`, `src/mail/mailer.service.spec.ts`).

Not yet verified: the apply itself against AWS, IAM policy completeness for the deploy role (a
missing permission would show up as an `AccessDenied` in the first apply), and SES delivery.
