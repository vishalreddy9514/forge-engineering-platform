output "db_address" {
  value = aws_db_instance.this.address
}

output "db_identifier" {
  value = aws_db_instance.this.identifier
}

output "redis_replication_group_id" {
  value = one(aws_elasticache_replication_group.this[*].id)
}

output "parameter_arns" {
  description = "SSM parameters the tasks read as secrets."
  value = {
    database_url    = aws_ssm_parameter.database_url.arn
    ai_db_password  = aws_ssm_parameter.ai_db_password.arn
    ai_database_url = aws_ssm_parameter.ai_database_url.arn
    redis_url       = one(aws_ssm_parameter.redis_url[*].arn)
  }
}

output "db_settings" {
  description = "Security-relevant database settings (asserted by the stack tests)."
  value = {
    storage_encrypted   = aws_db_instance.this.storage_encrypted
    publicly_accessible = aws_db_instance.this.publicly_accessible
    force_ssl           = one([for p in aws_db_parameter_group.this.parameter : p.value if p.name == "rds.force_ssl"])
  }
}

output "redis_settings" {
  description = "Security-relevant Redis settings (asserted by the stack tests)."
  value = {
    transit_encryption_enabled = one(aws_elasticache_replication_group.this[*].transit_encryption_enabled)
    at_rest_encryption_enabled = one(aws_elasticache_replication_group.this[*].at_rest_encryption_enabled)
    maxmemory_policy           = one([for p in aws_elasticache_parameter_group.this.parameter : p.value if p.name == "maxmemory-policy"])
  }
}
