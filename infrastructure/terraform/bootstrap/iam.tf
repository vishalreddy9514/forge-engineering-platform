# What the deploy role may do, and the boundary on what the roles it creates may do.
#
# Terraform needs broad rights over the services one environment uses. Its IAM rights are the
# part that matters: it can only create roles named forge-<env>-* that carry the permissions
# boundary below, can only pass forge-<env>-* roles, and cannot change the boundary or its own
# role. So a compromised deploy job cannot mint an administrator.

locals {
  boundary_arn = "arn:aws:iam::${local.account_id}:policy/forge-workload-boundary"
}

data "aws_iam_policy_document" "boundary" {
  statement {
    sid = "WorkloadServices"
    actions = [
      "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
      "ses:SendEmail",
      "ssm:GetParameters",
      "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage",
      "logs:CreateLogStream", "logs:PutLogEvents",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "boundary" {
  name        = "forge-workload-boundary"
  description = "Upper limit for every role a Forge environment creates"
  policy      = data.aws_iam_policy_document.boundary.json
}

data "aws_iam_policy_document" "deploy" {
  for_each = toset(var.environments)

  statement {
    sid = "EnvironmentServices"
    #trivy:ignore:AVD-AWS-0057 Terraform manages these services end to end; IAM below is the guarded part
    actions = [
      "ec2:*", "ecs:*", "elasticloadbalancing:*", "rds:*", "elasticache:*",
      "logs:*", "cloudwatch:*", "sns:*", "acm:*", "route53:*", "servicediscovery:*",
      "application-autoscaling:*", "ses:*", "ssm:DescribeParameters", "kms:DescribeKey",
    ]
    resources = ["*"]
  }

  # Bucket configuration Terraform reads and writes, and emptying a bucket on teardown.
  statement {
    sid = "EnvironmentBuckets"
    actions = [
      "s3:CreateBucket", "s3:DeleteBucket", "s3:DeleteBucketPolicy", "s3:Get*", "s3:List*",
      "s3:PutBucket*", "s3:PutEncryptionConfiguration", "s3:PutLifecycleConfiguration",
      "s3:DeleteObject", "s3:DeleteObjectVersion",
    ]
    resources = ["arn:aws:s3:::forge-${each.key}-*"]
  }

  statement {
    sid       = "EnvironmentParameters"
    actions   = ["ssm:*"]
    resources = ["arn:aws:ssm:*:${local.account_id}:parameter/forge-${each.key}/*"]
  }

  statement {
    sid       = "TerraformState"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/${each.key}/*"]
  }

  statement {
    sid = "PromoteImages"
    actions = [
      "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
    ]
    resources = ["*"]
  }

  statement {
    sid = "CreateBoundedRoles"
    actions = [
      "iam:CreateRole", "iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:PutRolePermissionsBoundary",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/forge-${each.key}-*"]
    condition {
      test     = "StringEquals"
      variable = "iam:PermissionsBoundary"
      values   = [local.boundary_arn]
    }
  }

  statement {
    sid = "ManageOwnRoles"
    actions = [
      "iam:GetRole", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole", "iam:DeleteRole", "iam:DeleteRolePolicy",
      "iam:DetachRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:UpdateAssumeRolePolicy",
      "iam:PassRole",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/forge-${each.key}-*"]
  }

  statement {
    sid     = "ServiceLinkedRoles"
    actions = ["iam:CreateServiceLinkedRole"]
    resources = [
      "arn:aws:iam::*:role/aws-service-role/ecs.amazonaws.com/*",
      "arn:aws:iam::*:role/aws-service-role/elasticloadbalancing.amazonaws.com/*",
      "arn:aws:iam::*:role/aws-service-role/rds.amazonaws.com/*",
      "arn:aws:iam::*:role/aws-service-role/elasticache.amazonaws.com/*",
      "arn:aws:iam::*:role/aws-service-role/ecs.application-autoscaling.amazonaws.com/*",
    ]
  }

  statement {
    sid       = "ReadOnlyIam"
    actions   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:GetOpenIDConnectProvider"]
    resources = ["*"]
  }

  # The deploy role must not loosen its own limits.
  statement {
    sid    = "ProtectBoundaryAndSelf"
    effect = "Deny"
    actions = [
      "iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion",
    ]
    resources = [local.boundary_arn]
  }
  statement {
    sid       = "ProtectDeployRoles"
    effect    = "Deny"
    actions   = ["iam:*"]
    resources = ["arn:aws:iam::${local.account_id}:role/forge-*-deploy"]
  }
}
