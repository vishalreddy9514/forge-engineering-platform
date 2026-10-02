#!/usr/bin/env bash
# Runs the migrate task once (prisma migrate deploy, then the AI service login) and waits for it.
# Called by terraform_data.migrate with CLUSTER, TASK_DEFINITION, SUBNETS, SECURITY_GROUP,
# LOG_GROUP and AWS_REGION; exits non-zero, failing the apply, if the migration fails.
set -euo pipefail

task_arn=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEFINITION" \
  --capacity-provider-strategy capacityProvider=FARGATE,weight=1 \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SECURITY_GROUP],assignPublicIp=DISABLED}" \
  --started-by terraform-migrate \
  --query 'tasks[0].taskArn' --output text)

if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
  echo "Could not start the migrate task" >&2
  exit 1
fi
echo "Migrate task: $task_arn"

# `tasks-stopped` gives up after 10 minutes; migrations here take seconds.
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task_arn"

read -r exit_code reason < <(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" \
  --query 'tasks[0].[containers[0].exitCode, stoppedReason]' --output text)

task_id=${task_arn##*/}
echo "Logs: aws logs tail $LOG_GROUP --log-stream-name-prefix migrate/migrate/$task_id"
if [[ "$exit_code" != "0" ]]; then
  echo "Migration failed (exit code $exit_code): $reason" >&2
  aws logs tail "$LOG_GROUP" --log-stream-name-prefix "migrate/migrate/$task_id" --since 30m >&2 || true
  exit 1
fi
echo "Migrations applied."
