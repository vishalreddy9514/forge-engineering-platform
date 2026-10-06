# Plan-level tests for one environment, with mocked providers: no AWS account or credentials.
# They pin the properties the architecture and security docs promise (docs/deployment.md).
# Run: cd infrastructure/terraform/modules/stack && terraform init -backend=false && terraform test

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_region" {
    defaults = { region = "eu-west-2" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-west-2a", "eu-west-2b", "eu-west-2c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
  mock_data "aws_route53_zone" {
    defaults = { zone_id = "Z0123456789ABCDEFGHIJ" }
  }
  mock_data "aws_ami" {
    defaults = { id = "ami-0123456789abcdef0" }
  }
  mock_data "aws_elb_service_account" {
    defaults = { arn = "arn:aws:iam::652711504416:root" }
  }
  # Provider validation still runs on mocked values: ARNs used as arguments must look real.
  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:eu-west-2:123456789012:forge-dev-alarms" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::123456789012:role/forge-dev-mock" }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = { arn = "arn:aws:ecs:eu-west-2:123456789012:cluster/forge-dev" }
  }
  mock_resource "aws_lb_target_group" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-2:123456789012:targetgroup/forge-dev/0123456789abcdef" }
  }
  mock_resource "aws_lb" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-2:123456789012:loadbalancer/app/forge-dev/0123456789abcdef" }
  }
  mock_resource "aws_lb_listener" {
    defaults = { arn = "arn:aws:elasticloadbalancing:eu-west-2:123456789012:listener/app/forge-dev/0123456789abcdef/0123456789abcdef" }
  }
  mock_resource "aws_ssm_parameter" {
    defaults = { arn = "arn:aws:ssm:eu-west-2:123456789012:parameter/forge-dev/mock" }
  }
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::forge-dev-attachments-123456789012" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:eu-west-2:123456789012:certificate/00000000-0000-0000-0000-000000000000"
      domain_validation_options = [{
        domain_name           = "forge.example.com"
        resource_record_name  = "_x1.forge.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_x2.acm-validations.aws."
      }]
    }
  }
  mock_resource "aws_service_discovery_http_namespace" {
    defaults = { arn = "arn:aws:servicediscovery:eu-west-2:123456789012:namespace/ns-mock" }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = { arn = "arn:aws:ecs:eu-west-2:123456789012:task-definition/forge-dev-mock:1" }
  }
  mock_resource "aws_ses_domain_dkim" {
    defaults = { dkim_tokens = ["dkim1", "dkim2", "dkim3"] }
  }
  mock_resource "aws_ses_domain_identity" {
    defaults = { arn = "arn:aws:ses:eu-west-2:123456789012:identity/forge.example.com" }
  }
}

# Distinct ARNs for the two database URLs, so the tests can tell which login a task gets.
override_resource {
  target = module.data.aws_ssm_parameter.database_url
  values = { arn = "arn:aws:ssm:eu-west-2:123456789012:parameter/forge-dev/database-url" }
}
override_resource {
  target = module.data.aws_ssm_parameter.app_database_url
  values = { arn = "arn:aws:ssm:eu-west-2:123456789012:parameter/forge-dev/app-database-url" }
}

# random and tls are local (no network or credentials), so the real ones generate the
# ephemeral secrets; Terraform's mocks do not support ephemeral resources.

variables {
  environment      = "dev"
  domain_name      = "forge.example.com"
  hosted_zone_name = "example.com"
  images = {
    api          = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-api@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    migrate      = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-migrate@sha256:2222222222222222222222222222222222222222222222222222222222222222"
    web          = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-web@sha256:3333333333333333333333333333333333333333333333333333333333333333"
    "ai-service" = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-ai-service@sha256:4444444444444444444444444444444444444444444444444444444444444444"
  }
  sizes = {
    api          = { cpu = 512, memory = 1024, count = 1, max = 1, spot = true }
    worker       = { cpu = 256, memory = 512, count = 1, max = 1, spot = true }
    web          = { cpu = 256, memory = 512, count = 1, max = 1, spot = true }
    "ai-service" = { cpu = 256, memory = 512, count = 1, max = 1, spot = true }
  }
  deletion_protection = false
}

