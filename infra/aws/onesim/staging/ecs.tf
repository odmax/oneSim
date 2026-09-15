# ---------------------------------------------------------------------------
# ECS Fargate: cluster, IAM roles, web task definition + service.
# No separate worker service (single-task staging model), no scheduled jobs.
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "staging" {
  name = "onesim-staging-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled" # staging; enable when needed
  }

  tags = merge(local.common_tags, { Name = "onesim-staging-cluster" })
}

resource "aws_cloudwatch_log_group" "staging" {
  name              = "/ecs/onesim-staging"
  retention_in_days = var.log_retention_days
  tags              = local.common_tags
}

# --- Execution role (least privilege) ---

data "aws_iam_policy_document" "ecs_execution_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "onesim-staging-ecs-execution-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_execution_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "ecs_execution_policy" {
  # CloudWatch logs for the task log group
  statement {
    sid       = "CloudWatchLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.staging.arn}:*"]
  }
  # ECR image pull for onesim-app only
  statement {
    sid       = "ECRImagePull"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
  statement {
    sid     = "ECRImageLayerAccess"
    effect  = "Allow"
    actions = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
    resources = [
      "arn:aws:ecr:${var.aws_region}:${data.aws_caller_identity.current.account_id}:repository/${var.ecr_image_repo}"
    ]
  }
  # SecretsManager: retrieve EXACTLY the secrets referenced by the task
  statement {
    sid       = "SecretsManagerGetSecretValue"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.web_secret_arns
  }
}

resource "aws_iam_policy" "ecs_execution" {
  name        = "onesim-staging-ecs-execution-policy"
  description = "Least-privilege execution policy for OneSIM staging ECS tasks."
  policy      = data.aws_iam_policy_document.ecs_execution_policy.json
  tags        = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = aws_iam_policy.ecs_execution.arn
}

# --- Application task role (least privilege; no permissions yet) ---

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task" {
  name               = "onesim-staging-ecs-task-role"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
  description        = "Runtime task role for OneSIM staging. Intentionally no attached policies; additive per-certification requirements only."
  tags               = local.common_tags
}

# --- Web task definition (immutable image digest) ---

resource "aws_ecs_task_definition" "web" {
  family                   = "onesim-staging"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ecs_task_cpu
  memory                   = var.ecs_task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name        = "onesim"
    image       = local.image_uri
    essential   = true
    stopTimeout = var.stop_timeout

    portMappings = [
      {
        containerPort = 3000
        hostPort      = 3000
        protocol      = "tcp"
      }
    ]

    environment = [
      for k, v in local.public_runtime_env : { name = k, value = v }
    ]

    secrets = concat(
      [{ name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.database_url.arn}:DATABASE_URL::" }],
      [
        for k, v in aws_secretsmanager_secret.app :
        { name = k, valueFrom = v.arn }
      ]
    )

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.staging.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "onesim-staging"
      }
    }
  }])

  tags = merge(local.common_tags, { Name = "onesim-staging-web-task" })
}

# --- Service (initially desired_count = 1) ---

resource "aws_ecs_service" "staging" {
  name            = "onesim-staging-service"
  cluster         = aws_ecs_cluster.staging.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.ecs_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private_app[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.staging.arn
    container_name   = "onesim"
    container_port   = 3000
  }

  health_check_grace_period_seconds = var.health_check_grace_period_seconds

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  tags = merge(local.common_tags, { Name = "onesim-staging-service" })
}