output "url" {
  value = local.origin
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "load_balancer_dns_name" {
  value = one(aws_lb.this[*].dns_name)
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}

output "alarm_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "log_groups" {
  value = {
    api          = module.api.log_group_name
    worker       = module.worker.log_group_name
    web          = module.web.log_group_name
    "ai-service" = module.ai_service.log_group_name
    migrate      = module.migrate.log_group_name
  }
}

output "operator_parameters" {
  description = "SSM parameters an operator must set (aws ssm put-parameter --overwrite)."
  value       = [for p in aws_ssm_parameter.external : p.name]
}
