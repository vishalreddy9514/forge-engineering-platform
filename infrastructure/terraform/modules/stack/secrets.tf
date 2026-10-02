# Application secrets in SSM Parameter Store (SecureString, NFR-7). Generated ones are ephemeral:
# they exist only during apply and are written through write-only arguments, so neither the
# Terraform state nor the plan ever contains them. Bump secret_versions.<name> to rotate.
# Secrets that come from outside (OpenAI, GitHub App) are created empty and set by an operator.

ephemeral "tls_private_key" "jwt" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

ephemeral "random_password" "ai_service_token" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "jwt_private_key" {
  name             = "/${local.name}/jwt-private-key"
  description      = "ES256 key that signs access tokens (ADR-0003)"
  type             = "SecureString"
  value_wo         = ephemeral.tls_private_key.jwt.private_key_pem_pkcs8
  value_wo_version = var.secret_versions.jwt
}

resource "aws_ssm_parameter" "jwt_public_key" {
  name             = "/${local.name}/jwt-public-key"
  description      = "Public half of the access-token key"
  type             = "SecureString"
  value_wo         = ephemeral.tls_private_key.jwt.public_key_pem
  value_wo_version = var.secret_versions.jwt
}

resource "aws_ssm_parameter" "ai_service_token" {
  name             = "/${local.name}/ai-service-token"
  description      = "Bearer token the API and worker present to the AI service"
  type             = "SecureString"
  value_wo         = ephemeral.random_password.ai_service_token.result
  value_wo_version = var.secret_versions.ai_service_token
}

# Set by an operator (docs/deployment.md); Terraform never reads or overwrites the value.
resource "aws_ssm_parameter" "external" {
  for_each = toset(concat(
    var.ai_provider == "openai" ? ["openai-api-key"] : [],
    local.github ? ["github-app-private-key", "github-webhook-secret"] : [],
  ))
  name        = "/${local.name}/${each.key}"
  description = "Set with: aws ssm put-parameter --overwrite --type SecureString --name /${local.name}/${each.key}"
  type        = "SecureString"
  value       = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}

locals {
  # Changing a secret's version also changes the task definitions, so running tasks are
  # replaced and pick up the new value.
  config_revision = sha256(jsonencode(var.secret_versions))
}
