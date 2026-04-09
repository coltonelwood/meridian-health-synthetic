# =============================================================================
# S3 Bucket Configuration
# =============================================================================
#
# All buckets are encrypted with SSE-KMS (customer-managed keys) and
# versioning is enabled for compliance. Lifecycle policies manage
# transitions to cheaper storage classes and eventual deletion per
# our data retention policy.
#
# Data Retention Policy (per Legal/Compliance, updated 2025-09):
# - Patient records: 7 years after last encounter (state-specific, using max)
# - Financial records: 7 years
# - Audit logs: 6 years
# - Clinical documents: 10 years (some states require longer for minors)
# - Temporary/operational: 90 days

resource "aws_kms_key" "s3" {
  description             = "KMS key for Meridian S3 bucket encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true

  tags = {
    Name       = "meridian-${var.environment}-s3-key"
    Compliance = "hipaa"
  }
}

# =============================================================================
# Documents Bucket (clinical documents, PDFs, images)
# =============================================================================

resource "aws_s3_bucket" "documents" {
  bucket = "meridian-${var.environment}-documents-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name        = "meridian-${var.environment}-documents"
    ContainsPHI = "true"
    Compliance  = "hipaa"
    RetentionPolicy = "10-years"
  }
}

resource "aws_s3_bucket_versioning" "documents" {
  bucket = aws_s3_bucket.documents.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "documents" {
  bucket = aws_s3_bucket.documents.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  rule {
    id     = "transition-to-ia"
    status = "Enabled"

    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 365
      storage_class = "GLACIER"
    }

    # 10 year retention for clinical documents
    # NOTE: We previously had this at 7 years but Legal changed it to 10
    # after the 2025 compliance audit. Some states require up to 10 years
    # for minor patients (calculated from age of majority).
    expiration {
      days = 3650
    }

    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_s3_bucket_logging" "documents" {
  bucket = aws_s3_bucket.documents.id

  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = "s3-documents/"
}

# =============================================================================
# Backups Bucket
# =============================================================================

resource "aws_s3_bucket" "backups" {
  bucket = "meridian-${var.environment}-backups-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name        = "meridian-${var.environment}-backups"
    ContainsPHI = "true"
    Compliance  = "hipaa"
    RetentionPolicy = "7-years"
  }
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket = aws_s3_bucket.backups.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id

  rule {
    id     = "backup-lifecycle"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    transition {
      days          = 365
      storage_class = "DEEP_ARCHIVE"
    }

    expiration {
      days = 2555 # 7 years
    }
  }
}

# =============================================================================
# Exports Bucket (reports, data extracts, ERA files)
# =============================================================================

resource "aws_s3_bucket" "exports" {
  bucket = "meridian-${var.environment}-exports-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name        = "meridian-${var.environment}-exports"
    ContainsPHI = "true"
    Compliance  = "hipaa"
    RetentionPolicy = "7-years"
  }
}

resource "aws_s3_bucket_versioning" "exports" {
  bucket = aws_s3_bucket.exports.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket = aws_s3_bucket.exports.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    id     = "export-lifecycle"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 180
      storage_class = "GLACIER"
    }

    expiration {
      days = 2555 # 7 years
    }
  }

  # Temp exports (e.g., CSV downloads) expire quickly
  rule {
    id     = "temp-exports"
    status = "Enabled"

    filter {
      prefix = "temp/"
    }

    expiration {
      days = 7
    }
  }
}

# =============================================================================
# Access Logs Bucket
# =============================================================================

resource "aws_s3_bucket" "access_logs" {
  bucket = "meridian-${var.environment}-access-logs-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name        = "meridian-${var.environment}-access-logs"
    ContainsPHI = "false"
    Compliance  = "hipaa"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256" # S3 access logs don't support KMS
    }
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "log-lifecycle"
    status = "Enabled"

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    expiration {
      days = 365 # 1 year for access logs
    }
  }
}

# =============================================================================
# CORS policy for documents bucket (patient portal uploads)
# =============================================================================

resource "aws_s3_bucket_cors_configuration" "documents" {
  bucket = aws_s3_bucket.documents.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST"]
    allowed_origins = var.environment == "production" ? [
      "https://portal.meridianhealth.io",
      "https://admin.meridianhealth.io",
    ] : [
      "http://localhost:3000",
      "https://*.meridianhealth.dev",
    ]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}
