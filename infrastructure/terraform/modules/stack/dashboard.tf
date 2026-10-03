# One CloudWatch dashboard per environment (the first three are free): the load balancer's RED
# metrics, each service's CPU and memory, and the data stores. The detailed application metrics
# (routes, queues, model calls) are Prometheus metrics; see docs/observability.md.

locals {
  services = ["api", "worker", "web", "ai-service"]
  dashboard_widgets = local.running ? [
    {
      type = "metric", x = 0, y = 0, width = 8, height = 6
      properties = {
        title  = "Requests and 5xx (load balancer)"
        region = local.region
        stat   = "Sum"
        period = 60
        metrics = [
          ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", local.alb_suffix],
          ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", local.alb_suffix],
        ]
      }
    },
    {
      type = "metric", x = 8, y = 0, width = 8, height = 6
      properties = {
        title   = "API latency p95 (s)"
        region  = local.region
        stat    = "p95"
        period  = 60
        metrics = [["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", local.alb_suffix, "TargetGroup", aws_lb_target_group.this["api"].arn_suffix]]
      }
    },
    {
      type = "metric", x = 16, y = 0, width = 8, height = 6
      properties = {
        title   = "Healthy targets"
        region  = local.region
        stat    = "Minimum"
        period  = 60
        metrics = [for tg in ["api", "web"] : ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", local.alb_suffix, "TargetGroup", aws_lb_target_group.this[tg].arn_suffix]]
      }
    },
    {
      type = "metric", x = 0, y = 6, width = 12, height = 6
      properties = {
        title   = "Service CPU (%)"
        region  = local.region
        stat    = "Average"
        period  = 60
        metrics = [for s in local.services : ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.this.name, "ServiceName", s]]
      }
    },
    {
      type = "metric", x = 12, y = 6, width = 12, height = 6
      properties = {
        title   = "Service memory (%)"
        region  = local.region
        stat    = "Average"
        period  = 60
        metrics = [for s in local.services : ["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.this.name, "ServiceName", s]]
      }
    },
    {
      type = "metric", x = 0, y = 12, width = 12, height = 6
      properties = {
        title  = "PostgreSQL CPU (%) and connections"
        region = local.region
        stat   = "Average"
        period = 60
        metrics = [
          ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", module.data.db_identifier],
          ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", module.data.db_identifier],
        ]
      }
    },
    {
      type = "metric", x = 12, y = 12, width = 12, height = 6
      properties = {
        title   = "Redis memory (%)"
        region  = local.region
        stat    = "Maximum"
        period  = 60
        metrics = [["AWS/ElastiCache", "DatabaseMemoryUsagePercentage", "ReplicationGroupId", module.data.redis_replication_group_id]]
      }
    },
  ] : []
}

resource "aws_cloudwatch_dashboard" "this" {
  count          = local.running ? 1 : 0
  dashboard_name = local.name
  dashboard_body = jsonencode({ widgets = local.dashboard_widgets })
}
