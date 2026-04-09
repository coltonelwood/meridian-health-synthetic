# =============================================================================
# Terraform Backend Configuration
# =============================================================================
#
# State is stored in S3 with DynamoDB locking. The state file itself
# contains sensitive values (database passwords, etc.) so the bucket
# is encrypted and access is tightly controlled.
#
# IMPORTANT: If you need to migrate state, coordinate with the platform
# team first. Last state migration was in March 2025 and it caused a
# 2-hour outage because someone ran terraform apply before the migration
# was complete.

terraform {
  backend "s3" {
    bucket         = "meridian-terraform-state"
    key            = "infrastructure/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "meridian-terraform-locks"
    kms_key_id     = "alias/meridian-terraform-state"

    # Role assumption for state access
    # Only CI/CD and the platform team have access to this role
    role_arn = "arn:aws:iam::123456789012:role/meridian-terraform-state-access"
  }
}
