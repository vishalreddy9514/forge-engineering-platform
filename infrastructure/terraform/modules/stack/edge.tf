# HTTPS entry point: an ACM certificate validated in Route 53, and an ALB that sends /api/* to
# the API and everything else to the web app, as Nginx does locally (one origin, no CORS).

data "aws_route53_zone" "this" {
  name         = var.hosted_zone_name
  private_zone = false
}

resource "aws_acm_certificate" "this" {
  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# One domain, so one validation record.
resource "aws_route53_record" "certificate_validation" {
  zone_id         = data.aws_route53_zone.this.zone_id
  name            = one(aws_acm_certificate.this.domain_validation_options).resource_record_name
  type            = one(aws_acm_certificate.this.domain_validation_options).resource_record_type
  records         = [one(aws_acm_certificate.this.domain_validation_options).resource_record_value]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "this" {
  certificate_arn         = aws_acm_certificate.this.arn
  validation_record_fqdns = [aws_route53_record.certificate_validation.fqdn]
}

# Target groups outlive hibernation (they cost nothing); the load balancer does not.
resource "aws_lb_target_group" "this" {
  for_each = {
    web = { port = 3000, health = "/login" }
    api = { port = 4000, health = "/api/v1/health/ready" }
  }
  name                 = "${local.name}-${each.key}"
  port                 = each.value.port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = module.network.vpc_id
  deregistration_delay = 30

  health_check {
    path                = each.value.health
    matcher             = "200"
    interval            = 15
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

#trivy:ignore:AVD-AWS-0053 the load balancer is the application's public entry point
resource "aws_lb" "this" {
  count                      = local.running ? 1 : 0
  name                       = local.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = module.network.public_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  # AI drafts and chat stream as Server-Sent Events; allow quiet periods between events.
  idle_timeout               = 120
  enable_deletion_protection = var.deletion_protection

  # Who called what, from where, and how long it took (logging.tf).
  access_logs {
    bucket  = aws_s3_bucket.logs.id
    prefix  = "alb"
    enabled = true
  }

  # The load balancer checks that it may write to the bucket when logging is turned on.
  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_lb_listener" "http" {
  count             = local.running ? 1 : 0
  load_balancer_arn = aws_lb.this[0].arn
  port              = 80
  protocol          = "HTTP" #trivy:ignore:AVD-AWS-0054 only redirects to HTTPS

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = local.running ? 1 : 0
  load_balancer_arn = aws_lb.this[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.this.certificate_arn

  # HSTS is set where TLS ends, on every response: browsers then refuse plain HTTP to the
  # domain for a year (the web app sets the other security headers itself).
  routing_http_response_strict_transport_security_header_value = "max-age=31536000; includeSubDomains"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["web"].arn
  }
}

resource "aws_lb_listener_rule" "api" {
  count        = local.running ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10

  condition {
    path_pattern {
      values = ["/api/*"]
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this["api"].arn
  }
}

resource "aws_route53_record" "app" {
  count   = local.running ? 1 : 0
  zone_id = data.aws_route53_zone.this.zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this[0].dns_name
    zone_id                = aws_lb.this[0].zone_id
    evaluate_target_health = true
  }
}
