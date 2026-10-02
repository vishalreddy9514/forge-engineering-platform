variable "region" {
  type    = string
  default = "eu-west-2"
}

variable "github_repository" {
  description = "owner/name of the repository whose workflows may deploy."
  type        = string
  default     = "vishalreddy9514/forge-engineering-platform"
}

variable "environments" {
  description = "One deploy role per environment (and GitHub environment of the same name)."
  type        = list(string)
  default     = ["dev", "prod"]
}

variable "ecr_force_delete" {
  description = "Allow deleting repositories that still hold images (teardown)."
  type        = bool
  default     = false
}
