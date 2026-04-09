# Local Development Setup

> **Last updated:** 2025-03
> **Owner:** Platform Team

## Prerequisites

- macOS 13+ or Ubuntu 22.04+
- Docker Desktop 4.x (make sure to allocate at least 8GB RAM in settings)
- Node.js 20 LTS (recommend using `nvm`)
- Python 3.11+ (recommend using `pyenv`)
- Go 1.21+
- Java 17 (Corretto, for fhir-facade only)
- Git
- AWS CLI v2

## Step 1: Clone the Repositories

```bash
# Create workspace directory
mkdir -p ~/meridian && cd ~/meridian

# Clone main application repo
git clone git@github.com:meridian-health/meridian-platform.git

# Clone infrastructure repo (optional, for DevOps work)
git clone git@github.com:meridian-health/meridian-infra.git
```

## Step 2: Install Dependencies

```bash
cd ~/meridian/meridian-platform

# Install Node.js dependencies (uses npm workspaces)
npm install

# Install Python dependencies
cd services/billing-service && pip install -r requirements.txt && cd ../..
cd services/claims-service && pip install -r requirements.txt && cd ../..

# Install Go dependencies
cd services/scheduling-service && go mod download && cd ../..
cd services/audit-service && go mod download && cd ../..
```

## Step 3: Start Infrastructure Services

We use Docker Compose for local infrastructure (databases, message queue, etc.):

```bash
# Start all infrastructure services
docker compose -f docker-compose.infra.yml up -d

# This starts:
# - PostgreSQL (port 5432)
# - MongoDB (port 27017)
# - Redis (port 6379)
# - RabbitMQ (port 5672, management UI on 15672)
# - LocalStack (for S3, KMS emulation)
```

Verify everything is running:
```bash
docker compose -f docker-compose.infra.yml ps
```

## Step 4: Database Setup

```bash
# Run migrations for each service
npm run db:migrate --workspace=services/auth-service
npm run db:migrate --workspace=services/patient-service

# For Python services
cd services/billing-service && alembic upgrade head && cd ../..
cd services/claims-service && alembic upgrade head && cd ../..

# For Go services
cd services/scheduling-service && go run cmd/migrate/main.go up && cd ../..

# Seed development data
npm run db:seed
# This loads data from data/seeds/ into the local databases
```

## Step 5: Environment Configuration

```bash
# Copy the example env file
cp .env.example .env.local

# Edit .env.local with your settings
# Most defaults should work for local development
# Key values to check:
#   DATABASE_URL=postgresql://meridian:meridian@localhost:5432/meridian_dev
#   REDIS_URL=redis://localhost:6379
#   RABBITMQ_URL=amqp://guest:guest@localhost:5672
#   AWS_ENDPOINT=http://localhost:4566 (LocalStack)
```

## Step 6: Start Services

### Option A: Start everything (recommended for first setup)

```bash
# Start all services in development mode
npm run dev

# This starts all services with hot-reloading
# API Gateway (Kong) runs on port 8000
# Patient Portal runs on port 3000
# Provider App runs on port 3001
```

### Option B: Start individual services

```bash
# If you only need specific services
npm run dev --workspace=services/patient-service    # port 3010
npm run dev --workspace=services/auth-service        # port 3011
npm run dev --workspace=services/billing-service     # port 3012

# Go services
cd services/scheduling-service && go run cmd/server/main.go  # port 3013
```

## Step 7: Verify Setup

```bash
# Check health endpoints
curl http://localhost:8000/health            # API Gateway
curl http://localhost:3010/health            # Patient service
curl http://localhost:3011/health            # Auth service

# Get a test JWT token
curl -X POST http://localhost:3011/v2/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@meridianhealth.io","password":"dev-password-123"}'

# Use the token to fetch patients
curl http://localhost:8000/v2/patients \
  -H "Authorization: Bearer <token-from-above>"
```

## Troubleshooting

### Docker: "Cannot connect to the Docker daemon"

Make sure Docker Desktop is running. On macOS, check the whale icon in the menu bar.

### PostgreSQL: "connection refused"

```bash
# Check if PostgreSQL container is running
docker compose -f docker-compose.infra.yml ps postgres

# If not, check logs
docker compose -f docker-compose.infra.yml logs postgres

# Common fix: port 5432 already in use by local PostgreSQL
# Either stop local PostgreSQL or change the port in docker-compose.infra.yml
```

### Node.js: "Module not found" errors

```bash
# Clean install
rm -rf node_modules
npm install

# If using nvm, make sure you're on the right version
nvm use 20
```

### RabbitMQ: "Connection refused"

```bash
# RabbitMQ takes 10-15 seconds to start
docker compose -f docker-compose.infra.yml logs rabbitmq

# Management UI: http://localhost:15672 (guest/guest)
```

### Migrations fail with "relation already exists"

```bash
# Reset the database and re-run migrations
docker compose -f docker-compose.infra.yml down -v
docker compose -f docker-compose.infra.yml up -d
# Wait for PostgreSQL to be ready...
sleep 5
npm run db:migrate
npm run db:seed
```

### Python: "No module named 'xyz'"

```bash
# Make sure you're in a virtual environment
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### "ENOSPC: System limit for number of file watchers reached"

```bash
# Linux only - increase inotify watchers
echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

### LocalStack S3: "The bucket does not exist"

```bash
# Create required S3 buckets in LocalStack
aws --endpoint-url=http://localhost:4566 s3 mb s3://meridian-documents-dev
aws --endpoint-url=http://localhost:4566 s3 mb s3://meridian-statements-dev
```

## Running Tests

```bash
# Run all tests
npm test

# Run tests for a specific service
npm test --workspace=services/patient-service

# Run with coverage
npm run test:coverage --workspace=services/patient-service

# Python tests
cd services/billing-service && pytest
cd services/claims-service && pytest

# Go tests
cd services/scheduling-service && go test ./...

# E2E tests (requires all services running)
npm run test:e2e
```

## Useful Development URLs

| Service | URL |
|---------|-----|
| API Gateway | http://localhost:8000 |
| Patient Portal (dev) | http://localhost:3000 |
| Provider App (dev) | http://localhost:3001 |
| Admin Portal (dev) | http://localhost:3002 |
| RabbitMQ Management | http://localhost:15672 |
| LocalStack | http://localhost:4566 |
| Swagger UI | http://localhost:8000/docs |

## Tips

- Use `docker compose -f docker-compose.infra.yml logs -f <service>` to tail logs
- RabbitMQ management UI is great for debugging event flow
- Use `pgAdmin` or `DBeaver` for database exploration
- Set `LOG_LEVEL=debug` in `.env.local` for verbose logging
- The seed data creates an admin user: `admin@meridianhealth.io` / `dev-password-123`
