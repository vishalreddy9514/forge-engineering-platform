variable "environment" {
  description = "Environment name (dev, prod); resources are named forge-<environment>."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,15}$", var.environment))
    error_message = "Use 2-16 lowercase letters, digits or hyphens."
  }
}

variable "domain_name" {
  description = "Where the app is served, e.g. forge.example.com. Also the SES sending domain."
  type        = string
}

variable "hosted_zone_name" {
  description = "Public Route 53 hosted zone that contains domain_name, e.g. example.com."
  type        = string
}

variable "images" {
  description = "Images by digest, as the deploy workflow promotes them to ECR."
  type        = map(string)
  validation {
    condition     = toset(keys(var.images)) == toset(["api", "migrate", "web", "ai-service"])
    error_message = "images must have exactly api, migrate, web and ai-service."
  }
  validation {
    condition     = alltrue([for ref in values(var.images) : can(regex("@sha256:[0-9a-f]{64}$", ref))])
    error_message = "Deploy images by digest, so what runs is exactly what was scanned and attested."
  }
}

variable "hibernate" {
  description = "Scale to (almost) zero: no services, load balancer, NAT or Redis; the database is stopped. Data is kept."
  type        = bool
  default     = false
}

variable "nat_mode" {
  description = "instance (fck-nat, ~$3/month) or gateway (managed NAT Gateway, ~$32/month)."
  type        = string
  default     = "instance"
}

variable "sizes" {
  description = "Fargate size, count and capacity per service (cpu units, memory MiB)."
  type = map(object({
    cpu    = number
    memory = number
    count  = number
    max    = number
    spot   = bool
  }))
  validation {
    condition     = alltrue([for s in ["api", "worker", "web", "ai-service"] : contains(keys(var.sizes), s)])
    error_message = "sizes must define api, worker, web and ai-service."
  }
}

variable "ai_provider" {
  description = "fake (deterministic, no key) or openai (reads /forge-<env>/openai-api-key)."
  type        = string
  default     = "fake"
  validation {
    condition     = contains(["fake", "openai"], var.ai_provider)
    error_message = "ai_provider must be fake or openai."
  }
}

variable "ai_daily_token_budget" {
  description = "Tokens one person may use per UTC day (NFR-12)."
  type        = number
  default     = 200000
}

variable "github_app" {
  description = "The GitHub App (docs/github-app-setup.md), or null to leave the integration off."
  type = object({
    id   = number
    slug = string
  })
  default = null
}

variable "error_reporting" {
  description = "Report errors to Sentry; reads the DSN from /forge-<env>/sentry-dsn (set by an operator)."
  type        = bool
  default     = false
}

variable "secret_versions" {
  description = "Bump one to generate a new value and roll it out (write-only; never in state)."
  type = object({
    database         = number
    redis            = number
    jwt              = number
    ai_service_token = number
  })
  default = { database = 1, redis = 1, jwt = 1, ai_service_token = 1 }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "redis_replicas" {
  type    = number
  default = 0
}

variable "deletion_protection" {
  description = "Protect the database and load balancer, keep a final snapshot and non-empty buckets."
  type        = bool
  default     = true
}

variable "container_insights" {
  description = "ECS Container Insights (per-task metrics; billed as custom metrics)."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 14
}

variable "alarm_email" {
  description = "Email for alarm notifications (confirm the subscription email once)."
  type        = string
  default     = null
}

variable "permissions_boundary_arn" {
  description = "Permissions boundary for every role this stack creates (from bootstrap)."
  type        = string
  default     = null
}

variable "run_migrations" {
  description = "Run the migrate task (needs the AWS CLI where Terraform runs) before updating services."
  type        = bool
  default     = true
}

variable "wait_for_steady_state" {
  description = "Wait for each service deployment to be healthy, failing the apply on rollback."
  type        = bool
  default     = true
}

variable "access_log_retention_days" {
  description = "Days the load balancer, attachment-bucket and VPC flow logs are kept."
  type        = number
  default     = 90
}

variable "flow_log_traffic" {
  description = "VPC flow logs: REJECT (what the security groups refused) or ALL."
  type        = string
  default     = "REJECT"
  validation {
    condition     = contains(["REJECT", "ALL"], var.flow_log_traffic)
    error_message = "Use REJECT or ALL."
  }
}
