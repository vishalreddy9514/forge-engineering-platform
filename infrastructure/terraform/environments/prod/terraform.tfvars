# prod: the same modules, sized for availability (architecture §10). Not deployed in this
# project; kept so the difference from dev is explicit and reviewed.
region = "eu-west-2"

nat_mode = "gateway" # a managed NAT Gateway: no single instance on the egress path

# Two tasks of everything serving traffic, on regular Fargate; background work can be interrupted.
sizes = {
  api          = { cpu = 1024, memory = 2048, count = 2, max = 6, spot = false }
  worker       = { cpu = 512, memory = 1024, count = 2, max = 4, spot = true }
  web          = { cpu = 512, memory = 1024, count = 2, max = 4, spot = false }
  "ai-service" = { cpu = 512, memory = 1024, count = 2, max = 4, spot = true }
}

db_instance_class        = "db.t4g.medium"
db_multi_az              = true
db_backup_retention_days = 14
redis_replicas           = 1 # Multi-AZ failover
deletion_protection      = true
container_insights       = true
