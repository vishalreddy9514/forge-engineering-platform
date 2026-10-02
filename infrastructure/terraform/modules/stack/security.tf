# One security group per workload, so each rule names exactly who may talk to whom:
#   internet → ALB (443, 80) → web (3000), api (4000)
#   web → api (4000), api and worker → ai-service (8000)    [Service Connect]
#   api, worker, ai-service, migrate → PostgreSQL;  api, worker → Redis   [modules/data]

locals {
  task_ports = { web = 3000, api = 4000, worker = null, "ai-service" = 8000, migrate = null }
  # Who may open connections to each listening workload.
  task_ingress = {
    "web-from-alb"   = { to = "web", from_alb = true, from = null }
    "api-from-alb"   = { to = "api", from_alb = true, from = null }
    "api-from-web"   = { to = "api", from_alb = false, from = "web" }
    "ai-from-api"    = { to = "ai-service", from_alb = false, from = "api" }
    "ai-from-worker" = { to = "ai-service", from_alb = false, from = "worker" }
  }
}

resource "aws_security_group" "task" {
  for_each    = local.task_ports
  name        = "${local.name}-${each.key}"
  description = "Forge ${each.key} tasks"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-${each.key}" }
}

resource "aws_vpc_security_group_ingress_rule" "task" {
  for_each                     = local.task_ingress
  security_group_id            = aws_security_group.task[each.value.to].id
  description                  = each.key
  referenced_security_group_id = each.value.from_alb ? aws_security_group.alb.id : aws_security_group.task[each.value.from].id
  ip_protocol                  = "tcp"
  from_port                    = local.task_ports[each.value.to]
  to_port                      = local.task_ports[each.value.to]
}

# Tasks reach AWS APIs (ECR, SSM, CloudWatch Logs, S3, SES), GitHub and OpenAI through the NAT.
# They are in private subnets with no inbound path from the internet.
resource "aws_vpc_security_group_egress_rule" "task_https" {
  for_each          = local.task_ports
  security_group_id = aws_security_group.task[each.key].id
  description       = "HTTPS to AWS APIs, GitHub and OpenAI"
  cidr_ipv4         = "0.0.0.0/0" #trivy:ignore:AVD-AWS-0104 private tasks call public HTTPS APIs through the NAT
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}

resource "aws_vpc_security_group_egress_rule" "task_in_vpc" {
  for_each          = local.task_ports
  security_group_id = aws_security_group.task[each.key].id
  description       = "Service Connect peers, PostgreSQL and Redis (each guarded by its own ingress rule)"
  cidr_ipv4         = module.network.vpc_cidr_block
  ip_protocol       = "tcp"
  from_port         = 0
  to_port           = 65535
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Public load balancer"
  vpc_id      = module.network.vpc_id
  tags        = { Name = "${local.name}-alb" }
}

resource "aws_vpc_security_group_ingress_rule" "alb" {
  for_each          = { https = 443, http = 80 }
  security_group_id = aws_security_group.alb.id
  description       = "${upper(each.key)} from the internet (HTTP only redirects)"
  cidr_ipv4         = "0.0.0.0/0" #trivy:ignore:AVD-AWS-0107 the public entry point of a web application
  ip_protocol       = "tcp"
  from_port         = each.value
  to_port           = each.value
}

resource "aws_vpc_security_group_egress_rule" "alb_to_tasks" {
  for_each                     = { web = 3000, api = 4000 }
  security_group_id            = aws_security_group.alb.id
  description                  = "To ${each.key} tasks"
  referenced_security_group_id = aws_security_group.task[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = each.value
  to_port                      = each.value
}
