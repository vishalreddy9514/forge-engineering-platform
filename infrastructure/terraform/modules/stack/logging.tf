# Audit logs for the infrastructure (security hardening, Phase 18): who reached the load
# balancer, which attachment objects were read or written, and which connections the network
# accepted or rejected. All three land in one private log bucket and expire after
# var.access_log_retention_days.

resource "aws_s3_bucket" "logs" {
  bucket        = "${local.name}-logs-${local.account_id}"
  force_destroy = !var.deletion_protection
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Load balancer access logs support SSE-S3 only.
#trivy:ignore:AVD-AWS-0132 SSE-S3 (AES-256) is the only encryption ALB log delivery supports
resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.access_log_retention_days
    }
  }
}

# The account that delivers load balancer logs in this region (regions older than August 2022
# use an AWS-owned account rather than a service principal).
data "aws_elb_service_account" "this" {}

data "aws_iam_policy_document" "logs" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "LoadBalancerAccessLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/alb/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.this.arn]
    }
  }

  statement {
    sid       = "S3ServerAccessLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/s3/*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.attachments.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid       = "VpcFlowLogsWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/vpc/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }

  statement {
    sid       = "VpcFlowLogsAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.logs.arn]
    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs.json
}

# ---------------------------------------------------------------- What is logged

# Every read and write of an attachment object (who, when, from where).
resource "aws_s3_bucket_logging" "attachments" {
  bucket        = aws_s3_bucket.attachments.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3/attachments/"

  depends_on = [aws_s3_bucket_policy.logs]
}

# Network connections to and from every interface in the VPC. dev records rejected traffic
# only (what the security groups refused); prod records all of it.
resource "aws_flow_log" "vpc" {
  vpc_id                   = module.network.vpc_id
  traffic_type             = var.flow_log_traffic
  log_destination_type     = "s3"
  log_destination          = "${aws_s3_bucket.logs.arn}/vpc/"
  max_aggregation_interval = 600

  depends_on = [aws_s3_bucket_policy.logs]
}
