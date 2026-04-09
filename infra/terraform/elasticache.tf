# =============================================================================
# ElastiCache Redis Configuration
# =============================================================================
#
# Redis cluster used for:
# - Session storage (JWT token caching)
# - Rate limiting
# - Claim processing queue (using Redis Streams)
# - Feature flag caching
# - Patient record caching (encrypted, short TTL)
#
# HIPAA Notes:
# - Encryption at rest enabled (AES-256 via AWS KMS)
# - Encryption in transit enabled (TLS)
# - No PHI should be stored in Redis for more than 1 hour
#   (enforced via TTL in application code, not at Redis level)
# - Redis AUTH enabled

resource "aws_kms_key" "elasticache" {
  description             = "KMS key for Meridian ElastiCache encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name       = "meridian-${var.environment}-elasticache-key"
    Compliance = "hipaa"
  }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "meridian-${var.environment}-cache-subnet"
  subnet_ids = aws_subnet.data[*].id

  tags = {
    Name = "meridian-${var.environment}-cache-subnet"
  }
}

resource "aws_elasticache_parameter_group" "main" {
  family = "redis7"
  name   = "meridian-${var.environment}-redis7"

  # Memory management
  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru" # Evict keys with TTL first (important for PHI caching)
  }

  # Keyspace notifications for cache invalidation
  parameter {
    name  = "notify-keyspace-events"
    value = "Ex" # Expired events only
  }

  # Snapshotting - disabled, we don't want PHI persisted to disk
  parameter {
    name  = "save"
    value = ""
  }

  # Connection limits
  parameter {
    name  = "maxclients"
    value = "65000"
  }

  tags = {
    Name = "meridian-${var.environment}-redis7-params"
  }
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "meridian-${var.environment}-redis"
  description          = "Meridian Health Redis cluster"

  node_type            = var.redis_node_type
  num_cache_clusters   = var.environment == "production" ? 3 : 1
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.main.name
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.cache.id]

  # Engine
  engine               = "redis"
  engine_version       = "7.0"

  # Encryption - required for HIPAA
  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.elasticache.arn
  transit_encryption_enabled = true
  # Note: transit_encryption_enabled = true means clients must use TLS
  # All our services are configured to use rediss:// (TLS) connection strings

  # AUTH token (password)
  auth_token = var.redis_auth_token

  # Automatic failover (production only)
  automatic_failover_enabled = var.environment == "production" ? true : false
  multi_az_enabled           = var.environment == "production" ? true : false

  # Maintenance window
  maintenance_window = "Sun:05:00-Sun:06:00"

  # Snapshot (disabled - no PHI persistence)
  snapshot_retention_limit = 0

  # Notifications
  notification_topic_arn = aws_sns_topic.infrastructure_alerts.arn

  tags = {
    Name        = "meridian-${var.environment}-redis"
    ContainsPHI = "transient" # PHI may be cached briefly
    Compliance  = "hipaa"
  }

  lifecycle {
    ignore_changes = [
      auth_token, # Managed via rotation
    ]
  }
}

# SNS topic for infrastructure alerts
resource "aws_sns_topic" "infrastructure_alerts" {
  name = "meridian-${var.environment}-infra-alerts"

  tags = {
    Name = "meridian-${var.environment}-infra-alerts"
  }
}
