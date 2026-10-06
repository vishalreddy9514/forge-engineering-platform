output "state_bucket" {
  description = "GitHub variable TF_STATE_BUCKET."
  value       = aws_s3_bucket.state.bucket
}

output "deploy_role_arns" {
  description = "GitHub environment variable AWS_DEPLOY_ROLE_ARN, per environment."
  value       = { for env, role in aws_iam_role.deploy : env => role.arn }
}

output "ecr_registry" {
  value = split("/", aws_ecr_repository.this["api"].repository_url)[0]
}

output "permissions_boundary_arn" {
  value = aws_iam_policy.boundary.arn
}
