# The prod environment. State lives in the bootstrap bucket (key prod/terraform.tfstate); the
# bucket name and region are passed to `terraform init -backend-config=...` (docs/deployment.md).

terraform {
  required_version = ">= 1.11"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.7" }
    tls    = { source = "hashicorp/tls", version = "~> 4.1" }
  }
  backend "s3" {
    key          = "prod/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "forge"
      Environment = "prod"
      ManagedBy   = "terraform"
      Repository  = "vishalreddy9514/forge-engineering-platform"
    }
  }
}

data "aws_caller_identity" "current" {}

module "forge" {
  source = "../../modules/stack"

  environment      = "prod"
  domain_name      = var.domain_name
  hosted_zone_name = var.hosted_zone_name
  images           = var.images
  hibernate        = var.hibernate
  alarm_email      = var.alarm_email
  ai_provider      = var.ai_provider
  github_app       = var.github_app
  secret_versions  = var.secret_versions

  nat_mode                 = var.nat_mode
  sizes                    = var.sizes
  db_instance_class        = var.db_instance_class
  db_multi_az              = var.db_multi_az
  db_backup_retention_days = var.db_backup_retention_days
  redis_replicas           = var.redis_replicas
  deletion_protection      = var.deletion_protection
  container_insights       = var.container_insights

  permissions_boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/forge-workload-boundary"
}
