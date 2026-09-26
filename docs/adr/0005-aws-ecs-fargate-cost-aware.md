# ADR-0005: Cost-aware AWS deployment on ECS Fargate

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

The project must run on AWS with realistic networking, compute, database, storage, secrets,
logging and monitoring, on a student budget. It runs four containers plus Postgres (with
pgvector) and Redis.

## Decision

- **ECS on Fargate** in private subnets across 2 AZs behind an **ALB** (HTTPS via ACM). The
  worker and ai-service use **Fargate Spot**. ai-service is reached through ECS Service Connect
  and has no ALB route.
- **RDS PostgreSQL 16** (pgvector is supported natively), `db.t4g.micro`, single-AZ in dev.
- **ElastiCache Redis** `cache.t4g.micro`.
- **S3** for attachments (private, SSE, pre-signed URLs), **ECR** for images, **SSM Parameter
  Store** SecureStrings for secrets, **CloudWatch** for logs, metrics and alarms.
- Egress through a **NAT instance** (fck-nat, `t4g.nano`) instead of a managed NAT Gateway.
- A `scale_to_zero` Terraform variable sets every service to `desired_count = 0`, and a script
  stops RDS.
- CI deploys through **GitHub OIDC** → an IAM role; no static AWS keys.

## Alternatives considered

| Option                      | Why not                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EKS                         | ~$73/month control plane before any workload; Kubernetes operations aren't the skill being demonstrated here                                                                   |
| Single EC2 + Docker Compose | Cheapest (~$15/month), but no managed DB backups, no rolling deploys, no health-based replacement. It would be documented as the budget option, not the reference architecture |
| App Runner                  | No private networking to ElastiCache without VPC connectors, less control, and service discontinuation risk                                                                    |
| Lambda                      | Long-lived SSE streams and BullMQ workers are a poor fit                                                                                                                       |
| Managed NAT Gateway         | ~$32/month + $0.045/GB, which is the single largest line item for a small dev environment                                                                                      |

## Consequences

- ➕ Estimated ~$60–75/month when running and about $5/month when scaled to zero.
- ➕ Everything is Terraform, so a production environment is the same modules with different `tfvars`.
- ➖ fck-nat is a single instance, and a failure breaks outbound calls (GitHub, OpenAI) but not
  serving. That is acceptable for dev; prod `tfvars` switch to a NAT Gateway.
- ➖ Fargate Spot tasks can be interrupted. The worker is idempotent and BullMQ re-delivers
  stalled jobs.
