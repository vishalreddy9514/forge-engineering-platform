output "task_definition_arn" {
  value = aws_ecs_task_definition.this.arn
}

output "service_name" {
  value = one(aws_ecs_service.this[*].name)
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.this.name
}

output "container_definitions" {
  description = "The rendered container definition JSON (for tests and review)."
  value       = aws_ecs_task_definition.this.container_definitions
}
