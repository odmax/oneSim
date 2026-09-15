# ---------------------------------------------------------------------------
# Reusable ONE-OFF migration task definition.
#
# Architecture: `prisma migrate deploy` NEVER runs at application startup. It
# is executed only as an explicit one-off ECS task before/at staging promotion.
# This file registers a task definition only (registration is safe and does not
# run anything). The controlled one-off run (aws_ecs_task) is intentionally
# NOT created here.
#
# The service must never race migrations: the web service is not created as a
# dependency of this task.
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "migration" {
  family                   = "onesim-staging-migration"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "onesim-migrate"
    image     = local.image_uri
    essential = true
    # One-off command: deterministic direct execution of the Prisma CLI binary that is
    # already a production dependency in the certified image (no package-manager layer).
    command = ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]

    environment = [
      { name = "NODE_ENV", value = "production" },
    ]

    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.database_url.arn}:DATABASE_URL::" }
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.staging.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "onesim-migration"
      }
    }
  }])

  tags = merge(local.common_tags, { Name = "onesim-staging-migration-task" })
}