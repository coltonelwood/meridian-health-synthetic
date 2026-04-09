# =============================================================================
# Meridian Health Technologies - Main Infrastructure
# =============================================================================
#
# This is the primary Terraform configuration for the Meridian Health
# AWS infrastructure. All resources are deployed in us-east-1 (primary)
# with disaster recovery in us-west-2.
#
# HIPAA Compliance Notes:
# - All data at rest is encrypted (AES-256)
# - All data in transit uses TLS 1.2+
# - VPC flow logs are enabled
# - CloudTrail is enabled for all API calls
# - All PHI-containing resources are tagged for compliance audits
#
# Cost Optimization Notes (reviewed quarterly):
# - RDS: Consider Aurora Serverless v2 for dev/staging (saves ~40%)
# - ECS: Right-size task definitions based on CloudWatch metrics
# - NAT Gateway: Consolidate to fewer AZs in non-prod (currently $150/mo each)
# - S3: Review lifecycle policies - some buckets have 7-year retention
#   that could be 3-year per our data retention policy update
# - ElastiCache: Drop to r6g.large in staging (currently r6g.xlarge)
#
# Last cost review: 2026-01-15 (monthly AWS bill: ~$47,000)

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.30"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "meridian-health"
      Environment = var.environment
      ManagedBy   = "terraform"
      CostCenter  = "engineering"
      Compliance  = "hipaa"
    }
  }
}

# Secondary region provider for DR
provider "aws" {
  alias  = "dr"
  region = var.dr_region

  default_tags {
    tags = {
      Project     = "meridian-health"
      Environment = var.environment
      ManagedBy   = "terraform"
      CostCenter  = "engineering"
      Compliance  = "hipaa"
      Purpose     = "disaster-recovery"
    }
  }
}

# =============================================================================
# VPC Configuration
# =============================================================================

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "meridian-${var.environment}-vpc"
  }
}

# Public subnets (load balancers, NAT gateways)
resource "aws_subnet" "public" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone = var.availability_zones[count.index]

  map_public_ip_on_launch = true

  tags = {
    Name = "meridian-${var.environment}-public-${var.availability_zones[count.index]}"
    Tier = "public"
  }
}

# Private subnets (application services)
resource "aws_subnet" "private" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + length(var.availability_zones))
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name = "meridian-${var.environment}-private-${var.availability_zones[count.index]}"
    Tier = "private"
  }
}

# Data subnets (databases, caches - no internet access)
resource "aws_subnet" "data" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 2 * length(var.availability_zones))
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name      = "meridian-${var.environment}-data-${var.availability_zones[count.index]}"
    Tier      = "data"
    ContainsPHI = "true"
  }
}

# Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "meridian-${var.environment}-igw"
  }
}

# NAT Gateways (one per AZ for HA)
# TODO: In non-prod environments, we could save money by using a single NAT
# gateway. Current cost: ~$450/month for 3 NAT gateways in prod.
resource "aws_eip" "nat" {
  count  = length(var.availability_zones)
  domain = "vpc"

  tags = {
    Name = "meridian-${var.environment}-nat-eip-${count.index}"
  }
}

resource "aws_nat_gateway" "main" {
  count = length(var.availability_zones)

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = {
    Name = "meridian-${var.environment}-nat-${count.index}"
  }

  depends_on = [aws_internet_gateway.main]
}

# Route tables
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "meridian-${var.environment}-public-rt"
  }
}

resource "aws_route_table" "private" {
  count  = length(var.availability_zones)
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = {
    Name = "meridian-${var.environment}-private-rt-${count.index}"
  }
}

resource "aws_route_table_association" "public" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "private" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# =============================================================================
# Security Groups
# =============================================================================

resource "aws_security_group" "alb" {
  name_prefix = "meridian-${var.environment}-alb-"
  vpc_id      = aws_vpc.main.id
  description = "Security group for Application Load Balancer"

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Redirect HTTP to HTTPS
  ingress {
    description = "HTTP redirect"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "meridian-${var.environment}-alb-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "app" {
  name_prefix = "meridian-${var.environment}-app-"
  vpc_id      = aws_vpc.main.id
  description = "Security group for application containers"

  ingress {
    description     = "Traffic from ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Service-to-service communication
  ingress {
    description = "Internal service mesh"
    from_port   = 3000
    to_port     = 3099
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "meridian-${var.environment}-app-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "database" {
  name_prefix = "meridian-${var.environment}-db-"
  vpc_id      = aws_vpc.main.id
  description = "Security group for databases - restricted to app tier only"

  ingress {
    description     = "PostgreSQL from app tier"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  # No internet egress for database tier
  egress {
    description     = "Response to app tier only"
    from_port       = 0
    to_port         = 0
    protocol        = "-1"
    security_groups = [aws_security_group.app.id]
  }

  tags = {
    Name        = "meridian-${var.environment}-db-sg"
    ContainsPHI = "true"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group" "cache" {
  name_prefix = "meridian-${var.environment}-cache-"
  vpc_id      = aws_vpc.main.id
  description = "Security group for ElastiCache Redis"

  ingress {
    description     = "Redis from app tier"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "meridian-${var.environment}-cache-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# =============================================================================
# VPC Flow Logs (HIPAA requirement)
# =============================================================================

resource "aws_flow_log" "main" {
  iam_role_arn    = aws_iam_role.flow_log.arn
  log_destination = aws_cloudwatch_log_group.flow_log.arn
  traffic_type    = "ALL"
  vpc_id          = aws_vpc.main.id

  tags = {
    Name = "meridian-${var.environment}-vpc-flow-log"
  }
}

resource "aws_cloudwatch_log_group" "flow_log" {
  name              = "/meridian/${var.environment}/vpc-flow-logs"
  retention_in_days = 365 # HIPAA requires minimum 6 years, but flow logs are not PHI
  # We keep 1 year here and archive older logs to S3 via a separate process

  tags = {
    Name = "meridian-${var.environment}-vpc-flow-logs"
  }
}

resource "aws_iam_role" "flow_log" {
  name = "meridian-${var.environment}-flow-log-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "vpc-flow-logs.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "flow_log" {
  name = "meridian-${var.environment}-flow-log-policy"
  role = aws_iam_role.flow_log.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams"
        ]
        Effect   = "Allow"
        Resource = "*"
      }
    ]
  })
}

# =============================================================================
# CloudTrail (HIPAA requirement)
# =============================================================================

resource "aws_cloudtrail" "main" {
  name                       = "meridian-${var.environment}-trail"
  s3_bucket_name             = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail      = true
  enable_log_file_validation = true

  event_selector {
    read_write_type           = "All"
    include_management_events = true
  }

  tags = {
    Name       = "meridian-${var.environment}-cloudtrail"
    Compliance = "hipaa"
  }
}

resource "aws_s3_bucket" "cloudtrail" {
  bucket = "meridian-${var.environment}-cloudtrail-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name       = "meridian-${var.environment}-cloudtrail"
    Compliance = "hipaa"
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AWSCloudTrailAclCheck"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action   = "s3:GetBucketAcl"
        Resource = aws_s3_bucket.cloudtrail.arn
      },
      {
        Sid    = "AWSCloudTrailWrite"
        Effect = "Allow"
        Principal = {
          Service = "cloudtrail.amazonaws.com"
        }
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"
        Condition = {
          StringEquals = {
            "s3:x-amz-acl" = "bucket-owner-full-control"
          }
        }
      }
    ]
  })
}

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}
