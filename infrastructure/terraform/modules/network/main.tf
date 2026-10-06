# VPC across two Availability Zones: public subnets for the load balancer and the NAT, private
# subnets for every task, the database and Redis (architecture §10).

data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, 2)
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = true
  enable_dns_support   = true
  tags                 = { Name = var.name }
}

# The default security group allows all traffic between its members; nothing uses it, so it
# is emptied rather than left as a trap.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 8, count.index)
  # The NAT instance gets its address explicitly; nothing else in these subnets needs one.
  map_public_ip_on_launch = false
  tags                    = { Name = "${var.name}-public-${local.azs[count.index]}", Tier = "public" }
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 8, count.index + 10)
  tags              = { Name = "${var.name}-private-${local.azs[count.index]}", Tier = "private" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# S3 traffic (attachments) stays on the AWS network and off the NAT, at no cost.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
  tags              = { Name = "${var.name}-s3" }
}

data "aws_region" "current" {}

# ---- Egress for private subnets (image pulls, GitHub, OpenAI) ----
# "instance": fck-nat on a t4g.nano (~$3/month), ADR-0005. "gateway": a managed NAT Gateway
# (~$32/month plus data), for production. "none": no egress at all (hibernated).

data "aws_ami" "fck_nat" {
  count       = var.nat_mode == "instance" ? 1 : 0
  most_recent = true
  owners      = ["568608671756"] # fck-nat's publisher account
  filter {
    name   = "name"
    values = ["fck-nat-al2023-*-arm64-ebs"]
  }
  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_security_group" "nat" {
  count       = var.nat_mode == "instance" ? 1 : 0
  name        = "${var.name}-nat"
  description = "fck-nat: forwards traffic from the private subnets to the internet"
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.name}-nat" }
}

resource "aws_vpc_security_group_ingress_rule" "nat_from_vpc" {
  count             = var.nat_mode == "instance" ? 1 : 0
  security_group_id = aws_security_group.nat[0].id
  description       = "Everything from inside the VPC"
  cidr_ipv4         = var.cidr_block
  ip_protocol       = "-1"
}

resource "aws_vpc_security_group_egress_rule" "nat_to_internet" {
  count             = var.nat_mode == "instance" ? 1 : 0
  security_group_id = aws_security_group.nat[0].id
  description       = "NAT egress to the internet (GitHub, OpenAI, image registries)"
  cidr_ipv4         = "0.0.0.0/0" #trivy:ignore:AVD-AWS-0104 a NAT exists to reach the internet
  ip_protocol       = "-1"
}

resource "aws_instance" "nat" {
  count                       = var.nat_mode == "instance" ? 1 : 0
  ami                         = data.aws_ami.fck_nat[0].id
  instance_type               = var.nat_instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.nat[0].id]
  associate_public_ip_address = true
  # A NAT forwards packets that are neither from nor to itself.
  source_dest_check = false

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  root_block_device {
    encrypted   = true
    volume_type = "gp3"
  }

  tags = { Name = "${var.name}-nat" }

  lifecycle {
    # A newer fck-nat image is picked up by replacing the instance deliberately, not on every plan.
    ignore_changes = [ami]
  }
}

resource "aws_eip" "nat" {
  count  = var.nat_mode == "gateway" ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${var.name}-nat" }
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_mode == "gateway" ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = var.name }
  depends_on    = [aws_internet_gateway.this]
}

resource "aws_route" "private_egress" {
  count                  = var.nat_mode == "none" ? 0 : 1
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = var.nat_mode == "instance" ? aws_instance.nat[0].primary_network_interface_id : null
  nat_gateway_id         = var.nat_mode == "gateway" ? aws_nat_gateway.this[0].id : null
}
