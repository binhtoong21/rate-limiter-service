# Rate Limiter with Quota Trading

A high-performance rate limiting service with dynamic quota management and cross-organization quota trading, built with Fastify, Redis, and PostgreSQL.

## Features

- Sliding Window + Token Bucket rate limiting algorithms
- Dynamic quota pools per organization
- Lease-based temporary quota claims
- Cross-org quota loans (trading)
- Automatic lease/loan expiry workers
- Reconciliation worker for Redis↔PostgreSQL consistency
- Prometheus metrics + Grafana dashboard
- Dual-write architecture (PostgreSQL ground truth, Redis materialized view)

## Architecture

This project features a scalable backend with a Fastify API layer routing rate-limiting checks to Redis using Lua scripts for atomicity. PostgreSQL serves as the persistent ground truth (managed via Drizzle ORM) for organizations, quotas, leases, and loans, while Redis acts as a high-performance materialized view. BullMQ handles asynchronous background jobs like lease expiry, loan repayment, and data reconciliation between Redis and PostgreSQL.

## Quick Start

```bash
# Start infrastructure
docker compose up -d

# Install dependencies
npm install

# Push database schema
npm run db:push

# Start development server
npm run dev

# Bootstrap test org (dev only)
curl -X POST http://localhost:3000/dev/bootstrap \
  -H 'Content-Type: application/json' \
  -d '{"orgSlug": "acme", "orgName": "Acme Corp", "serviceName": "api-gateway", "quotaAllocated": 10000}'
```

## API Endpoints

| Method | Path                    | Auth       | Description                  |
| ------ | ----------------------- | ---------- | ---------------------------- |
| GET    | /health                 | None       | Liveness check               |
| GET    | /metrics                | None       | Prometheus metrics           |
| POST   | /api/ping               | API Key    | Rate-limited demo endpoint   |
| POST   | /dev/bootstrap          | None (dev) | Create org, service, API key |
| PATCH  | /orgs/:slug/quota       | Admin      | Set org quota allocation     |
| GET    | /orgs/:slug/quota/pool  | Admin      | Query org's pool breakdown   |
| GET    | /quota/pool             | API Key    | Query caller's org pool      |
| POST   | /quota/leases           | API Key    | Claim lease (idempotent)     |
| GET    | /quota/leases           | API Key    | List service's leases        |
| GET    | /quota/leases/:id       | API Key    | Lease detail                 |
| DELETE | /quota/leases/:id       | API Key    | Release lease                |
| POST   | /quota/loans            | Admin      | Create cross-org loan        |
| GET    | /quota/loans            | API Key    | List org's loans             |
| GET    | /quota/loans/:id        | API Key    | Loan detail                  |
| POST   | /quota/loans/:id/repay  | Admin      | Repay loan early             |
| POST   | /quota/loans/:id/cancel | Admin      | Cancel/recall loan           |
| GET    | /quota/events           | Admin      | Audit log with filters       |
| GET    | /quota/events/:id       | Admin      | Event detail                 |

## Environment Variables

| Variable             | Default                | Description                               |
| -------------------- | ---------------------- | ----------------------------------------- |
| NODE_ENV             | development            | Environment mode                          |
| PORT                 | 3000                   | Server port                               |
| LOG_LEVEL            | info                   | Pino log level                            |
| DATABASE_URL         | -                      | PostgreSQL connection string              |
| REDIS_URL            | redis://localhost:6379 | Redis connection string                   |
| RATE_LIMIT_ALGORITHM | sliding_window         | Algorithm: sliding_window or token_bucket |

## Observability

### Prometheus Metrics

Exposed at `GET /metrics`. Key metrics:

- `rate_limit_requests_total{org_id, result}` - request counts
- `rate_limit_check_duration_ms{algorithm}` - check latency
- `quota_pool_available{org_id}` - available quota
- `quota_operation_total{type, status}` - operation counts
- `reconciliation_divergence_detected_total` - divergences

### Grafana Dashboard

Pre-provisioned dashboard available at `http://localhost:3001` when running with Docker Compose.

## Benchmarks

Run with [k6](https://k6.io/):

```bash
# Baseline latency test
k6 run benchmarks/rate-limit-baseline.js

# Spike test
k6 run benchmarks/rate-limit-spike.js

# Quota trading under load
k6 run benchmarks/quota-trading-load.js

# Algorithm comparison
RATE_LIMIT_ALGORITHM=sliding_window k6 run benchmarks/algorithm-comparison.js
RATE_LIMIT_ALGORITHM=token_bucket k6 run benchmarks/algorithm-comparison.js
```

### Benchmark Results

| Benchmark                 | Date     | p50     | p95     | p99     | Throughput | Notes |
| ------------------------- | -------- | ------- | ------- | ------- | ---------- | ----- |
| rate-limit-baseline       | Aug 2026 | 18.2ms  | 36.7ms  | 43.5ms  | ~2700 req/s| Sau tối ưu L1 Cache & Lua (Windows Docker) |
| rate-limit-baseline (WSL) | Aug 2026 | 14.4ms  | 31.0ms  | ~40.0ms | ~3225 req/s| Môi trường WSL2 Linux Native (Max CPU) |
| algorithm-comparison (SW) | Aug 2026 | 21.2ms  | 31.4ms  | 39.0ms  | 2222 req/s | Fast sliding window logic |
| algorithm-comparison (TB) | Aug 2026 | 24.5ms  | 45.8ms  | 56.9ms  | 1848 req/s | Lua time math overhead |
| quota-trading-load        | Aug 2026 | 28.1ms  | 40.5ms  | 45.2ms  | ~1500 req/s| Concurrent lease churning |

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Fastify
- **Database:** PostgreSQL (Drizzle ORM)
- **Cache/State:** Redis (ioredis + Lua scripts)
- **Workers:** BullMQ
- **Metrics:** Prometheus (prom-client)
- **Dashboard:** Grafana
- **Benchmarks:** k6
