# ---------------------------------------------------------------------------
# Safe outputs only. No secret values are ever exposed.
# ---------------------------------------------------------------------------

output "vpc_id" {
  description = "OneSIM staging VPC id"
  value       = aws_vpc.staging.id
}

output "public_subnet_ids" {
  description = "Public (ALB) subnet ids"
  value       = aws_subnet.public[*].id
}

output "private_app_subnet_ids" {
  description = "Private application (ECS) subnet ids"
  value       = aws_subnet.private_app[*].id
}

output "database_subnet_ids" {
  description = "Isolated database subnet ids"
  value       = aws_subnet.database[*].id
}

output "alb_dns_name" {
  description = "ALB DNS name (for later controlled DNS/certificate integration with staging.onetelecom.cloud)"
  value       = aws_lb.staging.dns_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.staging.name
}

output "ecs_service_name" {
  description = "ECS service name (single task, in-process worker disabled initially)"
  value       = aws_ecs_service.staging.name
}

output "database_endpoint" {
  description = "RDS endpoint (host:port). Marked sensitive; not a credential."
  value       = aws_db_instance.postgres.endpoint
  sensitive   = true
}

output "database_secret_arn" {
  description = "Secrets Manager ARN holding the DB credentials / DATABASE_URL"
  value       = aws_secretsmanager_secret.database_url.arn
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group used by ECS"
  value       = aws_cloudwatch_log_group.staging.name
}

output "ecr_image_digest" {
  description = "Immutable ECR image digest used by all task definitions"
  value       = var.ecr_image_digest
}