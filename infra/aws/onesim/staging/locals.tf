# Local values shared across resources.

locals {
  common_tags = {
    Project     = var.project
    Environment = var.environment
    ManagedBy   = "Terraform"
  }

  name_prefix = "onesim-staging"

  # Immutable ECR image URI: <account>.dkr.ecr.<region>.amazonaws.com/<repo>@<digest>
  image_uri = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.aws_region}.amazonaws.com/${var.ecr_image_repo}@${var.ecr_image_digest}"

  # Public (non-secret) runtime configuration injected via container `environment`.
  public_runtime_env = {
    NODE_ENV                = "production"
    PORT                    = "3000"
    HOSTNAME                = "0.0.0.0"
    NEXT_TELEMETRY_DISABLED = "1"
    APP_ENV                 = var.app_env
    NEXTAUTH_URL            = var.nextauth_url
    JOB_WORKER_ENABLED      = var.job_worker_enabled
    # Staging certification posture: every provider/external-mutation surface stays
    # disabled until controlled runtime certification completes. Absent flags
    # default to equivalent off-state in application code.
    ALLOW_MOCK_PROVIDERS                     = "false"
    OUTBOUND_CALLBACKS_ENABLED               = "false"
    ORDER_RECOVERY_ENABLED                   = "false"
    INVENTORY_RESERVATION_SWEEP_ENABLED      = "false"
    EXCHANGE_RATE_REFRESH_ENABLED            = "false"
    CUSTOM_PACKAGE_UPSTREAM_CREATION_ENABLED = "false"
    ADMIN_OPERATIONS_ACTIONS_ENABLED         = "false"
  }

  # Secret ARNs referenced by the web and migration task definitions.
  # RESEND_API_KEY intentionally excluded until email is enabled (container exists,
  # no value, never referenced by the default task).
  web_secret_arns = concat(
    [aws_secretsmanager_secret.database_url.arn],
    [for k, v in aws_secretsmanager_secret.app : v.arn],
  )
}