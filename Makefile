# =============================================================================
# Meridian Health Platform - Makefile
# =============================================================================
#
# Common development and deployment tasks.
# Run `make help` to see available targets.
#
# NOTE: Some of these targets are legacy from before we moved to npm scripts.
#       We should probably consolidate, but both work for now. -- @david.chen
# TODO: Add `make doctor` target that checks all prerequisites (PLAT-2560)
# =============================================================================

.PHONY: help install build test lint format clean dev \
        db-migrate db-seed db-reset \
        docker-up docker-down docker-build docker-clean \
        deploy-staging deploy-prod \
        tf-plan tf-apply \
        codegen proto

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Colors for output
BLUE := \033[0;34m
GREEN := \033[0;32m
YELLOW := \033[0;33m
RED := \033[0;31m
NC := \033[0m # No Color

# Variables
NODE_ENV ?= development
DOCKER_COMPOSE := docker compose
# DOCKER_COMPOSE := docker-compose  # uncomment if you're still on v1 (please upgrade)
AWS_REGION ?= us-east-1
AWS_ACCOUNT_ID ?= 123456789012
ECR_REGISTRY := $(AWS_ACCOUNT_ID).dkr.ecr.$(AWS_REGION).amazonaws.com
SERVICES := auth claims-engine ehr-gateway scheduling analytics-api doc-service notifications
TIMESTAMP := $(shell date +%Y%m%d%H%M%S)
GIT_SHA := $(shell git rev-parse --short HEAD)
VERSION := $(shell node -p "require('./package.json').version")

# ---- Help ----

help: ## Show this help message
	@echo ""
	@echo "  $(BLUE)Meridian Health Platform$(NC) - Development Tasks"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  $(GREEN)%-25s$(NC) %s\n", $$1, $$2}'
	@echo ""

# ---- Development ----

install: ## Install all dependencies
	npm install
	@echo "$(GREEN)Dependencies installed.$(NC)"
	@echo "$(YELLOW)Don't forget to copy .env.example to .env$(NC)"

build: ## Build all packages
	npm run build:libs
	npm run build
	@echo "$(GREEN)Build complete.$(NC)"

dev: docker-up ## Start all services in development mode
	@echo "$(BLUE)Waiting for infrastructure to be ready...$(NC)"
	@sleep 5
	npm run dev

dev-service: ## Start a specific service (usage: make dev-service SERVICE=auth)
ifndef SERVICE
	$(error SERVICE is required. Usage: make dev-service SERVICE=auth)
endif
	npm run dev -w services/$(SERVICE)

# ---- Testing ----

test: ## Run all tests
	npm test

test-unit: ## Run unit tests only
	npm run test:unit

test-integration: docker-up ## Run integration tests (starts Docker services)
	@echo "$(BLUE)Waiting for services...$(NC)"
	@sleep 3
	npm run test:integration

test-e2e: ## Run end-to-end tests
	npm run test:e2e

test-coverage: ## Run tests with coverage report
	npm run test:coverage

# FIXME: This target was added by @marcus.w but the script doesn't exist yet
# test-hipaa: ## Run HIPAA compliance test suite
# 	node scripts/test/hipaa-compliance-check.js

# ---- Linting & Formatting ----

lint: ## Run ESLint
	npm run lint

lint-fix: ## Run ESLint with auto-fix
	npm run lint:fix

format: ## Format code with Prettier
	npm run format

format-check: ## Check code formatting
	npm run format:check

typecheck: ## Run TypeScript type checking
	npm run typecheck

# Runs all checks (useful before pushing)
check: lint typecheck test-unit ## Run lint, typecheck, and unit tests
	@echo "$(GREEN)All checks passed!$(NC)"

# ---- Database ----

db-migrate: ## Run database migrations for all services
	@echo "$(BLUE)Running migrations...$(NC)"
	@for service in $(SERVICES); do \
		echo "  Migrating $$service..."; \
		DATABASE_URL=$$(grep "$${service^^}_DATABASE_URL" .env 2>/dev/null | cut -d= -f2-) \
		npm run db:migrate -- --service=$$service || exit 1; \
	done
	@echo "$(GREEN)All migrations complete.$(NC)"

db-migrate-service: ## Run migrations for a specific service (usage: make db-migrate-service SERVICE=auth)
ifndef SERVICE
	$(error SERVICE is required. Usage: make db-migrate-service SERVICE=auth)
endif
	npm run db:migrate -- --service=$(SERVICE)

db-migrate-create: ## Create a new migration (usage: make db-migrate-create SERVICE=auth NAME=add-users-table)
ifndef SERVICE
	$(error SERVICE is required)
endif
ifndef NAME
	$(error NAME is required)
endif
	npm run db:migrate:create -- --service=$(SERVICE) --name=$(NAME)

db-seed: ## Seed development data
	@echo "$(YELLOW)WARNING: This will overwrite existing dev data$(NC)"
	npm run db:seed

db-reset: ## Reset all databases and re-run migrations
	@echo "$(RED)WARNING: This will destroy all local data!$(NC)"
	@read -p "Are you sure? [y/N] " confirm && [[ $$confirm == [yY] ]] || exit 1
	npm run db:reset
	$(MAKE) db-migrate
	$(MAKE) db-seed
	@echo "$(GREEN)Database reset complete.$(NC)"

# ---- Docker ----

docker-up: ## Start Docker infrastructure services
	$(DOCKER_COMPOSE) up -d postgres redis rabbitmq minio elasticsearch
	@echo "$(GREEN)Infrastructure services started.$(NC)"
	@echo "  PostgreSQL:    localhost:5432"
	@echo "  Redis:         localhost:6379"
	@echo "  RabbitMQ:      localhost:5672 (mgmt: localhost:15672)"
	@echo "  MinIO:         localhost:9000 (console: localhost:9001)"
	@echo "  Elasticsearch: localhost:9200"

docker-up-all: ## Start ALL Docker services including application services
	$(DOCKER_COMPOSE) up -d
	@echo "$(GREEN)All services started.$(NC)"

docker-down: ## Stop all Docker services
	$(DOCKER_COMPOSE) down

docker-down-clean: ## Stop all Docker services and remove volumes
	@echo "$(RED)WARNING: This will destroy all Docker volumes (databases, etc)!$(NC)"
	@read -p "Are you sure? [y/N] " confirm && [[ $$confirm == [yY] ]] || exit 1
	$(DOCKER_COMPOSE) down -v

docker-build: ## Build all Docker images
	$(DOCKER_COMPOSE) build

docker-build-service: ## Build a specific service Docker image (usage: make docker-build-service SERVICE=auth)
ifndef SERVICE
	$(error SERVICE is required)
endif
	$(DOCKER_COMPOSE) build $(SERVICE)

docker-logs: ## Follow Docker logs (usage: make docker-logs or make docker-logs SERVICE=auth)
ifdef SERVICE
	$(DOCKER_COMPOSE) logs -f $(SERVICE)
else
	$(DOCKER_COMPOSE) logs -f
endif

docker-clean: ## Remove all Meridian Docker resources
	$(DOCKER_COMPOSE) down -v --rmi local
	docker network rm meridian-net 2>/dev/null || true
	@echo "$(GREEN)Docker resources cleaned.$(NC)"

# ---- Deployment ----

deploy-staging: ## Deploy to staging environment
	@echo "$(BLUE)Deploying to staging...$(NC)"
	@echo "$(YELLOW)NOTE: Prefer using the GitHub Actions workflow for staging deploys.$(NC)"
	@echo "$(YELLOW)This target is kept for emergency deployments.$(NC)"
	./scripts/deploy/deploy-staging.sh $(GIT_SHA)

deploy-prod: ## Deploy to production (requires approval)
	@echo "$(RED)PRODUCTION DEPLOYMENT$(NC)"
	@echo "Version: $(VERSION)"
	@echo "Git SHA: $(GIT_SHA)"
	@read -p "Have you completed the deployment checklist? [y/N] " confirm && [[ $$confirm == [yY] ]] || exit 1
	@read -p "Has this been approved by a team lead? [y/N] " confirm && [[ $$confirm == [yY] ]] || exit 1
	./scripts/deploy/deploy-prod.sh $(VERSION) $(GIT_SHA)

# TODO: This doesn't work anymore since we moved to EKS -- PLAT-3100
# deploy-ecs:
# 	aws ecs update-service --cluster meridian-prod --service $(SERVICE) --force-new-deployment

ecr-login: ## Login to AWS ECR
	aws ecr get-login-password --region $(AWS_REGION) | \
		docker login --username AWS --password-stdin $(ECR_REGISTRY)

ecr-push: docker-build ecr-login ## Build and push images to ECR
	@for service in $(SERVICES); do \
		echo "Pushing $$service..."; \
		docker tag meridian/$$service:latest $(ECR_REGISTRY)/meridian/$$service:$(GIT_SHA); \
		docker push $(ECR_REGISTRY)/meridian/$$service:$(GIT_SHA); \
	done

# ---- Infrastructure (Terraform) ----

tf-init: ## Initialize Terraform
	cd infra/terraform && terraform init

tf-plan: ## Plan Terraform changes (usage: make tf-plan ENV=staging)
ifndef ENV
	$(error ENV is required. Usage: make tf-plan ENV=staging)
endif
	cd infra/terraform && terraform plan -var-file=envs/$(ENV).tfvars -out=plan.out

tf-apply: ## Apply Terraform changes (usage: make tf-apply ENV=staging)
ifndef ENV
	$(error ENV is required)
endif
	cd infra/terraform && terraform apply plan.out

# ---- Code Generation ----

codegen: codegen-fhir codegen-openapi ## Run all code generation

codegen-fhir: ## Generate FHIR R4 TypeScript types
	npm run codegen:fhir

codegen-openapi: ## Generate API client from OpenAPI specs
	npm run codegen:openapi

# Deprecated: We used to generate protobuf types for inter-service communication
# but moved to REST+JSON. Keeping in case we ever go back to gRPC.
# proto:
# 	protoc --ts_out=libs/proto/src proto/**/*.proto

# ---- Utilities ----

clean: ## Clean build artifacts
	npm run clean
	rm -rf coverage/
	rm -rf dist/
	rm -rf .turbo/
	@echo "$(GREEN)Cleaned.$(NC)"

nuke: clean docker-down-clean ## Nuclear option: clean everything
	rm -rf node_modules/
	@echo "$(RED)Everything nuked. Run 'make install' to start fresh.$(NC)"

# Quick sanity check that everything is working
smoke-test: ## Run a quick smoke test against local services
	@echo "$(BLUE)Running smoke tests...$(NC)"
	@curl -sf http://localhost:3001/health > /dev/null && echo "  $(GREEN)auth: OK$(NC)" || echo "  $(RED)auth: FAIL$(NC)"
	@curl -sf http://localhost:3002/health > /dev/null && echo "  $(GREEN)claims-engine: OK$(NC)" || echo "  $(RED)claims-engine: FAIL$(NC)"
	@curl -sf http://localhost:3003/health > /dev/null && echo "  $(GREEN)ehr-gateway: OK$(NC)" || echo "  $(RED)ehr-gateway: FAIL$(NC)"
	@curl -sf http://localhost:3004/health > /dev/null && echo "  $(GREEN)scheduling: OK$(NC)" || echo "  $(RED)scheduling: FAIL$(NC)"
	@curl -sf http://localhost:3005/health > /dev/null && echo "  $(GREEN)analytics-api: OK$(NC)" || echo "  $(RED)analytics-api: FAIL$(NC)"
	@curl -sf http://localhost:3006/health > /dev/null && echo "  $(GREEN)doc-service: OK$(NC)" || echo "  $(RED)doc-service: FAIL$(NC)"
	@curl -sf http://localhost:3007/health > /dev/null && echo "  $(GREEN)notifications: OK$(NC)" || echo "  $(RED)notifications: FAIL$(NC)"

# Dump DB schema for documentation purposes
# TODO: This hasn't been updated for the multi-service DB split (PLAT-2780)
dump-schema:
	pg_dump -s -h localhost -U meridian meridian_auth > docs/schema/auth-schema.sql
	pg_dump -s -h localhost -U meridian meridian_claims > docs/schema/claims-schema.sql
