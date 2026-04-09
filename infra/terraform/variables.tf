variable "environment" {
  description = "Deployment environment (development, staging, production)"
  type        = string
  validation {
    condition     = contains(["development", "staging", "production"], var.environment)
    error_message = "Environment must be development, staging, or production."
  }
}

variable "aws_region" {
  description = "Primary AWS region"
  type        = string
  default     = "us-east-1"
}

variable "dr_region" {
  description = "Disaster recovery AWS region"
  type        = string
  default     = "us-west-2"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

# --- RDS Variables ---

variable "rds_instance_class" {
  description = "RDS instance type for the primary database"
  type        = string
  default     = "db.r6g.xlarge"
}

variable "rds_replica_instance_class" {
  description = "RDS instance type for read replicas"
  type        = string
  default     = "db.r6g.large"
}

variable "rds_storage_gb" {
  description = "Initial allocated storage in GB"
  type        = number
  default     = 100
}

variable "rds_max_storage_gb" {
  description = "Maximum storage for autoscaling in GB"
  type        = number
  default     = 500
}

# --- ElastiCache Variables ---

variable "redis_node_type" {
  description = "ElastiCache Redis node type"
  type        = string
  default     = "cache.r6g.large"
}

variable "redis_auth_token" {
  description = "Redis AUTH token (password)"
  type        = string
  sensitive   = true
}

# --- ECS Variables ---

variable "ecr_registry" {
  description = "ECR registry URL"
  type        = string
}

variable "patient_api_version" {
  description = "Docker image tag for patient-api"
  type        = string
  default     = "latest"
}

variable "claims_engine_version" {
  description = "Docker image tag for claims-engine"
  type        = string
  default     = "latest"
}

variable "rabbitmq_host" {
  description = "RabbitMQ host (Amazon MQ)"
  type        = string
}

# --- Feature Flags ---

variable "enable_fhir_r4_api" {
  description = "Enable the FHIR R4 API endpoint"
  type        = bool
  default     = false
}

variable "enable_patient_portal_v2" {
  description = "Enable the new patient portal (v2)"
  type        = bool
  default     = false
}
