# ECS on Fargate (ADR-0005). The API and the worker share one image; the migrate task applies
# migrations before any service is updated.

resource "aws_ecs_cluster" "this" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enhanced" : "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

# Service Connect: tasks call each other by name (http://api:4000, http://ai-service:8000).
resource "aws_service_discovery_http_namespace" "this" {
  name        = local.name
  description = "Service Connect names for ${local.name}"
}

# ---------------------------------------------------------------- IAM

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

# Used by ECS itself: pull images, write logs, read this environment's parameters.
resource "aws_iam_role" "execution" {
  name                 = "${local.name}-ecs-execution"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_parameters" {
  statement {
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:${local.region}:${local.account_id}:parameter/${local.name}/*"]
  }
}

resource "aws_iam_role_policy" "execution_parameters" {
  name   = "read-parameters"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution_parameters.json
}

# Used by the application code. Only the API and the worker call AWS (S3 and SES).
resource "aws_iam_role" "task" {
  for_each             = toset(["app", "web", "ai-service", "migrate"])
  name                 = "${local.name}-${each.key}"
  assume_role_policy   = data.aws_iam_policy_document.ecs_tasks_assume.json
  permissions_boundary = var.permissions_boundary_arn
}

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "Attachments"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.attachments.arn}/*"]
  }
  statement {
    sid       = "Email"
    actions   = ["ses:SendEmail"]
    resources = [aws_ses_domain_identity.this.arn]
    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.mail_from]
    }
  }
}

resource "aws_iam_role_policy" "app" {
  name   = "attachments-and-email"
  role   = aws_iam_role.task["app"].id
  policy = data.aws_iam_policy_document.app.json
}

# ---------------------------------------------------------------- Services

locals {
  service_defaults = {
    cluster_name                  = aws_ecs_cluster.this.name
    cluster_arn                   = aws_ecs_cluster.this.arn
    region                        = local.region
    execution_role_arn            = aws_iam_role.execution.arn
    subnet_ids                    = module.network.private_subnet_ids
    service_connect_namespace_arn = aws_service_discovery_http_namespace.this.arn
  }

  node_health = ["CMD", "node", "-e"]

  app_environment = merge(
    {
      NODE_ENV              = "production"
      LOG_LEVEL             = "info"
      AWS_REGION            = local.region
      TRUST_PROXY_HOPS      = "1" # the ALB
      WEB_ORIGIN            = local.origin
      CORS_ORIGINS          = local.origin
      COOKIE_SECURE         = "true"
      S3_BUCKET             = aws_s3_bucket.attachments.bucket
      S3_REGION             = local.region
      MAIL_TRANSPORT        = "ses"
      MAIL_FROM             = "Forge <${local.mail_from}>"
      AI_SERVICE_URL        = "http://ai-service:8000"
      AI_DAILY_TOKEN_BUDGET = tostring(var.ai_daily_token_budget)
      CONFIG_REVISION       = local.config_revision
      SENTRY_ENVIRONMENT    = var.environment
    },
    local.github ? {
      GITHUB_APP_ID   = tostring(var.github_app.id)
      GITHUB_APP_SLUG = var.github_app.slug
    } : {},
  )

  app_secrets = merge(
    {
      DATABASE_URL     = module.data.parameter_arns.database_url
      JWT_PRIVATE_KEY  = aws_ssm_parameter.jwt_private_key.arn
      JWT_PUBLIC_KEY   = aws_ssm_parameter.jwt_public_key.arn
      AI_SERVICE_TOKEN = aws_ssm_parameter.ai_service_token.arn
    },
    local.running ? { REDIS_URL = module.data.parameter_arns.redis_url } : {},
    local.github ? {
      GITHUB_APP_PRIVATE_KEY = aws_ssm_parameter.external["github-app-private-key"].arn
      GITHUB_WEBHOOK_SECRET  = aws_ssm_parameter.external["github-webhook-secret"].arn
    } : {},
    local.sentry_secret,
  )

  sentry_secret = var.error_reporting ? { SENTRY_DSN = aws_ssm_parameter.external["sentry-dsn"].arn } : {}
}

module "api" {
  source = "../service"
  name   = "api"

  cluster_name                  = local.service_defaults.cluster_name
  cluster_arn                   = local.service_defaults.cluster_arn
  region                        = local.service_defaults.region
  execution_role_arn            = local.service_defaults.execution_role_arn
  subnet_ids                    = local.service_defaults.subnet_ids
  service_connect_namespace_arn = local.service_defaults.service_connect_namespace_arn

  image                = var.images.api
  cpu                  = var.sizes.api.cpu
  memory               = var.sizes.api.memory
  port                 = 4000
  environment          = local.app_environment
  secrets              = local.app_secrets
  health_check_command = concat(local.node_health, ["fetch('http://127.0.0.1:4000/api/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"])
  task_role_arn        = aws_iam_role.task["app"].arn
  security_group_ids   = [aws_security_group.task["api"].id]
  target_group_arn     = aws_lb_target_group.this["api"].arn
  service_connect_name = "api"

  create_service        = local.running
  desired_count         = var.sizes.api.count
  max_count             = var.sizes.api.max
  spot                  = var.sizes.api.spot
  wait_for_steady_state = var.wait_for_steady_state
  log_retention_days    = var.log_retention_days

  depends_on = [terraform_data.migrate, aws_lb_listener_rule.api]
}

module "worker" {
  source = "../service"
  name   = "worker"

  cluster_name                  = local.service_defaults.cluster_name
  cluster_arn                   = local.service_defaults.cluster_arn
  region                        = local.service_defaults.region
  execution_role_arn            = local.service_defaults.execution_role_arn
  subnet_ids                    = local.service_defaults.subnet_ids
  service_connect_namespace_arn = local.service_defaults.service_connect_namespace_arn

  # The API's image with the worker entry point (one image, one commit).
  image              = var.images.api
  command            = ["node", "dist/worker.js"]
  cpu                = var.sizes.worker.cpu
  memory             = var.sizes.worker.memory
  environment        = local.app_environment
  secrets            = local.app_secrets
  task_role_arn      = aws_iam_role.task["app"].arn
  security_group_ids = [aws_security_group.task["worker"].id]

  create_service        = local.running
  desired_count         = var.sizes.worker.count
  max_count             = var.sizes.worker.max
  spot                  = var.sizes.worker.spot
  wait_for_steady_state = var.wait_for_steady_state
  log_retention_days    = var.log_retention_days

  depends_on = [terraform_data.migrate]
}

module "ai_service" {
  source = "../service"
  name   = "ai-service"

  cluster_name                  = local.service_defaults.cluster_name
  cluster_arn                   = local.service_defaults.cluster_arn
  region                        = local.service_defaults.region
  execution_role_arn            = local.service_defaults.execution_role_arn
  subnet_ids                    = local.service_defaults.subnet_ids
  service_connect_namespace_arn = local.service_defaults.service_connect_namespace_arn

  image  = var.images["ai-service"]
  cpu    = var.sizes["ai-service"].cpu
  memory = var.sizes["ai-service"].memory
  port   = 8000
  environment = {
    NODE_ENV           = "production"
    AI_LOG_JSON        = "true"
    AI_PROVIDER        = var.ai_provider
    CONFIG_REVISION    = local.config_revision
    SENTRY_ENVIRONMENT = var.environment
  }
  secrets = merge(
    {
      AI_SERVICE_TOKEN = aws_ssm_parameter.ai_service_token.arn
      AI_DATABASE_URL  = module.data.parameter_arns.ai_database_url
    },
    var.ai_provider == "openai" ? { OPENAI_API_KEY = aws_ssm_parameter.external["openai-api-key"].arn } : {},
    local.sentry_secret,
  )
  health_check_command = ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/live', timeout=2).status == 200 else 1)"]
  task_role_arn        = aws_iam_role.task["ai-service"].arn
  security_group_ids   = [aws_security_group.task["ai-service"].id]
  # No load balancer route: only the API and the worker reach it (architecture §3).
  service_connect_name = "ai-service"

  create_service        = local.running
  desired_count         = var.sizes["ai-service"].count
  max_count             = var.sizes["ai-service"].max
  spot                  = var.sizes["ai-service"].spot
  wait_for_steady_state = var.wait_for_steady_state
  log_retention_days    = var.log_retention_days

  depends_on = [terraform_data.migrate]
}

module "web" {
  source = "../service"
  name   = "web"

  cluster_name                  = local.service_defaults.cluster_name
  cluster_arn                   = local.service_defaults.cluster_arn
  region                        = local.service_defaults.region
  execution_role_arn            = local.service_defaults.execution_role_arn
  subnet_ids                    = local.service_defaults.subnet_ids
  service_connect_namespace_arn = local.service_defaults.service_connect_namespace_arn

  # The image's API_INTERNAL_URL (http://api:4000) resolves through Service Connect.
  image                = var.images.web
  cpu                  = var.sizes.web.cpu
  memory               = var.sizes.web.memory
  port                 = 3000
  health_check_command = concat(local.node_health, ["fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"])
  task_role_arn        = aws_iam_role.task["web"].arn
  security_group_ids   = [aws_security_group.task["web"].id]
  target_group_arn     = aws_lb_target_group.this["web"].arn

  create_service        = local.running
  desired_count         = var.sizes.web.count
  max_count             = var.sizes.web.max
  spot                  = var.sizes.web.spot
  wait_for_steady_state = var.wait_for_steady_state
  log_retention_days    = var.log_retention_days

  depends_on = [aws_lb_listener.https]
}

# ---------------------------------------------------------------- Migrations

module "migrate" {
  source = "../service"
  name   = "migrate"

  cluster_name       = local.service_defaults.cluster_name
  cluster_arn        = local.service_defaults.cluster_arn
  region             = local.service_defaults.region
  execution_role_arn = local.service_defaults.execution_role_arn

  image   = var.images.migrate
  command = ["sh", "-c", "prisma migrate deploy && tsx prisma/ai-login.ts"]
  cpu     = 512
  memory  = 1024
  environment = {
    # Prisma's migrate engine verifies the database certificate against this bundle.
    SSL_CERT_FILE = "/opt/rds-global-bundle.pem"
  }
  secrets = {
    DATABASE_URL   = module.data.parameter_arns.database_url
    AI_DB_PASSWORD = module.data.parameter_arns.ai_db_password
  }
  task_role_arn      = aws_iam_role.task["migrate"].arn
  create_service     = false
  log_retention_days = var.log_retention_days
}

# Runs the migrate task whenever its definition changes (a new image), and fails the apply if
# it fails, before the services above are updated.
resource "terraform_data" "migrate" {
  count            = var.run_migrations && local.running ? 1 : 0
  triggers_replace = [module.migrate.task_definition_arn, var.secret_versions.database]

  provisioner "local-exec" {
    command = "${path.module}/scripts/run-migrations.sh"
    environment = {
      AWS_REGION      = local.region
      CLUSTER         = aws_ecs_cluster.this.name
      TASK_DEFINITION = module.migrate.task_definition_arn
      SUBNETS         = join(",", module.network.private_subnet_ids)
      SECURITY_GROUP  = aws_security_group.task["migrate"].id
      LOG_GROUP       = module.migrate.log_group_name
    }
  }

  depends_on = [module.data, module.network, aws_iam_role_policy.execution_parameters]
}
