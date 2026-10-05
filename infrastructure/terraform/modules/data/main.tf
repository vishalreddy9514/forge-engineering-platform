# PostgreSQL 16 (pgvector) and Redis, private, encrypted at rest and in transit. Their passwords
# are ephemeral: generated during apply, written only to write-only arguments (RDS, ElastiCache,
# SSM), and never stored in Terraform state.

locals {
  # Every image that talks to RDS carries Amazon's CA bundle at this path (apps/*/Dockerfile).
  rds_ca = "/opt/rds-global-bundle.pem"
  # verify-full + sslrootcert: node-pg and libpq (psycopg). sslaccept=strict: Prisma's migrate
  # engine, which verifies against SSL_CERT_FILE instead (docs/deployment.md).
  app_tls = "sslmode=verify-full&sslrootcert=${local.rds_ca}&sslaccept=strict"
  ai_tls  = "sslmode=verify-full&sslrootcert=${local.rds_ca}"
}

# ---------------------------------------------------------------- PostgreSQL

ephemeral "random_password" "db" {
  length  = 40
  special = false
}

ephemeral "random_password" "ai_db" {
  length  = 40
  special = false
}

ephemeral "random_password" "app_db" {
  length  = 40
  special = false
}

resource "aws_security_group" "db" {
  name        = "${var.name}-db"
  description = "PostgreSQL: reachable from the application tasks only"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-db" }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_clients" {
  for_each                     = var.db_client_security_groups
  security_group_id            = aws_security_group.db.id
  description                  = "PostgreSQL from application tasks"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name   = "${var.name}-postgres16"
  family = "postgres16"

  # Refuse unencrypted connections.
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Slow-query log (ms) for the performance work in Phase 19.
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.db_instance_class

  db_name             = "forge"
  username            = "forge"
  password_wo         = ephemeral.random_password.db.result
  password_wo_version = var.secret_versions.database

  allocated_storage     = var.db_storage_gb
  max_allocated_storage = var.db_max_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"
  publicly_accessible    = false
  multi_az               = var.db_multi_az

  backup_retention_period         = var.db_backup_retention_days
  copy_tags_to_snapshot           = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = !var.deletion_protection
  final_snapshot_identifier       = "${var.name}-final"
  auto_minor_version_upgrade      = true
  enabled_cloudwatch_logs_exports = ["postgresql"]
  apply_immediately               = !var.deletion_protection

  #trivy:ignore:AVD-AWS-0176 IAM database authentication is not used: tasks get a password from SSM
  iam_database_authentication_enabled = false
  #trivy:ignore:AVD-AWS-0133 Performance Insights is optional; CloudWatch metrics and the slow-query log cover dev
  performance_insights_enabled = var.db_performance_insights
}

# Hibernation stops the instance instead of deleting it (AWS starts it again after 7 days).
resource "aws_rds_instance_state" "this" {
  identifier = aws_db_instance.this.identifier
  state      = var.hibernate ? "stopped" : "available"
}

# ---------------------------------------------------------------- Redis (BullMQ, caches)

ephemeral "random_password" "redis" {
  length  = 40
  special = false
}

resource "aws_security_group" "redis" {
  name        = "${var.name}-redis"
  description = "Redis: reachable from the application tasks only"
  vpc_id      = var.vpc_id
  tags        = { Name = "${var.name}-redis" }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_clients" {
  for_each                     = var.redis_client_security_groups
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis from application tasks"
  referenced_security_group_id = each.value
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_elasticache_parameter_group" "this" {
  name   = "${var.name}-redis7"
  family = "redis7"

  # BullMQ stores jobs in Redis: evicting keys would silently lose them.
  parameter {
    name  = "maxmemory-policy"
    value = "noeviction"
  }
}

resource "aws_elasticache_replication_group" "this" {
  count                = var.hibernate ? 0 : 1
  replication_group_id = var.name
  description          = "${var.name} queues and caches"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_clusters   = var.redis_replicas + 1
  port                 = 6379

  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.redis.id]
  parameter_group_name = aws_elasticache_parameter_group.this.name

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  auth_token_wo              = ephemeral.random_password.redis.result
  auth_token_wo_version      = var.secret_versions.redis
  auth_token_update_strategy = "ROTATE"

  automatic_failover_enabled = var.redis_replicas > 0
  multi_az_enabled           = var.redis_replicas > 0
  snapshot_retention_limit   = var.redis_replicas > 0 ? 1 : 0
  apply_immediately          = true
}

# ---------------------------------------------------------------- Connection secrets (SSM)

resource "aws_ssm_parameter" "database_url" {
  name             = "/${var.name}/database-url"
  description      = "Migrate task only: the schema owner, TLS verified"
  type             = "SecureString"
  value_wo         = "postgresql://forge:${ephemeral.random_password.db.result}@${aws_db_instance.this.address}:5432/forge?${local.app_tls}"
  value_wo_version = var.secret_versions.database
}

resource "aws_ssm_parameter" "app_db_password" {
  name             = "/${var.name}/app-db-password"
  description      = "Password of forge_app_service, set by the migrate task (prisma/db-logins.ts)"
  type             = "SecureString"
  value_wo         = ephemeral.random_password.app_db.result
  value_wo_version = var.secret_versions.database
}

resource "aws_ssm_parameter" "app_database_url" {
  name             = "/${var.name}/app-database-url"
  description      = "API and worker: forge_app_service, rows only (no DDL, insert-only audit log)"
  type             = "SecureString"
  value_wo         = "postgresql://forge_app_service:${ephemeral.random_password.app_db.result}@${aws_db_instance.this.address}:5432/forge?${local.app_tls}"
  value_wo_version = var.secret_versions.database
}

resource "aws_ssm_parameter" "ai_db_password" {
  name             = "/${var.name}/ai-db-password"
  description      = "Password of forge_ai_service, set by the migrate task (prisma/db-logins.ts)"
  type             = "SecureString"
  value_wo         = ephemeral.random_password.ai_db.result
  value_wo_version = var.secret_versions.database
}

resource "aws_ssm_parameter" "ai_database_url" {
  name             = "/${var.name}/ai-database-url"
  description      = "AI service: forge_ai_service, RAG tables only (ADR-0004)"
  type             = "SecureString"
  value_wo         = "postgresql://forge_ai_service:${ephemeral.random_password.ai_db.result}@${aws_db_instance.this.address}:5432/forge?${local.ai_tls}"
  value_wo_version = var.secret_versions.database
}

resource "aws_ssm_parameter" "redis_url" {
  count            = var.hibernate ? 0 : 1
  name             = "/${var.name}/redis-url"
  description      = "API and worker: Redis over TLS with its auth token"
  type             = "SecureString"
  value_wo         = "rediss://:${ephemeral.random_password.redis.result}@${aws_elasticache_replication_group.this[0].primary_endpoint_address}:6379"
  value_wo_version = var.secret_versions.redis
}
