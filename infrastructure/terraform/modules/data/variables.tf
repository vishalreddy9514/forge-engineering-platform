variable "name" {
  description = "Prefix for every resource name, e.g. forge-dev."
  type        = string
}

variable "vpc_id" {
  type = string
}

variable "subnet_ids" {
  description = "Private subnets (two AZs) for the database and Redis."
  type        = list(string)
}

variable "db_client_security_groups" {
  description = "Security groups allowed to reach PostgreSQL, keyed by a name known at plan time."
  type        = map(string)
}

variable "redis_client_security_groups" {
  description = "Security groups allowed to reach Redis, keyed by a name known at plan time."
  type        = map(string)
}

variable "hibernate" {
  description = "Stop the database and remove Redis (data in Redis is lost; Postgres keeps everything)."
  type        = bool
  default     = false
}

variable "secret_versions" {
  description = "Bump a number to generate and roll out a new password (write-only, never in state)."
  type        = object({ database = number, redis = number })
}

variable "postgres_version" {
  type    = string
  default = "16"
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_storage_gb" {
  type    = number
  default = 20
}

variable "db_max_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
  default     = 50
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_backup_retention_days" {
  type    = number
  default = 7
}

variable "db_performance_insights" {
  type    = bool
  default = false
}

variable "deletion_protection" {
  description = "Protects the database from deletion and takes a final snapshot. Off in dev for teardown."
  type        = bool
  default     = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "redis_replicas" {
  description = "Read replicas; one or more enables Multi-AZ failover."
  type        = number
  default     = 0
}
