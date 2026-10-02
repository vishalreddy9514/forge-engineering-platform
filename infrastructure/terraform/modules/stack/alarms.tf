# The alarms that mean a person should look now. Phase 17 adds dashboards and RED metrics.

#trivy:ignore:AVD-AWS-0095 alarm notifications carry no sensitive data; SSE with a CMK adds cost only
resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alarm_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alb_suffix = one(aws_lb.this[*].arn_suffix)
  alarms = local.running ? {
    "api-5xx" = {
      description = "The API answered more than 10 server errors in 5 minutes"
      namespace   = "AWS/ApplicationELB", metric = "HTTPCode_Target_5XX_Count", statistic = "Sum"
      threshold   = 10, periods = 1, comparison = "GreaterThanThreshold"
      dimensions  = { LoadBalancer = local.alb_suffix, TargetGroup = aws_lb_target_group.this["api"].arn_suffix }
    }
    "api-latency-p95" = {
      description = "API p95 latency above 1 s for 15 minutes (NFR-1 targets 250 ms)"
      namespace   = "AWS/ApplicationELB", metric = "TargetResponseTime", statistic = "p95"
      threshold   = 1, periods = 3, comparison = "GreaterThanThreshold"
      dimensions  = { LoadBalancer = local.alb_suffix, TargetGroup = aws_lb_target_group.this["api"].arn_suffix }
    }
    "api-unhealthy" = {
      description = "An API target has been failing its health check for 5 minutes"
      namespace   = "AWS/ApplicationELB", metric = "UnHealthyHostCount", statistic = "Maximum"
      threshold   = 0, periods = 5, comparison = "GreaterThanThreshold"
      dimensions  = { LoadBalancer = local.alb_suffix, TargetGroup = aws_lb_target_group.this["api"].arn_suffix }
    }
    "web-unhealthy" = {
      description = "A web target has been failing its health check for 5 minutes"
      namespace   = "AWS/ApplicationELB", metric = "UnHealthyHostCount", statistic = "Maximum"
      threshold   = 0, periods = 5, comparison = "GreaterThanThreshold"
      dimensions  = { LoadBalancer = local.alb_suffix, TargetGroup = aws_lb_target_group.this["web"].arn_suffix }
    }
    "db-cpu" = {
      description = "PostgreSQL CPU above 80% for 15 minutes"
      namespace   = "AWS/RDS", metric = "CPUUtilization", statistic = "Average"
      threshold   = 80, periods = 3, comparison = "GreaterThanThreshold"
      dimensions  = { DBInstanceIdentifier = module.data.db_identifier }
    }
    "db-storage" = {
      description = "Less than 2 GB of database storage left"
      namespace   = "AWS/RDS", metric = "FreeStorageSpace", statistic = "Minimum"
      threshold   = 2 * 1024 * 1024 * 1024, periods = 1, comparison = "LessThanThreshold"
      dimensions  = { DBInstanceIdentifier = module.data.db_identifier }
    }
    "redis-memory" = {
      # noeviction: a full Redis rejects new jobs instead of dropping old ones.
      description = "Redis memory above 80%; at 100% new queue jobs are rejected"
      namespace   = "AWS/ElastiCache", metric = "DatabaseMemoryUsagePercentage", statistic = "Maximum"
      threshold   = 80, periods = 1, comparison = "GreaterThanThreshold"
      dimensions  = { ReplicationGroupId = module.data.redis_replication_group_id }
    }
  } : {}
}

resource "aws_cloudwatch_metric_alarm" "this" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = each.value.namespace
  metric_name         = each.value.metric
  statistic           = startswith(each.value.statistic, "p") ? null : each.value.statistic
  extended_statistic  = startswith(each.value.statistic, "p") ? each.value.statistic : null
  dimensions          = each.value.dimensions
  period              = 300
  evaluation_periods  = each.value.periods
  threshold           = each.value.threshold
  comparison_operator = each.value.comparison
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
}
