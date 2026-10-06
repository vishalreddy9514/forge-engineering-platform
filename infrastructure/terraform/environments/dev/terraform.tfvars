# dev: the cheapest configuration that still has the production shape (docs/deployment.md,
# about $73/month running and $3/month hibernated). Domain and images come from the workflow.
region = "eu-west-2"

nat_mode = "instance" # fck-nat on a t4g.nano

# Everything on Fargate Spot: interruptions only restart a task in dev.
sizes = {
  api          = { cpu = 512, memory = 1024, count = 1, max = 1, spot = true }
  worker       = { cpu = 256, memory = 512, count = 1, max = 1, spot = true }
  web          = { cpu = 256, memory = 512, count = 1, max = 1, spot = true }
  "ai-service" = { cpu = 256, memory = 512, count = 1, max = 1, spot = true }
}

db_instance_class        = "db.t4g.micro"
db_multi_az              = false
db_backup_retention_days = 7
redis_replicas           = 0
deletion_protection      = false # `terraform destroy` removes everything
container_insights       = false
