# ---------------------------------------------------------------------------
# Dedicated RDS PostgreSQL for OneSIM staging.
#
# Choice: STANDARD RDS PostgreSQL (not Aurora Serverless).
# Application evidence: Prisma provider = postgresql; schema uses only standard
# PostgreSQL types (text, int, Decimal, Json, enums, timestamps) with no
# extensions/geometric/Aurora-specific features. Standard RDS gives predictable
# staging cost, simplest snapshots/parameter groups and lowest operational
# complexity. Aurora Serverless v2 would add cost/behavioral surface with no
# benefit at staging scale.
# ---------------------------------------------------------------------------

resource "aws_db_subnet_group" "staging" {
  name        = "onesim-staging-db-subnet-group"
  description = "OneSIM staging database subnets (isolated, no Internet route)"
  subnet_ids  = aws_subnet.database[*].id
  tags        = merge(local.common_tags, { Name = "onesim-staging-db-subnet-group" })
}

resource "aws_db_instance" "postgres" {
  identifier        = "onesim-staging"
  engine            = "postgres"
  engine_version    = var.database_engine_version
  instance_class    = var.database_instance_class
  allocated_storage = var.database_allocated_storage_gb
  storage_type      = var.database_storage_type
  storage_encrypted = true

  db_name  = var.database_name
  username = var.database_username
  password = random_password.database.result

  db_subnet_group_name   = aws_db_subnet_group.staging.name
  vpc_security_group_ids = [aws_security_group.database.id]

  publicly_accessible = false

  multi_az                = false # staging
  backup_retention_period = 7
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:05:00-sun:06:00"

  # Deliberate destroy behavior: keep a final snapshot before destruction
  # (data-preserving for staging). Deletion protection stays off for staging.
  deletion_protection       = false
  skip_final_snapshot       = false
  final_snapshot_identifier = "onesim-staging-rds-final"

  performance_insights_enabled = false
  monitoring_interval          = 0
  auto_minor_version_upgrade   = true

  tags = merge(local.common_tags, { Name = "onesim-staging-rds" })
}

# Master password is machine-generated and stored ONLY in Secrets Manager.
resource "random_password" "database" {
  length      = 24
  special     = false
  upper       = true
  lower       = true
  numeric     = true
  min_upper   = 1
  min_lower   = 1
  min_numeric = 1
}

# Structured DB credential secret + derived Prisma DATABASE_URL.
resource "aws_secretsmanager_secret" "database_url" {
  name = "onesim/staging/database-url"
  tags = merge(local.common_tags, { Name = "onesim/staging/database-url" })
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = jsonencode({
    DATABASE_URL = "postgresql://${var.database_username}:${random_password.database.result}@${aws_db_instance.postgres.endpoint}/${var.database_name}?schema=public"
    engine       = "postgres"
    host         = aws_db_instance.postgres.address
    port         = aws_db_instance.postgres.port
    dbname       = var.database_name
    username     = var.database_username
  })
}