# A mocked apply: every ID and ARN is known, so references between resources can be compared.
run "dev_running" {
  command = apply

  variables {
    run_migrations = false # the hook calls the AWS CLI; see "migrations_run_first"
  }

  assert {
    condition     = output.url == "https://forge.example.com"
    error_message = "The app is served over HTTPS on the configured domain."
  }

  # ---- Edge
  assert {
    condition     = aws_lb.this[0].drop_invalid_header_fields && !aws_lb.this[0].internal
    error_message = "The ALB is public and drops malformed headers."
  }
  assert {
    condition     = aws_lb_listener.http[0].default_action[0].type == "redirect" && aws_lb_listener.http[0].default_action[0].redirect[0].protocol == "HTTPS"
    error_message = "Port 80 only redirects to HTTPS."
  }
  assert {
    condition     = startswith(aws_lb_listener.https[0].ssl_policy, "ELBSecurityPolicy-TLS13")
    error_message = "HTTPS uses a TLS 1.2+/1.3 policy."
  }
  assert {
    condition     = flatten([for c in aws_lb_listener_rule.api[0].condition : [for p in c.path_pattern : p.values]]) == ["/api/*"]
    error_message = "/api/* goes to the API, as Nginx does locally."
  }

  # ---- Network placement: no task is reachable from the internet
  assert {
    condition = alltrue([
      for s in [module.api, module.worker, module.web, module.ai_service] : s.service_name != null
    ])
    error_message = "All four services exist when running."
  }
  assert {
    condition     = length([for r in aws_vpc_security_group_ingress_rule.task : r if r.cidr_ipv4 != null]) == 0
    error_message = "Task security groups only admit other security groups, never an address range."
  }
  assert {
    condition     = aws_vpc_security_group_ingress_rule.task["ai-from-api"].referenced_security_group_id == aws_security_group.task["api"].id
    error_message = "The API may call the AI service."
  }
  assert {
    condition = toset([
      for r in aws_vpc_security_group_ingress_rule.task : r.referenced_security_group_id if r.security_group_id == aws_security_group.task["ai-service"].id
    ]) == toset([aws_security_group.task["api"].id, aws_security_group.task["worker"].id])
    error_message = "Only the API and the worker reach the AI service; the load balancer never does."
  }

  # ---- Attachments bucket
  assert {
    condition = (
      aws_s3_bucket_public_access_block.attachments.block_public_acls &&
      aws_s3_bucket_public_access_block.attachments.block_public_policy &&
      aws_s3_bucket_public_access_block.attachments.ignore_public_acls &&
      aws_s3_bucket_public_access_block.attachments.restrict_public_buckets
    )
    error_message = "The attachments bucket blocks every form of public access."
  }
  assert {
    condition     = one(aws_s3_bucket_cors_configuration.attachments.cors_rule).allowed_origins == toset(["https://forge.example.com"])
    error_message = "Only the app's origin may upload with pre-signed URLs."
  }

  # ---- Secrets: generated values are write-only and never in the plan or state
  assert {
    condition = alltrue([
      for p in [aws_ssm_parameter.jwt_private_key, aws_ssm_parameter.jwt_public_key, aws_ssm_parameter.ai_service_token] :
      p.type == "SecureString" && p.value_wo_version == 1
    ])
    error_message = "Generated secrets are SecureStrings written through value_wo only."
  }
  assert {
    condition     = length(aws_ssm_parameter.external) == 0
    error_message = "No operator-supplied secrets exist unless OpenAI or the GitHub App is enabled."
  }

  # ---- Data tier: private, encrypted, TLS enforced
  assert {
    condition = (
      module.data.db_settings.storage_encrypted &&
      !module.data.db_settings.publicly_accessible &&
      module.data.db_settings.force_ssl == "1"
    )
    error_message = "PostgreSQL is private, encrypted at rest and refuses unencrypted connections."
  }
  assert {
    condition = (
      module.data.redis_settings.transit_encryption_enabled &&
      module.data.redis_settings.at_rest_encryption_enabled &&
      module.data.redis_settings.maxmemory_policy == "noeviction"
    )
    error_message = "Redis is encrypted in transit and at rest and never evicts queued jobs."
  }

  # ---- Task definitions: secrets by reference only
  assert {
    condition     = alltrue([for c in jsondecode(module.api.container_definitions) : length([for e in c.environment : e if contains(["DATABASE_URL", "REDIS_URL", "JWT_PRIVATE_KEY", "AI_SERVICE_TOKEN"], e.name)]) == 0])
    error_message = "No secret is ever a plain environment variable in a task definition."
  }
  assert {
    condition = (
      contains([for x in jsondecode(module.api.container_definitions)[0].secrets : x.name], "DATABASE_URL") &&
      { for e in jsondecode(module.api.container_definitions)[0].environment : e.name => e.value }["TRUST_PROXY_HOPS"] == "1" &&
      { for e in jsondecode(module.api.container_definitions)[0].environment : e.name => e.value }["MAIL_TRANSPORT"] == "ses"
    )
    error_message = "The API reads its database URL from SSM, trusts the ALB hop and sends mail through SES."
  }
  assert {
    condition = alltrue([
      for m in [module.api, module.worker] :
      { for x in jsondecode(m.container_definitions)[0].secrets : x.name => x.valueFrom }["DATABASE_URL"] == "arn:aws:ssm:eu-west-2:123456789012:parameter/forge-dev/app-database-url"
    ])
    error_message = "The API and worker connect as the least-privilege login, never as the schema owner."
  }
  assert {
    condition = (
      { for x in jsondecode(module.migrate.container_definitions)[0].secrets : x.name => x.valueFrom }["DATABASE_URL"] == "arn:aws:ssm:eu-west-2:123456789012:parameter/forge-dev/database-url" &&
      contains([for x in jsondecode(module.migrate.container_definitions)[0].secrets : x.name], "APP_DB_PASSWORD") &&
      strcontains(jsondecode(module.migrate.container_definitions)[0].command[2], "prisma/db-logins.ts")
    )
    error_message = "Only the migrate task holds the owner URL, and it creates the service logins after migrating."
  }
  assert {
    condition     = jsondecode(module.worker.container_definitions)[0].command == ["node", "dist/worker.js"]
    error_message = "The worker is the API image with the worker entry point."
  }

  # ---- Infrastructure audit logs (Phase 18)
  assert {
    condition = (
      aws_lb.this[0].access_logs[0].enabled &&
      aws_lb.this[0].access_logs[0].bucket == aws_s3_bucket.logs.id &&
      aws_s3_bucket_logging.attachments.target_bucket == aws_s3_bucket.logs.id &&
      aws_flow_log.vpc.traffic_type == "REJECT" &&
      aws_flow_log.vpc.log_destination == "${aws_s3_bucket.logs.arn}/vpc/"
    )
    error_message = "Load balancer requests, attachment object access and rejected VPC traffic are logged to the log bucket."
  }
  assert {
    condition = (
      aws_s3_bucket_public_access_block.logs.block_public_policy &&
      aws_s3_bucket_public_access_block.logs.restrict_public_buckets &&
      aws_s3_bucket_lifecycle_configuration.logs.rule[0].expiration[0].days == 90
    )
    error_message = "The log bucket is private and its logs expire."
  }
  assert {
    condition     = startswith(aws_lb_listener.https[0].routing_http_response_strict_transport_security_header_value, "max-age=31536000")
    error_message = "HTTPS responses carry HSTS for a year."
  }

  # ---- Dashboard
  assert {
    condition     = length(aws_cloudwatch_dashboard.this) == 1 && length(jsondecode(aws_cloudwatch_dashboard.this[0].dashboard_body).widgets) == 7
    error_message = "One CloudWatch dashboard: load balancer, services and data stores."
  }

  # ---- Alarms
  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.this)) == toset(["api-5xx", "api-latency-p95", "api-unhealthy", "web-unhealthy", "db-cpu", "db-storage", "redis-memory"])
    error_message = "The paging alarms exist."
  }
  assert {
    condition     = aws_cloudwatch_metric_alarm.this["api-latency-p95"].extended_statistic == "p95"
    error_message = "Latency alarms on the 95th percentile."
  }
}

