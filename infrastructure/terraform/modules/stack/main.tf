# One Forge environment (architecture §10, ADR-0005): network, data stores, secrets, the load
# balancer and four ECS services. environments/dev and environments/prod call this with
# different variables.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  name       = "forge-${var.environment}"
  region     = data.aws_region.current.region
  account_id = data.aws_caller_identity.current.account_id
  origin     = "https://${var.domain_name}"
  mail_from  = "no-reply@${var.domain_name}"
  running    = !var.hibernate
  github     = var.github_app != null
}

module "network" {
  source   = "../network"
  name     = local.name
  nat_mode = var.hibernate ? "none" : var.nat_mode
}

module "data" {
  source     = "../data"
  name       = local.name
  vpc_id     = module.network.vpc_id
  subnet_ids = module.network.private_subnet_ids
  hibernate  = var.hibernate

  db_client_security_groups = {
    api     = aws_security_group.task["api"].id
    worker  = aws_security_group.task["worker"].id
    ai      = aws_security_group.task["ai-service"].id
    migrate = aws_security_group.task["migrate"].id
  }
  redis_client_security_groups = {
    api    = aws_security_group.task["api"].id
    worker = aws_security_group.task["worker"].id
  }

  secret_versions          = { database = var.secret_versions.database, redis = var.secret_versions.redis }
  db_instance_class        = var.db_instance_class
  db_multi_az              = var.db_multi_az
  db_backup_retention_days = var.db_backup_retention_days
  deletion_protection      = var.deletion_protection
  redis_node_type          = var.redis_node_type
  redis_replicas           = var.redis_replicas
}
