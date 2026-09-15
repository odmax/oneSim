# ---------------------------------------------------------------------------
# OneSIM staging — variables
# ---------------------------------------------------------------------------
# No secret values live in this file. Runtime secrets are provisioned through
# AWS Secrets Manager (see secrets.tf / rds.tf) and are never printed.
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region for OneSIM staging infrastructure."
  type        = string
  default     = "af-south-1"
}

variable "project" {
  description = "Project tag value."
  type        = string
  default     = "OneSIM"
}

variable "environment" {
  description = "Environment tag value / resource suffix."
  type        = string
  default     = "staging"
}

variable "vpc_cidr" {
  description = "Dedicated OneSIM staging VPC CIDR. Deliberately disjoint from the unrelated esimiot VPC (10.0.0.0/16)."
  type        = string
  default     = "10.20.0.0/16"
}

variable "azs" {
  description = "Availability zones for OneSIM staging."
  type        = list(string)
  default     = ["af-south-1a", "af-south-1b"]
}

variable "public_subnet_cidrs" {
  description = "Public subnets (ALB)."
  type        = list(string)
  default     = ["10.20.0.0/24", "10.20.1.0/24"]
}

variable "private_app_subnet_cidrs" {
  description = "Private application subnets (ECS/Fargate)."
  type        = list(string)
  default     = ["10.20.10.0/24", "10.20.11.0/24"]
}

variable "database_subnet_cidrs" {
  description = "Isolated database subnet CIDRs (no default Internet/NAT route)."
  type        = list(string)
  default     = ["10.20.20.0/24", "10.20.21.0/24"]
}

# ---------------------------------------------------------------------------
# Application image (immutable, digest-pinned)
# ---------------------------------------------------------------------------

variable "ecr_image_repo" {
  description = "ECR repository holding the OneSIM application image."
  type        = string
  default     = "onesim-app"
}

variable "ecr_image_digest" {
  description = "Immutable image digest used by the ECS task definitions. NEVER a mutable tag."
  type        = string
  default     = "sha256:723069f1d4b7d5560363489bdd97d7955d006c510ef1e62fe4e4872d1294273b"
}

# ---------------------------------------------------------------------------
# ECS task sizing / runtime
# ---------------------------------------------------------------------------

variable "ecs_task_cpu" {
  description = "Fargate task CPU units (512 = 0.5 vCPU)."
  type        = number
  default     = 512
}

variable "ecs_task_memory" {
  description = "Fargate task memory MiB."
  type        = number
  default     = 1024
}

variable "ecs_desired_count" {
  description = "Initial service desired count. Intentionally ONE task while worker/multi-replica runtime is certified."
  type        = number
  default     = 1
}

variable "stop_timeout" {
  description = "Container stopTimeout (seconds) for graceful shutdown."
  type        = number
  default     = 120
}

variable "log_retention_days" {
  description = "CloudWatch log group retention for /ecs/onesim-staging."
  type        = number
  default     = 30
}

variable "health_check_grace_period_seconds" {
  description = "ALB-target health check grace period for Next.js startup."
  type        = number
  default     = 90
}

variable "alb_healthcheck_path" {
  description = "Provider-free ALB target health check path."
  type        = string
  default     = "/api/health"
}

# ---------------------------------------------------------------------------
# Runtime configuration (public, non-secret)
# ---------------------------------------------------------------------------

variable "job_worker_enabled" {
  description = "In-process background worker gate (JOB_WORKER_ENABLED). Initial certification runs with false; flip after DB/migration/runtime certification."
  type        = string
  default     = "false"
}

variable "app_env" {
  description = "APP_ENV for the application. 'development' for initial certification before DNS/ACM exists; flip to 'staging' after staging.onetelecom.cloud + certificate are integrated (do not fabricate DNS/ACM)."
  type        = string
  default     = "development"
}

variable "nextauth_url" {
  description = "NEXTAUTH_URL. Keep consistent with APP_ENV: 'staging' requires https://staging.onetelecom.cloud. Harmless in development mode (URL safety check is bypassed)."
  type        = string
  default     = "https://staging.onetelecom.cloud"
}

# ---------------------------------------------------------------------------
# Database (RDS PostgreSQL)
# ---------------------------------------------------------------------------

variable "database_engine_version" {
  description = "RDS PostgreSQL engine version (staging, cost-conscious standard RDS)."
  type        = string
  default     = "16.6"
}

variable "database_instance_class" {
  description = "RDS instance class for staging."
  type        = string
  default     = "db.t4g.small"
}

variable "database_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "database_storage_type" {
  description = "gp2 for broad af-south-1 availability (gp3 not guaranteed in this region)."
  type        = string
  default     = "gp2"
}

variable "database_name" {
  description = "Initial database created on the RDS instance."
  type        = string
  default     = "onesim_staging"
}

variable "database_username" {
  description = "Database master username (NOT a password; password is randomly generated in Secrets Manager)."
  type        = string
  default     = "onesim"
}

# ---------------------------------------------------------------------------
# Application SecretsManager containers/placeholders (names only, no values)
# ---------------------------------------------------------------------------

variable "application_secret_specs" {
  description = "Runtime secrets referenced by the ECS task definition. Values are generated as safe random placeholders stored ONLY in Secrets Manager (never in this repo/state outputs)."
  type = map(object({
    byte_length = number
  }))
  default = {
    NEXTAUTH_SECRET               = { byte_length = 32 }
    ENCRYPTION_KEY                = { byte_length = 32 }
    CRON_SECRET                   = { byte_length = 16 }
    CALLBACK_SIGNING_SECRET       = { byte_length = 16 }
    ORDER_CALLBACK_JOB_SECRET     = { byte_length = 16 }
    INVENTORY_RESERVATION_JOB_SECRET = { byte_length = 16 }
    ORDER_RECOVERY_JOB_SECRET     = { byte_length = 16 }
    EXCHANGE_RATE_JOB_SECRET      = { byte_length = 16 }
    WEBHOOK_SECRET                = { byte_length = 16 }
  }
}

variable "resend_api_key_secret_name" {
  description = "Optional container for RESEND_API_KEY (email). Created without a value; populate only if email via Resend is enabled."
  type        = string
  default     = "onesim/staging/RESEND_API_KEY"
}