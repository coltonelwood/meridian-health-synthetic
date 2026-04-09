# =============================================================================
# ECS Fargate Service Definitions
# =============================================================================
#
# Application services running on ECS Fargate. We migrated from EC2 launch
# type in Q3 2025 but some services are still on EC2 (see TODO notes).
#
# TODO: Migrate claims-engine to Fargate. It's still on EC2 launch type
# because it needs more than 4 vCPU (current Fargate limit for our account).
# We requested a limit increase in December 2025, still waiting on AWS.
# Ticket: MH-3456
#
# TODO: The workflow-engine service still runs on EC2 because it uses
# local disk for workflow checkpoints. Need to migrate checkpoints to
# S3 or DynamoDB first. Ticket: MH-3789

resource "aws_ecs_cluster" "main" {
  name = "meridian-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  configuration {
    execute_command_configuration {
      # Enable ECS Exec for debugging (be careful with PHI!)
      logging = "OVERRIDE"

      log_configuration {
        cloud_watch_log_group_name = "/meridian/${var.environment}/ecs-exec"
      }
    }
  }

  tags = {
    Name = "meridian-${var.environment}-cluster"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 1
  }
}

# =============================================================================
# Service: patient-api
# =============================================================================

resource "aws_ecs_task_definition" "patient_api" {
  family                   = "meridian-${var.environment}-patient-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.patient_api_task.arn

  container_definitions = jsonencode([
    {
      name      = "patient-api"
      image     = "${var.ecr_registry}/patient-api:${var.patient_api_version}"
      essential = true

      portMappings = [
        {
          containerPort = 3000
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = var.environment },
        { name = "PORT", value = "3000" },
        { name = "SERVICE_NAME", value = "patient-api" },
        { name = "LOG_LEVEL", value = var.environment == "production" ? "info" : "debug" },
        { name = "DB_HOST", value = aws_db_instance.primary.endpoint },
        { name = "DB_PORT", value = "5432" },
        { name = "DB_NAME", value = "meridian" },
        { name = "REDIS_HOST", value = aws_elasticache_replication_group.main.primary_endpoint_address },
        { name = "REDIS_PORT", value = "6379" },
        { name = "EVENT_BUS_URL", value = "amqps://${var.rabbitmq_host}:5671" },
      ]

      secrets = [
        {
          name      = "DB_PASSWORD"
          valueFrom = "${aws_secretsmanager_secret.db_password.arn}:password::"
        },
        {
          name      = "JWT_SECRET"
          valueFrom = aws_secretsmanager_secret.jwt_secret.arn
        },
        {
          name      = "RABBITMQ_PASSWORD"
          valueFrom = "${aws_secretsmanager_secret.rabbitmq_credentials.arn}:password::"
        }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/meridian/${var.environment}/patient-api"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Service     = "patient-api"
    ContainsPHI = "true"
  }
}

resource "aws_ecs_service" "patient_api" {
  name            = "patient-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.patient_api.arn
  desired_count   = var.environment == "production" ? 3 : 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.patient_api.arn
    container_name   = "patient-api"
    container_port   = 3000
  }

  deployment_configuration {
    maximum_percent         = 200
    minimum_healthy_percent = 100

    deployment_circuit_breaker {
      enable   = true
      rollback = true
    }
  }

  # Enable service discovery
  service_registries {
    registry_arn = aws_service_discovery_service.patient_api.arn
  }

  tags = {
    Service = "patient-api"
  }

  lifecycle {
    ignore_changes = [desired_count] # Managed by autoscaling
  }
}

# Auto-scaling for patient-api
resource "aws_appautoscaling_target" "patient_api" {
  max_capacity       = var.environment == "production" ? 10 : 3
  min_capacity       = var.environment == "production" ? 3 : 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.patient_api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "patient_api_cpu" {
  name               = "patient-api-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.patient_api.resource_id
  scalable_dimension = aws_appautoscaling_target.patient_api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.patient_api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 65.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# =============================================================================
# Service: claims-engine (STILL ON EC2 - see TODO above)
# =============================================================================

resource "aws_ecs_task_definition" "claims_engine" {
  family                   = "meridian-${var.environment}-claims-engine"
  # TODO: Change to FARGATE once limit increase is approved
  requires_compatibilities = ["EC2"]
  network_mode             = "awsvpc"
  cpu                      = 4096 # 4 vCPU - needs more for parallel claim processing
  memory                   = 8192 # 8 GB
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.claims_engine_task.arn

  container_definitions = jsonencode([
    {
      name      = "claims-engine"
      image     = "${var.ecr_registry}/claims-engine:${var.claims_engine_version}"
      essential = true

      portMappings = [
        {
          containerPort = 3001
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = var.environment },
        { name = "PORT", value = "3001" },
        { name = "SERVICE_NAME", value = "claims-engine" },
        { name = "DB_HOST", value = aws_db_instance.primary.endpoint },
        { name = "DB_PORT", value = "5432" },
        { name = "DB_NAME", value = "meridian" },
        { name = "REDIS_HOST", value = aws_elasticache_replication_group.main.primary_endpoint_address },
        { name = "EVENT_BUS_URL", value = "amqps://${var.rabbitmq_host}:5671" },
        { name = "CLEARINGHOUSE_API_URL", value = "https://api.changehealthcare.com/v1" },
        { name = "CLAIM_PROCESSING_CONCURRENCY", value = "10" },
      ]

      secrets = [
        {
          name      = "DB_PASSWORD"
          valueFrom = "${aws_secretsmanager_secret.db_password.arn}:password::"
        },
        {
          name      = "CHANGE_HEALTHCARE_API_KEY"
          valueFrom = aws_secretsmanager_secret.clearinghouse_key.arn
        },
        {
          name      = "AVAILITY_API_KEY"
          valueFrom = aws_secretsmanager_secret.availity_key.arn
        }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:3001/health || exit 1"]
        interval    = 30
        timeout     = 10
        retries     = 3
        startPeriod = 120 # Claims engine takes longer to start
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = "/meridian/${var.environment}/claims-engine"
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Service     = "claims-engine"
    ContainsPHI = "true"
  }
}

# =============================================================================
# Service Discovery (internal DNS)
# =============================================================================

resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "meridian.internal"
  vpc         = aws_vpc.main.id
  description = "Service discovery for Meridian microservices"
}

resource "aws_service_discovery_service" "patient_api" {
  name = "patient-api"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

# =============================================================================
# IAM Roles
# =============================================================================

resource "aws_iam_role" "ecs_execution" {
  name = "meridian-${var.environment}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_secrets" {
  name = "secrets-access"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "secretsmanager:GetSecretValue"
        ]
        Effect   = "Allow"
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:meridian/${var.environment}/*"
      },
      {
        Action = [
          "kms:Decrypt"
        ]
        Effect   = "Allow"
        Resource = aws_kms_key.rds.arn
      }
    ]
  })
}

resource "aws_iam_role" "patient_api_task" {
  name = "meridian-${var.environment}-patient-api-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role" "claims_engine_task" {
  name = "meridian-${var.environment}-claims-engine-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })
}

# Claims engine needs S3 access for 835 file processing
resource "aws_iam_role_policy" "claims_engine_s3" {
  name = "s3-access"
  role = aws_iam_role.claims_engine_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:ListBucket"
        ]
        Effect = "Allow"
        Resource = [
          aws_s3_bucket.documents.arn,
          "${aws_s3_bucket.documents.arn}/*",
          aws_s3_bucket.exports.arn,
          "${aws_s3_bucket.exports.arn}/*"
        ]
      }
    ]
  })
}

# =============================================================================
# ALB and Target Groups
# =============================================================================

resource "aws_lb" "main" {
  name               = "meridian-${var.environment}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = var.environment == "production"

  access_logs {
    bucket  = aws_s3_bucket.alb_logs.id
    prefix  = "alb"
    enabled = true
  }

  tags = {
    Name = "meridian-${var.environment}-alb"
  }
}

resource "aws_lb_target_group" "patient_api" {
  name        = "meridian-${var.environment}-patient-api"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 3
    interval            = 30
    matcher             = "200"
    path                = "/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    timeout             = 5
    unhealthy_threshold = 3
  }

  tags = {
    Service = "patient-api"
  }
}

resource "aws_s3_bucket" "alb_logs" {
  bucket = "meridian-${var.environment}-alb-logs-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name = "meridian-${var.environment}-alb-logs"
  }
}
