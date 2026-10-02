variable "name" {
  description = "Prefix for every resource name, e.g. forge-dev."
  type        = string
}

variable "cidr_block" {
  description = "VPC address range. Public subnets take /24s 0-1, private subnets 10-11."
  type        = string
  default     = "10.0.0.0/16"
}

variable "nat_mode" {
  description = "Private-subnet egress: instance (fck-nat), gateway (managed NAT) or none."
  type        = string
  default     = "instance"
  validation {
    condition     = contains(["instance", "gateway", "none"], var.nat_mode)
    error_message = "nat_mode must be instance, gateway or none."
  }
}

variable "nat_instance_type" {
  description = "Instance type for fck-nat (arm64)."
  type        = string
  default     = "t4g.nano"
}
