output "vpc_id" {
  description = "The ID of the VPC"
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "List of private subnet IDs"
  value       = aws_subnet.private[*].id
}

output "data_subnet_ids" {
  description = "List of data subnet IDs (databases)"
  value       = aws_subnet.data[*].id
}

output "rds_primary_endpoint" {
  description = "RDS primary instance endpoint"
  value       = aws_db_instance.primary.endpoint
}

output "rds_replica_endpoint" {
  description = "RDS read replica endpoint (production only)"
  value       = length(aws_db_instance.read_replica) > 0 ? aws_db_instance.read_replica[0].endpoint : null
}

output "redis_primary_endpoint" {
  description = "Redis primary endpoint"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "alb_dns_name" {
  description = "ALB DNS name"
  value       = aws_lb.main.dns_name
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "documents_bucket_name" {
  description = "S3 bucket name for clinical documents"
  value       = aws_s3_bucket.documents.id
}

output "exports_bucket_name" {
  description = "S3 bucket name for data exports"
  value       = aws_s3_bucket.exports.id
}

output "service_discovery_namespace" {
  description = "Service discovery namespace for internal DNS"
  value       = aws_service_discovery_private_dns_namespace.main.name
}

output "kms_rds_key_arn" {
  description = "KMS key ARN for RDS encryption"
  value       = aws_kms_key.rds.arn
}

output "kms_s3_key_arn" {
  description = "KMS key ARN for S3 encryption"
  value       = aws_kms_key.s3.arn
}