run "migrations_run_first" {
  command = plan

  assert {
    condition     = length(terraform_data.migrate) == 1
    error_message = "The migrate task runs on every new migrate image, before services are updated."
  }
}

run "dev_hibernated" {
  command = plan

  variables {
    hibernate = true
  }

  assert {
    condition = alltrue([
      for s in [module.api, module.worker, module.web, module.ai_service] : s.service_name == null
    ])
    error_message = "No service runs while hibernated."
  }
  assert {
    condition     = length(aws_lb.this) == 0 && length(aws_route53_record.app) == 0
    error_message = "The load balancer (the largest fixed cost) is removed."
  }
  assert {
    condition     = length(aws_cloudwatch_dashboard.this) == 0
    error_message = "No dashboard for resources that do not exist while hibernated."
  }
  assert {
    condition     = length(terraform_data.migrate) == 0 && length(aws_cloudwatch_metric_alarm.this) == 0
    error_message = "Nothing tries to migrate or alarm while hibernated."
  }
  assert {
    condition     = output.load_balancer_dns_name == null
    error_message = "No load balancer address while hibernated."
  }
}

run "integrations_enabled" {
  command = plan

  variables {
    ai_provider     = "openai"
    github_app      = { id = 123456, slug = "forge-dev" }
    error_reporting = true
  }

  assert {
    condition     = toset(keys(aws_ssm_parameter.external)) == toset(["openai-api-key", "github-app-private-key", "github-webhook-secret", "sentry-dsn"])
    error_message = "Each external secret gets an operator-set parameter."
  }
  assert {
    condition     = output.operator_parameters == ["/forge-dev/github-app-private-key", "/forge-dev/github-webhook-secret", "/forge-dev/openai-api-key", "/forge-dev/sentry-dsn"]
    error_message = "The parameters an operator must set are listed in the outputs."
  }
}

run "images_must_be_pinned_by_digest" {
  command = plan

  variables {
    images = {
      api          = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-api:latest"
      migrate      = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-migrate@sha256:2222222222222222222222222222222222222222222222222222222222222222"
      web          = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-web@sha256:3333333333333333333333333333333333333333333333333333333333333333"
      "ai-service" = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-ai-service@sha256:4444444444444444444444444444444444444444444444444444444444444444"
    }
  }

  expect_failures = [var.images]
}

run "every_image_is_required" {
  command = plan

  variables {
    images = {
      api = "123456789012.dkr.ecr.eu-west-2.amazonaws.com/forge-api@sha256:1111111111111111111111111111111111111111111111111111111111111111"
    }
  }

  expect_failures = [var.images]
}
