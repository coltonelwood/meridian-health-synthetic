# =============================================================================
# RDS PostgreSQL Configuration
# =============================================================================
#
# Primary database cluster for Meridian Health. PostgreSQL 15 on RDS.
# Uses Multi-AZ deployment with a read replica for reporting queries.
#
# HIPAA Notes:
# - Encryption at rest using AWS KMS (customer-managed key)
# - SSL/TLS enforced for all connections
# - Automated backups retained for 35 days
# - Manual snapshots retained for 7 years (compliance requirement)
# - Enhanced monitoring enabled
# - Performance Insights enabled (no PHI in query parameters)
#
# Performance tuning notes:
# - shared_buffers: 25% of instance memory (default for RDS)
# - work_mem: 256MB for complex claim queries
# - max_connections: 200 (we use pgBouncer in front, so this is fine)
# - effective_cache_size: 75% of instance memory
# - random_page_cost: 1.1 (using gp3 SSD)
# - We hit connection limits during the Q4 2025 enrollment surge.
#   Added pgBouncer as a connection pooler in January 2026.

resource "aws_db_subnet_group" "main" {
  name       = "meridian-${var.environment}-db-subnet"
  subnet_ids = aws_subnet.data[*].id

  tags = {
    Name = "meridian-${var.environment}-db-subnet-group"
  }
}

resource "aws_kms_key" "rds" {
  description             = "KMS key for Meridian Health RDS encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name       = "meridian-${var.environment}-rds-key"
    Purpose    = "database-encryption"
    Compliance = "hipaa"
  }
}

resource "aws_kms_alias" "rds" {
  name          = "alias/meridian-${var.environment}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

# Parameter group tuned for healthcare workloads
resource "aws_db_parameter_group" "main" {
  family = "postgres15"
  name   = "meridian-${var.environment}-pg15"

  # Connection settings
  parameter {
    name  = "max_connections"
    value = "200"
  }

  # Memory settings
  parameter {
    name  = "shared_buffers"
    value = "{DBInstanceClassMemory/4}" # 25% of instance memory
  }

  parameter {
    name  = "work_mem"
    value = "262144" # 256MB - needed for complex claim aggregation queries
  }

  parameter {
    name  = "maintenance_work_mem"
    value = "524288" # 512MB
  }

  parameter {
    name  = "effective_cache_size"
    value = "{DBInstanceClassMemory*3/4}" # 75% of instance memory
  }

  # Query planner settings
  parameter {
    name  = "random_page_cost"
    value = "1.1" # SSD-optimized
  }

  parameter {
    name  = "effective_io_concurrency"
    value = "200" # gp3 can handle this
  }

  # WAL settings
  parameter {
    name  = "wal_buffers"
    value = "65536" # 64MB
  }

  parameter {
    name  = "checkpoint_completion_target"
    value = "0.9"
  }

  # Logging - be careful not to log query parameters (PHI!)
  parameter {
    name  = "log_statement"
    value = "ddl" # Only log DDL statements, not queries with PHI
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "5000" # Log queries over 5 seconds (for performance tuning)
  }

  # IMPORTANT: Do NOT set log_statement to 'all' - it would log PHI
  # in query parameters. The audit log handles PHI access tracking.

  # SSL enforcement
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # Statement timeout - prevent runaway queries
  parameter {
    name  = "statement_timeout"
    value = "300000" # 5 minutes
  }

  # Lock timeout
  parameter {
    name  = "lock_timeout"
    value = "30000" # 30 seconds
  }

  tags = {
    Name = "meridian-${var.environment}-pg15-params"
  }
}

# Primary RDS instance
resource "aws_db_instance" "primary" {
  identifier = "meridian-${var.environment}-primary"

  engine               = "postgres"
  engine_version       = "15.4"
  instance_class       = var.rds_instance_class
  allocated_storage    = var.rds_storage_gb
  max_allocated_storage = var.rds_max_storage_gb # Autoscaling
  storage_type         = "gp3"
  storage_encrypted    = true
  kms_key_id           = aws_kms_key.rds.arn

  db_name  = "meridian"
  username = "meridian_admin"
  # Password managed via AWS Secrets Manager
  manage_master_user_password = true

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  # High availability
  multi_az = var.environment == "production" ? true : false

  # Backup configuration
  backup_retention_period = 35
  backup_window           = "03:00-04:00"
  maintenance_window      = "Mon:04:00-Mon:05:00"

  # Monitoring
  monitoring_interval          = 60
  monitoring_role_arn          = aws_iam_role.rds_monitoring.arn
  performance_insights_enabled = true
  performance_insights_retention_period = 731 # 2 years

  # Deletion protection
  deletion_protection = var.environment == "production" ? true : false
  skip_final_snapshot = var.environment == "production" ? false : true
  final_snapshot_identifier = var.environment == "production" ? "meridian-${var.environment}-final-${formatdate("YYYY-MM-DD", timestamp())}" : null

  # Enable automated minor version upgrades
  auto_minor_version_upgrade = true

  # Enable CloudWatch log exports
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = {
    Name        = "meridian-${var.environment}-primary"
    ContainsPHI = "true"
    BackupTier  = "critical"
  }

  lifecycle {
    ignore_changes = [
      final_snapshot_identifier,
    ]
  }
}

# Read replica for reporting and analytics queries
resource "aws_db_instance" "read_replica" {
  count = var.environment == "production" ? 1 : 0

  identifier = "meridian-${var.environment}-replica"

  replicate_source_db = aws_db_instance.primary.identifier
  instance_class      = var.rds_replica_instance_class
  storage_encrypted   = true
  kms_key_id          = aws_kms_key.rds.arn

  vpc_security_group_ids = [aws_security_group.database.id]
  parameter_group_name   = aws_db_parameter_group.main.name

  # Read replicas don't need Multi-AZ
  multi_az = false

  # No backups on read replica
  backup_retention_period = 0

  # Monitoring
  monitoring_interval          = 60
  monitoring_role_arn          = aws_iam_role.rds_monitoring.arn
  performance_insights_enabled = true

  auto_minor_version_upgrade = true

  tags = {
    Name        = "meridian-${var.environment}-replica"
    ContainsPHI = "true"
    Purpose     = "reporting"
  }
}

# IAM role for enhanced monitoring
resource "aws_iam_role" "rds_monitoring" {
  name = "meridian-${var.environment}-rds-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  role       = aws_iam_role.rds_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}
