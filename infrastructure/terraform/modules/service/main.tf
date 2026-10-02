# One ECS service on Fargate: its task definition, log group and, optionally, a load balancer
# target and a Service Connect name other tasks can call (e.g. http://ai-service:8000).

resource "aws_cloudwatch_log_group" "this" {
  name              = "/${var.cluster_name}/${var.name}"
  retention_in_days = var.log_retention_days
}

locals {
  container = {
    name      = var.name
    image     = var.image
    essential = true
    command   = var.command
    # Writable /tmp only where the process needs it; the image filesystem is read-only.
    readonlyRootFilesystem = var.read_only_root_filesystem
    portMappings = var.port == null ? [] : [{
      name          = var.name
      containerPort = var.port
      protocol      = "tcp"
      appProtocol   = "http"
    }]
    environment = [for k in sort(keys(var.environment)) : { name = k, value = var.environment[k] }]
    secrets     = [for k in sort(keys(var.secrets)) : { name = k, valueFrom = var.secrets[k] }]
    healthCheck = var.health_check_command == null ? null : {
      command     = var.health_check_command
      interval    = 15
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    mountPoints = var.read_only_root_filesystem ? [{ sourceVolume = "tmp", containerPath = "/tmp" }] : []
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = var.region
        awslogs-stream-prefix = var.name
      }
    }
    linuxParameters = { initProcessEnabled = true }
    user            = var.user
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.cluster_name}-${var.name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn
  container_definitions    = jsonencode([{ for k, v in local.container : k => v if v != null }])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  dynamic "volume" {
    for_each = var.read_only_root_filesystem ? ["tmp"] : []
    content {
      name = volume.value
    }
  }
}

resource "aws_ecs_service" "this" {
  count           = var.create_service ? 1 : 0
  name            = var.name
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  propagate_tags  = "SERVICE"

  capacity_provider_strategy {
    capacity_provider = var.spot ? "FARGATE_SPOT" : "FARGATE"
    weight            = 1
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = false
  }

  # A deployment whose tasks never become healthy is stopped and rolled back.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  health_check_grace_period_seconds = var.target_group_arn == null ? null : 60

  dynamic "load_balancer" {
    for_each = var.target_group_arn == null ? [] : [var.target_group_arn]
    content {
      target_group_arn = load_balancer.value
      container_name   = var.name
      container_port   = var.port
    }
  }

  service_connect_configuration {
    enabled   = true
    namespace = var.service_connect_namespace_arn
    dynamic "service" {
      for_each = var.service_connect_name == null ? [] : [var.service_connect_name]
      content {
        port_name      = var.name
        discovery_name = service.value
        client_alias {
          port     = var.port
          dns_name = service.value
        }
      }
    }
  }

  wait_for_steady_state = var.wait_for_steady_state
}

resource "aws_appautoscaling_target" "this" {
  count              = var.create_service && var.max_count > var.desired_count ? 1 : 0
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this[0].name}"
  min_capacity       = var.desired_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "cpu" {
  count              = length(aws_appautoscaling_target.this)
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = "ecs"
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension
  resource_id        = aws_appautoscaling_target.this[0].resource_id

  target_tracking_scaling_policy_configuration {
    target_value = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
