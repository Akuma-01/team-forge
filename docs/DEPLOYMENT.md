# TeamForge — Production Deployment Guide (Render + Neon)

Authoritative guide for manual deployment of TeamForge to Render with a Neon PostgreSQL database.

## 1. Hosting Architecture Overview

```
                      +---------------------------------------+
                      |       Client Browser / User           |
                      +-------------------+-------------------+
                                          | HTTPS / WSS
                                          v
                      +---------------------------------------+
                      |      Render Web Service (Docker)      |
                      |   - Static SPA (Vite / React)         |
                      |   - API Server (Node 22 / Express)    |
                      |   - SSE Heartbeats & Real-time Stream |
                      +---------+-------------------+---------+
                                |                   |
             Transaction Pooler | (Port 5432)       | Direct Connection
           (DATABASE_URL)       v                   v (DATABASE_URL_DIRECT)
                      +-------------------+   +--------------------+
                      | Neon PgBouncer    |   | Neon Compute Node  |
                      | Connection Pooler |   | (Direct Endpoint)  |
                      +---------+---------+   +---------+----------+
                                \                  /
                                 \                /
                                  v              v
                              +--------------------+
                              |  Neon PostgreSQL   |
                              |   16.x Database    |
                              +--------------------+
```

---

## 2. Required Environment Variables

Configure these environment variables in Render:

| Variable | Type | Example / Description | Required In |
|---|---|---|---|
| `NODE_ENV` | String | `production` | Production |
| `PORT` | Number | `8080` (injected automatically by Render) | Production |
| `HOST` | String | `0.0.0.0` (binds to all interfaces in container) | Production |
| `DATABASE_URL` | URL | `postgres://user:pass@ep-xyz-pooler.region.neon.tech/neondb?sslmode=require` | All |
| `DATABASE_URL_DIRECT` | URL | `postgres://user:pass@ep-xyz.region.neon.tech/neondb?sslmode=require` | Migrations / Seed |
| `APP_ORIGIN` | URL | `https://teamforge.onrender.com` (Must match exact public HTTPS origin) | Production |
| `JWT_SECRET` | String | Random string of at least 32 bytes (Render can auto-generate) | All |
| `PG_POOL_MAX` | Number | `20` (Connection pool limit per process) | Production |
| `INVITE_TTL_HOURS` | Number | `48` (Default invite code validity in hours) | Production |
| `BOARD_CACHE_TTL_MS` | Number | `1000` (In-memory discovery cache TTL in ms) | Optional |
| `TRUSTED_PROXY_CIDRS`| String | Comma-separated trusted ingress IPs/CIDRs (leave empty if behind Render proxy) | Optional |
| `SEED_PASSWORD` | String | Demo user password for seeded accounts (demo only) | Optional |

> [!IMPORTANT]
> `APP_ORIGIN` must begin with `https://` in production without trailing slashes. All mutating API endpoints strictly validate that `Origin` matches `APP_ORIGIN`.
> Session cookies automatically configure `HttpOnly`, `Secure`, `SameSite=Lax`, and `Path=/`.

---

## 3. Neon Setup Instructions

1. **Create Neon Project**:
   - Choose PostgreSQL 16.
   - Region: Select a region closest to your Render service (e.g., Singapore `ap-southeast-1` or Oregon `us-west-2`).
2. **Retrieve Connection Strings**:
   - **Pooled connection string** (Host contains `-pooler`):
     Use this for `DATABASE_URL`. It connects via Neon's connection pooler for routine web transactions.
   - **Direct connection string** (Host does NOT contain `-pooler`):
     Use this for `DATABASE_URL_DIRECT`. Used for DDL migrations (`npm run migrate`), deterministic seeding (`npm run seed`), and advisory locking.

---

## 4. Render Service Configuration

TeamForge includes a ready `render.yaml` Blueprint and a multi-stage `Dockerfile`:

### Option A: Via `render.yaml` (Blueprint)
1. In Render Dashboard, click **New +** -> **Blueprint**.
2. Connect your TeamForge repository.
3. Render reads `render.yaml` and provisions the Docker web service.
4. Supply `DATABASE_URL`, `DATABASE_URL_DIRECT`, and `APP_ORIGIN` in the environment settings.

### Option B: Manual Web Service
- **Runtime**: Docker (or Node with `npm ci && npm run build` and start `npm start`).
- **Dockerfile Path**: `./Dockerfile`.
- **Plan**: Free or Starter.
- **Health Check Path**: `/health`.
- **Auto-Deploy**: Enabled for branch `main`.

---

## 5. Migration Execution

Migrations are idempotent and automated:
1. **On-boot execution**:
   When the API server starts (`apps/api/dist/server.js`), it connects to `DATABASE_URL_DIRECT` (or `DATABASE_URL`), acquires `pg_advisory_xact_lock(718293)`, and applies any unapplied `.sql` scripts in `apps/api/dist/db/migrations/` sequentially inside a single transaction.
2. **Manual execution (pre-deploy or verification)**:
   ```bash
   DATABASE_URL="<NEON_DIRECT_URL>" npm run migrate
   ```
3. **Verify invariants**:
   ```bash
   DATABASE_URL="<NEON_DIRECT_URL>" npm run invariants
   ```

---

## 6. Remote Seed Instructions

To populate the 10,000 users, 2,000 teams, and 4,900 memberships on the remote database for benchmarking or demo:

```bash
DATABASE_URL="<NEON_DIRECT_URL>" DATABASE_URL_DIRECT="<NEON_DIRECT_URL>" SEED_PASSWORD="<DEMO_PASSWORD>" npm run seed
```

- Target execution: under 60 seconds (typically ~3–5 seconds via set-based SQL).
- Safe and repeatable: cleans existing `seed_user_*` records and demo hackathon teams without deleting real user registrations.
- Generates `loadtest/tokens.json` containing 200 authenticated session JWTs for load testing.

---

## 7. Production Smoke-Test Checklist

Execute this verification sequence against the live deployed URL:

1. [ ] **Process Liveness**:
   - `GET https://<your-render-url>/health` returns `200 OK` with `{"status":"ok"}`.
2. [ ] **Database Readiness**:
   - `GET https://<your-render-url>/ready` returns `200 OK` with `{"status":"ok"}`.
3. [ ] **Frontend SPA Delivery**:
   - Visiting `https://<your-render-url>/` delivers the compiled React application.
   - Deep links like `/board` return `index.html` with `Cache-Control: no-cache`.
4. [ ] **User Registration & Onboarding**:
   - Sign up with a new email and password.
   - Verify `sid` cookie is set with `Secure`, `HttpOnly`, and `SameSite=Lax`.
   - Complete profile (skills, timezone) and register for the hackathon.
5. [ ] **Team Lifecycle**:
   - Create a team -> verify team appears on `/board`.
   - Copy invite code -> open an incognito window, create a second account, join via invite code.
   - Verify team page in both browsers updates without a full page refresh (via SSE).
6. [ ] **Leader & Application Controls**:
   - Third account submits join application.
   - Leader receives application in inbox and accepts.
   - Applicant membership updates live.
7. [ ] **Role Revocation & Cleanup**:
   - Leader transfers leadership or leaves team; verify successor promotion.
   - Remaining members leave until empty; verify team row is safely removed from board.
8. [ ] **Database Invariants**:
   - Run `npm run invariants` against the remote database; verify 0 violations across all 8 checks.
