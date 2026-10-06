variable "name" {
  description = "Service and container name (api, worker, web, ai-service, migrate)."
  type        = string
}

variable "cluster_name" {
  type = string
}

variable "cluster_arn" {
  type = string
}

variable "region" {
  type = string
}

variable "image" {
  description = "Image reference, pinned by digest (registry/repo@sha256:...)."
  type        = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "Deploy images by digest so what runs is exactly what was scanned and attested."
  }
}

variable "command" {
  type    = list(string)
  default = null
}

variable "user" {
  description = "Overrides the image's user (null keeps it; every image runs as non-root)."
  type        = string
  default     = null
}

variable "cpu" {
  type = number
}

variable "memory" {
  type = number
}

variable "port" {
  description = "Container port, or null for a process with no listener (the worker)."
  type        = number
  default     = null
}

variable "environment" {
  type    = map(string)
  default = {}
}

variable "secrets" {
  description = "Environment variable name to SSM parameter ARN; ECS injects the value at start."
  type        = map(string)
  default     = {}
}

variable "health_check_command" {
  type    = list(string)
  default = null
}

variable "read_only_root_filesystem" {
  type    = bool
  default = true
}

variable "execution_role_arn" {
  type = string
}

variable "task_role_arn" {
  type = string
}

variable "create_service" {
  description = "False registers only the task definition (one-shot tasks, or hibernation)."
  type        = bool
  default     = true
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "max_count" {
  description = "Above desired_count, CPU target tracking scales the service up to this."
  type        = number
  default     = 1
}

variable "spot" {
  description = "Run on Fargate Spot (interruptible, about 70% cheaper)."
  type        = bool
  default     = false
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}

variable "target_group_arn" {
  type    = string
  default = null
}

variable "service_connect_namespace_arn" {
  type    = string
  default = null
}

variable "service_connect_name" {
  description = "Name other tasks use to reach this one (http://<name>:<port>); null for clients only."
  type        = string
  default     = null
}

variable "wait_for_steady_state" {
  description = "Make apply wait until the deployment is healthy (and fail if it is rolled back)."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  type    = number
  default = 14
}
