# ---------------------------------------------------------------------------
# Security groups — explicit chain:  Internet -> ALB -> ECS -> DB
# ---------------------------------------------------------------------------

# ALB: inbound 80 from anywhere; HTTPS 443 intentionally NOT opened until an ACM
# certificate exists (do not fabricate a certificate ARN).
resource "aws_security_group" "alb" {
  name        = "onesim-staging-alb-sg"
  description = "ALB for OneSIM staging"
  vpc_id      = aws_vpc.staging.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # HTTPS 443 added in the later certificate gate.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "onesim-staging-alb-sg" })
}

# ECS: only TCP 3000 from the ALB SG.
resource "aws_security_group" "ecs" {
  name        = "onesim-staging-ecs-sg"
  description = "ECS tasks for OneSIM staging"
  vpc_id      = aws_vpc.staging.id

  ingress {
    description     = "App traffic from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Outbound: app needs egress to the DB and (later) provider APIs via NAT.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "onesim-staging-ecs-sg" })
}

# DB: only TCP 5432 from the ECS SG; no egress rules (RDS initiates nothing).
resource "aws_security_group" "database" {
  name        = "onesim-staging-db-sg"
  description = "RDS for OneSIM staging"
  vpc_id      = aws_vpc.staging.id

  ingress {
    description     = "PostgreSQL from ECS tasks"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  tags = merge(local.common_tags, { Name = "onesim-staging-db-sg" })
}