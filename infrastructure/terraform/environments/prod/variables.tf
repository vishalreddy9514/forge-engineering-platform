variable "region" {
  type = string
}

variable "domain_name" {
  description = "Set in GitHub as the environment variable FORGE_DOMAIN (TF_VAR_domain_name)."
  type        = string
}

variable "hosted_zone_name" {
  description = "Set in GitHub as FORGE_HOSTED_ZONE (TF_VAR_hosted_zone_name)."
  type        = string
}

variable "images" {
  description = "Set by the deploy workflow: each image by digest in ECR."
  type        = map(string)
  validation {
    condition     = toset(keys(var.images)) == toset(["api", "migrate", "web", "ai-service"])
    error_message = "images must have exactly api, migrate, web and ai-service."
  }
}

variable "hibernate" {
  type    = bool
  default = false
}

variable "alarm_email" {
  type    = string
  default = null
}

variable "ai_provider" {
  type    = string
  default = "fake"
}

variable "github_app" {
  type = object({
    id   = number
    slug = string
  })
  default = null
}

variable "secret_versions" {
  type = object({
    database         = number
    redis            = number
    jwt              = number
    ai_service_token = number
  })
  default = { database = 1, redis = 1, jwt = 1, ai_service_token = 1 }
}

variable "nat_mode" {
  type = string
}

variable "sizes" {
  type = map(object({
    cpu    = number
    memory = number
    count  = number
    max    = number
    spot   = bool
  }))
}

variable "db_instance_class" {
  type = string
}

variable "db_multi_az" {
  type = bool
}

variable "db_backup_retention_days" {
  type = number
}

variable "redis_replicas" {
  type = number
}

variable "deletion_protection" {
  type = bool
}

variable "container_insights" {
  type = bool
}
